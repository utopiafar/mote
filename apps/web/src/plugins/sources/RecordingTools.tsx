import {recordingClock} from '../../recording-presentation';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {transcriptSchema,type Transcript} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from '../../api';
import type {Capture} from '../../api';
import {transcriptChunkText} from '../../dialogue-groups';
import { Loading } from '../../Loading';
const limit=64*1024*1024;
const rawNames=new Set(['原始转写.json','Original_transcript.json','Transcription_originale.json','Transcripción_original.json','元の転写.json','Исходный_транскрипт.json','Originaltranskript.json']);
/** Read the current export in memory; never extract paths onto a filesystem. */
export function rawTranscriptFromTar(bytes:Uint8Array,captureId:string,artifactId:string):Transcript{
 const decode=new TextDecoder('utf-8',{fatal:true}),entries=new Map<string,Uint8Array>();let offset=0,total=0;
 const text=(value:Uint8Array)=>decode.decode(value).replace(/\0.*$/s,'');
 while(offset+512<=bytes.length){const header=bytes.subarray(offset,offset+512);if(header.every(value=>value===0))break;
  const name=text(header.subarray(0,100)),sizeText=text(header.subarray(124,136)).trim(),sumText=text(header.subarray(148,156)).trim();
  if(!name||name.startsWith('/')||name.split('/').some(part=>!part||part==='..')||entries.has(name)||!/^0[0-7]*$/.test(sizeText)||!/^[0-7]+$/.test(sumText)||text(header.subarray(257,263))!=='ustar'||header[156]!==48)throw Error(moteText('原始转写导出无效，请重新读取。'));
  const sum=header.reduce((value,byte,index)=>value+(index>=148&&index<156?32:byte),0),size=parseInt(sizeText,8);total+=size;
  if(sum!==parseInt(sumText,8)||!Number.isSafeInteger(size)||size<0||total>limit||offset+512+size>bytes.length)throw Error(moteText('原始转写导出无效，请重新读取。'));
  entries.set(name,bytes.subarray(offset+512,offset+512+size));offset+=512+Math.ceil(size/512)*512;
 }
 if(offset+1024>bytes.length||!bytes.subarray(offset,offset+1024).every(value=>value===0))throw Error(moteText('原始转写导出无效，请重新读取。'));
 const manifestBytes=entries.get('manifest.json');if(!manifestBytes)throw Error(moteText('原始转写导出无效，请重新读取。'));
 const manifest=JSON.parse(decode.decode(manifestBytes));if(manifest.version!==1||manifest.captureId!==captureId||!Array.isArray(manifest.artifacts)||!manifest.artifacts.some((item:any)=>item.id===artifactId&&item.current!==false&&['transcript','text','image-text'].includes(item.kind)))throw Error(moteText('原始转写版本已变化，请重新打开。'));
 const raw=[...entries].filter(([name])=>rawNames.has(name));if(raw.length!==1)throw Error(moteText('原始转写导出无效，请重新读取。'));
 return transcriptSchema.parse(JSON.parse(decode.decode(raw[0][1])));
}
export function RecordingTools({title,onClose,children,className='',footer}:{title:string;onClose:()=>void;children:ReactNode;className?:string;footer?:ReactNode}){
 const panel=useRef<HTMLElement>(null);
 const close=useRef(onClose);close.current=onClose;
 useEffect(()=>{const before=document.activeElement as HTMLElement|null;panel.current?.querySelector<HTMLButtonElement>('button')?.focus();const listener=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close.current();}if(event.key==='Tab'){const items=[...panel.current!.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex="0"]')].filter(item=>!item.hasAttribute('disabled')&&item.getClientRects().length);const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}};document.addEventListener('keydown',listener);return()=>{document.removeEventListener('keydown',listener);if(before?.isConnected)before.focus();};},[]);
 return <div className="modal-backdrop recording-tools-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><section ref={panel} className={'modal recording-dialog '+className} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="icon-button" aria-label={moteText('关闭')} onClick={onClose}>×</button></header><div className="recording-dialog-body">{children}</div><footer>{footer??<button className="button" onClick={onClose}>{moteText('返回')}</button>}</footer></section></div>;
}
type Artifacts={id:string;kind:string}[];
const rawId=(artifacts:Artifacts)=>artifacts.find(item=>['transcript','text','image-text'].includes(item.kind))?.id;
const selectedId=(artifacts:Artifacts)=>(artifacts.find(item=>item.kind==='corrected-dialogue')??artifacts.find(item=>item.kind==='dialogue')??artifacts.find(item=>['transcript','text','image-text'].includes(item.kind)))?.id;
export function RawRecording({api,id,artifacts,compare=false}:{api:Api;id:string;artifacts:Artifacts;compare?:boolean}){
 const pin=rawId(artifacts),selected=compare?selectedId(artifacts):undefined,namesPin=compare?artifacts.find(artifact=>artifact.kind==='speaker-names')?.id:undefined,[version,setVersion]=useState(0),[state,setState]=useState<{owner:Api;id:string;pin?:string;selected?:string;namesPin?:string;data?:Transcript;chunks?:Capture[];error?:string}>();
 useEffect(()=>{const controller=new AbortController();setState(undefined);void(async()=>{if(!pin)throw Error(moteText('原始转写暂不可用。'));const before=await api.request<{artifacts:Artifacts}>('/api/files/'+id,{signal:controller.signal});if(rawId(before.artifacts)!==pin||compare&&(selectedId(before.artifacts)!==selected||before.artifacts.find(artifact=>artifact.kind==='speaker-names')?.id!==namesPin))throw Error(moteText('原始转写版本已变化，请重新打开。'));
  const response=await api.raw('/api/files/'+id+'/export',{signal:controller.signal});if(!response.body)throw Error(moteText('原始转写暂不可用。'));
  const reader=response.body.pipeThrough(new DecompressionStream('gzip')).getReader();const abort=()=>{void reader.cancel().catch(()=>{});};controller.signal.addEventListener('abort',abort,{once:true});
  const parts:Uint8Array[]=[];let size=0;try{for(;;){controller.signal.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>limit+1024*1024)throw Error(moteText('原始转写导出无效，请重新读取。'));parts.push(next.value);}}finally{controller.signal.removeEventListener('abort',abort);await reader.cancel();}
  controller.signal.throwIfAborted();
  const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}const data=rawTranscriptFromTar(bytes,id,pin),chunks:Capture[]=[];
  if(compare){let offset:number|null=0;while(offset!==null){
   controller.signal.throwIfAborted();const page:{items:Capture[];nextOffset:number|null}=await api.request('/api/files/'+id+'/chunks?offset='+offset,{signal:controller.signal});
   if(!Array.isArray(page.items)||page.items.some(chunk=>chunk.fileEvidence?.artifactId!==selected)||chunks.length+page.items.length>50000||page.nextOffset!==null&&(!Number.isSafeInteger(page.nextOffset)||page.nextOffset<=offset||!page.items.length))throw Error(moteText('原始转写版本已变化，请重新打开。'));
   chunks.push(...page.items);offset=page.nextOffset;
  }}
  controller.signal.throwIfAborted();const after=await api.request<{artifacts:Artifacts}>('/api/files/'+id,{signal:controller.signal});if(rawId(after.artifacts)!==pin||compare&&(selectedId(after.artifacts)!==selected||after.artifacts.find(artifact=>artifact.kind==='speaker-names')?.id!==namesPin))throw Error(moteText('原始转写版本已变化，请重新打开。'));if(!controller.signal.aborted)setState({owner:api,id,pin,selected,namesPin,data,chunks});
 })().catch(error=>{if(!controller.signal.aborted)setState({owner:api,id,pin,selected,namesPin,error:errorMessage(error)});});return()=>controller.abort();},[api,id,pin,selected,namesPin,compare,version]);
 const current=state?.owner===api&&state.id===id&&state.pin===pin&&state.selected===selected&&state.namesPin===namesPin?state:undefined;
 return <>{!current&&<Loading/>}{current?.error&&<p role="alert">{current.error}<button className="button" onClick={()=>setVersion(value=>value+1)}>{moteText('重新读取')}</button></p>}{current?.data&&<div className={compare?'policy-grid recording-comparison':undefined}><section>{compare&&<h3>{moteText('原始转写 · 未校正')}</h3>}{!current.data.segments.length&&<p>{moteText('转写结果为空。')}</p>}{current.data.segments.map((segment,index)=><div className="recording-raw-line" key={index}><small>{recordingClock(segment.startMs)} · {segment.speaker??moteText('未标记说话人')}</small><p>{segment.text}</p></div>)}</section>{compare&&<section><h3>{moteText('当前稿')}</h3>{!current.chunks?.length&&<p>{moteText('转写结果为空。')}</p>}{current.chunks?.map(chunk=><div className="recording-raw-line" key={chunk.id}><small>{recordingClock(chunk.fileEvidence?.startMs)} · {chunk.fileEvidence?.speakerAttribution?.name??chunk.fileEvidence?.speaker??moteText('未标记说话人')}</small><p>{transcriptChunkText(chunk)}</p></div>)}</section>}</div>}</>;
}
