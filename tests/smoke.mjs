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
  { id: 't1', projectId: 'p-5ai', title: '今天到期', dueDate: today + 'T12:00:00.000Z', priority: 3, status: 0, tags: ['a'] },
  { id: 't2', projectId: 'p-5ai', title: '逾期', dueDate: '2020-01-01T00:00:00.000Z', priority: 1, status: 0 },
  { id: 't3', projectId: 'p-5ai', title: '未来', dueDate: '2099-01-01T00:00:00.000Z', priority: 0, status: 0 },
  { id: 't4', projectId: 'p-5ai', title: '无截止', dueDate: undefined, priority: 0, status: 0 },
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
const fakeSpawn = async (prompt) => {
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
// Re-run immediately: x was completed (task gone in real flow, but here) and y/z are in cooldown -> all skipped.
const exec2 = await runAutoExecute(store, { completeTask: fakeComplete }, tasksExec, { spawn: fakeSpawn })
check('re-run within cooldown skips all 3', exec2.skipped === 3, JSON.stringify(exec2))
// autoExecute off -> no-op
await store.patch({ autoExecute: false })
const execOff = await runAutoExecute(store, { completeTask: fakeComplete }, tasksExec, { spawn: fakeSpawn })
check('autoExecute off -> no-op', execOff.executed === 0, execOff.executed)

console.log('run 7: worker workspace — spawnWorker honors cwd; runAutoExecute resolves workerWorkspaceId')
// Fake `dsh` executable that prints its cwd and fails when it is not the
// expected workspace dir (proves the worker is spawned inside the workspace).
const wsRoot = await mkdtemp(path.join(tmpdir(), 'dsh-ws-'))
const wsBin = path.join(wsRoot, 'bin')
await mkdir(wsBin, { recursive: true })
const fakeDsh = path.join(wsBin, 'dsh')
await writeFile(fakeDsh, '#!/bin/sh\necho "CWD=$PWD"\n[ "$PWD" = "$EXPECT_CWD" ]\n', { mode: 0o755 })
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

await rm(root, { recursive: true, force: true })
await rm(wsRoot, { recursive: true, force: true })
if (failures > 0) {
  console.error('\n' + failures + ' check(s) failed')
  process.exit(1)
}
console.log('\nAll smoke checks passed.')
