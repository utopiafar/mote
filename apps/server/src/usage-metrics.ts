import {z} from 'zod';
import {hasCompleteTokenUsage,type TokenUsage,type UsageReceipt,type ModelPrice,type UsageTotals} from '@mote/shared';

export const priceSchema=z.object({provider:z.string().min(1).max(128),model:z.string().min(1).max(512),currency:z.enum(['USD','CNY']),input:z.number().finite().min(0).max(1e6),output:z.number().finite().min(0).max(1e6),cacheRead:z.number().finite().min(0).max(1e6),cacheWrite:z.number().finite().min(0).max(1e6)}).strict();
export function estimateCost(tokens:TokenUsage|undefined,price:ModelPrice|undefined):number|null {
  if(!hasCompleteTokenUsage(tokens)||!price||tokens.cacheReadTokens===undefined||tokens.cacheWriteTokens===undefined)return null;
  const uncached=tokens.inputTokens-tokens.cacheReadTokens-tokens.cacheWriteTokens;
  if(uncached<0)return null;
  return (uncached*price.input+tokens.outputTokens*price.output+tokens.cacheReadTokens*price.cacheRead+tokens.cacheWriteTokens*price.cacheWrite)/1e6;
}
/** All views fold the same receipts; changing the grouping never duplicates costs. */
export function usageTotals(items:UsageReceipt[]):UsageTotals {
  const tokens=items.flatMap(r=>r.tokens?[r.tokens]:[]);
  const inputTokens=tokens.reduce((n,t)=>n+t.inputTokens,0),outputTokens=tokens.reduce((n,t)=>n+t.outputTokens,0);
  const eligible=tokens.filter(t=>t.cacheReadTokens!==undefined);
  const cacheInput=eligible.reduce((n,t)=>n+t.inputTokens,0),cacheReadTokens=eligible.reduce((n,t)=>n+t.cacheReadTokens!,0);
  const completed=items.filter(r=>r.status==='completed').length,failed=items.filter(r=>r.status==='failed').length;
  const durations=items.filter(r=>r.status!=='running').map(r=>r.durationMs).sort((a,b)=>a-b);
  return {
    runs:items.length,completed,failed,running:items.length-completed-failed,
    successRate:completed+failed?completed/(completed+failed):null,
    averageDurationMs:durations.length?durations.reduce((a,b)=>a+b,0)/durations.length:null,
    p95DurationMs:durations.length?durations[Math.ceil(durations.length*.95)-1]:null,
    requests:tokens.reduce((n,t)=>n+t.requests,0),reportedRequests:tokens.reduce((n,t)=>n+t.reportedRequests,0),
    inputTokens,outputTokens,totalTokens:inputTokens+outputTokens,cacheReadTokens,cacheHitRate:cacheInput?cacheReadTokens/cacheInput:null,
    unknownUsage:items.filter(r=>!hasCompleteTokenUsage(r.tokens)).length,
    ...(tokens.some(t=>t.measurement==='thread_cumulative')?{unknownRequestCounts:tokens.filter(t=>t.measurement==='thread_cumulative').length}:{}),
    unknownCache:items.filter(r=>!r.tokens||r.tokens.cacheReadTokens===undefined).length,
    unpriced:items.filter(r=>r.estimatedCost===null).length,
    costs:Object.fromEntries(['USD','CNY'].map(c=>{const priced=items.filter(r=>r.currency===c&&r.estimatedCost!==null);return [c,priced.length?priced.reduce((n,r)=>n+r.estimatedCost!,0):null];})),
  };
}
