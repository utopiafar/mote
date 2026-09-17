import {moteText} from '@mote/shared/i18n';
import {useEffect,useState} from 'react';
import {Copy,Plus,LockKeyhole,Server,Trash2} from 'lucide-react';
import {DEFAULT_MODEL_MAX_TOKENS,DEPLOYMENT_MODEL_PROFILE_ID,MODEL_FEATURE_LABELS,type ModelFeature,type ModelSettingsView,type ModelTestResult} from '@mote/shared/models';
import {type Api,errorMessage} from './api';
import {ModelSettingsEditor} from './ModelSettingsEditor';
import {createModelDraft,modelSettingsRequest} from './model-settings-form';

export function ModelProfiles({api,revision,onApplied}:{api:Api;revision:number;onApplied:()=>void}){
  const [view,setView]=useState<ModelSettingsView>(),[selected,setSelected]=useState(DEPLOYMENT_MODEL_PROFILE_ID);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmDelete,setConfirmDelete]=useState(false);
  const [copyName,setCopyName]=useState<string|null>(null),[includeCredentials,setIncludeCredentials]=useState(true),[probe,setProbe]=useState<ModelTestResult>();
  useEffect(()=>{const c=new AbortController();void api.request<ModelSettingsView>('/api/model-settings',{signal:c.signal}).then(value=>{if(!c.signal.aborted){setView(value);setError('');setSelected(id=>value.profiles?.some(p=>p.id===id)?id:value.profiles?.[0]?.id??'default');}}).catch(e=>{if(!c.signal.aborted)setError(errorMessage(e));});return()=>c.abort();},[api,revision]);
  async function mutate(path:string,method:string,body:unknown,after?:string){
    setBusy(true);setError('');
    try{const next=await api.request<ModelSettingsView>(path,{method,body:JSON.stringify(body)});setView(next);if(after)setSelected(after);setConfirmDelete(false);setCopyName(null);onApplied();}
    catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  const profiles=view?.profiles??[],profile=profiles.find(p=>p.id===selected),atCapacity=profiles.filter(p=>!p.readOnly&&p.id!=='default').length>=30;
  const uses=Object.entries(view?.defaults??{}).filter(([,id])=>id===selected).map(([feature])=>MODEL_FEATURE_LABELS[feature as ModelFeature]);
  function choose(id:string){setSelected(id);setConfirmDelete(false);setCopyName(null);setProbe(undefined);}
  async function testDeployment(){
    if(!view||!profile)return;setBusy(true);setError('');setProbe(undefined);
    try{setProbe(await api.request<ModelTestResult>(`/api/model-settings/profiles/${encodeURIComponent(selected)}/test`,{method:'POST',body:JSON.stringify(modelSettingsRequest({...view,settings:profile.settings},createModelDraft(profile.settings)))}));}
    catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  return <div className="provider-workspace">
    <aside className="panel provider-sidebar" aria-label={moteText("Provider 预设")}>
      <div className="section-heading"><h2>{moteText("连接预设")}</h2><span className="badge muted">{profiles.length}</span></div>
      <p>{moteText("一套连接可使用多个模型。凭据保存一次，各模块独立选择。")}</p>
      <button className="button primary" disabled={busy||!view||atCapacity} onClick={()=>{if(!view)return;const id=crypto.randomUUID();void mutate('/api/model-settings/profiles/'+id,'PUT',{revision:view.revision,name:moteText("新 Provider 预设"),settings:{provider:'custom',protocol:'openai-completions',baseUrl:'',model:'',reasoningEffort:'auto',maxTokens:DEFAULT_MODEL_MAX_TOKENS,timeoutMs:120000,allowUnauthenticatedLocal:false,apiKey:null,headers:null,extraBody:null}},id);}}><Plus size={16}/>{moteText("新增预设")}</button>
      <div className="provider-list">{profiles.map(p=><button key={p.id} className="provider-card" aria-pressed={selected===p.id} disabled={busy} onClick={()=>choose(p.id)}><span className="provider-card-icon">{p.readOnly?<LockKeyhole size={18}/>:<Server size={18}/>}</span><span><strong>{p.name}</strong><small>{p.settings.protocol==='codex-app-server'?'Codex App Server':p.settings.provider} · {p.settings.model||moteText("待配置")}</small><small>{p.readOnly?moteText("部署文件 · 只读"):moteText("自定义预设")}</small></span></button>)}</div>
    </aside>
    <div className="provider-detail">
      {error&&<p className="notice error" role="alert">{error}</p>}
      {profile&&view&&<>
        <section className="panel provider-actions"><div><h2>{profile.name}</h2><p>{uses.length?moteText("用于：")+uses.join('、'):moteText("尚未分配给模块，可在模块与模型中选择。")}</p></div><div className="provider-action-buttons"><button className="button subtle" disabled={busy||atCapacity} onClick={()=>{setCopyName((profile.name+moteText(" 副本")).slice(0,100));setIncludeCredentials(true);setConfirmDelete(false);}}><Copy size={15}/>{moteText("复制预设")}</button>{!profile.readOnly&&profile.id!=='default'&&<button className="button subtle" disabled={busy||uses.length>0} title={uses.length?moteText("请先更改使用此预设的模块"):undefined} onClick={()=>setConfirmDelete(true)}><Trash2 size={15}/>{moteText("删除")}</button>}</div>
          {copyName!==null&&<form className="provider-inline-form" onSubmit={e=>{e.preventDefault();const id=crypto.randomUUID();void mutate(`/api/model-settings/profiles/${encodeURIComponent(selected)}/copy`,'POST',{revision:view.revision,id,name:copyName.trim(),includeCredentials},id);}}><label className="preference-field">{moteText("副本名称")}<input aria-label={moteText("副本名称")} maxLength={100} value={copyName} onChange={e=>setCopyName(e.target.value)} required disabled={busy}/></label><label className="provider-copy-choice"><input type="checkbox" checked={includeCredentials} onChange={e=>setIncludeCredentials(e.target.checked)} disabled={busy}/>{moteText("同时复制凭据和高级参数（仅在服务器内部复制）")}</label><small>{moteText("副本独立保存。修改副本不会影响原预设；更换地址时仍需确认凭据复用。")}</small><div><button className="button primary" disabled={busy||!copyName.trim()}>{moteText("创建副本")}</button><button type="button" className="button subtle" disabled={busy} onClick={()=>setCopyName(null)}>{moteText("取消")}</button></div></form>}
          {confirmDelete&&<p className="notice provider-inline-form">{moteText("删除这套预设及凭据？历史问答保留。")}<button className="text-button" disabled={busy} onClick={()=>void mutate('/api/model-settings/profiles/'+encodeURIComponent(selected),'DELETE',{revision:view.revision},DEPLOYMENT_MODEL_PROFILE_ID)}>{moteText("确认删除")}</button><button className="text-button" disabled={busy} onClick={()=>setConfirmDelete(false)}>{moteText("取消")}</button></p>}
        </section>
        {profile.readOnly?<section className="panel deployment-provider"><div className="section-heading"><h2><LockKeyhole size={18}/>{moteText("部署配置")}</h2><span className="badge muted">{moteText("只读")}</span></div><p>{moteText("来自本次启动读取的配置文件或环境变量。修改文件后重启生效；需要在页面调整时，请先复制为独立预设。")}</p><dl className="provider-facts"><div><dt>Provider</dt><dd>{profile.settings.provider}</dd></div><div><dt>{moteText("接口协议")}</dt><dd>{profile.settings.protocol}</dd></div><div><dt>{moteText("服务地址")}</dt><dd>{profile.settings.baseUrl||moteText("本机 Codex 登录")}</dd></div><div><dt>{moteText("默认模型")}</dt><dd>{profile.settings.model||moteText("未配置")}</dd></div><div><dt>API key</dt><dd>{profile.settings.apiKeyConfigured?moteText("已配置，不回显"):moteText("未配置")}</dd></div><div><dt>{moteText("推理强度 / 最长等待")}</dt><dd>{profile.settings.reasoningEffort} / {profile.settings.timeoutMs/1000}s</dd></div></dl><button className="button subtle" disabled={busy||!profile.settings.model} onClick={()=>void testDeployment()}>{busy?moteText("正在测试…"):moteText("测试连接")}</button><small className="provider-test-note">{moteText("仅发送固定合成记录，验证模型与只读工具调用。")}</small>{probe&&<p role="status" className={'notice '+(probe.ok?'success':'error')}>{probe.message}</p>}</section>:<ModelSettingsEditor key={selected} api={api} revision={revision} onApplied={onApplied} profileId={selected}/>}
      </>}
    </div>
  </div>;
}
