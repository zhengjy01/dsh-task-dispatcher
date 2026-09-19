/**
 * dsh-task-dispatcher — 「省钱模式」边界测试。
 *
 * 覆盖：
 * - 官方口径（北京时间周一至周五 09:00–12:00、14:00–18:00 高峰）的逐点判定：
 *   工作日 12:00–14:00 / 18:00–次日 09:00 / 周五 18:00 之后到周一 09:00 / 周末全天 可执行；
 *   工作日 09:00–12:00 / 14:00–18:00 不执行。
 * - legacy-utc 口径可切换（每日 UTC 16:30–00:30 空闲）。
 * - 尾部余量：距下个高峰不足余量时排到下个空闲段。
 * - 排队持久化（宿主重启不丢）、到点 flush、skip 策略、关闭省钱模式行为不变。
 *
 * 纯逻辑 + 假 TickTickApi / 假 spawn，不触网、不起真实 worker。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(tmpdir(), 'dsh-dispatcher-cheap-'))
process.env.DSH_TASK_DISPATCHER_CONFIG = path.join(root, 'config.json')

const {
  DispatcherStore,
  OFFICIAL_2026_WINDOWS,
  LEGACY_UTC_WINDOWS,
  evaluateCheapMode,
  formatPeakWindowsText,
  isPeak,
  nextCheapStart,
  nextPeakStart,
  parsePeakWindowsText,
  runAutoExecuteGated,
  flushCheapQueueIfDue,
} = await import('../lib/index.js')

let failures = 0
function check(label, cond, detail) {
  if (cond) {
    console.log('  ✔ ' + label)
  } else {
    failures++
    console.error('  ✘ ' + label + (detail !== undefined ? ' → ' + String(detail) : ''))
  }
}

/** Build an instant from a Beijing wall-clock date/time (UTC+8, no DST). */
function beijing(dateStr, hour, minute) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, hour - 8, minute))
}

const CN = 'Asia/Shanghai'
const gate = (overrides = {}) => ({
  cheapMode: true,
  cheapPreset: 'official-2026',
  cheapTimezone: CN,
  cheapStrategy: 'wait',
  cheapMarginMinutes: 0,
  peakWindows: OFFICIAL_2026_WINDOWS,
  workerTimeoutMinutes: 30,
  ...overrides,
})

console.log('run 1: 官方口径逐点判定（2026-09-14 周一 ~ 2026-09-21 周一）')
{
  const cases = [
    // [标签, 日期, 时, 分, 期望高峰, 期望可执行]
    ['周一 09:00 高峰起', '2026-09-14', 9, 0, true, false],
    ['周一 11:59 高峰中', '2026-09-14', 11, 59, true, false],
    ['周一 12:00 空闲起', '2026-09-14', 12, 0, false, true],
    ['周一 13:59 空闲尾', '2026-09-14', 13, 59, false, true],
    ['周一 14:00 高峰起', '2026-09-14', 14, 0, true, false],
    ['周一 17:59 高峰中', '2026-09-14', 17, 59, true, false],
    ['周一 18:00 空闲起', '2026-09-14', 18, 0, false, true],
    ['周一 23:59 夜间空闲', '2026-09-14', 23, 59, false, true],
    ['周二 00:00 凌晨空闲', '2026-09-15', 0, 0, false, true],
    ['周二 08:59 上班前空闲', '2026-09-15', 8, 59, false, true],
    ['周五 09:00 高峰', '2026-09-18', 9, 0, true, false],
    ['周五 12:00 空闲', '2026-09-18', 12, 0, false, true],
    ['周五 14:00 高峰', '2026-09-18', 14, 0, true, false],
    ['周五 18:00 空闲（周末开始）', '2026-09-18', 18, 0, false, true],
    ['周五 23:00 空闲', '2026-09-18', 23, 0, false, true],
    ['周六 10:00 全天空闲', '2026-09-19', 10, 0, false, true],
    ['周六 23:00 全天空闲', '2026-09-19', 23, 0, false, true],
    ['周日 15:00 全天空闲', '2026-09-20', 15, 0, false, true],
    ['周一 08:59 周末尾空闲', '2026-09-21', 8, 59, false, true],
    ['周一 09:00 高峰（周末结束）', '2026-09-21', 9, 0, true, false],
  ]
  for (const [label, date, hour, minute, wantPeak, wantRun] of cases) {
    const now = beijing(date, hour, minute)
    const decision = evaluateCheapMode(gate(), now)
    const peak = isPeak(now, OFFICIAL_2026_WINDOWS, CN)
    check(label, peak === wantPeak && decision.canRunNow === wantRun,
      JSON.stringify({ peak, wantPeak, canRunNow: decision.canRunNow, wantRun, reason: decision.reason }))
  }
}

console.log('\nrun 2: nextCheapStart / nextPeakStart 边界')
{
  const fmt = (d) => (d === null ? null : d.toISOString())
  // 周五 10:00 高峰 → 下个空闲 12:00（04:00Z）
  check('高峰中：下个空闲 = 当天 12:00',
    fmt(nextCheapStart(beijing('2026-09-18', 10, 0), OFFICIAL_2026_WINDOWS, CN)) === '2026-09-18T04:00:00.000Z',
    fmt(nextCheapStart(beijing('2026-09-18', 10, 0), OFFICIAL_2026_WINDOWS, CN)))
  // 周五 14:00 高峰 → 下个空闲 18:00（10:00Z）
  check('下午高峰：下个空闲 = 当天 18:00',
    fmt(nextCheapStart(beijing('2026-09-18', 14, 0), OFFICIAL_2026_WINDOWS, CN)) === '2026-09-18T10:00:00.000Z',
    fmt(nextCheapStart(beijing('2026-09-18', 14, 0), OFFICIAL_2026_WINDOWS, CN)))
  // 周五 17:30 高峰 → 下个空闲 18:00
  check('周五 17:30：下个空闲 = 18:00',
    fmt(nextCheapStart(beijing('2026-09-18', 17, 30), OFFICIAL_2026_WINDOWS, CN)) === '2026-09-18T10:00:00.000Z',
    fmt(nextCheapStart(beijing('2026-09-18', 17, 30), OFFICIAL_2026_WINDOWS, CN)))
  // 周五 18:00 空闲 → 下个高峰 = 周一 09:00（2026-09-21T01:00Z）
  check('周五 18:00 后下一个高峰 = 周一 09:00',
    fmt(nextPeakStart(beijing('2026-09-18', 18, 0), OFFICIAL_2026_WINDOWS, CN)) === '2026-09-21T01:00:00.000Z',
    fmt(nextPeakStart(beijing('2026-09-18', 18, 0), OFFICIAL_2026_WINDOWS, CN)))
  // 周五 18:00 → 周一 09:00 整段都空闲
  const fridayEvening = evaluateCheapMode(gate(), beijing('2026-09-18', 18, 0))
  const sat = evaluateCheapMode(gate(), beijing('2026-09-19', 10, 0))
  const sun = evaluateCheapMode(gate(), beijing('2026-09-20', 22, 0))
  check('周五晚~周日全天都判为空闲可执行',
    fridayEvening.canRunNow && sat.canRunNow && sun.canRunNow,
    JSON.stringify([fridayEvening.canRunNow, sat.canRunNow, sun.canRunNow]))
}

console.log('\nrun 3: 尾部余量（距高峰不足则排到下个空闲段）')
{
  const withMargin = gate({ cheapMarginMinutes: 30 })
  const near = evaluateCheapMode(withMargin, beijing('2026-09-18', 13, 45))
  check('13:45 距 14:00 高峰仅 15 分钟 < 余量 30 → 不执行', near.canRunNow === false && near.waitReason === 'margin', JSON.stringify(near))
  check('且排到 18:00（下个空闲段）', near.nextCheapStartAt === '2026-09-18T10:00:00.000Z', near.nextCheapStartAt)
  const early = evaluateCheapMode(withMargin, beijing('2026-09-18', 13, 0))
  check('13:00 距高峰 60 分钟 ≥ 余量 30 → 执行', early.canRunNow === true, JSON.stringify(early))
  const zero = evaluateCheapMode(gate({ cheapMarginMinutes: 0 }), beijing('2026-09-18', 13, 59))
  check('余量 0（默认，关闭尾部保护）→ 空闲即执行', zero.canRunNow === true && zero.marginMinutes === 0, JSON.stringify(zero))
  const one = evaluateCheapMode(gate({ cheapMarginMinutes: 1 }), beijing('2026-09-18', 13, 59))
  check('余量 1：整点前一分钟仍可执行（1 < 1 为假）', one.canRunNow === true, JSON.stringify(one))
}

console.log('\nrun 3b: 默认配置的尾部余量为 0（官方空闲窗口整段可执行）')
{
  const store = new DispatcherStore()
  await store.patch({ cheapMode: true, cheapPreset: 'official-2026' })
  const cfg = await store.load()
  check('默认 cheapMarginMinutes = 0', cfg.cheapMarginMinutes === 0, cfg.cheapMarginMinutes)
  const tail = evaluateCheapMode(cfg, beijing('2026-09-18', 13, 59))
  check('默认配置 13:59 可执行', tail.canRunNow === true, JSON.stringify(tail))
}

console.log('\nrun 4: preset 可切换（legacy-utc：北京 00:30–08:30 空闲）')
{
  const legacy = gate({ cheapPreset: 'legacy-utc', peakWindows: LEGACY_UTC_WINDOWS })
  const early = evaluateCheapMode(legacy, beijing('2026-09-18', 4, 0))
  const morning = evaluateCheapMode(legacy, beijing('2026-09-18', 10, 0))
  check('legacy：北京 04:00 空闲可执行', early.canRunNow === true && early.inPeak === false, JSON.stringify(early))
  check('legacy：北京 10:00 高峰不执行', morning.canRunNow === false && morning.inPeak === true, JSON.stringify(morning))
  check('legacy：10:00 下个空闲 = 次日 00:30',
    nextCheapStart(beijing('2026-09-18', 10, 0), LEGACY_UTC_WINDOWS, CN)?.toISOString() === '2026-09-18T16:30:00.000Z',
    nextCheapStart(beijing('2026-09-18', 10, 0), LEGACY_UTC_WINDOWS, CN)?.toISOString())
}

console.log('\nrun 5: 自定义时段表解析 / 序列化')
{
  const parsed = parsePeakWindowsText('1,2,3,4,5 09:00-12:00\n1,2,3,4,5 14:00-18:00\n')
  check('文本解析为两条窗口', Array.isArray(parsed) && parsed.length === 2 && parsed[0].start === '09:00', JSON.stringify(parsed))
  check('空文本 = 一直空闲', JSON.stringify(parsePeakWindowsText('')) === '[]' && JSON.stringify(parsePeakWindowsText('   \n')) === '[]')
  check('畸形行返回 null', parsePeakWindowsText('nonsense') === null)
  check('可回写为编辑文本', formatPeakWindowsText(parsed) === '1,2,3,4,5 09:00-12:00\n1,2,3,4,5 14:00-18:00', formatPeakWindowsText(parsed))
  const custom = evaluateCheapMode(gate({ cheapPreset: 'custom', peakWindows: parsed }), beijing('2026-09-18', 13, 0))
  check('自定义窗口生效（13:00 空闲可执行）', custom.canRunNow === true, JSON.stringify(custom))
}

console.log('\nrun 6: 关闭省钱模式 = 旧行为（高峰也照跑）')
{
  const off = evaluateCheapMode(gate({ cheapMode: false }), beijing('2026-09-18', 10, 0))
  check('关闭时恒 canRunNow=true', off.cheapMode === false && off.canRunNow === true, JSON.stringify(off))
}

console.log('\nrun 7: 排队 / 持久化 / 到点 flush / skip / 关闭')
{
  const store = new DispatcherStore()
  await store.patch({
    autoExecute: true, retryCooldownMinutes: 1,
    notifyFlomo: false, notifyMac: false, notifyWechat: false, notifyResult: false,
    cheapMode: true, cheapPreset: 'official-2026', cheapStrategy: 'wait', cheapMarginMinutes: 0,
  })
  const tasks = [
    { id: 'cheap-1', projectId: 'p', title: '排队任务一', content: '', dueDate: '', startDate: '', actionable: true, priority: 0, tags: [] },
    { id: 'cheap-2', projectId: 'p', title: '排队任务二', content: '', dueDate: '', startDate: '', actionable: true, priority: 0, tags: [] },
  ]
  const api = { completeTask: async () => {} }
  const spawn = async () => ({ ok: true, exitCode: 0, output: '', stdout: 'done', stderr: '' })
  const captured = []
  const notify = async (text) => { captured.push(text) }

  // 7a: 高峰（周五 10:00）→ 排队 + 落盘 + 通知文案
  const queued = await runAutoExecuteGated(store, api, tasks, { notifyResult: true, now: beijing('2026-09-18', 10, 0), spawn, notify })
  check('高峰：mode=queued', queued.mode === 'queued' && queued.executed === 0, JSON.stringify(queued.mode))
  check('排队通知文案区分「省钱模式」', captured[0]?.includes('省钱模式：已排入') && captured[0].includes('空闲时段执行'), captured[0])
  check('nextCheapStartAt 落到下个空闲（12:00）', queued.nextCheapStartAt.startsWith('2026-09-18T04:00:00'), queued.nextCheapStartAt)

  // 7b: 模拟宿主重启：新 store 实例从磁盘读
  const reloaded = new DispatcherStore()
  const persisted = await reloaded.load()
  check('重启后排队状态不丢', persisted.cheapQueue.length === 2 && persisted.cheapQueue[0].id === 'cheap-1', JSON.stringify(persisted.cheapQueue.map((t) => t.id)))
  check('重启后 nextCheapStartAt 不丢', persisted.nextCheapStartAt.startsWith('2026-09-18T04:00:00'), persisted.nextCheapStartAt)

  // 7c: 仍处高峰时 flush 不动
  const notYet = await flushCheapQueueIfDue(store, api, { now: beijing('2026-09-18', 11, 0), spawn, notify })
  check('高峰中 flush 返回 null（继续等）', notYet === null, JSON.stringify(notYet))

  // 7d: 到点（12:00 之后）flush 执行
  const ran = []
  const flush = await flushCheapQueueIfDue(store, { completeTask: async (p, id) => { ran.push(id) } }, { now: beijing('2026-09-18', 12, 30), spawn, notify, notifyResult: false })
  check('空闲开始后 flush 执行排队任务', flush !== null && flush.mode === 'executed' && flush.executed === 2, JSON.stringify(flush?.mode))
  check('执行的是排队任务', JSON.stringify(ran.sort()) === JSON.stringify(['cheap-1', 'cheap-2']), JSON.stringify(ran))
  check('flush 后队列清空', (await store.view()).cheapQueueCount === 0 && (await store.view()).nextCheapStartAt === '', JSON.stringify(await store.view()))

  // 7e: skip 策略：高峰不改队列、直接跳过
  await store.patch({ cheapStrategy: 'skip' })
  captured.length = 0
  const skipTasks = [{ id: 'cheap-3', projectId: 'p', title: '跳过任务', content: '', dueDate: '', startDate: '', actionable: true, priority: 0, tags: [] }]
  const skipped = await runAutoExecuteGated(store, api, skipTasks, { notifyResult: true, now: beijing('2026-09-18', 10, 0), spawn, notify })
  check('skip：高峰 mode=skipped', skipped.mode === 'skipped' && skipped.skipped === 1, JSON.stringify(skipped.mode))
  check('skip：通知文案区分', captured[0]?.includes('省钱模式：当前为高峰时段，本轮跳过'), captured[0])
  check('skip：不产生排队', (await store.view()).cheapQueueCount === 0)

  // 7f: ignoreCheapMode 绕过（高峰也立刻执行）
  await store.patch({ cheapStrategy: 'wait' })
  const bypassTasks = [{ id: 'cheap-4', projectId: 'p', title: '绕过任务', content: '', dueDate: '', startDate: '', actionable: true, priority: 0, tags: [] }]
  const bypassed = await runAutoExecuteGated(store, api, bypassTasks, { notifyResult: false, ignoreCheapMode: true, now: beijing('2026-09-18', 10, 0), spawn, notify })
  check('ignoreCheapMode：高峰也执行', bypassed.mode === 'executed' && bypassed.executed === 1, JSON.stringify(bypassed.mode))

  // 7g: 关闭省钱模式后，遗留队列会被排空、高峰照跑
  await store.patch({ cheapMode: true })
  await store.enqueueCheap([{ id: 'cheap-5', projectId: 'p', title: '遗留任务', content: '', dueDate: '', startDate: '', actionable: true, priority: 0, tags: [] }], '2026-09-18T10:00:00.000Z')
  await store.patch({ cheapMode: false })
  const offTasks = [{ id: 'cheap-6', projectId: 'p', title: '关闭后任务', content: '', dueDate: '', startDate: '', actionable: true, priority: 0, tags: [] }]
  const ranOff = []
  const offRun = await runAutoExecuteGated(store, { completeTask: async (p, id) => { ranOff.push(id) } }, offTasks, { notifyResult: false, now: beijing('2026-09-18', 10, 0), spawn, notify })
  check('关闭省钱模式：高峰照跑', offRun.mode === 'executed' && offRun.executed === 2, JSON.stringify(offRun.mode))
  check('关闭后遗留队列被排空执行', ranOff.includes('cheap-5') && ranOff.includes('cheap-6'), JSON.stringify(ranOff))
  check('队列已清空', (await store.view()).cheapQueueCount === 0)
}

await rm(root, { recursive: true, force: true })
if (failures > 0) {
  console.error('\n' + failures + ' check(s) failed')
  process.exit(1)
}
console.log('\nAll cheap-mode checks passed.')
