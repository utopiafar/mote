import React,{useEffect,useRef,useState} from 'react';
import {featureRequirementsAvailable,type FeatureInventory,type QueryScope} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {ApiError,dateTime,errorMessage,type Api} from '../../api';
import {useResource} from '../../useResource';
import {ErrorNotice} from '../../shell-components';
import {Loading} from '../../Loading';
import {useForegroundResources} from '../../useForegroundResources';

export const all:QueryScope={kind:'all'};
export const scoped=(path:string,scope:QueryScope,extra:Record<string,string>={})=>path+'?'+new URLSearchParams({scope:JSON.stringify(scope),...extra});
export function assistantHref(kind:'matter'|'routine'|'commitment',id:string,returnTo?:string,scope?:QueryScope){
 return '#/assistant/matters?'+new URLSearchParams({[kind]:id,...(scope?{scope:JSON.stringify(scope)}:{}),...(returnTo?{returnTo}:{})});
}
export function useAssistantRead<T>(api:Api,path:string|null,revision?:unknown){
 // Details never render a prior visit's cached evidence while checking access.
 const read=useResource<T>(api,path,3000,revision,undefined,true);
 const validity=useRef({api,path,failed:false});
 if(validity.current.api!==api||validity.current.path!==path)validity.current={api,path,failed:false};
 if(read.error!==undefined)validity.current.failed=true;
 else if(!read.loading&&read.data!==undefined)validity.current.failed=false;
 useEffect(()=>{const visible=()=>{if(!document.hidden)read.refresh();};document.addEventListener('visibilitychange',visible);window.addEventListener('focus',visible);
  return()=>{document.removeEventListener('visibilitychange',visible);window.removeEventListener('focus',visible);};},[read.refresh]);
 return {...read,data:validity.current.failed?undefined:read.data};
}
export function useAssistantCapabilities(api:Api){
 const read=useResource<FeatureInventory>(api,'/api/features',5000);useForegroundResources(api,['/api/features']);
 return (id:string)=>read.error===undefined&&Array.isArray(read.data?.capabilities)&&featureRequirementsAvailable([id],read.data);
}
export function useAssistantCommand(api:Api,onSaved:()=>void){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const request=useRef<AbortController|null>(null),owner=useRef(api);owner.current=api;
 useEffect(()=>{setBusy(false);setError('');return()=>{request.current?.abort();request.current=null;};},[api]);
 const run=async(path:string,body:unknown)=>{
  if(request.current)return false;
  const controller=new AbortController();request.current=controller;setBusy(true);setError('');
  const active=()=>!controller.signal.aborted&&request.current===controller&&owner.current===api;
  try{await api.request(path,{method:'POST',body:JSON.stringify(body),signal:controller.signal});if(!active())return false;onSaved();return true;}
  catch(reason){if(active())setError(reason instanceof ApiError&&reason.status===409?moteText('内容已在其他地方修改或失效。请重新读取后再编辑。'):errorMessage(reason));return false;}
  finally{if(active()){request.current=null;setBusy(false);}}
 };
 return {busy,error,run};
}
export function ReadState({read}:{read:{error?:unknown;refresh:()=>void}}){
 return read.error!==undefined?<ErrorNotice text={errorMessage(read.error)} retry={read.refresh}/>:<Loading/>;
}
export function ScopePreview({scope}:{scope:QueryScope}){
 const empty=scope.kind==='selection'&&scope.sourceIds?.length===0||scope.evidenceIds?.length===0;
 return <div className="assistant-scope"><h3>{moteText('资料范围')}</h3><p>{empty?moteText('未选择资料'):scope.kind==='all'?moteText('全部来源'):moteText('已选资料')}</p>
  {scope.kind==='selection'&&scope.sourceIds&&scope.sourceIds.length>0&&<p>{moteText('来源')} · {scope.sourceIds.join(' · ')}</p>}
  {scope.evidenceIds&&scope.evidenceIds.length>0&&<p>{moteText('资料')} · {scope.evidenceIds.length}</p>}
  {scope.deviceId&&<p>{moteText('设备')} · {scope.deviceId}</p>}
  {scope.after&&<p>{moteText('开始时间')} · {dateTime(scope.after)}</p>}{scope.before&&<p>{moteText('结束时间')} · {dateTime(scope.before)}</p>}
 </div>;
}
export function BackgroundStatus({api}:{api:Api}){
 const read=useResource<{authorization:{state:'on'|'off';excludedSourceIds:string[]}}>(api,'/api/model-authorization',3000);useForegroundResources(api,['/api/model-authorization']);
 return <aside className="assistant-background"><strong>{moteText('后台模型处理')}</strong>
  {read.error!==undefined||!read.data?<ReadState read={read}/>:<><p role="status">{moteText(read.data.authorization.state==='on'?'后台模型已开启':'后台模型已关闭')}</p>
   {read.data.authorization.excludedSourceIds.length>0&&<p>{moteText('部分来源已排除在后台模型处理之外。')}</p>}</>}
  <p>{moteText('后台开关不改变采集设置，也不代表某项任务正在运行。')}</p><a href="#/sources">{moteText('管理来源')}</a>
 </aside>;
}
export const matterLabel=(state:'active'|'paused'|'archived')=>moteText(state==='active'?'事项已启用':state==='paused'?'事项已暂停':'已归档');
export function taskLabel(state:string){
 return moteText(state==='running'?'正在进行':state==='waiting'?'排队中':state==='succeeded'||state==='completed'?'已完成':state==='stale'?'已失效':state==='cancelled'?'已取消':state==='blocked'||state==='needs_input'?'需要你补充':state==='failed'?'失败':'未完成');
}
