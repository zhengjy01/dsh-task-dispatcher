/**
 * dsh-task-dispatcher — config store.
 *
 * Persists the dispatcher configuration (poll interval, source TickTick
 * project, filtering, notify toggles, and the last dispatch summary) to
 * ~/.dsh/dsh-task-dispatcher.json (mode 0600). Reuses the TickTick OAuth
 * credentials already stored by the dsh-ticktick plugin (~/.dsh/dsh-ticktick.json)
 * — it never stores its own secrets. Reads are lazy and cached; the public
 * view() never exposes tokens. The config path can be overridden with
 * DSH_TASK_DISPATCHER_CONFIG (used by the smoke tests).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

import { pluginPath } from './home.ts'

/** Default config location: DSH_HOME when set, else ~/.dsh (mode 0600). */
export const DEFAULT_CONFIG_FILE = pluginPath(undefined, 'dsh-task-dispatcher.json')

/** Default workspace task file written on each dispatch (under DSH_HOME). */
export const DEFAULT_TASK_FILE = pluginPath(undefined, 'dsh-task-dispatcher', 'today-tasks.md')

/** Default minutes before an auto-execute worker is killed (was a hardcoded 10). */
export const DEFAULT_WORKER_TIMEOUT_MINUTES = 30

/** Default worker prompt template ({title}/{content} replaced per task). */
export const DEFAULT_WORKER_PROMPT =
  '你是 DeepSeek Harness 的独立任务执行会话。请用你手头的基础工具（bash/读写文件/glob/grep/网络/目标工具）执行下面这一项任务：\n\n' +
  '任务：{title}\n' +
  '说明：{content}\n\n' +
  '要求：聚焦完成这一项即可；完成后在回复末尾单独输出一行：DONE'

/** Config location: DSH_TASK_DISPATCHER_CONFIG → DSH_HOME → ~/.dsh (mode 0600). */
export function configPath(): string {
  return pluginPath(process.env.DSH_TASK_DISPATCHER_CONFIG, 'dsh-task-dispatcher.json')
}

/** How to select tasks from the source project. */
export type DueMode = 'today' | 'all'

/** Persisted config shape. No secrets here. */
export interface DispatcherConfig {
  enabled: boolean
  announceToAgent: boolean
  /** Poll interval in minutes; 0 disables the automatic pull. */
  dispatchIntervalMinutes: number
  /** Source TickTick list, resolved by name; falls back to projectId. */
  projectName: string
  /** Optional explicit project id (name-resolution wins when both present). */
  projectId?: string
  /** today = due today/overdue; all = every incomplete task in the list. */
  dueMode: DueMode
  /** Whether to include tasks with no due date (when dueMode = today). */
  includeUndated: boolean
  /** Push a flomo MEMO on each dispatch. */
  notifyFlomo: boolean
  /** flomo tag (no leading #; space-separated allowed). */
  flomoTag: string
  /** Strip '#' from the dispatch flomo body so inline #word isn't a tag. */
  flomoStripBodyHash: boolean
  /** Post a macOS notification on each dispatch. */
  notifyMac: boolean
  /** Push a SHORT result notice after every auto-executed task (and a batch tally). */
  notifyResult: boolean
  /** Push the dispatch notification / session report to WeChat via ClawBot. */
  notifyWechat: boolean
  /** ClawBot gateway base URL; '' = http://127.0.0.1:51235. */
  wechatGatewayUrl: string
  /** WeChat recipient id; '' = auto-detect the ClawBot-logged-in user. */
  wechatTo: string
  /** ClawBot state dir; '' = $DSH_WECHAT_HOME or ~/.dsh-wechat. */
  wechatStateDir: string
  /** Where the today-tasks file is written. */
  taskFile: string
  /** ISO timestamp of the last successful dispatch. */
  lastDispatchAt: string
  /** Number of tasks in the last dispatch. */
  lastTaskCount: number
  /** Titles of the tasks in the last dispatch (for the status view). */
  lastTaskTitles: string[]
  /** Auto-execute each pulled task in its own headless DSH session. */
  autoExecute: boolean
  /** Minutes before re-attempting a task whose worker failed (retry cooldown). */
  retryCooldownMinutes: number
  /** Kill an auto-execute worker after this many minutes (default 30). */
  workerTimeoutMinutes: number
  /** Worker prompt template; {title}/{content} replaced per task. */
  workerPrompt: string
  /** DSH workspace id the auto-execute worker session runs in ('' = home dir). */
  workerWorkspaceId: string
  /** TaskId -> ISO time of last auto-execute attempt (avoids re-spawning). */
  attempted: Record<string, string>
}

/** Public, secret-free status view. */
export interface DispatcherConfigView {
  configured: boolean
  enabled: boolean
  announceToAgent: boolean
  dispatchIntervalMinutes: number
  projectName: string
  projectId: string
  dueMode: DueMode
  includeUndated: boolean
  notifyFlomo: boolean
  flomoTag: string
  flomoStripBodyHash: boolean
  notifyMac: boolean
  notifyResult: boolean
  notifyWechat: boolean
  wechatGatewayUrl: string
  wechatTo: string
  wechatStateDir: string
  taskFile: string
  lastDispatchAt: string
  lastTaskCount: number
  lastTaskTitles: string[]
  autoExecute: boolean
  retryCooldownMinutes: number
  workerTimeoutMinutes: number
  workerPrompt: string
  workerWorkspaceId: string
  configPath: string
}

/** Default config (used when the file is absent or unreadable). */
function defaults(): DispatcherConfig {
  return {
    enabled: true,
    announceToAgent: true,
    dispatchIntervalMinutes: 30,
    projectName: '5️⃣AI',
    projectId: '',
    dueMode: 'today',
    includeUndated: true,
    notifyFlomo: true,
    flomoTag: 'AI/DSH/派发',
    flomoStripBodyHash: true,
    notifyMac: true,
    notifyResult: true,
    notifyWechat: false,
    wechatGatewayUrl: '',
    wechatTo: '',
    wechatStateDir: '',
    taskFile: DEFAULT_TASK_FILE,
    lastDispatchAt: '',
    lastTaskCount: 0,
    lastTaskTitles: [],
    autoExecute: false,
    retryCooldownMinutes: 60,
    workerTimeoutMinutes: DEFAULT_WORKER_TIMEOUT_MINUTES,
    workerPrompt: DEFAULT_WORKER_PROMPT,
    workerWorkspaceId: '',
    attempted: {},
  }
}

/** Parse an unknown JSON record into config (tolerates missing keys). */
function parse(raw: unknown): DispatcherConfig {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const num = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback
  const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
  const d = defaults()
  return {
    enabled: bool(record.enabled, d.enabled),
    announceToAgent: bool(record.announceToAgent, d.announceToAgent),
    dispatchIntervalMinutes: clampInt(num(record.dispatchIntervalMinutes, d.dispatchIntervalMinutes), 0, 24 * 60),
    projectName: str(record.projectName, d.projectName),
    projectId: str(record.projectId, ''),
    dueMode: record.dueMode === 'all' ? 'all' : 'today',
    includeUndated: bool(record.includeUndated, d.includeUndated),
    notifyFlomo: bool(record.notifyFlomo, d.notifyFlomo),
    flomoTag: str(record.flomoTag, d.flomoTag),
    flomoStripBodyHash: bool(record.flomoStripBodyHash, d.flomoStripBodyHash),
    notifyMac: bool(record.notifyMac, d.notifyMac),
    notifyResult: bool(record.notifyResult, d.notifyResult),
    notifyWechat: bool(record.notifyWechat, d.notifyWechat),
    wechatGatewayUrl: str(record.wechatGatewayUrl, ''),
    wechatTo: str(record.wechatTo, ''),
    wechatStateDir: str(record.wechatStateDir, ''),
    taskFile: str(record.taskFile, d.taskFile),
    lastDispatchAt: str(record.lastDispatchAt, ''),
    lastTaskCount: num(record.lastTaskCount, 0),
    lastTaskTitles: Array.isArray(record.lastTaskTitles) ? record.lastTaskTitles.filter((t): t is string => typeof t === 'string') : [],
    autoExecute: bool(record.autoExecute, d.autoExecute),
    retryCooldownMinutes: clampInt(num(record.retryCooldownMinutes, d.retryCooldownMinutes), 1, 24 * 60),
    workerTimeoutMinutes: clampInt(num(record.workerTimeoutMinutes, d.workerTimeoutMinutes), 1, 24 * 60),
    workerPrompt: str(record.workerPrompt, d.workerPrompt),
    workerWorkspaceId: str(record.workerWorkspaceId, ''),
    attempted: typeof record.attempted === 'object' && record.attempted !== null
      ? Object.fromEntries(Object.entries(record.attempted as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : {},
  }
}

function clampInt(value: number, min: number, max: number): number {
  return value < min ? min : (value > max ? max : Math.floor(value))
}

/**
 * Config store backed by ~/.dsh/dsh-task-dispatcher.json.
 * Reads are lazy and cached; writes use mode 0600.
 */
export class DispatcherStore {
  config: DispatcherConfig | null = null

  async load(): Promise<DispatcherConfig> {
    if (this.config !== null) return this.config
    try {
      const raw = await readFile(configPath(), 'utf8')
      this.config = parse(JSON.parse(raw))
    } catch {
      // Missing or unreadable config file: treat as default.
      this.config = defaults()
    }
    return this.config
  }

  async save(next: DispatcherConfig): Promise<void> {
    this.config = next
    await mkdir(path.dirname(configPath()), { recursive: true })
    await writeFile(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 })
  }

  /** Public, secret-free view. */
  async view(): Promise<DispatcherConfigView> {
    const cfg = await this.load()
    return {
      configured: true,
      enabled: cfg.enabled,
      announceToAgent: cfg.announceToAgent,
      dispatchIntervalMinutes: cfg.dispatchIntervalMinutes,
      projectName: cfg.projectName,
      projectId: cfg.projectId ?? '',
      dueMode: cfg.dueMode,
      includeUndated: cfg.includeUndated,
      notifyFlomo: cfg.notifyFlomo,
      flomoTag: cfg.flomoTag,
      flomoStripBodyHash: cfg.flomoStripBodyHash,
      notifyMac: cfg.notifyMac,
      notifyResult: cfg.notifyResult,
      notifyWechat: cfg.notifyWechat,
      wechatGatewayUrl: cfg.wechatGatewayUrl,
      wechatTo: cfg.wechatTo,
      wechatStateDir: cfg.wechatStateDir,
      taskFile: cfg.taskFile,
      lastDispatchAt: cfg.lastDispatchAt,
      lastTaskCount: cfg.lastTaskCount,
      lastTaskTitles: cfg.lastTaskTitles,
      autoExecute: cfg.autoExecute,
      retryCooldownMinutes: cfg.retryCooldownMinutes,
      workerTimeoutMinutes: cfg.workerTimeoutMinutes,
      workerPrompt: cfg.workerPrompt,
      workerWorkspaceId: cfg.workerWorkspaceId,
      configPath: configPath(),
    }
  }

  /** Apply a config patch: strings/numbers/booleans replace, undefined keeps. */
  async patch(args: Record<string, unknown> | undefined): Promise<DispatcherConfigView> {
    const cfg = await this.load()
    const next: DispatcherConfig = { ...cfg }
    if (args !== undefined && typeof args.enabled === 'boolean') next.enabled = args.enabled
    if (args !== undefined && typeof args.announceToAgent === 'boolean') next.announceToAgent = args.announceToAgent
    if (args !== undefined && args.dispatchIntervalMinutes !== undefined) next.dispatchIntervalMinutes = clampInt(Number(args.dispatchIntervalMinutes), 0, 24 * 60)
    if (args !== undefined && typeof args.projectName === 'string') next.projectName = args.projectName.trim()
    if (args !== undefined && typeof args.projectId === 'string') next.projectId = args.projectId.trim()
    if (args !== undefined && (args.dueMode === 'today' || args.dueMode === 'all')) next.dueMode = args.dueMode
    if (args !== undefined && typeof args.includeUndated === 'boolean') next.includeUndated = args.includeUndated
    if (args !== undefined && typeof args.notifyFlomo === 'boolean') next.notifyFlomo = args.notifyFlomo
    if (args !== undefined && typeof args.flomoTag === 'string') next.flomoTag = args.flomoTag.trim()
    if (args !== undefined && typeof args.flomoStripBodyHash === 'boolean') next.flomoStripBodyHash = args.flomoStripBodyHash
    if (args !== undefined && typeof args.notifyMac === 'boolean') next.notifyMac = args.notifyMac
    if (args !== undefined && typeof args.notifyResult === 'boolean') next.notifyResult = args.notifyResult
    if (args !== undefined && typeof args.notifyWechat === 'boolean') next.notifyWechat = args.notifyWechat
    if (args !== undefined && typeof args.wechatGatewayUrl === 'string') next.wechatGatewayUrl = args.wechatGatewayUrl.trim()
    if (args !== undefined && typeof args.wechatTo === 'string') next.wechatTo = args.wechatTo.trim()
    if (args !== undefined && typeof args.wechatStateDir === 'string') next.wechatStateDir = args.wechatStateDir.trim()
    if (args !== undefined && typeof args.taskFile === 'string' && args.taskFile.trim() !== '') next.taskFile = args.taskFile.trim()
    if (args !== undefined && typeof args.autoExecute === 'boolean') next.autoExecute = args.autoExecute
    if (args !== undefined && args.retryCooldownMinutes !== undefined) next.retryCooldownMinutes = clampInt(Number(args.retryCooldownMinutes), 1, 24 * 60)
    if (args !== undefined && args.workerTimeoutMinutes !== undefined) next.workerTimeoutMinutes = clampInt(Number(args.workerTimeoutMinutes), 1, 24 * 60)
    if (args !== undefined && typeof args.workerPrompt === 'string' && args.workerPrompt.trim() !== '') next.workerPrompt = args.workerPrompt.trim()
    if (args !== undefined && typeof args.workerWorkspaceId === 'string') next.workerWorkspaceId = args.workerWorkspaceId.trim()
    await this.save(next)
    return this.view()
  }

  /** Record a completed dispatch summary. */
  async recordDispatch(titles: string[]): Promise<DispatcherConfigView> {
    const cfg = await this.load()
    const next: DispatcherConfig = {
      ...cfg,
      lastDispatchAt: new Date().toISOString(),
      lastTaskCount: titles.length,
      lastTaskTitles: titles,
    }
    await this.save(next)
    return this.view()
  }

  /** Mark a task id as attempted now (for auto-execute retry cooldown). */
  async markAttempted(taskId: string): Promise<void> {
    const cfg = await this.load()
    await this.save({ ...cfg, attempted: { ...cfg.attempted, [taskId]: new Date().toISOString() } })
  }

  /** Re-attempt logic: whether `now` is past the retry cooldown for a task id. */
  async canRetry(taskId: string, cooldownMinutes: number): Promise<boolean> {
    const cfg = await this.load()
    const attemptedAt = cfg.attempted[taskId]
    if (attemptedAt === undefined) return true
    const elapsed = Date.now() - new Date(attemptedAt).getTime()
    return elapsed > cooldownMinutes * 60 * 1000
  }
}
