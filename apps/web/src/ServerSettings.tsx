import {useResource} from './useResource';
import {resources} from './resource-cache';
import {RuntimeSettings} from './RuntimeSettings';
import {PerceptionSettings} from './PerceptionSettings';
import {AutomaticActivitySettings} from './AutomaticActivitySettings';
import { moteText } from '@mote/shared/i18n';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, Database, FileText, Link2, RefreshCw, Search, Settings2, ShieldCheck } from 'lucide-react';
import type { ServerConfiguration, ConfigurationField, SourceConnection } from '@mote/shared';
import { type Api, bytes, errorMessage } from './api';
import {ConfigurationBuilder, type ConfigCategory} from './ConfigurationBuilder';
import {MemorySettings} from './MemorySettings';
import {ModelProfiles} from './ModelProfiles';
import {ModelAssignments} from './ModelAssignments';
import {ModelAuthorizationSettings} from './ModelAuthorizationSettings';
import {ModelStartGuide} from './ModelStartGuide';
import {useHashChoice} from './useHashChoice';
import {settingsCategoryFromHash} from './route-query';
import {FileProcessingSettings} from './FileProcessingSettings';
export type SettingsDestination = 'imports'|'usage'|'lark'|'vault'|'developer'|'about'|'connections'|'extensions';
type SettingsCategory = ConfigCategory|'providers'|'model'|'file-processing'|'images';
const categories: {id:SettingsCategory;title:string;description:string;icon:typeof Bot}[] = [
  {id:'providers',title:moteText('模型连接（Provider）'),description:moteText('保存模型服务的地址与凭据，选择模型并按需测试连接'),icon:Bot},
  {id:'model',title:moteText("模块与模型"),description:moteText("为各模块分配预设和模型，设置记忆与回顾"),icon:Settings2},
  {id:'images',title:moteText('图片'),description:moteText('统一文字识别、画面理解与历史补处理'),icon:FileText},
  {id:'file-processing',title:moteText("文件与语音"),description:moteText("本地语音模型、转写与文件处理策略"),icon:FileText},
  {id:'storage',title:moteText("保留与容量"),description:moteText("历史保留周期与资料库容量"),icon:Database},
  {id:'embedding',title:moteText("检索索引"),description:moteText("全文检索与可选向量模型"),icon:Search},
  {id:'connectors',title:moteText("来源与外部应用"),description:moteText("同步频率、Google 日历与 MCP"),icon:Link2},
];
const origins = {environment:moteText("启动环境"),'env-file':moteText("配置文件"),'config-file':moteText("配置文件"),default:moteText("默认值"),derived:moteText("根据部署计算")};
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
 const [category,setCategory]=useHashChoice('category',settingsCategoryFromHash),[revision,setRevision]=useState(0);
 const configuration=useResource<ServerConfiguration>(api,'/api/configuration'),sourceResource=useResource<{items:SourceConnection[]}>(api,category==='connectors'?'/api/sources':null);
 const config=configuration.data,busy=configuration.loading,error=configuration.error,sources=sourceResource.data?.items??[],sourcesError=sourceResource.error?errorMessage(sourceResource.error):'';
 const refresh=()=>{resources(api).invalidate(key=>key==='/api/configuration'||key==='/api/sources'||key==='/api/file-processing'||key==='/api/media-models'||key.startsWith('/api/model-settings'));setRevision(n=>n+1);};
 useEffect(()=>{const heading=document.querySelector<HTMLElement>('.server-settings h1');if(heading?.getClientRects().length){heading.tabIndex=-1;heading.focus({preventScroll:true});}},[category]);
 const selected=categories.find(c=>c.id===category);
 return <div className="server-settings" aria-busy={busy||sourceResource.loading}>
  <button className="back-link workspace-back" aria-label={moteText('返回{0}',category?moteText('模型与服务'):moteText('设置'))} onClick={()=>{if(category){setCategory(null);}else onNavigate('about');}}><ArrowLeft size={16}/>{moteText('返回上级')}</button>
  <div className="page-heading settings-heading"><div><h1>{selected?.title||moteText("模型与服务")}</h1><p>{selected?.description||moteText("连接、记录与理解，各自有清楚的位置。")}</p></div><button className="button subtle" disabled={busy} onClick={refresh}><RefreshCw size={15} className={busy?'spin':''}/>{moteText("刷新生效配置")}</button></div>
  {error!==undefined&&<p className="notice error" role="alert">{errorMessage(error)}</p>}
  {config&&<ConfigurationState config={config}/>}
  {!config&&busy&&<p role="status">{moteText("正在读取节点设置…")}</p>}
  {!category&&<>
   <ModelStartGuide/><div className="settings-category-label">{moteText("偏好设置")}</div><div className="preference-menu">{categories.map(item=><button key={item.id} className="preference-menu-row" onClick={()=>setCategory(item.id)}><span className="preference-menu-icon"><item.icon size={21}/></span><span><strong>{item.title}</strong><small>{item.description}</small></span><ArrowRight size={17}/></button>)}</div>
   <p className="settings-footnote"><ShieldCheck size={16}/>{moteText("中央运行配置统一保存到配置文件。多数设置保存后应用；标记的部署设置需要重启。离开有未保存修改的页面时会先提醒。")}</p>
  </>}
  {category==='file-processing'&&<FileProcessingSettings api={api}/>}
  {category==='images'&&<PerceptionSettings api={api} onMemory={()=>{setCategory('model');}} onAdvanced={()=>{setCategory('file-processing');}}/>}
  {config&&categories.filter(item=>category===item.id&&item.id!=='file-processing'&&item.id!=='images').map(item=><div key={item.id}>{item.id==='providers'&&<ModelProfiles api={api} revision={revision} onApplied={()=>{setRevision(n=>n+1);onModelApplied();}}/>}{item.id==='model'&&<><ModelAuthorizationSettings api={api}/><ModelAssignments api={api} revision={revision} onApplied={()=>{setRevision(n=>n+1);onModelApplied();}} onManage={()=>{setCategory('providers');}}/><AutomaticActivitySettings api={api}/><div className="discovery-inline-guidance"><p>{moteText('先检查你要用的模块即可。下方高级设置管理任务执行名额、自动记忆配方和历史处理节奏，可按需调整。')}</p></div><details className="discovery-settings-advanced"><summary>{moteText('高级：任务执行与并发（Harness）')}</summary><p>{moteText('任务超出名额时排队；这是执行资源设置，不是启用问答的起步步骤。')}</p><RuntimeSettings api={api} kind="execution"/></details><details className="discovery-settings-advanced"><summary>{moteText('高级：记忆、洞察与自动处理节奏')}</summary><p>{moteText('这里管理已有配方和历史资料处理周期；整体自动记忆的暂停 / 恢复在「自动记忆与插件」。')}</p><MemorySettings api={api} onPlans={()=>onNavigate("extensions")}/></details></>} {item.id!=='model'&&item.id!=='providers'&&item.id!=='file-processing'&&item.id!=='images'&&<><ConfigurationBuilder api={api} config={config} category={item.id} sources={sources} sourcesError={sourcesError} onApplied={refresh}/><section className="panel effective-settings"><div className="section-heading"><div><h2>{moteText("当前生效值")}</h2><p>{moteText("来自运行中的中央节点；需要重启的设置同时显示文件中保存的值。")}</p></div><span className="badge muted">{moteText("只读")}</span></div>{config.groups.find(g=>g.id===item.id)?.fields.map(field=><EffectiveField key={field.key} field={field}/>)}</section></>}</div>)}
 </div>;
}
export function AdvancedConfiguration({api}:{api:Api}) {
 const {data:config,error,refresh}=useResource<ServerConfiguration>(api,'/api/configuration');
 return <>{error!==undefined&&<p className="notice error" role="alert">{errorMessage(error)}</p>}{config&&<><ConfigurationState config={config}/><RuntimeSettings api={api} kind="diagnostics" onApplied={refresh}/><details className="panel deployment-details"><summary><Settings2 size={17}/>{moteText("部署与全部生效配置")}</summary><p>{config.description}</p><dl className="settings-locations"><div><dt>{moteText("配置文件")}</dt><dd><code>{config.configFile||config.envFile||moteText("未设置")}</code></dd></div><div><dt>{moteText("数据目录")}</dt><dd><code>{config.storage.dataDir}</code></dd></div><div><dt>{moteText("相对路径基准")}</dt><dd><code>{config.baseDir}</code></dd></div></dl><ConfigurationRegistry config={config}/>{config.groups.map(group=><section key={group.id} className="advanced-config-group"><h3>{group.title}</h3>{group.fields.map(field=><div key={field.key}><EffectiveField field={field}/>{field.envVar&&<code className="env-variable">{field.envVar}</code>}</div>)}</section>)}</details></>}</>;
}
