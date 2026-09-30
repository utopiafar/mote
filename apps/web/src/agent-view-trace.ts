import {moteText} from '@mote/shared/i18n';
export type InitialContext={request?:string;selectedTimeRange?:{after?:string;before?:string};selectedDeviceId?:string;timeZone?:string;untrustedMemoryLeads?:{id:string;title:string;statement:string;uncertainty?:string}[];conversation?:{turns?:unknown[];omittedTurns?:number};untrustedEvidence?:unknown[]};
export type TraceEvent={seq:number;at:string;truncated?:boolean;trace?:{type:string;runId?:string;tool?:string;status?:string;payload?:unknown;truncated?:boolean}};
export type RecordedRead={id?:string;ref?:string;title?:string;text:string;offset?:number;total?:number};
export function recordedReads(event:TraceEvent):RecordedRead[]{
 if(event.truncated||event.trace?.truncated||event.trace?.type!=='tool.completed'||event.trace.status==='failed')return [];
 const result=(event.trace.payload as {result?:unknown}|undefined)?.result;
 if(!result||typeof result!=='object')return [];
 const data=(result as {data?:unknown}).data??result;
 const items=Array.isArray(data)?data:typeof data==='object'&&data!==null&&Array.isArray((data as {items?:unknown}).items)?(data as {items:unknown[]}).items:[data];
 return items.slice(0,30).flatMap(item=>{
  if(!item||typeof item!=='object')return [];
  const row=item as Record<string,unknown>,text=typeof row.ocrText==='string'?row.ocrText:typeof row.text==='string'?row.text:typeof row.statement==='string'?row.statement:undefined;
  if(text===undefined)return [];
  const range=row.textRange as {offset?:unknown;total?:unknown}|undefined;
  return [{text,...(typeof row.id==='string'?{id:row.id}:{}),...(typeof row.ref==='string'?{ref:row.ref}:{}),...(typeof row.title==='string'?{title:row.title}:{}),...(typeof range?.offset==='number'?{offset:range.offset}:{}),...(typeof range?.total==='number'?{total:range.total}:{})}];
 });
}
/** Exact protocol fields only. Captured text is never executed or interpreted as UI instructions. */
export function recordedContext(event:TraceEvent):InitialContext|undefined{
 if(event.truncated||event.trace?.truncated||event.trace?.type!=='context.assembled')return;
 const payload=event.trace.payload as {prompt?:unknown}|undefined;
 if(typeof payload?.prompt!=='string')return;
 try{const context=JSON.parse(payload.prompt);if(!context||typeof context!=='object'||typeof context.request!=='string')return;
  // Validate fields consumed by React; retain opaque fields only in the raw view.
  if(context.untrustedMemoryLeads!==undefined&&(!Array.isArray(context.untrustedMemoryLeads)||context.untrustedMemoryLeads.some((m:unknown)=>!m||typeof m!=='object'||['id','title','statement'].some(key=>typeof (m as Record<string,unknown>)[key]!=='string')||((m as Record<string,unknown>).uncertainty!==undefined&&typeof (m as Record<string,unknown>).uncertainty!=='string'))))return;
  for(const key of ['selectedDeviceId','timeZone'])if(context[key]!==undefined&&typeof context[key]!=='string')return;
  if(context.selectedTimeRange!==undefined&&(!context.selectedTimeRange||typeof context.selectedTimeRange!=='object'||['after','before'].some(key=>context.selectedTimeRange[key]!==undefined&&typeof context.selectedTimeRange[key]!=='string')))return;
  if(context.conversation!==undefined&&(!context.conversation||typeof context.conversation!=='object'||!Array.isArray(context.conversation.turns)||typeof context.conversation.omittedTurns!=='number'))return;
  if(context.untrustedEvidence!==undefined&&!Array.isArray(context.untrustedEvidence))return;
  return context;
 }catch{return;}
}
export function traceLabel(type:string){
 switch(type){case 'run.started':return moteText('开始运行');case 'instructions.assembled':return moteText('系统规则与工具');case 'context.assembled':return moteText('首次上下文');case 'tool.started':return moteText('调用工具');case 'tool.completed':return moteText('工具返回');case 'model.started':return moteText('模型请求');case 'model.completed':return moteText('模型返回');case 'validation.started':return moteText('校验回答');case 'validation.completed':return moteText('校验完成');case 'run.completed':return moteText('运行完成');case 'run.failed':return moteText('运行失败');default:return type;}
}
