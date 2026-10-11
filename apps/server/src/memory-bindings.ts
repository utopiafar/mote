import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {MemoryBindingView,MemoryModuleBinding,MemoryPlanView,MemoryPreparationView} from '@mote/shared';
import {memorySchema,type Memory} from './memory-schema.js';
import {memoryProviderKey,memoryBodyDigest,withMemoryHostState,type MemoryProvider,type MemoryProviderKey,type MemoryProviderNamespace,type MemoryProviderRecord} from './memory-provider-contract.js';
import {WorkerMemoryProvider} from './worker-memory-provider.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionGrant,type ExecutionStep} from './execution-engine.js';
import {MemoryAutomation,memoryControlCommandSchema} from './memory-automation.js';
import type {MemoryStore} from './memory.js';
import type {PluginCenter} from './plugin-center.js';
import {sha256,StoreError,type Store} from './store.js';

type Binding={planId:string;generation:number;namespace?:MemoryProviderNamespace};
type Preparation={view:MemoryPreparationView;source:Binding;target:Binding;stepId:string;snapshot?:string;prepared?:MemoryProviderRecord[]};
const builtinModules:MemoryModuleBinding[]=[['extract','Mote extraction'],['review','Mote independent review'],['integrate','Mote integration'],['repository','Mote repository'],['retrieval','Mote retrieval']].map(([stage,name])=>({stage:stage as MemoryModuleBinding['stage'],id:'mote.'+stage,name:name!,state:'verified'}));
const builtin:MemoryPlanView={id:'mote.builtin',name:'Mote',mode:'modules',modules:builtinModules,capabilities:[],available:true,allowedActions:['prepare']};
const preparationSchema=memoryControlCommandSchema.extend({targetPlanId:z.string().min(1),scope:z.literal('default'),feeAcknowledged:z.literal(true)}).strict();

/** The binding is changed only by a synchronous CAS after the exact migrated
 * bodies and deletion/correction state have been verified under a host fence. */
export class MemoryBindings {
  private dispose:()=>Promise<void>;
  private readers=new Map<string,number>();
  providerFactory?:(instanceId:string,namespace?:MemoryProviderNamespace)=>MemoryProvider;
  pendingTail:()=>number=()=>0;
  onReleased?:()=>void;
  constructor(readonly store:Store,readonly memories:MemoryStore,readonly automation:MemoryAutomation,readonly plugins:PluginCenter,readonly executor:ExecutionEngine){
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_plan_binding(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_preparation(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_binding_commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_provider_receipts(id TEXT PRIMARY KEY,json TEXT NOT NULL);`);
    store.db.prepare('INSERT OR IGNORE INTO memory_plan_binding VALUES(1,?)').run(JSON.stringify({planId:builtin.id,generation:1} satisfies Binding));
    plugins.references=id=>{const current=this.binding(),preparation=this.preparation();return [...(current.namespace?.instanceId===id?['Current Memory binding retains this instance for reads']:[]),...(preparation&&!['applied','cancelled'].includes(preparation.view.state)&&(preparation.target.namespace?.instanceId===id||preparation.source.namespace?.instanceId===id)?['A Memory preparation retains this instance']:[]),...((this.readers.get(id)??0)>0?['Existing queries retain a read snapshot']:[])];};
    this.dispose=executor.register({kind:'memory.prepare',pool:'plugin-control',concurrency:()=>1,
      validate:step=>this.preparation()?.stepId===step.id&&!['cancelled','applied'].includes(this.preparation()!.view.state),
      execute:(step,signal,grant)=>this.prepareBodies(step,signal,grant),
      commit:(_step,result)=>{const preparation=this.preparation()!;preparation.snapshot=String(result);preparation.view.state='verified';preparation.view.phase='verified';preparation.view.checks=['scope','bodies','corrections','deletions','index','tail','binding'].map(id=>({id,state:'verified'}));preparation.view.tail=0;preparation.view.allowedActions=['activate','cancel'];this.savePreparation(preparation);this.automation.touch();},
      project:step=>{const preparation=this.preparation();if(!preparation||preparation.stepId!==step.id)return;
        if(['blocked','failed','stale'].includes(step.state)){preparation.view.state=step.state==='failed'?'failed':'blocked';preparation.view.error=step.error??'memory_preparation_requires_attention';preparation.view.allowedActions=['retry','cancel'];this.savePreparation(preparation);}
      },classify:error=>error instanceof ExecutionFailure?error:new ExecutionFailure('blocked','memory_preparation_requires_attention'),
    });
  }
  binding():Binding{return JSON.parse(String(this.store.db.prepare('SELECT json FROM memory_plan_binding WHERE id=1').get()!.json));}
  private saveBinding(value:Binding){this.store.db.prepare('UPDATE memory_plan_binding SET json=? WHERE id=1').run(JSON.stringify(value));}
  private preparation():Preparation|undefined{const row=this.store.db.prepare('SELECT json FROM memory_preparation WHERE id=1').get();return row?JSON.parse(String(row.json)):undefined;}
  private savePreparation(value:Preparation){const json=JSON.stringify(value);this.store.reserveMetadata(Buffer.byteLength(json));this.store.db.prepare('INSERT INTO memory_preparation VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(json);}
  private currentRecords(){return this.store.db.prepare('SELECT json FROM memories ORDER BY id').all().map(row=>memorySchema.parse(JSON.parse(String(row.json))));}
  private snapshot(){return sha256(JSON.stringify({binding:this.binding(),memories:this.currentRecords(),deletions:this.memories.deletions.snapshot()}));}
  provider(instanceId:string,namespace?:MemoryProviderNamespace){return this.providerFactory?.(instanceId,namespace)??new WorkerMemoryProvider(this.plugins.runtime(instanceId));}
  plans():MemoryPlanView[]{return [builtin,...this.plugins.view().instances.filter(instance=>instance.capabilities.some(capability=>['repository','engine'].includes(capability.id))).map(instance=>{
    const declaredEngine=instance.capabilities.find(value=>value.id==='engine'),engine=declaredEngine?.state==='unsupported'?undefined:declaredEngine,repository=instance.capabilities.find(value=>value.id==='repository'),retrieval=instance.capabilities.find(value=>value.id==='retrieval'),available=instance.desired&&(engine?engine.state==='verified':repository?.state==='verified'&&retrieval?.state==='verified');
    return {id:'instance:'+instance.id,name:instance.name,mode:engine?'engine' as const:'modules' as const,instanceId:instance.id,modules:builtinModules.map(module=>(engine?module.stage!=='review':['repository','retrieval'].includes(module.stage))?{...module,id:instance.id+'.'+module.stage,name:instance.name,instanceId:instance.id,state:(engine??instance.capabilities.find(value=>value.id===module.stage))?.state??'unknown'}:module),capabilities:instance.capabilities,available,reason:available?undefined:'Enable this instance after verifying its actual capabilities',allowedActions:available?['prepare' as const]:[]};
  })];}
  view():MemoryBindingView{const binding=this.binding(),plans=this.plans(),activePlan=plans.find(plan=>plan.id===binding.planId);if(!activePlan)throw new StoreError('The active Memory provider is missing; restore its retained artifact',503);
    const preparation=this.preparation(),admission=this.automation.view(),enabled=!binding.namespace||this.plugins.instanceView(binding.namespace.instanceId).desired;
    return {revision:admission.revision,generation:binding.generation,mode:activePlan.mode,modules:activePlan.modules,activePlan,plans,admission:{...admission,...(!enabled&&admission.desired?{state:'blocked' as const,blockedReason:'The bound plugin is disabled; existing Memory remains readable'}:{})},preparation:preparation?.view,allowedActions:preparation&&!['applied','cancelled'].includes(preparation.view.state)?['stop',...preparation.view.allowedActions]:['pause','resume','stop','prepare']};
  }
  accepting(){const binding=this.binding();return this.automation.accepting()&&(!binding.namespace||this.plugins.instanceView(binding.namespace.instanceId).desired);}
  assertNewManualWork(){if(this.automation.state().barrier)throw new StoreError('Finish or cancel the Memory preparation before starting another write',409);}
  private command(kind:string,input:{operationId:string;expectedRevision:number},apply:()=>void){const fingerprint=sha256(JSON.stringify({kind,...input})),db=this.store.db;db.exec('BEGIN IMMEDIATE');try{
    const prior=db.prepare('SELECT fingerprint FROM memory_binding_commands WHERE id=?').get(input.operationId);if(prior){if(prior.fingerprint!==fingerprint)throw new StoreError('Memory command identity conflict',409);db.exec('COMMIT');return;}
    if(input.expectedRevision!==this.automation.state().revision)throw new StoreError('Memory binding changed; refresh before applying',409);apply();this.automation.touch();this.store.reserveMetadata(256);db.prepare('INSERT INTO memory_binding_commands VALUES(?,?)').run(input.operationId,fingerprint);db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}void this.executor.tick().catch(()=>{});}
  prepare(raw:unknown){const input=preparationSchema.parse(raw);this.command('prepare',input,()=>{const prior=this.preparation();if(prior&&!['applied','cancelled'].includes(prior.view.state))throw new StoreError('Finish or cancel the existing Memory preparation',409);
    const plan=this.plans().find(plan=>plan.id===input.targetPlanId);if(!plan?.available||plan.id===this.binding().planId)throw new StoreError('This Memory plan is unavailable',409);
    const target:Binding={planId:plan.id,generation:this.binding().generation+1,...(plan.instanceId?{namespace:{ownerId:'mote-owner',instanceId:plan.instanceId,bindingRevision:this.binding().generation+1}}:{})};
    const preparation:Preparation={source:this.binding(),target,stepId:'memory-prepare:'+input.operationId,view:{operationId:input.operationId,state:'waiting',phase:'copy',kind:'content-migration',targetPlanId:plan.id,scope:input.scope,checks:[],oldAdmissionFrozen:false,tail:this.pendingTail(),usageUnknown:true,allowedActions:['cancel']}};
    this.savePreparation(preparation);this.executor.enqueue(input.operationId,'memory.prepare',{preparationId:input.operationId},{id:preparation.stepId});
  });return this.view();}
  private async records(binding:Binding){const records=this.currentRecords();if(!binding.namespace)return records;
    const provider=this.provider(binding.namespace.instanceId,binding.namespace),namespace=binding.namespace;return Promise.all(records.map(async memory=>{const value=await provider.read({namespace,key:memoryProviderKey(memory)});if(!value||memoryBodyDigest(value)!==memoryBodyDigest(memory))throw new StoreError('The source provider is missing an exact Memory revision',502);return withMemoryHostState(value,memory);}));
  }
  private async copy(preparation:Preparation,signal:AbortSignal){const memories=await this.records(preparation.source);signal.throwIfAborted();if(!preparation.target.namespace)return;
    const namespace=preparation.target.namespace,provider=this.provider(namespace.instanceId,namespace),existing=await provider.export({namespace}),selected=new Set(memories.map(memory=>JSON.stringify(memoryProviderKey(memory))));
    for(const record of existing)if(!selected.has(JSON.stringify(record.key))){signal.throwIfAborted();await provider.remove({namespace,key:record.key,opId:preparation.view.operationId+':remove:'+sha256(JSON.stringify(record.key))});}
    for(const memory of memories){signal.throwIfAborted();const key=memoryProviderKey(memory),opId=preparation.view.operationId+':put:'+sha256(JSON.stringify({key,memory}));const prior=await provider.read({namespace,key}),receipt=prior&&memoryBodyDigest(prior)===memoryBodyDigest(memory)?{opId,namespace,key,payloadDigest:sha256(JSON.stringify({namespace,key,memory:prior})),state:'applied' as const,eraseVerified:false,recordedAt:new Date().toISOString()}:await provider.put({namespace,key,memory,opId});this.store.reserveMetadata(Buffer.byteLength(JSON.stringify(receipt)));this.store.db.prepare('INSERT OR REPLACE INTO memory_provider_receipts VALUES(?,?)').run(opId,JSON.stringify(receipt));}
    const exported=await provider.export({namespace}),actual=new Map(exported.map(record=>[JSON.stringify(record.key),memoryBodyDigest(record.memory)]));
    if(actual.size!==memories.length||exported.length!==memories.length||memories.some(memory=>actual.get(JSON.stringify(memoryProviderKey(memory)))!==memoryBodyDigest(memory)))throw new StoreError('The target provider did not preserve the complete Memory history',502);
    // Read every exact body through the target read API as well as its exporter.
    for(const memory of memories){const read=await provider.read({namespace,key:memoryProviderKey(memory)});if(!read||memoryBodyDigest(read)!==memoryBodyDigest(memory))throw new StoreError('The target read binding failed exact verification',502);}
    // A readable exporter does not prove the migrated retrieval index. Scope a
    // real search to one migrated body and verify its immutable mapping.
    if(memories.length){const sample=memories[0]!,key=memoryProviderKey(sample),hits=await provider.search({namespace,query:sample.statement,keys:[key],limit:1});signal.throwIfAborted();if(hits.length!==1||JSON.stringify(hits[0]!.namespace)!==JSON.stringify(namespace)||JSON.stringify(hits[0]!.key)!==JSON.stringify(key)||memoryBodyDigest(hits[0]!.memory)!==memoryBodyDigest(sample))throw new StoreError('The migrated retrieval index failed exact verification',502);}
  }
  private async prepareBodies(step:ExecutionStep,signal:AbortSignal,grant:ExecutionGrant){let preparation=this.preparation()!;
    if(JSON.stringify(this.binding())!==JSON.stringify(preparation.source))throw new ExecutionFailure('stale','memory_source_binding_changed');
    if(preparation.target.namespace){const health=await this.provider(preparation.target.namespace.instanceId,preparation.target.namespace).recover({namespace:preparation.target.namespace});if(!health.ready||!health.verified.persistentCrud||!health.verified.scopedRetrieval||!health.verified.immutableRecords||!health.verified.idempotentReplay)throw new ExecutionFailure('blocked','memory_target_capabilities_unverified');}
    await this.copy(preparation,signal);grant.assert();
    grant.commit(()=>{preparation=this.preparation()!;if(!preparation.view.oldAdmissionFrozen){this.automation.freeze(preparation.view.operationId);preparation.view.oldAdmissionFrozen=true;}preparation.view.state='running';preparation.view.phase='drain';preparation.view.tail=this.pendingTail();this.savePreparation(preparation);});
    if(preparation.view.tail)throw new ExecutionFailure('waiting','memory_tail_draining',1000);
    const snapshot=this.snapshot();await this.copy(preparation,signal);grant.assert();if(this.snapshot()!==snapshot)throw new ExecutionFailure('waiting','memory_tail_changed',1000);
    return snapshot;
  }
  action(kind:'activate'|'retry'|'cancel',raw:unknown){const input=memoryControlCommandSchema.extend({preparationId:z.string().uuid()}).strict().parse(raw);this.command(kind,input,()=>{const preparation=this.preparation();if(!preparation||preparation.view.operationId!==input.preparationId||!preparation.view.allowedActions.includes(kind))throw new StoreError('The Memory preparation action is unavailable',409);
    if(kind==='activate'){if(preparation.view.state!=='verified'||this.pendingTail()||preparation.snapshot!==this.snapshot())throw new StoreError('Memory changed after verification; prepare it again',409);const target=this.plans().find(plan=>plan.id===preparation.target.planId);if(!target?.available)throw new StoreError('The target instance is unavailable',409);this.saveBinding(preparation.target);preparation.view.state='applied';preparation.view.phase='applied';preparation.view.allowedActions=[];this.automation.release(preparation.view.operationId);this.onReleased?.();}
    else if(kind==='retry'){preparation.view.state='waiting';preparation.view.error=undefined;preparation.view.allowedActions=['cancel'];this.executor.retry(preparation.stepId);}
    else{this.executor.cancel(preparation.stepId);preparation.view.state='cancelled';preparation.view.allowedActions=[];if(preparation.view.oldAdmissionFrozen){this.automation.release(preparation.view.operationId);this.onReleased?.();}}
    this.savePreparation(preparation);
  });return this.view();}
  async read(id:string,binding=this.binding(),key?:MemoryProviderKey){const memory=this.memories.get(id);if(!binding.namespace)return memory;const value=await this.provider(binding.namespace.instanceId,binding.namespace).read({namespace:binding.namespace,key:key??memoryProviderKey(memory)});if(!value)throw new StoreError('The bound provider has no verified Memory body',503);return value;}
  retainSnapshot(){const binding=this.binding(),memories=this.currentRecords(),catalog=Object.fromEntries(memories.map(memory=>[memory.id,memoryProviderKey(memory)])),recordDigests=Object.fromEntries(memories.map(memory=>[memory.id,memoryBodyDigest(memory)])),hostStates=Object.fromEntries(memories.map(memory=>[memory.id,{status:memory.status,staleReason:memory.staleReason,updatedAt:memory.updatedAt}])),lineage=Object.fromEntries(memories.map(memory=>[memory.id,{evidenceIds:[...memory.evidenceIds],dependencyIds:this.store.db.prepare('SELECT evidence_id FROM memory_dependencies WHERE memory_id=? ORDER BY evidence_id').all(memory.id).map(row=>String(row.evidence_id)),evidence:memory.evidence.map(value=>({id:value.id,contentHash:value.contentHash})),scopeRefs:memory.scopeRefs}])),metadata=Object.fromEntries(this.store.db.prepare("SELECT id,json FROM memory_catalog ORDER BY id").all().map(row=>[String(row.id),{...JSON.parse(String(row.json)),staleReason:hostStates[String(row.id)]?.staleReason,updatedAt:hostStates[String(row.id)]?.updatedAt} as Record<string,unknown>])),records=binding.namespace?undefined:Object.fromEntries(memories.map(memory=>[memory.id,memory])),id=binding.namespace?.instanceId;let released=false;if(id)this.readers.set(id,(this.readers.get(id)??0)+1);return {binding,catalog,recordDigests,metadata,lineage,records,release:()=>{if(released)return;released=true;if(id)this.readers.set(id,Math.max(0,(this.readers.get(id)??1)-1));}};}
  async close(){await this.dispose();}
}
