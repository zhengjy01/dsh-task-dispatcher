/**
 * Ambient declaration for the `dsh-ticktick` plugin package.
 *
 * dsh-ticktick ships its declarations under lib/types/ but its package.json
 * exports map has no `types` condition and no top-level `types` field, so
 * TypeScript's `bundler` resolution cannot discover them and treats the
 * import as implicit `any`. This local declaration restores the small,
 * typed surface the dispatcher reuses (the credential store + API client),
 * without vendoring the whole plugin.
 */

declare module 'dsh-ticktick' {
  /** One TickTick task (fields the dispatcher reads). */
  interface TickTickTask {
    id: string
    projectId: string
    title: string
    content?: string
    dueDate?: string
    priority?: number
    status?: number
    tags?: string[]
  }

  /** One TickTick project/清单. */
  interface TickTickProject {
    id: string
    name: string
    closed?: boolean
    color?: string
  }

  /** Credential store bound to ~/.dsh/dsh-ticktick.json. */
  class TickTickStore {
    load(): Promise<{ accessToken: string; refreshToken: string; region: string }>
  }

  /** API client over the TickTick Open API (/open/v1). */
  class TickTickApi {
    constructor(store: TickTickStore, fetchImpl?: unknown)
    getProjects(): Promise<TickTickProject[]>
    getProjectData(projectId: string): Promise<{ tasks?: TickTickTask[]; [key: string]: unknown }>
    getCompletedTasks(projectId: string): Promise<TickTickTask[]>
    getTask(projectId: string, taskId: string): Promise<TickTickTask>
    createTask(payload: Record<string, unknown>): Promise<TickTickTask>
    updateTask(payload: Record<string, unknown> & { id: string }): Promise<TickTickTask>
    completeTask(projectId: string, taskId: string): Promise<void>
    deleteTask(projectId: string, taskId: string): Promise<void>
  }

  /** API error carrying HTTP status + auth-required flag. */
  class TickTickApiError extends Error {
    status: number
    authRequired: boolean
  }

  /** The Inbox (收集箱) as a fixed-id project (the open API omits it). */
  const INBOX_PROJECT: Readonly<{ id: string; name: string }>
}
