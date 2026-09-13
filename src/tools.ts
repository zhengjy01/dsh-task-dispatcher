/**
 * dsh-task-dispatcher — model-facing tools.
 *
 * Mounted via ctx.tools.register. Covers the task-dispatcher surface:
 * status, config, and a manual run-dispatch-now action. Every tool resolves
 * to { ok, message, ... } and never throws for API-level outcomes.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TickTickApi } from 'dsh-ticktick'
import type { DispatcherStore } from './store.ts'
import { doDispatch, localDateString, notifyText, type NotifyChannel } from './dispatch.ts'
import { flomoMemo, macNotify, wechatSend, type NotifyResult } from './notify.ts'
import { runAutoExecute } from './executor.ts'
import { resolveWorkspaceTitle } from './workspaces.ts'

/** One text content block (the only render shape these tools emit). */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** Shared tool dependencies. */
export interface ToolContext {
  store: DispatcherStore
  api: TickTickApi
}

/** Status tool: config + last dispatch summary. */
export function dispatcherStatusTool(ctx: ToolContext) {
  return defineTool({
    name: 'dispatcher_status',
    description: '查看 dsh-task-dispatcher 插件状态：是否启用、拉取间隔（分钟）、自动执行开关、自动执行会话的工作区、worker 超时（分钟）、任务来源清单、过滤方式、通知开关、最近一次派发结果（时间/数量/任务标题）与今日任务文件路径。不会泄露任何密钥。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          configured: { type: 'boolean' },
          enabled: { type: 'boolean' },
          announceToAgent: { type: 'boolean' },
          dispatchIntervalMinutes: { type: 'number' },
          autoExecute: { type: 'boolean' },
          retryCooldownMinutes: { type: 'number' },
          workerTimeoutMinutes: { type: 'number' },
          workerWorkspaceId: { type: 'string' },
          projectName: { type: 'string' },
          projectId: { type: 'string' },
          dueMode: { type: 'string' },
          includeUndated: { type: 'boolean' },
          notifyFlomo: { type: 'boolean' },
          flomoTag: { type: 'string' },
          flomoStripBodyHash: { type: 'boolean' },
          notifyMac: { type: 'boolean' },
          notifyResult: { type: 'boolean' },
          notifyWechat: { type: 'boolean' },
          wechatGatewayUrl: { type: 'string' },
          wechatTo: { type: 'string' },
          wechatStateDir: { type: 'string' },
          taskFile: { type: 'string' },
          lastDispatchAt: { type: 'string' },
          lastTaskCount: { type: 'number' },
          lastTaskTitles: { type: 'array', items: { type: 'string' } },
          workerPrompt: { type: 'string' },
          configPath: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      try {
        const view = await ctx.store.view()
        const interval = view.dispatchIntervalMinutes === 0
          ? '已关闭定时'
          : ('每 ' + view.dispatchIntervalMinutes + ' 分钟自动拉取')
        const workerWorkspace = view.workerWorkspaceId === ''
          ? '默认（用户主目录）'
          : ((await resolveWorkspaceTitle(view.workerWorkspaceId)) ?? view.workerWorkspaceId + '（已不存在，将回退主目录）')
        const parts: string[] = [
          '插件状态：' + (view.enabled ? '已启用' : '已禁用'),
          '拉取间隔：' + interval,
          '自动执行：' + (view.autoExecute ? '开（每任务一个 DSH 会话，串行）' : '关'),
          'worker 超时：' + view.workerTimeoutMinutes + ' 分钟（到点 SIGKILL）',
          '执行会话工作区：' + workerWorkspace,
          '任务来源：滴答清单「' + view.projectName + '」',
          '过滤：' + (view.dueMode === 'all' ? '全部未完成' : '今天到期/逾期' + (view.includeUndated ? ' + 无截止' : '') + ' + 进行中窗口任务（开始日已到、截止日未到；仅提示不自动执行）'),
          '通知通道：' + ([
            view.notifyWechat ? ('微信 ClawBot' + (view.wechatTo !== '' ? '（指定 ' + view.wechatTo + '）' : '（自动识别接收人）')) : '',
            view.notifyFlomo ? 'flomo' : '',
            view.notifyMac ? 'macOS' : '',
          ].filter(Boolean).join(' + ') || '无'),
          '执行结果回执：' + (view.notifyResult
            ? '开（自动执行的每个任务结束后推一条简明结果，多任务再补一条汇总）'
            : '关（不推送执行结果）'),
          '今日任务文件：' + view.taskFile,
        ]
        if (view.lastDispatchAt) {
          parts.push('上次拉取：' + view.lastDispatchAt + ' · ' + view.lastTaskCount + ' 项')
          parts.push('任务列表：' + (view.lastTaskTitles.length > 0 ? view.lastTaskTitles.join('；') : '（空）'))
        } else {
          parts.push('上次拉取：（尚未拉取）')
        }
        return { ok: true, message: parts.join('\n'), ...view }
      } catch (error) {
        return { ok: false, message: '读取状态失败: ' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}

/** Config tool: update dispatcher settings. */
export function dispatcherConfigTool(ctx: ToolContext) {
  return defineTool({
    name: 'dispatcher_config',
    description: '配置 dsh-task-dispatcher：enabled（总开关）、dispatchIntervalMinutes（每隔多少分钟自动拉取一次，0=关闭定时）、projectName 或 projectId（任务来源滴答清单，默认 5️⃣AI）、dueMode（today=今天到期/逾期，all=全部未完成）、includeUndated（是否含无截止任务）、notifyResult（自动执行结束后是否推送「每个任务的简明结果 + 批次汇总」，默认 true）、notifyWechat/notifyFlomo/notifyMac（通知通道开关：微信 ClawBot / flomo / macOS）、wechatGatewayUrl（ClawBot 网关地址，默认 http://127.0.0.1:51235）、wechatTo（微信接收人 id，留空自动用 ClawBot 扫码登录的那个账号）、wechatStateDir（ClawBot 状态目录，默认 ~/.dsh-wechat；也认环境变量 DSH_WECHAT_HOME）、testWechat（保存后立即发一条测试微信消息）、flomoTag（flomo 标签）、flomoStripBodyHash（发到 flomo 的通知/汇总正文里的井号# 是否替换成全角＃，避免 flomo 把#词误识别成标签；flomoTag 标签本身保留）、taskFile（今日任务文件路径）、autoExecute（是否自动执行：为每个拉到的新任务单独开一个 DSH 会话去执行）、workerWorkspaceId（执行会话运行在哪个 DSH 工作区，传空字符串=默认主目录；用 dispatcher_status 可看到工作区 id）、retryCooldownMinutes（失败任务重试冷却分钟）、workerTimeoutMinutes（单个执行会话的超时分钟数，默认 30，到点 SIGKILL 该 worker；范围 1–1440）、workerPrompt（执行会话的提示词模板，可用 {title}/{content}）、announceToAgent（是否在系统提示公告）。配置持久化到 DSH_HOME 下的 dsh-task-dispatcher.json（默认 ~/.dsh，0600）。传 reset: true 恢复默认。',
    parameters: {
      enabled: { type: 'boolean', description: '插件总开关' },
      dispatchIntervalMinutes: { type: 'number', description: '每隔多少分钟自动拉取一次滴答清单（0 关闭定时）' },
      projectName: { type: 'string', description: '任务来源清单名（默认 5️⃣AI）' },
      projectId: { type: 'string', description: '可选：来源清单 id（按名称解析不到时用）' },
      dueMode: { type: 'string', enum: ['today', 'all'], description: 'today=今天到期/逾期；all=全部未完成' },
      includeUndated: { type: 'boolean', description: 'dueMode=today 时是否包含无截止日期任务' },
      notifyFlomo: { type: 'boolean', description: '是否推送 flomo' },
      flomoTag: { type: 'string', description: 'flomo 标签（不带 #，空格分隔）' },
      flomoStripBodyHash: { type: 'boolean', description: '发到 flomo 的通知/汇总正文里的井号# 替换成全角＃（默认 true）' },
      notifyMac: { type: 'boolean', description: '是否发送 macOS 通知' },
      notifyResult: { type: 'boolean', description: '自动执行结束后是否推送结果（每任务一条简明结果 + 多任务批次汇总；走已开启的通知通道）' },
      notifyWechat: { type: 'boolean', description: '是否通过微信机器人 ClawBot 推送通知（需要本机已装 DSH-WeChatClawBot 且已扫码登录）' },
      wechatGatewayUrl: { type: 'string', description: 'ClawBot 网关地址（默认 http://127.0.0.1:51235）' },
      wechatTo: { type: 'string', description: '微信接收人 id（留空=自动使用 ClawBot 扫码登录的账号）' },
      wechatStateDir: { type: 'string', description: 'ClawBot 状态目录（默认 ~/.dsh-wechat，环境变量 DSH_WECHAT_HOME 优先）' },
      testWechat: { type: 'boolean', description: '保存配置后立即发一条测试微信消息（验证通道）' },
      taskFile: { type: 'string', description: '今日任务文件路径' },
      autoExecute: { type: 'boolean', description: '是否自动执行（每个任务单独一个 DSH 会话）' },
      workerWorkspaceId: { type: 'string', description: '执行会话运行的 DSH 工作区 id（空字符串=默认主目录）' },
      retryCooldownMinutes: { type: 'number', description: '失败任务重试冷却分钟' },
      workerTimeoutMinutes: { type: 'number', description: '单个执行会话的超时分钟数（默认 30；到点 SIGKILL 该 worker）' },
      workerPrompt: { type: 'string', description: '执行会话提示词模板（{title}/{content}）' },
      announceToAgent: { type: 'boolean', description: '是否在系统提示公告插件' },
      reset: { type: 'boolean', description: '恢复默认配置' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          enabled: { type: 'boolean' },
          dispatchIntervalMinutes: { type: 'number' },
          projectName: { type: 'string' },
          dueMode: { type: 'string' },
          includeUndated: { type: 'boolean' },
          notifyFlomo: { type: 'boolean' },
          flomoTag: { type: 'string' },
          flomoStripBodyHash: { type: 'boolean' },
          notifyMac: { type: 'boolean' },
          notifyResult: { type: 'boolean' },
          notifyWechat: { type: 'boolean' },
          wechatGatewayUrl: { type: 'string' },
          wechatTo: { type: 'string' },
          wechatStateDir: { type: 'string' },
          taskFile: { type: 'string' },
          autoExecute: { type: 'boolean' },
          workerWorkspaceId: { type: 'string' },
          retryCooldownMinutes: { type: 'number' },
          workerTimeoutMinutes: { type: 'number' },
          configPath: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute(args: Record<string, unknown>) {
      try {
        if (args !== undefined && args.reset === true) {
          await ctx.store.patch({
            enabled: true, announceToAgent: true, dispatchIntervalMinutes: 30,
            projectName: '5️⃣AI', projectId: '', dueMode: 'today', includeUndated: true,
            notifyFlomo: true, flomoTag: 'AI/DSH/派发', flomoStripBodyHash: true, notifyMac: true,
            notifyResult: true, notifyWechat: false, wechatGatewayUrl: '', wechatTo: '', wechatStateDir: '',
            taskFile: '', autoExecute: false, retryCooldownMinutes: 60, workerTimeoutMinutes: 30,
            workerWorkspaceId: '',
          } as Record<string, unknown>)
          args = {}
        }
        const wantsTest = args !== undefined && args.testWechat === true
        const sanitized: Record<string, unknown> = { ...(args ?? {}) }
        delete sanitized.testWechat
        const view = await ctx.store.patch(sanitized)
        let testLine = ''
        if (wantsTest) {
          const probe = await wechatSend('【DSH 任务派发器】微信通知通道测试：收到这条说明微信通知已生效。', {
            gatewayUrl: view.wechatGatewayUrl, to: view.wechatTo, stateDir: view.wechatStateDir,
          })
          testLine = probe.ok ? ' 微信测试消息已发送。' : ' 微信测试失败：' + probe.message
        }
        const interval = view.dispatchIntervalMinutes === 0
          ? '已关闭定时'
          : ('每 ' + view.dispatchIntervalMinutes + ' 分钟')
        const auto = view.autoExecute ? ' · 自动执行开' : ' · 自动执行关'
        const timeout = ' · worker 超时 ' + view.workerTimeoutMinutes + ' 分钟'
        const workspace = view.workerWorkspaceId === ''
          ? ''
          : ' · 工作区 ' + ((await resolveWorkspaceTitle(view.workerWorkspaceId)) ?? view.workerWorkspaceId)
        return { ok: true, message: '配置已保存：' + (view.enabled ? '启用' : '禁用') + ' · ' + interval + auto + timeout + workspace + ' · 来源「' + view.projectName + '」' + testLine + ' · 通知：' + ([view.notifyWechat ? '微信' : '', view.notifyFlomo ? 'flomo' : '', view.notifyMac ? 'macOS' : ''].filter(Boolean).join('+') || '无'), enabled: view.enabled, dispatchIntervalMinutes: view.dispatchIntervalMinutes, projectName: view.projectName, dueMode: view.dueMode, includeUndated: view.includeUndated, notifyResult: view.notifyResult, notifyFlomo: view.notifyFlomo, flomoTag: view.flomoTag, flomoStripBodyHash: view.flomoStripBodyHash, notifyMac: view.notifyMac, notifyWechat: view.notifyWechat, wechatGatewayUrl: view.wechatGatewayUrl, wechatTo: view.wechatTo, wechatStateDir: view.wechatStateDir, taskFile: view.taskFile, autoExecute: view.autoExecute, workerWorkspaceId: view.workerWorkspaceId, retryCooldownMinutes: view.retryCooldownMinutes, workerTimeoutMinutes: view.workerTimeoutMinutes, configPath: view.configPath }
      } catch (error) {
        return { ok: false, message: '配置失败: ' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}

/** Run tool: perform a dispatch now. */
export function dispatcherRunTool(ctx: ToolContext) {
  return defineTool({
    name: 'dispatcher_run',
    description: '立即执行一次任务拉取：从滴答清单「5️⃣AI」（或配置的来源）拉取今天相关的任务（今天到期/逾期 + 无截止 + 开始日已到的「进行中」窗口任务），写入今日任务文件，并发送微信（ClawBot）+ flomo + macOS 通知（手动触发始终通知；按配置开关决定发哪几路）。若开启 autoExecute，只为**今天到期/逾期**的项单独开一个 DSH 会话去执行并自动勾掉；标「进行中」的窗口任务仅列出、不自动执行。常用于手动触发派发或验证配置。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          dispatchedAt: { type: 'string' },
          projectName: { type: 'string' },
          taskCount: { type: 'number' },
          taskFile: { type: 'string' },
          wechatNotify: { type: 'string' },
          flomoNotify: { type: 'string' },
          macNotify: { type: 'string' },
          autoExecuted: { type: 'number' },
          autoCompleted: { type: 'number' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      try {
        const result = await doDispatch(ctx.store, ctx.api, { forceNotify: true })
        let autoExecuted = 0
        let autoCompleted = 0
        if (result.ok && result.tasks.length > 0) {
          const cfg = await ctx.store.load()
          if (cfg.autoExecute) {
            const exec = await runAutoExecute(ctx.store, ctx.api, result.tasks, { notifyResult: true })
            autoExecuted = exec.executed
            autoCompleted = exec.completed
          }
        }
        const flag = (channel: 'wechat' | 'flomo' | 'mac'): string => {
          const hit = result.notifies.find((n) => n.channel === channel)
          return hit === undefined ? 'none' : (hit.ok ? 'ok' : 'failed')
        }
        return {
          ok: result.ok,
          message: result.message + (autoExecuted > 0 ? ' 自动执行 ' + autoExecuted + ' 项，完成 ' + autoCompleted + ' 项。' : ''),
          dispatchedAt: result.dispatchedAt,
          projectName: result.projectName,
          taskCount: result.taskCount,
          taskFile: result.taskFile,
          wechatNotify: flag('wechat'),
          flomoNotify: flag('flomo'),
          macNotify: flag('mac'),
          autoExecuted,
          autoCompleted,
        }
      } catch (error) {
        return { ok: false, message: '派发失败: ' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}

/** Report tool: send the agent/session outcome summary to WeChat (and/or flomo). */
export function dispatcherReportTool(ctx: ToolContext) {
  return defineTool({
    name: 'dispatcher_report',
    description: '任务执行完/会话结束后，把本次执行结果汇总发一条通知：默认发到微信（通过 ClawBot 网关，读 dsh-task-dispatcher 的微信配置）；flomo 只在配置里开启 notifyFlomo 时才一并发送。参数：total（共几项）、completed（完成）、failed（失败）、skipped（跳过）、summary（可选的自定义说明/备注，多行）、date（可选，默认今天）。channels 可临时指定本次要发哪几路（wechat/flomo/mac），不传则用配置开关。',
    parameters: {
      total: { type: 'number', description: '本次会话任务总数（可选）' },
      completed: { type: 'number', description: '完成数量（可选）' },
      failed: { type: 'number', description: '失败数量（可选）' },
      skipped: { type: 'number', description: '跳过数量（可选）' },
      summary: { type: 'string', description: '可选：本次会话的说明/备注，多行文本' },
      date: { type: 'string', description: '可选：日期 YYYY-MM-DD，默认今天' },
      channels: { type: 'array', items: { type: 'string' }, description: '可选：本次发送渠道，可选值 wechat/flomo/mac（不传=按配置开关）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          wechatNotify: { type: 'string' },
          flomoNotify: { type: 'string' },
          macNotify: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute(args: Record<string, unknown> | undefined) {
      try {
        const cfg = await ctx.store.load()
        const requested = Array.isArray(args?.channels)
          ? (args?.channels as unknown[]).filter((c): c is string => typeof c === 'string')
          : []
        const use = (channel: 'wechat' | 'flomo' | 'mac', configured: boolean): boolean =>
          requested.length > 0 ? requested.includes(channel) : configured
        const wantWechat = use('wechat', cfg.notifyWechat)
        const wantFlomo = use('flomo', cfg.notifyFlomo)
        const wantMac = use('mac', cfg.notifyMac)
        if (!wantWechat && !wantFlomo && !wantMac) {
          return { ok: false, message: '通知渠道全部关闭（微信/flomo/macOS），未发送。请在设置面板或 dispatcher_config 开启。', wechatNotify: 'off', flomoNotify: 'off', macNotify: 'off' }
        }
        const date = typeof args?.date === 'string' && args.date.trim() !== '' ? args.date.trim() : localDateString()
        const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
        const total = num(args?.total)
        const completed = num(args?.completed)
        const failed = num(args?.failed)
        const skipped = num(args?.skipped)
        const summary = typeof args?.summary === 'string' ? args.summary.trim() : ''
        const lines: string[] = ['🗂 任务派发 · ' + date + ' · 会话汇总']
        if (total > 0 || completed > 0 || failed > 0 || skipped > 0) {
          lines.push('完成：' + completed + ' · 失败：' + failed + ' · 跳过：' + skipped + '（共 ' + total + ' 项）')
        }
        if (summary !== '') lines.push(summary)
        const body = lines.join('\n')
        // One shared fan-out (WeChat / flomo / macOS) with the same channel
        // semantics as the dispatch notice — `channels` overrides the config.
        const results: NotifyResult[] = await notifyText(body, cfg, {
          ...(requested.length > 0 ? { channels: requested as NotifyChannel[] } : {}),
          macTitle: 'DSH 任务派发',
          macSubtitle: '会话汇总 ' + date,
          macBody: lines.slice(0, 2).join(' · '),
        })
        const sent = results.filter((r) => r.ok).map((r) => r.message)
        const problems = results.filter((r) => !r.ok).map((r) => r.channel + '：' + r.message)
        const flagOf = (channel: NotifyChannel, wanted: boolean): string => {
          if (!wanted) return 'off'
          const hit = results.find((n) => n.channel === channel)
          return hit === undefined ? 'failed' : (hit.ok ? 'ok' : 'failed')
        }
        return {
          ok: problems.length === 0,
          message: (sent.length > 0 ? '已发送汇总（' + sent.join('；') + '）' : '汇总未发送')
            + (problems.length > 0 ? '；失败：' + problems.join('；') : ''),
          wechatNotify: flagOf('wechat', wantWechat),
          flomoNotify: flagOf('flomo', wantFlomo),
          macNotify: flagOf('mac', wantMac),
        }
      } catch (error) {
        return { ok: false, message: '发送汇总失败: ' + String(error instanceof Error ? error.message : error), wechatNotify: 'failed', flomoNotify: 'failed', macNotify: 'failed' }
      }
    },
  })
}

/** Build the tool list for registration. */
export function buildTools(ctx: ToolContext) {
  return [dispatcherStatusTool(ctx), dispatcherConfigTool(ctx), dispatcherRunTool(ctx), dispatcherReportTool(ctx)]
}
