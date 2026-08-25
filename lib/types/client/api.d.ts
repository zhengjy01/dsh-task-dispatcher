/**
 * Browser-side API client for the /api/dsh-task-dispatcher route family.
 * The only data access path the settings panel uses — plain fetch, same origin.
 */
/** Public config view (mirrors the host contract). */
export interface DispatcherConfigView {
    configured: boolean;
    enabled: boolean;
    announceToAgent: boolean;
    dispatchHour: number;
    dispatchMinute: number;
    projectName: string;
    projectId: string;
    dueMode: string;
    includeUndated: boolean;
    notifyFlomo: boolean;
    flomoTag: string;
    notifyMac: boolean;
    taskFile: string;
    lastDispatchAt: string;
    lastTaskCount: number;
    lastTaskTitles: string[];
    configPath: string;
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
    flomoNotify?: string;
    macNotify?: string;
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
    run(): Promise<DispatcherRunResult>;
}
