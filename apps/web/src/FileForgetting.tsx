import {useLayoutEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {apiOwnerKey,errorMessage,type Api} from './api';
import {useResource} from './useResource';
import {resources} from './resource-cache';
import {containDialogFocus} from './dialog-focus';

type Decision={sourceId:string;externalId:string;decisionId:string;generation:number};
type FileIdentity={title:string;generation:number;sourceId:string;externalId?:string};
type Receipt={deleted:number;cleanup:'complete'|'pending';decision:Decision};
const decisionValid=(value:Decision)=>value&&typeof value.sourceId==='string'&&!!value.sourceId&&typeof value.externalId==='string'&&!!value.externalId&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.decisionId)&&Number.isSafeInteger(value.generation)&&value.generation>0;

function Confirmation({file,onCancel,onConfirm}:{file:FileIdentity;onCancel:()=>void;onConfirm:()=>void}){
 const panel=useRef<HTMLElement|null>(null),cancel=useRef<HTMLButtonElement|null>(null),opener=useRef(document.activeElement as HTMLElement|null);
 useLayoutEffect(()=>panel.current?containDialogFocus(panel.current,opener.current,cancel.current):undefined,[]);
 return <div className="modal-backdrop" onKeyDown={e=>{if(e.key==='Escape')onCancel();}}><section className="modal connect-modal" ref={panel} role="alertdialog" aria-modal="true" aria-label={moteText('删除中央归档')}><h2>{moteText('删除中央归档')}</h2><p>{file.title}</p><p>{moteText('删除此文件的中央原件与处理成果，并阻止此来源再次采集该文件。设备上的原件保留。')}</p><div className="source-toolbar"><button className="button" ref={cancel} onClick={onCancel}>{moteText('取消')}</button><button className="button primary" onClick={onConfirm}>{moteText('确认删除归档')}</button></div></section></div>;
}

/** A404 detail is expected after an admitted forget. Recovery uses the original
 * command, never a newly read generation or a new operation. */
export function FileForgetting({api,id,file,onChanged}:{api:Api;id:string;file?:FileIdentity;onChanged:()=>void}){
 const path='/api/files/'+encodeURIComponent(id),key='mote.file-forget.v1:'+JSON.stringify([apiOwnerKey(api),id]),read=useResource<{captureId:string;blocked:boolean;decision:Decision}>(api,file?null:path+'/forgotten');
 const [pendingBody,setPendingBody]=useState<string>(),[confirm,setConfirm]=useState<FileIdentity>(),[receipt,setReceipt]=useState<Receipt>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[allowed,setAllowed]=useState(false);
 const alive=useRef(false),request=useRef<AbortController|null>(null),pending=useRef<string|undefined>(undefined);
 useLayoutEffect(()=>{alive.current=true;try{const body=window.localStorage.getItem(key);if(body){const value=JSON.parse(body);if(!/^[a-f0-9-]{36}$/.test(value.operationId)||!Number.isSafeInteger(value.originalGeneration)||value.originalGeneration<0||Object.keys(value).some(k=>!['operationId','originalGeneration'].includes(k)))throw Error(moteText('服务返回的操作回执与当前账号不一致。'));if(!file||value.originalGeneration===file.generation){pending.current=body;setPendingBody(body);}}}catch(e){setError(errorMessage(e));}return()=>{alive.current=false;request.current?.abort();request.current=null;};},[api,id,key]);
 const live=(controller:AbortController)=>alive.current&&request.current===controller&&!controller.signal.aborted;
 const invalidate=()=>{resources(api).invalidate(value=>value===path||value===path+'/forgotten'||value.startsWith('/api/files?')||/^\/api\/(memories|materials|capture-browser)([/?]|$)/.test(value));onChanged();};
 async function forget(body:string){
  if(!alive.current||request.current)return;const controller=new AbortController();request.current=controller;setBusy(true);setError('');
  try{const result=await api.request<Receipt>(path,{method:'DELETE',body,signal:controller.signal});if(!live(controller))return;
   const input=JSON.parse(body);if(!Number.isSafeInteger(result.deleted)||result.deleted<0||!['complete','pending'].includes(result.cleanup)||!decisionValid(result.decision)||result.decision.generation!==input.originalGeneration+1||(file&&(result.decision.sourceId!==file.sourceId||(file.externalId!==undefined&&result.decision.externalId!==file.externalId))))throw Error(moteText('服务返回的操作回执与当前账号不一致。'));
   if(window.localStorage.getItem(key)===body)window.localStorage.removeItem(key);pending.current=undefined;setPendingBody(undefined);setReceipt(result);invalidate();
  }catch(e){if(live(controller)){setError(errorMessage(e));invalidate();}}finally{if(live(controller)){request.current=null;setBusy(false);}}
 }
 function admit(){
  if(!alive.current||request.current||!confirm)return;const selected=confirm;setConfirm(undefined);try{const body=pending.current??JSON.stringify({operationId:crypto.randomUUID(),originalGeneration:selected.generation});window.localStorage.setItem(key,body);pending.current=body;setPendingBody(body);void forget(body);}catch(e){setError(errorMessage(e));}
 }
 const forgotten=read.data?.captureId===id&&decisionValid(read.data.decision)?read.data:undefined,decision=receipt?.decision??forgotten?.decision;
 async function allowAgain(){
  if(!alive.current||request.current||!decision)return;const controller=new AbortController();request.current=controller;setBusy(true);setError('');
  try{const result=await api.request<{allowed:boolean}>(path+'/allow-again',{method:'POST',body:JSON.stringify(decision),signal:controller.signal});if(!live(controller))return;if(result.allowed!==true)throw Error(moteText('服务返回的操作回执与当前账号不一致。'));setAllowed(true);read.refresh();}
  catch(e){if(live(controller))setError(errorMessage(e));}finally{if(live(controller)){request.current=null;setBusy(false);}}
 }
 return <div className="file-forget">
  {file&&!receipt&&!pendingBody&&<button className="button subtle" disabled={busy} onClick={()=>{if(alive.current)setConfirm({...file});}}>{moteText('删除中央归档')}</button>}
  {confirm&&<Confirmation file={confirm} onCancel={()=>setConfirm(undefined)} onConfirm={admit}/>}
  {pendingBody&&<div className="notice"><p>{moteText('提交结果待确认；重试会使用原操作，不会重新创建任务。')}</p><button className="button" disabled={busy} onClick={()=>void forget(pendingBody)}>{moteText('重试删除提交')}</button></div>}
  {decision&&!pendingBody&&<div className="notice"><p>{moteText('中央归档已删除。')}{receipt?.cleanup==='pending'&&moteText('原件清理等待当前调用结束。')}</p>{allowed||forgotten?.blocked===false?<p role="status">{moteText('已允许再次采集')}</p>:<button className="button" disabled={busy} onClick={()=>void allowAgain()}>{moteText('允许再次采集')}</button>}</div>}
  {error&&<p role="alert">{error}</p>}
 </div>;
}
