import { moteText } from '@mote/shared/i18n';
import {useEffect,useState} from 'react';
import type {ModelFeature,ModelSettingsView} from '@mote/shared/models';
import {type Api,errorMessage} from './api';

export function ModelSelector({api,feature,value,onChange,disabled}:{api:Api;feature:ModelFeature;value:string;onChange:(id:string)=>void;disabled?:boolean}){
  const [view,setView]=useState<ModelSettingsView>(),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();void api.request<ModelSettingsView>('/api/model-settings',{signal:controller.signal}).then(next=>{if(!controller.signal.aborted){setView(next);api.setAgentTimeout(Math.max(next.settings.timeoutMs,...(next.profiles??[]).map(p=>p.settings.timeoutMs)));}}).catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));});return()=>controller.abort();},[api]);
  const profiles=view?.profiles??[],defaultId=view?.defaults?.[feature]??'default',selected=profiles.find(p=>p.id===defaultId);
  return <label className="model-selector"><span>{moteText("本次模型")}</span><select aria-label={moteText("本次模型")} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}><option value="">{moteText("功能默认")}{selected?' · '+selected.name+(selected.settings.model?' / '+selected.settings.model:''):''}</option>{value&&!profiles.some(p=>p.id===value)&&<option value={value}>{moteText("配置已不可用，请重新选择")}</option>}{profiles.map(p=><option key={p.id} value={p.id}>{p.name} · {p.settings.model||moteText("未配置")}</option>)}</select>{error&&<small role="alert">{moteText("无法读取模型列表：")}{error}</small>}</label>;
}
