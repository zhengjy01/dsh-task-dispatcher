/**
 * dsh-task-dispatcher — config store.
 *
 * Persists the dispatcher configuration (dispatch time, source TickTick
 * project, filtering, notify toggles, and the last dispatch summary) to
 * ~/.dsh/dsh-task-dispatcher.json (mode 0600). Reuses the TickTick OAuth
 * credentials already stored by the dsh-ticktick plugin (~/.dsh/dsh-ticktick.json)
 * — it never stores its own secrets. Reads are lazy and cached; the public
 * view() never exposes tokens. The config path can be overridden with
 * DSH_TASK_DISPATCHER_CONFIG (used by the smoke tests).
 */
/** Default machine-wide config location (mode 0600). */
export declare const DEFAULT_CONFIG_FILE: string;
/** Default workspace task file written on each dispatch. */
export declare const DEFAULT_TASK_FILE: string;
/** Test override for the config location. */
export declare function configPath(): string;
/** How to select tasks from the source project. */
export type DueMode = 'today' | 'all';
/** Persisted config shape. No secrets here. */
export interface DispatcherConfig {
    enabled: boolean;
    announceToAgent: boolean;
    /** Daily dispatch hour (0-23). */
    dispatchHour: number;
    /** Daily dispatch minute (0-59). */
    dispatchMinute: number;
    /** Source TickTick list, resolved by name; falls back to projectId. */
    projectName: string;
    /** Optional explicit project id (name-resolution wins when both present). */
    projectId?: string;
    /** today = due today/overdue; all = every incomplete task in the list. */
    dueMode: DueMode;
    /** Whether to include tasks with no due date (when dueMode = today). */
    includeUndated: boolean;
    /** Push a flomo MEMO on each dispatch. */
    notifyFlomo: boolean;
    /** flomo tag (no leading #; space-separated allowed). */
    flomoTag: string;
    /** Post a macOS notification on each dispatch. */
    notifyMac: boolean;
    /** Where the today-tasks file is written. */
    taskFile: string;
    /** ISO timestamp of the last successful dispatch. */
    lastDispatchAt: string;
    /** Number of tasks in the last dispatch. */
    lastTaskCount: number;
    /** Titles of the tasks in the last dispatch (for the status view). */
    lastTaskTitles: string[];
}
/** Public, secret-free status view. */
export interface DispatcherConfigView {
    configured: boolean;
    enabled: boolean;
    announceToAgent: boolean;
    dispatchHour: number;
    dispatchMinute: number;
    projectName: string;
    projectId: string;
    dueMode: DueMode;
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
/**
 * Config store backed by ~/.dsh/dsh-task-dispatcher.json.
 * Reads are lazy and cached; writes use mode 0600.
 */
export declare class DispatcherStore {
    config: DispatcherConfig | null;
    load(): Promise<DispatcherConfig>;
    save(next: DispatcherConfig): Promise<void>;
    /** Public, secret-free view. */
    view(): Promise<DispatcherConfigView>;
    /** Apply a config patch: strings/numbers/booleans replace, undefined keeps. */
    patch(args: Record<string, unknown> | undefined): Promise<DispatcherConfigView>;
    /** Record a completed dispatch summary. */
    recordDispatch(titles: string[]): Promise<DispatcherConfigView>;
}
