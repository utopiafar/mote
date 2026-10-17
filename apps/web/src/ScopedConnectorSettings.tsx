import {useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {ConfigServiceView} from '@mote/shared';
import {type Api,errorMessage} from './api';
import {resources} from './resource-cache';
import {useUnsavedChanges} from './unsaved';

type GoogleSettings={id:string;provider:string;autoSync:boolean;syncIntervalMs:number;googleClientId?:string;googleClientSecret?:boolean|string;googleRedirectUri?:string};
type SavedSettings={connections:GoogleSettings[]};

/** M10 creates the disabled instance; existing settings use M04's masked CAS. */
export function ScopedConnectorSettings({api,id,provider='gmail',onSaved,onCancel}:{api:Api;id?:string;provider?:'gmail'|'google-calendar'|'lark';onSaved:(id:string)=>void;onCancel:()=>void}){
 const [base,setBase]=useState<ConfigServiceView>(),[connectionId,setConnectionId]=useState(id??''),[clientId,setClientId]=useState(''),[secret,setSecret]=useState(''),[clearSecret,setClearSecret]=useState(false),[redirect,setRedirect]=useState(''),[automatic,setAutomatic]=useState(true),[minutes,setMinutes]=useState('5'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[dirty,setDirty]=useState(false);
 const alive=useRef(true),running=useRef(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[api]);
 useUnsavedChanges(dirty);
 useEffect(()=>{const controller=new AbortController();void api.request<ConfigServiceView>('/api/configuration',{signal:controller.signal}).then(view=>{if(controller.signal.aborted)return;const settings=view.domains.find(value=>value.id==='connectorSettings')?.saved as SavedSettings|undefined,existing=id?settings?.connections.find(value=>value.id===id):undefined;if(id&&(!existing||existing.provider!==provider))throw Error(moteText('连接不存在，请重新读取。'));setBase(view);if(existing){setClientId(existing.googleClientId??'');setRedirect(existing.googleRedirectUri??'');setAutomatic(existing.autoSync);setMinutes(String(existing.syncIntervalMs/60000));}}).catch(error=>{if(!controller.signal.aborted)setError(errorMessage(error));});return()=>controller.abort();},[api,id,provider]);
 const existing=(base?.domains.find(value=>value.id==='connectorSettings')?.saved as SavedSettings|undefined)?.connections.find(value=>value.id===id);
 async function save(){
  if(!alive.current||running.current||!base)return;running.current=true;setBusy(true);setError('');
  try{
   const interval=Number(minutes)*60000;if(!Number.isInteger(interval)||interval<60000||interval>2147483647)throw Error(moteText('同步间隔不符合要求。'));
   const value:GoogleSettings={id:connectionId,provider,...(provider==='lark'?{}:{googleClientId:clientId,googleRedirectUri:redirect,googleClientSecret:clearSecret?'':secret||existing?.googleClientSecret||''}),autoSync:automatic,syncIntervalMs:interval};
   if(id){const settings=base.domains.find(value=>value.id==='connectorSettings')!.saved as SavedSettings;await api.request('/api/configuration/connectorSettings',{method:'PUT',body:JSON.stringify({revision:base.revision,value:{connections:settings.connections.map(previous=>previous.id===id?value:previous)},preserveRedactedSecrets:true})});}
   else await api.request('/api/connectors/'+encodeURIComponent(connectionId),{method:'PUT',body:JSON.stringify({expectedRevision:base.revision,connection:value})});
   if(!alive.current)return;setDirty(false);resources(api).invalidate(path=>path==='/api/connectors'||path==='/api/configuration'||path==='/api/plugins');onSaved(connectionId);
  }catch(e){if(alive.current)setError(errorMessage(e));}finally{if(alive.current){running.current=false;setBusy(false);}}
 }
 return <form className="connector-settings settings-form" onSubmit={event=>{event.preventDefault();void save();}}>
  <fieldset disabled={busy||!base}><legend>{id?moteText('编辑连接'):moteText('新建连接')}</legend>
   <label>{moteText('连接 ID')}<input aria-label={moteText('连接 ID')} required pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}" maxLength={80} disabled={!!id} value={connectionId} onInput={event=>{setConnectionId(event.currentTarget.value);setDirty(true);}}/></label>
   {provider!=='lark'&&<><label>{moteText('Google 客户端 ID')}<input aria-label={moteText('Google 客户端 ID')} required maxLength={2000} value={clientId} onInput={event=>{setClientId(event.currentTarget.value);setDirty(true);}}/></label>
   <label>{moteText('Google 客户端密钥')}<input aria-label={moteText('Google 客户端密钥')} type="password" autoComplete="new-password" maxLength={4000} value={secret} disabled={clearSecret} onInput={event=>{setSecret(event.currentTarget.value);setDirty(true);}}/>{existing?.googleClientSecret&&<small>{moteText('留空保留已保存密钥。')}</small>}</label>
   {existing?.googleClientSecret&&<label><input type="checkbox" checked={clearSecret} onChange={event=>{setClearSecret(event.target.checked);setDirty(true);}}/>{moteText('清除已保存密钥')}</label>}
   <label>{moteText('Google 授权回调地址')}<input aria-label={moteText('Google 授权回调地址')} type="url" required maxLength={4000} value={redirect} onInput={event=>{setRedirect(event.currentTarget.value);setDirty(true);}}/></label></>}
   <label><input type="checkbox" checked={automatic} onChange={event=>{setAutomatic(event.target.checked);setDirty(true);}}/>{moteText('自动同步')}</label>
   <label>{moteText('同步间隔（分钟）')}<input aria-label={moteText('同步间隔（分钟）')} type="number" min="1" max={2147483647/60000} step="any" required value={minutes} onInput={event=>{setMinutes(event.currentTarget.value);setDirty(true);}}/></label>
   <button className="button primary" disabled={!dirty}>{moteText('保存连接')}</button>
  </fieldset><button className="button subtle" type="button" disabled={busy} onClick={onCancel}>{moteText('取消')}</button>{error&&<p role="alert" className="error-banner">{error}</p>}
 </form>;
}
