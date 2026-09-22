import {z} from 'zod';
import {ProviderFailure,type TokenUsage,type ModelPrice} from '@mote/shared';
import {StoreError,type Store} from './store.js';
import {estimateCost} from './usage.js';
const tokens=z.number().int().positive().max(1e12),cost=z.number().positive().max(1e9);
const limits=z.object({dailyTokens:tokens.nullable().default(null),dailyCost:cost.nullable().default(null),operationTokens:tokens.nullable().default(null),operationCost:cost.nullable().default(null),providerDailyTokens:z.record(tokens).default({}),providerDailyCost:z.record(cost).default({}),currency:z.enum(['USD','CNY']).default('USD')}).strict();
const settingsSchema=z.object({revision:z.number().int().nonnegative(),limits});
type Settings=z.infer<typeof settingsSchema>;
type Request={id:string;operationId:string;provider:string;model:string;inputTokens:number;outputTokens:number;price?:ModelPrice};
/** Reservations and settlement share the SQLite writer lock across all model features.
 * Unknown usage retains the conservative reservation; it never releases a balance as zero. */
export class ModelBudgets {
 constructor(private store:Store,private now=Date.now){store.db.exec(`CREATE TABLE IF NOT EXISTS model_budget_reservations(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,day TEXT NOT NULL,currency TEXT NOT NULL,tokens INTEGER NOT NULL,cost REAL,status TEXT NOT NULL,revision INTEGER NOT NULL,requests INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS model_budget_day ON model_budget_reservations(day,provider);CREATE INDEX IF NOT EXISTS model_budget_operation ON model_budget_reservations(operation_id);`);}
 settings():Settings{const row=this.store.db.prepare("SELECT value FROM settings WHERE key='model-budgets'").get();return settingsSchema.parse(row?JSON.parse(String(row.value)):{revision:0,limits:{}});}
 configure(raw:unknown){
  const value=settingsSchema.strict().parse(raw),db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
  try{const current=this.settings();if(current.revision!==value.revision)throw new StoreError('Budget settings changed; refresh before saving',409);const next={...value,revision:value.revision+1};this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(next)));db.prepare("INSERT INTO settings VALUES('model-budgets',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));if(own)db.exec('COMMIT');return this.view();}
  catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
 }
 enabled(provider?:string){const l=this.settings().limits;return l.dailyTokens!==null||l.dailyCost!==null||l.operationTokens!==null||l.operationCost!==null||(provider?l.providerDailyTokens[provider]!==undefined:Object.keys(l.providerDailyTokens).length>0)||(provider?l.providerDailyCost[provider]!==undefined:Object.keys(l.providerDailyCost).length>0);}
 private failure(code:string):never{throw new ProviderFailure({category:'blocked',code});}
 requireBoundedRuntime(provider?:string){if(this.enabled(provider))this.failure('budget_unbounded_runtime');}
 reserve(request:Request){
  if(!this.enabled(request.provider))return;
  if(!Number.isSafeInteger(request.inputTokens)||request.inputTokens<0||!Number.isSafeInteger(request.outputTokens)||request.outputTokens<0)throw new StoreError('Invalid model reservation',400);
  const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
  try{
   const prior=db.prepare('SELECT * FROM model_budget_reservations WHERE id=?').get(request.id);
   const settings=this.settings(),l=settings.limits,day=prior?String(prior.day):new Date(this.now()).toISOString().slice(0,10),amount=request.inputTokens+request.outputTokens,price=request.price;
   const priced=price&&price.currency===l.currency,estimated=priced?(request.inputTokens*Math.max(price.input,price.cacheRead,price.cacheWrite)+request.outputTokens*price.output)/1e6:null;
   if((l.dailyCost!==null||l.operationCost!==null||l.providerDailyCost[request.provider]!==undefined)&&estimated===null)this.failure('budget_price_required');
   if(prior&&(prior.status!=='active'||prior.operation_id!==request.operationId||prior.provider!==request.provider||prior.model!==request.model||prior.currency!==l.currency))throw new StoreError('Model reservation identity conflict',409);
   const sum=(where:string,args:(string|number)[])=>db.prepare(`SELECT coalesce(sum(tokens),0) tokens,coalesce(sum(CASE WHEN currency=? THEN cost ELSE 0 END),0) cost,sum(CASE WHEN cost IS NULL OR currency!=? THEN 1 ELSE 0 END) unknown FROM model_budget_reservations WHERE ${where}`).get(l.currency,l.currency,...args)!;
   const check=(scope:ReturnType<typeof sum>,tokenLimit:number|null|undefined,costLimit:number|null|undefined)=>{if(tokenLimit!=null&&Number(scope.tokens)+amount>tokenLimit)this.failure('model_token_budget');if(costLimit!=null&&(Number(scope.unknown)>0||Number(scope.cost)+(estimated??0)>costLimit))this.failure('model_cost_budget');};
   check(sum('day=?',[day]),l.dailyTokens,l.dailyCost);check(sum('day=? AND provider=?',[day,request.provider]),l.providerDailyTokens[request.provider],l.providerDailyCost[request.provider]);check(sum('operation_id=?',[request.operationId]),l.operationTokens,l.operationCost);
   if(!prior)this.store.reserveMetadata(512);
   db.prepare(`INSERT INTO model_budget_reservations VALUES(?,?,?,?,?,?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET tokens=tokens+excluded.tokens,cost=CASE WHEN cost IS NULL OR excluded.cost IS NULL THEN NULL ELSE cost+excluded.cost END,requests=requests+1,updated_at=excluded.updated_at`).run(request.id,request.operationId,request.provider,request.model,day,l.currency,amount,estimated,'active',settings.revision,this.now());
   if(own)db.exec('COMMIT');
  }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
 }
 finish(id:string,usage?:TokenUsage,price?:ModelPrice){
  const row=this.store.db.prepare('SELECT * FROM model_budget_reservations WHERE id=?').get(id);if(!row||row.status!=='active')return;
  const complete=usage&&usage.requests>=Number(row.requests)&&usage.requests===usage.reportedRequests&&Number.isSafeInteger(usage.totalTokens)&&usage.totalTokens>=0;
  const actual=complete&&price?.currency===row.currency?estimateCost(usage,price):null;
  this.store.db.prepare('UPDATE model_budget_reservations SET tokens=?,cost=?,status=?,updated_at=? WHERE id=? AND status=\'active\'').run(complete?usage.totalTokens:row.tokens,actual??row.cost,complete&&actual!==null?'settled':'unknown',this.now(),id);
 }
 view(){const settings=this.settings(),day=new Date(this.now()).toISOString().slice(0,10),rows=this.store.db.prepare('SELECT provider,currency,sum(tokens) tokens,sum(cost) cost,sum(status=\'active\') active,sum(status=\'unknown\') unknown,count(*) runs FROM model_budget_reservations WHERE day=? GROUP BY provider,currency').all(day);return {...settings,day,timeZone:'UTC',usage:rows};}
}
