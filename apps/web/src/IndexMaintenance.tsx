import {useLayoutEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage,apiOwnerKey} from './api';
import {useResource} from './useResource';
type Job={id:string;operationId:string;state:string;attempts:number;error?:string};
export function IndexMaintenance({api}:{api:Api}){
 const read=useResource<{scope:'instance-index';mode:'text';contentVisible:false;job?:Job}>(api,'/api/admin/index',1000),[error,setError]=useState(''),[busy,setBusy]=useState(false),[pending,setPending]=useState<string>(),[invalid,setInvalid]=useState(false),alive=useRef(false),request=useRef<AbortController|undefined>(undefined),intent=useRef<string|undefined>(undefined),key='mote.index-rebuild.v1:'+apiOwnerKey(api);
 useLayoutEffect(()=>{alive.current=true;try{const value=localStorage.getItem(key);if(value){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw Error(moteText('服务返回的操作回执与当前账号不一致。'));intent.current=value;setPending(value);}}catch(e){setInvalid(true);setError(errorMessage(e));}return()=>{alive.current=false;request.current?.abort();};},[api,key]);
 async function change(cancel=false){if(!alive.current||request.current||invalid)return;const controller=new AbortController();request.current=controller;setBusy(true);setError('');try{
  const id=cancel?read.data?.job?.id:undefined;if(cancel&&!id)return;
  if(!cancel){intent.current??=crypto.randomUUID();localStorage.setItem(key,intent.current);setPending(intent.current);}
  const value=await api.request<Job>(cancel?'/api/admin/index/'+id+'/cancel':'/api/admin/index/rebuild',{method:'POST',signal:controller.signal,body:JSON.stringify(cancel?{}:{operationId:intent.current})});
  if(!alive.current||controller.signal.aborted)return;if(!/^[a-f0-9]{64}$/.test(value.id)||cancel&&value.id!==id||!cancel&&value.operationId!==intent.current)throw Error(moteText('服务返回的操作回执与当前账号不一致。'));
  if(!cancel){localStorage.removeItem(key);intent.current=undefined;setPending(undefined);}read.refresh();
 }catch(e){if(alive.current&&!controller.signal.aborted)setError(errorMessage(e));}finally{if(alive.current&&request.current===controller){request.current=undefined;setBusy(false);}}}
 const job=read.data?.job;
 return <section className="index-statuses"><h2>{moteText('检索索引')}</h2><p>{moteText('重建共享全文索引；来源、账号和原件授权在提交结果前重新核对。')}</p>{job&&<p role="status">{job.state} · {moteText('已尝试 {0} 次',job.attempts)}{job.error?' · '+job.error:''}</p>}<button className="button" disabled={busy||invalid||!pending&&!!job&&['waiting','running'].includes(job.state)} onClick={()=>void change()}>{pending?moteText('重试原操作'):moteText('重建索引')}</button>{job&&['waiting','running','blocked'].includes(job.state)&&<button className="button subtle" disabled={busy||invalid} onClick={()=>void change(true)}>{moteText('取消')}</button>}{pending&&<p>{moteText('提交结果待确认；重试会使用原操作，不会重新创建任务。')}</p>}{(pending||invalid)&&<button className="button subtle" disabled={busy} onClick={()=>{localStorage.removeItem(key);intent.current=undefined;setPending(undefined);setInvalid(false);setError('');}}>{moteText('移除本机待确认提交')}</button>}{Boolean(error||read.error)&&<p role="alert">{error||errorMessage(read.error)}</p>}</section>;
}
