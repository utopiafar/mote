import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, Database, FileText, Fingerprint, Link2, RefreshCw, Search, Settings2, ShieldCheck, Terminal } from 'lucide-react';
import type { ServerConfiguration, ConfigurationField, SourceConnection } from '@mote/shared';
import { type Api, bytes, errorMessage } from './api';
import {ConfigurationBuilder, type ConfigCategory} from './ConfigurationBuilder';
export type SettingsDestination = 'vault'|'developer'|'about'|'connections';
const categories: {id:ConfigCategory;title:string;description:string;icon:typeof Bot}[] = [
  {id:'model',title:'问答与回顾',description:'模型服务、推理强度与自动回顾',icon:Bot},
  {id:'storage',title:'保留与容量',description:'历史保留周期与资料库容量',icon:Database},
  {id:'embedding',title:'检索索引',description:'全文检索与可选向量模型',icon:Search},
  {id:'connectors',title:'来源与外部应用',description:'同步频率、Google 日历与 MCP',icon:Link2},
];
const origins = {environment:'启动环境','env-file':'配置文件',default:'默认值',derived:'根据部署计算'};
function EffectiveField({field}:{field:ConfigurationField}) {
 const value=field.value;
 return <div className="effective-field" data-config-key={field.key}><div><strong>{field.label}</strong><small>{field.description}</small></div><div>{field.visibility==='secret-status'?<span className={`badge ${value?'green':'muted'}`}>{value?'已配置':'未配置'}</span>:<span>{value===null||value===''?'未设置':field.unit==='bytes'&&typeof value==='number'?bytes(value):Array.isArray(value)?value.join('、')||'未设置':typeof value==='boolean'?value?'已开启':'已关闭':String(value)}{typeof value==='number'&&field.unit&&field.unit!=='bytes'?` ${{days:'天',hours:'小时',seconds:'秒',ms:'毫秒',tokens:'tokens',files:'个',entries:'条'}[field.unit]||field.unit}`:''}</span>}<small>{origins[field.source]}</small></div></div>;
}
export function ServerSettings({api,onNavigate}:{api:Api;onNavigate:(page:SettingsDestination)=>void}) {
 const [config,setConfig]=useState<ServerConfiguration>(),[category,setCategory]=useState<ConfigCategory|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{const controller=new AbortController();setBusy(true);setError('');void api.request<ServerConfiguration>('/api/configuration',{signal:controller.signal}).then(setConfig).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();},[api,revision]);
 const [sources,setSources]=useState<SourceConnection[]>([]),[sourcesError,setSourcesError]=useState('');
 useEffect(()=>{if(category!=='connectors')return;const controller=new AbortController();setSourcesError('');void api.request<{items:SourceConnection[]}>('/api/sources',{signal:controller.signal}).then(v=>setSources(v.items)).catch(e=>{if(!controller.signal.aborted)setSourcesError(errorMessage(e));});return()=>controller.abort();},[api,category,revision]);
 useEffect(()=>{const heading=document.querySelector<HTMLElement>('.server-settings h1');if(heading?.getClientRects().length){heading.tabIndex=-1;heading.focus({preventScroll:true});}},[category]);
 const selected=categories.find(c=>c.id===category);
 return <div className="server-settings">
  <div className="page-heading settings-heading"><div>{category&&<button className="back-link" onClick={()=>setCategory(null)}><ArrowLeft size={16}/>设置</button>}<div className="eyebrow">按你的方式运行</div><h1>{selected?.title||'设置'}</h1><p>{selected?.description||'连接、记录与理解，各自有清楚的位置。'}</p></div><button className="button subtle" disabled={busy} onClick={()=>setRevision(n=>n+1)}><RefreshCw size={15} className={busy?'spin':''}/>刷新生效配置</button></div>
  {error&&<p className="notice error" role="alert">{error}</p>}
  {!config&&busy&&<p role="status">正在读取节点设置…</p>}
  {!category&&<>
   <div className="settings-category-label">偏好设置</div><div className="preference-menu">{categories.map(item=><button key={item.id} className="preference-menu-row" onClick={()=>setCategory(item.id)}><span className="preference-menu-icon"><item.icon size={21}/></span><span><strong>{item.title}</strong><small>{item.description}</small></span><ArrowRight size={17}/></button>)}</div>
   <div className="settings-category-label">管理与维护</div><div className="preference-menu">{([
    ['vault','数据与备份','空间详情、归档导入与导出',Database],['connections','连接授权','设备邀请与外部 Chatbot 凭据',Fingerprint],['about','关于 Mote','软件版本、更新与部署信息',FileText],['developer','开发者选项','诊断、日志与高级生效配置',Terminal],
   ] as const).map(([id,title,description,Icon])=><button key={id} className="preference-menu-row" onClick={()=>onNavigate(id)}><span className="preference-menu-icon neutral"><Icon size={21}/></span><span><strong>{title}</strong><small>{description}</small></span><ArrowRight size={17}/></button>)}</div>
   <p className="settings-footnote"><ShieldCheck size={16}/>设置草稿只保留在当前页面内存。重启节点后，新的部署配置才会生效。</p>
  </>}
  {config&&categories.map(item=><div key={item.id} hidden={category!==item.id}><ConfigurationBuilder config={config} category={item.id} sources={sources} sourcesError={sourcesError}/><section className="panel effective-settings"><div className="section-heading"><div><h2>当前生效值</h2><p>来自运行中的中央节点；与上方尚未应用的草稿分开显示。</p></div><span className="badge muted">只读</span></div>{config.groups.find(g=>g.id===item.id)?.fields.map(field=><EffectiveField key={field.key} field={field}/>)}</section></div>)}
 </div>;
}
export function AdvancedConfiguration({api}:{api:Api}) {
 const [config,setConfig]=useState<ServerConfiguration>(),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();void api.request<ServerConfiguration>('/api/configuration',{signal:controller.signal}).then(setConfig).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));});return()=>controller.abort();},[api]);
 return <>{error&&<p className="notice error" role="alert">{error}</p>}{config&&<><ConfigurationBuilder config={config} category="diagnostics"/><details className="panel deployment-details"><summary><Settings2 size={17}/>部署与全部生效配置</summary><p>{config.description}</p><dl className="settings-locations"><div><dt>配置文件</dt><dd><code>{config.envFile||'进程环境变量'}</code></dd></div><div><dt>数据目录</dt><dd><code>{config.storage.dataDir}</code></dd></div><div><dt>相对路径基准</dt><dd><code>{config.baseDir}</code></dd></div></dl>{config.groups.map(group=><section key={group.id} className="advanced-config-group"><h3>{group.title}</h3>{group.fields.map(field=><div key={field.key}><EffectiveField field={field}/>{field.envVar&&<code className="env-variable">{field.envVar}</code>}</div>)}</section>)}</details></>}</>;
}
