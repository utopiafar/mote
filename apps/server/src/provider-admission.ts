import {ProviderFailure} from '@mote/shared';
import type {ModelSettings} from '@mote/shared/models';
import {sha256,type Store} from './store.js';
type Identity=Pick<ModelSettings,'protocol'|'provider'|'baseUrl'|'apiKey'|'headers'>;
/** Provider cooldown is shared across features/models using the same endpoint and
 * credentials. Only an opaque digest is persisted, never transport configuration. */
export class ProviderAdmission {
 constructor(private store:Store,private now=Date.now){store.db.exec('CREATE TABLE IF NOT EXISTS provider_cooldowns(scope TEXT PRIMARY KEY,code TEXT NOT NULL,until INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS provider_cooldown_expiry ON provider_cooldowns(until);');}
 private scope(settings:Identity){return sha256(JSON.stringify([settings.protocol,settings.provider,settings.baseUrl.replace(/\/+$/,''),settings.apiKey,Object.entries(settings.headers).sort(([a],[b])=>a.localeCompare(b))]));}
 check(settings:Identity){const row=this.store.db.prepare('SELECT code,until FROM provider_cooldowns WHERE scope=? AND until>?').get(this.scope(settings),this.now());if(row)throw new ProviderFailure({category:'transient',code:String(row.code),retryAfterMs:Math.max(0,Number(row.until)-this.now())});}
 async run<T>(settings:Identity,task:()=>Promise<T>){this.check(settings);try{return await task();}catch(error){
  if(error instanceof ProviderFailure&&error.details.category==='transient'&&['rate_limited','provider_unavailable','provider_timeout','provider_network'].includes(error.details.code)){
   const db=this.store.db,scope=this.scope(settings),now=this.now(),delay=error.details.retryAfterMs??30000,until=now+Math.max(1000,Math.min(Number.isFinite(delay)?delay:30000,7*86400000));
   db.prepare('DELETE FROM provider_cooldowns WHERE until<=?').run(now);if(!db.prepare('SELECT 1 FROM provider_cooldowns WHERE scope=?').get(scope))this.store.reserveMetadata(256);
   db.prepare('INSERT INTO provider_cooldowns VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET code=excluded.code,until=excluded.until WHERE excluded.until>provider_cooldowns.until').run(scope,error.details.code,until);
  }throw error;
 }}
 snapshot(){const row=this.store.db.prepare('SELECT count(*) n,min(until) next FROM provider_cooldowns WHERE until>?').get(this.now())!;return {coolingDown:Number(row.n),nextEligibleAt:row.next===null?null:Number(row.next)};}
}
