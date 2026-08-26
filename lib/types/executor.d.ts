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
import type { DispatcherStore } from './store.ts';
import type { DispatchedTask } from './dispatch.ts';
/** Outcome of one worker subprocess. */
export interface WorkerResult {
    ok: boolean;
    exitCode: number | null;
    output: string;
    error?: string;
}
/** Outline of one auto-execute pass. */
export interface AutoExecOutcome {
    executed: number;
    completed: number;
    failed: number;
    skipped: number;
    log: string[];
}
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
/** Build a worker prompt from the template + this task. */
export declare function buildWorkerPrompt(template: string, task: DispatchedTask): string;
/**
 * Serial auto-execute over the given tasks.
 * @param opts.spawn - injectable worker spaw (tests pass a fake).
 * @param opts.onComplete - injectable "mark complete" (defaults to the TickTick
 *   API's completeTask).
 */
export declare function runAutoExecute(store: DispatcherStore, api: {
    completeTask(projectId: string, taskId: string): Promise<void>;
}, tasks: DispatchedTask[], opts?: {
    spawn?: (prompt: string) => Promise<WorkerResult>;
    onComplete?: (task: DispatchedTask) => Promise<void>;
}): Promise<AutoExecOutcome>;
