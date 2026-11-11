import {useEffect,useId,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {ModelSettingsView} from '@mote/shared/models';
import {commonFailureMessage,httpStatusMessage} from '@mote/shared';
import {ApiError,errorMessage,type Api} from '../../api';
import {useResource} from '../../useResource';
import {ConversationDialog} from '../ask/ConversationTurnDetails';
import {invalidateConfiguration} from '../../configuration-cache';
import { Loading } from '../../Loading';
type Policy={enabled:boolean;intervalHours:number;minChanges:number;maxItems:number;maxWaitHours?:number};
type View={revision:number;settings:Record<string,unknown>&{insights:Policy}};
const failed=(error:unknown)=>error instanceof ApiError?(error.status===409?moteText('设置已变化，请重新读取并核对后继续。'):error.code&&commonFailureMessage(error.code,error.status)||httpStatusMessage(error.status)):errorMessage(error);
/** Only the existing insights policy is edited; every other field keeps its acknowledged CAS baseline. */
export function InsightAutomaticSettings({api,onClose,onSaved}:{api:Api;onClose:()=>void;onSaved:()=>void}){
 const formId=useId();
 const read=useResource<View>(api,'/api/memory-settings'),models=useResource<ModelSettingsView>(api,'/api/model-settings');
 const[editor,setEditor]=useState<{api:Api;view:View;policy:Policy}>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const request=useRef<AbortController|null>(null),owner=useRef(api);owner.current=api;const current=editor?.api===api?editor:undefined;
 useEffect(()=>()=>{request.current?.abort();},[]);
 useEffect(()=>{request.current?.abort();request.current=null;setEditor(undefined);setBusy(false);setError('');},[api]);
 useEffect(()=>{if(!read.loading&&read.error===undefined&&read.data&&!current)setEditor({api,view:read.data,policy:{...read.data.settings.insights}});if(read.error instanceof ApiError&&[401,403,404,410].includes(read.error.status))setEditor(undefined);},[api,read.data,read.error,read.loading,current]);
 const profile=models.data?.profiles.find(p=>p.id===models.data!.defaults.insight),change=(patch:Partial<Policy>)=>{if(current)setEditor({...current,policy:{...current.policy,...patch}});};
 async function save(){if(!current||request.current)return;const controller=new AbortController();request.current=controller;setBusy(true);setError('');const settings={...current.view.settings,insights:{...current.policy}};
  try{const next=await api.request<View>('/api/memory-settings',{method:'PUT',signal:controller.signal,body:JSON.stringify({revision:current.view.revision,settings})});if(controller.signal.aborted||owner.current!==api)return;const policy=next.settings?.insights;if(!Number.isSafeInteger(next.revision)||next.revision<=current.view.revision||!policy||(['enabled','intervalHours','minChanges','maxItems'] as const).some(key=>policy[key]!==settings.insights[key]))throw Error(moteText('中央响应格式无效，请刷新后重试。'));invalidateConfiguration(api);onSaved();onClose();}
  catch(cause){if(!controller.signal.aborted&&owner.current===api)setError(failed(cause));}finally{if(request.current===controller){request.current=null;setBusy(false);}}
 }
 return <div className="insight-automatic-dialog"><ConversationDialog open title={moteText('定期生成发现')} busy={busy} onClose={onClose} footer={<><button type="button" className="button subtle" disabled={busy} onClick={onClose}>{moteText('取消')}</button><button form={formId} type="submit" className="button primary" disabled={busy||!current}>{busy?moteText('正在保存…'):moteText('保存设置')}</button></>}><form id={formId} className="insight-automatic-settings" onSubmit={event=>{event.preventDefault();void save();}}>{!current&&read.loading&&<Loading/>}{Boolean(error||read.error)&&<p role="alert">{error||failed(read.error)}</p>}{current&&<fieldset disabled={busy}><label className="insight-automatic-toggle"><input type="checkbox" checked={current.policy.enabled} onChange={event=>change({enabled:event.target.checked})}/><span>{moteText('定期生成发现')}</span></label><p className="muted">{moteText('使用 {0}。有足够新增资料且达到周期时生成。',profile?.name??moteText('当前默认'))}</p><details><summary>{moteText('生成周期与资料门槛')}</summary><div className="insight-automatic-fields">{([['intervalHours','最短间隔（小时）',1/60,8760],['minChanges','最少新增变化',1,100000],['maxItems','每次最多处理',1,2000]] as const).map(([key,label,min,max])=><label key={key}>{moteText(label)}<input type="number" required min={min} max={max} step={key==='intervalHours'?'any':1} value={current.policy[key]} onChange={event=>change({[key]:Number(event.target.value)})}/></label>)}</div></details></fieldset>}{error&&<button type="button" className="text-button" disabled={busy} onClick={()=>{setEditor(undefined);setError('');read.refresh();}}>{moteText('读取最新并还原草稿')}</button>}</form></ConversationDialog></div>;
}
