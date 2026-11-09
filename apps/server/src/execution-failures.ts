import {ProviderFailure} from '@mote/shared';

/** Host metadata and explicitly retained typed-error identity. Never attach
 * prompts, request bodies, stderr or arbitrary provider prose. A caller may
 * retain an error name and a bounded one-line message only when that error is
 * produced by host code and the message is needed to diagnose an opaque task
 * failure; the sanitizer still bounds both fields. */
export type FailureContext={workId?:string;jobId?:string;batchId?:string;runId?:string;phase?:string;causeStepId?:string;causeCode?:string;causeState?:string;errorName?:string;errorDetail?:string};
const contexts=new WeakMap<object,FailureContext>();
const identity=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_.:@/-]{1,256}$/.test(value)?value:undefined;
const errorName=(value:unknown)=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(value)?value:undefined;
const errorDetail=(value:unknown)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,500)||undefined:undefined;
export function safeFailureContext(value:FailureContext):FailureContext {
 return Object.fromEntries(Object.entries(value).flatMap(([key,value])=>{
  if(key==='errorName'){const name=errorName(value);return name?[[key,name]]:[];}
  if(key==='errorDetail'){const detail=errorDetail(value);return detail?[[key,detail]]:[];}
  return ['workId','jobId','batchId','runId','phase','causeStepId','causeCode','causeState'].includes(key)&&identity(value)?[[key,value]]:[];
 }));
}
export function failureContext(error:unknown):FailureContext{return error&&typeof error==='object'?contexts.get(error)??{}:{};}
/** Retain a host-observable error identity for task diagnostics. Callers are
 * responsible for using this only where the error is produced by trusted host
 * or provider code, not where captured content can supply its message. */
export function retainErrorIdentity<T>(error:T):T {
 return error instanceof Error?retainFailureContext(error,{errorName:error.name,errorDetail:error.message}):error;
}
export function retainFailureContext<T>(error:T,value:FailureContext):T {
 if(error&&typeof error==='object')contexts.set(error,{...failureContext(error),...safeFailureContext(value)});
 return error;
}
/** Same-input paid recovery requires a typed temporary transport fact. */
export function recoverableProviderFailure(error:ProviderFailure):boolean {
 return error.details.category==='transient'&&['rate_limited','provider_network','provider_unavailable','provider_timeout'].includes(error.details.code);
}
