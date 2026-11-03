import React,{useEffect,useRef,useState} from 'react';
import type {RecordingStatus} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {type Api,errorMessage} from '../../api';
import {useResource} from '../../useResource';
import {ProviderAuthorization} from '../agent-access/ProviderAuthorization';

export function RecordingAuthorization({api,provider}:{api:Api;provider:string}){
 const path='/api/connectors/'+provider+'-recordings',read=useResource<RecordingStatus>(api,path,1000),scope=useRef(new AbortController());
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[appId,setAppId]=useState(''),[secret,setSecret]=useState(''),[brand,setBrand]=useState<'feishu'|'lark'>('feishu');
 useEffect(()=>{const controller=new AbortController();scope.current=controller;setBusy(false);setError('');setSecret('');return()=>controller.abort();},[api,provider]);
 const authorization=read.data?.authorization,task=authorization?.task,environment=authorization?.environment,running=task&&['running','waiting'].includes(task.state),disabled=busy||Boolean(running);
 async function run(kind:'check'|'setup'|'configure'|'login'|'authorization/cancel',payload?:unknown){
  if(busy||!authorization)return;const signal=scope.current.signal;setBusy(true);setError('');
  try{await api.request(path+'/'+kind,{method:'POST',signal,body:JSON.stringify(kind==='check'?{}:kind==='authorization/cancel'?{expectedRevision:authorization.revision,taskId:task?.id}:{operationId:crypto.randomUUID(),expectedRevision:authorization.revision,...(payload?{payload}:{})})});if(!signal.aborted)read.refresh();}
  catch(error){if(!signal.aborted)setError(errorMessage(error));}finally{if(!signal.aborted)setBusy(false);}
 }
 return <section className="recording-authorization"><h3>{moteText('账号授权')}</h3><p>{moteText('CLI 由当前中央部署准备，账号凭据由厂商 CLI 管理。')}</p>
 <div className="lark-buttons"><button className="button subtle" disabled={busy||!authorization} onClick={()=>void run('check')}>{moteText('重新检测')}</button><button className="button primary" disabled={disabled||!authorization} onClick={()=>void run('login')}>{read.data?.connected?moteText('重新授权 / 更换账号'):moteText('授权并连接账号')}</button>{provider==='feishu'&&<button className="button subtle" disabled={disabled||Boolean(environment?.configured)} onClick={()=>void run('setup')}>{moteText('创建飞书应用')}</button>}{running&&<button className="button subtle" disabled={busy} onClick={()=>void run('authorization/cancel')}>{moteText('取消当前操作')}</button>}</div>
 {environment?.version&&<p className="fine-print">{provider==='feishu'?'Lark CLI':'DWS'} {environment.version}</p>}
 {environment?.error&&<div role="alert" className="notice error"><p>{moteText('缺失或版本不符时，请管理员运行当前部署的 connectors-prepare，再重新检测。')}</p><code>{environment.error}</code></div>}
 {provider==='feishu'&&<details className="lark-manual"><summary>{moteText('使用已有应用')}</summary><p>{moteText('应用凭据仅发往当前中央节点，并通过标准输入交给厂商 CLI。')}</p><form onSubmit={event=>{event.preventDefault();const value=secret;setSecret('');void run('configure',{appId,secret:value,brand});}}><label>App ID<input required pattern="cli_[A-Za-z0-9]+" maxLength={100} value={appId} disabled={disabled} onChange={event=>setAppId(event.target.value)}/></label><label>App Secret<input type="password" required autoComplete="new-password" maxLength={1000} value={secret} disabled={disabled} onChange={event=>setSecret(event.target.value)}/></label><label>{moteText('服务区域')}<select value={brand} disabled={disabled} onChange={event=>setBrand(event.target.value as 'feishu'|'lark')}><option value="feishu">{moteText('飞书（中国）')}</option><option value="lark">Lark</option></select></label><button className="button primary" disabled={disabled||!appId||!secret}>{moteText('保存应用配置')}</button></form></details>}
 {provider==='dingtalk'&&<p className="fine-print">{moteText('钉钉所在组织需开启 CLI 接入；请在授权页面核对账号、组织和读取权限。')}</p>}
 {task&&<p role="status">{task.state==='waiting'?moteText('等待扫码或网页授权'):task.state==='running'?moteText('正在处理…'):task.state==='completed'?moteText('已完成'):task.state==='cancelled'?moteText('已取消'):moteText('未完成')}</p>}
 {running&&task.authorizationUrl&&<ProviderAuthorization key={authorization?.revision} provider={provider==='feishu'?'lark':'dingtalk'} url={task.authorizationUrl} expiresAt={task.expiresAt}/>}
 {(error||task?.error)&&<p role="alert">{error||task?.error}</p>}
 </section>;
}
