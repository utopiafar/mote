import React,{useEffect,useRef,useState} from 'react';
import {ArrowLeft,CheckCircle2,ExternalLink,Link2,RefreshCw} from 'lucide-react';
import type {LarkStatus,LarkSelection,LarkCalendar,LarkJob} from '@mote/shared';
import {type Api,errorMessage} from './api';
import {moteText} from '@mote/shared/i18n';

const errors:Record<string,string>={
 lark_cli_missing:'服务端尚未安装 Lark CLI。请点击安装，然后重新检测。',
 lark_not_configured:'尚未配置飞书应用。请创建应用或填写已有应用凭据。',
 lark_not_connected:'尚未连接飞书账号，请完成只读授权。',
 lark_permission_required:'读取权限未完整授予。请在飞书应用后台开通下方只读权限，然后重新授权。',
 lark_authorization_expired:'授权链接已过期，请重新发起登录。',
 lark_account_changed:'检测到账号变化，已暂停旧来源。请重新授权并选择同步范围。',
 lark_busy:'另一个操作正在进行，请稍后重试。',
 lark_operation_timeout:'操作超时。请检查服务端网络，或重新发起授权。',
 lark_command_failed:'飞书 CLI 操作未完成。请检查网络、应用权限及服务账号的系统钥匙串访问，再重试。',
 lark_operation_cancelled:'操作已取消，可以重新开始。',
 lark_calendar_not_available:'选中的日历不再可读，请重新加载日历列表。',
 lark_document_invalid:'请填写飞书或 Lark 的 docx、wiki 文档链接或文档 token。',
 lark_response_invalid:'飞书返回格式不符合预期，本次未标记同步成功。请检查 CLI 版本和文档访问权限。',
};
const requestError=(error:unknown)=>error instanceof Error&&(error.message.startsWith('lark_')||error.message==='connector_input_invalid')?larkError(error.message):errorMessage(error);
export const larkError=(code:string)=>moteText(errors[code]??'飞书操作失败，请重新检测连接后重试。');
const emptySelection:LarkSelection={documents:[],calendarIds:[],pastDays:30,futureDays:90,timeZone:'Asia/Shanghai',autoSync:false};
const activeJob=(job?:LarkJob)=>Boolean(job&&['running','waiting'].includes(job.state));
export function LarkJobStatus({job}:{job:LarkJob}){
 const [qr,setQr]=useState(''),[qrError,setQrError]=useState(false),[copyState,setCopyState]=useState('');
 useEffect(()=>{let disposed=false;setQr('');setQrError(false);setCopyState('');if(job.authorizationUrl)void import('qrcode').then(({default:QRCode})=>QRCode.toDataURL(job.authorizationUrl!,{width:220,margin:2})).then(v=>{if(!disposed)setQr(v);}).catch(()=>{if(!disposed)setQrError(true);});return()=>{disposed=true;};},[job.authorizationUrl]);
 const name={install:moteText('安装 CLI'),setup:moteText('配置应用'),configure:moteText('保存应用'),login:moteText('账号授权'),selection:moteText('保存范围'),sync:moteText('同步资料')}[job.kind];
 return <div className="lark-job" aria-live="polite">
  <strong>{name} · {job.state==='waiting'?moteText('等待扫码或网页授权'):job.state==='running'?moteText('正在处理…'):job.state==='completed'?moteText('已完成'):job.state==='cancelled'?moteText('已取消'):moteText('未完成')}</strong>
  {job.error&&<p role="alert">{larkError(job.error)}</p>}
  {job.result&&<p>{moteText('新增 {0} 条，已有 {1} 条。',job.result.imported,job.result.duplicates)}</p>}
  {job.authorizationUrl&&<div className="lark-authorization"><p>{moteText('在你的手机或当前浏览器完成授权，页面会自动更新。')}</p><a className="button" href={job.authorizationUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{moteText('打开飞书授权页面')}<ExternalLink size={15}/></a><button className="button subtle" onClick={async()=>{try{await navigator.clipboard.writeText(job.authorizationUrl!);setCopyState(moteText('授权链接已复制。'));}catch{setCopyState(moteText('复制失败，请使用二维码或授权链接。'));}}}>{moteText('复制授权链接')}</button><p className="fine-print">{copyState||moteText('如果无法打开，可复制链接到浏览器，或扫码。')}</p>{qr&&<img src={qr} alt={moteText('飞书授权二维码')} width={220} height={220}/>} {qrError&&<p>{moteText('二维码生成失败，请使用上方授权链接。')}</p>}{job.expiresAt&&<p className="fine-print">{moteText('链接有效至')} {new Date(job.expiresAt).toLocaleTimeString()}</p>}</div>}
 </div>;
}
export function LarkSettings({api,onBack,onSources}:{api:Api;onBack:()=>void;onSources:()=>void}){
 const [status,setStatus]=useState<LarkStatus>(),[selection,setSelection]=useState<LarkSelection>(emptySelection),[documents,setDocuments]=useState(''),[calendars,setCalendars]=useState<LarkCalendar[]>([]),[calendarLoaded,setCalendarLoaded]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[appId,setAppId]=useState(''),[secret,setSecret]=useState(''),[brand,setBrand]=useState<'feishu'|'lark'>('feishu'),[disconnecting,setDisconnecting]=useState(false);
 const alive=useRef(true),dirty=useRef(false),loading=useRef(false),wasConnected=useRef(false);
 const accept=(next:LarkStatus,reset=false)=>{if(wasConnected.current&&!next.connected){dirty.current=false;setCalendars([]);setCalendarLoaded(false);}wasConnected.current=next.connected;setStatus(next);if(reset||!dirty.current){setSelection(next.selection);setDocuments(next.selection.documents.join('\n'));if(reset)dirty.current=false;}};
 useEffect(()=>{
  alive.current=true;const controller=new AbortController();
  void api.request<LarkStatus>('/api/connectors/lark/check',{method:'POST',signal:controller.signal}).then(v=>{if(alive.current)accept(v,true);}).catch(e=>{if(!controller.signal.aborted)setError(requestError(e));});
  const timer=setInterval(()=>{if(loading.current)return;loading.current=true;void api.request<LarkStatus>('/api/connectors/lark',{signal:controller.signal}).then(v=>{if(alive.current)accept(v);}).catch(e=>{if(!controller.signal.aborted)setError(requestError(e));}).finally(()=>{loading.current=false;});},2000);
  return()=>{alive.current=false;controller.abort();clearInterval(timer);};
 },[api]);
 const perform=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');setNotice('');try{await fn();}catch(e){if(alive.current)setError(requestError(e));}finally{if(alive.current)setBusy(false);}};
 const command=(name:string)=>void perform(async()=>{await api.request(`/api/connectors/lark/${name}`,{method:'POST'});accept(await api.request<LarkStatus>('/api/connectors/lark'));});
 const running=busy||activeJob(status?.job);
 const update=(patch:Partial<LarkSelection>)=>{dirty.current=true;setSelection(v=>({...v,...patch}));};
 return <div className="lark-settings">
  <button className="back-link" onClick={onBack}><ArrowLeft size={16}/>{moteText('设置')}</button>
  <div className="page-heading"><div className="eyebrow">{moteText('来源与外部应用')}</div><h1>{moteText('飞书')}</h1><p>{moteText('在中央节点连接文档与日历。选择需要保留的资料，让它们成为可追溯的上下文。')}</p></div>
  <div className="lark-boundary"><Link2 size={20}/><div><strong>{moteText('本期只读')}</strong><p>{moteText('只读取你选中的文档和日历，不修改飞书内容。同步的正文进入 Mote 资料库，可由你配置的模型检索和分析。')}</p></div></div>
  {error&&<div className="notice error" role="alert">{error}<button className="button subtle" disabled={running} onClick={()=>void perform(async()=>accept(await api.request<LarkStatus>('/api/connectors/lark/check',{method:'POST'})))}>{moteText('重试')}</button></div>}{notice&&<p role="status" className="notice">{notice}</p>}
  {!status&&<p role="status">{moteText('正在检测服务端环境…')}</p>}
  {status&&<>
   <section className="panel lark-step"><div className="section-heading"><h2>1 · {moteText('服务端环境')}</h2><span className={`badge ${status.installed?'green':'muted'}`}>{status.installed?`Lark CLI ${status.version??''}`:moteText('未安装')}</span></div><p>{moteText('复用服务端已安装的 CLI；如未安装，可安装到 Mote 专用目录，无需修改全局软件。')}</p><div className="lark-buttons"><button className="button subtle" disabled={running} onClick={()=>command('check')}><RefreshCw size={15}/>{moteText('重新检测')}</button><button className="button subtle" disabled={running} onClick={()=>command('install')}>{status.installed?moteText('安装兼容版本到专用目录'):moteText('安装 Lark CLI')}</button></div></section>
   <section className="panel lark-step"><div className="section-heading"><h2>2 · {moteText('连接飞书账号')}</h2><span className={`badge ${status.connected?'green':'muted'}`}>{status.connected?moteText('已连接'):status.configured?moteText('应用已配置'):moteText('待配置应用')}</span></div>
    {status.accountName&&<p><CheckCircle2 size={15}/> {status.accountName}</p>}
    <p>{moteText('Mote 使用独立的 CLI 配置。首次使用先创建应用，也可以填写已有应用的 App ID 和 App Secret。')}</p>
    <div className="lark-buttons"><button className="button subtle" disabled={running||!status.installed||status.configured} onClick={()=>command('setup')}>{moteText('创建飞书应用')}</button><button className="button" disabled={running||!status.configured} onClick={()=>command('login')}>{status.connected?moteText('重新授权 / 更换账号'):moteText('扫码登录并授权只读权限')}</button></div>
    <details className="lark-manual"><summary>{moteText('使用已有应用')}</summary><p>{moteText('凭据仅发往当前中央节点。建议使用专用飞书应用；同一系统账号下，CLI 钥匙串可能与其他配置共享同一应用的凭据。')}</p><form onSubmit={e=>{e.preventDefault();const value=secret;setSecret('');void perform(async()=>{await api.request('/api/connectors/lark/configure',{method:'POST',body:JSON.stringify({appId,secret:value,brand})});accept(await api.request<LarkStatus>('/api/connectors/lark'));});}}><label>App ID<input value={appId} required pattern="cli_[A-Za-z0-9]+" disabled={running} onChange={e=>setAppId(e.target.value)}/></label><label>App Secret<input type="password" autoComplete="new-password" value={secret} required disabled={running} onChange={e=>setSecret(e.target.value)}/></label><label>{moteText('服务区域')}<select value={brand} disabled={running} onChange={e=>setBrand(e.target.value as 'feishu'|'lark')}><option value="feishu">{moteText('飞书（中国）')}</option><option value="lark">Lark</option></select></label><button className="button subtle" disabled={running||!appId||!secret} type="submit">{moteText('保存应用配置')}</button></form></details>
    <details><summary>{moteText('所需只读权限与授权帮助')}</summary><p>{moteText('文档读取、知识库读取、日历读取。应用管理员需先开通对应权限，再由用户扫码授权。')}</p><code>docx:document:readonly<br/>wiki:wiki:readonly<br/>calendar:calendar:readonly</code><p><a href={brand==='lark'?'https://open.larksuite.com/app':'https://open.feishu.cn/app'} target="_blank" rel="noopener noreferrer">{moteText('打开飞书应用后台')}</a></p></details>
    {status.missingScopes.length>0&&status.configured&&<p className="fine-print">{moteText('尚未授予：')}{status.missingScopes.join('、')}</p>}
    {status.job&&<LarkJobStatus job={status.job}/>}{activeJob(status.job)&&<button className="button subtle" disabled={busy} onClick={()=>command('cancel')}>{moteText('取消当前操作')}</button>}
    {status.error&&!status.job?.error&&<p role="alert">{larkError(status.error)}</p>}
   </section>
   <section className="panel lark-step"><h2>3 · {moteText('选择同步范围')}</h2><fieldset disabled={running||!status.connected}><label>{moteText('文档链接（每行一个，最多 30 个）')}<textarea rows={4} value={documents} onChange={e=>{dirty.current=true;setDocuments(e.target.value);}} placeholder="https://example.feishu.cn/docx/…"/></label><p className="fine-print">{moteText('支持 docx 和 wiki 文档正文；嵌入表格、附件和图片仅保留正文中的引用，不自动下载。')}</p>
    <div className="section-heading"><h3>{moteText('日历')}</h3><button className="button subtle" type="button" onClick={()=>void perform(async()=>{const data=await api.request<{calendars:LarkCalendar[]}>('/api/connectors/lark/calendars');setCalendars(data.calendars);setCalendarLoaded(true);})}>{moteText('加载可选日历')}</button></div>
    {calendarLoaded&&calendars.length===0&&<p>{moteText('当前账号没有可读取详情的日历。')}</p>}
    {([...calendars,...selection.calendarIds.filter(id=>!calendars.some(c=>c.id===id)).map(id=>({id,name:calendarLoaded?moteText('不可用日历：{0}（可取消选择）',id):id,primary:false}))]).map(c=><label className="lark-check" key={c.id}><input type="checkbox" checked={selection.calendarIds.includes(c.id)} onChange={e=>update({calendarIds:e.target.checked?[...selection.calendarIds,c.id]:selection.calendarIds.filter(id=>id!==c.id)})}/>{c.name}{c.primary?` · ${moteText('主日历')}`:''}</label>)}
    <div className="lark-range"><label>{moteText('过去天数')}<input type="number" min={0} max={180} value={selection.pastDays} onChange={e=>update({pastDays:Number(e.target.value)})}/></label><label>{moteText('未来天数')}<input type="number" min={1} max={180} value={selection.futureDays} onChange={e=>update({futureDays:Number(e.target.value)})}/></label><label>{moteText('全天日程时区')}<input value={selection.timeZone} onChange={e=>update({timeZone:e.target.value})}/></label></div>
    <label className="lark-check"><input type="checkbox" checked={selection.autoSync} onChange={e=>update({autoSync:e.target.checked})}/>{moteText('在后台定期同步选中内容')}</label>
    <p className="fine-print">{moteText('后台同步由中央节点执行，关闭页面后继续运行。取消选择会停止后续读取，已有归档保留。')}</p>
    <button className="button" onClick={()=>void perform(async()=>{const next=await api.request<LarkStatus>('/api/connectors/lark/selection',{method:'PUT',body:JSON.stringify({...selection,documents:documents.split('\n').map(v=>v.trim()).filter(Boolean)})});accept(next,true);setNotice(moteText('同步范围已保存。'));})}>{moteText('保存同步范围')}</button>
   </fieldset></section>
   <section className="panel lark-step"><h2>4 · {moteText('同步与归档')}</h2><p>{status.lastSyncAt?`${moteText('最近成功同步：')}${new Date(status.lastSyncAt).toLocaleString()}`:moteText('还没有完成过同步。')}</p><div className="lark-buttons"><button className="button" disabled={running||!status.connected||dirty.current||!(status.selection.documents.length||status.selection.calendarIds.length)} onClick={()=>command('sync')}>{moteText('立即同步')}</button><button className="button subtle" onClick={onSources}>{moteText('查看来源与归档')}</button><button className="button subtle" disabled={busy} onClick={()=>setDisconnecting(true)}>{moteText('断开连接')}</button></div>{dirty.current&&<p className="fine-print">{moteText('请先保存修改后的同步范围。')}</p>}
    {disconnecting&&<div className="notice" role="alert"><p>{moteText('断开会停止读取并暂停这些来源，保留已归档资料。飞书端授权及 CLI 凭据仍保留，可在飞书中单独撤销。')}</p><button className="button subtle" disabled={busy} onClick={()=>setDisconnecting(false)}>{moteText('返回')}</button><button className="button" disabled={busy} onClick={()=>void perform(async()=>{accept(await api.request<LarkStatus>('/api/connectors/lark',{method:'DELETE'}),true);setDisconnecting(false);setNotice(moteText('连接已断开，历史归档已保留。'));})}>{moteText('确认断开')}</button></div>}
   </section>
  </>}
 </div>;
}
