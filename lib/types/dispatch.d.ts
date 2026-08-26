/**
 * dsh-task-dispatcher — the dispatch core.
 *
 * A dispatch resolves the configured TickTick source project, pulls its
 * incomplete tasks, filters to today's actionable ones (due today/overdue,
 * plus undated when configured), writes a today-tasks file the agent reads,
 * and notifies (flomo + macOS). The actual task execution is done by the
 * agent in DSH using the existing dsh-ticktick tools; the file + notification
 * simply tell the agent what to work on today and write results back.
 *
 * Reuses the dsh-ticktick data layer (TickTickStore + TickTickApi) so the
 * same OAuth token drives everything — no duplicate credentials.
 */
import { TickTickApi } from 'dsh-ticktick';
import type { DispatcherStore } from './store.ts';
import { type NotifyResult } from './notify.ts';
/** One task picked for today's dispatch. */
export interface DispatchedTask {
    id: string;
    projectId: string;
    title: string;
    content: string;
    dueDate: string;
    priority: number;
    tags: string[];
}
/** Outcome of a dispatch. */
export interface DispatchResult {
    ok: boolean;
    message: string;
    dispatchedAt: string;
    projectName: string;
    projectId: string;
    taskCount: number;
    tasks: DispatchedTask[];
    taskFile: string;
    notifies: NotifyResult[];
    /** True when the task set changed since the last dispatch (or a manual run forced a notify). */
    changed: boolean;
    /** True when at least one notify channel fired. */
    notified: boolean;
}
/** Local calendar date as YYYY-MM-DD. */
export declare function localDateString(d?: Date): string;
/**
 * Run one dispatch using the given store and (optionally) an injected
 * TickTickApi (the smoke tests inject a fake). Writes the today-tasks file
 * and notifies, then records the dispatch on the store.
 *
 * On the scheduled interval, notify only when the task set CHANGED since the
 * last dispatch (so a repeated pull with no new tasks stays silent). A manual
 * `dispatcher_run` passes { forceNotify: true } to always notify.
 */
export declare function doDispatch(store: DispatcherStore, api: TickTickApi, opts?: {
    forceNotify?: boolean;
}): Promise<DispatchResult>;
