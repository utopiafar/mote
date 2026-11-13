import React,{useState} from 'react';
import type {Commitment,Matter,QueryScope,Routine} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {dateTime,type Api} from '../../api';
import {ReadState,assistantHref,matterLabel,scoped,useAssistantRead} from './common';

type Kind='matter'|'commitment'|'routine';
export const kindTitle=(kind:Kind)=>moteText(kind==='matter'?'事项':kind==='commitment'?'承诺':'规则');
export const commitmentLabel=(state:Commitment['status'])=>moteText(state==='completed'?'已完成':state==='cancelled'?'已取消':state==='confirmed'?'已确认':'待确认');
export function AssistantList({api,kind,scope,matterId}:{api:Api;kind:Kind;scope:QueryScope;matterId?:string}){
 const [cursor,setCursor]=useState<string>();
 const path=scoped('/api/assistant/'+(kind==='matter'?'matters':kind==='routine'?'routines':'commitments'),scope,{limit:'30',...(matterId?{matterId}:{}),...(cursor?{cursor}:{})});
 const read=useAssistantRead<{items:(Matter|Routine|Commitment)[];nextCursor:string|null}>(api,path),page=read.error===undefined?read.data:undefined;
 return <section className="assistant-object-list"><h3>{kindTitle(kind)}</h3>{!page?<ReadState read={read}/>:<>
  {!page.items.length&&<p>{moteText('暂无记录')}</p>}
  <div className="conversation-list">{page.items.map(item=><a className="conversation-item" key={item.id} href={assistantHref(kind,item.id,window.location.hash,scope)}>
   <strong>{'title' in item?item.title:item.goal}</strong><span>{'state' in item?matterLabel(item.state):'enabled' in item?moteText(item.enabled?'规则已启用':'规则已暂停'):commitmentLabel(item.status)}</span>
   {'nextDue' in item&&<span>{moteText('下次到期')} · {item.nextDue?dateTime(item.nextDue,{timeZone:item.schedule.timeZone,dateStyle:'medium',timeStyle:'short',hour12:false}):moteText('未知')} · {item.schedule.timeZone}</span>}
   {'deadline' in item&&<span>{moteText('期限')} · {item.deadline?.at?dateTime(item.deadline.at):moteText('未知')}</span>}
  </a>)}</div>
  <div className="processing-actions">{cursor&&<button className="text-button" onClick={()=>setCursor(undefined)}>{moteText('返回第一页')}</button>}{page.nextCursor&&<button className="text-button" onClick={()=>setCursor(page.nextCursor!)}>{moteText('继续展开')}</button>}</div>
 </>}</section>;
}
