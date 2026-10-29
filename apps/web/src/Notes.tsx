import { formatEvidenceRef } from '@mote/shared';
import { moteText, getLocale } from '@mote/shared/i18n';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, CloudUpload, FileText, LoaderCircle, RefreshCw, Trash2, WifiOff } from 'lucide-react';
import { ApiError, dateTime, errorMessage, type Api, type Capture } from './api';
import { uploadNoteAttachment } from './note-attachments';
import { NoteOutbox, type NoteDraft, type QueuedNote } from './notes-state';
import {QuickNoteContext} from './quick-note-context';
export function Notes({ api, namespace, revision, onOpen, onSaved, composerOnly=false, onSubmitted, onClose }: {
    api: Api;
    namespace: string;
    revision: number;
    onOpen: (id: string) => void;
    onSaved: () => void;
    composerOnly?: boolean;
    onSubmitted?: () => void;
    onClose?: () => void;
}) {
    const openQuickNote=useContext(QuickNoteContext);
    const historyOnly=!composerOnly&&Boolean(openQuickNote);
    const submitted=useRef<string|undefined>(undefined);
    const notifyOutbox=useCallback(()=>window.dispatchEvent(new window.CustomEvent('mote:notes-outbox',{detail:{namespace}})),[namespace]);
    const outbox = useMemo(() => new NoteOutbox(localStorage, namespace), [namespace]);
    const [draft, setDraft] = useState<NoteDraft>({ text: '', mood: '' });
    const [queued, setQueued] = useState<QueuedNote[]>([]);
    const [records, setRecords] = useState<Capture[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [listError, setListError] = useState('');
    const [notice, setNotice] = useState('');
    const [loading, setLoading] = useState(true);
    const [listLoaded, setListLoaded] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [draftSaved, setDraftSaved] = useState(false);
    const syncingRef = useRef(false);
    const mounted = useRef(true);
    const generation = useRef(0);
    const attachmentRequest = useRef<AbortController | null>(null);
    const load = useCallback(async (next?: string) => {
        const current = ++generation.current;
        setLoading(true);
        setLoadingMore(Boolean(next));
        setListError('');
        try {
            const response = await api.request<{
                items: Capture[];
                nextCursor: string | null;
            }>(`/api/notes?limit=30${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
            if (!mounted.current || generation.current !== current)
                return;
            setRecords(old => next ? [...old, ...response.items.filter(item => !old.some(p => p.id === item.id))] : response.items);
            setCursor(response.nextCursor);
            setListLoaded(true);
        }
        catch (e) {
            if (mounted.current && generation.current === current) {
                if (e instanceof ApiError && [401, 403, 404, 410].includes(e.status)) {
                    setRecords([]);
                    setCursor(null);
                    setListLoaded(false);
                }
                setListError(errorMessage(e));
            }
        }
        finally {
            if (mounted.current && generation.current === current) {
                setLoading(false);
                setLoadingMore(false);
            }
        }
    }, [api]);
    const sync = useCallback(async (manual = false) => {
        if (syncingRef.current)
            return;
        syncingRef.current = true;
        setSyncing(true);
        let saved = false, submittedSaved=false;
        try {
            for (const item of outbox.items()) {
                if (!mounted.current)
                    break;
                if (item.blocked && !manual)
                    continue;
                try {
                    const response = await api.request<{
                        id: string;
                    }>('/api/notes', {
                        method: 'POST', body: JSON.stringify(item.note), signal: AbortSignal.timeout(20000),
                    });
                    outbox.acknowledge(item.note.id, response);
                    if(submitted.current===item.note.id){submitted.current=undefined;submittedSaved=true;}
                    saved = true;
                }
                catch (e) {
                    const blocked = e instanceof ApiError && [400, 409, 410, 413].includes(e.status);
                    outbox.mark(item.note.id, errorMessage(e), blocked);
                    if (!blocked)
                        break;
                }
            }
            // An acknowledged submission still updates the underlying history
            // when the owner has already folded this composer away.
            if(saved)onSaved();
            if (mounted.current) {
                setQueued(outbox.items());
                if (saved) {
                    setNotice(moteText("随手记已同步到你的中央节点。"));
                    if(!composerOnly)void load();
                    const current=outbox.draft();
                    if(submittedSaved&&!current.text&&!current.description&&!current.attachments?.length)onSubmitted?.();
                }
            }
        }
        catch (e) {
            if (mounted.current)
                setError(errorMessage(e));
        }
        finally {
            notifyOutbox();
            syncingRef.current = false;
            if (mounted.current)
                setSyncing(false);
        }
    }, [api, outbox, onSaved, load, composerOnly, onSubmitted, notifyOutbox]);
    useEffect(() => {
        mounted.current = true;
        try {
            setDraft(outbox.draft());
            setQueued(outbox.items());
            setDraftSaved(Boolean(outbox.draft().text));
        }
        catch (e) {
            setError(errorMessage(e));
        }
        return () => { mounted.current = false; generation.current++; attachmentRequest.current?.abort(); };
    }, [outbox]);
    useEffect(() => { setRecords([]); setCursor(null); setListLoaded(false); }, [api, namespace]);
    useEffect(() => { if(!composerOnly)void load(); }, [load, revision, namespace, composerOnly]);
    useEffect(() => {
        const changed = (event?:Event) => { try {
            if(event?.type==='mote:notes-outbox'&&(event as CustomEvent<{namespace:string}>).detail.namespace!==namespace)return;
            setQueued(outbox.items());
        }
        catch (e) {
            setError(errorMessage(e));
        } };
        changed();
        window.addEventListener('storage', changed);
        window.addEventListener('mote:notes-outbox', changed);
        return () => { window.removeEventListener('storage', changed);window.removeEventListener('mote:notes-outbox', changed); };
    }, [outbox, namespace, revision]);
    useEffect(()=>{
        if(historyOnly)return;
        void sync();
        const online=()=>void sync();
        const timer=setInterval(online,30000);
        window.addEventListener('online',online);
        return()=>{clearInterval(timer);window.removeEventListener('online',online);};
    },[sync,historyOnly]);
    function edit(next: NoteDraft) {
        setDraft(next);
        setError('');
        setNotice('');
        try {
            outbox.saveDraft(next);
            setDraftSaved(true);
        }
        catch {
            setDraftSaved(false);
            setError(moteText("本机存储不可用或已满；草稿目前只在此窗口，请先复制保存。"));
        }
    }
    function save(event: FormEvent) {
        event.preventDefault();
        setError('');
        try {
            let deviceId = localStorage.getItem('mote.notes.device.v1');
            if (!deviceId) {
                deviceId = `web:${crypto.randomUUID()}`;
                localStorage.setItem('mote.notes.device.v1', deviceId);
            }
            const note = outbox.prepareSubmission(draft, { id: crypto.randomUUID(), deviceId, deviceName: moteText("Mote 随手记"), platform: 'import', client: 'web', capturedAt: new Date().toISOString() });
            outbox.enqueue(note);
            submitted.current=note.id;
            setQueued(outbox.items());
            outbox.completeSubmission(note.id);
            const remainingDraft = outbox.draft();
            setDraft(remainingDraft);
            setDraftSaved(Boolean(remainingDraft.text));
            setNotice(moteText("已保存到本机待同步队列，联网后会继续同步。"));
            notifyOutbox();
            void sync();
        }
        catch (e) {
            setError(errorMessage(e));
        }
    }
    function discard(id: string) {
        if (!window.confirm(moteText("移除这条本机待同步副本？若中央节点已收到但确认丢失，需要在下方历史记录中另行删除。")))
            return;
        try {
            outbox.discard(id);
            setQueued(outbox.items());
            notifyOutbox();
        }
        catch (e) {
            setError(errorMessage(e));
        }
    }
    const foregroundLoading = loading && (!listLoaded || loadingMore);
    return <>
    {!composerOnly&&<div className="page-heading note-heading"><h1>{moteText("想到什么，就记下来。")}</h1><p>{moteText("心情、杂事、一个还没成形的想法，都可以成为上下文。")}</p>{historyOnly&&<button className="button" onClick={openQuickNote!}>{moteText("写随手记")}</button>}</div>}
    {!historyOnly&&<form className={"panel note-composer"+(composerOnly?" note-composer-overlay":"")} onSubmit={save}>
      <label className={composerOnly?"visually-hidden":undefined} htmlFor="note-text">{moteText("此刻想留下什么？")}</label>
      <textarea disabled={uploading} id="note-text" value={draft.text} onChange={e => edit({ ...draft, text: e.target.value })} maxLength={100000} rows={6} placeholder={moteText(composerOnly?"记点什么…":"记下此刻的想法…")} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.text.trim())
        save(e); }}/>
      <details className="note-description"><summary>{moteText('资料说明（选填）')}</summary><label className="visually-hidden" htmlFor="note-description">{moteText('这条记录的资料说明')}</label><textarea id="note-description" rows={2} value={draft.description??''} maxLength={12000} onChange={event=>edit({...draft,description:event.target.value})} placeholder={moteText('例如：这是我的日记，记录当天的经历和感受。')}/><p>{moteText('仅用于理解这条记录。')}</p></details>

      <div className="note-composer-actions"><details className="note-more"><summary>{moteText('更多')}</summary><div className="note-more-content"><label>{moteText("选择已有图片 / 音频附件")}<input type="file" accept="image/*,audio/*" multiple disabled={uploading} onChange={event => {
            const selected = Array.from(event.target.files ?? []);
            event.target.value = '';
            if ((draft.attachments?.length ?? 0) + selected.length > 10) {
                setError(moteText("最多 10 个附件"));
                return;
            }
            const controller = new AbortController();
            attachmentRequest.current = controller;
            setUploading(true);
            setError('');
            void (async () => {
                let next = draft;
                let deviceId = localStorage.getItem('mote.notes.device.v1');
                if (!deviceId) {
                    deviceId = 'web:' + crypto.randomUUID();
                    localStorage.setItem('mote.notes.device.v1', deviceId);
                }
                for (const file of selected) {
                    const id = await uploadNoteAttachment(api, file, deviceId, controller.signal);
                    next = { ...next, attachments: [...(next.attachments ?? []), id] };
                    edit(next);
                }
            })().catch(e => { if (!controller.signal.aborted)
                setError(errorMessage(e)); }).finally(() => { if (!controller.signal.aborted)
                setUploading(false); if (attachmentRequest.current === controller)
                attachmentRequest.current = null; });
        }}/></label><p role="status">{uploading ? moteText("正在上传附件…") : moteText("已添加 {0} 个附件", draft.attachments?.length ?? 0)}</p>
      <p className="fine-print note-attachment-boundary">{moteText("已有文件 · 不现场录音 · 附件先归档 · 每个附件最多 50 MiB。")}</p>
      <details className="note-attachment-help"><summary>{moteText("附件与处理说明")}</summary><p>{moteText("文字识别与音频转写按中央处理设置进行；可在资料库核对各阶段状态。")}</p></details>
      <p className="note-storage-hint">{moteText("草稿和待同步内容保存在此应用的本机存储中，清除应用数据会移除它们。打开随手记时自动续传；按中央节点地址分别保存。")}</p>
      </div></details>{(draftSaved||!composerOnly||draft.text.length>0)&&<span>{draftSaved && <><Check size={14}/> {' '}{moteText("草稿已保存在本机 ·")}{' '}</>} {(!composerOnly||draft.text.length>0)&&draft.text.length.toLocaleString(getLocale())}{' '}{(!composerOnly||draft.text.length>0)&&moteText("字")}</span>}{onClose&&<button type="button" className="button" onClick={onClose}>{moteText("收起")}</button>}<button className="button primary" disabled={uploading || (!draft.text.trim() && !draft.attachments?.length)}>{!composerOnly&&<CloudUpload size={16}/>} {moteText(composerOnly?"保存":"保存并同步")}</button></div>

    </form>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status"><Check size={16}/>{notice}</div>}
    {queued.length > 0 && <section className="panel note-pending"><div className="section-heading"><div><span className="eyebrow">{moteText("仅保存在本机")}</span><h2>{moteText("待同步 ·")}{' '}{queued.length}{' '}{moteText("条")}</h2></div><button className="button subtle" disabled={syncing} onClick={() => historyOnly?openQuickNote?.():void sync(true)}><RefreshCw size={14} className={syncing ? 'spin' : ''}/>{syncing ? moteText("正在同步") : moteText("重试同步")}</button></div>{queued.map(item => <article className="pending-note" key={item.note.id}><div><time>{dateTime(item.note.capturedAt)}</time><p>{item.note.text}</p><small><WifiOff size={13}/>{item.error || moteText("本机已保存，等待中央节点确认。")}</small></div><button className="icon-button" aria-label={moteText("移除本机待同步副本")} onClick={() => discard(item.note.id)} disabled={syncing}><Trash2 size={15}/></button></article>)}</section>}
    {!composerOnly&&<section className="notes-history" aria-busy={loading}><div className="section-heading"><div><h2>{moteText("已经留下的心绪与杂事")}</h2></div><button className="text-button" onClick={() => void load()} disabled={loading}><RefreshCw size={14}/>{moteText("刷新")}</button></div>
      {listError && <div className="notice error" role="alert">{listError}{' '}{moteText("· 本机草稿仍可继续保存。")}</div>}
      {!records.length && !foregroundLoading && !listError && <div className="panel empty"><FileText size={26}/><h3>{moteText("给今天留一小段文字")}</h3><p>{moteText("保存后，原文会出现在这里，也可作为问答的证据。")}</p></div>}
      <div className="notes-grid">{records.map(record => <button className="panel note-card" key={record.id} onClick={() => onOpen(formatEvidenceRef('capture', record.id))}><time>{dateTime(record.capturedAt)}</time>{record.metadata?.noteOrigin&&record.metadata.noteOrigin.kind!=='manual'&&<small>{moteText(record.metadata.noteOrigin.kind==='conversation'?"引用原文":"分享内容")}</small>}<p>{record.ocrText||record.metadata?.noteOrigin?.text}</p>{record.metadata?.attachments?.length && <small>{moteText("附件")}: {record.metadata.attachments.length}</small>}<footer>{record.deviceName}<span>{moteText("查看原文 →")}</span></footer></button>)}</div>
      {foregroundLoading && <div className="load-more"><LoaderCircle size={17} className="spin"/>{moteText("正在读取随手记…")}</div>}
      {cursor && !foregroundLoading && <div className="load-more"><button className="button subtle" disabled={loading} onClick={() => void load(cursor)}>{moteText("加载更早的随手记")}</button></div>}
    </section>}
  </>;
}
