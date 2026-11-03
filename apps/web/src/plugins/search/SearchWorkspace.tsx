import {useEffect,useMemo,useRef,useSyncExternalStore,type ComponentProps} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,ApiError,dateTime,errorMessage} from '../../api';
import {useResource} from '../../useResource';
import {openQuestionDraft} from '../../open-question-draft';
import {OriginalNoteRow} from '../../owner-library-browse';
import {useDiscoveryState} from '../../DiscoveryLink';
import {featureRequirementsAvailable,sourceItemKinds} from '@mote/shared';
import {MemoryDetailPage} from '../../Memories';
import {ChevronRight} from 'lucide-react';
import {useWorkspaceStyle} from '../../workspace-final-style';
import {materialTextExcerpt} from '../../material-preview-text';
import type {Material} from '../../Materials';
import {LibraryBrowseLayout,LibraryMaterialRow} from '../../LibraryBrowse';
import {SearchController,clearSearchCache,emptySearchSnapshot,type SearchSnapshot,type SearchState} from './controller';

function useSearchWorkspace(api:Api):{controller:SearchController;snapshot:SearchSnapshot}{
 const hashOwner=useRef(api),previousOwner=useRef(api),adoptHash=hashOwner.current===api;
 const controller=useMemo(()=>new SearchController({api,adoptHash}),[api]);
 hashOwner.current=api;
 useEffect(()=>{controller.start();return()=>controller.stop();},[controller]);
 useEffect(()=>{
  if(previousOwner.current===api)return;
  const previous=previousOwner.current;previousOwner.current=api;
  clearSearchCache(previous);
 },[api,controller]);
 const snapshot=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot);
 return {controller,snapshot:snapshot.owner===api?snapshot:emptySearchSnapshot(api)};
}
export function SearchWorkspace({api,onOpen}:{api:Api;onOpen:(ref:string)=>void}) {
 useWorkspaceStyle();
 const availability=useDiscoveryState(api),supports=(path:string)=>!availability.inventoryError&&featureRequirementsAvailable(['http:GET:'+path],availability.inventory);
 const preview={read:supports('/api/materials/:id/read'),image:supports('/api/materials/:id/members')&&supports('/api/files/:id')&&supports('/api/files/:id/thumbnail')};
 const {controller,snapshot}=useSearchWorkspace(api);
 const {query,cursor,memoryCursor,selected,deviceId,sourceId,after,before}=snapshot;
 const selectedMemory=selected?.startsWith('memory:')?selected.slice(7):undefined;
 const devices={...snapshot.devices,refresh:()=>controller.refresh('devices')};
 const localDate=(value:string)=>{if(!value)return '';const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);};
 const scope={...(deviceId?{deviceId}:{}),...(after?{after}:{}),...(before?{before}:{})};
 const page={...snapshot.page,refresh:()=>controller.refresh('page')};
 const memories={...snapshot.memories,refresh:()=>controller.refresh('memories')};
 const materials=page.error===undefined?page.data?.items:undefined, memoryItems=memories.error===undefined?memories.data?.items:undefined;
 const update=(patch:Partial<SearchState>)=>controller.update(patch);
 const select=(ref:string)=>controller.select(ref);
 const close=()=>controller.close();
 const ask=()=>openQuestionDraft(api,snapshot.input.trim());
 const changeScope=(patch:Partial<SearchState>)=>controller.changeScope(patch);
 const count=(items:unknown[]|undefined,next?:string|null)=>items?moteText('本页 {0} 项',items.length):moteText('正在读取…');
 const pager=(stream:'cursor'|'memoryCursor',next?:string|null)=>(snapshot[stream]||next)&&<div className="search-pagination">{snapshot[stream]&&<button className="text-button" onClick={()=>update({[stream]:undefined,selected:undefined})}>{moteText('返回第一页')}</button>}{next&&<button className="text-button" onClick={()=>update({[stream]:next,selected:undefined})}>{moteText('下一页')}</button>}</div>;
 const error=(resource:{error?:unknown;refresh:()=>void},stream:'cursor'|'memoryCursor')=>{const invalid=resource.error instanceof ApiError&&resource.error.status===409;return resource.error!==undefined&&<p role="alert" className="notice error">{invalid?moteText('资料目录已变化，请返回第一页继续浏览。'):errorMessage(resource.error)} <button className="text-button" onClick={invalid?()=>update({[stream]:undefined,selected:undefined}):resource.refresh}>{moteText(invalid?'返回第一页':'重新读取')}</button></p>;};
 return <section className="search-workspace final-search">{selectedMemory&&<MemoryDetailPage api={api} id={selectedMemory} scope={scope} onOpen={onOpen} onBack={close}/>}<div className="search-surface" hidden={Boolean(selectedMemory)}><div className="page-heading"><h1>{moteText('搜索资料')}</h1><a className="text-button" href="#/ask?history=1">{moteText('对话历史')} →</a></div><form className="workspace-search" onSubmit={event=>{event.preventDefault();controller.submit();}}><input aria-label={moteText('搜索内容')} placeholder={moteText('搜索已有资料')} autoComplete="off" value={snapshot.input} onChange={event=>controller.setInput(event.target.value)} maxLength={500}/><button className="button primary">{moteText('搜索')}</button></form><div className="search-options"><nav className="view-tabs" aria-label={moteText('搜索与提问')}><button type="button" aria-pressed="true">{moteText('搜索')}</button><button type="button" onClick={ask}>{moteText('问一问')} ↗</button></nav><button className="text-button" aria-expanded={snapshot.filterOpen} onClick={()=>controller.toggleFilter()}>{moteText('筛选')}</button></div><div className="search-filters" hidden={!snapshot.filterOpen}><label>{moteText('设备')}<select value={deviceId} onChange={event=>changeScope({deviceId:event.target.value})}><option value="">{moteText('全部设备')}</option>{deviceId&&!devices.data?.items.some(item=>item.deviceId===deviceId)&&<option value={deviceId}>{deviceId}</option>}{!devices.error&&devices.data?.items.map(item=><option key={item.deviceId} value={item.deviceId}>{item.deviceName}</option>)}</select></label><label>{moteText('来源')}<select value={sourceId} onChange={event=>changeScope({sourceId:event.target.value})}><option value="">{moteText('全部来源')}</option>{sourceId&&!page.data?.sources.some(item=>item.id===sourceId)&&<option value={sourceId}>{sourceId}</option>}{!page.error&&page.data?.sources.map(item=><option key={item.id} value={item.id}>{item.label}</option>)}</select></label>{(['after','before'] as const).map((key,index)=><label key={key}>{moteText(index?'至':'从')}<input value={localDate(snapshot[key])} type="datetime-local" onChange={event=>changeScope({[key]:event.target.value?new Date(event.target.value).toISOString():''})}/></label>)}{devices.error!==undefined&&<p role="alert">{errorMessage(devices.error)} <button className="text-button" onClick={devices.refresh}>{moteText('重新读取')}</button></p>}<button className="text-button" onClick={()=>changeScope({deviceId:'',sourceId:'',after:'',before:''})}>{moteText('清除筛选')}</button></div><div className="search-library library-archive"><LibraryBrowseLayout api={api} reference={selectedMemory?undefined:selected} onClose={close} onOpen={onOpen}>
 {query?<>{error(page,'cursor')}{(page.loading&&!page.data)&&<p role="status">{moteText('正在读取…')}</p>}{materials&&(materials.length>0||page.data?.nextCursor||cursor)&&<section className="search-result-group library-materials"><div className="section-head"><h2>{moteText('资料')}</h2><span>{count(materials,page.data?.nextCursor)}</span></div><div className="search-records">{materials.map(entry=>entry.entryType==='capture'?<OriginalNoteRow key={entry.ref} entry={entry} onOpen={select}/>:<SearchMaterialRow key={entry.ref} api={api} item={entry.material} type={page.data?.types?.find(type=>type.kind===entry.material.kind&&type.schemaVersion===entry.material.schemaVersion)} source={page.data?.sources?.find(source=>source.id===entry.material.origin.sourceId)?.label} selected={selected===entry.ref} onSelect={select} preview={preview} sourceView={supports('/api/materials/:id/source-view')}/>)}</div>{pager('cursor',page.data?.nextCursor)}</section>}{<>{error(memories,'memoryCursor')}{memories.loading&&!memories.data&&<p role="status">{moteText('正在读取…')}</p>}{memoryItems&&(memoryItems.length>0||memories.data?.nextCursor||memoryCursor)&&<section className="search-result-group search-memory-section"><div className="section-head"><h2>{moteText('记忆')}</h2><span>{count(memoryItems,memories.data?.nextCursor)}</span></div>{memoryItems.map(item=><button className="library-record search-record search-memory-row" data-reference={'memory:'+item.id} key={item.id} onClick={()=>select('memory:'+item.id)}><span className="search-memory-symbol" aria-hidden="true">◇</span><span className="library-record-copy"><span className="search-memory-title"><strong>{item.title}</strong>{item.status==='stale'&&<small className="memory-status-badge">{moteText('需重验')}</small>}</span><span className="search-memory-summary">{item.statement}</span><small>{(item.evidenceCount??item.evidenceIds?.length??item.evidence?.length)!==undefined&&<>{moteText('{0} 份依据',item.evidenceCount??item.evidenceIds?.length??item.evidence?.length)} · </>}{Number.isFinite(Date.parse(item.updatedAt??item.createdAt))&&moteText('更新于 {0}',dateTime(item.updatedAt??item.createdAt))}</small></span><ChevronRight size={13}/></button>)}{pager('memoryCursor',memories.data?.nextCursor)}</section>}</>}{materials?.length===0&&memoryItems?.length===0&&!page.data?.nextCursor&&!memories.data?.nextCursor&&<div className="library-empty"><h2>{moteText('没有匹配的资料')}</h2><button className="text-button" onClick={ask}>{moteText('把这个问题交给 Mote')} →</button></div>}</>:<div className="library-empty"><h2>{moteText('找回已有的资料')}</h2></div>}
 </LibraryBrowseLayout></div></div></section>;
}

/** Existing source/body formats distinguish readable excerpts from raw metadata. */
function SearchMaterialRow({sourceView,...props}:ComponentProps<typeof LibraryMaterialRow>&{sourceView:boolean}){
 const item:Material=props.item,source=sourceItemKinds.some(kind=>item.kind==='mote.'+kind)&&[1,2].includes(item.schemaVersion),note=item.kind==='mote.note'&&[1,2].includes(item.schemaVersion);
 const path=source&&sourceView?'/api/materials/'+encodeURIComponent(item.id)+'/source-view?'+new URLSearchParams({revision:item.revision,length:'240'}):note&&props.preview?.read?'/api/materials/'+encodeURIComponent(item.id)+'/read?'+new URLSearchParams({revision:item.revision,offset:'0',length:'240'}):null;
 const page=useResource<{material:{ref:string};text:string;items?:{type:string;text:string}[];spans?:{kind:string;format?:string;pageRange:{start:number;end:number}}[]}>(props.api,path);
 const value=page.error===undefined&&page.data?.material?.ref===item.ref?page.data:undefined;
 const excerpt=value?(source?(value.items??[]).filter(block=>block.type==='text'||block.type==='source').map(block=>block.text).join('\n'):materialTextExcerpt(value)):'';
 return <LibraryMaterialRow {...props} preview={{read:!source&&!note&&Boolean(props.preview?.read),image:Boolean(props.preview?.image)}} presentationText={source||note?excerpt:undefined}/>;
}
