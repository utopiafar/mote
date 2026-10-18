import {invalidateConfiguration} from './configuration-cache';
import {useUnsavedChanges} from './unsaved';
import { moteText } from '@mote/shared/i18n';
import {useEffect, useMemo, useRef, useState} from 'react';
import {FileCheck2, RotateCcw, SlidersHorizontal} from 'lucide-react';
import type {ServerConfiguration, SourceConnection} from '@mote/shared';
import {ApiError, type Api, errorMessage} from './api';
import {savedValues, configurationPatches, type DraftValues} from './configuration-draft';
export type ConfigCategory = 'storage'|'embedding'|'connectors';
const names: Record<ConfigCategory,string> = {storage:moteText("保留与容量"),embedding:moteText("检索索引"),connectors:moteText("来源与外部应用")};
export function ConfigurationBuilder({api,config,category,sources=[],sourcesError='',onApplied}:{api:Api;config:ServerConfiguration;category:ConfigCategory;sources?:SourceConnection[];sourcesError?:string;onApplied?:()=>void}) {
  const activeApi=useRef(api);activeApi.current=api;
  const [baseline,setBaseline] = useState(config);
  const current = useMemo(()=>savedValues(baseline),[baseline]);
  const [changes,setChanges] = useState<DraftValues>({});
  useUnsavedChanges(Object.keys(changes).length > 0);
  const [busy,setBusy] = useState(false),[error,setError] = useState(''),[notice,setNotice] = useState(''),[credentialReview,setCredentialReview] = useState(false),[allowCredentialReuse,setAllowCredentialReuse] = useState(false);
  useEffect(()=>{if(!Object.keys(changes).length&&(config.revision??0)>=(baseline.revision??0))setBaseline(config);},[config,changes]);
  useEffect(()=>{setBaseline(config);setChanges({});setError('');setNotice('');setCredentialReview(false);setAllowCredentialReuse(false);},[api]);
  const value=(key:string)=>changes[key]??current[key]??'';
  const set=(key:string,v:string)=>{setChanges(previous=>{const next={...previous};if(v===(current[key]??''))delete next[key];else next[key]=v;return next;});setNotice('');setError('');setAllowCredentialReuse(false);};
  const count=Object.keys(changes).length;
  const writeSourceIds=value('mcpWriteSourceIds').split(',').map(id=>id.trim()).filter(Boolean);
  const text=(key:string,label:string,extra:{type?:string;placeholder?:string;hint?:string;min?:number;max?:number}={})=><label className="preference-field">{label}<input aria-label={label} value={value(key)} type={extra.type??'text'} placeholder={extra.placeholder} min={extra.min} max={extra.max} autoComplete="off" onChange={e=>{set(key,e.target.value);}}/>{extra.hint&&<small>{extra.hint}</small>}</label>;
  const choice=(key:string,label:string,options:[string,string][])=>{const selected=value(key);return <label className="preference-field">{label}<select aria-label={label} value={selected} onChange={e=>set(key,e.target.value)}>{!options.some(([v])=>v===selected)&&<option value={selected}>{moteText("当前自定义值 ·")}{' '}{selected||moteText("未设置")}</option>}{options.map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label>;};
  const toggle=(key:string,label:string,hint:string)=><label className="preference-toggle"><span><strong>{label}</strong><small>{hint}</small></span><input type="checkbox" role="switch" checked={value(key)==='1'} onChange={e=>set(key,e.target.checked?'1':'0')}/></label>;
  function validate() {
    const limits:Record<string,[number,number]>={retentionDays:[0,36500],maxStorageBytes:[1,1000000],modelRequestTimeoutMs:[5000,600000],agentTimeoutMs:[5000,3600000],modelTimeoutMs:[5000,600000],modelMaxTokens:[1,128000],insightIntervalHours:[0,168],connectorSyncInterval:[60,86400]};
    for(const [key,v] of Object.entries(changes)) {if(limits[key]){const n=Number(v),[min,max]=limits[key];if(!v||!Number.isInteger(n)||n<min||n>max)throw Error(moteText("{0} 需要 {1}–{2} 之间的整数。", key, min, max));}if(['embeddingBaseUrl','googleRedirectUri'].includes(key)&&v){const u=new URL(v);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw Error(moteText("模型地址须为不含凭据或参数的 HTTP(S) 地址。"));}}
    return configurationPatches(baseline,changes);
  }
  async function save(){
    setBusy(true);setError('');setNotice('');
    try {
      let revision=baseline.revision,next:ServerConfiguration|undefined;
      for(const patch of validate()){
        next=await api.request<ServerConfiguration>('/api/configuration/'+encodeURIComponent(patch.id),{method:'PUT',body:JSON.stringify({value:patch.value,revision,...(allowCredentialReuse?{allowCredentialReuse:true}:{})})});
        if(activeApi.current!==api)return;
        revision=next.revision;
      }
      if(next){setBaseline(next);setChanges({});setCredentialReview(false);setAllowCredentialReuse(false);setNotice(next.restartRequired?moteText('已保存到配置文件；标记的设置需要重启后生效。'):moteText('已保存，立即生效。'));}
      invalidateConfiguration(api);onApplied?.();
    } catch(e){if(activeApi.current!==api)return;if(e instanceof ApiError&&e.code==='model_settings_credential_reuse'){setCredentialReview(true);setError(errorMessage(e));}else setError(errorMessage(e));}
    finally{if(activeApi.current===api)setBusy(false);}
  }
  return <section className="panel config-builder" aria-label={moteText("配置文件")}>
    <div className="section-heading"><div><h2><SlidersHorizontal size={18}/>{moteText("调整")}{' '}{names[category]}</h2><p>{moteText("页面与手改文件使用同一份配置；保存后按各项生效方式应用。")}</p></div><span className="badge muted">{moteText("配置文件")}</span></div>
    <form onSubmit={e=>{e.preventDefault();void save();}}><fieldset disabled={busy}>
      {category==='storage'&&<><div className="preference-grid">{choice('retentionDays',moteText("历史记录保留"),[['0',moteText("持续保留")],['30',moteText("30 天")],['90',moteText("90 天")],['180',moteText("180 天")],['365',moteText("1 年")]])}{choice('maxStorageBytes',moteText("资料容量上限"),[['1024','1 GiB'],['5120','5 GiB'],['10240','10 GiB'],['51200','50 GiB'],['102400','100 GiB']])}</div><div className="preference-note">{moteText("正数保留周期会按采集时间自动清理旧记录。保存前请确认所选周期；需要重启的设置会保留当前有效值。")}</div><details className="preference-advanced"><summary>{moteText("自定义保留与容量")}</summary><div className="preference-grid">{text('retentionDays',moteText("自定义保留天数"),{type:'number',min:0,max:36500})}{text('maxStorageBytes',moteText("自定义容量（MiB）"),{type:'number',min:1,max:1000000})}</div></details></>}
      {category==='embedding'&&<><div className="preference-note">{moteText("文本检索始终可用。配置向量索引后，文本会提交给你选择的 Embedding 服务。")}</div><div className="preference-grid">{text('embeddingModel',moteText("Embedding 模型名称"),{hint:moteText("留空使用文本检索；更换模型可能需要重建已有向量。")})}{text('embeddingBaseUrl',moteText("Embedding 服务地址"),{type:'url'})}</div><p className="fine-print">{moteText("如服务需要认证，在配置文件设置 models.embedding.apiKey。")}</p></>}
      {category==='connectors'&&<>{choice('connectorSyncInterval',moteText("检查来源的间隔"),[['300',moteText("5 分钟")],['900',moteText("15 分钟")],['1800',moteText("30 分钟")],['3600',moteText("1 小时")]])}{toggle('mcpEnabled',moteText("允许外部应用检索"),moteText("需在部署机器设置独立的 MCP 读令牌。"))}{toggle('mcpWriteEnabled',moteText("允许指定来源写回"),moteText("写入还需要独立令牌与明确允许的来源。"))}<fieldset className="source-permissions"><legend>{moteText("允许外部应用写入的来源")}</legend><p className="fine-print">{moteText("只授权你勾选的来源。保存后按标记的生效方式应用。")}</p>{sources.map(source=><label className="source-permission" key={source.id}><input type="checkbox" checked={writeSourceIds.includes(source.id)} onChange={e=>set('mcpWriteSourceIds',(e.target.checked?[...new Set([...writeSourceIds,source.id])]:writeSourceIds.filter(id=>id!==source.id)).join(','))}/><span><strong>{source.name}</strong><small>{source.enabled?moteText("已启用"):moteText("已暂停")}</small></span></label>)}{!sources.length&&<p className="fine-print">{sourcesError||moteText("暂无已注册来源。先在“来源”页面添加内容。")}</p>}{writeSourceIds.filter(id=>!sources.some(s=>s.id===id)).length>0&&<p className="fine-print">{moteText("保留了当前配置中未列出的来源 ID；可在高级选项检查。")}</p>}</fieldset><details className="preference-advanced"><summary>{moteText("高级来源 ID 与授权回调")}</summary>{text('mcpWriteSourceIds',moteText("可写来源 ID"),{hint:moteText("保留自定义值；多个已注册来源 ID 以英文逗号分隔。")})}{text('googleRedirectUri',moteText("Google 授权回调地址"),{type:'url',hint:moteText("须与 Google Cloud 配置完全一致。OAuth 凭据在部署机器设置。")})}</details></>}
      {error&&<p className="notice error" role="alert">{error}</p>}
      {credentialReview&&<label className="preference-toggle"><span>{moteText('允许在更改后的服务地址复用已保存的凭据')}</span><input type="checkbox" checked={allowCredentialReuse} onChange={event=>setAllowCredentialReuse(event.target.checked)}/></label>}
      <div className="config-draft-footer"><span>{count?moteText("{0} 项修改待应用", count):moteText("当前没有修改")}</span><div><button className="button subtle" type="button" disabled={!count} onClick={()=>{setChanges({});setNotice('');setError('');setBaseline(config);}}><RotateCcw size={15}/>{moteText("还原草稿")}</button><button className="button primary" disabled={!count||busy}><FileCheck2 size={16}/>{busy?moteText("保存中…"):moteText("保存并应用")}</button></div></div>
    </fieldset></form>
    {error&&<button className="button subtle" onClick={()=>{setChanges({});setBaseline(config);setError('');onApplied?.();}}>{moteText('重新读取并还原草稿')}</button>}
    {notice&&<p role="status">{notice}</p>}
  </section>;
}
