import { captureOcrState,parseEvidenceRef,systemEventText,type CapturePreview } from '@mote/shared';
import { moteText } from '@mote/shared/i18n';
import {
ArrowRight,
ArrowUp,
ChevronDown,
FileText,
HardDrive,
Headphones,
Info,
Layers3,
LoaderCircle,
Monitor,
ShieldCheck,
Smartphone,
Trash2,
WifiOff,
X
} from "lucide-react";
import React,{
useEffect,
useRef,
useState
} from "react";
import { AnswerMarkdown } from "./AnswerMarkdown";
import { EvidenceState } from './EvidenceState';
import { ReferenceDetail } from './ReferenceDetail';
import { TurnUsage } from './Usage';
import {
ApiError,
createApi,
dateTime,
deviceLabels,
deviceState,
duration,
errorMessage,
type Answer,
type Api,
type Capture,
type Connection,
type Device
} from "./api";
import { evidencePresentation,ocrPresentation } from './capture-presentation';
import { containDialogFocus } from './dialog-focus';
import { type Page } from './navigation';
import { resources } from './resource-cache';
import { readSessionLifetime,type SessionLifetime } from "./session";
import { useOperationUpdates } from './useOperationUpdates';
import { useResource } from './useResource';

import { MediaSnapshot } from './Media';
import { activityExplanation,Metadata,sourceLabels } from './Metadata';
import { mediaCardText,mediaExplanation,mediaStatus } from './media-presentation';

import { FileDetail } from './Files';
import { SourceDocumentDetails } from './SourceDocumentDetails';


export function Spinner({ label = moteText("正在读取…") }: { label?: string }) {
  return (
    <span className="loading">
      <LoaderCircle size={16} className="spin" />
      {label}
    </span>
  );
}

export function Empty({
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

export function ErrorNotice({ text, retry }: { text: string; retry?: () => void }) {
  return (
    <div className="notice error" role="alert">
      <Info size={17} />
      <span>{text}</span>
      {retry && (
        <button className="text-button" onClick={retry}>
          {moteText("重试")}</button>
      )}
    </div>
  );
}

export function DeviceIcon({
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

export function StateBadge({ device }: { device: Device }) {
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

export function CentralStatusPill({
  connection,
  verified,
  onClick,
}: {
  connection: Connection | null;
  verified: boolean;
  onClick: () => void;
}) {
  const state = !connection ? "signed-out" : verified ? "online" : "checking";
  const label = !connection
    ? moteText("连接中央节点")
    : verified
      ? moteText("中央节点 · 已连接")
      : moteText("中央节点 · 正在验证");
  return (
    <button
      className={`connection-pill ${state}`}
      type="button"
      onClick={onClick}
      aria-label={verified ? moteText("已连接中央节点，打开连接详情") : label}
    >
      <span className="connection-pill-dot" aria-hidden="true" />
      <span>{label}</span>
      {connection ? <ChevronDown size={14} aria-hidden="true" /> : <ArrowRight size={14} aria-hidden="true" />}
    </button>
  );
}

export function AuthImage({
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
          <p>{capture.source==='media'?mediaCardText(media,'privacy' in capture?capture.privacy.collection:undefined):capture.source === 'activity' ? moteText("仅应用活动 · 未采集内容") : text.slice(0, 170) || moteText("来源元数据")}</p>
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
          <span>{moteText("影像暂不可用")}</span>
        </div>
      ) : (
        <LoaderCircle className="spin" size={19} />
      )}
    </div>
  );
}

export function CaptureCard({
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
    <button className="capture-card" onClick={() => onOpen(capture.id)} aria-label={moteText("查看 {0} · {1} 的记录", capture.appName || moteText("未识别应用"), dateTime(capture.capturedAt))}>
      <AuthImage api={api} capture={capture} />
      <div className="capture-card-body">
        <div className="capture-caption">
          <span className="app-avatar">
            {(capture.appName || "M").slice(0, 1)}
          </span>
          <strong>{capture.appName || moteText("未识别应用")}</strong>
          <time>
            {dateTime(capture.capturedAt, {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </time>
        </div>
        <p>
          {('stateSummary' in capture&&capture.stateSummary)?moteText("合并 {0} 次状态观察",capture.stateSummary.count):capture.source==='media'?moteText("媒体播放 · {0}", capture.durationMs>0?moteText("播放采样 {0}", duration(capture.durationMs)):moteText("状态观察 · 不累计时长")):capture.source === 'activity' ? moteText("仅应用活动 · 本次采样 {0}", duration(capture.durationMs)) : ('summary' in capture && capture.summary) ||
            capture.windowTitle ||
            text ||
            (capture.source === 'screen' ? ocr.description : moteText("此记录没有正文"))}
        </p>
        {capture.source === 'screen' && <span className={`badge capture-ocr ${ocr.tone}`}>{ocr.label}</span>}
        {capture.source==='media'&&<span className={`badge capture-ocr ${mediaStatus(media).tone}`}>{mediaStatus(media).label}</span>}
        {capture.source!=='media'&&media&&<span className="badge capture-ocr muted"><Headphones size={12}/>{moteText("附带媒体状态")}</span>}
        <div className="capture-bottom">
          <span>
            <DeviceIcon platform={capture.platform} size={12} />
            {capture.deviceName}
          </span>
          {'sizeBytes' in capture && capture.sizeBytes !== undefined && <span>{(capture.sizeBytes/1024).toFixed(1)} KiB</span>}
          {'privacy' in capture && capture.privacy.redacted && (
            <span title={moteText("客户端报告已脱敏")}>
              <ShieldCheck size={12} /> {' '}{moteText("已脱敏")}</span>
          )}
        </div>
      </div>
    </button>
  );
}

export function LoginDialog({ destination, onConnected, onClose }: {
  destination: string;
  onConnected: (value: Connection, lifetime: SessionLifetime) => void;
  onClose: () => void;
}) {
  const [token, setToken] = useState("");
  const [lifetime, setLifetime] = useState<SessionLifetime>(readSessionLifetime);
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
      if (!token.trim()) throw new Error(moteText("请输入管理访问令牌。"));
      const connection = {token: token.trim()};
      // A collector credential must never unlock owner-only management pages.
      await createApi(connection).request("/api/configuration", {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)])});
      if (!controller.signal.aborted) onConnected(connection, lifetime);
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof ApiError && e.status === 401
        ? moteText("令牌无效或已失效，请检查后重新登录。")
        : e instanceof ApiError && e.status === 403
          ? moteText("此令牌没有管理权限。请使用中央节点的管理令牌，设备配对凭据不能登录管理页面。")
          : errorMessage(e));
    } finally { if (!controller.signal.aborted) setBusy(false); active.current = null; }
  }
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()} onKeyDown={e => e.key === "Escape" && onClose()}>
    <section className="modal connect-modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">
      <button className="icon-button close" aria-label={moteText("关闭登录")} onClick={onClose}><X size={19}/></button>
      <div className="modal-icon"><ShieldCheck size={24}/></div>
      <div className="eyebrow">{moteText("MOTE · 中央管理界面")}</div>
      <h2 id="connect-title">{moteText("登录 Mote")}</h2>
      <p className="muted-copy">{moteText("此服务就是中央节点，负责接收和归档客户端采集的数据。验证管理令牌后，进入「")}{destination}」。</p>
      <form onSubmit={connect}>
        <p className="login-endpoint">{moteText("当前服务")}{' '}<strong>{window.location.origin}</strong></p>
        <label>{moteText("管理访问令牌")}<input aria-label={moteText("管理访问令牌")} autoFocus type="password" autoComplete="off" placeholder={moteText("输入此节点的管理令牌")} value={token} onChange={e=>setToken(e.target.value)} required disabled={busy}/></label>
        <label className="session-lifetime-control"><span>{moteText("登录会话有效期")}</span><select aria-label={moteText("登录会话有效期")} value={lifetime} onChange={e=>setLifetime(e.target.value as SessionLifetime)} disabled={busy}><option value="session">{moteText("当前窗口（Session）")}</option><option value="1d">{moteText("1 天")}</option><option value="7d">{moteText("7 天")}</option><option value="30d">{moteText("30 天")}</option></select></label>
        <div className="field-note"><ShieldCheck size={15}/>{lifetime==='session'?moteText("令牌只保留在当前标签页会话，退出登录后清除。"):moteText("令牌会保存在此浏览器中，并在所选期限后自动清除；退出登录会立即清除。")}</div>
        {error && <ErrorNotice text={error}/>}
        <button className="button primary full" disabled={busy}>{busy ? <Spinner label={moteText("正在验证令牌…")}/> : <>{moteText("登录并继续")}<ArrowRight size={16}/></>}</button>
      </form>
      <details className="connection-help"><summary>{moteText("在哪里获取管理令牌？")}</summary><p>{moteText("在部署机器上运行")}{' '}<code>node scripts/mote.mjs token --profile dev</code>{moteText("（日常环境使用对应名称），或读取部署配置中的")}{' '}<code>MOTE_TOKEN</code>{moteText("。设备扫码使用单独的一次性邀请。")}</p></details>
    </section>
  </div>;
}

export function OriginalImage({api,capture}:{api:Api;capture:Capture}) {
  const [open,setOpen]=useState(false);
  return <div className="original-image"><button className="button" aria-expanded={open} onClick={()=>setOpen(!open)}>{open?moteText('收起原图'):moteText('查看原图')}</button>{open&&<AuthImage api={api} capture={capture} full/>}</div>;
}

export function EvidenceDialog({
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
  const captureRef=parseEvidenceRef(id)?.kind==='capture';
  const {data:capture,error:readError}=useResource<Capture>(api,captureRef?`/api/capture-browser/${encodeURIComponent(id)}`:null);
  useOperationUpdates(api);
  const [mutationError,setError]=useState('');
  const error=mutationError||(readError?errorMessage(readError):'');
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(()=>{setError('');setConfirm(false);},[id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  useEffect(() => {
    const panel = document.querySelector<HTMLElement>('.evidence-modal');
    return panel?containDialogFocus(panel,document.activeElement as HTMLElement|null):undefined;
  }, []);
  async function remove() {
    setBusy(true);
    try {
      await api.request(`/api/captures/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      resources(api).invalidate(key=>/^\/api\/(capture-browser|captures|files|memories|source-items|sources)([/?]|$)/.test(key));
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
        aria-label={moteText("上下文证据详情")}
      >
        <div className="evidence-heading">
          <div>
            <span className="eyebrow">CONTEXT / EVIDENCE</span>
            <h2>{capture?.appName || moteText("上下文证据")}</h2>
            {capture && (
              <p>
                {dateTime(capture.capturedAt)} · {capture.deviceName}
              </p>
            )}
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label={moteText("关闭证据详情")}
          >
            <X size={20} />
          </button>
        </div>
        {presentation?.nativeFile && <FileDetail api={api} id={presentation.nativeFile.captureId} startMs={presentation.nativeFile.startMs} onOpen={onOpen}/>}
        {error && <ErrorNotice text={error} />}
        {!captureRef&&<ReferenceDetail key={id} api={api} reference={id} onOpen={onOpen}/>}
        {captureRef && !capture && !error && (
          <div className="panel-pad">
            <Spinner />
          </div>
        )}
        {capture && (
          <>
            <div className={`evidence-grid ${!capture.blobHash ? 'note-evidence' : ''}`}>
              {capture.blobHash && <OriginalImage key={capture.id} api={api} capture={capture}/>}
              <div className="evidence-text"><EvidenceState/>
                <span className="eyebrow">{presentation?.textLabel}</span>
                <h3>{capture.windowTitle || sourceLabels[capture.source] || moteText("原始上下文")}</h3>
                {capture.source === 'screen' && ocr && <div className="evidence-ocr-status" role="status"><span className={`badge ${ocr.tone}`}>{ocr.label}</span><p>{ocr.description}</p></div>}
                <pre aria-label={capture.source === 'screen' ? moteText("OCR 全文") : moteText("记录全文")}>
                  {capture.source==='media'?mediaExplanation:capture.source === 'activity' ? activityExplanation : systemEventText(capture.metadata) || capture.ocrText || (capture.provenance?.deleted ? moteText("来源已报告删除；本次只保留来源元数据。") : capture.provenance?.layer === 'reference' ? moteText("此来源仅保留引用与元数据，未导入正文。") : presentation?.nativeFile&&capture.provenance?.layer==='original'?moteText("原件单独保存；转写与摘要见上方。"):capture.blobHash ? moteText("暂无文字。") : moteText("此记录没有正文。"))}
                </pre>
                {(capture.source==='media'||capture.metadata?.media)&&<MediaSnapshot media={capture.metadata?.media} observedAt={capture.metadata?.observedAt??capture.capturedAt} screenLocked={capture.metadata?.state?.screenLocked} collection={capture.privacy.collection}/>}
                <dl>
                  <div>
                    <dt>{moteText("来源")}</dt>
                    <dd>
                      {sourceLabels[capture.source] || capture.source}
                    </dd>
                  </div>
                  {capture.appId && <div><dt>{moteText("应用标识")}</dt><dd>{capture.appId}</dd></div>}
                  {(capture.source === 'screen' || capture.source === 'activity') && <div><dt>{moteText("前台应用采样时长")}</dt><dd>{duration(capture.durationMs)}</dd></div>}
                  {capture.source==='media'&&<div><dt>{moteText("媒体播放采样时长")}</dt><dd>{capture.durationMs>0?duration(capture.durationMs):moteText("状态观察，不累计时长")}</dd></div>}
                  {capture.ocr?.updatedAt && <div><dt>{moteText("OCR 状态更新时间")}</dt><dd>{dateTime(capture.ocr.updatedAt)}</dd></div>}
                  <div>
                    <dt>{moteText("索引状态")}</dt>
                    <dd>
                      {capture.source==='media'?moteText("媒体状态与上报内容可检索"):capture.source === 'activity' ? moteText("应用与时间可检索") : (
                        {
                          text_ready: moteText("文本可检索"),
                          pending: moteText("等待索引"),
                          indexed: moteText("已建立索引"),
                          failed: moteText("索引失败"),
                        } as Record<string, string>
                      )[capture.indexingStatus] || capture.indexingStatus}
                    </dd>
                  </div>
                  <div>
                    <dt>{moteText("隐私处理")}</dt>
                    <dd>
                      {capture.source==='media'?(capture.privacy.collection==='activity'?moteText("仅应用与播放状态，不采集标题等内容"):moteText("保留应用上报的媒体信息，不录制音频")):capture.source === 'activity' ? moteText("仅记应用活动，不采集内容") : capture.privacy.redacted
                        ? moteText("客户端报告已脱敏")
                        : moteText("未标记脱敏")}
                    </dd>
                  </div>
                </dl>
                {capture.metadata?.attachments?.map(id=><button className="button subtle" key={id} onClick={()=>onOpen(id)}>{moteText("查看附件")} · {id.slice(0,8)}</button>)}
                <Metadata stateSeries={capture.stateSeries} metadata={capture.metadata} source={capture.provenance?.metadata} modifiedAt={capture.provenance?.modifiedAt}/>
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
                    {presentation?.deleteDescription}{moteText("此操作无法撤销。")}</p>
                  <button
                    className="button subtle"
                    onClick={() => setConfirm(false)}
                    disabled={busy}
                  >
                    {moteText("取消")}</button>
                  <button
                    className="button danger"
                    onClick={() => void remove()}
                    disabled={busy}
                  >
                    {busy ? <Spinner /> : moteText("确认删除")}
                  </button>
                </>
              ) : (
                <>
                  {capture.blobHash ? (
                    <span><ShieldCheck size={14} />{moteText("影像通过鉴权后读取")}</span>
                  ) : capture.source === "note" ? (
                    <span>{moteText("由你主动记录")}</span>
                  ) : <span />}
                  <button
                    className="text-button danger-text"
                    onClick={() => setConfirm(true)}
                  >
                    <Trash2 size={15} />
                    {moteText("删除这条记录")}</button>
                </>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

export function AnswerView({
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
        <span>{moteText("根据你的上下文")}</span>
      </div>
      <div className="markdown">
        <AnswerMarkdown answer={answer} onOpen={onOpen} />
      </div>
      {answer.citations.length > 0 && (
        <div className="citations">
          <span className="eyebrow">{moteText("证据来源 ·")}{' '}{answer.citations.length}</span>
          <div className="citation-grid">
            {answer.citations.map((cite, index) => (
              <button
                key={cite.id}
                onClick={() => onOpen(cite.id)}
                className="citation"
              >
                <span className="citation-number">{index + 1}</span>
                <div>
                  <strong>{cite.appName || moteText("上下文记录")}</strong>
                  <p>{cite.excerpt || moteText("查看原始记录")}</p>
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
          {moteText("查看检索过程")}{' '}<span>{answer.trace.length}{' '}{moteText("次工具调用")}</span>
        </summary>
        {answer.trace.map((step, index) => (
          <div key={index}>
            <span>{index + 1}</span>
            <code>{step.tool}</code>
            <p>{JSON.stringify(step.arguments)}</p>
            <small>{step.count}{' '}{moteText("项结果")}</small>
          </div>
        ))}
        <p className="run-id">{moteText("运行 ID ·")}{' '}{answer.runId}</p>
      </details>
    </div>
  );
}

export function SetupSteps({ onPage }: { onPage: (page: Page) => void }) {
  return (
    <div className="setup-steps">
      <div>
        <span>01</span>
        <h3>{moteText("连上采集端")}</h3>
        <p>{moteText("在手机或电脑的连接设置中，扫描或导入一次性邀请。")}</p>
      </div>
      <div>
        <span>02</span>
        <h3>{moteText("选择愿意留下的内容")}</h3>
        <p>{moteText("设置应用排除和脱敏，确认权限后主动开启采集。")}</p>
      </div>
      <div>
        <span>03</span>
        <h3>{moteText("让上下文开始连结")}</h3>
        <p>{moteText("回到这里查看记录；配置模型后，就可以问一个问题。")}</p>
        <button className="text-button" onClick={() => onPage("devices")}>
          {moteText("查看设备连接指引")}{' '}<ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}
