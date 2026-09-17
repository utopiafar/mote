import { moteText, getLocale } from '@mote/shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { type Api, errorMessage } from './api';
declare const __MOTE_WEB_VERSION__: string;
type Status = { currentVersion: string; latestVersion: string | null; repository: string; channel: string; state: string; error?: string; checkedAt: string | null; available: boolean; verified: boolean; releaseUrl: string | null; commands: {check: string;update: string;rollback: string} | null };
export function SoftwareUpdate({api}: {api: Api}) {
  const [status,setStatus] = useState<Status>(), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const generation=useRef(0), request=useRef<AbortController|null>(null);
  useEffect(()=>{const controller=new AbortController(), id=++generation.current; request.current?.abort();setBusy(false);setStatus(undefined);setError('');void api.request<Status>('/api/software-update',{signal:controller.signal}).then(value=>{if(id===generation.current&&!controller.signal.aborted)setStatus(value);}).catch(e=>{if(!controller.signal.aborted&&id===generation.current)setError(errorMessage(e));});return()=>{controller.abort();request.current?.abort();generation.current++;};},[api]);
  async function check(){const id=generation.current, controller=new AbortController();request.current=controller;setBusy(true);setError('');try{const value=await api.request<Status>('/api/software-update/check',{method:'POST',signal:controller.signal});if(id===generation.current)setStatus(value);}catch(e){if(id===generation.current&&!controller.signal.aborted)setError(errorMessage(e));}finally{if(id===generation.current)setBusy(false);}}
  return <section className="panel software-update" aria-labelledby="software-update-title">
    <div className="section-heading"><div><h2 id="software-update-title">{moteText("软件版本与更新")}</h2><p>{moteText("更新替换程序，保留原环境设置、模型、队列和资料库。")}</p></div><button className="button subtle" disabled={busy} onClick={()=>void check()}><RefreshCw size={15} className={busy?'spin':''}/>{busy?moteText("正在检查…"):moteText("检查新版本")}</button></div>
    {error&&<p className="notice error" role="alert">{error}</p>}
    {status&&<><p>{moteText("网页版本")} <strong>{__MOTE_WEB_VERSION__}</strong></p>{status.currentVersion!==__MOTE_WEB_VERSION__&&<p className="notice error" role="alert">{moteText("网页与服务版本不一致，请重新构建网页并刷新页面。")}</p>}<p>{moteText("当前版本")}{' '}<strong>{status.currentVersion}</strong> · {status.repository} · {status.channel==='stable'?moteText("正式渠道"):moteText("预览渠道")}</p>
      {status.state==='idle'&&<p>{moteText("点击检查后连接 GitHub，不上传个人资料或中央令牌。")}</p>}
      {status.state==='error'&&<p role="alert">{status.error==='release_not_found'?moteText("此渠道暂时没有可用的签名发布版本。"):moteText("更新检查未通过，现有程序和设置保持原样；稍后可重试。")}</p>}
      {status.verified&&<p>{status.available?moteText("发现 {0}，发布签名已验证。", status.latestVersion):moteText("已是最新版本，发布签名已验证。")} {status.releaseUrl&&<a href={status.releaseUrl} target="_blank" rel="noreferrer">{moteText("查看版本说明与安装包")}</a>}</p>}
      {status.checkedAt&&<p className="fine-print">{moteText("上次检查：")}{new Date(status.checkedAt).toLocaleString(getLocale())}</p>}
      {status.commands&&status.available&&<><p>{moteText("在部署机的 Mote 目录执行。命令先校验下载并准备程序，再备份、切换和检查健康状态。新版启动失败时保留快照，使用回退命令恢复。")}</p><pre><code>{status.commands.update}</code></pre><details><summary>{moteText("需要回退时")}</summary><p>{moteText("回退恢复升级前的数据快照；升级后的资料会另行保留。不要直接用旧程序打开已升级的数据。")}</p><pre><code>{status.commands.rollback}</code></pre></details></>}
      {!status.commands&&status.verified&&<p>{moteText("此节点未由命名部署环境管理。请先按部署文档建立对应环境，再使用更新命令；本页面不会直接重启当前服务。")}</p>}
    </>}
  </section>;
}
