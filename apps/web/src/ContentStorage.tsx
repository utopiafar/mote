import { moteText } from '@mote/shared/i18n';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {ApiError,type Api,errorMessage,apiOwnerKey} from './api';
import {useResource} from './useResource';
import {invalidateConfiguration} from './configuration-cache';

interface StorageState {
  enabled:boolean;
  revision:number;
  job:{state:'idle'|'running'|'completed'|'cancelled'|'blocked'|'failed';id?:string;operationId?:string;sequence?:number;total:number;processed:number;converted:number;skipped:number;failed:number};
}
const count=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scopedState=z.object({scope:z.literal('account'),enabled:z.boolean(),revision:count,coverage:z.object({originals:z.literal(true),uploadParts:z.literal(true),credentials:z.literal(false),privateDatabase:z.literal(false)}),job:z.object({state:z.enum(['idle','running','completed','cancelled','blocked','failed']),id:z.string().regex(/^[a-f0-9]{64}$/).optional(),operationId:z.string().uuid().optional(),sequence:count,total:count,processed:count,converted:count,skipped:count,failed:count}).refine(job=>job.processed<=job.total&&job.converted+job.skipped+job.failed===job.processed&&(job.state==='idle'?job.sequence===0:!!job.id&&!!job.operationId&&job.sequence>0))});
export function ContentStorage(props:{api:Api;onChange?:()=>void}){return <ContentStorageView key={JSON.stringify(props.api.connection)} {...props}/>;}
function ContentStorageView({api,onChange}:{api:Api;onChange?:()=>void}) {
  const scoped=api.connection?.mode==='web',key='mote.content-decrypt.v1:'+apiOwnerKey(api),alive=useRef(false),request=useRef<AbortController|undefined>(undefined),intent=useRef<string|undefined>(undefined),[pending,setPending]=useState<string>(),[invalidIntent,setInvalidIntent]=useState(false);
  useLayoutEffect(()=>{alive.current=true;if(scoped)try{const saved=localStorage.getItem(key);if(saved){z.object({operationId:z.string().uuid()}).strict().parse(JSON.parse(saved));intent.current=saved;setPending(saved);}}catch(e){setInvalidIntent(true);setError(errorMessage(e));}return()=>{alive.current=false;request.current?.abort();request.current=undefined;};},[api,key,scoped]);
  const [view,setView]=useState<{api:Api;value:StorageState}>();
  const state=view?.api===api?view.value:undefined,activeApi=useRef(api);activeApi.current=api;
  const setState=(raw:StorageState)=>{let value:StorageState;try{value=scoped?scopedState.parse(raw):raw;}catch{throw Error(moteText('服务返回的操作回执与当前账号不一致。'));}if(!alive.current||activeApi.current!==api)return;if(scoped&&intent.current&&JSON.parse(intent.current).operationId===value.job.operationId){if(localStorage.getItem(key)===intent.current)localStorage.removeItem(key);intent.current=undefined;setPending(undefined);}setView(previous=>previous?.api===api&&(previous.value.revision>value.revision||(previous.value.job.sequence??0)>(value.job.sequence??0))?previous:{api,value});};
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  const read=useResource<StorageState>(api,'/api/content-storage',state?.job.state==='running'?500:undefined);
  useEffect(()=>{setError('');setBusy(false);},[api]);
  useEffect(()=>{if(read.data)try{setState(read.data);}catch(e){setError(errorMessage(e));setView(undefined);}if(read.error){setError(errorMessage(read.error));if(read.error instanceof ApiError&&[401,403,404,410].includes(read.error.status))setView(undefined);}},[api,read.data,read.error]);
  async function change(path:string,method:string,body:object) {
    if(!alive.current||request.current)return;const controller=new AbortController();request.current=controller;setBusy(true);setError('');
    const current=()=>alive.current&&activeApi.current===api&&request.current===controller&&!controller.signal.aborted;
    try{const encoded=path==='/api/content-storage/decrypt'&&scoped?(intent.current??JSON.stringify({operationId:crypto.randomUUID()})):JSON.stringify(body);if(path==='/api/content-storage/decrypt'&&scoped){localStorage.setItem(key,encoded);intent.current=encoded;setPending(encoded);}const next=await api.request<StorageState>(path,{method,body:encoded,signal:controller.signal});if(current()){if(scoped&&(path==='/api/content-storage/decrypt'&&scopedState.parse(next).job.operationId!==JSON.parse(encoded).operationId||path==='/api/content-storage/decrypt/cancel'&&scopedState.parse(next).job.id!==JSON.parse(encoded).taskId))throw Error(moteText('服务返回的操作回执与当前账号不一致。'));setState(next);invalidateConfiguration(api);onChange?.();}}
    catch(e){if(current())setError(errorMessage(e));}finally{if(current()){request.current=undefined;setBusy(false);}}
  }
  const running=state?.job.state==='running';
  return <section className="panel" aria-labelledby="content-storage-title">
    <div className="section-heading"><div><h2 id="content-storage-title">{moteText("内容存储")}</h2><p>{scoped?moteText("当前账号 · 默认明文保存"):moteText("中央节点 · 默认明文保存")}</p></div></div>
    <label className="check-field"><input type="checkbox" checked={state?.enabled??false} disabled={!state||busy||running||state.job.state==='blocked'||!!pending||invalidIntent}
      onChange={event=>void change('/api/content-storage','PUT',{enabled:event.target.checked,revision:state!.revision})}/>{moteText("加密后续保存的图片和原件")}</label>
    <p className="fine-print">{moteText("开关立即生效，已有文件保持原格式并可继续读取。记录正文和索引存储在 SQLite 中；客户端的本地存储可在各自开发者选项中设置。")}</p>
    <div className="diagnostics-actions">
      <button className="button primary" disabled={!state||state.enabled||busy||invalidIntent||(!pending&&(running||state.job.state==='blocked'))} onClick={()=>void change('/api/content-storage/decrypt','POST',{})}>{pending?moteText("重试原操作"):moteText("一次性批量解密")}</button>
      {(running||state?.job.state==='blocked')&&<button className="button subtle" disabled={busy} onClick={()=>void change('/api/content-storage/decrypt/cancel','POST',scoped?{taskId:state!.job.id}:{})}>{moteText("取消解密")}</button>}
    </div>
    {(pending||invalidIntent)&&<div className="notice"><p>{invalidIntent?moteText('服务返回的操作回执与当前账号不一致。'):moteText('提交结果待确认；重试会使用原操作，不会重新创建任务。')}</p><button className="button subtle" disabled={busy} onClick={()=>{if(!alive.current)return;if(scoped)localStorage.removeItem(key);intent.current=undefined;setPending(undefined);setInvalidIntent(false);setError('');}}>{moteText('移除本机待确认提交')}</button><p className="fine-print">{moteText('移除本机提交不会取消已经准入的中央任务；可在活动中查看。')}</p></div>}
    <p className="fine-print">{moteText("关闭上方加密后，可将已有图片、原件和待上传分片逐项转换为明文。任务在后台运行，离开页面仍会继续；取消后保留已完成结果，可再次运行。连接凭据不参与转换。")}</p>
    {!state&&!error&&<p role="status">{moteText("正在读取存储设置…")}</p>}
    {state&&state.job.state!=='idle'&&<div role="status" aria-live="polite">
      {running?moteText("正在解密"):state.job.state==='cancelled'?moteText("已取消"):state.job.state==='blocked'?moteText('等待处理'):state.job.state==='failed'?moteText('处理失败'):moteText("处理完成")}{' '}{moteText("· 已检查")}{' '}{state.job.processed}/{state.job.total}{' '}{moteText("项 · 已转换")}{' '}{state.job.converted}{' '}{moteText("项 · 无需转换")}{' '}{state.job.skipped}{' '}{moteText("项 · 失败")}{' '}{state.job.failed}{' '}{moteText("项")}{running&&<progress aria-label={moteText("批量解密进度")} value={state.job.processed} max={Math.max(1,state.job.total)}/>}
      {state.job.failed>0&&<p>{moteText("失败项保留原文件，请检查原密钥和存储空间后重试。")}</p>}
    </div>}
    {error&&<p className="notice error" role="alert">{error}</p>}
    {error&&<button className="button subtle" disabled={busy} onClick={()=>void api.request<StorageState>('/api/content-storage').then(value=>{if(activeApi.current===api){setState(value);setError('');}},e=>{if(activeApi.current===api)setError(errorMessage(e));})}>{moteText('重新读取')}</button>}
  </section>;
}
