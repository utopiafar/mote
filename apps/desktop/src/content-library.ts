import { moteText } from '@mote/shared/i18n';
import { previewWork, sourceWork } from './background';
import type { DurableQueue } from './queue';
import type { LocalSourceManager } from './source-manager';
import type { SyncSource } from './sync-history';
export interface ContentItem { key:string;source:SyncSource;title:string;observedAt:string;preview:string;sourceName?:string;error?:string; }
export interface LocalContentPage {items:ContentItem[];total:number;nextOffset?:number;}
export interface ContentDetail {text:string;sourceName:string;metadata:string;hasImage?:boolean;image?:string;metadataOnly?:boolean;retainsOriginal?:boolean;truncated?:boolean;}
const sourceKind=(kind:string):SyncSource=>kind==='local-calendar'?'calendar':kind==='coding-agent'?'coding':'file';
/** All content is evidence. The bounded reading surface never executes or interprets its text. */
export function localContentPage(queue:DurableQueue,sources:LocalSourceManager,offset=0):LocalContentPage {
  if(!Number.isSafeInteger(offset)||offset<0)throw Error(moteText('分页参数无效'));
  const items:ContentItem[]=[...queue.contentRecords().map(record=>({key:`queue:${record.event.id}`,source:record.event.source,title:record.event.source==='note'?record.event.ocrText?.split('\n')[0].slice(0,100)||moteText('随手记'):record.event.appName,observedAt:record.event.capturedAt,preview:(record.event.ocrText??'').slice(0,160),sourceName:record.event.deviceName,error:record.syncError})),...sources.pendingContent().map(({source,item,key})=>({key:`source:${source.id}:${key}`,source:sourceKind(source.kind),title:item.title,observedAt:item.observedAt,preview:item.text.slice(0,160),sourceName:source.name}))].sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||a.key.localeCompare(b.key));
  return {items:items.slice(offset,offset+30),total:items.length,...(offset+30<items.length?{nextOffset:offset+30}:{})};
}
export async function localContentDetail(queue:DurableQueue,sources:LocalSourceManager,key:string,image=false):Promise<ContentDetail>{
  if(typeof key!=='string'||key.length>160||typeof image!=='boolean')throw Error(moteText('记录标识无效'));
  if(key.startsWith('queue:')){
    const record=queue.recordForHistory(key.slice(6));if(!record)throw Error(moteText('该记录已完成同步，请切换到中央已归档查看'));
    const event=record.event;let text=event.ocrText??'';
    if(event.source==='notification'){const value=event.metadata?.notification;text=value?[value.title,value.text,value.bigText,value.subText,...(value.textLines??[])].filter(Boolean).join('\n'):text;}
    const bytes=image?await queue.imageForBrowser(event.id):undefined;
    return {truncated:text.length>100000,text:text.slice(0,100000),sourceName:event.deviceName,metadata:JSON.stringify({capturedAt:event.capturedAt,appName:event.appName,durationMs:event.durationMs,metadata:event.metadata},null,2),hasImage:Boolean(record.blobHash),retainsOriginal:record.blobHash?true:undefined,...(bytes?{image:await previewWork.run<string>({kind:'preview',bytes,thumbnail:false})}:{})};
  }
  const [,id,version]=key.split(':');const source=sources.status().find(row=>row.source.id===id)?.source,item=sources.pendingForHistory(id,version);
  if(!source||!item)throw Error(moteText('本机副本已变化；尚无可读取的中央接收凭据。'));
  let text=item.text;
  if(!text&&item.mimeType?.startsWith('text/')){
    if(item.localOriginal&&item.localOriginal.sizeBytes<=512*1024)text=new TextDecoder('utf-8',{fatal:true}).decode(await sourceWork.run<Uint8Array>({kind:'original-part',spool:item.localOriginal,part:0}));
    else if(item.localOriginalBase64&&item.localOriginalBase64.length<700000)text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(item.localOriginalBase64,'base64'));
  }
  return {truncated:text.length>100000,text:text.slice(0,100000),sourceName:source.name,metadataOnly:item.layer==='reference',retainsOriginal:item.kind==='file'?Boolean(item.localOriginal||item.localOriginalBase64):undefined,metadata:JSON.stringify({title:item.title,uri:item.uri,modifiedAt:item.modifiedAt,mimeType:item.mimeType,calendar:item.calendar,document:item.document},null,2)};
}
export interface CentralContentPage {items:ContentItem[];total:number;nextCursor?:string;authorizationDenied?:true;}
export async function centralContentPage(config:import('./contracts').Config,cursor?:string):Promise<CentralContentPage>{
  const {requireConnectionToken}=await import('./login-session.js');const {validateServerUrl}=await import('./config.js');const {readResponseText}=await import('./response-body.js');
  if(cursor!==undefined&&(typeof cursor!=='string'||cursor.length>512))throw Error(moteText('分页参数无效'));
  const query=new URLSearchParams({deviceId:config.deviceId,limit:'30',...(cursor?{cursor}:{})});
  const response=await fetch(`${validateServerUrl(config.serverUrl)}/api/capture-browser?${query}`,{headers:{Authorization:`Bearer ${requireConnectionToken(config)}`},redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!response.ok){await response.body?.cancel();if(response.status===401||response.status===403)return {items:[],total:0,authorizationDenied:true};throw Error(moteText('无法访问采集记录，请检查中央连接权限'));}
  const page=JSON.parse(await readResponseText(response,1024*1024)) as {items:Record<string,unknown>[];totalCount:number;nextCursor?:string};
  if(!Array.isArray(page.items)||page.items.length>30||page.items.some(row=>typeof row.id!=='string'||!/^[a-f0-9-]{36}$/i.test(row.id)||row.deviceId!==config.deviceId))throw Error(moteText('记录不属于当前设备'));
  return {items:page.items.map(row=>({key:`capture:${row.id}`,source:row.source==='message'?'coding':row.source as SyncSource,title:String(row.windowTitle??row.appName??'').slice(0,200),observedAt:String(row.capturedAt),preview:String(row.textPreview??row.ocrText??'').slice(0,160),sourceName:String(row.deviceName??config.deviceName)})),total:page.totalCount,nextCursor:page.nextCursor??undefined};
}
