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
import { runAutoExecute } from './executor.ts'

/** Stable cordis plugin name. */
export const name = 'task-dispatcher'

/** Services required before the dispatcher surfaces can mount. */
export const inject = ['tools', 'systemPrompt', 'webServer', 'timer']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 170

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const DISPATCHER_GUIDANCE =
  '本机已安装 dsh-task-dispatcher 插件（滴答清单任务派发器）：每隔一段可配置的间隔（默认每 30 分钟）自动从滴答清单「5️⃣AI」（或配置的来源）拉取今天到期/逾期的任务，写入今日任务文件（默认 DSH_HOME 下的 dsh-task-dispatcher/today-tasks.md，DSH_HOME 未设时回落 ~/.dsh），' +
  '并在任务发生变化时发送通知（默认走**微信**：通过本机微信机器人 ClawBot 的网关 127.0.0.1:51235 把消息发到扫码登录的那个微信；flomo / macOS 通道保留，由配置开关决定）。工具：dispatcher_status（状态）、dispatcher_config（配置拉取间隔/来源/过滤/通知渠道/自动执行/worker 超时；testWechat 可发测试消息）、dispatcher_run（立即拉取一次）、dispatcher_report（执行完/会话结束后发一条汇总，默认发微信）。' +
  '自动执行的单个 worker 有超时保护（workerTimeoutMinutes，默认 30 分钟，到点 SIGKILL），可在设置面板或 dispatcher_config 调整。' +
  '你任务都是随手写进滴答清单的，插件会自动跟上：随时往清单里加任务，下次拉取就会带进来。' +
  '当你开始一天的工作时，先用 read 读取今日任务文件，逐项执行；完成的用 ticktick_complete 回写滴答清单，并把结果落到 Obsidian 知识库/项目档案。' +
  '**执行结果回执（notifyResult，默认开）**：自动执行的每个任务在 worker 结束后会**自动**推一条简明结果（✅/❌ + 标题 + 一句话结果）到已开启的通知通道（默认微信），多任务再补一条批次汇总——这条不依赖 worker 自己记得汇报。每次执行完/告一段落后，还要调用 dispatcher_report 把本次完成/失败/跳过情况汇总（total/completed/failed/skipped + 可选 summary），它会按配置把汇总发到微信（默认通道）。' +
  '用户提到「任务派发器 / 今日任务 / 派发 / 今天要做啥」时即指本插件，请据此协作。'

/** Plugin config, read from the composition row. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, tools, prompt section, timer). */
  enabled?: boolean
  /** Poll interval in minutes; 0 disables the automatic pull. */
  dispatchIntervalMinutes?: number
  /** Source TickTick list name. */
  projectName?: string
  /** Auto-execute each pulled task in its own headless session. */
  autoExecute?: boolean
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
  let busy = false

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

    // Automatic pull: poll every 60s and pull when at least the configured
    // interval (minutes) has elapsed since the last dispatch. This reacts to a
    // runtime interval change without re-arming, and notifies only on change.
    // Manual dispatcher_run still works anytime.
    disposeTimer = ctx.interval(() => {
      void (async () => {
        if (busy) return
        busy = true
        try {
          const cfg = await store.load()
          if (!cfg.enabled) return
          const minutes = cfg.dispatchIntervalMinutes
          if (minutes <= 0) return
          const now = Date.now()
          const last = cfg.lastDispatchAt !== '' ? new Date(cfg.lastDispatchAt).getTime() : 0
          if (last !== 0 && now - last < minutes * 60 * 1000) return
          const result = await doDispatch(store, api)
          ctx.logger?.info?.('[dsh-task-dispatcher] pull: ' + result.message)
          // Auto-execute each pulled task in its own headless session (serial).
          if (cfg.autoExecute && result.tasks.length > 0) {
            ctx.logger?.info?.('[dsh-task-dispatcher] auto-executing ' + result.tasks.length + ' task(s), serial')
            const exec = await runAutoExecute(store, api, result.tasks, { notifyResult: true })
            ctx.logger?.info?.('[dsh-task-dispatcher] auto-execute: ' + exec.log.join(' | '))
          }
        } catch (error) {
          ctx.logger?.warn?.('[dsh-task-dispatcher] pull failed: ' + String(error instanceof Error ? error.message : error))
        } finally {
          busy = false
        }
      })()
    }, 60 * 1000)
  }

  sync()
}

/** Re-exports for host consumers and the smoke tests. */
export { dshHome, pluginPath } from './home.ts'
export { DispatcherStore, configPath, DEFAULT_CONFIG_FILE, DEFAULT_TASK_FILE, DEFAULT_WORKER_PROMPT, DEFAULT_WORKER_TIMEOUT_MINUTES, type DispatcherConfig, type DispatcherConfigView } from './store.ts'
export { doDispatch, notifyText, localDateString, type DispatchedTask, type DispatchResult, type NotifyChannel } from './dispatch.ts'
export { flomoMemo, macNotify, wechatSend, wechatRecipient, wechatStateDir, escapeHashes, buildFlomoContent, HASH_SAFE, WECHAT_GATEWAY_URL, type WechatOptions } from './notify.ts'
export { dispatcherStatusTool, dispatcherConfigTool, dispatcherRunTool, dispatcherReportTool, buildTools, type ToolContext } from './tools.ts'
export { makeRoutes, DISPATCHER_API } from './routes.ts'
export { runAutoExecute, spawnWorker, buildWorkerPrompt, summarizeWorkerOutput, DEFAULT_WORKER_TIMEOUT_MS, type WorkerResult, type TaskExecResult, type AutoExecOutcome } from './executor.ts'
export { listWorkspaces, resolveWorkspacePath, resolveWorkspaceTitle, workspaceStorePath, DEFAULT_WORKSPACE_STORE, type WorkspaceInfo } from './workspaces.ts'
export {
  DeferredController,
  TIMER_LABEL,
  bundledScriptPath,
  coerceQueue,
  defaultQueue,
  installedScriptPath,
  newestSessionMtime,
  queuePath,
  timerPlistPath,
  type DeferredAction,
  type DeferredQueue,
  type DeferredStatus,
  type TimerState,
} from './deferred.ts'
export { defineTool }
