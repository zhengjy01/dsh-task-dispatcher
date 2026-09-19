/**
 * Task-dispatcher settings panel — rendered inside the web settings page
 * (settings.section entry). Configuration form (poll interval, source list,
 * filter, notify toggles, task file) plus a manual dispatch button and the
 * last-pull task list. The panel is self-explanatory: a short intro explains
 * how the dispatcher works, and the task list at the bottom is labelled as a
 * snapshot. Plain React, no emoji, no external UI package — inline styles only.
 */
import { useCallback, useEffect, useState } from 'react'
import {
  DispatcherApi,
  type DeferredActionResult,
  type DeferredStatus,
  type DispatcherConfigView,
  type DispatcherRunResult,
  type WorkspaceInfo,
} from './api.ts'

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
    (view.cheapMode ? ' · 省钱模式开' : '') +
    (view.lastDispatchAt ? ' · 上次 ' + view.lastDispatchAt + '（' + view.lastTaskCount + ' 项）' : ' · 尚未拉取')
}

/** Status line for the deferred-sync block. */
function deferredStatusText(view: DeferredStatus | null): string {
  if (view === null) return '加载中…'
  const idle = view.idleMinutesNow < 0 ? '暂无会话日志' : ('当前已静默 ' + view.idleMinutesNow + ' 分钟')
  const timer = view.timer.supported
    ? (view.timer.loaded ? ('定时器运行中（每 ' + String(view.timer.intervalSeconds) + ' 秒检查）') : '定时器未运行')
    : '非 macOS：无 launchd 定时器，只能手动写入'
  return '队列 ' + String(view.pending) + ' 条（顶层 ' + String(view.pendingTop) + '） · 阈值 ' + String(view.idleMinutes) +
    ' 分钟 · ' + idle + ' · ' + (view.isIdle ? '可同步' : '仍在活跃') + ' · ' + timer +
    (view.lastFlushAt ? ' · 上次写入 ' + view.lastFlushAt : ' · 尚未写入')
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
  const [notifyResult, setNotifyResult] = useState(true)
  const [notifyWechat, setNotifyWechat] = useState(false)
  const [wechatGatewayUrl, setWechatGatewayUrl] = useState('')
  const [wechatTo, setWechatTo] = useState('')
  const [autoExecute, setAutoExecute] = useState(false)
  const [workerTimeoutMinutes, setWorkerTimeoutMinutes] = useState('30')
  const [taskFile, setTaskFile] = useState('')
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [workerWorkspaceId, setWorkerWorkspaceId] = useState('')
  const [cheapMode, setCheapMode] = useState(false)
  const [cheapPreset, setCheapPreset] = useState('official-2026')
  const [cheapStrategy, setCheapStrategy] = useState('wait')
  const [cheapMarginMinutes, setCheapMarginMinutes] = useState('0')
  const [cheapTimezone, setCheapTimezone] = useState('Asia/Shanghai')
  const [peakText, setPeakText] = useState('')
  const [runIgnoreCheap, setRunIgnoreCheap] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [deferred, setDeferred] = useState<DeferredStatus | null>(null)
  const [idleDraft, setIdleDraft] = useState('10')
  const [capDraft, setCapDraft] = useState('3')
  const [intervalDraft, setIntervalDraft] = useState('120')
  const [deferredMsg, setDeferredMsg] = useState('')

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
      setNotifyResult(v.notifyResult)
      setNotifyWechat(v.notifyWechat)
      setWechatGatewayUrl(v.wechatGatewayUrl)
      setWechatTo(v.wechatTo)
      setAutoExecute(v.autoExecute)
      setWorkerTimeoutMinutes(String(v.workerTimeoutMinutes))
      setTaskFile(v.taskFile)
      setWorkerWorkspaceId(v.workerWorkspaceId)
      setCheapMode(v.cheapMode)
      setCheapPreset(v.cheapPreset)
      setCheapStrategy(v.cheapStrategy)
      setCheapMarginMinutes(String(v.cheapMarginMinutes))
      setCheapTimezone(v.cheapTimezone)
      setPeakText(v.peakWindowsText)
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
    // Deferred-sync block is loaded best-effort too: a failure only blanks that
    // block, it must not hide the dispatcher config above.
    try {
      const d = await api.getDeferred()
      setDeferred(d)
      setIdleDraft(String(d.idleMinutes))
      setCapDraft(String(d.maxPerSession))
      setIntervalDraft(String(d.timer.intervalSeconds > 0 ? d.timer.intervalSeconds : 120))
    } catch {
      setDeferred(null)
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
        notifyResult,
        notifyWechat,
        wechatGatewayUrl,
        wechatTo,
        autoExecute,
        workerWorkspaceId,
        workerTimeoutMinutes: Number(workerTimeoutMinutes) >= 1 ? Number(workerTimeoutMinutes) : 30,
        cheapMode,
        cheapPreset,
        cheapStrategy,
        cheapTimezone,
        cheapMarginMinutes: Number(cheapMarginMinutes) >= 0 ? Number(cheapMarginMinutes) : 0,
        peakWindowsText: peakText,
        ...(taskFile.trim() !== '' ? { taskFile } : {}),
      })
      setView(next)
      return '配置已保存。'
    })
  }

  const dispatchNow = (): void => {
    void run(async () => {
      const result: DispatcherRunResult = await api.run(runIgnoreCheap)
      setMsg((result.ok ? '[ok] ' : '[failed] ') + result.message)
      await refresh()
      return result.ok ? '[ok] ' + result.message : '[failed] ' + result.message
    })
  }

  /** Run one deferred action, refreshing the block from the returned status. */
  const deferredAction = (action: () => Promise<DeferredActionResult>): void => {
    void run(async () => {
      const result = await action()
      let status = result.status
      if (status === undefined) {
        try {
          status = await api.getDeferred()
        } catch {
          status = undefined
        }
      }
      if (status !== undefined) {
        setDeferred(status)
        setIdleDraft(String(status.idleMinutes))
        setCapDraft(String(status.maxPerSession))
        setIntervalDraft(String(status.timer.intervalSeconds > 0 ? status.timer.intervalSeconds : 120))
      }
      setDeferredMsg(
        (result.ok ? '[ok] ' : '[failed] ') + result.message + (result.output !== '' ? '\n' + result.output : ''),
      )
      return ''
    })
  }

  const saveDeferred = (): void => {
    deferredAction(() => api.setDeferredConfig({
      idleMinutes: Number(idleDraft) >= 1 ? Number(idleDraft) : 10,
      maxPerSession: Number(capDraft) >= 1 ? Number(capDraft) : 3,
      intervalSeconds: Number(intervalDraft) >= 30 ? Number(intervalDraft) : 120,
    }))
  }

  const lastList = view !== null && view.lastTaskTitles.length > 0 ? view.lastTaskTitles : null

  return (
    <div style={s.card}>
      <p style={s.title}>滴答清单任务派发器</p>

      <p style={s.hint}>
        每隔一段间隔，插件会自动从滴答清单「{projectName || '来源清单'}」拉取今天到期的任务，写入今日任务文件（默认
        ~/.dsh/dsh-task-dispatcher/today-tasks.md）；<b>任务有变化时</b>才发通知（微信 / flomo / macOS，按下方开关），没变化则保持安静。
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

      <div style={{ borderTop: '1px solid rgba(128,128,128,0.25)', paddingTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <label style={s.check}>
          <input type="checkbox" checked={cheapMode} onChange={(e) => setCheapMode(e.target.checked)} />
          省钱模式（自动执行只在 DeepSeek 空闲/优惠时段开跑）
        </label>
        <p style={s.hint}>
          官方口径（2026-08-17 起）：高峰 = 北京时间周一至周五 09:00–12:00、14:00–18:00（价格翻倍）；其余时间（工作日
          12:00–14:00、18:00–次日 09:00、周六周日全天）为空闲时段（约半价）。不勾选时行为与现有逻辑完全一致。时段仅作用于
          <b>自动执行</b>，拉取/过滤/串行都不变；排队状态落盘，DSH 重启不丢。
        </p>
        {cheapMode && (
          <>
            <div style={s.row}>
              <span style={s.label}>时段口径</span>
              <select style={{ ...s.input, flex: 1 }} value={cheapPreset} onChange={(e) => setCheapPreset(e.target.value)}>
                <option value="official-2026">官方现行（周中 09–12 / 14–18 高峰）</option>
                <option value="legacy-utc">旧版 UTC 16:30–00:30 空闲</option>
                <option value="custom">自定义（用下方时段表）</option>
              </select>
            </div>
            <div style={s.row}>
              <span style={s.label}>时区</span>
              <input style={{ ...s.input, ...s.flex }} value={cheapTimezone} onChange={(e) => setCheapTimezone(e.target.value)} placeholder="Asia/Shanghai" />
              <span style={s.label}>策略</span>
              <select style={s.input} value={cheapStrategy} onChange={(e) => setCheapStrategy(e.target.value)}>
                <option value="wait">排队等空闲</option>
                <option value="skip">本轮跳过</option>
              </select>
            </div>
            <div style={s.row}>
              <span style={s.label}>尾部余量</span>
              <input style={s.num} value={cheapMarginMinutes} onChange={(e) => setCheapMarginMinutes(e.target.value)} />
              <span style={s.label}>分钟（0 = 关闭尾部保护；建议 15 或 worker 超时，避免跑进高峰）</span>
            </div>
            <span style={s.label}>高峰时段表（每行 `1,2,3,4,5 09:00-12:00`；0=周日…6=周六；start&gt;end 跨午夜；空 = 一直空闲）</span>
            <textarea
              style={{ ...s.input, minHeight: '52px', fontFamily: 'monospace', resize: 'vertical' }}
              value={peakText}
              onChange={(e) => setPeakText(e.target.value)}
            />
            {view !== null && view.cheapMode && (
              <p style={s.hint}>
                当前口径：{view.cheapPresetLabel} · 高峰时段：{view.peakWindowsText || '（无，一直空闲）'}<br />
                下次执行时间：{view.nextCheapStartAt !== '' ? view.nextCheapStartAt : '（当前空闲，立即可执行）'} · 排队任务：{view.cheapQueueCount} 项
                {view.cheapQueueCount > 0 ? '（' + view.cheapQueue.map((t) => t.title).join('；') + '）' : ''}
              </p>
            )}
          </>
        )}
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

      <label style={s.check}>
        <input type="checkbox" checked={notifyResult} onChange={(e) => setNotifyResult(e.target.checked)} />
        执行结果回执（自动执行的每个任务结束后推一条简明结果，多任务再补一条批次汇总）
      </label>

      <label style={s.check}>
        <input type="checkbox" checked={notifyWechat} onChange={(e) => setNotifyWechat(e.target.checked)} />
        微信通知（通过本机微信机器人 ClawBot 推送）
      </label>
      <div style={s.row}>
        <span style={s.label}>ClawBot 网关</span>
        <input style={{ ...s.input, ...s.flex }} value={wechatGatewayUrl} onChange={(e) => setWechatGatewayUrl(e.target.value)} placeholder="留空默认 http://127.0.0.1:51235" />
      </div>
      <div style={s.row}>
        <span style={s.label}>微信接收人</span>
        <input style={{ ...s.input, ...s.flex }} value={wechatTo} onChange={(e) => setWechatTo(e.target.value)} placeholder="留空自动识别（ClawBot 扫码登录的那个微信）" />
      </div>
      <p style={s.hint}>
        微信通知复用 DSH-WeChatClawBot 的本地网关：插件把消息 POST 到网关的 /send，由它转发到扫码登录的微信。
        需要微信悬浮球已扫码登录（否则会提示未找到接收人）；网关默认 127.0.0.1:51235，接收人默认从 ClawBot 状态目录（~/.dsh-wechat）自动识别，也可在此显式填写。
      </p>

      <div style={s.row}>
        <span style={s.label}>任务文件</span>
        <input style={{ ...s.input, ...s.flex }} value={taskFile} onChange={(e) => setTaskFile(e.target.value)} placeholder="留空使用默认" />
      </div>

      <div style={s.row}>
        <button style={s.button} onClick={save} disabled={busy}>保存配置</button>
        <button style={s.button} onClick={dispatchNow} disabled={busy}>立即拉取</button>
        <button style={s.button} onClick={() => void refresh()} disabled={busy}>刷新</button>
      </div>
      {cheapMode && (
        <label style={s.check}>
          <input type="checkbox" checked={runIgnoreCheap} onChange={(e) => setRunIgnoreCheap(e.target.checked)} />
          立即拉取时忽略省钱模式（高峰也马上执行，仅本次）
        </label>
      )}

      {lastList !== null && (
        <>
          <p style={s.listHead}>上次拉取任务列表（快照）：</p>
          <ul style={s.list}>
            {lastList.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </>
      )}
      <div style={{ ...s.hint, borderTop: '1px solid rgba(128,128,128,0.25)', paddingTop: '10px', marginTop: '2px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <p style={s.title}>延迟同步（agent → 滴答清单）</p>
        <p style={s.hint}>
          会话进行中<b>不直接建任务</b>，只暂存进队列；等<b>整个 DSH</b> 安静够久（下方阈值）后，由定时器统一写入滴答清单
          「To do」。判据是 ~/.dsh/sessions/ 下<b>最新一个</b>会话日志的修改时间——即「所有会话都不再活动」，不是只看当前会话。
          写入由独立脚本 + launchd 完成，所以 <b>DSH 关着也能写</b>。
        </p>
        <div style={deferred !== null && deferred.timer.loaded ? s.status : s.statusWarn}>{deferredStatusText(deferred)}</div>

        <div style={s.row}>
          <span style={s.label}>静默阈值</span>
          <input style={s.num} value={idleDraft} onChange={(e) => setIdleDraft(e.target.value)} />
          <span style={s.label}>分钟</span>
          <span style={s.label}>顶层上限</span>
          <input style={s.num} value={capDraft} onChange={(e) => setCapDraft(e.target.value)} />
          <span style={s.label}>条/会话</span>
        </div>
        <div style={s.row}>
          <span style={s.label}>检查间隔</span>
          <input style={s.num} value={intervalDraft} onChange={(e) => setIntervalDraft(e.target.value)} />
          <span style={s.label}>秒（改它需要重载定时器）</span>
        </div>
        <div style={s.row}>
          <button style={s.button} onClick={saveDeferred} disabled={busy}>保存阈值</button>
          <button style={s.button} onClick={() => deferredAction(() => api.flushDeferred(false))} disabled={busy}>立即写入</button>
          <button style={s.button} onClick={() => deferredAction(() => api.flushDeferred(true))} disabled={busy}>强制写入</button>
          <button style={s.button} onClick={() => deferredAction(() => api.deferredTimer('reload'))} disabled={busy}>重载定时器</button>
        </div>

        <p style={s.hint}>
          阈值写在队列文件里（脚本每次运行都读它，下次检查即生效）；<b>检查间隔</b>写在 launchd plist 里，改完会立即重载定时器。
          实际写入时间 = 静默满阈值后的下一次检查，也就是「阈值 ~ 阈值 + 检查间隔」之间。
        </p>

        {deferred !== null && deferred.tasks.length > 0 && (
          <>
            <p style={s.listHead}>队列明细（{deferred.pending} 条，顶层 {deferred.pendingTop}）：</p>
            <ul style={s.list}>
              {deferred.tasks.map((t, i) => (
                <li key={i}>{t.parentKey !== '' ? '└ ' : ''}{t.title}{t.stagedBy !== '' ? ' · ' + t.stagedBy : ''}</li>
              ))}
            </ul>
          </>
        )}

        {deferred !== null && deferred.scriptSource === 'bundled' && (
          <p style={s.hint}>
            当前用的是插件自带的脚本（{deferred.bundledScriptPath}）；点「重载定时器」会把定时器指向它，或手动复制到
            {' '}<b>~/.dsh/scripts/ticktick-pending.mjs</b>。
          </p>
        )}
        {deferred !== null && deferred.timer.supported && !deferred.timer.loaded && (
          <p style={s.statusWarn}>定时器未运行——队列不会被自动写入；点「重载定时器」安装/重载。</p>
        )}
        {deferredMsg !== '' && <div style={s.msg}>{deferredMsg}</div>}
      </div>

      {msg !== '' && <div style={s.msg}>{msg}</div>}
    </div>
  )
}
