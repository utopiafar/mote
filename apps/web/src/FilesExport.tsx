import {useLayoutEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from './api';

export function FilesExport({api}:{api:Api}){
 const [type,setType]=useState(''),[selection,setSelection]=useState('current'),[busy,setBusy]=useState(false),[error,setError]=useState(''),alive=useRef(false),request=useRef<AbortController|undefined>(undefined),urls=useRef(new Set<string>());
 useLayoutEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();};},[api]);
 async function download(mode:'metadata'|'data'){
  if(!alive.current||request.current||!type)return;const controller=new AbortController();request.current=controller;setBusy(true);setError('');try{
   const response=await api.raw('/api/files/export?'+new URLSearchParams({mode,type,selection}),{signal:controller.signal}),blob=await response.blob();if(!alive.current||controller.signal.aborted)return;
   if(response.status!==200||response.headers.has('content-range')||response.headers.get('content-type')?.split(';')[0]!=='application/gzip'||response.headers.has('content-length')&&Number(response.headers.get('content-length'))!==blob.size)throw Error(moteText('归档校验失败，请重新读取操作回执。'));
   const url=URL.createObjectURL(blob);urls.current.add(url);const anchor=document.createElement('a');anchor.href=url;anchor.download='mote-files-'+mode+'.tar.gz';anchor.click();
  }catch(e){if(alive.current&&!controller.signal.aborted)setError(errorMessage(e));}finally{if(alive.current&&request.current===controller){request.current=undefined;setBusy(false);}}
 }
 return <section className="files-export"><p>{moteText('按文件类型导出本人的原件与已声明附件。元数据模式不读取文件字节；历史范围只包含仍获授权的保留版本。')}</p><label>{moteText('文件类型')}<select aria-label={moteText('导出文件类型')} disabled={busy} value={type} onChange={event=>setType(event.target.value)}><option value="">{moteText('请选择')}</option>{['*/*','text/*','image/*','audio/*','video/*','application/pdf','application/json'].map(value=><option key={value} value={value}>{value}</option>)}</select></label><label>{moteText('版本范围')}<select aria-label={moteText('导出版本范围')} disabled={busy} value={selection} onChange={event=>setSelection(event.target.value)}><option value="current">{moteText('当前版本')}</option><option value="history">{moteText('包含保留历史')}</option></select></label><div className="transfer-export-actions"><button className="button subtle" disabled={!type||busy} onClick={()=>void download('metadata')}>{moteText('导出元数据')}</button><button className="button subtle" disabled={!type||busy} onClick={()=>void download('data')}>{moteText('导出资料与附件')}</button>{busy&&<button className="button subtle" onClick={()=>{request.current?.abort();request.current=undefined;setBusy(false);}}>{moteText('取消')}</button>}</div>{error&&<p role="alert">{error}</p>}</section>;
}
