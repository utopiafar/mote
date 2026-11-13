import {useEffect,useMemo,useRef,useState} from 'react';
import {featureRequirementsAvailable,queryScopeSchema,type FeatureInventory,type FileCoverage,type QueryScope,type SourceConnection} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {ApiError,errorMessage,type Api} from '../../api';
import {failureMessage} from '../../failure-message';
import {Loading} from '../../Loading';
import {resources} from '../../resource-cache';
import {useResource} from '../../useResource';
import type {Material} from '../../Materials';
import {FileRetentionNote,fileRetentionLabel} from '../reader/FileStatus';

type CoverageCounts={completed:number;total:number;partial?:number;pending?:number;failed?:number;unsupported?:number;reason?:string};
type OnboardingItem={material:{ref:string;title:string;sourceId:string};state:'completed'|'cancelled'|'failed'|'pending';
 coverage:{sync:FileCoverage;extraction:FileCoverage;semantic:FileCoverage};reason?:string;
 memory?:{id:string;status:string;completedBatches:number;totalBatches:number}};
type OnboardingView={id:string;revision:number;state:'cancelled'|'empty'|'completed'|'failed'|'pending';
 coverage:{sync:CoverageCounts;extraction:CoverageCounts;semantic:CoverageCounts};
 completed:number;pending:number;failed:number;cancelled:number;items:OnboardingItem[]};
type StoredRun={id:string;scope:QueryScope};
type MaterialPage={items:Material[];nextCursor:string|null};

const onboardingCapabilities=['http:POST:/api/assistant/onboarding','http:GET:/api/assistant/onboarding/:id','http:POST:/api/assistant/onboarding/:id/cancel'];
const maxSelection=100;
const statusLabels:Record<FileCoverage['status'],string>={pending:moteText('等待处理'),partial:moteText('部分内容'),ready:moteText('处理完成'),failed:moteText('处理失败'),unsupported:moteText('不可用')};
const reasonLabels:Record<string,string>={extraction_failed:moteText('原文提取未完成，请查看来源与处理状态。'),original_body_unavailable:moteText('原文提取未完成，请查看来源与处理状态。'),
 memory_processing_unavailable:moteText('理解没有完成，请检查模型与服务后重试。'),memory_processing_failed:moteText('理解没有完成，请检查模型与服务后重试。'),
 assistant_analysis_changed:moteText('理解没有完成，请检查模型与服务后重试。'),assistant_analysis_failed:moteText('理解没有完成，请检查模型与服务后重试。'),
 understanding_input_changed:moteText('理解没有完成，请检查模型与服务后重试。'),understanding_input_limit:moteText('这次选择的资料超过单次处理上限，请减少选择后重试。'),
 understanding_unavailable:moteText('理解没有完成，请检查模型与服务后重试。')};
const modelReasons=new Set(['model_unconfigured','model_not_configured','provider_not_configured','provider_authentication','provider_quota','provider_endpoint','provider_unavailable','model_profile_missing']);

function readStoredRun():StoredRun|undefined{
 try{const value=JSON.parse(window.localStorage.getItem(storageKey())??'null') as {id?:unknown;scope?:unknown}|null;
  if(!value||typeof value.id!=='string')return;
  const scope=queryScopeSchema.safeParse(value.scope);return scope.success?{id:value.id,scope:scope.data}:undefined;
 }catch{return}
}
function writeStoredRun(run:StoredRun|undefined){
 try{if(run)window.localStorage.setItem(storageKey(),JSON.stringify(run));else window.localStorage.removeItem(storageKey());}catch{/* local storage is optional */}
}
function storageKey(){return 'mote.assistant.onboarding.'+window.location.origin;}
function selectedScope(values:readonly {origin:{sourceId:string}}[]):QueryScope{
 return {kind:'selection',sourceIds:[...new Set(values.map(value=>value.origin.sourceId))].sort()};
}
function stageState(value:CoverageCounts):FileCoverage['status']{
 if(!value.total)return 'unsupported';
 if(value.completed===value.total)return 'ready';
 if(value.failed&&!value.completed)return 'failed';
 if(value.partial||value.completed)return 'partial';
 return 'pending';
}
function extractionStatus(material:Material):FileCoverage['status']{
 const extracted=material.artifacts?.find(value=>value.key==='extracted-text'),body=material.artifacts?.find(value=>value.key==='source-body');
 if(material.coverage.reason==='original_body_not_collected')return 'unsupported';
 if(extracted?.state==='failed')return 'failed';
 if(extracted?.state==='pending')return 'pending';
 if(extracted?.state==='unavailable')return 'partial';
 if(body?.state==='unavailable'&&!extracted)return 'unsupported';
 if(material.coverage.state==='complete')return 'ready';
 if(material.coverage.state==='partial')return 'partial';
 return 'pending';
}
function countLabel(value:CoverageCounts){
 return `${value.completed} / ${value.total}`;
}
function gapLabel(value:CoverageCounts){
 const parts:string[]=[];
 if(value.pending)parts.push(moteText('等待处理')+' '+value.pending);
 if(value.partial)parts.push(moteText('部分内容')+' '+value.partial);
 if(value.failed)parts.push(moteText('处理失败')+' '+value.failed);
 if(value.unsupported)parts.push(moteText('不可用')+' '+value.unsupported);
 return parts.join(' · ');
}
function reasonText(reason:string|undefined){
 if(!reason)return '';
 return reasonLabels[reason]??failureMessage(reason);
}
function itemStateLabel(state:OnboardingItem['state']){
 return state==='completed'?moteText('已完成'):state==='cancelled'?moteText('已取消'):state==='failed'?moteText('处理失败'):moteText('等待处理');
}
function sourceCanProvideBody(source:SourceConnection|undefined){
 return !source||source.retention!=='reference';
}
function parseOnboarding(value:unknown):OnboardingView{
 if(!value||typeof value!=='object')throw Error(moteText('中央响应格式无效，请刷新后重试。'));
 const view=value as Partial<OnboardingView>;
 if(typeof view.id!=='string'||typeof view.revision!=='number'||!view.coverage||!Array.isArray(view.items))throw Error(moteText('中央响应格式无效，请刷新后重试。'));
 if(!view.coverage.sync||!view.coverage.extraction||!view.coverage.semantic)throw Error(moteText('中央响应格式无效，请刷新后重试。'));
 if(!view.items.every(item=>item&&typeof item==='object'&&typeof (item as OnboardingItem).material?.ref==='string'&&typeof (item as OnboardingItem).material?.title==='string'&&typeof (item as OnboardingItem).material?.sourceId==='string'&&
  typeof (item as OnboardingItem).coverage?.sync?.status==='string'&&typeof (item as OnboardingItem).coverage?.extraction?.status==='string'&&typeof (item as OnboardingItem).coverage?.semantic?.status==='string'))throw Error(moteText('中央响应格式无效，请刷新后重试。'));
 return view as OnboardingView;
}

/** The connection's value comes first; the concrete material selection and
 * retention facts follow. This panel never grants model access: starting an
 * onboarding is an explicit owner command through A6's existing route. */
export function SourceOnboarding({api,sources,onAdd,loading=false}:{api:Api;sources:SourceConnection[];onAdd?:()=>void;loading?:boolean}){
 const features=useResource<FeatureInventory>(api,'/api/features',5000);
 const supported=features.error===undefined&&typeof features.data!=='undefined'&&featureRequirementsAvailable(onboardingCapabilities,features.data);
 const authorization=useResource<{authorization:{state:'on'|'off';excludedSourceIds:string[]}}>(api,supported?'/api/model-authorization':null);
 const [sourceFilter,setSourceFilter]=useState('');
 const [selectedRefs,setSelectedRefs]=useState<string[]>([]);
 const [storedRun,setRun]=useState<StoredRun|undefined>(readStoredRun);
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const [arrived,setArrived]=useState(false);
 const request=useRef<AbortController|null>(null),requestId=useRef<{key:string;id:string}|undefined>(undefined),knownRefs=useRef<{filter:string;refs:Set<string>}|undefined>(undefined);
 const activeApi=useRef(api);activeApi.current=api;
 const materialsPath=supported?'/api/materials?limit=100'+(sourceFilter?'&sourceId='+encodeURIComponent(sourceFilter):''):null;
 const materialRead=useResource<MaterialPage>(api,materialsPath,supported?5000:undefined);
 const runPath=supported&&storedRun?'/api/assistant/onboarding/'+encodeURIComponent(storedRun.id)+'?scope='+encodeURIComponent(JSON.stringify(storedRun.scope)):null;
 const runRead=useResource<unknown>(api,runPath,supported&&storedRun?3000:undefined);
 const view=useMemo(()=>{if(runRead.data===undefined)return;try{return parseOnboarding(runRead.data);}catch(error){return error instanceof Error?error:new Error(moteText('中央响应格式无效，请刷新后重试。'));}},[runRead.data]);
 const run=view instanceof Error?undefined:view;
 const runFailure=view instanceof Error?view:undefined;
 const sourcesById=useMemo(()=>new Map(sources.map(source=>[source.id,source])),[sources]);
 const materialItems=useMemo(()=>materialRead.data?.items??[],[materialRead.data]);
 const visibleMaterials=useMemo(()=>materialItems.filter(material=>sourcesById.has(material.origin.sourceId)&&(!sourceFilter||material.origin.sourceId===sourceFilter)),[materialItems,sourcesById,sourceFilter]);
 const selectedMaterials=useMemo(()=>visibleMaterials.filter(material=>selectedRefs.includes(material.ref)),[visibleMaterials,selectedRefs]);
 const resumable=run?.items.filter(item=>item.state!=='completed')??[];
 const terminal=Boolean(run&&['completed','cancelled','failed','empty'].includes(run.state));
 const active=Boolean(storedRun)&&!terminal&&runFailure===undefined&&runRead.error===undefined;
 const syncing=sources.filter(source=>source.status?.state==='syncing').length,attention=sources.filter(source=>['error','permission_required'].includes(source.status?.state??'')).length;
 const revoked=sources.filter(source=>source.status?.state==='permission_required').length,otherAttention=attention-revoked;
 const syncGaps=[syncing?moteText('同步中')+' '+syncing:'',revoked?moteText('需要重新授权')+' '+revoked:'',otherAttention?moteText('需要处理')+' '+otherAttention:''].filter(Boolean).join(' · ');
 const extractionCounts=useMemo(()=>visibleMaterials.reduce((counts,material)=>{counts[extractionStatus(material)]++;return counts;},{pending:0,partial:0,ready:0,failed:0,unsupported:0}),[visibleMaterials]);
 const extractionTotal=visibleMaterials.length;
 const readyExtraction=extractionCounts.ready;
 const readError=materialRead.error??runFailure,technicalError=error||(readError?errorMessage(readError):''),visibleError=error||(readError?moteText('状态读取失败。'):'');
 const selectedSources=selectedMaterials.map(material=>sourcesById.get(material.origin.sourceId)).filter((source):source is SourceConnection=>Boolean(source));
 const selectedInvalid=selectedMaterials.some(material=>{const source=sourcesById.get(material.origin.sourceId),extraction=extractionStatus(material);return !sourceCanProvideBody(source)||extraction==='unsupported'||extraction==='failed';});
 const modelOff=authorization.error===undefined&&authorization.data?.authorization.state==='off';
 const modelOn=authorization.error===undefined&&authorization.data?.authorization.state==='on';

 useEffect(()=>{setBusy(false);setError('');setSourceFilter('');setSelectedRefs([]);setArrived(false);knownRefs.current=undefined;setRun(readStoredRun());return()=>{request.current?.abort();request.current=null;};},[api]);
 useEffect(()=>{if(!selectedRefs.length)return;const allowed=new Set(visibleMaterials.map(material=>material.ref));const next=selectedRefs.filter(ref=>allowed.has(ref));if(next.length!==selectedRefs.length)setSelectedRefs(next);},[visibleMaterials,selectedRefs]);
 useEffect(()=>{
  if(storedRun&&runRead.error instanceof ApiError&&[401,403,404,410].includes(runRead.error.status)){setRun(undefined);writeStoredRun(undefined);}
 },[storedRun,runRead.error]);
 useEffect(()=>{
  if(!materialRead.data)return;
  const filter=sourceFilter||'',refs=new Set(visibleMaterials.map(material=>material.ref));
  if(knownRefs.current?.filter!==filter){knownRefs.current={filter,refs};setArrived(false);return;}
  if([...refs].some(ref=>!knownRefs.current!.refs.has(ref)))setArrived(true);
  knownRefs.current={filter,refs};
 },[materialRead.data,visibleMaterials,sourceFilter]);
 function nextRequestId(key:string){if(requestId.current?.key!==key)requestId.current={key,id:crypto.randomUUID()};return requestId.current.id;}
 async function start(refs:string[],scope:QueryScope,key:string){
  if(busy||!supported||!refs.length||request.current)return;
  const controller=new AbortController();request.current=controller;setBusy(true);setError('');
  try{
   const value=parseOnboarding(await api.request<unknown>('/api/assistant/onboarding',{method:'POST',body:JSON.stringify({requestId:nextRequestId(key),scope,materialRefs:refs}),signal:controller.signal}));
   if(controller.signal.aborted||request.current!==controller||activeApi.current!==api)return;
   requestId.current=undefined;const stored={id:value.id,scope};setRun(stored);writeStoredRun(stored);setArrived(false);
   resources(api).invalidate(path=>path.startsWith('/api/assistant/onboarding/'));
  }catch(reason){if(!controller.signal.aborted&&request.current===controller)setError(reason instanceof ApiError&&reason.status===409?failureMessage('conflict'):errorMessage(reason));}
  finally{if(request.current===controller){request.current=null;setBusy(false);}}
 }
 async function cancel(){
  const current=run,scope=storedRun?.scope;if(!current||!scope||busy||request.current)return;
  const controller=new AbortController();request.current=controller;setBusy(true);setError('');
  try{await api.request('/api/assistant/onboarding/'+encodeURIComponent(current.id)+'/cancel',{method:'POST',body:JSON.stringify({expectedRevision:current.revision,scope}),signal:controller.signal});
   if(controller.signal.aborted||request.current!==controller||activeApi.current!==api)return;runRead.refresh();
  }catch(reason){if(!controller.signal.aborted&&request.current===controller)setError(reason instanceof ApiError&&reason.status===409?failureMessage('conflict'):errorMessage(reason));}
  finally{if(request.current===controller){request.current=null;setBusy(false);}}
 }
 function startSelected(){
  if(selectedInvalid)return;
  const scope=selectedScope(selectedMaterials),key=JSON.stringify([scope,selectedRefs]);
  void start(selectedRefs,scope,key);
 }
 function continueRun(){
  if(!run||!resumable.length)return;
  const scope=selectedScope(resumable.map(item=>({origin:{sourceId:item.material.sourceId}})));
  void start(resumable.map(item=>item.material.ref),scope,'continue:'+run.id+':'+resumable.map(item=>item.material.ref).join(','));
 }
 function toggle(ref:string,enabled:boolean){
  if(active)return;
  setSelectedRefs(values=>values.includes(ref)?values.filter(value=>value!==ref):!enabled||values.length>=maxSelection?values:[...values,ref]);
 }
 if(features.error!==undefined)return null;
 if(features.data===undefined)return <section className="source-onboarding" aria-label={moteText('初次认识')} aria-busy="true"><Loading/></section>;
 return <section className="source-onboarding" aria-label={moteText('初次认识')} data-onboarding-panel>
  <header className="source-onboarding-intro">
   <div><p className="eyebrow">{moteText('连接能带来什么')}</p><h2>{moteText('初次认识')}</h2><p>{moteText('连接成功后，Mote 可以先从你选的一小部分资料开始认识你。')}</p></div>
   <ul className="source-onboarding-value">
    <li>{moteText('把文件和记录变成可查的资料库')}</li>
    <li>{moteText('记住人物、事项和承诺，回答时引用原文')}</li>
    <li>{moteText('发现最近在忙什么，并给出下一步')}</li>
    <li>{moteText('新资料到达后更新相关事项，而不是只多一个文件')}</li>
   </ul>
  </header>
  <div className="source-onboarding-boundary"><strong>{moteText('连接成功只表示可以同步，不代表全库已经理解。')}</strong><p>{moteText('这里只决定本次初次认识读取哪些已同步资料，不改变来源授权或保存方式。')}</p></div>
  <div className="source-onboarding-progress" aria-label={moteText('处理进度')}>
   <div className="source-onboarding-stage" data-stage="sync" data-state={syncing?'pending':attention?'failed':'ready'}><strong>{moteText('同步')}</strong>
    {run?<><span>{countLabel(run.coverage.sync)}</span><small>{gapLabel(run.coverage.sync)}</small></>:<><span>{sources.length?moteText('已连接')+' '+sources.length:loading?moteText('正在读取来源…'):moteText('未连接')}</span><small>{syncGaps}</small></>}
   </div>
   <div className="source-onboarding-stage" data-stage="extraction" data-state={run?stageState(run.coverage.extraction):extractionTotal?readyExtraction===extractionTotal?'ready':readyExtraction?'partial':'pending':'unsupported'}><strong>{moteText('正文提取')}</strong>
    {run?<><span>{countLabel(run.coverage.extraction)}</span><small>{gapLabel(run.coverage.extraction)}</small></>:<><span>{extractionTotal?readyExtraction+' / '+extractionTotal:moteText('尚未开始')}</span>{extractionTotal>0&&<small>{gapLabel({completed:readyExtraction,total:extractionTotal,pending:extractionCounts.pending,partial:extractionCounts.partial,failed:extractionCounts.failed,unsupported:extractionCounts.unsupported})}</small>}</>}
   </div>
   <div className="source-onboarding-stage" data-stage="semantic" data-state={run?stageState(run.coverage.semantic):'unsupported'}><strong>{moteText('语义理解')}</strong>
    {run?<><span>{countLabel(run.coverage.semantic)}</span><small>{gapLabel(run.coverage.semantic)}</small></>:<><span>{moteText('尚未开始')}</span><small>{moteText('同步、正文提取和语义理解分别计算；连接或提取完成不等于语义理解完成。')}</small></>}
   </div>
  </div>
  {(modelOff||modelOn)&&<aside className="source-onboarding-model" role="status"><strong>{moteText(modelOff?'后台模型已关闭':'后台模型已开启')}</strong><p>{moteText(modelOff?'初次认识由你手动开始，仍会使用当前模型配置。':'初次认识仍只处理你选择的资料。')}</p><p>{moteText('后台开关不改变采集设置，也不代表某项任务正在运行。')}</p></aside>}
  {!supported?<p className="source-onboarding-unavailable" role="status">{moteText('初次认识暂不可用，仍可继续使用已同步的资料。')}</p>:<>
   <div className="source-onboarding-choice">
    <div className="source-onboarding-filter"><label>{moteText('来源')}<select aria-label={moteText('来源')} value={sourceFilter} disabled={busy||active} onChange={event=>setSourceFilter(event.target.value)}><option value="">{moteText('全部来源')}</option>{sources.map(source=><option key={source.id} value={source.id}>{source.name}</option>)}</select></label>
     <button className="button subtle" type="button" disabled={busy||materialRead.loading} onClick={()=>{materialRead.refresh();if(storedRun)runRead.refresh();}}>{moteText('刷新资料')}</button></div>
    <p className="fine-print">{moteText('已选资料')} {selectedRefs.length} · {moteText('来源')} {selectedSources.length}{selectedRefs.length>=maxSelection?' · '+moteText('一次最多选择 100 份资料。'):''}</p>
    {selectedRefs.length>0&&<p className="fine-print">{moteText('本次仅处理已选的 {0} 份资料。',selectedRefs.length)}</p>}
    {arrived&&<p className="source-onboarding-arrival" role="status">{moteText('有新资料到达，可选择后再次开始初次认识。')}</p>}
    {sources.length===0?<div className="source-onboarding-empty">{loading?<Loading/>:<><p>{moteText('还没有资料。连接来源或导入文件后，它们会出现在这里。')}</p>{onAdd&&<button className="button" type="button" onClick={onAdd}>{moteText('添加来源')}</button>}</>}</div>:visibleMaterials.length===0?<div className="source-onboarding-empty">{materialRead.loading?<Loading/>:moteText('此列表暂无原始记录；已有资料可在资料库查看。')}</div>:<ul className="source-onboarding-materials" aria-label={moteText('选择资料')}>{visibleMaterials.map(material=>{const source=sourcesById.get(material.origin.sourceId),extraction=extractionStatus(material),selectable=sourceCanProvideBody(source)&&extraction!=='unsupported'&&extraction!=='failed';return <li key={material.ref} className="source-onboarding-material" data-material-ref={material.ref}><label><input type="checkbox" checked={selectedRefs.includes(material.ref)} disabled={busy||active||!selectedRefs.includes(material.ref)&&(!selectable||selectedRefs.length>=maxSelection)} onChange={()=>toggle(material.ref,selectable)}/><span><strong>{material.title||moteText('未命名记录')}</strong><small>{source?.name??material.origin.sourceId} · {fileRetentionLabel(source?.retention??'snapshot')} · {moteText('正文提取')} {statusLabels[extraction]}</small>{!selectable&&<small>{source?.retention==='reference'?moteText('仅保存引用，未导入正文'):moteText('正文不可用，暂不能用于初次认识')}</small>}</span></label></li>;})}</ul>}
    <p className="fine-print">{moteText('保存方式沿用来源设置；需要更改时打开该来源的「连接与范围」。')}</p>
    <dl className="source-onboarding-retention"><dt>{moteText('保存方式')}</dt>{sources.map(source=><dd key={source.id}><span>{source.name} · {fileRetentionLabel(source.retention)}</span><a href={'#/connections?sourceId='+encodeURIComponent(source.id)}>{moteText('连接与范围')}</a></dd>)}</dl>
    <FileRetentionNote/>
   </div>
   <div className="source-onboarding-actions">
    {active&&<button className="button" type="button" disabled={busy} onClick={()=>void cancel()}>{moteText('取消初次认识')}</button>}
    {resumable.length>0&&<button className="button primary" type="button" disabled={busy} onClick={continueRun}>{moteText('继续初次认识')}</button>}
    {!active&&<button className={resumable.length>0?'button subtle':'button primary'} type="button" disabled={busy||!selectedRefs.length||selectedInvalid} onClick={startSelected}>{moteText('开始初次认识')}</button>}
   </div>
   {resumable.length>0&&<p className="fine-print">{moteText('取消后已完成的结果会保留；继续只会处理未完成的资料。')}</p>}
   {run?.state==='empty'&&<p className="source-onboarding-unavailable" role="status">{moteText('所选资料当前不可读取，请检查来源授权后重新选择。')}</p>}
   {run?.state==='completed'&&<p className="source-onboarding-complete" role="status">{moteText('本次选择的资料已完成；其他资料未包含。')}</p>}
   {run&&run.items.length>0&&<ul className="source-onboarding-items" aria-label={moteText('本次资料')}>{run.items.map(item=><li key={item.material.ref} data-item-state={item.state}><div><strong>{item.material.title}</strong><span>{itemStateLabel(item.state)}</span></div><small>{moteText('正文提取')} · {statusLabels[item.coverage.extraction.status]} · {moteText('语义理解')} · {statusLabels[item.coverage.semantic.status]}</small>{item.reason&&<p>{reasonText(item.reason)}{modelReasons.has(item.reason)&&<> · <a className="text-button" href="#/system/models">{moteText('检查模型连接 →')}</a></>}</p>}{item.memory&&item.memory.status!=='completed'&&<small>{moteText('处理中')} · {item.memory.completedBatches} / {item.memory.totalBatches}</small>}</li>)}</ul>}
   {visibleError&&<div className="source-onboarding-error"><p role="alert">{visibleError}</p>{technicalError&&<details><summary>{moteText('技术详情')}</summary><pre>{technicalError}</pre></details>}{error&&<a className="text-button" href="#/system/models">{moteText('检查模型连接 →')}</a>}</div>}
  </>}
 </section>;
}
