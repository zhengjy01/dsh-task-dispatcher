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
    taskFile: string;
    lastDispatchAt: string;
    lastTaskCount: number;
    lastTaskTitles: string[];
    autoExecute: boolean;
    retryCooldownMinutes: number;
    workerPrompt: string;
    workerWorkspaceId: string;
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
    /** List the DSH workspaces the auto-execute worker can run in. */
    getWorkspaces(): Promise<WorkspaceInfo[]>;
}
