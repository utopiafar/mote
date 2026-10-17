import {moteText} from '@mote/shared/i18n';
import {type Api,type Device,errorMessage} from './api';
import {useResource} from './useResource';
import {TurnUsage} from './Usage';
import type {UsageReceipt} from '@mote/shared';
import type {Page} from './navigation';
import {heartbeatSchema,type WorkActivityPage} from '@mote/shared';
import {DeviceOverview} from './DeviceOverview';
import {WorkProgress,WorkStateBadge} from './WorkProgress';
export function ScopedOverview({api,onPage}:{api:Api;onPage:(page:Page)=>void}){
 const statistics=useResource<{captures:number;materials:number;sources:number}>(api,'/api/data/statistics');
 const work=useResource<WorkActivityPage>(api,'/api/work-activity?limit=5');
 return <section><div className="page-heading"><h1>{moteText('今天')}</h1><p>{api.connection?.mode==='web'?api.connection.username:''}</p></div>{statistics.error!==undefined&&<p role="alert">{errorMessage(statistics.error)}</p>}
  {statistics.data&&<div className="feature-cards">{(['captures','materials','sources'] as const).map(key=><button className="panel panel-pad" key={key} onClick={()=>onPage(key==='sources'?'sources':'archive')}><h2>{key==='captures'?moteText('原始采集记录'):key==='materials'?moteText('正式资料'):moteText('来源与连接')}</h2><strong>{statistics.data![key]}</strong></button>)}</div>}
  <div className="processing-actions"><button className="button" onClick={()=>onPage('notes')}>{moteText('随手记')}</button><button className="button" onClick={()=>onPage('ask')}>{moteText('问一问')}</button><button className="button" onClick={()=>onPage('activity')}>{moteText('处理任务')}</button></div>
  <section className="recent-section"><div className="section-heading"><h2>{moteText('Mote 后台工作')}</h2><button className="text-button" onClick={()=>onPage('activity')}>{moteText('查看全部')}</button></div>{work.error!==undefined&&<p role="alert">{errorMessage(work.error)}</p>}<div className="activity-list">{work.data?.items.map(item=><a className="panel activity-card" key={item.id} href={'#/activity?'+new URLSearchParams({work:item.id})}><span className="activity-card-content"><span className="activity-card-heading"><strong>{item.goal}</strong><WorkStateBadge state={item.state}/></span><WorkProgress progress={item.progress} compact/></span></a>)}</div></section>
 </section>;
}
export function ScopedDevices({api,onConnect}:{api:Api;onConnect?:()=>void}){
 const read=useResource<{items:({id:string;name:string;platform:string}&Record<string,unknown>)[]}>(api,'/api/ingress/devices'),reported:Device[]=[],registered:{id:string;name:string;platform:string}[]=[];
 for(const row of read.data?.items??[]){const {id,name,lastSeenAt,...input}=row,heartbeat=heartbeatSchema.safeParse(input);if(!heartbeat.success||typeof lastSeenAt!=='string'||!Number.isFinite(Date.parse(lastSeenAt))){registered.push(row);continue;}const {lastCaptureAt,error,...value}=heartbeat.data;reported.push({...value,lastSeenAt,...lastCaptureAt?{lastCaptureAt}:{},...error?{error}:{}});}
 const navigate=(path:string)=>{window.location.hash=path;},connect=()=>onConnect?.();
 return <section>{read.error!==undefined&&<p role="alert">{errorMessage(read.error)}</p>}{read.data&&(reported.length>0||!registered.length)&&<DeviceOverview key={JSON.stringify(api.connection)} devices={reported} onConnect={connect} onAdd={()=>navigate('#/connections/add')} onSources={()=>navigate('#/connections')}/>}{registered.length>0&&<section className="panel panel-pad"><h2>{moteText('已知设备')}</h2><p>{moteText('尚未上报采集与同步状态。')}</p><ul className="connection-list">{registered.map(device=><li key={device.id}><strong>{device.name}</strong><p>{device.platform}</p></li>)}</ul>{onConnect&&<button className="button" onClick={connect}>{moteText('生成设备二维码')}</button>}</section>}</section>;
}
export function ScopedUsage({api}:{api:Api}){
 const read=useResource<{items:UsageReceipt[]}>(api,'/api/usage');
 return <section className="panel panel-pad"><h1>{moteText('用量与费用')}</h1>{read.error!==undefined&&<p role="alert">{errorMessage(read.error)}</p>}{read.data?.items.map((item,index)=><TurnUsage key={index} usage={item}/>)}</section>;
}
