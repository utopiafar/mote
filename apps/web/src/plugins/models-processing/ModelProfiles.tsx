import {invalidateConfiguration} from '../../configuration-cache';
import {useResource} from '../../useResource';
import {moteText} from '@mote/shared/i18n';
import {useEffect, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {ArrowLeft, ChevronRight, Copy, Plus, LockKeyhole, Server, Trash2} from 'lucide-react';
import {DEFAULT_AGENT_TIMEOUT_MS, DEFAULT_MODEL_MAX_TOKENS, DEFAULT_MODEL_REQUEST_TIMEOUT_MS, MODEL_FEATURE_LABELS, type ModelFeature, type ModelSettingsView, type ModelTestResult} from '@mote/shared/models';
import {type Api, ApiError, errorMessage} from '../../api';
import {ModelSettingsEditor} from './ModelSettingsEditor';
import {createModelDraft, modelSettingsRequest} from './model-settings-form';

function ProfileDialog({title, busy, onClose, children}: {title:string;busy:boolean;onClose:()=>void;children:ReactNode}) {
 const ref=useRef<HTMLDialogElement>(null);
 useEffect(()=>{const dialog=ref.current!;dialog.showModal();return()=>dialog.close();},[]);
 return <dialog ref={ref} className="model-profile-dialog" aria-label={title} onCancel={event=>{event.preventDefault();if(!busy)onClose();}}><h2>{title}</h2>{children}</dialog>;
}

/** The list and detail share one mounted workspace; returning to the list retains
 * unsaved drafts in memory. Leaving settings keeps the app's existing guard. */
export function ModelProfiles({api,revision,onApplied,onDetailChange}: {
 api:Api;revision:number;onApplied:()=>void;onDetailChange?:(detail:boolean)=>void;
}) {
 const resource=useResource<ModelSettingsView>(api,'/api/model-settings',undefined,revision);
 const [confirmed,setConfirmed]=useState<{api:Api;view:ModelSettingsView}>();
 const withdrawn=resource.error instanceof ApiError&&[401,403,404,410].includes(resource.error.status);
 const view=withdrawn?undefined:confirmed?.api===api&&(!resource.data||confirmed.view.revision>resource.data.revision)?confirmed.view:resource.data;
 const [navigation,setNavigation]=useState<{api:Api;selected:string|null;visited:string[]}>({api,selected:null,visited:[]});
 const selected=navigation.api===api?navigation.selected:null,visited=navigation.api===api?navigation.visited:[];
 const [newProfile,setNewProfile]=useState<{api:Api;value:ModelSettingsView['profiles'][number]}>();
 const pendingProfile=newProfile?.api===api?newProfile.value:undefined;
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmDelete,setConfirmDelete]=useState(false);
 const [copyName,setCopyName]=useState<string|null>(null),[includeCredentials,setIncludeCredentials]=useState(true),[probe,setProbe]=useState<ModelTestResult>();
 const activeApi=useRef(api);activeApi.current=api;
 const request=useRef<AbortController|undefined>(undefined),epoch=useRef(0),listScroll=useRef(0),lastSelection=useRef<string|null>(null),root=useRef<HTMLDivElement>(null);
 useEffect(()=>{setNewProfile(undefined);setNavigation({api,selected:null,visited:[]});setConfirmed(undefined);setBusy(false);setError('');setConfirmDelete(false);setCopyName(null);setProbe(undefined);return()=>{request.current?.abort();request.current=undefined;epoch.current++;};},[api]);
 useEffect(()=>{if(withdrawn)setConfirmed(undefined);},[withdrawn]);
 useEffect(()=>{onDetailChange?.(selected!==null);return()=>onDetailChange?.(false);},[selected,onDetailChange]);
 useEffect(()=>{if(view&&selected&&pendingProfile?.id!==selected&&!view.profiles.some(profile=>profile.id===selected)){setNavigation(value=>({...value,selected:null,visited:value.visited.filter(id=>view.profiles.some(profile=>profile.id===id))}));setCopyName(null);setConfirmDelete(false);}},[view,selected]);
 useLayoutEffect(()=>{if(selected){const title=root.current?.querySelector<HTMLElement>('.model-profile-heading h1');title?.focus({preventScroll:true});window.scrollTo(0,0);}else if(lastSelection.current){const row=Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-model-profile]')??[]).find(item=>item.dataset.modelProfile===lastSelection.current);row?.focus({preventScroll:true});window.scrollTo(0,listScroll.current);}},[selected]);
 const profiles=[...(view?.profiles??[]),...(pendingProfile&&!view?.profiles.some(value=>value.id===pendingProfile.id)?[pendingProfile]:[])],profile=profiles.find(value=>value.id===selected),atCapacity=profiles.filter(value=>!value.readOnly).length>=30;
 const profileName=(value:typeof profiles[number])=>value.readOnly?moteText('部署连接'):value.name;
 const uses=(id:string)=>Object.entries(view?.defaults??{}).filter(([,value])=>value===id).map(([feature])=>MODEL_FEATURE_LABELS[feature as ModelFeature]);
 function choose(id:string|null){if(busy)return;if(id){listScroll.current=window.scrollY;lastSelection.current=id;}setNavigation(value=>({api,selected:id,visited:id?[...new Set([...(value.api===api?value.visited:[]),id])]:value.visited}));setConfirmDelete(false);setCopyName(null);setProbe(undefined);setError('');}
 async function mutate(path:string,method:string,body:unknown,after:string|null){
  if(request.current)return;
  const controller=new AbortController(),generation=++epoch.current;request.current=controller;setBusy(true);setError('');
  const current=()=>activeApi.current===api&&epoch.current===generation&&!controller.signal.aborted;
  try{const next=await api.request<ModelSettingsView>(path,{method,body:JSON.stringify(body),signal:controller.signal});if(!current())return;setConfirmed({api,view:next});invalidateConfiguration(api);setNavigation(value=>({api,selected:after,visited:after?[...new Set([...value.visited,after])]:value.visited.filter(id=>id!==selected)}));setConfirmDelete(false);setCopyName(null);onApplied();}
  catch(failure){if(current())setError(errorMessage(failure));}
  finally{if(current())setBusy(false);if(request.current===controller)request.current=undefined;}
 }
 async function testDeployment(){
  if(!view||!profile||request.current)return;
  const controller=new AbortController(),generation=++epoch.current;request.current=controller;setBusy(true);setError('');setProbe(undefined);
  const current=()=>activeApi.current===api&&epoch.current===generation&&!controller.signal.aborted;
  try{const result=await api.request<ModelTestResult>(`/api/model-settings/profiles/${encodeURIComponent(profile.id)}/test`,{method:'POST',body:JSON.stringify(modelSettingsRequest({...view,settings:profile.settings},createModelDraft(profile.settings))),signal:controller.signal});if(current())setProbe(result);}
  catch(failure){if(current())setError(errorMessage(failure));}
  finally{if(current())setBusy(false);if(request.current===controller)request.current=undefined;}
 }
 return <div ref={root} className="model-connections" aria-busy={busy||resource.loading}>
  {Boolean(error||resource.error)&&<p className="notice error" role="alert">{error||errorMessage(resource.error)}</p>}
  {!view&&resource.loading&&<p role="status">{moteText('正在读取模型设置…')}</p>}
  <section hidden={selected!==null} aria-label={moteText('语言模型')}>
   <div className="section-heading model-connections-heading"><h2>{moteText('语言模型')}</h2><button className="button" disabled={busy||!view||atCapacity} onClick={()=>{if(!view)return;const id=crypto.randomUUID();setNewProfile({api,value:{id,name:moteText('新连接'),settings:{provider:'custom',protocol:'openai-completions',baseUrl:'',model:'',reasoningEffort:'auto',maxTokens:DEFAULT_MODEL_MAX_TOKENS,modelRequestTimeoutMs:DEFAULT_MODEL_REQUEST_TIMEOUT_MS,agentTimeoutMs:DEFAULT_AGENT_TIMEOUT_MS,allowUnauthenticatedLocal:false,apiKeyConfigured:false,headersConfigured:false,extraBodyConfigured:false}}});choose(id);}}><Plus size={15}/>{moteText('语言模型连接')}</button></div>
   <div className="model-profile-list">{profiles.map(value=><button key={value.id} type="button" className="model-profile-row" data-model-profile={value.id} disabled={busy} onClick={()=>choose(value.id)}><span className="model-profile-symbol">{value.readOnly?<LockKeyhole size={18}/>:<Server size={18}/>}</span><span><strong>{profileName(value)}</strong><small>{value.settings.model||moteText('尚未选择模型')}{uses(value.id).length?' · '+moteText('用于：')+uses(value.id).join('、'):''}</small></span><span className="model-row-state">{pendingProfile?.id===value.id?moteText('草稿'):value.readOnly?moteText('部署文件 · 只读'):value.settings.model?moteText('已配置'):moteText('待配置')}</span><ChevronRight size={15}/></button>)}</div>
  </section>
  {profile&&view&&<>
   <button className="text-button model-profile-back" disabled={busy} onClick={()=>choose(null)}><ArrowLeft size={15}/>{moteText('模型连接')}</button>
   <div className="page-heading model-profile-heading"><div><div className="model-title-line"><h1 tabIndex={-1}>{profileName(profile)}</h1>{profile.readOnly&&<span className="model-row-state">{moteText('部署文件 · 只读')}</span>}</div><p>{uses(profile.id).length?moteText('用于：')+uses(profile.id).join('、'):moteText('尚未分配给模块')}</p></div><button className="button" disabled={busy||atCapacity||pendingProfile?.id===profile.id} onClick={()=>{setCopyName((profileName(profile)+moteText(' 副本')).slice(0,100));setIncludeCredentials(true);setConfirmDelete(false);}}><Copy size={15}/>{moteText('复制连接')}</button></div>
   {profile.readOnly&&<section className="model-readonly deployment-provider" aria-label={moteText('部署配置')}><dl><dt>{moteText('默认模型')}</dt><dd>{profile.settings.model||moteText('未配置')}</dd><dt>{moteText('服务地址')}</dt><dd>{profile.settings.baseUrl||moteText('Central 所在机器')}</dd><dt>API key</dt><dd>{profile.settings.apiKeyConfigured?moteText('已配置，不回显'):moteText('未配置')}</dd><dt>{moteText('配置来源')}</dt><dd>{moteText('部署文件')}</dd></dl><div className="model-readonly-actions"><button className="button" disabled={busy||!profile.settings.model} onClick={()=>void testDeployment()}>{busy?moteText('正在测试…'):moteText('测试连接')}</button><small>{moteText('修改前可复制为独立连接')}</small></div>{probe&&<p role="status" className={'notice '+(probe.ok?'success':'error')}>{probe.message}</p>}<details className="model-readonly-advanced"><summary>{moteText('高级设置')}</summary><dl><dt>Provider</dt><dd>{profile.settings.provider}</dd><dt>{moteText('接口协议')}</dt><dd>{profile.settings.protocol}</dd><dt>{moteText('单次模型请求 / Agent 总运行超时')}</dt><dd>{profile.settings.modelRequestTimeoutMs===null?moteText('不适用'):profile.settings.modelRequestTimeoutMs/1000+'s'} / {profile.settings.agentTimeoutMs===null?moteText('未设置'):profile.settings.agentTimeoutMs/1000+'s'}</dd></dl></details></section>}
  </>}
  {view&&visited.map(id=>{const value=profiles.find(item=>item.id===id);return value&&!value.readOnly?<div key={id} hidden={selected!==id}><ModelSettingsEditor api={api} revision={revision} onApplied={onApplied} onSaved={next=>{setConfirmed({api,view:next});setNewProfile(undefined);}} initialProfile={pendingProfile?.id===id?pendingProfile:undefined} profileId={id} visible={selected===id}/>{selected===id&&pendingProfile?.id===id?<div className="model-delete-area"><button className="text-button" onClick={()=>{setNewProfile(undefined);setNavigation(value=>({...value,selected:null,visited:value.visited.filter(item=>item!==id)}));}}>{moteText('取消新建')}</button></div>:selected===id&&<div className="model-delete-area"><button className="text-button" disabled={busy||uses(id).length>0} onClick={()=>setConfirmDelete(true)}><Trash2 size={14}/>{moteText('删除连接')}</button>{uses(id).length>0&&<small>{moteText('先更改使用此连接的模块，再删除。')}</small>}</div>}</div>:null;})}
  {copyName!==null&&profile&&view&&<ProfileDialog title={moteText('复制连接')} busy={busy} onClose={()=>setCopyName(null)}><form onSubmit={event=>{event.preventDefault();const id=crypto.randomUUID();void mutate(`/api/model-settings/profiles/${encodeURIComponent(profile.id)}/copy`,'POST',{revision:view.revision,id,name:copyName.trim(),includeCredentials},id);}}><label className="preference-field">{moteText('副本名称')}<input autoFocus aria-label={moteText('副本名称')} required maxLength={100} value={copyName} disabled={busy} onChange={event=>setCopyName(event.target.value)}/></label><label className="model-copy-choice"><input type="checkbox" checked={includeCredentials} disabled={busy} onChange={event=>setIncludeCredentials(event.target.checked)}/>{moteText('同时复制凭据和高级参数（仅在服务器内部复制）')}</label><p>{moteText('副本独立保存。修改副本不会影响原预设；更换地址时仍需确认凭据复用。')}</p>{error&&<p role="alert">{error}</p>}<div className="model-dialog-actions"><button type="button" className="button" disabled={busy} onClick={()=>setCopyName(null)}>{moteText('取消')}</button><button className="button primary" disabled={busy||!copyName.trim()}>{moteText('创建副本')}</button></div></form></ProfileDialog>}
  {confirmDelete&&profile&&view&&<ProfileDialog title={moteText('删除连接')} busy={busy} onClose={()=>setConfirmDelete(false)}><p>{moteText('删除这套预设及凭据？历史问答保留。')}</p>{error&&<p role="alert">{error}</p>}<div className="model-dialog-actions"><button className="button" disabled={busy} onClick={()=>setConfirmDelete(false)}>{moteText('取消')}</button><button className="button danger" disabled={busy||uses(profile.id).length>0} onClick={()=>void mutate('/api/model-settings/profiles/'+encodeURIComponent(profile.id),'DELETE',{revision:view.revision},null)}>{moteText('确认删除')}</button></div></ProfileDialog>}
 </div>;
}
