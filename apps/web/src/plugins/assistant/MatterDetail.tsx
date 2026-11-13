import React,{useEffect,useRef,useState} from 'react';
import type {MatterDetail as Detail,QueryScope} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {dateTime,type Api} from '../../api';
import {confirmNavigation,useUnsavedChanges} from '../../unsaved';
import {MatterTask} from './MatterTask';
import {AssistantList} from './lists';
import {ReadState,ScopePreview,matterLabel,scoped,useAssistantRead,useAssistantCapabilities,useAssistantCommand} from './common';

export function MatterDetail({api,id,scope,onOpen}:{api:Api;id:string;scope:QueryScope;onOpen:(ref:string)=>void}){
 const path=scoped('/api/assistant/matters/'+encodeURIComponent(id),scope),read=useAssistantRead<Detail>(api,path),can=useAssistantCapabilities(api);
 const [edit,setEdit]=useState<{revision:number;goal:string;correction:string}|null>(null);
 const opening=useRef<AbortController|null>(null);
 useEffect(()=>()=>{opening.current?.abort();opening.current=null;},[api,path]);
 const command=useAssistantCommand(api,read.refresh);useUnsavedChanges(Boolean(edit));
 const detail=read.error===undefined&&read.data?.matter.id===id?read.data:undefined;
 if(!detail)return <ReadState read={read}/>;
 const {matter}=detail,editable=can('http:POST:/api/assistant/matter-commands')&&matter.state!=='archived',disabled=command.busy||read.loading||!editable;
 const transition=(type:'pause'|'resume'|'archive')=>command.run('/api/assistant/matter-commands',{type,matterId:id,expectedRevision:matter.revision});
 const openEvidence=async(evidenceId:string)=>{
  opening.current?.abort();const controller=new AbortController();opening.current=controller;
  try{const next=await api.request<Detail>(path,{signal:controller.signal});if(!controller.signal.aborted&&opening.current===controller&&next.matter.id===id&&next.linkedEvidence.some(item=>item.id===evidenceId))onOpen('capture:'+evidenceId);}
  catch{/* The following detail read clears unavailable evidence and reports errors. */}
  finally{if(!controller.signal.aborted&&opening.current===controller)read.refresh();}
 };
 return <article className="assistant-matter-detail"><header><h2>{matter.goal}</h2><p role="status">{matterLabel(matter.state)}</p><p>{moteText('更新时间')} · {dateTime(matter.updatedAt)}</p></header>
  <button className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button>
  {matter.state==='paused'&&<p>{moteText('暂停事项仅停止新的自动工作；已接收任务仍按原规则处理。')}</p>}
  {editable&&!edit&&<div className="processing-actions"><button className="button" disabled={disabled} onClick={()=>setEdit({revision:matter.revision,goal:matter.goal,correction:matter.correction??''})}>{moteText('编辑')}</button>
   <button className="button" disabled={disabled} onClick={()=>void transition(matter.state==='paused'?'resume':'pause')}>{moteText(matter.state==='paused'?'恢复事项':'暂停事项')}</button>
   <button className="button subtle" disabled={disabled} onClick={()=>void transition('archive')}>{moteText('归档')}</button></div>}
  {edit&&<form onSubmit={event=>{event.preventDefault();void command.run('/api/assistant/matter-commands',{type:'edit',matterId:id,expectedRevision:edit.revision,goal:edit.goal,correction:edit.correction||null}).then(saved=>{if(saved)setEdit(null);});}}>
   <label>{moteText('目标')}<textarea value={edit.goal} maxLength={8000} disabled={command.busy} onChange={event=>setEdit({...edit,goal:event.target.value})}/></label>
   <label>{moteText('纠正说明')}<textarea value={edit.correction} maxLength={4000} disabled={command.busy} onChange={event=>setEdit({...edit,correction:event.target.value})}/></label>
   <button className="button primary" disabled={disabled||!edit.goal.trim()||edit.goal===matter.goal&&edit.correction===(matter.correction??'')}>{moteText('保存')}</button><button type="button" className="text-button" disabled={command.busy} onClick={()=>{if(confirmNavigation())setEdit(null);}}>{moteText('取消')}</button>
  </form>}
  {command.error&&<p role="alert">{command.error}</p>}{matter.correction&&!edit&&<p>{moteText('纠正说明')} · {matter.correction}</p>}
  <ScopePreview scope={matter.scope}/><section><h3>{moteText('证据')}</h3>
   {detail.linkedEvidence.map(item=><p key={item.id}><button className="text-button" onClick={()=>{void openEvidence(item.id);}}>{item.title||moteText('查看原文')}</button> · {dateTime(item.at)}</p>)}
   {!detail.linkedEvidence.length&&<p>{moteText('暂无可显示的证据')}</p>}{detail.coverage.evidence==='partial'&&<p role="status">{moteText('部分关联资料已不可用，未显示其内容。')}</p>}
  </section><section><h3>{moteText('进展与产物')}</h3>
   {detail.linkedTasks.map(task=><MatterTask key={task.id} api={api} id={task.id} scope={matter.scope} onOpen={onOpen}/>)}
   {!detail.linkedTasks.length&&<p>{moteText('暂无关联任务')}</p>}{detail.coverage.tasks==='partial'&&<p>{moteText('部分关联任务已不可用。')}</p>}
  </section>
  {can('http:GET:/api/assistant/commitments')&&<AssistantList api={api} kind="commitment" scope={matter.scope} matterId={id}/>}
  {can('http:GET:/api/assistant/routines')&&<AssistantList api={api} kind="routine" scope={matter.scope} matterId={id}/>}
 </article>;
}
