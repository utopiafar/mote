import {associateChatScope,clearChatReloadDraft} from './plugins/ask/chat-drafts';
import {initializeBrowserLogging,installGlobalErrorLogging,log} from './logger';
import { ClientLoginApproval } from './plugins/agent-access/ClientLoginApproval';
import {consumeLoginTicket,loginRequestId,removeLoginParameter} from './login-handoff';
import {pageHash,pageRoutes} from '@mote/shared';
import { getLocale,moteText } from '@mote/shared/i18n';
import {
ArrowRight,
Database,
FileText,
Plus,
Info,
Link2,
MessageSquare,
ShieldCheck,
Sparkles,
X
} from "lucide-react";
import React,{
useCallback,
useEffect,
useMemo,
useRef,
useState,
useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import type { ArchiveTab } from './plugins/library/Archive';
import {
ApiError,
createApi,
errorMessage,
queryString,
type Activity,
type Answer,
type Connection,
type Device,
type Range,
type Status,
type Api
} from "./api";
import { changeEvidenceRoute,readEvidenceRoute } from './plugins/reader/evidence-route';
import { FeaturePage } from './features/runtime';
import { PluginCenterRescue } from './plugins/plugin-center/rescue';
import { featuresReady, featureScopes } from './features/bootstrap';
import { attachBootstrapLifetime } from './plugin-host/bootstrap';
import { webFeatures,installedWebPlugins } from './features/registry';
import { PresentationSurface } from './presentation';
import { GlobalRetrieval } from './plugins/search';
import { WorkspaceMenu,WorkspaceSidebar } from './WorkspaceSidebar';
import { NavStateContext,useNavStateRead } from './use-nav-state';
import { pageLabels,readPage,routes,workspaceNavigation,type Page } from './navigation';
import { redirectDeviceRoute } from './device-route';
import { canonicalDestination,readWorkspaceRoute,workspaceHash } from './workspace-route';
import { webViewPage } from './deep-link';
import { isSettingsContext,WorkspaceNavigation } from './WorkspaceNavigation';
import { readResource,resources,invalidateLibraryResources } from './resource-cache';
import { intakePlugin } from './plugins/intake';
import { clearSession,persistSession,readPeriod,savePeriod,type Period,readSessionLifetime,readStoredSession,saveSessionLifetime,type SessionLifetime } from "./session";
import { ErrorNotice,EvidenceDialog,LoginDialog } from './shell-components';
import { Loading,LoadingLine,LoadingMark } from './Loading';
import "./styles.css";
import './workspace.css';
import './library.css';
import './settings-ui.css';
import './plugin-center.css';
import './discovery-ui.css';
import './art-direction.css';
import './memory-presentation.css';
import './presentation.css';
import './final-web.css';
import './library-final.css';
import './recording-reader.css';
import './device-workspace.css';
import './agent-final.css';
import './special-materials-final.css';
import './activity-final.css';
import './actions-final.css';
import './discovery-final.css';
import './conversation-final.css';
import './imports-final.css';
import {QuickNoteDialog} from './plugins/notes';
import {QuickNoteContext} from './quick-note-context';
import { confirmNavigation,hasUnsavedChanges } from './unsaved';
import {ImportNavigationContext,clearImportReturn,importOrigin,importOriginOpener,markImportReturn,refreshImportOrigin,rememberImportOrigin,type ImportOrigin} from './import-navigation';


initializeBrowserLogging();
installGlobalErrorLogging(window);

const emptyInsights:Answer[]=[];
const periodNames: Record<string, string> = {
  today: moteText("今天"),
  week: moteText("过去 7 天"),
  month: moteText("过去 30 天"),
  all: moteText("全部时间"),
};
const readConnection = () => {
  try {
    return readStoredSession(window.location.origin);
  } catch {
    return null;
  }
};
function App() {
  const registryRevision=useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  const navigation=useMemo(()=>workspaceNavigation(),[registryRevision]);
  const [connection, setConnection] = useState<Connection | null>(
    readConnection,
  );
  useEffect(()=>{if(connection)log('auth.session_started','info');},[connection]);
  const [sessionLifetime, setSessionLifetime] = useState<SessionLifetime>(readSessionLifetime);
  const connectionGeneration = useRef(0);
  const [clientLogin,setClientLogin]=useState(loginRequestId);
  const [verified, setVerified] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [quickNoteApi,setQuickNoteApi]=useState<ReturnType<typeof createApi>|null>(null);
  const closeQuickNote=useCallback(()=>setQuickNoteApi(null),[]);
  const collectionIds = () => webFeatures.collections().map(entry=>entry.id);
  const initialRoute = useRef(readWorkspaceRoute(location.hash,readPage,collectionIds(),webViewPage));
  const [page, setPage] = useState<Page>(initialRoute.current.page);
  const [routeHash,setRouteHash]=useState(()=>location.hash);
  const settingsContext = isSettingsContext(page);
  const [archiveTab, updateArchiveTab] = useState<ArchiveTab>(initialRoute.current.collection);
  const archiveTabRef=useRef(archiveTab); archiveTabRef.current=archiveTab;
  const currentHash=useRef(location.hash),currentHistoryState=useRef<unknown>(history.state);
  const apiRef=useRef<Api|null>(null),preparedImport=useRef<{api:Api;origin:ImportOrigin}|undefined>(undefined),pendingImportReturn=useRef<{api:Api;origin:ImportOrigin}|undefined>(undefined),activeImportParent=useRef<{api:Api;origin:ImportOrigin}|undefined>(undefined),lastScroll=useRef(window.scrollY),allowedImportHash=useRef<string|undefined>(undefined);
  const pageRef = useRef(page); pageRef.current = page;
  useEffect(() => {
    const navigate = () => {
      const allowed=allowedImportHash.current===location.hash;allowedImportHash.current=undefined;
      if (location.hash !== currentHash.current && !allowed && !confirmNavigation()) {
        const owner=apiRef.current,parent=owner&&readPage(currentHash.current)==='imports'?importOrigin(owner,history.state,'moteImportParent'):undefined;
        const before=currentHistoryState.current as {moteEvidenceParent?:unknown;moteEvidenceReturn?:unknown}|null,after=history.state as {moteEvidenceParent?:unknown;moteEvidenceReturn?:unknown}|null;
        const evidenceBack=readEvidenceRoute(currentHash.current)&&(before?.moteEvidenceParent===location.hash||before?.moteEvidenceReturn===location.hash);
        const evidenceForward=readEvidenceRoute(location.hash)&&(after?.moteEvidenceParent===currentHash.current||after?.moteEvidenceReturn===currentHash.current);
        if(owner)clearImportReturn(owner);pendingImportReturn.current=undefined;preparedImport.current=undefined;
        if(parent&&parent.hash===location.hash||evidenceBack){allowedImportHash.current=currentHash.current;history.forward();}
        else if(evidenceForward){allowedImportHash.current=currentHash.current;history.back();}
        else history.replaceState(currentHistoryState.current, '', currentHash.current);
        return;
      }
      const redirected=redirectDeviceRoute(location.hash);
      if(redirected)history.replaceState(history.state,'',redirected);
      const next = readWorkspaceRoute(location.hash,readPage,collectionIds(),webViewPage);
      const prepared=preparedImport.current;
      if(next.page==='imports'&&readPage(currentHash.current)!=='imports'&&prepared?.api===apiRef.current&&prepared.origin.hash===currentHash.current)history.replaceState({...history.state,moteImportOrigin:prepared.origin.token},'',location.href);
      preparedImport.current=undefined;
      currentHash.current=location.hash;
      currentHistoryState.current=history.state;
      const owner=apiRef.current,parent=owner&&importOrigin(owner,history.state,'moteImportParent');activeImportParent.current=owner&&parent?{api:owner,origin:parent}:undefined;
      setRouteHash(location.hash);
      setClientLogin(loginRequestId());
      setPage(next.page); updateArchiveTab(next.collection);
      updateEvidenceId(readEvidenceRoute(location.hash));
    };
    const pop=()=>{const owner=apiRef.current,from=readPage(currentHash.current),next=readPage(location.hash);
      if(owner&&from!=='imports'&&next==='imports'){const origin=importOrigin(owner,history.state,'moteImportOrigin'),active=activeImportParent.current;if(origin&&active?.api===owner&&active.origin===origin&&!hasUnsavedChanges())refreshImportOrigin(owner,origin,currentHash.current,lastScroll.current);}
      const origin=owner&&from==='imports'?importOrigin(owner,history.state,'moteImportParent'):undefined;if(owner&&origin&&location.hash===origin.hash){pendingImportReturn.current={api:owner,origin};markImportReturn(owner,origin);}};
    const remember=()=>{currentHash.current=location.hash;currentHistoryState.current=history.state;setRouteHash(location.hash);};
    const scroll=()=>{lastScroll.current=window.scrollY;};
    window.addEventListener('hashchange', navigate);window.addEventListener('popstate',pop);window.addEventListener('mote:workspace-state',remember);window.addEventListener('scroll',scroll,{passive:true});
    return () => {window.removeEventListener('hashchange', navigate);window.removeEventListener('popstate',pop);window.removeEventListener('mote:workspace-state',remember);window.removeEventListener('scroll',scroll);};
  }, []);
  const [period, setPeriod] = useState<Period>(()=>readPeriod(connection));
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(()=>{if(status)initializeBrowserLogging(status.profile);},[status?.profile]);
  useEffect(()=>{const changed=(event:StorageEvent)=>{if(event.key==='mote-browser-log-settings')initializeBrowserLogging(status?.profile);};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[status?.profile]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [activity, setActivity] = useState<Activity>({
    apps: [],
    devices: [],
    totalDurationMs: 0,
    captures: 0,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [shellRevision, setShellRevision] = useState(0);
  const [evidenceId, updateEvidenceId] = useState<string | null>(()=>readEvidenceRoute(location.hash));
  const setEvidenceId = useCallback((id:string|null) => {
    updateEvidenceId(changeEvidenceRoute(window,id));
    currentHash.current=location.hash;
    currentHistoryState.current=history.state;
    setRouteHash(location.hash);
  }, []);
  const openNestedEvidence = useCallback((id:string) => {
    updateEvidenceId(changeEvidenceRoute(window,id,{returnToCurrent:true}));
    currentHash.current=location.hash;
    currentHistoryState.current=history.state;
    setRouteHash(location.hash);
  }, []);
  const [notice, setNotice] = useState("");
  const [timelineRevision, setTimelineRevision] = useState(0);
  const clearConnection = useCallback(() => {
    connectionGeneration.current++;
    clearSession();clearChatReloadDraft();
    log('auth.session_cleared','info');
    setPeriod("week");
    setConnection(null);
    setVerified(false);
    setShowConnect(false);
    setActivity({apps:[],devices:[],totalDurationMs:0,captures:0});
    setError("");
    setLoading(false);
    setStatus(null);
    setDevices([]);
  }, []);
  useEffect(()=>{
    const handoff=()=>{
      if(!new URLSearchParams(location.hash.split('?')[1]??'').has('loginTicket'))return;
      clearConnection();const generation=connectionGeneration.current;
      void consumeLoginTicket(()=>generation===connectionGeneration.current).then(()=>{
        if(generation===connectionGeneration.current)setConnection(readConnection());
      }).catch(()=>{if(generation===connectionGeneration.current)setShowConnect(true);});
    };
    window.addEventListener('hashchange',handoff);
    return()=>window.removeEventListener('hashchange',handoff);
  },[clearConnection]);
  const disconnect = useCallback(() => {
    if(connection)void createApi(connection).request('/api/login/logout',{method:'POST',body:'{}'}).catch(()=>{});
    clearConnection();
    setEvidenceId(null);
  }, [clearConnection, setEvidenceId,connection]);
  const unauthorized = useCallback(() => {
    log('auth.session_rejected','warn');
    // A same-node re-login may continue a direct evidence link. Clear the
    // credential and private UI, but keep the URL until the owner logs in.
    clearConnection();
    setNotice(moteText("登录已失效，请重新输入管理令牌。"));
    setShowConnect(true);
  }, [clearConnection]);
  useEffect(() => {
    if (!connection?.expiresAt) return;
    let timer: number | undefined;
    const check = () => {
      const remaining = connection.expiresAt! - Date.now();
      if (remaining <= 0) {
        unauthorized();
        return;
      }
      timer = window.setTimeout(check, Math.min(remaining, 2_147_483_647));
    };
    check();
    return () => { if (timer !== undefined) window.clearTimeout(timer); };
  }, [connection, unauthorized]);
  const api = useMemo(
    () => {
      const generation = connectionGeneration.current;
      return connection ? createApi(connection, unauthorized, () => generation === connectionGeneration.current) : null;
    },
    [connection, unauthorized],
  );
  apiRef.current=api;
  const navState=useNavStateRead(api);
  useEffect(()=>{if(navState.value)setVerified(true);},[navState.value]);
  const verificationError=!verified&&navState.error?(navState.error instanceof ApiError&&navState.error.status===403?moteText("此令牌没有管理权限，请退出后使用管理令牌登录。"):errorMessage(navState.error)):"";
  useEffect(()=>api&&verified?installedWebPlugins.connect(api,connection?.viewScope):undefined,[api,verified,connection?.viewScope]);
  useEffect(()=>{
    const update=()=>{const resolved=readWorkspaceRoute(location.hash,readPage,collectionIds(),webViewPage);setPage(resolved.page);};
    return webFeatures.registry.subscribe(update);
  },[]);
  useEffect(()=>{
    if(!api)return;
    const capture=(event:MouseEvent)=>{
      if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||!(event.target instanceof Element))return;
      const anchor=event.target.closest<HTMLAnchorElement>('a[href]');if(!anchor||anchor.target&&anchor.target!=='_self'||anchor.hasAttribute('download'))return;
      const target=new URL(anchor.href,location.href);if(target.origin!==location.origin||target.pathname!==location.pathname||readPage(target.hash)!=='imports'||readPage(currentHash.current)==='imports')return;
      const route=readWorkspaceRoute(currentHash.current,readPage,collectionIds(),webViewPage);
      preparedImport.current={api,origin:rememberImportOrigin(api,currentHash.current,window.scrollY,anchor,route.page==='archive'&&['materials','records','memories'].includes(route.collection)&&!hasUnsavedChanges())};
    };
    document.addEventListener('click',capture,true);return()=>document.removeEventListener('click',capture,true);
  },[api]);
  useEffect(()=>{if(api)associateChatScope(api,connection?.viewScope);},[api,connection?.viewScope]);
  const range: Range = useMemo(() => {
    if (period === "all") return {};
    const now = new Date();
    const after = new Date(now);
    if (period === "today") after.setHours(0, 0, 0, 0);
    else after.setDate(after.getDate() - (period === "week" ? 7 : 30));
    return { after: after.toISOString(), before: now.toISOString() };
  }, [period, shellRevision]);
  const refresh = useCallback(() => {
    if(api)resources(api).invalidate(()=>true);
    navState.refresh();
    setShellRevision((value) => value + 1);
    setTimelineRevision((value) => value + 1);
  }, [api, navState.refresh]);
  const materialsChanged = useCallback(() => {
    if(api)invalidateLibraryResources(api);
  }, [api]);
  useEffect(() => {
    if (!api) return;
    const plugin=intakePlugin(api),queue=plugin.activate();
    let completed=queue.getSnapshot().completedVersion;
    const unsubscribe=queue.subscribe(()=>{
      const next=queue.getSnapshot().completedVersion;
      if(next!==completed){completed=next;materialsChanged();}
    });
    return ()=>{unsubscribe();plugin.dispose();};
  }, [api,materialsChanged]);
  useEffect(() => {
    if (!api || !verified) return;
    let active = true;
    const controller = new AbortController();
    setLoading(true); setError("");
    const load = async <T,>(path: string, apply: (value: T) => void) => {
      const result = await readResource<T>(api,path,controller.signal);
      if (active) apply(result);
    };
    // Independent collections must not block navigation when one endpoint fails.
    void Promise.allSettled([
      load<Status>("/api/status", value => {setStatus(value);}),
      load<{items: Device[];disconnectedDeviceIds?: string[]}>("/api/devices", value => {
        const disconnected = new Set(value.disconnectedDeviceIds ?? []);
        setDevices(value.items.map(device => ({...device,disconnected:disconnected.has(device.deviceId)})));
      }),
    ]).then(results => {
      if (!active) return;
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") setError(moteText("部分资料加载失败，其他页面仍可使用。") + errorMessage(failure.reason));
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [api, verified, shellRevision]);
  useEffect(() => {
    if (!api || !verified || page !== "activity") return;
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    void readResource<Activity>(api,`/api/activity${queryString(range)}`,controller.signal)
      .then(value => {if (active) setActivity(value);})
      .catch(error => {if (active) setError(moteText("部分资料加载失败，其他页面仍可使用。") + errorMessage(error));})
      .finally(() => {if (active) setLoading(false);});
    return () => { active = false; controller.abort(); };
  }, [api, verified, page, range, shellRevision]);
  useEffect(() => {
    if (showConnect||readEvidenceRoute(location.hash)) return;
    if(pendingImportReturn.current?.api===apiRef.current&&pendingImportReturn.current?.origin.hash===location.hash)return;
    const heading = Array.from(document.querySelectorAll<HTMLElement>(".content h1")).find(element => element.getClientRects().length);
    if (heading) { heading.tabIndex = -1; heading.focus({preventScroll: true}); }
  }, [page, showConnect]);
  useEffect(()=>{
    const pending=pendingImportReturn.current;if(!pending||pending.api!==api)return;
    if(location.hash!==pending.origin.hash){clearImportReturn(api,pending.origin);pendingImportReturn.current=undefined;return;}
    let done=false;const finish=()=>{
      if(done||pendingImportReturn.current!==pending||location.hash!==pending.origin.hash)return;
      const opener=importOriginOpener(pending.origin),heading=document.querySelector<HTMLElement>('.content h1'),content=document.querySelector('.content');if(!heading)return;
      const view=readPage(pending.origin.hash)==='archive'?new URLSearchParams(pending.origin.hash.split('?')[1]??'').get('view')??'materials':undefined;
      const expected=view==='materials'?'.library-materials':view==='records'?'.library-time-final':view==='memories'?'.memories-page':readPage(pending.origin.hash)==='sourceCatalog'?'.discovery-source-catalog':undefined;
      const region=expected?content?.querySelector<HTMLElement>(expected):undefined;if(expected&&region?.dataset.importReturnReady!=='true')return;
      if(view==='records'&&region?.querySelector('.library-time-group[open][data-import-return-ready="false"]'))return;
      const settled=Boolean(region?.dataset.importReturnReady==='true'||content?.querySelector('[role="alert"]'));
      if(pending.origin.opener&&!opener&&!settled)return;
      if(pending.origin.scroll>document.documentElement.scrollHeight-window.innerHeight&&!settled)return;
      done=true;clearImportReturn(api,pending.origin);pendingImportReturn.current=undefined;(opener??heading).focus({preventScroll:true});window.scrollTo({top:pending.origin.scroll});observer.disconnect();
    };
    const observer=new MutationObserver(()=>finish());observer.observe(document.querySelector('.content')??document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['data-import-return-ready','aria-busy']});
    const frame=window.requestAnimationFrame(()=>finish());return()=>{observer.disconnect();window.cancelAnimationFrame(frame);};
  },[api,page,routeHash]);
  function onPage(next: Page) {
    const target=canonicalDestination(next,archiveTabRef.current,collectionIds());
    if(!webFeatures.page(target.page)&&target.page!=='extensions'){setNotice(moteText('当前服务未提供此入口'));return;}
    const retainImportOrigin=page==='archive'&&['materials','records','memories'].includes(archiveTabRef.current)&&!hasUnsavedChanges();
    if ((target.page !== page || (target.page==='archive'&&target.collection!==archiveTabRef.current)) && !confirmNavigation()) return;
    const origin=target.page==='imports'&&page!=='imports'&&api?rememberImportOrigin(api,currentHash.current,window.scrollY,document.activeElement,retainImportOrigin):undefined;
    history.pushState(origin?{moteImportOrigin:origin.token}:null, '', workspaceHash(webFeatures.page(target.page)?.route??(target.page==='extensions'?pageRoutes.skills:target.page),target.page==='archive'?target.collection:undefined));
    activeImportParent.current=undefined;
    currentHash.current=location.hash;
    currentHistoryState.current=history.state;
    setRouteHash(location.hash);
    archiveTabRef.current=target.collection; updateArchiveTab(target.collection);
    updateEvidenceId(null);
    setPage(target.page);
    window.scrollTo({ top: 0 });
  }
  function setArchiveTab(next:ArchiveTab) {
    if(next!==archiveTabRef.current&&!confirmNavigation())return;
    archiveTabRef.current=next; updateArchiveTab(next);
    if(pageRef.current==='archive') {
      history.pushState(null,'',workspaceHash(routes.archive,next,location.hash));
      activeImportParent.current=undefined;
      currentHash.current=location.hash;
      currentHistoryState.current=history.state;
      setRouteHash(location.hash);
    }
  }
  function connected(value: Connection, lifetime: SessionLifetime = sessionLifetime) {
    connectionGeneration.current++;
    saveSessionLifetime(lifetime);
    setSessionLifetime(lifetime);
    const next=persistSession(value, lifetime);
    setConnection(next);
    setPeriod(readPeriod(next));
    setVerified(false);
    setStatus(null);
    setDevices([]);
    updateEvidenceId(readEvidenceRoute(window.location.hash));
    setActivity({apps:[],devices:[],totalDurationMs:0,captures:0});
    setShowConnect(false);
    setNotice("");
  }
  function changeSessionLifetime(lifetime: SessionLifetime) {
    saveSessionLifetime(lifetime);
    setSessionLifetime(lifetime);
    if (connection) setConnection(persistSession(connection, lifetime));
  }
  const notesAvailable=Boolean(webFeatures.page('notes'));
  const returningImport=api&&page==='imports'?importOrigin(api,history.state,'moteImportOrigin'):undefined;
  const importReturnLabel=returningImport?readPage(returningImport.hash)==='archive'&&(!new URLSearchParams(returningImport.hash.split('?')[1]??'').get('view')||new URLSearchParams(returningImport.hash.split('?')[1]??'').get('view')==='materials')?'我的资料':'返回':'资料库';
  const importNavigation={label:importReturnLabel,leave:()=>{if(!confirmNavigation())return;if(returningImport){allowedImportHash.current=returningImport.hash;history.back();}else{allowedImportHash.current=pageHash('library',{view:'materials'});window.location.hash=allowedImportHash.current;}}};
  const pageLabel=page==='ask'&&new URLSearchParams(routeHash.split('?')[1]??'').has('question')?moteText('需要你补充'):pageLabels[page]??(page==='extensions'?moteText('自动记忆与插件'):undefined);
  useEffect(()=>{if(!notesAvailable)setQuickNoteApi(null);},[notesAvailable]);
  const openQuickNote=useCallback(()=>{if(!webFeatures.page('notes')){setNotice(moteText('当前服务未提供此入口'));return;}if(api&&verified)setQuickNoteApi(api);else setShowConnect(true);},[api,verified]);
  return (
    <>
    <NavStateContext.Provider value={navState.value}>
    <QuickNoteContext.Provider value={openQuickNote}>
    <PresentationSurface
      navigation={()=> <WorkspaceSidebar groups={navigation} page={page} onPage={onPage}/> }
      toolbar={
        <header className="topbar">
          <WorkspaceMenu groups={navigation} page={page} onPage={onPage} pageLabel={pageLabel??moteText('更多')}>
            <button type="button" onClick={()=>setShowConnect(true)}>{moteText('登录 Mote')}</button>
            {connection&&<button type="button" onClick={refresh} disabled={loading}>{moteText('刷新资料')}</button>}
          </WorkspaceMenu>
          <span className="breadcrumb"><strong>{pageLabel??moteText("当前服务未提供此入口")}</strong></span>
          <div className="topbar-actions"><GlobalRetrieval key={connection?.viewScope??'disconnected'} onPage={onPage}/><button className="button quick-note" disabled={!notesAvailable} title={notesAvailable?undefined:moteText('当前服务未提供此入口')} onClick={openQuickNote} aria-haspopup="dialog"><Plus size={16}/>{moteText("记录")}</button>

          </div>
        </header>}
      footer={null}
    >
        <React.Suspense key={page} fallback={<div data-page-loading={page}><Loading/></div>}><div data-page={page} data-session={!connection?'signed-out':verified?'ready':error||verificationError?'verification-failed':'verifying'} aria-busy={Boolean(connection&&loading)} className={`content ${settingsContext?'settings-surface':''}`}>
          <div className="workspace-tools">
          {connection&&verified&&<WorkspaceNavigation page={page} onPage={onPage}/> }
          <div className="workspace-range">
            {connection&&verified&&(page === "insights" || (page === "archive" && webFeatures.collections().find(entry=>entry.id===archiveTab)?.usesTimeRange !== false)) && (
                  <select
                    className="period-select"
                    aria-label={moteText("选择时间范围")}
                    value={period}
                    onChange={(e) => {if(e.target.value!==period&&confirmNavigation())setPeriod(savePeriod(connection,e.target.value));}}
                  >
                    {Object.entries(periodNames).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
            )}
          </div>
          </div>
      {clientLogin&&api&&verified&&<ClientLoginApproval id={clientLogin} api={api} done={outcome=>{removeLoginParameter('loginRequest');setClientLogin(undefined);setNotice(outcome==='approved'?moteText('客户端已登录，可返回客户端继续。'):moteText('已拒绝这次客户端登录。'));}}/>}
          {notice && (
            <div className="notice" role="status">
              <Info size={17} />
              <span>{notice}</span>
              <button
                className="icon-button"
                aria-label={moteText("关闭提示")}
                onClick={() => setNotice("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {!webFeatures.page(page)?(page==='extensions'?<PluginCenterRescue onPage={onPage}/>:<section className="panel panel-pad"><h1>{moteText('当前服务未提供此入口')}</h1><button className="button" onClick={()=>onPage('archive')}>{moteText('资料库')}</button></section>):!connection && settingsContext ? <section className="panel settings-sign-in"><div className="page-heading"><h1>{moteText("登录后查看{0}", pageLabels[page])}</h1><p>{moteText("调整服务与资料管理方式，或管理当前登录。")}</p></div><button className="button" onClick={()=>setShowConnect(true)}><Link2 size={16}/>{moteText("登录 Mote")}<ArrowRight size={16}/></button></section> : !connection ? (
            <>
              <div className="greeting welcome simple-welcome archive-welcome">
                <div>
                  <div className="eyebrow">{moteText("个人资料库")}</div>
                  <h1>
                    {page === "ask" ? moteText("把记录留住，在需要时找到。") : moteText("登录后查看{0}", pageLabels[page])}
                  </h1>
                  <p>{moteText("汇集手机、电脑与文件里的记录。按来源浏览资料，也能直接提问，回到答案的出处。")}</p>
                  <div className="welcome-archive-flow" aria-label={moteText("采集 · 汇聚 · 理解")}>
                    <span><FileText size={17}/>{moteText("添加资料")}</span><ArrowRight size={14} aria-hidden="true"/>
                    <span><Database size={17}/>{moteText("资料库")}</span><ArrowRight size={14} aria-hidden="true"/>
                    <span><MessageSquare size={17}/>{moteText("问一问")}</span>
                  </div>
                  <button className="button" onClick={() => setShowConnect(true)}>
                    <Link2 size={16} />
                    {moteText("登录 Mote")}<ArrowRight size={16} />
                  </button>
                </div>
              </div>
              <div className="welcome-values simple-values">
                <div>
                  <ShieldCheck size={20} />
                  <h3>{moteText("由你决定留下什么")}</h3>
                  <p>{moteText("应用过滤与端点脱敏，先于资料上传。")}</p>
                </div>
                <div>
                  <Database size={20} />
                  <h3>{moteText("资料在你的节点")}</h3>
                  <p>{moteText("可以导入、导出，也可以继续扩展来源。")}</p>
                </div>
                <div>
                  <Sparkles size={20} />
                  <h3>{moteText("答案带着来处")}</h3>
                  <p>{moteText("Agent 读取证据，串起你的问题与记录。")}</p>
                </div>
              </div>
            </>
          ) : (
            <>
              {(error||verificationError) && <ErrorNotice text={error||verificationError} retry={verificationError&&!error?navState.refresh:refresh} />}
              {!verified && <button className="button subtle" onClick={disconnect}>{moteText("退出登录")}</button>}
              {!verified
                ? !error && !verificationError && (
                    <LoadingMark label={moteText("正在验证登录权限…")} />
                  )
                : api && (
                    <>
                      {!["notes","devices","connections","settings","sources","archive","memories","imports","insights","about"].includes(page) && !status && !error && <LoadingLine label={moteText("正在读取节点状态…")}/>}
                      <ImportNavigationContext.Provider value={page==='imports'?importNavigation:null}><FeaturePage page={page} props={{api,viewScope:connection.viewScope,status,devices,activity,insights:emptyInsights,onPage,onOpen:setEvidenceId,range,rangeSelectionKey:period,archiveTab,setArchiveTab,timelineRevision:timelineRevision,refresh,disconnect,sessionLifetime,changeSessionLifetime}}/></ImportNavigationContext.Provider>
                    </>
                  )}
            </>
          )}
        </div>
        </React.Suspense>
    </PresentationSurface>
    </QuickNoteContext.Provider>
    </NavStateContext.Provider>
    {notesAvailable&&quickNoteApi===api&&api&&verified&&<QuickNoteDialog api={api} namespace={window.location.origin} revision={timelineRevision} onSaved={refresh} onClose={closeQuickNote}/>}
      {showConnect && (
        <LoginDialog
          destination={pageLabels[page]??moteText("当前服务未提供此入口")}
          onConnected={connected}
          onClose={() => setShowConnect(false)}
        />
      )}
      {page!=='unavailable' && evidenceId && api && verified && (
        <EvidenceDialog
          id={evidenceId}
          api={api}
          onOpen={setEvidenceId}
          onOpenNested={openNestedEvidence}
          onClose={() => setEvidenceId(null)}
          onDeleted={refresh}
        />
      )}
    </>
  );
}

document.documentElement.lang = getLocale();
document.documentElement.dir = 'ltr';
const initialRedirect=redirectDeviceRoute(location.hash);
if(initialRedirect)history.replaceState(history.state,'',initialRedirect);
const bootstrapLifetime=attachBootstrapLifetime({ready:featuresReady,scopes:featureScopes,host:webFeatures,unmount:async()=>{root?.unmount();await installedWebPlugins.close();}});
// Best-effort: async teardown cannot be guaranteed before unload; the real
// owner release path is close(), also used by controlled shutdown.
window.addEventListener('pagehide',event=>{if(!(event as PageTransitionEvent).persisted)void bootstrapLifetime.close();});
let root: ReturnType<typeof createRoot> | undefined;
void Promise.all([featuresReady,consumeLoginTicket().catch(()=>{})]).then(()=>{if(!bootstrapLifetime.mounted())return;root=createRoot(document.getElementById("root")!);root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);});
