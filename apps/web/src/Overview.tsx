import { moteText } from '@mote/shared/i18n';
import { ArrowRight, Database, Layers3, Link2, MessageSquare, Monitor, Sparkles } from 'lucide-react';
import { answerPreview } from './AnswerMarkdown';
import { type Activity,type Answer,type Api,type Capture,type Device,type Range,type Status } from './api';
import { type Page } from './navigation';
import { CaptureCard } from './shell-components';
import { FeatureHome } from './features/home';
export function Overview({api,status,devices,recent,insights,onPage,onOpen}: {api:Api;status:Status;devices:Device[];activity:Activity;recent:Capture[];insights:Answer[];onPage:(page:Page)=>void;onOpen:(id:string)=>void;range:Range;onMedia:()=>void}) {
 const firstDevice=devices.length===0;
 const needsSetup=firstDevice&&status.storage.captures===0;
 return <div className="home-page library-home">
  <div className="greeting"><div><div className="eyebrow">{moteText('个人资料库')}</div><h1>{moteText('你的记录，随时找回。')}</h1><p>{moteText('浏览已汇集的资料，或带着问题回看自己的经历。')}</p></div><button className="button primary" onClick={()=>onPage(firstDevice?'devices':'archive')}>{firstDevice?<Monitor size={17}/>:<Database size={17}/>} {firstDevice?moteText('连接设备'):moteText('打开资料库')}<ArrowRight size={16}/></button></div>
  {firstDevice&&<section className="panel first-device"><div className="device-icon"><Link2 size={23}/></div><div><h2>{moteText('从一台设备开始')}</h2><p>{moteText('连接手机或电脑，把你选择的记录汇集到这里。也可以先导入文件。')}</p><div className="first-device-actions"><button className="text-button" onClick={()=>onPage('imports')}>{moteText('导入文件')}</button></div></div></section>}
  {!needsSetup&&<div className="home-library-layout"><section className="recent-section"><div className="section-heading"><div><h2>{moteText('最近同步的记录')}</h2><p>{moteText('先看内容，再回到完整资料与来源。')}</p></div><button className="text-button" onClick={()=>onPage('archive')}>{moteText('查看全部')}<ArrowRight size={15}/></button></div>{recent.length?<div className="capture-grid">{recent.slice(0,4).map(capture=><CaptureCard key={capture.id} capture={capture} api={api} onOpen={onOpen}/>)}</div>:<div className="home-empty"><Layers3 size={23}/><p>{moteText('这里还没有近期屏幕记录。文件、随手记和其他资料可在资料库里查看。')}</p></div>}</section>
  <aside className="home-side"><section className="panel home-question"><MessageSquare size={24}/><h2>{moteText('从资料里找答案')}</h2><p>{moteText('用自己的问题开始，回答会附上可回看的资料来源。')}</p><button className="button" onClick={()=>onPage('ask')}>{moteText('问一问')}<ArrowRight size={16}/></button></section><button className="home-device-link" onClick={()=>onPage('devices')}><Monitor size={20}/><span><strong>{moteText('{0} 台已知设备',devices.length)}</strong><small>{moteText('查看上次上报的采集与同步状态')}</small></span><ArrowRight size={16}/></button></aside></div>}
  {insights[0]&&<button className="home-insight" onClick={()=>onPage('insights')}><Sparkles size={21}/><div><strong>{moteText('你最近的洞察')}</strong><p>{answerPreview(insights[0],125)}</p><small>{insights[0].citations.length}{' '}{moteText('条证据来源')}</small></div><ArrowRight size={18}/></button>}
  {!needsSetup&&<div className="home-secondary"><button className="text-button" onClick={()=>onPage('actions')}>{moteText('查看行动建议')}<ArrowRight size={15}/></button>{!status.agent.configured&&<button className="text-button" onClick={()=>onPage('settings')}>{moteText('配置问答模型')}<ArrowRight size={15}/></button>}</div>}
  {!needsSetup&&<details className="home-extensions"><summary>{moteText('更多上下文视图')}</summary><FeatureHome api={api} onPage={onPage}/></details>}
 </div>;
}
