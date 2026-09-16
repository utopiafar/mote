import type {TokenUsage} from '@mote/shared';
import type {HarnessNotification} from '@deepseek-ai/dsh-sdk-client';
import {reportProgress,type QueryInput} from './types.js';

type Sample = Omit<TokenUsage,'requests'|'reportedRequests'>;
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Harness inputTokens excludes cache buckets; output already includes reasoning. */
export function usageSample(value: unknown, omittedCacheIsZero = false): Sample | undefined {
  const u=value as Record<string,unknown>|undefined;
  if(!u||!count(u.inputTokens)||!count(u.outputTokens))return;
  for(const key of ['cacheReadTokens','cacheWriteTokens','reasoningTokens','totalTokens'])if(u[key]!==undefined&&!count(u[key]))return;
  let read=u.cacheReadTokens as number|undefined,write=u.cacheWriteTokens as number|undefined;
  const known=u.inputTokens+(read??0)+(write??0);
  const total=u.totalTokens??(read!==undefined&&write!==undefined?known+u.outputTokens:undefined);
  if(!count(total)||total-u.outputTokens<known||(read!==undefined&&write!==undefined&&total!==known+u.outputTokens)||(count(u.reasoningTokens)&&u.reasoningTokens>u.outputTokens))return;
  // pi-ai deliberately drops zero cache buckets. DeepSeek does not: a missing
  // read bucket stays unknown. With a known read count the disjoint exact total
  // proves the remaining write bucket arithmetically.
  if(omittedCacheIsZero&&total===known+u.outputTokens){read??=0;write??=0;}
  if(read!==undefined&&write===undefined)write=total-u.outputTokens-u.inputTokens-read;
  return {inputTokens:total-u.outputTokens,outputTokens:u.outputTokens,totalTokens:total,
    ...(read!==undefined?{cacheReadTokens:read}:{}),...(write!==undefined?{cacheWriteTokens:write}:{}),
    ...(count(u.reasoningTokens)?{reasoningTokens:u.reasoningTokens}:{})};
}
/** Last sample replaces an attempt; retries and JSON repairs add new attempts. No text escapes. */
export function observeHarness(input:QueryInput,sessionId:string,omittedCacheIsZero=false) {
  const attempts=new Map<string,Sample|undefined>();
  let slot='',retry=0;
  const publish=()=>{
    const samples=[...attempts.values()].filter((s):s is Sample=>s!==undefined);
    const total:TokenUsage={requests:attempts.size,reportedRequests:samples.length,inputTokens:0,outputTokens:0,totalTokens:0};
    for(const s of samples){total.inputTokens+=s.inputTokens;total.outputTokens+=s.outputTokens;total.totalTokens+=s.totalTokens;}
    for(const k of ['cacheReadTokens','cacheWriteTokens','reasoningTokens'] as const)if(samples.length&&samples.every(s=>s[k]!==undefined))total[k]=samples.reduce((n,s)=>n+s[k]!,0);
    try{input.onUsage?.(total);}catch{/* Telemetry must not alter model execution. */}
  };
  return (notification:HarnessNotification)=>{
    if(notification.method!=='session.event'||notification.params.sessionId!==sessionId)return;
    const event=notification.params.event as {type:string;data:Record<string,any>};
    if(!event?.data)return;
    const d=event.data;
    if(event.type==='step/start'){
      retry=0;slot=`${d.turn}:${d.step}:${retry}`;attempts.set(slot,undefined);publish();
      reportProgress(input,{stage:'model',step:d.step,phase:'started'});
    }else if(event.type==='llm/retry-started'){
      slot=`${d.turn}:${d.step}:${++retry}`;attempts.set(slot,undefined);publish();
      reportProgress(input,{stage:'model',step:d.step,phase:'started'});
    }else if(event.type==='assistant/message'||event.type==='assistant/attempt'){
      const chunks=Array.isArray(d.stream)?d.stream:[];
      const sample=usageSample(d.usage??[...chunks].reverse().find(c=>c.type==='chunk'&&c.chunk?.type==='usage')?.chunk.usage,omittedCacheIsZero);
      if(slot&&slot.startsWith(`${d.turn}:${d.step}:`)){attempts.set(slot,sample);publish();}
    }
  };
}
