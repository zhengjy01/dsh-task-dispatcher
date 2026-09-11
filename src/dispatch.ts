/**
 * dsh-task-dispatcher — the dispatch core.
 *
 * A dispatch resolves the configured TickTick source project, pulls its
 * incomplete tasks, filters to today's relevant ones, writes a today-tasks
 * file the agent reads (each task: title + due date + its TickTick description
 * quoted underneath), and notifies (flomo + macOS). The actual task execution
 * is done by the agent in DSH using the existing dsh-ticktick tools; the file
 * + notification simply tell the agent what to work on today and write results
 * back.
 *
 * 「今天相关」有两条独立判据，刻意分开（拉取按窗口、执行按截止）：
 * - **拉取**：`dueDate <= today`（到期/逾期）**或** `startDate <= today`
 *   （时间段任务已进窗口——TickTick 的「今天」包含这些，旧版只比 dueDate 会漏掉）。
 * - **自动执行**：只有到期/逾期任务可以跑；窗口任务只进文件 + 通知，
 *   因为「开始日到了」只代表可以开始，不代表今天该做完。
 *
 * Reuses the dsh-ticktick data layer (TickTickStore + TickTickApi) so the
 * same OAuth token drives everything — no duplicate credentials.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { TickTickStore, TickTickApi } from 'dsh-ticktick'
import type { DispatcherStore } from './store.ts'
import type { DispatcherConfig } from './store.ts'
import { flomoMemo, macNotify, stripHash, type NotifyResult } from './notify.ts'

/** One task picked for today's dispatch. */
export interface DispatchedTask {
  id: string
  projectId: string
  title: string
  content: string
  dueDate: string
  /** 开始日（时间段任务起点）；空串表示任务没有开始日。 */
  startDate: string
  /**
   * 是否可以「现在就自动执行」。
   *
   * 判定与「是否拉取」刻意分开（拉取按窗口、执行按截止）：
   * - true  = 今天到期/逾期（或配置放行的无截止任务）→ autoExecute 会跑
   * - false = 窗口任务（开始日已到、截止日未到）→ 只进今日任务文件 + 通知，
   *   交给 agent 判断该不该提前动，绝不自动执行
   *
   * 原因：「观察后真删 X」这类任务的开始日就是今天、截止日在两周后，
   * 按开始日自动执行会在当天就做出不可逆的删除。
   */
  actionable: boolean
  priority: number
  tags: string[]
}

/** Outcome of a dispatch. */
export interface DispatchResult {
  ok: boolean
  message: string
  dispatchedAt: string
  projectName: string
  projectId: string
  taskCount: number
  tasks: DispatchedTask[]
  taskFile: string
  notifies: NotifyResult[]
  /** True when the task set changed since the last dispatch (or a manual run forced a notify). */
  changed: boolean
  /** True when at least one notify channel fired. */
  notified: boolean
}

/** Local calendar date as YYYY-MM-DD. */
export function localDateString(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Local calendar date of an ISO dueDate, or null when unparseable. */
function localDateOf(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Whether a dueDate is on or before `today` (local calendar date compare). */
function dueThisDay(dueDate: string | undefined, today: string): boolean {
  if (typeof dueDate !== 'string' || dueDate === '') return false
  const local = localDateOf(dueDate)
  return local !== null && local <= today
}

/** Whether a startDate has already arrived (start <= today, local calendar date compare). */
function startsByThisDay(startDate: string | undefined, today: string): boolean {
  if (typeof startDate !== 'string' || startDate === '') return false
  const local = localDateOf(startDate)
  return local !== null && local <= today
}

/**
 * Does a task qualify for today's dispatch (i.e. should it be PULLED)?
 *
 * Two independent ways in:
 * 1. 到期：dueDate <= today（今天到期/逾期）。
 * 2. 进窗口：startDate <= today —— 滴答清单的「时间段任务」只要开始日到了，
 *    TickTick 就算它今天的事，派发器必须一起拉，否则「今天开始的活」永远
 *    不会被看见（2026-09-11 的 bug：旧判据只比 dueDate，漏了 startDate）。
 *
 * 注意：拉进来 ≠ 可以自动执行，能不能跑由 {@link taskIsActionable} 决定。
 */
function taskQualifies(task: { dueDate?: string; startDate?: string }, cfg: DispatcherConfig, today: string): boolean {
  if (cfg.dueMode === 'all') return true
  if (typeof task.dueDate === 'string' && task.dueDate !== '') {
    if (dueThisDay(task.dueDate, today)) return true
    return startsByThisDay(task.startDate, today)
  }
  // 无截止：由 includeUndated 放行；开始日已到的时间段任务同样放行。
  return cfg.includeUndated || startsByThisDay(task.startDate, today)
}

/**
 * May this task be auto-executed right now?（「拉取按窗口、执行按截止」）
 *
 * 只有 dueDate <= today 的到期/逾期任务才允许 autoExecute；窗口任务
 * （开始日已到、截止日未到）只通知不执行。无截止任务沿用 includeUndated。
 */
function taskIsActionable(task: { dueDate?: string; startDate?: string }, cfg: DispatcherConfig, today: string): boolean {
  if (cfg.dueMode === 'all') return true
  if (typeof task.dueDate === 'string' && task.dueDate !== '') return dueThisDay(task.dueDate, today)
  return cfg.includeUndated
}

/** Resolve the source project id by configured name (or explicit id). */
async function resolveProjectId(api: TickTickApi, cfg: DispatcherConfig): Promise<{ id: string; name: string }> {
  const projects = await api.getProjects()
  if (cfg.projectName.trim() !== '') {
    const byName = projects.find((p) => p.name === cfg.projectName)
    if (byName !== undefined) return { id: byName.id, name: byName.name }
  }
  if (cfg.projectId !== undefined && cfg.projectId.trim() !== '') {
    // Prefer the resolved name if present, else the configured id itself.
    const byId = projects.find((p) => p.id === cfg.projectId)
    return byId !== undefined ? { id: byId.id, name: byId.name } : { id: cfg.projectId.trim(), name: cfg.projectName }
  }
  throw new Error('未匹配到滴答清单「' + cfg.projectName + '」清单：请在 dispatcher_config 里用 projectName / projectId 指定来源清单。')
}

/** Human-readable due label (local date). */
function dueLabel(dueDate: string | undefined): string {
  if (typeof dueDate !== 'string' || dueDate === '') return '无截止'
  return localDateOf(dueDate) ?? '无截止'
}

/**
 * Run one dispatch using the given store and (optionally) an injected
 * TickTickApi (the smoke tests inject a fake). Writes the today-tasks file
 * and notifies, then records the dispatch on the store.
 *
 * On the scheduled interval, notify only when the task set CHANGED since the
 * last dispatch (so a repeated pull with no new tasks stays silent). A manual
 * `dispatcher_run` passes { forceNotify: true } to always notify.
 */
export async function doDispatch(store: DispatcherStore, api: TickTickApi, opts: { forceNotify?: boolean } = {}): Promise<DispatchResult> {
  const cfg = await store.load()
  const today = localDateString()
  const notifies: NotifyResult[] = []

  if (!cfg.enabled) {
    return {
      ok: false,
      message: '插件已禁用（enabled=false），本次派发跳过。',
      dispatchedAt: new Date().toISOString(), projectName: cfg.projectName, projectId: cfg.projectId ?? '',
      taskCount: 0, tasks: [], taskFile: cfg.taskFile, notifies, changed: false, notified: false,
    }
  }

  const { id: projectId, name: projectName } = await resolveProjectId(api, cfg)
  const data = await api.getProjectData(projectId)
  const all = Array.isArray(data.tasks) ? data.tasks : []
  const selected = all
    .filter((t) => t.status !== 2) // status 2 = completed; incomplete otherwise
    .filter((t) => taskQualifies(t, cfg, today))
    .map((t) => ({
      id: t.id,
      projectId: t.projectId,
      title: t.title,
      content: typeof t.content === 'string' ? t.content : '',
      dueDate: typeof t.dueDate === 'string' ? t.dueDate : '',
      startDate: typeof t.startDate === 'string' ? t.startDate : '',
      actionable: taskIsActionable(t, cfg, today),
      priority: typeof t.priority === 'number' ? t.priority : 0,
      tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === 'string') : [],
    }))
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))

  // Change detection: compare the new task-title set against the last one.
  // A scheduled pull that finds nothing new stays silent (no flomo/mac spam);
  // a manual run forces a notify.
  const titles = selected.map((t) => t.title)
  const signature = JSON.stringify([...titles].sort())
  const lastSig = JSON.stringify([...cfg.lastTaskTitles].sort())
  const changed = signature !== lastSig

  // Write the today-tasks file (always refreshed so the agent has current tasks).
  const taskFile = cfg.taskFile
  await mkdir(path.dirname(taskFile), { recursive: true })
  const lines = selected.map((t) => {
    // 「进行中」= 窗口任务（开始日已到、截止日未到）：只提示、不自动执行。
    const head = t.actionable
      ? `- [ ] ${t.title}（截止 ${dueLabel(t.dueDate) || '无截止'}）`
      : `- [ ] ${t.title}（进行中 · 截止 ${dueLabel(t.dueDate) || '无截止'}）`
    // The TickTick task description (content) is quoted under the title so the
    // agent reads it together with the task, not just the title. Multi-line
    // descriptions are kept line by line; blank lines become bare '>'.
    const desc = t.content.trim()
    if (desc === '') return head
    const quoted = desc
      .split(/\r?\n/)
      .map((line) => (line.trim() === '' ? '  >' : '  > ' + line.trimEnd()))
      .join('\n')
    return head + '\n' + quoted
  })
  const windowCount = selected.filter((t) => !t.actionable).length
  const head = [
    `# 今日待执行任务 · ${today}`,
    '',
    `**来源**：滴答清单「${projectName}」 · 共 ${selected.length} 项` +
    (windowCount > 0 ? `（其中 ${windowCount} 项为「进行中」窗口任务：开始日已到、截止日未到）` : ''),
    '',
    ...lines,
    '',
    '执行说明：逐项处理（任务描述以引用块附在标题下）；完成的用 ticktick_complete 回写滴答清单，并把结果落到知识库/项目档案。',
    '',
    '自动执行范围：只有「今天到期/逾期（+ 无截止）」的任务会被 autoExecute 执行；标「进行中」的窗口任务仅在此列出、不自动执行——开始日到了只代表「可以开始」，不代表「今天必须做完」（例：「观察后真删」要等观察期结束）。',
  ].join('\n')
  await writeFile(taskFile, head + '\n')

  // Notify (best-effort) — only when there is work to report (count > 0) AND
  // the set changed or a manual run forced it. Avoids spamming "0 项" or
  // repeating the same list every interval.
  const shouldNotify = (opts.forceNotify === true || changed) && selected.length > 0
  const notified = shouldNotify && (cfg.notifyFlomo || cfg.notifyMac)
  if (shouldNotify) {
    if (cfg.notifyFlomo) {
      const rawBody = [
        `📋 今日派发 · ${today} · 「${projectName}」共 ${selected.length} 项待执行`,
        ...selected.slice(0, 12).map((t) => (t.actionable ? `- ${t.title}` : `- ${t.title}（进行中）`)),
        ...(windowCount > 0 ? ['', `其中 ${windowCount} 项为「进行中」窗口任务（开始日已到、未到截止），仅提示、不自动执行。`] : []),
      ].join('\n')
      // flomo parses `#word` as a tag; strip '#' from the dispatch body (but
      // keep the configured flomoTag, which is appended separately) so task
      // titles that contain '#' don't spawn stray tags.
      const body = cfg.flomoStripBodyHash ? stripHash(rawBody) : rawBody
      notifies.push(await flomoMemo(body, cfg.flomoTag))
    }
    if (cfg.notifyMac) {
      notifies.push(await macNotify('DSH 任务派发', projectName, `今日 ${selected.length} 项任务待执行（${today}）`))
    }
  }

  await store.recordDispatch(titles)

  let extra = ''
  if (selected.length === 0) {
    extra = '，今日无待执行任务（未发送通知）'
  } else if (!shouldNotify) {
    extra = '，任务无变化，跳过通知'
  } else if (notified) {
    extra = '，已发送通知'
  } else {
    extra = '，通知未发送（flomo/macOS 均未配置）'
  }
  return {
    ok: true,
    message: `已拉取 ${selected.length} 项任务（来源「${projectName}」）` +
      (windowCount > 0 ? `，其中 ${windowCount} 项为进行中窗口任务（不自动执行）` : '') +
      `，今日任务文件已写入 ${taskFile}${extra}。`,
    dispatchedAt: new Date().toISOString(),
    projectName,
    projectId,
    taskCount: selected.length,
    tasks: selected,
    taskFile,
    notifies,
    changed,
    notified,
  }
}
