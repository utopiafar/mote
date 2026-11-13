import React,{useEffect,useRef,useState} from 'react';
import type {AssistantActionResults as Results,QueryScope} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {errorMessage,type Api} from '../../api';
import {useResource} from '../../useResource';
import {useForegroundResources} from '../../useForegroundResources';

/** Propose through an owner product command, then read the original domain's
 * status. Navigation to confirmation never counts as execution. */
export function AssistantActionResults({api,taskId,scope}:{api:Api;taskId:string;scope:QueryScope}){
 const path=`/api/assistant/tasks/${encodeURIComponent(taskId)}/actions?${new URLSearchParams({scope:JSON.stringify(scope)})}`;
 const read=useResource<Results>(api,path,15000);useForegroundResources(api,[path]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[choices,setChoices]=useState<Record<number,number>>({});
 const pending=useRef(false),identity=useRef({api,path});identity.current={api,path};
 useEffect(()=>{setBusy(false);setError('');setChoices({});pending.current=false;},[api,path]);
 const create=async(index:number)=>{
  const data=read.data,item=data?.drafts.find(item=>item.index===index);if(!data||!item||pending.current)return;
  pending.current=true;setBusy(true);setError('');
  const target=item.targets[choices[index]??0]?.target;
  try{
   await api.request('/api/assistant/action-commands',{method:'POST',body:JSON.stringify({taskId,expectedRevision:data.revision,index,scope,...(target?{target}:{})})});
   if(identity.current.api===api&&identity.current.path===path)read.refresh();
  }catch(reason){if(identity.current.api===api&&identity.current.path===path){setError(errorMessage(reason));read.refresh();}}
  finally{if(identity.current.api===api&&identity.current.path===path){pending.current=false;setBusy(false);}}
 };
 if(read.error!==undefined)return <p role="alert">{errorMessage(read.error)} <button className="button subtle" onClick={read.refresh}>{moteText('重新读取')}</button></p>;
 if(!read.data)return <p role="status">{moteText('正在读取行动结果…')}</p>;
 if(!Array.isArray(read.data.drafts))return <p role="alert">{moteText('中央响应格式无效，请刷新后重试。')}</p>;
 return <section className="related-action-results" aria-label={moteText('相关行动与结果')}>
  <h3>{moteText('相关行动与结果')}</h3>
  <button className="button subtle" onClick={read.refresh}>{moteText('重新读取')}</button>
  <p>{moteText('消息仍需逐条确认；日历按已有授权执行。')}</p>
  {read.data.drafts.map(({index,draft,targets,linked})=>{
   const title=draft.kind==='todo.create'?draft.todo.title:draft.kind==='calendar.create'?draft.event.title:draft.message.conversationName??draft.message.conversationId;
   const status=linked?.status;
   const label=status==='succeeded'?moteText('已完成'):status==='uncertain'?moteText('保存结果待核实'):status==='executing'?moteText('正在写入 / 等待回执'):
    status==='approved'?moteText('等待客户端写入'):status==='stale'?moteText('原文已更新或删除'):status==='dismissed'?moteText('已忽略'):
    status==='completed'?moteText('已完成'):status==='cancelled'?moteText('已取消'):status==='open'?moteText('未完成'):moteText('待确认');
   const destination=linked?`#/actions?${new URLSearchParams({...(draft.kind==='todo.create'?{tab:'todos'}:{action:linked.id}),returnTo:window.location.hash})}`:undefined;
   return <section key={index} data-assistant-action={index}>
    <strong>{title}</strong>
    <p>{draft.kind==='message.send'?draft.message.text:draft.kind==='todo.create'?draft.todo.description:draft.event.description}</p>
    {linked?<><a className="text-button" href={destination}>{title} →</a><span role="status"> · {label}</span>
     {linked.error&&<p role="alert">{linked.error}</p>}</>:
     <>{targets.length>0&&<select aria-label={moteText('目标设备')} value={choices[index]??0} disabled={busy} onChange={event=>setChoices(value=>({...value,[index]:Number(event.target.value)}))}>
      {targets.map((target,i)=><option key={i} value={i}>{target.name}</option>)}
     </select>}
     <button type="button" className="button" disabled={busy||draft.kind!=='todo.create'&&!targets.length} onClick={()=>void create(index)}>{draft.kind==='todo.create'?moteText('记为待办'):moteText('创建行动建议')}</button>
     {draft.kind!=='todo.create'&&!targets.length&&<p>{moteText('当前连接或授权范围不支持这项行动。')}</p>}</>}
   </section>;
  })}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
