/**
 * dsh-task-dispatcher — use TickTick (滴答清单) as the daily task dispatcher.
 * Host half.
 *
 * Mounts the dispatcher tools (status / config / run), the /api/dsh-task-dispatcher
 * route family the settings panel talks to, a self-adjusting poll timer (cordis
 * ctx.interval; polls each minute and pulls when the configured interval has
 * elapsed since the last dispatch), and a system-prompt announcement. On each
 * pull it reads today's due tasks from the configured TickTick list (default
 * 5️⃣AI), writes them to the today-tasks file, and notifies (flomo + macOS) only
 * when the task set changed. Execution is done by the agent using the existing
 * dsh-ticktick tools; this plugin only decides "what to do now" and tells the
 * agent.
 *
 * Reuses dsh-ticktick's data layer (TickTickStore + TickTickApi) so the single
 * OAuth token drives everything; no duplicate credentials. Plugin config lives
 * in ~/.dsh/dsh-task-dispatcher.json (mode 0600).
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
/** Stable cordis plugin name. */
export declare const name = "task-dispatcher";
/** Services required before the dispatcher surfaces can mount. */
export declare const inject: string[];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
export declare const DISPATCHER_GUIDANCE: string;
/** Plugin config, read from the composition row. */
export interface Config {
    /** When true (default), a system-prompt section announces the plugin. */
    announceToAgent?: boolean;
    /** Master switch for the plugin (routes, tools, prompt section, timer). */
    enabled?: boolean;
    /** Poll interval in minutes; 0 disables the automatic pull. */
    dispatchIntervalMinutes?: number;
    /** Source TickTick list name. */
    projectName?: string;
    /** Auto-execute each pulled task in its own headless session. */
    autoExecute?: boolean;
}
/**
 * Mount the dispatcher tools, routes, announcement, and daily timer.
 * @param ctx - host plugin context carrying tools/systemPrompt/webServer/timer.
 * @param config - plugin config from the composition row.
 */
export declare function apply(ctx: Context, config?: Config): void;
/** Re-exports for host consumers and the smoke tests. */
export { dshHome, pluginPath } from './home.ts';
export { DispatcherStore, configPath, DEFAULT_CONFIG_FILE, DEFAULT_TASK_FILE, DEFAULT_WORKER_PROMPT, DEFAULT_WORKER_TIMEOUT_MINUTES, type DispatcherConfig, type DispatcherConfigView } from './store.ts';
export { doDispatch, notifyText, localDateString, type DispatchedTask, type DispatchResult, type NotifyChannel } from './dispatch.ts';
export { flomoMemo, macNotify, wechatSend, wechatRecipient, wechatStateDir, escapeHashes, buildFlomoContent, HASH_SAFE, WECHAT_GATEWAY_URL, type WechatOptions } from './notify.ts';
export { dispatcherStatusTool, dispatcherConfigTool, dispatcherRunTool, dispatcherReportTool, buildTools, type ToolContext } from './tools.ts';
export { makeRoutes, DISPATCHER_API } from './routes.ts';
export { runAutoExecute, spawnWorker, buildWorkerPrompt, summarizeWorkerOutput, DEFAULT_WORKER_TIMEOUT_MS, type WorkerResult, type TaskExecResult, type AutoExecOutcome } from './executor.ts';
export { listWorkspaces, resolveWorkspacePath, resolveWorkspaceTitle, workspaceStorePath, DEFAULT_WORKSPACE_STORE, type WorkspaceInfo } from './workspaces.ts';
export { DeferredController, TIMER_LABEL, bundledScriptPath, coerceQueue, defaultQueue, installedScriptPath, newestSessionMtime, queuePath, timerPlistPath, type DeferredAction, type DeferredQueue, type DeferredStatus, type TimerState, } from './deferred.ts';
export { defineTool };
