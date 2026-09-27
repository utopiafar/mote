import {normalLimits,readNormalPlan} from './test-heldout-memory-replay-ledger.js';
/** One sealed paired ordinary Ask. Generated fixtures only until separately frozen live approval. */
import {randomInt,randomUUID} from 'node:crypto';
import {existsSync,openSync,writeSync,fsyncSync,closeSync} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {AgentAnswer,ContextReader,QueryInput} from '@mote/agent';
import type {QueryResult,UsageReceipt} from '@mote/shared';
import {sha256} from '../apps/server/src/store.js';
import {usageTotals} from '../apps/server/src/usage.js';
import {corpus,evaluation,check,equal,json,hashObject,closed,cloneClosed,sqliteCheck,verifyFreeze,parse,exactIndex} from './test-heldout-memory-replay.js';
import {AdmissionLedger,inspectAdmissionLedger,StageSafetyError} from './test-heldout-memory-replay-ledger.js';
import {type Manifest,codeHashes,treeHash,privateWrite,sealedError,safeCode,openNode,settings,bindings} from './test-heldout-memory-replay-stage.js';
import {type PhaseManifest,type Ref,ref,readRef,rootAndRuntime,validation,phaseCursor,validateRecoveryRoot,validateNormalRoot} from './test-heldout-memory-replay-sequence.js';

type Node=Awaited<ReturnType<typeof openNode>>['node'];
type Stub=(reader:ContextReader,input:QueryInput)=>Promise<QueryResult>;
type Rows=Record<string,Array<Record<string,any>>>;
export const askLimits={stageOuter:2,perOuterMs:300000,stageProcessMs:720000,cumulativePlanningCap:124,automaticOuterRetries:0,concurrency:1} as const;
type Question={questionId:string;scenario:string;question:string;checkpointWave:number;contextTime:string};
type Pair=Question&{slots:Array<{id:string;removeMemory:boolean;label:string}>};
export type AskPlan={schema:'mote-heldout-ask-plan@1';experimentHash:string;questionsHash:string;pairs:Pair[]};
export type AskManifest=Omit<PhaseManifest,'task'|'limits'>&{task:{kind:'evaluation';wave:number;index:number;contextTime:string;plan:Ref;commitment:Ref;inventoryHash:string};limits:typeof askLimits};
const questionCounts=[0,0,1,1,1,1,4];
const erase=['memories','memory_jobs','memory_checkpoints','memory_extraction_drafts','memory_lifecycle_state','memory_events'];
const memoryTables=new Set([...erase,'memory_catalog','memory_scopes','memory_dependencies','memory_artifact_dependencies','memory_batches','memory_batch_dependencies','memory_job_counts','memory_input_plans','memory_extraction_draft_dependencies','memories_fts','memories_fts_data','memories_fts_idx','memories_fts_content','memories_fts_docsize','memories_fts_config']);
const logicalMemory=[...memoryTables].filter(name=>!name.startsWith('memories_fts_'));
const empty=['conversations','conversation_turns','working_memories','query_runs','insights','insight_runs','memory_deletions','memory_deletion_dependencies','artifact_dependencies','artifact_material_inputs','context_dirty','perception_jobs','perception_results','capture_ocr_receipts','file_artifacts','file_chunks','file_reviews','file_versions','archived_files','capture_files','blobs','assets','file_read_requests','action_proposals','action_semantic_checkpoints','todos'];
const quoted=(name:string)=>'"'+name.replaceAll('"','""')+'"';
export function rows(db:DatabaseSync):Rows{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>{const name=String(row.name);return [name,db.prepare('SELECT * FROM '+quoted(name)).all().map(value=>({...value})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))];}));}
async function schemaCheck(db:DatabaseSync){const expected=JSON.parse(await readFile(new URL('./test-heldout-memory-replay-ask-schema.json',import.meta.url),'utf8')).tables;const actual=Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>[String(row.name),db.prepare('PRAGMA table_xinfo('+quoted(String(row.name))+')').all().map(col=>({name:col.name,type:col.type,pk:col.pk,hidden:col.hidden}))]));equal(actual,expected,'ask_unclassified_schema');return hashObject(actual);}
function preserve(a:unknown,b:unknown,code='ask_protected_rows_changed'){equal(a,b,code);}
export async function inventory(db:DatabaseSync){
  sqliteCheck(db);const schemaHash=await schemaCheck(db),all=rows(db);
  for(const name of empty)check(!all[name]?.length,'ask_unclassified_semantic_cache');
  // This replay has no media/preprocessing lane. A nonempty unexpected baseline is stopped,
  // never deleted from either arm. Original text/metadata are never keyword classified.
  check(all.captures.every(r=>!r.summary&&!r.embedding&&!r.embedding_model&&!r.blob_hash),'ask_unclassified_capture_derivative');
  check(all.memory_batches.every(r=>JSON.parse(r.json).status==='completed'),'ask_unfinished_memory_batch');
  check(all.memory_lifecycle_state.every(r=>!JSON.parse(r.json).active),'ask_active_lifecycle');
  const lifecycle=JSON.parse(all.memory_lifecycle_settings[0].json);check(['extraction','consolidation','insights','working'].every(k=>lifecycle[k].enabled===false),'ask_background_enabled');
  check(all.execution_steps.every(r=>!['waiting','running'].includes(r.state)),'ask_active_execution');
  check(all.processing_jobs.every(r=>!['waiting','running','pending'].includes(r.state)),'ask_active_processing');
  check(all.model_usage.every(r=>JSON.parse(r.json).status!=='running'),'ask_running_inherited_usage');
  exactIndex(db);
  // Normal material processors are fixed by the parent production/configuration pins.
  // No arbitrary custom material/organizer may silently become shared semantic context.
  const materialKinds=new Set(['mote.coding-session',...all.captures.map(r=>'mote.'+JSON.parse(r.json).source)]);
  check(all.material_heads.every(r=>materialKinds.has(r.kind)),'ask_unknown_material_kind');
  check(all.material_organizer_groups.every(r=>r.organizer_id==='mote.source-item'&&r.version==='8'),'ask_unknown_organizer');
  check(all.source_pipeline_work.every(r=>r.pipeline_id==='mote.coding'&&r.version==='6'&&r.state==='complete'),'ask_unknown_source_processor');
  return {schemaHash,rowsHash:hashObject(all),exactHash:hashObject(exactIndex(db))};
}
function changed(before:Rows,after:Rows){return Object.keys(before).filter(name=>hashObject(before[name])!==hashObject(after[name]));}
function storageRows(value:Rows,except:Set<string>){return value.storage_ledger.filter(r=>!except.has(r.name));}
/** A only: remove all Memory states, not raw-source preprocessing, permissions or source indexes. */
export async function ablateAsk(vault:string,remove:boolean){const db=new DatabaseSync(join(vault,'mote.sqlite'));try{
  db.exec('PRAGMA foreign_keys=ON');await inventory(db);const before=rows(db);
  if(remove){db.exec('BEGIN IMMEDIATE');try{for(const name of erase)db.exec('DELETE FROM '+quoted(name));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}
  const after=rows(db);check(changed(before,after).every(name=>remove&&(memoryTables.has(name)||name==='storage_ledger')),'ask_ablation_changed_protected');
  preserve(storageRows(before,memoryTables),storageRows(after,memoryTables),'ask_ablation_changed_source_accounting');
  if(remove)for(const name of logicalMemory)check(!after[name]?.length,'ask_memory_not_fully_removed');
  else preserve(after,before);sqliteCheck(db);return after;
}finally{db.close();}}
function defaults(before:Rows,after:Rows,remove:boolean,from:number,to:number){
  const expectedStreams:Record<string,string>={extraction:'artifact',consolidation:'memory',insights:'artifact',working:'conversation'};
  for(const r of after.memory_lifecycle_state){if(!remove)continue;const v=JSON.parse(r.json);check(Object.keys(v).sort().join(',')==='cursor,failures,lastSuccess,stream'&&v.cursor===0&&v.failures===0&&v.stream===expectedStreams[r.id]&&v.lastSuccess>=from&&v.lastSuccess<=to,'ask_bootstrap_state_not_empty');}
  if(remove)check(after.memory_lifecycle_state.length===before.memory_lifecycle_state.length+4,'ask_bootstrap_state_count');
  const allowed=new Set(remove?['memory_lifecycle_state','storage_ledger']:[]);check(changed(before,after).every(n=>allowed.has(n)),'ask_open_mutated_snapshot');preserve(storageRows(before,new Set(['memory_lifecycle_state'])),storageRows(after,new Set(['memory_lifecycle_state'])));
}
/** Remove only exactly query-owned additions, then compare all inherited rows unchanged. */
export function assertQueryWrites(before:Rows,after:Rows,queryId:string|undefined,receiptIds:Set<string>,closedQuery=true){
  preserve(Object.keys(after),Object.keys(before),'ask_schema_changed');const projected=structuredClone(after),operation=queryId?'query:'+queryId:undefined;
  const owned=new Set<string>(),keep=(table:string,predicate:(r:Record<string,any>)=>boolean)=>{const original=new Set(before[table].map(r=>JSON.stringify(r)));const additions=after[table].filter(r=>!original.has(JSON.stringify(r)));check(additions.every(predicate),'ask_unowned_write_'+table);projected[table]=after[table].filter(r=>!additions.includes(r));if(additions.length)owned.add(table);};
  const queries=after.query_runs.filter(r=>!before.query_runs.some(b=>b.id===r.id));check(queries.length<=1&&queries.every(r=>r.id===queryId),'ask_extra_query');
  const conversationIds=new Set(queries.flatMap(r=>{const id=JSON.parse(r.json).conversationId;return id?[id]:[];}));
  keep('query_runs',r=>r.id===queryId);keep('conversations',r=>conversationIds.has(r.id));keep('conversation_turns',r=>conversationIds.has(r.conversation_id)&&r.idx===0);
  keep('memory_events',r=>r.stream==='conversation'&&conversationIds.has(r.entity));
  keep('model_usage',r=>receiptIds.has(r.id)&&JSON.parse(r.json).attribution?.operationId===operation);
  const stepIds=new Set(after.execution_steps.filter(r=>r.operation_id===operation).map(r=>r.id));
  keep('execution_steps',r=>r.operation_id===operation&&r.id===operation&&r.attempts<=1&&String(r.kind).startsWith('query.run.'));
  keep('execution_resources',r=>stepIds.has(r.step_id));keep('execution_dependencies',r=>stepIds.has(r.step_id)&&stepIds.has(r.dependency_id));
  keep('execution_operation_steps',r=>r.operation_id===operation&&stepIds.has(r.step_id));keep('execution_fairness',r=>r.operation_id===operation);
  keep('operation_progress',r=>r.id===operation);keep('operation_changes',r=>r.operation_id===operation);keep('operation_generations',r=>r.operation_id===operation);keep('operation_parents',()=>false);
  const reservations=new Set(after.model_budget_reservations.filter(r=>r.operation_id===operation).map(r=>r.id));
  keep('model_budget_reservations',r=>r.operation_id===operation);keep('model_budget_attempts',r=>r.operation_id===operation&&reservations.has(r.reservation_id));keep('model_budget_usage',r=>reservations.has(r.reservation_id));
  // Closed query sessions release their owner leases. No inherited row may be renewed.
  if(closedQuery)preserve(before.run_execution_owners,after.run_execution_owners,'ask_owner_lease_left');
  else{const owners=new Set(after.execution_steps.filter(r=>stepIds.has(r.id)).map(r=>JSON.parse(r.input).ownerId));keep('run_execution_owners',r=>owners.has(r.id));}
  for(const table of ['execution_sequence','sqlite_sequence']){
    const base=new Map(before[table].map(r=>[r[table==='sqlite_sequence'?'name':'pool'],r]));const column=table==='sqlite_sequence'?'seq':'next',key=table==='sqlite_sequence'?'name':'pool';
    check(before[table].every(old=>after[table].some(r=>r[key]===old[key])),'ask_sequence_deleted');
    for(const r of after[table]){const old=base.get(r[key]),delta=Number(r[column])-Number(old?.[column]??0);if(delta===0)continue;
      const count=table==='sqlite_sequence'?(r.name==='memory_events'||r.name==='operation_changes'?after[r.name].length-before[r.name].length:-1):after.execution_fairness.filter(v=>v.pool===r.pool&&v.operation_id===operation).length;
      check(delta===count&&delta>0,'ask_unowned_sequence_change');}
    projected[table]=before[table];
  }
  projected.storage_ledger=projected.storage_ledger.filter(r=>!owned.has(r.name));const expected=structuredClone(before);expected.storage_ledger=expected.storage_ledger.filter(r=>!owned.has(r.name));
  preserve(projected,expected);return {queryRows:queries.length};
}
async function files(vault:string,prefix=''):Promise<Record<string,string>>{let out:Record<string,string>={};for(const entry of await readdir(join(vault,prefix),{withFileTypes:true})){const name=join(prefix,entry.name);if(name==='logs'||name==='token'||/^mote\.sqlite(?:-wal|-shm)?$/.test(name))continue;check(!entry.isSymbolicLink(),'ask_snapshot_link');if(entry.isDirectory())out={...out,...await files(vault,name)};else out[name]=sha256(await readFile(join(vault,name)));}return out;}
async function at(parent:string){await closed(parent);const db=new DatabaseSync(join(parent,'mote.sqlite'),{readOnly:true});try{return await inventory(db);}finally{db.close();}}
function questionCheck(q:Question){equal(Object.keys(q).sort(),['checkpointWave','contextTime','question','questionId','scenario'],'ask_question_schema_unknown');check(q&&typeof q.question==='string'&&q.question.length>0&&q.question.length<=8000&&q.question===q.question.trim(),'ask_question_transport_changes_text');check(Number.isInteger(q.checkpointWave)&&q.checkpointWave>=2&&q.checkpointWave<=6&&Number.isFinite(Date.parse(q.contextTime)),'ask_question_scope_invalid');}
async function questions(root:Manifest,mechanical?:Question[]):Promise<Question[]>{check(root.kind==='mechanical'||!mechanical,'ask_mechanical_questions_forbidden');const values=root.kind==='mechanical'?mechanical:(await parse(join(evaluation,'questions.json'))).questions;check(Array.isArray(values)&&values.length===8,'ask_question_count');for(const q of values)questionCheck(q);equal(questionCounts.slice(2),[2,3,4,5,6].map(w=>values.filter(q=>q.checkpointWave===w).length),'ask_question_checkpoint_counts');return values.map(q=>({questionId:q.questionId,scenario:q.scenario,question:q.question,checkpointWave:q.checkpointWave,contextTime:q.contextTime}));}
export function assertAskPlan(plan:AskPlan,experimentHash:string){
  check(plan&&typeof plan==='object','ask_plan_shape');equal(Object.keys(plan).sort(),['experimentHash','pairs','questionsHash','schema'],'ask_plan_shape');
  check(plan.schema==='mote-heldout-ask-plan@1'&&plan.experimentHash===experimentHash&&Array.isArray(plan.pairs)&&plan.pairs.length===8,'ask_plan_changed');
  const ids=new Set<string>(),questions=new Set<string>();
  for(const pair of plan.pairs){check(pair&&typeof pair==='object','ask_plan_pair_shape');const {slots,...q}=pair;questionCheck(q);check(typeof q.questionId==='string'&&q.questionId.length>0&&!questions.has(q.questionId),'ask_plan_question_identity');questions.add(q.questionId);
    check(Array.isArray(slots)&&slots.length===2,'ask_blind_slots_invalid');for(const slot of slots){check(slot&&typeof slot==='object','ask_blind_slot_shape');equal(Object.keys(slot).sort(),['id','label','removeMemory'],'ask_blind_slot_shape');check(typeof slot.removeMemory==='boolean','ask_blind_treatment_invalid');check(typeof slot.id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(slot.id)&&!ids.has(slot.id),'ask_blind_identity_invalid');ids.add(slot.id);}
    check(slots.filter(s=>s.removeMemory===true).length===1,'ask_blind_treatment_invalid');equal(slots.map(s=>s.label).sort(),['Response 1','Response 2'],'ask_blind_label_invalid');
  }
  check(hashObject(plan.pairs.map(({slots,...q})=>q))===plan.questionsHash,'ask_questions_hash_changed');
}
function planCommit(events:ReturnType<typeof inspectAdmissionLedger>,planHash:string){for(const e of events.filter(e=>e.kind==='stage-close'&&e.data.phase?.kind==='evaluation'))check(String(e.data.stage).endsWith('-'+planHash),'ask_prior_plan_changed');}
export async function freezeAsk(options:{rootManifest:string;previousManifest:string;parent:string;ledgerDirectory:string;validation:string;supervisorPath:string;output:string;recoveryLineage?:PhaseManifest['recoveryLineage'];normalContinuation?:PhaseManifest['normalContinuation'];planPath?:string;mechanicalQuestions?:Question[]}){
  const rootRef=await ref(options.rootManifest),root=await rootAndRuntime(rootRef),events=inspectAdmissionLedger(options.ledgerDirectory,root.experimentHash,options.recoveryLineage,options.normalContinuation),cursor=phaseCursor(events,root,options.recoveryLineage,options.normalContinuation);
  if(root.kind==='heldout'){await verifyFreeze(corpus,root.corpusFreeze);await verifyFreeze(evaluation,root.evaluationFreeze);}
  check(cursor.integrationDone&&cursor.wave>=2&&cursor.evaluatedPairs<questionCounts[cursor.wave],'ask_phase_not_ready');let planRef:Ref;const commitmentPath=join(options.ledgerDirectory,'ask-plan-commitment.json');
  if(existsSync(commitmentPath)){const prior=await readRef<{experimentHash:string;plan:Ref}>(await ref(commitmentPath));check(prior.experimentHash===root.experimentHash,'ask_commitment_experiment_changed');planRef=prior.plan;await readRef(planRef);if(options.planPath)check((await ref(options.planPath)).sha256===planRef.sha256,'ask_committed_plan_changed');}
  else if(options.planPath)planRef=await ref(options.planPath);
  else{
    check(!events.some(e=>e.kind==='stage-close'&&e.data.phase?.kind==='evaluation')&&(root.kind==='mechanical'||cursor.wave===2&&cursor.evaluatedPairs===0),'ask_initial_plan_required');
    const input=await questions(root,options.mechanicalQuestions),plan:AskPlan={schema:'mote-heldout-ask-plan@1',experimentHash:root.experimentHash,questionsHash:hashObject(input),pairs:input.map(q=>{const order=randomInt(2),labels=randomInt(2);return {...q,slots:[0,1].map(i=>({id:randomUUID(),removeMemory:i===order,label:i===labels?'Response 1':'Response 2'}))};})};
    const path=join(options.output,'DO_NOT_OPEN','ask-plan.json');await privateWrite(path,plan);const planHandle=openSync(path,'r');try{fsyncSync(planHandle);}finally{closeSync(planHandle);}planRef=await ref(path);
  }
  assertAskPlan(await readRef<AskPlan>(planRef),root.experimentHash);
  if(!existsSync(commitmentPath)){const handle=openSync(commitmentPath,'wx',0o600);try{writeSync(handle,json({schema:'mote-heldout-ask-plan-commitment@1',experimentHash:root.experimentHash,plan:planRef}));fsyncSync(handle);}finally{closeSync(handle);}const directory=openSync(options.ledgerDirectory,'r');try{fsyncSync(directory);}finally{closeSync(directory);}}
  const commitment=await ref(commitmentPath);
  const m:AskManifest={...(options.recoveryLineage?{recoveryLineage:options.recoveryLineage}:{}),...(options.normalContinuation?{normalContinuation:options.normalContinuation}:{}),schema:'mote-heldout-phase-manifest@1',kind:root.kind,experimentHash:root.experimentHash,rootManifest:rootRef,previousManifest:await ref(options.previousManifest),validation:await ref(options.validation),runtime:root.runtime,executor:{supervisorPath:options.supervisorPath,supervisorHash:sha256(await readFile(options.supervisorPath))},codeHashes:await codeHashes(),limits:askLimits,parent:{path:options.parent,treeHash:await treeHash(options.parent),ledgerHeadHash:events.at(-1)!.sha256},task:{kind:'evaluation',wave:cursor.wave,index:cursor.evaluatedPairs,contextTime:cursor.contextTime,plan:planRef,commitment,inventoryHash:hashObject(await at(options.parent))}};
  await validateAsk(m,options.ledgerDirectory);await privateWrite(join(options.output,'ROOT_SAFE_manifest.json'),m);return m;
}
export async function validateAsk(m:AskManifest,ledgerDirectory:string){
  check(m.schema==='mote-heldout-phase-manifest@1'&&m.task.kind==='evaluation','ask_manifest_invalid');equal(m.limits,askLimits,'ask_limits_changed');const root=await rootAndRuntime(m.rootManifest);check(root.kind===m.kind&&root.experimentHash===m.experimentHash,'ask_experiment_changed');equal(m.runtime,root.runtime,'ask_runtime_changed');equal(await codeHashes(),m.codeHashes,'ask_executor_changed');await validation(m.validation,m.codeHashes,'evaluation');check(sha256(await readFile(m.executor.supervisorPath))===m.executor.supervisorHash,'ask_supervisor_changed');
  if(root.kind==='heldout'){await verifyFreeze(corpus,root.corpusFreeze);await verifyFreeze(evaluation,root.evaluationFreeze);check(sha256(await readFile(root.model.codexBin))===root.model.codexBinHash,'ask_codex_changed');}
  check(!m.normalContinuation||!m.recoveryLineage&&!Object.hasOwn(m,'recoveryE'),'normal_lineages_conflict');await validateRecoveryRoot(m.recoveryLineage,root,m.rootManifest,m.executor);await validateNormalRoot(m.normalContinuation,root,m.rootManifest,m.executor);const events=inspectAdmissionLedger(ledgerDirectory,m.experimentHash,m.recoveryLineage,m.normalContinuation);check(events.at(-1)?.sha256===m.parent.ledgerHeadHash,'ask_ledger_advanced');const previous=await readRef<Manifest|PhaseManifest>(m.previousManifest);check(previous.experimentHash===m.experimentHash&&events.filter(e=>e.kind==='executor-freeze').at(-1)?.data.manifestHash===m.previousManifest.sha256,'ask_previous_executor_changed');const cursor=phaseCursor(events,root,m.recoveryLineage,m.normalContinuation);check(cursor.integrationDone&&cursor.wave===m.task.wave&&cursor.evaluatedPairs===m.task.index&&cursor.evaluatedPairs<questionCounts[cursor.wave]&&cursor.contextTime===m.task.contextTime&&cursor.archiveHeadHash===m.parent.treeHash,'ask_not_next_canonical_pair');check(await treeHash(m.parent.path)===m.parent.treeHash,'ask_parent_changed');equal(hashObject(await at(m.parent.path)),m.task.inventoryHash,'ask_inventory_changed');
  check(m.task.commitment.path===join(ledgerDirectory,'ask-plan-commitment.json'),'ask_commitment_path_changed');const committed=await readRef<{schema:string;experimentHash:string;plan:Ref}>(m.task.commitment);check(committed.schema==='mote-heldout-ask-plan-commitment@1'&&committed.experimentHash===m.experimentHash,'ask_commitment_invalid');equal(committed.plan,m.task.plan,'ask_commitment_plan_changed');
  const plan=await readRef<AskPlan>(m.task.plan);assertAskPlan(plan,m.experimentHash);check(plan.schema==='mote-heldout-ask-plan@1'&&plan.experimentHash===m.experimentHash,'ask_plan_changed');planCommit(events,m.task.plan.sha256);const raw=plan.pairs.map(({slots,...q})=>q);const validated=await questions(root,root.kind==='mechanical'?raw:undefined);equal(raw,validated,'ask_question_bundle_changed');check(hashObject(raw)===plan.questionsHash,'ask_questions_hash_changed');const pair=plan.pairs.filter(q=>q.checkpointWave===cursor.wave)[cursor.evaluatedPairs];check(pair&&pair.contextTime===m.task.contextTime,'ask_question_clock_changed');check(pair.slots.length===2&&new Set(pair.slots.map(s=>s.removeMemory)).size===2&&new Set(pair.slots.map(s=>s.id)).size===2&&new Set(pair.slots.map(s=>s.label)).size===2,'ask_blind_slots_invalid');return {root,cursor,pair,ledgerHead:events.at(-1)!.sha256};
}
export function assertOrdinaryInput(input:QueryInput,question:string,contextTime:string){
  const keys=new Set(['traceContext','executionLane','question','timeZone','contextTime','modelProfileId','modelOverride','signal','directImages','openingMemories','language','onProgress','onTrace','onUsage','validateOutput']);
  check(Object.keys(input).every(key=>keys.has(key)),'ask_unknown_query_input');
  check(input.question===question&&input.contextTime===contextTime&&input.timeZone==='Asia/Shanghai'&&input.executionLane==='interactive','ask_input_changed');
  check(!input.directImages?.length,'ask_attachment_forbidden');
}
export async function runAsk(options:{manifest:AskManifest;manifestHash:string;output:string;ledgerDirectory:string;stub?:Stub;live?:true;perOuterMs?:number;mechanicalHook?:(node:Node,index:number)=>void}){
  const {manifest:m,output}=options;check(options.stub||options.live===true,'ask_live_not_enabled');check(options.stub?m.kind==='mechanical':m.kind==='heldout','ask_execution_mode_mismatch');check(m.kind==='mechanical'||!options.mechanicalHook&&options.perOuterMs===undefined,'ask_live_test_override');check(sha256(json(m))===options.manifestHash,'ask_manifest_changed');const {root,cursor,pair,ledgerHead}=await validateAsk(m,options.ledgerDirectory);
  for(const other of [output,m.parent.path])for(const [a,b] of [[other,options.ledgerDirectory],[options.ledgerDirectory,other]]){const part=relative(a,b);check(part==='..'||part.startsWith('../'),'ask_ledger_inside_snapshot');}
  const ledger=new AdmissionLedger(options.ledgerDirectory,m.experimentHash,124,m.recoveryLineage,undefined,m.normalContinuation),stage=`wave${cursor.wave}-pair-${m.task.index}-${m.task.plan.sha256}`,report:Record<string,any>={schema:'mote-heldout-ask-stage@1',phase:'evaluation',wave:cursor.wave,pairOrdinal:m.task.index,status:'running',manifestHash:options.manifestHash,experimentHash:m.experimentHash,planHash:m.task.plan.sha256,semanticContentExposed:false,limits:m.limits,startedAt:new Date().toISOString()};
  let active:AbortController|undefined,succeeded=false,failure:unknown,completed=0;const results:unknown[]=[];const interrupted=()=>{ledger.stop('ask_interrupted');active?.abort();};process.on('SIGTERM',interrupted);process.on('SIGINT',interrupted);
  try{
    check(ledger.events.at(-1)?.sha256===ledgerHead,'ask_ledger_advanced');ledger.bindExecutor(options.manifestHash,m.previousManifest.sha256,m.validation.sha256);ledger.begin(stage,m.parent.treeHash,2);
    // Prepare and audit BOTH arms before the first paid boundary.
    const prepared=[];for(const slot of pair.slots){const vault=join(output,'DO_NOT_OPEN',slot.id);await cloneClosed(m.parent.path,vault);prepared.push({slot,vault,before:await ablateAsk(vault,slot.removeMemory),files:await files(vault)});}
    const normalize=(value:Rows)=>Object.fromEntries(Object.entries(value).filter(([name])=>!memoryTables.has(name)&&name!=='storage_ledger'));
    preserve(normalize(prepared[0].before),normalize(prepared[1].before),'ask_arms_source_mismatch');preserve(storageRows(prepared[0].before,memoryTables),storageRows(prepared[1].before,memoryTables));preserve(prepared[0].files,prepared[1].files);
    for(const [index,item] of prepared.entries()){
      check(!ledger.stopped,'ask_circuit_stopped');let node:Node|undefined,openedRows:Rows|undefined,queryId:string|undefined,callId:string|undefined,answer:unknown,armOK=false;const receiptIds=new Set<string>();const inherited=new Set(item.before.model_usage.map(r=>r.id));let requests=0,repairs=0;
      try{
        const started=Date.now(),opened=await openNode(item.vault,root.model,m.task.contextTime,options.stub);node=opened.node;const afterOpen=rows(node.store.db);defaults(item.before,afterOpen,item.slot.removeMemory,started,Date.now());openedRows=afterOpen;equal(hashObject(settings(node)),root.settingsHash,'ask_settings_changed');equal(hashObject(bindings(node)),root.bindingsHash,'ask_bindings_changed');check(node.featureServices.archiveReader.contextTools?.().length===0,'ask_unknown_tool_contribution');options.mechanicalHook?.(node,index);
        const query=node.agent.query.bind(node.agent);node.agent.query=async input=>{
          const traces:unknown[]=[];let timer:ReturnType<typeof setTimeout>|undefined;
          try{
            check(!ledger.stopped&&!callId,'ask_outer_retry_forbidden');assertOrdinaryInput(input,pair.question,m.task.contextTime);
            for(const field of ['conversation','taskContext','skill','responseMode','evidenceIds','evidenceRanges','after','before','deviceId','processingEvidence','processingMaterialInputs','derivedContextEvidenceIds'])check((input as any)[field]===undefined,'ask_oracle_or_special_input');check(!input.directImages?.length,'ask_attachment_forbidden');
            const trace=input.traceContext;check(trace?.operation==='query'&&trace.moduleId==='conversations'&&trace.provider===root.model.provider&&trace.protocol===root.model.protocol&&trace.model===root.model.model&&input.modelOverride===root.model.model,'ask_model_or_operation_changed');check(/^query:[a-f0-9-]{36}$/.test(trace.operationId??''),'ask_operation_id_invalid');queryId=trace.operationId!.slice(6);
            const running=node!.store.db.prepare("SELECT id FROM model_usage WHERE json_extract(json,'$.status')='running'").all().map(r=>String(r.id)).filter(id=>!inherited.has(id));check(running.length===1,'ask_running_receipt_ambiguous');receiptIds.add(running[0]);assertQueryWrites(openedRows!,rows(node!.store.db),queryId,receiptIds,false);check(node!.featureServices.archiveReader.contextTools?.().length===0,'ask_unknown_tool_contribution');const serial=JSON.parse(JSON.stringify(input,(_k,v)=>typeof v==='function'?undefined:v));callId=ledger.reserve(item.slot.id,hashObject(serial),running[0]);await privateWrite(join(output,'DO_NOT_OPEN',callId+'-input.json'),serial);active=new AbortController();const control=active,abort=()=>control.abort(input.signal?.reason);input.signal?.addEventListener('abort',abort,{once:true});
            try{const result=await Promise.race([query({...input,signal:control.signal,onTrace:event=>{traces.push(event);if(event.type==='model.started'){requests++;if((event.payload as any)?.repair)repairs++;}input.onTrace?.(event);}}),new Promise<never>((_r,reject)=>{timer=setTimeout(()=>{control.abort();reject(new StageSafetyError('ask_outer_deadline'));},options.perOuterMs??m.limits.perOuterMs);})]);const issue=await input.validateOutput?.(result as AgentAnswer);check(!issue,'ask_product_output_invalid');await privateWrite(join(output,'DO_NOT_OPEN',callId+'-result.json'),result);ledger.terminal(callId,'completed','ok',{modelRunStarts:requests||null,repairs:requests?repairs:null});return result;}finally{input.signal?.removeEventListener('abort',abort);}
          }catch(error){active?.abort();ledger.stop(safeCode(error));if(callId&&ledger.pending().some(e=>e.data.callId===callId))ledger.terminal(callId,'failed',safeCode(error),{modelRunStarts:requests||null,repairs:requests?repairs:null});await sealedError(join(output,'DO_NOT_OPEN'),error);throw error;}
          finally{if(timer)clearTimeout(timer);active=undefined;if(callId)await privateWrite(join(output,'DO_NOT_OPEN',callId+'-trace.json'),traces);}
        };
        answer=await opened.request('POST','/api/query',{question:pair.question,timeZone:'Asia/Shanghai'});check(callId&&!ledger.stopped,'ask_missing_successful_call');armOK=true;
      }catch(error){failure??=error;ledger.stop(safeCode(error));await sealedError(join(output,'DO_NOT_OPEN'),error);}
      finally{
        try{await node?.app.close();}catch(error){armOK=false;failure??=error;ledger.stop('ask_close_failed');await sealedError(join(output,'DO_NOT_OPEN'),error);}
        try{await closed(item.vault);const db=new DatabaseSync(join(item.vault,'mote.sqlite'),{readOnly:true});let fresh:UsageReceipt[],final:Rows;try{sqliteCheck(db);final=rows(db);fresh=final.model_usage.map(r=>JSON.parse(r.json) as UsageReceipt).filter(r=>!inherited.has(r.id));for(const r of fresh)receiptIds.add(r.id);}finally{db.close();}
          const admitted=new Set(ledger.admitted.map(e=>e.data.receiptId)),safe=(r:UsageReceipt)=>({id:r.id,status:r.status,tokens:r.tokens,estimatedCost:r.estimatedCost,currency:r.currency,durationMs:r.durationMs});ledger.receipts(fresh.filter(r=>admitted.has(r.id)).map(safe));ledger.rejectedReceipts(fresh.filter(r=>!admitted.has(r.id)).map(safe));if(openedRows)assertQueryWrites(openedRows,final!,queryId,receiptIds);else preserve(item.before,final!);check(fresh.length===1&&fresh[0].status==='completed'&&fresh.every(r=>admitted.has(r.id)),'ask_receipt_not_successful');const terminal=ledger.events.find(e=>e.kind==='terminal'&&e.data.callId===callId);check(terminal?.data.status===fresh[0].status,'ask_terminal_receipt_conflict');preserve(item.files,await files(item.vault),'ask_external_original_changed');check(await treeHash(m.parent.path)===m.parent.treeHash,'ask_parent_mutated');
        }catch(error){armOK=false;failure??=error;ledger.stop(safeCode(error));await sealedError(join(output,'DO_NOT_OPEN'),error);}
      }
      check(armOK&&!ledger.stopped,'ask_arm_not_closed_success');completed++;results.push({label:item.slot.label,slotId:item.slot.id,callId,answer,closedTreeHash:await treeHash(item.vault)});
    }
    const resultPath=join(output,'DO_NOT_OPEN','paired-results.json');await privateWrite(resultPath,{question:pair.question,results});const resultHash=sha256(await readFile(resultPath));ledger.finish(resultHash,true,{kind:'evaluation',wave:cursor.wave,contextTime:cursor.contextTime,archiveHeadHash:cursor.archiveHeadHash,totalBatches:cursor.totalBatches,nextBatch:cursor.nextBatch,evaluatedPairs:cursor.evaluatedPairs+1,...(cursor.wavePlan?{wavePlan:cursor.wavePlan}:{})});succeeded=true;report.pairedResultHash=resultHash;report.archiveHeadHash=cursor.archiveHeadHash;
  }catch(error){failure??=error;ledger.stop(safeCode(error));await sealedError(join(output,'DO_NOT_OPEN'),error);}
  finally{const calls=ledger.admitted.filter(e=>e.data.stage===stage).length;report.status=succeeded?'paired-success':'stopped';report.realModelCalls=options.stub?0:calls;report.stubModelCalls=options.stub?calls:0;report.completedCalls=completed;report.failure=failure?{code:safeCode(failure)}:undefined;report.cumulative={...ledger.summary(),usage:usageTotals(ledger.events.filter(e=>e.kind==='receipt').map(e=>e.data as UsageReceipt))};report.finishedAt=new Date().toISOString();process.off('SIGTERM',interrupted);process.off('SIGINT',interrupted);ledger.close();await privateWrite(join(output,'ROOT_SAFE_stage.json'),report);}
  return {succeeded,report};
}
