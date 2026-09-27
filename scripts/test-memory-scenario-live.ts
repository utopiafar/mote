/** Frozen generated-scenario adapter. Default: offline stub preflight, never a live baseline.
 * MOTE_SCENARIO_FIXTURE=/external/wave-1.v1.json MOTE_SCENARIO_OUTPUT=/external/new-run
 * node --import tsx scripts/test-memory-scenario-live.ts
 * A separately supervised live run requires MOTE_SCENARIO_MODE=live. No automatic retry/judge.
 * MOTE_SCENARIO_RECOVERY_PLAN explicitly clones a failed run, retains completed extraction,
 * cancels its old integration window and requests the current recipe. It never imports a draft.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes,randomInt,randomUUID} from 'node:crypto';
import {chmod,cp,mkdir,readFile,realpath,rename,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,join,relative,resolve} from 'node:path';
import {backup,DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryResult,UsageReceipt} from '@mote/shared';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {materialId} from '../apps/server/src/materials.js';
import {sha256} from '../apps/server/src/store.js';
import {usageTotals} from '../apps/server/src/usage.js';
import {defaultMemoryIntegrationRecipe,defaultMemoryIntegrationStrategy,defaultMemoryIntegrationReview} from '../apps/server/src/memory-integration-policy.js';
import {observationKey} from '../apps/server/src/evidence-archive.js';
import {requestMemoryIntegration} from '../apps/server/src/memory-integration.js';

const frozenWaveHash='6f02fa2ca1a129c3f8dcb427eecaf6fc7ad84893613d63ff1afa2925678a04e1';
const frozenManifestHash='5e01370bee0816ca38cf8e2512fc74b7638606c456c146e296ea52fffe551c5e';
const frozenLiveRecoveryHash='dfca5c52b103a783c725b3db7f7297cdd9b8151f8d26496aeb05cab00ac7187a';
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const recoverySchema=z.object({schema:z.literal('mote-memory-scenario-recovery-plan@1'),kind:z.literal('completed-extractions-new-integration'),
  sourceReport:z.string(),sourceReportSha256:hashSchema,sourceVaultSha256:hashSchema,sourceMode:z.enum(['preflight','live']),sourceOuterCalls:z.literal(8),fixtureSha256:hashSchema,
  sourceFailedPhase:z.literal('integration/review'),oldWindowId:z.string().uuid(),integrationRecipe:z.object({id:z.literal('mote.memory-integration'),version:z.literal('2')}).strict(),
  limits:z.object({maximumOuterModelCalls:z.literal(6),perCallTimeoutMs:z.literal(300000),maximumRunDurationMs:z.literal(2100000),maximumAutomaticRetries:z.literal(0)}).strict(),
  protocol:z.string(),limitations:z.array(z.string()),
}).strict();
type RecoveryPlan=z.infer<typeof recoverySchema>;
const stamp=z.string().datetime({offset:true}),armSchema=z.enum(['archive-only','memory-and-archive']);
const recordSchema=z.object({id:z.string().min(1),sourceType:z.literal('note'),recordedAt:stamp,observedAt:stamp,text:z.string().min(1).max(12000),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const fixtureSchema=z.object({schema:z.literal('mote-memory-scenario-fixture@1'),personalDataUsed:z.literal(false),heldOut:z.literal(false),contextTime:stamp,timeZone:z.string(),
  model:z.object({provider:z.literal('codex'),protocol:z.literal('codex-app-server'),model:z.literal('gpt-6-sol'),reasoningEffort:z.literal('max')}).strict(),
  records:z.array(recordSchema).min(1),questions:z.array(z.object({id:z.string(),text:z.string().min(1)}).strict()).min(1),extractionOrder:z.array(z.string()),
  askOrder:z.array(z.object({id:z.string(),arms:z.array(armSchema).length(2)}).strict()),
  limits:z.object({maximumOuterModelCalls:z.literal(12),perCallTimeoutMs:z.literal(300000),maximumRunDurationMs:z.literal(4500000),maximumAutomaticRetries:z.literal(0)}).strict(),
}).strict();
type Fixture=z.infer<typeof fixtureSchema>;
type Arm=z.infer<typeof armSchema>;
type Node=Awaited<ReturnType<typeof buildApp>>;
type Snapshot=Record<string,{rows:number;sha256:string}>;
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
function disjoint(a:string,b:string){for(const [from,to] of [[a,b],[b,a]]){const part=relative(from,to);assert.ok(part==='..'||part.startsWith('../'),`Directories must be disjoint: ${a}, ${b}`);}}
async function externalExisting(path:string){const actual=await realpath(resolve(path));disjoint(repositoryRoot,actual);return actual;}
async function newExternal(path:string){const parent=await externalExisting(dirname(resolve(path)));return join(parent,basename(resolve(path)));}
async function absentOrEmpty(path:string){try{assert.equal((await stat(path)).size,0,`Vault is not closed: ${path}`);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
async function closed(vault:string){await absentOrEmpty(join(vault,'logs','central.lock'));await absentOrEmpty(join(vault,'mote.sqlite-wal'));}
function tableSnapshot(db:DatabaseSync):Snapshot{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>{
  const name=String(row.name),rows=db.prepare(`SELECT * FROM ${quote(name)}`).all().map(value=>JSON.stringify(value)).sort();return [name,{rows:rows.length,sha256:sha256(JSON.stringify(rows))}];
}));}
// These are Memory records and their execution caches, never source/Material tables.
const ablatedTables=['memories','memory_jobs','memory_checkpoints','memory_extraction_drafts','memory_lifecycle_state','memory_events'] as const;
const ablationAllowed=new Set<string>([...ablatedTables,'memory_catalog','memory_scopes','memory_dependencies','memory_artifact_dependencies','memory_batches','memory_batch_dependencies','memory_job_counts','memory_input_plans','memory_input_authorizations','memory_extraction_draft_dependencies','storage_ledger','memories_fts','memories_fts_data','memories_fts_idx','memories_fts_content','memories_fts_docsize','memories_fts_config']);
// Fresh text ingress has no other semantic products. Fail closed if this assumption changes.
const emptyDerivedTables=['conversations','conversation_turns','working_memories','query_runs','insights','insight_runs','memory_deletions','memory_deletion_dependencies','artifact_dependencies','artifact_material_inputs','memory_artifact_dependencies'];
function assertNoOtherDerived(db:DatabaseSync){const snapshot=tableSnapshot(db);for(const name of emptyDerivedTables)if(snapshot[name])assert.equal(snapshot[name].rows,0,`Unexpected derived surface ${name}; this adapter does not silently carry it into A`);assertExactSourceSegments(db);}
/** Only the three complete, single-original production exact-text segments qualify
 * as shared retrieval indexes. Unknown processors and semantic caches fail closed. */
function assertExactSourceSegments(db:DatabaseSync){
  const hash=(value:unknown)=>sha256(JSON.stringify(value)),rows=db.prepare('SELECT * FROM context_artifacts ORDER BY id').all();assert.equal(rows.length,fixture.records.length,'Expected all three settled original-text segments');
  for(const table of ['artifact_inputs','context_observations','context_contents','artifacts_fts','artifact_events'])assert.equal(Number(db.prepare(`SELECT count(*) n FROM ${quote(table)}`).get()!.n),rows.length,`Unexpected ${table} rows`);
  assert.equal(Number(db.prepare('SELECT count(*) n FROM context_dirty').get()!.n),0,'Original indexes must settle before snapshot');const seen=new Set<string>();
  for(const row of rows){
    const artifact=JSON.parse(String(row.json)),inputs=db.prepare('SELECT observation_id,fingerprint FROM artifact_inputs WHERE artifact_id=?').all(row.id);assert.equal(inputs.length,1);
    const raw=db.prepare('SELECT fingerprint,json FROM captures WHERE id=?').get(inputs[0].observation_id);assert.ok(raw);const original=JSON.parse(String(raw.json)),record=fixture.records.find(item=>item.id===original.provenance?.externalId);assert.ok(record);assert.ok(!seen.has(record.id));seen.add(record.id);
    assert.equal(original.provenance.sourceId,sourceId);assert.equal(original.ocrText,record.text);assert.equal(sha256(original.ocrText),record.sha256);assert.equal(Date.parse(original.capturedAt),Date.parse(record.observedAt));assert.equal(original.provenance.document.recordedAt,record.recordedAt);
    assert.equal(db.prepare('SELECT capture_id FROM source_heads WHERE source_id=? AND external_id=?').get(sourceId,record.id)!.capture_id,original.id,'Segment original is no longer current');
    const perceptions=db.prepare("SELECT kind,json_extract(json,'$.text') AS text FROM perception_results WHERE capture_id=? AND current=1 ORDER BY kind").all(original.id);assert.deepEqual(perceptions,[],'Generated note segment acquired perception-derived text');
    const fingerprint=hash([raw.fingerprint,perceptions]);assert.equal(inputs[0].fingerprint,fingerprint);const group=observationKey(original),id=hash([group,original.id]),contentHash=hash(record.text);
    const metadata={grouping:'fixed_time_and_explicit_identity',semanticGrouping:false,observationCount:1,uniqueTexts:1,complete:true,entries:[{ids:[original.id],firstAt:original.capturedAt,lastAt:original.capturedAt,complete:true,characters:record.text.length}],originalCharacters:record.text.length,characters:record.text.length};
    const revision=hash([[{id:original.id,fingerprint}],'mote.exact-segment','1',metadata]);assert.ok(!Number.isNaN(Date.parse(artifact.generatedAt)));
    const expected={id,revision,kind:'segment',processor:'mote.exact-segment',processorVersion:'1',configFingerprint:hash({windowMs:300000,maxCharacters:12000,maxMembers:100}),generatedAt:artifact.generatedAt,firstAt:original.capturedAt,lastAt:original.capturedAt,deviceId:original.deviceId,appId:original.appId,source:original.source,members:[original.id],representatives:[original.id],contentHash,metadata,parents:[]};assert.deepEqual(artifact,expected,'Artifact is not the exact original-text index');
    assert.deepEqual({...row},{id,group_key:group,revision,kind:'segment',first_at:original.capturedAt,last_at:original.capturedAt,device_id:original.deviceId,app_id:original.appId,source:original.source,content_hash:contentHash,json:row.json});
    assert.deepEqual(JSON.parse(String(db.prepare('SELECT json FROM context_contents WHERE hash=?').get(contentHash)!.json)),{text:record.text});
    assert.deepEqual({...db.prepare('SELECT * FROM context_observations WHERE id=?').get(original.id)},{id:original.id,group_key:group,content_hash:contentHash});
    assert.deepEqual(db.prepare('SELECT id,text FROM artifacts_fts WHERE id=?').all(id).map(value=>({...value})),[{id,text:record.text}]);assert.deepEqual(db.prepare('SELECT entity,operation FROM artifact_events WHERE entity=?').all(id).map(value=>({...value})),[{entity:id,operation:'ready'}]);
  }
  assert.deepEqual([...seen].sort(),fixture.records.map(record=>record.id).sort());return rows.map(row=>({id:row.id,revision:row.revision,contentHash:row.content_hash}));
}
const queryWriteTables=new Set(['execution_operations','execution_steps','execution_jobs','execution_fairness','execution_operation_steps','execution_sequence','operation_changes','operation_progress','run_execution_owners','model_usage','query_runs','conversations','conversation_turns','working_memories','storage_ledger','memory_events']);
function protectedSnapshot(db:DatabaseSync){return Object.fromEntries(Object.entries(tableSnapshot(db)).filter(([name])=>!ablationAllowed.has(name)&&!queryWriteTables.has(name)));}
function assertSqlite(db:DatabaseSync){assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);}
async function cloneClosed(sourceVault:string,targetVault:string){
  await closed(sourceVault);const before=sha256(await readFile(join(sourceVault,'mote.sqlite')));
  await cp(sourceVault,targetVault,{recursive:true,errorOnExist:true,force:false,filter:path=>!['mote.sqlite','mote.sqlite-wal','mote.sqlite-shm','logs','token'].includes(basename(path))});
  await chmod(targetVault,0o700);const db=new DatabaseSync(join(sourceVault,'mote.sqlite'),{readOnly:true});
  try{assertSqlite(db);await backup(db,join(targetVault,'mote.sqlite'));}finally{db.close();}
  // A closed portable snapshot must not depend on a writable WAL/shared-memory pair.
  const target=new DatabaseSync(join(targetVault,'mote.sqlite'));try{target.exec('PRAGMA journal_mode=DELETE');assertSqlite(target);}finally{target.close();}
  await closed(sourceVault);assert.equal(sha256(await readFile(join(sourceVault,'mote.sqlite'))),before,'Backup modified its source');
  return {method:'node:sqlite.backup',sourceSha256:before,cloneSha256:sha256(await readFile(join(targetVault,'mote.sqlite')))};
}
function ablate(vault:string,arm:Arm){const db=new DatabaseSync(join(vault,'mote.sqlite'));try{
  db.exec('PRAGMA foreign_keys=ON');assertNoOtherDerived(db);const before=tableSnapshot(db);
  if(arm==='archive-only'){db.exec('BEGIN IMMEDIATE');try{for(const name of ablatedTables)if(before[name])db.exec(`DELETE FROM ${quote(name)}`);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}}
  const after=tableSnapshot(db),changed=Object.keys(before).filter(name=>JSON.stringify(before[name])!==JSON.stringify(after[name]));
  for(const name of changed)assert.ok(arm==='archive-only'&&ablationAllowed.has(name),`Unexpected ablation mutation: ${name}`);
  if(arm==='archive-only'){assert.equal(after.memories.rows,0);assert.equal(after.memories_fts.rows,0);assert.equal(after.memory_deletions.rows,0);}
  else assert.deepEqual(after,before);
  assertSqlite(db);return {before,after,changedTables:changed,allowedTables:[...ablationAllowed],userDeleteCalled:false};
}finally{db.close();}}

/** Shared hard bound for stub and future live runs. Repeated job/phase means a retry. */
class OuterBudget {
  count=0;seen=new Set<string>();
  constructor(readonly max:number,readonly deadline:number,readonly perCallMs:number,readonly now=Date.now){}
  async run<T>(key:string,task:(signal:AbortSignal)=>Promise<T>,parent?:AbortSignal){
    assert.ok(this.count<this.max,'Outer call budget exhausted');assert.ok(this.now()<this.deadline,'Run deadline exhausted');assert.ok(!this.seen.has(key),'Automatic outer retry blocked');parent?.throwIfAborted();
    this.seen.add(key);this.count++;
    const control=new AbortController(),abort=()=>control.abort(parent?.reason),ms=Math.min(this.perCallMs,this.deadline-this.now());
    parent?.addEventListener('abort',abort,{once:true});let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([task(control.signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{const error=Error('Scenario call deadline exhausted');control.abort(error);reject(error);},ms);})]);}
    finally{if(timer)clearTimeout(timer);parent?.removeEventListener('abort',abort);}
  }
}
async function budgetPrecheck(max:number){
  const budget=new OuterBudget(max,1000,100,()=>0);let calls=0;
  for(let i=0;i<max;i++)await budget.run(String(i),async()=>{calls++;});await assert.rejects(budget.run('extra',async()=>{calls++;}),/budget exhausted/);assert.equal(calls,max);
  const retry=new OuterBudget(12,1000,100,()=>0);await retry.run('same',async()=>{});await assert.rejects(retry.run('same',async()=>{}),/retry blocked/);
  await assert.rejects(new OuterBudget(12,0,100,()=>0).run('late',async()=>{}),/Run deadline/);
  let aborted=false;await assert.rejects(new OuterBudget(12,Date.now()+1000,5).run('slow',signal=>new Promise(()=>{signal.addEventListener('abort',()=>{aborted=true;});})),/call deadline/);assert.equal(aborted,true);
  return {maximumCalls:max,firstExcessCallBlocked:true,retryBlocked:true,runDeadlineBlocked:true,callTimeoutAborted:true,providerCalls:0};
}

assert.ok(process.env.MOTE_SCENARIO_FIXTURE&&process.env.MOTE_SCENARIO_OUTPUT,'Set MOTE_SCENARIO_FIXTURE and a new external MOTE_SCENARIO_OUTPUT');
const mode=z.enum(['preflight','live']).parse(process.env.MOTE_SCENARIO_MODE??'preflight'),preflight=mode==='preflight';
assert.ok(preflight||process.env.MOTE_SCENARIO_PREFLIGHT_VARIANT===undefined,'A stub variant must never affect a live run');
const recoveryPath=process.env.MOTE_SCENARIO_RECOVERY_PLAN?await externalExisting(process.env.MOTE_SCENARIO_RECOVERY_PLAN):undefined;
const recoveryBytes=recoveryPath?await readFile(recoveryPath):undefined;
const recovery:RecoveryPlan|undefined=recoveryBytes?recoverySchema.parse(JSON.parse(recoveryBytes.toString('utf8'))):undefined;
const recoveryValidateOnly=z.enum(['0','1']).parse(process.env.MOTE_SCENARIO_RECOVERY_VALIDATE_ONLY??'0')==='1';
assert.ok(!recoveryValidateOnly||recovery,'Validation-only requires an explicit recovery plan');
if(recovery){assert.equal(recovery.sourceMode,mode,'Preflight and live source runs cannot be mixed');assert.equal(recovery.fixtureSha256,frozenWaveHash);assert.deepEqual(recovery.integrationRecipe,defaultMemoryIntegrationRecipe);if(!preflight)assert.equal(sha256(recoveryBytes!),frozenLiveRecoveryHash,'Live recovery must use the separately frozen plan');}
const preflightVariant=z.enum(['empty-integration','nonempty-integration','failed-integration-review']).parse(process.env.MOTE_SCENARIO_PREFLIGHT_VARIANT??(recovery?'nonempty-integration':'empty-integration'));
if(recovery&&preflight)assert.equal(preflightVariant,'nonempty-integration','Recovery preflight must exercise independent integration review');
const fixturePath=await externalExisting(process.env.MOTE_SCENARIO_FIXTURE),fixtureBytes=await readFile(fixturePath);
assert.equal(sha256(fixtureBytes),frozenWaveHash,'Only frozen wave-1.v1 is supported; new scenarios need explicit registration');
const fixture:Fixture=fixtureSchema.parse(JSON.parse(fixtureBytes.toString('utf8'))),fixtureDirectory=dirname(fixturePath);
const limits=recovery?.limits??fixture.limits;
const manifestBytes=await readFile(join(fixtureDirectory,'manifest.json')),manifest=JSON.parse(manifestBytes.toString('utf8'));
assert.equal(sha256(manifestBytes),frozenManifestHash,'The registry/design paths and hashes must remain frozen');
assert.equal(manifest.privateDataUsed,false);assert.equal(manifest.modelsCalled,0);assert.equal(manifest.files[basename(fixturePath)],frozenWaveHash);
const fixtureHashes:Record<string,string>={};
for(const [file,hash] of Object.entries(manifest.files)){assert.equal(basename(file),file);fixtureHashes[file]=sha256(await readFile(join(fixtureDirectory,file)));assert.equal(fixtureHashes[file],hash,`Frozen ${file} changed`);}
assert.equal(sha256(await readFile(await externalExisting(manifest.design))),manifest.designSha256,'Frozen design changed');
// Read only source/question registries for structural matching; never parse or inject rubric.
const recordRegistry=JSON.parse(await readFile(join(fixtureDirectory,'records.v1.json'),'utf8')).records as unknown[];
const questionRegistry=JSON.parse(await readFile(join(fixtureDirectory,'questions.v1.json'),'utf8'));
for(const record of fixture.records){assert.equal(sha256(record.text),record.sha256);const registered=recordRegistry.find(value=>(value as {id:string}).id===record.id);assert.deepEqual(recordSchema.parse(registered),record);}
assert.equal(new Set(fixture.records.map(r=>r.id)).size,fixture.records.length);
assert.deepEqual([...fixture.extractionOrder].sort(),fixture.records.map(r=>r.id).sort());
assert.deepEqual(fixture.askOrder.map(q=>q.id).sort(),fixture.questions.map(q=>q.id).sort());
for(const q of fixture.questions)assert.ok(questionRegistry.questions.some((entry:{id:string;text:string})=>entry.id===q.id&&entry.text===q.text));
for(const order of fixture.askOrder)assert.equal(new Set(order.arms).size,2);
const directory=await newExternal(process.env.MOTE_SCENARIO_OUTPUT);disjoint(fixtureDirectory,directory);await mkdir(directory,{mode:0o700});
const started=Date.now(),reportPath=join(directory,'report.json'),token=randomBytes(32).toString('hex'),sourceId='generated-memory-scenario-v1';
const generationVault=join(directory,'generation','vault'),snapshotVault=join(directory,'snapshot','vault');
const report:Record<string,any>={schema:'mote-memory-scenario-run@1',mode,status:'preparing',startedAt:new Date(started).toISOString(),personalDataUsed:false,heldOut:false,
  ...(preflight?{preflightVariant}:{}),
  fixtureSha256:frozenWaveHash,fixtureHashes,manifestSha256:sha256(manifestBytes),intendedModel:fixture.model,actualAgent:recoveryValidateOnly?'provider-blocked-source-validation':preflight?'offline-stub':fixture.model,
  recoveryValidateOnly,semanticQualityAccepted:false,netBenefitAccepted:false,liveBaselineEligible:!preflight&&!recoveryValidateOnly,browserTested:false,physicalDevicesTested:false,
  maximumOuterCalls:limits.maximumOuterModelCalls,fixtureMaximumOuterCalls:fixture.limits.maximumOuterModelCalls,priorOuterCalls:recovery?.sourceOuterCalls??0,maximumCumulativeOuterCalls:(recovery?.sourceOuterCalls??0)+limits.maximumOuterModelCalls,maximumAutomaticOuterRetries:0,callCounterUnit:'outer agent.query invocation',providerInternalRequestCount:null,
  internalRepairPolicy:'Production Agent may repair validation within one outer invocation; visible model/repair turns are reported separately, hidden provider requests remain unknown.',
  deadlineProtection:{outerAdmissionDeadlineMs:limits.maximumRunDurationMs,perCallDeadlineMs:limits.perCallTimeoutMs,wholeProcessWatchdog:false,limitation:'Open, filesystem backup and close are not bounded by the query timer; supervise a live process separately.'},
  rubricInjected:false,paidJudge:false,publishRequests:0,realModelCalls:0,stubCalls:0,
  contextTimeAdapter:'Host-only QueryInput.contextTime is fixed; HTTP question and original timestamps are unchanged.',
  ablationPolicy:'Both arms retain identical production query instructions and read-only tools. A has empty Memory data/tools results, no special ignore-Memory prompt. Every arm/question opens a fresh snapshot clone and conversation.',
  protocolClarification:'Current production extraction with explicit evidenceIds exposes only the bounded evidence tool. This wave measures per-record bounded extraction followed by integration, not incremental extraction that retrieves earlier Memory. No permissions are expanded for evaluation.',
  limitations:['Generated development set, not held out.','Stub preflight outputs are synthetic plumbing fixtures, not extracted knowledge or live quality evidence.','Provider internal requests and cache state are unknown.','Only frozen wave 1 note ingress is supported.'],
  records:[],jobs:[],calls:[],arms:[],usageByVault:[],failures:[]};
let node:Node|undefined,currentVault='',stage='prepare',currentArm:Arm|undefined,questionId:string|undefined,saveChain=Promise.resolve();
let vaultInitialUsageIds=new Set<string>();const newUsageById=new Map<string,UsageReceipt>();
let recoverySource:{vault:string;reportPath:string;hashes:Record<string,string>;records:any[];jobs:any[];parents:any[];checkpoint:any;oldState:any;integrationSelection:string;jobSnapshot:Snapshot;receipts:UsageReceipt[]}|undefined;
const budget=new OuterBudget(limits.maximumOuterModelCalls,started+limits.maximumRunDurationMs,limits.perCallTimeoutMs);
function save(){const value=json(report);saveChain=saveChain.then(async()=>{await writeFile(reportPath+'.tmp',value,{mode:0o600});await rename(reportPath+'.tmp',reportPath);});return saveChain;}
function progress(value:string,extra:Record<string,unknown>={}){console.log(JSON.stringify({stage:value,mode,...extra}));}
function memories(){return node!.store.db.prepare('SELECT json FROM memories ORDER BY id').all().map(row=>JSON.parse(String(row.json)));}
function evidenceIds():string[]{return report.records.flatMap((r:any)=>r.evidenceIds);}
function config(vault:string):Config{return {dataKey:undefined,dataDir:vault,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,maxStorageBytes:200_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
  model:preflight?'scenario-preflight-stub':fixture.model.model,modelReasoningEffort:fixture.model.reasoningEffort,modelProvider:preflight?'custom':fixture.model.provider,modelProtocol:preflight?'openai-completions':fixture.model.protocol,
  modelBaseUrl:preflight?'http://127.0.0.1:1':'',apiKey:'',allowUnauthenticatedLocal:preflight,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',diagnosticsEnabled:false,agentTraceEnabled:true,
  agentTimeoutMs:limits.perCallTimeoutMs,codexBin:preflight?'/nonexistent-scenario-preflight-no-provider':process.env.MOTE_CODEX_BIN,codexHome:preflight?join(directory,'unused-codex-home'):process.env.MOTE_CODEX_HOME,memoryConcurrency:1};}
async function stub(reader:ContextReader,input:QueryInput):Promise<QueryResult>{
  assert.ok(preflight);assert.equal(input.contextTime,fixture.contextTime);
  const result={citations:[] as QueryResult['citations'],trace:[],runId:'stub-'+randomUUID()};
  if(input.skill==='memory-integration'){
    if(preflightVariant==='failed-integration-review'&&input.traceContext?.phase==='review')throw Error('Frozen offline integration review failure');
    if(preflightVariant==='empty-integration')return {...result,answer:'{"memories":[]}'}; // Deliberate empty output, never a semantic verdict.
    // Mechanical schema fixture exercises commit/review/parent proofs, not synthesis quality.
    const parents=report.beforeIntegration.slice(0,2);assert.equal(parents.length,2);
    const visible=await reader.memories!({limit:100,includeHistory:true});for(const parent of parents)assert.ok(visible.items.some((m:any)=>m.id===parent.id));
    const ids=[...new Set<string>(parents.flatMap((m:any)=>m.evidenceIds))],originals=await reader.evidence({ids});assert.equal(originals.length,ids.length);
    const candidate={domain:'personal',title:'Offline integration plumbing only',statement:'Synthetic integration fixture for supplied originals '+ids.map(id=>`[${id}]`).join(' '),uncertainty:'Mechanically combined for host validation only; no relationship or semantic quality has been assessed.',
      admission:{layer:'memory',reason:'Stub parent-proof/independent-review plumbing fixture.',scope:'Offline generated scenario preflight',attribution:'observed'},relatedMemoryIds:parents.map((m:any)=>m.id),evidenceIds:ids,evidence:originals.map(o=>({id:o.id,quote:o.ocrText}))};
    return {...result,answer:JSON.stringify({memories:[candidate]}),citations:originals.map(o=>({id:o.id,capturedAt:o.capturedAt,appName:o.appName,excerpt:o.ocrText}))};
  }
  if(input.responseMode==='memory-extraction'){
    const originals=await reader.evidence({ids:input.evidenceIds!});assert.equal(originals.length,input.evidenceIds!.length);
    const candidates=originals.map(original=>({domain:'personal',title:'Offline fixture plumbing only',statement:`Offline stub retained this supplied record [${original.id}]`,uncertainty:'Synthetic preflight output; no semantic extraction was performed.',
      admission:{layer:'memory',reason:'Stub fixture validates host lifecycle only.',scope:'Offline generated scenario preflight',attribution:'user'},evidenceIds:[original.id],evidence:[{id:original.id,quote:original.ocrText}]}));
    return {...result,answer:JSON.stringify({memories:candidates}),citations:originals.map(o=>({id:o.id,capturedAt:o.capturedAt,appName:o.appName,excerpt:o.ocrText}))};
  }
  assert.equal(input.conversation,undefined,'Each question must have a new conversation');
  const originals=await reader.evidence({ids:evidenceIds()}),cards=await reader.memories!({limit:100,includeHistory:true});
  assert.equal(originals.length,evidenceIds().length);if(currentArm==='archive-only'){assert.equal(cards.items.length,0);assert.equal(input.openingMemories?.length??0,0);}
  const call=report.calls.at(-1);call.stubReads={evidenceIds:originals.map(o=>o.id),memoryCount:cards.items.length,openingMemoryCount:input.openingMemories?.length??0};
  return {...result,answer:'OFFLINE STUB: no answer or quality assessment was generated.',citations:originals.map(o=>({id:o.id,capturedAt:o.capturedAt,appName:o.appName,excerpt:o.ocrText}))};
}
async function open(vault:string){
  assert.equal(node,undefined);currentVault=vault;
  node=await buildApp(config(vault),{backgroundWorker:false,...(recoveryValidateOnly?{createModelAgent:async()=>({configured:true,close:async()=>{},query:async()=>{throw Error('Recovery source validation forbids provider calls');}})}:preflight?{createModelAgent:async(_settings:any,reader:ContextReader)=>({configured:true,close:async()=>{},query:(input:QueryInput)=>stub(reader,input)})}:{})});
  // Offline-only old-version fixture. A restarted recovery node does not install it.
  if(preflight&&!recovery&&preflightVariant==='failed-integration-review'){
    node.memoryStrategies.registerIntegration({...defaultMemoryIntegrationStrategy,version:'1',prompt:'Offline old-version integration plumbing fixture; no semantic evaluation.'});
    node.memoryStrategies.registerIntegrationRecipe({id:defaultMemoryIntegrationRecipe.id,version:'1',integrate:{id:defaultMemoryIntegrationStrategy.id,version:'1'},review:{id:defaultMemoryIntegrationReview.id,version:defaultMemoryIntegrationReview.version}});
    node.memoryIntegrationSettings.configure({recipe:{id:defaultMemoryIntegrationRecipe.id,version:'1'}});
  }
  const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
  const query=node.agent.query.bind(node.agent);
  node.agent.query=async input=>{
    assert.ok(!recoveryValidateOnly,'Recovery source validation forbids agent admission');
    const phase=input.traceContext?.phase??'ask',key=[stage,currentArm??'',questionId??'',input.traceContext?.jobId??'',input.traceContext?.batchId??'',phase].join(':');
    assert.ok(report.calls.filter((call:any)=>call.stage===stage).length<({extraction:recovery?0:6,integration:2,ask:4}[stage]??0),'Frozen stage call budget exhausted');
    const request={...input,contextTime:fixture.contextTime};
    if(stage==='ask'){assert.equal(request.question,fixture.questions.find(q=>q.id===questionId)!.text);assert.equal(request.conversation,undefined);if(currentArm==='archive-only')assert.equal(request.openingMemories?.length??0,0);}
    return budget.run(key,async signal=>{
      const call:Record<string,any>={ordinal:report.calls.length+1,stage,phase,arm:currentArm,questionId,startedAt:new Date().toISOString(),status:'running',stub:preflight,possiblyBillable:!preflight,
        input:{...request,signal:undefined,onTrace:undefined,onProgress:undefined,validateOutput:undefined},trace:[]};call.inputSha256=sha256(JSON.stringify(call.input));
      report.calls.push(call);if(preflight)report.stubCalls++;else report.realModelCalls++;await save();progress('agent-start',{ordinal:call.ordinal,phase});
      try{const result=await query({...request,signal,onTrace:event=>{call.trace.push(event);input.onTrace?.(event);}});call.result=result;call.status='completed';return result;}
      catch(error){call.status='failed';call.failure=message(error);throw error;}
      finally{call.durationMs=Date.now()-Date.parse(call.startedAt);call.visibleModelTurns=call.trace.filter((event:any)=>event.type==='model.started').length;call.visibleRepairTurns=call.trace.filter((event:any)=>event.type==='model.started'&&event.payload?.repair===true).length;await save();}
    },input.signal);
  };
  await node.app.ready();assertSqlite(node.store.db);
  vaultInitialUsageIds=new Set(node.store.db.prepare('SELECT id FROM model_usage').all().map(row=>String(row.id)));
}
async function close(){if(!node)return;const closing=node;node=undefined;
  // app.close drains Agent cancellation and final usage before the store closes.
  // Reading before it can lose a late sample after the outer deadline has fired.
  await closing.app.close();await closed(currentVault);const db=new DatabaseSync(join(currentVault,'mote.sqlite'),{readOnly:true});
  let rows:ReturnType<ReturnType<DatabaseSync['prepare']>['all']>;try{rows=db.prepare('SELECT id,json FROM model_usage ORDER BY created_at,id').all();}finally{db.close();}
  const receipts=rows.map(row=>JSON.parse(String(row.json)) as UsageReceipt),newReceipts=rows.filter(row=>!vaultInitialUsageIds.has(String(row.id))).map(row=>JSON.parse(String(row.json)) as UsageReceipt);
  for(const row of rows)if(!vaultInitialUsageIds.has(String(row.id))){const receipt=JSON.parse(String(row.json)) as UsageReceipt;assert.ok(!newUsageById.has(String(row.id))||JSON.stringify(newUsageById.get(String(row.id)))===JSON.stringify(receipt),'Receipt ID changed across vaults');newUsageById.set(String(row.id),receipt);}
  report.usageByVault.push({vault:relative(directory,currentVault),includesSeedReceipts:Boolean(recovery)||currentVault!==generationVault,stub:preflight,readAfterAppClose:true,total:usageTotals(receipts),receipts,newIds:rows.filter(row=>!vaultInitialUsageIds.has(String(row.id))).map(row=>String(row.id)),newTotal:usageTotals(newReceipts),inheritedIds:[...vaultInitialUsageIds],note:'Read from closed SQLite after Agent shutdown; total includes inherited snapshot receipts, only newIds count toward this run'});
  await save();
}
async function request(method:'GET'|'POST'|'PUT',url:string,payload?:unknown){assert.ok(!url.endsWith('/publish'));const response=await node!.app.inject({method,url,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2'},...(payload===undefined?{}:{payload:payload as object})});assert.ok(response.statusCode>=200&&response.statusCode<300,`${method} ${url}: ${response.statusCode} ${response.body}`);return response.json();}
function originals(){return node!.memories.readEvidence(evidenceIds());}
function verifyOriginals(){for(const record of report.records){const original=node!.store.evidence([record.captureId])[0];assert.equal(original.ocrText,record.text);assert.equal(Date.parse(original.capturedAt),Date.parse(record.observedAt));assert.equal(Date.parse(original.provenance!.document!.recordedAt!),Date.parse(record.recordedAt));
  const material=node!.materials.get(record.materialRef);assert.ok(material);assert.deepEqual(node!.materials.evidenceIds(material.ref),record.evidenceIds);
  const formal=node!.memories.readEvidence(record.evidenceIds);assert.equal(formal.length,1);assert.equal(sha256(formal[0].ocrText),record.formalTextSha256);assert.equal(JSON.parse(formal[0].ocrText).text,record.text);
}}
async function seed(){
  await request('POST','/api/sources',{id:sourceId,name:'Generated scenario wave 1',kind:'custom',deviceId:sourceId,platform:'import',retention:'archive'});
  for(const id of fixture.extractionOrder){const record=fixture.records.find(r=>r.id===id)!,document={contentRole:'authored',recordedAt:record.recordedAt};
    const payload={externalId:id,revision:sha256(JSON.stringify([record.sha256,document])),observedAt:record.observedAt,kind:'message',layer:'original',text:record.text,document};
    const before=Date.now(),ack=await request('PUT',`/api/sources/${sourceId}/items`,payload),duplicate=await request('PUT',`/api/sources/${sourceId}/items`,payload);
    assert.equal(duplicate.id,ack.id);assert.equal(duplicate.duplicate,true);
    let drained=false;for(let i=0;i<20;i++)if(await node!.materialOrganizer.tick(100)===0){drained=true;break;}assert.ok(drained,'Organizer did not drain');
    const material=node!.materials.get(materialId(sourceId,id));assert.ok(material&&node!.materialMemoryWork.readyForMemory(material.ref));
    const ids=node!.materials.evidenceIds(material.ref),formal=node!.memories.readEvidence(ids),capture=node!.store.evidence([ack.id])[0];assert.equal(formal.length,1);assert.ok(Date.parse(capture.receivedAt)>=before&&Date.parse(capture.receivedAt)<=Date.now());
    report.records.push({...record,captureId:ack.id,materialRef:material.ref,evidenceIds:ids,formalTextSha256:sha256(formal[0].ocrText),receivedAt:capture.receivedAt});await save();
  }
  // The ordinary capture feature timer runs this same deterministic aggregate
  // after a 15-second settling delay. Settle explicitly so fast stubs also cover it.
  node!.store.archive.aggregate(100);report.originalTextSegments=assertExactSourceSegments(node!.store.db);
  verifyOriginals();assertNoOtherDerived(node!.store.db);assert.equal(report.calls.length,0);
}
function assertIdle(){assert.ok(node!.memoryPipeline.list().every(j=>['completed','failed','cancelled'].includes(j.status)),'Unfinished Memory job');assert.ok(node!.lifecycle.view().extensions.every(e=>!e.active),'Unfinished lifecycle window');}
const extractionTables=['memory_jobs','memory_batches','memory_checkpoints','memory_input_plans','memory_input_authorizations','memory_extraction_drafts'];
function extractionSnapshot(db:DatabaseSync){const snapshot=tableSnapshot(db);return Object.fromEntries(extractionTables.filter(name=>snapshot[name]).map(name=>[name,snapshot[name]]));}
async function recoveryPrecheck(){
  assert.ok(recovery);const sourceReport=await externalExisting(recovery.sourceReport),vault=await externalExisting(join(dirname(sourceReport),'generation','vault'));
  disjoint(dirname(sourceReport),directory);await closed(vault);
  const paths={report:sourceReport,db:join(vault,'mote.sqlite'),fixture:join(dirname(sourceReport),'wave-1.v1.json'),manifest:join(dirname(sourceReport),'source-manifest.json')};
  const hashes=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([key,path])=>[key,sha256(await readFile(path))])));
  assert.equal(hashes.report,recovery.sourceReportSha256,'Failed report changed');assert.equal(hashes.db,recovery.sourceVaultSha256,'Failed source database changed');assert.equal(hashes.fixture,frozenWaveHash);assert.equal(hashes.manifest,frozenManifestHash);
  // Discard all call inputs/results while parsing. In particular, call 7's draft and
  // call 8's review prompt are neither inspected nor supplied to the new task.
  const source=JSON.parse(await readFile(sourceReport,'utf8'),(key,value)=>key==='result'||key==='input'?undefined:value);
  assert.equal(source.schema,'mote-memory-scenario-run@1');assert.equal(source.mode,mode);assert.equal(source.status,'failed');assert.equal(source.fixtureSha256,frozenWaveHash);assert.equal(source.personalDataUsed,false);assert.equal(source.heldOut,false);assert.deepEqual(source.intendedModel,fixture.model);
  assert.equal(source.outerCalls,recovery.sourceOuterCalls);assert.equal(source.calls.length,8);assert.equal(source.realModelCalls,preflight?0:8);assert.equal(source.stubCalls,preflight?8:0);assert.equal(source.arms.length,0);
  assert.deepEqual(source.calls.map((call:any)=>[call.stage,call.phase,call.status]),[['extraction','extract','completed'],['extraction','review','completed'],['extraction','extract','completed'],['extraction','review','completed'],['extraction','extract','completed'],['extraction','review','completed'],['integration','extract','completed'],['integration','review','failed']]);
  if(preflight){assert.equal(source.preflightVariant,'failed-integration-review');assert.equal(source.calls[7].failure,'Frozen offline integration review failure');}
  assert.equal(source.records.length,fixture.records.length);assert.deepEqual(source.records.map((record:any)=>record.id),fixture.extractionOrder);
  for(const record of source.records)assert.deepEqual(recordSchema.parse(Object.fromEntries(Object.keys(recordSchema.shape).map(key=>[key,record[key]]))),fixture.records.find(r=>r.id===record.id));
  assert.equal(source.jobs.length,3);assert.ok(source.jobs.every((job:any)=>job.status==='completed'&&job.failedBatches===0&&job.completedBatches===job.totalBatches));
  assert.equal(source.integration.request.id,recovery.oldWindowId);assert.equal(source.integration.state.active.id,recovery.oldWindowId);assert.ok(source.integration.state.error);
  const db=new DatabaseSync(paths.db,{readOnly:true});let oldState:any,checkpoint:any,integrationSelection:string,jobSnapshot:Snapshot,receipts:UsageReceipt[];
  try{
    assertSqlite(db);assertNoOtherDerived(db);const savedJobs=db.prepare('SELECT id,json FROM memory_jobs ORDER BY id').all();assert.equal(savedJobs.length,3);
    for(const row of savedJobs){
      const saved=JSON.parse(String(row.json)),expected=source.jobs.find((job:any)=>job.id===row.id);assert.ok(expected);
      // get() projects memoryIds from completed batches; the stored job keeps its
      // initial empty array. Check the projection against its persisted authority.
      for(const [key,value] of Object.entries(saved))if(key!=='memoryIds')assert.deepEqual(value,expected[key],`Completed job changed: ${key}`);
      const batches=db.prepare('SELECT json FROM memory_batches WHERE job_id=? ORDER BY idx').all(String(row.id)).map(batch=>JSON.parse(String(batch.json)));assert.equal(batches.length,expected.batches.length);
      for(const batch of batches){const prior=expected.batches.find((item:any)=>item.id===batch.id);assert.ok(prior);for(const key of ['status','strategy','configuration','evidenceRanges','attempts','memoryIds'])assert.deepEqual(batch[key],prior[key],`Completed batch changed: ${key}`);}
      assert.deepEqual([...new Set(batches.flatMap(batch=>batch.memoryIds))],expected.memoryIds);
    }
    const parents=db.prepare('SELECT json FROM memories ORDER BY id').all().map(row=>JSON.parse(String(row.json)));assert.deepEqual(parents,source.beforeIntegration,'Stored reviewed cards differ from the failed report');assert.ok(parents.every((parent:any)=>parent.status==='published'&&parent.reviewReceipt&&parent.reviewReceipt.model===(preflight?'scenario-preflight-stub':fixture.model.model)));
    oldState=JSON.parse(String(db.prepare("SELECT json FROM memory_lifecycle_state WHERE id='consolidation'").get()!.json));assert.equal(oldState.active.id,recovery.oldWindowId);assert.equal(oldState.active.manual,true);assert.equal(oldState.active.checkpoint,source.integration.state.active.checkpoint);assert.equal(oldState.failures,1);assert.ok(!oldState.cancelled);
    checkpoint=JSON.parse(oldState.active.checkpoint);assert.deepEqual(checkpoint.completed,[]);assert.equal(checkpoint.selection.binding.recipe.id,defaultMemoryIntegrationRecipe.id);assert.equal(checkpoint.selection.binding.recipe.version,'1');assert.equal(checkpoint.selection.binding.integrate.version,'1');
    integrationSelection=String(db.prepare("SELECT value FROM settings WHERE key='memory-integration-selection'").get()!.value);assert.equal(JSON.parse(integrationSelection).binding.recipe.version,'1','Source default selection must remain the old recipe');
    const eligible=parents.filter((parent:any)=>!parent.supersededBy&&parent.admission?.layer==='memory');assert.deepEqual([...oldState.active.ids].sort(),eligible.map((parent:any)=>parent.id).sort());assert.deepEqual(checkpoint.inputs.map((input:any)=>input.id).sort(),[...oldState.active.ids].sort());
    for(const input of checkpoint.inputs)assert.equal(input.hash,sha256(JSON.stringify(parents.find((parent:any)=>parent.id===input.id))),'Integration parent hash changed');
    for(const job of source.jobs){assert.deepEqual(job.configuration,checkpoint.model.configuration);assert.deepEqual(job.recipes,[{id:'mote.personal-memory',version:'2'}]);for(const batch of job.batches)assert.equal(batch.strategy.recipe.id,'mote.personal-memory');}
    assert.equal(checkpoint.model.model,preflight?'scenario-preflight-stub':fixture.model.model);jobSnapshot=extractionSnapshot(db);receipts=db.prepare('SELECT json FROM model_usage ORDER BY id').all().map(row=>JSON.parse(String(row.json)) as UsageReceipt);
  }finally{db.close();}
  recoverySource={vault,reportPath:sourceReport,hashes,records:source.records,jobs:source.jobs,parents:source.beforeIntegration,checkpoint,oldState,integrationSelection:integrationSelection!,jobSnapshot:jobSnapshot!,receipts:receipts!};
  report.recovery={kind:recovery.kind,planSha256:sha256(recoveryBytes!),sourceMode:mode,sourceReportSha256:hashes.report,sourceVaultSha256:hashes.db,oldWindowId:recovery.oldWindowId,oldBinding:checkpoint.selection.binding,newRecipe:recovery.integrationRecipe,completedExtractionJobs:source.jobs.map((job:any)=>job.id),parentHashes:checkpoint.inputs,originalHashes:source.records.map((record:any)=>({id:record.id,sha256:record.sha256,formalTextSha256:record.formalTextSha256})),sourceCalls:8,maximumNewCalls:6,maximumCumulativeCalls:14,originalFixtureCallLimit:12,sourceInputsAndResultsDiscarded:true,oldDraftInjected:false,sourceHashesBefore:hashes,sourceUsage:{total:usageTotals(receipts!),receipts:receipts!,note:preflight?'Inherited offline seed receipts, excluded from new-call accounting.':'Inherited receipts are preserved unchanged. The old failed receipt claims complete=true unreliably: 50,927 tokens are only the last reported sample; the prior total 196,355 may undercount. Do not infer exact cumulative usage.'},limitations:recovery.limitations};
  await assertRecoverySourceUnchanged();await save();
}
async function assertRecoverySourceUnchanged(){
  if(!recoverySource)return;const paths={report:recoverySource.reportPath,db:join(recoverySource.vault,'mote.sqlite'),fixture:join(dirname(recoverySource.reportPath),'wave-1.v1.json'),manifest:join(dirname(recoverySource.reportPath),'source-manifest.json')};
  await closed(recoverySource.vault);const hashes=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([key,path])=>[key,sha256(await readFile(path))])));assert.deepEqual(hashes,recoverySource.hashes,'Recovery modified its closed source');report.recovery.sourceHashesAfter=hashes;report.recovery.sourceUnchanged=true;
}
async function recoverGeneration(){
  assert.ok(recovery&&recoverySource);report.recovery.clone=await cloneClosed(recoverySource.vault,generationVault);report.records=structuredClone(recoverySource.records);report.jobs=structuredClone(recoverySource.jobs);
  await open(generationVault);verifyOriginals();assertNoOtherDerived(node!.store.db);report.originalTextSegments=assertExactSourceSegments(node!.store.db);assert.deepEqual(memories(),recoverySource.parents);assert.deepEqual(extractionSnapshot(node!.store.db),recoverySource.jobSnapshot);
  assert.deepEqual(node!.memoryPipeline.modelSnapshot(),recoverySource.checkpoint.model,'Recovery model pin changed');
  const oldSelection=JSON.parse(String(node!.store.db.prepare("SELECT json FROM memory_lifecycle_state WHERE id='consolidation'").get()!.json));assert.deepEqual(oldSelection,recoverySource.oldState,'Opening clone changed old window');
  assert.equal(String(node!.store.db.prepare("SELECT value FROM settings WHERE key='memory-integration-selection'").get()!.value),recoverySource.integrationSelection,'Opening clone silently rebound the default selection');
  assert.throws(()=>node!.memoryStrategies.resolveIntegration({id:defaultMemoryIntegrationRecipe.id,version:'1'}),'Old recipe must not silently map to new policy');
  const cancellation=await request('POST',`/api/memory-integrations/${recovery.oldWindowId}/cancel`,{}),cancelled=cancellation.extensions.find((entry:any)=>entry.id==='consolidation');assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.active.id,recovery.oldWindowId);assert.equal(cancelled.active.checkpoint,recoverySource.oldState.active.checkpoint);assert.equal(report.calls.length,0);
  report.recovery.oldWindowCancelled={id:cancelled.active.id,status:cancelled.status,checkpointUnchanged:true};report.recovery.newBinding=node!.memoryStrategies.resolveIntegration(recovery.integrationRecipe).binding;assert.equal(report.recovery.newBinding.integrate.version,'2');
  if(recoveryValidateOnly){
    // Same production request function as the HTTP route, without its tick side
    // effect. Both the Agent admission wrapper and factory independently block
    // provider calls, including a timer arriving during this validation.
    const created=requestMemoryIntegration({recipe:recovery.integrationRecipe,memoryIds:recoverySource.checkpoint.inputs.map((input:any)=>input.id)},{lifecycle:node!.lifecycle,memories:node!.memories,pipeline:node!.memoryPipeline});assert.notEqual(created.id,recovery.oldWindowId);
    const active=JSON.parse(String(node!.store.db.prepare("SELECT json FROM memory_lifecycle_state WHERE id='consolidation'").get()!.json)).active,next=JSON.parse(active.checkpoint);assert.equal(active.id,created.id);assert.deepEqual(next.selection.binding,report.recovery.newBinding);assert.deepEqual(next.inputs,recoverySource.checkpoint.inputs);assert.deepEqual(next.model,recoverySource.checkpoint.model);
    assert.deepEqual(extractionSnapshot(node!.store.db),recoverySource.jobSnapshot);assert.equal(String(node!.store.db.prepare("SELECT value FROM settings WHERE key='memory-integration-selection'").get()!.value),recoverySource.integrationSelection);assert.equal(report.calls.length,0);
    report.recovery.sourceValidation={newWindowId:created.id,originalTextSegments:report.originalTextSegments,newVersionPinned:true,completedExtractionsUnchanged:true,oldDefaultSelectionUnchanged:true,providerFactoryBlocked:true,agentAdmissionBlocked:true,modelCatalogSkipped:true,outerCalls:0};await close();await assertRecoverySourceUnchanged();return;
  }
  await integrate(recovery.integrationRecipe);assert.deepEqual(extractionSnapshot(node!.store.db),recoverySource.jobSnapshot,'Recovery re-ran or changed completed extraction');assert.equal(String(node!.store.db.prepare("SELECT value FROM settings WHERE key='memory-integration-selection'").get()!.value),recoverySource.integrationSelection,'Manual v2 task changed the old default selection');report.recovery.oldDefaultSelectionUnchanged=true;report.recovery.extractionJobsUnchanged=true;assert.equal(report.calls.filter((call:any)=>call.stage==='extraction').length,0);await close();await assertRecoverySourceUnchanged();
}
async function generate(){
  stage='extraction';for(const id of fixture.extractionOrder){const record=report.records.find((r:any)=>r.id===id);
    const job=await request('POST','/api/memory-jobs',{evidenceIds:record.evidenceIds,recipes:[{id:'mote.personal-memory',version:'2'}],contextTime:fixture.contextTime,timeZone:fixture.timeZone});
    const done=await node!.memoryPipeline.run(job.id);report.jobs.push(done);await save();assert.equal(done.status,'completed',JSON.stringify(done));
  }
  await integrate(preflight&&preflightVariant==='failed-integration-review'?{id:defaultMemoryIntegrationRecipe.id,version:'1'}:defaultMemoryIntegrationRecipe);
}
async function integrate(recipe=defaultMemoryIntegrationRecipe){
  report.beforeIntegration=memories();const eligible=report.beforeIntegration.filter((m:any)=>m.status==='published'&&!m.supersededBy&&m.admission?.layer==='memory');
  assert.ok(eligible.every((m:any)=>(m.domain??'personal')==='personal'),'Wave 1 only supports personal integration');stage='integration';
  if(eligible.length){const integration=await request('POST','/api/memory-integrations',{recipe,memoryIds:eligible.map((m:any)=>m.id)});if(recovery)assert.notEqual(integration.id,recovery.oldWindowId);await node!.lifecycle.tick();
    const state=node!.lifecycle.view().extensions.find(e=>e.id==='consolidation')!;report.integration={request:integration,state};assert.equal(state.active,undefined,JSON.stringify(state));assert.ok(!state.error,JSON.stringify(state));
  }else report.integration={status:'not-applicable',reason:'No eligible input cards; no forced Memory or integration call.'};
  report.afterIntegration=memories();for(const memory of report.afterIntegration){assert.equal(memory.status,'published');assert.ok(memory.reviewReceipt);}
  verifyOriginals();assertNoOtherDerived(node!.store.db);assertIdle();report.originals=originals();
}
async function questions(){
  const db=new DatabaseSync(join(snapshotVault,'mote.sqlite'),{readOnly:true});let baseline:Snapshot;try{baseline=protectedSnapshot(db);}finally{db.close();}
  for(const order of fixture.askOrder)for(const arm of order.arms){stage='ask';currentArm=arm;questionId=order.id;
    const vault=join(directory,'questions',order.id,arm,'vault');await mkdir(dirname(vault),{recursive:true,mode:0o700});
    const cloned=await cloneClosed(snapshotVault,vault),ablation=ablate(vault,arm),entry:Record<string,any>={questionId:order.id,arm,clone:cloned,ablation,status:'prepared'};report.arms.push(entry);
    await open(vault);verifyOriginals();assertNoOtherDerived(node!.store.db);assert.deepEqual(protectedSnapshot(node!.store.db),baseline,'Originals, Material, index, permission or source state differs from snapshot');
    const cards=await node!.featureServices.archiveReader.memories!({limit:100,includeHistory:true});if(arm==='archive-only')assert.equal(cards.items.length,0);
    entry.originalsSha256=sha256(JSON.stringify(originals()));assert.equal(entry.originalsSha256,sha256(JSON.stringify(report.originals)));
    const before=tableSnapshot(node!.store.db),oldMemoryEvents=node!.store.db.prepare("SELECT * FROM memory_events WHERE stream!='conversation' ORDER BY seq").all(),oldUsage=new Set(node!.store.db.prepare('SELECT id FROM model_usage').all().map(row=>String(row.id))),q=fixture.questions.find(q=>q.id===order.id)!;
    entry.request={question:q.text,timeZone:fixture.timeZone,deviceId:sourceId,before:fixture.contextTime};const at=Date.now();
    const answer=await request('POST','/api/query',entry.request);entry.durationMs=Date.now()-at;entry.answer=answer;entry.status='completed';
    if(report.queryConfiguration)assert.deepEqual(answer.configuration,report.queryConfiguration,'Model configuration differs between arms');else report.queryConfiguration=answer.configuration;
    const after=tableSnapshot(node!.store.db);entry.queryChangedTables=Object.keys(before).filter(name=>JSON.stringify(before[name])!==JSON.stringify(after[name]));
    for(const name of entry.queryChangedTables)assert.ok(queryWriteTables.has(name),`Ask modified archive/Memory table ${name}`);assert.equal(answer.usage.status,'completed');
    assert.deepEqual(node!.store.db.prepare("SELECT * FROM memory_events WHERE stream!='conversation' ORDER BY seq").all(),oldMemoryEvents,'Ask changed non-conversation lifecycle events');
    const receipts=node!.store.db.prepare('SELECT id,json FROM model_usage').all().filter(row=>!oldUsage.has(String(row.id))).map(row=>JSON.parse(String(row.json)) as UsageReceipt);entry.usage={total:usageTotals(receipts),receipts};
    await writeFile(join(dirname(vault),'answer.md'),answer.answer+'\n',{mode:0o600});await save();await close();
  }
}
async function blindPackage(){
  assert.equal(report.arms.length,fixture.questions.length*2,'Incomplete run cannot produce a paired blind package');
  const pairs=[],mapping=[];
  for(const question of fixture.questions){const entries=report.arms.filter((entry:any)=>entry.questionId===question.id);
    assert.equal(entries.length,2);assert.equal(new Set(entries.map((entry:any)=>entry.arm)).size,2);assert.ok(entries.every((entry:any)=>entry.status==='completed'&&entry.answer));
    if(randomInt(2))entries.reverse();
    const labels=entries.map(()=> 'response-'+randomBytes(8).toString('hex'));
    pairs.push({id:question.id,question:question.text,originals:report.originals,answers:entries.map((entry:any,index:number)=>({label:labels[index],answer:entry.answer.answer,citations:entry.answer.citations}))});
    mapping.push({id:question.id,labels:Object.fromEntries(entries.map((entry:any,index:number)=>[labels[index],entry.arm]))});
  }
  const answers=json({schema:'mote-memory-scenario-blind-answers@1',artifactMode:preflight?'stub-preflight':'live-model',questions:pairs}),key=json({schema:'mote-memory-scenario-blind-mapping@1',questions:mapping});
  await writeFile(join(directory,'blind-answers.json'),answers,{mode:0o600});await writeFile(join(directory,'blind-mapping.json'),key,{mode:0o600});
  report.blindReview={status:'prepared-awaiting-human-review',answers:'blind-answers.json',answersSha256:sha256(answers),mapping:'blind-mapping.json',mappingSha256:sha256(key),reviewerModelCalled:false,
    protocol:'Read only blind-answers.json with the frozen rubric, save quality judgments, then reveal blind-mapping.json and tool/usage records. Content may itself reveal an arm; anonymity is not guaranteed.'};
}

// No catalog lookup, Codex executable, HTTP transport or model factory is reachable in preflight.
const realFetch=globalThis.fetch;if(preflight||recoveryValidateOnly)globalThis.fetch=async()=>{throw Error('Offline validation forbids network requests');};
try{
  report.budgetPrecheck=await budgetPrecheck(limits.maximumOuterModelCalls);report.head=execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim();
  const paths=['scripts/test-memory-scenario-live.ts','package-lock.json','apps/server/src/app.ts','apps/server/src/memory-pipeline.ts','apps/server/src/memory-review.ts','apps/server/src/memory-integration.ts','apps/server/src/memory-integration-policy.ts','apps/server/src/memory-policy.ts','apps/server/src/evidence-reader.ts','apps/server/src/evidence-archive.ts','apps/server/src/features/capture.ts','apps/server/src/opening-memory.ts','packages/agent/dist/instructions.js','packages/agent/dist/task-context.js','packages/agent/dist/skills.js','packages/agent/dist/codex-agent.js','packages/agent/dist/codex-session.js','packages/agent/dist/bridge.js'];
  report.codeHashes=Object.fromEntries(await Promise.all(paths.map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
  await mkdir(join(directory,'code'),{mode:0o700});await writeFile(join(directory,'code','working-tree.patch'),execFileSync('git',['diff','--binary'],{cwd:repositoryRoot}),{mode:0o600});
  for(const path of paths)await cp(join(repositoryRoot,path),join(directory,'code',path.replaceAll('/','__')));
  await writeFile(join(directory,'wave-1.v1.json'),fixtureBytes,{mode:0o600});await writeFile(join(directory,'source-manifest.json'),manifestBytes,{mode:0o600});
  if(recovery){await writeFile(join(directory,'recovery-plan.json'),recoveryBytes!,{mode:0o600});await recoveryPrecheck();}
  if(!preflight&&!recoveryValidateOnly){const {codexModels}=await import('../apps/server/src/model-catalog.js');const catalog=await codexModels(undefined,{executable:process.env.MOTE_CODEX_BIN,home:process.env.MOTE_CODEX_HOME});report.catalog=catalog.items.find(item=>item.id===fixture.model.model);assert.ok(report.catalog?.reasoningEfforts?.includes(fixture.model.reasoningEffort));}
  report.status='running';await save();await mkdir(dirname(generationVault),{mode:0o700});
  if(recovery)await recoverGeneration();
  else{
    await open(generationVault);await seed();await close();
    const rawVault=join(directory,'ingress-snapshot','vault');await mkdir(dirname(rawVault),{mode:0o700});report.ingressSnapshot=await cloneClosed(generationVault,rawVault);
    const emptyControl=join(directory,'empty-memory-control','vault');await mkdir(dirname(emptyControl),{mode:0o700});await cloneClosed(rawVault,emptyControl);report.emptyMemoryAblation=ablate(emptyControl,'archive-only');assert.equal(report.emptyMemoryAblation.before.memories.rows,0);
    await open(generationVault);await generate();await close();
  }
  if(recoveryValidateOnly){report.status='recovery-source-validated-no-model';report.structuralChecksPassed=true;assert.equal(budget.count,0);}
  else{
  await mkdir(dirname(snapshotVault),{mode:0o700});report.snapshot=await cloneClosed(generationVault,snapshotVault);await chmod(join(snapshotVault,'mote.sqlite'),0o400);
  await writeFile(join(directory,'seed.json'),json({schema:'mote-memory-scenario-seed@1',artifactMode:preflight?'stub-preflight':'live-model',generationStatus:preflight?'stub-completed':'model-completed',semanticQualityAccepted:false,liveBaselineEligible:!preflight,personalDataUsed:false,heldOut:false,fixtureSha256:frozenWaveHash,records:report.records,memories:report.afterIntegration,snapshot:report.snapshot,maximumOuterCalls:limits.maximumOuterModelCalls,...(recovery?{recoveryPlanSha256:sha256(recoveryBytes!),priorOuterCalls:8}:{} )}),{mode:0o600});
  await questions();await blindPackage();assert.equal(sha256(await readFile(join(snapshotVault,'mote.sqlite'))),report.snapshot.cloneSha256,'Immutable snapshot changed');
  report.status=preflight?'preflight-structural-passed':'completed-awaiting-human-review';report.structuralChecksPassed=true;
  if(preflight){assert.equal(report.realModelCalls,0);assert.equal(report.stubCalls,recovery?6:preflightVariant==='nonempty-integration'?12:11);if(preflightVariant==='nonempty-integration')assert.equal(report.afterIntegration.length,report.beforeIntegration.length+1);}
  }
}catch(error){report.status='failed';report.failures.push({stage,questionId,arm:currentArm,message:message(error)});process.exitCode=1;}
finally{
  await close();globalThis.fetch=realFetch;await assertRecoverySourceUnchanged();report.finishedAt=new Date().toISOString();report.durationMs=Date.now()-started;report.outerCalls=budget.count;report.cumulativeOuterCalls=(recovery?.sourceOuterCalls??0)+budget.count;
  const runReceipts=[...newUsageById.values()];report.runUsage={ids:[...newUsageById.keys()],total:usageTotals(runReceipts),receipts:runReceipts,note:'Only receipts newly created in this run; inherited clone receipts excluded and IDs deduplicated.'};
  if(recoverySource){const all=new Map(recoverySource.receipts.map(receipt=>[receipt.id,receipt]));for(const [id,receipt] of newUsageById){assert.ok(!all.has(id),'New receipt reused a source receipt ID');all.set(id,receipt);}report.cumulativeUsage={total:usageTotals([...all.values()]),receiptIds:[...all.keys()],priorOuterCalls:8,newOuterCalls:budget.count,outerCalls:8+budget.count,oldFailedUsageMayBeIncomplete:!preflight,note:'Sum of distinct reported receipts, not an exact usage claim; original failed usage is preserved unchanged.'};}
  await save();progress('finished',{status:report.status,realModelCalls:report.realModelCalls,stubCalls:report.stubCalls,report:reportPath});
}
