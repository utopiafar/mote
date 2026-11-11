import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {getLocale,moteText} from '@mote/shared/i18n';
import {captureStatus,type CaptureStatusCentral} from '@mote/shared/native-status';
import type {CapturePreview} from '@mote/shared';
import {Activity,ChevronLeft,ChevronRight,Laptop,Layers3,Lock,Monitor,QrCode,RefreshCw,Smartphone,Upload} from 'lucide-react';
import {ago,dateTime,deviceLabels,errorMessage,type Api,type Device} from './api';
import {useResource} from './useResource';
import {devicePageRoute} from './device-route';
import { Loading, LoadingText } from './Loading';
const modes={realtime:'实时同步',interval:'定时同步',batch:'批量同步',manual:'手动同步'};
const states={unconfigured:'尚未配置节点',idle:'已同步',waiting:'等待同步条件',uploading:'正在上传',error:'发送需要处理',manual:'等待手动同步'};
const platforms:Record<string,string>={macos:'macOS',windows:'Windows',linux:'Linux',android:'Android',ios:'iOS',import:moteText('导入')};
/** The Central column of the shared capture status table, derived from the last report. */
export function centralDeviceStatus(device:Device):CaptureStatusCentral|null{
 return captureStatus({
  disconnected:device.disconnected===true||device.status==='offline',
  connection:'connected',
  captureEnabled:device.status!=='paused',
  captureLive:device.status==='capturing'||device.status==='paused',
  permission:device.status==='permission_required'?'missing':null,
  interrupted:device.status==='error',
  syncState:device.sync?.state==='manual'?'waiting':device.sync?.state??'idle',
  pending:device.sync?.pendingRecords??device.queueDepth,
 }).central;
}
function DeviceStatus({central,fallback,fallbackWarn=false}:{central:CaptureStatusCentral|null;fallback?:string;fallbackWarn?:boolean}){
 const text=central?moteText(central.textKey):fallback;if(!text)return null;
 const warn=central?.tone==='warn'||(central===null&&fallbackWarn);
 return <span className={'device-state'+(warn?' warn':'')}>{warn&&<span className="dot"/>}{text}</span>;
}
export function DeviceOverview({api,devices,onConnect,onAdd,onSources,onOpen,onRefresh}:{api:Api;devices:Device[];onConnect:()=>void;onAdd:()=>void;onSources:()=>void;onOpen:(ref:string)=>void;onRefresh:()=>void}){
 const read=()=>new URLSearchParams(window.location.hash.split('?')[1]).get('deviceId');
 const [selection,setSelection]=useState<{owner:Api;id:string|null}>(()=>({owner:api,id:read()})),[tab,setTab]=useState<'status'|'received'>('status');const owner=useRef(api),opener=useRef<HTMLElement|null>(null);
 const selected=selection.owner===api?selection.id:null,chosen=devices.find(device=>device.deviceId===selected);
 const choose=(id:string|null)=>{setSelection({owner:api,id});setTab('status');const query=new URLSearchParams(window.location.hash.split('?')[1]);if(id)query.set('deviceId',id);else query.delete('deviceId');window.history.replaceState(null,'','#/'+devicePageRoute+(query.size?'?'+query:''));window.dispatchEvent(new window.Event('mote:workspace-state'));};
 useEffect(()=>{const sync=()=>setSelection({owner:api,id:read()});window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[api]);
 useLayoutEffect(()=>{if(owner.current!==api){owner.current=api;choose(null);}if(!chosen&&opener.current?.isConnected)opener.current.focus({preventScroll:true});},[api,Boolean(chosen)]);
 return <section className={'device-overview final-devices'+(chosen?' has-device-selection':'')}>
 {chosen?<><button className="back-link" onClick={()=>choose(null)}><ChevronLeft size={16}/>{moteText('采集与设备')}</button><div className="page-heading split-heading"><div><h1>{chosen.deviceName}</h1><p>{platforms[chosen.platform]??chosen.platform} · {moteText('最后联系')} {ago(chosen.lastSeenAt)}</p></div><button className="button" onClick={onRefresh}><RefreshCw size={15}/>{moteText('刷新')}</button></div><nav className="device-detail-tabs" aria-label={moteText('设备详情')}><button aria-current={tab==='status'?'page':undefined} onClick={()=>setTab('status')}>{moteText('状态')}</button><button aria-current={tab==='received'?'page':undefined} onClick={()=>setTab('received')}>{moteText('已收到')}</button></nav>
 {tab==='status'?<><div className="device-status-group"><div className="device-status-row"><Monitor size={20}/><div className="device-row-copy"><h2>{moteText('本机采集')}</h2><p>{moteText('最近采集')} {ago(chosen.lastCaptureAt)}</p></div><DeviceStatus central={centralDeviceStatus(chosen)} fallback={deviceLabels[chosen.status]??chosen.status} fallbackWarn={['permission_required','error','offline'].includes(chosen.status)}/></div><div className="device-status-row"><Upload size={20}/><div className="device-row-copy"><h2>{moteText('发送')}</h2><p>{chosen.sync?moteText(modes[chosen.sync.mode]):moteText('此客户端尚未上报同步策略。采集与同步偏好请在客户端设置。')}{chosen.sync?' · '+sendDetail(chosen.sync):''}</p></div><span className="device-status-value">{chosen.sync?moteText(states[chosen.sync.state]):moteText('未上报')}</span></div><DeviceOriginals key={chosen.deviceId} api={api} device={chosen} onOpen={onOpen} firstOnly onAll={()=>setTab('received')}/></div>
 {chosen.error&&<p role="status" className="notice">{moteText('上次报告：')}{chosen.error}</p>}
 <div className="device-status-group"><DeviceConnectionState api={api} deviceId={chosen.deviceId}/><a className="device-status-row device-link-row" href="#/activity"><Activity size={20}/><span className="device-row-copy"><strong>{moteText('后台处理')}</strong></span><ChevronRight size={16}/></a></div></>:<DeviceOriginals key={chosen.deviceId} api={api} device={chosen} onOpen={onOpen}/>}</>:<><div className="page-heading split-heading"><h1>{moteText('采集与设备')}</h1><button className="button" onClick={onConnect}><QrCode size={16}/>{moteText('连接设备')}</button></div><div className="device-list" aria-label={moteText('已知设备')}>{devices.map(device=>{const status=centralDeviceStatus(device),queue=device.sync?.pendingRecords??device.queueDepth;return <button key={device.deviceId} data-device-id={device.deviceId} onClick={event=>{opener.current=event.currentTarget;choose(device.deviceId);}}>{device.platform==='android'||device.platform==='ios'?<Smartphone size={20}/>:device.platform==='macos'?<Laptop size={20}/>:<Monitor size={20}/>}<span className="device-row-copy"><strong>{device.deviceName}</strong><small>{platforms[device.platform]??device.platform} · {ago(device.lastSeenAt)}</small></span><span className="device-queue">{queue>0?moteText('待同步 {0}',queue.toLocaleString(getLocale())):''}</span><span className="device-row-status"><DeviceStatus central={status}/></span><ChevronRight size={16} className="device-chevron"/></button>;})}</div>{!devices.length&&<p>{moteText('从你的第一台设备开始')}</p>}</>}
 </section>;
}
function receivedTime(value:string){const date=new Date(value),now=new Date();return date.toDateString()===now.toDateString()?date.toLocaleTimeString(getLocale(),{hour:'2-digit',minute:'2-digit',hour12:false}):dateTime(value);}
function sendDetail(sync:NonNullable<Device['sync']>){
 return sync.mode==='interval'?moteText('约每 {0} 分钟',sync.intervalMinutes):sync.mode==='batch'?moteText('累计 {0} 条，或最长等待 {1} 分钟后同步',sync.batchSize,sync.intervalMinutes):sync.mode==='manual'?moteText('在客户端点击同步后发送记录'):moteText('有新记录时尝试同步');
}
function DeviceOriginals({api,device,onOpen,firstOnly=false,onAll}:{api:Api;device:Device;onOpen:(ref:string)=>void;firstOnly?:boolean;onAll?:()=>void}){
 const [cursor,setCursor]=useState<string>();const page=useResource<{items:CapturePreview[];nextCursor:string|null}>(api,'/api/capture-browser?'+new URLSearchParams({deviceId:device.deviceId,limit:firstOnly?'1':'24',...(cursor?{cursor}:{})}));
 if(firstOnly){const first=page.data?.items[0];return <section className="device-original-preview">{page.error!==undefined&&<p role="alert">{errorMessage(page.error)}<button className="text-button" onClick={page.refresh}>{moteText('重新读取')}</button></p>}{page.loading&&!page.data&&<Loading/>}{page.error===undefined&&<button className="device-status-row device-link-row" onClick={onAll}><Layers3 size={20}/><span className="device-row-copy"><strong>{moteText('中央已收到')}</strong><small>{first?(first.windowTitle||first.textPreview?.split('\n')[0]?.slice(0,100)||first.appName)+' · '+receivedTime(first.capturedAt):moteText('等待收到这台设备的第一份原始资料。')}</small></span><ChevronRight size={16}/></button>}</section>;}
 return <section className="device-received"><div className="section-heading"><h2>{moteText('中央已收到')}</h2><a className="text-button" href={'#/library?view=records&deviceId='+encodeURIComponent(device.deviceId)}>{moteText('在资料库查看')} →</a></div>{page.error!==undefined&&<p role="alert">{errorMessage(page.error)}<button className="button" onClick={page.refresh}>{moteText('重新读取')}</button></p>}{page.loading&&!page.data&&<Loading/>}{page.error===undefined&&page.data?.items.map(item=><button className="device-first-record" key={item.id} onClick={()=>onOpen('capture:'+item.id)}><span><strong>{item.windowTitle||item.textPreview?.split('\n')[0]?.slice(0,100)||item.appName}</strong><small>{dateTime(item.capturedAt)} · {item.deviceName}</small></span><span>{moteText('查看原文')} →</span></button>)}{page.data&&!page.error&&!page.data.items.length&&<p>{moteText('等待收到这台设备的第一份原始资料。')}</p>}{page.data&&<div className="filter-bar"><span>{moteText('本页 {0} 份资料',page.data.items.length)}</span>{cursor&&<button className="button" onClick={()=>setCursor(undefined)}>{moteText('返回第一页')}</button>}{page.data.nextCursor&&<button className="button" onClick={()=>setCursor(page.data!.nextCursor!)}>{moteText('下一页')}</button>}</div>}</section>;
}
function DeviceConnectionState({api,deviceId}:{api:Api;deviceId:string}){
 const value=useResource<{items:{deviceId?:string;scope:string;revokedAt?:string}[]}>(api,'/api/connections'),known=value.data?.items.filter(item=>item.deviceId===deviceId&&['owner','collector'].includes(item.scope))??[],active=known.filter(item=>!item.revokedAt),label=value.error!==undefined?moteText('状态读取失败。'):value.data===undefined?<LoadingText/>:!known.length?moteText('未连接'):!active.length?moteText('已撤销'):active.some(item=>item.scope==='owner')?moteText('本人设备'):moteText('已连接');
 return <><a className="device-status-row device-link-row" href={'#/connections/pair?deviceId='+encodeURIComponent(deviceId)}><Lock size={20}/><span className="device-row-copy"><strong>{moteText('连接授权')}</strong></span><span className="device-row-tail"><span className="device-status-value">{label}</span><ChevronRight size={16}/></span></a>{value.error!==undefined&&<p role="alert" className="device-row-error">{errorMessage(value.error)}<button className="text-button" onClick={value.refresh}>{moteText('重新读取')}</button></p>}{known.length>0&&!active.length&&<div className="notice"><h2>{moteText('连接授权已撤销')}</h2><p>{moteText('归档资料保留；设备需要重新连接后才能继续同步。')}</p><a className="text-button" href={'#/connections/pair?deviceId='+encodeURIComponent(deviceId)}>{moteText('重新连接')}</a></div>}</>;
}
