import {useEffect,useState} from 'react';
import {ArrowRight,Headphones,Info,LoaderCircle,LockKeyhole} from 'lucide-react';
import type {MediaMetadata,MediaSession} from '@mote/shared';
import {type Api,type Range,type MediaActivity,queryString,dateTime,errorMessage} from './api';
import {mediaStatus,playbackLabels,playbackTypeLabels,visibilityLabels,mediaDuration as duration} from './media-presentation';

export function MediaSnapshot({media,observedAt,screenLocked,collection,compact=false}: {
  media?:MediaMetadata;observedAt?:string;screenLocked?:boolean;collection?:string;compact?:boolean;
}) {
  const state=mediaStatus(media);
  const mediaObservedAt=media?.observedAt??observedAt;
  return <section className={`media-snapshot ${compact?'compact':''}`} aria-label="上报的媒体状态">
    <div className="media-snapshot-heading"><Headphones size={17}/><strong>{compact?'最近上报的媒体状态':'当时的媒体状态'}</strong><span className={`badge ${state.tone}`}>{state.label}</span></div>
    <p className="media-observation-time">{mediaObservedAt?`媒体观察于 ${dateTime(mediaObservedAt)}`:'媒体观察时间未上报'} · 当时的状态不代表现在。</p>
    <p className="media-observation-time">{mediaObservedAt!==observedAt&&observedAt?`${dateTime(observedAt)} 设备上报：`:''}{screenLocked===undefined?'锁屏状态未知':screenLocked?'屏幕已锁定':'屏幕未锁定'}</p>
    {media?.sessions.map(session=><MediaSessionDetail key={session.sessionId} session={session} compact={compact} collection={collection}/>)}
    {!media?.sessions.length&&<p className="field-note">{state.description}</p>}
    {collection==='activity'&&<p className="field-note">仅保留应用与播放状态；标题、作者、专辑等内容不采集。</p>}
    {!compact&&<p className="field-note">这是应用公开的状态。媒体采集在客户端单独开启；通知使用权用于发现媒体会话，不保存通知正文或音频。音乐、有声书等内容类型由分析时结合证据判断。</p>}
  </section>;
}
function MediaSessionDetail({session,compact,collection}:{session:MediaSession;compact:boolean;collection?:string}) {
  const content=collection!=='activity';
  return <article className="media-session">
    <div className="media-session-top"><strong>{session.appName}</strong><span className={`badge ${session.playbackState==='playing'?'green':'muted'}`}>{playbackLabels[session.playbackState]}</span></div>
    {content&&session.title&&<p className="media-session-title">{session.title}</p>}
    {content&&(session.artist||session.displaySubtitle)&&<p className="media-session-subtitle">{[session.artist,session.displaySubtitle].filter(Boolean).join(' · ')}</p>}
    <div className="media-session-context"><span>{visibilityLabels[session.appVisibility]}</span><span>{playbackTypeLabels[session.playbackType]}</span></div>
    {!compact&&<dl>
      <div><dt>播放应用</dt><dd>{session.appId}</dd></div>
      {content&&session.album&&<div><dt>专辑 / 所属内容</dt><dd>{session.album}</dd></div>}
      {session.positionMs!==undefined&&<div><dt>上报的播放进度</dt><dd>{duration(session.positionMs)}</dd></div>}
      {session.durationMs!==undefined&&<div><dt>媒体总长度</dt><dd>{duration(session.durationMs)}</dd></div>}
      {session.playbackSpeed!==undefined&&<div><dt>播放速度</dt><dd>{session.playbackSpeed}×</dd></div>}
    </dl>}
  </article>;
}

export function MediaActivitySummary({api,range,onOpen,compact=false,onExpand}:{api:Api;range:Range;onOpen:(id:string)=>void;compact?:boolean;onExpand?:()=>void}) {
  const [value,setValue]=useState<MediaActivity|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  const path=`/api/media-activity${queryString(range)}`;
  useEffect(()=>{
    const controller=new AbortController();setValue(null);setError('');
    void api.request<MediaActivity>(path,{signal:controller.signal}).then(result=>{if(!controller.signal.aborted)setValue(result);}).catch(reason=>{if(!controller.signal.aborted)setError(errorMessage(reason));});
    return ()=>controller.abort();
  },[api,path,revision]);
  return <section className={`panel media-activity-panel ${compact?'compact':''}`} aria-label="媒体播放统计">
    <div className="section-heading"><div><h2><Headphones size={19}/>媒体播放</h2><p>锁屏与切换应用后，也可以留下播放线索。</p></div>{onExpand&&<button className="text-button" onClick={onExpand}>查看分布<ArrowRight size={15}/></button>}</div>
    {error?<div className="notice error" role="alert"><Info size={16}/><span>{error}</span><button className="text-button" onClick={()=>setRevision(v=>v+1)}>重试</button></div>:!value?<span className="loading"><LoaderCircle size={16} className="spin"/>正在读取媒体记录…</span>:<MediaActivityContent value={value} onOpen={onOpen} compact={compact}/>}
  </section>;
}
export function MediaActivityContent({value,onOpen,compact=false}:{value:MediaActivity;onOpen:(id:string)=>void;compact?:boolean}) {
  if (!value.observations) return <div className="media-empty"><Headphones size={25}/><div><strong>这段时间还没有媒体观察记录</strong><p>在 Android 客户端开启媒体采集并授权，记录同步后会出现在这里。没有记录不代表没有播放。</p></div></div>;
  return <>
    <div className="media-stats"><div><span>媒体播放采样时长</span><strong>{duration(value.totalDurationMs)}</strong><small>{value.observations.toLocaleString()} 次状态观察</small></div><div><span><LockKeyhole size={13}/>其中锁屏播放</span><strong>{duration(value.screenLock.locked)}</strong><small>锁屏状态未知 {duration(value.screenLock.unknown)}</small></div><div><span>其中后台播放</span><strong>{duration(value.visibility.background)}</strong><small>前后台未知 {duration(value.visibility.unknown)}</small></div></div>
    {value.availability&&(value.availability.disabled+value.availability.permission_required+value.availability.unavailable)>0&&<p className="measurement-note media-availability">{value.availability.permission_required} 次等待授权 · {value.availability.disabled} 次采集关闭 · {value.availability.unavailable} 次状态不可用。这些观察无法确定是否有播放。</p>}
    {value.apps.length>0&&<div className="media-app-list">{value.apps.slice(0,compact?3:undefined).map((app,index)=><div className="media-app-row" key={app.appId}><span className={`app-dot dot-${index%5}`}/><div><strong>{app.appName}</strong>{!compact&&<small>{app.appId}</small>}</div><span>{duration(app.durationMs)}</span>{app.evidenceIds[0]&&<button className="text-button" onClick={()=>onOpen(app.evidenceIds[0])} aria-label={`查看 ${app.appName} 的媒体证据`}>查看记录<ArrowRight size={13}/></button>}</div>)}</div>}
    {!compact&&<div className="media-breakdowns"><div><h3>应用位置</h3><p>前台 {duration(value.visibility.foreground)} · 后台 {duration(value.visibility.background)} · 未知 {duration(value.visibility.unknown)}</p></div><div><h3>播放位置</h3><p>本机 {duration(value.playbackType.local)} · 远程 {duration(value.playbackType.remote)} · 未知 {duration(value.playbackType.unknown)}</p></div><div><h3>屏幕状态</h3><p>锁定 {duration(value.screenLock.locked)} · 未锁定 {duration(value.screenLock.unlocked)} · 未知 {duration(value.screenLock.unknown)}</p></div></div>}
    {!compact&&value.devices.length>1&&<div className="media-device-list"><h3>按设备查看</h3>{value.devices.map(device=><p key={device.deviceId}><strong>{device.deviceName}</strong><span>{duration(device.durationMs)}</span></p>)}</div>}
    <p className="measurement-note">媒体播放与前台应用使用分别计时，可能同时发生，不应相加。只累计独立媒体记录的播放采样区间；同一设备重叠区间合并，多台设备分别累计。应用或状态分组可能重叠。</p>
    {!compact&&<p className="measurement-note">截图附带的媒体状态不重复计时。暂停、缓冲和观察空隙不补齐；播放进度或媒体总长度不等于收听时长，远程播放也不代表手机发声。</p>}
  </>;
}
