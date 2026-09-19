/**
 * Browser-side API client for the /api/dsh-task-dispatcher route family.
 * The only data access path the settings panel uses — plain fetch, same origin.
 */

/** Public config view (mirrors the host contract). */
export interface DispatcherConfigView {
  configured: boolean
  enabled: boolean
  announceToAgent: boolean
  dispatchIntervalMinutes: number
  projectName: string
  projectId: string
  dueMode: string
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
  cheapMode: boolean
  cheapPreset: string
  cheapPresetLabel: string
  peakWindows: { days: number[]; start: string; end: string }[]
  peakWindowsText: string
  cheapTimezone: string
  cheapStrategy: string
  cheapMarginMinutes: number
  cheapMarginEffectiveMinutes: number
  nextCheapStartAt: string
  cheapQueue: { id: string; title: string; queuedAt: string }[]
  cheapQueueCount: number
  configPath: string
}

/** One DSH workspace (id + display title + directory path). */
export interface WorkspaceInfo {
  id: string
  title: string
  path: string
}

/** Workspace list response. */
export interface WorkspaceListResult {
  workspaces: WorkspaceInfo[]
}

/** Dispatch result. */
export interface DispatcherRunResult {
  ok: boolean
  message: string
  dispatchedAt: string
  projectName: string
  projectId: string
  taskCount: number
  tasks: { id: string; title: string; dueDate: string }[]
  taskFile: string
  wechatNotify?: string
  flomoNotify?: string
  macNotify?: string
  /** 省钱模式门控结果（开启自动执行时才有）。 */
  cheap?: {
    mode: string
    executed: number
    completed: number
    failed: number
    queued: number
    nextCheapStartAt: string
    nextCheapStartLabel: string
    log: string[]
  }
}

/** One queued task in the deferred-sync queue. */
export interface DeferredTask {
  title: string
  /** Parent task key ('' = top level). */
  parentKey: string
  dueDate: string
  stagedBy: string
}

/** launchd timer state for the deferred sync. */
export interface DeferredTimerState {
  /** launchd exists only on macOS; other platforms degrade to manual flush. */
  supported: boolean
  label: string
  plistPath: string
  installed: boolean
  loaded: boolean
  intervalSeconds: number
  detail: string
}

/** Deferred-sync status payload. */
export interface DeferredStatus {
  ok: boolean
  message: string
  queueFile: string
  scriptPath: string
  /** 'installed' = <DSH_HOME>/scripts, 'bundled' = shipped in this package. */
  scriptSource: string
  bundledScriptPath: string
  idleMinutes: number
  maxPerSession: number
  projectId: string
  tags: string[]
  pending: number
  pendingTop: number
  tasks: DeferredTask[]
  /** Whole-harness silence in minutes (-1 when no session log exists yet). */
  idleMinutesNow: number
  newestSessionAt: string
  isIdle: boolean
  lastFlushAt: string
  lastFlushResult: string
  timer: DeferredTimerState
}

/** Result of one deferred action (flush / threshold change / timer change). */
export interface DeferredActionResult {
  ok: boolean
  message: string
  /** Raw child-process output, shown verbatim so failures are diagnosable. */
  output: string
  status?: DeferredStatus
}

/** Error carrying the route's JSON error message. */
export class DispatcherApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DispatcherApiError'
  }
}

/** Parse a JSON response or throw a DispatcherApiError. */
async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new DispatcherApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${response.status}`
    throw new DispatcherApiError(message)
  }
  return body as T
}

/** Plain fetch helper with an error wrapper. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    throw new DispatcherApiError('网络请求失败: ' + String(error instanceof Error ? error.message : error))
  }
  return readJson<T>(response)
}

/** The dispatcher panel API. */
export class DispatcherApi {
  async getConfig(): Promise<DispatcherConfigView> {
    return request<DispatcherConfigView>('/api/dsh-task-dispatcher/config')
  }

  async getStatus(): Promise<DispatcherConfigView> {
    return request<DispatcherConfigView>('/api/dsh-task-dispatcher/status')
  }

  async setConfig(patch: Record<string, unknown>): Promise<DispatcherConfigView> {
    return request<DispatcherConfigView>('/api/dsh-task-dispatcher/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  }

  async run(ignoreCheapMode = false): Promise<DispatcherRunResult> {
    return request<DispatcherRunResult>('/api/dsh-task-dispatcher/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignoreCheapMode }),
    })
  }

  /** List the DSH workspaces the auto-execute worker can run in. */
  async getWorkspaces(): Promise<WorkspaceInfo[]> {
    const result = await request<WorkspaceListResult>('/api/dsh-task-dispatcher/workspaces')
    return result.workspaces
  }

  /** Deferred TickTick sync: queue, thresholds, timer state. */
  async getDeferred(): Promise<DeferredStatus> {
    return request<DeferredStatus>('/api/dsh-task-dispatcher/deferred')
  }

  /** Change the silence threshold, the per-session cap, or the timer interval. */
  async setDeferredConfig(patch: {
    idleMinutes?: number
    maxPerSession?: number
    intervalSeconds?: number
  }): Promise<DeferredActionResult> {
    return request<DeferredActionResult>('/api/dsh-task-dispatcher/deferred/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
  }

  /** Write the queue to TickTick now. */
  async flushDeferred(force = false): Promise<DeferredActionResult> {
    return request<DeferredActionResult>('/api/dsh-task-dispatcher/deferred/flush', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    })
  }

  /** Install/reload/remove the launchd timer, or refresh the local script copy. */
  async deferredTimer(
    action: 'install' | 'reload' | 'uninstall' | 'install-script',
    intervalSeconds?: number,
  ): Promise<DeferredActionResult> {
    return request<DeferredActionResult>('/api/dsh-task-dispatcher/deferred/timer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(intervalSeconds === undefined ? { action } : { action, intervalSeconds }),
    })
  }
}
