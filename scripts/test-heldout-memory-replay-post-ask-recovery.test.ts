/** Native generated post-recovery waves only. No heldout semantics or real providers. */
import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {json,hashObject,cloneClosed,recipes} from './test-heldout-memory-replay.js';
import {sha256} from '../apps/server/src/store.js';
import {type Manifest,codeHashes,executorPins,newOutput,treeHash,runBatch,openNode,drain,assertRuntimePin} from './test-heldout-memory-replay-stage.js';
import {AdmissionLedger,readAdmissionChain,inspectAdmissionLedger,readAskRecoveryPlan,normalLimits} from './test-heldout-memory-replay-ledger.js';
import {type PhaseManifest,type WavePlan,ref,readRef,phaseCursor,freezePhase,runPhase} from './test-heldout-memory-replay-sequence.js';
import {freezeIntegration,runIntegration} from './test-heldout-memory-replay-integration.js';
import {type AskManifest,type AskPlan,freezeAsk,runAsk} from './test-heldout-memory-replay-ask.js';

const source=process.env.MOTE_HELDOUT_POST_ASK_RECOVERY_GENERATED_SOURCE??'';
assert.ok(source,'Explicit generated007 source is required');
const output=process.env.MOTE_HELDOUT_POST_ASK_RECOVERY_TEST_OUTPUT??'';
assert.ok(output,'Unique generated output is required');
assert.notEqual(resolve(source),resolve(output));
await mkdir(output,{mode:0o700});
const save=async(path:string,value:unknown)=>writeFile(path,json(value),{mode:0o600});
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Generated native validation forbids network');};
const checks:Array<Record<string,unknown>>=[];let stubCalls=0,calibrationProviderAttempts=0;
const testSourcePath=fileURLToPath(import.meta.url),testSourceSha256=sha256(await readFile(testSourcePath));
const expectedNames=['generated-recovery-prefix-and-cursor','current-validation-scope-and-pins','native-rollback-and-skipped-wave','native-original-waves3-through6','new-native-stop-prevents-next-admission','native-final-reconciled124-cursor','global124-overflow-rejected'];
const pins=executorPins(await codeHashes());let nativeCoverage:Record<string,unknown>|undefined;
const acceptanceBytes=await readFile(join(source,'ROOT_SAFE_ask-recovery.json'));
assert.equal(sha256(acceptanceBytes),'1896a940c941e51d2d12190d043bbdab37bdcfdbea433ea9246b0695751030a7');
const acceptance=JSON.parse(acceptanceBytes.toString());assert.equal(acceptance.status,'passed');assert.equal(acceptance.realModelCalls,0);assert.equal(acceptance.heldoutSemanticInputsRead,false);assert.deepEqual(acceptance.executorCodeHashes,pins);
const firstManifestPath=join(source,'inherited-recovery-freeze','ROOT_SAFE_manifest.json'),first=JSON.parse(await readFile(firstManifestPath,'utf8')) as AskManifest;
const root=await readRef<Manifest>(first.rootManifest);await assertRuntimePin(root.runtime);assert.equal(root.kind,'mechanical');assert.ok(first.normalContinuation&&first.normalReviewRecovery&&first.askRecovery);
const proof=first.askRecovery,normal=first.normalContinuation,review=first.normalReviewRecovery,plan=readAskRecoveryPlan(proof.plan);
assert.deepEqual(plan.newExecutors,pins);assert.equal(plan.inheritedAdmissions,28);assert.equal(plan.inheritedCompleted,24);assert.equal(plan.inheritedFailed,4);
const sourceLedgerPath=join(source,'inherited-ledger','admissions.ndjson'),sourceLedgerBytes=await readFile(sourceLedgerPath);
const sourceEvents=readAdmissionChain(join(source,'inherited-ledger'));
const firstClose=sourceEvents.find(e=>e.kind==='stage-close'&&e.data.stage===plan.targetStage&&e.data.succeeded===true);assert.ok(firstClose);
const lines=sourceLedgerBytes.toString().split('\n'),prefix=Buffer.from(lines.slice(0,firstClose.index+1).join('\n')+'\n');
assert.deepEqual(sourceLedgerBytes.subarray(0,prefix.length),prefix);
const ledgerDirectory=join(output,'native-ledger');await mkdir(ledgerDirectory,{mode:0o700});await writeFile(join(ledgerDirectory,'admissions.ndjson'),prefix,{mode:0o600});
const validation=join(output,'ROOT_SAFE_validator-shape-fixture.json');await save(validation,{schema:'mote-heldout-sequence-validation@1',status:'passed',realModelCalls:0,heldoutSemanticInputsRead:false,executorCodeHashes:pins,validatedPhases:['ingress','extraction','integration','evaluation'],note:'Generated validator-shape fixture; actual acceptance is final ROOT_SAFE_post-ask-native.json, never this file.'});
const common={rootManifest:first.rootManifest.path,ledgerDirectory,validation,supervisorPath:first.executor.supervisorPath,normalContinuation:normal,normalReviewRecovery:review,askRecovery:proof};
let previousManifest=firstManifestPath,parent=first.parent.path;
const readEvents=()=>inspectAdmissionLedger(ledgerDirectory,root.experimentHash,undefined,normal,review,proof);
const cursor=()=>phaseCursor(readEvents(),root,undefined,normal,review,proof);
const note=(wave:number,length:number)=>({externalId:'generated-native-wave-'+wave,revision:'1',kind:'message',layer:'original',observedAt:'2025-12-30T09:00:00+08:00',text:('Generated native wave '+wave+' literal. ').repeat(Math.ceil(length/34)).slice(0,length),document:{contentRole:'authored',recordedAt:'2025-12-29T09:00:00+08:00',timeBasis:'recorded'}});
const batches:Record<number,number>={3:10,4:6,5:8,6:6};
const inputs=new Map<number,string>();
const timings:Array<{wave:number;batches:number;ingressCalls:number;extractionCalls:number;integrationCalls:number;askCalls:number}>=[];
const usage=(input:QueryInput)=>{input.onTrace?.({type:'model.started',payload:{}});input.onUsage?.({measurement:'thread_cumulative',complete:true,inputTokens:8,outputTokens:4,totalTokens:12,requests:0,reportedRequests:0});};
const result=(answer:string,citations:QueryResult['citations']=[]):QueryResult=>({answer,citations,trace:[],runId:randomUUID()});
async function reviewResult(reader:ContextReader,input:QueryInput,draft?:QueryResult){const body=input.taskContext?.untrustedMemoryDraft;assert.ok(body);if(draft)return {...draft,answer:JSON.stringify(body),runId:randomUUID()};const ids=[...new Set(((body as {memories?:Array<{evidenceIds?:string[]}>}).memories??[]).flatMap(m=>m.evidenceIds??[]))],evidence=await reader.evidence({ids});return result(JSON.stringify(body),evidence.map(e=>({id:e.id,capturedAt:e.capturedAt,appName:e.appName,excerpt:e.ocrText})));}
const checkPrefix=async()=>{assert.deepEqual((await readFile(join(ledgerDirectory,'admissions.ndjson'))).subarray(0,prefix.length),prefix);assert.deepEqual(await readFile(sourceLedgerPath),sourceLedgerBytes);};

async function generatedInput(wave:number,canonical:string){
 const target=batches[wave],lengths=[12000*(target/2)-1000,12000*(target/2)-5000,12000*(target/2)-100,6000*(target/2),12000*(target/2)-11000];
 for(const [attempt,length] of lengths.entries()){
  const path=join(output,'calibration-wave'+wave+'-'+attempt);await cloneClosed(canonical,path);
  const opened=await openNode(path,root.model,root.contextTime,async()=>{calibrationProviderAttempts++;throw Error('Calibration provider forbidden');},600000);
  let total=0;
  try{const beforeHeads=new Map(opened.node.store.db.prepare('SELECT id,revision FROM material_heads WHERE retired=0').all().map(row=>[String(row.id),String(row.revision)]));await opened.request('PUT','/api/sources/recovery-fixture/items',note(wave,length));await drain(opened.node);const heads=opened.node.store.db.prepare('SELECT id,revision FROM material_heads WHERE retired=0 ORDER BY id').all(),changed=heads.filter(row=>beforeHeads.get(String(row.id))!==String(row.revision));const candidates=[...new Set(changed.flatMap(row=>opened.node.materials.evidenceIds(opened.node.materials.get(String(row.id))!.ref)))];assert.ok(candidates.length);const job=opened.node.memoryPipeline.create({evidenceIds:candidates,recipes,contextTime:root.contextTime,timeZone:'Asia/Shanghai',batchCharacters:12000});opened.node.memoryPipeline.pause(job.id);total=job.totalBatches;}finally{await opened.node.app.close();}
  assert.equal(calibrationProviderAttempts,0);
  if(total!==target)continue;
  const inputPath=join(output,'DO_NOT_OPEN_generated-wave'+wave+'-input.json');await save(inputPath,{contextTime:root.contextTime,expectedBatches:target,sources:[{id:'recovery-fixture',kind:'custom',deviceId:'generated-recovery',platform:'import'}],deliveries:[{sourceId:'recovery-fixture',item:note(wave,length),duplicate:false},{sourceId:'recovery-fixture',item:note(wave,length),duplicate:true}]});inputs.set(wave,inputPath);return inputPath;
 }
 throw Error('Generated original batch count calibration failed for wave'+wave);
}

async function rejectedFreeze(name:string,change:Record<string,unknown>,expectedCode:string){const before=await readFile(join(ledgerDirectory,'admissions.ndjson')),calls=stubCalls,beforeParent=await treeHash(parent);await assert.rejects(()=>freezePhase({...common,previousManifest,parent,kind:'ingress',wave:3,mechanicalInput:inputs.get(3),output:join(output,name),...change}),e=>e instanceof Error&&e.message===expectedCode);assert.deepEqual(await readFile(join(ledgerDirectory,'admissions.ndjson')),before);assert.equal(stubCalls,calls);assert.equal(await treeHash(parent),beforeParent);}

test('closed recovered pair starts the genuine inherited native cursor with exact current pins',async()=>{
 assert.deepEqual([cursor().wave,cursor().nextBatch,cursor().integrationDone,cursor().evaluatedPairs],[2,6,true,1]);assert.equal(cursor().archiveHeadHash,first.parent.treeHash);assert.equal(await treeHash(parent),first.parent.treeHash);assert.equal(readEvents().filter(e=>e.kind==='admit').length,30);assert.equal(readEvents().filter(e=>e.kind==='terminal'&&e.data.status==='failed').length,4);
 await generatedInput(3,parent);await checkPrefix();checks.push({name:'generated-recovery-prefix-and-cursor',passed:true,inheritedAdmissions:30,inheritedFailed:4,syntheticLaterClosuresUsed:false,calibrationProviderAttempts});
});
test('validation scope or changed current pin refuses the next native freeze without append',async()=>{
 for(const change of ['scope','pin'] as const){const path=join(output,'bad-'+change+'-validation.json');await save(path,{schema:'mote-heldout-sequence-validation@1',status:'passed',realModelCalls:0,heldoutSemanticInputsRead:false,executorCodeHashes:change==='pin'?{...pins,'scripts/test-heldout-memory-replay.ts':'0'.repeat(64)}:pins,validatedPhases:change==='scope'?['extraction']:['ingress']});await rejectedFreeze('bad-'+change,{validation:path},change==='scope'?'phase_validation_scope_missing':'phase_validation_wrong_executor');}
 checks.push({name:'current-validation-scope-and-pins',passed:true,newAdmissions:0});
});
test('rollback and skipped original wave refuse before append or stub',async()=>{
 await rejectedFreeze('rollback',{parent:root.seed},'phase_parent_not_archive_head');await rejectedFreeze('skip',{wave:4},'phase_ingress_not_next');checks.push({name:'native-rollback-and-skipped-wave',passed:true,newAdmissions:0});
});
test('waves3–6 run actual normal ingress, every original batch, integration and remaining paired Ask',async()=>{
 const fixed=await readRef<AskPlan>(first.task.plan);const generatedDomainSeen=new Set<string>();
 for(const wave of [3,4,5,6]){
  const waveCalls={wave,batches:batches[wave],ingressCalls:0,extractionCalls:0,integrationCalls:0,askCalls:0};
  const input=inputs.get(wave)??await generatedInput(wave,parent),priorHash=await treeHash(parent),ingressOut=await newOutput(join(output,'wave'+wave+'-ingress-freeze'));
  const ingress=await freezePhase({...common,previousManifest,parent,kind:'ingress',wave,mechanicalInput:input,output:ingressOut});previousManifest=join(ingressOut,'ROOT_SAFE_manifest.json');assert.deepEqual(ingress.limits,normalLimits.ingress);
  const ingressed=await runPhase({manifestPath:previousManifest,output:await newOutput(join(output,'wave'+wave+'-ingress')),ledgerDirectory});assert.ok(ingressed.succeeded,JSON.stringify(ingressed.report.failure));assert.equal(ingressed.report.providerAdmissionAttempts,0);assert.equal(ingressed.report.terminalUsage.new,0);assert.equal(ingressed.report.counts.duplicates,1);assert.equal(ingressed.report.counts.batches,batches[wave]);assert.equal(await treeHash(parent),priorHash);parent=ingressed.report.checkpoint.path;
  const nativePlan=await readRef<WavePlan>(ingressed.report.wavePlan);
  if(wave===3){const before=await readFile(join(ledgerDirectory,'admissions.ndjson')),beforeCalls=stubCalls,beforeParent=await treeHash(parent);await assert.rejects(()=>freezeIntegration({...common,previousManifest,parent,output:join(output,'before-extraction-integration')}),e=>e instanceof Error&&e.message==='integration_phase_not_ready');assert.deepEqual(await readFile(join(ledgerDirectory,'admissions.ndjson')),before);assert.equal(stubCalls,beforeCalls);assert.equal(await treeHash(parent),beforeParent);}
  for(let index=0;index<batches[wave];index++){
   const frozen=await newOutput(join(output,'wave'+wave+'-batch'+index+'-freeze')),m=await freezePhase({...common,previousManifest,parent,kind:'extraction',index,output:frozen});assert.deepEqual(m.limits,normalLimits.extraction);previousManifest=join(frozen,'ROOT_SAFE_manifest.json');
   const recipe=nativePlan.batchPlan[index].recipe as {id:string},domain=recipe.id==='mote.coding-memory'?'coding':'personal';let draft:QueryResult|undefined;
   const extracted=await runBatch({manifest:root,manifestHash:sha256(await readFile(previousManifest)),sequence:m,ledgerDirectory,output:await newOutput(join(output,'wave'+wave+'-batch'+index)),stub:async(reader,input)=>{
    stubCalls++;waveCalls.extractionCalls++;usage(input);if(input.traceContext?.phase==='review')return reviewResult(reader,input,draft);
    if(generatedDomainSeen.has(wave+'/'+domain))return result('{"memories":[]}');generatedDomainSeen.add(wave+'/'+domain);
    const e=(await reader.evidence({ids:input.evidenceIds!}))[0];assert.ok(e);return draft=result(JSON.stringify({memories:[{domain,title:'Generated native extraction',statement:'Generated observed marker ['+e.id+']',uncertainty:'Mechanical only',admission:{layer:'memory',reason:'Generated fixture',scope:'Generated wave',attribution:'observed'},evidenceIds:[e.id],evidence:[{id:e.id,quote:e.ocrText.slice(0,60)}],...(domain==='coding'?{coding:{kind:'decision',scope:'session',applicability:'Generated fixture',validation:'observed'}}:{})}]}),[{id:e.id,appName:e.appName,capturedAt:e.capturedAt,excerpt:e.ocrText.slice(0,60)}]);
   }});assert.ok(extracted.succeeded,JSON.stringify(extracted.report.failure));assert.ok(extracted.report.stubModelCalls<=2);assert.equal(extracted.report.realModelCalls,0);parent=extracted.snapshot;await checkPrefix();
  }
  const integratedFreeze=await newOutput(join(output,'wave'+wave+'-integration-freeze')),m=await freezeIntegration({...common,previousManifest,parent,output:integratedFreeze});assert.deepEqual(m.limits,normalLimits.integration);previousManifest=join(integratedFreeze,'ROOT_SAFE_manifest.json');let draft:QueryResult|undefined;
  const integrated=await runIntegration({manifest:m,manifestHash:sha256(await readFile(previousManifest)),ledgerDirectory,output:await newOutput(join(output,'wave'+wave+'-integration')),stub:async(reader,input)=>{
   stubCalls++;waveCalls.integrationCalls++;usage(input);if(input.traceContext?.phase==='review')return reviewResult(reader,input,draft);
   const ids=JSON.parse(input.question.slice(input.question.lastIndexOf('\n')+1)) as string[],cards=await Promise.all(ids.map(async id=>(await reader.memories!({id})).items[0] as any)),domain=cards[0].domain??'personal',evidenceIds=[...new Set(cards.flatMap(card=>card.evidenceIds))] as string[],evidence=await reader.evidence({ids:evidenceIds});return draft=result(JSON.stringify({memories:[{domain,title:'Generated native integration wave'+wave,statement:'Generated wave '+wave+' synthesis '+evidenceIds.map(id=>'['+id+']').join(' '),uncertainty:'Mechanical only',admission:{layer:'memory',reason:'Generated fixture',scope:'Generated wave',attribution:'observed'},relatedMemoryIds:ids,evidenceIds,evidence:evidence.map(e=>({id:e.id,quote:e.ocrText.slice(0,60)})),...(domain==='coding'?{coding:{kind:'decision',scope:'session',applicability:'Generated fixture',validation:'observed'}}:{})}]}),evidence.map(e=>({id:e.id,capturedAt:e.capturedAt,appName:e.appName,excerpt:e.ocrText.slice(0,60)})));
  }});assert.ok(integrated.succeeded,JSON.stringify(integrated.report.failure));assert.ok(waveCalls.integrationCalls>0&&waveCalls.integrationCalls<=4);assert.equal(integrated.report.terminalUsage.readAfterClose,true);assert.equal(integrated.report.hostRejectedReceipts,0);parent=integrated.snapshot;
  const archiveHead=await treeHash(parent),count=fixed.pairs.filter(pair=>pair.checkpointWave===wave).length;
  if(wave<6){const before=await readFile(join(ledgerDirectory,'admissions.ndjson')),beforeCalls=stubCalls,beforeParent=await treeHash(parent);await assert.rejects(()=>freezePhase({...common,previousManifest,parent,kind:'ingress',wave:wave+1,mechanicalInput:input,output:join(output,'wave'+wave+'-pair-not-closed')}),e=>e instanceof Error&&e.message==='phase_ingress_not_ready');assert.deepEqual(await readFile(join(ledgerDirectory,'admissions.ndjson')),before);assert.equal(stubCalls,beforeCalls);assert.equal(await treeHash(parent),beforeParent);}
  for(let pair=0;pair<count;pair++){
   const out=await newOutput(join(output,'wave'+wave+'-pair'+pair+'-freeze')),ask=await freezeAsk({...common,previousManifest,parent,output:out,planPath:first.task.plan.path});assert.deepEqual(ask.limits,normalLimits.evaluation);previousManifest=join(out,'ROOT_SAFE_manifest.json');
   const asked=await runAsk({manifest:ask,manifestHash:sha256(await readFile(previousManifest)),ledgerDirectory,output:await newOutput(join(output,'wave'+wave+'-pair'+pair)),stub:async(reader,input)=>{stubCalls++;waveCalls.askCalls++;usage(input);const page=await reader.timeline({limit:100}),rows=Array.isArray(page)?page:page.items;return result('GENERATED_NATIVE_COMPLETE_ANSWER',rows.map(e=>({id:e.id,capturedAt:e.capturedAt,appName:e.appName,excerpt:e.ocrText.slice(0,60)})));}});assert.ok(asked.succeeded,JSON.stringify(asked.report.failure));assert.equal(asked.report.completedCalls,2);assert.equal(await treeHash(parent),archiveHead);assert.equal(cursor().archiveHeadHash,archiveHead);
  }
  assert.equal(cursor().evaluatedPairs,count);assert.equal(cursor().integrationDone,true);timings.push(waveCalls);await save(join(output,'ROOT_SAFE_progress.json'),{semanticContentExposed:false,realModelCalls:0,stubModelCalls:stubCalls,nativeWaves:timings});
 }
 assert.equal(cursor().wave,6);assert.equal(cursor().evaluatedPairs,4);checks.push({name:'native-original-waves3-through6',passed:true,waves:timings,syntheticPhaseClosures:0,remainingPairedAsk:7});
});
test('new generated extraction failure bars further admissions through the inherited proof',async()=>{
 const mPath=join(output,'wave3-batch0-freeze','ROOT_SAFE_manifest.json'),m=JSON.parse(await readFile(mPath,'utf8')) as PhaseManifest;
 const all=readAdmissionChain(ledgerDirectory),head=all.find(e=>e.sha256===m.parent.ledgerHeadHash);assert.ok(head);
 const failedLedger=join(output,'failure-ledger');await mkdir(failedLedger,{mode:0o700});await writeFile(join(failedLedger,'admissions.ndjson'),all.slice(0,head.index+1).map(e=>JSON.stringify(e)).join('\n')+'\n',{mode:0o600});let calls=0;
 const failed=await runBatch({manifest:root,manifestHash:sha256(await readFile(mPath)),sequence:m,ledgerDirectory:failedLedger,output:await newOutput(join(output,'failure-batch')),stub:async(_reader,input)=>{calls++;stubCalls++;input.onTrace?.({type:'model.started',payload:{}});throw Error('Generated post-recovery native failure');}});assert.equal(failed.succeeded,false);assert.equal(calls,1);assert.throws(()=>inspectAdmissionLedger(failedLedger,root.experimentHash,undefined,normal,review,proof),e=>e instanceof Error&&e.message==='ask_recovery_new_stop_forbidden');const before=await readFile(join(failedLedger,'admissions.ndjson')),beforeParent=await treeHash(failed.snapshot),beforeCalls=stubCalls;await assert.rejects(()=>freezePhase({...common,ledgerDirectory:failedLedger,previousManifest:mPath,parent:failed.snapshot,kind:'extraction',index:1,output:join(output,'forbidden-after-failure')}),e=>e instanceof Error&&e.message==='ask_recovery_new_stop_forbidden');assert.deepEqual(await readFile(join(failedLedger,'admissions.ndjson')),before);assert.equal(stubCalls,beforeCalls);assert.equal(await treeHash(failed.snapshot),beforeParent);checks.push({name:'new-native-stop-prevents-next-admission',passed:true,failureOuter:1,laterOuter:0});
});
test('native final cursor stays within global124 cap with historical failures and exact prefixes retained',async()=>{
 const events=readEvents(),admitted=events.filter(e=>e.kind==='admit'),receipts=events.filter(e=>e.kind==='receipt'),failed=events.filter(e=>e.kind==='terminal'&&e.data.status==='failed');assert.ok(admitted.length<=124);assert.equal(failed.length,4);assert.equal(receipts.length,admitted.length);assert.equal(receipts.filter(e=>e.data.status==='failed').length,4);assert.equal(receipts.filter(e=>e.data.tokens?.complete!==true).length,4);assert.deepEqual(events.filter(e=>e.kind==='stop').map(e=>e.sha256),plan.stopHashes);assert.equal(cursor().wave,6);assert.equal(cursor().integrationDone,true);assert.equal(cursor().evaluatedPairs,4);assert.equal(calibrationProviderAttempts,0);await checkPrefix();assert.deepEqual(executorPins(await codeHashes()),pins);
 const later=events.filter(e=>e.index>firstClose.index),closes=later.filter(e=>e.kind==='stage-close'&&e.data.succeeded===true),ofKind=(kind:string)=>closes.filter(e=>(e.data.phase as {kind?:string})?.kind===kind),ingress=ofKind('ingress'),extraction=ofKind('extraction'),integration=ofKind('integration'),evaluation=ofKind('evaluation');
 assert.deepEqual([ingress.length,extraction.length,integration.length,evaluation.length],[4,30,4,7]);assert.equal(new Set(closes.map(e=>e.data.stage)).size,45);
 const actualBatchCounts:Record<number,number>={},actualPairCounts:Record<number,number>={};for(const wave of [3,4,5,6]){actualBatchCounts[wave]=extraction.filter(e=>(e.data.phase as {wave?:number}).wave===wave).length;actualPairCounts[wave]=evaluation.filter(e=>(e.data.phase as {wave?:number}).wave===wave).length;assert.equal(ingress.filter(e=>(e.data.phase as {wave?:number}).wave===wave).length,1);assert.equal(integration.filter(e=>(e.data.phase as {wave?:number}).wave===wave).length,1);}assert.deepEqual(actualBatchCounts,batches);assert.deepEqual(actualPairCounts,{3:1,4:1,5:1,6:4});
 const pairStages=new Set(evaluation.map(e=>e.data.stage)),arms=later.filter(e=>e.kind==='admit'&&pairStages.has(e.data.stage));assert.equal(arms.length,14);for(const close of evaluation)assert.equal(arms.filter(e=>e.data.stage===close.data.stage).length,2);for(const arm of arms){assert.equal(later.filter(e=>e.kind==='terminal'&&e.data.callId===arm.data.callId&&e.data.status==='completed').length,1);assert.equal(later.filter(e=>e.kind==='receipt'&&e.data.id===arm.data.receiptId&&e.data.status==='completed').length,1);}
 nativeCoverage={successfulIngressStages:4,successfulExtractionStages:30,uniqueNativeSuccessStages:45,successfulIntegrationStages:4,successfulLaterPairs:7,completedLaterArms:14,actualBatchCounts,actualPairCounts,derivedFromValidatedEventChain:true,syntheticNativePhaseClosures:0};checks.push({name:'native-final-reconciled124-cursor',passed:true,admitted:admitted.length,failed:4,incompleteUsage:4,unknownCalls:0,prefixBytes:prefix.length,source007Unchanged:true});
});
test('isolated generated ledger rejects the125th global admission before any model call',async()=>{
 const directory=join(output,'cap-ledger'),before=await readFile(join(ledgerDirectory,'admissions.ndjson'));await mkdir(directory,{mode:0o700});await writeFile(join(directory,'admissions.ndjson'),before,{mode:0o600});const initial=readEvents().filter(e=>e.kind==='admit').length,ledger=new AdmissionLedger(directory,root.experimentHash,124,undefined,undefined,normal,review,proof),calls=stubCalls;
 try{ledger.begin('generated-ledger-cap-counterexample',cursor().archiveHeadHash,125);for(let i=initial;i<124;i++){const id=randomUUID(),call=ledger.reserve(hashObject(['generated-cap',i]),hashObject(['generated-cap-input',i]),id);ledger.terminal(call,'completed','generated-mechanical-only',{modelRunStarts:1,repairs:0});ledger.receipts([{id,status:'completed',tokens:{complete:true,totalTokens:1}}]);}assert.equal(ledger.admitted.length,124);assert.throws(()=>ledger.reserve(hashObject(['generated-cap',124]),hashObject(['generated-cap-input',124]),randomUUID()),e=>e instanceof Error&&e.message==='admission_budget_exceeded');assert.equal(ledger.admitted.length,124);}finally{ledger.close();}
 assert.equal(stubCalls,calls);assert.deepEqual(await readFile(join(ledgerDirectory,'admissions.ndjson')),before);assert.equal(readAdmissionChain(directory).filter(e=>e.kind==='admit').length,124);checks.push({name:'global124-overflow-rejected',passed:true,attemptedGlobalAdmission:125,admitted:124,additionalModelCalls:0,scope:'Isolated generated ledger-only counterexample; synthetic metadata admissions are not native pipeline/stub model calls.'});
});
after(async()=>{globalThis.fetch=originalFetch;const sourceUnchanged=sha256(await readFile(testSourcePath))===testSourceSha256,names=checks.map(c=>String(c.name)),complete=checks.length===expectedNames.length&&new Set(names).size===expectedNames.length&&expectedNames.every(name=>names.includes(name))&&checks.every(c=>c.passed===true)&&sourceUnchanged&&nativeCoverage?.uniqueNativeSuccessStages===45;await save(join(output,'ROOT_SAFE_post-ask-native.json'),{schema:'mote-heldout-sequence-validation@1',status:complete?'passed':'incomplete',validatedPhases:['ingress','extraction','integration','evaluation'],executorCodeHashes:pins,checks,realModelCalls:0,stubModelCalls:stubCalls,heldoutSemanticInputsRead:false,calibrationProviderAttempts,runtimeUsed:root.runtime,testSource:{path:testSourcePath,sha256:testSourceSha256,unchangedAfterRun:sourceUnchanged},sourceAcceptance:{path:join(source,'ROOT_SAFE_ask-recovery.json'),sha256:sha256(acceptanceBytes)},nativeWaves:timings,nativeCoverage,scope:'Actual generated native waves3–6 after genuine normal/review/correction/Ask recovery; separate ledger-only cap counterexample. No live provider, heldout semantics, physical supervisor process, or new TS executor pins.'});assert.equal(sourceUnchanged,true,'Generated test source changed during execution');});
