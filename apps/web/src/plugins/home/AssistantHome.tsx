import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {featureRequirementsAvailable,formatEvidenceRef,type QueryScope,type WorkState} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {ApiError,dateTime,errorMessage,type Api} from '../../api';
import {discoveryAvailabilityText} from '../../DiscoveryLink';
import {Loading} from '../../Loading';
import {resources} from '../../resource-cache';
import {useResource} from '../../useResource';
import {useForegroundResources} from '../../useForegroundResources';
import {openOwnerQuestionList} from '../../owner-question-route';
import {AnswerView} from '../../shell-components';
import {AnswerMarkdown} from '../ask/AnswerMarkdown';
import type {AssistantTaskResultItem} from '../ask/AssistantTaskResults';
import {WorkStateBadge} from '../work/WorkProgress';
import type {HomeSnapshot} from './controller';
import {assistantCardPath,assistantScopeQuery,homeAssistantScope,type AssistantCard,type AssistantCardHistoryPage,type AssistantCardVersion} from './assistant-cards';

const cardLabels={activity:'动态',suggestion:'建议的下一步',briefing:'简报',artifact:'已保存成果',question:'需要你补充'};
const taskIdFromRoute=()=>new URLSearchParams(window.location.hash.split('?')[1]??'').get('assistantTask');

function Pages({page,count,next,loading,onPrevious,onNext}:{page:number;count:number;next?:string|null;loading:boolean;onPrevious:()=>void;onNext:(cursor:string)=>void}){
 return <nav className="list-pagination" aria-label={moteText('动态分页')}><span role="status">{moteText('第 {0} 页 · {1} 条',page,count)}</span><div>
  <button type="button" className="button" disabled={loading||page===1} onClick={onPrevious}>{moteText('上一页')}</button>
  <button type="button" className="button" disabled={loading||!next} onClick={()=>next&&onNext(next)}>{moteText('下一页')}</button>
 </div></nav>;
}

function CardBody({value,onEvidence}:{value:AssistantCardVersion;onEvidence:(id:string)=>void}){
 return <>
  {value.evidenceStale&&<p className="notice">{moteText('来源已变更')}</p>}
  <div className="home-assistant-body"><AnswerMarkdown answer={{answer:value.body,citations:[],runId:'',trace:[]}} onOpen={()=>{}} readOnly/></div>
  <details className="home-assistant-proof"><summary>{moteText('原文依据')} · {value.evidence.length}</summary>
   {value.evidence.map((proof,index)=><div key={proof.id+':'+index}><button type="button" className="text-button" onClick={()=>onEvidence(proof.id)}>{moteText('来源资料 {0}',index+1)}</button><blockquote>{proof.quote}</blockquote></div>)}
   {!value.evidence.length&&<p>{moteText('尚无原文依据。')}</p>}
  </details>
 </>;
}

function CardHistory({api,card,scope,onOpen}:{api:Api;card:AssistantCard;scope:QueryScope;onOpen:(ref:string)=>void}){
 const [cursors,setCursors]=useState<(string|undefined)[]>([undefined]),[error,setError]=useState('');
 const query=assistantScopeQuery(scope);query.set('limit','3');const cursor=cursors.at(-1);if(cursor)query.set('cursor',cursor);
 const path='/api/assistant-cards/'+encodeURIComponent(card.id)+'/history?'+query;
 const read=useResource<AssistantCardHistoryPage>(api,path,5000,card.version);
 useForegroundResources(api,[path]);
 const currentRevision=useRef(card.revision);currentRevision.current=card.revision;
 const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const open=async(version:string,id:string)=>{
  setError('');try{
   const latest=await api.request<AssistantCardHistoryPage>(path);
   if(active.current&&currentRevision.current===card.revision&&latest.items.some(item=>item.version===version&&item.evidence.some(proof=>proof.id===id)))onOpen(formatEvidenceRef('capture',id));
   else if(active.current){setError(moteText('原文已不可用，请重新读取。'));read.refresh();}
  }catch{if(active.current){setError(moteText('原文已不可用，请重新读取。'));read.refresh();}}
 };
 const items=read.error===undefined?read.data?.items:undefined;
 return <section className="home-assistant-history" aria-label={moteText('后续变化')}>
  {read.loading&&!read.data&&<Loading/>}
  {read.error!==undefined&&<p role="alert">{errorMessage(read.error)}<button type="button" className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>}
  {items?.map(item=><article key={item.version}><div className="home-assistant-meta"><span>{moteText('版本 {0}',item.version)}</span><time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time><span>{item.state==='resolved'?moteText('已解决'):moteText('待关注')}</span></div><h4>{item.title}</h4><CardBody value={item} onEvidence={id=>void open(item.version,id)}/></article>)}
  {items&&!items.length&&<p>{moteText('目前还没有进展记录。')}</p>}
  {error&&<p role="alert">{error}</p>}
  <Pages page={cursors.length} count={items?.length??0} next={read.error===undefined?read.data?.nextCursor:null} loading={read.loading} onPrevious={()=>setCursors(value=>value.length>1?value.slice(0,-1):value)} onNext={value=>setCursors(before=>[...before,value])}/>
 </section>;
}

function HomeTask({api,id,scope,supports,onOpen}:{api:Api;id:string;scope:QueryScope;supports:(capability:string)=>boolean;onOpen:(ref:string)=>void}){
 const path='/api/assistant/tasks/'+encodeURIComponent(id)+'?'+assistantScopeQuery(scope);
 const available=supports('http:GET:/api/assistant/tasks/:id');
 const read=useResource<AssistantTaskResultItem>(api,available?path:null,2000);
 useForegroundResources(api,[available?path:null]);
 const [error,setError]=useState('');const active=useRef(true);useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 const item=read.error===undefined?read.data:undefined;
 const latest=useRef(item);latest.current=item;
 const open=async(ref:string)=>{
  setError('');try{const current=await api.request<AssistantTaskResultItem>(path);
   if(active.current&&latest.current?.task.state==='completed'&&latest.current.task.revision===current.task.revision&&current.task.state==='completed'&&current.result?.citations.some(proof=>ref===formatEvidenceRef('capture',proof.id)))onOpen(ref);
   else if(active.current){read.refresh();setError(moteText('原文已不可用，请重新读取。'));}
  }catch{if(active.current){read.refresh();setError(moteText('原文已不可用，请重新读取。'));}}
 };
 return <section className="panel home-assistant-task" aria-label={moteText('任务状态')} data-task-id={id}>
  <div className="section-heading"><h2>{moteText('任务状态')}</h2><a className="text-button" href="#/today">{moteText('返回首页')}</a></div>
  {!available?<p>{moteText('当前服务未提供此入口')}</p>:read.loading&&!read.data?<Loading/>:null}
  {read.error!==undefined&&<p role="alert">{moteText('读取任务状态失败，请刷新重试。')}<button type="button" className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>}
  {item&&<><h3>{item.task.goal??moteText('任务状态')}</h3><div role="status"><WorkStateBadge state={item.task.state}/></div>
   {item.task.state==='needs_input'&&<p>{moteText('需要你补充')}</p>}
   {item.task.state==='cancelled'&&<p>{moteText('已取消')}</p>}
   {item.task.state==='stale'&&<p>{moteText('资料已变化，这项任务的结果已失效。')}</p>}
   {item.error==='no_usable_evidence'&&<p>{moteText('当前范围没有可用正文，任务尚未执行。')}</p>}
   {item.error==='model_context_budget_unavailable'&&<p>{moteText('模型上下文预算尚未就绪，任务未执行。')}</p>}
   {(item.task.state==='failed'||item.task.state==='needs_input'&&item.error&&item.error!=='no_usable_evidence'&&item.error!=='model_context_budget_unavailable')&&<p>{moteText('任务未能完成，请查看处理状态。')}</p>}
   {item.task.state==='needs_input'&&supports('http:GET:/api/owner-questions')&&<button type="button" className="text-button" onClick={()=>openOwnerQuestionList(api)}>{moteText('需要你补充')} →</button>}
   {item.task.state==='completed'&&item.result&&<AnswerView answer={item.result} onOpen={ref=>void open(ref)} compact/>}
  </>}
  {error&&<p role="alert">{error}</p>}
  {available&&<button type="button" className="text-button" disabled={read.loading} onClick={read.refresh}>{moteText('刷新状态')}</button>}
 </section>;
}

function HomeCard({api,card,state,scope,supports,refresh,onOpen,onTask,onTaskState}:{api:Api;card:AssistantCard;state:HomeSnapshot;scope:QueryScope;supports:(capability:string)=>boolean;refresh:()=>void;onOpen:(ref:string)=>void;onTask:(id:string)=>void;onTaskState:(id:string,state:WorkState|undefined)=>void}){
 const [goal,setGoal]=useState(card.title),[editing,setEditing]=useState(false),[history,setHistory]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [reviewedVersion,setReviewedVersion]=useState(card.version);
 const pending=useRef(false),alive=useRef(true),command=useRef<{requestId:string;goal:string;scope:QueryScope;cardId:string;expectedRevision:number}|undefined>(undefined);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const path=assistantCardPath(card.id,scope),feedbackAvailable=supports('http:POST:/api/assistant-cards/:id/feedback');
 const startAvailable=supports('http:POST:/api/assistant/tasks')&&supports('http:GET:/api/assistant/tasks/:id');
 const changed=reviewedVersion!==card.version;
 const canStart=startAvailable&&!changed&&card.state==='open'&&!card.evidenceStale&&!card.acceptedTaskId;
 const taskPath=card.acceptedTaskId&&supports('http:GET:/api/assistant/tasks/:id')?'/api/assistant/tasks/'+encodeURIComponent(card.acceptedTaskId)+'?'+assistantScopeQuery(scope):null;
 const taskRead=useResource<AssistantTaskResultItem>(api,taskPath,5000);
 useForegroundResources(api,[taskPath]);
 const taskState=taskRead.error===undefined?taskRead.data?.task?.state:undefined;
 useEffect(()=>{if(card.acceptedTaskId)onTaskState(card.acceptedTaskId,taskState);},[card.acceptedTaskId,taskState,onTaskState]);
 const currentVersion=useRef(card.version);currentVersion.current=card.version;
 const latestDecision=card.feedback.filter(entry=>['later','ignore','never_remind'].includes(entry.action)).at(-1);
 const readUnavailable=()=>{refresh();resources(api).invalidate(key=>key.startsWith('/api/assistant-cards/'));};
 const act=async(action:'read'|'later'|'ignore'|'start')=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');
  try{
   if(action==='start'){
    if(!canStart||!goal.trim())return;
    command.current??={requestId:crypto.randomUUID(),goal:goal.trim(),scope,cardId:card.id,expectedRevision:card.revision};
    const receipt=await api.request<{requestId:string;taskId:string}>('/api/assistant/tasks',{method:'POST',body:JSON.stringify(command.current)});
    if(receipt.requestId!==command.current.requestId||!receipt.taskId)throw Error('Invalid assistant task receipt');
    if(alive.current)onTask(receipt.taskId);
   }else{
    if(!feedbackAvailable)return;
    await api.request(path.replace('?', '/feedback?'),{method:'POST',body:JSON.stringify({expectedRevision:card.revision,action})});
   }
   if(alive.current)readUnavailable();
  }catch(reason){if(alive.current){
   if(reason instanceof ApiError&&[403,404,409,410].includes(reason.status)){command.current=undefined;setError(moteText('建议已更新，请重新核对后确认。'));readUnavailable();}
   else setError(moteText('操作未完成，请重试；重复开始会回到同一任务。'));
  }}finally{pending.current=false;if(alive.current)setBusy(false);}
 };
 const open=async(id:string)=>{
  setError('');try{const current=await api.request<AssistantCard>(path);
   if(alive.current&&currentVersion.current===card.version&&current.version===card.version&&current.state!=='stale'&&current.evidence.some(proof=>proof.id===id))onOpen(formatEvidenceRef('capture',id));
   else if(alive.current){readUnavailable();setError(moteText('原文已不可用，请重新读取。'));}
  }catch{if(alive.current){readUnavailable();setError(moteText('原文已不可用，请重新读取。'));}}
 };
 const sources=card.sourceContextDependencies?.map(pin=>state.sources.error===undefined?state.sources.data?.items.find(source=>source.id===pin.sourceId)?.name:undefined).filter(Boolean)??[];
 return <article className="home-assistant-card" data-card-id={card.id} data-card-revision={card.revision} aria-busy={busy}>
  <div className="home-assistant-meta"><span>{moteText(cardLabels[card.kind])}</span><span>{card.readAt?moteText('已读'):moteText('未读')}</span>{card.state==='resolved'&&<span>{moteText('已解决')}</span>}</div>
  <h3>{card.title}</h3>
  <p className="home-assistant-meta">{moteText('发现时间')} · <time dateTime={card.createdAt}>{dateTime(card.createdAt)}</time>{card.updatedAt!==card.createdAt&&<> · {moteText('最近更新')} · <time dateTime={card.updatedAt}>{dateTime(card.updatedAt)}</time></>}{sources.length>0&&<> · {moteText('来源')} · {sources.join(' · ')}</>}</p>
  {card.kind==='briefing'&&<p className="fine-print">{moteText('简报仅代表下列依据及正文注明的覆盖范围。')}</p>}
  <CardBody value={card} onEvidence={id=>void open(id)}/>
  {taskState&&<div role="status"><WorkStateBadge state={taskState}/>{taskState==='needs_input'&&<span> · {moteText('需要你补充')}</span>}</div>}
  {taskRead.error!==undefined&&<p role="alert">{moteText('读取任务状态失败，请刷新重试。')}<button type="button" className="text-button" onClick={taskRead.refresh}>{moteText('刷新状态')}</button></p>}
  {latestDecision&&<p role="status">{latestDecision.action==='later'?moteText('已稍后'):moteText('已忽略')}{latestDecision.until&&<> · <time dateTime={latestDecision.until}>{dateTime(latestDecision.until)}</time></>}</p>}
  {changed&&card.kind==='suggestion'&&!card.acceptedTaskId&&<p className="notice" role="status">{moteText('建议已更新，请重新核对后确认。')}<button type="button" className="text-button" disabled={busy} onClick={()=>{setReviewedVersion(card.version);setGoal(card.title);command.current=undefined;setError('');}}>{moteText('重新核对最新建议')}</button></p>}
  {editing&&<label className="home-assistant-goal">{moteText('工作目标')}<textarea aria-label={moteText('工作目标')} value={goal} maxLength={8000} rows={3} disabled={busy} onChange={event=>{setGoal(event.target.value);command.current=undefined;}}/></label>}
  <div className="home-assistant-actions">
   {card.acceptedTaskId?<button type="button" className="button primary" disabled={!supports('http:GET:/api/assistant/tasks/:id')} onClick={()=>onTask(card.acceptedTaskId!)}>{moteText('查看任务')}</button>:card.kind==='suggestion'&&card.state==='open'&&<>
    <button type="button" className="button primary" disabled={busy||!canStart||!goal.trim()} onClick={()=>void act('start')}>{moteText('开始')}</button>
    <button type="button" className="button subtle" disabled={busy||!canStart} onClick={()=>setEditing(value=>!value)}>{moteText('编辑')}</button>
   </>}
   <button type="button" className="text-button" disabled={busy||!feedbackAvailable||card.state==='stale'} onClick={()=>void act('later')}>{moteText('稍后')}</button>
   <button type="button" className="text-button" disabled={busy||!feedbackAvailable||card.state==='stale'} onClick={()=>void act('ignore')}>{moteText('忽略')}</button>
   {!card.readAt&&<button type="button" className="text-button" disabled={busy||!feedbackAvailable||card.state==='stale'} onClick={()=>void act('read')}>{moteText('标为已读')}</button>}
   <button type="button" className="text-button" disabled={!supports('http:GET:/api/assistant-cards/:id/history')} onClick={()=>setHistory(value=>!value)} aria-expanded={history}>{moteText('后续变化')}</button>
  </div>
  {card.kind==='suggestion'&&!card.acceptedTaskId&&!startAvailable&&<p className="fine-print">{moteText('任务服务尚未接通，暂时不能开始。')}</p>}
  {card.acceptedTaskId&&!supports('http:GET:/api/assistant/tasks/:id')&&<p className="fine-print">{moteText('当前服务未提供此入口')}</p>}
  {!feedbackAvailable&&<p className="fine-print">{moteText('当前服务未提供反馈操作。')}</p>}
  {!supports('http:GET:/api/assistant-cards/:id/history')&&<p className="fine-print">{moteText('当前服务未提供后续变化。')}</p>}
  {error&&<p role="alert">{error}</p>}
  {history&&supports('http:GET:/api/assistant-cards/:id/history')&&<CardHistory key={card.id} api={api} card={card} scope={scope} onOpen={onOpen}/>}
 </article>;
}

/** The card store owns feed and read state; the task service creates tasks. Home
 * groups exact kinds and task links, without interpreting the card's prose. */
export function AssistantHome({api,state,onOpen}:{api:Api;state:HomeSnapshot;onOpen:(ref:string)=>void}){
 const viewKey=useMemo(()=>crypto.randomUUID(),[api]);
 const [selected,setSelected]=useState(taskIdFromRoute);
 const [known,setKnown]=useState<{api:Api;states:Map<string,WorkState|undefined>}>(()=>({api,states:new Map()}));
 const taskState=useCallback((id:string,next:WorkState|undefined)=>setKnown(before=>{
  if(before.api===api&&before.states.has(id)&&before.states.get(id)===next)return before;
  const states=before.api===api?new Map(before.states):new Map<string,WorkState|undefined>();states.set(id,next);return {api,states};
 }),[api]);
 useEffect(()=>{const change=()=>setSelected(taskIdFromRoute());window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
 const supports=(capability:string)=>state.availability.inventoryError===undefined&&featureRequirementsAvailable([capability],state.availability.inventory);
 const available=state.availability.pages.some(page=>page.id==='insights')&&supports('http:GET:/api/assistant-cards');
 const read=state.cards,items=read.error===undefined?read.data?.items:undefined;
 const decision=(card:AssistantCard)=>card.feedback.filter(entry=>['later','ignore','never_remind'].includes(entry.action)).at(-1);
 const deferred=(card:AssistantCard)=>{const last=decision(card);return Boolean(last&&(last.action!=='later'||!last.until||Date.parse(last.until)>Date.now()));};
 const settled=(card:AssistantCard)=>Boolean(card.acceptedTaskId&&known.api===api&&['completed','cancelled','stale','excluded'].includes(known.states.get(card.acceptedTaskId)??''));
 const sections=[
  {title:moteText('今天要关注'),items:items?.filter(card=>!card.acceptedTaskId&&card.kind!=='suggestion'&&!deferred(card))},
  {title:moteText('正在推进'),items:items?.filter(card=>Boolean(card.acceptedTaskId)&&!settled(card))},
  {title:moteText('可以开始的工作'),items:items?.filter(card=>!card.acceptedTaskId&&card.kind==='suggestion'&&card.state==='open'&&!deferred(card))},
  {title:moteText('稍后与已处理'),items:items?.filter(card=>settled(card)||!card.acceptedTaskId&&(deferred(card)||card.kind==='suggestion'&&card.state==='resolved'))},
 ];
 return <section key={viewKey} className="home-assistant" aria-label={moteText('动态与建议')}>
  <div className="section-heading"><h2>{moteText('动态与建议')}</h2><button type="button" className="text-button" disabled={!available||read.loading} onClick={read.refresh}>{moteText('刷新')}</button></div>
  {!available&&<p className="home-empty">{discoveryAvailabilityText(state.availability.inventoryError!==undefined?'unknown':!state.availability.inventory?'checking':'unavailable')}</p>}
  {available&&read.loading&&!read.data&&<Loading/>}
  {available&&read.error!==undefined&&<p role="alert">{errorMessage(read.error)}<button type="button" className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></p>}
  {selected&&<HomeTask key={selected} api={api} id={selected} scope={homeAssistantScope} supports={supports} onOpen={onOpen}/>}
  {available&&items&&<>
   {!items.length&&<p className="home-empty">{moteText('当前页暂无动态或建议。')}</p>}
   {sections.map(section=>Boolean(section.items?.length)&&<section className="home-assistant-group" key={section.title} aria-label={section.title}><h2>{section.title}</h2>{section.items?.map(card=><HomeCard key={card.id} api={api} card={card} state={state} scope={homeAssistantScope} supports={supports} refresh={read.refresh} onOpen={onOpen} onTaskState={taskState} onTask={id=>{setSelected(id);window.location.hash='#/today?'+new URLSearchParams({assistantTask:id});}}/>)}</section>)}
   <Pages page={state.cardPaging.page} count={items.length} next={read.data?.nextCursor} loading={read.loading} onPrevious={state.cardPaging.previous} onNext={state.cardPaging.next}/>
  </>}
  {available&&state.cardPaging.page>1&&<button type="button" className="text-button" onClick={state.cardPaging.reset}>{moteText('返回第一页')}</button>}
 </section>;
}
