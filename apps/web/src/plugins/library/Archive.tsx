import { featureRequirementsAvailable, formatEvidenceRef, parseEvidenceRef, type CapturePreview } from '@mote/shared';
import { getLocale, moteText } from '@mote/shared/i18n';
import { ArrowLeft, ArrowRight, Clock3, FileText, Monitor, RefreshCw, Upload } from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, } from "react";
import { ApiError, duration, dateTime, errorMessage, queryString, type Activity, type Api, type Device, type Range } from "../../api";
import { captureDateRange, localDateInput, ocrPresentation } from '../../capture-presentation';
import { CollectionContent } from '../../features/runtime';
import { webFeatures } from '../../features/registry';
import { LibraryBrowseLayout } from './LibraryBrowse';
import {LibraryTimeline} from './LibraryTimeline';
const CaptureSessions = React.lazy(() => import('./CaptureSessions').then(module => ({ default: module.CaptureSessions })));
import { sourceLabels } from '../../Metadata';
import { CaptureCard, Empty, ErrorNotice, Spinner } from '../../shell-components';
import { confirmNavigation } from '../../unsaved';
import { DiscoveryLink, DiscoveryProvider, useDiscoveryState } from '../../DiscoveryLink';
import { pageLabels, sections } from '../../navigation';
export type ArchiveTab = string;
export function ActivitySummary({ activity }: {
    activity: Activity;
}) { return <section className="panel activity-panel special-activity"><div className="section-heading"><h2>{moteText("应用活动概况")}</h2></div><div className="special-measure"><strong>{Number.isFinite(activity.totalDurationMs)&&activity.totalDurationMs>=0?duration(activity.totalDurationMs):moteText('待确认')}</strong><span>{moteText('前台应用采样时长')}</span></div>{activity.apps.length ? <><div className="app-list">{activity.apps.map(app=>{const valid=Number.isFinite(app.durationMs)&&app.durationMs>=0,share=valid&&Number.isFinite(activity.totalDurationMs)&&activity.totalDurationMs>0?Math.max(0,Math.min(100,Math.round(app.durationMs/activity.totalDurationMs*100))):undefined;return <div className="special-activity-row" key={app.appId||app.appName}><strong>{app.appName}</strong><span>{valid?duration(app.durationMs):moteText('待确认')}</span><div className="special-duration-track" aria-label={share===undefined?moteText('待确认'):share+'%'}><i style={{width:share===undefined?'0%':share+'%'}}/></div></div>;})}</div><p className="measurement-note">{moteText("多台设备分别计时；未采样的时间不会补齐，应用活动不代表注意力或实际工作成果。后台媒体播放单独统计，可在「媒体播放」中查看。")}</p></> : <Empty icon={Clock3} title={moteText("这段时间还没有活动采样")}><p>{moteText("设备完成同步后，可以在这里查看应用时间分布。")}</p></Empty>}</section>; }

export function Archive({ api, devices, range, rangeSelectionKey, activity, revision, onOpen, tab, setTab, onChanged }: {
    onChanged?: () => void;
    api: Api;
    devices: Device[];
    range: Range;
    rangeSelectionKey?: string;
    activity: Activity;
    revision: number;
    onOpen: (id: string) => void;
    tab: ArchiveTab;
    setTab: (tab: ArchiveTab) => void;
}) {
    useSyncExternalStore(webFeatures.registry.subscribe, webFeatures.registry.getRevision, webFeatures.registry.getRevision);
    const entries = webFeatures.collections(), entry = entries.find(item => item.id === tab);
    const availability = useDiscoveryState(api);
    const [browseOwner,setBrowseOwner]=useState(api);
    useEffect(()=>{if(browseOwner===api)return;const [route,text]=window.location.hash.split('?'),query=new URLSearchParams(text);for(const key of ['origin','sourceId','deviceId','kind','type','after','before','cursor','selected'])query.delete(key);window.history.replaceState(null,'',route+(query.size?'?'+query:''));window.dispatchEvent(new window.Event('mote:workspace-state'));setBrowseOwner(api);},[api,browseOwner]);
    const [selection, setSelection] = useState<{
        owner: Api;
        view: string;
        reference: string;
    }|undefined>(()=>{const reference=new URLSearchParams(window.location.hash.split('?')[1]??'').get('selected');return reference?{owner:api,view:tab,reference}:undefined;});
    const listHeading = useRef<HTMLDivElement>(null);
    const returnPosition=useRef<{owner:Api;view:string;scroll:number;opener:HTMLElement|null}|undefined>(selection?{owner:api,view:tab,scroll:0,opener:null}:undefined);
    const selected = selection?.owner === api && selection.view === entry?.id ? selection.reference : undefined;
    useEffect(() => { setSelection(previous=>previous?.owner===api&&previous.view===entry?.id?previous:undefined); }, [api, entry?.id]);
    useEffect(()=>{const changed=()=>{const query=new URLSearchParams(window.location.hash.split('?')[1]??'');if(query.get('view')&&query.get('view')!==entry?.id)return;const reference=query.get('selected');setSelection(reference?{owner:api,view:entry?.id??tab,reference}:undefined);};window.addEventListener('hashchange',changed);return()=>window.removeEventListener('hashchange',changed);},[api,entry?.id,tab]);
    useLayoutEffect(() => {
        const position=returnPosition.current;if(selected||!position)return;
        returnPosition.current=undefined;
        if(position.owner!==api||position.view!==entry?.id)return;
        (position.opener?.isConnected?position.opener:listHeading.current)?.focus({preventScroll:true});
        if(window.scrollY!==position.scroll)window.scrollTo({top:position.scroll});
    }, [api,entry?.id,selected]);
    const rememberSelection = useCallback((reference?:string)=>{const [route,queryText]=window.location.hash.split('?'),query=new URLSearchParams(queryText);if(reference)query.set('selected',reference);else query.delete('selected');window.history.replaceState(window.history.state,'',route+(query.size?'?'+query:''));window.dispatchEvent(new window.Event('mote:workspace-state'));},[]);
    const clearSelection = useCallback(() => { setSelection(undefined); rememberSelection(); }, [rememberSelection]);
    const select = useCallback((ref: string) => { if(!confirmNavigation())return;returnPosition.current={owner:api,view:entry?.id??tab,scroll:window.scrollY,opener:document.activeElement as HTMLElement|null}; const parsed = parseEvidenceRef(ref),reference=parsed ? formatEvidenceRef(parsed.kind, parsed.id) : ref; setSelection({ owner: api, view: entry?.id ?? tab, reference });rememberSelection(reference);if(window.scrollY)window.scrollTo({top:0}); }, [api, entry?.id, tab,rememberSelection]);
    const visit=(id:string)=>{clearSelection();setTab(id);};
    const collectionLink=(id:string,label:string)=> <DiscoveryLink key={id} className={'library-view-link'+(tab===id?' active':'')} target={{pageId:'archive',href:'#/library?view='+id,collectionId:id}} onNavigate={()=>visit(id)}><span data-collection-id={id} aria-current={tab===id?'page':undefined}>{label}</span></DiscoveryLink>;
    const viewNavigation=<nav className="library-view-tabs" aria-label={moteText('资料视图')}>{collectionLink('materials',moteText('资料'))}{collectionLink('records',moteText('时间回看'))}</nav>;
    const contextual=['segments','activity','media','coding-status'];
    const otherCollections=entries.filter(item=>!['materials','records','memories',...contextual].includes(item.id));
    const otherPages=sections.library.filter(id=>id!=='archive'&&id!=='imports');
    const browseNavigation=<nav className="library-context-links" aria-label={moteText('更多上下文视图')}>
      {contextual.filter(id=>entries.some(item=>item.id===id)).map(id=>collectionLink(id,id==='segments'?moteText('片段与应用相册'):id==='coding-status'?moteText('Coding 同步状态'):entries.find(item=>item.id===id)!.label))}
      {(otherCollections.length>0||otherPages.length>0)&&<details className="library-secondary-views"><summary>{moteText('更多')}</summary><div className="library-type-filters">{otherCollections.map(item=>collectionLink(item.id,item.label))}{otherPages.map(id=><DiscoveryLink key={id} target={{pageId:id,href:'#/'+(webFeatures.page(id)?.route??id)}}>{pageLabels[id]}</DiscoveryLink>)}</div></details>}
    </nav>;
    const supports=(path:string)=>availability.inventoryError===undefined&&featureRequirementsAvailable(['http:GET:'+path],availability.inventory);
    const props = { api, devices, range, rangeSelectionKey, activity, revision, onOpen: entry?.layout === 'standalone' ? onOpen : select, onChanged, selectedReference: selected, onBrowseChanged: clearSelection,viewNavigation,browseNavigation,materialPreview:{read:supports('/api/materials/:id/read'),image:supports('/api/materials/:id/members')&&supports('/api/files/:id')&&supports('/api/files/:id/thumbnail')} };
    if(browseOwner!==api)return <Spinner/>;
    const content = <LibraryCollectionBoundary key={entry?.id}>{entry ? <CollectionContent entry={entry} props={props}/> : <p role="status">{moteText('此资料库分类当前不可用。请从资料库分类中选择可用入口。')}</p>}</LibraryCollectionBoundary>;
    return <DiscoveryProvider state={availability}><div className={'archive-page library-archive' + (selected ? ' has-selection' : '')}>
   <div ref={listHeading} tabIndex={-1} className="page-heading library-heading" hidden={Boolean(selected)}><h1>{moteText('资料库')}</h1><DiscoveryLink className="button" target={{pageId:'imports',href:'#/library/import'}}>{moteText('导入资料')}</DiscoveryLink></div>
   <nav className="segmented-nav library-primary-tabs" aria-label={moteText('资料库')} hidden={Boolean(selected)}>
     <button className={tab!=='memories'?'active':''} aria-current={tab!=='memories'?'page':undefined} onClick={()=>{clearSelection();setTab('materials');}}>{moteText('我的资料')}</button>
     <button className={tab==='memories'?'active':''} aria-current={tab==='memories'?'page':undefined} onClick={()=>{clearSelection();setTab('memories');}}>{moteText('我的记忆')}</button>
   </nav>
   {tab!=='materials'&&tab!=='memories'&&tab!=='records'&&<div hidden={Boolean(selected)} className="library-view-navigation">{viewNavigation}{browseNavigation}</div>}
   <div className="library-workspace central-library-workspace"><div className="library-content">{entry?.layout === 'standalone' ? content : <LibraryBrowseLayout reference={selected} api={api} onClose={clearSelection} onOpen={onOpen} supporting={entry?.layout !== 'browser'}>{content}</LibraryBrowseLayout>}</div></div>
 </div></DiscoveryProvider>;
}
class LibraryCollectionBoundary extends React.Component<{
    children: React.ReactNode;
}, {
    failed: boolean;
}> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? <p role="status">{moteText('专用视图暂不可用，请查看资料库或重试。')}</p> : this.props.children; }
}
export function Timeline(props: {
    api: Api;
    devices: Device[];
    onOpen: (id: string) => void;
    revision: number;
    embedded?: boolean;
}) {
    const Heading = props.embedded ? 'h2' : 'h1';
    const [view, setView] = useState(props.embedded ? 'records' : 'sessions');
    return <><div className="filter-bar" role="group" aria-label={moteText("记录视图")}><button className={'button ' + (view === 'sessions' ? 'primary' : '')} onClick={() => setView('sessions')}>{moteText("片段 / 应用分组")}</button><button className={'button ' + (view === 'records' ? 'primary' : '')} onClick={() => setView('records')}>{moteText("全部记录")}</button></div>{view === 'sessions' ? <><div className="page-heading timeline-heading"><div className="eyebrow">{moteText("沿着连续的记录回看")}</div><Heading>{moteText("片段")}</Heading><p>{moteText("先看一段，再展开其中的截图与上下文。")}</p></div><CaptureSessions {...props}/></> : <RecordTimeline {...props}/>}</>;
}
type RecordTimelineProps={api:Api;devices:Device[];onOpen:(ref:string)=>void;revision:number;library?:boolean;selectedReference?:string;onBrowseChanged?:()=>void;viewNavigation?:React.ReactNode;browseNavigation?:React.ReactNode};
export function RecordTimeline(props:RecordTimelineProps){return props.library?<LibraryTimeline {...props}/>:<RawRecordTimeline {...props}/>;}
function RawRecordTimeline({api,devices,onOpen,revision,onBrowseChanged}:RecordTimelineProps){
    const [layout, setLayout] = useState<'grid' | 'list'>(() => localStorage.getItem('mote.record-layout') === 'grid' ? 'grid' : 'list');
    const [after, setAfter] = useState("");
    const [before, setBefore] = useState("");
    const [device, setDevice] = useState("");
    const [collection, setCollection] = useState<'' | 'activity' | 'content'>('');
    const [source, setSource] = useState('');
    const [ocrStatus, setOcrStatus] = useState('');
    const [items, setItems] = useState<CapturePreview[]>([]);
    const [totalCount, setTotalCount] = useState<number>();
    const [refreshVersion, setRefreshVersion] = useState(0);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [pageLoading, setPageLoading] = useState(false);
    const [error, setError] = useState("");
    const [page, setPage] = useState(0);
    const [pageCursors, setPageCursors] = useState<(string | undefined)[]>([undefined]);
    const requestVersion = useRef(0);
    const inFlight = useRef(false);
    const request = useRef<AbortController | null>(null);
    const pendingRefresh = useRef(false);
    const readScope = useRef<{api:Api;range:Range}|undefined>(undefined);
    const currentPage = useRef({page,pageCursors});currentPage.current={page,pageCursors};
    const range = useMemo(() => ({
        ...captureDateRange(after, before),
        ...(device ? { deviceId: device } : {}),
        ...(collection ? { collection } : {}),
        ...(source ? { source } : {}),
        ...(ocrStatus ? { ocrStatus } : {}),
    }), [after, before, device, collection, source, ocrStatus]);
    const load = useCallback(async function readPage(next?: string, version = requestVersion.current, targetPage = 0, background = false):Promise<void> {
        if (inFlight.current && next)
            return;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        inFlight.current = true;
        setLoading(true);
        setPageLoading(!background);
        setError("");
        try {
            const result = await api.request<{
                items: CapturePreview[];
                nextCursor: string | null;
                totalCount: number;
            }>(`/api/capture-browser${queryString(range, { limit: 24, cursor: next })}`, { signal: controller.signal });
            if (requestVersion.current !== version || controller.signal.aborted)
                return;
            setItems(result.items);
            setPage(targetPage);
            setPageCursors(previous => [...previous.slice(0, targetPage), next]);
            setCursor(result.nextCursor);
            setTotalCount(result.totalCount);
        }
        catch (e) {
            if (requestVersion.current === version && !controller.signal.aborted){
                if(e instanceof ApiError&&[401,403,404,410].includes(e.status)){
                    setItems([]);setTotalCount(undefined);setCursor(null);setPage(0);setPageCursors([undefined]);
                }
                setError(errorMessage(e));
            }
        }
        finally {
            if (requestVersion.current === version && request.current === controller) {
                setLoading(false);
                setPageLoading(false);
                inFlight.current = false;
                if(pendingRefresh.current){pendingRefresh.current=false;void readPage(next,version,targetPage,true);}
            }
        }
    }, [api, range]);
    useEffect(() => {
        const version = ++requestVersion.current;
        pendingRefresh.current=false;
        readScope.current={api,range};
        setItems([]);
        setPage(0);
        setPageCursors([undefined]);
        setCursor(null);
        setTotalCount(undefined);
        inFlight.current = false;
        void load(undefined,version);
        return () => { pendingRefresh.current=false;request.current?.abort(); requestVersion.current++; };
    }, [load]);
    const revisions=useRef({load,revision,refreshVersion});
    useEffect(()=>{
        const before=revisions.current;revisions.current={load,revision,refreshVersion};
        if(before.load!==load||before.revision===revision&&before.refreshVersion===refreshVersion)return;
        if(inFlight.current){pendingRefresh.current=true;return;}
        const target=currentPage.current;
        void load(target.pageCursors[target.page],requestVersion.current,target.page,true);
    },[load,revision,refreshVersion]);
    const visibleScope=readScope.current?.api===api&&readScope.current?.range===range;
    const visibleItems=visibleScope?items:[];
    const visibleTotal=visibleScope?totalCount:undefined;
    const initialOrPageLoading=loading&&(visibleTotal===undefined||pageLoading);
    const groups = useMemo(() => {
        const result = new Map<string, CapturePreview[]>();
        for (const item of visibleItems) {
            const key = new Date(item.capturedAt).toLocaleDateString(getLocale(), {
                year: "numeric",
                month: "long",
                day: "numeric",
                weekday: "long",
            });
            result.set(key, [...(result.get(key) || []), item]);
        }
        return [...result.entries()];
    }, [visibleItems]);
    return (<>
      <div className="page-heading timeline-heading">
        <div className="eyebrow">{moteText("按天回看，保留来处")}</div>
        <h1>{moteText("采集记录")}</h1>
        <p>{moteText("按日期浏览截图、文字与媒体状态；点击记录查看内容和采样时的上下文。")}</p>
      </div>
      <div className="capture-day-controls">
        <label><span>{moteText("按天查看")}</span><input type="date" aria-label={moteText("查看某天的采集记录")} value={after && after === before ? after : ''} onChange={event => { setAfter(event.target.value); setBefore(event.target.value); }}/></label>
        <button className="button subtle" onClick={() => { const day = localDateInput(new Date()); setAfter(day); setBefore(day); }}>{moteText("今天")}</button>
        <button className="button subtle" aria-label={moteText("查看前一天")} disabled={!after || after !== before} onClick={() => { const date = new Date(`${after}T00:00:00`); date.setDate(date.getDate() - 1); const day = localDateInput(date); setAfter(day); setBefore(day); }}><ArrowLeft size={15}/></button>
        <button className="button subtle" aria-label={moteText("查看后一天")} disabled={!after || after !== before} onClick={() => { const date = new Date(`${after}T00:00:00`); date.setDate(date.getDate() + 1); const day = localDateInput(date); setAfter(day); setBefore(day); }}><ArrowRight size={15}/></button>
        <button className="button subtle capture-refresh" disabled={loading} onClick={() => setRefreshVersion(value => value + 1)}><RefreshCw size={15} className={loading ? 'spin' : ''}/>{moteText("刷新记录")}</button>
      </div>
      <div className="filter-bar capture-filters"><label>{moteText("展示方式")}<select aria-label={moteText("记录展示方式")} value={layout} onChange={e => { const v = e.target.value as 'grid' | 'list'; setLayout(v); localStorage.setItem('mote.record-layout', v); }}><option value="grid">{moteText("缩略图")}</option><option value="list">{moteText("列表")}</option></select></label>
        <label>
          <span>{moteText("从")}</span>
          <input type="date" aria-label={moteText("开始日期")} value={after} onChange={(e) => setAfter(e.target.value)}/>
        </label>
        <label>
          <span>{moteText("至")}</span>
          <input type="date" aria-label={moteText("结束日期")} value={before} min={after} onChange={(e) => setBefore(e.target.value)}/>
        </label>
        <label>
          <Monitor size={15}/>
          <select aria-label={moteText("筛选设备")} value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="">{moteText("全部设备")}</option>
            {devices.map((d) => (<option key={d.deviceId} value={d.deviceId}>
                {d.deviceName}
              </option>))}
          </select>
        </label>
        <label><span>{moteText("来源")}</span><select aria-label={moteText("筛选记录来源")} value={source} onChange={event => { setSource(event.target.value); if (event.target.value && event.target.value !== 'screen')
        setOcrStatus(''); }}><option value="">{moteText("全部来源")}</option>{Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>{moteText("采集级别")}</span><select aria-label={moteText("筛选采集级别")} value={collection} onChange={event => setCollection(event.target.value as typeof collection)}><option value="">{moteText("全部记录")}</option><option value="activity">{moteText("仅活动状态")}</option><option value="content">{moteText("允许保留的内容")}</option></select></label>
        <label><span>OCR</span><select aria-label={moteText("筛选 OCR 状态")} value={ocrStatus} onChange={event => setOcrStatus(event.target.value)}><option value="">{moteText("全部状态")}</option><option value="pending">{moteText("待处理")}</option><option value="completed">{moteText("已完成")}</option><option value="failed">{moteText("失败")}</option><option value="disabled">{moteText("已关闭")}</option><option value="unknown">{moteText("状态未知")}</option></select></label>
        {(after || before || device || collection || source || ocrStatus) && (<button className="text-button" onClick={() => {
                setAfter("");
                setBefore("");
                setDevice("");
                setCollection('');
                setSource('');
                setOcrStatus('');
            }}>
            {moteText("清除筛选")}</button>)}
        <span className="filter-count">{visibleTotal === undefined ? moteText("已读取") + " " + visibleItems.length : moteText("共 {0} 条 · 本页 {1} 条", visibleTotal, visibleItems.length)}</span>
      </div>
      <p className="capture-browse-note">{moteText("日期按当前浏览器时区显示。这里展示已同步到中央节点的记录；可刷新查看文字识别的最新状态与结果。")}</p>
      {error && (<ErrorNotice text={error} retry={() => void load(pageCursors[page], requestVersion.current, page)}/>)}
      {groups.map(([day, records]) => (<section className="timeline-group" key={day}>
          <h2>
            <span className="timeline-dot"/>
            {day}
            <small>{moteText("已加载")}{' '}{records.length}{' '}{moteText("条")}</small>
          </h2>
          <div className={layout === 'list' ? 'capture-grid capture-list' : 'capture-grid'}>
            {records.map((capture) => (<CaptureCard key={capture.id} capture={capture} api={api} onOpen={onOpen}/>))}
          </div>
        </section>))}
      {initialOrPageLoading && (<div className="load-more">
          <Spinner label={moteText("正在找回这些片刻…")}/>
        </div>)}
      {visibleTotal!==undefined && !initialOrPageLoading && !visibleItems.length && !error && (<div className="panel">
          <Empty icon={Clock3} title={moteText("这段时间还没有记录")}>
            <p>{moteText("试试其他时间或设备，或检查采集端是否已开启。")}</p>
          </Empty>
        </div>)}
      <nav className="load-more" aria-label={moteText("采集记录分页")}>
        <button className="button subtle" disabled={loading || page === 0} onClick={() => void load(pageCursors[page - 1], requestVersion.current, page - 1)}>{moteText("上一页")}</button>
        <span>{moteText("第 {0} 页", page + 1)}</span>
        <button className="button subtle" disabled={loading || !cursor} onClick={() => cursor && void load(cursor, requestVersion.current, page + 1)}>{moteText("下一页")}</button>
      </nav>
    </>);
}
