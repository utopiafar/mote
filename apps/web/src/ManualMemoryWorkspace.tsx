import {useEffect,useRef,useState} from 'react';
import {parseEvidenceRef} from '@mote/shared';
import type {ModelSettingsView} from '@mote/shared/models';
import {moteText} from '@mote/shared/i18n';
import {type Api,type Range,type Capture,errorMessage,dateTime} from './api';
import {useResource} from './useResource';
import {failureMessage} from './failure-message';
import {resources} from './resource-cache';
import {captureDateRange,localDateInput} from './capture-presentation';
import {ModelSelector} from './ModelSelector';
import {ManualMemoryRecipes} from './ManualMemoryRecipes';
import {MemoryWorkChoices,type ExtractionChoice} from './MemoryWorkChoices';
import {MemoryProgress,memoryJobLabel,useMemoryJob} from './MemoryProgress';
import {MemoryIntegration,type IntegrationCandidate} from './MemoryIntegration';
import type {MemoryRecipeRef} from './memory-recipes';
import type {Material} from './Materials';
export function installMemoryWorkspaceStyles(){if(document.querySelector('link[data-mote-memory-workspace]'))return;const link=document.createElement('link');link.rel='stylesheet';link.href=new URL('./memory-workspace-final.css?no-inline',import.meta.url).href;link.dataset.moteMemoryWorkspace='';document.head.append(link);}

export type MemoryWorkLaunch={api:Api;token:number|string;kind:'extract'|'integrate'|'current';choice?:ExtractionChoice;candidate?:IntegrationCandidate;jobId?:string};
type Scope={kind:'range';after:string;before:string;deviceId?:string}|{kind:'source';choice:ExtractionChoice};
type Snapshot={body:string;scope:Scope;pin?:string;modelPin:string};
type Work={api:Api;token:number|string;view:'extract-entry'|'integrate-entry'|'range'|'source'|'integration'|'job';scope:Scope;candidate?:IntegrationCandidate;jobId?:string};
function initial(api:Api,launch:MemoryWorkLaunch,range:Range):Work {
 const today=localDateInput(new Date()),scope:Scope={kind:'range',after:range.after?localDateInput(new Date(range.after)):today,before:range.before?localDateInput(new Date(range.before)):today,deviceId:range.deviceId};
 return {api,token:launch.token,view:launch.kind==='current'?'job':launch.kind==='integrate'?launch.candidate?'integration':'integrate-entry':launch.choice?'source':'extract-entry',scope:launch.choice?{kind:'source',choice:launch.choice}:scope,candidate:launch.candidate,jobId:launch.jobId};
}
function selectedModelPin(view:ModelSettingsView,profileId:string|undefined){const id=profileId||view.defaults.memory,profile=view.profiles.find(profile=>profile.id===id);return JSON.stringify({id,settings:profile?.settings,defaultModel:profileId?undefined:view.defaultModels?.memory});}
/** The existing commands in a separate work page. A new admission never resurrects a cancelled job. */
export function ManualMemoryWorkspace({api,launch,range,onClose,onOpen,onViewMemory,onBusyChange,verificationPending=false,active=true}:{api:Api;launch:MemoryWorkLaunch;range:Range;onClose:()=>void;onOpen:(ref:string)=>void;onViewMemory:(id:string)=>void;onBusyChange?:(api:Api,busy:boolean)=>void;verificationPending?:boolean;active?:boolean}){
 const [stored,setStored]=useState(()=>initial(api,launch,range)),work=stored.api===api&&stored.token===launch.token?stored:initial(api,launch,range);
 const [settings,setSettings]=useState<{api:Api;model:string;recipes:MemoryRecipeRef[]}>({api,model:'',recipes:[]});
 const options=settings.api===api?settings:{api,model:'',recipes:[]};
 const [activity,setActivity]=useState<{api:Api;token:number|string;busy:boolean;error?:string;scopeKey?:string}>(),currentActivity=activity?.api===api&&activity.token===launch.token?activity:undefined,busy=currentActivity?.busy===true;
 const workKey=JSON.stringify([work.view,work.scope,work.candidate?.id,work.candidate?.version,work.candidate?.fingerprint,work.jobId]),navigation=useRef({key:workKey});if(navigation.current.key!==workKey)navigation.current={key:workKey};
 const [integrationActivity,setIntegrationActivity]=useState<{api:Api;busy:boolean}>();
 const request=useRef<AbortController|null>(null),visit=useRef({api,token:launch.token}),alive=useRef(true),owned=useRef<{api:Api;items:Map<string,Snapshot>}>({api,items:new Map()});
 if(visit.current.api!==api||visit.current.token!==launch.token){visit.current={api,token:launch.token};request.current?.abort();request.current=null;}
 if(owned.current.api!==api)owned.current={api,items:new Map()};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();};},[]);
 const change=(patch:Partial<Work>)=>setStored({...work,...patch});
 const [rangeDraft,setRangeDraft]=useState<{api:Api;scope:Extract<Scope,{kind:'range'}>}>(()=>({api,scope:initial(api,{api,token:0,kind:'extract'},range).scope as Extract<Scope,{kind:'range'}>}));
 const chosenRange=rangeDraft.api===api?rangeDraft.scope:initial(api,{api,token:0,kind:'extract'},range).scope as Extract<Scope,{kind:'range'}>;
 const changeRange=(scope:Extract<Scope,{kind:'range'}>)=>{setRangeDraft({api,scope});change({scope});};
 const choice=work.scope.kind==='source'?work.scope.choice:undefined,captureId=choice?.kind==='capture'?parseEvidenceRef(choice.ref)?.id:undefined,materialId=choice?.kind==='material'?choice.ref.match(/^material:(mat_[a-f0-9]{64})@[a-f0-9]{64}$/)?.[1]:undefined;
 const source=useResource<Capture&{libraryVersion?:string}>(api,captureId?'/api/capture-browser/'+encodeURIComponent(captureId):null);
 const material=useResource<Material>(api,materialId?'/api/materials/'+encodeURIComponent(materialId):null);
 const models=useResource<ModelSettingsView>(api,'/api/model-settings');
 const sourcePin=source.data?.libraryVersion;
 const sourceReady=!!captureId&&typeof sourcePin==='string'&&!!sourcePin.trim()&&source.data?.id===captureId&&!source.error&&!source.loading&&(!choice?.revision||sourcePin===choice.revision);
 const materialReady=!!materialId&&!!material.data&&material.data.ref===choice?.ref&&material.data.memorySource?.status==='ready'&&!!material.data.memorySource.evidenceIds.length&&!material.error&&!material.loading;
 const readable=choice?.kind==='material'?materialReady:sourceReady;
 const {job,error:jobError,reload:reloadJob}=useMemoryJob(api,work.jobId);
 const recent=useResource<{items:{id:string}[]}>(api,'/api/memory-jobs');
 const allBusy=busy||integrationActivity?.api===api&&integrationActivity.busy;
 const currentJob=job?.id===work.jobId?job:undefined,own=currentJob?owned.current.items.get(currentJob.id):undefined;
 const running=!!currentJob&&(['queued','running','pausing'].includes(currentJob.status)||(currentJob.runningBatches??0)>0);
 const scopeTitle=(scope:Scope)=>scope.kind==='source'?scope.choice.title||moteText('原始记录'):scope.after+' — '+scope.before;
 const freshSnapshot=async(snapshot:Snapshot,signal:AbortSignal)=>{
  const body=JSON.parse(snapshot.body),model=await api.request<ModelSettingsView>('/api/model-settings',{signal});
  if(selectedModelPin(model,body.modelProfileId)!==snapshot.modelPin)throw Error(moteText('配置或方案已变化；请读取当前状态后重新确认。'));
  if(snapshot.scope.kind==='source'){
   const selected=snapshot.scope.choice;
   if(selected.kind==='material'){
    const id=selected.ref.match(/^material:(mat_[a-f0-9]{64})@[a-f0-9]{64}$/)?.[1];if(!id)throw Error(moteText('所选正式资料已变化或暂不可提取，请重新打开当前版本。'));
    const fresh=await api.request<Material>('/api/materials/'+encodeURIComponent(id),{signal});
    if(fresh.ref!==selected.ref||fresh.memorySource?.status!=='ready'||JSON.stringify(fresh.memorySource.evidenceIds)!==JSON.stringify(body.evidenceIds))throw Error(moteText('所选正式资料已变化或暂不可提取，请重新打开当前版本。'));
   }else{
    const id=parseEvidenceRef(selected.ref)?.id;if(!id)throw Error(moteText('所选资料无效，请重新打开原始记录。'));
    const fresh=await api.request<Capture&{libraryVersion?:string}>('/api/capture-browser/'+encodeURIComponent(id),{signal});
    if(fresh.id!==id||!snapshot.pin||fresh.libraryVersion!==snapshot.pin)throw Error(moteText('此版本已变化，请返回资料列表重新选择。'));
   }
  }
 };
 const refresh=()=>resources(api).invalidate(key=>/^\/api\/(memories|memory-jobs)([/?]|$)/.test(key));
 async function perform(fn:(signal:AbortSignal,current:()=>boolean)=>Promise<void>){
  if(request.current||busy)return;const ticket=visit.current,where=navigation.current,controller=new AbortController();request.current=controller;setActivity({api,token:launch.token,busy:true,scopeKey:workKey});onBusyChange?.(api,true);
  const current=()=>alive.current&&!controller.signal.aborted&&visit.current===ticket&&navigation.current===where;
  try{await fn(controller.signal,current);}catch(error){if(current())setActivity({api,token:launch.token,busy:true,error:errorMessage(error),scopeKey:workKey});}
  finally{if(request.current===controller){request.current=null;if(alive.current&&visit.current===ticket){setActivity(value=>({...value,api,token:launch.token,busy:false}));onBusyChange?.(api,false);}}}
 }
 async function submit(saved?:Snapshot){
  if(!saved&&(choice&&!readable||!models.data||models.error||models.loading||running))return;
  await perform(async(signal,current)=>{
   const body=saved?.body??JSON.stringify({... (choice?{evidenceIds:choice.kind==='material'?material.data!.memorySource!.evidenceIds:[captureId]}:work.scope.kind==='range'?{...captureDateRange(work.scope.after,work.scope.before),...(work.scope.deviceId?{deviceId:work.scope.deviceId}:{})}:{}),...(options.recipes.length?{recipes:options.recipes}:{}),modelProfileId:options.model||undefined,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
   const snapshot=saved??{body,scope:structuredClone(work.scope),pin:choice?.kind==='capture'?sourcePin:undefined,modelPin:selectedModelPin(models.data!,options.model||undefined)};
   await freshSnapshot(snapshot,signal);if(!current())return;
   const result=await api.request<{id:string}>('/api/memory-jobs',{method:'POST',body:snapshot.body,signal});
   if(typeof result.id!=='string'||!result.id.trim())throw Error(moteText('中央响应格式无效，请刷新后重试。'));if(visit.current.api!==api||signal.aborted)return;owned.current.items.set(result.id,snapshot);refresh();if(current())change({view:'job',jobId:result.id,scope:snapshot.scope});
  });
 }
 async function control(action:'pause'|'resume'|'cancel'|'retry'){
  if(!currentJob)return;const id=currentJob.id;
  await perform(async(signal,current)=>{await api.request('/api/memory-jobs/'+encodeURIComponent(id)+'/'+action,{method:'POST',signal});if(current()){reloadJob();refresh();}});
 }
 const canRetry=!!currentJob&&currentJob.outcome!=='input_invalidated'&&!['cancelled','paused','pausing','running','queued'].includes(currentJob.status)&&(currentJob.inputPlans.blocked>0||currentJob.failedBatches>0||currentJob.status==='waiting_for_model');
 const error=currentActivity?.scopeKey===workKey?currentActivity?.error:undefined;
 const title=work.view==='integration'?moteText('整理这条记忆'):work.view==='integrate-entry'?moteText('手动整理记忆'):moteText('手动提取记忆');
 return <section className="memory-workspace-final" aria-label={title}>
  <header><h1>{title}</h1><button className="text-button" onClick={()=>work.view==='extract-entry'||work.view==='integrate-entry'||work.view==='integration'&&!!launch.candidate?onClose():change({view:work.view==='integration'?'integrate-entry':'extract-entry'})}>← {moteText('返回')}</button></header>
  {error&&<div role="alert" className="memory-work-error"><p>{error}</p></div>}
  {work.view==='extract-entry'&&<><button className="button" disabled={busy} onClick={()=>change({view:'range',scope:chosenRange})}>{moteText('按时间范围提取')}</button><MemoryWorkChoices api={api} kind="extract" deviceId={range.deviceId} disabled={allBusy} onMaterial={choice=>change({view:'source',scope:{kind:'source',choice}})} onMemory={()=>{}}/><button className="text-button" onClick={()=>change({view:'job',jobId:work.jobId??launch.jobId??recent.data?.items[0]?.id})}>{moteText('查看最近的处理')}</button></>}
  {work.view==='integrate-entry'&&<><MemoryWorkChoices api={api} kind="integrate" deviceId={range.deviceId} disabled={allBusy} onMaterial={()=>{}} onMemory={candidate=>change({view:'integration',candidate})}/><button className="text-button" onClick={()=>change({view:'integration'})}>{moteText('查看最近的处理')}</button></>}
  {(work.view==='range'||work.view==='source')&&<form className="memory-work-scope" onSubmit={event=>{event.preventDefault();void submit();}}>
   {work.scope.kind==='range'?<div className="memory-work-dates"><label>{moteText('开始日期')}<input type="date" disabled={allBusy} required value={work.scope.after} max={work.scope.before||undefined} onChange={event=>changeRange({...work.scope as Extract<Scope,{kind:'range'}>,after:event.target.value})}/></label><label>{moteText('结束日期')}<input type="date" disabled={allBusy} required min={work.scope.after||undefined} value={work.scope.before} onChange={event=>changeRange({...work.scope as Extract<Scope,{kind:'range'}>,before:event.target.value})}/></label></div>:<div className="memory-work-scope-notice"><strong>{work.scope.choice.title||material.data?.title||source.data?.windowTitle||source.data?.appName||moteText('原始记录')}</strong><p>{moteText('本次只提取这份资料。')}</p>{!source.data&&!material.data&&(source.loading||material.loading)&&<p role="status">{moteText('正在读取…')}</p>}<button type="button" className="text-button" onClick={()=>onOpen(work.scope.kind==='source'?work.scope.choice.ref:'')}>{moteText('查看原文')}</button>{!readable&&!source.loading&&!material.loading&&<p role="alert">{source.error||material.error?errorMessage(source.error||material.error):!captureId&&!materialId?moteText('所选资料无效，请重新打开原始记录。'):choice?.kind==='material'?moteText('所选正式资料已变化或暂不可提取，请重新打开当前版本。'):moteText('此版本已变化，请返回资料列表重新选择。')}</p>}</div>}
   <details className="memory-processing-options"><summary>{moteText('处理选项')}</summary><ModelSelector api={api} feature="memory" detachedFromForm value={options.model} onChange={model=>setSettings({...options,model})} disabled={busy||running}/><ManualMemoryRecipes api={api} value={options.recipes} onChange={recipes=>setSettings({...options,recipes})} disabled={busy||running}/></details>
   {Boolean(models.error)&&<p role="alert">{errorMessage(models.error)}<button type="button" className="text-button" onClick={models.refresh}>{moteText('重新读取')}</button></p>}
   <button className="button primary" type="submit" disabled={busy||running||!!choice&&!readable||!models.data||!!models.error||models.loading}>{busy?moteText('正在提交…'):moteText('开始提取')}</button>
  </form>}
  <div hidden={work.view!=='integration'}><MemoryIntegration api={api} candidate={work.candidate} verificationPending={verificationPending} presentation="workspace" active={active&&work.view==='integration'} onBusyChange={(owner,busy)=>{if(visit.current.api===owner){setIntegrationActivity({api:owner,busy});onBusyChange?.(owner,busy);}}}/></div>
  {work.view==='job'&&<section className="memory-work-job">
   {jobError&&<p role="alert">{moteText('记忆进度暂时无法更新：')}{jobError}<button className="text-button" onClick={reloadJob}>{moteText('重新读取')}</button></p>}
   {!work.jobId&&<p>{moteText('暂无处理任务')}</p>}{work.jobId&&!currentJob&&!jobError&&<p role="status">{moteText('正在读取…')}</p>}
   {currentJob&&<><div className="memory-work-job-status" role="status"><strong>{memoryJobLabel(currentJob)}</strong>{currentJob.errorCode&&currentJob.status!=='cancelled'&&<p>{failureMessage(currentJob.execution?.failure??currentJob.errorCode)}</p>}{currentJob.outcome==='input_invalidated'&&<p>{moteText('历史结果保留；请查看当前资料版本。失效输入不能直接重试。')}</p>}{currentJob.status==='cancelled'&&(currentJob.runningBatches??0)>0&&<p>{moteText('已取消剩余批次，当前批次完成后停止。已保存结果保留。')}</p>}{currentJob.status==='completed'&&!currentJob.memoryIds.length&&<p>{moteText('已完成，本次没有发现需要新增的记忆。')}</p>}</div><div className="memory-work-actions"><button className="button" disabled={busy} onClick={reloadJob}>{moteText('刷新')}</button>{['queued','running','waiting_for_input'].includes(currentJob.status)&&<button className="text-button" disabled={busy} onClick={()=>void control('pause')}>{moteText('当前批次结束后暂停')}</button>}{['paused','pausing'].includes(currentJob.status)&&<button className="button" disabled={busy} onClick={()=>void control('resume')}>{moteText('继续整理')}</button>}{currentJob.outcome!=='input_invalidated'&&!['completed','cancelled'].includes(currentJob.status)&&<button className="text-button" disabled={busy} onClick={()=>void control('cancel')}>{moteText('取消未完成方案')}</button>}{canRetry&&<button className="button" disabled={busy} onClick={()=>void control('retry')}>{moteText('重新检查未完成方案')}</button>}{currentJob.status==='cancelled'&&own&&<button className="button" disabled={busy||(currentJob.runningBatches??0)>0} onClick={()=>void submit(own)}>{moteText('重试')}</button>}{currentJob.memoryIds.length>0&&<button className="button" onClick={()=>onViewMemory(currentJob.memoryIds[0])}>{moteText('查看记忆')}</button>}</div>
   {currentJob.status==='cancelled'&&own&&<p>{moteText('重试会提交新的提取任务；已取消任务和已有成果保留。')}</p>}<details className="memory-work-scope-details"><summary>{moteText('本次范围')}</summary><p>{own?scopeTitle(own.scope):moteText('未记录')}</p><small>{dateTime(currentJob.createdAt)}</small></details><details className="memory-work-job-details"><summary>{moteText('处理详情')}</summary><p><code>{currentJob.id}</code></p><MemoryProgress job={currentJob} onAction={action=>void control(action)} onRetry={()=>void control('retry')} onView={()=>{if(currentJob.memoryIds[0])onViewMemory(currentJob.memoryIds[0]);}} onOpen={onOpen} busy={busy}/></details></>}
  </section>}
 </section>;
}
