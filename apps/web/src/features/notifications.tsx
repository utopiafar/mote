import {moteText} from '@mote/shared/i18n';
import {useEffect,useRef,useState} from 'react';
import type {ServerConfiguration} from '@mote/shared';
import {ApiError,errorMessage,type Api} from '../api';
import {invalidateConfiguration} from '../configuration-cache';
import {Loading} from '../Loading';
import {useResource} from '../useResource';
import {useUnsavedChanges} from '../unsaved';
import type {PageProps} from './types';

export interface QuietHours{start:string;end:string}
export interface NotificationSettings{
  enabled:boolean;
  timeZone:string;
  quietHours:QuietHours|null;
  minIntervalMinutes:number;
}
const defaults:NotificationSettings={enabled:true,timeZone:'UTC',quietHours:null,minIntervalMinutes:60};
/** Quiet hours default to the prototype's overnight window only when the owner
 * first turns them on; existing saved values always win. */
const proposedQuietHours:QuietHours={start:'22:00',end:'08:00'};
const browserTimeZone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};
type DomainValue=Record<string,unknown>;
function domainValue(config:ServerConfiguration|undefined,key:string):unknown{
  const domain=config?.domains.find(value=>value.id==='notifications');
  if(!domain)return undefined;
  for(const source of [domain.saved,domain.effective]){
    if(source&&typeof source==='object'&&Object.hasOwn(source,key))return (source as DomainValue)[key];
  }
  return undefined;
}
function quietHours(value:unknown):QuietHours|null{
  if(!value||typeof value!=='object')return null;
  const {start,end}=value as DomainValue;
  return typeof start==='string'&&typeof end==='string'?{start,end}:null;
}
export function notificationSettings(config:ServerConfiguration|undefined):NotificationSettings{
  const enabled=domainValue(config,'enabled'),timeZone=domainValue(config,'timeZone'),quiet=domainValue(config,'quietHours'),interval=domainValue(config,'minIntervalMinutes');
  return {
    enabled:typeof enabled==='boolean'?enabled:defaults.enabled,
    timeZone:typeof timeZone==='string'&&timeZone?timeZone:defaults.timeZone,
    quietHours:quietHours(quiet),
    minIntervalMinutes:typeof interval==='number'&&Number.isInteger(interval)?interval:defaults.minIntervalMinutes,
  };
}
/** The landing summary is read from the same central configuration domain the
 * subpage writes; no notification API is added. */
export function notificationSummary(config:ServerConfiguration|undefined) {
  const settings=notificationSettings(config);
  if(!settings.enabled)return moteText('已关闭');
  return settings.quietHours?moteText('{0}–{1} 安静',settings.quietHours.start,settings.quietHours.end):'';
}
const same=(left:NotificationSettings|undefined,right:NotificationSettings|undefined)=>
  left===undefined&&right===undefined||Boolean(left&&right)&&left!.enabled===right!.enabled&&left!.timeZone===right!.timeZone&&left!.minIntervalMinutes===right!.minIntervalMinutes&&
  left!.quietHours?.start===right!.quietHours?.start&&left!.quietHours?.end===right!.quietHours?.end;

export function Notifications({api,onPage}:Pick<PageProps,'api'|'onPage'>){
  const activeApi=useRef(api);activeApi.current=api;
  const read=useResource<ServerConfiguration>(api,'/api/configuration');
  const config=read.data;
  const [baseline,setBaseline]=useState<NotificationSettings>(),[draft,setDraft]=useState<NotificationSettings>();
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const dirty=!same(draft,baseline),dirtyRef=useRef(dirty);dirtyRef.current=dirty;
  useUnsavedChanges(dirty);
  useEffect(()=>{setBaseline(undefined);setDraft(undefined);setError('');setNotice('');setBusy(false);},[api]);
  useEffect(()=>{
    if(!config)return;
    const next=notificationSettings(config);
    setBaseline(previous=>previous&&dirtyRef.current?previous:next);
    setDraft(previous=>previous&&dirtyRef.current?previous:next);
  },[config?.revision,api]);
  const value=baseline??notificationSettings(config);
  const edit=(patch:Partial<NotificationSettings>)=>setDraft(previous=>({...(previous??value),...patch}));
  const withdrawn=read.error instanceof ApiError&&[401,403,404,410].includes(read.error.status);
  const readOnly=Boolean(config?.readOnly);
  const zones=[...new Set([value.timeZone,browserTimeZone(),'UTC'])];
  async function save(){
    if(!config||!draft||busy||!dirty)return;
    if(draft.quietHours&&draft.quietHours.start===draft.quietHours.end){setError(moteText('开始和结束时间不能相同。'));return;}
    const controller=new AbortController();
    setBusy(true);setError('');setNotice('');
    try{
      const next=await api.request<ServerConfiguration>('/api/configuration/notifications',{method:'PUT',body:JSON.stringify({revision:config.revision,value:{enabled:draft.enabled,timeZone:draft.timeZone,quietHours:draft.quietHours}}),signal:controller.signal});
      if(activeApi.current!==api||controller.signal.aborted)return;
      const adopted=notificationSettings(next);
      setBaseline(adopted);setDraft(adopted);invalidateConfiguration(api);setNotice(moteText('已保存'));
    }catch(failure){if(activeApi.current===api&&!controller.signal.aborted)setError(errorMessage(failure));}
    finally{if(activeApi.current===api)setBusy(false);}
  }
  if(!config&&read.loading)return <section className="web-preferences notifications-page" aria-busy="true"><div className="page-heading"><h1>{moteText('通知')}</h1></div><Loading/></section>;
  if(withdrawn)return <section className="web-preferences notifications-page"><div className="page-heading"><h1>{moteText('通知')}</h1><button className="text-button" onClick={()=>onPage('about')}>← {moteText('返回')}</button></div><div className="notice error" role="alert"><p>{moteText('请求的操作或资源已失效，请重新读取后再确认。')}</p><button className="text-button" onClick={read.refresh}>{moteText('重新读取')}</button></div></section>;
  if(read.error!==undefined&&!config)return <section className="web-preferences notifications-page"><div className="page-heading"><h1>{moteText('通知')}</h1><button className="text-button" onClick={()=>onPage('about')}>← {moteText('返回')}</button></div><p className="notice error" role="alert">{errorMessage(read.error)} <button className="text-button" onClick={read.refresh}>{moteText('重试')}</button></p></section>;
  const current=draft??value;
  return <section className="web-preferences notifications-page">
    <div className="page-heading"><h1>{moteText('通知')}</h1><button className="text-button" onClick={()=>onPage('about')}>← {moteText('返回')}</button></div>
    <section className="web-preference-section">
      <label className="preference-toggle"><span><strong>{moteText('助理通知')}</strong></span><input type="checkbox" role="switch" aria-label={moteText('助理通知')} checked={current.enabled} disabled={busy||readOnly} onChange={event=>{edit({enabled:event.target.checked});setNotice('');}}/></label>
      <label className="preference-toggle"><span><strong>{moteText('安静时段')}</strong></span><input type="checkbox" role="switch" aria-label={moteText('安静时段')} checked={Boolean(current.quietHours)} disabled={busy||readOnly} onChange={event=>{edit({quietHours:event.target.checked?(current.quietHours??proposedQuietHours):null});setNotice('');}}/></label>
      {current.quietHours&&<div className="preference-grid">
        <label className="preference-field">{moteText('开始时间')}<input type="time" aria-label={moteText('开始时间')} value={current.quietHours.start} disabled={busy||readOnly} onChange={event=>{edit({quietHours:{start:event.target.value,end:current.quietHours!.end}});setNotice('');}}/></label>
        <label className="preference-field">{moteText('结束时间')}<input type="time" aria-label={moteText('结束时间')} value={current.quietHours.end} disabled={busy||readOnly} onChange={event=>{edit({quietHours:{start:current.quietHours!.start,end:event.target.value}});setNotice('');}}/></label>
      </div>}
      <label className="preference-field">{moteText('时区')}<select aria-label={moteText('时区')} value={current.timeZone} disabled={busy||readOnly} onChange={event=>{edit({timeZone:event.target.value});setNotice('');}}>{zones.map(zone=><option key={zone} value={zone}>{zone}</option>)}</select></label>
      {error&&<p className="notice error" role="alert">{error}</p>}
      {read.error!==undefined&&<p className="notice" role="status">{errorMessage(read.error)} <button type="button" className="text-button" onClick={read.refresh}>{moteText('重试')}</button></p>}
      {readOnly&&<p className="fine-print">{moteText('当前服务只读，无法保存。')}</p>}
      <div className="config-draft-footer"><span role="status">{notice||(dirty?moteText('有未保存的修改'):'')}</span><button type="button" className="button primary" disabled={!dirty||busy||readOnly} onClick={()=>void save()}>{busy?moteText('保存中…'):moteText('保存')}</button></div>
    </section>
  </section>;
}
