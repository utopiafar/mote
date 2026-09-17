import { moteText } from '@mote/shared/i18n';
import {useEffect,useState} from 'react';
import type {ModelFeature,ModelSettingsView} from '@mote/shared/models';
import {type Api,errorMessage} from './api';

export function ModelSelector({api,feature,value,onChange,disabled,model,onModelChange}:{api:Api;feature:ModelFeature;value:string;onChange:(id:string)=>void;disabled?:boolean;model?:string;onModelChange?:(value:string)=>void}){
  const [view,setView]=useState<ModelSettingsView>(),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();void api.request<ModelSettingsView>('/api/model-settings',{signal:controller.signal}).then(next=>{if(!controller.signal.aborted){setView(next);api.setAgentTimeout(Math.max(next.settings.timeoutMs,...(next.profiles??[]).map(p=>p.settings.timeoutMs)));}}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));});return()=>controller.abort();},[api]);
  const [models,setModels]=useState<{id:string;name:string}[]>([]);
  const profiles=view?.profiles??[],defaultId=view?.defaults?.[feature]??'default',selected=profiles.find(p=>p.id===defaultId);
  const providerId=value||defaultId;
  useEffect(()=>{if(!onModelChange||!view)return;const c=new AbortController();setModels([]);void api.request<{items:{id:string;name:string}[]}>(`/api/model-settings/profiles/${encodeURIComponent(providerId)}/models`,{signal:c.signal}).then(v=>{if(!c.signal.aborted)setModels(v.items);}).catch(()=>{});return()=>c.abort();},[api,providerId,Boolean(onModelChange),Boolean(view)]);
  return <label className="model-selector"><span>{moteText("本次模型")}</span><select aria-label={moteText("本次模型")} value={value} disabled={disabled} onChange={e=>{onChange(e.target.value);onModelChange?.('');}}><option value="">{moteText("功能默认")}{selected?' · '+selected.name+(selected.settings.model?' / '+selected.settings.model:''):''}</option>{value&&!profiles.some(p=>p.id===value)&&<option value={value}>{moteText("配置已不可用，请重新选择")}</option>}{profiles.map(p=><option key={p.id} value={p.id}>{p.name} · {p.settings.model||moteText("未配置")}</option>)}</select>{onModelChange&&<><span>Provider → {moteText("模型")}</span><input aria-label={moteText("临时模型 ID")} placeholder={profiles.find(p=>p.id===providerId)?.settings.model||moteText("模型 ID")} list="query-provider-models" disabled={disabled} value={model??''} maxLength={512} onChange={e=>onModelChange(e.target.value)}/><datalist id="query-provider-models">{models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</datalist></>}{error&&<small role="alert">{moteText("无法读取模型列表：")}{error}</small>}</label>;
}
