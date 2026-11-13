import {useEffect,useRef,useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import type {MediaRole,MediaModelStatus} from '@mote/shared';
import {type Api,errorMessage} from './api';
import {useResource} from './useResource';
import {resources} from './resource-cache';
import { LoadingText } from './Loading';

type Preparation={state:string;error?:string;runtimeReady:boolean;model:{state:string;bytes:number;totalBytes:number}};
const running=(state?:string)=>['queued','dependencies','verifying_dependencies','models','starting'].includes(state??'');
function stateText(value:Preparation){
 if(value.state==='queued')return moteText('等待另一项安装完成…');
 if(value.state==='dependencies')return moteText('正在准备运行依赖…');
 if(value.state==='verifying_dependencies')return moteText('正在验证运行依赖…');
 if(value.state==='models')return value.model.state==='verifying'?moteText('正在验证模型…'):value.model.state==='installing'?moteText('正在安装模型…'):moteText('正在下载模型…');
 if(value.state==='starting')return moteText('正在启动本机处理…');
 if(value.state==='ready'&&value.runtimeReady)return moteText('可使用');
 if(value.state==='idle'&&value.model.state==='ready')return moteText('模型已准备，音频或图片服务尚未就绪。检查服务后重试。');
 if(value.state==='cancelled')return moteText('安装已取消，可继续准备');
 if(value.state==='failed')return moteText('准备未完成');
 if(value.state==='unsupported')return moteText('当前运行方式需要手动准备');
 return moteText('尚未安装');
}
function failureText(code?:string){
 if(code==='configuration_changed')return moteText('运行配置已更改，重启中心后再准备。');
 if(code==='external_worker')return moteText('当前使用自定义处理连接，请在对应服务准备依赖。');
 if(code==='worker_auth_missing')return moteText('本机处理连接尚未配置，请检查运行设置。');
 if(code==='sidecar_unavailable')return moteText('模型已准备，音频或图片服务尚未就绪。检查服务后重试。');
 if(code==='worker_start_failed'||code==='worker_unavailable')return moteText('本机处理未能启动，请重试。');
 if(code==='runtime_unknown'||code==='platform_unsupported')return moteText('此运行方式暂不支持自动安装，可在高级连接中使用已准备的服务。');
 return moteText('准备未完成，请检查网络和可用空间后重试。');
}
/** Preparation never changes automatic processing consent or model selection. */
export function MediaPreparation({api,role,title}:{api:Api;role:MediaRole;title:string}){
 // VLM asset installation is independent of optional-plugin enablement. The
 // plugin owns starting its worker; installing weights cannot start it here.
 const assetsOnly=role==='local-image',path=assetsOnly?'/api/media-models':'/api/media-preparation';
 const read=useResource<Partial<Record<MediaRole,Preparation|MediaModelStatus>>>(api,path),status=read.data?.[role];
 const asset=assetsOnly?status as MediaModelStatus|undefined:undefined;
 const value:Preparation|undefined=assetsOnly?(asset?{state:['downloading','verifying','installing'].includes(asset.state)?'models':asset.state==='not_installed'?'idle':asset.state,error:asset.error,runtimeReady:asset.runtimeReady,model:asset}:undefined):status as Preparation|undefined;
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),current=useRef({api,role});
 if(current.current.api!==api||current.current.role!==role)current.current={api,role};
 useEffect(()=>{setBusy(false);setMessage('');},[api,role]);
 useEffect(()=>value?resources(api).get(path).poll(running(value.state)?2000:10000):undefined,[api,path,value?.state]);
 async function action(cancel=false){const owner=current.current,origin=owner.api,target=owner.role,isCurrent=()=>current.current===owner;setBusy(true);setMessage('');try{await origin.request(assetsOnly?`/api/media-models/${target}/${cancel?'cancel':'install'}`:`/api/media-preparation/${target}${cancel?'/cancel':''}`,{method:'POST',body:'{}'});if(isCurrent()){resources(origin).invalidate(key=>key==='/api/media-preparation'||key==='/api/media-models');}}catch(error){if(isCurrent())setMessage(errorMessage(error));}finally{if(isCurrent())setBusy(false);}}
 const installing=running(value?.state),ready=assetsOnly?asset?.state==='ready':value?.state==='ready'&&value.runtimeReady;
 return <section className="media-preparation" aria-label={title}>
  <div className="media-preparation-row"><div><strong>{title}</strong><p role="status">{value?assetsOnly&&ready?moteText('模型已安装'):stateText(value):<LoadingText/>}</p></div>
   {ready?<button type="button" className="button" disabled={read.loading} onClick={()=>read.refresh()}>{moteText('检查状态')}</button>:<button type="button" className="button primary" disabled={busy||installing||!value||Boolean(read.error)||value.state==='unsupported'} onClick={()=>void action()}>{installing?moteText('安装中…'):value?.state==='failed'||value?.state==='cancelled'||value?.model.state==='ready'?moteText('重试'):moteText('一键安装')}</button>}
  </div>
  {assetsOnly&&<p>{moteText('安装模型不会启用本地识图或改变处理设置。')}</p>}
  {installing&&<><progress aria-label={moteText('安装进度')} {...(value?.state==='models'&&value.model.totalBytes>0?{value:value.model.bytes,max:value.model.totalBytes}:{})}/><button type="button" className="text-button" disabled={busy} onClick={()=>void action(true)}>{moteText('取消')}</button></>}
  {(value?.state==='failed'||value?.state==='unsupported')&&<p role="alert">{failureText(value.error)}</p>}
  {(Boolean(message)||Boolean(read.error))&&<p role="alert">{message||errorMessage(read.error)}</p>}
  {Boolean(read.error)&&<button type="button" className="text-button" onClick={()=>read.refresh()}>{moteText('刷新')}</button>}
 </section>;
}
