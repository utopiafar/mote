import React,{useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import type {AssistantTaskRecord,AssistantActionDraft,QueryScope} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {Answer,Api} from '../../api';
import {FeaturePanels} from '../../features/runtime';
import {AssistantActionResults} from '../work/AssistantActionResults';

export type AssistantTaskResultItem={task:Pick<AssistantTaskRecord,'id'|'state'> & Partial<AssistantTaskRecord>;workId?:string;expectedRevision?:number;result?:Answer;error?:string;actionDrafts?:AssistantActionDraft[]};
type Item=AssistantTaskResultItem;
type Page={items:Item[]};

/** Re-read the durable task, including after a lost response or a reload. */
export function AssistantTaskResults({api,conversationId,turnId,scope,refresh,renderAnswer,onOpen,onFound}:{
 api:Api;conversationId:string;turnId:string;scope:QueryScope;refresh:number;
 renderAnswer:(answer:Answer,open:(ref:string)=>void)=>ReactNode;onOpen:(ref:string)=>void;onFound:(items:Item[])=>void;
}){
 const scopeJson=JSON.stringify(scope);
 const path=`/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(turnId)}/assistant-tasks?${new URLSearchParams({scope:scopeJson})}`;
 const [snapshot,setSnapshot]=useState<{api:Api;path:string;items:Item[];error:boolean}>({api,path,items:[],error:false});
 const items=snapshot.api===api&&snapshot.path===path?snapshot.items:[],error=snapshot.api===api&&snapshot.path===path&&snapshot.error;
 const identity=useRef({api,path});identity.current={api,path};
 const sequence=useRef(0),openRequest=useRef<AbortController|null>(null);
 const read=useCallback(async(signal?:AbortSignal)=>{
  const page=await api.request<Page>(path,{signal});
  if(!Array.isArray(page?.items))throw new Error('Invalid task projection');
  return page.items;
 },[api,path]);
 useEffect(()=>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{const version=++sequence.current;try{
   const next=await read(controller.signal);if(controller.signal.aborted)return;
   if(sequence.current===version){setSnapshot({api,path,items:next,error:false});if(next.length)onFound(next);}
   timer=setTimeout(()=>void poll(),next.some(item=>item.task.state==='waiting'||item.task.state==='running')?2000:5000);
  }catch{if(!controller.signal.aborted){if(sequence.current===version)setSnapshot({api,path,items:[],error:true});timer=setTimeout(()=>void poll(),5000);}}};
  void poll();return()=>{controller.abort();openRequest.current?.abort();openRequest.current=null;if(timer)clearTimeout(timer);};
 },[api,path,read,refresh,onFound]);
 const open=(taskId:string,ref:string)=>{void (async()=>{
  openRequest.current?.abort();const controller=new AbortController(),version=++sequence.current;openRequest.current=controller;
  const active=()=>!controller.signal.aborted&&openRequest.current===controller&&sequence.current===version&&identity.current.api===api&&identity.current.path===path;
  try{const next=await read(controller.signal);if(!active())return;setSnapshot({api,path,items:next,error:false});const current=next.find(item=>item.task.id===taskId);
   if(current?.task.state==='completed'&&current.result?.citations.some(citation=>ref==='capture:'+citation.id))onOpen(ref);
   else setSnapshot({api,path,items:next,error:true});
  }catch{if(active())setSnapshot({api,path,items:[],error:true});}
  finally{if(openRequest.current===controller)openRequest.current=null;}
 })();};
 return <>
  {items.map(({task,workId,result,error:reason,actionDrafts})=><section className="assistant-task-result" key={task.id}>
   {task.goal&&<p>{task.goal}</p>}
   <strong>{moteText('任务状态')}</strong>{' · '}
   <span role="status">{task.state==='completed'?moteText('已完成'):task.state==='running'?moteText('正在进行'):
    task.state==='waiting'?moteText('排队中'):task.state==='stale'?moteText('已失效'):
    task.state==='cancelled'?moteText('已取消'):moteText('未完成')}</span>
   {task.state==='stale'&&<p>{moteText('资料已变化，这项任务的结果已失效。')}</p>}
   {reason==='no_usable_evidence'&&<p>{moteText('当前范围没有可用正文，任务尚未执行。')}</p>}
   {reason==='model_context_budget_unavailable'&&<p>{moteText('模型上下文预算尚未就绪，任务未执行。')}</p>}
   {task.state==='needs_input'&&reason&&reason!=='no_usable_evidence'&&reason!=='model_context_budget_unavailable'&&<p>{moteText('任务未能完成，请查看处理状态。')}</p>}
   {task.state==='failed'&&<p>{moteText('任务未能完成，请查看处理状态。')}</p>}
   {task.state==='needs_input'&&workId&&<FeaturePanels api={api} onOpen={onOpen} value={{kind:'mote.work.activity',schemaVersion:1,representation:'overview',ref:workId,revision:String(task.revision),title:'',text:''}}/>}
   {task.state==='completed'&&result&&renderAnswer(result,ref=>open(task.id,ref))}
   {task.state==='completed'&&result&&Boolean(actionDrafts?.length)&&<AssistantActionResults api={api} taskId={task.id} scope={scope}/>}
  </section>)}
  {error&&<p role="alert">{moteText('读取任务状态失败，请刷新重试。')}</p>}
 </>;
}
