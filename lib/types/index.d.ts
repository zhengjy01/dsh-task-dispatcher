/**
 * dsh-task-dispatcher — use TickTick (滴答清单) as the daily task dispatcher.
 * Host half.
 *
 * Mounts the dispatcher tools (status / config / run), the /api/dsh-task-dispatcher
 * route family the settings panel talks to, a daily dispatch timer (cordis
 * ctx.interval; fires each minute and dispatches at the configured time), and
 * a system-prompt announcement. On each dispatch it pulls today's due tasks
 * from the configured TickTick list (default 5️⃣AI), writes them to the today-tasks
 * file, and notifies (flomo + macOS). Execution is done by the agent using the
 * existing dsh-ticktick tools; this plugin only decides "what to do today" and
 * tells the agent.
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
    /** Daily dispatch hour (0-23). */
    dispatchHour?: number;
    /** Daily dispatch minute (0-59). */
    dispatchMinute?: number;
    /** Source TickTick list name. */
    projectName?: string;
}
/**
 * Mount the dispatcher tools, routes, announcement, and daily timer.
 * @param ctx - host plugin context carrying tools/systemPrompt/webServer/timer.
 * @param config - plugin config from the composition row.
 */
export declare function apply(ctx: Context, config?: Config): void;
/** Re-exports for host consumers and the smoke tests. */
export { DispatcherStore, configPath, DEFAULT_CONFIG_FILE, DEFAULT_TASK_FILE, type DispatcherConfig, type DispatcherConfigView } from './store.ts';
export { doDispatch, localDateString, type DispatchedTask, type DispatchResult } from './dispatch.ts';
export { flomoMemo, macNotify } from './notify.ts';
export { dispatcherStatusTool, dispatcherConfigTool, dispatcherRunTool, buildTools, type ToolContext } from './tools.ts';
export { makeRoutes, DISPATCHER_API } from './routes.ts';
export { defineTool };
