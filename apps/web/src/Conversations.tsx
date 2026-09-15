import {useEffect, useRef, useState, type ReactNode} from 'react';
import {ArrowRight, ArrowUp, LoaderCircle, MessageSquare, Monitor, Plus, RefreshCw, ShieldCheck, Trash2} from 'lucide-react';
import {dateTime, errorMessage, type Answer, type Api, type Device, type Range} from './api';

interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  scope: Range & {timeZone?: string};
}
interface ConversationTurn {
  id: string;
  question: string;
  result: Answer;
  createdAt: string;
  evidenceDeleted?: boolean;
}
interface Conversation extends ConversationSummary {turns: ConversationTurn[]}
interface HistoryPage {items: ConversationSummary[]; nextCursor?: string | null}

export function Conversations({api, configured, devices, range, renderAnswer}: {
  api: Api;
  configured: boolean;
  devices: Device[];
  range: Range;
  renderAnswer: (answer: Answer) => ReactNode;
}) {
  const [items, setItems] = useState<ConversationSummary[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [question, setQuestion] = useState(''), [selectedDevice, setSelectedDevice] = useState('');
  const [busy, setBusy] = useState(false), [opening, setOpening] = useState(false), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [historyError, setHistoryError] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState(''), [confirmDelete, setConfirmDelete] = useState(false);
  const operation = useRef<AbortController | null>(null), historyRequest = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);

  async function loadHistory(next?: string) {
    historyRequest.current?.abort();
    const controller = new AbortController(); historyRequest.current = controller;
    setLoading(true); setHistoryError('');
    try {
      const page = await api.request<HistoryPage>(`/api/conversations?limit=30${next ? `&cursor=${encodeURIComponent(next)}` : ''}`, {signal: controller.signal});
      if (controller.signal.aborted) return;
      setItems(previous => next ? [...previous, ...page.items.filter(item => !previous.some(existing => existing.id === item.id))] : page.items);
      setCursor(page.nextCursor ?? null);
    } catch (e) { if (!controller.signal.aborted) setHistoryError(errorMessage(e)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    void loadHistory();
    return () => {operation.current?.abort(); historyRequest.current?.abort();};
  }, [api]);
  useEffect(() => {if (conversation?.turns.length) end.current?.scrollIntoView({block: 'nearest'});}, [conversation?.id, conversation?.turns.length]);

  async function open(id: string) {
    if (busy) return;
    operation.current?.abort();
    const controller = new AbortController(); operation.current = controller;
    setOpening(true); setError(''); setConfirmDelete(false); setQuestion(''); setPendingQuestion('');
    // Clear the old answer immediately, so a failed read cannot be mistaken for the selected conversation.
    setConversation(null);
    try {
      const result = await api.request<Conversation>(`/api/conversations/${encodeURIComponent(id)}`, {signal: controller.signal});
      if (!controller.signal.aborted) {setConversation(result); setSelectedDevice(result.scope.deviceId ?? '');}
    } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)); }
    finally { if (!controller.signal.aborted) {setOpening(false); operation.current = null;} }
  }
  function startNew() {
    if (busy) return;
    operation.current?.abort(); operation.current = null;
    setConversation(null); setOpening(false); setQuestion(''); setPendingQuestion(''); setError(''); setConfirmDelete(false);
  }
  async function submit(event?: {preventDefault(): void}, sample?: string) {
    event?.preventDefault();
    const text = (sample ?? question).trim();
    if (!text || operation.current || !configured) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(''); setConfirmDelete(false); setPendingQuestion(text);
    try {
      const result = await api.request<Answer & {conversationId: string; turnId: string}>('/api/query', {
        method: 'POST', signal: controller.signal,
        body: JSON.stringify({question: text, ...(conversation ? {conversationId: conversation.id} : {}),
          after: range.after ?? null, before: range.before ?? null, deviceId: selectedDevice || null,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone}),
      });
      if (controller.signal.aborted) return;
      // The successful query is already durable. Keep it visible even if refreshing the history list fails.
      const now = new Date().toISOString();
      const turn: ConversationTurn = {id: result.turnId, question: text, result, createdAt: now};
      setConversation(previous => ({id: result.conversationId, title: previous?.title ?? Array.from(text).slice(0, 80).join(''),
        createdAt: previous?.createdAt ?? now, updatedAt: now, turnCount: (previous?.turnCount ?? 0) + 1,
        scope: {...range, ...(selectedDevice ? {deviceId: selectedDevice} : {})}, turns: [...(previous?.turns ?? []), turn]}));
      setQuestion(''); setPendingQuestion('');
      void loadHistory();
    } catch (e) {
      if (!controller.signal.aborted) {setQuestion(text); setPendingQuestion(''); setError(`${errorMessage(e)} 可刷新历史检查结果后再重试。`);}
    } finally {if (!controller.signal.aborted) {setBusy(false); operation.current = null;}}
  }
  async function remove() {
    if (!conversation || operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError('');
    try {
      await api.request(`/api/conversations/${encodeURIComponent(conversation.id)}`, {method: 'DELETE', signal: controller.signal});
      if (controller.signal.aborted) return;
      setConversation(null); setQuestion(''); setConfirmDelete(false); void loadHistory();
    } catch (e) {if (!controller.signal.aborted) setError(errorMessage(e));}
    finally {if (!controller.signal.aborted) {setBusy(false); operation.current = null;}}
  }
  return <div className="conversation-layout">
    <aside className="conversation-history panel" aria-label="对话历史">
      <div className="conversation-history-heading"><h2>对话历史</h2><button className="icon-button" aria-label="刷新对话历史" disabled={loading} onClick={() => void loadHistory()}><RefreshCw size={16} className={loading ? 'spin' : ''}/></button></div>
      <button className="button subtle full" disabled={busy} onClick={startNew}><Plus size={16}/>新对话</button>
      {historyError && <p className="notice error" role="alert">{historyError}</p>}
      {!loading && !historyError && !items.length && <p className="fine-print">回答会自动保存在中央节点，随时回来继续。</p>}
      <div className="conversation-list">{items.map(item => <button key={item.id} className={`conversation-item ${conversation?.id === item.id ? 'active' : ''}`} aria-current={conversation?.id === item.id ? 'true' : undefined} disabled={busy} onClick={() => void open(item.id)}>
        <strong>{item.title}</strong><span>{dateTime(item.updatedAt)} · {item.turnCount} 轮</span>
      </button>)}</div>
      {loading && <p className="loading" role="status"><LoaderCircle size={15} className="spin"/>正在读取历史…</p>}
      {cursor && <button className="text-button" disabled={loading} onClick={() => void loadHistory(cursor)}>加载更早的对话</button>}
    </aside>
    <section className="conversation-content" aria-label="当前对话" aria-busy={busy || opening}>
      <div className="conversation-heading"><div><h2>{conversation?.title ?? '开始一段新对话'}</h2><p>对话保存在中央节点。时间与设备筛选用于下一次提问。</p></div>{conversation && <button className="icon-button" aria-label="删除此对话" disabled={busy} onClick={() => setConfirmDelete(value => !value)}><Trash2 size={17}/></button>}</div>
      {confirmDelete && <div className="notice"><span>删除此对话及全部问答记录？</span><button className="text-button" disabled={busy} onClick={() => void remove()}>确认删除对话</button><button className="text-button" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button></div>}
      {opening && <p className="loading" role="status"><LoaderCircle size={16} className="spin"/>正在打开对话…</p>}
      {conversation?.turns.map(turn => <article className="answer-panel conversation-turn" key={turn.id}>
        <div className="asked-question"><MessageSquare size={16}/><span>{turn.question}</span></div>
        {turn.evidenceDeleted ? <p className="notice">相关证据已删除，这条历史回答已清除。可以继续提问查阅现有记录。</p> : renderAnswer(turn.result)}
      </article>)}
      {pendingQuestion && <div className="thinking-panel" role="status"><LoaderCircle size={18} className="spin"/><div><strong>{pendingQuestion}</strong><p>正在查阅上下文并组织回答…</p></div></div>}
      <div ref={end}/>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="filter-bar"><label><Monitor size={15}/><span>筛选设备</span><select aria-label="问答设备" value={selectedDevice} disabled={busy || opening} onChange={event => setSelectedDevice(event.target.value)}>
        <option value="">全部设备</option>{selectedDevice && !devices.some(device => device.deviceId === selectedDevice) && <option value={selectedDevice}>历史设备（{selectedDevice}）</option>}{devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.deviceName}</option>)}
      </select></label></div>
      <form className="ask-form" onSubmit={event => void submit(event)}>
        <textarea aria-label="向 Mote 提问" placeholder={conversation ? '接着问，Mote 会结合前面的对话。' : '比如，我最近都在忙什么？'} value={question} onChange={event => setQuestion(event.target.value)} onKeyDown={event => {if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit(event);}} disabled={busy || opening} maxLength={8000} rows={3}/>
        <div><span><ShieldCheck size={14}/>只读查询 · 回答附带原始证据</span><button className="send-button" type="submit" disabled={busy || opening || !question.trim() || !configured} aria-label="发送问题">{busy ? <LoaderCircle className="spin" size={19}/> : <ArrowUp size={19}/>}</button></div>
      </form>
      {!conversation && !busy && !opening && <div className="suggestions"><span>从一个小问题开始</span>{['我最近都做了些什么？', '这周的时间主要花在了哪里？', '最近有哪些值得接着做的事情？'].map(sample => <button key={sample} disabled={!configured} onClick={() => void submit(undefined, sample)}>{sample}<ArrowRight size={14}/></button>)}</div>}
    </section>
  </div>;
}
