import {captureOcrState,decodeSourceText,parseEvidenceRef,systemEventText} from '@mote/shared';
import {moteText} from '@mote/shared/i18n';
import {ArrowLeft,FileText,RefreshCw,X} from 'lucide-react';
import {useEffect,useState,type ReactNode} from 'react';
import {type Api,type Capture,dateTime,duration,errorMessage} from './api';
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
export function LibraryMaterials({api,revision,selected,onSelect,onBrowseChanged}:{api:Api;revision:number;selected?:string;onSelect:(ref:string)=>void;onBrowseChanged?:()=>void}) {
  const [position,setPosition]=useState<{owner:Api;cursor?:string}>({owner:api});
  const cursor=position.owner===api?position.cursor:undefined;
  const setCursor=(next?:string)=>{onBrowseChanged?.();setPosition({owner:api,cursor:next});};
  const page=useResource<{items:Material[];nextCursor:string|null}>(api,'/api/materials?'+new URLSearchParams({limit:'12',...(cursor?{cursor}:{})}));
  useEffect(()=>{page.refresh();},[revision,page.refresh]);
  return <section className="library-materials"><div className="library-list-heading"><div><h2>{moteText('正式资料')}</h2><p>{moteText('查看中央端发布的正文、版本、来源和处理产物。')}</p></div><button className="icon-button" disabled={page.loading} onClick={page.refresh} aria-label={moteText('刷新')}><RefreshCw size={16}/></button></div>
    {page.error!==undefined&&<ErrorNotice text={errorMessage(page.error)} retry={page.refresh}/>}
    {page.loading&&!page.data&&<Spinner/>}
    {page.error===undefined&&page.data&&<><div className="library-record-list">{page.data.items.map(item=><button className={'library-record'+(selected===item.ref?' selected':'')} key={item.ref} aria-current={selected===item.ref?'true':undefined} onClick={()=>onSelect(item.ref)}><span className="library-record-icon"><FileText size={18}/></span><span className="library-record-copy"><strong>{item.title}</strong><small>{item.kind} · {moteText('版本 {0}',item.sequence)} · {item.coverage.state}</small><small>{item.origin.sourceId}</small></span></button>)}</div>{!page.data.items.length&&<Empty icon={FileText} title={moteText('当前范围内暂无已发布资料。')}/>}<div className="library-pagination">{cursor&&<button className="button subtle" disabled={page.loading} onClick={()=>setCursor(undefined)}>{moteText('返回第一页')}</button>}{page.data.nextCursor&&<button className="button subtle" disabled={page.loading} onClick={()=>setCursor(page.data!.nextCursor!)}>{moteText('下一页')}</button>}</div></>}
  </section>;
}
