import {normalAuthorization,type NormalContinuation} from './test-heldout-memory-replay-ledger.js';
/** Read-only, zero-model projection of a complete frozen eight-pair Ask run. */
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {calendarSchema,documentSchema} from '../packages/shared/src/sources.js';
import {fileEvidenceSchema} from '../packages/shared/src/files.js';
import {sourceMetadataSchema} from '../packages/shared/src/metadata.js';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const objectHash=(value:unknown)=>hash(JSON.stringify(value));
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const hex=z.string().regex(/^[a-f0-9]{64}$/);
const refSchema=z.object({path:z.string(),sha256:hex}).strict();
type Ref=z.infer<typeof refSchema>;
const limits={stageOuter:2,perOuterMs:300000,stageProcessMs:720000,cumulativePlanningCap:124,automaticOuterRetries:0,concurrency:1};
const inputSchema=z.object({schema:z.literal('mote-heldout-review-input@1'),kind:z.enum(['heldout','mechanical']),experimentHash:hex,
  rootManifest:refSchema,ledger:refSchema,commitment:refSchema,
  pairs:z.array(z.object({manifest:refSchema,stage:refSchema,supervision:refSchema,result:refSchema}).strict()).length(8)}).strict();
const questionSchema=z.object({questionId:z.string().min(1),scenario:z.string().min(1),question:z.string().min(1),checkpointWave:z.number().int().min(2).max(6),contextTime:z.string().datetime({offset:true})}).strict();
const slotSchema=z.object({id:z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),label:z.enum(['Response 1','Response 2']),removeMemory:z.boolean()}).strict();
const planSchema=z.object({schema:z.literal('mote-heldout-ask-plan@1'),experimentHash:hex,questionsHash:hex,
  pairs:z.array(questionSchema.extend({slots:z.array(slotSchema).length(2)})).length(8)}).strict();
// These are the actual citation fields returned by agent.parseAnswer through
// /api/query, including bridge.project's public provenance enrichment. Validate
// nested public schemas without accepting their trim/default transformations.
const unchangedValue=<T extends z.ZodTypeAny>(schema:T)=>z.custom<z.infer<T>>(value=>schema.safeParse(value).success);
const provenanceSchema=z.object({sourceId:z.string().optional(),externalId:z.string().optional(),revision:z.string().optional(),layer:z.string().optional(),
  document:unchangedValue(documentSchema).optional(),deleted:z.boolean().optional(),calendar:unchangedValue(calendarSchema).optional(),
  modifiedAt:z.string().optional(),metadata:unchangedValue(sourceMetadataSchema).optional(),originalAvailable:z.boolean().optional()}).strict();
const citationSchema=unchangedValue(z.object({id:z.string(),capturedAt:z.string(),appName:z.string(),excerpt:z.string(),contentAt:z.string().optional(),
  fileEvidence:unchangedValue(fileEvidenceSchema).optional(),provenance:provenanceSchema.optional()}).strict());
const resultSchema=z.object({question:z.string(),results:z.array(z.object({label:slotSchema.shape.label,slotId:z.string(),callId:z.string(),closedTreeHash:hex,
  answer:z.object({answer:z.string(),citations:z.array(citationSchema)}).passthrough()}).strict()).length(2)}).strict();
type Event={index:number;at:string;previous:string;kind:string;data:Record<string,any>;sha256:string};
export class ReviewFailure extends Error{constructor(readonly code:string){super(code);}}
function check(ok:unknown,code:string):asserts ok{if(!ok)throw new ReviewFailure(code);}
const equal=(a:unknown,b:unknown,code:string)=>check(isDeepStrictEqual(a,b),code);
const outside=(path:string)=>{const r=relative(repository,path);check(r==='..'||r.startsWith('../'),'review_path_inside_repository');};

/** Does not open SQLite, instantiate a ledger, load a provider, or inspect a rubric. */
export async function exportBlindReview(inputPath:string,output:string){
  check(isAbsolute(inputPath)&&isAbsolute(output),'review_absolute_paths_required');
  outside(inputPath);outside(output);
  check(await realpath(inputPath)===inputPath,'review_input_path_alias');
  check(await realpath(dirname(output))===dirname(output),'review_output_parent_alias');
  try{await lstat(output);throw new ReviewFailure('review_output_exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const sources=new Map<string,string>();
  const note=(path:string,sha256:string)=>{check(!sources.has(path)||sources.get(path)===sha256,'review_conflicting_source_pin');sources.set(path,sha256);};
  const source=async(ref:Ref)=>{refSchema.parse(ref);check(isAbsolute(ref.path),'review_absolute_paths_required');outside(ref.path);
    check(await realpath(ref.path)===ref.path,'review_source_path_alias');
    check(!ref.path.startsWith(output+'/')&&ref.path!==output&&!output.startsWith(ref.path+'/'),'review_source_output_overlap');
    const bytes=await readFile(ref.path);check(hash(bytes)===ref.sha256,'review_source_hash_changed');note(ref.path,ref.sha256);return bytes;};
  const read=async(ref:Ref)=>JSON.parse((await source(ref)).toString()) as Record<string,any>;
  const inputBytes=await readFile(inputPath),input=inputSchema.parse(JSON.parse(inputBytes.toString()));note(inputPath,hash(inputBytes));
  const root=await read(input.rootManifest);check(root.schema==='mote-heldout-first-batch-manifest@1'&&!root.continuation&&root.experimentHash===input.experimentHash&&root.kind===input.kind,'review_experiment_changed');
  // Recompute the public frozen experiment identity without opening any pinned
  // corpus, source tree, database or model executable.
  const pins=z.record(z.string(),hex).parse(root.codeHashes);
  check(objectHash({corpus:root.corpusFreeze,evaluation:root.evaluationFreeze,production:Object.fromEntries(Object.entries(pins).filter(([file])=>!file.startsWith('scripts/'))),model:root.model,runtime:root.runtime,bindings:root.bindingsHash,initialSeed:root.seedTreeHash,initialBatchPlan:root.batchPlan,plan:root.experimentPlan})===input.experimentHash,'review_experiment_identity_invalid');
  const ledgerDirectory=dirname(input.ledger.path);
  check(input.ledger.path===join(ledgerDirectory,'admissions.ndjson')&&input.commitment.path===join(ledgerDirectory,'ask-plan-commitment.json'),'review_ledger_path_invalid');
  check(!existsSync(join(ledgerDirectory,'writer.lock')),'review_ledger_running');
  check(!output.startsWith(ledgerDirectory+'/')&&!ledgerDirectory.startsWith(output+'/'),'review_output_overlaps_ledger');
  const commitment=await read(input.commitment);check(commitment.schema==='mote-heldout-ask-plan-commitment@1'&&commitment.experimentHash===input.experimentHash,'review_commitment_invalid');
  const planRef=refSchema.parse(commitment.plan),plan=planSchema.parse(await read(planRef));
  check(plan.experimentHash===input.experimentHash,'review_plan_experiment_changed');
  check(new Set(plan.pairs.map(p=>p.questionId)).size===8,'review_duplicate_question');
  equal([2,3,4,5,6].map(w=>plan.pairs.filter(p=>p.checkpointWave===w).length),[1,1,1,1,4],'review_question_distribution');
  const slots=plan.pairs.flatMap(p=>p.slots);check(new Set(slots.map(s=>s.id)).size===16,'review_duplicate_slot');
  for(const p of plan.pairs){equal(p.slots.map(s=>s.label).sort(),['Response 1','Response 2'],'review_labels_invalid');check(p.slots.filter(s=>s.removeMemory).length===1,'review_treatments_invalid');}
  check(objectHash(plan.pairs.map(({slots,...q})=>q))===plan.questionsHash,'review_questions_hash_changed');
  const ledgerBytes=await source(input.ledger),text=ledgerBytes.toString();check(text.endsWith('\n'),'review_partial_ledger');
  const events:Event[]=[],lineEnds:number[]=[];let byteOffset=0;
  for(const line of text.slice(0,-1).split('\n')){byteOffset+=Buffer.byteLength(line+'\n');lineEnds.push(byteOffset);const event=JSON.parse(line) as Event;const {sha256,...body}=event;
    check(event.index===events.length&&event.previous===(events.at(-1)?.sha256??'genesis')&&objectHash(body)===sha256,'review_ledger_chain_invalid');
    check(typeof event.at==='string'&&['manifest','executor-freeze','stage-open','admit','terminal','receipt','host-rejection-receipt','stage-close','stop','recovery-authorized','recovery-e-authorized','normal-continuation-authorized'].includes(event.kind)&&event.data&&typeof event.data==='object','review_ledger_event_invalid');events.push(event);}
  check(events[0]?.kind==='manifest'&&events[0].data.manifestHash===input.experimentHash&&events[0].data.cumulativeCap===124,'review_ledger_experiment_changed');
  const by=(kind:string)=>events.filter(e=>e.kind===kind),opens=by('stage-open'),closes=by('stage-close'),admissions=by('admit');
  const normalEvents=by('normal-continuation-authorized');check(normalEvents.length<=1,'review_normal_ambiguous');let normal:NormalContinuation|undefined;const oldFailedClosures=new Set<string>();if(normalEvents.length){const event=normalEvents[0];normal={plan:refSchema.parse(event.data.plan),eventHash:event.sha256};const p=await read(normal.plan),ep=await read(refSchema.parse(p.parentE?.plan)),dp=await read(refSchema.parse(ep.parentD?.plan));for(const value of [p.request,p.preparationCommitment,ep.request,ep.preparationCommitment,dp.preparationCommitment])await read(refSchema.parse(value));try{normalAuthorization(events,normal);}catch{check(false,'review_normal_proof_invalid');}equal(p.rootManifest,input.rootManifest,'review_normal_root_changed');oldFailedClosures.add(ep.failedCloseHash);oldFailedClosures.add(dp.failedCloseHash);}else check(!by('recovery-e-authorized').length,'review_normal_required');
  check(by('manifest').length===1&&admissions.length<=124,'review_ledger_budget_invalid');
  check(new Set(opens.map(e=>e.data.stage)).size===opens.length&&closes.length===opens.length,'review_stage_closure_ambiguous');
  for(const open of opens){const matches=closes.filter(e=>e.data.stage===open.data.stage);check(matches.length===1&&matches[0].index>open.index,'review_stage_unclosed');
    const close=matches[0];check(typeof open.data.stage==='string'&&open.data.stage.length>0&&typeof close.data.succeeded==='boolean'&&Number.isInteger(open.data.maxCalls)&&open.data.maxCalls>=0&&open.data.maxCalls<=4,'review_stage_shape_invalid');
    check(!opens.some(other=>other.index>open.index&&other.index<close.index),'review_stages_overlap');
    check(close.data.phase===undefined?(oldFailedClosures.has(close.sha256)||/^wave1-batch-\d+$/.test(close.data.stage)):close.data.phase!==null&&['ingress','extraction','integration','evaluation'].includes(close.data.phase.kind),'review_stage_phase_unknown');
    check(admissions.filter(a=>a.data.stage===open.data.stage).length<=open.data.maxCalls,'review_stage_budget_exceeded');
    if(close.data.succeeded===false)check(by('stop').some(s=>s.index>open.index&&s.index<close.index),'review_failed_stage_without_stop');}
  check(events.at(-1)?.kind==='stage-close'&&events.at(-1)?.data.succeeded===true,'review_final_stage_not_closed');
  // Historical paid failures stay in the chain. Only already recorded, hash-bound
  // recovery events can cover old stops; this is not a recovery authorization API.
  const covered=new Set<string>();check(by('recovery-authorized').length<=1,'review_recovery_ambiguous');
  if(normal){for(const h of normalAuthorization(events,normal).stopHashes)covered.add(h);}
  else for(const event of by('recovery-authorized')){const p=await read(refSchema.parse(event.data.plan));
    check(p.experimentHash===input.experimentHash&&p.stoppedHeadHash===event.previous&&Array.isArray(p.stopHashes)&&p.stopHashes.length>0,'review_recovery_binding_invalid');
    check(!by('stop').some(e=>e.index>event.index),'review_stop_after_recovery');
    for(const h of p.stopHashes){check(events.some(e=>e.kind==='stop'&&e.sha256===h&&e.index<event.index)&&!covered.has(h),'review_recovery_stop_invalid');covered.add(h);}}
  check(by('stop').every(e=>covered.has(e.sha256)),'review_unresolved_stop');
  check(new Set(admissions.map(e=>e.data.callId)).size===admissions.length&&new Set(admissions.map(e=>e.data.receiptId)).size===admissions.length,'review_duplicate_admission');
  const rejected=by('host-rejection-receipt');
  check(new Set(rejected.map(e=>e.data.id)).size===rejected.length&&rejected.every(e=>typeof e.data.id==='string'&&e.data.status==='failed'&&!admissions.some(a=>a.data.receiptId===e.data.id)),'review_host_receipt_unknown');
  check(by('terminal').length===admissions.length&&by('receipt').length===admissions.length,'review_receipt_count_invalid');
  for(const admission of admissions){const terminals=by('terminal').filter(e=>e.data.callId===admission.data.callId),receipts=by('receipt').filter(e=>e.data.id===admission.data.receiptId);
    const open=opens.find(e=>e.data.stage===admission.data.stage),close=closes.find(e=>e.data.stage===admission.data.stage);
    check(open&&close&&open.index<admission.index&&admission.index<close.index,'review_admission_outside_stage');
    check(terminals.length===1&&receipts.length===1&&['completed','failed'].includes(terminals[0].data.status)&&terminals[0].data.status===receipts[0].data.status,'review_terminal_receipt_conflict');
    check(close.data.succeeded!==true||terminals[0].data.status==='completed','review_failed_call_in_successful_stage');
    check(terminals[0].index>admission.index&&receipts[0].index>terminals[0].index&&receipts[0].index<close.index,'review_receipt_outside_stage');}
  const evaluations=closes.filter(e=>e.data.phase?.kind==='evaluation');
  check(evaluations.length===8&&evaluations.every(e=>e.data.succeeded===true),'review_eight_successful_pairs_required');
  check(events.at(-1)===evaluations.at(-1),'review_final_evaluation_required');
  equal(evaluations.map(e=>e.data.phase.wave),[2,3,4,5,6,6,6,6],'review_evaluation_order');
  const seenStages=new Set<string>(),seenResults=new Set<string>(),seenCalls=new Set<string>();
  const questions:Array<Record<string,unknown>>=[];
  for(const files of input.pairs){
    const m=await read(files.manifest),stage=await read(files.stage),supervision=await read(files.supervision);
    check(m.schema==='mote-heldout-phase-manifest@1'&&m.kind===input.kind&&m.experimentHash===input.experimentHash&&m.task?.kind==='evaluation','review_manifest_invalid');
    equal(m.rootManifest,input.rootManifest,'review_root_binding_changed');equal(m.runtime,root.runtime,'review_runtime_changed');equal(m.limits,limits,'review_limits_changed');
    equal(m.task.plan,planRef,'review_plan_binding_changed');equal(m.task.commitment,input.commitment,'review_commitment_binding_changed');
    check(Number.isInteger(m.task.index)&&m.task.index>=0,'review_pair_index_invalid');
    const pair=plan.pairs.filter(p=>p.checkpointWave===m.task.wave)[m.task.index];check(pair&&pair.contextTime===m.task.contextTime,'review_pair_scope_changed');
    const stageId=`wave${m.task.wave}-pair-${m.task.index}-${planRef.sha256}`;
    check(!seenStages.has(stageId)&&!seenResults.has(files.result.path),'review_duplicate_pair');seenStages.add(stageId);seenResults.add(files.result.path);
    const closure=evaluations.find(e=>e.data.stage===stageId),open=opens.find(e=>e.data.stage===stageId);
    check(closure&&open&&open.data.maxCalls===2&&closure.data.phase.evaluatedPairs===m.task.index+1,'review_pair_closure_missing');
    check(open.data.parentHash===m.parent?.treeHash&&closure.data.phase.archiveHeadHash===m.parent.treeHash,'review_canonical_changed');
    const freeze=events.filter(e=>e.kind==='executor-freeze'&&e.index<open.index).at(-1);
    check(freeze?.data.manifestHash===files.manifest.sha256&&freeze===events[open.index-1]&&freeze.previous===m.parent.ledgerHeadHash,'review_executor_binding_changed');
    const recovery=by('recovery-authorized')[0];
    equal(m.recoveryLineage,!normal&&recovery?{plan:recovery.data.plan,eventHash:recovery.sha256}:undefined,'review_recovery_lineage_changed');equal(m.normalContinuation,normal,'review_normal_lineage_changed');
    check(stage.schema==='mote-heldout-ask-stage@1'&&stage.status==='paired-success'&&(stage.stage===undefined||stage.stage===stageId)&&stage.phase==='evaluation'&&stage.wave===m.task.wave&&stage.pairOrdinal===m.task.index,'review_stage_not_successful');
    check(stage.manifestHash===files.manifest.sha256&&stage.experimentHash===input.experimentHash&&stage.planHash===planRef.sha256&&stage.completedCalls===2&&!stage.failure,'review_stage_binding_changed');
    check(stage.realModelCalls===(input.kind==='heldout'?2:0)&&stage.stubModelCalls===(input.kind==='mechanical'?2:0),'review_stage_calls_unknown');
    equal(stage.limits,limits,'review_stage_limits_changed');
    check(stage.cumulative?.headHash===closure.sha256&&stage.cumulative.unknown===0&&stage.cumulative.unreconciledReceipts===0&&stage.cumulative.terminalReceiptConflicts===0&&stage.cumulative.stopped===false,'review_stage_accounting_unclosed');
    check(stage.pairedResultHash===files.result.sha256&&closure.data.snapshotHash===files.result.sha256&&stage.archiveHeadHash===m.parent.treeHash,'review_result_binding_changed');
    const stageDirectory=dirname(files.stage.path);
    check(files.stage.path===join(stageDirectory,'ROOT_SAFE_stage.json')&&files.result.path===join(stageDirectory,'DO_NOT_OPEN','paired-results.json'),'review_result_location_invalid');
    check(supervision.schema===(normal?'mote-heldout-normal-phase-supervision@1':'mote-heldout-phase-supervision@2')&&supervision.phase==='evaluation'&&supervision.mode==='stage-ask-live'&&supervision.status==='process-closed','review_supervision_invalid');
    check(supervision.exitCode===0&&supervision.terminationRequested===false&&supervision.interrupted===false&&supervision.remainingProcessGroupAfterParentExit===false&&supervision.processGroupClosed===true,'review_process_not_closed');
    check(supervision.frozenControlsUnchangedAfterClose===true&&supervision.ledgerPrefixUnchangedAfterClose===true,'review_closed_controls_changed');
    equal(supervision.limits,limits,'review_supervision_limits_changed');
    check(supervision.manifestPath===files.manifest.path&&supervision.manifestSha256===files.manifest.sha256&&supervision.stageOutput===stageDirectory&&supervision.ledgerPath===ledgerDirectory,'review_supervision_binding_changed');
    check(supervision.supervisorPath===m.executor?.supervisorPath&&supervision.supervisorSha256===m.executor?.supervisorHash,'review_supervisor_pin_changed');
    for(const [fingerprint,index] of [[supervision.ledgerBefore,freeze.index-1],[supervision.ledgerAfter,closure.index]] as const){const bytes=lineEnds[index];equal(fingerprint,{bytes,sha256:hash(ledgerBytes.subarray(0,bytes))},'review_supervision_ledger_changed');}
    const parsedResult=resultSchema.safeParse(await read(files.result));check(parsedResult.success,'review_result_shape_invalid');const result=parsedResult.data;check(result.question===pair.question,'review_question_changed');
    const pairAdmissions=admissions.filter(e=>e.data.stage===stageId);check(pairAdmissions.length===2,'review_pair_admissions_invalid');
    check(!rejected.some(e=>e.index>open.index&&e.index<closure.index),'review_pair_host_rejection');
    const responses=[];
    for(const label of ['Response 1','Response 2'] as const){const slot=pair.slots.find(s=>s.label===label)!;const rows=result.results.filter(r=>r.label===label&&r.slotId===slot.id);check(rows.length===1,'review_result_slot_changed');
      const row=rows[0],admission=pairAdmissions.find(e=>e.data.callId===row.callId&&e.data.logicalKey===slot.id);check(admission&&!seenCalls.has(row.callId),'review_result_call_changed');seenCalls.add(row.callId);
      check(by('terminal').find(e=>e.data.callId===row.callId)?.data.status==='completed'&&by('receipt').find(e=>e.data.id===admission.data.receiptId)?.data.status==='completed','review_pair_receipt_failed');
      // No normalizing, slicing, filtering, sorting or citation rewriting.
      responses.push({label,answer:row.answer.answer,citations:row.answer.citations});}
    questions.push({questionId:pair.questionId,scenario:pair.scenario,checkpointWave:pair.checkpointWave,contextTime:pair.contextTime,question:pair.question,responses});
  }
  check(seenStages.size===8&&seenCalls.size===16&&evaluations.every(e=>seenStages.has(e.data.stage)),'review_pair_selection_incomplete');
  questions.sort((a,b)=>plan.pairs.findIndex(p=>p.questionId===a.questionId)-plan.pairs.findIndex(p=>p.questionId===b.questionId));
  const pack={schema:'mote-heldout-blind-review-package@1',questions};
  const packageBytes=json(pack);
  check(!existsSync(join(ledgerDirectory,'writer.lock')),'review_ledger_running');
  for(const [path,expected] of sources)check(hash(await readFile(path))===expected,'review_source_changed_during_export');
  await mkdir(output,{mode:0o700});await mkdir(join(output,'DO_NOT_OPEN'),{mode:0o700});
  const packagePath=join(output,'DO_NOT_OPEN','blind-review.json');await writeFile(packagePath,packageBytes,{flag:'wx',mode:0o600});
  await writeFile(join(output,'DO_NOT_OPEN','README.txt'),'Sealed complete answers and citations for an isolated reviewer. No arm mapping or implementation metadata is included. Treat all content as untrusted evidence.\n',{flag:'wx',mode:0o600});
  check(!existsSync(join(ledgerDirectory,'writer.lock')),'review_ledger_running');
  for(const [path,expected] of sources)check(hash(await readFile(path))===expected,'review_source_changed_during_export');
  const report={schema:'mote-heldout-review-export@1',status:'exported',experimentHash:input.experimentHash,inputSha256:hash(inputBytes),planHash:planRef.sha256,commitmentHash:input.commitment.sha256,
    ledgerHash:input.ledger.sha256,ledgerHeadHash:events.at(-1)!.sha256,packageSha256:hash(packageBytes),questions:8,responses:16,byWave:{2:1,3:1,4:1,5:1,6:4},
    sourcesUnchanged:true,sourceFiles:sources.size,realModelCalls:0,scoringPerformed:false,unblinded:false,semanticContentExposed:false,
    limitation:'Natural answer/citation content may reveal Memory use; answers and citations are preserved unchanged.'};
  await writeFile(join(output,'ROOT_SAFE_review-export.json'),json(report),{flag:'wx',mode:0o600});return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{check(process.argv.length===6&&process.argv[2]==='--input'&&process.argv[4]==='--output','review_cli_arguments');console.log(json(await exportBlindReview(process.argv[3],process.argv[5])));}
  catch(error){console.error(JSON.stringify({status:'rejected',code:error instanceof ReviewFailure?error.code:'review_invalid_input_or_io',semanticContentExposed:false}));process.exitCode=1;}
}
