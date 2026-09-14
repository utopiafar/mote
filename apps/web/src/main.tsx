import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { AnswerMarkdown } from "./AnswerMarkdown";
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
import { ServerSettings } from "./ServerSettings";
import { Connections } from "./Connections";

import {Sources} from "./Sources";
import {Memories} from "./Memories";

type Page = "sources" | "memories" | "overview" | "timeline" | "notes" | "ask" | "devices" | "vault" | "settings";
const nav = [
  { id: "overview" as const, label: "总览", icon: LayoutDashboard },
  { id: "timeline" as const, label: "时间线", icon: Clock3 },
  { id: "notes" as const, label: "随手记", icon: FileText },
  {id:"sources" as const,label:"来源",icon:Link2},
  {id:"memories" as const,label:"记忆",icon:Layers3},
  { id: "ask" as const, label: "问一问", icon: MessageSquare },
  { id: "devices" as const, label: "设备", icon: Monitor },
  { id: "vault" as const, label: "资料库", icon: Database },
  { id: "settings" as const, label: "服务端配置", icon: Settings2 },
];
const periodNames: Record<string, string> = {
  today: "今天",
  week: "过去 7 天",
  month: "过去 30 天",
  all: "全部时间",
};
const readConnection = () => {
  try {
    const value = JSON.parse(
      sessionStorage.getItem("mote.connection") || "null",
    );
    return value &&
      typeof value.url === "string" &&
      typeof value.token === "string"
      ? (value as Connection)
      : null;
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
  capture: Capture;
  className?: string;
  full?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(full);
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
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
    if (!visible || !capture.blobHash) return;
    const controller = new AbortController();
    let url = "";
    let mounted = true;
    setError("");
    setSrc("");
    void api
      .raw(`/api/captures/${encodeURIComponent(capture.id)}/image`, {
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
  }, [api, capture.id, capture.blobHash, visible]);
  return (
    <div
      ref={ref}
      className={`capture-image ${className} ${!capture.blobHash ? "text-image" : ""}`}
    >
      {!capture.blobHash ? (
        <>
          <FileText size={23} />
          <p>{capture.ocrText.slice(0, 170) || "文本记录"}</p>
        </>
      ) : src ? (
        <img
          src={src}
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
  capture: Capture;
  api: Api;
  onOpen: (id: string) => void;
}) {
  return (
    <button className="capture-card" onClick={() => onOpen(capture.id)}>
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
          {capture.summary ||
            capture.windowTitle ||
            capture.ocrText ||
            "截图已归档，等待更多上下文"}
        </p>
        <div className="capture-bottom">
          <span>
            <DeviceIcon platform={capture.platform} size={12} />
            {capture.deviceName}
          </span>
          {capture.privacy.redacted && (
            <span title="客户端报告已脱敏">
              <ShieldCheck size={12} /> 已脱敏
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function ConnectionDialog({
  initial,
  onConnected,
  onClose,
}: {
  initial: Connection | null;
  onConnected: (value: Connection) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(initial?.url ?? "");
  const [token, setToken] = useState(initial?.token ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function connect(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const endpoint = url.trim().replace(/\/+$/, "");
      if (endpoint) {
        let parsed: URL;
        try { parsed = new URL(endpoint); }
        catch { throw new Error("节点地址格式不正确，请输入完整的 HTTP(S) 地址，或留空连接当前网站。"); }
        if (
          !["http:", "https:"].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash ||
          (parsed.pathname !== "/" && parsed.pathname !== "")
        )
          throw new Error(
            "请输入节点的完整 HTTP(S) 地址，不包含路径、账号或查询参数。",
          );
      }
      if (!token.trim()) throw new Error("请填写中央节点的访问令牌。");
      const connection = { url: endpoint, token: token.trim() };
      await createApi(connection).request("/api/status");
      onConnected(connection);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        className="modal connect-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
      >
        <button
          className="icon-button close"
          aria-label="关闭连接设置"
          onClick={onClose}
        >
          <X size={19} />
        </button>
        <div className="modal-icon">
          <Link2 size={24} />
        </div>
        <div className="eyebrow">YOUR PERSONAL NODE</div>
        <h2 id="connect-title">连接你的中央节点</h2>
        <p className="muted-copy">资料留在你选择的地方，Mote 把它们串起来。</p>
        <form onSubmit={connect}>
          <label>
            节点地址 <span>留空使用当前网站所在节点</span>
            <input
              autoFocus
              placeholder="https://mote.example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label>
            访问令牌
            <input
              type="password"
              autoComplete="off"
              placeholder="粘贴中央节点的访问令牌"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required
            />
          </label>
          <div className="field-note">
            <ShieldCheck size={15} />
            令牌仅保留在当前浏览器标签页的会话中。
          </div>
          {error && <ErrorNotice text={error} />}
          <button className="button primary full" disabled={busy}>
            {busy ? (
              <Spinner label="正在连接…" />
            ) : (
              <>
                <Link2 size={16} />
                连接节点
              </>
            )}
          </button>
        </form>
        <div className="connection-help">
          <strong>第一次使用？</strong>
          <p>
            从中央节点所选环境的数据目录中读取 <code>access-token</code>{" "}
            文件并复制令牌。若设置过 <code>MOTE_TOKEN</code>，使用你配置的值。
          </p>
          <p>
            手机上的 localhost 指手机自己；跨设备访问请填写可达的中央节点地址。
          </p>
        </div>
      </section>
    </div>
  );
}

function EvidenceDialog({
  id,
  api,
  onClose,
  onDeleted,
}: {
  id: string;
  api: Api;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [capture, setCapture] = useState<Capture | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setCapture(null);
    setError("");
    void api
      .request<Capture>(`/api/captures/${encodeURIComponent(id)}`)
      .then((value) => active && setCapture(value))
      .catch((e) => active && setError(errorMessage(e)));
    return () => {
      active = false;
    };
  }, [api, id]);
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
        {error && <ErrorNotice text={error} />}
        {!capture && !error && (
          <div className="panel-pad">
            <Spinner />
          </div>
        )}
        {capture && (
          <>
            <div className={`evidence-grid ${capture.source === 'note' ? 'note-evidence' : ''}`}>
              {capture.source !== 'note' && <AuthImage api={api} capture={capture} full />}
              <div className="evidence-text">
                <span className="eyebrow">{capture.source === 'note' ? '用户原文' : '捕获文本'}</span>
                <h3>{capture.windowTitle || (capture.source === 'note' ? '随手记' : "原始上下文")}</h3>
                {capture.mood && <p className="note-mood-tag">我标注的心情 · {capture.mood}</p>}
                <pre>
                  {capture.ocrText ||
                    "这条记录尚无 OCR 文本。截图仍可查看；可在采集端启用本地 OCR。"}
                </pre>
                <dl>
                  <div>
                    <dt>来源</dt>
                    <dd>
                      {capture.source === "screen"
                        ? "屏幕采样"
                        : capture.source === "file"
                          ? "文件导入"
                          : "用户随手记"}
                    </dd>
                  </div>
                  <div>
                    <dt>索引状态</dt>
                    <dd>
                      {(
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
                      {capture.privacy.redacted
                        ? "客户端报告已脱敏"
                        : "未标记脱敏"}
                    </dd>
                  </div>
                </dl>
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
                    删除原始记录及不再被引用的影像，并清除已有洞察。此操作无法撤销。
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
                  <time>{dateTime(cite.capturedAt)}</time>
                </div>
                <ArrowUp size={14} />
              </button>
            ))}
          </div>
        </div>
      )}
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
        <p>在电脑程序或 Android App 中，填入节点地址与访问令牌。</p>
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

function Overview({
  api,
  status,
  devices,
  activity,
  recent,
  insights,
  onPage,
  onOpen,
  generate,
  generating,
}: {
  api: Api;
  status: Status;
  devices: Device[];
  activity: Activity;
  recent: Capture[];
  insights: Answer[];
  onPage: (page: Page) => void;
  onOpen: (id: string) => void;
  generate: () => void;
  generating: boolean;
}) {
  const online = devices.filter(
    (device) => deviceState(device) === "capturing",
  ).length;
  const total = activity.totalDurationMs;
  return (
    <>
      <div className="greeting">
        <div>
          <div className="eyebrow">A LITTLE CONTEXT, A CLEARER PICTURE</div>
          <h1>给生活留一点线索。</h1>
          <p>散落在屏幕间的片刻，在这里慢慢连成脉络。</p>
        </div>
        <div className="greeting-mark" aria-hidden="true">
          <div />
          <div />
          <div />
          <span>m.</span>
        </div>
      </div>
      <div className="stats-grid">
        <div className="stat">
          <span>
            <Clock3 size={16} />
            已记录的设备时间
          </span>
          <strong>{duration(total)}</strong>
          <small>屏幕采样累计 · 不等同专注时间</small>
        </div>
        <div className="stat">
          <span>
            <Layers3 size={16} />
            这段时间的记录
          </span>
          <strong>
            {activity.captures.toLocaleString()}
            <em>条</em>
          </strong>
          <small>跨设备的屏幕上下文</small>
        </div>
        <div className="stat">
          <span>
            <Radio size={16} />
            正在采集
          </span>
          <strong>
            {online}
            <em>/ {devices.length} 台设备</em>
          </strong>
          <small>
            {online
              ? "上下文正在持续汇入"
              : devices.length
                ? "查看设备状态以恢复采集"
                : "等待第一台设备连接"}
          </small>
        </div>
      </div>
      {status.storage.captures === 0 && (
        <section className="panel onboarding-panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">START SMALL</span>
              <h2>从一台设备，开始你的上下文库。</h2>
            </div>
            <span className="badge neutral">尚无记录</span>
          </div>
          <SetupSteps onPage={onPage} />
        </section>
      )}
      <div className="overview-columns">
        <section className="panel activity-panel">
          <div className="section-heading">
            <div>
              <h2>时间流向</h2>
              <p>已记录的应用采样时间</p>
            </div>
            <Clock3 size={18} className="muted-icon" />
          </div>
          {activity.apps.length ? (
            <>
              <div className="time-track">
                {activity.apps.slice(0, 6).map((app, index) => (
                  <span
                    key={app.appName}
                    style={{
                      flex: Math.max(app.durationMs, 1),
                      background: [
                        "#356451",
                        "#738775",
                        "#a4ad93",
                        "#c8c8b5",
                        "#d2af7e",
                        "#a4b0ba",
                      ][index],
                    }}
                    title={`${app.appName} ${duration(app.durationMs)}`}
                  />
                ))}
              </div>
              <div className="app-list">
                {activity.apps.slice(0, 5).map((app, index) => (
                  <div className="app-row" key={app.appName}>
                    <span className={`app-dot dot-${index}`} />
                    <strong>{app.appName}</strong>
                    <span>{duration(app.durationMs)}</span>
                    <small>
                      {total ? Math.round((app.durationMs / total) * 100) : 0}%
                    </small>
                  </div>
                ))}
              </div>
              <p className="measurement-note">
                多设备同时使用时分别计入；缺失截图的时间不会被推断为活动。
              </p>
            </>
          ) : (
            <Empty icon={Clock3} title="还没有这段时间的采样">
              <p>连上设备后，应用时间分布会出现在这里。</p>
            </Empty>
          )}
        </section>
        <section className="insight-panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">CONNECT THE DOTS</span>
              <h2>
                <Sparkles size={18} />
                留意那些细小的发现
              </h2>
            </div>
          </div>
          <p className="insight-intro">
            把最近的记录放在一起，看看做过什么，哪些线索值得继续。
          </p>
          {insights[0] ? (
            <>
              <div className="insight-preview">
                {insights[0].answer.slice(0, 240)}
                {insights[0].answer.length > 240 ? "…" : ""}
              </div>
              <div className="insight-source">
                <Layers3 size={13} />
                {insights[0].citations.length} 条来源 ·{" "}
                {insights[0].createdAt
                  ? dateTime(insights[0].createdAt)
                  : "最近生成"}
              </div>
            </>
          ) : (
            <div className="insight-placeholder">
              <span />
              <span />
              <span />
              <p>
                {status.agent.configured
                  ? "有了记录，就可以生成第一份回顾。"
                  : "配置 Agent 模型后，生成有来源的个人回顾。"}
              </p>
            </div>
          )}
          <button
            className="button primary"
            onClick={generate}
            disabled={
              generating ||
              !status.agent.configured ||
              status.storage.captures === 0
            }
          >
            {generating ? (
              <Spinner label="正在查阅与思考…" />
            ) : (
              <>
                <Sparkles size={15} />
                {insights.length ? "生成新的回顾" : "生成一份回顾"}
                <ArrowRight size={15} />
              </>
            )}
          </button>
          {insights.length > 0 && (
            <button className="text-button" onClick={() => onPage("ask")}>
              阅读完整回顾与证据
            </button>
          )}
        </section>
      </div>
      <section className="recent-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">RECENT MOMENTS</span>
            <h2>最近留下的片刻</h2>
          </div>
          <button className="text-button" onClick={() => onPage("timeline")}>
            打开时间线 <ArrowRight size={15} />
          </button>
        </div>
        {recent.length ? (
          <div className="capture-grid">
            {recent.slice(0, 4).map((capture) => (
              <CaptureCard
                key={capture.id}
                capture={capture}
                api={api}
                onOpen={onOpen}
              />
            ))}
          </div>
        ) : (
          <div className="panel">
            <Empty title="这里会留下你的第一条上下文">
              <p>采集端会在你开启采集后，自动上传允许保留的记录。</p>
            </Empty>
          </div>
        )}
      </section>
      <section className="devices-strip">
        <div>
          <Monitor size={17} />
          <strong>你的采集端</strong>
        </div>
        {devices.length ? (
          devices.slice(0, 3).map((device) => (
            <div key={device.deviceId}>
              <span>{device.deviceName}</span>
              <StateBadge device={device} />
            </div>
          ))
        ) : (
          <span>电脑、手机，以及未来更多的数据源</span>
        )}
        <button className="text-button" onClick={() => onPage("devices")}>
          管理设备 <ArrowRight size={14} />
        </button>
      </section>
    </>
  );
}

function Timeline({
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
  const [items, setItems] = useState<Capture[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const marker = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);
  const inFlight = useRef(false);
  const range = useMemo(
    () => ({
      ...(after ? { after: new Date(`${after}T00:00:00`).toISOString() } : {}),
      ...(before
        ? {
            before: new Date(
              new Date(`${before}T00:00:00`).getTime() + 86_400_000,
            ).toISOString(),
          }
        : {}),
      ...(device ? { deviceId: device } : {}),
    }),
    [after, before, device],
  );
  const load = useCallback(
    async (next?: string, version = requestVersion.current) => {
      if (inFlight.current && next) return;
      inFlight.current = true;
      setLoading(true);
      setError("");
      try {
        const result = await api.request<{
          items: Capture[];
          nextCursor: string | null;
        }>(`/api/captures${queryString(range, { limit: 24, cursor: next })}`);
        if (requestVersion.current !== version) return;
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
      } catch (e) {
        if (requestVersion.current === version) setError(errorMessage(e));
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
    inFlight.current = false;
    void load(undefined, version);
  }, [load, revision]);
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
    const result = new Map<string, Capture[]>();
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
      <div className="page-heading">
        <div className="eyebrow">YOUR DAYS, IN CONTEXT</div>
        <h1>每一个片刻，都有来处。</h1>
        <p>沿着时间往回走，找到你见过、想过、做过的事。</p>
      </div>
      <div className="filter-bar">
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
        {(after || before || device) && (
          <button
            className="text-button"
            onClick={() => {
              setAfter("");
              setBefore("");
              setDevice("");
            }}
          >
            清除筛选
          </button>
        )}
        <span className="filter-count">已读取 {items.length} 条</span>
      </div>
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
            <small>{records.length} 条</small>
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

function Ask({
  api,
  status,
  devices,
  range,
  scopeKey,
  insights,
  onOpen,
  onInsight,
}: {
  api: Api;
  status: Status;
  devices: Device[];
  range: Range;
  scopeKey: string;
  insights: Answer[];
  onOpen: (id: string) => void;
  onInsight: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [selectedDevice, setSelectedDevice] = useState("");
  const [asked, setAsked] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"ask" | "insights">("ask");
  const [selectedInsight, setSelectedInsight] = useState<string | null>(null);
  const queryGeneration = useRef(0);
  const pendingQuery = useRef<AbortController | null>(null);
  // Invalidate the previous scope before a user can submit against the newly committed controls.
  useLayoutEffect(() => {
    queryGeneration.current += 1;
    pendingQuery.current?.abort();
    pendingQuery.current = null;
    setAnswer(null);
    setAsked("");
    setError("");
    setBusy(false);
    return () => {
      queryGeneration.current += 1;
      pendingQuery.current?.abort();
    };
  }, [scopeKey, selectedDevice]);
  async function submit(e?: React.FormEvent, sample?: string) {
    e?.preventDefault();
    const text = sample || question.trim();
    if (!text || busy) return;
    setQuestion(text);
    setAsked(text);
    setBusy(true);
    setError("");
    setAnswer(null);
    const generation = ++queryGeneration.current;
    const controller = new AbortController();
    pendingQuery.current = controller;
    try {
      const result = await api.request<Answer>("/api/query", {
        method: "POST",
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
        body: JSON.stringify({
          question: text,
          ...range,
          ...(selectedDevice ? { deviceId: selectedDevice } : {}),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (queryGeneration.current === generation) setAnswer(result);
    } catch (e) {
      if (queryGeneration.current === generation) setError(errorMessage(e));
    } finally {
      if (queryGeneration.current === generation) {
        pendingQuery.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">LESS SEARCHING, MORE UNDERSTANDING</div>
        <h1>你只管问。</h1>
        <p>让 Mote 沿着你的上下文，找回答案和它的来处。</p>
      </div>
      <div className="tabs">
        <button
          className={tab === "ask" ? "active" : ""}
          onClick={() => setTab("ask")}
        >
          <MessageSquare size={15} />
          问一问
        </button>
        <button
          className={tab === "insights" ? "active" : ""}
          onClick={() => setTab("insights")}
        >
          <Sparkles size={15} />
          个人回顾 <span>{insights.length}</span>
        </button>
      </div>
      {!status.agent.configured && (
        <div className="notice model-notice">
          <Sparkles size={19} />
          <div>
            <strong>再连接一个模型，让资料变成答案。</strong>
            <p>
              在中央节点的 <code>.env</code> 设置 <code>MOTE_MODEL</code>、
              <code>MOTE_MODEL_BASE_URL</code> 与{" "}
              <code>MOTE_MODEL_API_KEY</code>
              ，然后重启服务。当前采集和归档可以继续使用。
            </p>
          </div>
        </div>
      )}
      {tab === "ask" ? (
        <>
          <div className="filter-bar">
            <label>
              <Monitor size={15} />
              <span>筛选设备</span>
              <select
                aria-label="问答设备"
                value={selectedDevice}
                disabled={busy}
                onChange={(event) => setSelectedDevice(event.target.value)}
              >
                <option value="">全部设备</option>
                {devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.deviceName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <form className="ask-form" onSubmit={(e) => void submit(e)}>
            <textarea
              aria-label="向 Mote 提问"
              placeholder="比如，我最近都在忙什么？"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                  void submit(e);
              }}
              maxLength={8000}
              rows={3}
            />
            <div>
              <span>
                <ShieldCheck size={14} />
                只读查询 · 回答附带原始证据
              </span>
              <button
                className="send-button"
                type="submit"
                disabled={busy || !question.trim() || !status.agent.configured}
                aria-label="发送问题"
              >
                {busy ? (
                  <LoaderCircle className="spin" size={19} />
                ) : (
                  <ArrowUp size={19} />
                )}
              </button>
            </div>
          </form>
          {!answer && !busy && !asked && (
            <div className="suggestions">
              <span>从一个小问题开始</span>
              {[
                "我最近都做了些什么？",
                "这周的时间主要花在了哪里？",
                "最近有哪些值得接着做的事情？",
              ].map((sample) => (
                <button
                  key={sample}
                  onClick={() => void submit(undefined, sample)}
                  disabled={!status.agent.configured}
                >
                  {sample}
                  <ArrowRight size={14} />
                </button>
              ))}
            </div>
          )}
          {busy && (
            <div className="thinking-panel">
              <span className="mote-symbol">m</span>
              <div>
                <Spinner label="正在查阅你的上下文…" />
                <p>Agent 会选择检索工具、核对记录，再组织回答。</p>
              </div>
            </div>
          )}
          {error && (
            <ErrorNotice
              text={error}
              retry={() => void submit(undefined, asked)}
            />
          )}
          {answer && (
            <div className="answer-panel">
              <div className="asked-question">{asked}</div>
              <AnswerView answer={answer} onOpen={onOpen} />
            </div>
          )}
        </>
      ) : (
        <>
          {insights.length ? (
            <div className="insight-history">
              {insights.map((item) => (
                <article className="panel" key={item.runId}>
                  <button
                    className="insight-history-heading"
                    onClick={() =>
                      setSelectedInsight(
                        selectedInsight === item.runId ? null : item.runId,
                      )
                    }
                  >
                    <div>
                      <Sparkles size={17} />
                      <strong>
                        {item.createdAt ? dateTime(item.createdAt) : "个人回顾"}
                      </strong>
                      <span>{item.citations.length} 条证据</span>
                    </div>
                    <ChevronDown
                      size={18}
                      className={
                        selectedInsight === item.runId ? "rotated" : ""
                      }
                    />
                  </button>
                  {selectedInsight === item.runId ? (
                    <AnswerView answer={item} onOpen={onOpen} />
                  ) : (
                    <p className="history-preview">
                      {item.answer.slice(0, 200)}
                      {item.answer.length > 200 && "…"}
                    </p>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="panel">
              <Empty icon={Sparkles} title="第一份回顾，等你开始">
                <p>累积一些记录后，生成一份有证据的个人回顾。</p>
                <button
                  className="button primary"
                  onClick={onInsight}
                  disabled={
                    !status.agent.configured || !status.storage.captures
                  }
                >
                  生成个人回顾
                </button>
              </Empty>
            </div>
          )}
        </>
      )}
    </>
  );
}

function Devices({
  devices,
  connection,
  api,
}: {
  devices: Device[];
  connection: Connection;
  api: Api;
}) {
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">MANY SOURCES, ONE PLACE</div>
        <h1>让你的设备，彼此相连。</h1>
        <p>采集发生在端点，线索汇聚到你自己的中央节点。</p>
      </div>
      <Connections api={api} serverUrl={connection.url || window.location.origin} devices={devices}/>
      <div className="device-grid">
        {devices.map((device) => (
          <article className="panel device-card" key={device.deviceId}>
            <div className="device-top">
              <div className="device-icon">
                <DeviceIcon platform={device.platform} size={25} />
              </div>
              <StateBadge device={device} />
            </div>
            <h2>{device.deviceName}</h2>
            <p className="device-platform">
              {(
                {
                  macos: "macOS",
                  windows: "Windows",
                  linux: "Linux",
                  android: "Android",
                  import: "导入数据源",
                } as Record<string, string>
              )[device.platform] || device.platform}
            </p>
            <dl>
              <div>
                <dt>最近心跳</dt>
                <dd>{ago(device.lastSeenAt)}</dd>
              </div>
              <div>
                <dt>最近采集</dt>
                <dd>{ago(device.lastCaptureAt)}</dd>
              </div>
              <div>
                <dt>等待上传</dt>
                <dd>{device.queueDepth.toLocaleString()} 条</dd>
              </div>
            </dl>
            {deviceState(device) === "offline" && (
              <div className="device-note">
                <WifiOff size={14} />
                超过 90 秒未收到心跳。检查网络或重新打开采集端。
              </div>
            )}
            {device.error && (
              <div className="device-note warn">
                <Info size={14} />
                最后上报：{device.error}
              </div>
            )}
            <code className="record-id">{device.deviceId}</code>
          </article>
        ))}
      </div>
      <section className="panel connection-guide">
        <div className="section-heading">
          <div>
            <span className="eyebrow">GET CONNECTED</span>
            <h2>采集端连接指引</h2>
          </div>
          <ShieldCheck size={19} className="muted-icon" />
        </div>
        <div className="guide-grid">
          <div>
            <Monitor size={23} />
            <h3>电脑端</h3>
            <p>
              启动 Mote
              桌面程序，导入连接邀请 JSON 或二维码图片，核对地址后连接。先设置应用过滤、遮挡区域与本地隐私处理，再授予系统屏幕录制权限并开启采集。
            </p>
            <span>启动命令</span>
            <code>npm run desktop</code>
          </div>
          <div>
            <Smartphone size={23} />
            <h3>Android · Xiaomi / HyperOS</h3>
            <p>
              安装 APK
              后连接节点，在系统中启用采集权限，开启通知、自启动与电池无限制，并在最近任务中锁定应用。每次重启后检查采集状态。
            </p>
            <span>保持透明</span>
            <p className="fine-print">
              系统强行结束应用后无法保证自动恢复。控制台会保留最后心跳及等待上传数，不把漏采视作空闲。
            </p>
          </div>
          <div>
            <HardDrive size={23} />
            <h3>本地文件与 NAS</h3>
            <p>
              使用文件导入工具，把明确选择的文本目录接入同一资料库。NAS
              挂载目录可以作为来源；不会自动扫描其他目录。
            </p>
            <span>查看导入用法</span>
            <code>npm run import:files -- --help</code>
          </div>
        </div>
      </section>
    </>
  );
}

function Vault({
  api,
  status,
  connection,
  refresh,
  disconnect,
}: {
  api: Api;
  status: Status;
  connection: Connection;
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
        <h1>一个可以带走的资料库。</h1>
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
              <dt>影像加密</dt>
              <dd>
                {storage.imagesEncrypted
                  ? "AES-256-GCM 已启用"
                  : "未启用应用层加密"}
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
            数据库元数据的静态保护依赖主机加密磁盘。影像加密和保留策略在中央节点配置。
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
      <Diagnostics api={api} profile={status.profile} />
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
                ? `每 ${status.insightIntervalHours} 小时`
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
            <strong>当前中央节点</strong>
            <p>{connection.url || window.location.origin}</p>
            <small>访问令牌只保留在当前标签页会话中</small>
          </div>
        </div>
        <button className="button subtle" onClick={disconnect}>
          <Unplug size={15} />
          断开连接
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
  const [recent, setRecent] = useState<Capture[]>([]);
  const [insights, setInsights] = useState<Answer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [evidenceId, setEvidenceId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [notice, setNotice] = useState("");
  const [timelineRevision, setTimelineRevision] = useState(0);
  const disconnect = useCallback(() => {
    connectionGeneration.current++;
    sessionStorage.removeItem("mote.connection");
    setConnection(null);
    setStatus(null);
    setDevices([]);
    setRecent([]);
    setInsights([]);
    setEvidenceId(null);
  }, []);
  const unauthorized = useCallback(() => {
    disconnect();
    setNotice("访问令牌已失效，请重新连接中央节点。");
  }, [disconnect]);
  const api = useMemo(
    () => {
      const generation = connectionGeneration.current;
      return connection ? createApi(connection, unauthorized, () => generation === connectionGeneration.current) : null;
    },
    [connection, unauthorized],
  );
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
    if (!api) return;
    let active = true;
    const controller = new AbortController();
    const requestOptions = {signal: controller.signal};
    setLoading(true);
    setError("");
    void Promise.all([
      api.request<Status>("/api/status", requestOptions),
      api.request<{ items: Device[] }>("/api/devices", requestOptions),
      api.request<Activity>(`/api/activity${queryString(range)}`, requestOptions),
      api.request<{ items: Capture[] }>(
        `/api/captures${queryString(range, { limit: 4 })}`,
        requestOptions,
      ),
      api.request<{ items: Answer[] }>("/api/insights", requestOptions),
    ])
      .then(
        ([nextStatus, nextDevices, nextActivity, nextRecent, nextInsights]) => {
          if (!active) return;
          setStatus(nextStatus);
          setDevices(nextDevices.items);
          setActivity(nextActivity);
          setRecent(nextRecent.items);
          setInsights(nextInsights.items);
        },
      )
      .catch((e) => active && setError(errorMessage(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, range, revision]);
  useEffect(() => {
    if (!api) return;
    const timer = setInterval(() => setRevision((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, [api, refresh]);
  function onPage(next: Page) {
    setPage(next);
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  }
  function connected(value: Connection) {
    connectionGeneration.current++;
    sessionStorage.setItem("mote.connection", JSON.stringify(value));
    setConnection(value);
    setStatus(null);
    setDevices([]); setRecent([]); setInsights([]); setEvidenceId(null);
    setActivity({apps:[],devices:[],totalDurationMs:0,captures:0});
    setGenerating(false);
    setShowConnect(false);
    setNotice("");
  }
  async function generate() {
    if (!api || generating) return;
    const generation = connectionGeneration.current;
    setGenerating(true);
    setNotice("");
    try {
      await api.request<Answer>("/api/insights", {
        method: "POST",
        body: JSON.stringify({ ...range, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      if (generation !== connectionGeneration.current) return;
      setNotice("新的个人回顾已生成，打开「问一问 → 个人回顾」查看证据。");
      refresh();
    } catch (e) {
      if (generation === connectionGeneration.current) setNotice(errorMessage(e));
    } finally {
      if (generation === connectionGeneration.current) setGenerating(false);
    }
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
        <div className="workspace-label">PERSONAL CONTEXT</div>
        <nav>
          {nav.map((item) => (
            <button
              key={item.id}
              className={page === item.id ? "active" : ""}
              onClick={() => onPage(item.id)}
            >
              <item.icon size={18} strokeWidth={1.7} />
              {item.label}
              {item.id === "ask" && <span className="nav-spark">✦</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="orbit-mark">✳</span>
            <p>
              一点一滴，
              <br />
              慢慢成为你的记忆。
            </p>
          </div>
          <button className="node-button" onClick={() => setShowConnect(true)}>
            <span
              className={`node-state ${connection && status ? "online" : ""}`}
            />
            <div>
              <strong>
                {connection && status ? "中央节点已连接" : "连接中央节点"}
              </strong>
              <small>
                {connection && status ? "你的个人上下文库" : "让线索开始汇聚"}
              </small>
            </div>
            <Settings2 size={15} />
          </button>
          <div className="version">
            MOTE <span>0.3</span>
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
              <strong>{nav.find((item) => item.id === page)?.label}</strong>
            </span>
          </div>
          <div className="topbar-actions">
            {connection && (
              <>
                <span className="private-label">
                  <ShieldCheck size={14} />
                  私有节点
                </span>
                {["overview", "ask"].includes(page) && (
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
              aria-label="连接设置"
              onClick={() => setShowConnect(true)}
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
                    把散落的片刻，
                    <br />
                    留给未来的自己。
                  </h1>
                  <p>
                    手机、电脑、文件。
                    <br />
                    一个私有资料库，一句就能问起的上下文。
                  </p>
                  <button
                    className="button primary"
                    onClick={() => setShowConnect(true)}
                  >
                    <Link2 size={16} />
                    连接我的中央节点
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
              {page === "notes" && api && <Notes key={connection.url || window.location.origin} api={api} namespace={connection.url || window.location.origin} revision={timelineRevision} onOpen={setEvidenceId} onSaved={refresh} />}
              {!status && page !== "notes"
                ? !error && (
                    <div className="initial-loading">
                      <Spinner label="正在连接你的上下文库…" />
                    </div>
                  )
                : api && status && (
                    <>
                      {page === "overview" && (
                        <Overview
                          api={api}
                          status={status}
                          devices={devices}
                          activity={activity}
                          recent={recent}
                          insights={insights}
                          onPage={onPage}
                          onOpen={setEvidenceId}
                          generate={() => void generate()}
                          generating={generating}
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
                      {page === "ask" && (
                        <Ask
                          api={api}
                          devices={devices}
                          status={status}
                          range={range}
                          scopeKey={period}
                          insights={insights}
                          onOpen={setEvidenceId}
                          onInsight={() => void generate()}
                        />
                      )}
                      {page === "devices" && (
                        <Devices key={connection.url} devices={devices} connection={connection} api={api} />
                      )}
                      {page === "vault" && (
                        <Vault
                          api={api}
                          status={status}
                          connection={connection}
                          refresh={refresh}
                          disconnect={disconnect}
                        />
                      )}
                      {page === "sources" && <Sources api={api} onOpen={setEvidenceId} />}
                      {page === "memories" && <Memories api={api} range={range} onOpen={setEvidenceId} />}
                      {page === "settings" && <ServerSettings key={connection.url || window.location.origin} api={api} />}
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
        <ConnectionDialog
          initial={connection}
          onConnected={connected}
          onClose={() => setShowConnect(false)}
        />
      )}
      {evidenceId && api && (
        <EvidenceDialog
          id={evidenceId}
          api={api}
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
