import { moteText } from '@mote/shared/i18n';
import {useEffect,useState} from 'react';
import {MODEL_FEATURES,MODEL_FEATURE_LABELS,DEFAULT_MODEL_MAX_TOKENS,type ModelSettingsView,type ModelFeatureDefaults} from '@mote/shared/models';
import {type Api,errorMessage} from './api';
import {ModelSettingsEditor} from './ModelSettingsEditor';

export function ModelProfiles({api,revision,onApplied}:{api:Api;revision:number;onApplied:()=>void}){
  const [view,setView]=useState<ModelSettingsView>(),[selected,setSelected]=useState('default');
  const [defaults,setDefaults]=useState<ModelFeatureDefaults>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmDelete,setConfirmDelete]=useState(false);
  useEffect(()=>{const controller=new AbortController();void api.request<ModelSettingsView>('/api/model-settings',{signal:controller.signal}).then(value=>{if(!controller.signal.aborted){setView(value);setDefaults(value.defaults);setError('');}}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));});return()=>controller.abort();},[api,revision]);
  async function mutate(path:string,method:string,body:unknown,after?:string){
    setBusy(true);setError('');
    try{const next=await api.request<ModelSettingsView>(path,{method,body:JSON.stringify(body)});setView(next);setDefaults(next.defaults);if(after)setSelected(after);setConfirmDelete(false);onApplied();}
    catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  const profiles=view?.profiles??(view?[{id:'default',name:moteText("默认配置"),settings:view.settings}]:[]);
  return <>
    <section className="panel model-profiles" aria-label={moteText("模型配置管理")}><div className="section-heading"><div><h2>{moteText("Provider 与默认模型")}</h2><p>{moteText("保存 Provider 的地址、协议与凭据，并设置默认模型。对话中可临时选择该 Provider 下的其他模型，无需重复保存凭据。")}</p></div></div>
      {error&&<p className="notice error" role="alert">{error}</p>}
      <div className="model-profile-toolbar"><label className="preference-field">{moteText("编辑模型配置")}<select aria-label={moteText("编辑模型配置")} value={selected} disabled={busy} onChange={e=>{setSelected(e.target.value);setConfirmDelete(false);}}>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}{p.settings.model?' · '+p.settings.model:''}</option>)}</select></label>
        <button className="button subtle" disabled={busy||!view||profiles.length>=31} onClick={()=>{if(!view)return;const id=crypto.randomUUID();void mutate('/api/model-settings/profiles/'+id,'PUT',{revision:view.revision,name:moteText("新模型配置"),settings:{provider:'custom',protocol:'openai-completions',baseUrl:'',model:'',reasoningEffort:'auto',maxTokens:DEFAULT_MODEL_MAX_TOKENS,timeoutMs:120000,allowUnauthenticatedLocal:false,apiKey:null,headers:null,extraBody:null}},id);}}>{moteText("新增配置")}</button>
        {selected!=='default'&&<button className="button subtle" disabled={busy} onClick={()=>setConfirmDelete(true)}>{moteText("删除配置")}</button>}
      </div>
      {confirmDelete&&<p className="notice">{moteText("删除这套模型配置及凭据？已保存的问答保留。")}<button className="text-button" disabled={busy} onClick={()=>void mutate('/api/model-settings/profiles/'+encodeURIComponent(selected),'DELETE',{revision:view!.revision},'default')}>{moteText("确认删除")}</button><button className="text-button" onClick={()=>setConfirmDelete(false)}>{moteText("取消")}</button></p>}
      {defaults&&view&&<><h3>{moteText("各功能默认模型")}</h3><div className="preference-grid">{MODEL_FEATURES.map(feature=><label key={feature} className="preference-field">{MODEL_FEATURE_LABELS[feature]}<select aria-label={MODEL_FEATURE_LABELS[feature]+moteText("默认模型")} value={defaults[feature]} disabled={busy} onChange={e=>setDefaults({...defaults,[feature]:e.target.value})}>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}{p.settings.model?' · '+p.settings.model:moteText(" · 未配置")}</option>)}</select></label>)}</div><button className="button primary" disabled={busy||JSON.stringify(defaults)===JSON.stringify(view.defaults)} onClick={()=>void mutate('/api/model-settings/defaults','PUT',{revision:view.revision,defaults})}>{moteText("保存功能默认值")}</button></>}
    </section>
    <ModelSettingsEditor key={selected} api={api} revision={revision} onApplied={onApplied} profileId={selected}/>
  </>;
}
