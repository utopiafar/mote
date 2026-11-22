import {useEffect,useRef,useState} from 'react';
import type {SourceConnection} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {ApiError,type Api} from '../../api';
import {useResource} from '../../useResource';
import {resources} from '../../resource-cache';
import {useUnsavedChanges} from '../../unsaved';
import {connectorFailure,useSourceConnectorStyle} from '../../source-connectors-ui';
import {Loading} from '../../Loading';
import {InstalledConnector} from './BundledConnector';
import {SourceDisconnectReview} from './SourceDisconnectReview';
import {SourceCoverageDetails} from './SourceCoverage';

export type OfficialProvider='notion'|'slack'|'feishu-session';
// Keep the form limits aligned with the installed packages' /select validation.
export const officialConnectorDefinitions={
 notion:{id:'official-notion',packageId:'mote.official.notion',kind:'mote.official.notion',name:()=> 'Notion',types:['page','database'],selectionLimit:50},
 slack:{id:'official-slack',packageId:'mote.official.slack',kind:'mote.official.slack',name:()=> 'Slack',types:['channel','im','mpim'],selectionLimit:100},
 'feishu-session':{id:'official-feishu-session',packageId:'mote.official.feishu-session',kind:'mote.official.feishu-session',name:()=>moteText('飞书会话'),types:['group','p2p'],selectionLimit:100},
} as const;
type Selection={id:string;type:string;sourceId:string;initialSync?:'all'|'new_only';title?:string;name?:string};
type Status={configured:boolean;connected:boolean;accountId?:string;connectionGeneration?:string;account?:string;workspace?:string;team?:string;user?:string;archiveAuthorized?:boolean;readScopesOk?:boolean;selected:Selection[];state:string;job?:{kind:string;state:string;authorizationUrl?:string;error?:string}};
type Candidate={id:string;type:string;title?:string;name?:string};
type Choice={id:string;type:string;initialSync:'all'|'new_only'};
const label=(item:Candidate)=>item.title||item.name||item.id;
const kindLabel=(type:string)=>({page:moteText('页面'),database:moteText('数据库'),channel:moteText('频道'),im:moteText('私信'),mpim:moteText('群组私信'),group:moteText('群聊'),p2p:moteText('私信')}[type]??type);
function authorizationTarget(provider:OfficialProvider,value:string){
 const url=new URL(value);
 const allowed=provider==='notion'?url.hostname==='api.notion.com'&&url.pathname==='/v1/oauth/authorize':provider==='slack'?url.hostname==='slack.com'&&url.pathname==='/oauth/v2/authorize':['feishu.cn','larksuite.com','larkoffice.com'].some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain));
 if(url.protocol!=='https:'||url.username||url.password||url.port||!allowed)throw new ApiError(moteText('授权地址不符合预期。'),502,undefined,'invalid_response');
 return url.href;
}
export function OfficialConnectorSettings(props:{api:Api;provider:OfficialProvider;sourceId?:string;refresh:()=>Promise<void>}){
 const definition=officialConnectorDefinitions[props.provider];
 return <InstalledConnector api={props.api} packageId={definition.packageId} contributionId={definition.id}>{instanceId=><OfficialConnectorContent key={instanceId} {...props}/>}</InstalledConnector>;
}
function OfficialConnectorContent({api,provider,sourceId,refresh}:{api:Api;provider:OfficialProvider;sourceId?:string;refresh:()=>Promise<void>}){
 useSourceConnectorStyle();
 const definition=officialConnectorDefinitions[provider],path='/api/connectors/'+provider;
 const page=useResource<Status>(api,path,3000),sourcePage=useResource<{items:SourceConnection[]}>(api,'/api/sources',3000),status=page.data;
 const ready=Boolean(status?.connected&&(provider!=='feishu-session'||status.archiveAuthorized&&status.readScopesOk));
 const identity=status?.accountId??status?.connectionGeneration??'unconnected';
 const live=useRef({api,provider,identity,ready,failed:Boolean(page.error),controller:new AbortController()});
 if(live.current.api!==api||live.current.provider!==provider||live.current.identity!==identity||live.current.ready!==ready||live.current.failed!==Boolean(page.error))live.current={api,provider,identity,ready,failed:Boolean(page.error),controller:new AbortController()};
 const visit=live.current,current=()=>live.current===visit&&!visit.controller.signal.aborted;
 useEffect(()=>()=>visit.controller.abort(),[visit]);
 const [form,setForm]=useState<{visit:typeof visit;choices:Choice[];dirty:boolean}>();
 const [candidates,setCandidates]=useState<{visit:typeof visit;items:Candidate[];truncated:boolean}>();
 const [operation,setOperation]=useState<{visit:typeof visit;busy:boolean;error?:string;notice?:string;url?:string;controller?:AbortController}>();
 const [review,setReview]=useState<typeof visit>();
 const running=useRef<{visit:typeof visit;controller:AbortController;replace:boolean}|undefined>(undefined);
 const selected=Array.isArray(status?.selected)?status.selected:[];
 const dirty=form?.visit===visit&&form.dirty;
 const choices=form?.visit===visit?form.choices:selected.map(item=>({id:item.id,type:item.type,initialSync:item.initialSync??'all'}));
 const {selectionLimit}=definition;
 const limitReached=choices.length>=selectionLimit,overLimit=choices.length>selectionLimit;
 const listed=candidates?.visit===visit?candidates:undefined;
 const busy=operation?.visit===visit&&operation.busy,notice=operation?.visit===visit?operation.notice:undefined;
 const authorizing=provider==='feishu-session'&&status?.job?.kind==='archive'&&['running','waiting'].includes(status.job.state);
 let url=operation?.visit===visit?operation.url:undefined,authorizationError:string|undefined;
 if(provider==='feishu-session'&&status?.job){url=undefined;if(authorizing&&status.job.authorizationUrl)try{url=authorizationTarget(provider,status.job.authorizationUrl);}catch{authorizationError=moteText('授权地址不符合预期。');}}
 const error=(operation?.visit===visit?operation.error:undefined)??authorizationError;
 useUnsavedChanges(Boolean(dirty));
 useEffect(()=>()=>{if(running.current?.visit===visit)running.current.controller.abort();},[visit]);
 useEffect(()=>{if(!status||!current())return;setForm(value=>value?.visit===visit&&value.dirty?value:{visit,choices:selected.map(item=>({id:item.id,type:item.type,initialSync:item.initialSync??'all'})),dirty:false});},[visit,status?.selected]);
 useEffect(()=>{
  if(provider!=='feishu-session')return;
  const controller=new AbortController();
  void api.request(path+'/check',{method:'POST',body:'{}',signal:controller.signal}).then(()=>{if(!controller.signal.aborted)resources(api).invalidate(key=>key===path||key==='/api/sources');}).catch(error=>{if(!controller.signal.aborted&&current())setOperation({visit,busy:false,error:connectorFailure(error)});});
  return()=>controller.abort();
 },[api,provider]);
 const update=(next:Choice[])=>setForm({visit,choices:next,dirty:true});
 async function action(work:(signal:AbortSignal,valid:()=>boolean)=>Promise<void>,replace=false){
  if(running.current?.visit===visit){if(!replace||running.current.replace)return;running.current.controller.abort();}
  const controller=new AbortController(),signal=AbortSignal.any([controller.signal,visit.controller.signal]),valid=()=>current()&&!signal.aborted;
  running.current={visit,controller,replace};setOperation({visit,busy:true,controller});
  try{await work(signal,valid);}catch(error){if(valid())setOperation(value=>({...value,visit,busy:false,error:connectorFailure(error)}));}
  finally{if(valid()){running.current=undefined;setOperation(value=>({...value,visit,busy:false}));resources(api).invalidate(key=>key===path||key==='/api/connectors/status'||key==='/api/sources');try{await refresh();}catch(error){if(valid())setOperation(value=>({...value,visit,busy:false,error:connectorFailure(error)}));}}}
 }
 const authorize=()=>void action(async(signal,valid)=>{
  if(valid()){setCandidates(undefined);setForm(undefined);}
  const value=await api.request<{authorizationUrl?:string;job?:Status['job']}>(path+(provider==='feishu-session'?'/archive/start':'/start'),{method:'POST',body:'{}',signal});
  const target=value.authorizationUrl??value.job?.authorizationUrl;
  if(target){const safe=authorizationTarget(provider,target);if(valid())setOperation({visit,busy:true,url:safe});}
 });
 const load=()=>void action(async(signal,valid)=>{
  const result=await api.request<{items:Candidate[];truncated?:boolean}>(path+'/candidates',{method:'POST',body:'{}',signal});
  if(!Array.isArray(result.items)||result.items.some(item=>typeof item.id!=='string'||typeof item.type!=='string'||!(definition.types as readonly string[]).includes(item.type)))throw new ApiError(moteText('中央响应格式无效，刷新后重试。'),502,undefined,'invalid_response');
  if(valid())setCandidates({visit,items:result.items,truncated:result.truncated===true});
 });
 const sync=async(signal:AbortSignal,valid:()=>boolean)=>{
  const result=await api.request<{imported:number;duplicates:number}>(path+'/sync',{method:'POST',body:'{}',signal});
  if(valid())setOperation({visit,busy:true,notice:moteText('已同步 {0} 条新版本，{1} 条已存在。',result.imported,result.duplicates)});
 };
 const all=[...selected,...(listed?.items??[])].filter((item,index,items)=>items.findIndex(value=>value.id===item.id)===index);
 const bound=!sourceId||selected.some(item=>item.sourceId===sourceId);
 if(page.error)return <section className="connector-section"><p role="alert">{connectorFailure(page.error)}</p><button className="button" onClick={page.refresh}>{moteText('刷新状态')}</button></section>;
 if(!status)return <Loading/>;
 if(!bound)return <section className="connector-section"><p>{moteText('来源超出当前账号范围。核对账号与选择。')}</p><a className="button" href={'#/connections?setup='+definition.id}>{moteText('连接与范围')}</a></section>;
 return <div className="final-source-connector official-source-connector" data-official-provider={provider}>
  {error&&<p className="error-banner" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <section className="connector-section"><h2>{moteText('连接')}</h2><div className="connector-account"><div><strong>{status.workspace||[status.team,status.user].filter(Boolean).join(' · ')||status.account||definition.name()}</strong><small>{ready?moteText('账号已连接 · 只读'):moteText('尚未授权')}</small></div><div className="connector-actions">
   {provider==='feishu-session'&&!status.connected?<a className="button" href="#/connections/lark">{moteText('连接飞书账号')}</a>:<button className="button" disabled={busy||!status.configured||authorizing} onClick={authorize}>{moteText(ready?'重新授权':'连接账号')}</button>}
   <button className="text-button" disabled={busy} onClick={()=>void action(async(signal)=>{if(provider==='feishu-session')await api.request(path+'/check',{method:'POST',body:'{}',signal});})}>{moteText('刷新状态')}</button>
  </div></div>{provider==='feishu-session'&&<p className="connector-help">{moteText('飞书会话需要单独的消息读取授权；不会开启发送权限。')}</p>}{url&&<><a className="text-button connector-authorization" href={url} target="_blank" rel="noreferrer noopener">{moteText('在系统浏览器打开授权页面')}</a><p>{moteText('授权完成后返回此页并刷新状态。')}</p></>}{authorizing&&<button className="text-button" onClick={()=>void action(async(signal)=>{await api.request(path+'/cancel',{method:'POST',body:'{}',signal});},true)}>{moteText('取消')}</button>}{status.job?.kind==='archive'&&status.job.state==='failed'&&<p role="alert">{moteText('授权未完成，重试。')}</p>}</section>
  {ready&&<><form className="connector-section" onSubmit={event=>{event.preventDefault();if(url||authorizing||overLimit)return;const chosen=choices.map(item=>({...item}));void action(async(signal,valid)=>{
   await api.request(path+'/select',{method:'POST',body:JSON.stringify({selected:chosen}),signal});if(!valid())return;setForm({visit,choices:chosen,dirty:false});setOperation({visit,busy:true,notice:moteText('同步范围已保存。')});if(chosen.length)await sync(signal,valid);
  });}}><h2>{moteText('允许读取的内容')}</h2><button type="button" className="button" disabled={busy||Boolean(url)||authorizing} onClick={load}>{moteText('加载可选内容')}</button>{listed?.truncated&&<p>{moteText('可选内容列表未完整返回，只能选择当前已列出的内容。')}</p>}<p className="connector-help">{moteText('保存后读取已选来源，保留已有归档。')}</p>
  <p className="connector-help" role="status">
   {moteText('已选 {0} 项，最多可选 {1} 项。',choices.length,selectionLimit)}
   {limitReached&&<> {moteText('取消勾选一项后即可改选。')}</>}
  </p>
  <fieldset disabled={busy||Boolean(sourcePage.error)||Boolean(url)||authorizing}>
   {all.map(item=>{const checked=choices.find(value=>value.id===item.id);return <div className="connector-selection" key={item.id}><label className="connector-check"><input type="checkbox" checked={Boolean(checked)} disabled={!checked&&limitReached} onChange={event=>update(event.target.checked?[...choices,{id:item.id,type:item.type,initialSync:'all'}]:choices.filter(value=>value.id!==item.id))}/>{label(item)} · {kindLabel(item.type)}</label>{checked&&<label>{moteText('历史范围：{0}',label(item))}<select value={checked.initialSync} onChange={event=>update(choices.map(value=>value.id===item.id?{...value,initialSync:event.target.value as Choice['initialSync']}:value))}><option value="all">{moteText('全部已授权历史')}</option><option value="new_only">{moteText('仅接入新增内容')}</option></select></label>}</div>;})}
   {choices.some(item=>item.initialSync==='new_only')&&<p className="connector-help">{moteText('首次同步建立基线，随后跟踪新增和已归档资料修订。')}</p>}<div className="connector-savebar"><button className="button primary" disabled={!dirty||overLimit}>{moteText('保存并同步')}</button>{dirty&&<small>{moteText('有未保存的修改')}</small>}</div>
  </fieldset></form><section className="connector-section"><h2>{moteText('同步与归档')}</h2><button className="button" disabled={busy||dirty||!selected.length||Boolean(url)||authorizing} onClick={()=>void action(sync)}>{moteText('立即同步')}</button>{Boolean(sourcePage.error)&&<p role="alert">{connectorFailure(sourcePage.error)}</p>}{selected.map(item=>{const source=sourcePage.data?.items.find(value=>value.id===item.sourceId);return source?<div key={item.sourceId}><h3>{label(item)}</h3><SourceCoverageDetails source={source}/><a className="text-button" href={'#/connections?sourceId='+encodeURIComponent(source.id)}>{moteText('管理来源')}</a></div>:null;})}</section></>}
  {status.connected&&<div className="connector-risk-actions"><button className="text-button danger-text" onClick={()=>setReview(visit)}>{moteText('断开连接')}</button></div>}{review===visit&&<SourceDisconnectReview busy={false} items={provider==='feishu-session'?[moteText('停止读取飞书会话并暂停所选会话。保留归档和此飞书账号的其他连接。')]:undefined} cancel={()=>setReview(undefined)} confirm={()=>{setReview(undefined);void action(async(signal,valid)=>{await api.request(path+'/disconnect',{method:'POST',body:'{}',signal});if(valid()){setReview(undefined);setCandidates(undefined);setForm(undefined);setOperation({visit,busy:true});resources(api).invalidate(key=>key===path||key==='/api/connectors/status',true);}},true);}}/>}
 </div>;
}
