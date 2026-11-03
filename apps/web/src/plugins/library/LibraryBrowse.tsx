import {OriginalNoteRow,type OwnerBrowseEntry,type OwnerBrowsePage} from './owner-library-browse';
import {ActionResults} from '../work/ActionResults';
import {NoteOrigin,NoteAttachments} from '../../NoteOrigin';
import {StructuredObservation} from '../../StructuredObservation';
import {libraryMaterialTypes,type LibraryMaterialType,type LibraryTypeDescriptor,type LibrarySourceFacet} from '@mote/shared';
import { FeatureCard, FeatureActions } from '../../features/runtime';
import { ImageProgress } from '../../ImageProgress';
import { materialKind, materialKindOptions, sourceDisplay } from '../../material-presentation';
import { captureOcrState, decodeSourceText, parseEvidenceRef, systemEventText } from '@mote/shared';
import { getLocale, moteText } from '@mote/shared/i18n';
import { ArrowLeft, ChevronDown, ChevronRight, FileText, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { type Api, type Capture, ApiError, dateTime, duration, errorMessage } from '../../api';
import { evidencePresentation, ocrPresentation } from '../../capture-presentation';
import { EvidenceState } from '../../EvidenceState';
import { FileDetail } from '../intake';
import { type Material } from '../../Materials';
import { MediaSnapshot } from './Media';
import { activityExplanation, Metadata, sourceLabels } from '../../Metadata';
import { mediaExplanation } from '../../media-presentation';
import { ReferenceDetail, SourceDocumentDetails } from '../reader';
import { Empty, ErrorNotice, EvidenceDialog, OriginalImage, Spinner } from '../../shell-components';
import { useResource } from '../../useResource';
import {useImportReturnRead} from '../../useImportReturnRead';
import {captureImportSnapshot,importSnapshot} from '../../import-navigation';
import {readPage} from '../../navigation';
import { useMaterialPreview, useNearViewport } from '../../HomeMaterialRow';
function libraryTypeLabel(value:string){
    const labels:Record<LibraryMaterialType,string>={note:moteText('随手记'),document:moteText('文档'),image:moteText('图片'),coding:moteText('Coding 会话'),transcript:moteText('转写'),email:moteText('邮件'),calendar:moteText('日程'),reference:moteText('引用')};
    return labels[value as LibraryMaterialType]??value;
}
function validLibraryDay(value:string){
    if(!value)return true;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
    const date=new Date(value+'T00:00:00');
    return Number.isFinite(date.getTime())&&date.getFullYear()===Number(value.slice(0,4))&&date.getMonth()+1===Number(value.slice(5,7))&&date.getDate()===Number(value.slice(8,10));
}
/** Keep the list mounted so returning from the full-width reader preserves its place. */
export function LibraryBrowseLayout({ children, reference, api, onClose, onOpen, supporting = false }: {
    children: ReactNode;
    reference?: string;
    api: Api;
    onClose: () => void;
    onOpen: (ref: string) => void;
    supporting?: boolean;
}) {
    return <div className={'library-browser' + (reference ? ' has-selection' : '') + (supporting ? ' supporting' : '')}>
    <div className="library-master" aria-label={moteText('资料列表')} hidden={Boolean(reference)}>{children}</div>
    <section className="library-detail" aria-label={moteText('资料详情')} hidden={!reference}>
      {reference ? <><header className="library-detail-heading"><button className="text-button library-back" onClick={onClose}><ArrowLeft size={16}/>{moteText('返回资料列表')}</button><span>{moteText('资料详情')}</span><button className="icon-button library-close" aria-label={moteText('关闭详情')} onClick={onClose}><X size={17}/></button></header><LibraryReference key={reference} api={api} reference={reference} onOpen={onOpen} onClose={onClose}/></> : <Empty icon={FileText} title={moteText('选择一条资料')}><p>{moteText('在这里查看内容、原始来源和支持证据。')}</p></Empty>}
    </section>
  </div>;
}
function LibraryReference({api,reference,onOpen,onClose}:{api:Api;reference:string;onOpen:(ref:string)=>void;onClose:()=>void}) {
    return <EvidenceDialog key={reference} embedded id={reference} api={api} onOpen={onOpen} onClose={onClose} onDeleted={()=>{}}/>;
}
/** Formal material rows pin the exact revision before the full ReferenceDetail reads it. */
export function LibraryMaterials({ api, revision, selected, onSelect, onBrowseChanged, devices = [], viewNavigation, browseNavigation, materialPreview }: {
    api: Api;
    revision: number;
    selected?: string;
    onSelect: (ref: string) => void;
    onBrowseChanged?: () => void;
    devices?: import('../../api').Device[];
    viewNavigation?: ReactNode;
    browseNavigation?: ReactNode;
    materialPreview?: {read:boolean;image:boolean};
}) {
    const readFilters = () => {const query=new URLSearchParams(window.location.hash.split('?')[1]??'');return {owner:api,origin:query.get('origin')??'',sourceId:query.get('sourceId')??'',deviceId:query.get('deviceId')??'',kind:query.get('kind')??'',type:query.get('type')??'',after:query.get('after')??'',before:query.get('before')??'',cursor:query.get('cursor')??undefined};};
    const [filters, setFilters] = useState(readFilters);
    const [filterOpen,setFilterOpen]=useState(()=>importSnapshot<boolean>(api,'materials.filterOpen')??false);
    const filterOpenRef=useRef(filterOpen);filterOpenRef.current=filterOpen;
    useEffect(()=>captureImportSnapshot(api,'materials.filterOpen',()=>filterOpenRef.current),[api]);
    const filterOwner=useRef(api);
    const current = filters.owner === api ? filters : { owner: api, origin:'', sourceId: '', deviceId: '', kind: '', type: '', after: '', before: '', cursor: undefined };
    const invalidDate=!validLibraryDay(current.after)||!validLibraryDay(current.before);
    const update = (patch: Partial<typeof current>) => { onBrowseChanged?.();const next={...current,cursor:undefined,...patch};setFilters(next);const [route,queryText]=window.location.hash.split('?'),query=new URLSearchParams(queryText);for(const key of ['origin','sourceId','deviceId','kind','type','after','before','cursor'] as const){if(next[key])query.set(key,next[key]!);else query.delete(key);}window.history.replaceState(window.history.state,'',route+(query.size?'?'+query:''));window.dispatchEvent(new window.Event('mote:workspace-state'));};
    useEffect(() => { if(filterOwner.current!==api){filterOwner.current=api;setFilterOpen(false);const [route,text]=window.location.hash.split('?'),query=new URLSearchParams(text);for(const key of ['origin','sourceId','deviceId','kind','type','after','before','cursor','selected'])query.delete(key);window.history.replaceState(null,'',route+(query.size?'?'+query:''));window.dispatchEvent(new window.Event('mote:workspace-state'));setFilters(readFilters());}const sync = () => {if(readPage(window.location.hash)==='archive')setFilters(readFilters());}; window.addEventListener('hashchange', sync); return () => window.removeEventListener('hashchange', sync); }, [api]);
    const query = new URLSearchParams({ limit: '24' });
    for (const key of ['origin','sourceId', 'deviceId', 'kind', 'type', 'cursor'] as const)
        if (current[key])
            query.set(key, current[key]!);
    if (current.after&&!invalidDate)
        query.set('after', new Date(current.after + 'T00:00:00').toISOString());
    if (current.before&&!invalidDate) {
        const end = new Date(current.before + 'T00:00:00');
        end.setDate(end.getDate() + 1);
        query.set('before', end.toISOString());
    }
    const path=invalidDate?null:'/api/library/browse?' + query;
    const page = useResource<OwnerBrowsePage>(api,path,undefined,revision),returnReadReady=useImportReturnRead(api,path);
    const activeFilters=([['origin',current.origin?moteText('随手记'):''],['sourceId',current.sourceId?sourceDisplay(current.sourceId,page.data?.sources.find(source=>source.id===current.sourceId)?.label):''],['deviceId',devices.find(device=>device.deviceId===current.deviceId)?.deviceName??current.deviceId],['type',current.type?libraryTypeLabel(current.type):''],['kind',current.kind?materialKind(current.kind,page.data?.types.find(type=>type.kind===current.kind)?.label):''],['after',current.after?moteText('从')+' '+current.after:''],['before',current.before?moteText('至')+' '+current.before:'']] as const).filter(([,label])=>label);
    const kinds=[...new Map([...materialKindOptions(),...(page.data?.items.filter(item=>item.entryType==='material').map(item=>item.material).filter(item=>!materialKindOptions().some(type=>type.kind===item.kind)).map(item=>({kind:item.kind,label:materialKind(item.kind)}))??[]),...(page.data?.types??[])].map(type=>[type.kind,type])).values()];
    const groups=new Map<string,OwnerBrowseEntry[]>();
    for(const item of page.data?.items??[]){const at=item.contentAt;const day=at&&Number.isFinite(Date.parse(at))?new Date(at).toLocaleDateString(getLocale(),{year:'numeric',month:'long',day:'numeric'}):moteText('资料');groups.set(day,[...(groups.get(day)??[]),item]);}
    return <>{!returnReadReady&&<p role="status">{moteText('正在读取…')}</p>}<section className="library-materials" aria-busy={!returnReadReady||undefined} data-import-return-ready={Boolean(returnReadReady&&(invalidDate||page.error!==undefined||!page.loading&&page.data!==undefined))} aria-hidden={!returnReadReady||undefined} style={{visibility:returnReadReady?'visible':'hidden'}}>
    <div className="library-list-heading">{viewNavigation??<h2>{moteText('资料')}</h2>}<div className="library-filter-actions"><button className="text-button" aria-expanded={filterOpen||invalidDate} aria-controls="library-catalog-filters" onClick={()=>setFilterOpen(!filterOpen)}>{moteText('筛选')}{activeFilters.length>0&&' · '+activeFilters.length}<ChevronDown size={12}/></button><button className="icon-button" disabled={page.loading} onClick={page.refresh} aria-label={moteText('刷新')}><RefreshCw size={13}/></button></div></div>
    <div className="library-catalog-filters" id="library-catalog-filters" hidden={!filterOpen&&!invalidDate}>
      <label>{moteText('来源')}<select value={current.origin?'@notes':current.sourceId} onChange={event => update(event.target.value==='@notes'?{origin:'notes',sourceId:'',kind:''}:{origin:'',sourceId:event.target.value})}><option value="">{moteText('全部来源')}</option>{page.data?.noteOrigin&&<option value="@notes">{page.data.noteOrigin.label}</option>}{current.sourceId && !page.data?.sources.some(source => source.id === current.sourceId) && <option value={current.sourceId}>{sourceDisplay(current.sourceId)}</option>}{page.data?.sources.map(source => <option key={source.id} value={source.id}>{sourceDisplay(source.id, source.label)}</option>)}</select></label>
      <label>{moteText('设备')}<select value={current.deviceId} onChange={event => update({ deviceId: event.target.value })}><option value="">{moteText('全部设备')}</option>{devices.map(device => <option key={device.deviceId} value={device.deviceId}>{device.deviceName}</option>)}</select></label>
      <label>{moteText('类型')}<select value={current.type} onChange={event=>update({type:event.target.value})}><option value="">{moteText('全部类型')}</option>{current.type&&!libraryMaterialTypes.includes(current.type as LibraryMaterialType)&&<option value={current.type}>{libraryTypeLabel(current.type)}</option>}{libraryMaterialTypes.map(type=><option key={type} value={type}>{libraryTypeLabel(type)}</option>)}</select></label>
      <button className="text-button" onClick={() => update({ origin:'',sourceId: '', deviceId: '',kind:'',type:'', after: '', before: '' })}>{moteText('清除筛选')}</button>
      <details className="library-date-filters" open={invalidDate||undefined}><summary>{moteText('更多筛选')}</summary><div><label>{moteText('资料类型')}<select value={current.kind} onChange={event=>update({origin:'',kind:event.target.value})}><option value="">{moteText('全部类型')}</option>{current.kind&&!kinds.some(type=>type.kind===current.kind)&&<option value={current.kind}>{materialKind(current.kind)}</option>}{kinds.map(type=><option key={type.kind} value={type.kind}>{materialKind(type.kind,type.label)}</option>)}</select></label><label>{moteText('从')}<input type="date" aria-invalid={!validLibraryDay(current.after)||undefined} value={current.after} onChange={event => update({ after: event.target.value })}/></label><label>{moteText('至')}<input type="date" aria-invalid={!validLibraryDay(current.before)||undefined} min={validLibraryDay(current.after)?current.after:undefined} value={current.before} onChange={event => update({ before: event.target.value })}/></label></div></details>
    </div>
    {activeFilters.length>0&&<div className="library-filter-chips">{activeFilters.map(([key,label])=><button key={key} aria-label={moteText('清除{0}筛选',label)} onClick={()=>update({[key]:''})}>{label}<X size={11}/></button>)}</div>}
    {invalidDate&&<p role="alert">{moteText('请选择有效日期')}</p>}
    {browseNavigation}
    {page.error !== undefined && <ErrorNotice text={page.error instanceof ApiError && page.error.status === 409 && page.error.code === 'invalid_cursor' ? moteText('资料目录已变化，请返回第一页继续浏览。') : errorMessage(page.error)} retry={() => current.cursor ? update({ cursor: undefined }) : page.refresh()}/>}
    {page.loading && !page.data && <Spinner />}
    {returnReadReady && page.error === undefined && page.data && <>{[...groups].map(([day,items])=><section className="library-material-day" key={day}><div className="library-day-heading"><h2>{day}</h2><span>{moteText('本页 {0} 份资料',items.length)}</span></div><div className="library-record-list">{items.map(entry=>entry.entryType==='capture'?<OriginalNoteRow key={entry.ref} entry={entry} onOpen={onSelect}/>:<LibraryMaterialRow key={entry.ref} api={api} item={entry.material} type={page.data!.types.find(type=>type.kind===entry.material.kind&&type.schemaVersion===entry.material.schemaVersion)} source={page.data!.sources.find(source=>source.id===entry.material.origin.sourceId)?.label} device={devices.find(device=>device.deviceId===entry.material.origin.deviceId)?.deviceName} selected={selected===entry.ref} onSelect={onSelect} preview={materialPreview}/>)}</div></section>)}{!page.data.items.length && <Empty icon={FileText} title={moteText('当前范围内暂无资料。')}><p>{moteText('保存记录或导入资料后，可以在这里查看。')}</p></Empty>}<div className="library-pagination">{current.cursor && <button className="button subtle" disabled={page.loading} onClick={() => update({ cursor: undefined })}>{moteText('返回第一页')}</button>}{page.data.nextCursor && <button className="button subtle" disabled={page.loading} onClick={() => update({ cursor: page.data!.nextCursor! })}>{moteText('下一页')}</button>}</div></>}
  </section></>;
}

export function LibraryMaterialRow({api,item,type,source,device,selected,onSelect,preview,presentationText}:{api:Api;item:Material;type?:LibraryTypeDescriptor;source?:string;device?:string;selected:boolean;onSelect:(ref:string)=>void;preview?:{read:boolean;image:boolean};presentationText?:string}){
    const rowRef=useRef<HTMLDivElement>(null),near=useNearViewport(rowRef);
    const {image,clearImage,kindLabel,text}=useMaterialPreview(api,item,Boolean(preview?.read),Boolean(preview?.image),near);
    const value={kind:item.kind,schemaVersion:item.schemaVersion,representation:'owner-material',ref:item.ref,revision:item.revision,title:item.title,text:''};
    const at=item.origin.lastAt??item.origin.firstAt??item.updatedAt;
    const sourceLabel=sourceDisplay(item.origin.sourceId,source);
    const shownText=presentationText??text;
    const fallback=<span className="library-record-copy"><strong>{item.title}</strong><small>{type?.label?materialKind(item.kind,type.label):kindLabel} · {sourceLabel}{device&&device!==sourceLabel?' · '+device:''}</small>{shownText&&<span className="library-record-preview">{shownText}</span>}{item.coverage.state!=='complete'&&<small>{item.coverage.state==='pending'?moteText('仍在整理'):moteText('部分内容')}</small>}{item.retention.original==='reference'&&!shownText&&<small>{moteText('仅保留引用')}</small>}{item.artifacts?.some(artifact=>artifact.state!=='ready')&&<small>{moteText('部分产物仍在处理，可先阅读已有内容。')}</small>}</span>;
    return <div className="library-catalog-row" ref={rowRef}><button data-reference={item.ref} className={'library-record'+(selected?' selected':'')} aria-current={selected?'true':undefined} onClick={()=>onSelect(item.ref)}><span className="library-record-icon">{image?<img src={image} alt="" onError={clearImage}/>:<FileText size={18}/>}</span><FeatureCard value={value} api={api} onOpen={onSelect} fallback={fallback} catalog={type}/><span className="library-record-trailing">{at&&Number.isFinite(Date.parse(at))&&<time dateTime={at}>{dateTime(at,{hour:'2-digit',minute:'2-digit',hour12:false})}</time>}<ChevronRight size={14}/></span></button><FeatureActions position="card" value={value} api={api} onOpen={onSelect} catalog={type}/></div>;
}
