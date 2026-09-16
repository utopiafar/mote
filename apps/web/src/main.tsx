import {Usage,TurnUsage} from './Usage';
import {CaptureSessions} from './CaptureSessions';
import {ContentStorage} from './ContentStorage';
import { restoreSession } from "./session";
import {systemEventText} from '@mote/shared';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import {captureOcrState, type CapturePreview} from '@mote/shared';
import { AnswerMarkdown, answerPreview } from "./AnswerMarkdown";
import { Conversations } from "./Conversations";
import {captureDateRange, evidencePresentation, localDateInput, ocrPresentation} from './capture-presentation';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpFromLine,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Database,
  ExternalLink,
  FileText,
  HardDrive,
  Headphones,
  Info,
  Layers3,
  LayoutDashboard,
  Link2,
  LoaderCircle,
  Menu,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  Unplug,
  WifiOff,
  X,
} from "lucide-react";
import {
  createApi,
  ApiError,
  queryString,
  duration,
  bytes,
  dateTime,
  ago,
  deviceState,
  deviceLabels,
  errorMessage,
  type Connection,
  type Api,
  type Capture,
  type Device,
  type Activity,
  type Status,
  type Answer,
  type Range,
} from "./api";
import "./styles.css";
import { Notes } from "./Notes";
import { Diagnostics } from "./Diagnostics";
import { ServerSettings, AdvancedConfiguration } from "./ServerSettings";
import { SoftwareUpdate } from "./SoftwareUpdate";
import { DeviceOverview, PageBack } from "./DeviceOverview";
import { Connections } from "./Connections";
import {Metadata, sourceLabels, activityExplanation} from './Metadata';
import {MediaSnapshot,MediaActivitySummary} from './Media';
import {mediaCardText,mediaStatus,mediaExplanation} from './media-presentation';

import {Files,FileDetail} from './Files';
import {Sources} from "./Sources";
import {Memories} from "./Memories";
import {Imports} from "./Imports";
import {Insights} from "./Insights";
import {SourceDocumentDetails} from './SourceDocumentDetails';

declare global {
  interface Window { moteCentralSession?: {close: () => void} }
}
type Page = "usage" | "imports" | "insights" | "sources" | "memories" | "overview" | "timeline" | "notes" | "ask" | "devices" | "vault" | "archive" | "connections" | "developer" | "about" | "settings";
const nav = [
  { id: "usage" as const, label: "用量与费用", icon: Clock3, group: "管理" },
  { id: "overview" as const, label: "总览", icon: LayoutDashboard, group: "日常" },
  { id: "timeline" as const, label: "采集记录", icon: Clock3, group: "日常" },
  { id: "notes" as const, label: "随手记", icon: FileText, group: "日常" },
  { id: "ask" as const, label: "问一问", icon: MessageSquare, group: "日常" },
  { id: "archive" as const, label: "资料库", icon: Database, group: "日常" },
  { id: "imports" as const, label: "导入", icon: ArrowUpFromLine, group: "资料" },
  { id: "memories" as const, label: "记忆", icon: Layers3, group: "资料" },
  { id: "insights" as const, label: "洞察", icon: Sparkles, group: "资料" },
  { id: "devices" as const, label: "设备", icon: Monitor, group: "管理" },
  { id: "sources" as const, label: "来源", icon: Link2, group: "管理" },
];
const pageLabels: Record<Page,string> = {usage:'用量与费用',imports:'导入',insights:'洞察',overview:'总览',timeline:'采集记录',notes:'随手记',ask:'问一问',archive:'资料库',memories:'记忆',devices:'设备',sources:'来源',settings:'设置',connections:'连接授权',developer:'开发者选项',about:'关于 Mote',vault:'数据与备份'};
const periodNames: Record<string, string> = {
  today: "今天",
  week: "过去 7 天",
  month: "过去 30 天",
  all: "全部时间",
};
const readConnection = () => {
  try {
    return restoreSession(sessionStorage.getItem("mote.connection"), window.location.origin);
  } catch {
    return null;
  }
};
function Spinner({ label = "正在读取…" }: { label?: string }) {
  return (
    <span className="loading">
      <LoaderCircle size={16} className="spin" />
      {label}
    </span>
  );
}
function Empty({
  icon: Icon = Layers3,
  title,
  children,
}: {
  icon?: typeof Layers3;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={25} strokeWidth={1.35} />
      </div>
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  );
}
function ErrorNotice({ text, retry }: { text: string; retry?: () => void }) {
  return (
    <div className="notice error" role="alert">
      <Info size={17} />
      <span>{text}</span>
      {retry && (
        <button className="text-button" onClick={retry}>
          重试
        </button>
      )}
    </div>
  );
}
function DeviceIcon({
  platform,
  size = 20,
}: {
  platform: string;
  size?: number;
}) {
  return platform === "android" ? (
    <Smartphone size={size} />
  ) : platform === "import" ? (
    <HardDrive size={size} />
  ) : (
    <Monitor size={size} />
  );
}
function StateBadge({ device }: { device: Device }) {
  const state = deviceState(device);
  return (
    <span
      className={`badge ${state === "capturing" ? "green" : state === "error" || state === "permission_required" ? "amber" : "muted"}`}
    >
      <span className="dot" />
      {deviceLabels[state] || state}
    </span>
  );
}

function AuthImage({
  api,
  capture,
  className = "",
  full = false,
}: {
  api: Api;
  capture: Capture | CapturePreview;
  className?: string;
  full?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(full);
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const hasImage = 'hasImage' in capture ? capture.hasImage : Boolean(capture.blobHash);
  const text = 'textPreview' in capture ? capture.textPreview : capture.ocrText;
  const media = 'textPreview' in capture ? capture.media : capture.metadata?.media;
  useEffect(() => {
    if (full || visible || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [full, visible]);
  useEffect(() => {
    if (!visible || !hasImage) return;
    const controller = new AbortController();
    let url = "";
    let mounted = true;
    setError("");
    setSrc("");
    void api
      .raw(`/api/capture-browser/${encodeURIComponent(capture.id)}/image${full ? '' : '?thumbnail=1'}`, {
        signal: controller.signal,
      })
      .then((response) => response.blob())
      .then((blob) => {
        if (!mounted) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch((e) => {
        if (!controller.signal.aborted && mounted) setError(errorMessage(e));
      });
    return () => {
      mounted = false;
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, capture.id, hasImage, visible, full]);
  return (
    <div
      ref={ref}
      className={`capture-image ${className} ${!hasImage ? "text-image" : ""} ${capture.source==='media'?'media-image':''}`}
    >
      {!hasImage ? (
        <>
          {capture.source==='media'?<Headphones size={28}/>:<FileText size={23} />}
          <p>{capture.source==='media'?mediaCardText(media,'privacy' in capture?capture.privacy.collection:undefined):capture.source === 'activity' ? '仅应用活动 · 未采集内容' : text.slice(0, 170) || "来源元数据"}</p>
        </>
      ) : src ? (
        <img
          src={src}
          decoding="async"
          alt={`${capture.appName} · ${dateTime(capture.capturedAt)}`}
        />
      ) : error ? (
        <div className="image-failure">
          <WifiOff size={19} />
          <span>影像暂不可用</span>
        </div>
      ) : (
        <LoaderCircle className="spin" size={19} />
      )}
    </div>
  );
}

function CaptureCard({
  capture,
  api,
  onOpen,
}: {
  capture: Capture | CapturePreview;
  api: Api;
  onOpen: (id: string) => void;
}) {
  const text = 'textPreview' in capture ? capture.textPreview : capture.ocrText;
  const ocr = ocrPresentation('textPreview' in capture ? capture.ocr : captureOcrState(capture), text);
  const media = 'textPreview' in capture ? capture.media : capture.metadata?.media;
  return (
    <button className="capture-card" onClick={() => onOpen(capture.id)} aria-label={`查看 ${capture.appName || '未识别应用'} · ${dateTime(capture.capturedAt)} 的记录`}>
      <AuthImage api={api} capture={capture} />
      <div className="capture-card-body">
        <div className="capture-caption">
          <span className="app-avatar">
            {(capture.appName || "M").slice(0, 1)}
          </span>
          <strong>{capture.appName || "未识别应用"}</strong>
          <time>
            {dateTime(capture.capturedAt, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </time>
        </div>
        <p>
          {capture.source==='media'?`媒体播放 · ${capture.durationMs>0?`播放采样 ${duration(capture.durationMs)}`:'状态观察 · 不累计时长'}`:capture.source === 'activity' ? `仅应用活动 · 本次采样 ${duration(capture.durationMs)}` : ('summary' in capture && capture.summary) ||
            capture.windowTitle ||
            text ||
            (capture.source === 'screen' ? ocr.description : '此记录没有正文')}
        </p>
        {capture.source === 'screen' && <span className={`badge capture-ocr ${ocr.tone}`}>{ocr.label}</span>}
        {capture.source==='media'&&<span className={`badge capture-ocr ${mediaStatus(media).tone}`}>{mediaStatus(media).label}</span>}
        {capture.source!=='media'&&media&&<span className="badge capture-ocr muted"><Headphones size={12}/>附带媒体状态</span>}
        <div className="capture-bottom">
          <span>
            <DeviceIcon platform={capture.platform} size={12} />
            {capture.deviceName}
          </span>
          {'privacy' in capture && capture.privacy.redacted && (
            <span title="客户端报告已脱敏">
              <ShieldCheck size={12} /> 已脱敏
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function LoginDialog({ destination, onConnected, onClose }: {
  destination: string;
  onConnected: (value: Connection) => void;
  onClose: () => void;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError("");
    try {
      if (!token.trim()) throw new Error("请输入管理访问令牌。");
      const connection = {token: token.trim()};
      // A collector credential must never unlock owner-only management pages.
      await createApi(connection).request("/api/configuration", {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])});
      if (!controller.signal.aborted) onConnected(connection);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof ApiError && e.status === 401
        ? "令牌无效或已失效，请检查后重新登录。"
        : e instanceof ApiError && e.status === 403
          ? "此令牌没有管理权限。请使用中央节点的管理令牌，设备配对凭据不能登录管理页面。"
          : errorMessage(e));
    } finally { if (!controller.signal.aborted) setBusy(false); active.current = null; }
  }
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()} onKeyDown={e => e.key === "Escape" && onClose()}>
    <section className="modal connect-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">
      <button className="icon-button close" aria-label="关闭登录" onClick={onClose}><X size={19}/></button>
      <div className="modal-icon"><ShieldCheck size={24}/></div>
      <div className="eyebrow">MOTE · 中央管理界面</div>
      <h2 id="connect-title">登录 Mote</h2>
      <p className="muted-copy">此服务就是中央节点，负责接收和归档客户端采集的数据。验证管理令牌后，进入「{destination}」。</p>
      <form onSubmit={connect}>
        <p className="login-endpoint">当前服务 <strong>{window.location.origin}</strong></p>
        <label>管理访问令牌<input aria-label="管理访问令牌" autoFocus type="password" autoComplete="off" placeholder="输入此节点的管理令牌" value={token} onChange={e=>setToken(e.target.value)} required disabled={busy}/></label>
        <div className="field-note"><ShieldCheck size={15}/>令牌只保留在当前标签页会话，退出登录后清除。</div>
        {error && <ErrorNotice text={error}/>}
        <button className="button primary full" disabled={busy}>{busy ? <Spinner label="正在验证令牌…"/> : <>登录并继续<ArrowRight size={16}/></>}</button>
      </form>
      <details className="connection-help"><summary>在哪里获取管理令牌？</summary><p>在部署机器上运行 <code>node scripts/mote.mjs token --profile dev</code>（日常环境使用对应名称），或读取部署配置中的 <code>MOTE_TOKEN</code>。设备扫码使用单独的一次性邀请。</p></details>
    </section>
  </div>;
}

function EvidenceDialog({
  id,
  api,
  onClose,
  onDeleted,
  onOpen,
}: {
  id: string;
  api: Api;
  onClose: () => void;
  onDeleted: () => void;
  onOpen: (id:string) => void;
}) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setCapture(null);
    setError("");
    setConfirm(false);
    void api
      .request<Capture>(`/api/capture-browser/${encodeURIComponent(id)}`, {signal: controller.signal})
      .catch(()=>api.request<Capture>(`/api/captures/${encodeURIComponent(id)}`,{signal:controller.signal}))
      .then((value) => active && setCapture(value))
      .catch((e) => active && setError(errorMessage(e)));
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, id]);
  useEffect(() => {
    if (capture?.ocr?.status !== 'pending') return;
    const controller = new AbortController();
    let fetching = false;
    const timer = setInterval(() => {
      if (fetching || document.hidden) return;
      fetching = true;
      void api.request<Capture>(`/api/capture-browser/${encodeURIComponent(id)}`, {signal: controller.signal})
        .then(value => {if (!controller.signal.aborted) setCapture(value);})
        .catch(() => { /* Preserve the last reported state while the node is unavailable. */ })
        .finally(() => {fetching = false;});
    }, 10_000);
    return () => {clearInterval(timer);controller.abort();};
  }, [api, id, capture?.ocr?.status]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  async function remove() {
    setBusy(true);
    try {
      await api.request(`/api/captures/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      onDeleted();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const presentation = capture ? evidencePresentation(capture) : null;
  const ocr = capture ? ocrPresentation(captureOcrState(capture), capture.ocrText, capture.metadata?.capture?.deduplication?.duplicate) : null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className="modal evidence-modal"
        role="dialog"
        aria-modal="true"
        aria-label="上下文证据详情"
      >
        <div className="evidence-heading">
          <div>
            <span className="eyebrow">CONTEXT / EVIDENCE</span>
            <h2>{capture?.appName || "上下文证据"}</h2>
            {capture && (
              <p>
                {dateTime(capture.capturedAt)} · {capture.deviceName}
              </p>
            )}
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="关闭证据详情"
          >
            <X size={20} />
          </button>
        </div>
        {presentation?.nativeFile && <FileDetail api={api} id={presentation.nativeFile.captureId} startMs={presentation.nativeFile.startMs} onOpen={onOpen}/>}
        {error && <ErrorNotice text={error} />}
        {!capture && !error && (
          <div className="panel-pad">
            <Spinner />
          </div>
        )}
        {capture && (
          <>
            <div className={`evidence-grid ${!capture.blobHash ? 'note-evidence' : ''}`}>
              {capture.blobHash && <AuthImage api={api} capture={capture} full />}
              <div className="evidence-text">
                <span className="eyebrow">{presentation?.textLabel}</span>
                <h3>{capture.windowTitle || sourceLabels[capture.source] || "原始上下文"}</h3>
                {capture.mood && <p className="note-mood-tag">我标注的心情 · {capture.mood}</p>}
                {capture.source === 'screen' && ocr && <div className="evidence-ocr-status" role="status"><span className={`badge ${ocr.tone}`}>{ocr.label}</span><p>{ocr.description}</p></div>}
                <pre aria-label={capture.source === 'screen' ? 'OCR 全文' : '记录全文'}>
                  {capture.source==='media'?mediaExplanation:capture.source === 'activity' ? activityExplanation : systemEventText(capture.metadata) || capture.ocrText || (capture.provenance?.deleted ? '来源已报告删除；本次只保留来源元数据。' : capture.provenance?.layer === 'reference' ? '此来源仅保留引用与元数据，未导入正文。' : presentation?.nativeFile&&capture.provenance?.layer==='original'?'原件单独保存；转写与摘要见上方。':capture.blobHash ? '暂无文字。' : '此记录没有正文。')}
                </pre>
                {(capture.source==='media'||capture.metadata?.media)&&<MediaSnapshot media={capture.metadata?.media} observedAt={capture.metadata?.observedAt??capture.capturedAt} screenLocked={capture.metadata?.state?.screenLocked} collection={capture.privacy.collection}/>}
                <dl>
                  <div>
                    <dt>来源</dt>
                    <dd>
                      {sourceLabels[capture.source] || capture.source}
                    </dd>
                  </div>
                  {capture.appId && <div><dt>应用标识</dt><dd>{capture.appId}</dd></div>}
                  {(capture.source === 'screen' || capture.source === 'activity') && <div><dt>前台应用采样时长</dt><dd>{duration(capture.durationMs)}</dd></div>}
                  {capture.source==='media'&&<div><dt>媒体播放采样时长</dt><dd>{capture.durationMs>0?duration(capture.durationMs):'状态观察，不累计时长'}</dd></div>}
                  {capture.ocr?.updatedAt && <div><dt>OCR 状态更新时间</dt><dd>{dateTime(capture.ocr.updatedAt)}</dd></div>}
                  <div>
                    <dt>索引状态</dt>
                    <dd>
                      {capture.source==='media'?'媒体状态与上报内容可检索':capture.source === 'activity' ? '应用与时间可检索' : (
                        {
                          text_ready: "文本可检索",
                          pending: "等待索引",
                          indexed: "已建立索引",
                          failed: "索引失败",
                        } as Record<string, string>
                      )[capture.indexingStatus] || capture.indexingStatus}
                    </dd>
                  </div>
                  <div>
                    <dt>隐私处理</dt>
                    <dd>
                      {capture.source==='media'?(capture.privacy.collection==='activity'?'仅应用与播放状态，不采集标题等内容':'保留应用上报的媒体信息，不录制音频'):capture.source === 'activity' ? '仅记应用活动，不采集内容' : capture.privacy.redacted
                        ? "客户端报告已脱敏"
                        : "未标记脱敏"}
                    </dd>
                  </div>
                </dl>
                <Metadata metadata={capture.metadata} source={capture.provenance?.metadata} modifiedAt={capture.provenance?.modifiedAt}/>
                <SourceDocumentDetails api={api} document={capture.provenance?.document}/>
                {capture.privacy.reason && (
                  <p className="field-note">{capture.privacy.reason}</p>
                )}
                <code className="record-id">{capture.id}</code>
              </div>
            </div>
            <div className="evidence-footer">
              {confirm ? (
                <>
                  <p>
                    {presentation?.deleteDescription}此操作无法撤销。
                  </p>
                  <button
                    className="button subtle"
                    onClick={() => setConfirm(false)}
                    disabled={busy}
                  >
                    取消
                  </button>
                  <button
                    className="button danger"
                    onClick={() => void remove()}
                    disabled={busy}
                  >
                    {busy ? <Spinner /> : "确认删除"}
                  </button>
                </>
              ) : (
                <>
                  {capture.blobHash ? (
                    <span><ShieldCheck size={14} />影像通过鉴权后读取</span>
                  ) : capture.source === "note" ? (
                    <span>由你主动记录</span>
                  ) : <span />}
                  <button
                    className="text-button danger-text"
                    onClick={() => setConfirm(true)}
                  >
                    <Trash2 size={15} />
                    删除这条记录
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function AnswerView({
  answer,
  onOpen,
}: {
  answer: Answer;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="answer">
      <div className="answer-label">
        <span className="mote-symbol small">m</span>
        <strong>Mote</strong>
        <span>根据你的上下文</span>
      </div>
      <div className="markdown">
        <AnswerMarkdown answer={answer} onOpen={onOpen} />
      </div>
      {answer.citations.length > 0 && (
        <div className="citations">
          <span className="eyebrow">证据来源 · {answer.citations.length}</span>
          <div className="citation-grid">
            {answer.citations.map((cite, index) => (
              <button
                key={cite.id}
                onClick={() => onOpen(cite.id)}
                className="citation"
              >
                <span className="citation-number">{index + 1}</span>
                <div>
                  <strong>{cite.appName || "上下文记录"}</strong>
                  <p>{cite.excerpt || "查看原始记录"}</p>
                  <time>{dateTime(cite.contentAt??cite.capturedAt)}</time>
                </div>
                <ArrowUp size={14} />
              </button>
            ))}
          </div>
        </div>
      )}
      <TurnUsage usage={answer.usage}/>
      <details className="trace">
        <summary>
          <Layers3 size={14} />
          查看检索过程 <span>{answer.trace.length} 次工具调用</span>
        </summary>
        {answer.trace.map((step, index) => (
          <div key={index}>
            <span>{index + 1}</span>
            <code>{step.tool}</code>
            <p>{JSON.stringify(step.arguments)}</p>
            <small>{step.count} 项结果</small>
          </div>
        ))}
        <p className="run-id">运行 ID · {answer.runId}</p>
      </details>
    </div>
  );
}

function SetupSteps({ onPage }: { onPage: (page: Page) => void }) {
  return (
    <div className="setup-steps">
      <div>
        <span>01</span>
        <h3>连上采集端</h3>
        <p>在手机或电脑的连接设置中，扫描或导入一次性邀请。</p>
      </div>
      <div>
        <span>02</span>
        <h3>选择愿意留下的内容</h3>
        <p>设置应用排除和脱敏，确认权限后主动开启采集。</p>
      </div>
      <div>
        <span>03</span>
        <h3>让上下文开始连结</h3>
        <p>回到这里查看记录；配置模型后，就可以问一个问题。</p>
        <button className="text-button" onClick={() => onPage("devices")}>
          查看设备连接指引 <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}

function Overview({api,status,devices,activity,recent,insights,onPage,onOpen,range,onMedia}: {api:Api;status:Status;devices:Device[];activity:Activity;recent:Capture[];insights:Answer[];onPage:(page:Page)=>void;onOpen:(id:string)=>void;range:Range;onMedia:()=>void}) {
 return <div className="home-page">
  <div className="greeting"><div><div className="eyebrow">你的个人上下文</div><h1>给生活留一点线索。</h1><p>记下的片刻，在需要时重新找到。</p></div><div className="greeting-mark" aria-hidden="true"><div/><div/><div/><span>m.</span></div></div>
  <div className="home-actions"><button className="home-action primary-action" onClick={()=>onPage('notes')}><FileText size={23}/><span><strong>写一条随手记</strong><small>留住此刻的想法</small></span><ArrowRight size={18}/></button><button className="home-action" onClick={()=>onPage('ask')}><MessageSquare size={23}/><span><strong>从记录里找答案</strong><small>带着来源，回看自己的经历</small></span><ArrowRight size={18}/></button></div>
  <div className="stats-grid compact-stats"><div className="stat"><span><Layers3 size={16}/>前台应用与屏幕采样</span><strong>{activity.captures.toLocaleString()}<em>条</em></strong><small>按所选时间统计，与媒体记录分别查看</small></div><div className="stat"><span><Clock3 size={16}/>前台应用采样时长</span><strong>{duration(activity.totalDurationMs)}</strong><small>采样区间累计，不等同专注时间</small></div><button className="stat stat-link" onClick={()=>onPage('devices')}><span><Monitor size={16}/>已知设备</span><strong>{devices.length}<em>台</em></strong><small>查看最近联系与上报的同步状态 →</small></button></div>
  <MediaActivitySummary api={api} range={range} onOpen={onOpen} compact onExpand={onMedia}/>
  {!status.storage.captures&&<section className="panel first-record"><span className="preference-menu-icon"><Link2 size={23}/></span><div><h2>准备好接住第一份记录</h2><p>连接一台设备，或导入你选择的文件。采集范围与同步方式由你决定。</p></div><button className="button" onClick={()=>onPage('devices')}>连接设备<ArrowRight size={15}/></button></section>}
  <section className="recent-section"><div className="section-heading"><div><h2>最近留下的片刻</h2><p>来自你选择的设备与来源</p></div><button className="text-button" onClick={()=>onPage('timeline')}>全部记录<ArrowRight size={15}/></button></div>{recent.length?<div className="capture-grid">{recent.slice(0,4).map(capture=><CaptureCard key={capture.id} capture={capture} api={api} onOpen={onOpen}/>)}</div>:<div className="home-empty"><Layers3 size={23}/><p>记录会在同步完成后出现在这里。也可以先写一条随手记。</p></div>}</section>
  {insights[0]&&<button className="home-insight" onClick={()=>onPage('insights')}><Sparkles size={21}/><div><strong>你最近的洞察</strong><p>{answerPreview(insights[0],125)}</p><small>{insights[0].citations.length} 条证据来源</small></div><ArrowRight size={18}/></button>}
 </div>;
}

function ActivitySummary({activity}:{activity:Activity}) {return <section className="panel activity-panel"><div className="section-heading"><div><h2>应用活动概况</h2><p>前台应用采样时长 · {duration(activity.totalDurationMs)}</p></div></div>{activity.apps.length?<><div className="app-list">{activity.apps.map((app,index)=><div className="app-row" key={app.appId||app.appName}><span className={'app-dot dot-'+index%5}/><strong>{app.appName}</strong><span>{duration(app.durationMs)}</span><small>{activity.totalDurationMs?Math.round(app.durationMs/activity.totalDurationMs*100):0}%</small></div>)}</div><p className="measurement-note">多台设备分别计时；未采样的时间不会补齐，应用活动不代表注意力或实际工作成果。后台媒体播放单独统计，可在「媒体播放」中查看。</p></>:<Empty icon={Clock3} title="这段时间还没有活动采样"><p>设备完成同步后，可以在这里查看应用时间分布。</p></Empty>}</section>;}

type ArchiveTab = 'records'|'files'|'activity'|'media'|'memories';
function Archive({api,devices,range,activity,revision,onOpen,tab,setTab}:{api:Api;devices:Device[];range:Range;activity:Activity;revision:number;onOpen:(id:string)=>void;tab:ArchiveTab;setTab:(tab:ArchiveTab)=>void}) {
 return <div className="archive-page"><div className="page-heading"><div className="eyebrow">有来处，也有脉络</div><h1>资料库</h1><p>浏览原始记录、活动与播放分布，以及有证据支撑的记忆。</p></div><nav className="segmented-nav" aria-label="资料库分类">{([['records','全部记录'],['files','文件'],['activity','应用活动'],['media','媒体播放'],['memories','记忆']] as const).map(([id,label])=><button key={id} aria-current={tab===id?'page':undefined} className={tab===id?'active':''} onClick={()=>setTab(id)}>{label}</button>)}</nav>{tab==='files'&&<Files api={api} onOpen={onOpen}/>} {tab==='records'&&<Timeline api={api} devices={devices} revision={revision} onOpen={onOpen}/>} {tab==='activity'&&<ActivitySummary activity={activity}/>} {tab==='media'&&<MediaActivitySummary key={revision} api={api} range={range} onOpen={onOpen}/>} {tab==='memories'&&<Memories api={api} range={range} onOpen={onOpen} refreshVersion={revision}/>}</div>;
}

function Timeline(props:{api:Api;devices:Device[];onOpen:(id:string)=>void;revision:number}) {
  const [view,setView]=useState('sessions');
  return <><div className="filter-bar" role="group" aria-label="记录视图"><button className={'button '+(view==='sessions'?'primary':'')} onClick={()=>setView('sessions')}>Session / App 分组</button><button className={'button '+(view==='records'?'primary':'')} onClick={()=>setView('records')}>全部记录</button></div>{view==='sessions'?<><div className="page-heading"><div className="eyebrow">沿着连续的记录回看</div><h2>采集记录</h2><p>先看一段，再展开其中的截图与上下文。</p></div><CaptureSessions {...props}/></>:<RecordTimeline {...props}/>}</>;
}
function RecordTimeline({
  api,
  devices,
  onOpen,
  revision,
}: {
  api: Api;
  devices: Device[];
  onOpen: (id: string) => void;
  revision: number;
}) {
  const [after, setAfter] = useState("");
  const [before, setBefore] = useState("");
  const [device, setDevice] = useState("");
  const [collection, setCollection] = useState<'' | 'activity' | 'content'>('');
  const [source,setSource] = useState('');
  const [ocrStatus, setOcrStatus] = useState('');
  const [items, setItems] = useState<CapturePreview[]>([]);
  const [totalCount, setTotalCount] = useState<number>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const marker = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);
  const inFlight = useRef(false);
  const request = useRef<AbortController | null>(null);
  const range = useMemo(
    () => ({
      ...captureDateRange(after, before),
      ...(device ? { deviceId: device } : {}),
      ...(collection ? {collection} : {}),
      ...(source ? {source} : {}),
      ...(ocrStatus ? {ocrStatus} : {}),
    }),
    [after, before, device, collection, source, ocrStatus],
  );
  const load = useCallback(
    async (next?: string, version = requestVersion.current) => {
      if (inFlight.current && next) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      inFlight.current = true;
      setLoading(true);
      setError("");
      try {
        const result = await api.request<{
          items: CapturePreview[];
          nextCursor: string | null;
          totalCount: number;
        }>(`/api/capture-browser${queryString(range, { limit: 24, cursor: next })}`, {signal: controller.signal});
        if (requestVersion.current !== version || controller.signal.aborted) return;
        setItems((previous) =>
          next
            ? [
                ...previous,
                ...result.items.filter(
                  (item) => !previous.some((old) => old.id === item.id),
                ),
              ]
            : result.items,
        );
        setCursor(result.nextCursor);
        setTotalCount(result.totalCount);
      } catch (e) {
        if (requestVersion.current === version && !controller.signal.aborted) setError(errorMessage(e));
      } finally {
        if (requestVersion.current === version) {
          setLoading(false);
          inFlight.current = false;
        }
      }
    },
    [api, range],
  );
  useEffect(() => {
    const version = ++requestVersion.current;
    setItems([]);
    setCursor(null);
    setTotalCount(undefined);
    inFlight.current = false;
    void load(undefined, version);
    return () => {request.current?.abort();requestVersion.current++;};
  }, [load, revision, refreshVersion]);
  useEffect(() => {
    if (!cursor || loading || error || !marker.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void load(cursor);
      },
      { rootMargin: "160px" },
    );
    observer.observe(marker.current);
    return () => observer.disconnect();
  }, [cursor, loading, error, load]);
  const groups = useMemo(() => {
    const result = new Map<string, CapturePreview[]>();
    for (const item of items) {
      const key = new Date(item.capturedAt).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      });
      result.set(key, [...(result.get(key) || []), item]);
    }
    return [...result.entries()];
  }, [items]);
  return (
    <>
      <div className="page-heading timeline-heading">
        <div className="eyebrow">按天回看，保留来处</div>
        <h1>采集记录</h1>
        <p>按日期浏览截图、文字与媒体状态；点击记录查看内容和采样时的上下文。</p>
      </div>
      <div className="capture-day-controls">
        <label><span>按天查看</span><input type="date" aria-label="查看某天的采集记录" value={after && after === before ? after : ''} onChange={event => {setAfter(event.target.value);setBefore(event.target.value);}}/></label>
        <button className="button subtle" onClick={() => {const day=localDateInput(new Date());setAfter(day);setBefore(day);}}>今天</button>
        <button className="button subtle" aria-label="查看前一天" disabled={!after || after !== before} onClick={() => {const date=new Date(`${after}T00:00:00`);date.setDate(date.getDate()-1);const day=localDateInput(date);setAfter(day);setBefore(day);}}><ArrowLeft size={15}/></button>
        <button className="button subtle" aria-label="查看后一天" disabled={!after || after !== before} onClick={() => {const date=new Date(`${after}T00:00:00`);date.setDate(date.getDate()+1);const day=localDateInput(date);setAfter(day);setBefore(day);}}><ArrowRight size={15}/></button>
        <button className="button subtle capture-refresh" disabled={loading} onClick={() => setRefreshVersion(value => value + 1)}><RefreshCw size={15} className={loading ? 'spin' : ''}/>刷新记录</button>
      </div>
      <div className="filter-bar capture-filters">
        <label>
          <span>从</span>
          <input
            type="date"
            aria-label="开始日期"
            value={after}
            onChange={(e) => setAfter(e.target.value)}
          />
        </label>
        <label>
          <span>至</span>
          <input
            type="date"
            aria-label="结束日期"
            value={before}
            min={after}
            onChange={(e) => setBefore(e.target.value)}
          />
        </label>
        <label>
          <Monitor size={15} />
          <select
            aria-label="筛选设备"
            value={device}
            onChange={(e) => setDevice(e.target.value)}
          >
            <option value="">全部设备</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.deviceName}
              </option>
            ))}
          </select>
        </label>
        <label><span>来源</span><select aria-label="筛选记录来源" value={source} onChange={event=>{setSource(event.target.value);if(event.target.value&&event.target.value!=='screen')setOcrStatus('');}}><option value="">全部来源</option>{Object.entries(sourceLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>采集级别</span><select aria-label="筛选采集级别" value={collection} onChange={event=>setCollection(event.target.value as typeof collection)}><option value="">全部记录</option><option value="activity">仅活动状态</option><option value="content">允许保留的内容</option></select></label>
        <label><span>OCR</span><select aria-label="筛选 OCR 状态" value={ocrStatus} onChange={event=>setOcrStatus(event.target.value)}><option value="">全部状态</option><option value="pending">待处理</option><option value="completed">已完成</option><option value="failed">失败</option><option value="disabled">已关闭</option><option value="unknown">状态未知</option></select></label>
        {(after || before || device || collection || source || ocrStatus) && (
          <button
            className="text-button"
            onClick={() => {
              setAfter("");
              setBefore("");
              setDevice("");
              setCollection('');
              setSource('');
              setOcrStatus('');
            }}
          >
            清除筛选
          </button>
        )}
        <span className="filter-count">已读取 {items.length}{totalCount === undefined ? '' : ` / ${totalCount}`} 条</span>
      </div>
      <p className="capture-browse-note">日期按当前浏览器时区显示。这里展示已同步到中央节点的记录；待充电的 OCR 由采集端补做，结果同步后可刷新查看。</p>
      {error && (
        <ErrorNotice
          text={error}
          retry={() => void load(cursor || undefined)}
        />
      )}
      {groups.map(([day, records]) => (
        <section className="timeline-group" key={day}>
          <h2>
            <span className="timeline-dot" />
            {day}
            <small>已加载 {records.length} 条</small>
          </h2>
          <div className="capture-grid">
            {records.map((capture) => (
              <CaptureCard
                key={capture.id}
                capture={capture}
                api={api}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      ))}
      {loading && (
        <div className="load-more">
          <Spinner label="正在找回这些片刻…" />
        </div>
      )}
      {!loading && !items.length && !error && (
        <div className="panel">
          <Empty icon={Clock3} title="这段时间还没有记录">
            <p>试试其他时间或设备，或检查采集端是否已开启。</p>
          </Empty>
        </div>
      )}
      <div ref={marker} className="load-more">
        {cursor && !loading && (
          <button className="button subtle" onClick={() => void load(cursor)}>
            加载更早的记录 <ChevronDown size={14} />
          </button>
        )}
        {!cursor && items.length > 0 && !loading && (
          <span>已经走到这些片刻的起点了。</span>
        )}
      </div>
    </>
  );
}

function Ask({api,status,devices,range,onOpen,onInsights,onSettings}: {api:Api;status:Status;devices:Device[];range:Range;onOpen:(id:string)=>void;onInsights:()=>void;onSettings:()=>void}) {
  return <><div className="page-heading split-heading"><div><div className="eyebrow">带着问题，回到上下文</div><h1>你只管问。</h1><p>让 Mote 沿着你的上下文，找回答案和它的来处。</p></div><button className="button subtle" onClick={onInsights}><Sparkles size={15}/>查看洞察</button></div>
  {!status.agent.configured&&<div className="notice model-notice"><Sparkles size={19}/><div><strong>再连接一个模型，让资料变成答案。</strong><p>在设置中配置模型后，就可以开始提问。</p><button className="button" onClick={onSettings}>打开模型设置</button></div></div>}
  <Conversations api={api} configured={status.agent.configured} devices={devices} range={range} renderAnswer={answer=><AnswerView answer={answer} onOpen={onOpen}/>}/></>;
}

function Vault({
  api,
  status,
  refresh,
  disconnect,
}: {
  api: Api;
  status: Status;
  refresh: () => void;
  disconnect: () => void;
}) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  async function action(kind: string, fn: () => Promise<string>) {
    setBusy(kind);
    setError("");
    setMessage("");
    try {
      setMessage(await fn());
      refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function exportArchive() {
    const response = await api.raw("/api/export");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mote-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return "资料已导出，包含记录、影像与校验信息。";
  }
  async function importFile(file?: File) {
    if (!file) return;
    await action("import", async () => {
      const raw = await file.text();
      const archive = JSON.parse(raw);
      if (archive.version !== 1 || !Array.isArray(archive.captures))
        throw new Error("请选择 Mote v1 JSON 归档文件。");
      const result = await api.request<{
        imported: number;
        duplicates: number;
      }>("/api/import", { method: "POST", body: raw });
      return `已导入 ${result.imported} 条记录，跳过 ${result.duplicates} 条重复记录。`;
    });
    if (input.current) input.current.value = "";
  }
  const storage = status.storage;
  const ratio = storage.maxBytes
    ? Math.min(100, (storage.bytes / storage.maxBytes) * 100)
    : 0;
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">YOUR CONTEXT BELONGS TO YOU</div>
        <h1>数据与备份</h1>
        <p>知道留下了什么、存在哪里，也随时保留迁移的自由。</p>
      </div>
      {error && <ErrorNotice text={error} />}
      {message && (
        <div className="notice success" role="status">
          <CheckCircle2 size={17} />
          {message}
        </div>
      )}
      <div className="vault-columns">
        <section className="panel storage-panel">
          <div className="section-heading">
            <div>
              <h2>存储概况</h2>
              <p>中央节点 · 文件对象与 SQLite 索引</p>
            </div>
            <Database size={21} className="muted-icon" />
          </div>
          <div className="storage-number">
            {bytes(storage.bytes)}
            <span>
              {storage.maxBytes ? `/ ${bytes(storage.maxBytes)}` : "已使用"}
            </span>
          </div>
          <div className="storage-track">
            <span style={{ width: `${Math.max(1, ratio)}%` }} />
          </div>
          <div className="storage-stats">
            <div>
              <strong>{storage.captures.toLocaleString()}</strong>
              <span>上下文记录</span>
            </div>
            <div>
              <strong>{storage.blobs.toLocaleString()}</strong>
              <span>独立影像对象</span>
            </div>
            <div>
              <strong>{bytes(storage.imageBytes)}</strong>
              <span>影像原始大小</span>
            </div>
          </div>
          <div className="storage-note">
            <Layers3 size={16} />
            <p>
              相同影像共享一份存储，每次采样仍保留独立观察记录。
              {storage.imageCaptures !== undefined &&
                `已复用 ${Math.max(0, storage.imageCaptures - storage.blobs)} 次影像。`}
            </p>
          </div>
          <dl>
            <div>
              <dt>新图片存储</dt>
              <dd>
                {storage.imagesEncrypted
                  ? "加密已启用（仅后续写入）"
                  : "明文保存（默认）"}
              </dd>
            </div>
            <div>
              <dt>保留周期</dt>
              <dd>
                {status.retentionDays
                  ? `${status.retentionDays} 天`
                  : "持续保留 · 未启用自动删除"}
              </dd>
            </div>
            <div>
              <dt>最早记录</dt>
              <dd>
                {storage.firstCaptureAt
                  ? dateTime(storage.firstCaptureAt)
                  : "尚无记录"}
              </dd>
            </div>
          </dl>
          <p className="fine-print">
            内容加密默认关闭，可在开发者选项中启用或一次性解密已有文件。数据库正文和索引保存在 SQLite 中。
          </p>
        </section>
        <section className="panel transfer-panel">
          <div className="section-heading">
            <div>
              <h2>导入与导出</h2>
              <p>可移植归档，保留完整上下文。</p>
            </div>
            <ArrowDownToLine size={21} className="muted-icon" />
          </div>
          <div className="transfer-action">
            <div className="transfer-icon">
              <ArrowDownToLine size={19} />
            </div>
            <div>
              <h3>导出资料</h3>
              <p>记录、原始影像和校验信息。访问令牌不会包含在内。</p>
            </div>
            <button
              className="button subtle"
              disabled={!!busy}
              onClick={() => void action("export", exportArchive)}
            >
              {busy === "export" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                "导出"
              )}
            </button>
          </div>
          <div className="transfer-action">
            <div className="transfer-icon">
              <ArrowUpFromLine size={19} />
            </div>
            <div>
              <h3>导入归档</h3>
              <p>合并 Mote v1 JSON 归档，验证校验值并跳过重复记录。</p>
            </div>
            <button
              className="button subtle"
              disabled={!!busy}
              onClick={() => input.current?.click()}
            >
              {busy === "import" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                "选择文件"
              )}
            </button>
            <input
              ref={input}
              className="hidden"
              type="file"
              accept="application/json,.json"
              aria-label="导入 Mote 归档"
              onChange={(e) => void importFile(e.target.files?.[0])}
            />
          </div>
          <div className="backup-note">
            <Info size={16} />
            <div>
              <strong>大资料库适合使用离线备份</strong>
              <p>
                网页导出受中央节点归档大小限制。需要完整备份或迁移加密数据时，在中央节点运行：
              </p>
              <code>npm run backup -- --help</code>
            </div>
          </div>
        </section>
      </div>

      <section className="panel index-panel">
        <div className="section-heading">
          <div>
            <h2>索引与 Agent</h2>
            <p>确定性的存储，模型负责理解。</p>
          </div>
          <span
            className={`badge ${status.agent.configured ? "green" : "muted"}`}
          >
            <span className="dot" />
            {status.agent.configured ? "Agent 已连接" : "模型待配置"}
          </span>
        </div>
        <div className="index-grid">
          <div>
            <span>检索方式</span>
            <strong>
              {status.index.mode === "hybrid" ? "全文 + 向量检索" : "文本检索"}
            </strong>
            <small>{status.index.model || "可选择配置 Embedding 模型"}</small>
          </div>
          <div>
            <span>推理模型</span>
            <strong>{status.agent.model || "尚未配置"}</strong>
            <small>{status.agent.provider}</small>
          </div>
          <div>
            <span>自动回顾</span>
            <strong>
              {status.insightIntervalHours
                ? `每 ${status.insightIntervalHours} 小时且有足够新增资料`
                : "手动生成"}
            </strong>
            <small>使用同一只读 Agent 与来源引用</small>
          </div>
        </div>
        <div className="index-statuses">
          {storage.indexing.map((row) => (
            <span key={row.status}>
              <span className={`dot ${row.status === "failed" ? "red" : ""}`} />
              {(
                {
                  pending: "等待索引",
                  indexed: "已建立向量索引",
                  text_ready: "文本就绪",
                  failed: "索引失败",
                } as Record<string, string>
              )[row.status] || row.status}
              <strong>{row.count}</strong>
            </span>
          ))}
          <button
            className="text-button"
            disabled={!!busy || status.index.mode !== "hybrid"}
            onClick={() =>
              void action("retry", async () => {
                const result = await api.request<{ queued: number }>(
                  "/api/index/retry",
                  { method: "POST", body: "{}" },
                );
                return `已将 ${result.queued} 条记录加入索引队列。`;
              })
            }
          >
            <RefreshCw size={14} className={busy === "retry" ? "spin" : ""} />
            重试索引
          </button>
        </div>
      </section>
      <section className="panel node-settings">
        <div>
          <div className="node-avatar">
            <Database size={21} />
          </div>
          <div>
            <strong>当前服务（中央节点）</strong>
            <p>{window.location.origin}</p>
            <small>访问令牌只保留在当前标签页会话中</small>
          </div>
        </div>
        <button className="button subtle" onClick={disconnect}>
          <Unplug size={15} />
          退出登录
        </button>
      </section>
    </>
  );
}

function App() {
  const [connection, setConnection] = useState<Connection | null>(
    readConnection,
  );
  const connectionGeneration = useRef(0);
  const [verified, setVerified] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [page, setPage] = useState<Page>("overview");
  const [period, setPeriod] = useState("week");
  const [menuOpen, setMenuOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [activity, setActivity] = useState<Activity>({
    apps: [],
    devices: [],
    totalDurationMs: 0,
    captures: 0,
  });
  const [archiveTab, setArchiveTab] = useState<ArchiveTab>('records');
  const [recent, setRecent] = useState<Capture[]>([]);
  const [insights, setInsights] = useState<Answer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [timelineRevision, setTimelineRevision] = useState(0);
  const disconnect = useCallback(() => {
    connectionGeneration.current++;
    sessionStorage.removeItem("mote.connection");
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
    setEvidenceId(null);
    window.moteCentralSession?.close();
  }, []);
  const unauthorized = useCallback(() => {
    disconnect();
    setNotice("登录已失效，请重新输入管理令牌。");
    setShowConnect(true);
  }, [disconnect]);
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
    void api.request("/api/configuration", {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])})
      .then(() => { if (!controller.signal.aborted) setVerified(true); })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof ApiError && e.status === 403 ? "此令牌没有管理权限，请退出后使用管理令牌登录。" : errorMessage(e)); });
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
    setRevision((value) => value + 1);
    setTimelineRevision((value) => value + 1);
  }, []);
  useEffect(() => {
    if (!api || !verified) return;
    let active = true;
    const controller = new AbortController();
    setLoading(true); setError("");
    const load = async <T,>(path: string, apply: (value: T) => void) => {
      const result = await api.request<T>(path, {signal: controller.signal});
      if (active) apply(result);
    };
    // Independent collections must not block navigation when one endpoint fails.
    void Promise.allSettled([
      load<Status>("/api/status", value => {api.setAgentTimeout(value.agent.timeoutMs);setStatus(value);}),
      load<{items: Device[]}>("/api/devices", value => setDevices(value.items)),
      load<Activity>(`/api/activity${queryString(range)}`, setActivity),
      load<{items: Capture[]}>(`/api/captures${queryString(range, {limit: 4})}`, value => setRecent(value.items)),
      load<{items: Answer[]}>("/api/insights", value => setInsights(value.items)),
    ]).then(results => {
      if (!active) return;
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") setError("部分资料加载失败，其他页面仍可使用。" + errorMessage(failure.reason));
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [api, verified, range, revision]);
  useEffect(() => {
    if (!api) return;
    const timer = setInterval(() => setRevision((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, [api, refresh]);
  useEffect(() => {
    if (showConnect) return;
    const heading = Array.from(document.querySelectorAll<HTMLElement>(".content h1")).find(element => element.getClientRects().length);
    if (heading) { heading.tabIndex = -1; heading.focus({preventScroll: true}); }
  }, [page, showConnect]);
  function onPage(next: Page) {
    setPage(next);
    if (!connection) setShowConnect(true);
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  }
  function connected(value: Connection) {
    connectionGeneration.current++;
    sessionStorage.setItem("mote.connection", JSON.stringify(value));
    setConnection(value);
    setVerified(false);
    setStatus(null);
    setDevices([]); setRecent([]); setInsights([]); setEvidenceId(null);
    setActivity({apps:[],devices:[],totalDurationMs:0,captures:0});
    setShowConnect(false);
    setNotice("");
  }
  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <button
          className="brand"
          onClick={() => onPage("overview")}
          aria-label="Mote 总览"
        >
          <span className="mote-symbol">m</span>
          <span>
            Mote<span className="brand-dot">.</span>
          </span>
        </button>
        <div className="workspace-label">中央管理界面</div>
        <nav>
          {["日常", "资料", "管理"].map(group => <React.Fragment key={group}><div className="nav-group-label">{group}</div>{nav.filter(item=>item.group===group).map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              aria-current={page === item.id ? "page" : undefined}
              onClick={() => onPage(item.id)}
            >
              <item.icon size={18} strokeWidth={1.7} />
              {item.label}
              {item.id === "ask" && <span className="nav-spark">✦</span>}
            </button>
          ))}</React.Fragment>)}
        </nav>
        <div className="sidebar-bottom">
          <button aria-current={["settings","vault","developer","about","connections"].includes(page)?"page":undefined} className={"settings-nav "+(["settings","vault","developer","about","connections"].includes(page)?"active":"")} onClick={()=>onPage("settings")}><Settings2 size={18}/>设置</button>
          <div className="local-note">
            <span className="orbit-mark">✳</span>
            <p>
              一点一滴，
              <br />
              慢慢成为你的记忆。
            </p>
          </div>
          <button className="node-button" onClick={() => connection ? onPage("about") : setShowConnect(true)}>
            <span
              className={`node-state ${verified ? "online" : ""}`}
            />
            <div>
              <strong>
                {verified ? `已登录 · ${status?.profile || "当前节点"}` : connection ? "正在验证登录" : "登录 Mote"}
              </strong>
              <small>
                {verified ? "管理当前节点" : "使用管理令牌访问资料"}
              </small>
            </div>
            <Settings2 size={15} />
          </button>
          <div className="version">
            MOTE <span>个人上下文</span>
          </div>
        </div>
      </aside>
      {menuOpen && (
        <div className="sidebar-scrim" onClick={() => setMenuOpen(false)} />
      )}
      <main className="main">
        <header className="topbar">
          <div>
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Menu size={21} />
            </button>
            <span className="breadcrumb">
              我的空间 <span>/</span>{" "}
              <strong>{pageLabels[page]}</strong>
            </span>
          </div>
          <div className="topbar-actions">
            {connection && (
              <>
                <span className="private-label">
                  <ShieldCheck size={14} />
                  私有节点
                </span>
                {(["overview", "ask", "memories", "insights"].includes(page) || (page === "archive" && archiveTab !== "records")) && (
                  <select
                    className="period-select"
                    aria-label="选择时间范围"
                    value={period}
                    onChange={(e) => setPeriod(e.target.value)}
                  >
                    {Object.entries(periodNames).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  className="icon-button"
                  aria-label="刷新资料"
                  onClick={refresh}
                  disabled={loading}
                >
                  <RefreshCw size={16} className={loading ? "spin" : ""} />
                </button>
              </>
            )}
            <button
              className="avatar"
              aria-label={connection ? "登录会话" : "登录 Mote"}
              onClick={() => connection ? onPage("about") : setShowConnect(true)}
            >
              我
            </button>
          </div>
        </header>
        <div className="content">
          {notice && (
            <div className="notice" role="status">
              <Info size={17} />
              <span>{notice}</span>
              <button
                className="icon-button"
                aria-label="关闭提示"
                onClick={() => setNotice("")}
              >
                <X size={15} />
              </button>
            </div>
          )}
          {!connection ? (
            <>
              <div className="greeting welcome">
                <div>
                  <div className="eyebrow">A HOME FOR YOUR CONTEXT</div>
                  <h1>
                    {page === "overview" ? "你的资料，汇聚在这里。" : `登录后查看${pageLabels[page]}`}
                  </h1>
                  <p>
                    这里是当前节点的管理界面。登录后可查看资料库、管理设备和设置模型；手机与电脑客户端负责采集和同步。
                  </p>
                  <button
                    className="button primary"
                    onClick={() => setShowConnect(true)}
                  >
                    <Link2 size={16} />
                    登录 Mote
                    <ArrowRight size={16} />
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
              <div className="welcome-values">
                <div>
                  <ShieldCheck size={20} />
                  <h3>由你决定留下什么</h3>
                  <p>应用过滤与端点脱敏，先于资料上传。</p>
                </div>
                <div>
                  <Database size={20} />
                  <h3>资料在你的节点</h3>
                  <p>可以导入、导出，也可以继续扩展来源。</p>
                </div>
                <div>
                  <Sparkles size={20} />
                  <h3>答案带着来处</h3>
                  <p>Agent 读取证据，串起你的问题与记录。</p>
                </div>
              </div>
              <section className="panel onboarding-panel">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">THREE SMALL STEPS</span>
                    <h2>从一台设备开始。</h2>
                  </div>
                </div>
                <SetupSteps onPage={onPage} />
              </section>
            </>
          ) : (
            <>
              {error && <ErrorNotice text={error} retry={refresh} />}
              {!verified && <button className="button subtle" onClick={disconnect}>退出登录</button>}
              {page === "notes" && api && verified && <Notes key={window.location.origin} api={api} namespace={window.location.origin} revision={timelineRevision} onOpen={setEvidenceId} onSaved={refresh} />}
              {!verified
                ? !error && (
                    <div className="initial-loading">
                      <Spinner label="正在验证登录权限…" />
                    </div>
                  )
                : api && (
                    <>
                      {!["notes","devices","connections","settings","sources","archive","memories","imports","insights","about"].includes(page) && !status && !error && <Spinner label="正在读取节点状态…"/>}
                      {page === "overview" && status && (
                        <Overview
                          api={api}
                          status={status}
                          devices={devices}
                          activity={activity}
                          recent={recent}
                          insights={insights}
                          onPage={onPage}
                          onOpen={setEvidenceId}
                          range={range}
                          onMedia={()=>{setArchiveTab('media');onPage('archive');}}
                        />
                      )}
                      {page === "timeline" && (
                        <Timeline
                          api={api}
                          devices={devices}
                          onOpen={setEvidenceId}
                          revision={timelineRevision}
                        />
                      )}
                      {page === "ask" && status && (
                        <Ask
                          api={api}
                          devices={devices}
                          status={status}
                          range={range}
                          onOpen={setEvidenceId}
                          onInsights={()=>onPage("insights")}
                          onSettings={()=>onPage("settings")}
                        />
                      )}
                      {page === "devices" && (
                        <DeviceOverview devices={devices} onConnect={()=>onPage("connections")} />
                      )}
                      {page === "vault" && status && (
                        <><PageBack title="设置" onBack={()=>onPage("settings")}/><Vault
                          api={api}
                          status={status}
                          refresh={refresh}
                          disconnect={disconnect}
                        /></>
                      )}
                      {page === "sources" && <Sources api={api} onOpen={setEvidenceId} onImport={()=>onPage("imports")} />}
                      {page === "imports" && <Imports api={api} refreshVersion={timelineRevision} onOpen={setEvidenceId} onMemories={()=>onPage("memories")} onSettings={()=>onPage("settings")} onChanged={refresh}/>}
                      {page === "usage" && <Usage api={api}/>}
                      {page === "insights" && <Insights api={api} refreshVersion={timelineRevision} range={range} configured={status?.agent.configured??false} onOpen={setEvidenceId} onSettings={()=>onPage("settings")} onChanged={refresh}/>}
                      {page === "memories" && <Memories api={api} range={range} refreshVersion={timelineRevision} onOpen={setEvidenceId} />}
                      {page === "settings" && <ServerSettings api={api} onNavigate={onPage} onModelApplied={refresh}/>}
                      {page === "archive" && <Archive tab={archiveTab} setTab={setArchiveTab} api={api} devices={devices} range={range} activity={activity} revision={timelineRevision} onOpen={setEvidenceId}/>}
                      {page === "connections" && <><PageBack title="设备" onBack={()=>onPage("devices")}/><Connections api={api} serverUrl={window.location.origin} devices={devices}/></>}
                      {page === "developer" && status && <><PageBack title="设置" onBack={()=>onPage("settings")}/><div className="page-heading"><div className="eyebrow">开发与维护</div><h1>开发者选项</h1><p>查看运行诊断，按需调整日志与高级部署配置。</p></div><ContentStorage api={api} onChange={refresh}/><Diagnostics api={api} profile={status.profile}/><AdvancedConfiguration api={api}/></>}
                      {page === "about" && <><PageBack title="设置" onBack={()=>onPage("settings")}/><div className="page-heading"><div className="eyebrow">你的资料，由你保管</div><h1>关于 Mote</h1><p>AI 原生个人上下文采集与中央归档。</p></div><SoftwareUpdate api={api}/><section className="panel session-settings"><h2>当前服务（中央节点）</h2><p>{window.location.origin}</p><p className="fine-print">访问令牌只保留在当前标签页会话。</p><button className="button subtle" onClick={disconnect}><Unplug size={15}/>退出登录</button></section></>}
                    </>
                  )}
            </>
          )}
        </div>
        <footer className="footer">
          <span>Mote · 让上下文，有迹可循。</span>
          <span>
            {connection && status
              ? `${status.storage.captures.toLocaleString()} 条记录 · ${status.agent.configured ? "Agent 就绪" : "等待模型配置"}`
              : "采集 · 汇聚 · 理解"}
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
      {evidenceId && api && (
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

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
