import { moteText, getLocale } from '@mote/shared/i18n';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, CloudUpload, FileText, LoaderCircle, RefreshCw, Smile, Trash2, WifiOff } from 'lucide-react';
import { ApiError, dateTime, errorMessage, type Api, type Capture } from './api';
import {uploadNoteAttachment} from './note-attachments';
import { NoteOutbox, type NoteDraft, type QueuedNote } from './notes-state';

export function Notes({ api, namespace, revision, onOpen, onSaved }: {
  api: Api; namespace: string; revision: number; onOpen: (id: string) => void; onSaved: () => void;
}) {
  const outbox = useMemo(() => new NoteOutbox(localStorage, namespace), [namespace]);
  const [draft, setDraft] = useState<NoteDraft>({ text: '', mood: '' });
  const [queued, setQueued] = useState<QueuedNote[]>([]);
  const [records, setRecords] = useState<Capture[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [listError, setListError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [uploading,setUploading]=useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const syncingRef = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const load = useCallback(async (next?: string) => {
    const current = ++generation.current;
    setLoading(true); setListError('');
    try {
      const response = await api.request<{ items: Capture[]; nextCursor: string | null }>(`/api/notes?limit=30${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
      if (!mounted.current || generation.current !== current) return;
      setRecords(old => next ? [...old, ...response.items.filter(item => !old.some(p => p.id === item.id))] : response.items);
      setCursor(response.nextCursor);
    } catch (e) { if (mounted.current && generation.current === current) setListError(errorMessage(e)); }
    finally { if (mounted.current && generation.current === current) setLoading(false); }
  }, [api]);
  const sync = useCallback(async (manual = false) => {
    if (syncingRef.current) return;
    syncingRef.current = true; setSyncing(true);
    let saved = false;
    try {
      for (const item of outbox.items()) {
        if (!mounted.current) break;
        if (item.blocked && !manual) continue;
        try {
          const response = await api.request<{ id: string }>('/api/notes', {
            method: 'POST', body: JSON.stringify(item.note), signal: AbortSignal.timeout(20000),
          });
          outbox.acknowledge(item.note.id, response); saved = true;
        } catch (e) {
          const blocked = e instanceof ApiError && [400, 409, 410, 413].includes(e.status);
          outbox.mark(item.note.id, errorMessage(e), blocked);
          if (!blocked) break;
        }
      }
      if (mounted.current) {
        setQueued(outbox.items());
        if (saved) { setNotice(moteText("随手记已同步到你的中央节点。")); onSaved(); void load(); }
      }
    } catch (e) { if (mounted.current) setError(errorMessage(e)); }
    finally { syncingRef.current = false; if (mounted.current) setSyncing(false); }
  }, [api, outbox, onSaved, load]);
  useEffect(() => {
    mounted.current = true;
    try { setDraft(outbox.draft()); setQueued(outbox.items()); setDraftSaved(Boolean(outbox.draft().text)); }
    catch (e) { setError(errorMessage(e)); }
    return () => { mounted.current = false; generation.current++; };
  }, [outbox]);
  useEffect(() => { void load(); }, [load, revision]);
  useEffect(() => {
    void sync();
    const online = () => void sync();
    const changed = () => { try { setQueued(outbox.items()); } catch (e) { setError(errorMessage(e)); } };
    const timer = setInterval(online, 30000);
    window.addEventListener('online', online); window.addEventListener('storage', changed);
    return () => { clearInterval(timer); window.removeEventListener('online', online); window.removeEventListener('storage', changed); };
  }, [outbox, sync]);
  function edit(next: NoteDraft) {
    setDraft(next); setError(''); setNotice('');
    try { outbox.saveDraft(next); setDraftSaved(true); }
    catch { setDraftSaved(false); setError(moteText("本机存储不可用或已满；草稿目前只在此窗口，请先复制保存。")); }
  }
  function save(event: FormEvent) {
    event.preventDefault(); setError('');
    try {
      let deviceId = localStorage.getItem('mote.notes.device.v1');
      if (!deviceId) { deviceId = `web:${crypto.randomUUID()}`; localStorage.setItem('mote.notes.device.v1', deviceId); }
      const note = outbox.prepareSubmission(draft, { id: crypto.randomUUID(), deviceId, deviceName: moteText("Mote 随手记"), platform: 'import', capturedAt: new Date().toISOString() });
      outbox.enqueue(note);
      setQueued(outbox.items());
      outbox.completeSubmission(note.id);
      const remainingDraft = outbox.draft();
      setDraft(remainingDraft); setDraftSaved(Boolean(remainingDraft.text));
      setNotice(moteText("已保存到本机待同步队列，联网后会继续同步。")); void sync();
    } catch (e) { setError(errorMessage(e)); }
  }
  function discard(id: string) {
    if (!window.confirm(moteText("移除这条本机待同步副本？若中央节点已收到但确认丢失，需要在下方历史记录中另行删除。"))) return;
    try { outbox.discard(id); setQueued(outbox.items()); } catch (e) { setError(errorMessage(e)); }
  }
  return <>
    <div className="page-heading"><div className="eyebrow">A LITTLE ROOM FOR YOUR THOUGHTS</div><h1>{moteText("想到什么，就记下来。")}</h1><p>{moteText("心情、杂事、一个还没成形的想法，都可以成为上下文。")}</p></div>
    <form className="panel note-composer" onSubmit={save}>
      <label htmlFor="note-text">{moteText("此刻想留下什么？")}</label>
      <textarea disabled={uploading} id="note-text" value={draft.text} onChange={e => edit({ ...draft, text: e.target.value })} maxLength={100000} rows={6} placeholder={moteText("记下此刻的想法…")} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.text.trim()) save(e); }} />
      <label>{moteText("图片与语音附件")}<input type="file" accept="image/*,audio/*" multiple disabled={uploading} onChange={event=>{
        const selected=Array.from(event.target.files??[]);event.target.value='';
        if((draft.attachments?.length??0)+selected.length>10){setError(moteText("最多 10 个附件"));return;}
        setUploading(true);setError('');
        void (async()=>{let next=draft;let deviceId=localStorage.getItem('mote.notes.device.v1');if(!deviceId){deviceId='web:'+crypto.randomUUID();localStorage.setItem('mote.notes.device.v1',deviceId);}
          for(const file of selected){const id=await uploadNoteAttachment(api,file,deviceId);next={...next,attachments:[...(next.attachments??[]),id]};edit(next);}
        })().catch(e=>setError(errorMessage(e))).finally(()=>setUploading(false));
      }}/></label><p role="status">{uploading?moteText("正在上传附件…"):moteText("已添加 {0} 个附件",draft.attachments?.length??0)}</p>
      <p className="fine-print">{moteText("图片复用中央 OCR，音频复用转写流程；处理状态可在资料库查看。每个附件最多 50 MiB。")}</p>
      <div className="note-composer-actions"><span>{draftSaved && <><Check size={14} /> {' '}{moteText("草稿已保存在本机 ·")}{' '}</>} {draft.text.length.toLocaleString(getLocale())}{' '}{moteText("字")}</span><button className="button primary" disabled={uploading||(!draft.text.trim()&&!draft.attachments?.length)}><CloudUpload size={16} />{moteText("保存并同步")}</button></div>
      <p className="note-storage-hint">{moteText("草稿和待同步内容保存在此应用的本机存储中，清除应用数据会移除它们。打开随手记时自动续传；按中央节点地址分别保存。")}</p>
    </form>
    {error && <div className="notice error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status"><Check size={16} />{notice}</div>}
    {queued.length > 0 && <section className="panel note-pending"><div className="section-heading"><div><span className="eyebrow">SAVED ON THIS DEVICE</span><h2>{moteText("待同步 ·")}{' '}{queued.length}{' '}{moteText("条")}</h2></div><button className="button subtle" disabled={syncing} onClick={() => void sync(true)}><RefreshCw size={14} className={syncing ? 'spin' : ''} />{syncing ? moteText("正在同步") : moteText("重试同步")}</button></div>{queued.map(item => <article className="pending-note" key={item.note.id}><div><time>{dateTime(item.note.capturedAt)}</time>{item.note.mood && <span className="badge muted">{moteText("我标注的心情 ·")}{' '}{item.note.mood}</span>}<p>{item.note.text}</p><small><WifiOff size={13} />{item.error || moteText("本机已保存，等待中央节点确认。")}</small></div><button className="icon-button" aria-label={moteText("移除本机待同步副本")} onClick={() => discard(item.note.id)} disabled={syncing}><Trash2 size={15} /></button></article>)}</section>}
    <section className="notes-history"><div className="section-heading"><div><span className="eyebrow">YOUR OWN WORDS</span><h2>{moteText("已经留下的心绪与杂事")}</h2></div><button className="text-button" onClick={() => void load()} disabled={loading}><RefreshCw size={14} />{moteText("刷新")}</button></div>
      {listError && <div className="notice error" role="alert">{listError}{' '}{moteText("· 本机草稿仍可继续保存。")}</div>}
      {!records.length && !loading && !listError && <div className="panel empty"><FileText size={26} /><h3>{moteText("给今天留一小段文字")}</h3><p>{moteText("保存后，原文会出现在这里，也可作为问答的证据。")}</p></div>}
      <div className="notes-grid">{records.map(record => <button className="panel note-card" key={record.id} onClick={() => onOpen(record.id)}><time>{dateTime(record.capturedAt)}</time>{record.mood && <span className="note-mood-tag"><Smile size={14} />{moteText("我标注的心情 ·")}{' '}{record.mood}</span>}<p>{record.ocrText}</p>{record.metadata?.attachments?.length&&<small>{moteText("附件")}: {record.metadata.attachments.length}</small>}<footer>{record.deviceName}<span>{moteText("查看原文 →")}</span></footer></button>)}</div>
      {loading && <div className="load-more"><LoaderCircle size={17} className="spin" />{moteText("正在读取随手记…")}</div>}
      {cursor && !loading && <div className="load-more"><button className="button subtle" onClick={() => void load(cursor)}>{moteText("加载更早的随手记")}</button></div>}
    </section>
  </>;
}
