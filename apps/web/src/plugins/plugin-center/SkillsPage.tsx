import {useState} from 'react';
import {Clock,Package,Plug,Plus,RefreshCw,Search} from 'lucide-react';
import {moteText} from '@mote/shared/i18n';
import {pageHash,type PluginBuildView,type PluginCenterView,type PluginInstanceView,type QueryScope,type Routine,type ServerConfiguration} from '@mote/shared';
import {dateTime,errorMessage,type Api} from '../../api';
import {webFeatures} from '../../features/registry';
import {Loading} from '../../Loading';
import {resources} from '../../resource-cache';
import {useForegroundResources} from '../../useForegroundResources';
import {useResource} from '../../useResource';
import {pinnedPageIds,savePinnedPages,type PinnablePage} from './pinned-pages';

export const routinesPath='/api/assistant/routines?'+new URLSearchParams({scope:JSON.stringify({kind:'all'}),limit:'100'}).toString();

export type SkillsPageProps={api:Api;pages?:readonly PinnablePage[]};

type SkillRow={
  key:string;name:string;enabled:boolean;failed:boolean;
  contributions:string[];pages:readonly PinnablePage[];instance?:PluginInstanceView;build?:PluginBuildView;
};

function contributionLabels(connectors:number,pages:number,capabilities:readonly string[],external:boolean):string[]{
  const labels:string[]=[];
  if(connectors)labels.push(moteText('连接器'));
  if(pages){labels.push(moteText('页面'));if(external)labels.push(moteText('第三方'));}
  if(capabilities.some(id=>id.startsWith('memory.')))labels.push(moteText('记忆'));
  if(capabilities.some(id=>id.includes('export')))labels.push(moteText('导出'));
  return labels;
}

/** Compact owner-readable scope. It summarizes the saved rule scope; it never
 * widens or reinterprets it. */
export function routineScopeSummary(scope:QueryScope):string{
  const empty=scope.kind==='selection'&&scope.sourceIds?.length===0||scope.evidenceIds?.length===0;
  if(empty)return moteText('未选择资料');
  const parts:string[]=[];
  if(scope.kind==='all')parts.push(moteText('全部来源'));
  else if(scope.sourceIds?.length)parts.push(moteText('来源')+' · '+scope.sourceIds.length);
  else parts.push(moteText('已选资料'));
  if(scope.evidenceIds?.length)parts.push(moteText('资料')+' · '+scope.evidenceIds.length);
  if(scope.deviceId)parts.push(moteText('设备'));
  if(scope.after)parts.push(moteText('开始时间')+' · '+dateTime(scope.after));
  if(scope.before)parts.push(moteText('结束时间')+' · '+dateTime(scope.before));
  return parts.join(' · ');
}

export function SkillsPage({api,pages=webFeatures.pages()}:SkillsPageProps){
  const pluginResource=useResource<PluginCenterView>(api,'/api/plugins',3000),buildResource=useResource<PluginBuildView[]>(api,'/api/plugin-builds',3000);
  const configuration=useResource<ServerConfiguration>(api,'/api/configuration'),routineResource=useResource<{items:Routine[];nextCursor:string|null}>(api,routinesPath,3000);
  useForegroundResources(api,['/api/plugins','/api/plugin-builds','/api/configuration',routinesPath]);
  const [query,setQuery]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState('');
  const view=pluginResource.data,builds=buildResource.data??[],pinned=pinnedPageIds(configuration.data);
  /** A page contribution keeps its declaring package ID even when an external
   * package runs under a scoped instance. */
  const contributedPages=(packageId:string)=>pages.filter(page=>page.featureId===packageId&&!page.navItem);
  const refreshPlugins=()=>resources(api).invalidate(key=>key==='/api/plugins'||key==='/api/plugins/presentation'||key==='/api/plugin-builds'||key.startsWith('/api/plugin-builds/')||key.startsWith('/api/plugin-instances'));
  const refreshRoutines=()=>resources(api).invalidate(key=>key===routinesPath);

  async function command(key:string,path:string,init:RequestInit,after:()=>void){
    if(busy)return;
    setBusy(key);setError('');
    try{await api.request(path,init);after();}
    catch(cause){setError(errorMessage(cause));after();}
    finally{setBusy('');}
  }
  function toggleBuild(build:PluginBuildView){
    const selection=build.desired?null:{packageId:build.packageId,version:build.version||'1',configurationRevision:0};
    void command('build:'+build.id,'/api/plugin-builds/'+encodeURIComponent(build.id),{method:'PATCH',body:JSON.stringify({expectedRevision:build.revision,operationId:crypto.randomUUID(),selection})},refreshPlugins);
  }
  function retryBuild(build:PluginBuildView){
    void command('retry:'+build.id,'/api/plugin-builds/'+encodeURIComponent(build.id),{method:'PATCH',body:JSON.stringify({expectedRevision:build.revision,operationId:crypto.randomUUID(),selection:build.desired})},refreshPlugins);
  }
  function toggleInstance(instance:PluginInstanceView){
    const action=instance.desired?'disable':'enable';
    void command('instance:'+instance.id,'/api/plugin-instances/'+encodeURIComponent(instance.id)+'/'+action,{method:'POST',body:JSON.stringify({expectedRevision:instance.revision,operationId:crypto.randomUUID()})},refreshPlugins);
  }
  function retryPackage(){resources(api).invalidate(key=>key==='/api/plugins'||key==='/api/plugins/presentation'||key==='/api/plugin-builds'||key.startsWith('/api/plugin-builds/'));}
  async function togglePin(pageId:string){
    const current=configuration.data;
    if(busy||!current)return;
    const key='pin:'+pageId;
    setBusy(key);setError('');
    try{
      const ids=pinnedPageIds(current),next=ids.includes(pageId)?ids.filter(id=>id!==pageId):[...ids,pageId];
      await savePinnedPages(api,current.revision,next);
      resources(api).invalidate(entry=>entry==='/api/configuration');
    }catch(cause){setError(errorMessage(cause));resources(api).invalidate(entry=>entry==='/api/configuration');}
    finally{setBusy('');}
  }
  async function toggleRoutine(rule:Routine){
    const key='routine:'+rule.id;
    if(busy)return;
    setBusy(key);setError('');
    try{await api.request('/api/assistant/routines/'+encodeURIComponent(rule.id),{method:'POST',body:JSON.stringify({expectedRevision:rule.revision,enabled:!rule.enabled})});}
    catch(cause){setError(errorMessage(cause));}
    finally{refreshRoutines();setBusy('');}
  }

  const packageRows:SkillRow[]=(view?.packages??[]).map(pkg=>{
    const instances=(view?.instances??[]).filter(instance=>instance.packageId===pkg.id),instance=instances[0];
    const packagePages=contributedPages(pkg.id),connectors=(view?.sourceContributions??[]).filter(entry=>entry.packageId===pkg.id);
    const capabilities=instances.flatMap(entry=>entry.capabilities.map(capability=>capability.id));
    return {key:'package:'+pkg.id,name:pkg.name,
      enabled:instance?instance.desired:false,failed:pkg.state==='failed',
      contributions:contributionLabels(connectors.length,packagePages.length,capabilities,true),pages:packagePages,instance};
  });
  const buildRows:SkillRow[]=builds.filter(build=>!build.retired&&build.runtime==='host'&&Boolean(build.allowedActions?.includes('disable'))).map(build=>{
    const buildPages=contributedPages(build.packageId),connector=build.id.startsWith('bundled:')||build.packageId.startsWith('mote.connector.');
    return {key:'build:'+build.id,name:build.name??build.id,
      enabled:Boolean(build.desired),failed:build.observed==='blocked',
      contributions:contributionLabels(connector?1:0,buildPages.length,build.capabilities?.map(capability=>capability.id)??[],false),pages:[],build};
  });
  const rows=[...buildRows,...packageRows];
  const normalized=query.trim().toLocaleLowerCase();
  const visibleRows=rows.filter(row=>!normalized||row.name.toLocaleLowerCase().includes(normalized)||row.contributions.join(' ').toLocaleLowerCase().includes(normalized)||row.pages.some(page=>(page.label??page.id).toLocaleLowerCase().includes(normalized)));
  const routines=(routineResource.data?.items??[]).filter(rule=>!normalized||rule.goal.toLocaleLowerCase().includes(normalized)||routineScopeSummary(rule.scope).toLocaleLowerCase().includes(normalized));
  const pluginLoading=pluginResource.loading&&!pluginResource.data&&buildResource.loading&&!buildResource.data;

  return <div className="plugin-center skills-page">
    <style>{skillsStyles}</style>
    <div className="page-heading split-heading"><div><h1>{moteText('技能')}</h1></div><button className="button subtle" onClick={()=>{window.location.hash=pageHash('skills',{tab:'discover'});}}><Plus size={16}/>{moteText('添加')}</button></div>
    <label className="skills-search"><Search size={16} aria-hidden="true"/><input aria-label={moteText('搜索技能')} placeholder={moteText('搜索技能')} value={query} onChange={event=>setQuery(event.target.value)}/></label>
    {error&&<p className="notice error" role="alert">{error}</p>}
    <section className="skills-panel" aria-label={moteText('已安装')}>
      <h2>{moteText('已安装')}</h2>
      {pluginResource.error!==undefined&&<p className="notice error" role="alert">{errorMessage(pluginResource.error)}<button className="text-button" onClick={pluginResource.refresh}>{moteText('重试')}</button></p>}
      {buildResource.error!==undefined&&<p className="notice error" role="alert">{errorMessage(buildResource.error)}<button className="text-button" onClick={buildResource.refresh}>{moteText('重试')}</button></p>}
      {configuration.error!==undefined&&<p className="notice error" role="alert">{errorMessage(configuration.error)}<button className="text-button" onClick={configuration.refresh}>{moteText('重试')}</button></p>}
      {pluginLoading&&<Loading/>}
      {!pluginLoading&&!visibleRows.length&&<p className="plugin-empty">{normalized?moteText('没有匹配的技能。'):moteText('还没有安装外部插件。')}</p>}
      <div className="skills-list">{visibleRows.map(row=>{
        const action=row.build?(row.build.desired?'disable':'enable'):row.instance?(row.instance.desired?'disable':'enable'):undefined;
        const allowed=row.build?Boolean(row.build.allowedActions?.includes(action as 'enable'|'disable'))&&!['starting','draining'].includes(row.build.observed):Boolean(row.instance?.allowedActions.includes(action as 'enable'|'disable'));
        return <article className="skills-row" key={row.key} data-skill-id={row.key} data-skill-state={row.failed?'failed':row.enabled?'enabled':'disabled'}>
          <span className="skills-row-icon">{row.contributions.includes(moteText('连接器'))?<Plug size={18}/>:<Package size={18}/>}</span>
          <div className="skills-row-main">
            <strong>{row.name}</strong>
            {row.contributions.length>0&&<small>{row.contributions.join(' · ')}</small>}
            {row.failed&&<span className="badge muted">{moteText('加载失败')}</span>}
            {row.pages.length>0&&<div className="skills-pins">{row.pages.map(page=><span className="skills-pin" key={page.id} data-page-id={page.id} data-pinned={pinned.includes(page.id)?'true':'false'}>{page.label!==row.name&&<span>{page.label??page.id}</span>}<span aria-hidden="true">{moteText('固定到侧栏')}</span><button type="button" role="switch" className="skills-switch" aria-checked={pinned.includes(page.id)} aria-label={(page.label??page.id)+' · '+moteText(pinned.includes(page.id)?'取消固定':'固定到侧栏')} disabled={Boolean(busy)||configuration.data===undefined} onClick={()=>void togglePin(page.id)}/></span>)}</div>}
          </div>
          <div className="skills-row-actions">
            {row.failed&&<button className="text-button" disabled={Boolean(busy)} onClick={row.build?()=>retryBuild(row.build!):retryPackage}><RefreshCw size={14}/>{moteText('重试')}</button>}
            {action&&<button type="button" role="switch" className="skills-switch" aria-checked={row.enabled} aria-label={row.name} disabled={busy===('build:'+row.build?.id)||busy===('instance:'+row.instance?.id)||!allowed} onClick={()=>row.build?toggleBuild(row.build!):toggleInstance(row.instance!)}/>}
          </div>
        </article>;
      })}</div>
    </section>
    <section className="skills-panel" aria-label={moteText('例行')}>
      <h2>{moteText('例行')}</h2>
      {routineResource.error!==undefined&&<p className="notice error" role="alert">{errorMessage(routineResource.error)}<button className="text-button" onClick={routineResource.refresh}>{moteText('重试')}</button></p>}
      {routineResource.loading&&!routineResource.data&&<Loading/>}
      {!routineResource.loading&&!routines.length&&<p className="plugin-empty">{moteText('还没有例行。')}</p>}
      <div className="skills-list">{routines.map(rule=><article className="skills-row" key={rule.id} data-routine-id={rule.id} data-next-run={rule.nextDue??''} data-scope-kind={rule.scope.kind} data-routine-state={rule.enabled?'enabled':'disabled'}>
        <span className="skills-row-icon"><Clock size={18}/></span>
        <div className="skills-row-main"><strong>{rule.goal}</strong><small>{rule.nextDue?moteText('下次到期')+' · '+dateTime(rule.nextDue,{timeZone:rule.schedule.timeZone,dateStyle:'medium',timeStyle:'short',hour12:false}):moteText('已暂停')}{' · '}{routineScopeSummary(rule.scope)}</small></div>
        <div className="skills-row-actions"><button type="button" role="switch" className="skills-switch" aria-checked={rule.enabled} aria-label={rule.goal} disabled={busy==='routine:'+rule.id} onClick={()=>void toggleRoutine(rule)}/></div>
      </article>)}</div>
    </section>
  </div>;
}

const skillsStyles=`
.skills-page {display:grid;gap:8px;max-width:900px;}
.skills-search {display:flex;align-items:center;gap:10px;margin:0 0 14px;padding:10px 14px;border:1px solid var(--mote-hair);border-radius:var(--mote-radius-container);background:var(--mote-surface);}
.skills-search input {width:100%;border:0;outline:none;background:transparent;color:inherit;font:inherit;}
.skills-panel {margin:0;padding:0;border:0;background:transparent;}
.skills-panel h2 {margin:22px 0 6px;font-size:var(--mote-font-body);}
.skills-list {display:flex;flex-direction:column;}
.skills-row {display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:center;gap:12px;padding:15px 4px;border-bottom:1px solid var(--mote-hair);}
.skills-row-icon {display:flex;justify-content:center;color:var(--mote-muted);}
.skills-row-main {min-width:0;}
.skills-row-main strong {display:block;font-size:var(--mote-font-body);overflow-wrap:anywhere;}
.skills-row-main small {display:block;margin-top:4px;color:var(--mote-muted);font-size:var(--mote-font-meta);line-height:1.6;}
.skills-row-actions {display:flex;align-items:center;gap:12px;}
.skills-pins {display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:7px;font-size:var(--mote-font-meta);}
.skills-pin {display:inline-flex;align-items:center;gap:8px;color:var(--mote-muted);}
.skills-switch {position:relative;flex:none;width:44px;height:26px;padding:0;border:0;border-radius:999px;background:var(--mote-hair);cursor:pointer;}
.skills-switch[aria-checked=true] {background:var(--mote-accent);}
.skills-switch::after {content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:999px;background:var(--mote-surface);transition:transform var(--mote-motion-feedback) var(--mote-motion-settle);}
.skills-switch[aria-checked=true]::after {transform:translateX(18px);}
.skills-switch:disabled {opacity:.5;cursor:default;}
@media (max-width:760px) {.skills-row {grid-template-columns:24px minmax(0,1fr) auto;gap:9px;} .skills-page {max-width:none;}}
`;
