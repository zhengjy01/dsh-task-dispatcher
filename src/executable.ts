/**
 * dsh-task-dispatcher — executable resolution.
 *
 * The auto-execute worker shells out to the `dsh` CLI. DSH itself can be
 * started by launchd (the shipped `com.dsh.web` service), whose PATH is only
 * `/usr/bin:/bin`; a bare `dsh` then fails with ENOENT even though the CLI is
 * installed. Resolve the binary against PATH plus the well-known install
 * directories so a worker can always be spawned.
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Directories that commonly hold a globally installed CLI on this machine. */
function extraBinDirs(): string[] {
  const home = homedir()
  const dirs = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/usr/bin',
    '/bin',
  ]
  // Node version managers keep each release under its own bin directory.
  for (const manager of ['.nvm/versions/node', '.local/share/fnm/node-versions', '.asdf/installs/nodejs']) {
    const root = path.join(home, manager)
    try {
      for (const entry of readdirSync(root)) dirs.push(path.join(root, entry, 'bin'))
    } catch {
      // Not installed with this manager — nothing to add.
    }
  }
  return dirs
}

/**
 * Resolve an executable name to an absolute path.
 * @param name - bare executable name (without a Windows extension).
 * @returns the first existing absolute path, or the bare name so that the OS
 *   still performs its own PATH lookup (and reports a meaningful error).
 */
export function resolveExecutable(name: string): string {
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  const seen = new Set<string>()
  for (const dir of [...(process.env.PATH ?? '').split(path.delimiter), ...extraBinDirs()]) {
    if (dir === '' || seen.has(dir)) continue
    seen.add(dir)
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix)
      if (existsSync(candidate)) return candidate
    }
  }
  return name
}
