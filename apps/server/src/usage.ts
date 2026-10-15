import { moteText } from './i18n.js';
import {randomUUID} from 'node:crypto';
import {hasCompleteTokenUsage,usageIdentity,usageLabel,type TokenUsage,type UsageReceipt,type ModelPrice,type UsageAttribution,type UsageTotals,type UsageSummary,type UsageFilters,type UsageGroupBy,type UsageGroup} from '@mote/shared';
import {Store} from './store.js';

export {priceSchema,estimateCost,usageTotals} from './usage-metrics.js';
import {priceSchema,estimateCost,usageTotals} from './usage-metrics.js';
export type OperationUsage={operationId:string;wallDurationMs:number;modelDurationMs:number;total:UsageTotals;items:UsageReceipt[]};
export class UsageLedger {
  constructor(private readonly store:Store){
    store.db.exec('CREATE TABLE IF NOT EXISTS model_usage(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS model_usage_created ON model_usage(created_at); CREATE TABLE IF NOT EXISTS model_prices(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
    for(const row of store.db.prepare("SELECT json FROM model_usage WHERE json_extract(json,'$.status')='running'").all() as {json:string}[]){
      const receipt=JSON.parse(row.json) as UsageReceipt;
      // An interrupted process cannot confirm that its last cumulative sample was final.
      if(receipt.tokens?.measurement==='thread_cumulative')receipt.tokens={...receipt.tokens,complete:false};
      this.save({...receipt,status:'failed',estimatedCost:null});
    }
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
  /** Fold every durable fragment receipt, including yielded coordinators,
   * delegated research, working context, writers and independent reviewers. */
  operation(operationId:string,createdAt?:string,finishedAt?:string):OperationUsage{
    const items=(this.store.db.prepare("SELECT json FROM model_usage WHERE json_extract(json,'$.attribution.operationId')=? ORDER BY created_at,id").all(operationId) as {json:string}[]).map(row=>JSON.parse(row.json) as UsageReceipt);
    const start=createdAt?Date.parse(createdAt):items.length?Math.min(...items.map(item=>Date.parse(item.createdAt))):Date.now();
    const end=finishedAt?Date.parse(finishedAt):items.length?Math.max(...items.map(item=>Date.parse(item.createdAt)+item.durationMs)):start;
    return {operationId,wallDurationMs:Math.max(0,end-start),modelDurationMs:items.reduce((sum,item)=>sum+item.durationMs,0),total:usageTotals(items),items};
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
