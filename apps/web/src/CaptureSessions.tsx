import { moteText } from '@mote/shared/i18n';
import {useEffect,useState} from 'react';
import {ArrowLeft,ArrowRight,Clock3,Layers3,RefreshCw} from 'lucide-react';
import type {CaptureSession} from '@mote/shared';
import {type Api,type Device,dateTime,errorMessage,queryString} from './api';
import {captureDateRange,localDateInput} from './capture-presentation';

type ImageRef={id:string;capturedAt:string;hasImage:boolean;appName:string};
export function CaptureSessions({api,devices,onOpen,revision}:{api:Api;devices:Device[];onOpen:(id:string)=>void;revision:number}){
  const [day,setDay]=useState(()=>localDateInput(new Date())),[device,setDevice]=useState(''),[mode,setMode]=useState('sessions');
  const [selected,setSelected]=useState<CaptureSession|null>(null),[items,setItems]=useState<(CaptureSession|ImageRef)[]>([]);
  const [cursors,setCursors]=useState<(string|undefined)[]>([undefined]),[next,setNext]=useState<string|null>(null);
  const [loading,setLoading]=useState(false),[error,setError]=useState(''),[total,setTotal]=useState(0),[groupCount,setGroupCount]=useState(0),[refresh,setRefresh]=useState(0);
  const reset=()=>{setSelected(null);setCursors([undefined]);};
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');setItems([]);setNext(null);
    const range=captureDateRange(day,day),params={...range,...(device?{deviceId:device}:{}),limit:20,cursor:cursors.at(-1)};
    const path=mode==='sessions'?'sessions':selected?'album-images':'albums';
    const scope=selected?(mode==='sessions'?{...params,deviceId:selected.deviceId,sessionId:selected.id}:{...params,deviceId:selected.deviceId,appId:selected.appId,after:selected.after,before:selected.before}):params;
    void api.request<{items:(CaptureSession|ImageRef)[];totalCount:number;sessionCount?:number;albumCount?:number;nextCursor:string|null}>(`/api/capture-browser/${path}${queryString({},scope)}`,{signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted){setItems(result.items);setTotal(result.totalCount);setGroupCount(result.sessionCount??result.albumCount??0);setNext(result.nextCursor);}})
      .catch(e=>{if(!controller.signal.aborted)setError(errorMessage(e));}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[api,day,device,mode,selected,cursors,revision,refresh]);
  return <section className="capture-sessions">
    <div className="filter-bar"><label>{moteText("日期")}<input aria-label={moteText("Session 日期")} type="date" required value={day} onChange={e=>{if(e.target.value){setDay(e.target.value);reset();}}}/></label><label>{moteText("设备")}<select value={device} onChange={e=>{setDevice(e.target.value);reset();}}><option value="">{moteText("全部设备")}</option>{devices.map(d=><option key={d.deviceId} value={d.deviceId}>{d.deviceName}</option>)}</select></label><label>{moteText("聚合方式")}<select aria-label={moteText("聚合方式")} value={mode} onChange={e=>{setMode(e.target.value);reset();}}><option value="sessions">{moteText("按 Session")}</option><option value="albums">{moteText("按 App · 15 分钟")}</option></select></label><button className="button" onClick={()=>{reset();setRefresh(n=>n+1);}} disabled={loading}><RefreshCw size={15}/>{moteText("刷新")}</button></div>
    <p className="measurement-note">{mode==='sessions'?moteText("同一设备、同一应用的连续截图归为一段；切换应用或相邻采样超过 5 分钟即分段。范围仅限所选日期，本机与中央按各自保留的记录分组。"):moteText("每 15 分钟按设备与应用汇集截图。")}{' '}{moteText("起止时间表示观察范围，不代表持续使用时长。")}</p>
    {selected&&<div className="section-heading"><button className="button" onClick={reset}><ArrowLeft size={15}/>{moteText("返回分组")}</button><div><h2>{selected.appName||moteText("应用未知")}</h2><p>{dateTime(selected.firstAt)} — {dateTime(selected.capturedAt)}</p></div></div>}
    {error&&<div role="alert" className="error-banner">{error}<button className="button" onClick={()=>{reset();setRefresh(n=>n+1);}}>{moteText("重新读取")}</button></div>}
    <p role="status">{loading?moteText("正在读取…"):moteText("{0}{1} 条记录 · 第 {2} 页", selected?'':moteText("{0} 个{1} · ", groupCount, mode==='sessions'?' Session':moteText("相册")), total, cursors.length)}</p>
    {!loading&&!error&&!items.length&&<div className="panel workspace-empty"><Clock3/><p>{moteText("这一天还没有截图记录。")}</p></div>}
    <div className={selected?'session-image-grid':'session-list'}>{items.map(item=>'count' in item?<button className="session-card" key={item.id} onClick={()=>{setSelected(item);setCursors([undefined]);}}><span className="session-symbol"><Layers3 size={20}/></span><span><strong>{item.appName||moteText("应用未知")}</strong><small>{devices.find(d=>d.deviceId===item.deviceId)?.deviceName||item.deviceId}</small><span>{dateTime(item.firstAt)} — {dateTime(item.capturedAt)}</span></span><span className="session-count"><strong>{item.count}{' '}{moteText("条")}</strong><small>{item.imageCount}{' '}{moteText("张图片")}</small></span><ArrowRight size={16}/></button>:<SessionImage key={item.id} api={api} item={item} onOpen={onOpen}/>)}</div>
    <div className="form-footer"><button className="button" disabled={loading||cursors.length===1} onClick={()=>setCursors(c=>c.slice(0,-1))}>{moteText("上一页")}</button><button className="button" disabled={loading||!next} onClick={()=>setCursors(c=>[...c,next!])}>{moteText("下一页")}</button></div>
  </section>;
}
function SessionImage({api,item,onOpen}:{api:Api;item:ImageRef;onOpen:(id:string)=>void}){
  const [url,setUrl]=useState(''),[failed,setFailed]=useState(false);
  useEffect(()=>{if(!item.hasImage)return;let disposed=false,owned='';const controller=new AbortController();
    void api.raw(`/api/capture-browser/${item.id}/image?thumbnail=1`,{signal:controller.signal}).then(response=>response.blob()).then(blob=>{if(!disposed){owned=URL.createObjectURL(blob);setUrl(owned);}}).catch(()=>{if(!disposed)setFailed(true);});
    return()=>{disposed=true;controller.abort();if(owned)URL.revokeObjectURL(owned);};},[api,item.id,item.hasImage]);
  return <button className="session-image" onClick={()=>onOpen(item.id)}>{url?<img src={url} alt={moteText("{0} 截图", item.appName)} loading="lazy"/>:<span>{failed?moteText("预览加载失败，点击查看详情"):item.hasImage?moteText("加载预览…"):moteText("无图片 · 查看采样记录")}</span>}<small>{dateTime(item.capturedAt)}</small></button>;
}
