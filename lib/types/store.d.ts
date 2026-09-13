/**
 * dsh-task-dispatcher — config store.
 *
 * Persists the dispatcher configuration (poll interval, source TickTick
 * project, filtering, notify toggles, and the last dispatch summary) to
 * ~/.dsh/dsh-task-dispatcher.json (mode 0600). Reuses the TickTick OAuth
 * credentials already stored by the dsh-ticktick plugin (~/.dsh/dsh-ticktick.json)
 * — it never stores its own secrets. Reads are lazy and cached; the public
 * view() never exposes tokens. The config path can be overridden with
 * DSH_TASK_DISPATCHER_CONFIG (used by the smoke tests).
 */
/** Default config location: DSH_HOME when set, else ~/.dsh (mode 0600). */
export declare const DEFAULT_CONFIG_FILE: string;
/** Default workspace task file written on each dispatch (under DSH_HOME). */
export declare const DEFAULT_TASK_FILE: string;
/** Default minutes before an auto-execute worker is killed (was a hardcoded 10). */
export declare const DEFAULT_WORKER_TIMEOUT_MINUTES = 30;
/** Default worker prompt template ({title}/{content} replaced per task). */
export declare const DEFAULT_WORKER_PROMPT: string;
/** Config location: DSH_TASK_DISPATCHER_CONFIG → DSH_HOME → ~/.dsh (mode 0600). */
export declare function configPath(): string;
/** How to select tasks from the source project. */
export type DueMode = 'today' | 'all';
/** Persisted config shape. No secrets here. */
export interface DispatcherConfig {
    enabled: boolean;
    announceToAgent: boolean;
    /** Poll interval in minutes; 0 disables the automatic pull. */
    dispatchIntervalMinutes: number;
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
    /** Strip '#' from the dispatch flomo body so inline #word isn't a tag. */
    flomoStripBodyHash: boolean;
    /** Post a macOS notification on each dispatch. */
    notifyMac: boolean;
    /** Push a SHORT result notice after every auto-executed task (and a batch tally). */
    notifyResult: boolean;
    /** Push the dispatch notification / session report to WeChat via ClawBot. */
    notifyWechat: boolean;
    /** ClawBot gateway base URL; '' = http://127.0.0.1:51235. */
    wechatGatewayUrl: string;
    /** WeChat recipient id; '' = auto-detect the ClawBot-logged-in user. */
    wechatTo: string;
    /** ClawBot state dir; '' = $DSH_WECHAT_HOME or ~/.dsh-wechat. */
    wechatStateDir: string;
    /** Where the today-tasks file is written. */
    taskFile: string;
    /** ISO timestamp of the last successful dispatch. */
    lastDispatchAt: string;
    /** Number of tasks in the last dispatch. */
    lastTaskCount: number;
    /** Titles of the tasks in the last dispatch (for the status view). */
    lastTaskTitles: string[];
    /** Auto-execute each pulled task in its own headless DSH session. */
    autoExecute: boolean;
    /** Minutes before re-attempting a task whose worker failed (retry cooldown). */
    retryCooldownMinutes: number;
    /** Kill an auto-execute worker after this many minutes (default 30). */
    workerTimeoutMinutes: number;
    /** Worker prompt template; {title}/{content} replaced per task. */
    workerPrompt: string;
    /** DSH workspace id the auto-execute worker session runs in ('' = home dir). */
    workerWorkspaceId: string;
    /** TaskId -> ISO time of last auto-execute attempt (avoids re-spawning). */
    attempted: Record<string, string>;
}
/** Public, secret-free status view. */
export interface DispatcherConfigView {
    configured: boolean;
    enabled: boolean;
    announceToAgent: boolean;
    dispatchIntervalMinutes: number;
    projectName: string;
    projectId: string;
    dueMode: DueMode;
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
    /** Mark a task id as attempted now (for auto-execute retry cooldown). */
    markAttempted(taskId: string): Promise<void>;
    /** Re-attempt logic: whether `now` is past the retry cooldown for a task id. */
    canRetry(taskId: string, cooldownMinutes: number): Promise<boolean>;
}
