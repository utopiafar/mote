import React,{useEffect,useState} from 'react';
import type {ActionProposal,CurrentActionReference} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import type {Api} from '../../api';
import {errorMessage} from '../../api';
import {useResource} from '../../useResource';
import {useForegroundResources} from '../../useForegroundResources';
import {operationFeed} from './operation-feed';
import { Loading } from '../../Loading';
import {actionFailure,calendarStateLabel} from '../../action-presentation';

/** A completed owner instruction links to the original Action. There is no
 * second start/confirm command and model answer prose is never a receipt. */
export function CurrentActionReceipt({api,reference}:{api:Api;reference:CurrentActionReference}){
 const path='/api/actions/'+encodeURIComponent(reference.id),read=useResource<ActionProposal>(api,path,15000),[busy,setBusy]=useState(false),[error,setError]=useState('');
 useForegroundResources(api,[path]);
 useEffect(()=>{setBusy(false);setError('');},[api,reference.id]);
 const action=read.data;
 const cancel=async()=>{if(!action)return;setBusy(true);setError('');try{await api.request('/api/managed-calendar/'+encodeURIComponent(action.id)+'/cancel',{method:'POST',body:JSON.stringify({version:action.version})});read.refresh();}catch(reason){setError(actionFailure(reason));}finally{setBusy(false);}};
 if(read.loading&&!action)return <Loading label={moteText('正在读取行动结果…')}/>;
 if(read.error!==undefined)return <p role="alert">{errorMessage(read.error)} <button className="button subtle" onClick={read.refresh}>{moteText('重新读取')}</button></p>;
 if(!action)return null;
 if(action.id!==reference.id||action.kind!==reference.kind||!action.ownerInstruction)return <p role="alert">{moteText('中央响应格式无效，刷新后重试。')}</p>;
 return <section className="related-action-results" aria-label={moteText('相关行动与结果')} data-action-id={action.id}>
  <a href={'#/actions?action='+encodeURIComponent(action.id)}>{action.event.title}</a>
  <p role="status">{calendarStateLabel(action)}</p>
  {!action.cancelRequestedAt&&['approved','executing','uncertain'].includes(action.status)&&<button className="text-button" disabled={busy} onClick={()=>void cancel()}>{action.status==='approved'?moteText('停止等待执行'):moteText('停止后续执行')}</button>}
  <button className="text-button" onClick={read.refresh}>{moteText('刷新状态')}</button>
  {error&&<p role="alert">{error}</p>}
 </section>;
}
export function ActionResults({api,evidenceId}:{api:Api;evidenceId:string}){
 const path='/api/actions/by-evidence/'+encodeURIComponent(evidenceId);
 const read=useResource<{items:(Pick<ActionProposal,'id'|'status'|'managed'|'resolution'|'kind'>&{title:string})[];hasMore:boolean}>(api,path,15000);
 useForegroundResources(api,[path]);
 useEffect(()=>operationFeed(api).subscribe(()=>{}),[api]);
 if(read.loading&&!read.data)return <Loading label={moteText('正在读取行动结果…')}/>;
 if(read.error!==undefined)return <p role="alert">{errorMessage(read.error)} <button className="button subtle" onClick={read.refresh}>{moteText('重新读取')}</button></p>;
 if(read.data&&!Array.isArray(read.data.items))return <p role="alert">{moteText('中央响应格式无效，刷新后重试。')} <button className="button subtle" onClick={read.refresh}>{moteText('重新读取')}</button></p>;
 const todoUrl='#/actions?tab=todos&todoEvidence='+encodeURIComponent(evidenceId)+'&returnTo='+encodeURIComponent(window.location.hash);
 if(!read.data?.items.length)return <section className="related-action-results"><a className="text-button" href={todoUrl}>{moteText('记为待办')} →</a></section>;
 return <section className="related-action-results"><h3>{moteText('相关行动与结果')}</h3><a className="text-button" href={todoUrl}>{moteText('记为待办')} →</a>{read.data.items.map(a=><p key={a.id} data-action-id={a.id}><a href={'#/actions?action='+encodeURIComponent(a.id)}>{a.title}</a> · {a.managed?.state==='cancelled'?moteText('已取消等待执行'):a.managed?.state==='cancel_requested'?moteText('已请求取消，写入结果仍待核实'):a.status==='succeeded'?moteText('已完成'):a.status==='approved'?moteText('等待客户端写入'):a.status==='executing'?moteText('正在写入 / 等待回执'):a.status==='uncertain'?moteText('保存结果待核实'):a.status==='stale'?moteText('原文已更新或删除'):a.status==='dismissed'?moteText('已忽略'):moteText('待确认')}</p>)}{read.data.hasMore&&<a href="#/actions">{moteText('查看全部行动')}</a>}</section>;
}
