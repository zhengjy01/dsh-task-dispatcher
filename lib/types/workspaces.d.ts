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
/** One DSH workspace (id + display title + directory path). */
export interface WorkspaceInfo {
    id: string;
    title: string;
    path: string;
}
/** Default machine-wide workspace ledger location. */
export declare const DEFAULT_WORKSPACE_STORE: string;
/** Test override for the workspace ledger location. */
export declare function workspaceStorePath(): string;
/**
 * List every known DSH workspace, sorted by title. Never throws: a missing,
 * unreadable, or unexpectedly-shaped ledger simply yields [].
 */
export declare function listWorkspaces(): Promise<WorkspaceInfo[]>;
/**
 * Resolve a workspace id to its directory path. Returns undefined when the id
 * is empty or the workspace no longer exists (caller falls back to the
 * default cwd).
 */
export declare function resolveWorkspacePath(workspaceId: string): Promise<string | undefined>;
/** Resolve a workspace id to its display title (falls back to the id). */
export declare function resolveWorkspaceTitle(workspaceId: string): Promise<string | undefined>;
