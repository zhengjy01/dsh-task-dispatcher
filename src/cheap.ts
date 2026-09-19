/**
 * dsh-task-dispatcher — 「省钱模式」时段判定（纯逻辑，无 IO）。
 *
 * 目标：勾选省钱模式后，自动执行的任务只在 DeepSeek **空闲（优惠）时段** 开跑；
 * 高峰期排队等到下个空闲开始点（或按策略跳过）。不勾选时本模块完全不参与，
 * 行为与旧版 100% 一致。
 *
 * ## 口径（务必以官方定价页为准，禁止写死）
 * 2026-08-17 起 DeepSeek API 采用峰谷定价，官方定价页（中文）脚注原文：
 *   「空闲时段价格为高峰时段价格的一半。高峰时段为北京时间周一至周五
 *     9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。」
 *   —— https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 即：高峰 = 工作日 09:00–12:00、14:00–18:00（Asia/Shanghai）；
 *     空闲 = 工作日 12:00–14:00、18:00–次日 09:00、周六周日全天。
 *
 * 历史口径（2025 年旧版，现已失效但仍保留为 preset 供切换）：
 *   「每日 UTC 16:30–00:30（北京 00:30–08:30）为空闲时段」。
 *   两者不一致，故本模块不写死任何时段：preset 与自定义
 *   peakWindows 都可配置（`cheapPreset` = official-2026 / legacy-utc / custom）。
 *
 * ## 数据模型：高峰黑名单
 * 只描述「高峰窗口」，优惠时段 = 非高峰（天然覆盖周末、跨夜、跨周一的整段空闲）。
 * days 用 JS 的 {@link Date#getDay} 口径：0=周日 … 6=周六。
 */

/** 一个高峰窗口（在 {@link DispatcherConfig.cheapTimezone} 时区内）。 */
export interface PeakWindow {
  /** 生效星期，0=周日 … 6=周六；如 [1,2,3,4,5] = 周一至周五。 */
  days: number[]
  /** 开始 HH:MM（含）。 */
  start: string
  /** 结束 HH:MM（不含）；start > end 表示跨过午夜。 */
  end: string
}

/** 一个可切换的时段口径 preset。 */
export interface CheapPreset {
  id: string
  label: string
  timezone: string
  windows: PeakWindow[]
}

/** 官方 2026-08-17 峰谷定价口径（默认）。 */
export const OFFICIAL_2026_WINDOWS: PeakWindow[] = [
  { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
  { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
]

/** 旧版 UTC 口径：每日 UTC 16:30–00:30（北京 00:30–08:30）空闲，故高峰 = 08:30–次日 00:30。 */
export const LEGACY_UTC_WINDOWS: PeakWindow[] = [
  { days: [0, 1, 2, 3, 4, 5, 6], start: '08:30', end: '00:30' },
]

/** 全部 preset（id -> 定义）。切 preset 即同时切时段与时区。 */
export const CHEAP_PRESETS: Record<string, CheapPreset> = {
  'official-2026': {
    id: 'official-2026',
    label: '官方 2026-08 峰谷（北京时间 周一至周五 09–12 / 14–18 为高峰）',
    timezone: 'Asia/Shanghai',
    windows: OFFICIAL_2026_WINDOWS,
  },
  'legacy-utc': {
    id: 'legacy-utc',
    label: '旧版 UTC 16:30–00:30 空闲（北京 00:30–08:30）',
    timezone: 'Asia/Shanghai',
    windows: LEGACY_UTC_WINDOWS,
  },
}

/** 默认 preset id。 */
export const DEFAULT_CHEAP_PRESET = 'official-2026'

/** 默认时区（高峰窗口按此时区解释）。 */
export const DEFAULT_CHEAP_TIMEZONE = 'Asia/Shanghai'

/** 默认尾部余量（0 = 不做尾部保护，空闲窗口内都可开跑；建议按需设为 15 或 workerTimeoutMinutes）。 */
export const DEFAULT_CHEAP_MARGIN_MINUTES = 0

/** Whether a value is a known preset id. */
export function isKnownPreset(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CHEAP_PRESETS, id)
}

/** Normalise an unknown preset id to a known one (unknown → custom). */
export function normalizePreset(id: unknown): string {
  return typeof id === 'string' && isKnownPreset(id.trim()) ? id.trim() : 'custom'
}

/** "HH:MM" → minutes since midnight, or null when malformed. */
export function hhmmToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

/** Minutes since midnight → "HH:MM". */
export function minutesToHhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
}

/** Parse one unknown value into a PeakWindow, or null when malformed. */
export function parsePeakWindow(value: unknown): PeakWindow | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const days = Array.isArray(record.days)
    ? [...new Set(record.days.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
    : null
  if (days === null || days.length === 0) return null
  if (typeof record.start !== 'string' || typeof record.end !== 'string') return null
  if (hhmmToMinutes(record.start) === null || hhmmToMinutes(record.end) === null) return null
  return { days, start: record.start.trim(), end: record.end.trim() }
}

/**
 * Parse an unknown array into a PeakWindow list.
 * @returns the windows (possibly empty = 「没有任何高峰」= 一直空闲) or null when malformed.
 */
export function parsePeakWindows(value: unknown): PeakWindow[] | null {
  if (!Array.isArray(value)) return null
  const windows: PeakWindow[] = []
  for (const item of value) {
    const parsed = parsePeakWindow(item)
    if (parsed === null) return null
    windows.push(parsed)
  }
  return windows
}

/**
 * Parse the human-friendly one-line-per-window editor format:
 *   `1,2,3,4,5 09:00-12:00`
 * days are 0=Sun … 6=Sat; blank lines and `#` comments are dropped.
 * @returns the windows ([] when the text is empty = 一直空闲) or null when a line is malformed.
 */
export function parsePeakWindowsText(text: string): PeakWindow[] | null {
  const windows: PeakWindow[] = []
  for (const rawLine of (text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line === '') continue
    const match = /^([0-6](?:\s*,\s*[0-6])*)\s+(\d{1,2}:\d{2})\s*[-~–—]\s*(\d{1,2}:\d{2})$/.exec(line)
    if (match === null) return null
    const days = [...new Set(match[1].split(',').map((d) => Number(d.trim())))].sort((a, b) => a - b)
    if (hhmmToMinutes(match[2]) === null || hhmmToMinutes(match[3]) === null) return null
    windows.push({ days, start: match[2], end: match[3] })
  }
  return windows
}

/** Render one window in the editor format (`1,2,3,4,5 09:00-12:00`). */
export function formatPeakWindowLine(window: PeakWindow): string {
  return window.days.join(',') + ' ' + window.start + '-' + window.end
}

/** Render a window list in the editor format (one per line). */
export function formatPeakWindowsText(windows: PeakWindow[]): string {
  return windows.map(formatPeakWindowLine).join('\n')
}

const DAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Human-readable day list (周一至周五 / 每天 / 周末 / 周一、周三). */
export function formatDays(days: number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b)
  if (set.length === 7) return '每天'
  if (set.length === 5 && set.every((d, i) => d === i + 1)) return '周一至周五'
  if (set.length === 2 && set[0] === 0 && set[1] === 6) return '周末'
  return set.map((d) => DAY_LABELS[d] ?? String(d)).join('、')
}

/** Human-readable window list, e.g. `周一至周五 09:00–12:00；周一至周五 14:00–18:00（Asia/Shanghai）`. */
export function formatPeakWindows(windows: PeakWindow[], timezone: string): string {
  if (windows.length === 0) return '（无高峰，一直空闲）'
  return windows.map((w) => formatDays(w.days) + ' ' + w.start + '–' + w.end).join('；') + '（' + timezone + '）'
}

/** Weekly minutes (0..10079, 0 = Sunday 00:00) occupied by the给定高峰窗口。 */
const maskCache = new Map<string, boolean[]>()

/** Build (and cache) the boolean peak mask for a week of minutes. */
export function peakMask(windows: PeakWindow[]): boolean[] {
  const key = JSON.stringify(windows)
  const cached = maskCache.get(key)
  if (cached !== undefined) return cached
  const mask = new Array<boolean>(7 * 1440).fill(false)
  for (const window of windows) {
    const start = hhmmToMinutes(window.start)
    const end = hhmmToMinutes(window.end)
    if (start === null || end === null) continue
    for (const day of window.days) {
      if (day < 0 || day > 6) continue
      if (start === end) {
        // 整段一天：start == end 视为全天高峰。
        for (let m = 0; m < 1440; m++) mask[day * 1440 + m] = true
        continue
      }
      const span = end > start ? end - start : (1440 - start) + end
      for (let i = 0; i < span; i++) {
        mask[(day * 1440 + start + i) % mask.length] = true
      }
    }
  }
  if (maskCache.size > 64) maskCache.clear()
  maskCache.set(key, mask)
  return mask
}

/** Resolve the effective peak windows for a config-like object. */
export function effectivePeakWindows(cfg: { cheapPreset?: string; peakWindows?: PeakWindow[] }): PeakWindow[] {
  if (Array.isArray(cfg.peakWindows) && cfg.peakWindows.length > 0) return cfg.peakWindows
  const preset = typeof cfg.cheapPreset === 'string' ? cfg.cheapPreset : ''
  if (isKnownPreset(preset)) return CHEAP_PRESETS[preset].windows
  return OFFICIAL_2026_WINDOWS
}

/** Resolve the effective timezone for a config-like object. */
export function effectiveCheapTimezone(cfg: { cheapTimezone?: string }): string {
  const tz = (cfg.cheapTimezone ?? '').trim()
  return tz !== '' ? tz : DEFAULT_CHEAP_TIMEZONE
}

/**
 * 尾部余量（分钟）。
 *
 * `> 0` 用自己的值（推荐 ≥ workerTimeoutMinutes，避免任务跑一半掉进高峰）；
 * `0`（默认）= 关闭尾部保护，空闲窗口内都可开跑。这样未显式配置时，
 * 官方口径的整段空闲窗口（如工作日 12:00–14:00）都能正常执行。
 */
export function effectiveMarginMinutes(cfg: { cheapMarginMinutes?: number }): number {
  const raw = typeof cfg.cheapMarginMinutes === 'number' && Number.isFinite(cfg.cheapMarginMinutes) ? cfg.cheapMarginMinutes : 0
  return raw > 0 ? Math.floor(raw) : 0
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const formatterCache = new Map<string, Intl.DateTimeFormat>()

/** Cached Intl formatter for a timezone (unknown tz falls back to Asia/Shanghai). */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached !== undefined) return cached
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', options)
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: DEFAULT_CHEAP_TIMEZONE })
  }
  formatterCache.set(timeZone, formatter)
  return formatter
}

/** Week minutes (0..10079, 0 = Sunday 00:00) of an instant in a timezone. */
export function localWeekMinutes(date: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(date)
  let weekday = 0
  let hour = 0
  let minute = 0
  for (const part of parts) {
    if (part.type === 'weekday') {
      const index = WEEKDAYS.indexOf(part.value)
      if (index >= 0) weekday = index
    } else if (part.type === 'hour') {
      hour = Number(part.value) % 24
    } else if (part.type === 'minute') {
      minute = Number(part.value)
    }
  }
  return weekday * 1440 + hour * 60 + minute
}

/** Whether an instant is inside a peak (expensive) window. */
export function isPeak(date: Date, windows: PeakWindow[], timeZone: string): boolean {
  if (windows.length === 0) return false
  return peakMask(windows)[localWeekMinutes(date, timeZone)] === true
}

/**
 * 从 `date` 起，找下一个「高峰→空闲」的转折点（即下个空闲时段的开始）。
 * @returns the instant, or null when the whole week is free (no peak).
 */
export function nextCheapStart(date: Date, windows: PeakWindow[], timeZone: string): Date | null {
  const mask = peakMask(windows)
  const local = localWeekMinutes(date, timeZone)
  for (let delta = 1; delta <= mask.length; delta++) {
    const current = mask[(local + delta) % mask.length]
    const previous = mask[(local + delta - 1) % mask.length]
    if (!current && previous) return new Date(date.getTime() + delta * 60_000)
  }
  return null
}

/**
 * 从 `date` 起，找下一个「空闲→高峰」的转折点（即下个高峰的开始）。
 * @returns the instant, or null when there is no peak at all.
 */
export function nextPeakStart(date: Date, windows: PeakWindow[], timeZone: string): Date | null {
  const mask = peakMask(windows)
  const local = localWeekMinutes(date, timeZone)
  for (let delta = 1; delta <= mask.length; delta++) {
    const current = mask[(local + delta) % mask.length]
    const previous = mask[(local + delta - 1) % mask.length]
    if (current && !previous) return new Date(date.getTime() + delta * 60_000)
  }
  return null
}

/** Format an instant as `YYYY-MM-DD HH:mm` in a timezone. */
export function formatDateTimeInTimezone(date: Date, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(date)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? ''
  const year = get('year')
  const month = get('month')
  const day = get('day')
  const hour = get('hour')
  const minute = get('minute')
  if (year === '') {
    // Fallback: build from the same instant in the fallback timezone.
    const base = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_CHEAP_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
    return base.replace(',', '')
  }
  return `${year}-${month}-${day} ${hour}:${minute}`
}

/** 省钱门控判定结果。 */
export interface CheapDecision {
  /** 省钱模式是否开启（关闭时其它字段无意义）。 */
  cheapMode: boolean
  /** 现在是否处于高峰（贵）时段。 */
  inPeak: boolean
  /** 现在是否可以开跑（非高峰，且距下个高峰的开始 ≥ 余量）。 */
  canRunNow: boolean
  /** 需要排队时：下一个空闲开始时刻（ISO）；否则空串。 */
  nextCheapStartAt: string
  /** 需要排队时：下一个空闲开始时刻的本地可读文本；否则空串。 */
  nextCheapStartLabel: string
  /** 需要排队的原因：peak=正在高峰；margin=离高峰太近；''=无需排队。 */
  waitReason: '' | 'peak' | 'margin'
  /** 距下个空闲开始的分钟数（排队时）；否则 0。 */
  minutesUntilCheap: number
  /** 距下个高峰开始的分钟数（-1 = 本周无高峰或已过）。 */
  minutesUntilPeak: number
  /** 生效的余量分钟数。 */
  marginMinutes: number
  /** 面向人的一句话原因。 */
  reason: string
}

/** Config slice the gate needs (subset of DispatcherConfig). */
export interface CheapGateConfig {
  cheapMode: boolean
  cheapPreset: string
  cheapTimezone: string
  cheapStrategy: 'wait' | 'skip'
  cheapMarginMinutes: number
  peakWindows: PeakWindow[]
  workerTimeoutMinutes: number
}

/**
 * 判定「现在能不能为自动执行开 worker」。
 *
 * 规则（省钱模式开启时）：
 * 1. 正在高峰 → 排队到下个空闲开始；策略 skip 时调用方跳过。
 * 2. 空闲但距下个高峰不足 `cheapMarginMinutes` → 不冒险开跑（避免跑一半掉进
 *    高峰），直接排到下个空闲段（即这次高峰结束之后）。
 * 3. 其它情况 → 允许立刻执行。
 *
 * `cheapMode=false` 时恒返回 `canRunNow:true`，调用方无需分支，保证旧行为不变。
 */
export function evaluateCheapMode(cfg: CheapGateConfig, now: Date = new Date()): CheapDecision {
  const timezone = effectiveCheapTimezone(cfg)
  const windows = effectivePeakWindows(cfg)
  const margin = effectiveMarginMinutes(cfg)
  if (!cfg.cheapMode) {
    return {
      cheapMode: false, inPeak: false, canRunNow: true, nextCheapStartAt: '', nextCheapStartLabel: '',
      waitReason: '', minutesUntilCheap: 0, minutesUntilPeak: -1, marginMinutes: margin,
      reason: '省钱模式未开启，按正常执行时间逻辑执行',
    }
  }
  const inPeak = isPeak(now, windows, timezone)
  if (inPeak) {
    const next = nextCheapStart(now, windows, timezone)
    const minutes = next === null ? 0 : Math.max(1, Math.round((next.getTime() - now.getTime()) / 60_000))
    return {
      cheapMode: true, inPeak: true, canRunNow: false,
      nextCheapStartAt: next?.toISOString() ?? '', nextCheapStartLabel: next === null ? '' : formatDateTimeInTimezone(next, timezone),
      waitReason: 'peak', minutesUntilCheap: minutes, minutesUntilPeak: 0, marginMinutes: margin,
      reason: '当前处于高峰时段（' + formatPeakWindows(windows, timezone) + '），排队等待下个空闲时段',
    }
  }
  const upcomingPeak = nextPeakStart(now, windows, timezone)
  const minutesUntilPeak = upcomingPeak === null ? -1 : Math.max(0, Math.round((upcomingPeak.getTime() - now.getTime()) / 60_000))
  if (margin > 0 && upcomingPeak !== null && minutesUntilPeak >= 0 && minutesUntilPeak < margin) {
    const next = nextCheapStart(now, windows, timezone)
    const minutes = next === null ? 0 : Math.max(1, Math.round((next.getTime() - now.getTime()) / 60_000))
    return {
      cheapMode: true, inPeak: false, canRunNow: false,
      nextCheapStartAt: next?.toISOString() ?? '', nextCheapStartLabel: next === null ? '' : formatDateTimeInTimezone(next, timezone),
      waitReason: 'margin', minutesUntilCheap: minutes, minutesUntilPeak: minutesUntilPeak, marginMinutes: margin,
      reason: '距下个高峰开始仅 ' + minutesUntilPeak + ' 分钟，不足尾部余量 ' + margin + ' 分钟，排到下个空闲段',
    }
  }
  return {
    cheapMode: true, inPeak: false, canRunNow: true, nextCheapStartAt: '', nextCheapStartLabel: '',
    waitReason: '', minutesUntilCheap: 0, minutesUntilPeak: minutesUntilPeak, marginMinutes: margin,
    reason: '当前处于空闲时段，可正常执行',
  }
}
