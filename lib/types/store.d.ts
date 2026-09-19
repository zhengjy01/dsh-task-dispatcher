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
import { type PeakWindow } from './cheap.ts';
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
/** 省钱模式排队策略：wait = 排队等到下个空闲开始；skip = 本轮跳过。 */
export type CheapStrategy = 'wait' | 'skip';
/**
 * 一条「省钱模式」排队任务（等待空闲时段执行）。
 * 结构与 DispatchedTask 一致，额外带排队时间；整体落盘，宿主重启不丢。
 */
export interface QueuedTask {
    id: string;
    projectId: string;
    title: string;
    content: string;
    dueDate: string;
    startDate: string;
    actionable: boolean;
    priority: number;
    tags: string[];
    /** ISO time this task was queued. */
    queuedAt: string;
}
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
    /** 「省钱模式」：勾选后自动执行只在 DeepSeek 空闲时段开跑（默认 false）。 */
    cheapMode: boolean;
    /** 高峰时段口径 preset：official-2026 / legacy-utc / custom。 */
    cheapPreset: string;
    /** 高峰时段黑名单（custom 时使用；切 preset 会覆盖它）。 */
    peakWindows: PeakWindow[];
    /** 解释高峰时段用的 IANA 时区（默认 Asia/Shanghai）。 */
    cheapTimezone: string;
    /** 高峰期策略：wait = 排队等到下个空闲；skip = 本轮跳过。 */
    cheapStrategy: CheapStrategy;
    /** 尾部余量（分钟；0 = 自动用 workerTimeoutMinutes）。 */
    cheapMarginMinutes: number;
    /** 已排队任务的下个空闲开始时刻（ISO；无排队时空串）。 */
    nextCheapStartAt: string;
    /** 等待空闲时段执行的排队任务（落盘，宿主重启不丢）。 */
    cheapQueue: QueuedTask[];
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
    cheapMode: boolean;
    cheapPreset: string;
    cheapPresetLabel: string;
    peakWindows: PeakWindow[];
    /** 高峰时段编辑器的文本形式（每行 `1,2,3,4,5 09:00-12:00`）。 */
    peakWindowsText: string;
    cheapTimezone: string;
    cheapStrategy: CheapStrategy;
    cheapMarginMinutes: number;
    /** 实际生效的余量（0 = 自动取 workerTimeoutMinutes）。 */
    cheapMarginEffectiveMinutes: number;
    nextCheapStartAt: string;
    cheapQueue: QueuedTask[];
    cheapQueueCount: number;
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
    /** 把任务合并进省钱模式排队队列，并记录下个空闲开始时刻（落盘）。 */
    enqueueCheap(tasks: Array<Omit<QueuedTask, 'queuedAt'>>, nextCheapStartAt: string): Promise<DispatcherConfigView>;
    /** 清空排队队列（到点执行 / 关闭省钱模式 / 手动绕过时调用）。 */
    clearCheapQueue(): Promise<DispatcherConfigView>;
    /** Record a completed dispatch summary. */
    recordDispatch(titles: string[]): Promise<DispatcherConfigView>;
    /** Mark a task id as attempted now (for auto-execute retry cooldown). */
    markAttempted(taskId: string): Promise<void>;
    /** Re-attempt logic: whether `now` is past the retry cooldown for a task id. */
    canRetry(taskId: string, cooldownMinutes: number): Promise<boolean>;
}
