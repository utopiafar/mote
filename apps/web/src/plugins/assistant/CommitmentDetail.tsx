import React,{useEffect,useRef} from 'react';
import type {Commitment,QueryScope} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {dateTime,type Api} from '../../api';
import {commitmentLabel} from './lists';
import {ReadState,assistantHref,scoped,useAssistantRead} from './common';

export function CommitmentDetail({api,id,scope,onOpen}:{api:Api;id:string;scope:QueryScope;onOpen:(ref:string)=>void}){
 const path=scoped('/api/assistant/commitments/'+encodeURIComponent(id),scope),read=useAssistantRead<Commitment>(api,path),request=useRef<AbortController|null>(null);
 useEffect(()=>()=>{request.current?.abort();request.current=null;},[api,path]);
 const item=read.error===undefined&&read.data?.id===id?read.data:undefined;
 const open=async(eventId:string,evidenceId:string)=>{
  request.current?.abort();const controller=new AbortController();request.current=controller;
  try{const current=await api.request<Commitment>(path,{signal:controller.signal});if(controller.signal.aborted||request.current!==controller)return;
   if(current.id===id&&current.timeline.some(event=>event.eventId===eventId&&event.evidence.some(evidence=>evidence.id===evidenceId)))onOpen('capture:'+evidenceId);
  }catch{/* Revalidate the projection before showing any further evidence. */}finally{if(!controller.signal.aborted&&request.current===controller)read.refresh();}
 };
 if(!item)return <ReadState read={read}/>;
 return <article className="assistant-commitment-detail"><h2>{item.title}</h2><p role="status">{commitmentLabel(item.status)}</p><button className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button>
  <p>{moteText('期限')} · {item.deadline?.at?dateTime(item.deadline.at):moteText('未知')}{item.deadline?.text&&<> · {item.deadline.text}</>}</p>
  {item.dueState==='overdue'&&<p role="status">{moteText('已逾期')}</p>}
  <p>{moteText('时间经过不代表承诺已履行。')}</p>
  {item.matterId&&<a className="text-button" href={assistantHref('matter',item.matterId,undefined,scope)}>{moteText('返回事项')}</a>}
  {item.todoId&&<a className="text-button" href={'#/actions?'+new URLSearchParams({tab:'todos',returnTo:window.location.hash})}>{moteText('查看待办')}</a>}
  <section><h3>{moteText('进展时间线')}</h3>{item.timeline.map(event=><section key={event.eventId} className="assistant-commitment-event"><p>{event.summary}</p>
   <p>{moteText('发生时间')} · {event.occurredAt?dateTime(event.occurredAt):moteText('未知')} · {moteText('记录时间')} · {dateTime(event.createdAt)}</p>
   {event.origin==='owner'&&<p>{moteText('用户纠正')}</p>}{event.kind==='reminder'&&<p>{moteText('提醒')}</p>}
   {event.evidence.map(evidence=><blockquote key={evidence.id+':'+evidence.offset}><p>{evidence.quote}</p><button className="text-button" onClick={()=>{void open(event.eventId,evidence.id);}}>{moteText('查看原文')}</button></blockquote>)}
  </section>)}</section>
 </article>;
}
