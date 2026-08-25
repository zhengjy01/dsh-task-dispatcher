/**
 * dsh-task-dispatcher smoke test — validates the dispatch core against a fake
 * TickTickApi (no network, no real credentials). Sets a temp config path via
 * DSH_TASK_DISPATCHER_CONFIG and a temp task-file path; disables flomo/mac
 * notify so no side effects fire.
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

await rm(root, { recursive: true, force: true })
if (failures > 0) {
  console.error('\n' + failures + ' check(s) failed')
  process.exit(1)
}
console.log('\nAll smoke checks passed.')
