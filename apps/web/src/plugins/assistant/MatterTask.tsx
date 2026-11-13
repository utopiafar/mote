import React,{useEffect,useRef} from 'react';
import type {QueryScope} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {Api} from '../../api';
import {AnswerView} from '../../shell-components';
import type {AssistantTaskResultItem} from '../ask/AssistantTaskResults';
import {OwnerQuestionLinks} from '../memory/OwnerQuestions';
import {AssistantActionResults} from '../work/AssistantActionResults';
import {ReadState,scoped,taskLabel,useAssistantRead,useAssistantCapabilities} from './common';

export function MatterTask({api,id,scope,onOpen}:{api:Api;id:string;scope:QueryScope;onOpen:(ref:string)=>void}){
 const path=scoped('/api/assistant/tasks/'+encodeURIComponent(id),scope),read=useAssistantRead<AssistantTaskResultItem>(api,path),can=useAssistantCapabilities(api);
 const pending=useRef<AbortController|null>(null),identity=useRef({api,path});identity.current={api,path};
 useEffect(()=>()=>{pending.current?.abort();pending.current=null;},[api,path]);
 const open=async(ref:string)=>{
  pending.current?.abort();const controller=new AbortController();pending.current=controller;
  const active=()=>!controller.signal.aborted&&pending.current===controller&&identity.current.api===api&&identity.current.path===path;
  try{const current=await api.request<AssistantTaskResultItem>(path,{signal:controller.signal});if(!active())return;
   if(current.task.id===id&&current.task.state==='completed'&&current.result?.citations.some(citation=>ref==='capture:'+citation.id))onOpen(ref);
  }catch{/* Revalidate the task instead of opening an unverified original. */}finally{if(active())read.refresh();}
 };
 const item=read.error===undefined&&read.data?.task.id===id?read.data:undefined;
 if(!item)return <ReadState read={read}/>;
 return <section className="assistant-matter-task"><h3>{item.task.goal??moteText('任务状态')}</h3><p role="status">{taskLabel(item.task.state)}</p>
  {item.error==='no_usable_evidence'&&<p>{moteText('当前范围没有可用正文，任务尚未执行。')}</p>}
  {item.error==='model_context_budget_unavailable'&&<p>{moteText('模型上下文预算尚未就绪，任务未执行。')}</p>}
  {item.task.state==='stale'&&<p>{moteText('资料已变化，这项任务的结果已失效。')}</p>}
  {item.workId&&can('http:GET:/api/owner-questions')&&<OwnerQuestionLinks api={api} workId={item.workId}/>}
  {item.task.state==='completed'&&item.result&&<AnswerView answer={item.result} onOpen={ref=>{void open(ref);}} compact/>}
  {item.task.state==='completed'&&Boolean(item.actionDrafts?.length)&&can('http:GET:/api/assistant/tasks/:id/actions')&&<AssistantActionResults api={api} taskId={id} scope={scope} canCreate={can('http:POST:/api/assistant/action-commands')}/>}
 </section>;
}
