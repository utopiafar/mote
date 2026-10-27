import { moteText } from '@mote/shared/i18n';
import { ArrowRight, Database, Link2, Bot, Activity as ActivityIcon, Sparkles } from 'lucide-react';
import { answerPreview } from './AnswerMarkdown';
import { type Activity, type Answer, type Api, type Capture, type Device, type Range, type Status } from './api';
import { type Page } from './navigation';
import { CaptureCard } from './shell-components';
import { FeatureHome } from './features/home';
import { useResource } from './useResource';
import {errorMessage} from './api';
type FirstDeviceData={state:'waiting'|'unverified'|'received_unavailable'|'ready';originalAvailable:boolean;checkedDevices:number;checkedRecords:number;windowLimited:boolean;candidate?:{id:string;deviceId:string;deviceName:string;source:string;capturedAt:string;receivedAt:string}};
export function Overview({ api, status, devices, recent, insights, onPage, onOpen }: {
 api:Api;status:Status;devices:Device[];activity:Activity;recent:Capture[];insights:Answer[];
 onPage:(page:Page)=>void;onOpen:(id:string)=>void;range:Range;onMedia:()=>void;
}) {
 const sources=useResource<{items:{id:string;status?:{state:string}}[]}>(api,'/api/sources');
 const connections=useResource<{items:{scope:string;revokedAt?:string;expiresAt?:string;lastUsedAt?:string}[]}>(api,'/api/connections');
 const materials=useResource<{items:unknown[]}>(api,'/api/library/catalog?limit=1');
 const firstData=useResource<FirstDeviceData>(api,'/api/devices/first-data',undefined,status.storage?.captures);
 const checked=!firstData.loading&&!firstData.error?firstData.data:undefined;
 const retained=!firstData.error?firstData.data:undefined;
 const sample=retained?.candidate;
 const sourceReady=Boolean(checked?.checkedDevices);
 const collected=!!materials.data?.items.length;
 const discovery=insights.find(item=>item.citations.length>0);
 const aiReady=connections.data?.items.some(item=>item.scope==='mcp-read'&&!item.revokedAt&&(!item.expiresAt||Date.parse(item.expiresAt)>Date.now()));
 const complete=checked?.state==='ready'&&checked.originalAvailable&&Boolean(sample);
 const issues=sources.data?.items.filter(item=>['error','permission_required'].includes(item.status?.state??''))??[];
 return <div className="home-page central-overview">
  <div className="page-heading"><h1>{moteText('首页')}</h1></div>
  <section className={"panel central-onboarding"+(complete?" compact":"")} aria-label={moteText('开始使用')} data-onboarding-state={firstData.error?'error':firstData.loading?'loading':checked?.state??'unverified'}>
   {!complete&&<div className="central-first-steps">
    {[{ready:sourceReady,label:moteText('连接设备'),page:'deviceConnections',icon:Link2},{ready:Boolean(sample),label:moteText('中央已接收'),page:'devices',icon:Database},{ready:false,label:moteText('查看原文'),page:'archive',icon:Database}].map((step,index)=><button key={step.page} aria-label={step.label} className={step.ready?'completed':''} onClick={()=>step.page==='archive'&&sample?onOpen('capture:'+sample.id):onPage(step.page)}><span className="step-number">{step.ready?'✓':index+1}</span><step.icon size={20}/><strong>{step.label}</strong><ArrowRight size={16}/></button>)}
   </div>}
   <div className="central-first-data">
    {sample&&<div className="central-first-original" key={sample.id}>
     <p><strong>{moteText('中央已接收')}</strong>{' · '}{sample.deviceName}{' · '}<time dateTime={sample.receivedAt}>{new Date(sample.receivedAt).toLocaleString()}</time></p>
     <p>{moteText(firstData.loading?'尚未验证':complete?'原件已保留':'原件不可用')}{retained?.originalAvailable&&<> · <button className="text-button" onClick={()=>onOpen('capture:'+sample.id)}>{moteText('查看原文')}<ArrowRight size={15}/></button></>}</p>
    </div>}
    {firstData.loading?<p role="status">{moteText('正在读取采集记录…')}</p>:firstData.error?<p className="error" role="alert">{errorMessage(firstData.error)}</p>:!sample&&<p>{moteText(checked?.state==='waiting'?'准备好接住第一份记录':'最近记录')}{checked?.state!=='waiting'&&<> · {moteText('尚未验证')}</>}</p>}
    <details className="central-first-actions" open={!complete}><summary>{moteText('更多')}</summary><div className="button-row"><button className="button subtle" onClick={()=>firstData.refresh()} disabled={firstData.loading}>{moteText('刷新')}</button><button className="text-button" onClick={()=>onPage('archive')}>{moteText('打开资料库')}</button></div></details>
   </div>
  </section>
  <section className="central-status-grid" aria-label={moteText('运行状态')}>
   <button className="panel" onClick={()=>onPage('sources')}><Link2 size={20}/><strong>{moteText('来源')}</strong><span>{sources.data?(sources.data.items.length+devices.length):'—'}</span>{issues.length>0&&<small className="attention">{moteText('需要处理')} · {issues.length}</small>}</button>
   <button className="panel" onClick={()=>onPage('activity')}><ActivityIcon size={20}/><strong>{moteText('Mote 后台工作')}</strong><span>{moteText('查看进展')}<ArrowRight size={15}/></span></button>
   <button className="panel" onClick={()=>onPage('connections')}><Bot size={20}/><strong>{moteText('AI 接入')}</strong><span>{connections.data?(aiReady?moteText('已授权'):moteText('未连接')):'—'}</span></button>
  </section>
  {issues.length>0&&<button className="notice central-issue" onClick={()=>onPage('sources')}>{moteText('来源需要处理')}<ArrowRight size={16}/></button>}
  {discovery&&<a className="home-insight" href={'#/library/insights?insight='+encodeURIComponent(discovery.runId)}><Sparkles size={21}/><div><strong>{moteText('你最近的洞察')}</strong><p>{answerPreview(discovery,125)}</p><small>{moteText('{0} 条证据',discovery.citations.length)}</small></div><ArrowRight size={18}/></a>}
  <section className="recent-section"><div className="section-heading"><h2>{moteText('最近同步的记录')}</h2><button className="text-button" onClick={()=>onPage('archive')}>{moteText('查看全部')}<ArrowRight size={15}/></button></div><div className="home-record-list">{recent.slice(0,4).map(capture=><CaptureCard compact key={capture.id} capture={capture} api={api} onOpen={onOpen}/>)}</div>{!recent.length&&<button className="button subtle" onClick={()=>onPage(collected?'archive':'imports')}>{moteText(collected?'打开资料库':'导入资料')}<ArrowRight size={15}/></button>}</section>
  <details className="home-extensions"><summary>{moteText('更多上下文视图')}</summary><FeatureHome api={api} onPage={onPage}/></details>
 </div>;
}
