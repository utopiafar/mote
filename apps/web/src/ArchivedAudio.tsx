import {useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';
import {ArchivedFileButton} from './ArchivedFileButton';
/** Audio is fetched only after an explicit owner playback request. */
export function ArchivedAudio({api,id,name,mimeType}:{api:Api;id:string;name:string;mimeType:string}){
 const [url,setUrl]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),objectUrl=useRef(''),scope=useRef(new AbortController());
 useEffect(()=>{const controller=new AbortController();scope.current=controller;setUrl('');setBusy(false);setError('');return()=>{controller.abort();if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current='';};},[api,id]);
 const play=async()=>{const signal=scope.current.signal;setBusy(true);setError('');try{const response=await api.raw('/api/archived-files/'+encodeURIComponent(id)+'/content',{signal});const bytes=await response.blob();signal.throwIfAborted();const value=URL.createObjectURL(new Blob([bytes],{type:mimeType}));objectUrl.current=value;setUrl(value);}catch(e){if(!signal.aborted)setError(errorMessage(e));}finally{if(!signal.aborted)setBusy(false);}};
 return <div>{url?<audio controls src={url} preload="metadata" aria-label={moteText('原始录音')}/>:<button className="button subtle" disabled={busy} onClick={()=>void play()}>{busy?moteText('正在读取…'):moteText('回听原始录音')}</button>} <ArchivedFileButton api={api} id={id} name={name}/>{error&&<p role="alert">{error}</p>}</div>;
}
