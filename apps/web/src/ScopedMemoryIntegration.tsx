import {useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {ApiError,type Api,errorMessage} from './api';
import {useResource} from './useResource';
import {resources} from './resource-cache';
import {currentIntegrationCandidate,type IntegrationCandidate} from './MemoryIntegration';
import {ScopedMemoryProgress,useScopedMemoryJob,scopedMemoryState} from './ScopedMemoryProgress';
import {readIntegrationIntent,saveIntegrationIntent,type IntegrationIntent} from './memory-integration-intent';

type Recipe={id:string;version:string;available:boolean};
type Models={personal:{id:string;name:string;settings:{model?:string;agentTimeoutMs?:number|null}}[];shared:{id:string;name:string;model:string}[];selections:{memory?:{kind:'personal'|'shared';id:string}}};
export function ScopedMemoryIntegration({api,candidate,verificationPending=false}:{api:Api;candidate?:IntegrationCandidate;verificationPending?:boolean}){
 const eligible=currentIntegrationCandidate(candidate),view=useResource<{settings:{lifecycle:{consolidation:{enabled:boolean;maxItems:number}}}}>(api,eligible?'/api/memory':null),recipes=useResource<{integrations:Recipe[]}>(api,eligible?'/api/memory/recipes':null),models=useResource<Models>(api,eligible?'/api/models':null);
 const [key,setKey]=useState(''),[intent,setIntent]=useState<IntegrationIntent>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0),mounted=useRef(false),controller=useRef<AbortController|undefined>(undefined),current=useRef(candidate);current.current=candidate;
 useEffect(()=>{mounted.current=true;setBusy(false);setError('');controller.current=undefined;try{setIntent(readIntegrationIntent(api));}catch(cause){setError(errorMessage(cause));}return()=>{mounted.current=false;controller.current?.abort();controller.current=undefined;};},[api]);
 const read=useScopedMemoryJob(api,intent?.operationId,revision),job=read.data,validJob=job&&job.id===intent?.operationId&&(job.state==='deleted'||job.phase==='integrate'&&job.automatic===false)?job:undefined,state=validJob?scopedMemoryState(validJob):undefined,active=!!validJob&&!['succeeded','cancelled','deleted'].includes(state!);
 const available=recipes.data?.integrations.filter(recipe=>recipe.available)??[],chosen=available.find(recipe=>recipe.id+'@'+recipe.version===key)??available[0],ref=models.data?.selections.memory,profile=ref?.kind==='personal'?models.data?.personal.find(profile=>profile.id===ref.id):ref?.kind==='shared'?models.data?.shared.find(profile=>profile.id===ref.id):undefined,model=profile&&('settings'in profile?profile.settings.model:profile.model),timeout=profile&&'settings'in profile?profile.settings.agentTimeoutMs:undefined,configured=!!profile&&!!model;
 const policy=view.data?.settings.lifecycle.consolidation,canStart=eligible&&!verificationPending&&!!chosen&&configured&&!!policy&&!busy&&!active&&!view.error&&!recipes.error&&!models.error&&(!intent||!!validJob&&['succeeded','cancelled','deleted'].includes(state!));
 const refresh=()=>{setRevision(value=>value+1);resources(api).invalidate(path=>path.startsWith('/api/memory/jobs')||path.startsWith('/api/memories'));};
 async function act(action:'start'|'retry-admission'|'pause'|'resume'|'retry'|'cancel'){
  if(!mounted.current||controller.current)return;const abort=new AbortController();controller.current=abort;setBusy(true);setError('');const live=()=>mounted.current&&!abort.signal.aborted;
  try{if(action==='start'||action==='retry-admission'){
    let selected=intent;if(action==='start'){
     if(!canStart||!candidate||!chosen)return;const fixed=candidate,fresh=await api.request<IntegrationCandidate>('/api/memories/'+encodeURIComponent(fixed.id),{signal:abort.signal});if(!live())return;
     if(!currentIntegrationCandidate(fresh)||fresh.id!==fixed.id||fresh.version!==fixed.version||fresh.fingerprint!==fixed.fingerprint||current.current?.id!==fixed.id||current.current?.version!==fixed.version||current.current?.fingerprint!==fixed.fingerprint){setError(moteText('所选记忆已变化，请刷新后重新选择。'));return;}
     selected={operationId:crypto.randomUUID(),recipe:{id:chosen.id,version:chosen.version},inputs:[{id:fixed.id,version:fixed.version!,fingerprint:fixed.fingerprint!}]};saveIntegrationIntent(api,selected);setIntent(selected);
    }
    if(!selected)return;const result=await api.request<{id:string}>('/api/memory-integrations',{method:'POST',body:JSON.stringify(selected),signal:abort.signal});if(!live())return;if(result.id!==selected.operationId)throw Error('Invalid Memory integration receipt');
   }else{if(!validJob)return;await api.request('/api/memory/jobs/'+encodeURIComponent(validJob.id)+'/'+action,{method:'POST',body:'{}',signal:abort.signal});if(!live())return;}
   refresh();
  }catch(cause){if(live()){setError(errorMessage(cause));refresh();}}
  finally{if(controller.current===abort)controller.current=undefined;if(live())setBusy(false);}
 }
 if(!eligible&&!intent)return null;
 const readError=read.error instanceof ApiError&&read.error.status===404?undefined:read.error;
 return <section id="manual-memory-integration" className="panel panel-pad memory-integration"><h2>{moteText('整理所选记忆')}</h2>
 {eligible&&<><p>{moteText('从当前精选记忆开始，模型会按需检索你仍可读取的相关资料和原文；结果可能为空，也可能产生经独立审核的新记忆。')}</p><p><strong>{candidate!.title}</strong> · {moteText('仅选择此卡作为整合起点')}</p><label>{moteText('整理方案')}<select aria-label={moteText('整理方案')} value={chosen?chosen.id+'@'+chosen.version:''} disabled={busy||active} onChange={event=>setKey(event.target.value)}>{available.length?available.map(recipe=><option key={recipe.id+'@'+recipe.version} value={recipe.id+'@'+recipe.version}>{recipe.id==='mote.memory-integration'?moteText('记忆整理'):recipe.id} · {moteText('版本 {0}',recipe.version)}</option>):<option value="">{moteText('没有可用的整理方案')}</option>}</select></label>
 <p>{moteText('使用 Memory 功能默认模型：{0}',configured?profile!.name+' · '+model:moteText('未配置'))}{' · '}{timeout===null?moteText('未设 Agent 总时限'):typeof timeout==='number'?moteText('Agent 总时限 {0} 秒',Math.round(timeout/1000)):moteText('时限未提供')}</p><p className="muted">{moteText('单次最多 {0} 条；自动整理当前{1}。手动运行不会开启自动整理。',policy?.maxItems??'—',policy?.enabled?moteText('已开启'):moteText('已关闭'))}</p><a className="button subtle" href="#/system/models">{moteText('前往模型与服务配置')}</a>
 {!configured&&!models.loading&&<p role="status">{moteText('先配置 Memory 功能默认模型，再开始手动整理。')}</p>}<div className="memory-actions"><button className="button primary" disabled={!canStart} onClick={()=>void act('start')}>{busy?moteText('正在提交…'):moteText('整理这条记忆')}</button></div></>}
 {Boolean(error||view.error||recipes.error||models.error||readError)&&<p role="alert" className="notice error">{error||errorMessage(view.error||recipes.error||models.error||readError)}</p>}
 {job&&!validJob&&<p role="alert">{moteText('所选记忆已变化，请刷新后重新选择。')}</p>}
 {intent&&read.error instanceof ApiError&&read.error.status===404&&<button className="button subtle" disabled={busy} onClick={()=>void act('retry-admission')}>{moteText('显式重试整理')}</button>}
 {validJob&&<><ScopedMemoryProgress job={validJob} busy={busy} onAction={action=>void act(action)}/>{active&&<button className="button subtle" disabled={busy} onClick={()=>void act('cancel')}>{moteText('取消整理')}</button>}{state==='succeeded'&&<p role="status">{moteText('本次手动整理已完成；请刷新记忆列表查看结果，零条新记忆也是有效结果。')}</p>}</>}
 </section>;
}
