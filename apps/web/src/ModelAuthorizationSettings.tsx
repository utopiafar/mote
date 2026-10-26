import {useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {ModelSettingsView} from '@mote/shared/models';
import {ApiError,type Api,errorMessage} from './api';
import {useResource} from './useResource';
import {useUnsavedChanges} from './unsaved';

type Connection={id:string;fingerprint:string};
type Kind='text'|'image'|'audio'|'conversation';
type Scope={sourceIds:string[]|null;dataKinds:Kind[]};
type Authority={revision:number;state:'unapproved'|'enabled'|'paused'|'stopped';connections:Connection[];scope:Scope};
type View={authorization:Authority;connections:Connection[]};
type Draft={connections:Connection[];scope:Scope};
const path='/api/model-authorization';
const key=(connection:Connection)=>connection.id+'@'+connection.fingerprint;
const kinds:Record<Kind,string>={text:moteText('文字'),image:moteText('图片原件'),audio:moteText('音频原件'),conversation:moteText('对话内容')};
const states={unapproved:moteText('尚未授权'),enabled:moteText('已启用'),paused:moteText('已暂停新任务'),stopped:moteText('已停止并撤销自动任务')};

export function ModelAuthorizationSettings({api}:{api:Api}){
 const active=useRef(api);active.current=api;
 const read=useResource<View>(api,path,5000),models=useResource<ModelSettingsView>(api,'/api/model-settings');
 const media=useResource<{policy:{services:{id:string;name:string}[]};processors:{id:string;name:string}[]}>(api,'/api/file-processing');
 const sources=useResource<{items:{id:string;name:string}[]}>(api,'/api/sources');
 const devices=useResource<{items:{deviceId:string;deviceName:string}[]}>(api,'/api/devices');
 const [draft,setDraft]=useState<Draft>(),[baseline,setBaseline]=useState<Draft>(),[revision,setRevision]=useState<number>();
 const [consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const pending=useRef<{encoded:string;operationId:string}|undefined>(undefined);
 const dirty=JSON.stringify(draft)!==JSON.stringify(baseline)||consent;
 useUnsavedChanges(dirty);
 useEffect(()=>{setDraft(undefined);setBaseline(undefined);setRevision(undefined);setConsent(false);setBusy(false);setError('');setNotice('');pending.current=undefined;},[api]);
 useEffect(()=>{if(read.data&&!dirty&&!busy&&(revision===undefined||read.data.authorization.revision>=revision)){
  const next={connections:read.data.authorization.connections,scope:read.data.authorization.scope};setDraft(structuredClone(next));setBaseline(structuredClone(next));setRevision(read.data.authorization.revision);
 }},[read.data,dirty,busy,revision]);
 useEffect(()=>{if(read.error instanceof ApiError&&[401,403,404,410].includes(read.error.status)){setDraft(undefined);setBaseline(undefined);setRevision(undefined);setConsent(false);}},[read.error]);
 const change=(next:Draft)=>{setDraft(next);setConsent(false);setNotice('');};
 const command=async(action:'authorize'|'pause'|'stop')=>{
  if(!draft||revision===undefined||busy)return;
  const body={revision:action==='authorize'?revision:read.data!.authorization.revision,action,...(action==='authorize'?draft:{})};
  const encoded=JSON.stringify(body);
  if(pending.current?.encoded!==encoded)pending.current={encoded,operationId:crypto.randomUUID()};
  setBusy(true);setError('');setNotice('');
  try{
   const next=await api.request<Authority>(path+'/commands',{method:'POST',body:JSON.stringify({...body,operationId:pending.current.operationId})});
   if(active.current!==api)return;
   const value={connections:next.connections,scope:next.scope};setDraft(structuredClone(value));setBaseline(structuredClone(value));setRevision(next.revision);setConsent(false);pending.current=undefined;
   setNotice(action==='stop'?moteText('已撤销在途自动任务；已保存的资料继续保留。'):action==='pause'?moteText('已暂停新任务，已受理任务继续完成。'):moteText('已保存后续任务的授权范围。'));read.refresh();
  }catch(failure){if(active.current===api){setError(errorMessage(failure));read.refresh();}}
  finally{if(active.current===api)setBusy(false);}
 };
 const options=[...(sources.data?.items??[]).map(source=>({id:source.id,name:source.name})),...(devices.data?.items??[]).map(device=>({id:'device:'+device.deviceId,name:device.deviceName})),{id:'mote.conversations',name:moteText('已提交对话')}];
 const sourceOptions=[...new Map(options.map(option=>[option.id,option])).values()];
 for(const id of draft?.scope.sourceIds??[])if(!sourceOptions.some(option=>option.id===id))sourceOptions.push({id,name:id});
 const connections=read.data?.connections??[];
 const connectionOptions=[...new Map([...connections,...(draft?.connections??[])].map(connection=>[key(connection),connection])).values()];
 const unavailable=Boolean(draft?.connections.some(connection=>!connections.some(current=>key(current)===key(connection))));
 const title=(connection:Connection)=>{
  const profile=models.data?.profiles.find(profile=>connection.id.startsWith('profile:'+profile.id+':'));
  if(profile)return profile.name+' · '+connection.id.slice(('profile:'+profile.id+':').length);
  const service=media.data?.policy.services.find(service=>connection.id.startsWith('media:'+service.id+':')||connection.id.startsWith('file-service:'+service.id+':'));
  if(service){const prefix=connection.id.startsWith('media:')?'media:':'file-service:',suffix=connection.id.slice((prefix+service.id+':').length);return service.name+' · '+(media.data?.processors.find(processor=>processor.id===suffix)?.name??suffix);}
  return connection.id;
 };
 const failed=media.error!==undefined||read.error!==undefined||sources.error!==undefined||devices.error!==undefined||models.error!==undefined;
 const canAuthorize=draft&&consent&&draft.connections.length>0&&draft.scope.dataKinds.length>0&&(draft.scope.sourceIds===null||draft.scope.sourceIds.length>0)&&!unavailable&&!failed;
 return <section className="panel runtime-settings model-authorization-settings" aria-busy={busy}>
  <h2>{moteText('后台 AI 处理授权')}</h2>
  <p>{moteText('未授权或未配置模型，也可以保存资料。保存模型连接不会自动授权后台处理。')}</p>
  <p>{moteText('授权后，仅新接收的资料触发自动处理；历史资料仍可在批准范围内作为参考。原文可能发送给所选模型服务并产生费用，具体费用取决于服务商。')}</p>
  <p>{moteText('模块使用固定模型或跟随模块默认。动态路由、成本调度与自动切换尚未启用。')}</p>
  {read.data&&<p role="status">{states[read.data.authorization.state]}</p>}
  {read.loading&&!draft&&<p role="status">{moteText('正在读取…')}</p>}
  {(error||failed)&&<p role="alert">{error||errorMessage(read.error??sources.error??devices.error??models.error??media.error)}</p>}
  {draft&&<form onSubmit={event=>{event.preventDefault();void command('authorize');}}><fieldset disabled={busy||failed}>
   <legend>{moteText('后续任务的模型与数据范围')}</legend>
   {!connections.length&&<p>{moteText('请先配置模型连接，再选择允许后台使用的模型。')}</p>}
   {connectionOptions.map(connection=><label className="preference-toggle" key={key(connection)}><span>{title(connection)}{!connections.some(current=>key(current)===key(connection))?' · '+moteText('所选模型连接已不可用'):''}</span><input type="checkbox" aria-label={title(connection)} checked={draft.connections.some(value=>key(value)===key(connection))} onChange={event=>change({...draft,connections:event.target.checked?[...draft.connections,connection]:draft.connections.filter(value=>key(value)!==key(connection))})}/></label>)}
   {unavailable&&<p role="alert">{moteText('原授权模型已更改或不可用，请重新读取并核对模型。')}</p>}
   <label className="preference-toggle"><span>{moteText('所有来源（包括之后新增的来源）')}</span><input type="checkbox" checked={draft.scope.sourceIds===null} onChange={event=>change({...draft,scope:{...draft.scope,sourceIds:event.target.checked?null:[]}})}/></label>
   {draft.scope.sourceIds!==null&&sourceOptions.map(source=><label className="preference-toggle" key={source.id}><span>{source.name}</span><input type="checkbox" checked={draft.scope.sourceIds!.includes(source.id)} onChange={event=>change({...draft,scope:{...draft.scope,sourceIds:event.target.checked?[...draft.scope.sourceIds!,source.id]:draft.scope.sourceIds!.filter(id=>id!==source.id)}})}/></label>)}
   {(Object.keys(kinds) as Kind[]).map(kind=><label className="preference-toggle" key={kind}><span>{kinds[kind]}</span><input type="checkbox" checked={draft.scope.dataKinds.includes(kind)} onChange={event=>change({...draft,scope:{...draft.scope,dataKinds:event.target.checked?[...draft.scope.dataKinds,kind]:draft.scope.dataKinds.filter(value=>value!==kind)}})}/></label>)}
   <p>{moteText('调整范围只影响之后受理的任务，不撤回在途任务。暂停只阻止新任务；立即停止会撤销在途自动任务。')}</p>
   <label className="preference-toggle"><span>{moteText('我已核对数据范围、模型服务与可能产生的费用')}</span><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/></label>
   <button className="button primary" disabled={!canAuthorize||busy}>{moteText('授权后续后台处理')}</button>
  </fieldset></form>}
  <div className="source-toolbar">
   <button className="button" disabled={busy||read.error!==undefined||read.data?.authorization.state!=='enabled'} onClick={()=>void command('pause')}>{moteText('暂停新任务')}</button>
   <button className="button" disabled={busy||read.error!==undefined||!read.data||['unapproved','stopped'].includes(read.data.authorization.state)} onClick={()=>void command('stop')}>{moteText('立即停止并撤销自动任务')}</button>
   <button className="button subtle" disabled={busy} onClick={()=>{setDraft(undefined);setBaseline(undefined);setRevision(undefined);setConsent(false);setError('');setNotice('');pending.current=undefined;read.refresh();models.refresh();sources.refresh();devices.refresh();media.refresh();}}>{moteText('重新读取并还原草稿')}</button>
  </div>
  {notice&&<p role="status">{notice}</p>}
 </section>;
}
