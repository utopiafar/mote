import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {ProviderFailure} from '@mote/shared';
import {sha256,StoreError,type Store} from './store.js';
import type {ExecutionStep} from './execution-engine.js';

/** Host identities only. None of these values grants access to an original;
 * every consumer must also enforce its existing source and privacy authority. */
export type ModelConnection={id:string;fingerprint:string};
const dataKind=z.enum(['text','image','audio','conversation']);
export type ModelDataKind=z.infer<typeof dataKind>;
const scopeSchema=z.object({sourceIds:z.array(z.string().min(1).max(256)).max(1000).nullable(),dataKinds:z.array(dataKind).min(1).max(4)}).strict();
export type ModelDataScope=z.infer<typeof scopeSchema>;
export type ModelDisclosure={sourceId:string;dataKind:ModelDataKind};
export type ModelAuthorityView={revision:number;epoch:number;state:'unapproved'|'enabled'|'paused'|'stopped';connections:ModelConnection[];scope:ModelDataScope;acceptedThrough:number};
type State=ModelAuthorityView&{lastOperation?:string;lastCommand?:string};
export type AutomaticModelPurpose='memory'|'working'|'insight'|'activity'|'actions'|'image'|'file'|'embedding'|'semantic'|'integration';
type Work={id:string;kind:'manual'|'automatic'|'probe';purpose?:AutomaticModelPurpose;epoch:number;roots:string[];connections:ModelConnection[];scope:ModelDataScope};
type Authority={work:Work;controller:AbortController};
const command=z.object({revision:z.number().int().nonnegative(),operationId:z.string().uuid(),action:z.enum(['authorize','pause','stop']),connections:z.array(z.object({id:z.string().min(1).max(256),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(100).optional(),scope:scopeSchema.optional()}).strict();
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const pending=()=>new ProviderFailure({category:'blocked',code:'background_model_authorization_required',executionStarted:false,admissionWaiting:true},'Background model processing needs owner authorization');

/** One durable owner decision and immutable original-receipt permissions.
 * A lane, model login, source timestamp, retry or derived publication cannot
 * issue authority. Callers receive no serializable authority token. */
export class BackgroundModelAuthorization {
  private readonly context=new AsyncLocalStorage<Authority|undefined>();
  private readonly stepContext=new AsyncLocalStorage<string>();
  private readonly active=new Set<Authority>();
  constructor(private readonly store:Store,private readonly available:()=>ModelConnection[]){
    store.db.exec(`CREATE TABLE IF NOT EXISTS background_model_authorization(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS background_model_receipts(seq INTEGER PRIMARY KEY AUTOINCREMENT,identity TEXT NOT NULL UNIQUE,epoch INTEGER NOT NULL,authorized INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS background_model_lineage(identity TEXT NOT NULL,original TEXT NOT NULL,PRIMARY KEY(identity,original));
      CREATE TABLE IF NOT EXISTS background_model_work(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS background_model_trigger_claims(original TEXT NOT NULL,purpose TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES background_model_work(id),PRIMARY KEY(original,purpose));
      CREATE TABLE IF NOT EXISTS background_model_connections_used(work_id TEXT NOT NULL REFERENCES background_model_work(id),id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(work_id,id,fingerprint));
      CREATE TABLE IF NOT EXISTS background_model_step_authority(step_id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES background_model_work(id));`);
    if(!store.db.prepare('SELECT 1 FROM background_model_authorization WHERE id=1').get()){
      const json=JSON.stringify({revision:0,epoch:1,state:'unapproved',connections:[],scope:{sourceIds:[],dataKinds:[]},acceptedThrough:0} satisfies State);
      store.reserveMetadata(Buffer.byteLength(json)+128);store.db.prepare('INSERT INTO background_model_authorization VALUES(1,?)').run(json);
    }
  }
  private state():State{return JSON.parse(String(this.store.db.prepare('SELECT json FROM background_model_authorization WHERE id=1').get()!.json));}
  view():ModelAuthorityView{const {lastOperation:_,lastCommand:__,...view}=this.state();return view;}
  private transaction<T>(write:()=>T):T{const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{const result=write();if(own)db.exec('COMMIT');return result;}catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}}
  command(raw:unknown){
    const input=command.parse(raw),encoded=JSON.stringify(input);
    this.transaction(()=>{
      const state=this.state(),previousBytes=Buffer.byteLength(JSON.stringify(state));
      if(state.lastOperation===input.operationId){if(state.lastCommand!==encoded)throw new StoreError('Authorization operation was already used for a different request',409);return state;}
      if(state.revision!==input.revision)throw new StoreError('Model authorization changed; reload before continuing',409);
      if(input.action==='authorize'){
        const available=this.available(),selected=input.connections;
        if(!input.scope||!selected?.length||new Set(selected.map(c=>c.id)).size!==selected.length||selected.some(c=>!available.some(current=>same(c,current))))throw new StoreError('Review the current model connections and data scope before authorizing background processing',409);
        // Approval is prospective. Previously denied receipts never change.
        state.state='enabled';state.connections=structuredClone(selected);state.scope=structuredClone(input.scope);
      }else{
        if(input.connections!==undefined||input.scope!==undefined)throw new StoreError('Connections and scope are only accepted with authorization',400);
        if(input.action==='stop'){state.epoch++;state.state='stopped';}
        else if(state.state!=='unapproved'&&state.state!=='stopped')state.state='paused';
      }
      state.acceptedThrough=Number(this.store.db.prepare('SELECT coalesce(max(seq),0) seq FROM background_model_receipts').get()!.seq);
      state.revision++;state.lastOperation=input.operationId;state.lastCommand=encoded;
      const json=JSON.stringify(state);this.store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-previousBytes));
      this.store.db.prepare('UPDATE background_model_authorization SET json=? WHERE id=1').run(json);
      return state;
    });
    if(input.action==='stop')for(const authority of this.active)if(authority.work.kind==='automatic')authority.controller.abort(pending());
    return this.view();
  }
  /** Original intake only, in the same durable receive transaction. Persist a
   * denial too, so duplicates and later approval cannot backfill permission. */
  receive(identity:string,disclosure:ModelDisclosure,eligible=true){
    if(!this.store.db.isTransaction)throw Error('Model receipt requires the original receive transaction');
    if(!identity||identity.length>2048)throw Error('Invalid original receipt identity');
    const state=this.state();
    if(this.store.db.prepare('SELECT 1 FROM background_model_receipts WHERE identity=?').get(identity))return;
    this.store.reserveMetadata(Buffer.byteLength(identity)+128);
    // Intake is a trigger, not a disclosure. A screenshot may later supply
    // permitted text while raw pixels remain forbidden; check data kind at
    // every real model disclosure instead of denying the whole receipt here.
    const sourceAllowed=state.scope.sourceIds===null||state.scope.sourceIds.includes(disclosure.sourceId);
    this.store.db.prepare('INSERT INTO background_model_receipts(identity,epoch,authorized) VALUES(?,?,?)').run(identity,state.epoch,Number(eligible&&state.state==='enabled'&&sourceAllowed));
  }
  /** A deterministic projection only inherits existing roots. It cannot mint
   * an original receipt, and repeated publication cannot change its lineage. */
  derive(identity:string,originals:readonly string[]){
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
    if(this.store.db.prepare('SELECT 1 FROM background_model_receipts WHERE identity=?').get(identity))return [identity];
    return this.store.db.prepare('SELECT original FROM background_model_lineage WHERE identity=? ORDER BY original').all(identity).map(row=>String(row.original));
  }
  /** Host-derived grouping can contain historical context. Only newly
   * received, unconsumed originals become triggers; the context remains subject
   * to disclosure scope. Never call this with model-authored catalog entries. */
  freshTriggers(identities:readonly string[],purpose:AutomaticModelPurpose):string[]{
    const state=this.state();if(state.state!=='enabled')return [];
    return [...new Set(identities.flatMap(identity=>this.roots(identity)))].filter(root=>Boolean(this.store.db.prepare('SELECT 1 FROM background_model_receipts WHERE identity=? AND epoch=? AND authorized=1').get(root,state.epoch))&&!this.store.db.prepare('SELECT 1 FROM background_model_trigger_claims WHERE original=? AND purpose=?').get(root,purpose)).sort();
  }
  automaticTriggers(id:string,purpose:AutomaticModelPurpose):readonly string[]|undefined{const work=this.saved(id);if(!work)return;if(work.kind!=='automatic'||work.purpose!==purpose)throw new StoreError('Model operation has a different purpose',409);return [...work.roots];}
  private save(work:Work){const json=JSON.stringify(work);this.store.reserveMetadata(Buffer.byteLength(json+work.id)+128);this.store.db.prepare('INSERT INTO background_model_work VALUES(?,?)').run(work.id,json);return work;}
  private saved(id:string):Work|undefined{const row=this.store.db.prepare('SELECT json FROM background_model_work WHERE id=?').get(id);return row?JSON.parse(String(row.json)):undefined;}
  private assert(work:Work,connection?:ModelConnection){
    if(work.kind==='automatic'){
      const state=this.state();
      // Pause drains already admitted work; stop invalidates its epoch.
      if(work.epoch!==state.epoch||['unapproved','stopped'].includes(state.state))throw pending();
      if(!work.roots.length||work.roots.some(root=>!this.store.db.prepare('SELECT 1 FROM background_model_receipts WHERE identity=? AND epoch=? AND authorized=1').get(root,work.epoch)))throw pending();
    }
    const available=this.available();
    if(work.kind==='automatic'&&this.store.db.prepare('SELECT id,fingerprint FROM background_model_connections_used WHERE work_id=?').all(work.id).some(used=>!available.some(current=>current.id===used.id&&current.fingerprint===used.fingerprint)))throw pending();
    if(connection&&!work.connections.some(c=>same(c,connection)&&(work.kind!=='automatic'||available.some(current=>same(current,c)))))throw pending();
  }
  /** Host-owned job identity. The exact original set is immutable on restart. */
  automatic(id:string,identities:readonly string[],purpose:AutomaticModelPurpose='memory'){
    return this.transaction(()=>{
      const roots=[...new Set(identities.flatMap(identity=>this.roots(identity)))].sort();
      if(!identities.length||identities.some(identity=>!this.roots(identity).length))throw pending();
      const prior=this.saved(id);
      if(prior){if(prior.kind!=='automatic'||prior.purpose!==purpose||!same(prior.roots,roots))throw new StoreError('Model work authorization scope changed',409);this.assert(prior);return id;}
      const state=this.state();if(state.state!=='enabled')throw pending();
      if(roots.some(root=>this.store.db.prepare('SELECT 1 FROM background_model_trigger_claims WHERE original=? AND purpose=?').get(root,purpose)))throw pending();
      const work:Work={id,kind:'automatic',purpose,epoch:state.epoch,roots,connections:structuredClone(state.connections),scope:structuredClone(state.scope)};this.assert(work);this.save(work);
      for(const root of roots){this.store.reserveMetadata(Buffer.byteLength(root+purpose+id)+64);this.store.db.prepare('INSERT INTO background_model_trigger_claims VALUES(?,?,?)').run(root,purpose,id);}
      return id;
    });
  }
  /** Called only at an existing owner-confirmed operation boundary. Never
   * expose it as a QueryInput flag or accept a caller-provided authority. */
  manual(id:string,kind:'manual'|'probe',identities:readonly string[]=[],connections=this.available()){
    return this.transaction(()=>{const roots=[...new Set(identities)].sort(),prior=this.saved(id);if(prior){if(prior.kind!==kind||!same(prior.roots,roots))throw new StoreError('Manual model scope changed',409);return id;}this.save({id,kind,epoch:0,roots,connections:structuredClone(connections),scope:{sourceIds:null,dataKinds:['text','image','audio','conversation']}});return id;});
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
    const work=this.saved(id);if(!work)throw pending();this.assert(work);
    const stepId=this.stepContext.getStore();if(stepId)this.bindStep(stepId,id);
    const authority:Authority={work,controller:new AbortController()};this.active.add(authority);
    const combined=AbortSignal.any([authority.controller.signal,...(signal?[signal]:[])]);
    try{return await this.context.run(authority,async()=>{combined.throwIfAborted();const value=await task(combined);combined.throwIfAborted();this.assert(work);return value;});}
    finally{this.active.delete(authority);}
  }
  /** Each actual send and publication checks the same host-issued authority. */
  private assertConnection(authority:Authority,connection?:ModelConnection){if(authority.controller.signal.aborted)throw pending();this.assert(authority.work,connection);if(connection&&!this.store.db.prepare('SELECT 1 FROM background_model_connections_used WHERE work_id=? AND id=? AND fingerprint=?').get(authority.work.id,connection.id,connection.fingerprint)){this.store.reserveMetadata(Buffer.byteLength(authority.work.id+connection.id+connection.fingerprint)+64);this.store.db.prepare('INSERT INTO background_model_connections_used VALUES(?,?,?)').run(authority.work.id,connection.id,connection.fingerprint);}}
  assertCurrent(connection?:ModelConnection){const authority=this.context.getStore();if(!authority)throw pending();this.assertConnection(authority,connection);}
  get currentId(){return this.context.getStore()?.work.id;}
  get currentKind(){return this.context.getStore()?.work.kind;}
  ownerIntent(identity:string):string|undefined{const work=this.context.getStore()?.work;return work?.kind==='manual'&&work.roots.includes(identity)?work.id:undefined;}
  assertOwnerIntent(id:string,identity:string){const work=this.saved(id);if(!work||work.kind!=='manual'||!work.roots.includes(identity))throw pending();this.assert(work);}
  /** Native HTTP relays do not inherit AsyncLocalStorage. Capture the host
   * authority in a closure, never in a serializable plugin argument. */
  capture(connection?:ModelConnection){const authority=this.context.getStore();if(!authority)throw pending();return ()=>this.assertConnection(authority,connection);}
  private bindStep(stepId:string,id:string){const prior=this.store.db.prepare('SELECT work_id FROM background_model_step_authority WHERE step_id=?').get(stepId);if(prior&&prior.work_id!==id)throw new StoreError('Execution step already has a different model authority',409);if(!prior){this.store.reserveMetadata(Buffer.byteLength(stepId+id)+64);this.store.db.prepare('INSERT INTO background_model_step_authority VALUES(?,?)').run(stepId,id);}}
  captureStep(step:ExecutionStep){const id=this.currentId;if(id)this.bindStep(step.id,id);}
  assertStep(step:ExecutionStep){for(const row of this.store.db.prepare('SELECT work_id FROM background_model_step_authority WHERE step_id=?').all(step.id)){const work=this.saved(String(row.work_id));if(!work)throw pending();this.assert(work);}}
  async runStep<T>(step:ExecutionStep,task:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T>{
    this.assertStep(step);
    const row=this.store.db.prepare('SELECT work_id FROM background_model_step_authority WHERE step_id=?').get(step.id);
    // A shared executor must never inherit whichever HTTP request happened to
    // wake its timer. Only this exact durable step can restore manual authority.
    return this.stepContext.run(step.id,()=>row?this.run(String(row.work_id),task,signal):this.context.run(undefined,()=>task(signal)));
  }
  private permits(scope:ModelDataScope,disclosure:ModelDisclosure){return scope.dataKinds.includes(disclosure.dataKind)&&(scope.sourceIds===null||scope.sourceIds.includes(disclosure.sourceId));}
  /** Historical reference is allowed in the approved source/data scope. Only
   * the automatic trigger must be prospective. Existing source/privacy/read
   * checks remain mandatory for both historical and newly received evidence. */
  assertDisclosure(disclosures:readonly ModelDisclosure[]){
    const authority=this.context.getStore();if(!authority)throw pending();this.assert(authority.work);
    if(authority.work.kind!=='automatic')return;
    if(disclosures.some(disclosure=>!this.permits(authority.work.scope,disclosure)))throw pending();
  }
  allowsDisclosure(disclosure:ModelDisclosure){try{this.assertDisclosure([disclosure]);return true;}catch{return false;}}
  close(){for(const authority of this.active)authority.controller.abort();this.context.disable();this.stepContext.disable();}
}

/** Includes credential/header identity as a hash, never as persisted cleartext. */
export const modelConnection=(id:string,settings:unknown):ModelConnection=>({id,fingerprint:sha256(JSON.stringify(settings))});
export const manualModelOperation=()=>`manual-model:${randomUUID()}`;
