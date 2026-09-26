import { getLocale,moteText } from '@mote/shared/i18n';
import {
ArrowDownToLine,
ArrowUpFromLine,
CheckCircle2,
Database,
Info,
Layers3,
LoaderCircle,
RefreshCw,
Unplug
} from "lucide-react";
import {
useRef,
useState
} from "react";
import {
bytes,
dateTime,
errorMessage,
type Api,
type Status
} from "./api";



import { ErrorNotice } from './shell-components';
export function Vault({
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
  async function exportArchive(mode?: 'metadata'|'data') {
    const response = await api.raw(mode?`/api/export-bundle?mode=${mode}`:"/api/export");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = mode?`mote-${mode}.tar.gz`:`mote-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return moteText("资料已导出，包含记录、影像与校验信息。");
  }
  async function importFile(file?: File) {
    if (!file) return;
    await action("import", async () => {
      const raw = await file.text();
      const archive = JSON.parse(raw);
      if (archive.version !== 1 || !Array.isArray(archive.captures))
        throw new Error(moteText("请选择 Mote v1 JSON 归档文件。"));
      const result = await api.request<{
        imported: number;
        duplicates: number;
      }>("/api/import", { method: "POST", body: raw });
      return moteText("已导入 {0} 条记录，跳过 {1} 条重复记录。", result.imported, result.duplicates);
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
        <h1>{moteText("数据与备份")}</h1>
        <p>{moteText("知道留下了什么、存在哪里，也随时保留迁移的自由。")}</p>
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
              <h2>{moteText("存储概况")}</h2>
              <p>{moteText("中央节点 · 文件对象与 SQLite 索引")}</p>
            </div>
            <Database size={21} className="muted-icon" />
          </div>
          <div className="storage-number">
            {bytes(storage.bytes)}
            <span>
              {storage.maxBytes ? `/ ${bytes(storage.maxBytes)}` : moteText("已使用")}
            </span>
          </div>
          <div className="storage-track">
            <span style={{ width: `${Math.max(1, ratio)}%` }} />
          </div>
          <div className="storage-stats">
            <div>
              <strong>{storage.captures.toLocaleString(getLocale())}</strong>
              <span>{moteText("上下文记录")}</span>
            </div>
            <div>
              <strong>{storage.blobs.toLocaleString(getLocale())}</strong>
              <span>{moteText("独立影像对象")}</span>
            </div>
            <div>
              <strong>{bytes(storage.imageBytes)}</strong>
              <span>{moteText("影像原始大小")}</span>
            </div>
          </div>
          <div className="storage-note">
            <Layers3 size={16} />
            <p>
              {moteText("相同影像共享一份存储，每次采样仍保留独立观察记录。")}{storage.imageCaptures !== undefined &&
                moteText("已复用 {0} 次影像。", Math.max(0, storage.imageCaptures - storage.blobs))}
            </p>
          </div>
          <dl>
            <div>
              <dt>{moteText("新图片存储")}</dt>
              <dd>
                {storage.imagesEncrypted
                  ? moteText("加密已启用（仅后续写入）")
                  : moteText("明文保存（默认）")}
              </dd>
            </div>
            <div>
              <dt>{moteText("保留周期")}</dt>
              <dd>
                {status.retentionDays
                  ? moteText("{0} 天", status.retentionDays)
                  : moteText("持续保留 · 未启用自动删除")}
              </dd>
            </div>
            <div>
              <dt>{moteText("最早记录")}</dt>
              <dd>
                {storage.firstCaptureAt
                  ? dateTime(storage.firstCaptureAt)
                  : moteText("尚无记录")}
              </dd>
            </div>
          </dl>
          <p className="fine-print">
            {moteText("内容加密默认关闭，可在开发者选项中启用或一次性解密已有文件。数据库正文和索引保存在 SQLite 中。")}</p>
        </section>
        <section className="panel transfer-panel">
          <div className="section-heading">
            <div>
              <h2>{moteText("导入与导出")}</h2>
              <p>{moteText("可移植归档，保留完整上下文。")}</p>
            </div>
            <ArrowDownToLine size={21} className="muted-icon" />
          </div>
          <div className="transfer-action">
            <div className="transfer-icon">
              <ArrowDownToLine size={19} />
            </div>
            <div>
              <h3>{moteText("导出资料")}</h3>
              <p>{moteText("记录、原始影像和校验信息。访问令牌不会包含在内。")}</p>
            </div>
            <button
              className="button subtle"
              disabled={!!busy}
              onClick={() => void action("export", ()=>exportArchive())}
            >
              {busy === "export" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                moteText("导出")
              )}
            </button><button className="button subtle" disabled={Boolean(busy)} onClick={()=>void action('export',()=>exportArchive('metadata'))}>{moteText("导出元数据")}</button><button className="button subtle" disabled={Boolean(busy)} onClick={()=>void action('export',()=>exportArchive('data'))}>{moteText("导出资料与附件")}</button>
          </div>
          <div className="transfer-action">
            <div className="transfer-icon">
              <ArrowUpFromLine size={19} />
            </div>
            <div>
              <h3>{moteText("导入归档")}</h3>
              <p>{moteText("合并 Mote v1 JSON 归档，验证校验值并跳过重复记录。")}</p>
            </div>
            <button
              className="button subtle"
              disabled={!!busy}
              onClick={() => input.current?.click()}
            >
              {busy === "import" ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                moteText("选择文件")
              )}
            </button>
            <input
              ref={input}
              className="hidden"
              type="file"
              accept="application/json,.json"
              aria-label={moteText("导入 Mote 归档")}
              onChange={(e) => void importFile(e.target.files?.[0])}
            />
          </div>
          <div className="backup-note">
            <Info size={16} />
            <div>
              <strong>{moteText("大资料库适合使用离线备份")}</strong>
              <p>
                {moteText("网页导出受中央节点归档大小限制。需要完整备份或迁移加密数据时，在中央节点运行：")}</p>
              <code>npm run backup -- --help</code>
            </div>
          </div>
        </section>
      </div>

      <section className="panel index-panel">
        <div className="section-heading">
          <div>
            <h2>{moteText("索引与 Agent")}</h2>
            <p>{moteText("确定性的存储，模型负责理解。")}</p>
          </div>
          <span
            className={`badge ${status.agent.configured ? "green" : "muted"}`}
          >
            <span className="dot" />
            {status.agent.configured ? moteText("Agent 已连接") : moteText("模型待配置")}
          </span>
        </div>
        <div className="index-grid">
          <div>
            <span>{moteText("检索方式")}</span>
            <strong>
              {status.index.mode === "hybrid" ? moteText("全文 + 向量检索") : moteText("文本检索")}
            </strong>
            <small>{status.index.model || moteText("可选择配置 Embedding 模型")}</small>
          </div>
          <div>
            <span>{moteText("推理模型")}</span>
            <strong>{status.agent.model || moteText("尚未配置")}</strong>
            <small>{status.agent.provider}</small>
          </div>
          <div>
            <span>{moteText("自动回顾")}</span>
            <strong>
              {status.insightIntervalHours
                ? moteText("每 {0} 小时且有足够新增资料", status.insightIntervalHours)
                : moteText("手动生成")}
            </strong>
            <small>{moteText("使用同一只读 Agent 与来源引用")}</small>
          </div>
        </div>
        <div className="index-statuses">
          {storage.indexing.map((row) => (
            <span key={row.status}>
              <span className={`dot ${row.status === "failed" ? "red" : ""}`} />
              {(
                {
                  pending: moteText("等待索引"),
                  indexed: moteText("已建立向量索引"),
                  text_ready: moteText("文本就绪"),
                  failed: moteText("索引失败"),
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
                return moteText("已将 {0} 条记录加入索引队列。", result.queued);
              })
            }
          >
            <RefreshCw size={14} className={busy === "retry" ? "spin" : ""} />
            {moteText("重试索引")}</button>
        </div>
      </section>
      <section className="panel node-settings">
        <div>
          <div className="node-avatar">
            <Database size={21} />
          </div>
          <div>
            <strong>{moteText("当前服务（中央节点）")}</strong>
            <p>{window.location.origin}</p>
            <small>{moteText("访问令牌只保留在当前标签页会话中")}</small>
          </div>
        </div>
        <button className="button subtle" onClick={disconnect}>
          <Unplug size={15} />
          {moteText("退出登录")}</button>
      </section>
    </>
  );
}
