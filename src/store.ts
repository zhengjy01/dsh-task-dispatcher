/**
 * dsh-task-dispatcher — config store.
 *
 * Persists the dispatcher configuration (dispatch time, source TickTick
 * project, filtering, notify toggles, and the last dispatch summary) to
 * ~/.dsh/dsh-task-dispatcher.json (mode 0600). Reuses the TickTick OAuth
 * credentials already stored by the dsh-ticktick plugin (~/.dsh/dsh-ticktick.json)
 * — it never stores its own secrets. Reads are lazy and cached; the public
 * view() never exposes tokens. The config path can be overridden with
 * DSH_TASK_DISPATCHER_CONFIG (used by the smoke tests).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Default machine-wide config location (mode 0600). */
export const DEFAULT_CONFIG_FILE = path.join(homedir(), '.dsh', 'dsh-task-dispatcher.json')

/** Default workspace task file written on each dispatch. */
export const DEFAULT_TASK_FILE = path.join(homedir(), '.dsh', 'dsh-task-dispatcher', 'today-tasks.md')

/** Test override for the config location. */
export function configPath(): string {
  const override = process.env.DSH_TASK_DISPATCHER_CONFIG
  return override !== undefined && override !== '' ? override : DEFAULT_CONFIG_FILE
}

/** How to select tasks from the source project. */
export type DueMode = 'today' | 'all'

/** Persisted config shape. No secrets here. */
export interface DispatcherConfig {
  enabled: boolean
  announceToAgent: boolean
  /** Daily dispatch hour (0-23). */
  dispatchHour: number
  /** Daily dispatch minute (0-59). */
  dispatchMinute: number
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
  /** Post a macOS notification on each dispatch. */
  notifyMac: boolean
  /** Where the today-tasks file is written. */
  taskFile: string
  /** ISO timestamp of the last successful dispatch. */
  lastDispatchAt: string
  /** Number of tasks in the last dispatch. */
  lastTaskCount: number
  /** Titles of the tasks in the last dispatch (for the status view). */
  lastTaskTitles: string[]
}

/** Public, secret-free status view. */
export interface DispatcherConfigView {
  configured: boolean
  enabled: boolean
  announceToAgent: boolean
  dispatchHour: number
  dispatchMinute: number
  projectName: string
  projectId: string
  dueMode: DueMode
  includeUndated: boolean
  notifyFlomo: boolean
  flomoTag: string
  notifyMac: boolean
  taskFile: string
  lastDispatchAt: string
  lastTaskCount: number
  lastTaskTitles: string[]
  configPath: string
}

/** Default config (used when the file is absent or unreadable). */
function defaults(): DispatcherConfig {
  return {
    enabled: true,
    announceToAgent: true,
    dispatchHour: 8,
    dispatchMinute: 30,
    projectName: '5️⃣AI',
    projectId: '',
    dueMode: 'today',
    includeUndated: true,
    notifyFlomo: true,
    flomoTag: 'AI/DSH/派发',
    notifyMac: true,
    taskFile: DEFAULT_TASK_FILE,
    lastDispatchAt: '',
    lastTaskCount: 0,
    lastTaskTitles: [],
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
    dispatchHour: clampInt(num(record.dispatchHour, d.dispatchHour), 0, 23),
    dispatchMinute: clampInt(num(record.dispatchMinute, d.dispatchMinute), 0, 59),
    projectName: str(record.projectName, d.projectName),
    projectId: str(record.projectId, ''),
    dueMode: record.dueMode === 'all' ? 'all' : 'today',
    includeUndated: bool(record.includeUndated, d.includeUndated),
    notifyFlomo: bool(record.notifyFlomo, d.notifyFlomo),
    flomoTag: str(record.flomoTag, d.flomoTag),
    notifyMac: bool(record.notifyMac, d.notifyMac),
    taskFile: str(record.taskFile, d.taskFile),
    lastDispatchAt: str(record.lastDispatchAt, ''),
    lastTaskCount: num(record.lastTaskCount, 0),
    lastTaskTitles: Array.isArray(record.lastTaskTitles) ? record.lastTaskTitles.filter((t): t is string => typeof t === 'string') : [],
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
      dispatchHour: cfg.dispatchHour,
      dispatchMinute: cfg.dispatchMinute,
      projectName: cfg.projectName,
      projectId: cfg.projectId ?? '',
      dueMode: cfg.dueMode,
      includeUndated: cfg.includeUndated,
      notifyFlomo: cfg.notifyFlomo,
      flomoTag: cfg.flomoTag,
      notifyMac: cfg.notifyMac,
      taskFile: cfg.taskFile,
      lastDispatchAt: cfg.lastDispatchAt,
      lastTaskCount: cfg.lastTaskCount,
      lastTaskTitles: cfg.lastTaskTitles,
      configPath: configPath(),
    }
  }

  /** Apply a config patch: strings/numbers/booleans replace, undefined keeps. */
  async patch(args: Record<string, unknown> | undefined): Promise<DispatcherConfigView> {
    const cfg = await this.load()
    const next: DispatcherConfig = { ...cfg }
    if (args !== undefined && typeof args.enabled === 'boolean') next.enabled = args.enabled
    if (args !== undefined && typeof args.announceToAgent === 'boolean') next.announceToAgent = args.announceToAgent
    if (args !== undefined && args.dispatchHour !== undefined) next.dispatchHour = clampInt(Number(args.dispatchHour), 0, 23)
    if (args !== undefined && args.dispatchMinute !== undefined) next.dispatchMinute = clampInt(Number(args.dispatchMinute), 0, 59)
    if (args !== undefined && typeof args.projectName === 'string') next.projectName = args.projectName.trim()
    if (args !== undefined && typeof args.projectId === 'string') next.projectId = args.projectId.trim()
    if (args !== undefined && (args.dueMode === 'today' || args.dueMode === 'all')) next.dueMode = args.dueMode
    if (args !== undefined && typeof args.includeUndated === 'boolean') next.includeUndated = args.includeUndated
    if (args !== undefined && typeof args.notifyFlomo === 'boolean') next.notifyFlomo = args.notifyFlomo
    if (args !== undefined && typeof args.flomoTag === 'string') next.flomoTag = args.flomoTag.trim()
    if (args !== undefined && typeof args.notifyMac === 'boolean') next.notifyMac = args.notifyMac
    if (args !== undefined && typeof args.taskFile === 'string' && args.taskFile.trim() !== '') next.taskFile = args.taskFile.trim()
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
}
