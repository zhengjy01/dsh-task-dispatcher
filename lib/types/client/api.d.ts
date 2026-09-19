/**
 * Browser-side API client for the /api/dsh-task-dispatcher route family.
 * The only data access path the settings panel uses — plain fetch, same origin.
 */
/** Public config view (mirrors the host contract). */
export interface DispatcherConfigView {
    configured: boolean;
    enabled: boolean;
    announceToAgent: boolean;
    dispatchIntervalMinutes: number;
    projectName: string;
    projectId: string;
    dueMode: string;
    includeUndated: boolean;
    notifyFlomo: boolean;
    flomoTag: string;
    flomoStripBodyHash: boolean;
    notifyMac: boolean;
    notifyResult: boolean;
    notifyWechat: boolean;
    wechatGatewayUrl: string;
    wechatTo: string;
    wechatStateDir: string;
    taskFile: string;
    lastDispatchAt: string;
    lastTaskCount: number;
    lastTaskTitles: string[];
    autoExecute: boolean;
    retryCooldownMinutes: number;
    workerTimeoutMinutes: number;
    workerPrompt: string;
    workerWorkspaceId: string;
    cheapMode: boolean;
    cheapPreset: string;
    cheapPresetLabel: string;
    peakWindows: {
        days: number[];
        start: string;
        end: string;
    }[];
    peakWindowsText: string;
    cheapTimezone: string;
    cheapStrategy: string;
    cheapMarginMinutes: number;
    cheapMarginEffectiveMinutes: number;
    nextCheapStartAt: string;
    cheapQueue: {
        id: string;
        title: string;
        queuedAt: string;
    }[];
    cheapQueueCount: number;
    /** 实时省钱判定（status 路由附带；未知时缺省）。 */
    inPeakNow?: boolean;
    cheapCanRunNow?: boolean;
    cheapNextStartLabel?: string;
    cheapReason?: string;
    configPath: string;
}
/** One DSH workspace (id + display title + directory path). */
export interface WorkspaceInfo {
    id: string;
    title: string;
    path: string;
}
/** Workspace list response. */
export interface WorkspaceListResult {
    workspaces: WorkspaceInfo[];
}
/** Dispatch result. */
export interface DispatcherRunResult {
    ok: boolean;
    message: string;
    dispatchedAt: string;
    projectName: string;
    projectId: string;
    taskCount: number;
    tasks: {
        id: string;
        title: string;
        dueDate: string;
    }[];
    taskFile: string;
    wechatNotify?: string;
    flomoNotify?: string;
    macNotify?: string;
    /** 省钱模式门控结果（开启自动执行时才有）。 */
    cheap?: {
        mode: string;
        executed: number;
        completed: number;
        failed: number;
        queued: number;
        nextCheapStartAt: string;
        nextCheapStartLabel: string;
        log: string[];
    };
}
/** One queued task in the deferred-sync queue. */
export interface DeferredTask {
    title: string;
    /** Parent task key ('' = top level). */
    parentKey: string;
    dueDate: string;
    stagedBy: string;
}
/** launchd timer state for the deferred sync. */
export interface DeferredTimerState {
    /** launchd exists only on macOS; other platforms degrade to manual flush. */
    supported: boolean;
    label: string;
    plistPath: string;
    installed: boolean;
    loaded: boolean;
    intervalSeconds: number;
    detail: string;
}
/** Deferred-sync status payload. */
export interface DeferredStatus {
    ok: boolean;
    message: string;
    queueFile: string;
    scriptPath: string;
    /** 'installed' = <DSH_HOME>/scripts, 'bundled' = shipped in this package. */
    scriptSource: string;
    bundledScriptPath: string;
    idleMinutes: number;
    maxPerSession: number;
    projectId: string;
    tags: string[];
    pending: number;
    pendingTop: number;
    tasks: DeferredTask[];
    /** Whole-harness silence in minutes (-1 when no session log exists yet). */
    idleMinutesNow: number;
    newestSessionAt: string;
    isIdle: boolean;
    lastFlushAt: string;
    lastFlushResult: string;
    timer: DeferredTimerState;
}
/** Result of one deferred action (flush / threshold change / timer change). */
export interface DeferredActionResult {
    ok: boolean;
    message: string;
    /** Raw child-process output, shown verbatim so failures are diagnosable. */
    output: string;
    status?: DeferredStatus;
}
/** Error carrying the route's JSON error message. */
export declare class DispatcherApiError extends Error {
    constructor(message: string);
}
/** The dispatcher panel API. */
export declare class DispatcherApi {
    getConfig(): Promise<DispatcherConfigView>;
    getStatus(): Promise<DispatcherConfigView>;
    setConfig(patch: Record<string, unknown>): Promise<DispatcherConfigView>;
    run(ignoreCheapMode?: boolean): Promise<DispatcherRunResult>;
    /** List the DSH workspaces the auto-execute worker can run in. */
    getWorkspaces(): Promise<WorkspaceInfo[]>;
    /** Deferred TickTick sync: queue, thresholds, timer state. */
    getDeferred(): Promise<DeferredStatus>;
    /** Change the silence threshold, the per-session cap, or the timer interval. */
    setDeferredConfig(patch: {
        idleMinutes?: number;
        maxPerSession?: number;
        intervalSeconds?: number;
    }): Promise<DeferredActionResult>;
    /** Write the queue to TickTick now. */
    flushDeferred(force?: boolean): Promise<DeferredActionResult>;
    /** Install/reload/remove the launchd timer, or refresh the local script copy. */
    deferredTimer(action: 'install' | 'reload' | 'uninstall' | 'install-script', intervalSeconds?: number): Promise<DeferredActionResult>;
}
