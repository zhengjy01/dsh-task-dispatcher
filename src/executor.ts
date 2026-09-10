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
 */

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import type { DispatcherStore } from './store.ts'
import type { DispatchedTask } from './dispatch.ts'
import { resolveWorkspacePath } from './workspaces.ts'
import { resolveExecutable } from './executable.ts'

/** Outcome of one worker subprocess. */
export interface WorkerResult {
  ok: boolean
  exitCode: number | null
  output: string
  error?: string
}

/** Outline of one auto-execute pass. */
export interface AutoExecOutcome {
  executed: number
  completed: number
  failed: number
  skipped: number
  log: string[]
}

/** Worker command (dsh headless) is spawned from the user's home dir. */
const WORKER_TIMEOUT_MS = 10 * 60 * 1000

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
  const timeoutMs = opts.timeoutMs ?? WORKER_TIMEOUT_MS
  return new Promise((resolve) => {
    let output = ''
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
      return resolve({ ok: false, exitCode: null, output: '', error: String(error) })
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child?.kill('SIGKILL')
      resolve({ ok: false, exitCode: null, output: output + stderr, error: 'timeout' })
    }, timeoutMs)
    child.stdout?.on('data', (d) => { output += String(d) })
    child.stderr?.on('data', (d) => { stderr += String(d) })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, exitCode: null, output: output + stderr, error: String(err) })
    })
    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, exitCode: code, output: output + stderr })
    })
  })
}

/** Build a worker prompt from the template + this task. */
export function buildWorkerPrompt(template: string, task: DispatchedTask): string {
  return template
    .replace('{title}', task.title)
    .replace('{content}', task.content)
}

/**
 * Serial auto-execute over the given tasks.
 * @param opts.spawn - injectable worker spaw (tests pass a fake).
 * @param opts.onComplete - injectable "mark complete" (defaults to the TickTick
 *   API's completeTask).
 */
export async function runAutoExecute(
  store: DispatcherStore,
  api: { completeTask(projectId: string, taskId: string): Promise<void> },
  tasks: DispatchedTask[],
  opts: {
    spawn?: (prompt: string) => Promise<WorkerResult>
    onComplete?: (task: DispatchedTask) => Promise<void>
  } = {},
): Promise<AutoExecOutcome> {
  const cfg = await store.load()
  const log: string[] = []
  const outcome: AutoExecOutcome = { executed: 0, completed: 0, failed: 0, skipped: 0, log }
  if (!cfg.autoExecute) {
    log.push('自动执行未开启（autoExecute=false）')
    return outcome
  }
  // Resolve the configured DSH workspace once per pass; a stale/missing id
  // yields undefined and the worker falls back to the home directory.
  const workerCwd = cfg.workerWorkspaceId !== '' ? await resolveWorkspacePath(cfg.workerWorkspaceId) : undefined
  const spawn = opts.spawn ?? ((prompt: string) => spawnWorker(prompt, workerCwd !== undefined ? { cwd: workerCwd } : {}))
  const onComplete = opts.onComplete ?? ((t: DispatchedTask) => api.completeTask(t.projectId, t.id))

  for (const task of tasks) {
    if (!(await store.canRetry(task.id, cfg.retryCooldownMinutes))) {
      outcome.skipped++
      log.push('跳过「' + task.title + '」（冷却期）')
      continue
    }
    await store.markAttempted(task.id)
    outcome.executed++
    const prompt = buildWorkerPrompt(cfg.workerPrompt, task)
    const worker = await spawn(prompt)
    if (worker.ok) {
      outcome.completed++
      try {
        await onComplete(task)
        log.push('✓ 完成「' + task.title + '」')
      } catch (error) {
        log.push('完成「' + task.title + '」但回写失败: ' + String(error instanceof Error ? error.message : error))
      }
    } else {
      outcome.failed++
      log.push('✗「' + task.title + '」执行失败' + (worker.error !== undefined ? '（' + worker.error + '）' : ''))
    }
  }
  return outcome
}
