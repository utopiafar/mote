import {useResource} from './useResource';
import {resources} from './resource-cache';
import {RuntimeSettings} from './RuntimeSettings';
import {AutomaticActivitySettings} from './plugins/models-processing/AutomaticActivitySettings';
import { moteText } from '@mote/shared/i18n';
import { useEffect, useState } from 'react';
import {ProcessingOverview} from './plugins/models-processing/ProcessingOverview';
import {ProcessingServices} from './ProcessingServices';
import { ArrowLeft, ArrowRight, Bot, Database, FileText, Link2, RefreshCw, Search, Settings2, ShieldCheck } from 'lucide-react';
import type { ServerConfiguration, ConfigurationField, SourceConnection } from '@mote/shared';
import { type Api, bytes, errorMessage } from './api';
import {ConfigurationBuilder, type ConfigCategory} from './ConfigurationBuilder';
import {MemorySettings} from './MemorySettings';
import {ModelProfiles} from './plugins/models-processing/ModelProfiles';
import {ModelAssignments} from './plugins/models-processing/ModelAssignments';
import {AutomaticProcessing} from './plugins/models-processing/AutomaticProcessing';
import {MaterialProcessing} from './plugins/models-processing/MaterialProcessing';
import {ModelStartGuide} from './plugins/models-processing/ModelStartGuide';
import {useHashChoice} from './useHashChoice';
import {settingsCategoryFromHash} from './route-query';
import {FileProcessingSettings} from './FileProcessingSettings';
export type SettingsDestination = 'imports'|'usage'|'lark'|'vault'|'developer'|'about'|'connections'|'extensions';
type SettingsCategory = ConfigCategory|'providers'|'model'|'processing'|'file-processing'|'images'|'audio'|'documents';
const categories: {id:SettingsCategory;title:string;description:string;icon:typeof Bot}[] = [
  {id:'providers',title:moteText('服务连接'),description:'',icon:Bot},
  {id:'model',title:moteText('模块与模型'),description:'',icon:Settings2},
 {id:'processing',title:moteText('资料处理'),description:'',icon:FileText},
 {id:'audio',title:moteText('录音'),description:'',icon:FileText},
 {id:'documents',title:moteText('文档与其他文件'),description:'',icon:FileText},
  {id:'images',title:moteText('图片'),description:moteText('统一文字识别、画面理解与历史补处理'),icon:FileText},
  {id:'file-processing',title:moteText("文件与语音"),description:moteText("本地语音模型、转写与文件处理策略"),icon:FileText},
  {id:'storage',title:moteText("保留与容量"),description:moteText("历史保留周期与资料库容量"),icon:Database},
  {id:'embedding',title:moteText("检索索引"),description:moteText("全文检索与可选向量模型"),icon:Search},
  {id:'connectors',title:moteText("来源与外部应用"),description:moteText("同步频率、Google 日历与 MCP"),icon:Link2},
];
const origins = {'config-file':moteText("配置文件"),default:moteText("默认值"),derived:moteText("根据部署计算")};
const effects = {immediate:moteText('立即生效'),'next-request':moteText('后续请求生效'),'next-admission':moteText('后续任务准入生效'),restart:moteText('重启后生效'),migration:moteText('需要迁移并重启')};
function ConfigurationState({config}:{config:ServerConfiguration}) {
 return <>{config.lastError&&<p className="notice error" role="alert">{moteText('配置文件校验或应用失败，继续使用最后有效配置。请修正文件后重试。')}</p>}{config.restartRequired&&<p className="notice">{moteText('已保存到配置文件；标记的设置需要重启后生效。')}</p>}</>;
}
function ConfigurationRegistry({config}:{config:ServerConfiguration}) {
 return <>{config.domains?.map(domain=><details className="advanced-config-group" key={domain.id}><summary><code>{domain.id}</code>{' · '}{domain.status==='invalid'?moteText('配置应用失败'):domain.status==='restart-required'?moteText('重启后生效'):moteText('已应用')}</summary><p>{moteText('配置文件')}{' · '}{moteText('版本 {0}',config.revision)}</p>{domain.fields.map(field=><div key={field.path}><code>{domain.id}.{field.path}</code><small>{field.effect?effects[field.effect]:moteText('立即生效')}{field.sensitive?' · '+moteText('已保存，隐藏凭据'):''}</small></div>)}<div className="preference-grid"><div><h4>{moteText('文件中保存的值')}</h4><pre>{JSON.stringify(domain.saved,null,2)}</pre></div><div><h4>{moteText('当前生效值')}</h4><pre>{JSON.stringify(domain.effective,null,2)}</pre></div></div></details>)}</>;
}
function EffectiveField({field}:{field:ConfigurationField}) {
 const value=field.value;
 const pending=field.savedValue!==undefined&&JSON.stringify(field.savedValue)!==JSON.stringify(value);
 return <div className="effective-field" data-config-key={field.key}><div><strong>{field.label}</strong><small>{field.description}</small></div><div>{field.visibility==='secret-status'?<span className={`badge ${value?'green':'muted'}`}>{value?moteText("已配置"):moteText("未配置")}</span>:<span>{value===null||value===''?moteText("未设置"):field.unit==='bytes'&&typeof value==='number'?bytes(value):Array.isArray(value)?value.join('、')||moteText("未设置"):typeof value==='boolean'?value?moteText("已开启"):moteText("已关闭"):String(value)}{typeof value==='number'&&field.unit&&field.unit!=='bytes'?` ${{days:moteText("天"),hours:moteText("小时"),seconds:moteText("秒"),ms:moteText("毫秒"),tokens:'tokens',files:moteText("个"),entries:moteText("条")}[field.unit]||field.unit}`:''}</span>}<small>{origins[field.source]}{field.effect?' · '+effects[field.effect]:''}</small>{pending&&<small>{moteText('文件中保存的值：{0}',field.visibility==='secret-status'?field.savedValue?moteText('已配置'):moteText('未配置'):Array.isArray(field.savedValue)?field.savedValue.join('、'):String(field.savedValue??''))}</small>}</div></div>;
}
export function ServerSettings({api,onNavigate,onModelApplied}:{api:Api;onNavigate:(page:SettingsDestination)=>void;onModelApplied:()=>void}) {
 const [category,setCategory]=useHashChoice('category',settingsCategoryFromHash),[revision,setRevision]=useState(0),[modelDetail,setModelDetail]=useState(false),[serviceDetail,setServiceDetail]=useState(false),[materialDetail,setMaterialDetail]=useState(false);
 const activeCategory=category??'providers',isTab=['providers','model','processing'].includes(activeCategory);
 const configuration=useResource<ServerConfiguration>(api,'/api/configuration'),sourceResource=useResource<{items:SourceConnection[]}>(api,category==='connectors'?'/api/sources':null);
 const config=configuration.data,busy=configuration.loading,error=configuration.error,sources=sourceResource.data?.items??[],sourcesError=sourceResource.error?errorMessage(sourceResource.error):'';
 const refresh=()=>{resources(api).invalidate(key=>key==='/api/configuration'||key==='/api/sources'||key==='/api/file-processing'||key==='/api/media-models'||key.startsWith('/api/model-settings'));setRevision(n=>n+1);};
 useEffect(()=>{const heading=document.querySelector<HTMLElement>('.server-settings h1');if(heading?.getClientRects().length){heading.tabIndex=-1;heading.focus({preventScroll:true});}},[category]);
 const selected=categories.find(item=>item.id===activeCategory),detail=activeCategory==='providers'&&(modelDetail||serviceDetail)||['images','audio','documents'].includes(activeCategory)&&materialDetail;
 return <div className="server-settings final-model-settings" aria-busy={busy||sourceResource.loading}>
  <div hidden={detail}>
   <button className="text-button workspace-back" onClick={()=>{if(!isTab)setCategory(['images','audio','documents','file-processing'].includes(activeCategory)?'processing':null);else onNavigate('about');}}><ArrowLeft size={15}/>{isTab?moteText('返回上级'):['images','audio','documents','file-processing'].includes(activeCategory)?moteText('资料处理'):moteText('模型与服务')}</button>
   <div className="page-heading settings-heading"><div><h1>{isTab?moteText('模型与服务'):selected?.title}</h1></div></div>
   {isTab&&<nav className="model-settings-tabs" aria-label={moteText('模型与服务')} role="tablist">{(['providers','model','processing'] as const).map(id=><button key={id} role="tab" aria-selected={activeCategory===id} aria-controls={'model-tab-'+id} onClick={()=>setCategory(id)}>{categories.find(item=>item.id===id)!.title}</button>)}</nav>}
  </div>
  {error!==undefined&&<p className="notice error" role="alert">{errorMessage(error)}</p>}
  {config&&<ConfigurationState config={config}/>}
  {activeCategory==='providers'&&<div id="model-tab-providers" role="tabpanel"><ModelStartGuide contextualOnly step="connection"/><div hidden={serviceDetail}><ModelProfiles api={api} revision={revision} onDetailChange={setModelDetail} onApplied={()=>{setRevision(value=>value+1);onModelApplied();}}/></div><div hidden={modelDetail}><ProcessingServices api={api} onDetailChange={setServiceDetail} onProcessing={()=>setCategory('processing')}/></div></div>}
  {activeCategory==='model'&&<div id="model-tab-model" role="tabpanel"><ModelStartGuide contextualOnly step="module"/><ModelAssignments api={api} revision={revision} onApplied={()=>{setRevision(value=>value+1);onModelApplied();}} onManage={()=>setCategory('providers')}/><details className="discovery-settings-advanced"><summary>{moteText('高级：任务执行与并发（Harness）')}</summary><RuntimeSettings api={api} kind="execution"/></details><details className="discovery-settings-advanced" open={new URLSearchParams(window.location.hash.split('?')[1]).get('section')==='automatic'||undefined}><summary>{moteText('高级：记忆、洞察与自动处理节奏')}</summary><AutomaticActivitySettings api={api}/><MemorySettings api={api} onPlans={()=>onNavigate('extensions')}/></details></div>}
  {activeCategory==='processing'&&<div id="model-tab-processing" role="tabpanel"><ProcessingOverview api={api} onSelect={setCategory}/><AutomaticProcessing api={api}/></div>}
  {['images','audio','documents'].includes(activeCategory)&&<MaterialProcessing key={activeCategory} api={api} kind={activeCategory as 'images'|'audio'|'documents'} onDetailChange={setMaterialDetail}/>}
  {activeCategory==='file-processing'&&<FileProcessingSettings api={api}/>}
  {config&&['storage','embedding','connectors'].includes(activeCategory)&&<><ConfigurationBuilder api={api} config={config} category={activeCategory as ConfigCategory} sources={sources} sourcesError={sourcesError} onApplied={refresh}/><section className="panel effective-settings"><div className="section-heading"><div><h2>{moteText('当前生效值')}</h2><p>{moteText('来自运行中的中央；需要重启的设置同时显示文件中保存的值。')}</p></div><span className="badge muted">{moteText('只读')}</span></div>{config.groups.find(group=>group.id===activeCategory)?.fields.map(field=><EffectiveField key={field.key} field={field}/>)}</section></>}
  {isTab&&!detail&&<details className="model-maintenance-settings"><summary>{moteText('高级设置')}</summary><div className="model-maintenance-links">{categories.filter(item=>['storage','embedding','connectors'].includes(item.id)).map(item=><button className="text-button" key={item.id} onClick={()=>setCategory(item.id)}>{item.title}<ArrowRight size={14}/></button>)}<button className="text-button" disabled={busy} onClick={refresh}><RefreshCw size={14}/>{moteText('刷新生效配置')}</button></div></details>}
 </div>;
}
export function AdvancedConfiguration({api,includeRuntime=true}:{api:Api;includeRuntime?:boolean}) {
 const {data:config,error,refresh}=useResource<ServerConfiguration>(api,'/api/configuration');
 return <>{error!==undefined&&<p className="notice error" role="alert">{errorMessage(error)}</p>}{config&&<><ConfigurationState config={config}/>{includeRuntime&&<RuntimeSettings api={api} kind="diagnostics" onApplied={refresh}/>}<details className="panel deployment-details"><summary><Settings2 size={17}/>{moteText("部署与全部生效配置")}</summary><p>{config.description}</p><dl className="settings-locations"><div><dt>{moteText("配置文件")}</dt><dd><code>{config.configFile||config.envFile||moteText("未设置")}</code></dd></div><div><dt>{moteText("数据目录")}</dt><dd><code>{config.storage.dataDir}</code></dd></div><div><dt>{moteText("相对路径基准")}</dt><dd><code>{config.baseDir}</code></dd></div></dl><ConfigurationRegistry config={config}/>{config.groups.map(group=><section key={group.id} className="advanced-config-group"><h3>{group.title}</h3>{group.fields.map(field=><div key={field.key}><EffectiveField field={field}/>{field.envVar&&<code className="env-variable">{field.envVar}</code>}</div>)}</section>)}</details></>}</>;
}
