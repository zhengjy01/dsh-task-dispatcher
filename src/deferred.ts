/**
 * dsh-task-dispatcher — deferred TickTick sync control plane.
 *
 * The queue is written to TickTick by a standalone Node script driven by a
 * launchd timer, and that split is deliberate: the flush must be able to happen
 * while **DSH is closed** (a session that ended at 21:00 should still land in
 * TickTick at 21:12), which an in-process timer can never guarantee. This module
 * is therefore the control plane, not the engine:
 *
 *   - it reads the *same* queue file (`<DSH_HOME>/dsh-ticktick-pending.json`),
 *   - it computes the *same* idle verdict the script computes (newest session
 *     log mtime across the whole harness home, not just one session),
 *   - and it lets the settings panel change the thresholds, flush by hand, and
 *     install/reload/remove the launchd timer.
 *
 * The queue file is the only contract between the two halves, so no behaviour
 * is duplicated: the write path (credentials, dedupe, parentId, dueDate
 * rollover) lives in the script and stays there.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { dshHome } from './home.ts'

/** launchd label shared with the standalone script's timer. */
export const TIMER_LABEL = 'com.dsh.ticktick-deferred-sync'

/** Queue file (also read/written by the standalone script). */
export function queuePath(): string {
  return path.join(dshHome(), 'dsh-ticktick-pending.json')
}

/** Where the script is installed for the timer to run. */
export function installedScriptPath(): string {
  return path.join(dshHome(), 'scripts', 'ticktick-pending.mjs')
}

/** The copy shipped inside this plugin (works on a machine that never had it). */
export function bundledScriptPath(): string {
  // lib/index.js (or a shared chunk in lib/) → the package root.
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(path.dirname(here), 'scripts', 'ticktick-pending.mjs')
}

/** launchd plist path (macOS only). */
export function timerPlistPath(): string {
  return path.join(homedir(), 'Library', 'LaunchAgents', TIMER_LABEL + '.plist')
}

/** Queue shape (defaults mirror the script's DEFAULT_CONFIG). */
export interface DeferredQueue {
  version: number
  idleMinutes: number
  maxPerSession: number
  projectId: string
  tags: string[]
  tasks: { title?: string; parentKey?: string; dueDate?: string; stagedBy?: string }[]
  lastFlushAt: string | null
  lastFlushResult: string | null
}

/** Default queue contents, used when the file does not exist yet. */
export function defaultQueue(): DeferredQueue {
  return {
    version: 1,
    idleMinutes: 10,
    maxPerSession: 3,
    projectId: '6aa654ffe4b094f3c163a198',
    tags: ['ai'],
    tasks: [],
    lastFlushAt: null,
    lastFlushResult: null,
  }
}

/** Timer state read off the plist + launchctl. */
export interface TimerState {
  /** launchd only exists on macOS; other platforms degrade to manual flush. */
  supported: boolean
  label: string
  plistPath: string
  installed: boolean
  loaded: boolean
  intervalSeconds: number
  /** launchctl's own rendering errors, surfaced for the panel. */
  detail: string
}

/** Full status payload for the panel. */
export interface DeferredStatus {
  ok: boolean
  message: string
  queueFile: string
  scriptPath: string
  /** 'installed' = <home>/scripts, 'bundled' = this package, 'missing' = neither. */
  scriptSource: 'installed' | 'bundled' | 'missing'
  bundledScriptPath: string
  idleMinutes: number
  maxPerSession: number
  projectId: string
  tags: string[]
  pending: number
  pendingTop: number
  tasks: { title: string; parentKey: string; dueDate: string; stagedBy: string }[]
  /** Whole-harness silence, in minutes. */
  idleMinutesNow: number
  newestSessionAt: string
  isIdle: boolean
  lastFlushAt: string
  lastFlushResult: string
  timer: TimerState
}

/** Result of one action (flush / install / timer). */
export interface DeferredAction {
  ok: boolean
  message: string
  /** Raw child-process output, shown verbatim so a failure is diagnosable. */
  output: string
  status?: DeferredStatus
}

/** Newest session-log mtime under `<home>/sessions` (0 when none). */
export function newestSessionMtime(sessionsDir = path.join(dshHome(), 'sessions')): number {
  let newest = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (/^session.*\.jsonl\.zstd$/.test(entry.name)) {
        try {
          const mtime = statSync(full).mtimeMs
          if (mtime > newest) newest = mtime
        } catch {
          // A log that disappeared mid-walk is not interesting.
        }
      }
    }
  }
  walk(sessionsDir, 0)
  return newest
}

/** Run one child process, never throwing. */
function run(
  command: string,
  args: readonly string[],
  timeoutMs = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** Coerce the queue file, tolerating a hand-edited or partial file. */
export function coerceQueue(raw: unknown): DeferredQueue {
  const base = defaultQueue()
  if (typeof raw !== 'object' || raw === null) return base
  const obj = raw as Record<string, unknown>
  const num = (value: unknown, fallback: number, min: number, max: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback
  return {
    version: typeof obj.version === 'number' ? obj.version : base.version,
    idleMinutes: num(obj.idleMinutes, base.idleMinutes, 1, 1440),
    maxPerSession: num(obj.maxPerSession, base.maxPerSession, 1, 50),
    projectId: typeof obj.projectId === 'string' && obj.projectId !== '' ? obj.projectId : base.projectId,
    tags: Array.isArray(obj.tags) ? obj.tags.filter((tag): tag is string => typeof tag === 'string') : base.tags,
    tasks: Array.isArray(obj.tasks)
      ? obj.tasks.filter((task): task is Record<string, unknown> => typeof task === 'object' && task !== null)
      : [],
    lastFlushAt: typeof obj.lastFlushAt === 'string' ? obj.lastFlushAt : null,
    lastFlushResult: typeof obj.lastFlushResult === 'string' ? obj.lastFlushResult : null,
  }
}

/** The control plane. */
export class DeferredController {
  /** Read the queue (defaults when absent/corrupt). */
  async readQueue(): Promise<DeferredQueue> {
    try {
      return coerceQueue(JSON.parse(await readFile(queuePath(), 'utf8')) as unknown)
    } catch {
      return defaultQueue()
    }
  }

  /** Persist the queue with owner-only permissions. */
  async writeQueue(queue: DeferredQueue): Promise<void> {
    const file = queuePath()
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(queue, null, 2) + '\n', { mode: 0o600 })
  }

  /** Which copy of the script would run. */
  resolveScript(): { path: string; source: 'installed' | 'bundled' | 'missing' } {
    const installed = installedScriptPath()
    if (existsSync(installed)) return { path: installed, source: 'installed' }
    const bundled = bundledScriptPath()
    if (existsSync(bundled)) return { path: bundled, source: 'bundled' }
    return { path: installed, source: 'missing' }
  }

  /** Read the timer's plist + launchd state. */
  async timerState(): Promise<TimerState> {
    const supported = platform() === 'darwin'
    const plistPath = timerPlistPath()
    const installed = supported && existsSync(plistPath)
    let intervalSeconds = 0
    if (installed) {
      try {
        const text = await readFile(plistPath, 'utf8')
        const match = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(text)
        intervalSeconds = match === null ? 0 : Number(match[1])
      } catch {
        intervalSeconds = 0
      }
    }
    let loaded = false
    let detail = ''
    if (supported) {
      const printed = await run('launchctl', ['print', 'gui/' + String(process.getuid?.() ?? 0) + '/' + TIMER_LABEL], 15_000)
      loaded = printed.code === 0
      if (installed && !loaded) detail = printed.stderr.trim().split('\n')[0] ?? ''
    }
    return { supported, label: TIMER_LABEL, plistPath, installed, loaded, intervalSeconds, detail }
  }

  /** The full panel payload. */
  async status(): Promise<DeferredStatus> {
    const queue = await this.readQueue()
    const script = this.resolveScript()
    const newest = newestSessionMtime()
    const idleMs = newest === 0 ? Number.POSITIVE_INFINITY : Date.now() - newest
    const idleMinutesNow = newest === 0 ? -1 : Math.floor(idleMs / 60_000)
    const isIdle = newest === 0 || idleMs >= queue.idleMinutes * 60_000
    const timer = await this.timerState()
    const tasks = queue.tasks.map((task) => ({
      title: typeof task.title === 'string' ? task.title : '(无标题)',
      parentKey: typeof task.parentKey === 'string' ? task.parentKey : '',
      dueDate: typeof task.dueDate === 'string' ? task.dueDate : '',
      stagedBy: typeof task.stagedBy === 'string' ? task.stagedBy : '',
    }))
    const parts = [
      '待同步 ' + String(queue.tasks.length) + ' 条（顶层 ' + String(tasks.filter((task) => task.parentKey === '').length) + '）',
      '阈值 ' + String(queue.idleMinutes) + ' 分钟',
      newest === 0 ? '暂无会话日志' : '当前已静默 ' + String(idleMinutesNow) + ' 分钟',
      isIdle ? '可同步' : '仍在活跃',
      timer.supported ? (timer.loaded ? '定时器运行中（每 ' + String(timer.intervalSeconds) + ' 秒检查）' : '定时器未运行') : '非 macOS：无 launchd 定时器，只能手动写入',
    ]
    return {
      ok: true,
      message: parts.join(' · '),
      queueFile: queuePath(),
      scriptPath: script.path,
      scriptSource: script.source,
      bundledScriptPath: bundledScriptPath(),
      idleMinutes: queue.idleMinutes,
      maxPerSession: queue.maxPerSession,
      projectId: queue.projectId,
      tags: queue.tags,
      pending: queue.tasks.length,
      pendingTop: tasks.filter((task) => task.parentKey === '').length,
      tasks,
      idleMinutesNow,
      newestSessionAt: newest === 0 ? '' : new Date(newest).toISOString(),
      isIdle,
      lastFlushAt: queue.lastFlushAt ?? '',
      lastFlushResult: queue.lastFlushResult ?? '',
      timer,
    }
  }

  /**
   * Change the thresholds.
   *
   * `idleMinutes` / `maxPerSession` live in the queue file (the script reads it
   * on every run, so a change applies to the very next tick). `intervalSeconds`
   * lives in the launchd plist, so it is written and the timer reloaded — a
   * plist edit alone is not picked up by an already-loaded job.
   */
  async patchConfig(patch: {
    idleMinutes?: number
    maxPerSession?: number
    intervalSeconds?: number
  }): Promise<DeferredAction> {
    const queue = await this.readQueue()
    const notes: string[] = []
    if (patch.idleMinutes !== undefined) {
      queue.idleMinutes = Math.max(1, Math.min(1440, Math.floor(patch.idleMinutes)))
      notes.push('静默阈值 = ' + String(queue.idleMinutes) + ' 分钟')
    }
    if (patch.maxPerSession !== undefined) {
      queue.maxPerSession = Math.max(1, Math.min(50, Math.floor(patch.maxPerSession)))
      notes.push('单会话顶层上限 = ' + String(queue.maxPerSession))
    }
    await this.writeQueue(queue)
    let output = ''
    if (patch.intervalSeconds !== undefined) {
      const seconds = Math.max(30, Math.min(3600, Math.floor(patch.intervalSeconds)))
      const timer = await this.writeTimer(seconds)
      output = timer.output
      notes.push('定时器检查间隔 = ' + String(seconds) + ' 秒')
      if (!timer.ok) {
        return { ok: false, message: '阈值已保存，但定时器重载失败：' + timer.message, output, status: await this.status() }
      }
    }
    return {
      ok: true,
      message: '已更新：' + notes.join('；') + '（阈值写入队列文件，脚本下次运行即生效）',
      output,
      status: await this.status(),
    }
  }

  /** Write the plist for `intervalSeconds` and reload the timer. */
  async writeTimer(intervalSeconds: number): Promise<DeferredAction> {
    if (platform() !== 'darwin') {
      return { ok: false, message: '当前平台不是 macOS，launchd 定时器不可用；可用「立即写入」手动同步。', output: '' }
    }
    // The timer runs the installed script, so make sure it exists first.
    const install = await this.installScript(false)
    const script = this.resolveScript()
    if (script.source === 'missing') {
      return { ok: false, message: '找不到 ticktick-pending.mjs（插件自带副本也缺失）。', output: install.output }
    }
    const node = process.execPath
    const home = dshHome()
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key><string>' + TIMER_LABEL + '</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      '    <string>' + node + '</string>',
      '    <string>' + script.path + '</string>',
      '    <string>flush</string>',
      '  </array>',
      '  <key>StartInterval</key><integer>' + String(intervalSeconds) + '</integer>',
      '  <key>StandardOutPath</key><string>' + path.join(home, 'ticktick-deferred-sync.launchd.out') + '</string>',
      '  <key>StandardErrorPath</key><string>' + path.join(home, 'ticktick-deferred-sync.launchd.err') + '</string>',
      '</dict>',
      '</plist>',
      '',
    ].join('\n')
    const plistPath = timerPlistPath()
    await mkdir(path.dirname(plistPath), { recursive: true })
    await writeFile(plistPath, plist, { mode: 0o644 })
    const uid = String(process.getuid?.() ?? 0)
    // bootout of a job that is not loaded exits non-zero; that is not a failure.
    const bootout = await run('launchctl', ['bootout', 'gui/' + uid + '/' + TIMER_LABEL], 20_000)
    const bootstrap = await run('launchctl', ['bootstrap', 'gui/' + uid, plistPath], 20_000)
    const output = ['bootout: ' + String(bootout.code) + ' ' + bootout.stderr.trim(), 'bootstrap: ' + String(bootstrap.code) + ' ' + bootstrap.stderr.trim()]
      .filter((line) => line.trim() !== '')
      .join('\n')
    if (bootstrap.code !== 0) {
      return { ok: false, message: 'launchctl bootstrap 失败（详情见下方输出）。', output }
    }
    const state = await this.timerState()
    return {
      ok: state.loaded,
      message: state.loaded
        ? '定时器已安装并加载：每 ' + String(state.intervalSeconds) + ' 秒检查一次，静默满 ' + String((await this.readQueue()).idleMinutes) + ' 分钟后写入。'
        : '已写入 plist 但 launchctl 未确认加载。',
      output,
    }
  }

  /** Remove the timer (the queue file is left alone). */
  async removeTimer(): Promise<DeferredAction> {
    if (platform() !== 'darwin') {
      return { ok: false, message: '当前平台不是 macOS，无 launchd 定时器可移除。', output: '' }
    }
    const uid = String(process.getuid?.() ?? 0)
    const bootout = await run('launchctl', ['bootout', 'gui/' + uid + '/' + TIMER_LABEL], 20_000)
    let removed = false
    try {
      const { rm } = await import('node:fs/promises')
      await rm(timerPlistPath(), { force: true })
      removed = true
    } catch {
      removed = false
    }
    return {
      ok: true,
      message: removed ? '定时器已移除（队列文件保留，可用「立即写入」手动同步）。' : '定时器已卸载，但 plist 删除失败。',
      output: 'bootout: ' + String(bootout.code) + ' ' + bootout.stderr.trim(),
    }
  }

  /** Copy the bundled script into `<home>/scripts` (skipped when already there). */
  async installScript(force: boolean): Promise<DeferredAction> {
    const bundled = bundledScriptPath()
    const installed = installedScriptPath()
    if (!existsSync(bundled)) {
      return { ok: false, message: '插件自带的 ticktick-pending.mjs 不存在：' + bundled, output: '' }
    }
    if (existsSync(installed) && !force) {
      return { ok: true, message: '本地脚本已存在，未覆盖：' + installed, output: '' }
    }
    await mkdir(path.dirname(installed), { recursive: true })
    await copyFile(bundled, installed)
    return { ok: true, message: (force ? '已更新' : '已安装') + '本地脚本：' + installed, output: '' }
  }

  /** Write the queue to TickTick now (runs the script's `flush`). */
  async flush(force: boolean): Promise<DeferredAction> {
    const script = this.resolveScript()
    if (script.source === 'missing') {
      return { ok: false, message: '找不到 ticktick-pending.mjs，无法写入。', output: '' }
    }
    const args = [script.path, 'flush']
    if (force) args.push('--force')
    const result = await run(process.execPath, args)
    const output = [result.stdout.trim(), result.stderr.trim()].filter((line) => line !== '').join('\n')
    return {
      ok: result.code === 0,
      message: result.code === 0 ? '已执行写入（输出见下方；「仍在活跃，跳过」是正常结果）。' : '写入失败（退出码 ' + String(result.code) + '）。',
      output,
      status: await this.status(),
    }
  }
}
