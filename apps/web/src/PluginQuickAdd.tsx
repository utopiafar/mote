import React,{useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {MemoryBindingView,PluginCenterView,PluginInstanceView,PluginReleasePreview} from '@mote/shared';
import {ApiError,errorMessage,type Api} from './api';
import {PluginConfiguration} from './PluginConfiguration';
import {confirmNavigation} from './unsaved';
import {clearQuickAdd,quickConfiguration,quickPackage,quickRecipes,readQuickAdd,saveQuickAdd,type QuickAdd,type QuickIntent,type QuickRecipe} from './plugin-quick-add';

/** A guided consumer of the existing owner controls. It never enables a plugin,
 * changes a binding or treats a declaration as verified runtime capability. */
export function PluginQuickAdd({api,viewScope,view,binding,refresh,onManage}:{api:Api;viewScope?:string;view?:PluginCenterView;binding?:MemoryBindingView;refresh:()=>void;onManage:(packageId:string)=>void}){
 const [flow,setFlow]=useState<QuickAdd|undefined>(()=>readQuickAdd(viewScope)),[opened,setOpened]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[fee,setFee]=useState(false);
 const active=useRef({api,viewScope}),controller=useRef<AbortController|undefined>(undefined),working=useRef(false);active.current={api,viewScope};
 useEffect(()=>{controller.current?.abort();working.current=false;setBusy(false);setError('');setFee(false);setFlow(readQuickAdd(viewScope));return()=>controller.current?.abort();},[api,viewScope]);
 function persist(next:QuickAdd){if(!saveQuickAdd(next)){setError(moteText('无法保存添加进度。尚未发送新的操作，请使用原有插件管理流程。'));return false;}setFlow(next);return true;}
 function clear(){clearQuickAdd();setFlow(undefined);setFee(false);setError('');}
 function manage(){if(!flow||!confirmNavigation())return;const packageId=quickPackage(flow);clear();onManage(packageId);}
 function current(owner:Api,scope:string|undefined,signal:AbortSignal){return active.current.api===owner&&active.current.viewScope===scope&&!signal.aborted;}
 async function resolve(recipe:QuickRecipe){
  if(working.current||flow||!view?.installation.supported)return;
  if(!viewScope){setError(moteText('登录会话无法保存添加进度，请使用原有插件管理流程。'));return;}
  if(!confirmNavigation())return;
  const owner=api,scope=viewScope,abort=new AbortController();controller.current?.abort();controller.current=abort;working.current=true;setBusy(true);setError('');
  try{const preview=await owner.request<PluginReleasePreview>('/api/plugins/resolve',{method:'POST',body:JSON.stringify({repository:recipe.repository,tag:recipe.tag}),signal:abort.signal});
   if(current(owner,scope,abort.signal)&&persist({version:1,scope,recipe:recipe.id,preview,stage:'preview'}))setOpened(true);
  }catch(cause){if(current(owner,scope,abort.signal))setError(errorMessage(cause));}
  finally{if(current(owner,scope,abort.signal)){working.current=false;setBusy(false);}}
 }
 async function execute(next:QuickAdd,intent:QuickIntent){
  if(working.current||active.current.api!==api||active.current.viewScope!==viewScope||next.scope!==viewScope||!persist({...next,pending:intent,conflict:false}))return;
  const owner=api,scope=viewScope,abort=new AbortController();controller.current?.abort();controller.current=abort;working.current=true;setBusy(true);setError('');
  try{const result=await owner.request<PluginCenterView|PluginInstanceView>(intent.path,{method:intent.method,body:intent.body,signal:abort.signal});
   if(!current(owner,scope,abort.signal))return;
   const settled={...next,pending:undefined,conflict:false,viewRevision:(view?.revision??0)+1};
   if(intent.phase==='install')persist({...settled,stage:'installing',packageId:quickPackage(next)});
   else if(intent.phase==='configure'){
    const instance=result as PluginInstanceView,requested=JSON.parse(intent.body);
    const same=instance.id===next.instanceId&&instance.packageId===quickPackage(next)&&Object.entries(requested.configuration).every(([key,value])=>instance.configuration[key]===value);
    persist({...settled,stage:'configured',conflict:!same,instanceSnapshot:{revision:instance.revision,configuration:instance.configuration}});
   }else persist({...settled,stage:'checking',instanceSnapshot:{revision:JSON.parse(intent.body).expectedRevision+2,configuration:next.instanceSnapshot!.configuration}});
   refresh();
  }catch(cause){if(!current(owner,scope,abort.signal))return;
   if(cause instanceof ApiError&&[401,403,404,410].includes(cause.status)){clear();setError(errorMessage(cause));}
   else{setError(errorMessage(cause));if(cause instanceof ApiError&&[409,422].includes(cause.status))persist({...next,pending:undefined,conflict:true});}
   refresh();
  }finally{if(current(owner,scope,abort.signal)){working.current=false;setBusy(false);}}
 }
 function command(phase:QuickIntent['phase'],path:string,body:Record<string,unknown>,next=flow){if(!next||!view)return;const operationId=crypto.randomUUID(),intent:QuickIntent={phase,path,method:'POST',body:JSON.stringify({...body,operationId})};void execute(phase==='configure'?{...next,instanceId:operationId}:next,intent);}
 const installed=flow?view?.packages.find(item=>item.id===quickPackage(flow)):undefined;
 const instance=flow?.instanceId?view?.instances.find(item=>item.id===flow.instanceId):undefined;
 const sameConfiguration=Boolean(flow?.instanceSnapshot&&instance&&instance.packageId===quickPackage(flow)&&Object.keys(instance.configuration).length===Object.keys(flow.instanceSnapshot.configuration).length&&Object.entries(flow.instanceSnapshot.configuration).every(([key,value])=>instance.configuration[key]===value));
 const verified=Boolean(installed?.state==='installed'&&sameConfiguration&&instance?.revision===flow?.instanceSnapshot?.revision&&instance?.observed==='ready'&&!instance.issues.length&&flow?.preview.capabilities.every(capability=>instance.capabilities.some(actual=>actual.id===capability.id&&actual.state==='verified')));
 useEffect(()=>{
  if(!flow||flow.pending||flow.conflict||!view)return;
  if(flow.stage==='installing'&&installed?.state==='installed')persist({...flow,stage:'configure',packageId:installed.id});
  if(['configured','checking','verified'].includes(flow.stage)&&view.revision>=(flow.viewRevision??0)){
   if(!instance||installed?.state!=='installed'||!sameConfiguration){persist({...flow,stage:'configured',conflict:true});return;}
   if(flow.stage==='checking'){
    if(verified)persist({...flow,stage:'verified'});
    else if(instance.observed==='blocked'||instance.observed==='failed')persist({...flow,stage:'configured',instanceSnapshot:{revision:instance.revision,configuration:instance.configuration}});
    else if(instance.observed!=='checking')persist({...flow,stage:'configured',conflict:true});
   }else if(instance.revision!==flow.instanceSnapshot?.revision||flow.stage==='verified'&&!verified)persist({...flow,stage:'configured',conflict:true});
  }
 },[flow,view,installed,instance,sameConfiguration,verified]);
 return <section className="panel plugin-quick-add" aria-label={moteText('常用插件快捷添加')}>
  <div className="section-heading"><h2>{moteText('常用插件快捷添加')}</h2></div>
  {!flow&&<div className="plugin-catalog">{quickRecipes.map(recipe=><article key={recipe.id}><h3>{recipe.name}</h3><small>{recipe.repository} · {recipe.tag}</small><button className="button subtle" disabled={busy||!view?.installation.supported} onClick={()=>void resolve(recipe)}>{busy?moteText('正在解析…'):moteText('添加 {0}',recipe.name)}</button></article>)}</div>}
  {error&&<p className="notice error" role="alert">{error}</p>}
  {flow&&!opened&&<button className="button" onClick={()=>setOpened(true)}>{moteText('继续添加 {0}',flow.preview.name)}</button>}
  {flow&&opened&&<div className="plugin-quick-progress">
   <h3>{flow.preview.name} · {flow.preview.version}</h3>
   <details open={flow.stage==='preview'}><summary>{moteText('固定版本与访问声明')}</summary><dl className="plugin-facts"><div><dt>{moteText('来源')}</dt><dd>{flow.preview.source.repository}</dd></div><div><dt>{moteText('固定版本')}</dt><dd>{flow.preview.source.tag} · {flow.preview.source.commit}</dd></div><div><dt>{moteText('完整性摘要')}</dt><dd>{flow.preview.source.digest}</dd></div><div><dt>{moteText('访问声明')}</dt><dd>{flow.preview.access.join(' · ')}</dd></div><div><dt>{moteText('依赖')}</dt><dd>{flow.preview.dependencies.join(' · ')}</dd></div></dl><p>{moteText('插件代码可以访问 Central 服务的资源。请只安装你信任的插件；这里列出的访问范围不会自动限制代码。安装完成后仍需配置、启用与绑定。')}</p>{flow.preview.issues.map((issue,index)=><p key={index}>{issue}</p>)}</details>
   {flow.pending&&<div className="notice"><p>{moteText('请求结果尚未确认，请重试同一请求。')}</p><button className="button" disabled={busy} onClick={()=>void execute(flow,flow.pending!)}>{moteText('重试同一请求')}</button></div>}
   {flow.conflict&&<p className="notice">{moteText('配置或方案已变化；请读取当前状态后重新确认。')}</p>}
   {!flow.pending&&!flow.conflict&&<>
    {flow.stage==='preview'&&<><p>{moteText('安装后自动进入连接配置；不会自动核验、启用或更换记忆方案。')}</p><button className="button primary" disabled={busy||!flow.preview.installable||!view?.installation.supported} onClick={()=>command('install','/api/plugins/install',{expectedRevision:view!.revision,previewId:flow.preview.id},{...flow,stage:'installing'})}>{moteText('安装此版本')}</button></>}
    {flow.stage==='installing'&&<p role="status">{installed?.state==='failed'?moteText('安装未完成，请查看已登记的插件状态。'):moteText('正在安装…')}</p>}
    {installed?.issues.map((issue,index)=><p className="notice" key={index}>{issue}</p>)}
    {flow.stage==='configure'&&installed?.state==='installed'&&<PluginConfiguration key={flow.preview.id} api={api} item={installed} busy={busy} guided onSave={body=>{try{const configuration=quickConfiguration(flow.recipe,body.configuration);command('configure','/api/plugin-instances',{...body,configuration,packageId:installed.id,expectedRevision:view!.revision});}catch{setError(moteText('请检查连接配置；仅使用已有模型与凭据引用，不填写密钥。'));}}}/>}
    {(flow.stage==='configured'||flow.stage==='checking'||flow.stage==='verified')&&<>
     <p role="status">{moteText(flow.stage==='checking'?'正在核验能力…':flow.stage==='verified'&&verified?'能力已核验。启用与记忆方案仍需单独选择。':'连接配置已保存，尚未核验能力。')}</p>
     {instance?.issues.map((issue,index)=><p className="notice" key={index}>{issue}</p>)}
     {flow.stage==='configured'&&instance?.allowedActions.includes('check')&&<><p>{moteText('核验使用生成测试资料，可能产生模型与 Embedding 费用；Hindsight 会启动 Docker 服务与模型。不会读取或回填个人历史。')}</p><label className="plugin-confirm"><input type="checkbox" checked={fee} disabled={busy} onChange={event=>setFee(event.target.checked)}/><span>{moteText('已了解核验的连接与费用影响。')}</span></label><button className="button primary" disabled={busy||!fee} onClick={()=>{setFee(false);command('check','/api/plugin-instances/'+instance.id+'/check',{expectedRevision:instance.revision},{...flow,stage:'checking'});}}>{moteText('核验能力')}</button></>}
     {binding&&<p>{binding.activePlan.instanceId===flow.instanceId?moteText('当前记忆方案'):moteText('尚未设为当前记忆方案。')}</p>}
    </>}
   </>}
   <div className="plugin-footer"><button className="button subtle" disabled={busy} onClick={()=>{if(confirmNavigation())setOpened(false);}}>{moteText('返回')}</button>{installed&&<button className="button subtle" disabled={busy||Boolean(flow.pending)} onClick={manage}>{moteText('查看已安装插件')}</button>}{(flow.stage==='preview'||flow.conflict)&&!flow.pending&&<button className="button subtle" disabled={busy} onClick={clear}>{moteText('取消')}</button>}</div>
   <small>{moteText('离开此引导不会撤销已登记的安装或核验。')}</small>
  </div>}
 </section>;
}
