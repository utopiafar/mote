import {useEffect,useState} from 'react';
import type {ArchivedFile} from '@mote/shared';
import {httpStatusMessage,commonFailureMessage} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {type Api,ApiError,bytes,errorMessage} from '../../api';
import {ArchivedFileButton} from '../../ArchivedFileButton';
import { Loading } from '../../Loading';
const images=new Set(['image/png','image/jpeg','image/webp','image/gif']);
/** Existing owner-authorized immutable archive bytes; never an invented capture ref. */
export function ArchivedFileReader({api,file,onBack}:{api:Api;file:ArchivedFile;onBack:()=>void}){
 const text=file.mimeType.startsWith('text/')||['application/json','application/x-ndjson'].includes(file.mimeType),image=images.has(file.mimeType);
 const [reload,setReload]=useState(0);
 const [view,setView]=useState<{owner?:Api;fileId?:string;hash?:string;text?:string;url?:string;error?:string;loading:boolean}>({loading:text||image});
 useEffect(()=>{const controller=new AbortController();let url:string|undefined;setView({loading:text||image});if(text||image)void api.raw('/api/archived-files/'+encodeURIComponent(file.id)+'/content',{signal:controller.signal}).then(async response=>{const blob=await response.blob();controller.signal.throwIfAborted();const content=await blob.arrayBuffer();controller.signal.throwIfAborted();const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',content)),byte=>byte.toString(16).padStart(2,'0')).join('');controller.signal.throwIfAborted();if(blob.size!==file.sizeBytes||digest!==file.hash)throw Error(moteText('中央响应格式无效，请刷新后重试。'));if(text){const value=new TextDecoder('utf-8',{fatal:true}).decode(content);controller.signal.throwIfAborted();setView({owner:api,fileId:file.id,hash:file.hash,text:value,loading:false});}else{url=URL.createObjectURL(new Blob([blob],{type:file.mimeType}));setView({owner:api,fileId:file.id,hash:file.hash,url,loading:false});}}).catch(error=>{if(!controller.signal.aborted)setView({owner:api,fileId:file.id,hash:file.hash,loading:false,error:error instanceof ApiError?commonFailureMessage(error.code??'',error.status)||httpStatusMessage(error.status):errorMessage(error)});});return()=>{controller.abort();if(url)URL.revokeObjectURL(url);};},[api,file.id,file.hash,file.mimeType,file.sizeBytes,text,image,reload]);
 const current=view.owner===api&&view.fileId===file.id&&view.hash===file.hash;
 return <article className="import-original-reader"><header><button className="text-button" onClick={onBack}>{moteText('返回导入详情')}</button><ArchivedFileButton api={api} id={file.id} name={file.name}/></header><h1>{file.relativePath||file.name}</h1><p className="muted">{file.mimeType} · {bytes(file.sizeBytes)}</p>{(view.loading||!current&&(text||image))&&<Loading/>}{current&&view.error&&<div><p role="alert">{view.error}</p><button className="button" onClick={()=>setReload(value=>value+1)}>{moteText('重试')}</button></div>}{current&&view.text!==undefined&&<pre>{view.text}</pre>}{current&&view.url&&<img src={view.url} alt={file.name}/>} {!text&&!image&&<p>{moteText('此格式暂无预览')}</p>}</article>;
}
