import {useEffect,useRef,useState,type ReactNode} from 'react';
import {Check,ChevronRight,Package,RefreshCw,Settings2,ShieldCheck,X} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import type {MemoryBindingView,MemoryPlanView,PluginBuildView,PluginCatalogEntry,PluginCatalogGroup,PluginCenterView,PluginInstanceView,PluginPackageView,PluginReleasePreview} from '@mote/shared';
import {ApiError,errorMessage,type Api} from '../../api';
import {FeatureInventory} from '../../FeatureInventory';
import {PluginInstanceSurface} from '../../features/runtime';
import {containDialogFocus} from '../../dialog-focus';
import {resources} from '../../resource-cache';
import {operationFeed} from '../work/operation-feed';
import {useForegroundResources} from '../../useForegroundResources';
import {confirmNavigation,useUnsavedChanges} from '../../unsaved';
import {useResource} from '../../useResource';
import {blockerLabel,buildObservedLabel,buildSelectionLabel,capabilityLabel,hasRequiresBuild,instanceObservedLabel,memoryAdmissionLabel,moduleLabel,packageObservedLabel,packageStateLabel,preparationLabel,preparationPhaseLabel,preparationFailureLabel} from './plugin-center-presentation';
import {useHashChoice} from '../../useHashChoice';
import {pluginTabFromHash} from '../../route-query';
import type {Page} from '../../navigation';
import {PluginConfiguration} from './PluginConfiguration';
import {MemorySettings} from '../../MemorySettings';
import { Loading } from '../../Loading';

const pluginsPath='/api/plugins',buildsPath='/api/plugin-builds',bindingPath='/api/memory-spaces/default/binding';
const deniedBindingApis=new WeakSet<Api>();
type Intent={path:string;method:string;body:Record<string,unknown>;after?:(value:unknown)=>void};
type Dialog={kind:'install';preview:PluginReleasePreview}|{kind:'configure';package:PluginPackageView;instance?:PluginInstanceView}|{kind:'prepare';plan:MemoryPlanView}|{kind:'stop'}|{kind:'uninstall';package:PluginPackageView};

function Modal({title,close,opener,children,busy}:{title:string;close:()=>void;opener:HTMLElement|null;children:ReactNode;busy:boolean}){
 const ref=useRef<HTMLElement>(null);
 useEffect(()=>ref.current?containDialogFocus(ref.current,opener):undefined,[opener]);
 return <div className="modal-backdrop plugin-modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)close();}} onKeyDown={event=>{if(event.key==='Escape'&&!busy){event.stopPropagation();close();}}}>
  <section className="modal plugin-modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
   <div className="section-heading"><h2>{title}</h2><button className="icon-button" aria-label={moteText('关闭详情')} disabled={busy} onClick={close}><X size={20}/></button></div>
   {children}
  </section>
 </div>;
}

function Capabilities({items}:{items:PluginReleasePreview['capabilities']}){
 const requiresBuild=items.some(item=>Boolean(item.reason&&hasRequiresBuild([item.reason])));
 return <>{<ul className="plugin-capabilities">{items.map(item=><li key={item.id}><span>{item.id}</span><span className={'badge '+(item.state==='verified'?'green':'muted')}>{capabilityLabel(item.state)}</span>{item.reason&&<small>{blockerLabel(item.reason)}</small>}</li>)}</ul>}{requiresBuild&&<p className="notice" role="status">{moteText('需要重新构建（requires-build）')}</p>}</>;
}

function BuildStatus({builds}:{builds:PluginBuildView[]}){
 const visible=builds.filter(build=>!build.retired);
 if(!visible.length)return null;
 return <section className="panel plugin-builds" aria-label={moteText('插件构建')}>
  <div className="section-heading"><div><h2>{moteText('插件构建')}</h2><p>{moteText('构建版本与配置实例分开；候选失败时仍显示实际运行的版本。')}</p></div></div>
  <div className="plugin-build-list">{visible.map(build=>{
   const running=build.active??undefined,candidate=build.desired,requiresBuild=hasRequiresBuild(build.blockers);
   const differs=Boolean(candidate&&running&&(candidate.packageId!==running.packageId||candidate.version!==running.version||candidate.configurationRevision!==running.configurationRevision));
   const failed=build.observed==='blocked'||Boolean(differs&&build.blockers.length);
   return <article className="plugin-build" key={build.id} data-build-id={build.id} data-build-runtime={build.runtime??'host'}>
    <div className="section-heading"><div><h3>{build.name??build.id}</h3><small>{build.packageId}{build.version?'@'+build.version:''} · {build.runtime==='worker'?moteText('中央 Worker')+' · ':''}{moteText('配置版本 {0}',build.revision)}</small></div><span className={'badge '+(build.observed==='active'?'green':'muted')}>{buildObservedLabel(build.observed)}</span></div>
    <dl className="plugin-facts">
     <div><dt>{moteText('候选版本')}</dt><dd>{candidate?buildSelectionLabel(candidate):moteText('已选择停用')}</dd></div>
     <div><dt>{moteText('当前版本')}</dt><dd>{running?buildSelectionLabel(running):moteText('没有正在运行的版本')}</dd></div>
     {build.blockers.length>0&&<div><dt>{moteText('阻塞原因')}</dt><dd>{build.blockers.map(blockerLabel).join(' · ')}</dd></div>}
    </dl>
    {failed&&<p className="notice" role="alert">{moteText('候选版本未生效：{0}',build.blockers.map(blockerLabel).join(' · ')||buildObservedLabel(build.observed))}{running&&' · '+moteText('仍在运行的版本：{0}',buildSelectionLabel(running))}</p>}
    {build.restartRequired&&<p className="notice">{moteText('等待节点重启')}{running&&' · '+moteText('仍在运行的版本：{0}',buildSelectionLabel(running))}</p>}
    {requiresBuild&&<p className="notice" role="status">{moteText('需要重新构建（requires-build）')}</p>}
   </article>;
  })}</div>
 </section>;
}

export function PluginCenter({api,onPage,viewScope}:{api:Api;onPage:(page:Page)=>void;viewScope?:string}){
 const pluginResource=useResource<PluginCenterView>(api,pluginsPath,3000),buildResource=useResource<PluginBuildView[]>(api,buildsPath,3000),bindingResource=useResource<MemoryBindingView>(api,bindingPath,3000);
 const authorization=useResource<{authorization:{revision:number;state:'off'|'on'}}>(api,'/api/model-authorization',3000);
 useForegroundResources(api,[pluginsPath,buildsPath,bindingPath,'/api/model-authorization']);
 useEffect(()=>operationFeed(api).subscribe(()=>{}),[api]);
 const view=pluginResource.data,builds=buildResource.data??[],binding=bindingResource.data;
 const [bindingDenied,setBindingDenied]=useState<Api|undefined>(()=>deniedBindingApis.has(api)?api:undefined);
 const [tab,setTab]=useHashChoice('tab',pluginTabFromHash),[selected,setSelected]=useState<string>(),[dialog,setDialog]=useState<Dialog>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[retry,setRetry]=useState<Intent>();
 const [scope,setScope]=useState('default'),[fee,setFee]=useState(false),[showInventory,setShowInventory]=useState(false),[rhythmOpened,setRhythmOpened]=useState(false);
 const catalogGroups:readonly {id:PluginCatalogGroup;label:string}[]=[
  {id:'connectors',label:moteText('连接器')},
  {id:'memory',label:moteText('Memory 方案')},
  {id:'outbound-processing',label:moteText('出站与处理')},
 ];
 const opener=useRef<HTMLElement|null>(null),identity=useRef(api),controller=useRef<AbortController|undefined>(undefined),busyRef=useRef(false);identity.current=api;
 useEffect(()=>{setSelected(undefined);setDialog(undefined);setBusy(false);busyRef.current=false;setError('');setNotice('');setRetry(undefined);setBindingDenied(deniedBindingApis.has(api)?api:undefined);return()=>controller.current?.abort();},[api]);
 useEffect(()=>{
  const denied=[pluginResource.error,bindingResource.error].some(cause=>cause instanceof ApiError&&[401,403,404,410].includes(cause.status));
  if(bindingResource.error instanceof ApiError&&[401,403,404,410].includes(bindingResource.error.status)){deniedBindingApis.add(api);setBindingDenied(api);}
  // Resource drops data on owner denial. Later retained data witnesses an
  // authorized read, including one made by another page before a transient error.
  else if(bindingResource.data!==undefined){deniedBindingApis.delete(api);setBindingDenied(current=>current===api?undefined:current);}
  if(!denied)return;
  controller.current?.abort();busyRef.current=false;setBusy(false);setDialog(undefined);setRetry(undefined);setNotice('');
 },[api,pluginResource.error,bindingResource.error,bindingResource.data,bindingResource.loading]);
 const currentPackage=view?.packages.find(item=>item.id===selected);
 const privateDenied=bindingResource.data===undefined&&(deniedBindingApis.has(api)||bindingDenied===api)||[pluginResource.error,bindingResource.error].some(cause=>cause instanceof ApiError&&[401,403,404,410].includes(cause.status));
 const installReady=!privateDenied&&view!==undefined;
 const latestInstance=dialog?.kind==='configure'&&dialog.instance?view?.instances.find(instance=>instance.id===dialog.instance!.id):undefined;
 function open(next:Dialog,event?:HTMLElement){if(!confirmNavigation())return;opener.current=event??document.activeElement as HTMLElement;setDialog(next);setScope('default');setFee(false);setError('');setNotice('');setRetry(undefined);}
 function close(){if(!busy&&confirmNavigation())setDialog(undefined);}
 function refresh(){resources(api).invalidate(key=>key===pluginsPath||key===buildsPath||key.startsWith('/api/plugin-builds')||key.startsWith('/api/plugin-instances')||key.startsWith('/api/memory-spaces')||key.startsWith('/api/operations'));}
 async function execute(intent:Intent){
  if(busyRef.current)return;const owner=api,signal=new AbortController();controller.current?.abort();controller.current=signal;busyRef.current=true;setBusy(true);setError('');setNotice('');setRetry(undefined);
  try{const value=await owner.request(intent.path,{method:intent.method,body:JSON.stringify(intent.body),signal:signal.signal});if(identity.current!==owner||signal.signal.aborted)return;refresh();setNotice(moteText('请求已登记，运行状态以中央返回为准。'));intent.after?.(value);}
  catch(cause){if(identity.current!==owner||signal.signal.aborted)return;setError(errorMessage(cause));if(!(cause instanceof ApiError&&[401,403,404,409,410,422].includes(cause.status)))setRetry(intent);refresh();}
  finally{if(identity.current===owner&&!signal.signal.aborted){busyRef.current=false;setBusy(false);}}
 }
 function operationId(path:string,method:string,body:Record<string,unknown>){
  if(retry&&retry.path===path&&retry.method===method){
   const {operationId:priorOperationId,...prior}=retry.body;
   if(JSON.stringify(prior)===JSON.stringify(body))return String(priorOperationId);
  }
  return crypto.randomUUID();
 }
 function command(path:string,expectedRevision:number,body:Record<string,unknown>={},after?:(value:unknown)=>void,method='POST'){
  const commandBody={...body,expectedRevision};
  void execute({path,method,body:{...commandBody,operationId:operationId(path,method,commandBody)},after});
 }
 async function resolveCatalog(entry:PluginCatalogEntry,event?:HTMLElement){
  if(!installReady||busyRef.current)return;const owner=api,signal=new AbortController();controller.current?.abort();controller.current=signal;busyRef.current=true;setBusy(true);setError('');setNotice('');setRetry(undefined);opener.current=event??document.activeElement as HTMLElement;
  try{const preview=await owner.request<PluginReleasePreview>('/api/plugins/resolve',{method:'POST',body:JSON.stringify({repository:entry.repository,...(entry.tag?{tag:entry.tag}:{})}),signal:signal.signal});if(identity.current===owner&&!signal.signal.aborted)setDialog({kind:'install',preview});}
  catch(cause){if(identity.current===owner&&!signal.signal.aborted)setError(errorMessage(cause));}
  finally{if(identity.current===owner&&!signal.signal.aborted){busyRef.current=false;setBusy(false);}}
 }
 function memoryCommand(action:string,extra:Record<string,unknown>={},after?:()=>void){if(binding)command(bindingPath+'/'+action,binding.revision,extra,after);}
 const admission=binding?.admission,preparation=binding?.preparation;
 const memoryActions=binding?.allowedActions??[];
 const waitingAuthorization=Boolean(authorization.error===undefined&&admission?.desired&&admission.state==='enabled'&&authorization.data?.authorization&&authorization.data.authorization.state==='off');
 const automaticStatus=!admission?moteText('状态未知'):admission.desired&&admission.state==='enabled'?authorization.error!==undefined?moteText('自动处理状态暂不可用'):!authorization.data?.authorization?(authorization.loading?moteText('正在读取…'):moteText('状态未知')):waitingAuthorization?moteText('等待开启自动处理'):memoryAdmissionLabel(admission):memoryAdmissionLabel(admission);
 return <div className="plugin-center">
  {!(tab==='installed'&&currentPackage)&&<button className="back-link plugin-owner-back" onClick={()=>onPage('about')}>← {moteText('设置')}</button>}{tab==='installed'&&currentPackage&&<button className="back-link" disabled={busy} onClick={()=>setSelected(undefined)}>← {moteText('已安装插件')}</button>}<div className="page-heading split-heading"><div><h1>{tab==='installed'&&currentPackage?currentPackage.name:moteText('自动记忆与插件')}</h1></div></div>
  <nav hidden={tab==='installed'&&Boolean(currentPackage)} className="segmented-nav plugin-tabs" aria-label={moteText('插件页面')}>
   {(['memory','installed','discover'] as const).map(value=><button key={value} className={tab===value?'active':''} aria-pressed={tab===value} onClick={()=>{if(confirmNavigation())setTab(value);}}>{value==='installed'?moteText('已安装插件'):value==='discover'?moteText('官方目录'):moteText('自动记忆')}</button>)}
  </nav>
  {error&&<div className="notice error" role="alert">{error}{retry&&<button className="text-button" disabled={busy} onClick={()=>void execute(retry)}>{moteText('重试同一请求')}</button>}</div>}
  {pluginResource.error!==undefined&&<p className="notice error" role="alert">{errorMessage(pluginResource.error)}<button className="text-button" onClick={pluginResource.refresh}>{moteText('重试')}</button></p>}
  {buildResource.error!==undefined&&<p className="notice error" role="alert">{errorMessage(buildResource.error)}<button className="text-button" onClick={buildResource.refresh}>{moteText('重试')}</button></p>}
  {bindingResource.error!==undefined&&<p className="notice error" role="alert">{errorMessage(bindingResource.error)}<button className="text-button" onClick={bindingResource.refresh}>{moteText('重试')}</button></p>}
  {pluginResource.loading&&!view&&<Loading/>}
  {tab==='discover'&&!installReady&&bindingResource.loading&&view&&<Loading/>}
  <BuildStatus builds={builds}/>
  {tab==='installed'&&<>
   {view&&<div className={"provider-workspace plugin-workspace"+(currentPackage?" has-package":"")}><aside hidden={Boolean(currentPackage)} className="panel provider-sidebar"><div className="section-heading"><h2>{moteText('已安装')}</h2><span className="badge muted">{view.packages.length}</span></div>

    {!view.packages.length&&<p className="plugin-empty">{moteText('还没有安装外部插件。')}<button className="text-button" onClick={()=>setTab('discover')}>{moteText('浏览官方目录')}</button></p>}
    <div className="provider-list">{view.packages.map(item=><button key={item.id} className="provider-card" aria-pressed={currentPackage?.id===item.id} disabled={busy} onClick={()=>{if(confirmNavigation())setSelected(item.id);}}><span className="provider-card-icon"><Package size={18}/></span><span><strong>{item.name}</strong><small>{item.version} · {packageStateLabel(item.state)}</small><small>{packageObservedLabel(item.observed)}</small></span></button>)}</div>
   </aside><div hidden={!currentPackage} className="provider-detail">{currentPackage&&<section className="panel plugin-package-detail"><div className="section-heading"><div><p>{currentPackage.version} · {currentPackage.runtime==='worker'?moteText('中央 Worker'):moteText('独立服务')}</p></div><span className="badge muted">{packageStateLabel(currentPackage.state)}</span></div>
    <dl className="plugin-facts"><div><dt>{moteText('来源')}</dt><dd>{currentPackage.source.repository}</dd></div><div><dt>{moteText('固定版本')}</dt><dd>{currentPackage.source.tag} · {currentPackage.source.commit}</dd></div><div><dt>{moteText('完整性摘要')}</dt><dd>{currentPackage.source.digest}</dd></div></dl>
    {currentPackage.issues.map((issue,index)=><p className="notice" key={index}>{blockerLabel(issue)}</p>)}
    {hasRequiresBuild(currentPackage.issues)&&<p className="notice" role="status">{moteText('需要重新构建（requires-build）')}</p>}
    {currentPackage.allowedActions.includes('uninstall')&&<button className="button subtle" disabled={busy} onClick={event=>open({kind:'uninstall',package:currentPackage},event.currentTarget)}>{moteText('卸载安装包')}</button>}
    {currentPackage.state==='restart-required'&&<p className="notice">{moteText('此包需要节点重启。当前页面不会重启服务器。')}</p>}
    <div className="section-heading"><h3>{moteText('配置实例')}</h3>{currentPackage.allowedActions.includes('configure')&&<button className="button subtle" disabled={busy} onClick={event=>open({kind:'configure',package:currentPackage},event.currentTarget)}><Settings2 size={15}/>{moteText('新增实例')}</button>}</div>
    {view.instances.filter(instance=>instance.packageId===currentPackage.id).map(instance=><article className="plugin-instance" key={instance.id}><div className="section-heading"><div><h3>{instance.name}</h3><p>{instance.scope} · {moteText('配置版本 {0}',instance.revision)}</p></div><span className={'badge '+(instance.observed==='enabled'?'green':'muted')}>{instanceObservedLabel(instance)}</span></div><dl className="plugin-facts"><div><dt>{moteText('状态')}</dt><dd>{instance.desired?moteText('已选择启用'):moteText('已选择停用')} · {instanceObservedLabel(instance)}{binding?.activePlan.instanceId===instance.id?' · '+moteText('当前记忆方案'):''}</dd></div>{instance.issues.length>0&&<div><dt>{moteText('阻塞原因')}</dt><dd>{instance.issues.map(blockerLabel).join(' · ')}</dd></div>}</dl>{hasRequiresBuild(instance.issues)&&<p className="notice" role="status">{moteText('需要重新构建（requires-build）')}</p>}<Capabilities items={instance.capabilities}/>{instance.issues.filter(issue=>!hasRequiresBuild([issue])).map((issue,index)=><p className="notice" key={index}>{blockerLabel(issue)}</p>)}<div className="plugin-actions">
     {instance.allowedActions.includes('configure')&&<button className="button subtle" disabled={busy} onClick={event=>open({kind:'configure',package:currentPackage,instance},event.currentTarget)}>{moteText('配置')}</button>}
     <PluginInstanceSurface instance={instance} busy={busy} command={command} stateLabel={packageStateLabel} labels={{scope:moteText('范围'),state:moteText('状态'),check:moteText('核验能力'),enable:moteText('启用'),disable:moteText('停用')}}/>
     <button className="text-button" onClick={()=>setTab('memory')}>{moteText('查看记忆方案')}<ChevronRight size={14}/></button>
    </div></article>)}
    {!view.instances.some(instance=>instance.packageId===currentPackage.id)&&<p className="plugin-empty">{moteText('此安装包尚无配置实例；没有运行，也没有绑定到记忆方案。')}</p>}
   </section>}</div></div>}
  </>}
  {tab==='discover'&&<section className="plugin-official-catalog" aria-label={moteText('官方目录')}>
   <p>{moteText('只展示主线签发的固定制品。安装不等于授权，也不等于切换 Memory 方案或开始扫描历史。')}</p>
   {view&&!view.installation.supported&&<p className="notice">{view.installation.reason??moteText('当前节点不支持在线安装。')}</p>}
   {installReady&&!view?.catalog.length&&<p className="plugin-empty">{moteText('当前没有可安装的官方制品。')}</p>}
   {catalogGroups.map(group=>{
    const items=(view?.catalog??[]).filter(entry=>entry.group===group.id);
    if(!items.length)return null;
    return <section key={group.id} className="plugin-catalog-group" aria-label={group.label}>
     <h2>{group.label}</h2>
     <div className="plugin-catalog">{items.map(item=><article key={item.repository+'@'+(item.tag??'')}>
      <h3>{item.name}</h3><p>{item.description}</p>
      <small>{item.repository}{item.tag?' · '+item.tag:''} · {item.runtime==='worker'?moteText('中央 Worker'):moteText('独立服务')}</small>
      <button className="button subtle" disabled={busy||!installReady||!view?.installation.supported} onClick={event=>void resolveCatalog(item,event.currentTarget)}>{busy?moteText('正在解析…'):moteText('预览并安装')}</button>
     </article>)}</div>
    </section>;
   })}
   <p className="fine-print"><a className="text-button" href="#/system/diagnostics">{moteText('从 GitHub 添加其他可信插件')}</a>{moteText('已移至「设置 → 运行与诊断」。')}</p>
  </section>}
  {tab==='memory'&&<>
   {bindingResource.loading&&!binding&&<Loading/>}
   {binding&&<><section className="panel plugin-memory-control"><div className="section-heading"><div><h2>{moteText('自动记忆')}</h2><p role="status">{automaticStatus}</p></div><button type="button" role="switch" aria-checked={admission!.desired} aria-label={moteText('自动记忆')} className={'plugin-memory-switch '+(admission!.desired?'is-on':'')} disabled={busy||!(admission!.desired?memoryActions.includes('pause'):memoryActions.includes('resume'))} onClick={()=>memoryCommand(admission!.desired?'pause':'resume')}>{admission!.desired?moteText('已选择启用'):moteText('已选择暂停')}</button></div>
    {authorization.error!==undefined&&<p className="notice error" role="alert">{errorMessage(authorization.error)}<button className="text-button" onClick={authorization.refresh}>{moteText('重新读取')}</button></p>}{waitingAuthorization&&<p className="plugin-waiting-authorization"><a className="text-button" href="#/system/models?category=processing">{moteText('开启自动处理')} →</a></p>}
    {admission!.blockedReason&&<p className="notice">{admission!.blockedReason}</p>}
    {!admission!.desired&&<p>{moteText('暂停期间的新资料只归档。恢复只处理新资料，不会自动补跑暂停期间的历史。')}</p>}
    {admission!.state==='draining'&&<p>{moteText('已停止新增自动任务；已授权任务保留原范围与代次，完成后停用。')}</p>}
    {admission!.resultUnknown>0&&<p className="notice">{moteText('外部结果尚未确认，停止请求不代表远端工作已结束。')}</p>}

   </section>
   <section className="panel plugin-current-plan"><h2>{moteText('当前记忆方案')}</h2><div className="plugin-current-plan-row"><h3>{binding.activePlan.name}</h3><span>{moteText('当前')}</span></div><details className="plugin-advanced"><summary>{moteText('更换记忆方案')}</summary><p>{moteText('准备与生效分开执行。只有范围、正文与索引核验通过后，才能切换写入与查询绑定。')}</p><div className="plugin-plan-list">{binding.plans.filter(plan=>plan.id!==binding.activePlan.id).map(plan=><article className="plugin-plan" key={plan.id}><div><h3>{plan.name}</h3><p>{plan.mode==='engine'?moteText('完整引擎'):moteText('模块组合')}</p>{plan.reason&&<small>{plan.reason}</small>}</div>{plan.id===binding.activePlan.id?<span className="badge green">{moteText('当前')}</span>:<button className="button subtle" disabled={busy||!plan.available||!plan.allowedActions.includes('prepare')||!memoryActions.includes('prepare')} onClick={event=>open({kind:'prepare',plan},event.currentTarget)}>{moteText('预览更换')}</button>}<Capabilities items={plan.capabilities}/></article>)}</div></details>

   </section>
   <details className="plugin-advanced plugin-rhythm" onToggle={event=>{if(event.currentTarget.open)setRhythmOpened(true);}}><summary>{moteText('记忆处理设置')}</summary>{rhythmOpened&&<MemorySettings api={api} compact/>}</details>
    <details className="plugin-advanced plugin-memory-more"><summary>{moteText('更多控制')}</summary><div className="plugin-admission-state" role="status"><strong>{memoryAdmissionLabel(admission!)}</strong><p>{moteText('排队 {0} · 运行 {1} · 检查点 {2} · 结果待确认 {3}',admission!.queued,admission!.running,admission!.checkpointed,admission!.resultUnknown)}</p><small>{moteText('当前准入代次 {0} · 绑定代次 {1}',admission!.generation,binding.generation)}</small></div>
    <div className="plugin-actions">{memoryActions.includes('stop')&&<button className="button subtle" disabled={busy} onClick={event=>open({kind:'stop'},event.currentTarget)}>{moteText('立即停止')}</button>}<button className="text-button" onClick={()=>onPage('processing')}>{moteText('查看任务详情')}</button></div></details>
   {preparation&&<section className="panel plugin-preparation"><div className="section-heading"><h2>{moteText('方案准备')}</h2><span className={'badge '+(preparation.state==='verified'||preparation.state==='applied'?'green':'muted')}>{preparationLabel(preparation.state)}</span></div><p>{preparation.kind==='content-migration'?moteText('正文迁移与索引准备'):moteText('同一正文权威的索引准备')} · {preparation.scope}</p><p>{moteText('当前阶段：{0}',preparationPhaseLabel(preparation))}</p><p>{preparation.oldAdmissionFrozen?moteText('旧方案已冻结新增写入，仍为既有查询提供读取。'):moteText('当前方案继续按原绑定服务。')}{moteText(' 待核对尾部任务：{0}',preparation.tail)}</p><Capabilities items={preparation.checks}/>{preparation.usageUnknown&&<p className="notice">{moteText('实际模型与 Embedding 费用尚未确定，请查看服务用量。')}</p>}{preparation.error&&['blocked','failed'].includes(preparation.state)&&<p className="notice error" role="alert">{preparationFailureLabel(preparation.error)}</p>}<div className="plugin-actions">
    <button className="text-button" disabled={busy} onClick={bindingResource.refresh}>{moteText('检查准备结果')}</button>
    {preparation.allowedActions.includes('retry')&&<button className="button subtle" disabled={busy} onClick={()=>memoryCommand('retry',{preparationId:preparation.operationId})}>{moteText('重试准备')}</button>}
    {preparation.allowedActions.includes('cancel')&&<button className="button subtle" disabled={busy} onClick={()=>memoryCommand('cancel',{preparationId:preparation.operationId})}>{moteText('取消准备')}</button>}
    {preparation.allowedActions.includes('activate')&&<button className="button primary" disabled={busy||preparation.state!=='verified'||!memoryActions.includes('activate')} onClick={()=>memoryCommand('activate',{preparationId:preparation.operationId})}><Check size={15}/>{moteText('设为当前方案')}</button>}
    <button className="text-button" onClick={()=>onPage('processing')}>{moteText('查看运行记录')}</button>
   </div><small>{moteText('准备失败或取消不会自动切换。历史范围的迁移不会授权新的自动提取。')}</small></section>}
   </>}
  </>}
  <details className="plugin-advanced plugin-inventory" onToggle={event=>setShowInventory(event.currentTarget.open)}><summary>{moteText('核验与恢复')}</summary>{binding&&<>    <details className="plugin-advanced"><summary>{moteText('高级：当前模块与绑定')}</summary><dl className="plugin-facts">{binding.modules.map(module=><div key={module.stage}><dt>{moduleLabel(module.stage)}</dt><dd>{module.name} · {capabilityLabel(module.state)}{module.instanceId&&<small>{module.instanceId}</small>}{module.reason&&<small>{module.reason}</small>}</dd></div>)}<div><dt>{moteText('绑定版本')}</dt><dd>{binding.revision} · {moteText('绑定代次 {0}',binding.generation)}</dd></div></dl><p>{moteText('独立审查与授权由 Mote 保留。只展示实际注册与核验过的模块。')}</p></details></>}{showInventory&&<FeatureInventory api={api} embedded/>}</details>
  {notice&&<p className="notice" role="status">{notice}</p>}
  {dialog&&<Modal title={dialog.kind==='install'?moteText('安装预览'):dialog.kind==='configure'?moteText('配置实例'):dialog.kind==='prepare'?moteText('更换方案预览'):dialog.kind==='uninstall'?moteText('卸载安装包'):moteText('立即停止自动记忆')} close={close} busy={busy} opener={opener.current}>
   {error&&<p className="notice error" role="alert">{error}{retry&&<button className="text-button" disabled={busy} onClick={()=>void execute(retry)}>{moteText('重试同一请求')}</button>}</p>}
   {dialog.kind==='configure'&&latestInstance&&dialog.instance&&latestInstance.revision!==dialog.instance.revision&&<p className="notice">{moteText('配置已被其他会话更新；当前草稿尚未覆盖服务器。')}<button className="text-button" disabled={busy} onClick={()=>{if(confirmNavigation())setDialog({...dialog,instance:latestInstance});}}>{moteText('重新读取配置并丢弃草稿')}</button></p>}
   {dialog.kind==='configure'&&<PluginConfiguration key={dialog.instance?dialog.instance.id+':'+dialog.instance.revision:'create:'+dialog.package.id} api={api} item={dialog.package} instance={dialog.instance} busy={busy} onSave={body=>command(dialog.instance?'/api/plugin-instances/'+encodeURIComponent(dialog.instance.id):'/api/plugin-instances',dialog.instance?.revision??view!.revision,{...body,...(!dialog.instance?{packageId:dialog.package.id}:{})},value=>{if(dialog.instance||dialog.package.configurationSchema)setDialog(undefined);else setDialog({kind:'configure',package:dialog.package,instance:value as PluginInstanceView});},dialog.instance?'PATCH':'POST')}/>}
   {dialog.kind==='install'&&<><h3>{dialog.preview.name} · {dialog.preview.version}</h3><dl className="plugin-facts"><div><dt>{moteText('来源')}</dt><dd>{dialog.preview.source.repository}</dd></div><div><dt>{moteText('固定版本')}</dt><dd>{dialog.preview.source.tag} · {dialog.preview.source.commit}</dd></div><div><dt>{moteText('完整性摘要')}</dt><dd>{dialog.preview.source.digest}</dd></div><div><dt>{moteText('运行位置')}</dt><dd>{dialog.preview.runtime==='worker'?moteText('中央 Worker'):moteText('独立服务')}{dialog.preview.restartRequired?' · '+moteText('安装后需重启'):''}</dd></div><div><dt>{moteText('访问声明')}</dt><dd>{dialog.preview.access.length?dialog.preview.access.join(' · '):moteText('没有访问声明')}</dd></div><div><dt>{moteText('依赖')}</dt><dd>{dialog.preview.dependencies.join(' · ')||moteText('无声明依赖')}</dd></div></dl><Capabilities items={dialog.preview.capabilities}/><p className="notice">{moteText('可信插件代码拥有中央宿主权限；访问声明不是沙箱隔离。安装完成后仍需配置、启用与绑定。')}</p>{dialog.preview.issues.map((issue,index)=><p className="notice" key={index}>{issue}</p>)}<div className="plugin-footer"><button className="button primary" disabled={busy||!dialog.preview.installable||!view?.installation.supported} onClick={()=>command('/api/plugins/install',view!.revision,{previewId:dialog.preview.id},value=>{const installed=(value as PluginCenterView).packages.find(item=>item.source.commit===dialog.preview.source.commit&&item.source.repository===dialog.preview.source.repository);setSelected(installed?.id);setTab('installed');setDialog(undefined);})}>{busy?moteText('正在安装…'):moteText('安装此版本')}</button><button className="button subtle" disabled={busy} onClick={close}>{moteText('取消')}</button></div></>}
   {dialog.kind==='prepare'&&<form onSubmit={event=>{event.preventDefault();if(fee&&scope.trim())memoryCommand('prepare',{targetPlanId:dialog.plan.id,scope:scope.trim(),feeAcknowledged:true},()=>setDialog(undefined));}}><h3>{binding?.activePlan.name} → {dialog.plan.name}</h3><p>{moteText('更换正文权威时须迁移记忆正文、修正与删除标记，再准备索引。同一正文权威只更换检索时可重建索引。准备完成不会自动生效。')}</p><p>{moteText('迁移全部 Mote 保留记忆正文及更正/替代状态。外部原生审计历史和引擎图保留在旧实例及运行备份中，不承诺跨引擎迁移。')}</p><Capabilities items={dialog.plan.capabilities}/><label className="preference-field">{moteText('历史授权范围')}<input value={scope} onChange={event=>setScope(event.target.value)} required disabled={busy}/><small>{moteText('范围必须已获授权；准备不包含未授权历史或暂停期间的新提取。')}</small></label><label className="plugin-confirm"><input type="checkbox" checked={fee} onChange={event=>setFee(event.target.checked)} disabled={busy}/><span>{moteText('已确认范围。真实接入可能产生模型与 Embedding 费用，费用以实际服务用量为准。')}</span></label><p>{moteText('生效前会冻结旧方案新增写入，排空并核对尾部任务，验证新绑定；既有查询仍读取固定旧版本。')}</p><div className="plugin-footer"><button className="button primary" disabled={busy||!fee||!scope.trim()}>{busy?moteText('正在登记…'):moteText('开始准备')}</button><button className="button subtle" type="button" disabled={busy} onClick={close}>{moteText('取消')}</button></div></form>}
   {dialog.kind==='uninstall'&&<><h3>{dialog.package.name} · {dialog.package.version}</h3><p>{moteText('移除此安装包。已绑定、仍有历史读者或正在排空的包不能卸载，中央会再次核验。')}</p><div className="plugin-footer"><button className="button primary" disabled={busy||!view?.packages.find(item=>item.id===dialog.package.id)?.allowedActions.includes('uninstall')} onClick={()=>command('/api/plugins/'+encodeURIComponent(dialog.package.id)+'/uninstall',view!.revision,{},()=>{setSelected(undefined);setDialog(undefined);})}>{moteText('确认卸载')}</button><button className="button subtle" disabled={busy} onClick={close}>{moteText('取消')}</button></div></>}
   {dialog.kind==='stop'&&<><p>{moteText('撤销旧任务继续写入的权限，并请求取消运行中的自动记忆任务。外部工作可能无法立刻停止，未确认结果会单独保留。')}</p><p>{moteText('原件、已有记忆和只读查询继续保留；恢复后只处理新资料。')}</p><div className="plugin-footer"><button className="button primary" disabled={busy||!memoryActions.includes('stop')} onClick={()=>memoryCommand('stop',{},()=>setDialog(undefined))}>{moteText('确认立即停止')}</button><button className="button subtle" disabled={busy} onClick={close}>{moteText('取消')}</button></div></>}
  </Modal>}
 </div>;
}
