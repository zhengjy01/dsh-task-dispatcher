/**
 * dsh-task-dispatcher — model-facing tools.
 *
 * Mounted via ctx.tools.register. Covers the task-dispatcher surface:
 * status, config, and a manual run-dispatch-now action. Every tool resolves
 * to { ok, message, ... } and never throws for API-level outcomes.
 */
import { TickTickApi } from 'dsh-ticktick';
import type { DispatcherStore } from './store.ts';
/** Shared tool dependencies. */
export interface ToolContext {
    store: DispatcherStore;
    api: TickTickApi;
}
/** Status tool: config + last dispatch summary. */
export declare function dispatcherStatusTool(ctx: ToolContext): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Config tool: update dispatcher settings. */
export declare function dispatcherConfigTool(ctx: ToolContext): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Run tool: perform a dispatch now. */
export declare function dispatcherRunTool(ctx: ToolContext): import("@deepseek-ai/dsh-tools").ToolDefinition;
/** Build the tool list for registration. */
export declare function buildTools(ctx: ToolContext): import("@deepseek-ai/dsh-tools").ToolDefinition[];
