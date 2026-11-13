import React,{useState} from 'react';
import type {MatterDetail,QueryScope,Routine} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {dateTime,type Api} from '../../api';
import {confirmNavigation,useUnsavedChanges} from '../../unsaved';
import {ReadState,ScopePreview,all,assistantHref,scoped,useAssistantRead,useAssistantCapabilities,useAssistantCommand} from './common';

export function RoutineDetail({api,id,scope=all}:{api:Api;id:string;scope?:QueryScope}){
 const read=useAssistantRead<Routine>(api,scoped('/api/assistant/routines/'+encodeURIComponent(id),scope)),can=useAssistantCapabilities(api),command=useAssistantCommand(api,read.refresh);
 const rule=read.error===undefined&&read.data?.id===id?read.data:undefined;
 const parent=useAssistantRead<MatterDetail>(api,rule?.matterId?scoped('/api/assistant/matters/'+encodeURIComponent(rule.matterId),scope):null);
 const [edit,setEdit]=useState<Routine|null>(null);useUnsavedChanges(Boolean(edit));
 if(!rule)return <ReadState read={read}/>;
 const disabled=command.busy||read.loading||!can('http:POST:/api/assistant/routines/:id'),trigger=rule.schedule.trigger;
 const parentKnown=parent.error===undefined&&parent.data?.matter.id===rule.matterId,parentPaused=Boolean(rule.matterId&&(!parentKnown||parent.data?.matter.state!=='active'));
 const editDisabled=disabled||rule.enabled&&parentPaused;
 const save=()=>{if(!edit)return;void command.run('/api/assistant/routines/'+encodeURIComponent(id),{expectedRevision:edit.revision,goal:edit.goal,timeZone:edit.schedule.timeZone,trigger:edit.schedule.trigger}).then(saved=>{if(saved)setEdit(null);});};
 return <article className="assistant-routine-detail"><h2>{rule.goal}</h2><p role="status">{moteText(rule.enabled?'规则已启用':'规则已暂停')}</p>
  <button className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button>
  {parentPaused&&<p role="status">{parentKnown?moteText('事项已暂停或归档，规则不会启动新的自动工作。'):moteText('当前事项状态无法确认。')}</p>}
  {rule.matterId&&<a className="text-button" href={assistantHref('matter',rule.matterId,undefined,scope)}>{moteText('返回事项')}</a>}
  <dl><dt>{moteText('时区')}</dt><dd>{rule.schedule.timeZone}</dd><dt>{moteText('规则时间')}</dt><dd>
   {trigger.kind==='daily'?<>{moteText('每天')} · {trigger.localTime}</>:trigger.kind==='weekly'?<>{moteText('每周')} · {[moteText('星期一'),moteText('星期二'),moteText('星期三'),moteText('星期四'),moteText('星期五'),moteText('星期六'),moteText('星期日')][trigger.weekday-1]} · {trigger.localTime}</>:<>{moteText('会前 {0} 分钟',trigger.leadMinutes)}</>}
  </dd><dt>{moteText('下次到期')}</dt><dd>{rule.nextDue?dateTime(rule.nextDue,{timeZone:rule.schedule.timeZone,dateStyle:'medium',timeStyle:'short',hour12:false}):moteText('未知')}</dd></dl>
  <p>{moteText('到期时间是规则预览；是否开始取决于事项、后台开关和当前资料权限。')}</p><ScopePreview scope={rule.scope}/>
  {can('http:POST:/api/assistant/routines/:id')&&!edit&&<div className="processing-actions"><button className="button" disabled={editDisabled} onClick={()=>setEdit(structuredClone(rule))}>{moteText('编辑')}</button>
   <button className="button" disabled={disabled||!rule.enabled&&parentPaused} onClick={()=>void command.run('/api/assistant/routines/'+encodeURIComponent(id),{expectedRevision:rule.revision,enabled:!rule.enabled})}>{moteText(rule.enabled?'暂停规则':'恢复规则')}</button></div>}
  {edit&&<form onSubmit={event=>{event.preventDefault();save();}}><label>{moteText('目标')}<textarea maxLength={7600} disabled={command.busy} value={edit.goal} onChange={event=>setEdit({...edit,goal:event.target.value})}/></label>
   <label>{moteText('时区')}<input disabled={command.busy} value={edit.schedule.timeZone} onChange={event=>setEdit({...edit,schedule:{...edit.schedule,timeZone:event.target.value}})}/></label>
   {edit.schedule.trigger.kind!=='before-event'?<><label>{moteText('本地时间')}<input type="time" required disabled={command.busy} value={edit.schedule.trigger.localTime} onChange={event=>{const trigger=edit.schedule.trigger;if(trigger.kind!=='before-event')setEdit({...edit,schedule:{...edit.schedule,trigger:{...trigger,localTime:event.target.value}}});}}/></label>
    {edit.schedule.trigger.kind==='weekly'&&<label>{moteText('每周')}<select disabled={command.busy} value={edit.schedule.trigger.weekday} onChange={event=>{if(edit.schedule.trigger.kind==='weekly')setEdit({...edit,schedule:{...edit.schedule,trigger:{...edit.schedule.trigger,weekday:Number(event.target.value)}}});}}>
     {[moteText('星期一'),moteText('星期二'),moteText('星期三'),moteText('星期四'),moteText('星期五'),moteText('星期六'),moteText('星期日')].map((day,index)=><option key={index} value={index+1}>{day}</option>)}</select></label>}</>:
    <label>{moteText('提前分钟数')}<input type="number" min={1} max={525600} required disabled={command.busy} value={edit.schedule.trigger.leadMinutes} onChange={event=>setEdit({...edit,schedule:{...edit.schedule,trigger:{kind:'before-event',leadMinutes:Number(event.target.value)}}})}/></label>}
   <button className="button primary" disabled={editDisabled||!edit.goal.trim()||!edit.schedule.timeZone.trim()}>{moteText('保存')}</button><button type="button" className="text-button" disabled={command.busy} onClick={()=>{if(confirmNavigation())setEdit(null);}}>{moteText('取消')}</button>
  </form>}{command.error&&<p role="alert">{command.error}</p>}
 </article>;
}
