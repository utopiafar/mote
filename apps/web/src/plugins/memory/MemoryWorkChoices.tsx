import {useState} from 'react';
import {moteText} from '@mote/shared/i18n';
import {type Api,ApiError,dateTime,errorMessage} from '../../api';
import {useResource} from '../../useResource';
import {resources} from '../../resource-cache';
import type {OwnerBrowsePage} from '../../owner-library-browse';
import type {Memory} from './Memories';
import {currentIntegrationCandidate} from '../../MemoryIntegration';

export type ExtractionChoice={kind:'capture'|'material';ref:string;title:string;revision?:string};
/** Current owner read projections only. Selection never reconstructs a material or a Memory pin. */
export function MemoryWorkChoices({api,kind,deviceId,disabled,onMaterial,onMemory}:{api:Api;kind:'extract'|'integrate';deviceId?:string;disabled?:boolean;onMaterial:(value:ExtractionChoice)=>void;onMemory:(value:Memory)=>void}){
 const identity=JSON.stringify([kind,deviceId]),[paging,setPaging]=useState<{api:Api;identity:string;cursors:(string|undefined)[]}>({api,identity,cursors:[undefined]});
 const cursors=paging.api===api&&paging.identity===identity?paging.cursors:[undefined];
 const params=new URLSearchParams({limit:'10',...(deviceId?{deviceId}:{}),...(cursors.at(-1)?{cursor:cursors.at(-1)!}:{})});
 if(kind==='integrate')for(const [key,value]of Object.entries({layer:'memory',status:'published',level:'detail',includeHistory:'false',includeStale:'false'}))params.set(key,value);
 const path=(kind==='extract'?'/api/library/browse?':'/api/memories?')+params;
 const page=useResource<OwnerBrowsePage|{items:Memory[];nextCursor:string|null}>(api,path);
 const stale=page.error instanceof ApiError&&page.error.status===409,revoked=page.error instanceof ApiError&&[401,403,404,410].includes(page.error.status);
 const [discarded,setDiscarded]=useState<unknown>();
 const data=stale||revoked||page.data===discarded?undefined:page.data;
 const items=kind==='integrate'?(data?.items as Memory[]|undefined)?.filter(item=>currentIntegrationCandidate(item)):undefined;
 const materialItems=kind==='extract'?(data as OwnerBrowsePage|undefined)?.items:undefined;
 const reset=()=>{const first=new URLSearchParams(params);first.delete('cursor');const resource=resources(api).get((kind==='extract'?'/api/library/browse?':'/api/memories?')+first);setDiscarded(resource.getSnapshot().data);setPaging({api,identity,cursors:[undefined]});resource.refresh();};
 return <section className="memory-work-choices"><h2>{kind==='extract'?moteText('选择资料'):moteText('选择当前有效的记忆')}</h2>
 {page.error!==undefined&&<div role="alert"><p>{stale?moteText('分页内容已变化或游标无效，请返回第一页重新读取。'):errorMessage(page.error)}</p><button className="text-button" onClick={stale?reset:page.refresh}>{moteText('重新读取')}</button></div>}
 {page.loading&&!data&&<p role="status">{moteText('正在读取…')}</p>}
 {!page.loading&&!page.error&&!items?.length&&!materialItems?.length&&<p>{kind==='extract'?moteText('本页没有可选资料。'):moteText('本页没有可选的有效记忆。')}</p>}
 <div className="memory-work-choice-list">{items?.map(memory=><button type="button" key={memory.id} disabled={disabled} onClick={()=>onMemory(memory)}><span><strong>{memory.title}</strong><small>{moteText('以这条记忆作为整理起点')}</small></span><span aria-hidden="true">›</span></button>)}
 {materialItems?.map(entry=>{const material=entry.entryType==='material',title=material?entry.material.title:entry.capture.windowTitle||entry.capture.textPreview?.split('\n')[0]||moteText('原始记录');return <button type="button" key={entry.ref} disabled={disabled} onClick={()=>onMaterial({kind:material?'material':'capture',ref:entry.ref,title,revision:material?entry.material.revision:entry.revision})}><span><strong>{title}</strong><small>{dateTime(entry.contentAt)}</small></span><span aria-hidden="true">›</span></button>;})}</div>
 {(cursors.length>1||data?.nextCursor)&&<nav aria-label={moteText('选择资料')}><button className="text-button" disabled={page.loading||cursors.length===1} onClick={()=>setPaging({api,identity,cursors:cursors.slice(0,-1)})}>{moteText('上一页')}</button><span>{moteText('第 {0} 页',cursors.length)}</span><button className="text-button" disabled={page.loading||!data?.nextCursor} onClick={()=>{if(data?.nextCursor)setPaging({api,identity,cursors:[...cursors,data.nextCursor]});}}>{moteText('下一页')}</button></nav>}
 </section>;
}
