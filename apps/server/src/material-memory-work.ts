import {z} from 'zod';
import {sha256,StoreError,type Store} from './store.js';
import type {MaterialStore} from './materials.js';
import {materialRequirementsSchema} from './material-readiness.js';
import {DEFAULT_MEMORY_INPUT_SCOPE,MemoryInputAuthorization,type AutomaticMemoryGrant} from './memory-input-authorization.js';
import {memoryWorkPackageSchema,type MemoryWorkPackage} from './memory-work-contract.js';
import type {MemoryRecipeSettings} from './memory-recipe-settings.js';
import {memoryRecipeBindingSchema,type MemoryStrategyRef} from './memory-strategy-contract.js';

const requiredSchema=materialRequirementsSchema;
type WorkRow={material_id:string;scope:string;revision:string;required_json:string;source_required_json:string;input_fingerprint:string|null;ready_at:number;job_id:string|null;error:string|null;input_key:string;auto_authorized:number;binding_json:string|null;context_time:string|null};
const TERMINAL_AT=Number.MAX_SAFE_INTEGER,RESUME_DELAY_MS=5000,RETRY_DELAY_MS=60000;
export type MaterialMemoryRunner={
  create:(input:{evidenceIds:string[];originKey:string;contextTime?:string;recipes?:MemoryStrategyRef[];automaticGrant?:AutomaticMemoryGrant;automaticGrants?:AutomaticMemoryGrant[];workPackage?:MemoryWorkPackage})=>{id:string};
  get:(id:string)=>{status:string};run:(id:string)=>Promise<unknown>;cancel:(id:string)=>unknown;
};
export type MemoryWorkCandidate={key:string;materialId:string;ref:string;title:string;sourceId:string;inputKey:string;scope:string;contextTime:string;fingerprint:string;characters:number;evidenceCount:number;evidenceIds:string[];recipe?:MemoryStrategyRef};
export type MemoryWorkProposal={id?:string;members:string[];goal:string;instruction:string};
export type MaterialMemoryPlanner=(catalog:MemoryWorkCandidate[])=>Promise<MemoryWorkProposal[]>;
export type MaterialMemoryObservation={inputKey:string;change:'source'|'rebuild';automatic?:boolean};

/** One common durable queue, independently scoped by selected product recipe.
 * Readiness is separate from the raw receipt's permission to run paid work. */
export class MaterialMemoryWork {
  private readonly active=new Set<string>();
  private planning=false;
  private dormantCursor:[string,string]=['',''];
  readonly inputs:MemoryInputAuthorization;
  constructor(private readonly store:Store,private readonly materials:MaterialStore,private readonly now=Date.now,private readonly automaticEnabled=()=>true,private readonly recipes?:MemoryRecipeSettings){
    const priorContextChanged=materials.onContextChanged;
    materials.onContextChanged=(id,cause)=>{priorContextChanged?.(id,cause);this.withdraw(id);};
    this.inputs=new MemoryInputAuthorization(store,automaticEnabled,now,recipes);
    const db=store.db;
    this.transaction(()=>{
    db.exec('CREATE TABLE IF NOT EXISTS material_memory_revocations(job_id TEXT PRIMARY KEY,material_id TEXT NOT NULL,revision TEXT NOT NULL)');
    db.exec(`CREATE TABLE IF NOT EXISTS material_memory_requests(
      material_id TEXT NOT NULL,scope TEXT NOT NULL,revision TEXT NOT NULL,required_json TEXT NOT NULL,ready_at INTEGER NOT NULL,
      job_id TEXT,error TEXT,input_key TEXT NOT NULL,auto_authorized INTEGER NOT NULL,binding_json TEXT,context_time TEXT,source_required_json TEXT NOT NULL,input_fingerprint TEXT,
      PRIMARY KEY(material_id,scope));
      CREATE INDEX IF NOT EXISTS material_memory_requests_due ON material_memory_requests(ready_at,job_id);`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS material_memory_forget BEFORE DELETE ON material_heads BEGIN
      INSERT OR IGNORE INTO material_memory_revocations SELECT job_id,material_id,revision FROM material_memory_requests WHERE material_id=old.id AND job_id IS NOT NULL;
      DELETE FROM memory_input_authorizations WHERE source_id=old.source_id AND input_key IN (SELECT input_key FROM material_memory_requests WHERE material_id=old.id);
      DELETE FROM material_memory_requests WHERE material_id=old.id; END;`);
    });
  }
  private rows(id:string){return this.store.db.prepare('SELECT * FROM material_memory_requests WHERE material_id=?').all(id) as WorkRow[];}
  private transaction<T>(run:()=>T):T{const db=this.store.db,own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');try{const result=run();if(own)db.exec('COMMIT');return result;}catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}}
  private update(row:WorkRow,set:string,values:(string|number|null)[]=[]){return this.store.db.prepare(`UPDATE material_memory_requests SET ${set} WHERE material_id=? AND scope=? AND revision=?`).run(...values,row.material_id,row.scope,row.revision);}
  private revoke(row:WorkRow){if(row.job_id)this.store.db.prepare('INSERT OR IGNORE INTO material_memory_revocations VALUES(?,?,?)').run(row.job_id,row.material_id,row.revision);}
  private available(row:WorkRow,sourceId:string,jobId?:string){
    if(row.binding_json){const binding=memoryRecipeBindingSchema.parse(JSON.parse(row.binding_json));if(!this.recipes?.enabled(sourceId,binding))return false;}
    else if(this.recipes)return false;
    return this.inputs.available(sourceId,row.input_key,jobId,row.scope);
  }
  /** Publication can continue an unused grant, never mint a new scope or renew
   * a completed raw input after deterministic reprocessing. */
  observe(materialId:string,required:readonly string[],observation:MaterialMemoryObservation,settleMs=0):void{
    const keys=requiredSchema.parse([...required]),inputKey=z.string().min(1).max(256).parse(observation.inputKey);
    if(!Number.isSafeInteger(settleMs)||settleMs<0||settleMs>7*86400000)throw Error('Invalid material Memory settle delay');
    const material=this.materials.get(materialId);if(!material){this.withdraw(materialId);return;}
    const sourceRequiredJson=JSON.stringify(keys),readyAt=this.now()+settleMs;
    this.transaction(()=>{
      const previous=this.rows(materialId),grants=this.inputs.list(material.origin.sourceId,inputKey);
      if(!grants.length)grants.push({scope:DEFAULT_MEMORY_INPUT_SCOPE,authorized:false,contextTime:new Date(this.now()).toISOString()});
      for(const row of previous)if(!grants.some(g=>g.scope===row.scope)){this.revoke(row);this.store.db.prepare('DELETE FROM material_memory_requests WHERE material_id=? AND scope=?').run(materialId,row.scope);}
      for(const grant of grants){
        const prior=previous.find(r=>r.scope===grant.scope),bindingJson=grant.binding?JSON.stringify(grant.binding):null;
        const required=grant.binding?.requires??keys,requiredJson=JSON.stringify(required),selection=this.materials.input(material.ref,required);
        const fingerprint=selection?.ready?selection.fingerprint:null;
        const current:WorkRow={material_id:materialId,scope:grant.scope,revision:material.revision,required_json:requiredJson,source_required_json:sourceRequiredJson,input_fingerprint:fingerprint,ready_at:readyAt,job_id:null,error:null,input_key:inputKey,auto_authorized:0,binding_json:bindingJson,context_time:grant.contextTime};
        const automatic=this.automaticEnabled()&&observation.automatic!==false&&grant.authorized&&this.available(current,material.origin.sourceId,prior?.job_id??undefined);
        const authorized=automatic&&(prior?.input_key===inputKey?Boolean(prior.auto_authorized&&!prior.job_id):observation.change==='source');
        const sameInput=prior?.input_key===inputKey&&prior.required_json===requiredJson&&
          (prior.revision===material.revision||Boolean(prior.input_fingerprint&&prior.input_fingerprint===fingerprint));
        if(sameInput){
          if(!automatic&&prior.auto_authorized){this.revoke(prior);this.update(prior,'auto_authorized=0,job_id=NULL,input_key=?',[inputKey]);}
          else this.update(prior,'input_key=?,auto_authorized=?',[inputKey,prior.job_id?prior.auto_authorized:Number(authorized)]);
          this.update(prior,'source_required_json=?,input_fingerprint=?,revision=?',[sourceRequiredJson,fingerprint,material.revision]);
          continue;
        }
        if(prior)this.revoke(prior);
        this.store.reserveMetadata(Buffer.byteLength(requiredJson+sourceRequiredJson+(bindingJson??''))+640);
        this.store.db.prepare(`INSERT INTO material_memory_requests VALUES(?,?,?,?,?,NULL,NULL,?,?,?,?,?,?) ON CONFLICT(material_id,scope) DO UPDATE SET
          revision=excluded.revision,required_json=excluded.required_json,ready_at=excluded.ready_at,job_id=NULL,error=NULL,input_key=excluded.input_key,auto_authorized=excluded.auto_authorized,binding_json=excluded.binding_json,context_time=excluded.context_time,source_required_json=excluded.source_required_json,input_fingerprint=excluded.input_fingerprint`)
          .run(materialId,grant.scope,material.revision,requiredJson,readyAt,inputKey,Number(authorized),bindingJson,grant.contextTime,sourceRequiredJson,fingerprint);
      }
    });
  }
  /** Refresh output readiness without authorizing a new raw tool-only input. */
  observeUnchanged(materialId:string,required:readonly string[],observation:MaterialMemoryObservation,settleMs=0){
    const prior=this.rows(materialId)[0];
    this.observe(materialId,required,{...observation,inputKey:prior?.input_key||observation.inputKey,change:'rebuild'},settleMs);
  }
  withdraw(materialId:string){this.transaction(()=>{for(const row of this.rows(materialId))this.revoke(row);this.store.db.prepare('DELETE FROM material_memory_requests WHERE material_id=?').run(materialId);});}
  private selection(row:WorkRow){return this.materials.input(row.material_id,requiredSchema.parse(JSON.parse(row.required_json)));}
  planningEvidence(materialId:string,scope:string):string[]{const row=this.rows(materialId).find(row=>row.scope===scope);return row?this.selection(row)?.evidenceIds??[]:[];}
  /** A sample uses the candidate's independently pinned recipe selection. */
  planningInput(candidate:MemoryWorkCandidate,jobId?:string){const row=this.rows(candidate.materialId).find(row=>row.scope===candidate.scope),material=this.materials.get(candidate.materialId),selection=row&&this.selection(row);
    if(!row?.auto_authorized||!material||material.origin.sourceId!==candidate.sourceId||row.input_key!==candidate.inputKey||!selection?.ready||selection.fingerprint!==candidate.fingerprint||!this.available(row,candidate.sourceId,jobId)||jobId&&row.job_id!==jobId)throw new StoreError('Memory sample authorization changed',409);
    return selection;
  }
  sourceRequirements(ref:string):string[]|undefined {const material=this.materials.get(ref),row=material&&this.rows(material.id)[0];return row?requiredSchema.parse(JSON.parse(row.source_required_json)):undefined;}
  readyForMemory(ref:string,scope?:string):boolean{
    try{const pinned=this.materials.get(ref);if(!pinned)return false;const current=this.materials.get(pinned.id);if(current?.revision!==pinned.revision)return false;
      const row=this.rows(pinned.id).find(r=>r.revision===pinned.revision&&(scope===undefined||r.scope===scope));if(!row)return false;
      return Boolean(this.materials.input(current.ref,requiredSchema.parse(JSON.parse(scope===undefined?row.source_required_json:row.required_json)))?.ready);
    }catch{return false;}
  }
  /** Execution and commit both check this, including a retry of an old auto job. */
  authorized(job:{id:string;automaticGrant?:AutomaticMemoryGrant;automaticGrants?:AutomaticMemoryGrant[]}):boolean{
    const grants=job.automaticGrants??(job.automaticGrant?[job.automaticGrant]:[]);
    return grants.every(grant=>this.authorizedGrant(job.id,grant));
  }
  private authorizedGrant(jobId:string,authorization:AutomaticMemoryGrant):boolean{
    const {sourceId,inputKey,scope}=authorization;
    if(!this.automaticEnabled()||!this.inputs.available(sourceId,inputKey,jobId,scope))return false;
    const grant=this.inputs.list(sourceId,inputKey).find(g=>g.scope===scope);
    const row=this.store.db.prepare('SELECT r.* FROM material_memory_requests r JOIN material_heads m ON m.id=r.material_id WHERE r.scope=? AND r.input_key=? AND r.job_id=? AND m.source_id=?').get(scope,inputKey,jobId,sourceId) as WorkRow|undefined;
    const selection=row&&this.selection(row);
    return Boolean(grant&&row?.auto_authorized&&selection?.ready&&selection.fingerprint===row.input_fingerprint&&(!this.recipes||grant.binding&&this.recipes.enabled(sourceId,grant.binding)));
  }
  /** Selection changes revoke work, without creating receipts or deleting products. */
  reconcile(runner:MaterialMemoryRunner){
    this.inputs.revokeDisabled();
    for(const row of this.store.db.prepare('SELECT * FROM material_memory_requests WHERE auto_authorized=1').all() as WorkRow[]){
      const material=this.materials.get(row.material_id);
      if(material&&this.available(row,material.origin.sourceId,row.job_id??undefined))continue;
      this.revoke(row);this.update(row,'auto_authorized=0');
    }
    this.cancelRevocations(runner,Number.MAX_SAFE_INTEGER);
  }
  private cancelRevocations(runner:MaterialMemoryRunner,limit:number){for(const row of this.store.db.prepare('SELECT job_id FROM material_memory_revocations ORDER BY rowid LIMIT ?').all(limit)){
    try{runner.cancel(String(row.job_id));}catch(error){if(!(error instanceof StoreError&&error.statusCode===404))return false;}
    this.store.db.prepare('DELETE FROM material_memory_revocations WHERE job_id=?').run(row.job_id);
  }return true;}
  private launch(runner:MaterialMemoryRunner,row:WorkRow,allowed:(id:string)=>boolean){
    const id=row.job_id!;if(this.active.has(id))return;this.active.add(id);
    void Promise.resolve().then(()=>{
      const current=this.rows(row.material_id).find(r=>r.scope===row.scope&&r.job_id===id&&r.auto_authorized);
      if(!current||!this.automaticEnabled()||!allowed(row.material_id))return;
      const material=this.materials.get(row.material_id);
      if(material?.revision!==current.revision||!this.readyForMemory(material.ref,current.scope)||!this.available(current,material.origin.sourceId,id))return;
      return runner.run(id);
    }).catch(()=>this.update(row,"error='memory_run_failed'")).finally(()=>this.active.delete(id));
  }
  /** A product resume/retry has already changed its job state. Rejoin that
   * existing claimed queue entry after a previous pause/failure parked it;
   * never retry a terminal product or renew its raw-input authority. */
  private rejoinResumed(runner:MaterialMemoryRunner,limit:number){
    const rows=this.store.db.prepare('SELECT * FROM material_memory_requests WHERE auto_authorized=1 AND job_id IS NOT NULL AND ready_at=? AND error IS NOT NULL AND (material_id,scope)>(?,?) ORDER BY material_id,scope LIMIT ?').all(TERMINAL_AT,...this.dormantCursor,limit) as WorkRow[];
    this.dormantCursor=rows.length===limit?[rows.at(-1)!.material_id,rows.at(-1)!.scope]:['',''];
    for(const row of rows){let status:string;try{status=runner.get(row.job_id!).status;}catch{continue;}
      if(['queued','running','waiting_for_model','waiting_for_input'].includes(status))this.update(row,'ready_at=?,error=NULL',[this.now()]);
    }
  }
  /** A metadata catalog supports model planning without another full-corpus read. */
  catalog(limit=64,allowed:(materialId:string)=>boolean=()=>true,allowCandidate:(candidate:MemoryWorkCandidate)=>boolean=()=>true):MemoryWorkCandidate[]{
    if(!Number.isSafeInteger(limit)||limit<1||limit>64)throw Error('Invalid Memory planning catalog limit');
    const catalog:MemoryWorkCandidate[]=[];
    // Interleave source queues before applying the metadata bound. This is
    // admission fairness, not a decision about which inputs belong together.
    for(const row of this.store.db.prepare(`SELECT r.* FROM material_memory_requests r JOIN material_heads m ON m.id=r.material_id
      WHERE r.auto_authorized=1 AND r.job_id IS NULL AND r.ready_at<=?
      ORDER BY row_number() OVER (PARTITION BY m.source_id ORDER BY r.ready_at,r.material_id,r.scope),r.ready_at,r.material_id,r.scope LIMIT ?`).all(this.now(),limit) as WorkRow[]){
      const material=this.materials.get(row.material_id),selection=this.selection(row);
      if(!material||material.revision!==row.revision||!selection?.ready||selection.fingerprint!==row.input_fingerprint||!allowed(material.id)||!this.available(row,material.origin.sourceId)){this.update(row,'ready_at=?',[this.now()+RETRY_DELAY_MS]);continue;}
      const binding=row.binding_json?memoryRecipeBindingSchema.parse(JSON.parse(row.binding_json)):undefined;
      const candidate:MemoryWorkCandidate={key:sha256(JSON.stringify([material.ref,row.scope,row.input_key,selection.fingerprint])),materialId:material.id,ref:material.ref,title:material.title.slice(0,200),sourceId:material.origin.sourceId,inputKey:row.input_key,scope:row.scope,contextTime:row.context_time??new Date(this.now()).toISOString(),fingerprint:selection.fingerprint,characters:material.textLength,evidenceCount:selection.evidenceIds.length,evidenceIds:selection.evidenceIds.slice(0,8),recipe:binding?{id:binding.recipe.id,version:binding.recipe.version}:undefined};
      if(!allowCandidate(candidate)){this.update(row,'ready_at=?',[this.now()+RETRY_DELAY_MS]);continue;}catalog.push(candidate);
    }
    return catalog;
  }
  /** Model-defined bounded packages; receipt claims and queue insertion are atomic. */
  async drainPlanned(runner:MaterialMemoryRunner,enabled:boolean,planner:MaterialMemoryPlanner,limit=64,allowed:(materialId:string)=>boolean=()=>true,onCreated?:(proposal:MemoryWorkProposal,job:{id:string})=>void,onSkipped?:(proposal:MemoryWorkProposal)=>void,allowCandidate:(candidate:MemoryWorkCandidate)=>boolean=()=>true):Promise<number>{
    if(!this.cancelRevocations(runner,limit)||!enabled||this.planning)return 0;
    this.rejoinResumed(runner,limit);
    // Resume prior packages first; do not create ordinary per-material jobs.
    for(const row of this.store.db.prepare('SELECT * FROM material_memory_requests WHERE auto_authorized=1 AND job_id IS NOT NULL AND ready_at<=? ORDER BY ready_at LIMIT ?').all(this.now(),limit) as WorkRow[]){
      let status:string;try{status=runner.get(row.job_id!).status;}catch{this.update(row,"ready_at=?,error='memory_job_unavailable'",[TERMINAL_AT]);continue;}
      if(status==='completed')this.update(row,'ready_at=?,error=NULL',[TERMINAL_AT]);
      else if(['queued','running','waiting_for_model','waiting_for_input'].includes(status)){this.update(row,'ready_at=?',[this.now()+RESUME_DELAY_MS]);this.launch(runner,row,allowed);}
      else this.update(row,'ready_at=?,error=?',[TERMINAL_AT,'memory_job_'+status]);
    }
    const catalog=this.catalog(limit,allowed,allowCandidate);if(!catalog.length)return 0;
    this.planning=true;
    try{return this.acceptPackages(runner,catalog,await planner(catalog),allowed,onCreated,onSkipped,allowCandidate);}finally{this.planning=false;}
  }
  /** Ready receipt inputs are independent tasks. Packing is transport capacity,
   * never a claim that their topics or evaluation times are interchangeable. */
  drainBounded(runner:MaterialMemoryRunner,enabled:boolean,limit=64,allowed:(materialId:string)=>boolean=()=>true,allowCandidate:(candidate:MemoryWorkCandidate)=>boolean=()=>true):Promise<number>{
    return this.drainPlanned(runner,enabled,async catalog=>{
      const groups:MemoryWorkCandidate[][]=[];
      for(const member of catalog){
        const group=groups.find(group=>group.length<8&&JSON.stringify(group[0].recipe)===JSON.stringify(member.recipe)&&group.reduce((sum,item)=>sum+item.characters,0)+member.characters<=12000);
        if(group)group.push(member);else groups.push([member]);
      }
      return groups.map(group=>({members:group.map(member=>member.key),goal:'Independently inspect each authorized original range',instruction:'These members share a transport batch only. Interpret each member using its own contextTime and attributionContext. Preserve every source and its supported time. Do not infer shared authorship, chronology, topic or evaluation time from this batch.'}));
    },limit,allowed,undefined,undefined,allowCandidate);
  }
  /** Resume durable model proposals without another planning call. Fresh
   * receipt claims and each product queue insertion still share one transaction. */
  acceptPackages(runner:MaterialMemoryRunner,catalog:MemoryWorkCandidate[],rawProposals:MemoryWorkProposal[],allowed:(materialId:string)=>boolean=()=>true,onCreated?:(proposal:MemoryWorkProposal,job:{id:string})=>void,onSkipped?:(proposal:MemoryWorkProposal)=>void,allowCandidate:(candidate:MemoryWorkCandidate)=>boolean=()=>true):number{
      let started=0;
      const proposals=z.array(z.object({id:z.string().min(1).max(200).optional(),members:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(8),goal:z.string().min(1).max(2000),instruction:z.string().min(1).max(4000)}).strict()).max(64).parse(rawProposals);
      const seen=new Set<string>();
      for(const proposal of proposals){
        const members=proposal.members.map(key=>catalog.find(member=>member.key===key));
        if(members.some(member=>!member)||proposal.members.some(key=>seen.has(key))||new Set(proposal.members).size!==proposal.members.length)throw new StoreError('Memory planner selected unknown or duplicate inputs',409);
        const selected=members as MemoryWorkCandidate[];
        if(new Set(selected.map(member=>JSON.stringify(member.recipe))).size!==1||selected.length>1&&selected.reduce((sum,member)=>sum+member.characters,0)>12000)throw new StoreError('Memory package exceeds policy or context compatibility',409);
        for(const key of proposal.members)seen.add(key);
      }
      for(const proposal of proposals){
        const members=proposal.members.map(key=>catalog.find(member=>member.key===key)!);
        // Recovery and a concurrently finishing planner can hand off the same
        // persisted proposal. Reuse its queue row, never revoke that product.
        const prior=proposal.id&&this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_jobs'").get()?this.store.db.prepare("SELECT id,json FROM memory_jobs WHERE json_extract(json,'$.workPackage.id')=?").get(proposal.id):undefined;
        if(prior){const job=JSON.parse(String(prior.json));if(job.originKey!=='memory-package:'+sha256(JSON.stringify(proposal.members)))throw new StoreError('Memory package belongs to another input grant',409);onCreated?.(proposal,{id:String(prior.id)});const row=this.rows(members[0].materialId).find(row=>row.scope===members[0].scope&&row.job_id===prior.id);if(row)this.launch(runner,row,allowed);continue;}
        let created:{id:string}|undefined,rows:WorkRow[]=[];
        try{this.transaction(()=>{
          rows=members.map(member=>this.rows(member.materialId).find(row=>row.scope===member.scope)!);
          if(rows.some((row,index)=>{const member=members[index];return !row||row.job_id||!row.auto_authorized||row.revision!==this.materials.get(member.materialId)?.revision||this.selection(row)?.fingerprint!==member.fingerprint||row.input_key!==member.inputKey||!this.available(row,member.sourceId)||!allowed(member.materialId)||!allowCandidate(member);}))return;
          const grants=members.map(member=>({sourceId:member.sourceId,inputKey:member.inputKey,scope:member.scope})),evidenceIds=[...new Set(rows.flatMap(row=>this.selection(row)!.evidenceIds))];
          if(!evidenceIds.length)return;
          const binding=rows[0].binding_json?memoryRecipeBindingSchema.parse(JSON.parse(rows[0].binding_json)):undefined;
          const packageId=proposal.id??sha256(JSON.stringify(proposal.members));
          created=runner.create({evidenceIds,originKey:'memory-package:'+sha256(JSON.stringify(proposal.members)),contextTime:members[0].contextTime,recipes:binding?[{id:binding.recipe.id,version:binding.recipe.version}]:undefined,automaticGrants:grants,workPackage:memoryWorkPackageSchema.parse({id:packageId,goal:proposal.goal,instruction:proposal.instruction,inputs:members.map(({materialId,ref,sourceId,inputKey,scope,contextTime,fingerprint})=>({materialId,ref,sourceId,inputKey,scope,contextTime,fingerprint}))})});
          if(!this.inputs.claimMany(grants,created.id))throw new StoreError('Memory package authorization changed',409);
          for(const row of rows)if(!this.update(row,'job_id=?,error=NULL',[created.id]).changes)throw new StoreError('Memory package input changed',409);
        });}catch(error){for(const row of rows)if(row)this.update(row,"error='memory_enqueue_failed',ready_at=?",[this.now()+RETRY_DELAY_MS]);onSkipped?.(proposal);continue;}
        if(!created)onSkipped?.(proposal);
        if(created){onCreated?.(proposal,created);this.launch(runner,{...rows[0],job_id:created.id},allowed);started++;}
      }
      return started;
  }
  drain(runner:MaterialMemoryRunner,enabled:boolean,limit=10,allowed:(materialId:string)=>boolean=()=>true):number{
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid material Memory drain limit');
    if(!this.cancelRevocations(runner,limit)||!enabled)return 0;
    this.rejoinResumed(runner,limit);
    let started=0;
    for(const existing of [true,false])for(const row of this.store.db.prepare(`SELECT * FROM material_memory_requests WHERE auto_authorized=1 AND job_id IS ${existing?'NOT ':''}NULL AND ready_at<=? ORDER BY ready_at,material_id,scope LIMIT ?`).all(this.now(),limit) as WorkRow[]){
      if(!allowed(row.material_id)){this.update(row,'ready_at=?',[this.now()+RETRY_DELAY_MS]);continue;}
      const material=this.materials.get(row.material_id);if(!material){this.withdraw(row.material_id);continue;}
      if(!this.available(row,material.origin.sourceId,row.job_id??undefined)){this.revoke(row);this.update(row,'auto_authorized=0');continue;}
      if(material.revision!==row.revision){this.observe(row.material_id,requiredSchema.parse(JSON.parse(row.source_required_json)),{inputKey:row.input_key||'unknown',change:'rebuild'});continue;}
      if(!this.readyForMemory(material.ref,row.scope)){
        if(existing){this.revoke(row);this.update(row,'auto_authorized=0');}else this.update(row,'ready_at=?',[this.now()+RETRY_DELAY_MS]);continue;
      }
      if(!existing){
        const selection=this.selection(row),evidenceIds=selection?.evidenceIds??[];if(!selection?.ready||!evidenceIds.length){this.update(row,'ready_at=?',[this.now()+RETRY_DELAY_MS]);continue;}
        try{
          const binding=row.binding_json?memoryRecipeBindingSchema.parse(JSON.parse(row.binding_json)):undefined;
          if(binding&&!this.recipes?.available(binding))throw Error('recipe unavailable');
          const job=runner.create({evidenceIds,originKey:binding?'material:'+sha256(JSON.stringify([material.ref,row.scope,row.input_key])):material.ref,...(binding?{contextTime:row.context_time!,recipes:[{id:binding.recipe.id,version:binding.recipe.version}],automaticGrant:{sourceId:material.origin.sourceId,inputKey:row.input_key,scope:row.scope}}:{})});
          const claimed=this.transaction(()=>{
            const current=this.rows(row.material_id).find(r=>r.scope===row.scope);
            if(!current?.auto_authorized||current.revision!==row.revision||current.input_key!==row.input_key||current.job_id||this.selection(current)?.fingerprint!==selection.fingerprint||!this.readyForMemory(material.ref,row.scope)||!this.available(current,material.origin.sourceId))return false;
            if(!this.inputs.claim(material.origin.sourceId,row.input_key,job.id,row.scope))return false;
            return Boolean(this.update(row,'job_id=?,input_fingerprint=?,error=NULL',[job.id,selection.fingerprint]).changes);
          });
          if(!claimed){this.revoke({...row,job_id:job.id});continue;}row.job_id=job.id;
        }catch{this.update(row,"error='memory_enqueue_failed',ready_at=?",[this.now()+RETRY_DELAY_MS]);continue;}
      }
      let status:string;
      try{status=runner.get(row.job_id!).status;}catch{this.update(row,"error='memory_job_unavailable',ready_at=?",[TERMINAL_AT]);continue;}
      if(status==='completed')this.update(row,'ready_at=?,error=NULL',[TERMINAL_AT]);
      else if(['queued','running','waiting_for_model'].includes(status)){if(existing)this.update(row,'ready_at=?',[this.now()+RESUME_DELAY_MS]);this.launch(runner,row,allowed);started++;}
      else this.update(row,'ready_at=?,error=?',[TERMINAL_AT,['failed','cancelled','paused','pausing'].includes(status)?`memory_job_${status}`:'memory_job_unavailable']);
    }
    return started;
  }
}
