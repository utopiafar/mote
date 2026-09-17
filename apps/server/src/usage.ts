import { moteText } from './i18n.js';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {usageIdentity,usageLabel,type TokenUsage,type UsageReceipt,type ModelPrice,type UsageAttribution,type UsageTotals,type UsageSummary,type UsageFilters,type UsageGroupBy,type UsageGroup} from '@mote/shared';
import {Store} from './store.js';

export const priceSchema=z.object({provider:z.string().min(1).max(128),model:z.string().min(1).max(512),currency:z.enum(['USD','CNY']),input:z.number().finite().min(0).max(1e6),output:z.number().finite().min(0).max(1e6),cacheRead:z.number().finite().min(0).max(1e6),cacheWrite:z.number().finite().min(0).max(1e6)}).strict();
export function estimateCost(tokens:TokenUsage|undefined,price:ModelPrice|undefined):number|null {
  if(!tokens||!price||!tokens.requests||tokens.requests!==tokens.reportedRequests||tokens.cacheReadTokens===undefined||tokens.cacheWriteTokens===undefined)return null;
  const uncached=tokens.inputTokens-tokens.cacheReadTokens-tokens.cacheWriteTokens;
  if(uncached<0)return null;
  return (uncached*price.input+tokens.outputTokens*price.output+tokens.cacheReadTokens*price.cacheRead+tokens.cacheWriteTokens*price.cacheWrite)/1e6;
}
export class UsageLedger {
  constructor(private readonly store:Store){
    store.db.exec('CREATE TABLE IF NOT EXISTS model_usage(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS model_usage_created ON model_usage(created_at); CREATE TABLE IF NOT EXISTS model_prices(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
    for(const row of store.db.prepare("SELECT json FROM model_usage WHERE json_extract(json,'$.status')='running'").all() as {json:string}[]){const receipt=JSON.parse(row.json);this.save({...receipt,status:'failed',estimatedCost:null});}
  }
  prices():ModelPrice[]{return (this.store.db.prepare('SELECT json FROM model_prices ORDER BY id').all() as {json:string}[]).map(r=>JSON.parse(r.json));}
  setPrice(body:unknown){const price=priceSchema.parse(body);this.store.reserveMetadata(2048);this.store.db.prepare('INSERT INTO model_prices VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(JSON.stringify([price.provider,price.model]),JSON.stringify(price));return price;}
  private save(receipt:UsageReceipt){this.store.db.prepare('INSERT INTO model_usage VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(receipt.id,receipt.createdAt,JSON.stringify(receipt));}
  start(provider:string,model:string,operation:string,attribution?:UsageAttribution){
    this.store.reserveMetadata(4096);
    const price=this.prices().find(p=>p.provider===provider&&p.model===model),started=Date.now();
    const receipt:UsageReceipt={id:randomUUID(),provider,model,operation,...(attribution?{attribution:structuredClone(attribution)}:{}),createdAt:new Date(started).toISOString(),durationMs:0,status:'running',estimatedCost:null,currency:price?.currency??'USD',...(price?{price:structuredClone(price)}:{})};
    this.save(receipt);
    return {
      update:(tokens:TokenUsage)=>{receipt.tokens=structuredClone(tokens);receipt.durationMs=Date.now()-started;receipt.estimatedCost=estimateCost(tokens,price);this.save(receipt);},
      finish:(status:'completed'|'failed')=>{receipt.status=status;receipt.durationMs=Date.now()-started;this.save(receipt);return structuredClone(receipt);},
    };
  }
  summary(from:string,to:string,timeZone:string,filters:UsageFilters={},groupBy:UsageGroupBy='agent',page=1,pageSize=20):UsageSummary {
    const day=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
    const scoped=(this.store.db.prepare('SELECT json FROM model_usage WHERE created_at>=? AND created_at<? ORDER BY created_at DESC,id DESC').all(new Date(Date.parse(from)-86400000).toISOString(),new Date(Date.parse(to)+172800000).toISOString()) as {json:string}[])
      .map(r=>JSON.parse(r.json) as UsageReceipt).filter(r=>{const d=day.format(new Date(r.createdAt));return d>=from&&d<=to;});
    const facets:UsageSummary['facets']={agentId:[],moduleId:[],skillId:[]};
    for(const [field,dimension] of [['agentId','agent'],['moduleId','module'],['skillId','skill']] as const){
      facets[field]=[...new Set(scoped.map(r=>usageIdentity(r)[field]))].map(id=>({id,label:usageLabel(dimension,id)})).sort((a,b)=>a.label.localeCompare(b.label));
    }
    const rows=scoped.filter(r=>{
      const values={...usageIdentity(r),provider:r.provider,model:r.model,status:r.status};
      return (Object.keys(filters) as (keyof UsageFilters)[]).every(k=>filters[k]===undefined||values[k]===filters[k]);
    });
    const days=new Map<string,UsageReceipt[]>(),groups=new Map<string,{label:string;filter:UsageFilters;items:UsageReceipt[]}>();
    for(const row of rows){
      const date=day.format(new Date(row.createdAt));
      const bucket=days.get(date)??[];bucket.push(row);days.set(date,bucket);
      const identity=usageIdentity(row);
      const field=groupBy==='agent'?'agentId':groupBy==='module'?'moduleId':'skillId';
      const id=groupBy==='provider'?row.provider:groupBy==='model'?JSON.stringify([row.provider,row.model]):identity[field];
      const group=groups.get(id)??{label:groupBy==='provider'?row.provider:groupBy==='model'?`${row.provider} · ${row.model||moteText("未知模型")}`:usageLabel(groupBy,id),filter:groupBy==='provider'?{provider:row.provider}:groupBy==='model'?{provider:row.provider,model:row.model}:{[field]:id},items:[]};
      group.items.push(row);groups.set(id,group);
    }
    const grouped:UsageGroup[]=[...groups].map(([id,g])=>({id,label:g.label,filter:g.filter,...usageTotals(g.items)}));
    grouped.sort((a,b)=>b.totalTokens-a.totalTokens||b.runs-a.runs||a.id.localeCompare(b.id));
    return {from,to,timeZone,groupBy,filters,total:usageTotals(rows),days:[...days].sort(([a],[b])=>b.localeCompare(a)).map(([date,items])=>({date,...usageTotals(items)})),groups:grouped,facets,items:rows.slice((page-1)*pageSize,page*pageSize),itemsTotal:rows.length,page,pageSize,prices:this.prices()};
  }
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
    unknownUsage:items.filter(r=>!r.tokens||!r.tokens.requests||r.tokens.requests!==r.tokens.reportedRequests).length,
    unknownCache:items.filter(r=>!r.tokens||r.tokens.cacheReadTokens===undefined).length,
    unpriced:items.filter(r=>r.estimatedCost===null).length,
    costs:Object.fromEntries(['USD','CNY'].map(c=>{const priced=items.filter(r=>r.currency===c&&r.estimatedCost!==null);return [c,priced.length?priced.reduce((n,r)=>n+r.estimatedCost!,0):null];})),
  };
}
