import { getLocale,moteText } from '@mote/shared/i18n';
import {
ArrowRight,
Clock3,
FileText,
Layers3,
Link2,
MessageSquare,
Monitor,
Sparkles
} from "lucide-react";
import { answerPreview } from "./AnswerMarkdown";
import {
duration,
type Activity,
type Answer,
type Api,
type Capture,
type Device,
type Range,
type Status
} from "./api";
import { type Page } from './navigation';



import { CaptureCard } from './shell-components';
export function Overview({api,status,devices,activity,recent,insights,onPage,onOpen,range,onMedia}: {api:Api;status:Status;devices:Device[];activity:Activity;recent:Capture[];insights:Answer[];onPage:(page:Page)=>void;onOpen:(id:string)=>void;range:Range;onMedia:()=>void}) {
 return <div className="home-page">
  <div className="greeting"><div><div className="eyebrow">{moteText("你的个人上下文")}</div><h1>{moteText("今天，留下了什么？")}</h1><p>{moteText("记下的片刻，在需要时重新找到。")}</p></div><div className="greeting-mark" aria-hidden="true"><div/><div/><div/><span>m.</span></div></div>
  <div className="home-actions"><button className="home-action primary-action" onClick={()=>onPage('notes')}><FileText size={23}/><span><strong>{moteText("写一条随手记")}</strong><small>{moteText("留住此刻的想法")}</small></span><ArrowRight size={18}/></button><button className="home-action" onClick={()=>onPage('ask')}><MessageSquare size={23}/><span><strong>{moteText("从记录里找答案")}</strong><small>{moteText("带着来源，回看自己的经历")}</small></span><ArrowRight size={18}/></button></div>
  <div className="stats-grid compact-stats"><div className="stat"><span><Layers3 size={16}/>{moteText("前台应用与屏幕采样")}</span><strong>{activity.captures.toLocaleString(getLocale())}<em>{' '}{moteText("条")}</em></strong><small>{moteText("按所选时间统计，与媒体记录分别查看")}</small></div><div className="stat"><span><Clock3 size={16}/>{moteText("前台应用采样时长")}</span><strong>{duration(activity.totalDurationMs)}</strong><small>{moteText("采样区间累计，不等同专注时间")}</small></div><button className="stat stat-link" onClick={()=>onPage('devices')}><span><Monitor size={16}/>{moteText("已知设备")}</span><strong>{devices.length}<em>{moteText("台")}</em></strong><small>{moteText("查看最近联系与上报的同步状态 →")}</small></button></div>
  {!status.storage.captures&&<section className="panel first-record"><span className="preference-menu-icon"><Link2 size={23}/></span><div><h2>{moteText("准备好接住第一份记录")}</h2><p>{moteText("连接一台设备，或导入你选择的文件。采集范围与同步方式由你决定。")}</p></div><button className="button" onClick={()=>onPage('devices')}>{moteText("连接设备")}<ArrowRight size={15}/></button></section>}
  <section className="recent-section"><div className="section-heading"><div><h2>{moteText("最近留下的片刻")}</h2><p>{moteText("来自你选择的设备与来源")}</p></div><button className="text-button" onClick={()=>onPage('timeline')}>{moteText("全部记录")}<ArrowRight size={15}/></button></div>{recent.length?<div className="capture-grid">{recent.slice(0,4).map(capture=><CaptureCard key={capture.id} capture={capture} api={api} onOpen={onOpen}/>)}</div>:<div className="home-empty"><Layers3 size={23}/><p>{moteText("记录会在同步完成后出现在这里。也可以先写一条随手记。")}</p></div>}</section>
  {insights[0]&&<button className="home-insight" onClick={()=>onPage('insights')}><Sparkles size={21}/><div><strong>{moteText("你最近的洞察")}</strong><p>{answerPreview(insights[0],125)}</p><small>{insights[0].citations.length}{' '}{moteText("条证据来源")}</small></div><ArrowRight size={18}/></button>}
 </div>;
}
