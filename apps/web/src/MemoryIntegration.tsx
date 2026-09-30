import {useEffect,useRef,useState} from 'react';
import type {ModelSettingsView} from '@mote/shared/models';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage,dateTime} from './api';
import {useResource} from './useResource';

export type IntegrationCandidate={id:string;title:string;version?:number;fingerprint?:string;status:string;supersededBy?:string;validFrom?:string;validUntil?:string;admission?:{layer:string}};
type Recipe={id:string;version:string;available:boolean};
type LifecycleView={settings:{consolidation:{enabled:boolean;maxItems:number}};extensions:{id:string;status:string;error?:string;failures:number;maxAttempts?:number;retryAt?:number;active?:{id:string;manual:boolean;items:number;startedAt:number};lastRun?:{id:string;completedAt:number}}[]};
type Run={api:Api;id:string;title:string};

export function currentIntegrationCandidate(item:IntegrationCandidate|undefined,now=Date.now()){
  return !!item&&item.status==='published'&&item.admission?.layer==='memory'&&!item.supersededBy&&!!item.fingerprint&&!!item.version&&
    (!item.validFrom||Date.parse(item.validFrom)<=now)&&(!item.validUntil||Date.parse(item.validUntil)>now);
}

const statusLabels:Record<string,string>={pending:moteText('等待执行'),running:moteText('正在整理'),retry_wait:moteText('等待自动重试'),failed:moteText('整理失败'),cancelled:moteText('已取消')};
const recipeLabel=(item:Recipe)=>item.id==='mote.memory-integration'?moteText('记忆整理'):item.id;
export function MemoryIntegration({api,candidate,verificationPending=false}:{api:Api;candidate?:IntegrationCandidate;verificationPending?:boolean}){
  const eligible=currentIntegrationCandidate(candidate);
  const lifecycle=useResource<LifecycleView>(api,'/api/memory-settings',3000);
  const recipes=useResource<{items:Recipe[]}>(api,eligible?'/api/memory-integration-recipes':null);
  const models=useResource<ModelSettingsView>(api,eligible?'/api/model-settings':null);
  const [recipeKey,setRecipeKey]=useState(''),[run,setRun]=useState<Run>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const activeApi=useRef(api),currentCandidate=useRef(candidate),request=useRef<AbortController|null>(null);
  currentCandidate.current=candidate;
  useEffect(()=>{activeApi.current=api;setRun(undefined);setBusy(false);setError('');return()=>{request.current?.abort();request.current=null;};},[api]);
  const available=recipes.data?.items?.filter(item=>item.available)??[];
  const chosen=available.find(item=>item.id+'@'+item.version===recipeKey)??available[0];
  const state=lifecycle.data?.extensions?.find(item=>item.id==='consolidation'),active=state?.active;
  const manual=active?.manual===true,local=run?.api===api&&run.id===active?.id?run:undefined;
  const completed=run?.api===api&&run.id===state?.lastRun?.id&&!active;
  const defaultId=models.data?.defaults?.memory??'default';
  const profile=defaultId==='default'?{name:moteText('默认预设'),settings:models.data?.settings}:models.data?.profiles?.find(item=>item.id===defaultId);
  const model=models.data?.defaultModels?.memory||profile?.settings?.model;
  const timeout=profile?.settings?.agentTimeoutMs;
  const configured=!!model&&!!profile;
  const limit=lifecycle.data?.settings?.consolidation?.maxItems;
  const canSubmit=eligible&&!verificationPending&&!!chosen&&configured&&!!limit&&limit>=1&&(!active||state?.status==='cancelled')&&!busy&&!lifecycle.error&&!models.error&&!recipes.error;
  async function act(action:'start'|'cancel'|'retry'){
    if(busy||request.current||activeApi.current!==api)return;
    const controller=new AbortController();request.current=controller;setBusy(true);setError('');
    try{
      if(action==='start'){
        if(!canSubmit||!candidate||!chosen)return;
        const fresh=await api.request<IntegrationCandidate>('/api/memories/'+encodeURIComponent(candidate.id),{signal:controller.signal});
        if(controller.signal.aborted||activeApi.current!==api)return;
        const latest=currentCandidate.current;
        if(!latest||!currentIntegrationCandidate(latest)||latest.id!==candidate.id||latest.version!==candidate.version||latest.fingerprint!==candidate.fingerprint||
           !currentIntegrationCandidate(fresh)||fresh.id!==candidate.id||fresh.version!==candidate.version||fresh.fingerprint!==candidate.fingerprint){
          setError(moteText('所选记忆已变化，请刷新后重新选择。'));return;
        }
        const result=await api.request<{id:string}>('/api/memory-integrations',{method:'POST',body:JSON.stringify({recipe:{id:chosen.id,version:chosen.version},memoryIds:[candidate.id]}),signal:controller.signal});
        if(controller.signal.aborted||activeApi.current!==api)return;
        setRun({api,id:result.id,title:candidate.title});
      }else{
        if(!active?.id||!manual)return;
        await api.request('/api/memory-integrations/'+encodeURIComponent(active.id)+'/'+action,{method:'POST',signal:controller.signal});
      }
      if(!controller.signal.aborted&&activeApi.current===api)lifecycle.refresh();
    }catch(caught){if(!controller.signal.aborted&&activeApi.current===api)setError(errorMessage(caught));}
    finally{if(!controller.signal.aborted&&activeApi.current===api)setBusy(false);if(request.current===controller)request.current=null;}
  }
  if(!eligible&&!manual&&!completed)return null;
  return <section id="manual-memory-integration" className="panel panel-pad memory-integration">
    <h2>{moteText('整理所选记忆')}</h2>
    {eligible?<><p>{moteText('从当前精选记忆开始，模型会按需检索你仍可读取的相关资料和原文；结果可能为空，也可能产生经独立审核的新记忆。')}</p>
    <p><strong>{candidate!.title}</strong> · {moteText('仅选择此卡作为整合起点')}</p>
    <label>{moteText('整理方案')}<select aria-label={moteText('整理方案')} value={chosen?chosen.id+'@'+chosen.version:''} disabled={busy||!!active&&state?.status!=='cancelled'} onChange={event=>setRecipeKey(event.target.value)}>{available.length?available.map(item=><option key={item.id+'@'+item.version} value={item.id+'@'+item.version}>{recipeLabel(item)} · {moteText('版本 {0}',item.version)}</option>):<option value="">{moteText('没有可用的整理方案')}</option>}</select></label>
    <p>{moteText('使用 Memory 功能默认模型：{0}',configured?(profile!.name+' · '+model):moteText('未配置'))}{' · '}{timeout===null?moteText('未设 Agent 总时限'):typeof timeout==='number'?moteText('Agent 总时限 {0} 秒',Math.round(timeout/1000)):moteText('时限未提供')}</p>
    <p className="muted">{moteText('单次最多 {0} 条；自动整理当前{1}。手动运行不会开启自动整理。',limit??'—',lifecycle.data?.settings?.consolidation?.enabled?moteText('已开启'):moteText('已关闭'))}</p>
    <a className="button subtle" href="#/system/models">{moteText('前往模型与服务配置')}</a></>:<p className="muted">{moteText('请先选择一条当前有效的精选记忆。')}</p>}
    {(lifecycle.error||recipes.error||models.error||error)&&<p role="alert" className="notice error">{error||errorMessage(lifecycle.error||recipes.error||models.error)}</p>}
    {eligible&&!configured&&!models.loading&&<p role="status">{moteText('先配置 Memory 功能默认模型，再开始手动整理。')}</p>}
    {eligible&&<div className="memory-actions"><button className="button primary" disabled={!canSubmit} onClick={()=>void act('start')}>{busy?moteText('正在提交…'):moteText('整理这条记忆')}</button></div>}
    {active&&manual&&<div className="review-notes" role="status"><p>{local?moteText('本次所选：{0}',local.title):moteText('手动整理任务；当前卡片不是其已确认的输入。')}{' · '}{statusLabels[state!.status]??state!.status}{' · '}{moteText('{0} 条输入',active.items)}</p>{state?.status!=='cancelled'&&state?.error&&<p>{state.error}</p>}{state?.retryAt&&state.status==='retry_wait'&&<p>{moteText('预计重试时间：{0}',dateTime(new Date(state.retryAt).toISOString()))}</p>}<div className="memory-actions">{state?.status!=='cancelled'&&<button className="button subtle" disabled={busy} onClick={()=>void act('cancel')}>{moteText('取消整理')}</button>}{['failed','cancelled'].includes(state?.status??'')&&<button className="button subtle" disabled={busy} onClick={()=>void act('retry')}>{moteText('显式重试整理')}</button>}</div></div>}
    {active&&!manual&&state?.status!=='cancelled'&&<p className="muted" role="status">{moteText('自动整理窗口正在运行；请等待它结束后再提交手动整理。')}</p>}
    {completed&&<p role="status">{moteText('本次手动整理已完成；请刷新记忆列表查看结果，零条新记忆也是有效结果。')}</p>}
  </section>;
}
