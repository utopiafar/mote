import {z} from 'zod';
import {actionPluginIdentitySchema,actionSourceIdentitySchema} from '@mote/shared';
import React,{useEffect,useState} from 'react';
import type {ActionCapabilityDraft,ActionDeviceCapability,ActionGrant,ActionPluginProvider} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {createApi,errorMessage} from './api';
import {useResource} from './useResource';
import {useUnsavedChanges} from './unsaved';
type Inventory={providers:ActionPluginProvider[];grants:(ActionGrant&{available:boolean})[];declarations:ActionDeviceCapability[];drafts:ActionCapabilityDraft[];sources:(ActionCapabilityDraft['inputs']['sources'][number]&{name:string})[]};
// Validate the fields rendered/selected here. A malformed response is an error,
// never an empty inventory or permission to submit a partial grant.
const targetView=z.object({deviceId:z.string(),calendarId:z.string(),declarationRevision:z.number().int().positive()});
const inputView=z.object({sources:z.array(actionSourceIdentitySchema),existingArchived:z.boolean(),futureInputs:z.boolean()});
const draftView=z.object({id:z.string(),revision:z.number().int().positive(),target:targetView,inputs:inputView,state:z.enum(['draft','revoked']),updatedAt:z.string()});
const inventoryView=z.object({
 providers:z.array(z.object({identity:actionPluginIdentitySchema,name:z.string()})),
 declarations:z.array(z.object({deviceId:z.string(),connectionActive:z.boolean(),permission:z.enum(['granted','required','unavailable']),revision:z.number().int().positive(),calendars:z.array(z.object({id:z.string(),title:z.string()}))})),
 sources:z.array(actionSourceIdentitySchema.extend({name:z.string()})),drafts:z.array(draftView),
 grants:z.array(draftView.omit({state:true}).extend({plugin:actionPluginIdentitySchema,state:z.enum(['active','revoked']),available:z.boolean()})),
});
const pendingCommands=new WeakMap<object,Map<string,unknown>>();
const scopes=new WeakMap<object,number>();let nextScope=0;
const edits=new WeakMap<object,{target:string;sources:string[];existing:boolean;future:boolean;saved?:ActionCapabilityDraft;plugin:string;dirty:boolean}>();
export function ActionCapabilitySettings({api}:{api:ReturnType<typeof createApi>}){if(!scopes.has(api))scopes.set(api,++nextScope);return <ScopedSettings key={scopes.get(api)} api={api}/>;}
function ScopedSettings({api}:{api:ReturnType<typeof createApi>}){
 const read=useResource<Inventory>(api,'/api/action-capabilities',15000),parsed=inventoryView.safeParse(read.data),malformed=read.data!==undefined&&!parsed.success;
 const data=read.error===undefined&&parsed.success?read.data:undefined;
 const prior=edits.get(api);
 const [target,setTarget]=useState(prior?.target??''),[sources,setSources]=useState<string[]>(prior?.sources??[]),[existing,setExisting]=useState(prior?.existing??false),[future,setFuture]=useState(prior?.future??true),[saved,setSaved]=useState<ActionCapabilityDraft|undefined>(prior?.saved),[plugin,setPlugin]=useState(prior?.plugin??''),[ack,setAck]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[dirty,setDirty]=useState(prior?.dirty??false);
 useEffect(()=>{edits.set(api,{target,sources,existing,future,saved,plugin,dirty});},[api,target,sources,existing,future,saved,plugin,dirty]);
 const [commands]=useState(()=>{let value=pendingCommands.get(api);if(!value){value=new Map();pendingCommands.set(api,value);}return value;});
 useUnsavedChanges(dirty);
 const change=()=>{setDirty(true);setSaved(undefined);setAck(false);commands.delete('save');commands.delete('grant');};
 const run=async(fn:()=>Promise<void>)=>{setBusy(true);setError('');try{await fn();read.refresh();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}};
 const command=(key:string,build:()=>unknown)=>{if(!commands.has(key))commands.set(key,build());return commands.get(key);};
 const request=(path:string,body:unknown,method='POST')=>api.request(path,{method,body:JSON.stringify(body)});
 const choices=data?.declarations.filter(d=>d.connectionActive&&d.permission==='granted').flatMap(d=>d.calendars.map(c=>({value:JSON.stringify({deviceId:d.deviceId,calendarId:c.id,declarationRevision:d.revision}),label:d.deviceId+' · '+c.title})))??[];
 return <details className="panel action-settings"><summary>{moteText('日程执行范围授权')}</summary>
 <p>{moteText('授权后，范围内明确且未过期的新建日程可由指定设备执行。不会邀请参与人、更新或删除日程；范围外建议仍需逐条确认。')}</p>
 {read.loading&&!data&&<p role="status">{moteText('正在读取…')}</p>}{(!!error||read.error!==undefined||malformed)&&<p role="alert">{error||(read.error!==undefined?errorMessage(read.error):moteText('中央响应格式无效，请刷新后重试。'))}</p>}
 <button className="button" disabled={busy} onClick={()=>read.refresh()}>{moteText('刷新')}</button>
 {data&&<><p>{moteText('先在设备连接日历，并在插件中心安装、检查和启用声明日历能力的插件。安装和升级不会自动授予执行权限。')}</p>
 {!data.providers.length&&<p role="status">{moteText('暂无已检查并启用的日历能力插件。')}</p>}{!choices.length&&<p role="status">{moteText('暂无已连接的可写日历。')}</p>}
 <fieldset disabled={busy}><label>{moteText('选择设备和日历')}<select value={target} onChange={e=>{change();setTarget(e.target.value);}}><option value="">{moteText('请选择目标日历')}</option>{choices.map(c=><option key={c.value} value={c.value}>{c.label}</option>)}</select></label>
 <p>{moteText('授权资料来源')}</p>{data.sources.map(s=><label key={s.sourceId}><input type="checkbox" checked={sources.includes(s.sourceId)} onChange={e=>{change();setSources(e.target.checked?[...sources,s.sourceId]:sources.filter(id=>id!==s.sourceId));}}/>{s.name} · {s.deviceId}</label>)}
 <label><input type="checkbox" checked={existing} onChange={e=>{change();setExisting(e.target.checked);}}/>{moteText('包括已归档资料')}</label><label><input type="checkbox" checked={future} onChange={e=>{change();setFuture(e.target.checked);}}/>{moteText('包括授权后新增资料')}</label>
 <button className="button" disabled={!target||!sources.length||(!existing&&!future)} onClick={()=>void run(async()=>{const body=command('save',()=>({id:crypto.randomUUID(),operationId:crypto.randomUUID(),expectedRevision:0,capability:{id:'calendar.create',version:1},target:JSON.parse(target),inputs:{sources:data.sources.filter(s=>sources.includes(s.sourceId)).map(({name,...identity})=>identity),existingArchived:existing,futureInputs:future}}));const result=await request('/api/action-capability-drafts',body,'PUT') as ActionCapabilityDraft;setSaved(result);setDirty(false);})}>{moteText('保存范围草稿')}</button>
 <p>{moteText('已保存草稿可在返回或重启后继续；保存草稿不会执行。')}</p>{data.drafts.filter(d=>d.state==='draft').map(d=><button key={d.id} className="button subtle" onClick={()=>{commands.clear();setSaved(d);setDirty(false);setAck(false);setTarget(JSON.stringify(d.target));setSources(d.inputs.sources.map(s=>s.sourceId));setExisting(d.inputs.existingArchived);setFuture(d.inputs.futureInputs);}}>{moteText('继续草稿')} · {d.target.deviceId} · {d.target.calendarId} · {d.updatedAt}</button>)}
 {saved&&<><label>{moteText('日历能力插件')}<select value={plugin} onChange={e=>{setPlugin(e.target.value);setAck(false);commands.delete('grant');}}><option value="">{moteText('请选择')}</option>{data.providers.map(p=><option key={p.identity.instanceId} value={JSON.stringify(p.identity)}>{p.name} · {p.identity.releaseDigest.slice(0,12)}</option>)}</select></label><label><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/>{moteText('我允许此插件按以上资料范围，在指定设备日历中创建日程。')}</label><button className="button primary" disabled={!plugin||!ack} onClick={()=>void run(async()=>{await request('/api/action-capability-grants',command('grant',()=>({id:crypto.randomUUID(),operationId:crypto.randomUUID(),expectedRevision:0,draftId:saved.id,draftRevision:saved.revision,plugin:JSON.parse(plugin),acknowledgeCalendarWrites:true})),'PUT');setAck(false);setSaved(undefined);commands.clear();})}>{moteText('确认范围授权')}</button></>}
 </fieldset>
 <h3>{moteText('已有范围授权')}</h3>{!data.grants.length&&<p>{moteText('尚未授予日程执行权限。')}</p>}{data.grants.map(g=><article key={g.id}><p>{g.plugin.packageId} · {g.target.deviceId} · {g.target.calendarId} · {g.state==='revoked'?moteText('已撤销'):g.available?moteText('范围授权有效'):moteText('授权条件已变化，请重新核对')}</p><p>{g.inputs.sources.map(s=>data.sources.find(x=>x.sourceId===s.sourceId)?.name??s.sourceId).join('、')} · {g.inputs.existingArchived?moteText('包括已归档资料'):''} {g.inputs.futureInputs?moteText('包括授权后新增资料'):''}</p>{g.state==='active'&&<button className="button" disabled={busy} onClick={()=>void run(async()=>{await request(`/api/action-capability-grants/${g.id}/revoke`,command('revoke:'+g.id+':'+g.revision,()=>({operationId:crypto.randomUUID(),expectedRevision:g.revision})));})}>{moteText('撤销范围授权')}</button>}</article>)}<p>{moteText('撤销会阻止尚未领取的写入；已开始的写入仍须等待结果，不会自动删除日历事件。')}</p></>}
 </details>;
}
