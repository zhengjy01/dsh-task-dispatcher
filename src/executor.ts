/**
 * dsh-task-dispatcher — auto-execute worker (1 task = 1 headless DSH session).
 *
 * When autoExecute is on, the dispatcher runs each pulled task in its own
 * `dsh --profile headless "<job>"` session (a fresh one-shot agent that uses
 * only the base tools: bash / fs / glob / grep / web / todo). Sessions run
 * SERIALLY (one at a time) to keep cost and load predictable. After a worker
 * exits cleanly, the task is completed back in TickTick (auto-complete).
 *
 * Worker workspace: the headless session takes its workspace from
 * process.cwd() (meta.cwd) and the host attaches it to the DSH workspace
 * whose directory matches — so when `workerWorkspaceId` is configured, each
 * worker is spawned with cwd = that workspace's directory and shows up under
 * that workspace in the GUI sidebar. Unset (or a stale id) falls back to the
 * user's home directory.
 *
 * Re-attempt protection: a task whose worker failed is marked attempted and
 * not re-run until the retry cooldown elapses, so a flaky task doesn't spin
 * every interval.
 *
 * Result notification: dispatching is not the same as finishing. When
 * `notifyResult` is on, every executed task pushes a SHORT outcome message
 * through the configured channels (WeChat / flomo / macOS) as soon as its
 * worker settles, and a compact batch tally follows when more than one task
 * ran — so a run that happens unattended still reports back by itself instead
 * of relying on the worker remembering to call `dispatcher_report`.
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import type { DispatcherStore, QueuedTask } from './store.ts'
import { DEFAULT_WORKER_TIMEOUT_MINUTES } from './store.ts'
import type { DispatchedTask } from './dispatch.ts'
import { notifyText } from './dispatch.ts'
import { resolveWorkspacePath } from './workspaces.ts'
import { resolveExecutable } from './executable.ts'
import { evaluateCheapMode, type CheapDecision } from './cheap.ts'

/** Outcome of one worker subprocess. */
export interface WorkerResult {
  ok: boolean
  exitCode: number | null
  /** stdout + stderr (kept for logs / back-compat). */
  output: string
  /** The final assistant text alone — the headless runner prints it on stdout. */
  stdout: string
  /** Progress, reasoning and diagnostics, which the runner prints on stderr. */
  stderr: string
  error?: string
}

/** Per-task outcome of one auto-execute pass (drives the result notification). */
export interface TaskExecResult {
  taskId: string
  title: string
  status: 'completed' | 'failed' | 'skipped'
  /** Concise answer summary when completed, else the failure reason. */
  summary: string
  /** False when the worker succeeded but the TickTick write-back failed. */
  writtenBack: boolean
  durationMs: number
}

/** Outline of one auto-execute pass. */
export interface AutoExecOutcome {
  executed: number
  completed: number
  failed: number
  skipped: number
  log: string[]
  /** One entry per task the pass considered, in execution order. */
  results: TaskExecResult[]
}

/**
 * Fallback worker timeout when no explicit `timeoutMs` is given to
 * `spawnWorker`. The live auto-execute path always passes the configured
 * `workerTimeoutMinutes` (default 30); this constant only covers direct calls.
 */
export const DEFAULT_WORKER_TIMEOUT_MS = DEFAULT_WORKER_TIMEOUT_MINUTES * 60 * 1000

/** Options for one worker spawn. */
export interface SpawnWorkerOptions {
  /** Directory the worker process starts in (= the DSH workspace dir). */
  cwd?: string
  /** Kill the worker after this many milliseconds. */
  timeoutMs?: number
}

/**
 * Spawn `dsh --profile headless "<prompt>"` and resolve when it exits.
 * Best-effort: never throws; resolves a WorkerResult even on spawn error.
 */
export async function spawnWorker(prompt: string, opts: SpawnWorkerOptions = {}): Promise<WorkerResult> {
  const cwd = opts.cwd ?? homedir()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child: ReturnType<typeof spawn> | null = null
    try {
      // Absolute path: a launchd-started DSH has only /usr/bin:/bin on PATH,
      // which would hide the `dsh` CLI from spawn().
      child = spawn(resolveExecutable('dsh'), ['--profile', 'headless', prompt], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      return resolve({ ok: false, exitCode: null, output: '', stdout: '', stderr: '', error: String(error) })
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child?.kill('SIGKILL')
      resolve({ ok: false, exitCode: null, output: stdout + stderr, stdout, stderr, error: 'timeout' })
    }, timeoutMs)
    child.stdout?.on('data', (d) => { stdout += String(d) })
    child.stderr?.on('data', (d) => { stderr += String(d) })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, exitCode: null, output: stdout + stderr, stdout, stderr, error: String(err) })
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, exitCode: code, output: stdout + stderr, stdout, stderr })
    })
  })
}

/** ANSI colour escapes (the CLI colourises stderr output). */
const ANSI_ESCAPES = /\u001B\[[0-9;]*[A-Za-z]/g

/**
 * Condense a worker's final answer into one short line for the result notice.
 *
 * The headless runner writes ONLY the final assistant text to stdout (progress
 * and reasoning go to stderr), so stdout is the answer. Blank lines and a
 * trailing bare completion marker (the worker prompt asks for `DONE`) are
 * dropped, and the rest is flattened and capped — a notification must stay
 * readable in a chat bubble.
 */
export function summarizeWorkerOutput(stdout: string, maxChars = 220): string {
  const lines = (stdout ?? '')
    .replace(ANSI_ESCAPES, '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  while (lines.length > 0 && /^(done|完成|✅ *done)$/i.test(lines[lines.length - 1] ?? '')) lines.pop()
  const text = lines.join(' ')
  if (text === '') return ''
  return text.length <= maxChars ? text : text.slice(0, maxChars - 1) + '…'
}

/** The per-task result message. */
function taskMessage(result: TaskExecResult): string {
  const head = result.status === 'completed' ? '✅ 任务完成 · ' : '❌ 任务失败 · '
  const lines = [head + result.title]
  if (result.summary !== '') {
    lines.push((result.status === 'completed' ? '结果：' : '原因：') + result.summary)
  }
  if (result.status === 'completed' && !result.writtenBack) {
    lines.push('（滴答清单回写失败，请手动勾选）')
  }
  return lines.join('\n')
}

/** The batch tally that follows a multi-task pass. */
function batchMessage(outcome: AutoExecOutcome): string {
  const done = outcome.results.filter((r) => r.status !== 'skipped')
  const lines = ['📊 本轮自动执行：完成 ' + outcome.completed + ' · 失败 ' + outcome.failed + '（共 ' + done.length + ' 项）']
  for (const r of done) lines.push((r.status === 'completed' ? '- ✅ ' : '- ❌ ') + r.title)
  return lines.join('\n')
}

/** Build a worker prompt from the template + this task. */
export function buildWorkerPrompt(template: string, task: DispatchedTask): string {
  return template
    .replace('{title}', task.title)
    .replace('{content}', task.content)
}

/**
 * Serial auto-execute over the given tasks.
 * @param opts.spawn - injectable worker spawn (tests pass a fake); receives the
 *   resolved timeout so a pass can be checked without a real subprocess.
 * @param opts.onComplete - injectable "mark complete" (defaults to the TickTick
 *   API's completeTask).
 */
export async function runAutoExecute(
  store: DispatcherStore,
  api: { completeTask(projectId: string, taskId: string): Promise<void> },
  tasks: DispatchedTask[],
  opts: {
    spawn?: (prompt: string, opts: SpawnWorkerOptions) => Promise<WorkerResult>
    onComplete?: (task: DispatchedTask) => Promise<void>
    /** Push a result notification as each task settles (opt-in; real callers set it). */
    notifyResult?: boolean
    /** Injectable notification transport (tests / custom channels). */
    notify?: (text: string) => Promise<void>
  } = {},
): Promise<AutoExecOutcome> {
  const cfg = await store.load()
  const log: string[] = []
  const outcome: AutoExecOutcome = { executed: 0, completed: 0, failed: 0, skipped: 0, log, results: [] }
  // Result notifications are opt-in (opts.notifyResult) AND config-gated, so a
  // test that omits the flag can never fire a real message.
  const notify = opts.notify ?? (async (text: string) => { await notifyText(text, cfg, { macTitle: 'DSH 任务结果', macSubtitle: '自动执行' }) })
  const wantsResultNotify = opts.notifyResult === true && cfg.notifyResult
  if (!cfg.autoExecute) {
    log.push('自动执行未开启（autoExecute=false）')
    return outcome
  }
  // Resolve the configured DSH workspace once per pass; a stale/missing id
  // yields undefined and the worker falls back to the home directory.
  const workerCwd = cfg.workerWorkspaceId !== '' ? await resolveWorkspacePath(cfg.workerWorkspaceId) : undefined
  // Worker timeout is config-driven (workerTimeoutMinutes, default 30) so a
  // task that legitimately runs longer than the old fixed 10 min is not
  // SIGKILLed mid-flight anymore.
  const workerTimeoutMs = cfg.workerTimeoutMinutes * 60 * 1000
  const spawn = opts.spawn ?? spawnWorker
  const onComplete = opts.onComplete ?? ((t: DispatchedTask) => api.completeTask(t.projectId, t.id))

  for (const task of tasks) {
    // 「拉取按窗口、执行按截止」：窗口任务（开始日已到、截止日未到）会出现在
    // 今日任务文件里供 agent 判断，但绝不自动执行——否则「观察后真删 X」这类
    // 任务会在开始日当天就做出不可逆的操作。
    if (task.actionable === false) {
      outcome.skipped++
      log.push('跳过「' + task.title + '」（进行中窗口任务：未到截止日，不自动执行）')
      outcome.results.push({ taskId: task.id, title: task.title, status: 'skipped', summary: '进行中窗口任务（未到截止日）', writtenBack: false, durationMs: 0 })
      continue
    }
    if (!(await store.canRetry(task.id, cfg.retryCooldownMinutes))) {
      outcome.skipped++
      log.push('跳过「' + task.title + '」（冷却期）')
      outcome.results.push({ taskId: task.id, title: task.title, status: 'skipped', summary: '仍在失败重试冷却期', writtenBack: false, durationMs: 0 })
      continue
    }
    await store.markAttempted(task.id)
    outcome.executed++
    const startedAt = Date.now()
    const prompt = buildWorkerPrompt(cfg.workerPrompt, task)
    const worker = await spawn(prompt, {
      ...(workerCwd !== undefined ? { cwd: workerCwd } : {}),
      timeoutMs: workerTimeoutMs,
    })
    const durationMs = Date.now() - startedAt
    const summary = summarizeWorkerOutput(worker.stdout)
    if (worker.ok) {
      outcome.completed++
      let writtenBack = true
      try {
        await onComplete(task)
        log.push('✓ 完成「' + task.title + '」')
      } catch (error) {
        writtenBack = false
        log.push('完成「' + task.title + '」但回写失败: ' + String(error instanceof Error ? error.message : error))
      }
      const result: TaskExecResult = { taskId: task.id, title: task.title, status: 'completed', summary, writtenBack, durationMs }
      outcome.results.push(result)
      if (wantsResultNotify) await notify(taskMessage(result))
    } else {
      outcome.failed++
      const reason = worker.error !== undefined
        ? (worker.error === 'timeout' ? '执行超时（' + cfg.workerTimeoutMinutes + ' 分钟，已 SIGKILL）' : worker.error)
        : ('worker 退出码 ' + String(worker.exitCode))
      const result: TaskExecResult = { taskId: task.id, title: task.title, status: 'failed', summary: reason, writtenBack: false, durationMs }
      outcome.results.push(result)
      log.push('✗「' + task.title + '」执行失败（' + reason + '）')
      if (wantsResultNotify) await notify(taskMessage(result))
    }
  }
  if (wantsResultNotify && outcome.results.filter((r) => r.status !== 'skipped').length > 1) {
    await notify(batchMessage(outcome))
  }
  return outcome
}

/** Options for the cheap-mode gated execution (threaded into runAutoExecute). */
export interface GatedRunOptions {
  /** 手动触发时绕过省钱模式（立刻执行，不等空闲时段）。 */
  ignoreCheapMode?: boolean
  /** Push the per-task result notifications (real callers set it). */
  notifyResult?: boolean
  /** Injectable clock (tests / deterministic decisions). */
  now?: Date
  spawn?: (prompt: string, opts: SpawnWorkerOptions) => Promise<WorkerResult>
  onComplete?: (task: DispatchedTask) => Promise<void>
  notify?: (text: string) => Promise<void>
}

/** Outcome of a gated execution: ran now / queued / skipped / disabled. */
export interface GatedRunResult {
  mode: 'executed' | 'queued' | 'skipped' | 'disabled'
  outcome: AutoExecOutcome | null
  executed: number
  completed: number
  failed: number
  skipped: number
  /** Number of tasks left waiting for the cheap window. */
  queued: number
  nextCheapStartAt: string
  nextCheapStartLabel: string
  inPeak: boolean
  decision: CheapDecision | null
  log: string[]
}

/** Merge queued + freshly pulled tasks, de-duplicated by id (fresh wins). */
function mergeTasks(queue: QueuedTask[], tasks: DispatchedTask[]): DispatchedTask[] {
  const merged = new Map<string, DispatchedTask>()
  for (const task of queue) merged.set(task.id, task)
  for (const task of tasks) merged.set(task.id, task)
  return [...merged.values()]
}

/** Build the "queued for the cheap window" notification body. */
function queuedNotice(tasks: DispatchedTask[], decision: CheapDecision): string {
  const lines = [
    '💰 省钱模式：已排入 ' + (decision.nextCheapStartLabel || decision.nextCheapStartAt) + ' 空闲时段执行 · ' + tasks.length + ' 项',
    ...tasks.slice(0, 12).map((t) => '- ' + t.title),
  ]
  if (tasks.length > 12) lines.push('…还有 ' + (tasks.length - 12) + ' 项')
  lines.push('（' + decision.reason + '）')
  return lines.join('\n')
}

/** Build the "skipped this round" notification body. */
function skippedNotice(tasks: DispatchedTask[], decision: CheapDecision): string {
  const lines = [
    '💰 省钱模式：当前为高峰时段，本轮跳过 ' + tasks.length + ' 项（策略=skip）',
    ...tasks.slice(0, 12).map((t) => '- ' + t.title),
  ]
  if (tasks.length > 12) lines.push('…还有 ' + (tasks.length - 12) + ' 项')
  lines.push('（' + decision.reason + '）')
  return lines.join('\n')
}

/** Raw counts from an auto-execute outcome (or zeros). */
function countsOf(outcome: AutoExecOutcome | null): { executed: number; completed: number; failed: number; skipped: number } {
  return outcome === null
    ? { executed: 0, completed: 0, failed: 0, skipped: 0 }
    : { executed: outcome.executed, completed: outcome.completed, failed: outcome.failed, skipped: outcome.skipped }
}

/**
 * 带「省钱模式」门控的自动执行。
 *
 * 判定点刻意只在「准备开 worker 之前」：拉取节奏、过滤、串行执行都不参与判定。
 * - 省钱模式关闭（或 ignoreCheapMode）→ 与旧版完全一致，立刻执行。
 * - 高峰期 → 策略 wait 把任务落盘排队并通知；策略 skip 本轮跳过并通知。
 * - 空闲期且距下个高峰 ≥ 余量 → 立刻执行（同时把之前排队的任务一起跑了）。
 */
export async function runAutoExecuteGated(
  store: DispatcherStore,
  api: { completeTask(projectId: string, taskId: string): Promise<void> },
  tasks: DispatchedTask[],
  opts: GatedRunOptions = {},
): Promise<GatedRunResult> {
  const cfg = await store.load()
  const log: string[] = []
  const base: GatedRunResult = {
    mode: 'disabled', outcome: null, executed: 0, completed: 0, failed: 0, skipped: 0, queued: cfg.cheapQueue.length,
    nextCheapStartAt: cfg.nextCheapStartAt, nextCheapStartLabel: '', inPeak: false, decision: null, log,
  }
  if (!cfg.autoExecute) {
    log.push('自动执行未开启（autoExecute=false）')
    return base
  }
  const notify = opts.notify ?? (async (text: string) => { await notifyText(text, cfg, { macTitle: 'DSH 省钱模式', macSubtitle: '任务派发器' }) })
  const runOpts = {
    ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
    ...(opts.onComplete !== undefined ? { onComplete: opts.onComplete } : {}),
    ...(opts.notifyResult !== undefined ? { notifyResult: opts.notifyResult } : {}),
    ...(opts.notify !== undefined ? { notify: opts.notify } : {}),
  }
  const bypass = opts.ignoreCheapMode === true
  if (cfg.cheapMode && !bypass) {
    const decision = evaluateCheapMode(cfg, opts.now ?? new Date())
    if (!decision.canRunNow) {
      if (cfg.cheapStrategy === 'skip') {
        log.push('省钱模式：高峰时段，跳过 ' + tasks.length + ' 项（' + decision.reason + '）')
        if (opts.notifyResult === true && tasks.length > 0) await notify(skippedNotice(tasks, decision))
        return { ...base, mode: 'skipped', skipped: tasks.length, inPeak: decision.inPeak, decision }
      }
      await store.enqueueCheap(tasks, decision.nextCheapStartAt)
      const queuedCount = (await store.view()).cheapQueueCount
      log.push('省钱模式：已排入 ' + (decision.nextCheapStartLabel || decision.nextCheapStartAt) + ' 空闲时段（' + tasks.length + ' 项，' + decision.reason + '）')
      if (opts.notifyResult === true && tasks.length > 0) await notify(queuedNotice(tasks, decision))
      return {
        ...base, mode: 'queued', queued: queuedCount, nextCheapStartAt: decision.nextCheapStartAt,
        nextCheapStartLabel: decision.nextCheapStartLabel, inPeak: decision.inPeak, decision,
      }
    }
    // 空闲且够余量：把之前排队的任务一并执行，然后清空队列。
    const merged = mergeTasks(cfg.cheapQueue, tasks)
    if (cfg.cheapQueue.length > 0) await store.clearCheapQueue()
    log.push('省钱模式：当前空闲，执行 ' + merged.length + ' 项（其中排队 ' + cfg.cheapQueue.length + ' 项）')
    const outcome = await runAutoExecute(store, api, merged, runOpts)
    return { ...base, mode: 'executed', outcome, ...countsOf(outcome), queued: 0, inPeak: decision.inPeak, decision, log }
  }
  // 未开省钱模式（或手动绕过）：旧行为。关闭省钱模式时顺带把遗留队列排空。
  const leftover = bypass ? [] : cfg.cheapQueue
  if (!bypass && leftover.length > 0) await store.clearCheapQueue()
  const merged = mergeTasks(leftover, tasks)
  if (bypass && tasks.length > 0) log.push('已忽略省钱模式（ignoreCheapMode）：立刻执行 ' + merged.length + ' 项')
  const outcome = await runAutoExecute(store, api, merged, runOpts)
  return { ...base, mode: 'executed', outcome, ...countsOf(outcome), queued: (await store.view()).cheapQueueCount, log }
}

/**
 * 定时器每分钟调用：队列到点（进入空闲）就把排队任务跑掉。
 *
 * 与拉取节奏解耦——即便 dispatchIntervalMinutes 很长（或为 0），排队任务也会在
 * 空闲开始后的下一次检查触发。队列在开跑前先清空，避免进程被中断后重复执行。
 *
 * @returns the outcome, or null when there is nothing due (empty queue / still peak / autoExecute off).
 */
export async function flushCheapQueueIfDue(
  store: DispatcherStore,
  api: { completeTask(projectId: string, taskId: string): Promise<void> },
  opts: GatedRunOptions = {},
): Promise<GatedRunResult | null> {
  const cfg = await store.load()
  if (!cfg.autoExecute || cfg.cheapQueue.length === 0) return null
  const decision = evaluateCheapMode(cfg, opts.now ?? new Date())
  if (!decision.canRunNow) return null
  const tasks = cfg.cheapQueue
  await store.clearCheapQueue()
  const runOpts = {
    ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
    ...(opts.onComplete !== undefined ? { onComplete: opts.onComplete } : {}),
    ...(opts.notifyResult !== undefined ? { notifyResult: opts.notifyResult } : {}),
    ...(opts.notify !== undefined ? { notify: opts.notify } : {}),
  }
  const log = ['省钱模式：空闲开始，执行排队任务 ' + tasks.length + ' 项']
  const outcome = await runAutoExecute(store, api, tasks, runOpts)
  return {
    mode: 'executed', outcome, ...countsOf(outcome), queued: 0,
    nextCheapStartAt: '', nextCheapStartLabel: '', inPeak: decision.inPeak, decision, log,
  }
}
