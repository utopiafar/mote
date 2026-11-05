import type { ContentItem, LocalContentPage, ContentDetail, CentralContentPage } from './contracts/content';
export type { ContentItem, LocalContentPage, ContentDetail, CentralContentPage } from './contracts/content';
import {sourceSchema,sourceItemSchema} from '@mote/shared';
import {noteBody} from './note-presentation';
import { moteText } from '@mote/shared/i18n';
import { previewWork, sourceWork } from './background';
import type { DurableQueue } from './queue';
import type { LocalSourceManager } from './source-manager';
import type { SyncSource } from './sync-history';

const sourceKind=(kind:string):SyncSource=>kind==='local-calendar'?'calendar':kind==='coding-agent'?'coding':'file';
/** All content is evidence. The bounded reading surface never executes or interprets its text. */
function contentQuery(query?:string):string {if(query!==undefined&&(typeof query!=='string'||query.length>2000))throw Error(moteText('搜索内容过长'));return query?.trim().toLocaleLowerCase()??'';}
export function localContentPage(queue:DurableQueue,sources:LocalSourceManager,offset=0,query?:string,sourceId?:string):LocalContentPage {
  if(!Number.isSafeInteger(offset)||offset<0)throw Error(moteText('分页参数无效'));
  const needle=contentQuery(query),matches=(...values:(string|undefined)[])=>!needle||values.some(value=>value?.toLocaleLowerCase().includes(needle));
  const items:ContentItem[]=[...(sourceId?[]:queue.contentSummaries()).filter(record=>matches(record.appName,record.ocrText)).map(record=>({key:`queue:${record.id}`,source:record.source,title:record.source==='note'?record.ocrText?.split('\n')[0].slice(0,100)||moteText('记录'):record.appName,observedAt:record.capturedAt,preview:(record.ocrText??'').slice(0,160),sourceName:record.deviceName,error:record.syncError})),...sources.pendingContentSummaries().filter(row=>(!sourceId||row.sourceId===sourceId)&&matches(row.item.title,row.item.text)).map(({sourceId,sourceKind:kind,sourceName,item,key})=>({key:`source:${sourceId}:${key}`,source:sourceKind(kind),title:item.title,observedAt:item.observedAt,preview:item.text.slice(0,160),sourceName}))].sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||a.key.localeCompare(b.key));
  return {items:items.slice(offset,offset+30),total:items.length,...(offset+30<items.length?{nextOffset:offset+30}:{})};
}
export async function localContentDetail(queue:DurableQueue,sources:LocalSourceManager,key:string,image=false):Promise<ContentDetail>{
  if(typeof key!=='string'||key.length>160||typeof image!=='boolean')throw Error(moteText('记录标识无效'));
  if(key.startsWith('queue:')){
    const record=queue.recordForHistory(key.slice(6));if(!record)throw Error(moteText('该记录已完成同步，请切换到中央已归档查看'));
    const event=record.event;let text=event.source==='note'?noteBody(event.ocrText??'',event.metadata):event.ocrText??'';
    if(event.source==='activity')text=moteText('仅记录应用活动；未采集屏幕、窗口标题或正文');
    if(event.source==='notification'){const value=event.metadata?.notification;text=value?[value.title,value.text,value.bigText,value.subText,...(value.textLines??[])].filter(Boolean).join('\n'):text;}
    const bytes=image?await queue.imageForBrowser(event.id):undefined;
    return {sizeBytes:record.blobBytes||undefined,truncated:text.length>100000,text:text.slice(0,100000),description:event.metadata?.ownerDescription,sourceName:event.deviceName,metadata:JSON.stringify({capturedAt:event.capturedAt,appName:event.appName,durationMs:event.durationMs,stateSeries:event.stateSeries,metadata:event.metadata},null,2),hasImage:Boolean(record.blobHash),retainsOriginal:record.blobHash?true:undefined,...(bytes?{image:await previewWork.run<string>({kind:'preview',bytes,thumbnail:false})}:{})};
  }
  const [,id,version]=key.split(':');const source=sources.status().find(row=>row.source.id===id)?.source,item=sources.pendingForHistory(id,version);
  if(!source||!item)throw Error(moteText('本机副本已变化；尚无可读取的中央接收凭据。'));
  let text=item.text;
  if(!text&&item.mimeType?.startsWith('text/')){
    if(item.localOriginal&&item.localOriginal.sizeBytes<=512*1024)text=new TextDecoder('utf-8',{fatal:true}).decode(await sourceWork.run<Uint8Array>({kind:'original-part',spool:item.localOriginal,part:0}));
    else if(item.localOriginalBase64&&item.localOriginalBase64.length<700000)text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(item.localOriginalBase64,'base64'));
  }
  const context=sources.status().find(row=>row.source.id===id)?.context;
  return {sizeBytes:item.localOriginal?.sizeBytes??(item.localOriginalBase64?Buffer.from(item.localOriginalBase64,'base64').length:undefined),description:context?.pending?.description??context?.snapshot.description,truncated:text.length>100000,text:text.slice(0,100000),sourceName:source.name,metadataOnly:item.layer==='reference',retainsOriginal:item.kind==='file'?Boolean(item.localOriginal||item.localOriginalBase64):undefined,metadata:JSON.stringify({title:item.title,uri:item.uri,modifiedAt:item.modifiedAt,mimeType:item.mimeType,calendar:item.calendar,document:item.document},null,2)};
}

export async function centralContentPage(config:import('./contracts').Config,cursor?:string,search?:string):Promise<CentralContentPage>{
  const {requireConnectionToken}=await import('./login-session.js');const {validateServerUrl}=await import('./config.js');const {readResponseText}=await import('./response-body.js');
  if(cursor!==undefined&&(typeof cursor!=='string'||cursor.length>4096))throw Error(moteText('分页参数无效'));
  const needle=contentQuery(search);
  const query=new URLSearchParams({deviceId:config.deviceId,limit:'30',...(cursor?{cursor}:{}),...(needle?{query:needle}:{})});
  const response=await fetch(`${validateServerUrl(config.serverUrl)}${needle?'/api/context/search':'/api/capture-browser'}?${query}`,{headers:{Authorization:`Bearer ${requireConnectionToken(config)}`},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok){await response.body?.cancel();if(response.status===401||response.status===403)return {items:[],total:0,authorizationDenied:true};throw Error(moteText('无法访问采集记录，请检查中央连接权限'));}
  const page=JSON.parse(await readResponseText(response,1024*1024)) as {items:Record<string,unknown>[];totalCount:number;nextCursor?:string};
  if(needle){
    if(!Array.isArray(page.items)||page.items.length>30)throw Error(moteText('记录不属于当前设备'));
    const items=page.items.map(row=>{const origin=row.origin as Record<string,unknown>|undefined;
      if(typeof row.id!=='string'||!/^[a-f0-9-]{36}$/i.test(row.id)||origin?.deviceId!==config.deviceId||row.ref!==`capture:${row.id}`||!sourceSchema.safeParse(origin?.source).success)throw Error(moteText('记录不属于当前设备'));
      return {key:`capture:${row.id}`,source:origin.source==='message'?'coding' as const:sourceSchema.parse(origin.source),title:String(row.title??'').slice(0,200),observedAt:String(origin.capturedAt),preview:String(row.snippet??'').slice(0,160),sourceName:config.deviceName};});
    return {items,nextCursor:page.nextCursor??undefined};
  }
  if(!Array.isArray(page.items)||page.items.length>30||page.items.some(row=>typeof row.id!=='string'||!/^[a-f0-9-]{36}$/i.test(row.id)||row.deviceId!==config.deviceId||!sourceSchema.safeParse(row.source).success))throw Error(moteText('记录不属于当前设备'));
  return {items:page.items.map(row=>({key:`capture:${row.id}`,source:row.source==='message'?'coding':sourceSchema.parse(row.source),title:String(row.windowTitle??row.appName??'').slice(0,200),observedAt:String(row.capturedAt),preview:String(row.textPreview??row.ocrText??'').slice(0,160),sourceName:String(row.deviceName??config.deviceName)})),total:page.totalCount,nextCursor:page.nextCursor??undefined};
}

/** The existing source archive is scoped to this registered local source and device. */
export async function centralSourceContentPage(config:import('./contracts').Config,source:import('./source-types').LocalSource,cursor?:string):Promise<CentralContentPage>{
  const {requireConnectionToken}=await import('./login-session.js');const {validateServerUrl}=await import('./config.js');const {readResponseText}=await import('./response-body.js');
  if(cursor!==undefined&&(typeof cursor!=='string'||cursor.length>4096))throw Error(moteText('分页参数无效'));
  const query=new URLSearchParams({deviceId:config.deviceId,limit:'30',...(cursor?{cursor}:{})});
  const response=await fetch(`${validateServerUrl(config.serverUrl)}/api/sources/${encodeURIComponent(source.id)}/items?${query}`,{headers:{Authorization:`Bearer ${requireConnectionToken(config)}`},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok){await response.body?.cancel();if(response.status===401||response.status===403)return {items:[],authorizationDenied:true};if(response.status===404)return {items:[]};throw Error(moteText('内容暂不可完整读取，请重试。'));}
  const page=JSON.parse(await readResponseText(response,4*1024*1024)) as {items:Record<string,unknown>[];nextCursor?:string|null};
  if(!Array.isArray(page.items)||page.items.length>30||page.nextCursor!=null&&typeof page.nextCursor!=='string')throw Error(moteText('记录不属于当前设备'));
  const items=page.items.map(row=>{const {captureId,sourceId,receivedAt,current,...raw}=row;
    if(sourceId!==source.id||typeof captureId!=='string'||!/^[a-f0-9-]{36}$/i.test(captureId)||current!==true)throw Error(moteText('记录不属于当前设备'));
    const item=sourceItemSchema.parse(raw);if(item.deleted)throw Error(moteText('记录不属于当前设备'));
    return {key:`capture:${captureId}`,source:item.kind==='message'?'coding' as const:sourceSchema.parse(item.kind),title:item.title,observedAt:item.observedAt,preview:item.text.slice(0,160),sourceName:source.name};
  });
  return {items,nextCursor:page.nextCursor??undefined};
}
