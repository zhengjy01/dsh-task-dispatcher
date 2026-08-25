/**
 * dsh-task-dispatcher — the dispatch core.
 *
 * A dispatch resolves the configured TickTick source project, pulls its
 * incomplete tasks, filters to today's actionable ones (due today/overdue,
 * plus undated when configured), writes a today-tasks file the agent reads,
 * and notifies (flomo + macOS). The actual task execution is done by the
 * agent in DSH using the existing dsh-ticktick tools; the file + notification
 * simply tell the agent what to work on today and write results back.
 *
 * Reuses the dsh-ticktick data layer (TickTickStore + TickTickApi) so the
 * same OAuth token drives everything — no duplicate credentials.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { TickTickStore, TickTickApi } from 'dsh-ticktick'
import type { DispatcherStore } from './store.ts'
import type { DispatcherConfig } from './store.ts'
import { flomoMemo, macNotify, type NotifyResult } from './notify.ts'

/** One task picked for today's dispatch. */
export interface DispatchedTask {
  id: string
  projectId: string
  title: string
  dueDate: string
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

/** Does a task qualify for today's dispatch? */
function taskQualifies(task: { dueDate?: string }, cfg: DispatcherConfig, today: string): boolean {
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
      dueDate: typeof t.dueDate === 'string' ? t.dueDate : '',
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
  const lines = selected.map((t) =>
    `- [ ] ${t.title}（截止 ${dueLabel(t.dueDate) || '无截止'}）`,
  )
  const head = [
    `# 今日待执行任务 · ${today}`,
    '',
    `**来源**：滴答清单「${projectName}」 · 共 ${selected.length} 项`,
    '',
    ...lines,
    '',
    '执行说明：逐项处理；完成的用 ticktick_complete 回写滴答清单，并把结果落到知识库/项目档案。',
  ].join('\n')
  await writeFile(taskFile, head + '\n')

  // Notify (best-effort) — only when there is work to report (count > 0) AND
  // the set changed or a manual run forced it. Avoids spamming "0 项" or
  // repeating the same list every interval.
  const shouldNotify = (opts.forceNotify === true || changed) && selected.length > 0
  const notified = shouldNotify && (cfg.notifyFlomo || cfg.notifyMac)
  if (shouldNotify) {
    if (cfg.notifyFlomo) {
      const body = [
        `📋 今日派发 · ${today} · 「${projectName}」共 ${selected.length} 项待执行`,
        ...selected.slice(0, 12).map((t) => `- ${t.title}`),
      ].join('\n')
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
    message: `已拉取 ${selected.length} 项任务（来源「${projectName}」），今日任务文件已写入 ${taskFile}${extra}。`,
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
