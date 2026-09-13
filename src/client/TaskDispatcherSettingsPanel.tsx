/**
 * Task-dispatcher settings panel — rendered inside the web settings page
 * (settings.section entry). Configuration form (poll interval, source list,
 * filter, notify toggles, task file) plus a manual dispatch button and the
 * last-pull task list. The panel is self-explanatory: a short intro explains
 * how the dispatcher works, and the task list at the bottom is labelled as a
 * snapshot. Plain React, no emoji, no external UI package — inline styles only.
 */
import { useCallback, useEffect, useState } from 'react'
import { DispatcherApi, type DispatcherConfigView, type DispatcherRunResult, type WorkspaceInfo } from './api.ts'

/** Module-level API client (stateless; the component closes over it). */
const api = new DispatcherApi()

/** One shared style sheet (kept tiny and theme-agnostic). */
const s = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    maxWidth: '620px',
    padding: '14px 16px',
    borderRadius: '10px',
    border: '1px solid rgba(128,128,128,0.3)',
    fontSize: '13px',
    color: 'inherit',
  } as const,
  title: { fontWeight: 600, fontSize: '13px', margin: 0 } as const,
  status: { fontSize: '12px', opacity: 0.85 } as const,
  statusWarn: { fontSize: '12px', opacity: 0.9, color: '#c9763a' } as const,
  hint: { fontSize: '12px', opacity: 0.85, lineHeight: '1.5', margin: 0 } as const,
  row: { display: 'flex', gap: '6px', alignItems: 'center' } as const,
  label: { fontSize: '12px', opacity: 0.85, whiteSpace: 'nowrap' } as const,
  input: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'rgba(128,128,128,0.08)',
    color: 'inherit',
    fontSize: '12px',
  } as const,
  num: {
    width: '72px',
    padding: '5px 8px',
    borderRadius: '6px',
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'rgba(128,128,128,0.08)',
    color: 'inherit',
    fontSize: '12px',
  } as const,
  flex: { flex: 1 } as const,
  check: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' } as const,
  button: {
    padding: '4px 10px',
    borderRadius: '6px',
    cursor: 'pointer',
    border: '1px solid rgba(128,128,128,0.4)',
    background: 'rgba(128,128,128,0.14)',
    color: 'inherit',
    fontSize: '12px',
  } as const,
  msg: { fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', opacity: 0.9 } as const,
  listHead: { fontSize: '12px', opacity: 0.9, margin: 0 } as const,
  list: { fontSize: '12px', margin: 0, paddingLeft: '18px' } as const,
}

/** Status line for the current config view. */
function statusText(view: DispatcherConfigView | null): string {
  if (view === null) return '加载中…'
  const interval = view.dispatchIntervalMinutes === 0
    ? '已关闭定时'
    : ('每 ' + view.dispatchIntervalMinutes + ' 分钟')
  return (view.enabled ? '已启用' : '已禁用') + ' · ' + interval + ' · 来源「' + view.projectName + '」' +
    (view.autoExecute ? ' · 自动执行' : '') +
    (view.lastDispatchAt ? ' · 上次 ' + view.lastDispatchAt + '（' + view.lastTaskCount + ' 项）' : ' · 尚未拉取')
}

/** The settings panel component. */
export function TaskDispatcherSettingsPanel(): JSX.Element {
  const [view, setView] = useState<DispatcherConfigView | null>(null)
  const [intervalMinutes, setIntervalMinutes] = useState('30')
  const [projectName, setProjectName] = useState('5️⃣AI')
  const [dueMode, setDueMode] = useState('today')
  const [includeUndated, setIncludeUndated] = useState(true)
  const [notifyFlomo, setNotifyFlomo] = useState(true)
  const [flomoTag, setFlomoTag] = useState('AI/DSH/派发')
  const [flomoStripBodyHash, setFlomoStripBodyHash] = useState(true)
  const [notifyMac, setNotifyMac] = useState(true)
  const [autoExecute, setAutoExecute] = useState(false)
  const [workerTimeoutMinutes, setWorkerTimeoutMinutes] = useState('30')
  const [taskFile, setTaskFile] = useState('')
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [workerWorkspaceId, setWorkerWorkspaceId] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const refresh = useCallback(async () => {
    try {
      const v = await api.getStatus()
      setView(v)
      setIntervalMinutes(String(v.dispatchIntervalMinutes))
      setProjectName(v.projectName)
      setDueMode(v.dueMode)
      setIncludeUndated(v.includeUndated)
      setNotifyFlomo(v.notifyFlomo)
      setFlomoTag(v.flomoTag)
      setFlomoStripBodyHash(v.flomoStripBodyHash)
      setNotifyMac(v.notifyMac)
      setAutoExecute(v.autoExecute)
      setWorkerTimeoutMinutes(String(v.workerTimeoutMinutes))
      setTaskFile(v.taskFile)
      setWorkerWorkspaceId(v.workerWorkspaceId)
    } catch (error) {
      setMsg('读取状态失败: ' + String(error instanceof Error ? error.message : error))
    }
    // Workspace list is loaded separately (best-effort; a read failure keeps
    // the selector at its current value).
    try {
      setWorkspaces(await api.getWorkspaces())
    } catch (error) {
      setMsg('读取工作区列表失败: ' + String(error instanceof Error ? error.message : error))
    }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  /** Run one async panel action with busy/message bookkeeping. */
  const run = async (action: () => Promise<string>): Promise<void> => {
    setBusy(true)
    setMsg('')
    try {
      setMsg(await action())
    } catch (error) {
      setMsg('操作失败: ' + String(error instanceof Error ? error.message : error))
    } finally {
      setBusy(false)
    }
  }

  const save = (): void => {
    void run(async () => {
      const next = await api.setConfig({
        dispatchIntervalMinutes: Number(intervalMinutes) >= 0 ? Number(intervalMinutes) : 30,
        projectName,
        dueMode,
        includeUndated,
        notifyFlomo,
        flomoTag,
        flomoStripBodyHash,
        notifyMac,
        autoExecute,
        workerWorkspaceId,
        workerTimeoutMinutes: Number(workerTimeoutMinutes) >= 1 ? Number(workerTimeoutMinutes) : 30,
        ...(taskFile.trim() !== '' ? { taskFile } : {}),
      })
      setView(next)
      return '配置已保存。'
    })
  }

  const dispatchNow = (): void => {
    void run(async () => {
      const result: DispatcherRunResult = await api.run()
      setMsg((result.ok ? '[ok] ' : '[failed] ') + result.message)
      await refresh()
      return result.ok ? '[ok] ' + result.message : '[failed] ' + result.message
    })
  }

  const lastList = view !== null && view.lastTaskTitles.length > 0 ? view.lastTaskTitles : null

  return (
    <div style={s.card}>
      <p style={s.title}>滴答清单任务派发器</p>

      <p style={s.hint}>
        每隔一段间隔，插件会自动从滴答清单「{projectName || '来源清单'}」拉取今天到期的任务，写入今日任务文件（默认
        ~/.dsh/dsh-task-dispatcher/today-tasks.md）；<b>任务有变化时</b>才发 flomo + macOS 通知，没变化则保持安静。
        你随手在滴答清单里加任务，插件会在下次拉取时自动带进来。<b>自动执行</b>开启后，每个拉到的新任务会单独开一个 DSH
        会话（串行，一任务一会话）去执行，成功即回写滴答清单勾掉。下方的「上次拉取任务列表」只是最近一次拉取到的任务快照，非实时。
      </p>

      <div style={view !== null && view.enabled ? s.status : s.statusWarn}>{statusText(view)}</div>

      <div style={s.row}>
        <span style={s.label}>拉取间隔</span>
        <input style={s.num} value={intervalMinutes} onChange={(e) => setIntervalMinutes(e.target.value)} />
        <span style={s.label}>分钟（0 = 关闭定时自动拉取）</span>
      </div>

      <label style={s.check}>
        <input type="checkbox" checked={autoExecute} onChange={(e) => setAutoExecute(e.target.checked)} />
        自动执行（每个任务单独开一个 DSH 会话去执行，串行）
      </label>

      <div style={s.row}>
        <span style={s.label}>执行会话工作区</span>
        <select style={{ ...s.input, flex: 1 }} value={workerWorkspaceId} onChange={(e) => setWorkerWorkspaceId(e.target.value)}>
          <option value="">默认（用户主目录）</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.title}</option>
          ))}
        </select>
      </div>
      {autoExecute && workspaces.length > 0 && workerWorkspaceId === '' && (
        <p style={s.hint}>提示：开启自动执行后，worker 会话默认在用户主目录下运行；选择上方工作区后，worker 会话会在该工作区目录下运行，并在 GUI 侧边栏归入该工作区。</p>
      )}

      <div style={s.row}>
        <span style={s.label}>worker 超时</span>
        <input style={s.num} value={workerTimeoutMinutes} onChange={(e) => setWorkerTimeoutMinutes(e.target.value)} />
        <span style={s.label}>分钟（默认 30；到点 SIGKILL 该执行会话，1–1440）</span>
      </div>

      <div style={s.row}>
        <span style={s.label}>来源清单</span>
        <input style={{ ...s.input, ...s.flex }} value={projectName} onChange={(e) => setProjectName(e.target.value)} />
      </div>

      <div style={s.row}>
        <span style={s.label}>过滤</span>
        <select style={{ ...s.input, flex: 1 }} value={dueMode} onChange={(e) => setDueMode(e.target.value)}>
          <option value="today">今天到期/逾期</option>
          <option value="all">全部未完成</option>
        </select>
        <label style={s.check}>
          <input type="checkbox" checked={includeUndated} onChange={(e) => setIncludeUndated(e.target.checked)} />
          含无截止
        </label>
      </div>

      <div style={s.row}>
        <label style={s.check}><input type="checkbox" checked={notifyFlomo} onChange={(e) => setNotifyFlomo(e.target.checked)} /> flomo</label>
        <input style={{ ...s.input, ...s.flex }} value={flomoTag} onChange={(e) => setFlomoTag(e.target.value)} placeholder="flomo 标签" />
      </div>
      <label style={s.check}>
        <input type="checkbox" checked={flomoStripBodyHash} onChange={(e) => setFlomoStripBodyHash(e.target.checked)} />
        正文里的井号 # 替换成全角 ＃
      </label>
      <p style={s.hint}>
        开启后，发到 flomo 的正文（派发通知的任务标题、会话汇总等）会把「#」替换成全角「＃」——看起来还是井号，但 flomo 只认半角 #，
        因此不会再被误识别成标签（`#91` 也不会消失，仍读作「＃91」）；「{flomoTag}」标签本身仍保留半角 #。
      </p>
      <label style={s.check}><input type="checkbox" checked={notifyMac} onChange={(e) => setNotifyMac(e.target.checked)} /> macOS 通知</label>

      <div style={s.row}>
        <span style={s.label}>任务文件</span>
        <input style={{ ...s.input, ...s.flex }} value={taskFile} onChange={(e) => setTaskFile(e.target.value)} placeholder="留空使用默认" />
      </div>

      <div style={s.row}>
        <button style={s.button} onClick={save} disabled={busy}>保存配置</button>
        <button style={s.button} onClick={dispatchNow} disabled={busy}>立即拉取</button>
        <button style={s.button} onClick={() => void refresh()} disabled={busy}>刷新</button>
      </div>

      {lastList !== null && (
        <>
          <p style={s.listHead}>上次拉取任务列表（快照）：</p>
          <ul style={s.list}>
            {lastList.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </>
      )}
      {msg !== '' && <div style={s.msg}>{msg}</div>}
    </div>
  )
}
