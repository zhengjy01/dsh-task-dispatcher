/**
 * dsh-task-dispatcher smoke test — validates the dispatch core against a fake
 * TickTickApi (no network, no real credentials). Sets a temp config path via
 * DSH_TASK_DISPATCHER_CONFIG and a temp task-file path; disables flomo/mac
 * notify so no side effects fire.
 */
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'

const root = await mkdtemp(path.join(tmpdir(), 'dsh-dispatcher-'))
process.env.DSH_TASK_DISPATCHER_CONFIG = path.join(root, 'config.json')

const { DispatcherStore } = await import('../lib/index.js')
const { doDispatch } = await import('../lib/index.js')
const { localDateString } = await import('../lib/index.js')

const TASK_FILE = path.join(root, 'today-tasks.md')

/** Fake TickTickApi over the same surface doDispatch uses. */
const fakeApi = {
  async getProjects() {
    return [{ id: 'p-5ai', name: '5️⃣AI', closed: false }]
  },
  async getProjectData(projectId) {
    if (projectId !== 'p-5ai') throw new Error('unexpected project ' + projectId)
    return { tasks: TASKS }
  },
}

const today = localDateString()
// Build a set of tasks with known due dates relative to today (local date).
const TASKS = [
  { id: 't1', projectId: 'p-5ai', title: '今天到期', content: '描述第一行\n描述第二行', dueDate: today + 'T12:00:00.000Z', priority: 3, status: 0, tags: ['a'] },
  { id: 't2', projectId: 'p-5ai', title: '逾期', dueDate: '2020-01-01T00:00:00.000Z', priority: 1, status: 0 },
  { id: 't3', projectId: 'p-5ai', title: '未来', dueDate: '2099-01-01T00:00:00.000Z', priority: 0, status: 0 },
  { id: 't4', projectId: 'p-5ai', title: '无截止', content: '无截止任务的描述', dueDate: undefined, priority: 0, status: 0 },
  { id: 't5', projectId: 'p-5ai', title: '已完成', dueDate: today + 'T12:00:00.000Z', priority: 0, status: 2 },
  { id: 't6', projectId: 'p-5ai', title: '过期无截止', dueDate: '', priority: 0, status: 0 },
]

let failures = 0
function check(label, cond, detail) {
  if (cond) {
    console.log('  ✔ ' + label)
  } else {
    failures++
    console.error('  ✘ ' + label + (detail !== undefined ? ' → ' + String(detail) : ''))
  }
}

const store = new DispatcherStore()
await store.patch({
  enabled: true,
  projectName: '5️⃣AI',
  dueMode: 'today',
  includeUndated: true,
  notifyFlomo: false,
  notifyMac: false,
  taskFile: TASK_FILE,
})

console.log('run 1: dueMode=today, includeUndated=true')
let res = await doDispatch(store, fakeApi)
check('ok', res.ok === true, res.message)
check('taskCount = 4 (今天+逾期+无截止*2)', res.taskCount === 4 && res.taskCount === res.tasks.length, res.taskCount)
const titles = res.tasks.map((t) => t.title).sort()
check('selected titles', JSON.stringify(titles) === JSON.stringify(['今天到期', '无截止', '过期无截止', '逾期'].sort()), JSON.stringify(titles))
check('excludes 未来', !titles.includes('未来'))
check('excludes 已完成', !titles.includes('已完成'))
check('task file written', (await readFile(TASK_FILE, 'utf8')).includes('今日待执行任务 · ' + today))
const file1 = await readFile(TASK_FILE, 'utf8')
check('task description kept in the task file (multi-line, quoted)',
  file1.includes('- [ ] 今天到期（截止 ' + today + '）\n  > 描述第一行\n  > 描述第二行'), file1)
check('description of an undated task kept too',
  file1.includes('- [ ] 无截止（截止 无截止）\n  > 无截止任务的描述'), file1)
check('task without a description stays a single line',
  file1.includes('- [ ] 逾期（截止 2020-01-01）\n- [ ] '), file1)
check('no notify (both disabled)', res.notifies.length === 0, res.notifies.length)
check('recorded last dispatch', (await store.view()).lastTaskCount === 4)

console.log('run 2: dueMode=all')
await store.patch({ dueMode: 'all' })
res = await doDispatch(store, fakeApi)
check('taskCount = 5 (all incomplete)', res.taskCount === 5, res.taskCount)

console.log('run 3: dueMode=today, includeUndated=false')
await store.patch({ dueMode: 'today', includeUndated: false })
res = await doDispatch(store, fakeApi)
check('taskCount = 2 (今天+逾期)', res.taskCount === 2, res.taskCount)

console.log('run 4: project by explicit id when name missing')
const fakeApi2 = { ...fakeApi, async getProjects() { return [{ id: 'p-x', name: '其他', closed: false }] } }
await store.patch({ dueMode: 'today', includeUndated: true, projectName: 'GhostList', projectId: 'p-5ai' })
const res4 = await doDispatch(store, fakeApi2)
check('falls back to projectId when name not found', res4.ok === true && res4.projectId === 'p-5ai', res4.message)

console.log('run 5: change-detection (interval mode notifies only on change)')
await store.patch({ dueMode: 'all', includeUndated: true, projectName: '5️⃣AI', projectId: '' })
const baseApi = { getProjects: async () => [{ id: 'p-5ai', name: '5️⃣AI', closed: false }], getProjectData: async () => ({ tasks: [
  { id: 'a', projectId: 'p-5ai', title: '任务A', status: 0 },
  { id: 'b', projectId: 'p-5ai', title: '任务B', status: 0 },
] }) }
const first = await doDispatch(store, baseApi)
check('first dispatch changed=true', first.changed === true, first.changed)
const repeat = await doDispatch(store, baseApi)
check('identical re-dispatch changed=false (no notify spam)', repeat.changed === false, repeat.changed)
const plusApi = { getProjects: baseApi.getProjects, getProjectData: async () => ({ tasks: [
  { id: 'a', projectId: 'p-5ai', title: '任务A', status: 0 },
  { id: 'b', projectId: 'p-5ai', title: '任务B', status: 0 },
  { id: 'c', projectId: 'p-5ai', title: '任务C', status: 0 },
] }) }
const plus = await doDispatch(store, plusApi)
check('new task added -> changed=true', plus.changed === true, plus.changed)

console.log('run 6: auto-execute (1 task = 1 worker session, serial, auto-complete)')
const { runAutoExecute } = await import('../lib/index.js')
await store.patch({ autoExecute: true, retryCooldownMinutes: 60 })
const executedIds = []
let seenTimeoutMs
const fakeSpawn = async (prompt, opts) => {
  seenTimeoutMs = opts?.timeoutMs
  executedIds.push(prompt.includes('任务X') ? 'x' : 'y')
  if (prompt.includes('任务X')) return { ok: true, exitCode: 0, output: 'DONE', error: undefined }
  return { ok: false, exitCode: 1, output: '', error: 'boom' }
}
const completedIds = []
const fakeComplete = async (projectId, taskId) => { completedIds.push(taskId) }
const tasksExec = [
  { id: 'x', projectId: 'p-5ai', title: '任务X', content: 'do x', dueDate: '', priority: 0, tags: [] },
  { id: 'y', projectId: 'p-5ai', title: '任务Y', content: 'do y', dueDate: '', priority: 0, tags: [] },
  { id: 'z', projectId: 'p-5ai', title: '任务Z', content: 'do z', dueDate: '', priority: 0, tags: [] },
]
const exec = await runAutoExecute(store, { completeTask: fakeComplete }, tasksExec, { spawn: fakeSpawn })
check('executed 3 (serial one per task)', exec.executed === 3, exec.executed)
check('completed 1 (only the ok worker)', exec.completed === 1 && completedIds.length === 1 && completedIds[0] === 'x', JSON.stringify(completedIds))
check('failed 2 (y/z)', exec.failed === 2, exec.failed)
check('worker 超时默认 30 分钟且传给 spawn', seenTimeoutMs === 30 * 60 * 1000, seenTimeoutMs)
// Re-run immediately: x was completed (task gone in real flow, but here) and y/z are in cooldown -> all skipped.
const exec2 = await runAutoExecute(store, { completeTask: fakeComplete }, tasksExec, { spawn: fakeSpawn })
check('re-run within cooldown skips all 3', exec2.skipped === 3, JSON.stringify(exec2))
// autoExecute off -> no-op
await store.patch({ autoExecute: false })
const execOff = await runAutoExecute(store, { completeTask: fakeComplete }, tasksExec, { spawn: fakeSpawn })
check('autoExecute off -> no-op', execOff.executed === 0, execOff.executed)

console.log('run 6b: worker 超时可配置（workerTimeoutMinutes）')
await store.patch({ autoExecute: true, retryCooldownMinutes: 60, workerTimeoutMinutes: 45 })
check('配置写入 view', (await store.view()).workerTimeoutMinutes === 45)
let seenTimeout45
const execT = await runAutoExecute(store, { completeTask: fakeComplete }, [
  { id: 'to1', projectId: 'p-5ai', title: '超时任务', content: '', dueDate: '', priority: 0, tags: [] },
], { spawn: async (_prompt, opts) => { seenTimeout45 = opts?.timeoutMs; return { ok: true, exitCode: 0, output: 'DONE', error: undefined } } })
check('runAutoExecute 用配置的超时（45 分钟）', execT.completed === 1 && seenTimeout45 === 45 * 60 * 1000, JSON.stringify({ seenTimeout45, execT: execT.log }))
await store.patch({ workerTimeoutMinutes: 30 })

console.log('run 7: worker workspace — spawnWorker honors cwd; runAutoExecute resolves workerWorkspaceId')
// Fake `dsh` executable that prints its cwd and fails when it is not the
// expected workspace dir (proves the worker is spawned inside the workspace).
const wsRoot = await mkdtemp(path.join(tmpdir(), 'dsh-ws-'))
const wsBin = path.join(wsRoot, 'bin')
await mkdir(wsBin, { recursive: true })
const fakeDsh = path.join(wsBin, 'dsh')
await writeFile(fakeDsh, '#!/bin/sh\necho "CWD=$PWD"\nif [ -n "$FAKE_DSH_SLEEP" ]; then sleep "$FAKE_DSH_SLEEP"; fi\n[ "$PWD" = "$EXPECT_CWD" ]\n', { mode: 0o755 })
// Workspace ledger the plugin reads (DSH_WORKSPACE_STORE override).
const wsStoreFile = path.join(wsRoot, 'workspace.json')
const wsDir = path.join(wsRoot, 'ws-demo')
await mkdir(wsDir, { recursive: true })
await writeFile(wsStoreFile, JSON.stringify({ tables: { workspaces: { 'ws-demo': { id: 'ws-demo', title: '演示工作区', path: wsDir } } } }))
process.env.DSH_WORKSPACE_STORE = wsStoreFile
process.env.PATH = wsBin + path.delimiter + (process.env.PATH ?? '')
const { spawnWorker } = await import('../lib/index.js')
// macOS /var -> /private/var symlink: the shell's $PWD is the resolved real
// path, so compare against realpath of the cwd.
const wsDirReal = await import('node:fs/promises').then((fs) => fs.realpath(wsDir))
// 7a: explicit cwd flows through spawnWorker.
process.env.EXPECT_CWD = wsDirReal
const direct = await spawnWorker('task', { cwd: wsDir })
check('spawnWorker honors cwd', direct.ok === true && direct.output.includes('CWD=' + wsDirReal), direct.output)
// 7b: workerWorkspaceId resolves to the workspace dir through runAutoExecute.
await store.patch({ autoExecute: true, retryCooldownMinutes: 60, workerWorkspaceId: 'ws-demo' })
const wsTasks = [{ id: 'w1', projectId: 'p-5ai', title: '工作区任务', content: '', dueDate: '', priority: 0, tags: [] }]
const execWs = await runAutoExecute(store, { completeTask: fakeComplete }, wsTasks)
check('auto-execute worker runs in configured workspace', execWs.executed === 1 && execWs.completed === 1, JSON.stringify(execWs.log))
// 7c: empty workspace id falls back to the home directory (fresh task id to
// avoid the retry cooldown from 7b).
await store.patch({ workerWorkspaceId: '' })
process.env.EXPECT_CWD = homedir()
const execHome = await runAutoExecute(store, { completeTask: fakeComplete }, [{ ...wsTasks[0], id: 'w2' }])
check('empty workspace id falls back to home dir', execHome.executed === 1 && execHome.completed === 1, JSON.stringify(execHome.log))
// 7d: the timeout is really enforced — a slow worker is SIGKILLed at the
// configured deadline and reported as error='timeout'.
process.env.FAKE_DSH_SLEEP = '8'
const t0 = Date.now()
const timedOut = await spawnWorker('slow task', { cwd: wsDir, timeoutMs: 500 })
const elapsed = Date.now() - t0
delete process.env.FAKE_DSH_SLEEP
check('spawnWorker 到点 SIGKILL（error=timeout, 提前收尾）',
  timedOut.ok === false && timedOut.error === 'timeout' && elapsed < 5000,
  JSON.stringify({ error: timedOut.error, elapsed }))

console.log('run 8: 窗口任务（开始日已到、截止日未到）= 拉取但不自动执行')
const windowApi = { getProjects: async () => [{ id: 'p-5ai', name: '5️⃣AI', closed: false }], getProjectData: async () => ({ tasks: [
  { id: 'd1', projectId: 'p-5ai', title: '今天到期', dueDate: today + 'T12:00:00.000Z', status: 0 },
  { id: 'd2', projectId: 'p-5ai', title: '未来无开始日', dueDate: '2099-01-01T00:00:00.000Z', status: 0 },
  { id: 'd3', projectId: 'p-5ai', title: '窗口任务', startDate: today + 'T00:00:00.000Z', dueDate: '2099-01-01T00:00:00.000Z', status: 0 },
  { id: 'd4', projectId: 'p-5ai', title: '未开始', startDate: '2099-01-01T00:00:00.000Z', dueDate: '2099-06-01T00:00:00.000Z', status: 0 },
] }) }
await store.patch({ dueMode: 'today', includeUndated: false, autoExecute: false, projectName: '5️⃣AI', projectId: '' })
const res8 = await doDispatch(store, windowApi)
const t8 = res8.tasks.map((t) => t.title)
check('窗口任务被拉取（startDate 已到）', t8.includes('窗口任务'), JSON.stringify(t8))
check('未来且无开始日的任务仍被排除', !t8.includes('未来无开始日'), JSON.stringify(t8))
check('未来才开始的任务被排除', !t8.includes('未开始'), JSON.stringify(t8))
const w8 = res8.tasks.find((t) => t.title === '窗口任务')
check('窗口任务 actionable=false', w8 !== undefined && w8.actionable === false, JSON.stringify(w8))
const a8 = res8.tasks.find((t) => t.title === '今天到期')
check('到期任务 actionable=true', a8 !== undefined && a8.actionable === true, JSON.stringify(a8))
const file8 = await readFile(TASK_FILE, 'utf8')
check('今日任务文件标注「进行中」', file8.includes('- [ ] 窗口任务（进行中 · 截止 2099-01-01）'), file8)
check('今日任务文件说明不自动执行', file8.includes('标「进行中」的窗口任务仅在此列出、不自动执行'), file8)
await store.patch({ autoExecute: true })
const ran8 = []
const exec8 = await runAutoExecute(store, { completeTask: async (p, id) => { ran8.push(id) } }, res8.tasks, { spawn: async () => ({ ok: true, exitCode: 0, output: 'DONE', error: undefined }) })
check('自动执行跑到期任务', ran8.includes('d1'), JSON.stringify(ran8))
check('自动执行跳过窗口任务（即使开始日是今天）', !ran8.includes('d3'), JSON.stringify(ran8))
check('窗口任务计入 skipped', exec8.skipped === 1, JSON.stringify(exec8))

console.log('\nrun 9: flomo 正文井号处理（派发通知与会话汇总共用同一道出口）')
{
  const { escapeHashes, buildFlomoContent } = await import('../lib/index.js')
  // 会话汇总里最典型的正文：PR 号。曾经 dispatcher_report 这条路径没做处理，
  // 导致 flomo 把「#91 / #759 / #76」当成标签（2026-09-11 20:42 那条汇总）。
  const escaped = escapeHashes('- PR #91 CLEAN、#759 CLEAN、#76 限流')
  check('escapeHashes 换成全角 ＃（不删除）', escaped === '- PR ＃91 CLEAN、＃759 CLEAN、＃76 限流', escaped)
  const memo = buildFlomoContent(escaped, 'AI/DSH/派发')
  const body = memo.slice(0, memo.lastIndexOf('#'))
  check('正文无半角 #', !body.includes('#'), body)
  check('标签保留半角 #', memo.endsWith('#AI/DSH/派发'), memo)
  const plain = buildFlomoContent(escapeHashes('干净正文'), 'AI/DSH/派发')
  check('无井号正文不受影响', plain === '干净正文 #AI/DSH/派发', plain)
}

console.log('\nrun 10: 执行结果回执（每任务一条简明结果 + 多任务批次汇总）')
{
  const { runAutoExecute, summarizeWorkerOutput } = await import('../lib/index.js')
  await store.patch({ autoExecute: true, retryCooldownMinutes: 0, notifyResult: true })

  // 摘要只取 stdout（headless runner 把最终答复写 stdout，进度/思考写 stderr），
  // 丢掉 ANSI、空行与结尾的 DONE 标记，压平成一行并截断。
  check('摘要取 stdout 最终答复', summarizeWorkerOutput('\u001b[32m做好了：给 dsh-cubox 加了导出\u001b[0m\n\nDONE\n') === '做好了：给 dsh-cubox 加了导出')
  check('摘要丢掉 DONE 标记', !summarizeWorkerOutput('结论\nDONE').includes('DONE'))
  check('摘要截断超长正文', summarizeWorkerOutput('x'.repeat(500)).length === 220)
  check('空 stdout → 空摘要', summarizeWorkerOutput('') === '')

  const captured = []
  const spawn10 = async (prompt) => {
    if (prompt.includes('回执A')) return { ok: true, exitCode: 0, output: 'stdout+stderr', stdout: 'A 做完了：改了 notify.ts', stderr: 'progress', error: undefined }
    if (prompt.includes('回执B')) return { ok: false, exitCode: null, output: '', stdout: '', stderr: '', error: 'timeout' }
    return { ok: true, exitCode: 0, output: '', stdout: 'C 做完了', stderr: '', error: undefined }
  }
  const tasks10 = [
    { id: 'r1', projectId: 'p-5ai', title: '回执A', content: '', dueDate: '', priority: 0, tags: [] },
    { id: 'r2', projectId: 'p-5ai', title: '回执B', content: '', dueDate: '', priority: 0, tags: [] },
    { id: 'r3', projectId: 'p-5ai', title: '回执C', content: '', dueDate: '', priority: 0, tags: [] },
  ]
  const exec10 = await runAutoExecute(store, { completeTask: async () => {} }, tasks10, {
    spawn: spawn10,
    notifyResult: true,
    notify: async (text) => { captured.push(text) },
  })
  check('3 项执行、2 完成 1 失败', exec10.executed === 3 && exec10.completed === 2 && exec10.failed === 1, JSON.stringify(exec10.log))
  check('results 每项一条', exec10.results.length === 3, JSON.stringify(exec10.results.map((r) => r.status)))
  check('完成消息带标题 + 结果摘要', captured[0] === '✅ 任务完成 · 回执A\n结果：A 做完了：改了 notify.ts', JSON.stringify(captured[0]))
  check('失败消息带超时原因', captured[1].startsWith('❌ 任务失败 · 回执B\n原因：执行超时（30 分钟，已 SIGKILL）'), JSON.stringify(captured[1]))
  check('多任务补一条批次汇总', captured[3] === '📊 本轮自动执行：完成 2 · 失败 1（共 3 项）\n- ✅ 回执A\n- ❌ 回执B\n- ✅ 回执C', JSON.stringify(captured[3]))
  check('共 4 条（3 任务 + 1 汇总）', captured.length === 4, JSON.stringify(captured.length))

  // 单任务不补汇总；不传 notifyResult 时一条都不发（测试/其它调用方零副作用）。
  // 每段用新 taskId：已 attempted 的任务在 retryCooldownMinutes（最小 1 分钟）
  // 内会被跳过，复用同一个 id 会让后面几段「一条都没发」变得没有意义。
  const runCase = async (label, ids, opts) => {
    const caseTasks = ids.map((id) => ({ id, projectId: 'p-5ai', title: '回执' + id, content: '', dueDate: '', priority: 0, tags: [] }))
    captured.length = 0
    const outcome = await runAutoExecute(store, { completeTask: async () => {} }, caseTasks, {
      spawn: async (prompt) => {
        const id = prompt.match(/回执([A-Za-z0-9]+)/)?.[1]
        return { ok: true, exitCode: 0, output: '', stdout: id + ' 完成', stderr: '', error: undefined }
      },
      ...opts,
    })
    return { label, outcome, sent: captured.length }
  }
  const one = await runCase('单任务', ['s1'], { notifyResult: true, notify: async (t) => { captured.push(t) } })
  check('单任务只发 1 条（无汇总）', one.sent === 1, JSON.stringify(one))
  const optOut = await runCase('未开启', ['s2'], { notify: async (t) => { captured.push(t) } })
  check('未显式开启 notifyResult → 不发结果（但任务照跑）', optOut.sent === 0 && optOut.outcome.completed === 1, JSON.stringify(optOut))

  // 配置可关（notifyResult=false 时即使调用方开启也不发）
  await store.patch({ notifyResult: false })
  const offByCfg = await runCase('配置关', ['s3'], { notifyResult: true, notify: async (t) => { captured.push(t) } })
  check('配置 notifyResult=false → 不发结果（但任务照跑）', offByCfg.sent === 0 && offByCfg.outcome.completed === 1, JSON.stringify(offByCfg))
  await store.patch({ notifyResult: true })
}

console.log('\nrun 11: DSH_HOME 感知（插件覆盖变量 → DSH_HOME → ~/.dsh）')
{
  const { dshHome, pluginPath, configPath, workspaceStorePath, DEFAULT_CONFIG_FILE, DEFAULT_TASK_FILE } = await import('../lib/index.js')
  const saved = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_TASK_DISPATCHER_CONFIG: process.env.DSH_TASK_DISPATCHER_CONFIG,
    DSH_WORKSPACE_STORE: process.env.DSH_WORKSPACE_STORE,
  }
  const put = (key, value) => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const fakeHome = path.join(root, 'relocated-dsh-home')
  process.env.DSH_HOME = fakeHome
  delete process.env.DSH_TASK_DISPATCHER_CONFIG
  delete process.env.DSH_WORKSPACE_STORE
  check('dshHome() 认 DSH_HOME', dshHome() === fakeHome, dshHome())
  check('pluginPath() 落到 DSH_HOME 下', pluginPath(undefined, 'x.json') === path.join(fakeHome, 'x.json'))
  check('configPath() 落到 DSH_HOME 下', configPath() === path.join(fakeHome, 'dsh-task-dispatcher.json'), configPath())
  check('workspaceStorePath() 落到 DSH_HOME 下', workspaceStorePath() === path.join(fakeHome, 'storages', 'workspace.json'), workspaceStorePath())
  check('模块级默认路径也在 home 下',
    DEFAULT_CONFIG_FILE.endsWith(path.join('dsh-task-dispatcher.json')) && DEFAULT_TASK_FILE.endsWith(path.join('dsh-task-dispatcher', 'today-tasks.md')),
    DEFAULT_CONFIG_FILE + ' / ' + DEFAULT_TASK_FILE)
  process.env.DSH_TASK_DISPATCHER_CONFIG = path.join(root, 'explicit.json')
  check('插件覆盖变量优先于 DSH_HOME', configPath() === path.join(root, 'explicit.json'), configPath())
  process.env.DSH_WORKSPACE_STORE = path.join(root, 'explicit-workspace.json')
  check('工作区覆盖变量优先于 DSH_HOME', workspaceStorePath() === path.join(root, 'explicit-workspace.json'), workspaceStorePath())
  put('DSH_HOME', saved.DSH_HOME)
  put('DSH_TASK_DISPATCHER_CONFIG', saved.DSH_TASK_DISPATCHER_CONFIG)
  put('DSH_WORKSPACE_STORE', saved.DSH_WORKSPACE_STORE)
}

await rm(root, { recursive: true, force: true })
await rm(wsRoot, { recursive: true, force: true })
if (failures > 0) {
  console.error('\n' + failures + ' check(s) failed')
  process.exit(1)
}
console.log('\nAll smoke checks passed.')
