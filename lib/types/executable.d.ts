/**
 * dsh-task-dispatcher — executable resolution.
 *
 * The auto-execute worker shells out to the `dsh` CLI. DSH itself can be
 * started by launchd (the shipped `com.dsh.web` service), whose PATH is only
 * `/usr/bin:/bin`; a bare `dsh` then fails with ENOENT even though the CLI is
 * installed. Resolve the binary against PATH plus the well-known install
 * directories so a worker can always be spawned.
 */
/**
 * Resolve an executable name to an absolute path.
 * @param name - bare executable name (without a Windows extension).
 * @returns the first existing absolute path, or the bare name so that the OS
 *   still performs its own PATH lookup (and reports a meaningful error).
 */
export declare function resolveExecutable(name: string): string;
