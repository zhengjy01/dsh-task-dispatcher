/**
 * dsh-task-dispatcher — notify helpers.
 *
 * On each dispatch, notify the user that today's tasks are queued:
 *   - flomo: post one MEMO reusing the dsh-flomo credentials it already
 *     stores (~/.dsh/dsh-flomo.json). Reads the same file the flomo plugin
 *     uses (webhookUrl, or apiKey -> /api/prod/apis/webhook/v1/?apiKey=...),
 *     so no duplicate config is needed. Tags are appended as #tag.
 *   - macOS: post a Notification Center banner via osascript (best effort).
 *
 * Both are best-effort: a delivery failure is reported in the returned
 * outcome, never thrown (dispatch must not fail because a notify failed).
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Default flomo credential location (mirrors the dsh-flomo plugin). */
export const FLOMO_CONFIG = path.join(homedir(), '.dsh', 'dsh-flomo.json')

/** Short mask for display only. */
function mask(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return value.slice(0, 2) + '****'
  return value.slice(0, 4) + '****' + value.slice(-4)
}

/** Outcome of one notify channel. */
export interface NotifyResult {
  ok: boolean
  channel: 'flomo' | 'mac'
  message: string
}

/** Read the flomo webhook URL (mirrors dsh-flomo's `store.url()`). */
async function flomoUrl(): Promise<string> {
  let record: Record<string, unknown> = {}
  try {
    const raw = await readFile(FLOMO_CONFIG, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) record = parsed as Record<string, unknown>
  } catch {
    // Missing or unreadable: treat as unconfigured.
  }
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const webhook = str(record.webhookUrl).trim()
  if (webhook !== '') return webhook
  const key = str(record.apiKey).trim()
  if (key !== '') return 'https://flomoapp.com/api/prod/apis/webhook/v1/?apiKey=' + encodeURIComponent(key)
  return ''
}

/**
 * Strip every '#' from a string. flomo parses `#word` as a tag, so a task
 * title like `做A #重要` would spawn a stray tag; removing '#' keeps the text
 * readable without polluting flomo's tag set. The configured flomoTag is
 * appended separately by buildFlomoContent, so a leading '#' there survives.
 */
export function stripHash(value: string): string {
  return (value ?? '').replace(/#/g, '')
}

/** Append #tags (space-separated) to a memo body, mirroring dsh-flomo. */
export function buildFlomoContent(content: string, tags: string): string {
  const body = (content ?? '').trim()
  const suffix = (tags ?? '').split(/[\s,，;；]+/).map((t) => t.trim()).filter(Boolean).map((t) => '#' + t.replace(/^#+/, '')).join(' ')
  return suffix !== '' ? body + ' ' + suffix : body
}

/** Post one MEMO to flomo. Returns an outcome, never throws. */
export async function flomoMemo(content: string, tags: string): Promise<NotifyResult> {
  try {
    const url = await flomoUrl()
    if (url === '') {
      return { ok: false, channel: 'flomo', message: '尚未配置 flomo（~/.dsh/dsh-flomo.json 无 webhookUrl/apiKey），已跳过 flomo 通知。' }
    }
    const bound = buildFlomoContent(content, tags)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: bound }),
      signal: AbortSignal.timeout(15000),
    })
    const body = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      parsed = null
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const code = (parsed as { code?: unknown }).code
      if (typeof code === 'number' && code === 0) {
        return { ok: true, channel: 'flomo', message: '已写入 flomo' }
      }
      if (typeof code === 'number') {
        return { ok: false, channel: 'flomo', message: 'flomo 返回错误: ' + String((parsed as { message?: unknown }).message ?? JSON.stringify(parsed)) }
      }
    }
    if (!res.ok) {
      return { ok: false, channel: 'flomo', message: 'flomo 请求失败（HTTP ' + res.status + '）: ' + body.slice(0, 200) }
    }
    return { ok: true, channel: 'flomo', message: 'flomo 已响应: ' + body.slice(0, 200) }
  } catch (error) {
    return { ok: false, channel: 'flomo', message: 'flomo 请求失败: ' + String(error instanceof Error ? error.message : error) }
  }
}

/** Post a macOS Notification Center banner. Never throws. */
export async function macNotify(title: string, subtitle: string, body: string): Promise<NotifyResult> {
  try {
    const script = [
      'display notification ' + JSON.stringify(body),
      'with title ' + JSON.stringify(title),
      'subtitle ' + JSON.stringify(subtitle),
      'sound name "Glass"',
    ].join(' ')
    await execFileAsync('osascript', ['-e', script])
    return { ok: true, channel: 'mac', message: '已发送 macOS 通知' }
  } catch (error) {
    return { ok: false, channel: 'mac', message: 'macOS 通知失败: ' + String(error instanceof Error ? error.message : error) }
  }
}
