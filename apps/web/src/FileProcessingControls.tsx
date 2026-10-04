import {moteText} from '@mote/shared/i18n';
import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {ApiError,errorMessage,type Api} from './api';
import {containDialogFocus} from './dialog-focus';
import {resources} from './resource-cache';
import {useResource} from './useResource';
import {useOperationUpdates} from './useOperationUpdates';

type ProcessingFile={
 cancellation?:{canCancel:boolean;wait:'running'|'unknown'|null};
 job:null|{state:string;summary_state:string;local_only?:number};
 processingPolicy?:{applied?:{profile?:{summarize?:boolean}};current?:{profile?:{summarize?:boolean}}};
};

function UnknownRetryConfirmation({onCancel,onConfirm}:{onCancel:()=>void;onConfirm:()=>void}){
 const panel=useRef<HTMLElement|null>(null),cancel=useRef<HTMLButtonElement|null>(null),opener=useRef(document.activeElement as HTMLElement|null),titleId=useId(),warningId=useId();
 useEffect(()=>panel.current?containDialogFocus(panel.current,opener.current,cancel.current):undefined,[]);
 return <div className="modal-backdrop" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();onCancel();}}} onMouseDown={event=>{if(event.target===event.currentTarget)onCancel();}}>
  <section ref={panel} className="modal connect-modal" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={warningId}>
   <h2 id={titleId}>{moteText('确认重试')}</h2><p id={warningId}>{moteText('上次处理是否结束未知，重试可能重复执行。请确认后继续。')}</p>
   <div className="source-toolbar"><button ref={cancel} className="button" onClick={onCancel}>{moteText('取消')}</button><button className="button primary" onClick={onConfirm}>{moteText('确认重试')}</button></div>
  </section>
 </div>;
}

/** Every entry point reads the same physical-call state before offering retry.
 * Import status alone cannot distinguish a stopped result from a live call. */
export function FileProcessingControls({api,id,mode='detail',disabled=false,onChanged}:{api:Api;id:string;mode?:'detail'|'import';disabled?:boolean;onChanged?:()=>void}){
 const path='/api/files/'+encodeURIComponent(id),{data:file,error:readError,loading,refresh}=useResource<ProcessingFile>(api,path);
 useOperationUpdates(api);
 const request=useRef<AbortController|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[unknownStage,setUnknownStage]=useState<string|null>(null);
 useEffect(()=>file?.cancellation?.wait==='running'?resources(api).get<ProcessingFile>(path).poll(2000):undefined,[api,path,file?.cancellation?.wait]);
 useLayoutEffect(()=>{setBusy(false);setError('');setUnknownStage(null);return()=>{request.current?.abort();request.current=null;};},[api,id]);
 const revoked=readError instanceof ApiError&&[401,403,404,410].includes(readError.status);
 useLayoutEffect(()=>{if(revoked){request.current?.abort();request.current=null;setBusy(false);setUnknownStage(null);}},[revoked]);
 useEffect(()=>{if(file?.cancellation?.wait!=='unknown')setUnknownStage(null);},[file?.cancellation?.wait]);
 async function action(kind:'cancel'|'retry',stage='transcribe',unknownConfirmed=false){
  if(request.current||disabled||loading||readError||!file?.job)return;
  if(kind==='cancel'&&!file.cancellation?.canCancel)return;
  if(kind==='retry'&&file.cancellation?.wait==='running')return;
  const confirmUnknown=kind==='retry'&&file.cancellation?.wait==='unknown';
  if(confirmUnknown&&!unknownConfirmed){setUnknownStage(stage);return;}
  const controller=new AbortController();request.current=controller;setBusy(true);setError('');
  try{
   await api.request(path+'/'+kind,{method:'POST',body:JSON.stringify(kind==='cancel'?{}:{stage,...(confirmUnknown?{confirmUnknown:true}:{})}),signal:controller.signal});
   if(request.current===controller&&!controller.signal.aborted){refresh();onChanged?.();}
  }catch(error){if(request.current===controller&&!controller.signal.aborted)setError(errorMessage(error));}
  finally{if(request.current===controller){request.current=null;setBusy(false);}}
 }
 if(!file)return <>{readError&&<p className="error-banner" role="alert">{errorMessage(readError)}<button className="button" onClick={refresh}>{moteText('重新读取')}</button></p>}</>;
 const locked=disabled||busy||loading||!!readError,waiting=file.cancellation?.wait==='running';
 const summaryDisabled=(file.processingPolicy?.applied??file.processingPolicy?.current)?.profile?.summarize===false;
 const canRetry=mode==='detail'||['failed','blocked','cancelled'].includes(file.job?.state??'')||file.cancellation?.wait==='unknown';
 return <>
  {unknownStage!==null&&<UnknownRetryConfirmation onCancel={()=>setUnknownStage(null)} onConfirm={()=>{const stage=unknownStage;setUnknownStage(null);void action('retry',stage,true);}}/>}
  {waiting&&<p role="status">{moteText('当前调用尚在等待结束；此时不能重试。')}</p>}
  {file.cancellation?.wait==='unknown'&&<p role="status">{moteText('上次处理是否结束未知，重试可能重复执行。请确认后继续。')}</p>}
  {(file.job?.state==='cancelled'||file.job?.summary_state==='cancelled')&&<p role="status">{moteText('本次处理已取消，不再保存后续结果；原件和已保存的成果保留。')}</p>}
  {file.job&&<div className="source-toolbar">
   {file.cancellation?.canCancel&&<button className="button" disabled={locked} onClick={()=>void action('cancel')}>{mode==='import'?moteText('取消处理'):moteText('取消本次处理')}</button>}
   {canRetry&&<button className="button" disabled={locked||waiting} onClick={()=>void action('retry')}>{mode==='import'?moteText('重试处理'):moteText('重新转写 / 提取')}</button>}
   {mode==='detail'&&!file.job.local_only&&!summaryDisabled&&<button className="button" disabled={locked||waiting} onClick={()=>void action('retry','summary')}>{moteText('重新生成摘要')}</button>}
   {mode==='detail'&&!!file.job.local_only&&<button className="button" disabled={locked||waiting} onClick={()=>void action('retry','diarize')}>{moteText('重新分离说话人（保留转写）')}</button>}
   <button className="button" onClick={refresh}>{moteText('刷新处理状态')}</button>
  </div>}
  {(error||readError)&&<p role="alert" className="error-banner">{error||errorMessage(readError)}</p>}
 </>;
}
