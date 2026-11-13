import type {QueryInput} from '@mote/agent';
import type {EvidenceDependencies,QueryResult} from '@mote/shared';
import {BackgroundModelAuthorization,type AutomaticModelPurpose,type ModelConnection} from './background-model-authorization.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {EXECUTION_POLICIES} from './execution-policy.js';
import {memoryEvidenceFingerprint,type MemoryStore} from './memory.js';
import {sha256,StoreError,type Store} from './store.js';
import {TaskRecords,type AssertTaskCurrent} from './task-records.js';
import {combineSourceContextDependencies} from './source-context-lineage.js';
import {resolveDependencies} from './conversation-lineage.js';

// This is a server-local adapter for the existing read-only query, not another
// task DTO. The owner supplies the exact originals after applying its scope.
export type BatchQuery=Pick<QueryInput,'question'> & {evidenceIds:string[]};
export type BatchRequest={operationId:string;requestId:string;items:BatchQuery[];reduce?:string};
type FrozenQuery=BatchQuery & {processingEvidence:Record<string,string>};
type Plan={items:string[];contextTime:string;reduce?:string};
type StepInput={batchId:string;itemId?:string;index?:number;revision:number};
type Admission={kind:'automatic';purpose:AutomaticModelPurpose;roots:readonly string[]}|{kind:'manual';identities:readonly string[];connections:ModelConnection[]};
/** A product owner may project its own record in the existing step lifecycle.
 * These callbacks neither admit work nor create another execution mechanism. */
export type BatchProductProjection={
  valid(step:ExecutionStep):boolean;
  project(step:ExecutionStep):void;
  commit(step:ExecutionStep,result:QueryResult):void;
};
const deps=(ids:readonly string[]):EvidenceDependencies=>({version:1,complete:true,ids:[...new Set(ids)].sort()});
const terminal=(state:string)=>['succeeded','cancelled','stale','skipped'].includes(state);
const itemStep=(id:string,index:number)=>`batch:${id}:item:${index}`;
const reduceStep=(id:string)=>`batch:${id}:reduce`;

/** Small task adapter: one existing executor step per query and at most one
 * reducer. Private inputs and outputs stay in K3; the queue holds only IDs. */
export class BatchProcessing {
  private readonly tasks:TaskRecords;
  private readonly unregister:Array<()=>Promise<void>>=[];
  private unbindStop?:()=>void;
  private closed=false;
  private started=false;
  constructor(private readonly store:Store,private readonly engine:ExecutionEngine,private readonly control:BackgroundModelAuthorization,
    private readonly query:(input:QueryInput)=>Promise<QueryResult>,private readonly assertCurrent:AssertTaskCurrent,
    private readonly assertDisclosure:(ids:readonly string[])=>void,private readonly assertResultCurrent:(result:QueryResult)=>void,
    private readonly modelAdmission:()=>ExecutionFailure|undefined,private readonly concurrency:()=>number=()=>1,deferStart=false,
    private readonly evidence:Pick<MemoryStore,'readEvidence'|'isCurrentEvidence'>={readEvidence:ids=>store.evidence(ids),isCurrentEvidence:id=>store.isCurrentEvidence(id)},
    private readonly product?:BatchProductProjection){
    this.tasks=new TaskRecords(store);if(!deferStart)this.start();
  }
  start(){
    if(this.closed||this.started)return;this.started=true;
    for(const kind of ['batch.item','batch.reduce'] as const)this.unregister.push(this.engine.register({
      kind,pool:'batch',concurrency:this.concurrency,policy:EXECUTION_POLICIES.modelCall,
      validate:step=>this.valid(step),admit:()=>this.modelAdmission(),
      execute:(step,signal,grant)=>this.execute(step,signal,()=>grant.assert()),
      commit:(step,result)=>this.commit(step,result as QueryResult),
      project:step=>this.project(step),
    }));
    this.unbindStop=this.control.bindBatchStop(()=>this.stopAutomatic());
  }
  private transaction<T>(write:()=>T):T{
    const db=this.store.db;db.exec('SAVEPOINT batch_write');
    try{const result=write();db.exec('RELEASE batch_write');return result;}
    catch(error){db.exec('ROLLBACK TO batch_write; RELEASE batch_write');throw error;}
  }
  private frozen(input:BatchQuery):FrozenQuery{
    if(!input||typeof input.question!=='string'||!input.question.trim()||input.question.length>8000||!Array.isArray(input.evidenceIds)||
       input.evidenceIds.some(id=>typeof id!=='string'||!id)||new Set(input.evidenceIds).size!==input.evidenceIds.length)
      throw new StoreError('Invalid batch query',400);
    const ids=[...input.evidenceIds],records=this.evidence.readEvidence(ids);
    if(records.length!==ids.length||ids.some(id=>!this.evidence.isCurrentEvidence(id)))throw new StoreError('Batch evidence is unavailable',409);
    this.assertCurrent(ids);
    return {question:input.question,evidenceIds:ids,processingEvidence:Object.fromEntries(records.map(record=>[record.id,memoryEvidenceFingerprint(record)]))};
  }
  private pins(input:FrozenQuery){
    const records=this.evidence.readEvidence(input.evidenceIds);
    if(records.length!==input.evidenceIds.length||records.some(record=>!this.evidence.isCurrentEvidence(record.id)||input.processingEvidence[record.id]!==memoryEvidenceFingerprint(record)))
      throw new StoreError('Batch evidence changed',409);
    this.assertCurrent(input.evidenceIds);
  }
  private batch(id:string){const task=this.tasks.get(id);if(task.kind!=='batch')throw new StoreError('Batch not found',404);return task;}
  private parent(step:ExecutionStep){
    const input=step.input as StepInput,task=this.batch(input.batchId);
    if(!((task.state==='waiting'&&task.revision===input.revision)||(task.state==='running'&&task.revision===input.revision+1)))
      throw new ExecutionFailure('stale','batch_changed');
    return task;
  }
  private valid(step:ExecutionStep){
    if(this.closed)return false;
    try{
      const parent=this.parent(step),input=step.input as StepInput;
      this.tasks.evidenceDependencies(parent.id,parent.revision,this.assertCurrent);
      if(input.itemId){const item=this.tasks.get(input.itemId);if(item.state!=='waiting'&&item.state!=='running')return false;
        this.pins(this.tasks.input<FrozenQuery>(item.id,item.revision,this.assertCurrent));}
      return this.product?.valid(step)??true;
    }catch{return false;}
  }
  private project(step:ExecutionStep){
    if(step.state==='running'){
      const input=step.input as StepInput,parent=this.batch(input.batchId);
      if(parent.state==='waiting'&&parent.revision===input.revision)this.tasks.setState(parent.id,parent.revision,'running');
      if(input.itemId){const item=this.tasks.get(input.itemId);if(item.state==='waiting')this.tasks.setState(item.id,item.revision,'running');}
    }
    this.product?.project(step);
  }
  private async execute(step:ExecutionStep,signal:AbortSignal,assertGrant:()=>void):Promise<QueryResult>{
    const input=step.input as StepInput,parent=this.parent(step),plan=this.tasks.input<Plan>(parent.id,parent.revision,this.assertCurrent);
    let frozen:FrozenQuery,taskContext:QueryInput['taskContext'],sourceContexts:QueryInput['contextSourceContextDependencies'];
    let inputs:QueryResult[]=[];
    if(input.itemId){
      const item=this.tasks.get(input.itemId);frozen=this.tasks.input<FrozenQuery>(item.id,item.revision,this.assertCurrent);
    }else{
      if(plan.reduce===undefined)throw new ExecutionFailure('stale','batch_reduce_missing');
      const values=plan.items.map(id=>{const item=this.tasks.get(id);if(item.state!=='succeeded')throw new ExecutionFailure('blocked','batch_item_incomplete');
        const frozen=this.tasks.input<FrozenQuery>(id,item.revision,this.assertCurrent);this.pins(frozen);
        const result=this.tasks.result<QueryResult>(id,item.revision,this.assertCurrent);if(!result)throw new ExecutionFailure('blocked','batch_item_incomplete');this.assertResultCurrent(result);
        return {frozen,result};});
      frozen={question:plan.reduce,evidenceIds:[...new Set(values.flatMap(value=>value.frozen.evidenceIds))],processingEvidence:Object.assign({},...values.map(value=>value.frozen.processingEvidence))};
      inputs=values.map(value=>value.result);sourceContexts=combineSourceContextDependencies(inputs.map(result=>result.sourceContextDependencies));
      const summaries=JSON.stringify(values.map(({result})=>({answer:result.answer,citations:result.citations})));
      if(Buffer.byteLength(summaries)>48000)throw new ExecutionFailure('blocked','batch_reduce_input_too_large');
      taskContext={turns:[],untrustedInterpretations:summaries};
    }
    const assert=()=>{signal.throwIfAborted();assertGrant();this.parent(step);this.pins(frozen);this.assertDisclosure(frozen.evidenceIds);for(const result of inputs)this.assertResultCurrent(result);};
    assert();
    const result=await this.query({...frozen,executionLane:'background',...(frozen.evidenceIds.length?{}:{hostRetrieval:'none' as const}),
      contextTime:plan.contextTime,contextEvidenceDependencies:deps(frozen.evidenceIds),...(sourceContexts?.length?{contextSourceContextDependencies:sourceContexts}:{}),assertContextAuthority:assert,signal,...(taskContext?{taskContext}:{}),
      traceContext:{operationId:step.operationId,jobId:parent.id,batchId:step.id,...(input.index===undefined?{}:{batchIndex:input.index}),attempt:step.attempts}});
    assert();
    const allowed=new Set(frozen.evidenceIds);
    const lineage=new Set(resolveDependencies(this.store,deps(frozen.evidenceIds))!.ids);
    if(result.evidenceDependencies?.complete!==true||result.evidenceDependencies.ids.some(id=>!lineage.has(id))||result.citations.some(citation=>!allowed.has(citation.id)))
      throw new ExecutionFailure('stale','batch_evidence_outside_scope');
    return result;
  }
  private commit(step:ExecutionStep,result:QueryResult){
    const input=step.input as StepInput,parent=this.parent(step),plan=this.tasks.input<Plan>(parent.id,parent.revision,this.assertCurrent);
    this.assertResultCurrent(result);const dependencies=deps(result.evidenceDependencies!.ids);
    if(input.itemId){
      const item=this.tasks.get(input.itemId),frozen=this.tasks.input<FrozenQuery>(item.id,item.revision,this.assertCurrent);this.pins(frozen);this.assertDisclosure(frozen.evidenceIds);
      this.tasks.saveResult(item.id,item.revision,result,dependencies,this.assertCurrent);
      if(plan.reduce===undefined)this.tasks.saveResult(parent.id,parent.revision,result,dependencies,this.assertCurrent);
    }else{
      for(const id of plan.items){const item=this.tasks.get(id),frozen=this.tasks.input<FrozenQuery>(id,item.revision,this.assertCurrent);this.pins(frozen);this.assertDisclosure(frozen.evidenceIds);
        const itemResult=this.tasks.result<QueryResult>(id,item.revision,this.assertCurrent);if(!itemResult)throw new ExecutionFailure('stale','batch_item_incomplete');this.assertResultCurrent(itemResult);}
      this.tasks.saveResult(parent.id,parent.revision,result,dependencies,this.assertCurrent);
    }
    if(!input.itemId||plan.reduce===undefined)this.product?.commit(step,result);
  }
  /** The whole admission, K3 records and step authority either commit together
   * or roll back. Replaying a request never mints another automatic trigger. */
  submit(request:BatchRequest,admission:Admission){
    if(this.closed||!this.started)throw new StoreError('Batch processing is unavailable',503);
    if(!request.items.length||request.items.length>1000||admission.kind==='automatic'&&request.items.some(item=>!item.evidenceIds.length)||request.items.length>1&&request.reduce===undefined||
      request.reduce!==undefined&&(typeof request.reduce!=='string'||!request.reduce.trim()||request.reduce.length>8000))throw new StoreError('Invalid batch',400);
    const batch=this.transaction(()=>{
      const items=request.items.map((input,index)=>{
        const frozen=this.frozen(input);
        return this.tasks.create({operationId:request.operationId,kind:'batch.item',requestId:'batch-item:'+sha256(JSON.stringify([request.requestId,index])),input:frozen,evidenceDependencies:deps(frozen.evidenceIds)},this.assertCurrent);
      });
      const allIds=[...new Set(request.items.flatMap(item=>item.evidenceIds))];
      const parent=this.tasks.create({operationId:request.operationId,kind:'batch',requestId:'batch:'+sha256(request.requestId),
        input:{items:items.map(item=>item.id),contextTime:items[0].createdAt,...(request.reduce===undefined?{}:{reduce:request.reduce})} satisfies Plan,evidenceDependencies:deps(allIds)},this.assertCurrent);
      if(this.engine.get(itemStep(parent.id,0)))return parent;
      const enqueue=()=>{
        for(const [index,item] of items.entries())this.engine.enqueue(request.operationId,'batch.item',{batchId:parent.id,itemId:item.id,index,revision:parent.revision},{id:itemStep(parent.id,index)});
        if(request.reduce!==undefined)this.engine.enqueue(request.operationId,'batch.reduce',{batchId:parent.id,revision:parent.revision},{id:reduceStep(parent.id),dependencies:items.map((_,index)=>itemStep(parent.id,index))});
      };
      if(admission.kind==='automatic')this.control.automaticCommand('batch:'+parent.id,admission.roots,admission.purpose,enqueue);
      else this.control.manualCommand('batch:'+parent.id,admission.identities,admission.connections,enqueue);
      return parent;
    });
    this.engine.localEffect(()=>queueMicrotask(()=>{if(!this.closed)void this.engine.tick().catch(()=>{});}));
    return batch;
  }
  progress(id:string){
    const parent=this.batch(id),steps=this.steps(id),items=steps.filter(step=>step.kind==='batch.item');
    return {task:parent,completed:items.filter(step=>step.state==='succeeded').length,total:items.length,items,reduce:steps.find(step=>step.kind==='batch.reduce')};
  }
  private steps(id:string){return this.store.db.prepare("SELECT id FROM execution_steps WHERE kind IN ('batch.item','batch.reduce') AND json_extract(input,'$.batchId')=? ORDER BY rowid").all(id).map(row=>this.engine.get(String(row.id))!);}
  result(id:string){const task=this.batch(id),result=this.tasks.result<QueryResult>(id,task.revision,this.assertCurrent);if(result)this.assertResultCurrent(result);return result;}
  cancel(id:string){
    // A caller-owned transaction cannot safely abort local work before it
    // commits. The stop command uses the private transactional path below.
    if(this.store.db.isTransaction)throw new StoreError('Batch cancellation requires its own transaction',409);
    this.cancelBatch(id,true);
  }
  private cancelBatch(id:string,abortLocal:boolean){
    const steps=this.steps(id);
    this.transaction(()=>{
      const parent=this.batch(id);if(terminal(parent.state))return;
      this.tasks.setState(id,parent.revision,'cancelled');
      for(const step of steps){this.engine.cancel(step.id,false);const itemId=(step.input as StepInput).itemId;if(itemId){const item=this.tasks.get(itemId);if(!terminal(item.state))this.tasks.setState(item.id,item.revision,'cancelled');}}
    });
    if(abortLocal)for(const step of steps)this.engine.abortLocal(step.id);
  }
  private stopAutomatic(){
    const rows=this.store.db.prepare(`SELECT DISTINCT json_extract(e.input,'$.batchId') AS id FROM execution_steps e
      JOIN background_model_step_authority a ON a.step_id=e.id JOIN background_model_work w ON w.id=a.work_id
      WHERE e.kind IN ('batch.item','batch.reduce') AND e.state NOT IN ('succeeded','cancelled','stale') AND json_extract(w.json,'$.kind')='automatic'`).all();
    for(const row of rows)this.cancelBatch(String(row.id),false);
  }
  retry(id:string){
    const task=this.batch(id);if(terminal(task.state))throw new StoreError('Batch is already finished',409);
    for(const step of this.steps(id))if(step.state==='failed'||step.state==='blocked')this.engine.retry(step.id,true);
    this.engine.localEffect(()=>queueMicrotask(()=>{if(!this.closed)void this.engine.tick().catch(()=>{});}));
  }
  async close(){if(this.closed)return;this.closed=true;this.unbindStop?.();await Promise.all(this.unregister.map(dispose=>dispose()));}
}
