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
    <div className="filter-bar"><label>日期<input aria-label="Session 日期" type="date" required value={day} onChange={e=>{if(e.target.value){setDay(e.target.value);reset();}}}/></label><label>设备<select value={device} onChange={e=>{setDevice(e.target.value);reset();}}><option value="">全部设备</option>{devices.map(d=><option key={d.deviceId} value={d.deviceId}>{d.deviceName}</option>)}</select></label><label>聚合方式<select aria-label="聚合方式" value={mode} onChange={e=>{setMode(e.target.value);reset();}}><option value="sessions">按 Session</option><option value="albums">按 App · 15 分钟</option></select></label><button className="button" onClick={()=>{reset();setRefresh(n=>n+1);}} disabled={loading}><RefreshCw size={15}/>刷新</button></div>
    <p className="measurement-note">{mode==='sessions'?'同一设备、同一应用的连续截图归为一段；切换应用或相邻采样超过 5 分钟即分段。范围仅限所选日期，本机与中央按各自保留的记录分组。':'每 15 分钟按设备与应用汇集截图。'} 起止时间表示观察范围，不代表持续使用时长。</p>
    {selected&&<div className="section-heading"><button className="button" onClick={reset}><ArrowLeft size={15}/>返回分组</button><div><h2>{selected.appName||'应用未知'}</h2><p>{dateTime(selected.firstAt)} — {dateTime(selected.capturedAt)}</p></div></div>}
    {error&&<div role="alert" className="error-banner">{error}<button className="button" onClick={()=>{reset();setRefresh(n=>n+1);}}>重新读取</button></div>}
    <p role="status">{loading?'正在读取…':`${selected?'':`${groupCount} 个${mode==='sessions'?' Session':'相册'} · `}${total} 条记录 · 第 ${cursors.length} 页`}</p>
    {!loading&&!error&&!items.length&&<div className="panel workspace-empty"><Clock3/><p>这一天还没有截图记录。</p></div>}
    <div className={selected?'session-image-grid':'session-list'}>{items.map(item=>'count' in item?<button className="session-card" key={item.id} onClick={()=>{setSelected(item);setCursors([undefined]);}}><span className="session-symbol"><Layers3 size={20}/></span><span><strong>{item.appName||'应用未知'}</strong><small>{devices.find(d=>d.deviceId===item.deviceId)?.deviceName||item.deviceId}</small><span>{dateTime(item.firstAt)} — {dateTime(item.capturedAt)}</span></span><span className="session-count"><strong>{item.count} 条</strong><small>{item.imageCount} 张图片</small></span><ArrowRight size={16}/></button>:<SessionImage key={item.id} api={api} item={item} onOpen={onOpen}/>)}</div>
    <div className="form-footer"><button className="button" disabled={loading||cursors.length===1} onClick={()=>setCursors(c=>c.slice(0,-1))}>上一页</button><button className="button" disabled={loading||!next} onClick={()=>setCursors(c=>[...c,next!])}>下一页</button></div>
  </section>;
}
function SessionImage({api,item,onOpen}:{api:Api;item:ImageRef;onOpen:(id:string)=>void}){
  const [url,setUrl]=useState(''),[failed,setFailed]=useState(false);
  useEffect(()=>{if(!item.hasImage)return;let disposed=false,owned='';const controller=new AbortController();
    void api.raw(`/api/capture-browser/${item.id}/image?thumbnail=1`,{signal:controller.signal}).then(response=>response.blob()).then(blob=>{if(!disposed){owned=URL.createObjectURL(blob);setUrl(owned);}}).catch(()=>{if(!disposed)setFailed(true);});
    return()=>{disposed=true;controller.abort();if(owned)URL.revokeObjectURL(owned);};},[api,item.id,item.hasImage]);
  return <button className="session-image" onClick={()=>onOpen(item.id)}>{url?<img src={url} alt={`${item.appName} 截图`} loading="lazy"/>:<span>{failed?'预览加载失败，点击查看详情':item.hasImage?'加载预览…':'无图片 · 查看采样记录'}</span>}<small>{dateTime(item.capturedAt)}</small></button>;
}
