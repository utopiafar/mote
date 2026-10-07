import type {LibraryTypeDescriptor,LibrarySourceFacet} from '@mote/shared';
import {FeatureCard,FeatureActions} from './features/runtime';
import {ImageProgress} from './ImageProgress';
import {captureOcrState,decodeSourceText,parseEvidenceRef,systemEventText} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {ArrowLeft,FileText,RefreshCw,X} from 'lucide-react';
import {useEffect,useState,type ReactNode} from 'react';
import {type Api,type Capture,ApiError,dateTime,duration,errorMessage} from './api';
import {evidencePresentation,ocrPresentation} from './capture-presentation';
import {EvidenceState} from './EvidenceState';
import {FileDetail} from './Files';
import {type Material} from './Materials';
import {MediaSnapshot} from './Media';
import {activityExplanation,Metadata,sourceLabels} from './Metadata';
import {mediaExplanation} from './media-presentation';
import {ReferenceDetail} from './ReferenceDetail';
import {SourceDocumentDetails} from './SourceDocumentDetails';
import {Empty,ErrorNotice,OriginalImage,Spinner} from './shell-components';
import {useResource} from './useResource';

/** A single object browser: wide screens keep the list, narrow screens return to it. */
export function LibraryBrowseLayout({children,reference,api,onClose,onOpen,supporting=false}:{children:ReactNode;reference?:string;api:Api;onClose:()=>void;onOpen:(ref:string)=>void;supporting?:boolean}) {
  return <div className={'library-browser'+(reference?' has-selection':'')+(supporting?' supporting':'')}>
    <div className="library-master" aria-label={moteText('资料列表')}>{children}</div>
    <section className="library-detail" aria-label={moteText('资料详情')}>
      {reference?<><header className="library-detail-heading"><button className="text-button library-back" onClick={onClose}><ArrowLeft size={16}/>{moteText('返回资料列表')}</button><span>{moteText('资料详情')}</span><button className="icon-button library-close" aria-label={moteText('关闭详情')} onClick={onClose}><X size={17}/></button></header><LibraryReference key={reference} api={api} reference={reference} onOpen={onOpen}/></>:<Empty icon={FileText} title={moteText('选择一条资料')}><p>{moteText('在这里查看内容、原始来源和支持证据。')}</p></Empty>}
    </section>
  </div>;
}

function LibraryReference({api,reference,onOpen}:{api:Api;reference:string;onOpen:(ref:string)=>void}) {
  const capture=parseEvidenceRef(reference)?.kind==='capture';
  return capture?<LibraryCaptureDetail api={api} reference={reference} onOpen={onOpen}/>:<ReferenceDetail api={api} reference={reference} onOpen={onOpen}/>;
}

/** The same authenticated original and provenance shown by the full evidence reader. */
function LibraryCaptureDetail({api,reference,onOpen}:{api:Api;reference:string;onOpen:(ref:string)=>void}) {
  const read=useResource<Capture>(api,'/api/capture-browser/'+encodeURIComponent(parseEvidenceRef(reference)!.id),5000);
  if(read.error!==undefined)return <div className="panel-pad"><ErrorNotice text={errorMessage(read.error)} retry={read.refresh}/></div>;
  if(!read.data)return <div className="panel-pad"><Spinner/></div>;
  const capture=read.data,presentation=evidencePresentation(capture);
  const sourceBody=capture.evidencePresentation==='source-record-json-v1'?decodeSourceText(capture.evidencePresentation,capture.ocrText):undefined;
  const text=sourceBody?.kind==='source'?sourceBody.text:capture.ocrText;
  const ocr=capture.source==='screen'?ocrPresentation(captureOcrState(capture),capture.ocrText,capture.metadata?.capture?.deduplication?.duplicate,capture.perceptionJobs):undefined;
  return <article className="library-capture-detail panel-pad">
    <span className="eyebrow">{sourceLabels[capture.source]??capture.source}</span><h2>{capture.windowTitle||capture.appName||moteText('原始上下文')}</h2><p className="muted">{dateTime(capture.capturedAt)} · {capture.deviceName}</p><EvidenceState/>
    {capture.revisionState==='historical'&&<p role="status">{moteText('历史证据，仅用于核对当时的内容。')}</p>}
    {presentation.nativeFile&&<FileDetail api={api} id={presentation.nativeFile.captureId} startMs={presentation.nativeFile.startMs} onOpen={onOpen}/>}
    {capture.blobHash&&capture.revisionState!=='historical'&&<ImageProgress api={api} id={capture.id}/>}
    {capture.blobHash&&<OriginalImage api={api} capture={capture}/>}
    {ocr&&<div className="evidence-ocr-status" role="status"><span className={'badge '+ocr.tone}>{ocr.label}</span><p>{ocr.description}</p></div>}
    <h3>{presentation.textLabel}</h3><pre className="library-original-text">{capture.source==='media'?mediaExplanation:capture.source==='activity'?activityExplanation:systemEventText(capture.metadata)||text||(capture.provenance?.deleted?moteText('来源已报告删除；本次只保留来源元数据。'):capture.provenance?.layer==='reference'?moteText('此来源仅保留引用与元数据，未导入正文。'):presentation.nativeFile&&capture.provenance?.layer==='original'?moteText('原件单独保存；转写与摘要见上方。'):capture.blobHash?moteText('暂无文字。'):moteText('此记录没有正文。'))}</pre>
    {(capture.source==='media'||capture.metadata?.media)&&<MediaSnapshot media={capture.metadata?.media} observedAt={capture.metadata?.observedAt??capture.capturedAt} screenLocked={capture.metadata?.state?.screenLocked} collection={capture.privacy.collection}/>}
    <section className="library-provenance"><h3>{moteText('来源与定位')}</h3><dl><dt>{moteText('来源')}</dt><dd>{sourceLabels[capture.source]??capture.source}</dd><dt>{moteText('设备')}</dt><dd>{capture.deviceName}</dd>{capture.appId&&<><dt>{moteText('应用标识')}</dt><dd>{capture.appId}</dd></>}{(capture.source==='screen'||capture.source==='activity')&&<><dt>{moteText('前台应用采样时长')}</dt><dd>{duration(capture.durationMs)}</dd></>}<dt>{moteText('隐私处理')}</dt><dd>{capture.source==='activity'?moteText('仅记应用活动，不采集内容'):capture.source==='media'?(capture.privacy.collection==='activity'?moteText('仅应用与播放状态，不采集标题等内容'):moteText('保留应用上报的媒体信息，不录制音频')):capture.privacy.redacted?moteText('客户端报告已脱敏'):moteText('未标记脱敏')}</dd></dl>
      <Metadata stateSeries={capture.stateSeries} metadata={capture.metadata} source={capture.provenance?.metadata} modifiedAt={capture.provenance?.modifiedAt}/><SourceDocumentDetails api={api} document={capture.provenance?.document}/>{capture.privacy.reason&&<p className="field-note">{capture.privacy.reason}</p>}<code className="record-id">{reference}</code>
    </section>
    <button className="button subtle" onClick={()=>onOpen(reference)}>{moteText('打开完整详情')}</button>
  </article>;
}

/** Formal material rows pin the exact revision before the full ReferenceDetail reads it. */
export function LibraryMaterials({api,revision,selected,onSelect,onBrowseChanged,devices=[]}:{api:Api;revision:number;selected?:string;onSelect:(ref:string)=>void;onBrowseChanged?:()=>void;devices?:import('./api').Device[]}) {
  const [filters,setFilters]=useState({owner:api,sourceId:new URLSearchParams(location.hash.split('?')[1]??'').get('sourceId')??'',deviceId:'',after:'',before:'',cursor:undefined as string|undefined});
  const current=filters.owner===api?filters:{owner:api,sourceId:'',deviceId:'',after:'',before:'',cursor:undefined};
  const update=(patch:Partial<typeof current>)=>{onBrowseChanged?.();setFilters({...current,cursor:undefined,...patch});};
  useEffect(()=>{const sync=()=>{const sourceId=new URLSearchParams(location.hash.split('?')[1]??'').get('sourceId')??'';if(sourceId!==current.sourceId)onBrowseChanged?.();setFilters(previous=>previous.owner===api&&previous.sourceId===sourceId?previous:{...previous,owner:api,sourceId,cursor:undefined});};window.addEventListener('hashchange',sync);return()=>window.removeEventListener('hashchange',sync);},[api,current.sourceId,onBrowseChanged]);
  const query=new URLSearchParams({limit:'24'});
  for(const key of ['sourceId','deviceId','cursor'] as const)if(current[key])query.set(key,current[key]!);
  if(current.after)query.set('after',new Date(current.after+'T00:00:00').toISOString());
  if(current.before){const end=new Date(current.before+'T00:00:00');end.setDate(end.getDate()+1);query.set('before',end.toISOString());}
  const page=useResource<{schemaVersion:1;types:LibraryTypeDescriptor[];sources:LibrarySourceFacet[];sourcesTruncated:boolean;items:Material[];nextCursor:string|null}>(api,'/api/library/catalog?'+query);
  useEffect(()=>{page.refresh();},[revision,page.refresh]);
  const coverage=(state:string)=>({complete:moteText('完整'),partial:moteText('部分内容'),pending:moteText('仍在整理')}[state]??state);
  return <section className="library-materials">
    <div className="library-list-heading"><div><h2>{moteText('全部资料')}</h2><p>{moteText('包括 Coding Agent 会话；可读内容不等待记忆整理。')}</p></div><button className="icon-button" disabled={page.loading} onClick={page.refresh} aria-label={moteText('刷新')}><RefreshCw size={16}/></button></div>
    <div className="library-catalog-filters">
      <label>{moteText('来源')}<select value={current.sourceId} onChange={event=>update({sourceId:event.target.value})}><option value="">{moteText('全部来源')}</option>{current.sourceId&&!page.data?.sources.some(source=>source.id===current.sourceId)&&<option value={current.sourceId}>{current.sourceId}</option>}{page.data?.sources.map(source=><option key={source.id} value={source.id}>{source.label} · {source.count}</option>)}</select></label>
      <label>{moteText('设备')}<select value={current.deviceId} onChange={event=>update({deviceId:event.target.value})}><option value="">{moteText('全部设备')}</option>{devices.map(device=><option key={device.deviceId} value={device.deviceId}>{device.deviceName}</option>)}</select></label>
      <label>{moteText('从')}<input type="date" value={current.after} onChange={event=>update({after:event.target.value})}/></label><label>{moteText('至')}<input type="date" min={current.after} value={current.before} onChange={event=>update({before:event.target.value})}/></label>
      {(current.sourceId||current.deviceId||current.after||current.before)&&<button className="text-button" onClick={()=>update({sourceId:'',deviceId:'',after:'',before:''})}>{moteText('清除筛选')}</button>}
    </div>
    {page.error!==undefined&&<ErrorNotice text={page.error instanceof ApiError&&page.error.status===409?moteText('资料目录已变化，请返回第一页继续浏览。'):errorMessage(page.error)} retry={()=>current.cursor?update({cursor:undefined}):page.refresh()}/>}
    {page.loading&&!page.data&&<Spinner/>}
    {page.error===undefined&&page.data&&<><div className="library-record-list">{page.data.items.map(item=>{
      const type=page.data!.types.find(type=>type.kind===item.kind&&type.schemaVersion===item.schemaVersion);
      const value={kind:item.kind,schemaVersion:item.schemaVersion,representation:'owner-material',ref:item.ref,revision:item.revision,title:item.title,text:''};
      const source=page.data!.sources.find(source=>source.id===item.origin.sourceId);
      const fallback=<span className="library-record-copy"><strong>{item.title}</strong><small>{source?.label??item.origin.sourceId} · {type?moteText(type.label):item.kind}</small><small>{coverage(item.coverage.state)} · {moteText('版本 {0}',item.sequence)}</small>{item.artifacts?.some(artifact=>artifact.state!=='ready')&&<small>{moteText('部分产物仍在处理，可先阅读已有内容。')}</small>}</span>;
      return <div className="library-catalog-row" key={item.id}><button className={'library-record'+(selected===item.ref?' selected':'')} aria-current={selected===item.ref?'true':undefined} onClick={()=>onSelect(item.ref)}><span className="library-record-icon"><FileText size={18}/></span><FeatureCard value={value} api={api} onOpen={onSelect} fallback={fallback} catalog={type}/></button><FeatureActions position="card" value={value} api={api} onOpen={onSelect} catalog={type}/></div>;
    })}</div>{!page.data.items.length&&<Empty icon={FileText} title={moteText('当前范围内暂无已发布资料。')}><p>{moteText('已上传但尚未发布的输入，可在上传与处理中查看。')}</p></Empty>}<div className="library-pagination">{current.cursor&&<button className="button subtle" disabled={page.loading} onClick={()=>update({cursor:undefined})}>{moteText('返回第一页')}</button>}{page.data.nextCursor&&<button className="button subtle" disabled={page.loading} onClick={()=>update({cursor:page.data!.nextCursor!})}>{moteText('下一页')}</button>}</div></>}
  </section>;
}
