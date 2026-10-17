import type {FileDiarizationOptions} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {ApiError,errorMessage,type Api} from './api';
import {containDialogFocus} from './dialog-focus';
import {resources} from './resource-cache';
import {useResource} from './useResource';
import {useOperationUpdates} from './useOperationUpdates';
import {readFileRetry,saveFileRetry,clearFileRetry} from './file-retry-intent';

type ProcessingFile={
 rawArtifactId?:string;
 item?:{mimeType?:string};
 artifacts?:{id:string;kind:string}[];
 cancellation?:{canCancel:boolean;wait:'running'|'unknown'|null};
 job:null|{state:string;summary_state:string};
 processingPolicy?:{capabilities?:{dialogue:boolean;summary:boolean};applied?:{profile?:{summarize?:boolean}};current?:{profile?:{summarize?:boolean}}};
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
type Props={api:Api;id:string;mode?:'detail'|'import';disabled?:boolean;onChanged?:()=>void};
export function FileProcessingControls(props:Props){return <FileProcessingControlView key={JSON.stringify([props.api.connection,props.id])} {...props}/>;}
function FileProcessingControlView({api,id,mode='detail',disabled=false,onChanged}:Props){
 const path='/api/files/'+encodeURIComponent(id),{data:file,error:readError,loading,refresh}=useResource<ProcessingFile>(api,path);
 useOperationUpdates(api);
 const request=useRef<AbortController|null>(null),alive=useRef(false),pending=useRef<string|undefined>(undefined),[retryBody,setRetryBody]=useState<string>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[unknownStage,setUnknownStage]=useState<{stage:string;scoped:boolean}|null>(null);
 const [model,setModel]=useState('audio.diarize-wespeaker'),[countMode,setCountMode]=useState('unknown'),[exact,setExact]=useState(''),[minimum,setMinimum]=useState(''),[maximum,setMaximum]=useState('');
 useEffect(()=>file?.cancellation?.wait==='running'?resources(api).get<ProcessingFile>(path).poll(2000):undefined,[api,path,file?.cancellation?.wait]);
 useLayoutEffect(()=>{alive.current=true;setBusy(false);setError('');setUnknownStage(null);try{pending.current=readFileRetry(api,id);setRetryBody(pending.current);}catch(e){setError(errorMessage(e));}return()=>{alive.current=false;request.current?.abort();request.current=null;};},[api,id]);
 const revoked=readError instanceof ApiError&&[401,403,404,410].includes(readError.status);
 useLayoutEffect(()=>{if(revoked){request.current?.abort();request.current=null;setBusy(false);setUnknownStage(null);}},[revoked]);
 useEffect(()=>{if(file?.cancellation?.wait!=='unknown')setUnknownStage(null);},[file?.cancellation?.wait]);
 async function action(kind:'cancel'|'retry',stage='transcribe',unknownConfirmed=false,scoped=false){
  if(!alive.current||request.current||pending.current||disabled||loading||readError||!file?.job)return;
  if(kind==='cancel'&&!file.cancellation?.canCancel)return;
  if(kind==='retry'&&file.cancellation?.wait==='running')return;
  const confirmUnknown=kind==='retry'&&file.cancellation?.wait==='unknown';
  if(confirmUnknown&&!unknownConfirmed){setUnknownStage({stage,scoped});return;}
  let diarization:{artifactId:string;options:FileDiarizationOptions}|undefined;
  if(scoped){const artifactId=file.rawArtifactId??file.artifacts?.find(a=>a.kind==='transcript')?.id;if(!artifactId)return;diarization={artifactId,options:{processor:model as FileDiarizationOptions['processor'],speakerCount:countMode==='exact'?Number(exact):null,range:countMode==='range'?{min:Number(minimum),max:Number(maximum)}:null}};}
  const body=JSON.stringify(kind==='cancel'?{}:{...(api.connection?.mode==='web'?{operationId:crypto.randomUUID()}:{}),stage,...(diarization?{diarization}:{}),...(confirmUnknown?{confirmUnknown:true}:{})});
  if(kind==='retry'&&api.connection?.mode==='web'){try{const saved=readFileRetry(api,id);pending.current=saved??body;if(!saved)saveFileRetry(api,id,body);setRetryBody(pending.current);}catch(e){setError(errorMessage(e));return;}}
  await send(kind,pending.current??body);
 }
 async function send(kind:'cancel'|'retry',body:string){
  if(!alive.current||request.current||disabled||readError)return;
  const controller=new AbortController();request.current=controller;setBusy(true);setError('');
  try{
   const result=await api.request<{queued?:boolean;taskId?:string}>(path+'/'+kind,{method:'POST',body,signal:controller.signal});
   if(request.current===controller&&!controller.signal.aborted&&alive.current){if(kind==='retry'&&api.connection?.mode==='web'){if(result.queued!==true||!result.taskId||!/^[a-f0-9]{64}$/.test(result.taskId))throw Error(moteText('服务返回的操作回执与当前账号不一致。'));clearFileRetry(api,id,body);pending.current=undefined;setRetryBody(undefined);}refresh();onChanged?.();}
  }catch(error){if(request.current===controller&&!controller.signal.aborted)setError(errorMessage(error));}
  finally{if(request.current===controller){request.current=null;setBusy(false);}}
 }
 if(!file)return <>{readError&&<p className="error-banner" role="alert">{errorMessage(readError)}<button className="button" onClick={refresh}>{moteText('重新读取')}</button></p>}</>;
 if(file.job?.state==='skipped')return null;
 const locked=disabled||busy||loading||!!readError||!!retryBody,waiting=file.cancellation?.wait==='running';
 const dialogue=file.processingPolicy?.capabilities?.dialogue||(api.connection?.mode==='web'&&file.item?.mimeType?.startsWith('audio/')&&!!file.rawArtifactId);
 const summaryDisabled=file.processingPolicy?.capabilities?.summary===false||(file.processingPolicy?.applied??file.processingPolicy?.current)?.profile?.summarize===false;
 const canRetry=mode==='detail'||['failed','blocked','cancelled'].includes(file.job?.state??'')||file.cancellation?.wait==='unknown';
 return <>
  {retryBody&&<div className="notice"><p>{moteText('提交结果待确认；重试会使用原操作，不会重新创建任务。')}</p><button className="button" disabled={busy||!!readError} onClick={()=>void send('retry',retryBody)}>{moteText('重试提交')}</button><button className="button subtle" disabled={busy} onClick={()=>{clearFileRetry(api,id,retryBody);pending.current=undefined;setRetryBody(undefined);}}>{moteText('移除本机待确认提交')}</button><p className="fine-print">{moteText('移除本机提交不会取消已经准入的中央任务；可在活动中查看。')}</p></div>}
  {unknownStage!==null&&<UnknownRetryConfirmation onCancel={()=>setUnknownStage(null)} onConfirm={()=>{const stage=unknownStage;setUnknownStage(null);void action('retry',stage.stage,true,stage.scoped);}}/>}
  {waiting&&<p role="status">{moteText('当前调用尚在等待结束；此时不能重试。')}</p>}
  {file.cancellation?.wait==='unknown'&&<p role="status">{moteText('上次处理是否结束未知，重试可能重复执行。请确认后继续。')}</p>}
  {(file.job?.state==='cancelled'||file.job?.summary_state==='cancelled')&&<p role="status">{moteText('本次处理已取消，不再保存后续结果；原件和已保存的成果保留。')}</p>}
  {file.job&&<div className="source-toolbar">
   {file.cancellation?.canCancel&&<button className="button" disabled={locked} onClick={()=>void action('cancel')}>{mode==='import'?moteText('取消处理'):moteText('取消本次处理')}</button>}
   {canRetry&&<button className="button primary" disabled={locked||waiting} onClick={()=>void action('retry')}>{mode==='import'?moteText('重试处理'):moteText('重新转写 / 提取')}</button>}
   {mode==='detail'&&!summaryDisabled&&<button className="button" disabled={locked||waiting} onClick={()=>void action('retry','summary')}>{moteText('重新生成摘要')}</button>}
   {mode==='detail'&&dialogue&&<button className="button primary" disabled={locked||waiting} onClick={()=>void action('retry','diarize')}>{moteText('重新分离说话人（保留转写）')}</button>}
   <button className="button" onClick={refresh}>{moteText('刷新处理状态')}</button>
  </div>}
  {mode==='detail'&&dialogue&&file.artifacts?.some(a=>a.kind==='transcript')&&<details className="source-item file-diarization-settings"><summary>{moteText('单文件分人设置')}</summary><p>{moteText('只更改此文件的分人与对齐，复用原始转写。其他文件和默认方案保持原配置。')}</p><form onSubmit={e=>{e.preventDefault();void action('retry','diarize',false,true);}}><fieldset className="file-diarization-fields" disabled={locked||waiting}><label>{moteText('声纹模型')}<select value={model} onChange={e=>{setModel(e.target.value);if(e.target.value==='audio.diarize'&&countMode==='range')setCountMode('unknown');}}><option value="audio.diarize-wespeaker">{moteText('WeSpeaker 中文')}</option><option value="audio.diarize">3D-Speaker</option></select><span className="file-diarization-selection" aria-hidden="true">{model==='audio.diarize-wespeaker'?moteText('WeSpeaker 中文'):'3D-Speaker'}</span></label><label>{moteText('人数信息')}<select value={countMode} onChange={e=>setCountMode(e.target.value)}><option value="unknown">{moteText('未知')}</option><option value="exact">{moteText('准确人数')}</option><option value="range" disabled={model!=='audio.diarize-wespeaker'}>{moteText('已知范围')}</option></select><span className="file-diarization-selection" aria-hidden="true">{moteText(countMode==='exact'?'准确人数':countMode==='range'?'已知范围':'未知')}</span></label>{countMode==='exact'&&<label>{moteText('准确人数')}<input type="number" min="1" max="16" required value={exact} onChange={e=>setExact(e.target.value)}/></label>}{countMode==='range'&&<><label>{moteText('说话人数下限')}<input type="number" min="1" max="16" required value={minimum} onChange={e=>setMinimum(e.target.value)}/></label><label>{moteText('说话人数上限')}<input type="number" min={minimum||1} max="16" required value={maximum} onChange={e=>setMaximum(e.target.value)}/></label></>}<button className="button primary" type="submit">{moteText('应用并重新分人')}</button></fieldset></form></details>}
  {(error||readError)&&<p role="alert" className="error-banner">{error||errorMessage(readError)}</p>}
 </>;
}
