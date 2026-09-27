import {normalLimits,readNormalPlan} from './test-heldout-memory-replay-ledger.js';
/** A single explicit integration window. No CLI or automatic live dispatch. */
import {readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {AgentAnswer,ContextReader,QueryInput} from '@mote/agent';
import type {QueryResult,UsageReceipt} from '@mote/shared';
import {memorySchema} from '../apps/server/src/memory-schema.js';
import {requestMemoryIntegration} from '../apps/server/src/memory-integration.js';
import {defaultMemoryIntegrationRecipe} from '../apps/server/src/memory-integration-policy.js';
import {lifecycleSettingsSchema} from '../apps/server/src/memory-lifecycle.js';
import {sha256} from '../apps/server/src/store.js';
import {usageTotals} from '../apps/server/src/usage.js';
import {check,equal,json,hashObject,closed,cloneClosed,sqliteCheck,externalNew,corpus,evaluation,verifyFreeze} from './test-heldout-memory-replay.js';
import {AdmissionLedger,inspectAdmissionLedger,StageSafetyError} from './test-heldout-memory-replay-ledger.js';
import {type Manifest,codeHashes,executorPins,treeHash,protectedTables,privateWrite,sealedError,safeCode,bindings,settings,openNode} from './test-heldout-memory-replay-stage.js';
import {type PhaseManifest,type Ref,type WavePlan,ref,readRef,rootAndRuntime,validation,phaseCursor,validateRecoveryRoot,validateNormalRoot} from './test-heldout-memory-replay-sequence.js';

type Node=Awaited<ReturnType<typeof openNode>>['node'];
type Stub=(reader:ContextReader,input:QueryInput)=>Promise<QueryResult>;
type Domain='personal'|'coding';
const domains:Domain[]=['personal','coding'];
export const integrationLimits={stageOuter:4,perOuterMs:300000,stageProcessMs:1320000,cumulativePlanningCap:124,automaticOuterRetries:0,concurrency:1} as const;
export type IntegrationSelection={schema:'mote-heldout-integration-selection@1';contextTime:string;capacity:number;allCardsHash:string;inputs:Array<{id:string;hash:string;domain:Domain}>;excluded:{stale:number;superseded:number;inactive:number;observation:number};protectedHash:string};
export type IntegrationPlan=IntegrationSelection&{experimentHash:string;wave:number;totalBatches:number;settingsHash:string;bindingsHash:string;wavePlan?:Ref};
export type IntegrationManifest=Omit<PhaseManifest,'task'|'limits'>&{task:{kind:'integration';wave:number;contextTime:string;selectionPlan:Ref};limits:typeof integrationLimits|typeof normalLimits.integration};

/** Complete structural scan, never LIMIT/slice/semantic ranking. Reads a closed snapshot. */
export function integrationSelection(db:DatabaseSync,contextTime:string):IntegrationSelection {
  check(Number.isFinite(Date.parse(contextTime)),'integration_clock_invalid');sqliteCheck(db);
  const lifecycle=lifecycleSettingsSchema.parse(JSON.parse(String(db.prepare('SELECT json FROM memory_lifecycle_settings WHERE id=1').get()!.json)));
  check(['extraction','consolidation','insights','working'].every(key=>!lifecycle[key as keyof Pick<typeof lifecycle,'extraction'|'consolidation'|'insights'|'working'>].enabled),'integration_background_enabled');
  check(lifecycle.consolidation.maxItems===30,'integration_frozen_capacity_changed');
  check(Number(db.prepare("SELECT count(*) n FROM memory_batches WHERE json_extract(json,'$.status')!='completed'").get()!.n)===0,'integration_extraction_unfinished');
  check(Number(db.prepare('SELECT count(*) n FROM memory_deletions').get()!.n)===0,'integration_extra_deletion_review_forbidden');
  for(const row of db.prepare('SELECT json FROM memory_lifecycle_state').all())check(!JSON.parse(String(row.json)).active,'integration_existing_window');
  const rows=db.prepare('SELECT id,json FROM memories ORDER BY id').all(),inputs:IntegrationSelection['inputs']=[],excluded={stale:0,superseded:0,inactive:0,observation:0};
  for(const row of rows){
    const raw=JSON.parse(String(row.json)),parsed=memorySchema.safeParse(raw);check(parsed.success,'integration_memory_shape_unknown');const card=parsed.data;
    check(card.status!=='proposed','integration_proposed_requires_review');check(card.admission,'integration_legacy_admission_unknown');
    if(card.status==='stale'){excluded.stale++;continue;}if(card.supersededBy){excluded.superseded++;continue;}
    if(card.validFrom&&Date.parse(card.validFrom)>Date.parse(contextTime)||card.validUntil&&Date.parse(card.validUntil)<=Date.parse(contextTime)){excluded.inactive++;continue;}
    if(card.admission.layer==='observation'){excluded.observation++;continue;}
    // The product defaults legacy missing domains to personal; no text classification.
    inputs.push({id:card.id,hash:hashObject({version:1,...raw}),domain:card.domain??'personal'});
  }
  const capacity=Math.min(50,lifecycle.consolidation.maxItems);check(inputs.length<=capacity,'integration_complete_set_over_capacity');
  return {schema:'mote-heldout-integration-selection@1',contextTime,capacity,allCardsHash:hashObject(rows),inputs,excluded,protectedHash:hashObject(protectedTables(db))};
}
async function selectionAt(parent:string,contextTime:string){await closed(parent);const db=new DatabaseSync(join(parent,'mote.sqlite'),{readOnly:true});try{return integrationSelection(db,contextTime);}finally{db.close();}}
function selectionFields(plan:IntegrationPlan):IntegrationSelection{const {experimentHash:_experimentHash,wave:_wave,totalBatches:_totalBatches,settingsHash:_settingsHash,bindingsHash:_bindingsHash,wavePlan:_wavePlan,...selection}=plan;return selection;}
async function boundary(root:Manifest,cursor:ReturnType<typeof phaseCursor>){
  check(cursor.nextBatch===cursor.totalBatches&&!cursor.integrationDone&&cursor.evaluatedPairs===0,'integration_phase_not_ready');
  if(!cursor.wavePlan){check(cursor.wave===1,'integration_wave_plan_missing');return {settingsHash:root.settingsHash,bindingsHash:root.bindingsHash,protectedHash:root.protectedHash};}
  const plan=await readRef<WavePlan>(cursor.wavePlan);check(plan.wave===cursor.wave&&plan.contextTime===cursor.contextTime&&plan.batchPlan.length===cursor.totalBatches,'integration_wave_plan_changed');return plan;
}
export async function validateIntegration(m:IntegrationManifest,ledgerDirectory:string){
  check(m.schema==='mote-heldout-phase-manifest@1'&&m.task.kind==='integration','integration_manifest_invalid');equal(m.limits,m.normalContinuation?normalLimits.integration:integrationLimits,'integration_limits_changed');
  const root=await rootAndRuntime(m.rootManifest);check(root.kind===m.kind&&root.experimentHash===m.experimentHash,'integration_experiment_changed');equal(m.runtime,root.runtime,'integration_runtime_changed');
  equal(await codeHashes(),m.codeHashes,'integration_executor_changed');await validation(m.validation,m.codeHashes,'integration');check(sha256(await readFile(m.executor.supervisorPath))===m.executor.supervisorHash,'integration_supervisor_changed');
  if(root.kind==='heldout'){await verifyFreeze(corpus,root.corpusFreeze);await verifyFreeze(evaluation,root.evaluationFreeze);check(sha256(await readFile(root.model.codexBin))===root.model.codexBinHash,'integration_codex_changed');}
  check(!m.normalContinuation||!m.recoveryLineage&&!Object.hasOwn(m,'recoveryE'),'normal_lineages_conflict');await validateRecoveryRoot(m.recoveryLineage,root,m.rootManifest,m.executor);await validateNormalRoot(m.normalContinuation,root,m.rootManifest,m.executor);const events=inspectAdmissionLedger(ledgerDirectory,m.experimentHash,m.recoveryLineage,m.normalContinuation);check(events.at(-1)?.sha256===m.parent.ledgerHeadHash,'integration_ledger_advanced');
  const previous=await readRef<Manifest|PhaseManifest>(m.previousManifest);check(previous.experimentHash===m.experimentHash&&events.filter(e=>e.kind==='executor-freeze').at(-1)?.data.manifestHash===m.previousManifest.sha256,'integration_previous_executor_changed');
  const cursor=phaseCursor(events,root,m.recoveryLineage,m.normalContinuation),expected=await boundary(root,cursor);check(cursor.wave===m.task.wave&&cursor.contextTime===m.task.contextTime&&cursor.archiveHeadHash===m.parent.treeHash,'integration_parent_not_canonical');
  check(await treeHash(m.parent.path)===m.parent.treeHash,'integration_parent_changed');const plan=await readRef<IntegrationPlan>(m.task.selectionPlan);
  check(plan.wave===cursor.wave&&plan.contextTime===cursor.contextTime&&plan.experimentHash===m.experimentHash&&plan.totalBatches===cursor.totalBatches,'integration_selection_scope_changed');equal(plan.wavePlan,cursor.wavePlan,'integration_wave_plan_changed');
  equal({settingsHash:plan.settingsHash,bindingsHash:plan.bindingsHash,protectedHash:plan.protectedHash},{settingsHash:expected.settingsHash,bindingsHash:expected.bindingsHash,protectedHash:expected.protectedHash},'integration_configuration_changed');
  equal(await selectionAt(m.parent.path,m.task.contextTime),selectionFields(plan),'integration_selection_changed');return {root,cursor,plan,ledgerHead:events.at(-1)!.sha256};
}
/** No app/model is opened during freeze. Selection details are sealed, not ROOT_SAFE. */
export async function freezeIntegration(options:{rootManifest:string;previousManifest:string;parent:string;ledgerDirectory:string;validation:string;supervisorPath:string;output:string;recoveryLineage?:PhaseManifest['recoveryLineage'];normalContinuation?:PhaseManifest['normalContinuation']}){
  const rootRef=await ref(options.rootManifest),root=await rootAndRuntime(rootRef),events=inspectAdmissionLedger(options.ledgerDirectory,root.experimentHash,options.recoveryLineage,options.normalContinuation),cursor=phaseCursor(events,root,options.recoveryLineage,options.normalContinuation),expected=await boundary(root,cursor);
  const selection=await selectionAt(options.parent,cursor.contextTime);equal(selection.protectedHash,expected.protectedHash,'integration_protected_source_changed');
  const plan:IntegrationPlan={...selection,experimentHash:root.experimentHash,wave:cursor.wave,totalBatches:cursor.totalBatches,settingsHash:expected.settingsHash,bindingsHash:expected.bindingsHash,...(cursor.wavePlan?{wavePlan:cursor.wavePlan}:{})};
  const planPath=join(options.output,'DO_NOT_OPEN','integration-selection.json');await privateWrite(planPath,plan);
  const m:IntegrationManifest={...(options.recoveryLineage?{recoveryLineage:options.recoveryLineage}:{}),...(options.normalContinuation?{normalContinuation:options.normalContinuation}:{}),schema:'mote-heldout-phase-manifest@1',kind:root.kind,experimentHash:root.experimentHash,rootManifest:rootRef,previousManifest:await ref(options.previousManifest),validation:await ref(options.validation),runtime:root.runtime,executor:{supervisorPath:options.supervisorPath,supervisorHash:sha256(await readFile(options.supervisorPath))},codeHashes:await codeHashes(),limits:options.normalContinuation?normalLimits.integration:integrationLimits,parent:{path:options.parent,treeHash:await treeHash(options.parent),ledgerHeadHash:events.at(-1)!.sha256},task:{kind:'integration',wave:cursor.wave,contextTime:cursor.contextTime,selectionPlan:await ref(planPath)}};
  await validateIntegration(m,options.ledgerDirectory);await privateWrite(join(options.output,'ROOT_SAFE_manifest.json'),m);return m;
}

/** Stateful ordering uses durable completed[] + fixed domain order, never question semantics. */
export class IntegrationCallOrder {
  private progress=new Map<Domain,{extracted:boolean;needsReview:boolean;reviewed:boolean}>();
  readonly activeDomains:Domain[];
  constructor(private inputs:IntegrationPlan['inputs']){this.activeDomains=domains.filter(domain=>inputs.some(input=>input.domain===domain));}
  next(completed:unknown,phase:unknown,question:string){
    check(Array.isArray(completed)&&completed.every((domain,i)=>domain===this.activeDomains[i]),'integration_completed_order_changed');
    const domain=this.activeDomains[completed.length];check(domain,'integration_extra_outer');const progress=this.progress.get(domain);
    if(phase==='extract')check(!progress,'integration_prior_domain_uncommitted_or_repeated');
    else check(phase==='review'&&progress?.extracted&&progress.needsReview&&!progress.reviewed,'integration_review_out_of_order');
    const ids=this.inputs.filter(input=>input.domain===domain).map(input=>input.id);
    check(question.endsWith('\n'+JSON.stringify(ids)),'integration_host_ids_changed');return domain;
  }
  complete(domain:Domain,phase:'extract'|'review',answer:string){
    const value=JSON.parse(answer);check(Array.isArray(value.memories),'integration_output_shape');
    if(phase==='extract')this.progress.set(domain,{extracted:true,needsReview:value.memories.length>0,reviewed:false});else this.progress.get(domain)!.reviewed=true;
  }
}

export async function runIntegration(options:{manifest:IntegrationManifest;manifestHash:string;output:string;ledgerDirectory:string;stub?:Stub;live?:true;perOuterMs?:number;mechanicalHook?:(node:Node)=>void}){
  const {manifest:m,output}=options;check(options.stub||options.live===true,'integration_live_not_enabled');check(options.stub?m.kind==='mechanical':m.kind==='heldout','integration_execution_mode_mismatch');check(m.kind==='mechanical'||!options.mechanicalHook&&options.perOuterMs===undefined,'integration_live_test_override');
  check(sha256(json(m))===options.manifestHash,'integration_manifest_changed');const {root,cursor,plan,ledgerHead}=await validateIntegration(m,options.ledgerDirectory);
  // Ledger lives outside both mutable clones and immutable parent snapshots.
  await externalNew(options.ledgerDirectory);for(const other of [output,m.parent.path])for(const [a,b] of [[other,options.ledgerDirectory],[options.ledgerDirectory,other]]){const part=relative(a,b);check(part==='..'||part.startsWith('../'),'integration_ledger_inside_snapshot');}
  const ledger=new AdmissionLedger(options.ledgerDirectory,m.experimentHash,124,m.recoveryLineage,undefined,m.normalContinuation),stage=`wave${m.task.wave}-integration`,vault=join(output,'DO_NOT_OPEN','working');let node:Node|undefined,started=false,succeeded=false,failure:unknown,windowId:string|undefined,snapshot='',inherited=new Set<string>(),admissionOpen=true,activeControl:AbortController|undefined;
  const order=new IntegrationCallOrder(plan.inputs),usedReceipts=new Set<string>();let inFlight=false;const report:Record<string,any>={schema:'mote-heldout-integration-stage@1',stage,phase:'integration',wave:m.task.wave,contextTime:m.task.contextTime,status:'running',manifestHash:options.manifestHash,selectionPlanHash:m.task.selectionPlan.sha256,inputCount:plan.inputs.length,capacity:plan.capacity,completedDomainCount:0,realModelCalls:0,stubModelCalls:0,semanticContentExposed:false,startedAt:new Date().toISOString(),limits:m.limits};
  const interrupted=()=>{ledger.stop('integration_interrupted');admissionOpen=false;activeControl?.abort();};process.on('SIGTERM',interrupted);process.on('SIGINT',interrupted);
  try{
    check(ledger.events.at(-1)?.sha256===ledgerHead,'integration_ledger_advanced');ledger.bindExecutor(options.manifestHash,m.previousManifest.sha256,m.validation.sha256);ledger.begin(stage,m.parent.treeHash,4);started=true;
    await cloneClosed(m.parent.path,vault);const initial=new DatabaseSync(join(vault,'mote.sqlite'),{readOnly:true});try{inherited=new Set(initial.prepare('SELECT id FROM model_usage').all().map(row=>String(row.id)));}finally{initial.close();}
    if(plan.inputs.length){
      ({node}=await openNode(vault,root.model,m.task.contextTime,options.stub,m.normalContinuation?600000:300000));equal(hashObject(settings(node)),plan.settingsHash,'integration_settings_changed');if(m.normalContinuation){const {assertRecoveryESettings}=await import('./test-heldout-memory-replay-recovery.js');equal(assertRecoveryESettings(node,root.settingsHash),readNormalPlan(m.normalContinuation.plan).effectiveSettingsHash,'normal_integration_settings_changed');report.effectiveAgentTimeoutMs=node.modelSettings.select('memory').settings.agentTimeoutMs;}equal(hashObject(bindings(node)),plan.bindingsHash,'integration_bindings_changed');equal(integrationSelection(node.store.db,m.task.contextTime),selectionFields(plan),'integration_open_changed_selection');
      for(const input of plan.inputs){check(hashObject(node.memories.get(input.id))===input.hash,'integration_input_changed');node.memoryPipeline.assertAdmissibleEvidence(node.memories.get(input.id).evidenceIds);}
      options.mechanicalHook?.(node);const query=node.agent.query.bind(node.agent);
      node.agent.query=async input=>{
        let callId:string|undefined,requests=0,repairs=0;const traces:unknown[]=[];
        try{
          check(admissionOpen&&!ledger.stopped,'integration_admission_closed');check(!inFlight,'integration_concurrency');
          equal(hashObject(protectedTables(node!.store.db)),plan.protectedHash,'integration_admission_source_changed');
          const trace=input.traceContext,phase=trace?.phase;check(windowId&&trace?.jobId===windowId&&trace.operationId==='workflow:lifecycle:'+windowId&&(phase==='extract'||phase==='review')&&input.skill==='memory-integration'&&input.responseMode==='memory-extraction','integration_outer_scope');check(input.contextTime===m.task.contextTime,'integration_outer_clock');
          check(input.modelOverride===root.model.model&&trace.model===root.model.model&&trace.provider===root.model.provider&&trace.protocol===root.model.protocol,'integration_outer_model_changed');
          const active=node!.lifecycle.view().extensions.find(e=>e.id==='consolidation')!.active;check(active?.id===windowId&&active.checkpoint&&active.checkpoint!=='completed','integration_window_changed');const checkpoint=JSON.parse(active.checkpoint),domain=order.next(checkpoint.completed,phase,input.question);
          const receipts=node!.store.db.prepare("SELECT id FROM model_usage WHERE json_extract(json,'$.status')='running'").all().map(row=>String(row.id)).filter(id=>!inherited.has(id)&&!usedReceipts.has(id));check(receipts.length===1,'integration_running_receipt_ambiguous');usedReceipts.add(receipts[0]);
          const serial=JSON.parse(JSON.stringify(input,(_key,value)=>typeof value==='function'?undefined:value));callId=ledger.reserve(hashObject([windowId,domain,phase]),hashObject(serial),receipts[0]);inFlight=true;
          await privateWrite(join(output,'DO_NOT_OPEN',callId+'-input.json'),serial);const control=new AbortController();activeControl=control;const abort=()=>control.abort(input.signal?.reason);input.signal?.addEventListener('abort',abort,{once:true});let timer:ReturnType<typeof setTimeout>|undefined;
          try{
            input.signal?.throwIfAborted();const answer=await Promise.race([query({...input,signal:control.signal,onTrace:event=>{traces.push(event);if(event.type==='model.started'){requests++;if((event.payload as {repair?:boolean}|undefined)?.repair)repairs++;}input.onTrace?.(event);}}),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{control.abort();reject(new StageSafetyError('integration_outer_deadline'));},options.perOuterMs??m.limits.perOuterMs);})]);
            const issue=await input.validateOutput?.(answer as AgentAnswer);check(!issue,'integration_outer_validation');order.complete(domain,phase,answer.answer);await privateWrite(join(output,'DO_NOT_OPEN',callId+'-result.json'),answer);ledger.terminal(callId,'completed','ok',{modelRunStarts:requests||null,repairs:requests?repairs:null});return answer;
          }finally{if(timer)clearTimeout(timer);input.signal?.removeEventListener('abort',abort);await privateWrite(join(output,'DO_NOT_OPEN',callId+'-trace.json'),traces);activeControl=undefined;}
        }catch(error){activeControl?.abort();ledger.stop(safeCode(error));if(callId&&ledger.pending().some(e=>e.data.callId===callId))ledger.terminal(callId,'failed',safeCode(error),{modelRunStarts:requests||null,repairs:requests?repairs:null});await sealedError(join(output,'DO_NOT_OPEN'),error);throw error;}
        finally{inFlight=false;}
      };
      const requested=requestMemoryIntegration({recipe:defaultMemoryIntegrationRecipe,memoryIds:plan.inputs.map(input=>input.id)},{lifecycle:node.lifecycle,memories:node.memories,pipeline:node.memoryPipeline});windowId=requested.id;await privateWrite(join(output,'DO_NOT_OPEN','window.json'),requested);await node.lifecycle.tick();
      check(!ledger.stopped,'integration_circuit_stopped');const state=node.lifecycle.view().extensions.find(e=>e.id==='consolidation')!;
      check(!state.active&&!state.error&&state.lastRun?.id===windowId&&node.executor.get('lifecycle:'+windowId)?.state==='succeeded','integration_window_not_committed');report.completedDomainCount=order.activeDomains.length;
      equal(hashObject(protectedTables(node.store.db)),plan.protectedHash,'integration_protected_source_mutated');
    }
    succeeded=true;
  }catch(error){failure=error;ledger.stop(safeCode(error));await sealedError(join(output,'DO_NOT_OPEN'),error);}
  finally{
    admissionOpen=false;if(node)try{await node.app.close();}catch(error){failure??=error;succeeded=false;ledger.stop('integration_close_failed');await sealedError(join(output,'DO_NOT_OPEN'),error);}
    try{
      await closed(vault);const db=new DatabaseSync(join(vault,'mote.sqlite'),{readOnly:true});let receipts:UsageReceipt[]=[];
      try{sqliteCheck(db);receipts=db.prepare('SELECT json FROM model_usage').all().map(row=>JSON.parse(String(row.json)) as UsageReceipt).filter(row=>!inherited.has(row.id));report.sourceProtectedHash=hashObject(protectedTables(db));if(windowId){const state=JSON.parse(String(db.prepare("SELECT json FROM memory_lifecycle_state WHERE id='consolidation'").get()!.json));report.completedDomainCount=state.active?.checkpoint&&state.active.checkpoint!=='completed'?JSON.parse(state.active.checkpoint).completed.length:state.lastRun?.id===windowId?order.activeDomains.length:0;}}finally{db.close();}
      const admitted=new Set(ledger.admitted.map(e=>e.data.receiptId)),rejected=receipts.filter(row=>!admitted.has(row.id));report.hostRejectedReceipts=rejected.length;if(rejected.length)succeeded=false;
      const safeReceipt=(row:UsageReceipt)=>({id:row.id,status:row.status,tokens:row.tokens,estimatedCost:row.estimatedCost,currency:row.currency,durationMs:row.durationMs});
      ledger.rejectedReceipts(rejected.map(safeReceipt));ledger.receipts(receipts.filter(row=>admitted.has(row.id)).map(safeReceipt));report.terminalUsage={readAfterClose:true,inherited:inherited.size,new:receipts.length,totals:usageTotals(receipts)};check(receipts.every(row=>row.status!=='running'),'integration_usage_unfinished');equal(report.sourceProtectedHash,plan.protectedHash,'integration_closed_source_mutated');
      snapshot=join(output,'DO_NOT_OPEN','closed-checkpoint');await cloneClosed(vault,snapshot);const snapshotHash=await treeHash(snapshot);check(await treeHash(m.parent.path)===m.parent.treeHash,'integration_parent_mutated');report.checkpoint={path:snapshot,treeHash:snapshotHash,parentTreeHash:m.parent.treeHash,canonical:succeeded};
      if(started)ledger.finish(snapshotHash,succeeded,succeeded?{kind:'integration',wave:cursor.wave,contextTime:cursor.contextTime,archiveHeadHash:snapshotHash,totalBatches:cursor.totalBatches,nextBatch:cursor.nextBatch,evaluatedPairs:0,...(cursor.wavePlan?{wavePlan:cursor.wavePlan}:{})}:undefined);
    }catch(error){failure??=error;succeeded=false;ledger.stop(safeCode(error));if(report.checkpoint)report.checkpoint.canonical=false;await sealedError(join(output,'DO_NOT_OPEN'),error);}
    const stageAdmissions=ledger.admitted.filter(row=>row.data.stage===stage).length;report.realModelCalls=options.stub?0:stageAdmissions;report.stubModelCalls=options.stub?stageAdmissions:0;report.status=succeeded?(plan.inputs.length?'completed':'completed-no-input'):'stopped';report.failure=failure?{code:safeCode(failure)}:undefined;report.cumulative={...ledger.summary(),usage:usageTotals(ledger.events.filter(row=>row.kind==='receipt').map(row=>row.data as UsageReceipt))};report.finishedAt=new Date().toISOString();process.off('SIGTERM',interrupted);process.off('SIGINT',interrupted);ledger.close();await privateWrite(join(output,'ROOT_SAFE_stage.json'),report);
  }
  return {succeeded,report,snapshot};
}
