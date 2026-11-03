import {SourceMaterialToolsContext} from './features/source-material';
import {originalReferenceRoute,rememberOriginalReturn} from './ask-original-reference';
import {confirmNavigation} from './unsaved';
import { useEffect,useRef,useState } from 'react';
import {noteMaterialPage,noteAssetTarget,noteQuoteCaptureId,type NoteReadSpan} from './note-material-render';
import {ArchivedFileButton} from './ArchivedFileButton';
import type {ArchivedFile} from '@mote/shared';
import { moteText } from '@mote/shared/i18n';
import { type Api, type Capture, ApiError, errorMessage,dateTime } from './api';
import {ConversationOrigin} from './NoteOrigin';
import {readEvidenceRoute} from './plugins/reader/evidence-route';
import {verifyCompleteNoteQuote} from './note-material-quote';
import { useResource } from './useResource';
import type { LibraryCatalogDescriptor } from '@mote/shared';
import { FeatureActions, FeaturePanels, FeatureView } from './features/runtime';
import { AnswerMarkdown } from './AnswerMarkdown';
import { AttributionEditor, AttributionSummary, type AttributionContext } from './AttributionContext';
import { memoryMaterialRoute } from './memory-source-route';
import { artifactDisplay, materialKind, materialState, sourceDisplay } from './material-presentation';
export type Material = {
    id: string;
    ref: string;
    revision: string;
    kind: string;
    schemaVersion: number;
    title: string;
    sequence: number;
    textLength: number;
    blockCount: number;
    coverage: {
        state: string;
        reason?: string;
    };
    origin: {
        sourceId: string;
        externalId?: string;
        provider?: string;
        sessionId?: string;
        deviceId?: string;
        firstAt?: string;
        lastAt?: string;
    };
    createdAt?: string;
    updatedAt?: string;
    artifacts?: {
        key: string;
        state: string;
        reason?: string;
    }[];
    indexing?: {
        state: 'disabled' | 'pending' | 'running' | 'indexed' | 'failed';
        reason?: string;
    };
    retention: {
        original: string;
    };
    attributionContext?: AttributionContext;
    memorySource?: {
        status: 'ready' | 'waiting' | 'unavailable' | 'too_large';
        evidenceIds: string[];
    };
};
type ReadPage = {
    material: Material;
    text: string;
    spans?:NoteReadSpan[];
    textRange: {
        offset: number;
        total: number;
        nextOffset: number | null;
    };
};
const noteReaderOwners=new WeakMap<Api,number>();let nextNoteReaderOwner=0;
function noteReaderKey(api:Api,ref:string){if(!noteReaderOwners.has(api))noteReaderOwners.set(api,++nextNoteReaderOwner);return noteReaderOwners.get(api)+':'+ref;}
function installNoteReaderStyle(){if(document.querySelector('link[data-mote-note-material]'))return;const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./note-material-final.css?no-inline',import.meta.url).href;link.dataset.moteNoteMaterial='';document.head.append(link);}
function NoteAsset({api,span,onOpen}:{api:Api;span:NoteReadSpan;onOpen:(ref:string)=>void}){
 const target=noteAssetTarget(span),file=useResource<ArchivedFile>(api,target?.kind==='archive'?'/api/archived-files/'+encodeURIComponent(target.id):null);
 const matched=file.data?.id===target?.id&&file.data?.hash===span.asset?.hash&&file.data?.mimeType===span.asset?.mimeType;
 return <div className="note-material-asset"><span>{matched?file.data!.name:moteText('附件')}<small>{span.asset?.mimeType}</small></span>{target?.kind==='capture'?<button className="text-button" onClick={()=>onOpen('capture:'+target.id)}>{moteText('查看原始记录')}</button>:target?.kind==='archive'?file.error?<span role="alert">{errorMessage(file.error)} <button className="text-button" onClick={file.refresh}>{moteText('重试')}</button></span>:matched?<ArchivedFileButton api={api} id={target.id} name={file.data!.name}/>:file.loading?<span role="status">{moteText('正在读取…')}</span>:<span role="status">{moteText('此版本已变化，请返回资料列表重新选择。')}</span>:span.evidenceId&&/^[a-f0-9-]{36}$/i.test(span.evidenceId)?<button className="text-button" onClick={()=>onOpen('capture:'+span.evidenceId)}>{moteText('查看原始记录')}</button>:null}</div>;
}
const savedQuoteReturns=new WeakMap<Api,Map<string,{identity:string;token:string;parent:string;child:string}>>();
function NoteMaterialQuote({api,page,span,text,onOpen,onSettled}:{api:Api;page:ReadPage;span:NoteReadSpan;text:string;onOpen:(ref:string)=>void;onSettled?:(instance:object)=>void}){
 const id=noteQuoteCaptureId(page,span),ref=page.material.ref,instance=useRef({}),pending=useRef<AbortController|null>(null);
 const [state,setState]=useState<{owner:Api;ref:string;id:string;capture?:Capture;failed?:boolean}>(),[expandedKey,setExpandedKey]=useState(''),[busy,setBusy]=useState(false),[expandError,setExpandError]=useState(false);
 useEffect(()=>{
  if(!id)return;
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,reading=false,again=false,hidden=document.hidden;
  setState(undefined);
  function schedule(){clearTimeout(timer);if(!controller.signal.aborted&&!document.hidden)timer=setTimeout(()=>{if(!document.hidden)void read();},5000);}
  async function read(){
   if(controller.signal.aborted)return;
   if(reading){again=true;return;}reading=true;
   try{const capture=await api.request<Capture>('/api/capture-browser/'+encodeURIComponent(id!),{signal:controller.signal});if(!controller.signal.aborted)setState({owner:api,ref,id:id!,capture});}
   catch{if(!controller.signal.aborted)setState({owner:api,ref,id:id!,failed:true});}
   finally{reading=false;const fresh=again&&!document.hidden;again=false;if(!controller.signal.aborted){if(fresh)void read();else schedule();}}
  }
  function visibility(){if(hidden===document.hidden)return;hidden=document.hidden;clearTimeout(timer);if(hidden)again=false;else void read();}
  document.addEventListener('visibilitychange',visibility);
  void read();return()=>{controller.abort();clearTimeout(timer);document.removeEventListener('visibilitychange',visibility);};
 },[api,ref,id]);
 const current=state?.owner===api&&state.ref===ref&&state.id===id?state:undefined,capture=current?.capture,origin=capture?.metadata?.noteOrigin,blockStart=span.materialRange.start-(span.evidenceOffset??0);
 const ownerOrigin=capture&&id&&capture.id===id&&capture.source==='note'&&origin?.kind==='conversation'&&origin.conversationId&&origin.messageIds?.length===1&&typeof origin.text==='string'?origin:undefined;
 const validSlice=Boolean(ownerOrigin&&span.evidenceOffset!==undefined&&text===(ownerOrigin.text+'\n').slice(span.evidenceOffset,span.evidenceOffset+text.length));
 const full=Boolean(ownerOrigin&&span.evidenceOffset===0&&(text===ownerOrigin.text||text===ownerOrigin.text+'\n'));
 const returnKey=JSON.stringify([ref,id,blockStart]),snapshot=ownerOrigin?.text,conversationId=ownerOrigin?.conversationId,turnId=ownerOrigin?.messageIds?.[0],identity=JSON.stringify([snapshot,conversationId,turnId]),expanded=Boolean(snapshot&&expandedKey===identity);
 const latest=useRef({api,ref,id,snapshot,conversationId,turnId,text});latest.current={api,ref,id,snapshot,conversationId,turnId,text};
 useEffect(()=>()=>{pending.current?.abort();pending.current=null;},[api,ref,id,snapshot,conversationId,turnId,text]);
 useEffect(()=>{
  const value=savedQuoteReturns.get(api)?.get(returnKey),receipt=window.history.state?.moteSavedQuoteReturn;
  if(value&&value.identity===identity&&validSlice&&value.parent===window.location.hash&&receipt?.token===value.token&&receipt.parent===value.parent&&receipt.child===value.child){
   setExpandedKey(identity);
  }
 },[api,returnKey,identity,validSlice,onSettled]);
 const matched=Boolean(ownerOrigin&&validSlice&&(full||expanded));
 const returning=savedQuoteReturns.get(api)?.get(returnKey),receipt=window.history.state?.moteSavedQuoteReturn;
 const awaitingReturn=Boolean(returning&&returning.identity===identity&&validSlice&&receipt?.token===returning.token&&receipt.parent===returning.parent&&receipt.child===returning.child);
 useEffect(()=>{if(!id||current&&!matched&&!awaitingReturn)onSettled?.(instance.current);},[id,current,matched,awaitingReturn,onSettled]);
 async function expand(){
  if(!id||!ownerOrigin?.text||!ownerOrigin.conversationId||!ownerOrigin.messageIds?.[0]||!validSlice||pending.current)return;
  const controller=new AbortController(),owner=api,materialRef=ref,quote=ownerOrigin.text,conversation=ownerOrigin.conversationId,turn=ownerOrigin.messageIds[0],pageText=text;pending.current=controller;setBusy(true);setExpandError(false);
  const valid=()=>!controller.signal.aborted&&pending.current===controller&&latest.current.api===owner&&latest.current.ref===materialRef&&latest.current.id===id&&latest.current.snapshot===quote&&latest.current.conversationId===conversation&&latest.current.turnId===turn&&latest.current.text===pageText;
  try{await verifyCompleteNoteQuote(api,page,span,id,quote,conversation,turn,controller.signal);if(valid())setExpandedKey(identity);}
  catch{if(valid())setExpandError(true);}
  finally{if(pending.current===controller){pending.current=null;setBusy(false);}}
 }
 const cancel=()=>{pending.current?.abort();pending.current=null;setBusy(false);setExpandError(false);};
 const open=(target:string)=>{if(expanded&&snapshot&&readEvidenceRoute(window.location.hash)===ref){const parent=window.location.hash,token=crypto.randomUUID();let values=savedQuoteReturns.get(api);if(!values){values=new Map();savedQuoteReturns.set(api,values);}if(values.size>=32)values.delete(values.keys().next().value!);values.set(returnKey,{identity,token,parent,child:target});window.history.replaceState({...window.history.state,moteSavedQuoteReturn:{token,parent,child:target}},'',window.location.href);}onOpen(target);};
 if(!matched||!id||!ownerOrigin?.conversationId||!ownerOrigin.messageIds?.[0])return <><pre>{text}</pre>{current?.failed&&<p role="status">{moteText('原文暂不可用')}</p>}{validSlice&&!full&&<div className="processing-actions">{busy?<><span role="status">{moteText('正在读取…')}</span><button className="text-button" onClick={cancel}>{moteText('取消')}</button></>:<button className="text-button" onClick={()=>void expand()}>{moteText('查看全部内容')}</button>}{expandError&&<p role="status">{moteText('原文暂不可用')}</p>}</div>}</>;
 return <section className="note-origin"><ConversationOrigin key={id+ownerOrigin.conversationId+ownerOrigin.messageIds[0]} api={api} conversationId={ownerOrigin.conversationId} turnId={ownerOrigin.messageIds[0]} text={ownerOrigin.text!} fallbackText={text} onOpen={open} onSettled={onSettled}/>{expanded&&!full&&<button className="text-button" onClick={()=>{const value=savedQuoteReturns.get(api)?.get(returnKey);savedQuoteReturns.get(api)?.delete(returnKey);if(value&&window.history.state?.moteSavedQuoteReturn?.token===value.token){const {moteSavedQuoteReturn:_,...state}=window.history.state;window.history.replaceState(state,'',window.location.href);}setExpandedKey('');}}>{moteText('收起')}</button>}</section>;
}
function NoteMaterialBody({api,page,onOpen,onOpenSavedOrigin,onSavedOriginSettled,offset,onOffset}:{api:Api;page:ReadPage;onOpen:(ref:string)=>void;onOpenSavedOrigin:(ref:string)=>void;onSavedOriginSettled?:(instance:object)=>void;offset:number;onOffset:(offset:number)=>void}){
 useEffect(installNoteReaderStyle,[]);const [quoteOpen,setQuoteOpen]=useState(true),content=noteMaterialPage(page),hasBody=content.quotes.length+content.records.length+content.other.length>0,emptyInstance=useRef({});
 useEffect(()=>{if(!content.quoteSpans.length)onSavedOriginSettled?.(emptyInstance.current);},[content.quoteSpans.length,onSavedOriginSettled]);
 return <section className="note-material-body">{content.quotes.length>0&&<details className="note-material-quote" open={quoteOpen} onToggle={event=>setQuoteOpen(event.currentTarget.open)}><summary>{moteText('引用原文')}</summary>{content.quoteSpans.map(({span,text},index)=><NoteMaterialQuote key={span.materialRange.start+':'+index} api={api} page={page} span={span} text={text} onOpen={onOpenSavedOrigin} onSettled={onSavedOriginSettled}/>)}</details>}{content.records.length>0&&<section className="note-material-record"><h3>{content.quotes.length?moteText('我的补充'):moteText('用户原文')}</h3>{content.records.map((text,index)=><pre key={index}>{text}</pre>)}</section>}{content.other.map((text,index)=><pre key={index}>{text}</pre>)}{!hasBody&&<p role="status">{moteText('本页暂无文字正文。')}</p>}{content.assets.length>0&&<section className="note-material-assets"><h3>{moteText('附件')}</h3>{content.assets.map(span=><NoteAsset key={span.blockId+':'+span.pageRange.start} api={api} span={span} onOpen={onOpen}/>)}</section>}{content.descriptions.length>0&&<details className="note-material-description"><summary>{moteText('资料说明')}</summary>{content.descriptions.map((text,index)=><pre key={index}>{text}</pre>)}</details>}<details className="note-material-technical"><summary>{moteText('技术详情')}</summary><pre>{page.text}</pre><p>{moteText('从第 {0} 个字符开始',offset+1)} · {page.textRange.total}</p></details><div className="processing-actions">{offset>0&&<button className="button" onClick={()=>onOffset(0)}>{moteText('返回第一页')}</button>}{page.textRange.nextOffset!==null&&<button className="button" onClick={()=>onOffset(page.textRange.nextOffset!)}>{moteText('继续展开')}</button>}</div></section>;
}
type Scope = {
    deviceId?: string;
    after?: string;
    before?: string;
};
export function MaterialDetail({ api, material, onOpen, onOpenSavedOrigin, onSavedOriginSettled, agent = false, scope = {} }: {
    api: Api;
    material: Material;
    onOpen: (ref: string) => void;
    onOpenSavedOrigin?: (ref:string)=>void;
    onSavedOriginSettled?: (instance:object)=>void;
    agent?: boolean;
    scope?: Scope;
}) {
    const [sourceTools,setSourceTools]=useState<HTMLDivElement|null>(null);
    const [offset, setOffset] = useState(()=>{const saved=window.history.state?.moteMaterialReturn;return saved?.ref===material.ref&&Number.isSafeInteger(saved.offset)&&saved.offset>=0?saved.offset:0;}), [tab, setTab] = useState('body'),[memberOffset,setMemberOffset]=useState(0), [indexBusy, setIndexBusy] = useState(false), [indexError, setIndexError] = useState('');
    // Each range is pinned to the selected revision. Identity is also the React key.
    const scopeQuery = new URLSearchParams(scope).toString();
    const read = useResource<ReadPage>(api, agent ? `/api/agent-view/material-read?ref=${encodeURIComponent(material.ref)}&offset=${offset}&${scopeQuery}` : `/api/materials/${encodeURIComponent(material.id)}/read?revision=${material.revision}&offset=${offset}&length=4000`, 5000);
    const current = useResource<Material>(api, agent ? null : `/api/materials/${encodeURIComponent(material.id)}`, 5000);
    const members = useResource<{
        items: {
            id: string;
            kind: string;
            ref: string;
        }[];
        nextOffset: number | null;
    }>(api, !agent && tab === 'origin' ? `/api/materials/${encodeURIComponent(material.id)}/members?revision=${material.revision}&offset=${memberOffset}&limit=20` : null);
    const sourceNames = useResource<{
        items: {
            id: string;
            name: string;
        }[];
    }>(api, !agent && tab === 'origin' ? '/api/sources' : null);
    const presentation = useResource<LibraryCatalogDescriptor>(api, agent ? null : '/api/library/descriptor', 5000);
    const selected = current.error === undefined && current.data?.revision === material.revision ? current.data : read.error === undefined ? read.data?.material ?? material : material;
    const rebuilding = selected.coverage.reason === 'source_evidence_changed' || read.error instanceof ApiError && read.error.status === 409;
    const historical = current.error === undefined && current.data && current.data.revision !== material.revision;
    const memorySource = !agent && !historical && current.error === undefined && current.data?.ref === material.ref ? current.data.memorySource : undefined;
    const catalog = (presentation.data?.schemaVersion === 1 && Array.isArray(presentation.data.types) ? presentation.data.types : []).find(type => type.kind === selected.kind && type.schemaVersion === selected.schemaVersion);
    const ownerNote=!agent&&material.kind==='mote.note'&&material.schemaVersion===2;
    const failureInstance=useRef({});
    useEffect(()=>{if(read.error!==undefined||current.error!==undefined)onSavedOriginSettled?.(failureInstance.current);},[read.error,current.error,onSavedOriginSettled]);
    const openSavedOrigin=(ref:string)=>{if(onOpenSavedOrigin){if(readEvidenceRoute(window.location.hash)===material.ref)window.history.replaceState({...window.history.state,moteMaterialReturn:{ref:material.ref,offset}},'',window.location.href);onOpenSavedOrigin(ref);}else onOpen(ref);};
    const retry = () => { read.refresh(); current.refresh(); };
    const retryIndex = async () => { setIndexBusy(true); setIndexError(''); try {
        await api.request(`/api/materials/${encodeURIComponent(material.id)}/index/retry`, { method: 'POST' });
        retry();
    }
    catch (error) {
        setIndexError(errorMessage(error));
    }
    finally {
        setIndexBusy(false);
    } };
    return <SourceMaterialToolsContext.Provider value={{target:sourceTools}}><article className={'panel panel-pad material-detail'+(ownerNote?' note-material-reader':'')}>{!agent&&!historical&&current.error===undefined&&current.data?.ref===material.ref&&read.error===undefined&&read.data?.material.ref===material.ref&&<a className="button material-reader-ask" href={originalReferenceRoute('material',selected.ref)} onClick={event=>{if(!confirmNavigation()){event.preventDefault();return;}rememberOriginalReturn(api,'material',selected.ref);}}>{moteText('问问 AI')} ↗</a>}<h2>{selected.title}</h2><p>{materialKind(selected.kind, catalog?.label)}{!ownerNote&&<> · {sourceDisplay(selected.origin.sourceId)}</>}{(selected.origin.lastAt??selected.origin.firstAt)&&<> · {dateTime((selected.origin.lastAt??selected.origin.firstAt)!)}</>}</p>
    {['pending', 'running'].includes(selected.indexing?.state ?? '') && <p role="status">{moteText('资料已发布，检索索引正在处理中。')}</p>}
    {selected.indexing?.state === 'failed' && <p role="status">{moteText('检索索引未完成，正文可正常查看。')}{!agent && !historical && current.error === undefined && current.data?.ref === material.ref && <button className="button" disabled={indexBusy} onClick={() => void retryIndex()}>{moteText('仅重试检索索引')}</button>}</p>}
    {indexError && <p role="alert">{indexError}</p>}
    {historical && <p role="status">{moteText('这是历史版本，当前资料已更新。')} <button className="button" onClick={() => onOpen(current.data!.ref)}>{moteText('查看当前版本')}</button></p>}
    {rebuilding ? <p role="status">{moteText('来源已更正，正在重新整理资料。完成后可继续查看。')} <button onClick={retry}>{moteText('刷新')}</button></p> : read.error !== undefined && <p role="alert">{errorMessage(read.error)} <button onClick={retry}>{moteText('重试')}</button></p>}
    {current.error !== undefined && <p role="alert">{errorMessage(current.error)} <button onClick={retry}>{moteText('重试')}</button></p>}
    {!rebuilding && read.error === undefined && current.error === undefined && read.data && read.data.material.ref===material.ref && <FeatureView catalog={catalog} api={api} onOpen={onOpen} value={{ ...selected, representation: agent ? 'markdown' : 'owner-material', text: read.data.text }} fallback={ownerNote?<NoteMaterialBody key={noteReaderKey(api,material.ref)} api={api} page={read.data} onOpen={onOpen} onOpenSavedOrigin={openSavedOrigin} onSavedOriginSettled={onSavedOriginSettled} offset={offset} onOffset={setOffset}/>:<><AnswerMarkdown onOpen={onOpen} answer={{ answer: read.data.text, runId: selected.ref, trace: [], citations: [] }}/><p className="fine-print">{moteText('从第 {0} 个字符开始', offset + 1)} · {read.data.textRange.total}</p><div className="processing-actions">{offset > 0 && <button className="button" onClick={() => setOffset(0)}>{moteText('返回第一页')}</button>}{read.data.textRange.nextOffset !== null && <button className="button" onClick={() => setOffset(read.data!.textRange.nextOffset!)}>{moteText('继续展开')}</button>}</div></>}/>}
    {!agent && <FeatureActions position="detail" catalog={catalog} api={api} onOpen={onOpen} value={{ ...selected, representation: 'owner-material', text: read.data?.text ?? '' }}/>}
    <div className="reader-source-details"><button className="text-button" aria-expanded={tab==='origin'} onClick={()=>{setTab(tab==='origin'?'body':'origin');setMemberOffset(0);}}>{moteText('来源与处理')}</button>{tab === 'origin' && <><div className="source-material-tools-target" ref={setSourceTools}/>    {memorySource?.status === 'ready' && <a className="button" href={memoryMaterialRoute(selected.ref)}>{moteText('仅从这份正式资料提取记忆')}</a>}
    {memorySource && memorySource.status !== 'ready' && <p role="status">{moteText('这份正式资料暂不能单独提取记忆，请查看来源与处理状态。')}</p>}
<AttributionSummary context={selected.attributionContext}/>{!agent && !historical && current.error === undefined && current.data?.ref === material.ref && <><FeaturePanels api={api} onOpen={onOpen} value={{ kind: 'mote.material.context', schemaVersion: 1, representation: 'source-context', ref: selected.ref, revision: selected.revision, title: selected.title, text: '' }}/><AttributionEditor key={selected.ref} api={api} path={`/api/materials/${encodeURIComponent(selected.id)}/context`} revision={selected.revision} value={selected.attributionContext?.correction?.ownerRelation} onSaved={result => onOpen(result.ref)}/></>}{!agent&&<div className="source-toolbar"><a className="button subtle" href={'#/connections?sourceId='+encodeURIComponent(selected.origin.sourceId)}>{moteText('管理来源')}</a><a className="button subtle" href={'#/activity?materialId='+encodeURIComponent(selected.id)}>{moteText('相关活动')}</a></div>}<dl className="discovery-material-facts"><dt>{moteText('来源')}</dt><dd>{sourceDisplay(selected.origin.sourceId, sourceNames.data?.items?.find(source => source.id === selected.origin.sourceId)?.name)}</dd><dt>{moteText('原始记录')}</dt><dd>{materialState(selected.retention.original)}</dd><dt>{moteText('覆盖状态')}</dt><dd>{materialState(selected.coverage.state)}</dd></dl>{selected.coverage.state !== 'complete' && <p role="status">{moteText("资料范围尚不完整或仍在整理。请核对已有正文；缺失部分不能作为已经读取的证据。")}</p>}<details><summary>{moteText("技术标识与状态原因")}</summary><div className="discovery-technical-id"><p>{moteText("来源 ID：")}{selected.origin.sourceId}</p><p>{moteText("类型：")}{selected.kind} · {selected.coverage.state} · {selected.retention.original}</p><p>{moteText("覆盖原因：")}{selected.coverage.reason ?? '—'}</p></div></details><h3>{moteText('已记录的处理产物')}</h3>{selected.artifacts?.map(a => <div key={a.key}><p>{artifactDisplay(a.key)} · {materialState(a.state)}</p><details><summary>{moteText("查看产物标识与状态原因")}</summary><code className="discovery-technical-id">{a.key} · {a.state} · {a.reason ?? '—'}</code></details></div>)}{!agent && <><h3>{moteText('来源与定位')}</h3>{members.error !== undefined && <p role="alert">{errorMessage(members.error)}</p>}{members.data?.items.map(m => <p key={m.id}>{m.kind==='capture'&&<button className="text-button" onClick={()=>onOpen(m.ref)}>{moteText('查看原始记录')}</button>}<code>{m.kind} · {m.ref}</code></p>)}{members.data?.nextOffset != null && <button className="button" onClick={() => setMemberOffset(members.data!.nextOffset!)}>{moteText('下一页')}</button>}</>}</>}</div>
  </article></SourceMaterialToolsContext.Provider>;
}
export function Materials({ api, onOpen, kind, sourceId, agent = false, scope = {} }: {
    api: Api;
    onOpen: (ref: string) => void;
    kind?: string;
    sourceId?: string;
    agent?: boolean;
    scope?: Scope;
}) {
    const [cursor, setCursor] = useState<string>(), [selected, setSelected] = useState<Material>();
    const query = new URLSearchParams({ limit: '12', ...(cursor ? { cursor } : {}), ...(kind ? { kind } : {}), ...(sourceId ? { sourceId } : {}), ...scope });
    const page = useResource<{
        items: Material[];
        nextCursor: string | null;
    }>(api, (agent ? '/api/agent-view/materials' : '/api/materials') + '?' + query);
    return <section className="materials-browser"><div className="page-heading"><h1>{moteText('正式资料')}</h1><p>{moteText('查看中央端发布的正文、版本、来源和处理产物。')}</p></div><button className="button" onClick={() => { setSelected(undefined); page.refresh(); }}>{moteText('刷新')}</button>{page.error !== undefined && <p role="alert">{errorMessage(page.error)}</p>}{page.loading && !page.data && <p role="status">{moteText('正在读取…')}</p>}
    {page.data && <><div className="feature-cards">{page.data.items.map(m => <button className="panel source-item" key={m.ref} onClick={() => setSelected(m)}><strong>{m.title}</strong><p>{materialKind(m.kind)} · {materialState(m.coverage.state)} · {m.textLength}{' '}{moteText("字符")}</p></button>)}</div>{!page.data.items.length && <p>{moteText('当前范围内暂无已发布资料。')}</p>}<div className="processing-actions">{cursor && <button className="button" onClick={() => { setCursor(undefined); setSelected(undefined); }}>{moteText('返回第一页')}</button>}{page.data.nextCursor && <button className="button" onClick={() => { setCursor(page.data!.nextCursor!); setSelected(undefined); }}>{moteText('下一页')}</button>}</div></>}
    {selected && page.error === undefined && <MaterialDetail key={selected.ref} api={api} material={selected} onOpen={onOpen} agent={agent} scope={scope}/>}
  </section>;
}
