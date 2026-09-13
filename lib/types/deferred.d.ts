/**
 * dsh-task-dispatcher — deferred TickTick sync control plane.
 *
 * The queue is written to TickTick by a standalone Node script driven by a
 * launchd timer, and that split is deliberate: the flush must be able to happen
 * while **DSH is closed** (a session that ended at 21:00 should still land in
 * TickTick at 21:12), which an in-process timer can never guarantee. This module
 * is therefore the control plane, not the engine:
 *
 *   - it reads the *same* queue file (`<DSH_HOME>/dsh-ticktick-pending.json`),
 *   - it computes the *same* idle verdict the script computes (newest session
 *     log mtime across the whole harness home, not just one session),
 *   - and it lets the settings panel change the thresholds, flush by hand, and
 *     install/reload/remove the launchd timer.
 *
 * The queue file is the only contract between the two halves, so no behaviour
 * is duplicated: the write path (credentials, dedupe, parentId, dueDate
 * rollover) lives in the script and stays there.
 */
/** launchd label shared with the standalone script's timer. */
export declare const TIMER_LABEL = "com.dsh.ticktick-deferred-sync";
/** Queue file (also read/written by the standalone script). */
export declare function queuePath(): string;
/** Where the script is installed for the timer to run. */
export declare function installedScriptPath(): string;
/** The copy shipped inside this plugin (works on a machine that never had it). */
export declare function bundledScriptPath(): string;
/** launchd plist path (macOS only). */
export declare function timerPlistPath(): string;
/** Queue shape (defaults mirror the script's DEFAULT_CONFIG). */
export interface DeferredQueue {
    version: number;
    idleMinutes: number;
    maxPerSession: number;
    projectId: string;
    tags: string[];
    tasks: {
        title?: string;
        parentKey?: string;
        dueDate?: string;
        stagedBy?: string;
    }[];
    lastFlushAt: string | null;
    lastFlushResult: string | null;
}
/** Default queue contents, used when the file does not exist yet. */
export declare function defaultQueue(): DeferredQueue;
/** Timer state read off the plist + launchctl. */
export interface TimerState {
    /** launchd only exists on macOS; other platforms degrade to manual flush. */
    supported: boolean;
    label: string;
    plistPath: string;
    installed: boolean;
    loaded: boolean;
    intervalSeconds: number;
    /** launchctl's own rendering errors, surfaced for the panel. */
    detail: string;
}
/** Full status payload for the panel. */
export interface DeferredStatus {
    ok: boolean;
    message: string;
    queueFile: string;
    scriptPath: string;
    /** 'installed' = <home>/scripts, 'bundled' = this package, 'missing' = neither. */
    scriptSource: 'installed' | 'bundled' | 'missing';
    bundledScriptPath: string;
    idleMinutes: number;
    maxPerSession: number;
    projectId: string;
    tags: string[];
    pending: number;
    pendingTop: number;
    tasks: {
        title: string;
        parentKey: string;
        dueDate: string;
        stagedBy: string;
    }[];
    /** Whole-harness silence, in minutes. */
    idleMinutesNow: number;
    newestSessionAt: string;
    isIdle: boolean;
    lastFlushAt: string;
    lastFlushResult: string;
    timer: TimerState;
}
/** Result of one action (flush / install / timer). */
export interface DeferredAction {
    ok: boolean;
    message: string;
    /** Raw child-process output, shown verbatim so a failure is diagnosable. */
    output: string;
    status?: DeferredStatus;
}
/** Newest session-log mtime under `<home>/sessions` (0 when none). */
export declare function newestSessionMtime(sessionsDir?: string): number;
/** Coerce the queue file, tolerating a hand-edited or partial file. */
export declare function coerceQueue(raw: unknown): DeferredQueue;
/** The control plane. */
export declare class DeferredController {
    /** Read the queue (defaults when absent/corrupt). */
    readQueue(): Promise<DeferredQueue>;
    /** Persist the queue with owner-only permissions. */
    writeQueue(queue: DeferredQueue): Promise<void>;
    /** Which copy of the script would run. */
    resolveScript(): {
        path: string;
        source: 'installed' | 'bundled' | 'missing';
    };
    /** Read the timer's plist + launchd state. */
    timerState(): Promise<TimerState>;
    /** The full panel payload. */
    status(): Promise<DeferredStatus>;
    /**
     * Change the thresholds.
     *
     * `idleMinutes` / `maxPerSession` live in the queue file (the script reads it
     * on every run, so a change applies to the very next tick). `intervalSeconds`
     * lives in the launchd plist, so it is written and the timer reloaded — a
     * plist edit alone is not picked up by an already-loaded job.
     */
    patchConfig(patch: {
        idleMinutes?: number;
        maxPerSession?: number;
        intervalSeconds?: number;
    }): Promise<DeferredAction>;
    /** Write the plist for `intervalSeconds` and reload the timer. */
    writeTimer(intervalSeconds: number): Promise<DeferredAction>;
    /** Remove the timer (the queue file is left alone). */
    removeTimer(): Promise<DeferredAction>;
    /** Copy the bundled script into `<home>/scripts` (skipped when already there). */
    installScript(force: boolean): Promise<DeferredAction>;
    /** Write the queue to TickTick now (runs the script's `flush`). */
    flush(force: boolean): Promise<DeferredAction>;
}
