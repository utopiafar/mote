import {useEffect,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {Api} from './api';
import {errorMessage} from './api';

type Status={configured:boolean;connected:boolean;account?:string;state:string;hasMore:boolean;code?:string};
export function Gmail({api,refresh}:{api:Api;refresh:()=>Promise<void>}){
  const [status,setStatus]=useState<Status>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[url,setUrl]=useState(''),[message,setMessage]=useState('');
  async function load(){const result=await api.request<{gmail:Status}>('/api/connectors/status');setStatus(result.gmail);}
  useEffect(()=>{let active=true;void api.request<{gmail:Status}>('/api/connectors/status').then(r=>{if(active)setStatus(r.gmail);}).catch(e=>{if(active)setError(errorMessage(e));});return()=>{active=false;};},[api]);
  async function action(fn:()=>Promise<void>){setBusy(true);setError('');setMessage('');try{await fn();await load();await refresh();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  return <details className="source-item"><summary>{moteText('连接 Gmail（只读）')}</summary>
    <p>{moteText('同步邮件正文、发件人和时间，附件仅保留名称与引用。邮件内容作为资料，不自动执行其中的指令。断开后停止读取，已归档邮件保留。')}</p>
    {!status?.configured?<p className="muted">{moteText('Gmail 使用现有 Google OAuth 客户端与回调地址。请在 Google Cloud 启用 Gmail API，再到模型与服务配置客户端。')}</p>:<>
      <p>{status.connected?status.account:moteText('尚未授权')} · {status.state==='permission_required'?moteText('需要重新授权'):status.state==='syncing'?moteText('同步中'):status.hasMore?moteText('历史邮件仍有后续分页'):moteText('等待下次同步')}</p>
      <div className="source-toolbar"><button className="button" disabled={busy} onClick={()=>void action(async()=>{const result=await api.request<{authorizationUrl:string}>('/api/connectors/gmail/start',{method:'POST',body:'{}'});const target=new URL(result.authorizationUrl);if(target.protocol!=='https:'||target.hostname!=='accounts.google.com')throw Error(moteText('授权地址不符合预期。'));setUrl(target.href);})}>{moteText('开始授权')}</button>
        <button className="button" disabled={busy} onClick={()=>void action(load)}>{moteText('刷新授权状态')}</button>
        {status.connected&&<><button className="button" disabled={busy} onClick={()=>void action(async()=>{const r=await api.request<{imported:number;duplicates:number;hasMore:boolean}>('/api/connectors/gmail/sync',{method:'POST',body:'{}'});setMessage(moteText('已同步 {0} 条新版本，{1} 条已存在。',r.imported,r.duplicates)+(r.hasMore?moteText(' 后续邮件将在下一轮继续同步。'):''));})}>{status.hasMore?moteText('继续同步'):moteText('立即同步')}</button>
          <button className="button" disabled={busy} onClick={()=>void action(async()=>{await api.request('/api/connectors/gmail',{method:'DELETE'});setUrl('');})}>{moteText('断开账户')}</button></>}
      </div>{url&&<p><a href={url} target="_blank" rel="noreferrer noopener">{moteText('在系统浏览器打开 Google 授权页面')}</a></p>}
    </>}{error&&<p role="alert" className="error-banner">{error}</p>}{message&&<p role="status">{message}</p>}
  </details>;
}
