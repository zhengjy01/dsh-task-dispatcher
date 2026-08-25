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

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TickTickStore, TickTickApi } from 'dsh-ticktick'
import { DispatcherStore } from './store.ts'
import { buildTools } from './tools.ts'
import { makeRoutes, DISPATCHER_API } from './routes.ts'
import { doDispatch, localDateString } from './dispatch.ts'

/** Stable cordis plugin name. */
export const name = 'task-dispatcher'

/** Services required before the dispatcher surfaces can mount. */
export const inject = ['tools', 'systemPrompt', 'webServer', 'timer']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 170

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const DISPATCHER_GUIDANCE =
  '本机已安装 dsh-task-dispatcher 插件（滴答清单任务派发器）：每天早上（默认 08:30）会把滴答清单「5️⃣AI」（或配置的来源）中今天到期/逾期的任务写入今日任务文件（默认 ~/.dsh/dsh-task-dispatcher/today-tasks.md），' +
  '并发送 flomo+macOS 通知。工具：dispatcher_status（状态）、dispatcher_config（配置派发时间/来源/过滤/通知）、dispatcher_run（立即派发一次）。' +
  '当你开始一天的工作时，先用 read 读取今日任务文件，逐项执行；完成的用 ticktick_complete 回写滴答清单，并把结果落到 Obsidian 知识库/项目档案。' +
  '用户提到「任务派发器 / 今日任务 / 派发 / 今天要做啥」时即指本插件，请据此协作。'

/** Plugin config, read from the composition row. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, tools, prompt section, timer). */
  enabled?: boolean
  /** Daily dispatch hour (0-23). */
  dispatchHour?: number
  /** Daily dispatch minute (0-59). */
  dispatchMinute?: number
  /** Source TickTick list name. */
  projectName?: string
}

/**
 * Mount the dispatcher tools, routes, announcement, and daily timer.
 * @param ctx - host plugin context carrying tools/systemPrompt/webServer/timer.
 * @param config - plugin config from the composition row.
 */
export function apply(ctx: Context, config?: Config): void {
  const announceToAgent = config?.announceToAgent !== false
  const enabled = config?.enabled !== false
  const store = new DispatcherStore()
  const tickStore = new TickTickStore()
  const api = new TickTickApi(tickStore)
  const toolContext = { store, api }

  let disposeTools: (() => void) | undefined
  let disposeRoutes: (() => void) | undefined
  let disposeSection: (() => void) | undefined
  let disposeTimer: (() => void) | undefined

  const sync = (): void => {
    if (disposeTools !== undefined) { disposeTools(); disposeTools = undefined }
    if (disposeRoutes !== undefined) { disposeRoutes(); disposeRoutes = undefined }
    if (disposeSection !== undefined) { disposeSection(); disposeSection = undefined }
    if (disposeTimer !== undefined) { disposeTimer(); disposeTimer = undefined }
    if (!enabled) return

    disposeTools = ctx.effect(
      () => {
        const disposers = buildTools(toolContext).map((tool) => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-task-dispatcher: tools',
    )
    disposeRoutes = ctx.effect(
      () => {
        const disposers = makeRoutes(toolContext).map((route) => ctx.webServer.register(route))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-task-dispatcher: routes',
    )
    if (announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-task-dispatcher',
        order: SECTION_ORDER,
        text: DISPATCHER_GUIDANCE,
      })
    }

    // Daily dispatch: poll each minute, dispatch when the clock reaches the
    // configured time (and only once — the minute gate is the guard, since the
    // next poll is a minute later). Manual dispatcher_run still works anytime.
    disposeTimer = ctx.interval(() => {
      void (async () => {
        try {
          const cfg = await store.load()
          if (!cfg.enabled) return
          const now = new Date()
          if (now.getHours() !== cfg.dispatchHour || now.getMinutes() !== cfg.dispatchMinute) return
          // Already dispatched this minute? The store's lastDispatchAt guards a
          // process restart within the same minute.
          if (cfg.lastDispatchAt.slice(0, 16) === localDateString(now) + 'T' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')) return
          const result = await doDispatch(store, api)
          ctx.logger?.info?.('[dsh-task-dispatcher] dispatch: ' + result.message)
        } catch (error) {
          ctx.logger?.warn?.('[dsh-task-dispatcher] dispatch failed: ' + String(error instanceof Error ? error.message : error))
        }
      })()
    }, 60 * 1000)
  }

  sync()
}

/** Re-exports for host consumers and the smoke tests. */
export { DispatcherStore, configPath, DEFAULT_CONFIG_FILE, DEFAULT_TASK_FILE, type DispatcherConfig, type DispatcherConfigView } from './store.ts'
export { doDispatch, localDateString, type DispatchedTask, type DispatchResult } from './dispatch.ts'
export { flomoMemo, macNotify } from './notify.ts'
export { dispatcherStatusTool, dispatcherConfigTool, dispatcherRunTool, buildTools, type ToolContext } from './tools.ts'
export { makeRoutes, DISPATCHER_API } from './routes.ts'
export { defineTool }
