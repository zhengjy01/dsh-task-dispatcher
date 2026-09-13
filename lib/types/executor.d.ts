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
