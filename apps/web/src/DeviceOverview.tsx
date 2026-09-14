import {ArrowLeft, ArrowRight, CheckCircle2, Clock3, HardDrive, Info, Monitor, QrCode, Smartphone} from 'lucide-react';
import {ago,dateTime,deviceState,deviceLabels,type Device} from './api';
import {Metadata} from './Metadata';
import {MediaSnapshot} from './Media';
const modes={realtime:'实时同步',interval:'定时同步',batch:'批量同步',manual:'手动同步'};
const states={unconfigured:'尚未配置节点',idle:'等待新记录',waiting:'等待同步条件',uploading:'正在上传',error:'同步需要处理',manual:'等待手动同步'};
export function DeviceOverview({devices,onConnect}:{devices:Device[];onConnect:()=>void}) {
 return <div className="device-overview"><div className="page-heading split-heading"><div><div className="eyebrow">记录各自发生，资料在此汇合</div><h1>你的设备</h1><p>采集在设备本机运行，同步按每台设备的偏好进行。</p></div><button className="button primary" onClick={onConnect}><QrCode size={17}/>扫码连接设备</button></div>
 <div className="device-observation-note"><Clock3 size={18}/><p>这里显示设备最近一次上报。较久未联系可能是定时、手动同步或网络变化，不能据此判断本机是否正在采集。</p></div>
 {!devices.length?<section className="panel device-empty"><Monitor size={34}/><h2>从你的第一台设备开始</h2><p>生成一次性邀请，在手机或 Mac 的连接设置中确认。客户端也可以先在本机记录，稍后再连接。</p><button className="button primary" onClick={onConnect}>生成设备二维码<ArrowRight size={16}/></button></section>:<div className="device-grid">{devices.map(device=>{const fresh=deviceState(device)!=='stale',Icon=device.platform==='android'?Smartphone:device.platform==='import'?HardDrive:Monitor;return <article className="panel device-card" key={device.deviceId}>
  <div className="device-top"><div className="device-icon"><Icon size={24}/></div><span className={`badge ${fresh?'green':'muted'}`}><span className="dot"/>{fresh?'刚刚联系':'上次上报'}</span></div><h2>{device.deviceName}</h2><p className="device-platform">{({macos:'macOS',android:'Android',import:'导入来源',windows:'Windows',linux:'Linux'} as Record<string,string>)[device.platform]||device.platform}</p>
  <dl><div><dt>最后联系</dt><dd title={dateTime(device.lastSeenAt)}>{ago(device.lastSeenAt)}</dd></div><div><dt>上报的采集状态</dt><dd>{deviceLabels[device.status]||device.status}</dd></div><div><dt>最近采集</dt><dd>{ago(device.lastCaptureAt)}</dd></div><div><dt>上报的待同步记录</dt><dd>{(device.sync?.pendingRecords??device.queueDepth).toLocaleString()} 条</dd></div></dl>
  {device.sync?<div className="device-sync-summary"><div><CheckCircle2 size={16}/><strong>{modes[device.sync.mode]}</strong><span>{states[device.sync.state]}</span></div><p>{device.sync.mode==='interval'?`约每 ${device.sync.intervalMinutes} 分钟检查一次` : device.sync.mode==='batch'?`累计 ${device.sync.batchSize} 条，或最长等待 ${device.sync.intervalMinutes} 分钟后同步`:device.sync.mode==='manual'?'在客户端点击同步后发送记录':'有新记录时尝试同步'}</p>{device.sync.lastUploadAt&&<p>上次上传 · {ago(device.sync.lastUploadAt)}</p>}{device.sync.nextUploadAt&&<p>计划检查 · {dateTime(device.sync.nextUploadAt)}<small>系统调度、网络与电量条件可能推迟。</small></p>}</div>:<p className="fine-print">此客户端尚未上报同步策略。采集与同步偏好请在客户端设置。</p>}
  {(device.platform==='android'||device.metadata?.media)&&<MediaSnapshot media={device.metadata?.media} observedAt={device.metadata?.observedAt} screenLocked={device.metadata?.state?.screenLocked} compact/>}
  {device.error&&<div className="device-note warn"><Info size={15}/><span>上次报告：{device.error}</span></div>}<details className="device-details"><summary>设备详情与元数据</summary><code className="record-id">{device.deviceId}</code><Metadata metadata={device.metadata}/></details>
 </article>;})}</div>}
 <button className="button subtle manage-authorizations" onClick={onConnect}>管理连接授权<ArrowRight size={15}/></button></div>;
}
export function PageBack({title,onBack}:{title:string;onBack:()=>void}) {return <button className="back-link" onClick={onBack}><ArrowLeft size={16}/>{title}</button>;}
