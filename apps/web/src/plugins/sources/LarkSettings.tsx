import {useSourceConnectorStyle,useConnectorDraft,connectorFailure} from '../../source-connectors-ui';
import {useResource} from '../../useResource';
import {readResource,resources} from '../../resource-cache';
import {ApiError} from '../../api';
import React,{useEffect,useRef,useState} from 'react';
import {CheckCircle2,ExternalLink,Link2,RefreshCw} from 'lucide-react';
import type {LarkStatus,LarkSelection,LarkCalendar,LarkJob,SourceConnection} from '@mote/shared';
import {type Api} from '../../api';
import {moteText} from '@mote/shared/i18n';
import {SourceContextEditor} from './SourceContextEditor';

const errors:Record<string,string>={
 lark_cli_deployment_required:'缺失或版本不符时，请管理员运行当前部署的 connectors-prepare，再重新检测。',
 lark_cli_version_unsupported:'缺失或版本不符时，请管理员运行当前部署的 connectors-prepare，再重新检测。',
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
 lark_partial_failure:'部分文档未完成读取，成功归档已保留。请逐篇重试失败项。',
 lark_document_sync_incomplete:'文档同步尚未完成，请检查失败项并重试。',
 lark_document_scope_changed:'文档范围已变化，请保存后重新预览。',
 lark_document_not_selected:'此文档已不在同步范围内，请检查范围后重试。',
 lark_search_pagination_invalid:'飞书搜索分页未完整返回，本次未标记检查完成。请重试。',
 lark_document_unsupported:'此资料类型暂不能读取正文，已保留可用引用。',
 lark_document_archive_required:'此来源当前不保留完整原件。确认后，此来源的后续归档也会保留文档正文原件；图片和附件仍只保留引用。',
 lark_file_archive_unavailable:'中央节点的文档原件归档暂不可用。请检查节点版本与存储后重试。',
};
const requestError=(error:unknown)=>error instanceof Error&&(error.message.startsWith('lark_')||error.message==='connector_input_invalid')?larkError(error.message):connectorFailure(error);
export const larkError=(code:string)=>moteText(errors[code]??'飞书操作失败，请重新检测连接后重试。');
const emptySelection:LarkSelection={documents:[],calendarIds:[],pastDays:30,futureDays:90,timeZone:'Asia/Shanghai',autoSync:false};
const noDiscovery={created:false,edited:false,opened:false,firstSyncDays:30};
const lines=(value:string)=>value.split('\n').map(v=>v.trim()).filter(Boolean);
const hasDocumentScope=(selection:LarkSelection)=>Boolean(selection.documents.length||selection.folders?.length||selection.wikiRoots?.length||selection.documentDiscovery&&(selection.documentDiscovery.created||selection.documentDiscovery.edited||selection.documentDiscovery.opened));
const hasScope=(selection:LarkSelection)=>Boolean(hasDocumentScope(selection)||selection.calendarIds.length);
const activeJob=(job?:LarkJob)=>Boolean(job&&['running','waiting'].includes(job.state));
export function LarkJobStatus({job}:{job:LarkJob}){
 const [qr,setQr]=useState(''),[qrError,setQrError]=useState(false),[copyState,setCopyState]=useState('');
 useEffect(()=>{let disposed=false;setQr('');setQrError(false);setCopyState('');if(job.authorizationUrl)void import('qrcode').then(({default:QRCode})=>QRCode.toDataURL(job.authorizationUrl!,{width:220,margin:2})).then(v=>{if(!disposed)setQr(v);}).catch(()=>{if(!disposed)setQrError(true);});return()=>{disposed=true;};},[job.authorizationUrl]);
 const name={install:moteText('安装 CLI'),setup:moteText('配置应用'),configure:moteText('保存应用'),login:moteText('账号授权'),selection:moteText('保存范围'),preview:moteText('预览文档范围'),sync:moteText('同步资料')}[job.kind];
 return <div className="lark-job" aria-live="polite">
  <strong>{name} · {job.state==='waiting'?moteText('等待扫码或网页授权'):job.state==='running'?moteText('正在处理…'):job.state==='completed'?moteText('已完成'):job.state==='cancelled'?moteText('已取消'):moteText('未完成')}</strong>
  {job.error&&<p role="alert">{larkError(job.error)}</p>}
  {job.result&&<>{job.kind==='preview'?<p>{moteText('发现 {0} 篇文档，尚未读取正文。',job.result.discovered??0)}</p>:<p>{moteText('新增 {0} 条，已有 {1} 条。',job.result.imported,job.result.duplicates)}</p>}{job.result.activities!==undefined&&<p>{moteText('保存 {0} 条文档活动线索。',job.result.activities)}</p>}{!!job.result.documentFailures&&<p>{moteText('{0} 篇文档读取失败，成功资料已保留；可在下方逐篇重试。',job.result.documentFailures)}</p>}</>}
  {job.authorizationUrl&&<div className="lark-authorization"><p>{moteText('在你的手机或当前浏览器完成授权，页面会自动更新。')}</p><a className="button" href={job.authorizationUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{moteText('打开飞书授权页面')}<ExternalLink size={15}/></a><button className="button subtle" onClick={async()=>{try{await navigator.clipboard.writeText(job.authorizationUrl!);setCopyState(moteText('授权链接已复制。'));}catch{setCopyState(moteText('复制失败，请使用二维码或授权链接。'));}}}>{moteText('复制授权链接')}</button><p className="fine-print">{copyState||moteText('如果无法打开，可复制链接到浏览器，或扫码。')}</p>{qr&&<img src={qr} alt={moteText('飞书授权二维码')} width={220} height={220}/>} {qrError&&<p>{moteText('二维码生成失败，请使用上方授权链接。')}</p>}{job.expiresAt&&<p className="fine-print">{moteText('链接有效至')} {new Date(job.expiresAt).toLocaleTimeString()}</p>}</div>}
 </div>;
}
export function LarkSettings({api,onSources}:{api:Api;onSources:()=>void}){
 useSourceConnectorStyle();const preparation=useRef<HTMLDetailsElement>(null);const [draftDirty,setDraftDirty]=useConnectorDraft(api,'lark.dirty',false);
 const [status,setStatus]=useState<LarkStatus>(),[selection,setSelection]=useConnectorDraft<LarkSelection>(api,'lark.selection',emptySelection),[documents,setDocuments]=useConnectorDraft(api,'lark.documents',''),[folders,setFolders]=useConnectorDraft(api,'lark.folders',''),[wikiRoots,setWikiRoots]=useConnectorDraft(api,'lark.wikiRoots',''),[excludedDocuments,setExcludedDocuments]=useConnectorDraft(api,'lark.excludedDocuments',''),[calendars,setCalendars]=useState<LarkCalendar[]>([]),[calendarLoaded,setCalendarLoaded]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[appId,setAppId]=useState(''),[secret,setSecret]=useState(''),[brand,setBrand]=useState<'feishu'|'lark'>('feishu'),[disconnecting,setDisconnecting]=useState(false);
 const alive=useRef(true),dirty=useRef(draftDirty),wasConnected=useRef(false);
 const read=useResource<LarkStatus>(api,'/api/connectors/lark',2000),scope=useRef(new AbortController());
 const sourcePath=status?.documentSync?.sourceId?'/api/sources/'+encodeURIComponent(status.documentSync.sourceId):null;
 const sourceList=useResource<{items:SourceConnection[]}>(api,sourcePath?'/api/sources':null,2000);
 const source=sourceList.data?.items.find(item=>item.id===status?.documentSync?.sourceId);
 const request=async<T,>(path:string,init?:RequestInit):Promise<T>=>{const signal=scope.current.signal;const result=init?.method?await api.request<T>(path,{...init,signal}):await readResource<T>(api,path,signal);signal.throwIfAborted();return result;};
 const accept=(next:LarkStatus,reset=false)=>{if(wasConnected.current&&!next.connected){resources(api).invalidate(key=>key==='/api/connectors/lark/calendars');setCalendars([]);setCalendarLoaded(false);}wasConnected.current=next.connected;setStatus(next);if(reset||!dirty.current){setSelection(next.selection);setDocuments(next.selection.documents.join('\n'));setFolders((next.selection.folders??[]).join('\n'));setWikiRoots((next.selection.wikiRoots??[]).join('\n'));setExcludedDocuments((next.selection.excludedDocuments??[]).join('\n'));if(reset){dirty.current=false;setDraftDirty(false);}}};
 useEffect(()=>{
  const controller=new AbortController();scope.current=controller;alive.current=true;dirty.current=draftDirty;wasConnected.current=false;setStatus(undefined);setCalendars([]);setCalendarLoaded(false);setError('');setNotice('');setSecret('');setBusy(false);
  void request<LarkStatus>('/api/connectors/lark/check',{method:'POST'}).then(()=>read.refresh()).catch(e=>{if(!controller.signal.aborted)setError(requestError(e));});
  return()=>{alive.current=false;controller.abort();};
 },[api]);
 useEffect(()=>{if(read.data)accept(read.data);if(read.error instanceof ApiError&&[401,403,404,410].includes(read.error.status)){setStatus(undefined);setCalendars([]);setCalendarLoaded(false);setDocuments('');setSelection(emptySelection);dirty.current=false;}},[read.data,read.error]);
 const perform=async(fn:()=>Promise<void>)=>{const signal=scope.current.signal;setBusy(true);setError('');setNotice('');try{await fn();if(!signal.aborted)read.refresh();}catch(e){if(alive.current&&!signal.aborted)setError(requestError(e));}finally{if(alive.current&&!signal.aborted)setBusy(false);}};
 const command=(name:string,body?:unknown)=>void perform(async()=>{await request(`/api/connectors/lark/${name}`,{method:'POST',...(body?{body:JSON.stringify(body)}:{})});accept(await request<LarkStatus>('/api/connectors/lark'));});
 const running=busy||activeJob(status?.job);
 const update=(patch:Partial<LarkSelection>)=>{dirty.current=true;setDraftDirty(true);setSelection(v=>({...v,...patch}));};
 const discovery=selection.documentDiscovery??noDiscovery;
 const updateDiscovery=(patch:Partial<typeof discovery>)=>update({documentDiscovery:{...discovery,...patch}});
 const needsConfirmation=Boolean(status&&hasDocumentScope(status.selection)&&!status.documentSync?.confirmed);
 return <div className="lark-settings final-source-connector">

  <button className="text-button connector-back" onClick={onSources}>← {moteText('来源')}</button><div className="page-heading"><h1>{moteText('飞书文档与日历')}</h1></div>
  {Boolean(error||read.error)&&<div className="notice error" role="alert">{error||requestError(read.error)}<button className="button subtle" disabled={running} onClick={()=>void perform(async()=>accept(await request<LarkStatus>('/api/connectors/lark/check',{method:'POST'})))}>{moteText('重试')}</button></div>}{notice&&<p role="status" className="notice">{notice}</p>}
  {!status&&<p role="status">{moteText('正在检测服务端环境…')}</p>}
  {status&&<>
   <section className="connector-section connector-connection"><h2>{moteText('连接')}</h2><div className="connector-account"><div><strong>{status.accountName||moteText(status.connected?'已连接':'尚未连接')}</strong><small>{status.connected?moteText('账号已连接 · 只读'):moteText('尚未连接')}</small></div><div className="connector-actions">{(!status.connected||status.missingScopes.length>0)&&<button className="button" disabled={running} onClick={()=>status.installed&&status.configured?command('login'):preparation.current&&(preparation.current.open=true)}>{status.installed&&status.configured?moteText('连接账号'):moteText('接入准备')}</button>}<button className="text-button" disabled={running} onClick={()=>command('check')}>{moteText('刷新状态')}</button></div></div>{status.job&&<LarkJobStatus job={status.job}/>}{activeJob(status.job)&&<button className="button subtle" disabled={busy} onClick={()=>command('cancel')}>{moteText('取消当前操作')}</button>}{status.error&&!status.job?.error&&<p role="alert">{larkError(status.error)}</p>}</section>
   <section className="connector-section connector-document-scope"><h2>{moteText('文档范围')}</h2><fieldset disabled={running||!status.connected}>

    <div className="lark-discovery-options">{([['created','我创建的'],['edited','我编辑过的'],['opened','我打开过的']] as const).map(([key,label])=><label className="lark-check" key={key}><input type="checkbox" checked={discovery[key]} onChange={e=>updateDiscovery({[key]:e.target.checked})}/>{moteText(label)}</label>)}</div>
    <label>{moteText('首次回溯天数')}<input type="number" min={1} value={discovery.firstSyncDays} onChange={e=>updateDiscovery({firstSyncDays:Number(e.target.value)})}/></label>
    <p className="fine-print">{moteText('活动来自飞书可提供的最近记录，可能只有时间范围；不保证逐次操作日志或阅读时长。')}</p>
    <details className="lark-pinned-scope connector-details"><summary>{moteText('持续跟踪指定文档、文件夹或知识库分支')}</summary><p>{moteText('明确选定的范围会持续检查当前版本，包括其他协作者的后续修改。每行填写一个链接或 token。')}</p>
     <label>{moteText('指定文档（每行一个）')}<textarea rows={3} value={documents} onChange={e=>{dirty.current=true;setDraftDirty(true);setDocuments(e.target.value);}} placeholder="https://example.feishu.cn/docx/…"/></label>
     <label>{moteText('文件夹（每行一个）')}<textarea rows={2} value={folders} onChange={e=>{dirty.current=true;setDraftDirty(true);setFolders(e.target.value);}} placeholder="https://example.feishu.cn/drive/folder/…"/></label>
     <label>{moteText('知识库分支（每行一个）')}<textarea rows={2} value={wikiRoots} onChange={e=>{dirty.current=true;setDraftDirty(true);setWikiRoots(e.target.value);}} placeholder="https://example.feishu.cn/wiki/…"/></label>
    </details>
    <details className="connector-details"><summary>{moteText('排除特定文档')}</summary><label>{moteText('不再读取的文档（每行一个）')}<textarea rows={2} value={excludedDocuments} onChange={e=>{dirty.current=true;setDraftDirty(true);setExcludedDocuments(e.target.value);}}/></label><p className="fine-print">{moteText('排除优先于自动发现和指定范围；已有归档保留。')}</p></details>
    <details className="connector-details connector-calendar-scope"><summary>{moteText('日历与时间范围')}</summary><div className="section-heading"><h3>{moteText('日历')}</h3><div className="lark-buttons"><button className="button subtle" type="button" onClick={()=>command('login',{calendar:true})}>{moteText('授权日历读取')}</button><button className="button subtle" type="button" onClick={()=>void perform(async()=>{resources(api).invalidate(key=>key==='/api/connectors/lark/calendars');const data=await request<{calendars:LarkCalendar[]}>('/api/connectors/lark/calendars');setCalendars(data.calendars);setCalendarLoaded(true);})}>{moteText('加载可选日历')}</button></div></div>
    <p className="fine-print">{moteText('需要日历时，先单独授权日历读取，再加载并选择日历。授权本身不会开始收集日程。')}</p>
    {calendarLoaded&&calendars.length===0&&<p>{moteText('当前账号没有可读取详情的日历。')}</p>}
    {([...calendars,...selection.calendarIds.filter(id=>!calendars.some(c=>c.id===id)).map(id=>({id,name:calendarLoaded?moteText('不可用日历：{0}（可取消选择）',id):id,primary:false}))]).map(c=><label className="lark-check" key={c.id}><input type="checkbox" checked={selection.calendarIds.includes(c.id)} onChange={e=>update({calendarIds:e.target.checked?[...selection.calendarIds,c.id]:selection.calendarIds.filter(id=>id!==c.id)})}/>{c.name}{c.primary?` · ${moteText('主日历')}`:''}</label>)}
    <div className="lark-range"><label>{moteText('过去天数')}<input type="number" min={0} max={180} value={selection.pastDays} onChange={e=>update({pastDays:Number(e.target.value)})}/></label><label>{moteText('未来天数')}<input type="number" min={1} max={180} value={selection.futureDays} onChange={e=>update({futureDays:Number(e.target.value)})}/></label><label>{moteText('全天日程时区')}<input value={selection.timeZone} onChange={e=>update({timeZone:e.target.value})}/></label></div>
    </details><label className="lark-check"><input type="checkbox" checked={selection.autoSync} onChange={e=>update({autoSync:e.target.checked})}/>{moteText('在后台定期同步选中内容')}</label>
    <p className="fine-print">{moteText('中央节点每 {0} 分钟检查，关闭页面后继续运行。关闭后台同步、移除范围或断开连接均保留已有归档；已暂停的来源需手动恢复。',(status.syncIntervalSeconds??900)/60)}</p>
    <div className="lark-scope-review"><strong>{moteText('保存前确认')}</strong><p>{moteText('首次回溯 {0} 天；指定 {1} 篇文档、{2} 个文件夹、{3} 个知识库分支；排除 {4} 篇文档。',discovery.firstSyncDays,lines(documents).length,lines(folders).length,lines(wikiRoots).length,lines(excludedDocuments).length)}</p><p className="fine-print">{moteText('首次保存后，先预览实际发现的文档，再确认开始归档。同步归档完成后，Memory 按现有设置继续处理；并非每篇文档都会生成精选记忆。')}</p></div>
    <button className="button primary" onClick={()=>void perform(async()=>{const next=await request<LarkStatus>('/api/connectors/lark/selection',{method:'PUT',body:JSON.stringify({...selection,documents:lines(documents),folders:lines(folders),wikiRoots:lines(wikiRoots),excludedDocuments:lines(excludedDocuments)})});accept(next,true);setNotice(moteText('同步范围已保存。'));})}>{moteText('保存同步范围')}</button>
   </fieldset></section>
   <section className="connector-section"><h2>{moteText('同步与归档')}</h2><p>{status.lastSyncAt?`${moteText('最近成功同步：')}${new Date(status.lastSyncAt).toLocaleString()}`:moteText('还没有完成过同步。')}</p><div className="lark-buttons"><button className="button subtle" disabled={running||!status.connected||dirty.current||!hasDocumentScope(status.selection)} onClick={()=>command('preview')}>{moteText('预览文档范围')}</button><button className="button primary" disabled={running||!status.connected||dirty.current||!hasScope(status.selection)||needsConfirmation&&!status.documentSync?.preview||source?.enabled===false} onClick={()=>command('sync')}>{needsConfirmation?moteText('确认并开始归档'):moteText('立即同步')}</button></div>{dirty.current&&<p className="fine-print">{moteText('请先保存修改后的同步范围。')}</p>}
    {source?.enabled===false&&<p role="status">{moteText('此文档来源已暂停；保存范围或重新授权不会恢复接入。')}</p>}{Boolean(sourceList.error)&&<p role="alert">{requestError(sourceList.error)}</p>}
    {status.documentSync?.preview&&!dirty.current&&<div className="lark-scope-review"><strong>{moteText('实际发现的文档')}</strong><p>{moteText('下列为可用文档标题与引用，尚未因预览读取正文。归档时保存当前版本及可获得的活动线索。')}</p><p>{moteText('发现 {0} 篇文档，以下显示 {1} 篇。',status.documentSync.previewTotal??status.documentSync.preview.length,status.documentSync.preview.length)}</p>{status.documentSync.preview.length===0?<p>{moteText('本次范围内没有发现文档。')}</p>:<ul>{status.documentSync.preview.map(item=><li key={item.reference}>{item.title||item.reference}</li>)}</ul>}<p className="fine-print">{moteText('预览最多显示 50 篇；同步会分页处理全部选定范围。')}</p></div>}
    {status.documentSync&&<div className="lark-document-status"><p>{moteText('已归档 {0} 篇文档 · {1} 条活动线索 · {2} 项待处理 · {3} 项失败',status.documentSync.documents,status.documentSync.activities,status.documentSync.pending,status.documentSync.failed)}</p>{status.documentSync.lastAttemptAt&&<p className="fine-print">{moteText('最近检查：{0}',new Date(status.documentSync.lastAttemptAt).toLocaleString())}</p>}{status.documentSync.errors.map(failure=><div className="lark-document-failure" key={failure.reference}><div><strong>{failure.reference}</strong><p>{larkError(failure.code)}</p></div><button className="button subtle" disabled={running||!status.connected||dirty.current||source?.enabled===false} onClick={()=>failure.code==='lark_document_archive_required'&&sourcePath?void perform(async()=>{await request(sourcePath,{method:'PATCH',body:JSON.stringify({retention:'archive'})});sourceList.refresh();await request('/api/connectors/lark/sync',{method:'POST',body:JSON.stringify({document:failure.reference})});accept(await request<LarkStatus>('/api/connectors/lark'));}):command('sync',{document:failure.reference})}>{moteText(failure.code==='lark_document_archive_required'?'为此来源保留完整正文并重试':'重试此文档')}</button></div>)}</div>}
    {status.documentSync?.sourceId&&<details className="connector-details connector-context"><summary>{moteText('资料说明与内容归属')}</summary><SourceContextEditor api={api} sourceId={status.documentSync.sourceId}/></details>}
    {disconnecting&&<div className="notice lark-disconnect-confirmation" role="alert"><p>{moteText('断开会停止读取并暂停这些来源，保留已归档资料。飞书端授权及 CLI 凭据仍保留，可在飞书中单独撤销。')}</p><div className="lark-buttons"><button className="button subtle" disabled={busy} onClick={()=>setDisconnecting(false)}>{moteText('返回')}</button><button className="button" disabled={busy} onClick={()=>void perform(async()=>{accept(await request<LarkStatus>('/api/connectors/lark',{method:'DELETE'}),true);setDisconnecting(false);setNotice(moteText('连接已断开，历史归档已保留。'));})}>{moteText('确认断开')}</button></div></div>}
   </section>
   <details ref={preparation} className="connector-details connector-preparation"><summary>{moteText('接入准备')}</summary>  <div className="lark-boundary"><Link2 size={20}/><div><strong>{moteText('只读资料来源')}</strong><p>{moteText('在你选择的范围内保存当前文档和后续版本。打开、编辑等线索单独保存；打开不代表读完、认同或当时看到的版本。')}</p><p>{moteText('正文与原文依据进入中央资料库，由你配置的模型处理；图片、附件和嵌入表格先保留引用。')}</p></div></div>
   <section className="panel lark-step"><div className="section-heading"><h2>1 · {moteText('服务端环境')}</h2><span className={`badge ${status.installed?'green':'muted'}`}>{status.installed?`Lark CLI ${status.version??''}`:moteText('未安装')}</span></div><p>{moteText('复用服务端已安装的 CLI；如未安装，可安装到 Mote 专用目录，无需修改全局软件。')}</p><div className="lark-buttons"><button className="button subtle" disabled={running} onClick={()=>command('check')}><RefreshCw size={15}/>{moteText('重新检测')}</button><button className="button subtle" disabled={running} onClick={()=>command('install')}>{status.installed?moteText('安装兼容版本到专用目录'):moteText('安装 Lark CLI')}</button></div></section>
   <section className="panel lark-step"><div className="section-heading"><h2>2 · {moteText('连接飞书账号')}</h2><span className={`badge ${status.connected?'green':'muted'}`}>{status.connected?moteText('已连接'):status.configured?moteText('应用已配置'):moteText('待配置应用')}</span></div>
    {status.accountName&&<p><CheckCircle2 size={15}/> {status.accountName}</p>}
    <p>{moteText('Mote 使用独立的 CLI 配置。首次使用先创建应用，也可以填写已有应用的 App ID 和 App Secret。')}</p>
    <div className="lark-buttons"><button className="button subtle" disabled={running||!status.installed||status.configured} onClick={()=>command('setup')}>{moteText('创建飞书应用')}</button><button className="button primary" disabled={running||!status.configured} onClick={()=>command('login')}>{status.connected?moteText('重新授权 / 更换账号'):moteText('扫码登录并授权只读权限')}</button></div>
    <details className="lark-manual"><summary>{moteText('使用已有应用')}</summary><p>{moteText('凭据仅发往当前中央节点。建议使用专用飞书应用；同一系统账号下，CLI 钥匙串可能与其他配置共享同一应用的凭据。')}</p><form onSubmit={e=>{e.preventDefault();const value=secret;setSecret('');void perform(async()=>{await request('/api/connectors/lark/configure',{method:'POST',body:JSON.stringify({appId,secret:value,brand})});accept(await request<LarkStatus>('/api/connectors/lark'));});}}><label>App ID<input value={appId} required pattern="cli_[A-Za-z0-9]+" disabled={running} onChange={e=>setAppId(e.target.value)}/></label><label>App Secret<input type="password" autoComplete="new-password" value={secret} required disabled={running} onChange={e=>setSecret(e.target.value)}/></label><label>{moteText('服务区域')}<select value={brand} disabled={running} onChange={e=>setBrand(e.target.value as 'feishu'|'lark')}><option value="feishu">{moteText('飞书（中国）')}</option><option value="lark">Lark</option></select></label><button className="button primary" disabled={running||!appId||!secret} type="submit">{moteText('保存应用配置')}</button></form></details>
    <details><summary>{moteText('所需只读权限与授权帮助')}</summary><p>{moteText('文档搜索、文档读取与知识库读取；选择文件夹或日历时再增加对应只读权限。保存新增范围后，如有缺失权限，请重新授权。')}</p><code>search:docs:read<br/>docx:document:readonly<br/>wiki:wiki:readonly<br/>space:document:retrieve<br/>calendar:calendar:readonly</code><p><a href={brand==='lark'?'https://open.larksuite.com/app':'https://open.feishu.cn/app'} target="_blank" rel="noopener noreferrer">{moteText('打开飞书应用后台')}</a></p></details>
    {status.missingScopes.length>0&&status.configured&&<p className="fine-print">{moteText('尚未授予：')}{status.missingScopes.join('、')}</p>}


   </section>
<div className="connector-actions"><button className="button subtle" onClick={onSources}>{moteText('查看来源与归档')}</button></div></details><div className="connector-risk-actions">{source&&<button className="button subtle" disabled={running||!status.connected} onClick={()=>void perform(async()=>{await request(sourcePath!,{method:'PATCH',body:JSON.stringify({enabled:!source!.enabled})});sourceList.refresh();})}>{source.enabled?moteText('暂停接入'):moteText('恢复接入')}</button>}<button className="button subtle" disabled={busy} onClick={()=>setDisconnecting(true)}>{moteText('断开连接')}</button></div>
  </>}
 </div>;
}
