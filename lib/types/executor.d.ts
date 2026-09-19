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
import type { DispatcherStore } from './store.ts';
import type { DispatchedTask } from './dispatch.ts';
import { type CheapDecision } from './cheap.ts';
/** Outcome of one worker subprocess. */
export interface WorkerResult {
    ok: boolean;
    exitCode: number | null;
    /** stdout + stderr (kept for logs / back-compat). */
    output: string;
    /** The final assistant text alone — the headless runner prints it on stdout. */
    stdout: string;
    /** Progress, reasoning and diagnostics, which the runner prints on stderr. */
    stderr: string;
    error?: string;
}
/** Per-task outcome of one auto-execute pass (drives the result notification). */
export interface TaskExecResult {
    taskId: string;
    title: string;
    status: 'completed' | 'failed' | 'skipped';
    /** Concise answer summary when completed, else the failure reason. */
    summary: string;
    /** False when the worker succeeded but the TickTick write-back failed. */
    writtenBack: boolean;
    durationMs: number;
}
/** Outline of one auto-execute pass. */
export interface AutoExecOutcome {
    executed: number;
    completed: number;
    failed: number;
    skipped: number;
    log: string[];
    /** One entry per task the pass considered, in execution order. */
    results: TaskExecResult[];
}
/**
 * Fallback worker timeout when no explicit `timeoutMs` is given to
 * `spawnWorker`. The live auto-execute path always passes the configured
 * `workerTimeoutMinutes` (default 30); this constant only covers direct calls.
 */
export declare const DEFAULT_WORKER_TIMEOUT_MS: number;
/** Options for one worker spawn. */
export interface SpawnWorkerOptions {
    /** Directory the worker process starts in (= the DSH workspace dir). */
    cwd?: string;
    /** Kill the worker after this many milliseconds. */
    timeoutMs?: number;
}
/**
 * Spawn `dsh --profile headless "<prompt>"` and resolve when it exits.
 * Best-effort: never throws; resolves a WorkerResult even on spawn error.
 */
export declare function spawnWorker(prompt: string, opts?: SpawnWorkerOptions): Promise<WorkerResult>;
/**
 * Condense a worker's final answer into one short line for the result notice.
 *
 * The headless runner writes ONLY the final assistant text to stdout (progress
 * and reasoning go to stderr), so stdout is the answer. Blank lines and a
 * trailing bare completion marker (the worker prompt asks for `DONE`) are
 * dropped, and the rest is flattened and capped — a notification must stay
 * readable in a chat bubble.
 */
export declare function summarizeWorkerOutput(stdout: string, maxChars?: number): string;
/** Build a worker prompt from the template + this task. */
export declare function buildWorkerPrompt(template: string, task: DispatchedTask): string;
/**
 * Serial auto-execute over the given tasks.
 * @param opts.spawn - injectable worker spawn (tests pass a fake); receives the
 *   resolved timeout so a pass can be checked without a real subprocess.
 * @param opts.onComplete - injectable "mark complete" (defaults to the TickTick
 *   API's completeTask).
 */
export declare function runAutoExecute(store: DispatcherStore, api: {
    completeTask(projectId: string, taskId: string): Promise<void>;
}, tasks: DispatchedTask[], opts?: {
    spawn?: (prompt: string, opts: SpawnWorkerOptions) => Promise<WorkerResult>;
    onComplete?: (task: DispatchedTask) => Promise<void>;
    /** Push a result notification as each task settles (opt-in; real callers set it). */
    notifyResult?: boolean;
    /** Injectable notification transport (tests / custom channels). */
    notify?: (text: string) => Promise<void>;
}): Promise<AutoExecOutcome>;
/** Options for the cheap-mode gated execution (threaded into runAutoExecute). */
export interface GatedRunOptions {
    /** 手动触发时绕过省钱模式（立刻执行，不等空闲时段）。 */
    ignoreCheapMode?: boolean;
    /** Push the per-task result notifications (real callers set it). */
    notifyResult?: boolean;
    /** Injectable clock (tests / deterministic decisions). */
    now?: Date;
    spawn?: (prompt: string, opts: SpawnWorkerOptions) => Promise<WorkerResult>;
    onComplete?: (task: DispatchedTask) => Promise<void>;
    notify?: (text: string) => Promise<void>;
}
/** Outcome of a gated execution: ran now / queued / skipped / disabled. */
export interface GatedRunResult {
    mode: 'executed' | 'queued' | 'skipped' | 'disabled';
    outcome: AutoExecOutcome | null;
    executed: number;
    completed: number;
    failed: number;
    skipped: number;
    /** Number of tasks left waiting for the cheap window. */
    queued: number;
    nextCheapStartAt: string;
    nextCheapStartLabel: string;
    inPeak: boolean;
    decision: CheapDecision | null;
    log: string[];
}
/**
 * 带「省钱模式」门控的自动执行。
 *
 * 判定点刻意只在「准备开 worker 之前」：拉取节奏、过滤、串行执行都不参与判定。
 * - 省钱模式关闭（或 ignoreCheapMode）→ 与旧版完全一致，立刻执行。
 * - 高峰期 → 策略 wait 把任务落盘排队并通知；策略 skip 本轮跳过并通知。
 * - 空闲期且距下个高峰 ≥ 余量 → 立刻执行（同时把之前排队的任务一起跑了）。
 */
export declare function runAutoExecuteGated(store: DispatcherStore, api: {
    completeTask(projectId: string, taskId: string): Promise<void>;
}, tasks: DispatchedTask[], opts?: GatedRunOptions): Promise<GatedRunResult>;
/**
 * 定时器每分钟调用：队列到点（进入空闲）就把排队任务跑掉。
 *
 * 与拉取节奏解耦——即便 dispatchIntervalMinutes 很长（或为 0），排队任务也会在
 * 空闲开始后的下一次检查触发。队列在开跑前先清空，避免进程被中断后重复执行。
 *
 * @returns the outcome, or null when there is nothing due (empty queue / still peak / autoExecute off).
 */
export declare function flushCheapQueueIfDue(store: DispatcherStore, api: {
    completeTask(projectId: string, taskId: string): Promise<void>;
}, opts?: GatedRunOptions): Promise<GatedRunResult | null>;
