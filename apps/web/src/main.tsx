import { ClientLoginApproval } from './ClientLoginApproval';
import {consumeLoginTicket,loginRequestId,removeLoginParameter} from './login-handoff';
import { getLocale,moteText } from '@mote/shared/i18n';
import {
ArrowRight,
Activity as ActivityIcon,
Database,
FileText,
Info,
LayoutDashboard,
Link2,
MessageSquare,
Monitor,
RefreshCw,
Settings2,
ShieldCheck,
Smartphone,
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
import type { ArchiveTab } from './Archive';
import { LanguageSelector } from './LanguageSelector';
import {
ApiError,
createApi,
errorMessage,
queryString,
type Activity,
type Answer,
type Capture,
type Connection,
type Device,
type Range,
type Status
} from "./api";
import { changeEvidenceRoute,readEvidenceRoute } from './evidence-route';
import { FeaturePage,featuresReady,webFeatures } from './features/runtime';
import { pageLabels,readPage,routes,type Page } from './navigation';
import { canonicalDestination,readWorkspaceRoute,workspaceHash } from './workspace-route';
import { primaryDestination,WorkspaceNavigation } from './WorkspaceNavigation';
import { readResource,resources } from './resource-cache';
import { importQueue } from './import-queue';
import { clearSession,persistSession,readPeriod,savePeriod,type Period,readSessionLifetime,readStoredSession,saveSessionLifetime,type SessionLifetime } from "./session";
import { CentralStatusPill,ErrorNotice,EvidenceDialog,LoginDialog,Spinner } from './shell-components';
import "./styles.css";
import './workspace.css';
import './library.css';
import './settings-ui.css';
import { confirmNavigation } from './unsaved';


declare global {
  interface Window { moteCentralSession?: {close: () => void} }
}
const nav = [
  {id:'overview' as const,label:moteText('今天'),icon:LayoutDashboard},
  {id:'archive' as const,label:moteText('资料库'),icon:Database},
  {id:'ask' as const,label:moteText('问一问'),icon:MessageSquare},
  {id:'activity' as const,label:moteText('活动'),icon:ActivityIcon},
  {id:'devices' as const,label:moteText('采集与设备'),icon:Monitor},
];

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
  useSyncExternalStore(webFeatures.registry.subscribe,webFeatures.registry.getRevision,webFeatures.registry.getRevision);
  const [connection, setConnection] = useState<Connection | null>(
    readConnection,
  );
  const [sessionLifetime, setSessionLifetime] = useState<SessionLifetime>(readSessionLifetime);
  const connectionGeneration = useRef(0);
  const [clientLogin,setClientLogin]=useState(loginRequestId);
  const [verified, setVerified] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const collectionIds = () => webFeatures.collections().map(entry=>entry.id);
  const initialRoute = useRef(readWorkspaceRoute(location.hash,readPage,collectionIds()));
  const [page, setPage] = useState<Page>(initialRoute.current.page);
  const [archiveTab, updateArchiveTab] = useState<ArchiveTab>(initialRoute.current.collection);
  const archiveTabRef=useRef(archiveTab); archiveTabRef.current=archiveTab;
  const currentHash=useRef(location.hash);
  const pageRef = useRef(page); pageRef.current = page;
  useEffect(() => {
    const navigate = () => {
      const next = readWorkspaceRoute(location.hash,readPage,collectionIds());
      if ((next.page !== pageRef.current || (next.page==='archive'&&next.collection!==archiveTabRef.current)) && !confirmNavigation()) {
        history.replaceState(null, '', currentHash.current); return;
      }
      currentHash.current=location.hash;
      setClientLogin(loginRequestId());
      setPage(next.page); updateArchiveTab(next.collection);
      updateEvidenceId(readEvidenceRoute(location.hash));
    };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, []);
  const [period, setPeriod] = useState<Period>(()=>readPeriod(connection));
  const [status, setStatus] = useState<Status | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [activity, setActivity] = useState<Activity>({
    apps: [],
    devices: [],
    totalDurationMs: 0,
    captures: 0,
  });
  const [recent, setRecent] = useState<Capture[]>([]);
  const [insights, setInsights] = useState<Answer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [evidenceId, updateEvidenceId] = useState<string | null>(()=>readEvidenceRoute(location.hash));
  const setEvidenceId = useCallback((id:string|null) => {
    updateEvidenceId(changeEvidenceRoute(window,id));
    currentHash.current=location.hash;
  }, []);
  const [notice, setNotice] = useState("");
  const [timelineRevision, setTimelineRevision] = useState(0);
  const clearConnection = useCallback(() => {
    connectionGeneration.current++;
    clearSession();
    setPeriod("week");
    setConnection(null);
    setVerified(false);
    setShowConnect(false);
    setActivity({apps:[],devices:[],totalDurationMs:0,captures:0});
    setError("");
    setLoading(false);
    setStatus(null);
    setDevices([]);
    setRecent([]);
    setInsights([]);
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
    window.moteCentralSession?.close();
  }, [clearConnection, setEvidenceId,connection]);
  const unauthorized = useCallback(() => {
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
  useEffect(() => {
    if (!api || verified) return;
    const controller = new AbortController();
    setError("");
    void readResource(api,"/api/configuration",AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]))
      .then(() => { if (!controller.signal.aborted) setVerified(true); })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof ApiError && e.status === 403 ? moteText("此令牌没有管理权限，请退出后使用管理令牌登录。") : errorMessage(e)); });
    return () => controller.abort();
  }, [api, verified, revision]);
  const range: Range = useMemo(() => {
    if (period === "all") return {};
    const now = new Date();
    const after = new Date(now);
    if (period === "today") after.setHours(0, 0, 0, 0);
    else after.setDate(after.getDate() - (period === "week" ? 7 : 30));
    return { after: after.toISOString(), before: now.toISOString() };
  }, [period, revision]);
  const refresh = useCallback(() => {
    if(api)resources(api).invalidate(()=>true);
    setRevision((value) => value + 1);
    setTimelineRevision((value) => value + 1);
  }, [api]);
  useEffect(() => {
    if (!api) return;
    const queue=importQueue(api);
    queue.start();
    let completed=queue.getSnapshot().completedVersion;
    const unsubscribe=queue.subscribe(()=>{
      const next=queue.getSnapshot().completedVersion;
      if(next!==completed){completed=next;refresh();}
    });
    return ()=>{unsubscribe();queue.close();};
  }, [api,refresh]);
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
      load<Status>("/api/status", value => {api.setAgentTimeout(value.agent.agentTimeoutMs);setStatus(value);}),
      load<{items: Device[]}>("/api/devices", value => setDevices(value.items)),
      ...(["overview", "activity"].includes(page) ? [load<Activity>(`/api/activity${queryString(range)}`, setActivity)] : []),
      ...(page === "overview" ? [load<{items: Capture[]}>(`/api/captures${queryString(range, {limit: 4})}`, value => setRecent(value.items))] : []),
      ...(page === "overview" ? [load<{items: Answer[]}>("/api/insights", value => setInsights(value.items))] : []),
    ]).then(results => {
      if (!active) return;
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") setError(moteText("部分资料加载失败，其他页面仍可使用。") + errorMessage(failure.reason));
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [api, verified, range, revision, page]);
  useEffect(() => {
    if (!api) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") setRevision((value) => value + 1); }, 30_000);
    return () => clearInterval(timer);
  }, [api, refresh]);
  useEffect(() => {
    if (showConnect||readEvidenceRoute(location.hash)) return;
    const heading = Array.from(document.querySelectorAll<HTMLElement>(".content h1")).find(element => element.getClientRects().length);
    if (heading) { heading.tabIndex = -1; heading.focus({preventScroll: true}); }
  }, [page, showConnect]);
  function onPage(next: Page) {
    const target=canonicalDestination(next,archiveTabRef.current,collectionIds());
    if ((target.page !== page || (target.page==='archive'&&target.collection!==archiveTabRef.current)) && !confirmNavigation()) return;
    history.pushState(null, '', workspaceHash(routes[target.page],target.page==='archive'?target.collection:undefined));
    currentHash.current=location.hash;
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
      currentHash.current=location.hash;
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
    setDevices([]); setRecent([]); setInsights([]);
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
  return (
    <div className="app-shell">
      <aside id="primary-navigation" className="sidebar">
        <button
          className="brand"
          onClick={() => onPage("overview")}
          aria-label={moteText("Mote 总览")}
        >
          <span className="mote-symbol">m</span>
          <span>
            Mote<span className="brand-dot">.</span>
          </span>
        </button>
        <div className="workspace-label">{moteText("个人资料库")}</div>
        <nav aria-label={moteText("主导航")}>
          {nav.map(item => <button key={item.id} className={primaryDestination(page) === item.id ? 'active' : ''} aria-current={primaryDestination(page) === item.id ? 'page' : undefined} onClick={() => onPage(item.id)}><item.icon size={18} strokeWidth={1.7}/>{item.label}</button>)}
        </nav>
        <div className="sidebar-bottom"><LanguageSelector/>
          <button aria-current={primaryDestination(page)==='about'?'page':undefined} className={'settings-nav '+(primaryDestination(page)==='about'?'active':'')} onClick={()=>onPage('about')}><Settings2 size={18}/>{moteText('设置')}</button>
          <div className="local-note">
            <span className="orbit-mark">✳</span>
            <p>
              {moteText("一点一滴，")}<br />
              {moteText("慢慢成为你的记忆。")}</p>
          </div>
          <button className="node-button" onClick={() => connection ? onPage("about") : setShowConnect(true)}>
            <span
              className={`node-state ${verified ? "online" : ""}`}
            />
            <div>
              <strong>
                {verified ? moteText("已登录 · {0}", status?.profile || moteText("当前节点")) : connection ? moteText("正在验证登录") : moteText("登录 Mote")}
              </strong>
              <small>
                {verified ? moteText("管理当前节点") : moteText("使用管理令牌访问资料")}
              </small>
            </div>
            <Settings2 size={15} />
          </button>
          <div className="version">
            MOTE <span>{moteText("个人上下文")}</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <span className="breadcrumb">
              <span className="breadcrumb-workspace">{moteText("我的空间")} / </span>
              <strong>{pageLabels[page]}</strong>
            </span>
          </div>
          <div className="topbar-actions"><button className="button quick-note" onClick={()=>onPage("notes")}><FileText size={16}/>{moteText("记录")}</button>
            <CentralStatusPill
              connection={connection}
              verified={verified}
              onClick={() => connection && verified ? onPage("about") : setShowConnect(true)}
            />
            {connection && (
              <>
                <span className="private-label">
                  <ShieldCheck size={14} />
                  {moteText("私有节点")}</span>
                <button className="icon-button mobile-settings" aria-label={moteText('设置')} onClick={()=>onPage('about')}><Settings2 size={18}/></button>
                <button
                  className="icon-button"
                  aria-label={moteText("刷新资料")}
                  onClick={refresh}
                  disabled={loading}
                >
                  <RefreshCw size={16} className={loading ? "spin" : ""} />
                </button>
              </>
            )}
            <button
              className="avatar"
              aria-label={connection ? moteText("登录会话") : moteText("登录 Mote")}
              onClick={() => connection ? onPage("about") : setShowConnect(true)}
            >
              {moteText("我")}</button>
          </div>
        </header>
        <React.Suspense key={page} fallback={<p role="status">{moteText("正在读取…")}</p>}><div className={`content ${primaryDestination(page)==='about'||['lark','recordings'].includes(page)?'settings-surface':''}`}>
          {connection&&verified&&<WorkspaceNavigation page={page} onPage={onPage}/> }
          <div className="workspace-range">
            {connection&&verified&&(page === "insights" || (page === "archive" && webFeatures.collections().find(entry=>entry.id===archiveTab)?.usesTimeRange !== false)) && (
                  <select
                    className="period-select"
                    aria-label={moteText("选择时间范围")}
                    value={period}
                    onChange={(e) => setPeriod(savePeriod(connection,e.target.value))}
                  >
                    {Object.entries(periodNames).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
            )}
          </div>
      {clientLogin&&api&&verified&&<ClientLoginApproval id={clientLogin} api={api} done={()=>{removeLoginParameter('loginRequest');setClientLogin(undefined);setNotice(moteText('客户端已登录，可返回客户端继续。'));}}/>}
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
          {!connection ? (
            <>
              <div className="greeting welcome simple-welcome">
                <div>
                  <div className="eyebrow">{moteText('个人资料库')}</div>
                  <h1>
                    {page === "overview" ? moteText("把记录留住，在需要时找到。") : moteText("登录后查看{0}", pageLabels[page])}
                  </h1>
                  <p>
                    {moteText("汇集手机、电脑与文件里的记录。按来源浏览资料，也能直接提问，回到答案的出处。")}</p>
                  <button
                    className="button primary"
                    onClick={() => setShowConnect(true)}
                  >
                    <Link2 size={16} />
                    {moteText("登录 Mote")}<ArrowRight size={16} />
                  </button>
                </div>
                <div className="welcome-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <span className="art-node art-phone">
                    <Smartphone size={27} />
                  </span>
                  <span className="art-node art-desktop">
                    <Monitor size={31} />
                  </span>
                  <span className="art-node art-file">
                    <FileText size={24} />
                  </span>
                  <span className="art-center">
                    m<span>.</span>
                  </span>
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
              {error && <ErrorNotice text={error} retry={refresh} />}
              {!verified && <button className="button subtle" onClick={disconnect}>{moteText("退出登录")}</button>}
              {!verified
                ? !error && (
                    <div className="initial-loading">
                      <Spinner label={moteText("正在验证登录权限…")} />
                    </div>
                  )
                : api && (
                    <>
                      {!["notes","devices","connections","settings","sources","archive","memories","imports","insights","about"].includes(page) && !status && !error && <Spinner label={moteText("正在读取节点状态…")}/>}
                      <FeaturePage page={page} props={{api,status,devices,activity,recent,insights,onPage,onOpen:setEvidenceId,range,rangeSelectionKey:period,archiveTab,setArchiveTab,timelineRevision,refresh,disconnect,sessionLifetime,changeSessionLifetime}}/>
                    </>
                  )}
            </>
          )}
        </div>
        </React.Suspense><footer className="footer">
          <span>{moteText("Mote · 让上下文，有迹可循。")}</span>
          <span>
            {connection && status
              ? moteText("{0} 条记录 · {1}", status.storage.captures.toLocaleString(getLocale()), status.agent.configured ? moteText("Agent 就绪") : moteText("等待模型配置"))
              : moteText("采集 · 汇聚 · 理解")}
          </span>
        </footer>
      </main>
      {showConnect && (
        <LoginDialog
          destination={pageLabels[page]}
          onConnected={connected}
          onClose={() => setShowConnect(false)}
        />
      )}
      {evidenceId && api && verified && (
        <EvidenceDialog
          id={evidenceId}
          api={api}
          onOpen={setEvidenceId}
          onClose={() => setEvidenceId(null)}
          onDeleted={refresh}
        />
      )}
    </div>
  );
}

document.documentElement.lang = getLocale();
document.documentElement.dir = 'ltr';
void Promise.all([featuresReady,consumeLoginTicket().catch(()=>{})]).then(()=>createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
));
