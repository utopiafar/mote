import {formatEvidenceRef} from '@mote/shared';
import { moteText } from '@mote/shared/i18n';
import {useEffect,useId,useState} from 'react';
import {ArrowLeft,ArrowRight,Clock3,Layers3,RefreshCw} from 'lucide-react';
import type {CaptureSession} from '@mote/shared';
import {type Api,type Device,dateTime,errorMessage,queryString} from '../../api';
import {captureDateRange,localDateInput} from '../../capture-presentation';
import {useResource} from '../../useResource';

type ImageRef={id:string;capturedAt:string;hasImage:boolean;appName:string};
export function CaptureSessions({api,devices,onOpen,revision}:{api:Api;devices:Device[];onOpen:(id:string)=>void;revision:number}){
  const tabsId=useId();
  const [day,setDay]=useState(()=>localDateInput(new Date())),[device,setDevice]=useState(''),[mode,setMode]=useState('sessions');
  const [storedSelected,setSelected]=useState<CaptureSession|null>(null),[owner,setOwner]=useState(api);
  const selected=owner===api?storedSelected:null,deviceValue=owner===api?device:'';
  const [storedCursors,setCursors]=useState<(string|undefined)[]>([undefined]),[refresh,setRefresh]=useState(0);
  const cursors=owner===api?storedCursors:[undefined];
  const reset=()=>{setSelected(null);setCursors([undefined]);};
  useEffect(()=>{setOwner(api);setSelected(null);setCursors([undefined]);setDevice('');},[api]);
  const range=captureDateRange(day,day),params={...range,...(deviceValue?{deviceId:deviceValue}:{}),limit:20,cursor:cursors.at(-1)};
  const path=mode==='sessions'?'sessions':selected?'album-images':'albums';
  const scope=selected?(mode==='sessions'?{...params,deviceId:selected.deviceId,sessionId:selected.id}:{...params,deviceId:selected.deviceId,appId:selected.appId,after:selected.after,before:selected.before}):params;
  const page=useResource<{items:(CaptureSession|ImageRef)[];totalCount:number;sessionCount?:number;albumCount?:number;nextCursor:string|null}>(api,`/api/capture-browser/${path}${queryString({},scope)}`,undefined,`${revision}:${refresh}`);
  const items=page.data?.items??[],total=page.data?.totalCount??0,groupCount=page.data?.sessionCount??page.data?.albumCount??0,next=page.data?.nextCursor??null,loading=page.loading,error=page.error?errorMessage(page.error):'',initialLoading=loading&&!page.data;
  return <section className="capture-sessions special-capture-sessions">
    {!selected&&<h2 className="special-material-heading">{moteText("截图片段")}</h2>}
    <div hidden={Boolean(selected)}>
    <div className="filter-bar capture-session-filters"><label>{moteText("日期")}<input aria-label={moteText("Session 日期")} type="date" required value={day} onChange={e=>{if(e.target.value){setDay(e.target.value);reset();}}}/></label><label>{moteText("设备")}<select value={deviceValue} onChange={e=>{setDevice(e.target.value);reset();}}><option value="">{moteText("全部设备")}</option>{devices.map(d=><option key={d.deviceId} value={d.deviceId}>{d.deviceName}</option>)}</select></label><button className="button" onClick={()=>{reset();setRefresh(n=>n+1);}} disabled={loading}><RefreshCw size={15}/>{moteText("刷新")}</button></div>
    <nav className="capture-group-tabs" role="tablist" aria-label={moteText("聚合方式")}>{[['sessions',moteText('按 Session')],['albums',moteText('按应用 · 15 分钟')]].map(([id,label])=><button key={id} id={tabsId+id} data-mode={id} type="button" role="tab" aria-controls={tabsId+"panel"} tabIndex={mode===id?0:-1} aria-selected={mode===id} onKeyDown={event=>{if(["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){event.preventDefault();const next=event.key==="Home"?"sessions":event.key==="End"?"albums":mode==="sessions"?"albums":"sessions";setMode(next);reset();document.getElementById(tabsId+next)?.focus();}}} onClick={()=>{setMode(id);reset();}}>{label}</button>)}</nav>
    </div>
    {selected&&<div className="section-heading"><button className="button" onClick={reset}><ArrowLeft size={15}/>{moteText("返回分组")}</button><div><h2>{selected.appName||moteText("应用未知")}</h2><p>{dateTime(selected.firstAt)} — {dateTime(selected.capturedAt)}</p></div></div>}
    {error&&<div role="alert" className="error-banner">{error}<button className="button" onClick={()=>{reset();setRefresh(n=>n+1);}}>{moteText("重新读取")}</button></div>}
    <p role="status">{initialLoading?moteText("正在读取…"):moteText("{0}{1} 条记录 · 第 {2} 页", selected?'':moteText(mode==='sessions'?"会话：{0} · ":"相册：{0} · ", groupCount), total, cursors.length)}</p>
    {!initialLoading&&!error&&!items.length&&<div className="panel workspace-empty"><Clock3/><p>{moteText("这一天还没有截图记录。")}</p></div>}
    <div id={tabsId+'panel'} role="tabpanel" aria-labelledby={tabsId+mode} className={selected?'session-image-grid':'session-list'}>{items.map(item=>'count' in item?<button className="session-card" key={item.id} onClick={()=>{setSelected(item);setCursors([undefined]);}}><span className="session-symbol"><Layers3 size={20}/></span><span><strong>{item.appName||moteText("应用未知")}</strong><small>{devices.find(d=>d.deviceId===item.deviceId)?.deviceName||item.deviceId}</small><span>{dateTime(item.firstAt)} — {dateTime(item.capturedAt)}</span></span><span className="session-count"><strong>{item.count}{' '}{moteText("条")}</strong><small>{item.imageCount}{' '}{moteText("张图片")}</small></span><ArrowRight size={16}/></button>:<SessionImage key={item.id} api={api} item={item} onOpen={onOpen}/>)}</div>
    {!selected&&<><p className="measurement-note">{moteText("起止时间表示观察范围，不代表持续使用时长。")}</p><details className="special-measurement"><summary>{moteText('技术详情')}</summary><p>{mode==='sessions'?moteText("同一设备、同一应用的连续截图归为一段；切换应用或相邻采样超过 5 分钟即分段。范围仅限所选日期，本机与中央按各自保留的记录分组。"):moteText("每 15 分钟按设备与应用汇集截图。")}</p></details></>}
    <div className="form-footer"><button className="button" disabled={loading||cursors.length===1} onClick={()=>setCursors(c=>c.slice(0,-1))}>{moteText("上一页")}</button><button className="button" disabled={loading||!next} onClick={()=>setCursors(c=>[...c,next!])}>{moteText("下一页")}</button></div>
  </section>;
}
export function SessionImage({api,item,onOpen}:{api:Api;item:ImageRef;onOpen:(id:string)=>void}){
  const [image,setImage]=useState<{owner:Api;id:string;url?:string;failed?:boolean}>();
  const current=item.hasImage&&image?.owner===api&&image.id===item.id?image:undefined,url=current?.url,failed=current?.failed;
  useEffect(()=>{if(!item.hasImage)return;let disposed=false,owned='';const controller=new AbortController();
    void api.raw(`/api/capture-browser/${item.id}/image?thumbnail=1`,{signal:controller.signal}).then(response=>response.blob()).then(blob=>{if(!disposed){owned=URL.createObjectURL(blob);setImage({owner:api,id:item.id,url:owned});}}).catch(()=>{if(!disposed)setImage({owner:api,id:item.id,failed:true});});
    return()=>{disposed=true;controller.abort();if(owned)URL.revokeObjectURL(owned);};},[api,item.id,item.hasImage]);
  return <button className="session-image" onClick={()=>onOpen(formatEvidenceRef('capture',item.id))}>{url?<img src={url} alt={moteText("{0} 截图", item.appName)} loading="lazy"/>:<span>{failed?moteText("预览加载失败，点击查看详情"):item.hasImage?moteText("加载预览…"):moteText("无图片 · 查看采样记录")}</span>}<small>{dateTime(item.capturedAt)}</small></button>;
}
