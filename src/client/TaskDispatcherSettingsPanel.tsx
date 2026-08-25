/**
 * Task-dispatcher settings panel — rendered inside the web settings page
 * (settings.section entry). Configuration form (dispatch time, source list,
 * filter, notify toggles, task file) plus a manual dispatch button and the
 * last-dispatch summary. Plain React, no emoji, no external UI package —
 * inline styles only.
 */
import { useCallback, useEffect, useState } from 'react'
import { DispatcherApi, type DispatcherConfigView, type DispatcherRunResult } from './api.ts'

/** Module-level API client (stateless; the component closes over it). */
const api = new DispatcherApi()

/** One shared style sheet (kept tiny and theme-agnostic). */
const s = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    maxWidth: '600px',
    padding: '14px 16px',
    borderRadius: '10px',
    border: '1px solid rgba(128,128,128,0.3)',
    fontSize: '13px',
    color: 'inherit',
  } as const,
  title: { fontWeight: 600, fontSize: '13px', margin: 0 } as const,
  status: { fontSize: '12px', opacity: 0.85 } as const,
  statusWarn: { fontSize: '12px', opacity: 0.9, color: '#c9763a' } as const,
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
    width: '64px',
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
  list: { fontSize: '12px', margin: 0, paddingLeft: '18px' } as const,
}

/** Status line for the current config view. */
function statusText(view: DispatcherConfigView | null): string {
  if (view === null) return '加载中…'
  const time = String(view.dispatchHour).padStart(2, '0') + ':' + String(view.dispatchMinute).padStart(2, '0')
  const base = (view.enabled ? '已启用' : '已禁用') + ' · 每日 ' + time + ' · 来源「' + view.projectName + '」'
  return base + (view.lastDispatchAt ? ' · 上次 ' + view.lastDispatchAt + '（' + view.lastTaskCount + ' 项）' : ' · 尚未派发')
}

/** The settings panel component. */
export function TaskDispatcherSettingsPanel(): JSX.Element {
  const [view, setView] = useState<DispatcherConfigView | null>(null)
  const [dispatchHour, setDispatchHour] = useState('8')
  const [dispatchMinute, setDispatchMinute] = useState('30')
  const [projectName, setProjectName] = useState('5️⃣AI')
  const [dueMode, setDueMode] = useState('today')
  const [includeUndated, setIncludeUndated] = useState(true)
  const [notifyFlomo, setNotifyFlomo] = useState(true)
  const [flomoTag, setFlomoTag] = useState('AI/DSH/派发')
  const [notifyMac, setNotifyMac] = useState(true)
  const [taskFile, setTaskFile] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const refresh = useCallback(async () => {
    try {
      const v = await api.getStatus()
      setView(v)
      setDispatchHour(String(v.dispatchHour))
      setDispatchMinute(String(v.dispatchMinute))
      setProjectName(v.projectName)
      setDueMode(v.dueMode)
      setIncludeUndated(v.includeUndated)
      setNotifyFlomo(v.notifyFlomo)
      setFlomoTag(v.flomoTag)
      setNotifyMac(v.notifyMac)
      setTaskFile(v.taskFile)
    } catch (error) {
      setMsg('读取状态失败: ' + String(error instanceof Error ? error.message : error))
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
        dispatchHour: Number(dispatchHour) || 8,
        dispatchMinute: Number(dispatchMinute) || 30,
        projectName,
        dueMode,
        includeUndated,
        notifyFlomo,
        flomoTag,
        notifyMac,
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
      <div style={view !== null && view.enabled ? s.status : s.statusWarn}>{statusText(view)}</div>

      <div style={s.row}>
        <span style={s.label}>每日派发</span>
        <input style={s.num} value={dispatchHour} onChange={(e) => setDispatchHour(e.target.value)} />
        <span style={s.label}>:</span>
        <input style={s.num} value={dispatchMinute} onChange={(e) => setDispatchMinute(e.target.value)} />
        <span style={s.label}>（时:分）</span>
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
      <label style={s.check}><input type="checkbox" checked={notifyMac} onChange={(e) => setNotifyMac(e.target.checked)} /> macOS 通知</label>

      <div style={s.row}>
        <span style={s.label}>任务文件</span>
        <input style={{ ...s.input, ...s.flex }} value={taskFile} onChange={(e) => setTaskFile(e.target.value)} placeholder="留空使用默认" />
      </div>

      <div style={s.row}>
        <button style={s.button} onClick={save} disabled={busy}>保存配置</button>
        <button style={s.button} onClick={dispatchNow} disabled={busy}>立即派发</button>
        <button style={s.button} onClick={() => void refresh()} disabled={busy}>刷新</button>
      </div>

      {lastList !== null && (
        <ul style={s.list}>
          {lastList.map((t, i) => <li key={i}>{t}</li>)}
        </ul>
      )}
      {msg !== '' && <div style={s.msg}>{msg}</div>}
    </div>
  )
}
