import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  Clock3,
  Command,
  FileSearch,
  FolderOpen,
  LoaderCircle,
  Mail,
  Menu,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import codexLogo from './assets/codex.png'
import deepseekLogo from './assets/deepseek.png'
import doubaoLogo from './assets/doubao.png'

const DEFAULT_WORKSPACE = ''
const ACTIVE_STATES = new Set(['staged', 'starting', 'running', 'waiting_approval', 'waiting_input', 'halted'])
const STOPPABLE_STATES = new Set(['starting', 'running', 'waiting_approval', 'waiting_input'])
const NEW_DRAFT_KEY = 'new'
const MARKDOWN_PLUGINS = [remarkGfm]

const AGENT_META = {
  codex: {
    name: 'Codex',
    shortName: 'Codex',
    role: '协调与代码落地',
    focus: '拆解目标、整合方案并执行修改',
    accent: 'blue',
    logo: codexLogo,
  },
  deepseek: {
    name: 'DeepSeek Harness',
    shortName: 'DeepSeek',
    role: '方案规划与设计',
    focus: '独立分析任务并规划交互方案',
    accent: 'amber',
    logo: deepseekLogo,
  },
  doubao: {
    name: '豆包桌面端',
    shortName: '豆包',
    role: '信息搜集与整理',
    focus: '搜集中文资料并整理上下文',
    accent: 'coral',
    logo: doubaoLogo,
  },
}

const STATUS_LABELS = {
  idle: '本轮未调用',
  unchecked: '尚未检查',
  ready: '连接就绪',
  warning: '需检查',
  offline: '离线',
  starting: '启动中',
  running: '运行中',
  working: '处理中',
  waiting_approval: '待你确认',
  waiting_input: '等待你的输入',
  needs_approval: '待你确认',
  completed: '已结束',
  done: '已完成',
  failed: '失败',
  interrupted: '已中断',
  staged: '等待计划确认',
  halted: '已暂停',
  pending: '待开始',
  claimed: '已领取',
  in_progress: '执行中',
  cancelled: '已取消',
  blocked: '被依赖阻塞',
}

const COMPLETION_LABELS = {
  SUCCESS: '已完成',
  REVISION_NEEDED: '需要修改',
  BLOCKED: '已阻塞',
  INTERRUPTED: '已暂停',
}

function getStatusLabel(status) {
  return STATUS_LABELS[status] || status || '未知'
}

function timeLabel(value) {
  if (!value) return ''
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
}

function ErrorNotice({ message, onClose }) {
  if (!message) return null
  return (
    <div className="error-notice" role="alert">
      <AlertCircle size={16} aria-hidden="true" />
      <span>{message}</span>
      <button type="button" className="icon-button small" onClick={onClose} aria-label="关闭错误提示">
        <X size={15} />
      </button>
    </div>
  )
}

function StatePill({ status, compact = false }) {
  return (
    <span role="status" className={`state-pill state-${status || 'unchecked'}${compact ? ' compact' : ''}`} aria-label={getStatusLabel(status)}>
      <span className="state-dot" aria-hidden="true" />
      {compact ? <span className="sr-only">{getStatusLabel(status)}</span> : getStatusLabel(status)}
    </span>
  )
}

function AgentAvatar({ id, size = 'regular' }) {
  const meta = AGENT_META[id] || AGENT_META.codex
  return (
    <span className={`agent-avatar agent-${meta.accent} avatar-${size}`} aria-hidden="true">
      <img className="agent-logo" src={meta.logo} alt="" />
    </span>
  )
}

function MarkdownContent({ children }) {
  return <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{children}</ReactMarkdown>
}

function TeamMemberButton({ id, health, runAgent, selected, activityOpen, onSelect }) {
  const meta = AGENT_META[id]
  const connectionStatus = health?.status || 'unchecked'
  const activityStatus = runAgent?.status || 'idle'

  return (
    <button
      type="button"
      className={`team-member-button accent-${meta.accent}${selected && activityOpen ? ' selected' : ''}`}
      onClick={() => onSelect(id)}
      aria-expanded={selected && activityOpen}
      aria-controls="member-activity"
    >
      <AgentAvatar id={id} />
      <span className="team-member-copy">
        <span className="team-member-name">
          <strong>{meta.shortName}</strong>
          <span>{meta.role}</span>
        </span>
        <span className="team-member-state" title={runAgent?.activity || getStatusLabel(activityStatus)}>
          <StatePill status={connectionStatus} compact />
          <span className={`team-member-activity state-${activityStatus}`}>
            <Activity size={12} aria-hidden="true" />
            {runAgent?.activity || getStatusLabel(activityStatus)}
          </span>
        </span>
      </span>
    </button>
  )
}

function UserInputCard({ question, pending, onSubmit }) {
  const [values, setValues] = useState(() => Object.fromEntries(question.fields.map(field => [field.id, field.default ?? (field.type === 'array' ? [] : field.type === 'boolean' ? false : '')])))
  const [customAnswer, setCustomAnswer] = useState('')

  const setValue = (id, value) => setValues(previous => ({ ...previous, [id]: value }))
  const submit = event => {
    event.preventDefault()
    const answers = Object.fromEntries(question.fields.map(field => {
      const value = values[field.id]
      if ((field.type === 'number' || field.type === 'integer') && value !== '') return [field.id, Number(value)]
      return [field.id, value]
    }))
    onSubmit(question.id, { answers, customAnswer })
  }

  return (
    <form className="user-input-card" onSubmit={submit}>
      {question.fields.map(field => (
        <fieldset key={field.id} className="user-input-field">
          <legend>{field.label}{field.required && <span aria-label="必填"> *</span>}</legend>
          {field.description && <p>{field.description}</p>}
          {field.type === 'boolean' ? (
            <label className="checkbox-choice"><input type="checkbox" checked={Boolean(values[field.id])} onChange={event => setValue(field.id, event.target.checked)} disabled={pending} /> <span>是</span></label>
          ) : field.type === 'array' ? (
            <div className="choice-list" role="group" aria-label={field.label}>
              {field.options.map(option => (
                <label className="choice-option" key={option.value}>
                  <input type="checkbox" checked={Array.isArray(values[field.id]) && values[field.id].includes(option.value)} onChange={event => {
                    const current = Array.isArray(values[field.id]) ? values[field.id] : []
                    setValue(field.id, event.target.checked ? [...current, option.value] : current.filter(value => value !== option.value))
                  }} disabled={pending} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          ) : field.options.length ? (
            <div className="choice-list" role="radiogroup" aria-label={field.label}>
              {field.options.map(option => (
                <label className="choice-option" key={option.value}>
                  <input type="radio" name={`${question.id}-${field.id}`} value={option.value} checked={values[field.id] === option.value} onChange={() => setValue(field.id, option.value)} disabled={pending} />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          ) : field.type === 'number' || field.type === 'integer' ? (
            <input type="number" step={field.type === 'integer' ? '1' : 'any'} min={field.minimum} max={field.maximum} value={values[field.id]} onChange={event => setValue(field.id, event.target.value)} disabled={pending} />
          ) : (
            <textarea value={values[field.id]} onChange={event => setValue(field.id, event.target.value)} maxLength={field.maxLength} disabled={pending} rows={2} />
          )}
        </fieldset>
      ))}
      <label className="user-input-custom">
        <span>补充说明</span>
        <textarea value={customAnswer} onChange={event => setCustomAnswer(event.target.value)} maxLength={8_000} rows={2} placeholder="选项不完全符合时，在这里写下你的想法…" disabled={pending} />
      </label>
      <div className="user-input-actions">
        <span>{pending ? '正在提交…' : '可选择选项，也可补充自己的描述。'}</span>
        <button type="submit" className="button button-primary" disabled={pending}>{pending ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{pending ? '正在提交' : '提交回答'}</button>
      </div>
    </form>
  )
}

function TimelineItem({ item, onDecision, onQuestion, runId, actionable, pending, resolution, question, questionPending, questionResolution, isLatestFinal }) {
  const isUser = item.agentId === 'user'
  const isFinal = item.kind === 'message' && item.agentId === 'codex' && isLatestFinal
  const isProcess = item.kind === 'tool' || item.kind === 'progress'
  const meta = AGENT_META[item.agentId] || AGENT_META.codex
  const needsDecision = item.kind === 'approval'
  const needsInput = item.kind === 'input'

  return (
    <article
      className={`timeline-item${isUser ? ' from-user' : ''}${isFinal ? ' is-final' : ''}${isProcess ? ' is-process' : ''}${item.state === 'error' ? ' has-error' : ''}${needsDecision ? ' is-approval' : ''}${needsInput ? ' is-input' : ''}`}
      data-pending-approval={needsDecision && actionable ? 'true' : undefined}
      data-pending-input={needsInput && question ? 'true' : undefined}
    >
      <div className="timeline-avatar">
        {isUser ? <span className="user-avatar">你</span> : <AgentAvatar id={item.agentId} />}
      </div>
      <div className="timeline-content">
        <div className="timeline-meta">
          <strong>{isUser ? '你' : meta.name}</strong>
          {isUser && <span className="event-type message-type">你的消息</span>}
          {isFinal && <span className="event-type final-type">最终答复</span>}
          {isProcess && <span className="event-type process-type">执行过程</span>}
          {item.kind === 'approval' && <span className="event-type approval-type">{actionable ? '待你确认' : '确认记录'}</span>}
          {needsInput && <span className="event-type input-type">需要你的选择</span>}
          <time>{timeLabel(item.createdAt)}</time>
        </div>
        <div className="timeline-body">
          <strong className="timeline-title">{item.title}</strong>
          {item.body && (isUser ? <p>{item.body}</p> : <div className="timeline-markdown"><MarkdownContent>{item.body}</MarkdownContent></div>)}
        </div>
        {item.details && (
          <details className="timeline-details">
            <summary>{needsDecision ? '展开请求详情' : '展开原始内容'}</summary>
            <pre>{item.details}</pre>
          </details>
        )}
        {needsDecision && item.approvalId && resolution && (
          <p className="approval-resolution">{resolution === 'accept' ? '已允许本次操作' : '已拒绝此操作'}</p>
        )}
        {needsDecision && item.approvalId && actionable && !resolution && (
          <div className="approval-actions">
            {pending && <span className="approval-pending" role="status">正在提交确认</span>}
            <button type="button" className="button button-subtle" disabled={pending} onClick={() => onDecision(runId, item.approvalId, 'decline')}>
              拒绝
            </button>
            {item.canAccept !== false && (
              <button type="button" className="button button-primary" disabled={pending} onClick={() => onDecision(runId, item.approvalId, 'accept')}>
                {pending ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} {pending ? '正在提交' : '允许一次'}
              </button>
            )}
          </div>
        )}
        {needsDecision && item.approvalId && !actionable && !resolution && (
          <p className="approval-expired">此确认已结束，或原会话已恢复。</p>
        )}
        {needsInput && question && <UserInputCard question={question} pending={questionPending} onSubmit={onQuestion} />}
        {needsInput && questionResolution && <p className="approval-resolution">已提交你的回答，团队正在继续处理。</p>}
        {needsInput && !question && !questionResolution && <p className="approval-expired">此问题已结束，或工作台重启后无法恢复。</p>}
      </div>
    </article>
  )
}

function PlanReview({ run, busy, onAction }) {
  const [note, setNote] = useState('')
  if (!run?.plan || run.phase !== 'staged') return null
  return (
    <section className="plan-review" aria-label="执行计划">
      <div className="plan-review-heading"><div><span className="overline">执行计划</span><h2>等待你的确认</h2></div><StatePill status="staged" /></div>
      <p>{run.plan.summary}</p>
      <div className="plan-member-row">{run.plan.members?.filter(member => member.enabled).map(member => <span key={member.id}>{member.id === 'deepseek' ? 'DeepSeek' : member.id === 'doubao' ? '豆包' : 'Codex'} · {member.role}</span>)}</div>
      <p className="plan-scope">工作区：{run.plan.writeMode === 'workspace-write' ? '允许按范围修改' : '只读'}</p>
      <textarea value={note} onChange={event => setNote(event.target.value)} maxLength={4000} rows={2} placeholder="可选：补充执行要求；若要求修改计划，请说明原因。" disabled={busy} />
      <div className="plan-actions">
        <button type="button" className="button button-subtle" disabled={busy} onClick={() => onAction('discard', note)}>放弃</button>
        <button type="button" className="button button-subtle" disabled={busy || !note.trim()} onClick={() => onAction('revise', note)}>要求修改</button>
        <button type="button" className="button button-primary" disabled={busy} onClick={() => onAction('approve', note)}>{busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />} 批准并执行</button>
      </div>
    </section>
  )
}

function AuditPanel({ run, events, loading, error, onRefresh, onClose }) {
  const [actor, setActor] = useState('all')
  const [type, setType] = useState('all')
  const visible = events.filter(event => (actor === 'all' || event.actor === actor) && (type === 'all' || event.type === type))
  const actors = [...new Set(events.map(event => event.actor).filter(Boolean))]
  const types = [...new Set(events.map(event => event.type).filter(Boolean))]
  return <aside className="utility-panel" aria-label="审计记录">
    <div className="utility-header"><div><span className="overline">审计记录</span><h2>任务历史</h2></div><button type="button" className="icon-button small" onClick={onClose} aria-label="关闭审计记录"><X size={16} /></button></div>
    <div className="audit-filters"><label>成员<select value={actor} onChange={event => setActor(event.target.value)}><option value="all">全部</option>{actors.map(value => <option key={value} value={value}>{value}</option>)}</select></label><label>事件<select value={type} onChange={event => setType(event.target.value)}><option value="all">全部</option>{types.map(value => <option key={value} value={value}>{value}</option>)}</select></label><button type="button" className="icon-button small" onClick={onRefresh} aria-label="刷新审计记录" title="刷新"><RefreshCw size={15} className={loading ? 'spin' : ''} /></button></div>
    {error && <p className="utility-error">{error}</p>}
    <ol className="audit-list">{visible.slice().reverse().map(event => <li key={`${event.seq}-${event.ts}`}><strong>#{event.seq} · {event.type}</strong><span>{event.actor || 'system'} · {timeLabel(event.ts)}</span>{event.taskId && <small>任务：{event.taskId}</small>}</li>)}</ol>
    {!loading && !visible.length && <div className="quiet-empty">尚无匹配的审计事件</div>}
  </aside>
}

function MailboxPanel({ run, busy, onSend, onClose }) {
  const [to, setTo] = useState('codex')
  const [body, setBody] = useState('')
  const [error, setError] = useState('')
  const submit = async event => { event.preventDefault(); if (!body.trim()) return; setError(''); try { await onSend({ to, body: body.trim() }); setBody('') } catch (requestError) { setError(requestError.message) } }
  return <aside className="utility-panel" aria-label="成员留言">
    <div className="utility-header"><div><span className="overline">成员邮箱</span><h2>团队留言</h2></div><button type="button" className="icon-button small" onClick={onClose} aria-label="关闭成员留言"><X size={16} /></button></div>
    <ol className="mailbox-list">{(run?.mailbox || []).slice().reverse().map(message => <li key={message.messageId}><strong>{message.from === 'human' ? '你' : message.from} → {message.to === 'human' ? '你' : message.to}</strong><p>{message.body}</p><time>{timeLabel(message.createdAt)}</time></li>)}</ol>
    {!run?.mailbox?.length && <div className="quiet-empty">尚无团队留言</div>}
    <form className="mailbox-form" onSubmit={submit}><label>发送给<select value={to} onChange={event => setTo(event.target.value)} disabled={busy}><option value="codex">Codex</option><option value="deepseek">DeepSeek</option><option value="doubao">豆包</option></select></label><textarea value={body} onChange={event => setBody(event.target.value)} maxLength={8000} rows={3} placeholder="留下可追踪的任务说明或问题…" disabled={busy} />{error && <p className="utility-error">{error}</p>}<button type="submit" className="button button-primary" disabled={busy || !body.trim()}><Mail size={15} />发送留言</button></form>
  </aside>
}

function AgentInspector({ agentId, health, run, activityOpen, checking, onRefresh, onSelect, onClose }) {
  const meta = AGENT_META[agentId]
  const agent = run?.agents?.[agentId]
  const check = health?.agents?.find(item => item.id === agentId)
  const status = agent?.status || 'idle'
  const events = run?.timeline?.filter(item => item.agentId === agentId).slice(-6).reverse() || []

  return (
    <aside id="member-inspector" className="inspector-pane" aria-label="团队分工">
      <div className="inspector-header">
        <div>
          <span className="overline">团队成员</span>
          <h2>团队分工</h2>
        </div>
        <div className="inspector-actions">
          <button type="button" className="icon-button small" onClick={onRefresh} aria-label="刷新成员连接状态" title="刷新成员连接状态" disabled={checking}>
            <RefreshCw size={16} className={checking ? 'spin' : ''} />
          </button>
          <button type="button" className="icon-button inspector-close" onClick={onClose} aria-label="收起团队分工">
            <PanelRightClose size={18} />
          </button>
        </div>
      </div>

      <div className="team-member-list" aria-label="成员列表">
        {Object.keys(AGENT_META).map(id => (
          <TeamMemberButton
            key={id}
            id={id}
            health={health?.agents?.find(item => item.id === id)}
            runAgent={run?.agents?.[id]}
            selected={agentId === id}
            activityOpen={activityOpen}
            onSelect={onSelect}
          />
        ))}
      </div>

      {activityOpen && (
        <div id="member-activity" className="member-activity-panel">
          <div className={`member-summary accent-${meta.accent}`}>
            <div className="member-name-row">
              <AgentAvatar id={agentId} size="large" />
              <div>
                <h3>{meta.name}</h3>
                <span>{meta.role}</span>
              </div>
            </div>
            <p className="member-description">{meta.focus}</p>
            <div className="member-status-row">
              <span>本轮状态</span>
              <StatePill status={status} />
            </div>
            <p className="member-description">{agent?.activity || '当前任务尚未调用此成员。'}</p>
          </div>

          <section className="inspector-section">
            <div className="section-label-row">
              <h3>本轮活动</h3>
              <span>{events.length}</span>
            </div>
            {events.length ? (
              <ol className="member-activity-list">
                {events.map(event => (
                  <li key={event.id}>
                    <span className={`activity-mark mark-${event.state}`} />
                    <div>
                      <strong>{event.title}</strong>
                      <p>{event.body || '无附加内容'}</p>
                      <time>{timeLabel(event.createdAt)}</time>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="quiet-empty">尚无成员活动</div>
            )}
          </section>

          <section className="inspector-section connection-section">
            <div className="section-label-row">
              <h3>连接状态</h3>
              <StatePill status={check?.status || 'unchecked'} />
            </div>
            <p>{check?.detail || '尚未检查连接。'}</p>
            {check?.version && <code>{check.version}</code>}
            {agentId === 'deepseek' && agent?.sessionId && (
              <div className="session-line"><span>DSH 会话</span><code>{agent.sessionId}</code></div>
            )}
            {agentId === 'doubao' && agent?.runId && (
              <div className="session-line"><span>运行 ID</span><code>{agent.runId}</code></div>
            )}
            {agentId === 'doubao' && agent?.conversationId && (
              <div className="session-line"><span>豆包会话</span><code>{agent.conversationId}</code></div>
            )}
          </section>
        </div>
      )}
    </aside>
  )
}

function App() {
  const [health, setHealth] = useState(null)
  const [runs, setRuns] = useState([])
  const [activeRunId, setActiveRunId] = useState(null)
  const [selectedAgentId, setSelectedAgentId] = useState('codex')
  const [workspace, setWorkspace] = useState(() => localStorage.getItem('agent-team.workspace') || DEFAULT_WORKSPACE)
  const [drafts, setDrafts] = useState({})
  const [allowWrites, setAllowWrites] = useState(true)
  const [busy, setBusy] = useState(false)
  const [pendingApprovals, setPendingApprovals] = useState({})
  const [resolvedApprovals, setResolvedApprovals] = useState({})
  const [pendingQuestions, setPendingQuestions] = useState({})
  const [resolvedQuestions, setResolvedQuestions] = useState({})
  const [error, setError] = useState('')
  const [inspectorOpen, setInspectorOpen] = useState(() => window.matchMedia('(min-width: 1181px)').matches)
  const [activityOpen, setActivityOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [stopping, setStopping] = useState(false)
  const [planBusy, setPlanBusy] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [utilityPanel, setUtilityPanel] = useState(null)
  const [auditEvents, setAuditEvents] = useState([])
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditError, setAuditError] = useState('')
  const [mailBusy, setMailBusy] = useState(false)
  const timelineRef = useRef(null)
  const inputRef = useRef(null)
  const navigationToggleRef = useRef(null)
  const approvalGuardRef = useRef(new Set())
  const shouldAutoScrollRef = useRef(true)
  const [hasNewActivity, setHasNewActivity] = useState(false)

  const selectedRun = useMemo(() => runs.find(run => run.id === activeRunId) || null, [runs, activeRunId])
  const isRunActive = ACTIVE_STATES.has(selectedRun?.status)
  const draftKey = activeRunId || NEW_DRAFT_KEY
  const prompt = drafts[draftKey] || ''
  const setPrompt = value => setDrafts(previous => ({ ...previous, [draftKey]: value }))

  const upsertRun = useCallback(run => {
    setRuns(previous => {
      const exists = previous.some(item => item.id === run.id)
      const next = exists ? previous.map(item => item.id === run.id ? run : item) : [run, ...previous]
      return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    })
  }, [])

  const loadHealth = useCallback(async () => {
    setChecking(true)
    try {
      const response = await fetch('/api/health')
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '无法检查本机连接。')
      setHealth(data)
      setError(current => current.startsWith('成员连接检查失败：') ? '' : current)
    } catch (requestError) {
      setError(`成员连接检查失败：${requestError.message}`)
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    let mounted = true
    fetch('/api/runs')
      .then(response => response.json())
      .then(data => {
        if (!mounted) return
        const loaded = Array.isArray(data) ? data : []
        setRuns(loaded)
        if (loaded[0]) setActiveRunId(loaded[0].id)
      })
      .catch(requestError => mounted && setError(requestError.message))
    loadHealth()
    const refresh = setInterval(loadHealth, 60_000)
    const source = new EventSource('/api/events')
    source.addEventListener('snapshot', event => {
      const data = JSON.parse(event.data)
      if (mounted && Array.isArray(data.runs)) setRuns(previous => {
        const merged = new Map([...previous, ...data.runs].map(run => [run.id, run]))
        return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      })
    })
    source.addEventListener('run.deleted', event => {
      const { runId } = JSON.parse(event.data)
      if (!mounted) return
      setRuns(previous => {
        const next = previous.filter(run => run.id !== runId)
        setActiveRunId(current => current === runId ? (next[0]?.id || null) : current)
        return next
      })
    })
    const receiveRun = event => {
      const data = JSON.parse(event.data)
      if (mounted && data.run) upsertRun(data.run)
    }
    source.addEventListener('run.updated', receiveRun)
    source.addEventListener('run.delta', receiveRun)
    source.onopen = () => setError(current => current.startsWith('与本机工作台服务的实时连接中断') ? '' : current)
    source.onerror = () => setError('与本机工作台服务的实时连接中断，浏览器正在重连。')
    return () => {
      mounted = false
      clearInterval(refresh)
      source.close()
    }
  }, [loadHealth, upsertRun])

  useEffect(() => {
    localStorage.setItem('agent-team.workspace', workspace)
  }, [workspace])

  useEffect(() => {
    if (!selectedRun) return
    setWorkspace(selectedRun.workspace)
    setAllowWrites(selectedRun.allowWrites)
  }, [selectedRun?.id])

  useEffect(() => {
    shouldAutoScrollRef.current = true
    setHasNewActivity(false)
  }, [selectedRun?.id])

  useEffect(() => {
    if (!timelineRef.current) return
    if (shouldAutoScrollRef.current) {
      timelineRef.current.scrollTop = timelineRef.current.scrollHeight
      setHasNewActivity(false)
    } else {
      setHasNewActivity(true)
    }
  }, [selectedRun?.id, selectedRun?.timeline?.length, selectedRun?.streamingText])

  useEffect(() => {
    if (!sidebarOpen && !inspectorOpen) return undefined
    const closeOnEscape = event => {
      if (event.key !== 'Escape') return
      if (sidebarOpen) {
        setSidebarOpen(false)
        navigationToggleRef.current?.focus()
      } else {
        setInspectorOpen(false)
        setActivityOpen(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [sidebarOpen, inspectorOpen])

  const handleTimelineScroll = () => {
    const element = timelineRef.current
    if (!element) return
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 56
    shouldAutoScrollRef.current = nearBottom
    if (nearBottom) setHasNewActivity(false)
  }

  const scrollToLatest = () => {
    const element = timelineRef.current
    if (!element) return
    shouldAutoScrollRef.current = true
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
    setHasNewActivity(false)
  }

  const scrollToPendingApproval = () => {
    const item = timelineRef.current?.querySelector('[data-pending-input="true"], [data-pending-approval="true"]')
    if (item) item.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const submitPrompt = async event => {
    event.preventDefault()
    const text = prompt.trim()
    if (!text || busy) return
    setBusy(true)
    setError('')
    try {
      const endpoint = selectedRun ? `/api/runs/${selectedRun.id}/messages` : '/api/runs'
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, workspace, allowWrites }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '任务没有提交成功。')
      upsertRun(data)
      setActiveRunId(data.id)
      setDrafts(previous => ({ ...previous, [draftKey]: '' }))
    } catch (requestError) {
      setError(`任务提交失败：${requestError.message}`)
    } finally {
      setBusy(false)
    }
  }

  const handleDecision = async (runId, approvalId, decision) => {
    const key = `${runId}:${approvalId}`
    if (approvalGuardRef.current.has(key)) return
    approvalGuardRef.current.add(key)
    setPendingApprovals(previous => ({ ...previous, [key]: true }))
    setError('')
    try {
      const response = await fetch(`/api/runs/${runId}/approvals/${encodeURIComponent(approvalId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '确认没有提交成功。')
      upsertRun(data)
      setResolvedApprovals(previous => ({ ...previous, [key]: decision }))
    } catch (requestError) {
      setError(`操作确认失败：${requestError.message}`)
    } finally {
      approvalGuardRef.current.delete(key)
      setPendingApprovals(previous => ({ ...previous, [key]: false }))
    }
  }

  const handleQuestion = async (questionId, payload) => {
    if (!selectedRun) return
    const key = `${selectedRun.id}:${questionId}`
    if (pendingQuestions[key]) return
    setPendingQuestions(previous => ({ ...previous, [key]: true }))
    setError('')
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}/questions/${encodeURIComponent(questionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '回答没有提交成功。')
      upsertRun(data)
      setResolvedQuestions(previous => ({ ...previous, [key]: true }))
    } catch (requestError) {
      setError(`提交回答失败：${requestError.message}`)
    } finally {
      setPendingQuestions(previous => ({ ...previous, [key]: false }))
    }
  }

  const removeRun = async run => {
    if (ACTIVE_STATES.has(run.status)) return
    if (!window.confirm(`永久删除“${run.title || '未命名任务'}”的工作台对话记录？此操作无法在工作台中恢复，不会删除工作区文件。`)) return
    setError('')
    try {
      const response = await fetch(`/api/runs/${run.id}`, { method: 'DELETE' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '任务记录没有删除成功。')
      setRuns(previous => {
        const next = previous.filter(item => item.id !== run.id)
        setActiveRunId(current => current === run.id ? (next[0]?.id || null) : current)
        return next
      })
    } catch (requestError) {
      setError(`删除任务失败：${requestError.message}`)
    }
  }

  const saveTitle = async () => {
    if (!selectedRun) return
    const title = titleDraft.replace(/\s+/g, ' ').trim()
    if (!title) {
      setError('标题不能为空。')
      return
    }
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '标题没有保存成功。')
      upsertRun(data)
      setEditingTitle(false)
    } catch (requestError) { setError(`修改标题失败：${requestError.message}`) }
  }

  const stopCurrentRun = async () => {
    if (!selectedRun || stopping) return
    if (!window.confirm('停止 Codex、DeepSeek 和豆包正在进行的工作？已经完成的文件修改不会撤销。')) return
    setStopping(true)
    setError('')
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}/stop`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '停止请求没有完成。')
      upsertRun(data)
    } catch (requestError) { setError(`停止任务失败：${requestError.message}`) } finally { setStopping(false) }
  }

  const handlePlanAction = async (action, note) => {
    if (!selectedRun || planBusy) return
    setPlanBusy(true); setError('')
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, note }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '计划操作没有完成。')
      upsertRun(data)
    } catch (requestError) { setError(`计划操作失败：${requestError.message}`) } finally { setPlanBusy(false) }
  }

  const resumeCurrentRun = async () => {
    if (!selectedRun || resuming) return
    const reason = window.prompt('请说明恢复任务的原因或新的执行要求：')?.trim()
    if (!reason) return
    setResuming(true); setError('')
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '恢复任务没有完成。')
      upsertRun(data)
    } catch (requestError) { setError(`恢复任务失败：${requestError.message}`) } finally { setResuming(false) }
  }

  const loadAudit = useCallback(async () => {
    if (!selectedRun) return
    setAuditLoading(true); setAuditError('')
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}/events?since=0`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '无法读取审计记录。')
      setAuditEvents(data.events || [])
    } catch (requestError) { setAuditError(requestError.message) } finally { setAuditLoading(false) }
  }, [selectedRun?.id])

  const openAudit = () => { setUtilityPanel('audit'); void loadAudit() }
  const sendMail = async ({ to, body }) => {
    if (!selectedRun || mailBusy) return
    setMailBusy(true)
    try {
      const response = await fetch(`/api/runs/${selectedRun.id}/mailbox`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'human', to, body }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '留言没有发送成功。')
      const refreshed = await fetch(`/api/runs/${selectedRun.id}`).then(result => result.json())
      upsertRun(refreshed)
    } finally { setMailBusy(false) }
  }

  const startNewRun = () => {
    setActiveRunId(null)
    setSidebarOpen(false)
    setSelectedAgentId('codex')
    setActivityOpen(false)
    setAllowWrites(true)
    inputRef.current?.focus()
  }

  const selectRun = runId => {
    setActiveRunId(runId)
    setSidebarOpen(false)
    setEditingTitle(false)
    window.requestAnimationFrame(() => navigationToggleRef.current?.focus())
  }

  const closeSidebar = () => {
    setSidebarOpen(false)
    window.requestAnimationFrame(() => navigationToggleRef.current?.focus())
  }

  const selectAgent = agentId => {
    const shouldCloseActivity = selectedAgentId === agentId && activityOpen
    setSelectedAgentId(agentId)
    setInspectorOpen(true)
    setActivityOpen(!shouldCloseActivity)
  }

  const toggleInspector = () => {
    setInspectorOpen(open => {
      if (open) setActivityOpen(false)
      return !open
    })
  }

  const closeInspector = () => {
    setInspectorOpen(false)
    setActivityOpen(false)
  }

  const activeRuns = runs.filter(run => ACTIVE_STATES.has(run.status))
  const recentRuns = runs.filter(run => !ACTIVE_STATES.has(run.status))
  const activeCount = activeRuns.length
  const pendingApprovalTotal = runs.reduce((total, run) => total + (run.approvals?.length || 0) + (run.questions?.length || 0), 0)
  const approvalCount = selectedRun?.approvals?.length || 0
  const questionCount = selectedRun?.questions?.length || 0
  const latestFinalMessageId = !isRunActive && !selectedRun?.streamingText
    ? selectedRun?.timeline?.slice().reverse().find(item => item.kind === 'message' && item.agentId === 'codex')?.id
    : null
  const renderRunLink = run => (
    <div className="run-entry" key={run.id}>
      <button
        type="button"
        className={`run-link${activeRunId === run.id ? ' selected-run' : ''}`}
        onClick={() => selectRun(run.id)}
        aria-current={activeRunId === run.id ? 'page' : undefined}
      >
        <span className={`run-mark run-${run.status}`} aria-hidden="true" />
        <span className="run-link-copy">
          <strong>{run.title || '未命名任务'}</strong>
          <small>{timeLabel(run.createdAt)} · {getStatusLabel(run.status)}</small>
        </span>
      </button>
      {!ACTIVE_STATES.has(run.status) && (
        <button type="button" className="icon-button tiny run-delete" onClick={() => removeRun(run)} aria-label={`删除任务：${run.title || '未命名任务'}`} title="删除本地任务记录">
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )

  return (
    <div className={`app-shell${inspectorOpen ? ' with-inspector' : ' inspector-closed'}`}>
      {sidebarOpen && <button type="button" className="sidebar-scrim" onClick={closeSidebar} aria-label="关闭任务导航" />}
      <aside id="task-navigation" className={`navigation-rail${sidebarOpen ? ' mobile-open' : ''}`} aria-label="任务导航">
        <div className="brand-row">
          <span className="brand-mark"><Command size={18} /></span>
          <span className="brand-name">Agent Team</span>
          <span className="local-label">本机</span>
          <button type="button" className="icon-button mobile-nav-close" onClick={closeSidebar} aria-label="关闭任务导航">
            <X size={17} />
          </button>
        </div>

        <button type="button" className="new-run-button" onClick={startNewRun}>
          <Plus size={17} /> 新建协作任务
        </button>

        <div className="navigation-overview" aria-label="任务概览">
          <div><span>进行中</span><strong>{activeCount}</strong></div>
          <div className={pendingApprovalTotal ? 'has-pending' : ''}><span>待确认</span><strong>{pendingApprovalTotal}</strong></div>
        </div>

        <div className="recent-header">
          <div className="nav-group-label">进行中</div>
          <button type="button" className="icon-button tiny" onClick={startNewRun} aria-label="新增任务">
            <Plus size={15} />
          </button>
        </div>
        <div className="run-list">
          {activeRuns.length ? activeRuns.map(renderRunLink) : <p className="no-runs">没有进行中的任务</p>}
        </div>

        <div className="recent-header completed-header">
          <div className="nav-group-label">最近记录</div>
          <span className="nav-count">{recentRuns.length}</span>
        </div>
        <div className="run-list recent-run-list">
          {recentRuns.length ? recentRuns.map(renderRunLink) : <p className="no-runs">完成的任务会显示在这里</p>}
        </div>

        <div className="nav-footer">
          <div className="workspace-path-label"><FolderOpen size={14} /> 工作区</div>
          <span title={workspace}>{workspace || '未选择目录'}</span>
          <div className="footer-connection">
            <span><Activity size={13} /> 成员连接{health?.checkedAt ? ` · ${timeLabel(health.checkedAt)}` : ''}</span>
            <button type="button" className="icon-button tiny" onClick={loadHealth} aria-label="刷新成员连接状态" title="刷新成员连接状态" disabled={checking}>
              <RefreshCw size={14} className={checking ? 'spin' : ''} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main-column">
        <header className="topbar">
          <div className="breadcrumb">
            <button type="button" className="icon-button mobile-nav-toggle" ref={navigationToggleRef} onClick={() => setSidebarOpen(true)} aria-label="打开任务导航" aria-controls="task-navigation" aria-expanded={sidebarOpen}>
              <Menu size={18} />
            </button>
            <span>工作台</span>
            <span className="breadcrumb-separator">/</span>
            <strong>{selectedRun?.title || '新建协作任务'}</strong>
          </div>
          <div className="topbar-actions">
            <button type="button" className="icon-button mobile-new-run" onClick={startNewRun} aria-label="新建任务" title="新建任务">
              <Plus size={18} />
            </button>
            <span className="local-status">本机工作台</span>
            <button
              type="button"
              className="icon-button"
              onClick={toggleInspector}
              aria-label={inspectorOpen ? '收起团队分工' : '展开团队分工'}
              title={inspectorOpen ? '收起团队分工' : '展开团队分工'}
            >
              {inspectorOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
            </button>
          </div>
        </header>

        <section className="run-heading">
          <div className="run-heading-copy">
            <div className="run-title-line">
              {editingTitle ? (
                <form className="title-editor" onSubmit={event => { event.preventDefault(); void saveTitle() }}>
                  <input value={titleDraft} onChange={event => setTitleDraft(event.target.value)} maxLength={120} autoFocus aria-label="任务标题" />
                  <button type="submit" className="icon-button small" aria-label="保存标题" title="保存标题"><Check size={16} /></button>
                  <button type="button" className="icon-button small" onClick={() => setEditingTitle(false)} aria-label="取消编辑标题" title="取消"><X size={16} /></button>
                </form>
              ) : <>
                <h1 title={selectedRun?.title}>{selectedRun?.title || '新建协作任务'}</h1>
                {selectedRun && <button type="button" className="icon-button small title-edit" onClick={() => { setTitleDraft(selectedRun.title || ''); setEditingTitle(true) }} aria-label="修改任务标题" title="修改任务标题"><Pencil size={15} /></button>}
              </>}
              {selectedRun && <StatePill status={selectedRun.status} />}
            </div>
            <div className="run-meta-line">
              <span><FolderOpen size={13} /> {selectedRun?.workspace || workspace}</span>
              {selectedRun?.createdAt && <span><Clock3 size={13} /> {new Date(selectedRun.createdAt).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })}</span>}
            </div>
          </div>
          <div className="run-heading-actions">
            {STOPPABLE_STATES.has(selectedRun?.status) && <button type="button" className="button button-stop" onClick={stopCurrentRun} disabled={stopping} title="停止三个成员当前正在进行的工作">{stopping ? <LoaderCircle size={15} className="spin" /> : <Square size={14} />} {stopping ? '正在停止' : '停止任务'}</button>}
            {selectedRun?.status === 'halted' && <button type="button" className="button button-primary" onClick={resumeCurrentRun} disabled={resuming} title="恢复任务需要填写原因">{resuming ? <LoaderCircle size={15} className="spin" /> : <Play size={14} />} {resuming ? '正在恢复' : '恢复任务'}</button>}
            {selectedRun && <button type="button" className="icon-button" onClick={() => setUtilityPanel('mailbox')} aria-label="打开成员邮箱" title="成员邮箱"><Mail size={17} /></button>}
            {selectedRun && <button type="button" className="icon-button" onClick={openAudit} aria-label="查看审计记录" title="审计记录"><FileSearch size={17} /></button>}
            {selectedRun?.threadId && <span className="thread-token">Codex thread · {selectedRun.threadId.slice(0, 8)}</span>}
          </div>
        </section>

        <ErrorNotice message={error} onClose={() => setError('')} />

        <PlanReview run={selectedRun} busy={planBusy} onAction={handlePlanAction} />

        {(approvalCount > 0 || questionCount > 0) && (
          <div className="approval-banner" role="status">
            <ShieldCheck size={17} aria-hidden="true" />
            <span><strong>{questionCount ? `${questionCount} 个问题` : `${approvalCount} 项操作`}</strong>{questionCount ? '等待你的回答' : '等待你的确认'}</span>
            <button type="button" className="text-button" onClick={scrollToPendingApproval}>{questionCount ? '查看问题' : '查看确认项'}</button>
          </div>
        )}

        <section className="conversation-pane">
          <div className="timeline" ref={timelineRef} onScroll={handleTimelineScroll} aria-label="任务活动">
            {!selectedRun ? (
              <div className="empty-state">
                <span className="empty-state-icon"><Sparkles size={20} /></span>
                <h2>准备新的协作任务</h2>
                <p>先写下目标，成员分工和本轮活动显示在右侧。</p>
              </div>
            ) : (
              <>
                {selectedRun.timeline?.filter(item => item.kind !== 'notification').map(item => (
                  <TimelineItem
                    key={item.id}
                    item={item}
                    runId={selectedRun.id}
                    onDecision={handleDecision}
                    onQuestion={handleQuestion}
                    actionable={selectedRun.approvals?.some(approval => String(approval.id) === String(item.approvalId))}
                    pending={pendingApprovals[`${selectedRun.id}:${item.approvalId}`]}
                    resolution={resolvedApprovals[`${selectedRun.id}:${item.approvalId}`]}
                    question={selectedRun.questions?.find(question => String(question.id) === String(item.questionId))}
                    questionPending={pendingQuestions[`${selectedRun.id}:${item.questionId}`]}
                    questionResolution={resolvedQuestions[`${selectedRun.id}:${item.questionId}`]}
                    isLatestFinal={item.id === latestFinalMessageId}
                  />
                ))}
                {selectedRun.streamingText && (
                  <article className="timeline-item is-final is-streaming">
                    <div className="timeline-avatar"><AgentAvatar id="codex" /></div>
                    <div className="timeline-content">
                      <div className="timeline-meta"><strong>Codex</strong><span className="event-type final-type">正在回复</span></div>
                      <div className="timeline-body streaming-text"><div className="timeline-markdown"><MarkdownContent>{selectedRun.streamingText}</MarkdownContent></div><span className="typing-caret" /></div>
                    </div>
                  </article>
                )}
                {ACTIVE_STATES.has(selectedRun.status) && (
                  <div className="running-row" role="status" aria-live="polite">{selectedRun.status !== 'staged' && selectedRun.status !== 'halted' && <LoaderCircle size={15} className="spin" />}<span>{selectedRun.status === 'staged' ? '等待你确认执行计划' : selectedRun.status === 'halted' ? '任务已暂停，填写原因后可恢复' : selectedRun.status === 'waiting_input' ? '等待你回答问题' : selectedRun.status === 'waiting_approval' ? '等待你确认操作' : '团队正在工作'}</span></div>
                )}
                {!selectedRun.timeline?.some(item => item.kind !== 'notification') && <div className="quiet-empty">任务已建立，正在等待 Codex 事件。</div>}
              </>
            )}
            {hasNewActivity && <button type="button" className="new-activity-button" onClick={scrollToLatest}><ArrowDown size={15} /> 有新动态</button>}
          </div>

          <form className="composer" onSubmit={submitPrompt}>
            <div className="composer-workspace-row">
              <label className="workspace-picker">
                <FolderOpen size={15} />
                <span>工作区</span>
                <input value={workspace} onChange={event => setWorkspace(event.target.value)} aria-label="工作区路径" spellCheck="false" placeholder="C:\\Projects\\my-app" disabled={Boolean(selectedRun)} />
              </label>
              <label className={`write-toggle${allowWrites ? ' enabled' : ''}`} title="允许 Codex、DeepSeek 和豆包在当前工作区内按分配范围修改文件。危险操作仍会要求确认。">
                <input type="checkbox" checked={allowWrites} disabled={Boolean(selectedRun)} onChange={event => setAllowWrites(event.target.checked)} />
                <span className="toggle-track" />
                <ShieldCheck size={14} />
                <span>允许修改工作区</span>
              </label>
            </div>
            <div className="composer-input-row">
              <textarea
                ref={inputRef}
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                    event.preventDefault()
                    event.currentTarget.form?.requestSubmit()
                  }
                }}
                placeholder={isRunActive ? '团队运行中，可先写下补充内容…' : selectedRun ? '继续这个任务…' : '描述你希望团队完成的任务…'}
                rows={3}
                maxLength={30_000}
                disabled={busy}
                aria-label="任务内容"
              />
              <button type="submit" className="send-button" disabled={!prompt.trim() || busy || !workspace.trim()} aria-label={selectedRun ? (isRunActive ? '追加任务指引' : '发送补充内容') : '开始团队任务'} title={selectedRun ? (isRunActive ? '向当前任务追加指引' : '发送补充内容') : '开始协作'}>
                {busy ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={18} />}
              </button>
            </div>
            <div className="composer-footnote">
              <span>{allowWrites ? '三名成员可在工作区内按分配范围修改文件；危险操作仍需确认。' : '只读模式 · 团队不会修改工作区。'}</span>
              <span><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行 · {prompt.length.toLocaleString()} / 30,000</span>
            </div>
          </form>
        </section>
      </main>

      {inspectorOpen && <button type="button" className="inspector-scrim" onClick={closeInspector} aria-label="关闭团队分工" />}
      {inspectorOpen && (
        <AgentInspector
          agentId={selectedAgentId}
          health={health}
          run={selectedRun}
          activityOpen={activityOpen}
          checking={checking}
          onRefresh={loadHealth}
          onSelect={selectAgent}
          onClose={closeInspector}
        />
      )}
      {utilityPanel === 'audit' && <AuditPanel run={selectedRun} events={auditEvents} loading={auditLoading} error={auditError} onRefresh={loadAudit} onClose={() => setUtilityPanel(null)} />}
      {utilityPanel === 'mailbox' && <MailboxPanel run={selectedRun} busy={mailBusy} onSend={sendMail} onClose={() => setUtilityPanel(null)} />}
    </div>
  )
}

export default App
