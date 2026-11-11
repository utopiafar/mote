import {commonFailureMessage,httpStatusMessage,formatEvidenceRef,type CaptureTimelineGroup,type CaptureTimelinePage,type CaptureTimelineMembers,type CaptureTimelineMember} from '@mote/shared';
import {moteText,getLocale} from '@mote/shared/i18n';
import {ChevronDown,ChevronLeft,ChevronRight,Clock3,FileText,Monitor,RefreshCw} from 'lucide-react';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ApiError,dateTime,errorMessage,type Api,type Device} from '../../api';
import {captureDateRange,localDateInput} from '../../capture-presentation';
import {sourceLabels} from '../../Metadata';
import {AuthImage,Empty,ErrorNotice} from '../../shell-components';
import {useResource} from '../../useResource';
import {useImportReturnRead} from '../../useImportReturnRead';
import {captureImportSnapshot,importSnapshot} from '../../import-navigation';
import {resources} from '../../resource-cache';
import { Loading } from '../../Loading';

type Filters={api:Api;after:string;before:string;device:string;source:string;collection:string;ocr:string;appId:string};
type TimelineSnapshot={filters:Filters;filterOpen:boolean;paging:{api:Api;scope:string;cursors:(string|undefined)[]}};
const defaults=(api:Api):Filters=>{const day=localDateInput(new Date());return {api,after:day,before:day,device:'',source:'',collection:'',ocr:'',appId:''};};
const validDay=(value:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const at=new Date(value+'T00:00:00');return Number.isFinite(at.getTime())&&localDateInput(at)===value;};
const blocked=(error:unknown)=>error instanceof ApiError&&[401,403,404,409,410].includes(error.status);
const time=(at:string,seconds=false)=>dateTime(at,{hour:'2-digit',minute:'2-digit',...(seconds?{second:'2-digit'}:{}),hour12:false});
const interval=(first:string,last:string,seconds=false)=>time(first,seconds)===time(last,seconds)?time(first,seconds):time(first,seconds)+'–'+time(last,seconds);
const sourceName=(source:string)=>sourceLabels[source]??source;
function counts(group:CaptureTimelineGroup){return group.sampleCount===null?moteText('{0} 条记录',group.recordCount):moteText('{0} 个样本',group.sampleCount);}
// Source groups span a device's civil day; screen sessions keep their observed
// application/start identity. Sealed locators change with every host revision.
const stableKey=(item:CaptureTimelinePage['items'][number])=>JSON.stringify(item.type==='record'?['record',item.record.id,item.day]:['group',item.kind,item.source,item.deviceId,item.day,...(item.kind==='screen-session'?[item.appId??'',item.firstAt]:[])]);

function TimelineFailure({error,retry,message}:{error:unknown;retry:()=>void;message?:string}){return <div className="library-time-failure"><ErrorNotice text={message??(error instanceof ApiError?(error.code&&commonFailureMessage(error.code,error.status)||httpStatusMessage(error.status)):moteText('读取采集记录失败，请重试'))} retry={retry}/><details><summary>{moteText('技术详情')}</summary><pre>{errorMessage(error)}{error instanceof ApiError?'\n'+[error.status,error.code,error.requestId].filter(value=>value!==undefined).join(' · '):''}</pre></details></div>;}

/** Host-provided groups and member locators are read projections, never inferred document relationships. */
export function LibraryTimeline({api,devices,onOpen,revision,onBrowseChanged,viewNavigation,browseNavigation}:{api:Api;devices:Device[];onOpen:(ref:string)=>void;revision:number;onBrowseChanged?:()=>void;viewNavigation?:ReactNode;browseNavigation?:ReactNode}){
 const [restored]=useState(()=>importSnapshot<TimelineSnapshot>(api,'records'));
 const [stored,setStored]=useState(()=>restored?.filters??defaults(api)),[filterOpen,setFilterOpen]=useState(restored?.filterOpen??false),[reload,setReload]=useState(0);
 const current=stored.api===api?stored:defaults(api),zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
 const validDates=validDay(current.after)&&validDay(current.before)&&current.after<=current.before;
 const range=validDates?captureDateRange(current.after,current.before):{};
 const valid=validDates&&!!range.after&&!!range.before&&Date.parse(range.before)-Date.parse(range.after)<=32*86400000;
 const params=new URLSearchParams({...(range.after?{after:range.after}:{}),...(range.before?{before:range.before}:{}),timeZone:zone});
 for(const [key,value]of [['deviceId',current.device],['source',current.source],['collection',current.collection],['ocrStatus',current.ocr],['appId',current.appId]])if(value)params.set(key,value);
 const scope=params.toString(),[paging,setPaging]=useState<{api:Api;scope:string;cursors:(string|undefined)[]}>(restored?.paging??{api,scope,cursors:[undefined]});
 const cursors=paging.api===api&&paging.scope===scope?paging.cursors:[undefined],cursor=cursors.at(-1);
 const base='/api/capture-browser/timeline?'+scope+'&limit=24',path=valid?base+(cursor?'&cursor='+encodeURIComponent(cursor):''):null;
 const page=useResource<CaptureTimelinePage>(api,path,undefined,revision),returnReadReady=useImportReturnRead(api,path);
 const [conflict,setConflict]=useState<{api:Api;scope:string;error:ApiError}>();
 useEffect(()=>setConflict(undefined),[api,scope]);
 useEffect(()=>{
  if(!(page.error instanceof ApiError)||page.error.status!==409||cursors.length===1)return;
  setConflict({api,scope,error:page.error});setPaging({api,scope,cursors:[undefined]});resources(api).get<CaptureTimelinePage>(base).refresh();
 },[api,scope,base,page.error,cursors.length]);
 const failure=page.error??(conflict?.api===api&&conflict.scope===scope?conflict.error:undefined);
 const withdrawn=useRef<CaptureTimelinePage|undefined>(undefined);
 if(blocked(page.error))withdrawn.current=page.data;
 const data=!returnReadReady||blocked(page.error)||page.data===withdrawn.current?undefined:page.data,items=data?.items??[];
 const days=new Map<string,{item:CaptureTimelinePage['items'][number];key:string}[]>(),identities=new Map<string,number>();
 for(const item of items){const identity=stableKey(item);identities.set(identity,(identities.get(identity)??0)+1);}
 const completeQuery=cursors.length===1&&data?.nextCursor===null;
 // A single page cannot prove session uniqueness across the query, and empty
 // app IDs always create separate sessions. Unknown identities close on a new
 // sealed locator rather than inheriting another session's disclosure state.
 for(const item of items){const identity=stableKey(item),unknownSession=item.type==='group'&&item.kind==='screen-session'&&(!item.appId||!completeQuery),key=JSON.stringify([identity,identities.get(identity)!>1||unknownSession?item.id:null]);days.set(item.day,[...(days.get(item.day)??[]),{item,key}]);}
 const snapshot=useRef<TimelineSnapshot>({filters:stored,filterOpen,paging});snapshot.current={filters:stored,filterOpen,paging};
 useEffect(()=>captureImportSnapshot(api,'records',()=>snapshot.current),[api]);
 const filterOwner=useRef(api);useEffect(()=>{if(filterOwner.current===api)return;filterOwner.current=api;setStored(defaults(api));setFilterOpen(false);setPaging({api,scope:'',cursors:[undefined]});},[api]);
 const update=(patch:Partial<Filters>)=>{onBrowseChanged?.();setConflict(undefined);setStored({...current,...patch});};
 const refresh=()=>{onBrowseChanged?.();setConflict(undefined);setPaging({api,scope,cursors:[undefined]});setReload(value=>value+1);if(valid)resources(api).get<CaptureTimelinePage>(base).refresh();};
 const move=(step:number)=>{const at=new Date(current.after+'T00:00:00');at.setDate(at.getDate()+step);const day=localDateInput(at);update({after:day,before:day});};
 const single=current.after===current.before,active=[current.device,current.source,current.collection,current.ocr,current.appId].filter(Boolean).length;
 const label=single&&validDay(current.after)?new Date(current.after+'T12:00:00').toLocaleDateString(getLocale(),{month:'long',day:'numeric',weekday:'short'}):moteText('日期');
 return <>{!returnReadReady&&<Loading/>}<section className="library-captures library-time-final" aria-busy={!returnReadReady||undefined} data-import-return-ready={Boolean(returnReadReady&&(!valid||page.error!==undefined||!page.loading&&data!==undefined))} aria-hidden={!returnReadReady||undefined} style={{visibility:returnReadReady?'visible':'hidden'}}>
  <div className="library-list-heading">{viewNavigation}<div className="library-filter-actions"><button className="text-button" aria-expanded={filterOpen||!valid} aria-controls="library-time-filters" onClick={()=>setFilterOpen(value=>!value)}>{moteText('筛选')}{active>0?' · '+active:''}<ChevronDown size={12}/></button><button className="icon-button" aria-label={moteText('刷新记录')} disabled={page.loading||!valid} onClick={refresh}><RefreshCw size={13}/></button></div></div>
  <div className="library-time-filters" id="library-time-filters" hidden={!filterOpen&&valid}>
   <label>{moteText('设备')}<select aria-label={moteText('筛选设备')} value={current.device} onChange={event=>update({device:event.target.value})}><option value="">{moteText('全部设备')}</option>{devices.map(device=><option key={device.deviceId} value={device.deviceId}>{device.deviceName}</option>)}</select></label>
   <label>{moteText('来源')}<select aria-label={moteText('筛选记录来源')} value={current.source} onChange={event=>update({source:event.target.value,...(event.target.value&&event.target.value!=='screen'?{ocr:''}:{})})}><option value="">{moteText('全部来源')}</option>{Object.entries(sourceLabels).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
   <details className="library-date-filters" open={!valid||undefined}><summary>{moteText('更多筛选')}</summary><div>
    <label>{moteText('从')}<input type="date" aria-label={moteText('开始日期')} value={current.after} aria-invalid={!valid||undefined} onChange={event=>update({after:event.target.value})}/></label><label>{moteText('至')}<input type="date" aria-label={moteText('结束日期')} value={current.before} min={current.after} aria-invalid={!valid||undefined} onChange={event=>update({before:event.target.value})}/></label>
    <label>{moteText('采集级别')}<select aria-label={moteText('筛选采集级别')} value={current.collection} onChange={event=>update({collection:event.target.value})}><option value="">{moteText('全部记录')}</option><option value="activity">{moteText('仅活动状态')}</option><option value="content">{moteText('允许保留的内容')}</option></select></label>
    <label>OCR<select aria-label={moteText('筛选 OCR 状态')} value={current.ocr} onChange={event=>update({ocr:event.target.value})}><option value="">{moteText('全部状态')}</option>{['pending','completed','failed','disabled','unknown','not_applicable'].map(value=><option key={value} value={value}>{moteText(({pending:'待处理',completed:'已完成',failed:'失败',disabled:'已关闭',unknown:'状态未知',not_applicable:'不适用'} as const)[value as 'pending'])}</option>)}</select></label>
    <label>{moteText('应用标识')}<input aria-label={moteText('应用标识')} value={current.appId} maxLength={300} onChange={event=>update({appId:event.target.value})}/></label>
   </div></details>
   <button className="text-button" onClick={()=>update(defaults(api))}>{moteText('清除筛选')}</button>
  </div>
  <div className="library-time-daybar"><button className="icon-button" aria-label={moteText('查看前一天')} disabled={!valid||!single} onClick={()=>move(-1)}><ChevronLeft size={18}/></button><label className="library-time-daypicker"><span>{label}</span><input type="date" aria-label={moteText('查看某天的采集记录')} max={localDateInput(new Date())} value={single?current.after:''} onChange={event=>update({after:event.target.value,before:event.target.value})}/></label><button className="icon-button" aria-label={moteText('查看后一天')} disabled={!valid||!single||current.after>=localDateInput(new Date())} onClick={()=>move(1)}><ChevronRight size={18}/></button>{(!single||current.after!==localDateInput(new Date()))&&<button className="text-button" onClick={()=>{const day=localDateInput(new Date());update({after:day,before:day});}}>{moteText('今天')}</button>}</div>
  {browseNavigation}
  {!valid&&<p role="alert">{moteText('请选择有效日期，最多查看 32 天。')}</p>}
  {failure!==undefined&&<TimelineFailure error={failure} message={failure instanceof ApiError&&failure.status===409?moteText('时间回看内容已变化，请重新读取当前范围。'):undefined} retry={failure instanceof ApiError&&failure.status===409?refresh:page.refresh}/>}
  {page.loading&&!data&&valid&&<Loading/>}
  {valid&&data&&<><p className="library-list-status">{moteText('本页 {0} 项',items.length)}</p><div className="library-time-list">{[...days].map(([day,entries])=><section className="library-time-day" key={day}>{!single&&<h2>{day}</h2>}{entries.map(({item,key})=>item.type==='group'?<TimelineGroup key={reload+':'+key} api={api} scope={scope} group={item} revision={data.revision} refreshVersion={revision} onOpen={onOpen} onReload={refresh}/>:<TimelineRecord key={key} member={item} onOpen={onOpen}/>)}</section>)}</div>{!page.error&&!items.length&&<Empty icon={Clock3} title={moteText('这段时间还没有记录')}><p>{moteText('试试其他时间或设备，或检查采集端是否已开启。')}</p></Empty>}</>}
  <nav className="library-pagination" aria-label={moteText('采集记录分页')}><button className="button subtle" disabled={page.loading||cursors.length===1} onClick={()=>{onBrowseChanged?.();setConflict(undefined);setPaging({api,scope,cursors:cursors.slice(0,-1)});}}>{moteText('上一页')}</button><span>{moteText('第 {0} 页',cursors.length)}</span><button className="button subtle" disabled={page.loading||!data?.nextCursor} onClick={()=>{if(data?.nextCursor){onBrowseChanged?.();setConflict(undefined);setPaging({api,scope,cursors:[...cursors,data.nextCursor]});}}}>{moteText('下一页')}</button></nav>
 </section></>;
}

function TimelineRecord({member,onOpen}:{member:CaptureTimelineMember;onOpen:(ref:string)=>void}){const record=member.record;return <button className="library-record library-time-record" data-reference={formatEvidenceRef('capture',record.id)} onClick={()=>onOpen(formatEvidenceRef('capture',record.id))}><span className="library-time-symbol"><FileText size={18}/></span><span className="library-record-copy"><strong>{record.windowTitle||(record.source==='note'?record.textPreview:record.appName)||record.textPreview||sourceName(record.source)}</strong><small>{sourceName(record.source)} · {record.deviceName}</small></span><time>{time(member.firstAt)}</time><ChevronRight size={16}/></button>;}

function TimelineGroup({api,scope,group,revision,refreshVersion,onOpen,onReload}:{api:Api;scope:string;group:CaptureTimelineGroup;revision:string;refreshVersion:number;onOpen:(ref:string)=>void;onReload:()=>void}){
 type GroupState={api:Api;scope:string;groupId:string;open:boolean;cursors:(string|undefined)[]};
 const [restored]=useState(()=>importSnapshot<{state:GroupState;revision:string}>(api,'records.group:'+group.id));
 const [state,setState]=useState<GroupState>(restored?.revision===revision?restored.state:{api,scope,groupId:group.id,open:false,cursors:[undefined]});
 const current=state.api===api&&state.scope===scope?(state.groupId===group.id?state:{...state,groupId:group.id,cursors:[undefined]}):{api,scope,groupId:group.id,open:false,cursors:[undefined]},cursor=current.cursors.at(-1);
 useEffect(()=>{if(current!==state)setState(current);},[current,state]);
 const path=current.open?'/api/capture-browser/timeline/members?'+scope+'&group='+encodeURIComponent(group.id)+'&limit=24'+(cursor?'&cursor='+encodeURIComponent(cursor):''):null;
 const page=useResource<CaptureTimelineMembers>(api,path,undefined,refreshVersion),returnReadReady=useImportReturnRead(api,path);
 const snapshot=useRef({state:current,revision});snapshot.current={state:current,revision};useEffect(()=>captureImportSnapshot(api,'records.group:'+group.id,()=>snapshot.current),[api,group.id]);
 const mismatched=page.data!==undefined&&(page.data.group?.id!==group.id||page.data.revision!==revision||!Array.isArray(page.data.items));
 const withdrawn=useRef<CaptureTimelineMembers|undefined>(undefined);
 if(blocked(page.error)||mismatched)withdrawn.current=page.data;
 const data=!returnReadReady||blocked(page.error)||mismatched||page.data===withdrawn.current?undefined:page.data;
 const title=group.kind==='screen-session'?(group.appName||moteText('应用未知')):sourceName(group.source);
 return <details className="library-time-group" data-group-id={group.id} data-import-return-ready={Boolean(returnReadReady&&(!current.open||page.error!==undefined||mismatched||!page.loading&&data!==undefined))} open={current.open} onToggle={event=>{if(event.currentTarget.open!==current.open)setState({...current,open:event.currentTarget.open});}}>
  <summary><span className="library-time-symbol">{group.kind==='screen-session'?<Monitor size={18}/>:<FileText size={18}/>}</span><span><strong>{title}</strong><small>{group.deviceName} · {interval(group.firstAt,group.lastAt)}</small></span><span className="library-time-count">{counts(group)}{group.kind==='screen-session'&&<small>{moteText('{0} 张图片',group.imageCount)}</small>}{group.sampleCount!==null&&<small>{moteText('{0} 条记录',group.recordCount)}</small>}</span></summary>
  {current.open&&!returnReadReady&&<Loading/>}
  {current.open&&<div className="library-time-members" aria-hidden={!returnReadReady||undefined} style={{visibility:returnReadReady?'visible':'hidden'}}>
   {(page.error!==undefined||mismatched)&&<TimelineFailure error={page.error??moteText('这组记录当前不可用，请重新读取当前范围。')} message={mismatched||page.error instanceof ApiError&&page.error.status===409?moteText('这组记录当前不可用，请重新读取当前范围。'):undefined} retry={mismatched||page.error instanceof ApiError&&page.error.status===409?onReload:page.refresh}/>}
   {page.loading&&!data&&<Loading/>}
   <div className={group.kind==='screen-session'?'library-time-frames':'library-time-observations'}>{data?.items.map(member=>group.kind==='screen-session'?<button className="library-time-frame" key={member.record.id} data-reference={formatEvidenceRef('capture',member.record.id)} onClick={()=>onOpen(formatEvidenceRef('capture',member.record.id))}>{member.record.hasImage?<AuthImage api={api} capture={member.record}/>:<span className="library-time-no-image">{moteText('无图片 · 查看采样记录')}</span>}<small>{interval(member.firstAt,member.lastAt,true)}</small></button>:<button className="library-time-observation" key={member.record.id} data-reference={formatEvidenceRef('capture',member.record.id)} onClick={()=>onOpen(formatEvidenceRef('capture',member.record.id))}><time>{interval(member.firstAt,member.lastAt)}</time><span><strong>{member.record.windowTitle||member.record.appName||sourceName(member.record.source)}</strong>{member.record.textPreview&&<small>{member.record.textPreview}</small>}{member.sampleCount!==null&&<small>{moteText('{0} 个样本',member.sampleCount)}</small>}</span></button>)}</div>
   {data&&<nav className="library-time-member-pagination" aria-label={moteText('组内记录分页')}><button className="text-button" disabled={page.loading||current.cursors.length===1} onClick={()=>setState({...current,cursors:current.cursors.slice(0,-1)})}>{moteText('上一页')}</button><span>{moteText('第 {0} 页',current.cursors.length)}</span><button className="text-button" disabled={page.loading||!data.nextCursor} onClick={()=>{if(data.nextCursor)setState({...current,cursors:[...current.cursors,data.nextCursor]});}}>{moteText('下一页')}</button></nav>}
  </div>}
 </details>;
}
