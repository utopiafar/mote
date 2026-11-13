import { commonFailureMessage,httpStatusMessage,formatEvidenceRef } from '@mote/shared';
import { useResource } from '../../useResource';
import { resources } from '../../resource-cache';
import { useOperationUpdates } from '../../useOperationUpdates';
import { moteText, cjkLocale } from '@mote/shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw, FolderInput, Layers3, Plus, X,ChevronRight,FileText,Monitor,Mail,CalendarDays,Link2,Code2,Mic } from 'lucide-react';
import type { SourceConnection, SourceItemRecord,LibrarySourceFacet } from '@mote/shared';
import { ApiError,type Api, errorMessage, dateTime } from '../../api';
import {archivePageWithdrawn,currentArchivePages,mergeArchivePage,reconcileArchivePages,type ArchivePage,type ArchivePages} from '../../archive-pages';
import { sourceMetadataSchema } from '@mote/shared';
import { AttributionEditor } from '../../AttributionContext';
import { SourceContextEditor } from './SourceContextEditor';
import { Metadata } from '../../Metadata';
import { useHashChoice } from '../../useHashChoice';
import {useSourceConnectorStyle} from '../../source-connectors-ui';
import { recordingSourceStatus, recordingSyncText } from '../../recording-status';
import {sourcePluginBound,sourcePluginFor,sourcePluginStatus,sourcePlugins} from './registry';
import { Loading } from '../../Loading';
import {FileRetentionSettings} from './FileRetentionSettings';
const readSource=(hash:string)=>new URLSearchParams(hash.split('?')[1]??'').get('sourceId');
const readSetup=(hash:string)=>{const value=new URLSearchParams(hash.slice(hash.indexOf('?')+1)).get('setup');return value&&['gmail','google','mcp','reference'].includes(value)?value:null;};
const layerNames: Record<string, string> = { reference: moteText("引用 / Shadow"), snapshot: moteText("内容快照"), original: moteText("原始文本"), derived: moteText("派生记录") };
const kindNames: Record<string, string> = { 'coding-agent': moteText("编码 Agent 对话"), 'local-files': moteText("客户端文件"), 'local-calendar': moteText("本地日历"), 'local-meeting-recording': moteText("本机会议录音"), 'google-calendar': 'Google Calendar', gmail: 'Gmail', 'lark-docs': moteText('飞书文档'), 'lark-calendar': moteText('飞书日历'), mcp: moteText("MCP 来源"), upload: moteText("文件导入"), custom: moteText("自定义来源") };
const sourceStyleHref=new URL('../../source-final.css',import.meta.url).href;
function useSourceStyle(){useEffect(()=>{if(document.head.querySelector('link[data-mote-source-final]'))return;const link=document.createElement('link');link.rel='stylesheet';link.href=sourceStyleHref;link.dataset.moteSourceFinal='true';document.head.append(link);},[]);}
const sourceIcon=(kind:string)=>({'local-files':FileText,'coding-agent':Code2,'local-calendar':CalendarDays,'local-meeting-recording':Mic,'google-calendar':CalendarDays,gmail:Mail,'lark-calendar':CalendarDays,'lark-docs':FileText,mcp:Link2,upload:FolderInput}[kind]??(kind.endsWith('.recordings')?Mic:Monitor));
const sourceConnectionLink=(source:SourceConnection,recording:ReturnType<typeof recordingSourceStatus>)=>recording?'#/connections/recordings?provider='+encodeURIComponent(recording.provider):source.kind.startsWith('lark-')?'#/connections/lark':(['google-calendar','gmail','mcp'].includes(source.kind)?'#/connections?setup='+({'google-calendar':'google',gmail:'gmail',mcp:'mcp'}[source.kind]):source.kind==='coding-agent'?'#/library?view=coding-status':null);
function sourceStatus(source:SourceConnection,catalog:Record<string,unknown>|null){const recording=recordingSourceStatus(source,catalog);return recording?recordingSyncText(recording.status,source):!source.enabled&&!['error','permission_required'].includes(source.status?.state??'')?moteText('已暂停'):({idle:!source.enabled?moteText('已暂停'):source.capabilities?.lifecycle==='one-shot'?moteText('一次导入来源'):source.capabilities?.lifecycle==='external-push'?moteText('等待外部写入'):moteText('等待下次同步'),syncing:moteText('同步中'),error:moteText('需要处理'),permission_required:moteText('需要重新授权')} as Record<string,string>)[source.status?.state??'']??moteText('等待同步');}
export function Sources({ api, onOpen, onImport, mode = 'connections', onBrowse, onAdd }: {
    api: Api;
    onOpen: (id: string) => void;
    onImport: () => void;
    mode?: 'connections' | 'library';
    onBrowse?: () => void;
    onAdd?: () => void;
}) {
    useSourceStyle();useSourceConnectorStyle();
    const Heading = mode === 'library' ? 'h2' : 'h1';
    const [sourceKind,setSourceKind]=useState(''),[attentionOnly,setAttentionOnly]=useState(false),[sourceSearch,setSourceSearch]=useState('');
    const [detailChoice,setDetailChoice]=useState<{api:Api;source:string;tab:'content'|'connection'}>();
    const [selectedChoice, chooseSource] = useHashChoice('sourceId', readSource);
    const selected=selectedChoice??'';
    const detailTab=detailChoice?.api===api&&detailChoice.source===selected?detailChoice.tab:'content';
    const [listPosition,setListPosition]=useState<{api:Api;scroll:number;opener:HTMLElement|null}>();
    const choose=(id:string|null)=>{if(id&&!selected)setListPosition({api,scroll:window.scrollY,opener:document.activeElement as HTMLElement|null});chooseSource(id);};
    useEffect(()=>{if(selected||!listPosition||listPosition.api!==api)return;listPosition.opener?.isConnected&&listPosition.opener.focus({preventScroll:true});if(window.scrollY!==listPosition.scroll)window.scrollTo({top:listPosition.scroll});},[api,selected,listPosition]);
    const activeApi=useRef(api);activeApi.current=api;
    const visit=useRef({api,source:selected});if(visit.current.api!==api||visit.current.source!==selected)visit.current={api,source:selected};
    const connectionVisit=useRef<typeof visit.current|undefined>(undefined);if(detailTab==='connection')connectionVisit.current=visit.current;
    const renderVisit=visit.current,mutationVisit=useRef<typeof visit.current|undefined>(undefined);
    const [storedMutationError,setError]=useState(''),[storedBusy,setBusy]=useState(false),[historyChoice,setHistoryChoice]=useState<{visit:typeof visit.current;path:string}>();
    const mutationError=mutationVisit.current===visit.current?storedMutationError:'',busy=mutationVisit.current===visit.current&&storedBusy;
    const historyKey=historyChoice?.visit===visit.current?historyChoice.path:null;
    const setHistoryKey=(path:string|null)=>setHistoryChoice(path?{visit:visit.current,path}:undefined);
    const [pages, setPages] = useState<ArchivePages<SourceItemRecord>>();
    const listScope = JSON.stringify([mode, selected]), currentPages = currentArchivePages(pages,api,listScope), cursor = currentPages?.cursor;
    const [requestedSetup,chooseSetup]=useHashChoice('setup',readSetup);
    const [adding,setAdding]=useState(Boolean(requestedSetup)),[addKind,setAddKind]=useState<'files'|'reference'|'connectors'>(requestedSetup==='reference'?'reference':requestedSetup?'connectors':'files');
    useEffect(()=>{setAdding(Boolean(requestedSetup));if(requestedSetup)setAddKind(requestedSetup==='reference'?'reference':'connectors');},[requestedSetup]);
    const sourceList = useResource<{
        items: SourceConnection[];
    }>(api, '/api/sources');
    const page = useResource<ArchivePage<SourceItemRecord>>(api, (mode === 'library'||!!selected) ? '/api/source-items?' + new URLSearchParams({ limit: '30', ...(selected ? { sourceId: selected } : {}), ...(cursor ? { cursor } : {}) }) : null);
    const versions = useResource<{
        items: SourceItemRecord[];
    }>(api, historyKey);
    const libraryCatalog=useResource<{sources:LibrarySourceFacet[];sourcesTruncated:boolean}>(api,'/api/library/browse?limit=1');
    const libraryCount=(id:string)=>{const current=!libraryCatalog.loading&&!libraryCatalog.error&&libraryCatalog.data;if(!current||!Array.isArray(current.sources))return undefined;const facet=current.sources.find(item=>item.id===id);if(facet)return Number.isSafeInteger(facet.count)&&facet.count>=0?facet.count:undefined;return current.sourcesTruncated===false?0:undefined;};
    const countLabel=(id:string)=>{const count=libraryCount(id);return count===undefined?moteText('资料数量待确认'):moteText('资料库中有 {0} 份资料',count);};
    const connectorStatus = useResource<Record<string, unknown>>(api, '/api/connectors/status');
    useOperationUpdates(api);
    const withdrawn = archivePageWithdrawn(page.error);
    useEffect(() => { setPages(value => reconcileArchivePages(value,api,listScope,withdrawn)); }, [api, listScope, withdrawn]);
    useEffect(() => { setBusy(false);setError('');setSourceKind('');setAttentionOnly(false);setSourceSearch('');setDetailChoice(undefined); }, [api]);
    const sources = sourceList.data?.items ?? [], items = mergeArchivePage(currentPages,page.data?.items??[],withdrawn), nextCursor = page.data?.nextCursor, history = versions.data?.items ?? null, catalog = connectorStatus.data ?? null, loading = sourceList.loading || page.loading;
    const initialLoading = page.loading && page.data === undefined;
    const readError = sourceList.error || page.error || versions.error || connectorStatus.error, technicalError=mutationError||(readError?errorMessage(readError):''),error=mutationError?moteText('操作未完成，请重试'):readError?(readError instanceof ApiError?(readError.code&&commonFailureMessage(readError.code,readError.status)||httpStatusMessage(readError.status)):moteText('状态读取失败。')):'';
    async function refresh(source = selected) { if(activeApi.current!==api||visit.current!==renderVisit)return;setError(''); setHistoryKey(null); setPages(undefined); resources(api).invalidate(key => /^\/api\/(sources|source-items|library\/browse|connectors\/status)([/?]|$)/.test(key)); }
    function loadHistory(item: SourceItemRecord) { if(visit.current!==renderVisit||selected&&item.sourceId!==selected)return;setHistoryKey('/api/sources/' + encodeURIComponent(item.sourceId) + '/history?externalId=' + encodeURIComponent(item.externalId)); }
    function more() { if (!nextCursor || loading)
        return; setPages({api,scope:listScope,previous:items,cursor:nextCursor}); }
    async function run(task: () => Promise<void>) { const owner=visit.current,current=()=>visit.current===owner&&activeApi.current===api;mutationVisit.current=owner;setBusy(true);setError('');try {
        await task();
        if(current())await refresh();
    }
    catch (e) {
        if(current())setError(errorMessage(e));
    }
    finally {
        if(current())setBusy(false);
    } }
    const filteredSources=sources.filter(source=>(!sourceSearch||(source.name+' '+(kindNames[source.kind]??source.kind)).toLocaleLowerCase().includes(sourceSearch.toLocaleLowerCase()))&&(!sourceKind||source.kind===sourceKind)&&(!attentionOnly||['error','permission_required'].includes(source.status?.state??'')));
    const sourceContent=mode==='library'?<div className="source-final-originals">{initialLoading ? <Loading/> : items.length === 0 && !error ? <p className="muted">{moteText("还没有资料。连接来源或导入文件后，它们会出现在这里。")}</p> : items.map(item => <article className="source-item" key={item.captureId}><div><strong>{item.title || moteText("未命名记录")}</strong><span className="badge">{layerNames[item.layer]}</span></div><p className="muted">{moteText("采集于")}{' '}{dateTime(item.observedAt)} · {item.current ? moteText("当前版本") : moteText("历史版本")}</p>{item.calendar && <p>{moteText("日历安排：")}{dateTime(item.calendar.start)} — {dateTime(item.calendar.end)}{item.calendar.allDay ? moteText("（全天）") : ''} · {item.calendar.status === 'cancelled' ? moteText("已取消") : moteText("计划")}{moteText("，不代表实际参加。")}</p>}<p>{item.layer === 'reference' ? moteText("原文仍在外部来源，此处没有收集正文。") : item.text.slice(0, 300)}</p>{item.uri && <details><summary>{moteText("原件位置")}</summary><code>{item.uri}</code><p className="muted">{moteText("这里只展示定位信息，不会自动读取远程地址。")}</p></details>}<Metadata source={item.metadata} modifiedAt={item.modifiedAt}/><div className="source-toolbar"><button className="button" onClick={() => onOpen(formatEvidenceRef('capture', item.captureId))}>{moteText("展开证据")}</button><button className="button" onClick={() => void loadHistory(item)}>{moteText("查看版本")}</button></div></article>)}{nextCursor && <button disabled={loading} className="button" onClick={() => void more()}>{moteText("更多资料")}</button>}</div>:<div className="source-final-originals">{initialLoading?<Loading/>:!items.length&&!error?<p className="muted">{moteText('此列表暂无原始记录；已有资料可在资料库查看。')}</p>:items.map(item=><div className="source-final-record" key={item.captureId}><button className="source-final-record-open" onClick={()=>onOpen(formatEvidenceRef('capture',item.captureId))}><span className="source-final-symbol">{item.kind==='calendar'?<CalendarDays size={18}/>:<FileText size={18}/>}</span><span><strong>{item.title||moteText('未命名记录')}</strong><small>{item.layer==='reference'?moteText('原文仍在外部来源，此处没有收集正文。'):item.text}</small></span><time title={moteText('采集于')}>{dateTime(item.observedAt)}</time><ChevronRight size={16}/></button><details className="source-final-record-more"><summary>{moteText('更多')}</summary><p>{item.current?moteText('当前版本'):moteText('历史版本')} · {layerNames[item.layer]}</p>{item.calendar&&<p>{moteText('日历安排：')}{dateTime(item.calendar.start)} — {dateTime(item.calendar.end)}{item.calendar.allDay?moteText('（全天）'):''} · {item.calendar.status==='cancelled'?moteText('已取消'):moteText('计划')}{moteText('，不代表实际参加。')}</p>}{item.uri&&<><code>{item.uri}</code><p>{moteText('这里只展示定位信息，不会自动读取远程地址。')}</p></>}<Metadata source={item.metadata} modifiedAt={item.modifiedAt}/><button className="text-button" onClick={()=>void loadHistory(item)}>{moteText('查看版本')}</button></details></div>)}{nextCursor&&<button disabled={loading} className="button" onClick={()=>void more()}>{moteText('更多资料')}</button>}</div>;
    const setupTitle=requestedSetup==='gmail'?'Gmail':requestedSetup==='google'?'Google Calendar':requestedSetup==='mcp'?moteText('MCP 资料服务'):moteText('外部文件 / NAS 引用');
    return <section className={"sources-page final-sources"+(selected?" source-selected":"")+(requestedSetup?" source-external-setup":"")}>{requestedSetup&&<button className="text-button connector-back" onClick={()=>{chooseSetup(null);setAdding(false);}}>{moteText('返回来源')}</button>}{selected&&mode==='connections'&&<button className="text-button source-list-back" onClick={()=>choose(null)}>{moteText("返回来源")}</button>}<div className="page-heading split-heading"><div><div className="eyebrow">{moteText("只连接你选择的内容")}</div><Heading>{requestedSetup?setupTitle:mode==='connections'&&selected?sources.find(source=>source.id===selected)?.name??moteText("来源"):moteText(mode === 'library' ? "来源资料" : "来源")}</Heading><p>{moteText("连接文件与日历，管理保存方式和同步版本。")}</p></div><div className="source-heading-actions">{onBrowse&&!selected&&<button className="button" onClick={onBrowse}>{moteText("浏览来源资料")}</button>}<button className="button subtle" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15}/>{moteText("刷新")}</button>{mode==='connections'&&!selected&&<button className="button" onClick={() => {if(onAdd&&!requestedSetup){onAdd();return;}if(adding&&requestedSetup)chooseSetup(null);else setAdding(v=>!v);}}>{adding ? <X size={16}/> : <Plus size={16}/>} {adding ? moteText("收起添加") : moteText("添加来源")}</button>}</div></div>
 {error&&<div className="source-final-failure"><div className="error-banner" role="alert">{error}</div><details><summary>{moteText('技术详情')}</summary><pre>{technicalError}</pre></details></div>}
 <details className="source-explainer"><summary>{moteText("保留原文，或只留下引用")}</summary><p>{moteText("快照保存当次文字，引用只保存原件位置。资料后续变化会成为新版本，方便查看来处。")}</p></details>
 {mode==='connections'&&<section hidden={!adding||Boolean(selected)} className="panel add-source-panel"><nav hidden={Boolean(requestedSetup)} className="segmented-nav" aria-label={moteText("添加来源方式")}>{([['files', moteText("导入文件")], ['reference', moteText("添加引用")], ['connectors', moteText("连接服务")]] as const).map(([id, label]) => <button key={id} className={addKind === id ? 'active' : ''} onClick={() => setAddKind(id)}>{label}</button>)}</nav><div hidden={addKind !== 'files'}>
 <div className="source-toolbar"><button className="button" onClick={onImport}><FolderInput size={16}/>{moteText("打开导入")}</button><span className="muted">{moteText("支持多个文件、文件夹和 ZIP 压缩包。")}</span></div>
 </div><div hidden={addKind !== 'reference'}><ReferenceEntry api={api} refresh={() => refresh()}/></div>
 <div hidden={addKind !== 'connectors'}>{adding&&!selected&&<ConnectorPanel api={api} catalog={catalog} refresh={() => refresh()} requested={requestedSetup ?? ""}/>}</div></section>}
 {mode==='connections'&&!selected&&<div className="source-list-filters"><label className="source-search"><span className="visually-hidden">{moteText('搜索来源')}</span><input type="search" aria-label={moteText('搜索来源')} value={sourceSearch} maxLength={500} onChange={event=>setSourceSearch(event.target.value)} placeholder={moteText('搜索来源')}/></label><label>{moteText("类型")}<select value={sourceKind} onChange={event=>setSourceKind(event.target.value)}><option value="">{moteText("全部类型")}</option>{[...new Set(sources.map(source=>source.kind))].map(kind=><option key={kind} value={kind}>{kindNames[kind]??kind}</option>)}</select></label><label><input type="checkbox" checked={attentionOnly} onChange={event=>setAttentionOnly(event.target.checked)}/>{moteText("需要处理")}</label></div>}
 <div className={"source-grid " + (mode === 'connections' ? 'connection-catalog' : '')}><aside aria-label={moteText("筛选来源")}><h2 className="source-list-title">{moteText("已连接来源")}{' '}<span>{sources.length}</span></h2><button className={!selected ? 'button active' : 'button'} onClick={() => { choose(null); void refresh(''); }}>{moteText("所有来源")}</button>{filteredSources.map(s => {
     const recording=recordingSourceStatus(s,catalog);
     const Icon=sourceIcon(s.kind),status=sourceStatus(s,catalog);
     return <article key={s.id} className="source-final-row"><button className={selected===s.id?'source-select active':'source-select'} aria-current={selected===s.id?'true':undefined} onClick={()=>{choose(s.id);setHistoryKey(null);void refresh(s.id);}}><span className="source-final-symbol"><Icon size={18}/></span><span className="source-final-copy"><strong>{s.name}</strong><small>{recording?moteText('录音归档'):kindNames[s.kind]??s.kind} · {countLabel(s.id)}</small></span><span className={'source-final-status'+(['error','permission_required'].includes(s.status?.state??'')?' attention':'')}>{status}</span><time>{s.status?.lastSyncAt?dateTime(s.status.lastSyncAt):moteText('尚无同步时间')}</time><ChevronRight size={16}/></button>{mode==='library'&&selected===s.id&&<a className="text-button" href={'#/connections?sourceId='+encodeURIComponent(s.id)}>{moteText('管理来源')}</a>}</article>;

 })}{!sourceList.loading&&!sourceList.error&&!filteredSources.length&&<div className="source-final-empty"><p>{moteText('没有找到来源')}</p>{(sourceSearch||sourceKind||attentionOnly)&&<button className="text-button" onClick={()=>{setSourceSearch('');setSourceKind('');setAttentionOnly(false);}}>{moteText('清除筛选')}</button>}</div>}</aside>
 {mode === 'connections' && <div className="source-configuration">{sources.filter(s=>s.id===selected).map(s=>{
     const recording=recordingSourceStatus(s,catalog);
     const connection=sourceConnectionLink(s,recording),status=sourceStatus(s,catalog),needsAttention=['error','permission_required'].includes(s.status?.state??'');
     return <section key={s.id} className="source-final-detail"><p className="source-final-kind">{recording?moteText('录音归档'):kindNames[s.kind]??s.kind}</p><p className={'source-final-current'+(needsAttention?' attention':'')} role="status">{status}</p>
       {needsAttention&&<div className="source-final-issue"><div><strong>{status}</strong><p>{moteText('新资料同步需要处理；已归档资料仍可查看。')}</p></div>{connection&&<a className="button" href={connection}>{moteText('连接与范围')} →</a>}</div>}
       <div className="source-final-metrics"><div><span>{moteText('资料库中的资料')}</span><strong>{libraryCount(s.id)??moteText('待确认')}</strong></div><div><span>{moteText('最近同步')}</span><strong>{s.status?.lastSyncAt?dateTime(s.status.lastSyncAt):moteText('尚无同步时间')}</strong></div></div>
       <nav className="source-final-tabs" aria-label={moteText('来源详情')}>{([['content','已有资料'],['connection','连接与范围']] as const).map(([tab,label])=><button key={tab} aria-selected={detailTab===tab} onClick={()=>setDetailChoice({api,source:s.id,tab})}>{moteText(label)}</button>)}</nav>
       <div className="source-final-content" hidden={detailTab!=='content'}><a className="text-button source-final-library-entry" href={'#/library?view=materials&sourceId='+encodeURIComponent(s.id)}>{moteText('浏览来源资料')} · {countLabel(s.id)} →</a><h2 className="source-final-originals-heading">{moteText('原始记录')}</h2>{sourceContent}</div>
       <div className="source-final-connection" hidden={detailTab!=='connection'}>{connectionVisit.current===renderVisit&&<SourceConnectionConfig key={s.id} api={api} source={s} catalog={catalog} onOpen={onOpen} refresh={()=>refresh()} onSources={()=>choose(null)}/>}<dl className={['gmail','google-calendar'].includes(s.kind)||s.kind.startsWith('lark-')||recording?'source-connection-source-facts':undefined}><dt>{moteText('读取范围')}</dt><dd>{moteText('当前来源')}{connection&&<> · <a href={connection}>{recording?moteText('录音同步设置'):moteText('在连接设置中查看')}</a></>}</dd><dt>{moteText('保存方式')}</dt><dd>{s.retention==='reference'?moteText('仅保存引用'):s.retention==='archive'?moteText('保留原件'):moteText('内容快照')}</dd><dt>{moteText('连接方式')}</dt><dd>{s.capabilities?.lifecycle==='one-shot'?moteText('一次性导入'):s.capabilities?.lifecycle==='external-push'?moteText('等待外部写入'):s.capabilities?.discovery==='local-selection'?moteText('从客户端接收'):moteText('在连接设置中查看')}</dd></dl>
       <div className="source-toolbar">{connection&&<a className="button source-connection-settings" href={connection}>{recording?moteText('录音同步设置'):moteText('连接与范围')} →</a>}<a className="text-button" href={'#/activity?sourceId='+encodeURIComponent(s.id)}>{moteText('相关活动')}</a><button className="button subtle" disabled={busy} onClick={()=>void run(async()=>{await api.request('/api/sources/'+encodeURIComponent(s.id),{method:'PATCH',body:JSON.stringify({enabled:!s.enabled})});})}>{s.enabled?moteText('暂停接入'):moteText('恢复接入')}</button></div>
       {recording&&<p className="muted">{moteText('恢复接入仅允许接收资料；录音同步需在录音同步设置中确认范围并启用。')}</p>}
       <details className="source-owner-context"><summary>{moteText('资料说明与内容归属')}</summary><SourceContextEditor api={api} sourceId={s.id}/><AttributionEditor api={api} source path={'/api/sources/'+encodeURIComponent(s.id)} value={s.ownerRelation} onSaved={()=>void refresh()}/></details>
       {s.status?.code&&<details className="source-final-diagnostics"><summary>{moteText('技术详情')}</summary><code>{s.status.code}</code></details>}</div></section>;

 })}{!selected&&<section className="panel panel-pad"><h2>{moteText('所有来源')}</h2><p className="muted">{moteText('连接文件与日历，管理保存方式和同步版本。')}</p>{onBrowse&&<button className="text-button" onClick={onBrowse}>{moteText('浏览来源资料')}</button>}</section>}{selected&&!loading&&!sources.some(s=>s.id===selected)&&<p role="status">{moteText('当前服务未提供此入口')}</p>}</div>}
 {mode==='library'&&sourceContent}
 </div>
 {versions.loading && history === null && <Loading/>}{history && <div className="source-history"><h3>{moteText("版本记录")}</h3><button className="button" onClick={() => setHistoryKey(null)}>{moteText("关闭详情")}</button>{history.map(h => <p key={h.captureId}><button className="button" onClick={() => onOpen(formatEvidenceRef('capture', h.captureId))}>{dateTime(h.observedAt)} · {h.deleted ? moteText("来源报告已移除") : h.current ? moteText("当前版本") : moteText("历史快照")}</button></p>)}</div>}
 </section>;
}
function SourceConnectionConfig({api,source,catalog,onOpen,refresh,onSources}:{api:Api;source:SourceConnection;catalog:Record<string,unknown>|null;onOpen:(ref:string)=>void;refresh:()=>Promise<void>;onSources:()=>void}){
 if(source.kind==='local-files')return <FileRetentionSettings api={api} source={source}/>;
 const plugin=sourcePluginFor(source,catalog);
 if(!plugin?.settings)return null;
 if(plugin.binding?.endsWith('-recordings'))return <>{plugin.settings({api,source,catalog,refresh,onSources,onOpen})}</>;
 const bound=sourcePluginBound(plugin,source,catalog),status=sourcePluginStatus(plugin,catalog);
 return <div className="source-connection-embedded"><p className="connector-help source-account-scope">{moteText('此处管理这个账号下所有来源的连接与读取范围。')}</p>{status!==undefined&&!bound&&<p className="connector-help">{moteText('当前来源的账号绑定尚待核实。')}</p>}{!source.enabled&&<p className="connector-notice">{moteText('来源接入已暂停')}</p>}{plugin.settings({api,source,catalog,refresh,onSources,onOpen})}</div>;
}
function ConnectorPanel({api,catalog,refresh,requested}:{api:Api;catalog:Record<string,unknown>|null;refresh:()=>Promise<void>;requested:string}){
 const setupPlugins=sourcePlugins.filter(plugin=>plugin.setup&&plugin.catalog?.setupChoice);
 return <div className="source-connectors">{!requested&&<div className="connector-provider-choice">{setupPlugins.map(plugin=><a key={plugin.setup!.id} href={'#/connections?setup='+plugin.setup!.id}>{plugin.catalog!.setupChoice!.title()} →</a>)}</div>}{setupPlugins.map(plugin=><div key={plugin.setup!.id} hidden={requested!==plugin.setup!.id}>{plugin.setup!.render({api,catalog,refresh,requested:requested===plugin.setup!.id})}</div>)}</div>;
}
function ReferenceEntry({ api, refresh }: {
    api: Api;
    refresh: () => Promise<void>;
}) {
    const [title, setTitle] = useState(''), [uri, setUri] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
    return <details open className="source-item"><summary>{moteText("添加 NAS 或外部文件引用")}</summary><p className="muted">{moteText("保存原件位置、标题和观察时间，不读取正文。需要分析内容时，可在能访问原件的客户端选择该文件或目录以保存快照。")}</p><form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(''); try {
        const sourceId = 'manual-references';
        await api.request('/api/sources', { method: 'POST', body: JSON.stringify({ id: sourceId, name: moteText("外部文件引用"), kind: 'custom', deviceId: 'web-reference', platform: 'import', retention: 'reference', enabled: true }) });
        const hash = await itemRevision(api, sourceId, uri, { title, text: '', uri, kind: 'file', layer: 'reference', deleted: false });
        await api.request('/api/sources/' + sourceId + '/items', { method: 'PUT', body: JSON.stringify({ externalId: uri, revision: hash, observedAt: new Date().toISOString(), title, uri, text: '', kind: 'file', layer: 'reference' }) });
        setTitle('');
        setUri('');
        await refresh();
    }
    catch (err) {
        setError(errorMessage(err));
    }
    finally {
        setBusy(false);
    } }}><label>{moteText("文件标题")}<input aria-label={moteText("引用文件标题")} value={title} onChange={e => setTitle(e.target.value)} required maxLength={2000}/></label><label>{moteText("原件位置")}<input aria-label={moteText("原件位置")} value={uri} onChange={e => setUri(e.target.value)} placeholder="nas://home/documents/notes.pdf" required maxLength={1000}/></label><button className="button primary" disabled={busy}>{moteText("保存引用")}</button>{error && <p className="error-banner" role="alert">{error}</p>}</form></details>;
}
async function itemRevision(api: Api, sourceId: string, externalId: string, item: Record<string, unknown>) {
    const { item: prior } = await api.request<{
        item: SourceItemRecord | null;
    }>('/api/sources/' + encodeURIComponent(sourceId) + '/item?externalId=' + encodeURIComponent(externalId));
    const fields = ['title', 'text', 'kind', 'layer', 'mimeType', 'modifiedAt', 'uri', 'deleted'];
    const sameMetadata = JSON.stringify(sourceMetadataSchema.optional().parse(prior?.metadata)) === JSON.stringify(sourceMetadataSchema.optional().parse(item.metadata));
    return prior && sameMetadata && fields.every(key => (prior as unknown as Record<string, unknown>)[key] === item[key]) ? prior.revision : crypto.randomUUID();
}
