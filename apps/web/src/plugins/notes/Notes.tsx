import { formatEvidenceRef } from '@mote/shared';
import { moteText, getLocale } from '@mote/shared/i18n';
import { useContext, useEffect, useMemo, useRef, useSyncExternalStore, type FormEvent } from 'react';
import { Check, CloudUpload, FileText, LoaderCircle, RefreshCw, Trash2, WifiOff } from 'lucide-react';
import { dateTime, type Api } from '../../api';
import { QuickNoteContext } from '../../quick-note-context';
import { createNotesController } from './controller';

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
    const openQuickNote = useContext(QuickNoteContext);
    const historyOnly = !composerOnly && Boolean(openQuickNote);
    const callbacks = useRef({ onSaved, onSubmitted });
    callbacks.current = { onSaved, onSubmitted };
    const controller = useMemo(() => createNotesController({
        api,
        namespace,
        revision,
        composerOnly,
        historyOnly,
        onSaved: () => callbacks.current.onSaved(),
        onSubmitted: () => callbacks.current.onSubmitted?.(),
    }), [api, namespace, composerOnly, historyOnly]);
    useEffect(() => { controller.start(); return () => controller.stop(); }, [controller]);
    useEffect(() => { controller.setRevision(revision); }, [controller, revision]);
    const { draft, queued, records, cursor, error, listError, notice, loading, listLoaded, loadingMore, syncing, uploading, draftSaved } = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const foregroundLoading = loading && (!listLoaded || loadingMore);
    function save(event: FormEvent) {
        event.preventDefault();
        void controller.save();
    }
    function discard(id: string) {
        if (!window.confirm(moteText("移除这条本机待同步副本？若中央节点已收到但确认丢失，需要在下方历史记录中另行删除。")))
            return;
        controller.discard(id);
    }
    return <>
    {!composerOnly&&<div className="page-heading note-heading"><h1>{moteText("想到什么，就记下来。")}</h1><p>{moteText("心情、杂事、一个还没成形的想法，都可以成为上下文。")}</p>{historyOnly&&<button className="button" onClick={openQuickNote!}>{moteText("写随手记")}</button>}</div>}
    {!historyOnly&&<form className={"panel note-composer"+(composerOnly?" note-composer-overlay":"")} onSubmit={save}>
      <label className={composerOnly?"visually-hidden":undefined} htmlFor="note-text">{moteText("此刻想留下什么？")}</label>
      <textarea disabled={uploading} id="note-text" value={draft.text} onChange={e => controller.patchDraft({text:e.target.value})} maxLength={100000} rows={6} placeholder={moteText(composerOnly?"记点什么…":"记下此刻的想法…")} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.text.trim())
        save(e); }}/>
      <details className="note-description"><summary>{moteText('资料说明（选填）')}</summary><label className="visually-hidden" htmlFor="note-description">{moteText('这条记录的资料说明')}</label><textarea disabled={uploading} id="note-description" rows={2} value={draft.description??''} maxLength={12000} onChange={event=>controller.patchDraft({description:event.target.value})} placeholder={moteText('例如：这是我的日记，记录当天的经历和感受。')}/><p>{moteText('仅用于理解这条记录。')}</p></details>

      <div className="note-composer-actions"><details className="note-more"><summary>{moteText('更多')}</summary><div className="note-more-content"><label>{moteText("选择已有图片 / 音频附件")}<input type="file" accept="image/*,audio/*" multiple disabled={uploading} onChange={event => {
            const selected = Array.from(event.target.files ?? []);
            event.target.value = '';
            void controller.addAttachments(selected);
        }}/></label><p role="status">{uploading ? moteText("正在上传附件…") : moteText("已添加 {0} 个附件", draft.attachments?.length ?? 0)}</p>
      <p className="fine-print note-attachment-boundary">{moteText("已有文件 · 不现场录音 · 附件先归档 · 每个附件最多 50 MiB。")}</p>
      <details className="note-attachment-help"><summary>{moteText("附件与处理说明")}</summary><p>{moteText("文字识别与音频转写按中央处理设置进行；可在资料库核对各阶段状态。")}</p></details>
      <p className="note-storage-hint">{moteText("草稿和待同步内容保存在此应用的本机存储中，清除应用数据会移除它们。打开随手记时自动续传；按中央节点地址分别保存。")}</p>
      </div></details>{(draftSaved||!composerOnly||draft.text.length>0)&&<span>{draftSaved && <><Check size={14}/> {' '}{moteText("草稿已保存在本机 ·")}{' '}</>} {(!composerOnly||draft.text.length>0)&&draft.text.length.toLocaleString(getLocale())}{' '}{(!composerOnly||draft.text.length>0)&&moteText("字")}</span>}{onClose&&<button type="button" className="button" onClick={onClose}>{moteText("收起")}</button>}<button className="button primary" disabled={uploading || (!draft.text.trim() && !draft.attachments?.length)}>{!composerOnly&&<CloudUpload size={16}/>} {moteText(composerOnly?"保存":"保存并同步")}</button></div>

    </form>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {notice && <div className="notice" role="status"><Check size={16}/>{notice}</div>}
    {queued.length > 0 && <section className="panel note-pending"><div className="section-heading"><div><span className="eyebrow">{moteText("仅保存在本机")}</span><h2>{moteText("待同步 ·")}{' '}{queued.length}{' '}{moteText("条")}</h2></div><button className="button subtle" disabled={syncing} onClick={() => historyOnly?openQuickNote?.():void controller.retry()}><RefreshCw size={14} className={syncing ? 'spin' : ''}/>{syncing ? moteText("正在同步") : moteText("重试同步")}</button></div>{queued.map(item => <article className="pending-note" key={item.note.id}><div><time>{dateTime(item.note.capturedAt)}</time><p>{item.note.text}</p><small><WifiOff size={13}/>{item.error || moteText("本机已保存，等待中央节点确认。")}</small></div><button className="icon-button" aria-label={moteText("移除本机待同步副本")} onClick={() => discard(item.note.id)} disabled={syncing}><Trash2 size={15}/></button></article>)}</section>}
    {!composerOnly&&<section className="notes-history" aria-busy={loading}><div className="section-heading"><div><h2>{moteText("已经留下的心绪与杂事")}</h2></div><button className="text-button" onClick={() => void controller.load()} disabled={loading}><RefreshCw size={14}/>{moteText("刷新")}</button></div>
      {listError && <div className="notice error" role="alert">{listError}{' '}{moteText("· 本机草稿仍可继续保存。")}</div>}
      {!records.length && !foregroundLoading && !listError && <div className="panel empty"><FileText size={26}/><h3>{moteText("给今天留一小段文字")}</h3><p>{moteText("保存后，原文会出现在这里，也可作为问答的证据。")}</p></div>}
      <div className="notes-grid">{records.map(record => <button className="panel note-card" key={record.id} onClick={() => onOpen(formatEvidenceRef('capture', record.id))}><time>{dateTime(record.capturedAt)}</time>{record.metadata?.noteOrigin&&record.metadata.noteOrigin.kind!=='manual'&&<small>{moteText(record.metadata.noteOrigin.kind==='conversation'?"引用原文":"分享内容")}</small>}<p>{record.ocrText||record.metadata?.noteOrigin?.text}</p>{record.metadata?.attachments?.length && <small>{moteText("附件")}: {record.metadata.attachments.length}</small>}<footer>{record.deviceName}<span>{moteText("查看原文 →")}</span></footer></button>)}</div>
      {foregroundLoading && <div className="load-more"><LoaderCircle size={17} className="spin"/>{moteText("正在读取随手记…")}</div>}
      {cursor && !foregroundLoading && <div className="load-more"><button className="button subtle" disabled={loading} onClick={() => void controller.load(cursor)}>{moteText("加载更早的随手记")}</button></div>}
    </section>}
  </>;
}
