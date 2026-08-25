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
import { doDispatch } from './dispatch.ts'
import { runAutoExecute } from './executor.ts'

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
    description: '查看 dsh-task-dispatcher 插件状态：是否启用、拉取间隔（分钟）、自动执行开关、任务来源清单、过滤方式、通知开关、最近一次派发结果（时间/数量/任务标题）与今日任务文件路径。不会泄露任何密钥。',
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
          projectName: { type: 'string' },
          projectId: { type: 'string' },
          dueMode: { type: 'string' },
          includeUndated: { type: 'boolean' },
          notifyFlomo: { type: 'boolean' },
          flomoTag: { type: 'string' },
          notifyMac: { type: 'boolean' },
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
        const parts: string[] = [
          '插件状态：' + (view.enabled ? '已启用' : '已禁用'),
          '拉取间隔：' + interval,
          '自动执行：' + (view.autoExecute ? '开（每任务一个 DSH 会话，串行）' : '关'),
          '任务来源：滴答清单「' + view.projectName + '」',
          '过滤：' + (view.dueMode === 'all' ? '全部未完成' : '今天到期/逾期' + (view.includeUndated ? ' + 无截止' : '')),
          '通知：' + [view.notifyFlomo ? 'flomo' : '', view.notifyMac ? 'macOS' : ''].filter(Boolean).join('+') || '无',
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
    description: '配置 dsh-task-dispatcher：enabled（总开关）、dispatchIntervalMinutes（每隔多少分钟自动拉取一次，0=关闭定时）、projectName 或 projectId（任务来源滴答清单，默认 5️⃣AI）、dueMode（today=今天到期/逾期，all=全部未完成）、includeUndated（是否含无截止任务）、notifyFlomo/notifyMac（通知开关）、flomoTag（flomo 标签）、taskFile（今日任务文件路径）、autoExecute（是否自动执行：为每个拉到的新任务单独开一个 DSH 会话去执行）、retryCooldownMinutes（失败任务重试冷却分钟）、workerPrompt（执行会话的提示词模板，可用 {title}/{content}）、announceToAgent（是否在系统提示公告）。配置持久化到 ~/.dsh/dsh-task-dispatcher.json（0600）。传 reset: true 恢复默认。',
    parameters: {
      enabled: { type: 'boolean', description: '插件总开关' },
      dispatchIntervalMinutes: { type: 'number', description: '每隔多少分钟自动拉取一次滴答清单（0 关闭定时）' },
      projectName: { type: 'string', description: '任务来源清单名（默认 5️⃣AI）' },
      projectId: { type: 'string', description: '可选：来源清单 id（按名称解析不到时用）' },
      dueMode: { type: 'string', enum: ['today', 'all'], description: 'today=今天到期/逾期；all=全部未完成' },
      includeUndated: { type: 'boolean', description: 'dueMode=today 时是否包含无截止日期任务' },
      notifyFlomo: { type: 'boolean', description: '是否推送 flomo' },
      flomoTag: { type: 'string', description: 'flomo 标签（不带 #，空格分隔）' },
      notifyMac: { type: 'boolean', description: '是否发送 macOS 通知' },
      taskFile: { type: 'string', description: '今日任务文件路径' },
      autoExecute: { type: 'boolean', description: '是否自动执行（每个任务单独一个 DSH 会话）' },
      retryCooldownMinutes: { type: 'number', description: '失败任务重试冷却分钟' },
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
          notifyMac: { type: 'boolean' },
          taskFile: { type: 'string' },
          autoExecute: { type: 'boolean' },
          retryCooldownMinutes: { type: 'number' },
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
            notifyFlomo: true, flomoTag: 'AI/DSH/派发', notifyMac: true,
            taskFile: '', autoExecute: false, retryCooldownMinutes: 60,
          } as Record<string, unknown>)
          args = {}
        }
        const view = await ctx.store.patch(args)
        const interval = view.dispatchIntervalMinutes === 0
          ? '已关闭定时'
          : ('每 ' + view.dispatchIntervalMinutes + ' 分钟')
        const auto = view.autoExecute ? ' · 自动执行开' : ' · 自动执行关'
        return { ok: true, message: '配置已保存：' + (view.enabled ? '启用' : '禁用') + ' · ' + interval + auto + ' · 来源「' + view.projectName + '」', enabled: view.enabled, dispatchIntervalMinutes: view.dispatchIntervalMinutes, projectName: view.projectName, dueMode: view.dueMode, includeUndated: view.includeUndated, notifyFlomo: view.notifyFlomo, flomoTag: view.flomoTag, notifyMac: view.notifyMac, taskFile: view.taskFile, autoExecute: view.autoExecute, retryCooldownMinutes: view.retryCooldownMinutes, configPath: view.configPath }
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
    description: '立即执行一次任务拉取：从滴答清单「5️⃣AI」（或配置的来源）拉取今天到期的任务，写入今日任务文件，并发送 flomo + macOS 通知（手动触发始终通知）。若开启 autoExecute，还会为每个拉到的新任务单独开一个 DSH 会话去执行并自动勾掉。常用于手动触发派发或验证配置。',
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
            const exec = await runAutoExecute(ctx.store, ctx.api, result.tasks)
            autoExecuted = exec.executed
            autoCompleted = exec.completed
          }
        }
        const flomoNotify = result.notifies.find((n) => n.channel === 'flomo')
        const macNotify = result.notifies.find((n) => n.channel === 'mac')
        return {
          ok: result.ok,
          message: result.message + (autoExecuted > 0 ? ' 自动执行 ' + autoExecuted + ' 项，完成 ' + autoCompleted + ' 项。' : ''),
          dispatchedAt: result.dispatchedAt,
          projectName: result.projectName,
          taskCount: result.taskCount,
          taskFile: result.taskFile,
          flomoNotify: flomoNotify?.ok === true ? 'ok' : (flomoNotify === undefined ? 'none' : 'failed'),
          macNotify: macNotify?.ok === true ? 'ok' : (macNotify === undefined ? 'none' : 'failed'),
          autoExecuted,
          autoCompleted,
        }
      } catch (error) {
        return { ok: false, message: '派发失败: ' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}

/** Build the tool list for registration. */
export function buildTools(ctx: ToolContext) {
  return [dispatcherStatusTool(ctx), dispatcherConfigTool(ctx), dispatcherRunTool(ctx)]
}
