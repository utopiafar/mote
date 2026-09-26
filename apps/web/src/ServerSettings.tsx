import {useResource} from './useResource';
import {resources} from './resource-cache';
import {RuntimeSettings} from './RuntimeSettings';
import {confirmNavigation} from './unsaved';
import {PerceptionSettings} from './PerceptionSettings';
import { moteText } from '@mote/shared/i18n';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, Database, FileText, Fingerprint, Link2, RefreshCw, Search, Settings2, ShieldCheck, Terminal } from 'lucide-react';
import type { ServerConfiguration, ConfigurationField, SourceConnection } from '@mote/shared';
import { type Api, bytes, errorMessage } from './api';
import {ConfigurationBuilder, type ConfigCategory} from './ConfigurationBuilder';
import {Feedback} from './Feedback';
import {MemorySettings} from './MemorySettings';
import {ModelProfiles} from './ModelProfiles';
import {ModelAssignments} from './ModelAssignments';
export type SettingsDestination = 'imports'|'usage'|'lark'|'vault'|'developer'|'about'|'connections';
const categories: {id:ConfigCategory|'providers'|'model';title:string;description:string;icon:typeof Bot}[] = [
  {id:'providers',title:moteText("模型 Provider"),description:moteText("连接预设、模型目录、凭据与测试"),icon:Bot},
  {id:'model',title:moteText("模块与模型"),description:moteText("为各模块分配预设和模型，设置记忆与回顾"),icon:Settings2},
  {id:'storage',title:moteText("保留与容量"),description:moteText("历史保留周期与资料库容量"),icon:Database},
  {id:'embedding',title:moteText("检索索引"),description:moteText("全文检索与可选向量模型"),icon:Search},
  {id:'connectors',title:moteText("来源与外部应用"),description:moteText("同步频率、Google 日历与 MCP"),icon:Link2},
];
const origins = {environment:moteText("启动环境"),'env-file':moteText("配置文件"),default:moteText("默认值"),derived:moteText("根据部署计算")};
function EffectiveField({field}:{field:ConfigurationField}) {
 const value=field.value;
 return <div className="effective-field" data-config-key={field.key}><div><strong>{field.label}</strong><small>{field.description}</small></div><div>{field.visibility==='secret-status'?<span className={`badge ${value?'green':'muted'}`}>{value?moteText("已配置"):moteText("未配置")}</span>:<span>{value===null||value===''?moteText("未设置"):field.unit==='bytes'&&typeof value==='number'?bytes(value):Array.isArray(value)?value.join('、')||moteText("未设置"):typeof value==='boolean'?value?moteText("已开启"):moteText("已关闭"):String(value)}{typeof value==='number'&&field.unit&&field.unit!=='bytes'?` ${{days:moteText("天"),hours:moteText("小时"),seconds:moteText("秒"),ms:moteText("毫秒"),tokens:'tokens',files:moteText("个"),entries:moteText("条")}[field.unit]||field.unit}`:''}</span>}<small>{origins[field.source]}</small></div></div>;
}
export function ServerSettings({api,onNavigate,onModelApplied}:{api:Api;onNavigate:(page:SettingsDestination)=>void;onModelApplied:()=>void}) {
 const [category,setCategory]=useState<ConfigCategory|'providers'|'model'|null>(null),[revision,setRevision]=useState(0);
 const configuration=useResource<ServerConfiguration>(api,'/api/configuration'),sourceResource=useResource<{items:SourceConnection[]}>(api,category==='connectors'?'/api/sources':null);
 const config=configuration.data,busy=configuration.loading,error=configuration.error,sources=sourceResource.data?.items??[],sourcesError=sourceResource.error?errorMessage(sourceResource.error):'';
 const refresh=()=>{resources(api).invalidate(key=>key==='/api/configuration'||key==='/api/sources'||key.startsWith('/api/model-settings'));setRevision(n=>n+1);};
 useEffect(()=>{const heading=document.querySelector<HTMLElement>('.server-settings h1');if(heading?.getClientRects().length){heading.tabIndex=-1;heading.focus({preventScroll:true});}},[category]);
 const selected=categories.find(c=>c.id===category);
 return <div className="server-settings">
  <div className="page-heading settings-heading"><div>{category&&<button className="back-link" onClick={()=>{if(confirmNavigation())setCategory(null);}}><ArrowLeft size={16}/>{moteText("设置")}</button>}<div className="eyebrow">{moteText("按你的方式运行")}</div><h1>{selected?.title||moteText("设置")}</h1><p>{selected?.description||moteText("连接、记录与理解，各自有清楚的位置。")}</p></div><button className="button subtle" disabled={busy} onClick={refresh}><RefreshCw size={15} className={busy?'spin':''}/>{moteText("刷新生效配置")}</button></div>
  {error!==undefined&&<p className="notice error" role="alert">{errorMessage(error)}</p>}
  {!config&&busy&&<p role="status">{moteText("正在读取节点设置…")}</p>}
  {!category&&<>
   <div className="settings-category-label">{moteText("偏好设置")}</div><div className="preference-menu">{categories.map(item=><button key={item.id} className="preference-menu-row" onClick={()=>setCategory(item.id)}><span className="preference-menu-icon"><item.icon size={21}/></span><span><strong>{item.title}</strong><small>{item.description}</small></span><ArrowRight size={17}/></button>)}</div>
   <div className="settings-category-label">{moteText("管理与维护")}</div><div className="preference-menu">{([
    ['imports',moteText("导入"),moteText("将已有文件加入资料库"),FileText],['usage',moteText("用量与费用"),moteText("查看模型调用与费用"),Database],['lark',moteText("飞书"),moteText("安装、登录与文档 / 日历只读同步"),Link2],['vault',moteText("数据与备份"),moteText("空间详情、归档导入与导出"),Database],['connections',moteText("连接授权"),moteText("设备邀请与外部 Chatbot 凭据"),Fingerprint],['about',moteText("关于 Mote"),moteText("软件版本、更新与部署信息"),FileText],['developer',moteText("开发者选项"),moteText("诊断、日志与高级生效配置"),Terminal],
   ] as const).map(([id,title,description,Icon])=><button key={id} className="preference-menu-row" onClick={()=>onNavigate(id)}><span className="preference-menu-icon neutral"><Icon size={21}/></span><span><strong>{title}</strong><small>{description}</small></span><ArrowRight size={17}/></button>)}<Feedback profile={config?.profile} runtime={config?.runtime}/></div>
   <p className="settings-footnote"><ShieldCheck size={16}/>{moteText("模型、记忆与飞书设置可直接保存并生效；其他偏好通过部署草稿修改并重启。离开有未保存修改的配置页面时会先提醒。")}</p>
  </>}
  {config&&categories.filter(item=>category===item.id).map(item=><div key={item.id}>{item.id==='providers'&&<ModelProfiles api={api} revision={revision} onApplied={()=>{setRevision(n=>n+1);onModelApplied();}}/>}{item.id==='model'&&<><ModelAssignments api={api} revision={revision} onApplied={()=>{setRevision(n=>n+1);onModelApplied();}} onManage={()=>{if(confirmNavigation())setCategory('providers');}}/><RuntimeSettings api={api} kind="execution"/><PerceptionSettings api={api}/><MemorySettings api={api}/></>} {item.id!=='model'&&item.id!=='providers'&&<><ConfigurationBuilder config={config} category={item.id} sources={sources} sourcesError={sourcesError}/><section className="panel effective-settings"><div className="section-heading"><div><h2>{moteText("当前生效值")}</h2><p>{moteText("来自运行中的中央节点；与上方尚未应用的草稿分开显示。")}</p></div><span className="badge muted">{moteText("只读")}</span></div>{config.groups.find(g=>g.id===item.id)?.fields.map(field=><EffectiveField key={field.key} field={field}/>)}</section></>}</div>)}
 </div>;
}
export function AdvancedConfiguration({api}:{api:Api}) {
 const {data:config,error,refresh}=useResource<ServerConfiguration>(api,'/api/configuration');
 return <>{error!==undefined&&<p className="notice error" role="alert">{errorMessage(error)}</p>}{config&&<><RuntimeSettings api={api} kind="diagnostics" onApplied={refresh}/><details className="panel deployment-details"><summary><Settings2 size={17}/>{moteText("部署与全部生效配置")}</summary><p>{config.description}</p><dl className="settings-locations"><div><dt>{moteText("配置文件")}</dt><dd><code>{config.envFile||moteText("进程环境变量")}</code></dd></div><div><dt>{moteText("数据目录")}</dt><dd><code>{config.storage.dataDir}</code></dd></div><div><dt>{moteText("相对路径基准")}</dt><dd><code>{config.baseDir}</code></dd></div></dl>{config.groups.map(group=><section key={group.id} className="advanced-config-group"><h3>{group.title}</h3>{group.fields.map(field=><div key={field.key}><EffectiveField field={field}/>{field.envVar&&<code className="env-variable">{field.envVar}</code>}</div>)}</section>)}</details></>}</>;
}
