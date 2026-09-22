import { moteText } from '@mote/shared/i18n';
import {useEffect,useId} from 'react';
import {useResource} from './useResource';
import type {ModelFeature,ModelSettingsView} from '@mote/shared/models';
import {type Api,errorMessage} from './api';

export function ModelSelector({api,feature,value,onChange,disabled,model,onModelChange}:{api:Api;feature:ModelFeature;value:string;onChange:(id:string)=>void;disabled?:boolean;model?:string;onModelChange?:(value:string)=>void}){
  const settings=useResource<ModelSettingsView>(api,'/api/model-settings'),view=settings.data;
  useEffect(()=>{if(!view)return;const values=[view.settings.agentTimeoutMs,...(view.profiles??[]).map(p=>p.settings.agentTimeoutMs)],timeouts=values.filter((value):value is number=>value!==null);api.setAgentTimeout(values.some(value=>value===null)?null:timeouts.length?Math.max(...timeouts):null);},[api,view]);
  const profiles=view?.profiles??[],defaultId=view?.defaults?.[feature]??'default',selected=profiles.find(p=>p.id===defaultId),providerId=value||defaultId;
  const catalog=useResource<{items:{id:string;name:string}[]}>(api,onModelChange&&view?`/api/model-settings/profiles/${encodeURIComponent(providerId)}/models`:null),models=catalog.data?.items??[];
  const error=settings.error||catalog.error,modelListId=useId();
  return <label className="model-selector"><span>{moteText("本次模型")}</span><select aria-label={moteText("本次模型")} value={value} disabled={disabled||settings.loading&&!view} onChange={e=>{onChange(e.target.value);onModelChange?.('');}}><option value="">{moteText("功能默认")}{selected?' · '+selected.name+((view?.defaultModels?.[feature]||selected.settings.model)?' / '+(view?.defaultModels?.[feature]||selected.settings.model):''):''}</option>{value&&!profiles.some(p=>p.id===value)&&<option value={value}>{moteText("配置已不可用，请重新选择")}</option>}{profiles.map(p=><option key={p.id} value={p.id}>{p.name} · {p.settings.model||moteText("未配置")}</option>)}</select>{onModelChange&&<><span>Provider → {moteText("模型")}</span><input aria-label={moteText("临时模型 ID")} placeholder={(!value?view?.defaultModels?.[feature]:undefined)||profiles.find(p=>p.id===providerId)?.settings.model||moteText("模型 ID")} list={modelListId} disabled={disabled} value={model??''} maxLength={512} onChange={e=>onModelChange(e.target.value)}/><datalist id={modelListId}>{models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</datalist></>}{!!error&&<small role="alert">{moteText("无法读取模型列表：")}{errorMessage(error)}</small>}</label>;
}
