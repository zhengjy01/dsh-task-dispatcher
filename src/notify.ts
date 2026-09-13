/**
 * dsh-task-dispatcher — notify helpers.
 *
 * On each dispatch, notify the user that today's tasks are queued:
 *   - flomo: post one MEMO reusing the dsh-flomo credentials it already
 *     stores (~/.dsh/dsh-flomo.json). Reads the same file the flomo plugin
 *     uses (webhookUrl, or apiKey -> /api/prod/apis/webhook/v1/?apiKey=...),
 *     so no duplicate config is needed. Tags are appended as #tag.
 *   - macOS: post a Notification Center banner via osascript (best effort).
 *   - WeChat: hand the text to the local ClawBot gateway
 *     (DSH-WeChatClawBot, default http://127.0.0.1:51235), which relays it to
 *     the WeChat account that scanned the floating-ball QR code.
 *
 * All are best-effort: a delivery failure is reported in the returned
 * outcome, never thrown (dispatch must not fail because a notify failed).
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { pluginPath } from './home.ts'

const execFileAsync = promisify(execFile)

/** Shared flomo credential location: DSH_HOME when set, else ~/.dsh. */
export const FLOMO_CONFIG = pluginPath(undefined, 'dsh-flomo.json')

/**
 * Default ClawBot state directory — where the WeChat gateway keeps its login
 * (`accounts.json` plus `accounts/<botId>.json`, which carries the id of the
 * user who scanned). Mirrors the gateway's own `STATE_DIR` default;
 * `DSH_WECHAT_HOME` overrides it.
 */
export function wechatStateDir(override?: string): string {
  const explicit = (override ?? '').trim()
  if (explicit !== '') return explicit
  const env = (process.env.DSH_WECHAT_HOME ?? '').trim()
  return env !== '' ? env : path.join(homedir(), '.dsh-wechat')
}

/** Default ClawBot gateway endpoint (loopback HTTP API of the WeChat bridge). */
export const WECHAT_GATEWAY_URL = 'http://127.0.0.1:51235'

/** Per-message character cap (WeChat refuses very large text bubbles). */
const WECHAT_CHUNK_CHARS = 1200

/** Options for one WeChat notification. */
export interface WechatOptions {
  /** Gateway base URL; empty = {@link WECHAT_GATEWAY_URL}. */
  gatewayUrl?: string
  /** Explicit recipient id; empty = auto-detect the ClawBot owner. */
  to?: string
  /** ClawBot state dir; empty = `$DSH_WECHAT_HOME` or `~/.dsh-wechat`. */
  stateDir?: string
}

/** Short mask for display only. */
function mask(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return value.slice(0, 2) + '****'
  return value.slice(0, 4) + '****' + value.slice(-4)
}

/** Outcome of one notify channel. */
export interface NotifyResult {
  ok: boolean
  channel: 'flomo' | 'mac' | 'wechat'
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
 * Full-width number sign (U+FF03). It reads as a hash mark but is a different
 * code point from the ASCII '#', so flomo's tag parser — which matches
 * `#word` against an ASCII hash — never turns it into a tag.
 */
export const HASH_SAFE = '＃'

/**
 * Replace every ASCII '#' in a memo body with the full-width '＃'.
 *
 * flomo parses `#word` as a tag, so a raw '#' inside body text (a task title
 * like `做A #重要`, a PR number like `#91`, a markdown heading) leaks into the
 * tag set. Replacing rather than deleting keeps the text readable — `#91`
 * survives as `＃91`. The configured flomoTag is appended separately by
 * buildFlomoContent and keeps its own ASCII '#'.
 */
export function escapeHashes(value: string): string {
  return (value ?? '').replace(/#/g, HASH_SAFE)
}

/** Append #tags (space-separated) to a memo body, mirroring dsh-flomo. */
export function buildFlomoContent(content: string, tags: string): string {
  const body = (content ?? '').trim()
  const suffix = (tags ?? '').split(/[\s,，;；]+/).map((t) => t.trim()).filter(Boolean).map((t) => '#' + t.replace(/^#+/, '')).join(' ')
  return suffix !== '' ? body + ' ' + suffix : body
}

/**
 * Post one MEMO to flomo. Returns an outcome, never throws.
 *
 * `escapeBodyHashes` (default true) is the single choke point that keeps every
 * path into flomo free of a stray ASCII '#': the body is escaped *before* the
 * #tag suffix is appended, so the tag keeps its hash while the body has none.
 */
export async function flomoMemo(content: string, tags: string, escapeBodyHashes = true): Promise<NotifyResult> {
  try {
    const url = await flomoUrl()
    if (url === '') {
      return { ok: false, channel: 'flomo', message: '尚未配置 flomo（DSH_HOME 下的 dsh-flomo.json 无 webhookUrl/apiKey），已跳过 flomo 通知。' }
    }
    const bound = buildFlomoContent(escapeBodyHashes ? escapeHashes(content) : content, tags)
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

/**
 * Resolve the WeChat recipient (iLink `to_user_id`) for a ClawBot message.
 *
 * Order: explicit `to` option → the `userId` recorded by the ClawBot gateway
 * when the user scanned the floating-ball QR code. The gateway stores it in
 * `<stateDir>/accounts/<botId>.json` (`userId: <wxid>@im.wechat`) and lists the
 * bot ids in `<stateDir>/accounts.json`. Returns '' when ClawBot has never been
 * logged in on this machine.
 */
export async function wechatRecipient(opts: WechatOptions = {}): Promise<string> {
  const explicit = (opts.to ?? '').trim()
  if (explicit !== '') return explicit
  const dir = wechatStateDir(opts.stateDir)
  const accountsDir = path.join(dir, 'accounts')
  const readUserId = async (file: string): Promise<string> => {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null) {
        const value = (parsed as { userId?: unknown }).userId
        if (typeof value === 'string') return value.trim()
      }
    } catch {
      // Unreadable / half-written account file: try the next candidate.
    }
    return ''
  }
  // Preferred: the ids listed in accounts.json, newest entry last.
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(dir, 'accounts.json'), 'utf8'))
    if (Array.isArray(parsed)) {
      for (const id of [...parsed].reverse()) {
        if (typeof id !== 'string' || id.trim() === '') continue
        const found = await readUserId(path.join(accountsDir, id.trim() + '.json'))
        if (found !== '') return found
      }
    }
  } catch {
    // accounts.json missing: fall back to scanning the accounts directory.
  }
  try {
    const files = (await readdir(accountsDir)).filter((f) => f.endsWith('.json') && !f.endsWith('.sync.json'))
    for (const file of files) {
      const found = await readUserId(path.join(accountsDir, file))
      if (found !== '') return found
    }
  } catch {
    // No ClawBot state on this machine.
  }
  return ''
}

/** Split long text into WeChat-sized chunks, preferring line boundaries. */
function chunkText(text: string, max: number): string[] {
  const chunks: string[] = []
  let current = ''
  for (const line of text.split(/\r?\n/)) {
    const next = current === '' ? line : current + '\n' + line
    if (next.length <= max) {
      current = next
      continue
    }
    if (current !== '') chunks.push(current)
    if (line.length <= max) {
      current = line
      continue
    }
    // A single over-long line: hard-split it.
    let rest = line
    while (rest.length > max) {
      chunks.push(rest.slice(0, max))
      rest = rest.slice(max)
    }
    current = rest
  }
  if (current !== '') chunks.push(current)
  return chunks.length > 0 ? chunks : [text]
}

/**
 * Send one text message to the user's WeChat through the ClawBot gateway.
 *
 * The gateway is a local loopback service started by the DSH-WeChatClawBot
 * plugin; this plugin never talks to WeChat directly and stores no WeChat
 * credentials. Returns an outcome, never throws — a missing gateway or a
 * missing ClawBot login is reported as a failed channel, not an exception.
 */
export async function wechatSend(text: string, opts: WechatOptions = {}): Promise<NotifyResult> {
  try {
    const body = (text ?? '').trim()
    if (body === '') {
      return { ok: false, channel: 'wechat', message: '微信通知正文为空，已跳过。' }
    }
    const to = await wechatRecipient(opts)
    if (to === '') {
      return {
        ok: false,
        channel: 'wechat',
        message: '未找到微信接收人：请先用 ClawBot 悬浮球扫码登录（或在设置里填 wechatTo 显式指定）。',
      }
    }
    const base = ((opts.gatewayUrl ?? '').trim() || WECHAT_GATEWAY_URL).replace(/\/+$/, '')
    const chunks = chunkText(body, WECHAT_CHUNK_CHARS)
    for (const chunk of chunks) {
      const res = await fetch(base + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, text: chunk }),
        signal: AbortSignal.timeout(15000),
      })
      const raw = await res.text()
      if (!res.ok) {
        return {
          ok: false,
          channel: 'wechat',
          message: 'ClawBot 网关返回 HTTP ' + res.status + '：' + raw.slice(0, 200) +
            '（网关未启动？默认 http://127.0.0.1:51235）',
        }
      }
    }
    return {
      ok: true,
      channel: 'wechat',
      message: chunks.length > 1 ? '已发送微信通知（' + chunks.length + ' 条）' : '已发送微信通知',
    }
  } catch (error) {
    const detail = String(error instanceof Error ? error.message : error)
    return { ok: false, channel: 'wechat', message: '微信通知失败: ' + detail + '（ClawBot 网关默认 http://127.0.0.1:51235）' }
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
