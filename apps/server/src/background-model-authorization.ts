import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ProviderFailure} from '@mote/shared';
import {sha256,StoreError,type Store} from './store.js';
import type {ExecutionStep} from './execution-engine.js';

/** Host identities only. None of these values grants access to an original;
 * every consumer must also enforce its existing source and privacy authority. */
export type ModelConnection={id:string;fingerprint:string};
export type ModelDisclosure={sourceId:string};
/** The owner switch. `excludedSourceIds` is the only remaining scope: new
 * sources participate by default, and an excluded source can be re-included. */
export type ModelAuthorityView={revision:number;state:'off'|'on';excludedSourceIds:string[]};
type State=ModelAuthorityView&{lastOperation?:string;lastCommand?:string};
export type AutomaticModelPurpose=`memory:${string}`|'memory'|'working'|'insight'|'activity'|'actions'|'image'|'file'|'embedding'|'semantic'|'integration'|'assistant';
type AutomaticWork={id:string;kind:'automatic';purpose:AutomaticModelPurpose;roots:string[]};
type ManualWork={id:string;kind:'manual'|'probe';roots:string[];connections:ModelConnection[]};
type Work=AutomaticWork|ManualWork;
type Authority={work:Work;controller:AbortController};
const sourceIds=z.array(z.string().min(1).max(256)).max(1000);
const command=z.object({
  revision:z.number().int().nonnegative(),
  operationId:z.string().uuid(),
  action:z.enum(['on','off','stop','exclude']),
  excludedSourceIds:sourceIds.optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.action==='exclude'){if(value.excludedSourceIds===undefined)ctx.addIssue({code:z.ZodIssueCode.custom,path:['excludedSourceIds'],message:'An exclusion command requires the excluded source list'});}
  else if(value.excludedSourceIds!==undefined)ctx.addIssue({code:z.ZodIssueCode.custom,path:['excludedSourceIds'],message:'Excluded sources are only accepted with the exclusion command'});
});
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
// An owner decision is not a short-lived provider capacity event. Keep the
// durable wait inexpensive while preserving the existing prospective consent
// checks and without spending an execution attempt.
export const BACKGROUND_MODEL_AUTHORIZATION_RECHECK_MS=60000;
const pending=()=>new ProviderFailure({category:'blocked',code:'background_model_authorization_required',executionStarted:false,admissionWaiting:true,retryAfterMs:BACKGROUND_MODEL_AUTHORIZATION_RECHECK_MS},'Background model processing needs owner authorization');

/** One durable owner switch and immutable original-receipt eligibility.
 * A lane, model login, source timestamp, retry or derived publication cannot
 * issue authority. Callers receive no serializable authority token. */
export class BackgroundModelAuthorization {
  private readonly context=new AsyncLocalStorage<Authority|undefined>();
  private readonly stepContext=new AsyncLocalStorage<string>();
  private readonly active=new Set<Authority>();
  private closed=false;
  // The batch owner participates in the existing stop transaction.
  private stopBatches?:()=>void;
  bindBatchStop(stop:()=>void){
    if(this.stopBatches)throw Error('Batch stop is already installed');
    this.stopBatches=stop;
    return ()=>{if(this.stopBatches===stop)this.stopBatches=undefined;};
  }
  constructor(private readonly store:Store,private readonly available:()=>ModelConnection[]){
    store.db.exec(`CREATE TABLE IF NOT EXISTS background_model_authorization(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS background_model_receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT,identity TEXT NOT NULL UNIQUE,source_id TEXT NOT NULL,eligible INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS background_model_lineage(identity TEXT NOT NULL,original TEXT NOT NULL,PRIMARY KEY(identity,original));
      CREATE TABLE IF NOT EXISTS background_model_work(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS background_model_trigger_claims(original TEXT NOT NULL,purpose TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES background_model_work(id),PRIMARY KEY(original,purpose));
      CREATE TABLE IF NOT EXISTS background_model_step_authority(step_id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES background_model_work(id));`);
    if(!store.db.prepare('SELECT 1 FROM background_model_authorization WHERE id=1').get()){
      const json=JSON.stringify({revision:0,state:'off',excludedSourceIds:[]} satisfies State);
      store.reserveMetadata(Buffer.byteLength(json)+128);store.db.prepare('INSERT INTO background_model_authorization VALUES(1,?)').run(json);
    }
  }
  private state():State{if(this.closed)throw pending();return JSON.parse(String(this.store.db.prepare('SELECT json FROM background_model_authorization WHERE id=1').get()!.json));}
  view():ModelAuthorityView{const {lastOperation:_,lastCommand:__,...view}=this.state();return view;}
  private transaction<T>(write:()=>T):T{const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{const result=write();if(own)db.exec('COMMIT');return result;}catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}}
  command(raw:unknown){
    const input=command.parse(raw),encoded=JSON.stringify(input);
    this.transaction(()=>{
      const state=this.state(),previousBytes=Buffer.byteLength(JSON.stringify(state));
      if(state.lastOperation===input.operationId){if(state.lastCommand!==encoded)throw new StoreError('Authorization operation was already used for a different request',409);return state;}
      if(state.revision!==input.revision)throw new StoreError('Model authorization changed; reload before continuing',409);
      if(input.action==='on')state.state='on';
      else if(input.action==='off'||input.action==='stop')state.state='off';
      else state.excludedSourceIds=[...input.excludedSourceIds!];
      state.revision++;state.lastOperation=input.operationId;state.lastCommand=encoded;
      const json=JSON.stringify(state);this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-previousBytes));
      this.store.db.prepare('UPDATE background_model_authorization SET json=? WHERE id=1').run(json);
      if(input.action==='stop')this.stopBatches?.();
      return state;
    });
    // Closing drains admitted work; immediate stop also aborts it. Re-excluding a
    // source aborts only the in-flight calls whose roots it now forbids.
    if(input.action==='stop')for(const authority of this.active)if(authority.work.kind==='automatic')authority.controller.abort(pending());
    if(input.action==='exclude')this.revalidateActive();
    return this.view();
  }
  /** Original intake only, in the same durable receive transaction. Record what
   * arrived and from which source; the switch decides later whether it runs. */
  receive(identity:string,disclosure:ModelDisclosure,eligible=true){
    if(!this.store.db.isTransaction)throw Error('Model receipt requires the original receive transaction');
    if(!identity||identity.length>2048)throw Error('Invalid original receipt identity');
    if(this.store.db.prepare('SELECT 1 FROM background_model_receipts WHERE identity=?').get(identity))return;
    this.store.reserveMetadata(Buffer.byteLength(identity+disclosure.sourceId)+128);
    this.store.db.prepare('INSERT INTO background_model_receipts(identity,source_id,eligible) VALUES(?,?,?)').run(identity,disclosure.sourceId,Number(eligible));
  }
  /** A deterministic projection only inherits existing roots. It cannot mint
   * an original receipt, and repeated publication cannot change its lineage. */
  derive(identity:string,originals:readonly string[]){
    if(this.closed)throw pending();
    if(!this.store.db.isTransaction)throw Error('Model lineage requires the publication transaction');
    const roots=[...new Set(originals.flatMap(original=>this.roots(original)))].sort();
    // Old retained data remains readable and deterministically rebuildable.
    // Missing original intake proof only prevents a new automatic trigger.
    if(!roots.length)return;
    const prior=this.store.db.prepare('SELECT original FROM background_model_lineage WHERE identity=? ORDER BY original').all(identity).map(row=>String(row.original));
    if(prior.length){if(!same(prior,roots))throw new StoreError('Published model authorization lineage changed',409);return;}
    const insert=this.store.db.prepare('INSERT INTO background_model_lineage VALUES(?,?)');for(const root of roots){this.store.reserveMetadata(Buffer.byteLength(identity+root)+64);insert.run(identity,root);}
  }
  roots(identity:string):string[]{
    if(this.closed)throw pending();
    if(this.store.db.prepare('SELECT 1 FROM background_model_receipts WHERE identity=?').get(identity))return [identity];
    return this.store.db.prepare('SELECT original FROM background_model_lineage WHERE identity=? ORDER BY original').all(identity).map(row=>String(row.original));
  }
  /** A root still participates only if it arrived as automatic input and its
   * source is not excluded. Exclusion is checked at trigger time, never frozen
   * into the receipt, so re-including a source backfills what it withheld. */
  private eligible(identity:string,state=this.state()){
    const receipt=this.store.db.prepare('SELECT source_id,eligible FROM background_model_receipts WHERE identity=?').get(identity) as {source_id:string;eligible:number}|undefined;
    return Boolean(receipt&&receipt.eligible===1&&!state.excludedSourceIds.includes(receipt.source_id));
  }
  /** A negative hint only: it cannot admit work or replace the disclosure check
   * at the model boundary. False means this original can run automatically now. */
  deniedOriginal(identity:string):boolean{
    const state=this.state(),roots=this.roots(identity);
    return state.state!=='on'||!roots.length||roots.some(root=>!this.eligible(root,state));
  }
  /** Host-derived grouping can contain historical context. Only received,
   * eligible, non-excluded, unconsumed originals become triggers; the context
   * remains subject to disclosure scope. Never call this with model-authored
   * catalog entries. */
  freshTriggers(identities:readonly string[],purpose:AutomaticModelPurpose):string[]{
    const state=this.state();if(state.state!=='on')return [];
    return [...new Set(identities.flatMap(identity=>this.roots(identity)))].filter(root=>this.eligible(root,state)&&!this.store.db.prepare('SELECT 1 FROM background_model_trigger_claims WHERE original=? AND purpose=?').get(root,purpose)).sort();
  }
  automaticTriggers(id:string,purpose:AutomaticModelPurpose):readonly string[]|undefined{const work=this.saved(id);if(!work)return;if(work.kind!=='automatic'||work.purpose!==purpose)throw new StoreError('Model operation has a different purpose',409);return [...work.roots];}
  /** Final product commits recheck the host-owned job without relying on the
   * request-local async authority that admitted the model fragment. */
  workState(id:string):'missing'|'current'|'revoked'{
    if(this.closed)return 'revoked';
    const work=this.saved(id);if(!work)return 'missing';
    try{this.assert(work);return 'current';}catch{return 'revoked';}
  }
  private save(work:Work){const json=JSON.stringify(work);this.store.reserveMetadata(Buffer.byteLength(json+work.id)+128);this.store.db.prepare('INSERT INTO background_model_work VALUES(?,?)').run(work.id,json);return work;}
  private saved(id:string):Work|undefined{if(this.closed)throw pending();const row=this.store.db.prepare('SELECT json FROM background_model_work WHERE id=?').get(id);return row?JSON.parse(String(row.json)):undefined;}
  /** Durable roots only. `off` drains admitted work, so the switch itself must
   * not invalidate an authority that was admitted before the owner closed it;
   * admission paths below check the switch instead. */
  private assert(work:Work){
    if(this.closed)throw pending();
    if(work.kind==='automatic'){
      const state=this.state();
      if(!work.roots.length||work.roots.some(root=>!this.eligible(root,state)))throw pending();
    }
  }
  private admit(work:Work){
    if(work.kind==='automatic'&&this.state().state!=='on')throw pending();
    this.assert(work);
  }
  /** Host-owned job identity. The exact original set is immutable on restart. */
  automatic(id:string,identities:readonly string[],purpose:AutomaticModelPurpose='memory'){
    return this.transaction(()=>{
      const roots=[...new Set(identities.flatMap(identity=>this.roots(identity)))].sort();
      if(!identities.length||identities.some(identity=>!this.roots(identity).length))throw pending();
      const prior=this.saved(id);
      if(prior){if(prior.kind!=='automatic'||prior.purpose!==purpose||!same(prior.roots,roots))throw new StoreError('Model work authorization scope changed',409);this.admit(prior);return id;}
      const state=this.state();if(state.state!=='on')throw pending();
      if(roots.some(root=>!this.eligible(root,state)))throw pending();
      if(roots.some(root=>this.store.db.prepare('SELECT 1 FROM background_model_trigger_claims WHERE original=? AND purpose=?').get(root,purpose)))throw pending();
      const work:AutomaticWork={id,kind:'automatic',purpose,roots};this.assert(work);this.save(work);
      for(const root of roots){this.store.reserveMetadata(Buffer.byteLength(root+purpose+id)+64);this.store.db.prepare('INSERT INTO background_model_trigger_claims VALUES(?,?,?)').run(root,purpose,id);}
      return id;
    });
  }
  /** Admit an automatic batch and its durable execution steps atomically.
   * Only host-proven original receipts can enter automatic(). */
  automaticCommand<T>(id:string,identities:readonly string[],purpose:AutomaticModelPurpose,task:()=>T):T{
    return this.transaction(()=>{
      this.automatic(id,identities,purpose);const work=this.saved(id)!;this.assert(work);
      const authority:Authority={work,controller:new AbortController()};this.active.add(authority);
      try{return this.context.run(authority,()=>{const result=task();if(result&&typeof (result as {then?:unknown}).then==='function')throw Error('Automatic command must be synchronous');this.assert(work);return result;});}
      finally{this.active.delete(authority);}
    });
  }
  /** Called only at an existing owner-confirmed operation boundary. Never
   * expose it as a QueryInput flag or accept a caller-provided authority. */
  manual(id:string,kind:'manual'|'probe',identities:readonly string[]=[],connections=this.available()){
    return this.transaction(()=>{const roots=[...new Set(identities)].sort(),prior=this.saved(id);if(prior){if(prior.kind!==kind||!same(prior.roots,roots))throw new StoreError('Manual model scope changed',409);return id;}this.save({id,kind,roots,connections:structuredClone(connections)});return id;});
  }
  /** Synchronous owner commands persist admission and their domain writes in
   * one transaction. Never hold the SQLite transaction across asynchronous work. */
  manualCommand<T>(id:string,identities:readonly string[],connections:ModelConnection[],task:()=>T):T{
    return this.transaction(()=>{
      this.manual(id,'manual',identities,connections);const work=this.saved(id)!;this.assert(work);
      const authority:Authority={work,controller:new AbortController()};this.active.add(authority);
      try{return this.context.run(authority,()=>{const result=task();if(result&&typeof (result as {then?:unknown}).then==='function')throw Error('Owner command must be synchronous');this.assert(work);return result;});}
      finally{this.active.delete(authority);}
    });
  }
  async run<T>(id:string,task:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    return this.runAuthorized(id,task,signal,false);
  }
  private async runAuthorized<T>(id:string,task:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal|undefined,admitted:boolean):Promise<T>{
    const work=this.saved(id);if(!work)throw pending();
    // A fresh attempt waits while the switch is off; a dependent fragment of
    // the same in-flight work has already been admitted and drains.
    if(work.kind==='automatic'&&this.state().state!=='on'&&!admitted&&this.context.getStore()?.work.id!==id)throw pending();
    this.assert(work);
    const stepId=this.stepContext.getStore();if(stepId)this.bindStep(stepId,id);
    const authority:Authority={work,controller:new AbortController()};this.active.add(authority);
    const combined=AbortSignal.any([authority.controller.signal,...(signal?[signal]:[])]);
    try{return await this.context.run(authority,async()=>{combined.throwIfAborted();const value=await task(combined);combined.throwIfAborted();this.assert(work);return value;});}
    finally{this.active.delete(authority);}
  }
  /** Each actual send and publication checks the same host-issued authority.
   * Automatic work uses the model configuration current at the call; only the
   * switch and the original receipts still fence it. */
  private assertConnection(authority:Authority,connection?:ModelConnection){
    if(authority.controller.signal.aborted)throw pending();
    this.assert(authority.work);
    if(authority.work.kind!=='automatic'&&connection&&!authority.work.connections.some(c=>same(c,connection)))throw pending();
  }
  assertCurrent(connection?:ModelConnection){const authority=this.context.getStore();if(!authority)throw pending();this.assertConnection(authority,connection);}
  get currentId(){return this.context.getStore()?.work.id;}
  get currentKind(){return this.context.getStore()?.work.kind;}
  ownerIntent(identity:string):string|undefined{const work=this.context.getStore()?.work;return work?.kind==='manual'&&work.roots.includes(identity)?work.id:undefined;}
  assertOwnerIntent(id:string,identity:string){const work=this.saved(id);if(!work||work.kind!=='manual'||!work.roots.includes(identity))throw pending();this.assert(work);}
  /** Native HTTP relays do not inherit AsyncLocalStorage. Capture the host
   * authority in a closure, never in a serializable plugin argument. */
  capture(connection?:ModelConnection){const authority=this.context.getStore();if(!authority)throw pending();return ()=>this.assertConnection(authority,connection);}
  private bindStep(stepId:string,id:string){const prior=this.store.db.prepare('SELECT work_id FROM background_model_step_authority WHERE step_id=?').get(stepId);if(prior&&prior.work_id!==id)throw new StoreError('Execution step already has a different model authority',409);if(!prior){this.store.reserveMetadata(Buffer.byteLength(stepId+id)+64);this.store.db.prepare('INSERT INTO background_model_step_authority VALUES(?,?)').run(stepId,id);}}
  stepAuthority(stepId:string){const row=this.store.db.prepare('SELECT work_id FROM background_model_step_authority WHERE step_id=?').get(stepId);return row?String(row.work_id):undefined;}
  inheritStep(parentId:string,childId:string){
    if(!this.store.db.isTransaction)throw Error('Dependent authority requires the publication transaction');
    const id=this.stepAuthority(parentId),work=id&&this.saved(id);if(!id||!work)throw pending();this.assert(work);this.bindStep(childId,id);
  }
  bindCurrentStep(step:ExecutionStep){return this.transaction(()=>this.captureStep(step));}
  captureStep(step:ExecutionStep){const id=this.currentId;if(id)this.bindStep(step.id,id);}
  assertStep(step:ExecutionStep){for(const row of this.store.db.prepare('SELECT work_id FROM background_model_step_authority WHERE step_id=?').all(step.id)){const work=this.saved(String(row.work_id));if(!work)throw pending();this.assert(work);}}
  commitStep<T>(step:ExecutionStep,task:()=>T):T{
    this.assertStep(step);
    const id=this.stepAuthority(step.id),work=id&&this.saved(id);
    if(!work)return this.context.run(undefined,task);
    const authority:Authority={work,controller:new AbortController()};
    return this.context.run(authority,()=>{this.assert(work);const result=task();this.assert(work);return result;});
  }
  async runStep<T>(step:ExecutionStep,task:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T>{
    this.assertStep(step);
    const row=this.store.db.prepare('SELECT work_id FROM background_model_step_authority WHERE step_id=?').get(step.id);
    // A shared executor must never inherit whichever HTTP request happened to
    // wake its timer. Only this exact durable step can restore manual authority.
    return this.stepContext.run(step.id,()=>row?this.runAuthorized(String(row.work_id),task,signal,step.kind==='batch.item'||step.kind==='batch.reduce'):this.context.run(undefined,()=>task(signal)));
  }
  /** Automatic disclosure only forbids currently excluded sources. Everything
   * else still passes through the existing source, privacy and read checks. */
  assertDisclosure(disclosures:readonly ModelDisclosure[]){
    const authority=this.context.getStore();if(!authority)throw pending();this.assert(authority.work);
    if(authority.work.kind!=='automatic')return;
    const excluded=new Set(this.state().excludedSourceIds);
    if(disclosures.some(disclosure=>excluded.has(disclosure.sourceId)))throw pending();
  }
  allowsDisclosure(disclosure:ModelDisclosure){try{this.assertDisclosure([disclosure]);return true;}catch{return false;}}
  /** Recheck the existing fences after trusted host invalidation; no new admission policy. */
  revalidateActive(){for(const authority of this.active)try{this.assert(authority.work);}catch(error){authority.controller.abort(error);}}
  close(){this.closed=true;for(const authority of this.active)authority.controller.abort();this.context.disable();this.stepContext.disable();}
}

/** Includes credential/header identity as a hash, never as persisted cleartext. */
export const modelConnection=(id:string,settings:unknown):ModelConnection=>({id,fingerprint:sha256(JSON.stringify(settings))});
export const manualModelOperation=()=>`manual-model:${randomUUID()}`;
