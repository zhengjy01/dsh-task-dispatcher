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
    days: number[];
    /** 开始 HH:MM（含）。 */
    start: string;
    /** 结束 HH:MM（不含）；start > end 表示跨过午夜。 */
    end: string;
}
/** 一个可切换的时段口径 preset。 */
export interface CheapPreset {
    id: string;
    label: string;
    timezone: string;
    windows: PeakWindow[];
}
/** 官方 2026-08-17 峰谷定价口径（默认）。 */
export declare const OFFICIAL_2026_WINDOWS: PeakWindow[];
/** 旧版 UTC 口径：每日 UTC 16:30–00:30（北京 00:30–08:30）空闲，故高峰 = 08:30–次日 00:30。 */
export declare const LEGACY_UTC_WINDOWS: PeakWindow[];
/** 全部 preset（id -> 定义）。切 preset 即同时切时段与时区。 */
export declare const CHEAP_PRESETS: Record<string, CheapPreset>;
/** 默认 preset id。 */
export declare const DEFAULT_CHEAP_PRESET = "official-2026";
/** 默认时区（高峰窗口按此时区解释）。 */
export declare const DEFAULT_CHEAP_TIMEZONE = "Asia/Shanghai";
/** 默认尾部余量（0 = 不做尾部保护，空闲窗口内都可开跑；建议按需设为 15 或 workerTimeoutMinutes）。 */
export declare const DEFAULT_CHEAP_MARGIN_MINUTES = 0;
/** Whether a value is a known preset id. */
export declare function isKnownPreset(id: string): boolean;
/** Normalise an unknown preset id to a known one (unknown → custom). */
export declare function normalizePreset(id: unknown): string;
/** "HH:MM" → minutes since midnight, or null when malformed. */
export declare function hhmmToMinutes(value: string): number | null;
/** Minutes since midnight → "HH:MM". */
export declare function minutesToHhmm(minutes: number): string;
/** Parse one unknown value into a PeakWindow, or null when malformed. */
export declare function parsePeakWindow(value: unknown): PeakWindow | null;
/**
 * Parse an unknown array into a PeakWindow list.
 * @returns the windows (possibly empty = 「没有任何高峰」= 一直空闲) or null when malformed.
 */
export declare function parsePeakWindows(value: unknown): PeakWindow[] | null;
/**
 * Parse the human-friendly one-line-per-window editor format:
 *   `1,2,3,4,5 09:00-12:00`
 * days are 0=Sun … 6=Sat; blank lines and `#` comments are dropped.
 * @returns the windows ([] when the text is empty = 一直空闲) or null when a line is malformed.
 */
export declare function parsePeakWindowsText(text: string): PeakWindow[] | null;
/** Render one window in the editor format (`1,2,3,4,5 09:00-12:00`). */
export declare function formatPeakWindowLine(window: PeakWindow): string;
/** Render a window list in the editor format (one per line). */
export declare function formatPeakWindowsText(windows: PeakWindow[]): string;
/** Human-readable day list (周一至周五 / 每天 / 周末 / 周一、周三). */
export declare function formatDays(days: number[]): string;
/** Human-readable window list, e.g. `周一至周五 09:00–12:00；周一至周五 14:00–18:00（Asia/Shanghai）`. */
export declare function formatPeakWindows(windows: PeakWindow[], timezone: string): string;
/** Build (and cache) the boolean peak mask for a week of minutes. */
export declare function peakMask(windows: PeakWindow[]): boolean[];
/** Resolve the effective peak windows for a config-like object. */
export declare function effectivePeakWindows(cfg: {
    cheapPreset?: string;
    peakWindows?: PeakWindow[];
}): PeakWindow[];
/** Resolve the effective timezone for a config-like object. */
export declare function effectiveCheapTimezone(cfg: {
    cheapTimezone?: string;
}): string;
/**
 * 尾部余量（分钟）。
 *
 * `> 0` 用自己的值（推荐 ≥ workerTimeoutMinutes，避免任务跑一半掉进高峰）；
 * `0`（默认）= 关闭尾部保护，空闲窗口内都可开跑。这样未显式配置时，
 * 官方口径的整段空闲窗口（如工作日 12:00–14:00）都能正常执行。
 */
export declare function effectiveMarginMinutes(cfg: {
    cheapMarginMinutes?: number;
}): number;
/** Week minutes (0..10079, 0 = Sunday 00:00) of an instant in a timezone. */
export declare function localWeekMinutes(date: Date, timeZone: string): number;
/** Whether an instant is inside a peak (expensive) window. */
export declare function isPeak(date: Date, windows: PeakWindow[], timeZone: string): boolean;
/**
 * 从 `date` 起，找下一个「高峰→空闲」的转折点（即下个空闲时段的开始）。
 * @returns the instant, or null when the whole week is free (no peak).
 */
export declare function nextCheapStart(date: Date, windows: PeakWindow[], timeZone: string): Date | null;
/**
 * 从 `date` 起，找下一个「空闲→高峰」的转折点（即下个高峰的开始）。
 * @returns the instant, or null when there is no peak at all.
 */
export declare function nextPeakStart(date: Date, windows: PeakWindow[], timeZone: string): Date | null;
/** Format an instant as `YYYY-MM-DD HH:mm` in a timezone. */
export declare function formatDateTimeInTimezone(date: Date, timeZone: string): string;
/** 省钱门控判定结果。 */
export interface CheapDecision {
    /** 省钱模式是否开启（关闭时其它字段无意义）。 */
    cheapMode: boolean;
    /** 现在是否处于高峰（贵）时段。 */
    inPeak: boolean;
    /** 现在是否可以开跑（非高峰，且距下个高峰的开始 ≥ 余量）。 */
    canRunNow: boolean;
    /** 需要排队时：下一个空闲开始时刻（ISO）；否则空串。 */
    nextCheapStartAt: string;
    /** 需要排队时：下一个空闲开始时刻的本地可读文本；否则空串。 */
    nextCheapStartLabel: string;
    /** 需要排队的原因：peak=正在高峰；margin=离高峰太近；''=无需排队。 */
    waitReason: '' | 'peak' | 'margin';
    /** 距下个空闲开始的分钟数（排队时）；否则 0。 */
    minutesUntilCheap: number;
    /** 距下个高峰开始的分钟数（-1 = 本周无高峰或已过）。 */
    minutesUntilPeak: number;
    /** 生效的余量分钟数。 */
    marginMinutes: number;
    /** 面向人的一句话原因。 */
    reason: string;
}
/** Config slice the gate needs (subset of DispatcherConfig). */
export interface CheapGateConfig {
    cheapMode: boolean;
    cheapPreset: string;
    cheapTimezone: string;
    cheapStrategy: 'wait' | 'skip';
    cheapMarginMinutes: number;
    peakWindows: PeakWindow[];
    workerTimeoutMinutes: number;
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
export declare function evaluateCheapMode(cfg: CheapGateConfig, now?: Date): CheapDecision;
