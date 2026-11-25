import {useEffect, useRef, useState, type KeyboardEvent} from 'react';
import {BarChart3, Bell, CircleAlert, Image, MessageCircle, RefreshCw, ScanLine, Wrench} from 'lucide-react';
import {usageCaptureKinds, usageFailureKinds, type MeasuredCount, type UsageFailureKind, type UsageStatisticsCounts, type UsageStatisticsSummary} from '@mote/shared';
import {getLocale, moteText} from '@mote/shared/i18n';
import {errorMessage, type Api} from '../../api';
import {Loading} from '../../Loading';
import {MaintenanceFrame} from '../../MaintenanceFrame';
import {ErrorNotice} from '../../shell-components';
import {useResource} from '../../useResource';
import {Usage} from './Usage';
import {UsageDay, UsageFailures} from './UsageStatisticsDetails';
import {captureLabel, failureLabel, statisticDay, statisticNumber, toolLabel} from './usage-statistics-labels';

const tabs=['overview','capture','turn','tool','failures','usage'] as const;
type Tab=typeof tabs[number];
type Metric='captures'|'projection'|'system'|'turns'|'turnFailures'|'toolCalls'|'toolFailures'|'processingFailures';
const metricsFor={
  overview:['captures','turns','toolCalls','toolFailures'],
  capture:['captures','projection','system'],
  turn:['turns','turnFailures'],
  tool:['toolCalls','toolFailures'],
} as const satisfies Record<Exclude<Tab,'failures'|'usage'>,readonly Metric[]>;
const failureMetrics={tool:'toolFailures',turn:'turnFailures',processing:'processingFailures'} as const satisfies Record<UsageFailureKind,Metric>;

function metricInfo(metric:Metric) {
  return {
    captures:{label:moteText('采集事件'),icon:ScanLine},projection:{label:moteText('投屏截图'),icon:Image},
    system:{label:moteText('系统事件'),icon:Bell},turns:{label:moteText('对话轮次'),icon:MessageCircle},
    turnFailures:{label:failureLabel('turn'),icon:CircleAlert},toolCalls:{label:moteText('工具调用'),icon:Wrench},
    toolFailures:{label:failureLabel('tool'),icon:CircleAlert},processingFailures:{label:failureLabel('processing'),icon:CircleAlert},
  }[metric];
}
function localDay(offset=0) {
  const date=new Date();
  return new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate()+offset)).toISOString().slice(0,10);
}
function exact(value:number):MeasuredCount {return {value,partial:false};}
function count(data:UsageStatisticsCounts,metric:Metric):MeasuredCount {
  if(metric==='captures')return exact(Object.values(data.captures).reduce((total,current)=>total+current,0));
  if(metric==='projection')return {value:data.captures.projection||(!data.captures.unknownScreen?0:null),partial:data.captures.unknownScreen>0};
  if(metric==='system')return exact(data.captures.system);
  if(metric==='toolCalls'||metric==='toolFailures')return data[metric];
  return exact(data[metric]);
}
function displayed(value:MeasuredCount) {return value.value===null?moteText('未记录'):statisticNumber(value.value);}

function MetricCard({metric,data,active,onClick,overview=false}:{metric:Metric;data:UsageStatisticsCounts;active:boolean;onClick:()=>void;overview?:boolean}) {
  const {label,icon:Icon}=metricInfo(metric),measure=count(data,metric);
  const note=measure.partial&&measure.value!==null?moteText('部分未记录')
    :overview&&metric==='captures'?`${moteText('投屏截图')} ${displayed(count(data,'projection'))}`:undefined;
  return <button className="statistics-metric" type="button" aria-pressed={active} onClick={onClick}>
    <span><Icon size={15} aria-hidden="true"/>{label}</span>
    <strong data-measure={measure.value===null?'unknown':undefined}>{displayed(measure)}</strong>
    {note&&<small>{note}</small>}
  </button>;
}

const stackOrder=['projection','page','system','screen','unknownScreen','other'] as const;
function Trend({days,metric,selected,onDay}:{days:UsageStatisticsSummary['days'];metric:Metric;selected:string|undefined;onDay:(day:string)=>void}) {
  const {label}=metricInfo(metric),values=days.map(day=>count(day,metric));
  const max=Math.max(1,...values.map(value=>value.value??0)),scale=10**Math.floor(Math.log10(Math.max(1,max/4))),step=Math.ceil(max/4/scale)*scale,ceiling=4*step;
  const compact=new Intl.NumberFormat(getLocale(),{notation:'compact',maximumFractionDigits:1});
  const ticks=[ceiling,3*step,2*step,step,0];
  return <section className="statistics-panel statistics-trend" aria-label={`${label} · ${moteText('每日趋势')}`}>
    <header><h2>{label} · {moteText('每日趋势')}</h2>
      {!!days.length&&<input aria-label={moteText('选择日期')} type="date" min={days[0].day} max={days.at(-1)!.day}
        value={selected??''} onChange={event=>{if(days.some(day=>day.day===event.target.value))onDay(event.target.value);}}/>}</header>
    <div className="statistics-plot">
      <div className="statistics-ticks" aria-hidden="true">{ticks.map(tick=><span key={tick}>{compact.format(tick)}</span>)}</div>
      <div className="statistics-marks" style={{gridTemplateColumns:`repeat(${Math.max(1,days.length)},minmax(0,1fr))`}}>
      <div className="statistics-gridlines" aria-hidden="true">{ticks.map(tick=><span key={tick}/>)}</div>
      {days.map((day,index)=>{
        const measure=values[index],sz=100*(measure.value??0)/ceiling,description=`${statisticDay(day.day)} · ${displayed(measure)}${measure.partial&&measure.value!==null?` · ${moteText('部分未记录')}`:''}`;
        return <button className="statistics-day-mark" type="button" key={day.day} data-day={day.day} aria-pressed={selected===day.day}
          aria-label={description} title={description} onClick={()=>onDay(day.day)}>
          <span className="statistics-bar-slot" aria-hidden="true">
            <span className="statistics-bar" data-measure={measure.value===null?'unknown':measure.partial?'partial':undefined} data-metric={metric} style={{height:`${sz}%`}}>
              {metric==='captures'&&stackOrder.filter(kind=>day.captures[kind]>0).map(kind=><i key={kind} className="statistics-series" data-series={kind} style={{flexGrow:day.captures[kind]}}/>)}</span>
          </span>
          <span className="statistics-date-label" aria-hidden="true">{(days.length<=7||index%5===0||index===days.length-1)&&statisticDay(day.day,{month:'numeric',day:'numeric'})}</span>
        </button>;
      })}
      </div>
    </div>
  </section>;
}

function CaptureBreakdown({data}:{data:UsageStatisticsCounts}) {
  const total=count(data,'captures').value??0;
  const kinds=usageCaptureKinds.filter(kind=>data.captures[kind]>0).sort((left,right)=>data.captures[right]-data.captures[left]);
  return <section className="statistics-panel"><header><h2>{moteText('采集来源')}</h2></header>
    {kinds.length?<ul className="statistics-rank">{kinds.map(kind=><li key={kind}>
      <span><i className="statistics-series" data-series={kind} aria-hidden="true"/>{captureLabel(kind)}</span>
      <strong>{statisticNumber(data.captures[kind])}</strong>
      <div aria-hidden="true"><i className="statistics-series" data-series={kind} style={{width:`${100*data.captures[kind]/total}%`}}/></div>
    </li>)}</ul>:<p className="fine-print">{moteText('暂无数据')}</p>}
  </section>;
}

function ToolBreakdown({tools,total}:{tools:UsageStatisticsSummary['tools'];total:MeasuredCount}) {
  return <section className="statistics-panel"><header><h2>{moteText('常用工具')}</h2></header>
    {tools.length?<ul className="statistics-rank">{tools.map(tool=><li key={tool.name}>
      <span>{toolLabel(tool.name)}</span><strong>{statisticNumber(tool.calls)}</strong>
      <div aria-hidden="true"><i className="statistics-series" style={{width:`${100*tool.calls/tools[0].calls}%`}}/></div>
      {!!tool.failures&&<small>{moteText('{0} 次失败',statisticNumber(tool.failures))}</small>}
    </li>)}</ul>:<p className="fine-print">{total.value===null?moteText('未记录'):moteText('暂无数据')}</p>}
  </section>;
}

function StatisticsTabs({active,onTab}:{active:Tab;onTab:(value:Tab)=>void}) {
  const labels:Record<Tab,string>={overview:moteText('总览'),capture:moteText('采集'),turn:moteText('对话'),tool:moteText('工具'),failures:moteText('失败'),usage:moteText('用量与费用')};
  function move(event:KeyboardEvent,tab:Tab) {
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const index=tabs.indexOf(tab),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;
    onTab(tabs[next]);
    document.getElementById(`usage-statistics-tab-${tabs[next]}`)?.focus();
  }
  return <nav className="statistics-tabs" role="tablist" aria-label={moteText('统计分类')}>
    {tabs.map(tab=><button key={tab} type="button" role="tab" id={`usage-statistics-tab-${tab}`} aria-selected={active===tab} aria-controls="usage-statistics-panel"
      tabIndex={active===tab?0:-1} onClick={()=>onTab(tab)} onKeyDown={event=>move(event,tab)}>{labels[tab]}</button>)}
  </nav>;
}

export function UsageStatistics({api,onOpen}:{api:Api;onOpen:(ref:string)=>void}) {
  const [tab,setTab]=useState<Tab>('overview'),[period,setPeriod]=useState(7),[day,setDay]=useState<string>(),[revision,setRevision]=useState(0);
  const [metrics,setMetrics]=useState<Record<keyof typeof metricsFor,Metric>>({overview:'captures',capture:'captures',turn:'turns',tool:'toolCalls'});
  const [failureKind,setFailureKind]=useState<UsageFailureKind>('tool');
  const dayPanel=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(day)dayPanel.current?.scrollIntoView({block:'nearest'});},[day]);

  const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const range={from:localDay(1-period),to:localDay(),timeZone};
  const rangeQuery=new URLSearchParams(range);
  const summary=useResource<UsageStatisticsSummary>(api,tab==='usage'?null:`/api/usage-statistics?${rangeQuery}`,undefined,revision);
  const activeDay=summary.data?.days.find(value=>value.day===day);
  function changeTab(value:Tab) {setTab(value);setDay(undefined);}
  const actions=tab==='usage'?undefined:<div className="statistics-actions">
    <div className="owner-presets" role="group" aria-label={moteText('时间范围')}>
      {[7,30].map(days=><button type="button" key={days} aria-pressed={days===period} onClick={()=>{setPeriod(days);setDay(undefined);}}>{moteText('近 {0} 天',days)}</button>)}
    </div>
    <button className="button subtle" type="button" disabled={summary.loading} onClick={()=>setRevision(value=>value+1)}><RefreshCw size={14} aria-hidden="true"/>{moteText('刷新')}</button>
  </div>;
  function statistics(data:UsageStatisticsSummary) {
    if(tab==='failures'){
      const query=new URLSearchParams({...range,kind:failureKind});
      return <><div className="statistics-metrics">{usageFailureKinds.map(kind=><MetricCard key={kind} metric={failureMetrics[kind]} data={data.total} active={failureKind===kind} onClick={()=>setFailureKind(kind)}/>)}</div>
        <UsageFailures key={String(query)} api={api} path={`/api/usage-statistics/failures?${query}`} kind={failureKind} count={count(data.total,failureMetrics[failureKind])} revision={revision}/></>;
    }
    if(tab==='usage')return null;
    const metric=metrics[tab];
    const captures=['captures','projection','system'].includes(metric),tools=metric==='toolCalls'||metric==='toolFailures';
    return <>
      <div className="statistics-metrics">{metricsFor[tab].map(key=><MetricCard key={key} metric={key} data={data.total} active={metric===key} overview={tab==='overview'}
        onClick={()=>setMetrics(previous=>({...previous,[tab]:key}))}/>)}</div>
      <div className={captures||tools?'statistics-columns':'statistics-single'}>
        <Trend days={data.days} metric={metric} selected={activeDay?.day} onDay={setDay}/>
        {captures&&<CaptureBreakdown data={data.total}/>} {tools&&<ToolBreakdown tools={data.tools} total={data.total.toolCalls}/>}
      </div>
      {activeDay&&<div ref={dayPanel}><UsageDay key={activeDay.day} api={api} day={activeDay.day} timeZone={timeZone} revision={revision} onOpen={onOpen}
        initialKind={tab==='overview'?undefined:tab} tools={activeDay.toolCalls}/></div>}
    </>;
  }

  return <MaintenanceFrame className="usage-statistics-page" title={moteText('使用统计')} actions={actions}>
    <StatisticsTabs active={tab} onTab={changeTab}/>
    <div id="usage-statistics-panel" role="tabpanel" aria-labelledby={`usage-statistics-tab-${tab}`} className="statistics-content">
      {tab==='usage'?<Usage api={api} initialRange={range} embedded/>
        :summary.error!==undefined?<ErrorNotice text={errorMessage(summary.error)} retry={summary.refresh}/>
        :summary.data?statistics(summary.data):<Loading label={moteText('正在读取统计…')}/>}
      {tab!=='usage'&&summary.data&&summary.error===undefined&&<footer><BarChart3 size={13} aria-hidden="true"/>{statisticDay(range.from)} – {statisticDay(range.to)}<span>{timeZone}</span></footer>}
    </div>
  </MaintenanceFrame>;
}
