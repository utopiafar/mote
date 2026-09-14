import { useEffect, useState } from "react";
import { Database, FolderOpen, RefreshCw, Settings2 } from "lucide-react";
import type { ServerConfiguration } from "@mote/shared";
import { type Api, bytes, errorMessage } from "./api";
import { SoftwareUpdate } from './SoftwareUpdate';

const sources = { environment: "启动环境", "env-file": "配置文件", default: "默认值", derived: "根据部署计算" };
const runtimes = { native: "原生 Node.js", docker: "Docker", unknown: "未声明" };
const units: Record<string, string> = { days: "天", hours: "小时", tokens: "tokens", files: "个文件", entries: "条" };

export function ServerSettings({ api }: { api: Api }) {
  const [config, setConfig] = useState<ServerConfiguration>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setBusy(true); setError("");
    void api.request<ServerConfiguration>("/api/configuration", { signal: controller.signal })
      .then(value => { if (active) setConfig(value); })
      .catch(e => { if (active) setError(errorMessage(e)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; controller.abort(); };
  }, [api, revision]);
  return <div className="server-settings">
    <div className="page-heading settings-heading">
      <div><div className="eyebrow">YOUR CENTRAL NODE</div><h1>服务端配置</h1><p>查看当前节点实际使用的设置，以及资料保存的位置。</p></div>
      <button className="button subtle" disabled={busy} onClick={() => setRevision(n => n + 1)}><RefreshCw size={15} className={busy ? "spin" : ""} />刷新配置</button>
    </div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {busy && !config && <p role="status">正在读取服务端配置…</p>}
    {config && <>
      <SoftwareUpdate api={api}/>
      <section className="panel settings-summary" aria-labelledby="settings-location-title">
        <div className="section-heading"><div><h2 id="settings-location-title"><Database size={18} />资料在哪里</h2><p>{config.profile} · {runtimes[config.runtime]}</p></div><span className="badge muted">当前生效配置</span></div>
        <p className="settings-description">{config.storage.description}</p>
        <dl className="settings-locations">
          {[
            ["数据目录", config.storage.dataDir], ["SQLite 数据库", config.storage.sqlitePath],
            ["图片目录", config.storage.blobsDir], ["运行日志", config.storage.logDir],
            ["存储来源 / 挂载来源", config.storage.source], ["容器挂载位置", config.storage.mountPath],
          ].filter(([, value]) => value).map(([label, value]) => <div key={label}><dt>{label}</dt><dd><code>{value}</code></dd></div>)}
        </dl>
      </section>
      <section className="panel settings-edit-guide" aria-labelledby="settings-edit-title">
        <h2 id="settings-edit-title"><FolderOpen size={18} />修改配置</h2>
        <p>{config.description}</p>
        <dl className="settings-locations"><div><dt>配置文件</dt><dd><code>{config.envFile || "未使用配置文件，通过服务进程的环境变量设置"}</code></dd></div><div><dt>相对路径基准</dt><dd><code>{config.baseDir}</code></dd></div></dl>
        <ol><li>在部署机器上编辑此环境的配置，下面每项都标出了变量名。</li><li>保存后重启此环境，再刷新本页确认生效。运行中的服务不会自动读取文件变更。</li><li>更换数据目录或磁盘前，先停止服务并备份，再恢复到新的空目录。修改路径本身不会搬运原有资料。</li></ol>
        <p className="fine-print">本页仅供节点所有者查看。密钥只显示配置状态；可分享的诊断包从「资料库 → 运行诊断」导出。</p>
      </section>
      <nav className="settings-sections" aria-label="配置分类">{config.groups.map(group => <a href={`#settings-${group.id}`} key={group.id}>{group.title}</a>)}</nav>
      {config.groups.map(group => <section className="panel settings-group" id={`settings-${group.id}`} key={group.id} aria-labelledby={`settings-title-${group.id}`}>
        <div className="section-heading"><div><h2 id={`settings-title-${group.id}`}><Settings2 size={17} />{group.title}</h2><p>{group.description}</p></div></div>
        <dl className="settings-fields">{group.fields.map(field => <div className="settings-field" key={field.key} data-config-key={field.key}>
          <dt><strong>{field.label}</strong>{field.envVar && <code>{field.envVar}</code>}<p>{field.description}</p></dt>
          <dd><div className="settings-value">{field.visibility === "secret-status"
            ? <span className={`badge ${field.value ? "green" : "muted"}`}>{field.value ? "已配置" : "未配置"}</span>
            : <code>{field.value === null || field.value === "" || (Array.isArray(field.value) && !field.value.length) ? "未设置" : field.unit === "bytes" && typeof field.value === "number" ? `${bytes(field.value)}（${field.value / 1024 ** 2} MiB）` : Array.isArray(field.value) ? field.value.join("\n") : typeof field.value === "boolean" ? field.value ? "已开启" : "已关闭" : String(field.value)}</code>}{field.unit && field.unit !== "bytes" && <span className="settings-unit">{units[field.unit] || field.unit}</span>}</div><small>{sources[field.source]}{field.restartRequired ? " · 重启后生效" : ""}</small></dd>
        </div>)}</dl>
      </section>)}
    </>}
  </div>;
}
