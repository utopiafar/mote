import {useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {ModelSettingsView} from '@mote/shared/models';
import {ApiError,type Api,errorMessage} from '../../api';
import {useResource} from '../../useResource';
import {useForegroundResources} from '../../useForegroundResources';
import {RecordingTools} from '../sources/RecordingTools';
import {ModelAuthorizationSettings} from './ModelAuthorizationSettings';
import type {FileSettingsView} from '../../processing-settings-view';
import {automaticProcessingPlan,processingConnectionKey,type ProcessingAuthority,type ProcessingConnection,type ProcessingGrant,type ProcessingKind} from './automatic-processing-plan';

const path='/api/model-authorization';
const kindNames:Record<ProcessingKind,string>={text:'文字',conversation:'已提交对话',image:'图片原件',audio:'音频原件'};
type Command={owner:Api;encoded:string;id:string;controller:AbortController;sending?:boolean;action:'authorize'|'pause'|'stop'};
type Review={owner:Api;revision:number;plan:ProcessingGrant;viewOnly:boolean;editing:boolean;refreshing?:boolean};
export function AutomaticProcessing({api}:{api:Api}){
 const authority=useResource<{authorization:ProcessingAuthority;connections:ProcessingConnection[]}>(api,path,5000),models=useResource<ModelSettingsView>(api,'/api/model-settings'),media=useResource<FileSettingsView>(api,'/api/file-processing'),perception=useResource<{settings:{enabled:boolean}}>(api,'/api/perception'),sources=useResource<{items:{id:string;name:string}[]}>(api,'/api/sources'),devices=useResource<{items:{deviceId:string;deviceName:string}[]}>(api,'/api/devices');
 useForegroundResources(api,[path,'/api/model-settings','/api/file-processing','/api/perception','/api/sources','/api/devices']);
 const [review,setReview]=useState<Review>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const reviewError=useRef<HTMLParagraphElement>(null);
 const active=useRef(api);active.current=api;
 const operation=useRef<Command|undefined>(undefined);
 const [pending,setPending]=useState<Command>();
 const hasPending=pending?.owner===api&&operation.current===pending;
 useEffect(()=>{setReview(undefined);setPending(undefined);setBusy(false);setError('');setNotice('');return()=>{operation.current?.controller.abort();operation.current=undefined;};},[api]);
 const failure=[authority,models,media,perception,sources,devices].find(value=>value.error!==undefined)?.error;
 const failureDetails=[...new Set([error,failure!==undefined?errorMessage(failure):''])].filter(Boolean).join('\n');
 const withdrawn=[authority,models,media,perception,sources,devices].some(value=>value.error instanceof ApiError&&[401,403,404,410].includes(value.error.status));
 useEffect(()=>{if(withdrawn){setReview(undefined);operation.current?.controller.abort();operation.current=undefined;setPending(undefined);setBusy(false);}},[withdrawn]);
 const ready=authority.data&&models.data&&media.data&&perception.data&&sources.data&&devices.data&&failure===undefined;
 const revalidating=[authority,models,media,perception,sources,devices].some(value=>value.loading);
 const sourceOptions=[...new Map([...(sources.data?.items??[]),...(devices.data?.items??[]).map(value=>({id:'device:'+value.deviceId,name:value.deviceName})),{id:'mote.conversations',name:moteText('已提交对话')}].map(value=>[value.id,value])).values()];
 const currentSourceIds=sourceOptions.map(value=>value.id);
 for(const id of review?.owner===api?review.plan.scope.sourceIds??[]:[])if(!sourceOptions.some(value=>value.id===id))sourceOptions.push({id,name:id});
 const proposal=ready?automaticProcessingPlan(authority.data!.authorization,authority.data!.connections,models.data!,media.data!,perception.data!.settings.enabled,currentSourceIds):undefined;
 const current=authority.data?.authorization,dialog=review?.owner===api&&!withdrawn?review:undefined;
 useEffect(()=>{
  if(!dialog?.refreshing||active.current!==api||revalidating||busy||hasPending)return;
  if(failure!==undefined){setError(errorMessage(failure));return;}
  if(!ready)return;
  setError('');setReview(value=>value!==dialog?value:{...dialog,refreshing:false,revision:current!.revision,plan:structuredClone(dialog.viewOnly?{connections:current!.connections,scope:current!.scope}:proposal!.plan)});
 },[api,dialog,ready,current,proposal,failure,revalidating,busy,hasPending]);
 const state=hasPending?moteText('状态尚未确认'):!ready?moteText(failure!==undefined?'暂不可用':'正在读取…'):current!.state==='unapproved'?moteText('尚未开启'):current!.state==='paused'?moteText('已暂停新任务'):current!.state==='stopped'?moteText('已停止'):proposal!.covered?moteText('已开启'):moteText('设置变化，待确认');
 const label=current?.state==='enabled'?proposal?.covered?moteText('暂停新任务'):moteText('确认新设置'):current?.state==='paused'?moteText('恢复自动处理'):current?.state==='stopped'?moteText('重新开启'):moteText('开启自动处理');
 const title=(connection:ProcessingConnection)=>{
  const profile=models.data?.profiles.find(value=>connection.id.startsWith('profile:'+value.id+':'));
  if(profile)return {name:profile.name+' · '+connection.id.slice(('profile:'+profile.id+':').length),address:profile.settings.protocol==='codex-app-server'?moteText('Central 上已登录的 Codex'):profile.settings.baseUrl};
  const service=media.data?.policy.services.find(value=>connection.id.startsWith('media:'+value.id+':')||connection.id.startsWith('file-service:'+value.id+':'));
  if(service)return {name:service.name,address:service.execution==='local'?moteText('在 Mote 中心所在机器处理'):service.endpoint};
  return {name:connection.id,address:''};
 };
 async function send(request:Command){
  if(request.sending||busy||active.current!==request.owner||operation.current!==request||request.controller.signal.aborted)return;
  request.sending=true;
  const isCurrent=()=>active.current===request.owner&&operation.current===request&&!request.controller.signal.aborted;
  setBusy(true);setError('');setNotice('');
  try{
   await request.owner.request<ProcessingAuthority>(path+'/commands',{method:'POST',body:JSON.stringify({...JSON.parse(request.encoded),operationId:request.id}),signal:request.controller.signal});
   if(!isCurrent())return;
   setReview(undefined);setPending(undefined);setNotice(request.action==='pause'?moteText('已暂停新任务，已受理任务继续完成。'):request.action==='stop'?moteText('已撤销在途自动任务；已保存的资料继续保留。'):moteText('已保存后续任务的授权范围。'));operation.current=undefined;setBusy(false);authority.refresh();
  }catch(caught){if(isCurrent()){
   setError(errorMessage(caught));
   if(caught instanceof ApiError&&caught.status>=400&&caught.status<500){operation.current=undefined;setPending(undefined);setBusy(false);}else setPending(request);
   authority.refresh();
  }}finally{request.sending=false;if(isCurrent())setBusy(false);}
 }
 async function command(action:'authorize'|'pause'|'stop',grant?:ProcessingGrant,revision=current?.revision){
  if(!ready||revision===undefined||busy||hasPending||operation.current)return;
  const encoded=JSON.stringify({revision,action,...(action==='authorize'?grant:{})});
  const request:Command={owner:api,encoded,id:crypto.randomUUID(),controller:new AbortController(),action};operation.current=request;
  await send(request);
 }
 function openReview(viewOnly:boolean){
  if(!ready||busy||hasPending)return;
  setError('');setReview({owner:api,revision:current!.revision,plan:structuredClone(viewOnly?{connections:current!.connections,scope:current!.scope}:proposal!.plan),viewOnly,editing:false,refreshing:true});
  [authority,models,media,perception,sources,devices].forEach(value=>value.refresh());
 }
 function start(){
  if(!ready||busy||hasPending)return;
  if(current!.state==='enabled'&&proposal!.covered){void command('pause');return;}
  if(['paused','stopped'].includes(current!.state)&&proposal!.covered){void command('authorize',{connections:current!.connections,scope:current!.scope});return;}
  openReview(false);
 }
 const changed=dialog&&current&&dialog.revision!==current.revision;
 useEffect(()=>{if((error||failure!==undefined)&&dialog)reviewError.current?.scrollIntoView?.({block:'nearest'});},[error,failure,Boolean(dialog)]);
 const valid=dialog&&dialog.plan.connections.length>0&&dialog.plan.scope.dataKinds.length>0&&(dialog.plan.scope.sourceIds===null||dialog.plan.scope.sourceIds.length>0)&&dialog.plan.connections.every(value=>authority.data?.connections.some(available=>processingConnectionKey(available)===processingConnectionKey(value)));
 const recheckReview=()=>{if(!dialog||busy||revalidating||active.current!==api)return;if(!hasPending)setError('');[authority,models,media,perception,sources,devices].forEach(value=>value.refresh());};
 const refresh=()=>{setReview(undefined);setError('');[authority,models,media,perception,sources,devices].forEach(value=>value.refresh());};
 return <section className="automatic-processing-control" aria-label={moteText('自动处理新资料')} aria-busy={busy||revalidating||Boolean(dialog?.refreshing)}>
  <div className="automatic-control-main"><div><h2>{moteText('自动处理新资料')}</h2><p role="status">{state}</p></div><button type="button" className={'button '+(current?.state!=='enabled'?'primary':'')} disabled={!ready||busy||hasPending||Boolean(dialog?.refreshing)} onClick={start}>{label}</button></div>
  {(error||failure!==undefined)&&!dialog&&<div><p role="alert">{moteText(hasPending?'请求结果尚未确认，请重试同一请求。':'操作未完成，请重试')}</p><details><summary>{moteText('技术详情')}</summary><pre>{error||errorMessage(failure)}</pre></details></div>}{notice&&<p role="status">{notice}</p>}{hasPending&&!dialog&&<button className="button" disabled={busy||!ready} onClick={()=>void send(pending!)}>{moteText('重试')}</button>}
  <details className="automatic-control-more"><summary>{moteText('更多')}</summary><button type="button" className="text-button" disabled={!ready||busy||hasPending||!current?.connections.length} onClick={()=>openReview(true)}>{moteText('资料处理范围')}</button><button type="button" className="text-button" disabled={!ready||busy||hasPending||!['enabled','paused'].includes(current?.state??'')} onClick={()=>void command('stop')}>{moteText('立即停止全部自动任务')}</button><p>{moteText('暂停后，已受理任务继续完成。立即停止会撤销在途自动任务，已保存资料保留。')}</p><button type="button" className="text-button" disabled={busy||hasPending} onClick={refresh}>{moteText('重新读取')}</button><details><summary>{moteText('高级：模型与资料范围')}</summary><ModelAuthorizationSettings api={api}/></details></details>
  {dialog&&<RecordingTools className="automatic-review-dialog" title={dialog.viewOnly?moteText('当前自动处理范围'):current?.connections.length?moteText('确认处理设置'):moteText('开启自动处理')} onClose={()=>{if(!busy)setReview(undefined);}} footer={<><button type="button" className="button" disabled={busy} onClick={()=>setReview(undefined)}>{moteText(dialog.viewOnly?'关闭':current?.connections.length?'取消':'暂不开启')}</button>{!dialog.viewOnly&&<button type="button" className="button primary" disabled={!ready||busy||(!hasPending&&(revalidating||Boolean(dialog.refreshing)||!valid||Boolean(changed)))} onClick={()=>hasPending?void send(pending!):void command('authorize',dialog.plan,dialog.revision)}>{moteText(hasPending?'重试':current?.connections.length?'保存并开启':'开启自动处理')}</button>}</>}>
   <p className="automatic-review-intro">{moteText(dialog.viewOnly?'自动任务使用这份已保存范围。':'按已保存的设置处理新资料。内容可能发送到所选服务，并产生费用。')}</p>
   <section className="automatic-review-section"><h3>{moteText('模型与处理服务')}</h3><p>{[...new Set(dialog.plan.connections.map(value=>title(value).name))].join('、')||moteText('未配置')}</p>
   <details className="automatic-review-addresses"><summary>{moteText('查看服务明细')}</summary><ul className="automatic-review-services">{dialog.plan.connections.map(value=><li key={processingConnectionKey(value)}><strong>{title(value).name}</strong><small>{title(value).address}</small></li>)}</ul></details></section>
   <section className="automatic-review-section"><h3>{moteText('处理内容')}</h3><p>{dialog.plan.scope.dataKinds.map(value=>moteText(kindNames[value])).join('、')}</p></section>
   <details className="automatic-review-range" open={dialog.editing||undefined}><summary>{moteText('资料范围')} · {dialog.plan.scope.sourceIds===null?moteText('全部来源（含之后新增的来源）'):moteText('{0} 个已选来源',dialog.plan.scope.sourceIds.length)}</summary><p>{dialog.plan.scope.sourceIds===null?moteText('全部来源，包括之后新增的来源'):dialog.plan.scope.sourceIds.map(id=>sourceOptions.find(value=>value.id===id)?.name??id).join('、')}</p>
   {!dialog.editing&&<button type="button" className="text-button" disabled={busy||hasPending||Boolean(dialog.refreshing)} onClick={()=>setReview({...dialog,viewOnly:false,editing:true})}>{moteText('调整资料范围')}</button>}
   {dialog.editing&&<fieldset disabled={busy||hasPending||Boolean(dialog.refreshing)} className="automatic-source-options"><label><input type="checkbox" checked={dialog.plan.scope.sourceIds===null} onChange={event=>setReview({...dialog,plan:{...dialog.plan,scope:{...dialog.plan.scope,sourceIds:event.target.checked?null:sourceOptions.map(value=>value.id)}}})}/>{moteText('全部来源，包括之后新增的来源')}</label>{dialog.plan.scope.sourceIds!==null&&sourceOptions.map(source=><label key={source.id}><input type="checkbox" checked={dialog.plan.scope.sourceIds!.includes(source.id)} onChange={event=>setReview({...dialog,plan:{...dialog.plan,scope:{...dialog.plan.scope,sourceIds:event.target.checked?[...dialog.plan.scope.sourceIds!,source.id]:dialog.plan.scope.sourceIds!.filter(id=>id!==source.id)}}})}/><span>{source.name}{sourceOptions.some(other=>other.id!==source.id&&other.name===source.name)&&<small>{source.id}</small>}</span></label>)}</fieldset>}
   </details>
   {!dialog.viewOnly&&dialog.plan.scope.sourceIds!==null&&<p className="automatic-review-note">{moteText('新增来源需另行加入处理范围。')}</p>}
   {!dialog.viewOnly&&Boolean(current?.connections.length)&&<p className="automatic-review-note">{moteText('现有来源范围保留；本次将确认当前选择的服务与所需内容类型。已受理任务沿用原范围。')}</p>}
   {changed&&!hasPending&&<p role="alert">{moteText('设置已变化，请重新读取并核对后继续。')}</p>}{(error||failure!==undefined)&&<div><p ref={reviewError} role="alert">{moteText(hasPending?'请求结果尚未确认，请重试同一请求。':'操作未完成，请重试')}</p>{failure!==undefined&&<button type="button" className="text-button" disabled={busy||revalidating} onClick={recheckReview}>{moteText('重新读取')}</button>}<details><summary>{moteText('技术详情')}</summary><pre>{failureDetails}</pre></details></div>}
  </RecordingTools>}
 </section>;
}
