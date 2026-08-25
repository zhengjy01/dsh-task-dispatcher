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
  notifyMac: boolean
  taskFile: string
  lastDispatchAt: string
  lastTaskCount: number
  lastTaskTitles: string[]
  configPath: string
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
  flomoNotify?: string
  macNotify?: string
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

  async run(): Promise<DispatcherRunResult> {
    return request<DispatcherRunResult>('/api/dsh-task-dispatcher/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  }
}
