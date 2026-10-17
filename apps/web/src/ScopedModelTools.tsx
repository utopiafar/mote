import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {moteText} from '@mote/shared/i18n';
import type {ConfigServiceView} from '@mote/shared';
import {errorMessage,type Api} from './api';

const catalogSchema=z.object({items:z.array(z.object({id:z.string().min(1),name:z.string().min(1)}))});
const probeSchema=z.object({ok:z.boolean(),code:z.enum(['ok','not_configured','timeout','provider_error','invalid_response']),message:z.string(),durationMs:z.number().finite().nonnegative()}).refine(value=>value.ok===(value.code==='ok'));
export type ModelToolsContext={revision:number;dirty:boolean;onApplied:(view:ConfigServiceView)=>void};

/** The original manual controls inspect a fixed saved M04 reference. */
export function ScopedModelTools({api,id,name,kind='personal',tools,onSelect}:{api:Api;id:string;name:string;kind?:'personal'|'shared';tools:ModelToolsContext;onSelect?:(id:string)=>void}){
 const live=useRef(false),generation=useRef(0),request=useRef<AbortController|undefined>(undefined);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[catalog,setCatalog]=useState<z.infer<typeof catalogSchema>['items']>([]),[copyName,setCopyName]=useState<string|null>(null),[includeCredentials,setIncludeCredentials]=useState(true);
 useEffect(()=>{live.current=true;generation.current++;request.current?.abort();setBusy(false);setError('');setMessage('');setCatalog([]);setCopyName(null);return()=>{live.current=false;generation.current++;request.current?.abort();};},[api,id,kind,tools.revision,tools.dirty]);
 async function run(operation:'catalog'|'probe'|'copy'){
  if(!live.current||tools.dirty||busy)return;
  const controller=new AbortController(),epoch=generation.current,current=()=>live.current&&epoch===generation.current&&!controller.signal.aborted;
  request.current?.abort();request.current=controller;setBusy(true);setError('');setMessage('');
  try{
   const reference={kind,id},input={revision:tools.revision,reference};
   if(operation==='catalog'){
    const result=catalogSchema.parse(await api.request('/api/models/catalog',{method:'POST',body:JSON.stringify(input),signal:controller.signal}));
    if(current())setCatalog(result.items);
   }else if(operation==='probe'){
    const result=probeSchema.parse(await api.request('/api/models/probe',{method:'POST',body:JSON.stringify(input),signal:controller.signal}));
    if(current())setMessage(result.message);
   }else{
    if(kind!=='personal'||!copyName?.trim())return;
    const copyId=crypto.randomUUID(),next=await api.request<ConfigServiceView>('/api/models/profiles/'+encodeURIComponent(id)+'/copy',{method:'POST',body:JSON.stringify({revision:tools.revision,id:copyId,name:copyName.trim(),includeCredentials}),signal:controller.signal});
    if(current())tools.onApplied(next);
   }
  }catch(cause){if(current())setError(errorMessage(cause));}
  finally{if(current())setBusy(false);}
 }
 return <div className="provider-actions scoped-model-tools">
  <div className="provider-action-buttons"><button type="button" className="button subtle" disabled={busy||tools.dirty} onClick={()=>void run('catalog')}>{moteText('刷新模型列表')}</button><button type="button" className="button subtle" disabled={busy||tools.dirty} onClick={()=>void run('probe')}>{moteText('测试连接')}</button>{kind==='personal'&&<button type="button" className="button subtle" disabled={busy||tools.dirty} onClick={()=>{if(!live.current)return;setCopyName((name+moteText(' 副本')).slice(0,100));setIncludeCredentials(true);}}>{moteText('复制预设')}</button>}</div>
  {onSelect&&<label>{moteText('可用模型')}<select aria-label={moteText('可用模型')} disabled={busy||tools.dirty} value="" onChange={event=>{if(live.current&&event.target.value)onSelect(event.target.value);}}><option value="">{moteText('选择模型，或在下方手动填写')}</option>{catalog.map(model=><option key={model.id} value={model.id}>{model.name===model.id?model.id:model.name+' · '+model.id}</option>)}</select></label>}
  {!onSelect&&catalog.length>0&&<ul>{catalog.map(model=><li key={model.id}>{model.name} · {model.id}</li>)}</ul>}
  <small>{moteText('这些操作使用已保存的连接；修改草稿后请先保存并应用。')}</small><small>{moteText('测试连接会由中央节点发送少量合成内容，最多等待 30 秒，可能产生少量费用；不会读取资料库。测试不会保存草稿。')}</small>
  {copyName!==null&&<div className="provider-inline-form"><label>{moteText('副本名称')}<input aria-label={moteText('副本名称')} maxLength={100} value={copyName} onChange={event=>setCopyName(event.target.value)} disabled={busy}/></label><label className="provider-copy-choice"><input type="checkbox" aria-label={moteText('同时复制凭据和高级参数（仅在服务器内部复制）')} checked={includeCredentials} onChange={event=>setIncludeCredentials(event.target.checked)} disabled={busy}/>{moteText('同时复制凭据和高级参数（仅在服务器内部复制）')}</label><button type="button" className="button primary" disabled={busy||tools.dirty||!copyName.trim()} onClick={()=>void run('copy')}>{moteText('创建副本')}</button><button type="button" className="button subtle" disabled={busy} onClick={()=>setCopyName(null)}>{moteText('取消')}</button></div>}
  {error&&<p className="notice error" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
 </div>;
}
