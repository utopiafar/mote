import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Copy,Download,QrCode,X} from 'lucide-react';
import {connectionServerUrl} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import designTokens from '../../../packages/shared/design-tokens.json';
import {errorMessage,type Api} from './api';
import {useResource} from './useResource';

type Invitation={format:'mote.connection';version:2;deploymentId:string;userId:string;serverUrl:string;purpose:'device';code:string;expiresAt:string;deviceId?:string};
type Reply={invitation:Invitation;uri:string};
function checked(value:Reply,api:Api,serverUrl:string,deviceId:string):Reply{
 const inv=value?.invitation,c=api.connection;
 const fields=['format','version','deploymentId','userId','serverUrl','purpose','code','expiresAt',...(deviceId?['deviceId']:[])];
 if(!c||c.mode!=='web'||!inv||Object.keys(inv).some(key=>!fields.includes(key))||Object.keys(inv).length!==fields.length||inv.format!=='mote.connection'||inv.version!==2||inv.purpose!=='device'||inv.deploymentId!==c.deploymentId||inv.userId!==c.userId||inv.serverUrl!==serverUrl||inv.deviceId!==(deviceId||undefined)||typeof inv.code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(inv.code)||typeof inv.expiresAt!=='string'||!Number.isFinite(Date.parse(inv.expiresAt))||Date.parse(inv.expiresAt)<=Date.now())throw Error(moteText('连接邀请校验失败，请重新生成。'));
 const bytes=new TextEncoder().encode(JSON.stringify(inv)),encoded=btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join('')).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
 if(value.uri!=='mote://connect?data='+encoded)throw Error(moteText('连接邀请校验失败，请重新生成。'));
 return value;
}
/** Keep transient pairing capabilities inside one immutable credential tree. */
export function DevicePairing({api}:{api:Api}){return <DevicePairingView key={JSON.stringify(api.connection)} api={api}/>;}
function DevicePairingView({api}:{api:Api}){
 const [fixedApi]=useState(api),live=useRef(false),active=useRef<AbortController|null>(null),running=useRef(false);
 const devices=useResource<{items:{id:string;name:string}[]}>(fixedApi,'/api/ingress/devices'),credentials=useResource<{items:{deviceId?:string;deviceName?:string;label?:string}[]}>(fixedApi,'/api/connections'),sources=useResource<{items:{deviceId?:string;name:string}[]}>(fixedApi,'/api/sources');
 const [endpoint,setEndpoint]=useState(location.origin),[label,setLabel]=useState(moteText('我的新设备')),[deviceId,setDeviceId]=useState(''),[invite,setInvite]=useState<Reply>(),[qr,setQr]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[now,setNow]=useState(Date.now());
 useLayoutEffect(()=>{live.current=true;return()=>{live.current=false;active.current?.abort();};},[]);
 useEffect(()=>{setQr('');if(!invite)return;let current=true;void import('qrcode').then(({default:QRCode})=>QRCode.toDataURL(invite.uri,{width:360,margin:4,errorCorrectionLevel:'M',color:{dark:designTokens.ink,light:designTokens.surface}})).then(value=>{if(current&&live.current)setQr(value);}).catch(()=>{if(current&&live.current)setError(moteText('二维码生成失败，可以复制或下载连接邀请 JSON。'));});return()=>{current=false;};},[invite]);
 useEffect(()=>{if(!invite)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[invite]);
 const expired=!!invite&&Date.parse(invite.invitation.expiresAt)<=now;
 useEffect(()=>{if(expired){setInvite(undefined);setMessage(moteText('连接邀请已到期，请重新生成；已经连接的设备不受影响。'));}},[expired]);
 const known=[...new Map([...(sources.data?.items.filter(s=>s.deviceId).map(s=>[s.deviceId!,{id:s.deviceId!,name:s.name}] as const)??[]),...(credentials.data?.items.filter(c=>c.deviceId).map(c=>[c.deviceId!,{id:c.deviceId!,name:c.deviceName||c.label||c.deviceId!}] as const)??[]),...(devices.data?.items.map(d=>[d.id,d] as const)??[])]).values()];
 async function act(work:(signal:AbortSignal)=>Promise<void>){if(!live.current||running.current)return;running.current=true;const controller=new AbortController();active.current=controller;setBusy(true);setError('');setMessage('');try{await work(controller.signal);}catch(e){if(live.current&&!controller.signal.aborted)setError(errorMessage(e));}finally{if(active.current===controller){running.current=false;active.current=null;if(live.current)setBusy(false);}}}
 function generate(){void act(async signal=>{const serverUrl=connectionServerUrl(endpoint.trim());if(invite)await fixedApi.request('/api/connections/invitations/revoke',{method:'POST',signal,body:JSON.stringify({code:invite.invitation.code})});if(!live.current||signal.aborted)return;setInvite(undefined);const value=await fixedApi.request<Reply>('/api/connections/invitations',{method:'POST',signal,body:JSON.stringify({serverUrl,label:label.trim(),...(deviceId?{deviceId}:{})})});if(live.current&&!signal.aborted){setNow(Date.now());setInvite(checked(value,fixedApi,serverUrl,deviceId));}});}
 function cancel(){const original=invite;if(!original)return;void act(async signal=>{await fixedApi.request('/api/connections/invitations/revoke',{method:'POST',signal,body:JSON.stringify({code:original.invitation.code})});if(live.current&&!signal.aborted){setInvite(undefined);setMessage(moteText('邀请已取消，旧二维码和 JSON 不再有效。'));}});}
 async function copy(){if(!live.current||!invite)return;const json=JSON.stringify(invite.invitation,null,2);try{await navigator.clipboard.writeText(json);if(live.current)setMessage(moteText('已复制，请只粘贴到你信任的客户端。'));}catch{if(live.current)setError(moteText('当前环境无法访问剪贴板，请使用下载 JSON，或展开内容手动复制。'));}}
 function download(){if(!live.current||!invite)return;const url=URL.createObjectURL(new Blob([JSON.stringify(invite.invitation,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='mote-connection.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return <section className="connections" aria-label={moteText('设备二维码与连接授权')}><div className="section-heading"><h2><QrCode size={19}/>{moteText('设备二维码与连接授权')}</h2></div>
  <p>{moteText('扫码或导入一次性邀请，把手机和电脑连接到中央节点。')}</p><p className="fine-print">{moteText('此页面只生成连接授权。先安装 Mac / Android 客户端，再填写客户端可访问的节点地址；二维码不会创建公网地址或隧道。')}</p>
  <p>{moteText('设备邀请仅授权此账号的采集与同步，不授予私人资料库或账号管理权限。')}</p>
  {Boolean(error||devices.error||credentials.error||sources.error)&&<p role="alert">{error||errorMessage(devices.error||credentials.error||sources.error)}</p>}{message&&<p role="status">{message}</p>}
  <div className="connection-fields"><label>{moteText('本服务供设备访问的地址')}<input aria-label={moteText('邀请节点地址')} type="url" value={endpoint} disabled={busy} onChange={e=>setEndpoint(e.target.value)}/></label><label>{moteText('连接名称')}<input aria-label={moteText('连接名称')} value={label} maxLength={120} disabled={busy} onChange={e=>setLabel(e.target.value)}/></label></div>
  {(()=>{try{return ['localhost','127.0.0.1','[::1]'].includes(new URL(endpoint).hostname);}catch{return false;}})()&&<p className="connection-warning">{moteText('当前是本机地址，手机扫码后会指向手机自己。跨设备连接请先填入可访问的 HTTPS 域名；本机地址可用于同一台电脑或明确配置了端口转发的开发环境。')}</p>}
  <label>{moteText('设备身份')}<select aria-label={moteText('邀请设备身份')} value={deviceId} disabled={busy} onChange={e=>setDeviceId(e.target.value)}><option value="">{moteText('首次连接的新设备')}</option>{known.map(device=><option key={device.id} value={device.id}>{device.name} · {device.id}</option>)}</select></label><p className="fine-print">{moteText('重新配对时，请选择原设备以保留身份。成功配对后会替换该设备之前的客户端凭据。')}</p>
  <button className="button primary" disabled={busy||!label.trim()} onClick={generate}><QrCode size={16}/>{busy?moteText('正在生成…'):invite?moteText('重新生成二维码'):moteText('生成设备二维码')}</button>
  {invite&&!expired&&<div className="connection-invitation" aria-label={moteText('连接邀请')}><div className="connection-qr">{qr?<img src={qr} width={288} height={288} alt={moteText('使用 Mote 客户端扫描此一次性连接二维码')}/>:<p>{moteText('正在生成二维码…')}</p>}</div><div className="connection-invitation-details"><span className="badge green">{moteText('有效期剩余')} {Math.max(0,Math.ceil((Date.parse(invite.invitation.expiresAt)-now)/1000))} {moteText('秒')}</span><h3>{moteText('在客户端打开「设置 → 连接」')}</h3><code>{invite.invitation.serverUrl}</code><p>{moteText('Android 可以直接扫码；Mac 可以导入二维码图片。两端均支持粘贴邀请或导入 JSON 文件，确认节点地址后连接。')}</p><p className="fine-print">{moteText('有效期内，持有邀请的人可以领取该连接。请勿公开分享；关闭此页面不会取消邀请，需使用下面的取消按钮。')}</p><div className="connection-actions"><button className="button" onClick={()=>void copy()}><Copy size={15}/>{moteText('复制邀请 JSON')}</button><button className="button" onClick={download}><Download size={15}/>{moteText('下载 JSON')}</button>{qr&&<a className="button" href={qr} download="mote-connection.png">{moteText('保存二维码')}</a>}<button className="button subtle" disabled={busy} onClick={cancel}><X size={15}/>{moteText('取消邀请')}</button></div><details><summary>{moteText('手动复制邀请内容')}</summary><textarea readOnly aria-label={moteText('连接邀请 JSON')} value={JSON.stringify(invite.invitation,null,2)} spellCheck={false}/></details></div></div>}
 </section>;
}
