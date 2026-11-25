import {useState, type ReactNode} from 'react';
import {ChevronRight, Image, MessageCircle, Wrench} from 'lucide-react';
import {formatEvidenceRef, type MeasuredCount, type UsageActivity, type UsageActivityKind, type UsageFailure, type UsageFailureKind, type UsageStatisticsPage} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {dateTime, errorMessage, type Api} from '../../api';
import {failureMessage} from '../../failure-message';
import {Loading} from '../../Loading';
import {AuthImage, ErrorNotice} from '../../shell-components';
import {useResource} from '../../useResource';
import {activityLabel, failureLabel, resultLabel, retryLabel, statisticDay, toolLabel} from './usage-statistics-labels';

function usePage<T>(api:Api,path:string,revision:number) {
  const [cursors,setCursors]=useState<string[]>([]);
  const cursor=cursors.at(-1);
  const resource=useResource<UsageStatisticsPage<T>>(api,cursor?`${path}&cursor=${encodeURIComponent(cursor)}`:path,undefined,revision);
  const next=resource.data?.nextCursor;
  return {...resource,previous:cursors.length?()=>setCursors(values=>values.slice(0,-1)):undefined,
    next:next?()=>setCursors(values=>[...values,next]):undefined};
}

function PageNavigation({previous,next,loading}:{previous?:()=>void;next?:()=>void;loading:boolean}) {
  if(!previous&&!next)return null;
  return <div className="statistics-pagination"><button className="button subtle" type="button" disabled={loading||!previous} onClick={previous}>{moteText('上一页')}</button>
    <button className="button subtle" type="button" disabled={loading||!next} onClick={next}>{moteText('下一页')}</button></div>;
}

function time(value:string) {return dateTime(value,{hour:'2-digit',minute:'2-digit'});}
function rowKey(item:UsageActivity) {return `${item.kind}:${item.id}`;}
function revealRecord(button:HTMLButtonElement) {
  if(window.matchMedia('(max-width: 750px)').matches)button.closest('.statistics-columns')?.querySelector('.statistics-record')?.scrollIntoView({block:'start'});
}

function ActivityPreview({api,item,onOpen}:{api:Api;item:UsageActivity;onOpen:(ref:string)=>void}) {
  return <aside className="statistics-panel statistics-record" aria-label={moteText('活动详情')}>
    <header><h3>{activityLabel(item)}</h3><time dateTime={item.at}>{time(item.at)}</time></header>
    {item.kind==='capture'?<>
      {item.hasImage&&<AuthImage key={item.id} api={api} capture={{id:item.id,capturedAt:item.at,appName:item.appName||activityLabel(item),hasImage:true}}/>}
      <dl>{item.deviceName&&<div><dt>{moteText('设备')}</dt><dd>{item.deviceName}</dd></div>}
      {item.appName&&<div><dt>{moteText('应用')}</dt><dd>{item.appName}</dd></div>}</dl>
      <button type="button" className="button subtle" onClick={()=>onOpen(formatEvidenceRef('capture',item.id))}>{item.hasImage?moteText('查看原图'):moteText('查看记录')}</button>
    </>:<dl><div><dt>{moteText('状态')}</dt><dd>{resultLabel(item.state)}</dd></div>
      {item.kind==='tool'&&<div><dt>{moteText('耗时')}</dt><dd>{item.durationMs===null?moteText('未记录'):moteText('{0} 秒',(item.durationMs/1000).toLocaleString(undefined,{maximumFractionDigits:2}))}</dd></div>}
    </dl>}
  </aside>;
}

function ActivityRows({api,path,revision,onOpen,unknown,filters}:{api:Api;path:string;revision:number;onOpen:(ref:string)=>void;unknown:boolean;filters:ReactNode}) {
  const resource=usePage<UsageActivity>(api,path,revision);
  const [selected,setSelected]=useState<string>();
  const items=resource.data?.items??[];
  const active=items.find(item=>rowKey(item)===selected)??items.find(item=>item.kind==='capture'&&item.hasImage)??items[0];
  return <div className="statistics-columns">
    <div className="statistics-panel statistics-rows-panel">
      {filters}
      {resource.error!==undefined?<ErrorNotice text={errorMessage(resource.error)} retry={resource.refresh}/>
        :resource.loading&&!resource.data?<Loading label={moteText('正在读取…')}/>
        :items.length?<ul className="statistics-rows">{items.map(item=>{
          const Icon=item.kind==='capture'?Image:item.kind==='turn'?MessageCircle:Wrench;
          return <li key={rowKey(item)}><button type="button" aria-pressed={active===item} onClick={event=>{setSelected(rowKey(item));revealRecord(event.currentTarget);}}>
            <time dateTime={item.at}>{time(item.at)}</time><Icon size={15} aria-hidden="true"/>
            <span><strong>{activityLabel(item)}</strong><small>{item.kind==='capture'?[item.deviceName,item.appName].filter(Boolean).join(' · '):resultLabel(item.state)}</small></span>
            <ChevronRight size={15} aria-hidden="true"/>
          </button></li>;
        })}</ul>:<p className="fine-print">{unknown?moteText('未记录'):moteText('当天无活动')}</p>}
      <PageNavigation {...resource}/>
    </div>
    {active&&resource.error===undefined&&<ActivityPreview api={api} item={active} onOpen={onOpen}/>}
  </div>;
}

export function UsageDay({api,day,timeZone,revision,onOpen,initialKind,tools}:{api:Api;day:string;timeZone:string;revision:number;
  onOpen:(ref:string)=>void;initialKind?:UsageActivityKind;tools?:MeasuredCount}) {
  const [kind,setKind]=useState<UsageActivityKind|''>(initialKind??'');
  const filters=[['',moteText('全部')],['capture',moteText('采集')],['turn',moteText('对话')],['tool',moteText('工具')]] as const;
  const path=`/api/usage-statistics/day?${new URLSearchParams({day,timeZone,...(kind?{kind}:{})})}`;
  return <section className="statistics-day" aria-labelledby="usage-statistics-day-title" tabIndex={-1}>
    <header><h2 id="usage-statistics-day-title">{moteText('当天活动')}</h2><time dateTime={day}>{statisticDay(day,{month:'long',day:'numeric',weekday:'short'})}</time></header>
    {kind!=='capture'&&kind!=='turn'&&tools?.partial&&<p className="fine-print">{tools.value===null?moteText('工具调用未记录'):moteText('工具调用部分未记录')}</p>}
    <ActivityRows key={path} api={api} path={path} revision={revision} onOpen={onOpen} unknown={kind==='tool'&&tools?.value===null}
      filters={<div className="owner-presets" role="group" aria-label={moteText('记录类型')}>
        {filters.map(([value,label])=><button type="button" key={value} aria-pressed={kind===value} onClick={()=>setKind(value)}>{label}</button>)}
      </div>}/>
  </section>;
}

export function UsageFailures({api,path,kind,revision,count}:{api:Api;path:string;kind:UsageFailureKind;revision:number;count:MeasuredCount}) {
  const resource=usePage<UsageFailure>(api,path,revision);
  const [selected,setSelected]=useState<string>();
  const items=resource.data?.items??[];
  const active=items.find(item=>item.id===selected)??items[0];
  const title=(row:UsageFailure)=>row.tool?toolLabel(row.tool):failureLabel(row.kind);
  return <div className="statistics-columns">
    <section className="statistics-panel statistics-rows-panel"><header><h2>{moteText('近期失败')}</h2></header>
      {resource.error!==undefined?<ErrorNotice text={errorMessage(resource.error)} retry={resource.refresh}/>
        :resource.loading&&!resource.data?<Loading label={moteText('正在读取…')}/>
        :items.length?<ul className="statistics-rows statistics-failures">{items.map(item=><li key={item.id}>
          <button type="button" aria-pressed={active===item} onClick={event=>{setSelected(item.id);revealRecord(event.currentTarget);}}>
            <time dateTime={item.at}>{dateTime(item.at)}</time><span><strong>{title(item)}</strong><small>{item.reason??moteText('未记录')}</small></span>
            <span className="statistics-retry" data-result={item.retry}>{retryLabel(item.retry)}</span><ChevronRight size={15} aria-hidden="true"/>
          </button></li>)}</ul>:<p className="fine-print">{count.value===null?moteText('未记录'):moteText('暂无失败记录')}</p>}
      <PageNavigation {...resource}/>
    </section>
    {active&&resource.error===undefined&&<aside className="statistics-panel statistics-record" aria-label={moteText('失败详情')}>
      <header><h3>{title(active)}</h3><time dateTime={active.at}>{dateTime(active.at)}</time></header>
      <dl><div><dt>{moteText('失败原因')}</dt><dd>{active.reason?failureMessage(active.reason):moteText('未记录')}
        {active.reason&&<code>{active.reason}</code>}</dd></div>
        <div><dt>{kind==='tool'?moteText('运行重试'):moteText('重试结果')}</dt><dd className="statistics-retry" data-result={active.retry}>{retryLabel(active.retry)}</dd></div></dl>
    </aside>}
  </div>;
}
