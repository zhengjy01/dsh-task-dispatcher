/**
 * dsh-task-dispatcher — DSH workspace lookup.
 *
 * Reads the DSH host's workspace ledger (~/.dsh/storages/workspace.json,
 * the `workspace` storage unit) so the auto-execute worker can be launched
 * inside a chosen workspace directory. A headless DSH session takes its
 * workspace from process.cwd() (`meta.cwd`), and the host attaches a session
 * to a workspace when their canonical cwd/path match — so spawning the worker
 * with cwd = workspace.path makes the produced session show up under that
 * workspace in the GUI sidebar.
 *
 * The storage file is a cordis storage unit; we only ever read the
 * `tables.workspaces` table and tolerate any format drift by falling back to
 * an empty list. No secrets live here.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** One DSH workspace (id + display title + directory path). */
export interface WorkspaceInfo {
  id: string
  title: string
  path: string
}

/** Default machine-wide workspace ledger location. */
export const DEFAULT_WORKSPACE_STORE = path.join(homedir(), '.dsh', 'storages', 'workspace.json')

/** Test override for the workspace ledger location. */
export function workspaceStorePath(): string {
  const override = process.env.DSH_WORKSPACE_STORE
  return override !== undefined && override !== '' ? override : DEFAULT_WORKSPACE_STORE
}

/**
 * List every known DSH workspace, sorted by title. Never throws: a missing,
 * unreadable, or unexpectedly-shaped ledger simply yields [].
 */
export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  let raw: string
  try {
    raw = await readFile(workspaceStorePath(), 'utf8')
  } catch {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    const tables = typeof parsed === 'object' && parsed !== null
      ? (parsed as { tables?: unknown }).tables
      : undefined
    const workspaces = typeof tables === 'object' && tables !== null
      ? (tables as { workspaces?: unknown }).workspaces
      : undefined
    if (typeof workspaces !== 'object' || workspaces === null) return []
    return Object.entries(workspaces as Record<string, unknown>)
      .map(([id, record]) => {
        const entry = typeof record === 'object' && record !== null ? record as Record<string, unknown> : {}
        return {
          id,
          title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : id,
          path: typeof entry.path === 'string' ? entry.path : '',
        }
      })
      .filter((workspace) => workspace.path !== '')
      .sort((a, b) => a.title.localeCompare(b.title, 'zh'))
  } catch {
    return []
  }
}

/**
 * Resolve a workspace id to its directory path. Returns undefined when the id
 * is empty or the workspace no longer exists (caller falls back to the
 * default cwd).
 */
export async function resolveWorkspacePath(workspaceId: string): Promise<string | undefined> {
  if (workspaceId === '') return undefined
  const workspaces = await listWorkspaces()
  return workspaces.find((workspace) => workspace.id === workspaceId)?.path
}

/** Resolve a workspace id to its display title (falls back to the id). */
export async function resolveWorkspaceTitle(workspaceId: string): Promise<string | undefined> {
  if (workspaceId === '') return undefined
  const workspaces = await listWorkspaces()
  const found = workspaces.find((workspace) => workspace.id === workspaceId)
  return found !== undefined ? found.title : undefined
}
