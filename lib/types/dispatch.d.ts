/**
 * dsh-task-dispatcher — the dispatch core.
 *
 * A dispatch resolves the configured TickTick source project, pulls its
 * incomplete tasks, filters to today's relevant ones, writes a today-tasks
 * file the agent reads (each task: title + due date + its TickTick description
 * quoted underneath), and notifies (flomo + macOS). The actual task execution
 * is done by the agent in DSH using the existing dsh-ticktick tools; the file
 * + notification simply tell the agent what to work on today and write results
 * back.
 *
 * 「今天相关」有两条独立判据，刻意分开（拉取按窗口、执行按截止）：
 * - **拉取**：`dueDate <= today`（到期/逾期）**或** `startDate <= today`
 *   （时间段任务已进窗口——TickTick 的「今天」包含这些，旧版只比 dueDate 会漏掉）。
 * - **自动执行**：只有到期/逾期任务可以跑；窗口任务只进文件 + 通知，
 *   因为「开始日到了」只代表可以开始，不代表今天该做完。
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
    /** 开始日（时间段任务起点）；空串表示任务没有开始日。 */
    startDate: string;
    /**
     * 是否可以「现在就自动执行」。
     *
     * 判定与「是否拉取」刻意分开（拉取按窗口、执行按截止）：
     * - true  = 今天到期/逾期（或配置放行的无截止任务）→ autoExecute 会跑
     * - false = 窗口任务（开始日已到、截止日未到）→ 只进今日任务文件 + 通知，
     *   交给 agent 判断该不该提前动，绝不自动执行
     *
     * 原因：「观察后真删 X」这类任务的开始日就是今天、截止日在两周后，
     * 按开始日自动执行会在当天就做出不可逆的删除。
     */
    actionable: boolean;
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
