import React,{useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {PluginConfigurationField,PluginInstanceView,PluginPackageView} from '@mote/shared';
import type {ModelSettingsView} from '@mote/shared/models';
import {errorMessage,type Api} from './api';
import {useUnsavedChanges} from './unsaved';
import {useResource} from './useResource';
import {configurationValid} from './plugin-center-presentation';

export function PluginConfiguration({api,item,instance,busy,onSave,guided=false}:{api:Api;item:PluginPackageView;instance?:PluginInstanceView;busy:boolean;guided?:boolean;onSave:(body:Record<string,unknown>)=>void}){
 const fields=instance?.configurationSchema??item.configurationSchema??[];
 const [name,setName]=useState(instance?.name??item.name),[scope,setScope]=useState(instance?.scope??'default'),[values,setValues]=useState<Record<string,string|number|boolean>>({...instance?.configuration});
 const baseline=JSON.stringify({name:instance?.name??item.name,scope:instance?.scope??'default',values:instance?.configuration??{}});
 const dirty=JSON.stringify({name,scope,values})!==baseline;
 useUnsavedChanges(dirty);
 const models=useResource<ModelSettingsView>(api,fields.some(field=>field.type==='model-profile')?'/api/model-settings':null);
 function fieldControl(field:PluginConfigurationField){
  const value=values[field.id];
  const update=(next:string|number|boolean)=>setValues(current=>({...current,[field.id]:next}));
  if(field.type==='boolean')return <input type="checkbox" checked={value===true} onChange={event=>update(event.target.checked)} disabled={busy}/>;
  if(field.type==='select'||field.type==='model-profile'){
   const options=field.type==='model-profile'?(models.data?.profiles.map(profile=>({value:profile.id,label:profile.name}))??[]):field.options??[];
   return <select value={typeof value==='string'?value:''} required={field.required} disabled={busy||Boolean(field.type==='model-profile'&&models.loading)} onChange={event=>update(event.target.value)}><option value="">{moteText('请选择')}</option>{options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  }
  return <input type={field.type==='number'?'number':'text'} value={typeof value==='boolean'?'':value??''} required={field.required} disabled={busy} autoComplete="off" onChange={event=>update(field.type==='number'&&event.target.value!==''?Number(event.target.value):event.target.value)}/>;
 }
 return <form onSubmit={event=>{event.preventDefault();if(name.trim()&&scope.trim()&&configurationValid(fields,values))onSave({name:name.trim(),scope:scope.trim(),configuration:values});}}>
  <p>{moteText(guided?'填写连接配置。保存不会运行核验、启用插件或更换记忆方案。':'配置实例与资料范围，再单独启用。启用不会自动替换当前记忆方案。')}</p>
  <div className="plugin-fields">{!guided&&<><label className="preference-field">{moteText('实例名称')}<input value={name} required maxLength={100} disabled={busy} onChange={event=>setName(event.target.value)}/></label><label className="preference-field">{moteText('资料范围')}<input value={scope} required disabled={busy} onChange={event=>setScope(event.target.value)}/><small>{moteText('由中央节点核验授权范围；填写范围不会授予新的数据权限。')}</small></label></>}
   {fields.map(field=><label className="preference-field" key={field.id}>{field.label}{fieldControl(field)}{field.description&&<small>{field.description}</small>}{field.type==='secret-reference'&&<small>{moteText('仅填写服务器保存的凭据引用，不填写凭据本身。')}{instance?.secretStatus[field.id]?' '+moteText('服务器已配置凭据。'):''}</small>}</label>)}
  </div>
  {!instance&&!item.configurationSchema&&<p className="notice">{moteText('先创建实例，中央节点返回此插件的配置字段。')}</p>}
  {models.error!==undefined&&<p className="notice error" role="alert">{errorMessage(models.error)}</p>}
  <div className="plugin-footer"><button className="button primary" disabled={busy||!name.trim()||!scope.trim()||!configurationValid(fields,values)}>{busy?moteText('正在保存…'):instance||guided?moteText('保存配置'):moteText('创建实例')}</button></div>
 </form>;
}
