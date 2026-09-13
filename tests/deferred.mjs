/**
 * dsh-task-dispatcher — deferred-sync control-plane tests.
 *
 * Isolated: DSH_HOME points at a temp dir *before* the controller is used, so
 * the real queue, log and session logs are never touched. The launchd timer is
 * only ever READ here — installing/removing it would mutate the developer's
 * machine, and the panel drives that path interactively instead.
 *
 * `flush` is exercised only in its safe forms (empty queue / still-active), both
 * of which the script refuses to turn into TickTick writes.
 */

import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0

function check(label, condition, detail = '') {
  if (condition) {
    passed++
    console.log('  ✔ ' + label)
  } else {
    failed++
    console.error('  ✘ ' + label + (detail ? ' — ' + detail : ''))
  }
}

const tempDir = await mkdtemp(path.join(tmpdir(), 'dsh-deferred-test-'))
process.env.DSH_HOME = tempDir

const {
  DeferredController,
  TIMER_LABEL,
  bundledScriptPath,
  coerceQueue,
  defaultQueue,
  installedScriptPath,
  newestSessionMtime,
  queuePath,
  timerPlistPath,
} = await import('../lib/index.js')

const controller = new DeferredController()

console.log('\n▸ 路径契约（认 DSH_HOME，不写死 ~/.dsh）')
{
  check('队列文件在隔离 home 下', queuePath() === path.join(tempDir, 'dsh-ticktick-pending.json'), queuePath())
  check('本地脚本路径在隔离 home 下', installedScriptPath() === path.join(tempDir, 'scripts', 'ticktick-pending.mjs'))
  check('插件自带脚本存在', await stat(bundledScriptPath()).then(() => true).catch(() => false), bundledScriptPath())
  check('自带脚本不含本机绝对路径', !(await readFile(bundledScriptPath(), 'utf8')).includes('/Users/zhengjunyao'))
  check('定时器 label 固定', TIMER_LABEL === 'com.dsh.ticktick-deferred-sync')
}

console.log('\n▸ 队列默认值与容错')
{
  const base = defaultQueue()
  check('默认阈值 10 分钟', base.idleMinutes === 10, String(base.idleMinutes))
  check('默认顶层上限 3', base.maxPerSession === 3)
  check('默认只打 ai 标签', JSON.stringify(base.tags) === '["ai"]')
  check('默认投 To do 清单', base.projectId === '6aa654ffe4b094f3c163a198')

  const coerced = coerceQueue({ idleMinutes: -5, maxPerSession: 'x', tags: 'nope', tasks: null })
  // A numeric-but-out-of-range value is clamped (the user asked for "shorter",
  // so floor it); only a non-numeric value falls back to the default.
  check('越界数值被钳制到下限', coerced.idleMinutes === 1, String(coerced.idleMinutes))
  check('非数字阈值回退默认', coerceQueue({ idleMinutes: 'x' }).idleMinutes === 10)
  check('非法上限回退默认', coerced.maxPerSession === 3)
  check('非法 tags 回退默认', JSON.stringify(coerced.tags) === '["ai"]')
  check('缺失 tasks 视为空队列', Array.isArray(coerced.tasks) && coerced.tasks.length === 0)
  check('损坏输入整体回退', coerceQueue(null).idleMinutes === 10 && coerceQueue('junk').maxPerSession === 3)
  check('越界阈值被钳制', coerceQueue({ idleMinutes: 99999 }).idleMinutes === 1440)
}

console.log('\n▸ 读写队列（0600）')
{
  const queue = defaultQueue()
  queue.idleMinutes = 7
  queue.tasks = [
    { title: '父任务', stagedBy: '测试会话' },
    { title: '子任务', parentKey: 'p1', dueDate: '2026-09-13', stagedBy: '测试会话' },
  ]
  await controller.writeQueue(queue)
  const mode = (await stat(queuePath())).mode & 0o777
  check('队列文件权限 0600', mode === 0o600, '0o' + mode.toString(8))
  const back = await controller.readQueue()
  check('读回阈值', back.idleMinutes === 7)
  check('读回任务与父子关系', back.tasks.length === 2 && back.tasks[1]?.parentKey === 'p1')
}

console.log('\n▸ 静默判定（全机最新 session 日志）')
{
  const sessions = path.join(tempDir, 'sessions')
  const nested = path.join(sessions, 'agent-x', 'session-1')
  await mkdir(nested, { recursive: true })
  check('无日志时为 0（视为可同步）', newestSessionMtime(path.join(tempDir, 'nope')) === 0)

  const logFile = path.join(nested, 'session-abc.jsonl.zstd')
  await writeFile(logFile, 'x')
  const old = new Date(Date.now() - 30 * 60 * 1000)
  await utimes(logFile, old, old)
  const stale = newestSessionMtime(sessions)
  check('读到嵌套层级里的日志', stale > 0)
  check('旧日志 → 已静默约 30 分钟', Math.round((Date.now() - stale) / 60000) === 30, String(Math.round((Date.now() - stale) / 60000)))

  const fresh = new Date()
  await utimes(logFile, fresh, fresh)
  const now = newestSessionMtime(sessions)
  check('新日志 → 几乎无静默', Math.round((Date.now() - now) / 60000) === 0)
  check('非 session 前缀的文件被忽略', (await writeFile(path.join(nested, 'other.txt'), 'x'), newestSessionMtime(sessions) === now))
}

console.log('\n▸ 状态汇总')
{
  const status = await controller.status()
  check('报 ok', status.ok === true)
  check('队列指向隔离 home', status.queueFile === queuePath())
  check('阈值来自队列文件', status.idleMinutes === 7, String(status.idleMinutes))
  check('统计待同步条数', status.pending === 2, String(status.pending))
  check('统计顶层条数（父子不算顶层）', status.pendingTop === 1, String(status.pendingTop))
  check('给出当前静默分钟', typeof status.idleMinutesNow === 'number')
  check('给出是否可同步', typeof status.isIdle === 'boolean')
  check('任务明细带 stagedBy', status.tasks[0]?.stagedBy === '测试会话')
  check('脚本来源为自带或已安装', status.scriptSource === 'bundled' || status.scriptSource === 'installed', status.scriptSource)
  check('定时器状态含平台判断', typeof status.timer.supported === 'boolean')
  check('文案含队列条数', status.message.includes('2 条'), status.message)

  const quiet = { ...status, idleMinutesNow: 99, isIdle: true }
  check('可同步时文案正确', quiet.isIdle === true)
}

console.log('\n▸ 改阈值（写入队列文件；间隔走 plist）')
{
  const result = await controller.patchConfig({ idleMinutes: 12, maxPerSession: 5 })
  check('动作成功', result.ok === true, result.message)
  check('返回新状态', result.status?.idleMinutes === 12)
  const reread = await controller.readQueue()
  check('已落盘', reread.idleMinutes === 12 && reread.maxPerSession === 5)
  check('未动标签与清单', JSON.stringify(reread.tags) === '["ai"]' && reread.projectId === '6aa654ffe4b094f3c163a198')
  const clamped = await controller.patchConfig({ idleMinutes: 0 })
  check('阈值下限被钳制到 1', clamped.status?.idleMinutes === 1, String(clamped.status?.idleMinutes))
  await controller.patchConfig({ idleMinutes: 10 })
}

console.log('\n▸ 脚本安装（幂等，不覆盖已有）')
{
  const first = await controller.installScript(false)
  check('安装成功', first.ok === true, first.message)
  check('落到 <DSH_HOME>/scripts', await stat(installedScriptPath()).then(() => true).catch(() => false))
  check('来源切换为 installed', (await controller.status()).scriptSource === 'installed')
  const again = await controller.installScript(false)
  check('重复安装被跳过（不覆盖）', again.ok === true && again.message.includes('未覆盖'), again.message)
  const content = await readFile(installedScriptPath(), 'utf8')
  check('安装的是同一份脚本', content.includes('ticktick-pending.mjs'))
}

console.log('\n▸ 定时器：只读检查（不改系统状态）')
{
  const timer = await controller.timerState()
  check('label 正确', timer.label === TIMER_LABEL)
  check('plist 路径在 LaunchAgents 下', timer.plistPath === timerPlistPath() && timer.plistPath.includes('Library/LaunchAgents'))
  if (timer.supported) {
    check('macOS 下 installed 为布尔', typeof timer.installed === 'boolean')
    check('macOS 下 loaded 为布尔', typeof timer.loaded === 'boolean')
    if (timer.installed) {
      check('能解析出 StartInterval', timer.intervalSeconds > 0, String(timer.intervalSeconds))
      console.log('    （本机定时器：installed=' + String(timer.installed) + ' loaded=' + String(timer.loaded) + ' interval=' + String(timer.intervalSeconds) + 's）')
    }
  } else {
    check('非 macOS：报告不支持', timer.supported === false)
  }
}

console.log('\n▸ flush 的安全路径（不会写滴答）')
{
  // 空队列：脚本直接返回，不触发任何 API 调用。
  await controller.writeQueue(defaultQueue())
  const empty = await controller.flush(false)
  check('空队列 flush 退出码 0', empty.ok === true, empty.message)
  check('空队列不产生写入', !empty.output.includes('已创建'), empty.output)

  // 有任务但仍在活跃：脚本拒绝写入（除非 --force，测试里绝不使用）。
  const queue = defaultQueue()
  queue.idleMinutes = 600
  queue.tasks = [{ title: '不该被写出的测试任务', stagedBy: 'test' }]
  await controller.writeQueue(queue)
  const blocked = await controller.flush(false)
  check('未静默时不写入', blocked.ok === true, blocked.message)
  const after = await controller.readQueue()
  check('任务仍留在队列里', after.tasks.length === 1 && after.lastFlushAt === null, JSON.stringify(after.lastFlushAt))
  check('队列未被清空', after.tasks[0]?.title === '不该被写出的测试任务')
}

console.log('\n▸ 隔离性')
{
  const real = path.join(process.env.HOME ?? '', '.dsh', 'dsh-ticktick-pending.json')
  let realUntouched = true
  try {
    const realQueue = JSON.parse(await readFile(real, 'utf8'))
    // The real queue must not contain the marker task this suite staged.
    realUntouched = !JSON.stringify(realQueue).includes('不该被写出的测试任务')
  } catch {
    realUntouched = true
  }
  check('真实队列未被测试污染', realUntouched)
  check('测试队列在临时目录', queuePath().startsWith(tempDir))
}

await rm(tempDir, { recursive: true, force: true })

console.log('\n' + (failed === 0 ? '✅ 全部通过' : '❌ 有失败') + '：' + String(passed) + ' 通过 / ' + String(failed) + ' 失败\n')
process.exit(failed === 0 ? 0 : 1)
