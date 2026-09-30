/** Zero-provider preparation for the frozen, sealed heldout v2 replay.
 * Stage modes use the separately frozen first-batch adapter. Never prints corpus/question values.
 * MOTE_HELDOUT_OUTPUT=/new/external/path node --import tsx scripts/test-heldout-memory-replay.ts
 * Public output is counts/hashes/status only. Vaults and identity manifests are sealed.
 */
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {cp,mkdir,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,join,relative,resolve} from 'node:path';
import {backup,DatabaseSync} from 'node:sqlite';
import {sourceItemSchema} from '@mote/shared';
import type {QueryResult} from '@mote/shared';
import type {ContextReader,QueryInput} from '@mote/agent';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {sha256} from '../apps/server/src/store.js';
import {archiveHash,sourceReceiptId} from '../apps/server/src/source-archive.js';
import {defaultMemoryIntegrationRecipe} from '../apps/server/src/memory-integration-policy.js';
import {requestMemoryIntegration} from '../apps/server/src/memory-integration.js';

const base='/Users/utopiafar/Documents/Codex/mote-goal-2026-09-27';
const corpus=join(base,'heldout-corpus-v2'),evaluation=join(base,'heldout-eval-v2-1');
const freezes={corpus:'367c19ff948908151d4ae1fcd55e8f194bf314de4a02f3824d7c246ff6697e8c',evaluation:'c8fa7c2439da14d540a0877804da8c6fe6e1e5ae7cebe8ff65b3f8f95fc06f24'};
const recipes=[{id:'mote.personal-memory',version:'2'},{id:'mote.coding-memory',version:'2'}];
const token=randomBytes(32).toString('hex');
type Node=Awaited<ReturnType<typeof buildApp>>;
type Summary=Record<string,any>;
type Snapshot=Record<string,{rows:number;sha256:string}>;
class SafeFailure extends Error {constructor(readonly code:string){super(code);}}
function check(value:unknown,code:string):asserts value {if(!value)throw new SafeFailure(code);}
const equal=(a:unknown,b:unknown,code:string)=>check(JSON.stringify(a)===JSON.stringify(b),code);
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const quoted=(name:string)=>'"'+name.replaceAll('"','""')+'"';
const hashObject=(value:unknown)=>sha256(JSON.stringify(value));
let phase='initial',output='',node:Node|undefined,admissions=0;
const report:Summary={schema:'mote-heldout-replay-preparation@1',mode:'prepare-only',status:'running',realModelCalls:0,stubModelCalls:0,providerAdmissionAttempts:0,semanticContentExposed:false,liveReady:false,blockers:['Replay runner, technical gates and staged cumulative budget must be frozen; generated model work is already authorized by the active Goal.'],waves:[],checks:{},policy:{recipes,integrationRecipe:defaultMemoryIntegrationRecipe,batchCharacters:12000,selection:'Both recipes receive every new or revised Material; no semantic source dispatch.',checkpointReuse:'Unchanged Material revisions are not rescheduled. Changed sessions retain their normal complete Material input. Resume preserves the original job contextTime.',maximumAutomaticOuterRetries:0,perOuterCallTimeoutMs:300000}};
async function save(){if(output)await writeFile(join(output,'metadata.json'),json(report),{mode:0o600});}
function disjoint(a:string,b:string){const rel=relative(a,b);check(rel==='..'||rel.startsWith('../'),'paths_not_disjoint');const reverse=relative(b,a);check(reverse==='..'||reverse.startsWith('../'),'paths_not_disjoint');}
async function externalNew(value:string){const path=resolve(value),parent=await realpath(dirname(path));disjoint(repositoryRoot,path);disjoint(corpus,path);disjoint(evaluation,path);return join(parent,basename(path));}
async function parse(path:string):Promise<any>{try{return JSON.parse(await readFile(path,'utf8'));}catch{throw new SafeFailure('json_invalid');}}
async function verifyFreeze(directory:string,expected:string){
  const bytes=await readFile(join(directory,'freeze-manifest.json'));check(sha256(bytes)===expected,'freeze_hash_mismatch');
  const manifest=JSON.parse(bytes.toString('utf8'));check(manifest.fileHashes&&typeof manifest.fileHashes==='object','freeze_shape_invalid');
  const hashes:Record<string,string>={};
  for(const [file,expectedHash] of Object.entries(manifest.fileHashes)){
    check(typeof expectedHash==='string'&&/^[a-f0-9]{64}$/.test(expectedHash),'file_hash_invalid');
    check(!file.startsWith('/')&&!file.split('/').includes('..'),'freeze_path_invalid');
    const actual=sha256(await readFile(join(directory,file)));check(actual===expectedHash,'frozen_file_changed');hashes[file]=actual;
  }
  return {freezeSha256:expected,fileHashes:hashes};
}
async function lines(path:string){const text=await readFile(path,'utf8');check(text.endsWith('\n'),'ndjson_missing_final_lf');return text.slice(0,-1).split('\n').map(line=>({bytes:line+'\n',value:JSON.parse(line)}));}
function config(vault:string):Config{return {dataDir:vault,dataKey:undefined,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,maxStorageBytes:400_000_000,maxExportBytes:40_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
  model:'heldout-preparation-no-provider',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1',apiKey:'',allowUnauthenticatedLocal:true,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',diagnosticsEnabled:false,agentTraceEnabled:false,agentTimeoutMs:300000,memoryConcurrency:1,codexBin:'/nonexistent-heldout-no-provider',codexHome:join(output,'DO_NOT_OPEN','unused-codex-home')};}
async function open(vault:string,stub?:(reader:ContextReader,input:QueryInput)=>Promise<QueryResult>,semanticContextTime?:()=>string){
  check(!node,'node_already_open');
  node=await buildApp(config(vault),{backgroundWorker:false,semanticContextTime,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{if(stub)return stub(reader,input);admissions++;throw new SafeFailure('provider_admission_forbidden');}})});
  const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
  node.memoryRecipeSettings.configure({recipes});await node.app.ready();
}
async function close(){if(!node)return;const current=node;node=undefined;await current.app.close();}
async function request(method:'POST'|'PUT',url:string,payload:unknown){const response=await node!.app.inject({method,url,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2'},payload:payload as object});check(response.statusCode>=200&&response.statusCode<300,'source_api_status_'+response.statusCode);try{return response.json();}catch{throw new SafeFailure('source_api_response_invalid');}}
async function drain(){let sourceDone=false;for(let i=0;i<30;i++)if(await node!.sourcePipelines.tick(100)===0){sourceDone=true;break;}check(sourceDone,'source_pipeline_not_drained');let done=false;for(let i=0;i<30;i++)if(await node!.materialOrganizer.tick(100)===0){done=true;break;}check(done,'material_organizer_not_drained');for(let i=0;i<30;i++)if(node!.store.archive.aggregate(100)===0)break;check(Number(node!.store.db.prepare('SELECT count(*) n FROM context_dirty').get()!.n)===0,'exact_index_not_drained');}
function tables(db:DatabaseSync):Snapshot{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>{const name=String(row.name),rows=db.prepare(`SELECT * FROM ${quoted(name)}`).all().map(r=>JSON.stringify(r)).sort();return [name,{rows:rows.length,sha256:hashObject(rows)}];}));}
function sqliteCheck(db:DatabaseSync){check(db.prepare('PRAGMA quick_check').get()!.quick_check==='ok','sqlite_quick_check');check(db.prepare('PRAGMA foreign_key_check').all().length===0,'sqlite_foreign_key_check');}
async function absentOrEmpty(path:string){try{check((await stat(path)).size===0,'snapshot_not_closed');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
async function closed(vault:string){await absentOrEmpty(join(vault,'logs','central.lock'));await absentOrEmpty(join(vault,'mote.sqlite-wal'));}
async function cloneClosed(source:string,target:string){
  await closed(source);const before=sha256(await readFile(join(source,'mote.sqlite')));
  await cp(source,target,{recursive:true,errorOnExist:true,force:false,filter:path=>!['mote.sqlite','mote.sqlite-wal','mote.sqlite-shm','logs','token'].includes(basename(path))});
  const sourceDb=new DatabaseSync(join(source,'mote.sqlite'),{readOnly:true});try{sqliteCheck(sourceDb);await backup(sourceDb,join(target,'mote.sqlite'));}finally{sourceDb.close();}
  const targetDb=new DatabaseSync(join(target,'mote.sqlite'));try{targetDb.exec('PRAGMA journal_mode=DELETE');sqliteCheck(targetDb);}finally{targetDb.close();}
  await closed(source);check(sha256(await readFile(join(source,'mote.sqlite')))===before,'backup_mutated_source');return {method:'closed-node-sqlite-backup',sourceSha256:before,targetSha256:sha256(await readFile(join(target,'mote.sqlite')))};
}
// Explicit cache classification. Any unknown semantic artifact is a blocker, not an implicit allowlist.
const ablated=['memories','memory_jobs','memory_checkpoints','memory_extraction_drafts','memory_lifecycle_state','memory_events'];
const allowed=new Set([...ablated,'memory_catalog','memory_scopes','memory_dependencies','memory_artifact_dependencies','memory_batches','memory_batch_dependencies','memory_job_counts','memory_input_plans','memory_input_authorizations','memory_extraction_draft_dependencies','storage_ledger','memories_fts','memories_fts_data','memories_fts_idx','memories_fts_content','memories_fts_docsize','memories_fts_config']);
const emptySemantic=['conversations','conversation_turns','working_memories','query_runs','insights','insight_runs','memory_deletions','memory_deletion_dependencies','artifact_dependencies','artifact_material_inputs'];
/** Compare deterministic segments against a fresh production reconstruction in a disposable clone.
 * No prose parser: exact source bytes, processor identity, metadata, inputs and FTS must match.
 * The generatedAt/ready journal timestamps alone are nondeterministic and not semantic content.
 */
function exactIndex(db:DatabaseSync){
  for(const row of db.prepare('SELECT json FROM context_artifacts').all()){
    const artifact=JSON.parse(String(row.json));check(artifact.kind==='segment'&&artifact.processor==='mote.exact-segment'&&artifact.processorVersion==='1'&&artifact.metadata?.semanticGrouping===false,'unclassified_semantic_artifact');
  }
  return Object.fromEntries(['context_artifacts','artifact_inputs','context_observations','context_contents','artifacts_fts'].map(name=>{
    const rows=db.prepare(`SELECT * FROM ${quoted(name)}`).all().map(row=>{if(name!=='context_artifacts')return row;const value=JSON.parse(String(row.json));delete value.generatedAt;return {...row,json:JSON.stringify(value)};}).map(row=>JSON.stringify(row)).sort();return [name,{rows:rows.length,sha256:hashObject(rows)}];
  }));
}
function ablateClone(vault:string,remove:boolean){const db=new DatabaseSync(join(vault,'mote.sqlite'));try{
  db.exec('PRAGMA foreign_keys=ON');const before=tables(db);for(const name of emptySemantic)check(!before[name]||before[name].rows===0,'unexpected_semantic_cache');exactIndex(db);
  if(remove){db.exec('BEGIN IMMEDIATE');try{for(const name of ablated)if(before[name])db.exec(`DELETE FROM ${quoted(name)}`);db.exec('COMMIT');}catch{db.exec('ROLLBACK');throw new SafeFailure('ablation_transaction_failed');}}
  const after=tables(db),changed=Object.keys(before).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]));check(changed.every(name=>remove&&allowed.has(name)),'ablation_changed_protected_table');sqliteCheck(db);
  return {protectedHash:hashObject(Object.fromEntries(Object.entries(after).filter(([name])=>!allowed.has(name)))),protectedTables:Object.keys(after).filter(name=>!allowed.has(name)).length,changedTables:changed,index:exactIndex(db)};
}finally{db.close();}}
/** Independent, literal plumbing fixture. It never loads heldout text into a model stub. */
async function clockProbe(){
  const expected='2025-12-31T23:59:59+08:00',integrationExpected='2026-01-31T23:59:59+08:00';
  const vault=join(output,'DO_NOT_OPEN','clock-probe'),calls:Summary[]=[];let stage:'extraction'|'integration'|'ask'='extraction',proofIds:string[]=[],parents:any[]=[],target:any;
  const probe:Summary={fixture:'independent-literal-clock-plumbing@1',heldoutInputsUsed:false,maximumStubCalls:5,calls,expectedExtractionTime:expected,expectedIntegrationAndAskTime:integrationExpected};
  const stub=async(reader:ContextReader,input:QueryInput):Promise<QueryResult>=>{
    check(calls.length<5,'clock_stub_budget_exhausted');const expectedTime=stage==='extraction'?expected:integrationExpected;
    const call:Summary={stage,phase:input.traceContext?.phase??'ask',inputContextTime:input.contextTime??null,matchesExpected:input.contextTime===expectedTime};calls.push(call);report.stubModelCalls++;
    const result={runId:'clock-stub-'+randomUUID(),trace:[],citations:[] as QueryResult['citations']};
    if(stage==='ask'){
      check(!input.conversation,'clock_stub_conversation_not_fresh');const defaults=await reader.memories!({limit:100}),historical=await reader.memories!({limit:100,asOf:expected});
      const catalog=await reader.catalog!({path:'/context/memory',limit:100}) as {entries:{id:string}[]};
      call.defaultMemoryCount=defaults.items.length;call.historicalMemoryCount=historical.items.length;call.openingMemoryCount=input.openingMemories?.length??0;call.catalogMemoryCount=catalog.entries.length;
      equal(catalog.entries.map(entry=>entry.id).sort(),defaults.items.map((entry:any)=>entry.id).sort(),'clock_catalog_default_mismatch');equal((input.openingMemories??[]).map(entry=>entry.id).sort(),defaults.items.map((entry:any)=>entry.id).sort(),'clock_opening_default_mismatch');
      return {...result,answer:'Independent clock plumbing stub; no semantic answer was generated.'};
    }
    const evidence=await reader.evidence({ids:proofIds});check(evidence.length===1,'clock_stub_original_missing');const original=evidence[0];
    const common={domain:'personal',uncertainty:'Independent mechanical fixture only.',admission:{layer:'memory',reason:'Clock plumbing fixture',scope:'Independent generated clock test',attribution:'observed'},evidenceIds:proofIds,evidence:[{id:original.id,quote:original.ocrText}]};
    const memories=stage==='extraction'?[{...common,title:'Expiry fixture',statement:'Expiry clock fixture ['+original.id+']',validUntil:'2026-01-01T00:00:00+08:00'},{...common,title:'Relation fixture',statement:'Relation clock fixture ['+original.id+']'}]:[{...common,title:'Replacement fixture',statement:'Replacement clock fixture ['+original.id+']',relatedMemoryIds:parents.map(parent=>parent.id),relations:[{kind:'supersedes',memoryId:target.id,fingerprint:target.fingerprint,version:target.version}]}];
    return {...result,answer:JSON.stringify({memories}),citations:[{id:original.id,capturedAt:original.capturedAt,appName:original.appName,excerpt:original.ocrText}]};
  };
  const semanticTime=()=>stage==='extraction'?expected:integrationExpected;
  await open(vault,stub,semanticTime);await request('POST','/api/sources',{id:'independent-clock-source',name:'Independent clock plumbing fixture',kind:'custom',deviceId:'independent-clock-device',platform:'import',retention:'archive'});
  await request('PUT','/api/sources/independent-clock-source/items',{externalId:'independent-clock-original',revision:'1',kind:'message',layer:'original',observedAt:'2025-12-01T12:00:00+08:00',text:'Independent generated fixture for expiry, replacement, and host time plumbing.',document:{contentRole:'authored',recordedAt:'2025-12-01T12:00:00+08:00',timeBasis:'recorded'}});await drain();
  const material=node!.store.db.prepare('SELECT id FROM material_heads WHERE retired=0').get();check(material,'clock_material_missing');proofIds=node!.materials.evidenceIds(node!.materials.get(String(material.id))!.ref);
  const input={evidenceIds:proofIds,recipes:[recipes[0]],contextTime:expected,timeZone:'Asia/Shanghai',batchCharacters:12000};const job=node!.memoryPipeline.create(input);check(job.totalBatches===1,'clock_batch_count');check((await node!.memoryPipeline.run(job.id)).status==='completed','clock_job_failed');
  parents=node!.store.db.prepare('SELECT json FROM memories').all().map(row=>JSON.parse(String(row.json)));check(parents.length===2,'clock_card_count');check(parents.every(parent=>parent.reviewReceipt?.contextTime===expected),'clock_extraction_receipt_mismatch');
  target=parents.find(parent=>parent.validUntil===undefined);check(target,'clock_relation_target_missing');
  probe.extraction={modelInputsMatch:calls.every(call=>call.matchesExpected),reviewReceiptsMatch:true,defaultValidityCount:node!.memories.page().items.length,explicitHistoricalValidityCount:node!.memories.page({asOf:expected}).items.length,receiptCheckedAtUsesWallTime:parents.every(parent=>Date.parse(parent.reviewReceipt.checkedAt)>Date.parse(integrationExpected))};
  const reused=node!.memoryPipeline.create(input);check(reused.status==='completed'&&reused.totalBatches===0&&calls.length===2,'same_clock_checkpoint_not_reused');probe.sameClockCompletedCheckpointReuse=true;
  stage='integration';const integration=requestMemoryIntegration({recipe:defaultMemoryIntegrationRecipe,memoryIds:parents.map(parent=>parent.id)},{lifecycle:node!.lifecycle,memories:node!.memories,pipeline:node!.memoryPipeline});await node!.lifecycle.tick();
  const state=node!.lifecycle.view().extensions.find(extension=>extension.id==='consolidation');check(!state?.active&&!state?.error,'clock_integration_failed');
  const cards=node!.store.db.prepare('SELECT json FROM memories').all().map(row=>JSON.parse(String(row.json))),replacement=cards.find(card=>card.tier==='consolidated'),old=cards.find(card=>card.id===target.id);check(replacement&&old?.supersededBy===replacement.id,'clock_relation_not_applied');
  probe.integration={windowIdHash:sha256(integration.id),modelInputsMatch:calls.filter(call=>call.stage==='integration').every(call=>call.matchesExpected),reviewReceiptContextTime:replacement.reviewReceipt?.contextTime??null,reviewReceiptMatchesExpected:replacement.reviewReceipt?.contextTime===integrationExpected,supersededAt:old.supersededAt,supersededAtMatchesExpected:Date.parse(old.supersededAt)===Date.parse(integrationExpected),oldStillActiveAtReplayTime:node!.memories.page({asOf:integrationExpected}).items.some(card=>card.id===old.id)};
  await close();await closed(vault);const left=join(output,'DO_NOT_OPEN','clock-ablation-1'),right=join(output,'DO_NOT_OPEN','clock-ablation-2');await cloneClosed(vault,left);await cloneClosed(vault,right);const a=ablateClone(left,true),b=ablateClone(right,false);equal(a.protectedHash,b.protectedHash,'clock_nonempty_ablation_protected_mismatch');
  const counts=[left,right].map(path=>{const db=new DatabaseSync(join(path,'mote.sqlite'),{readOnly:true});try{return Number(db.prepare('SELECT count(*) n FROM memories').get()!.n);}finally{db.close();}});equal(counts,[0,3],'clock_nonempty_ablation_card_counts');probe.nonemptyAblation={removedCardCount:3,protectedTableCount:a.protectedTables,protectedHash:a.protectedHash,passed:true};
  stage='ask';await open(vault,stub,semanticTime);await request('POST','/api/query',{question:'Inspect this independent clock plumbing fixture.',before:integrationExpected,timeZone:'Asia/Shanghai'});await close();await closed(vault);
  const db=new DatabaseSync(join(vault,'mote.sqlite'),{readOnly:true});try{probe.terminalUsage={readAfterAppClose:true,receipts:Number(db.prepare('SELECT count(*) n FROM model_usage').get()!.n),realProviderCalls:0,stubCalls:calls.length};}finally{db.close();}
  check(Number(calls.length)===5,'clock_stub_call_count');probe.consistent=calls.every(call=>call.matchesExpected)&&probe.integration.reviewReceiptMatchesExpected&&probe.integration.supersededAtMatchesExpected&&!probe.integration.oldStillActiveAtReplayTime;
  check(probe.consistent,'trusted_semantic_clock_alignment_failed');probe.status='passed';probe.result='Generation/review receipts, Ask opening/catalog/default memories and fallback supersession share the trusted semantic instant; explicit historical reads remain available and wall-clock receipts are unchanged.';return probe;
}
async function duplicateProbe(){
  const vault=join(output,'DO_NOT_OPEN','duplicate-probe');await open(vault);
  await request('POST','/api/sources',{id:'independent-coding-source',name:'Independent coding transport fixture',kind:'coding-agent',deviceId:'independent-coding-device',platform:'import',retention:'archive'});
  const item=(id:string,role:'user'|'assistant',time:string)=>({externalId:id,revision:'1',observedAt:time,kind:'message',layer:'original',text:'Independent generated transport fixture '+id,document:{contentRole:'transcript',recordedAt:time,timeBasis:'recorded',coding:{version:1,provider:'codex',sessionId:'independent-session',projectKey:'independent-project',eventId:id,role,part:0,parts:1}}});
  const first=item('event-a','user','2026-01-01T10:00:00+08:00'),second=item('event-b','assistant','2026-01-01T10:01:00+08:00');
  const snapshot=()=>{const head=node!.store.db.prepare("SELECT id,revision,sequence FROM material_heads WHERE kind='mote.coding-session' AND retired=0").get();check(head,'duplicate_probe_head_missing');const m=node!.materials.get(String(head.id))!,input=node!.materials.input(m.ref,['conversation']);check(input?.ready,'duplicate_probe_material_unready');const db=node!.store.db;return {revision:String(head.revision),sequence:Number(head.sequence),inputFingerprint:input.fingerprint,conversationRevision:m.artifacts?.find(artifact=>artifact.key==='conversation')?.revision,rawVersionsHash:hashObject(db.prepare('SELECT * FROM source_archive_versions ORDER BY source_id,version_key').all()),rawHeadCount:Number(db.prepare('SELECT count(*) n FROM source_archive_heads').get()!.n),memoryGrants:Number(db.prepare('SELECT count(*) n FROM memory_input_authorizations').get()!.n)};};
  const ackA=await request('PUT','/api/sources/independent-coding-source/items',first);await drain();const initial=snapshot();const ackB=await request('PUT','/api/sources/independent-coding-source/items',second);await drain();const appended=snapshot();const ackDuplicate=await request('PUT','/api/sources/independent-coding-source/items',first);await drain();const repeated=snapshot();
  check(ackA.id!==ackB.id&&ackDuplicate.id===ackA.id&&ackDuplicate.duplicate===true,'duplicate_probe_receipt_identity');check(initial.revision!==appended.revision&&appended.rawHeadCount===2,'duplicate_probe_new_event_not_appended');check(appended.rawVersionsHash===repeated.rawVersionsHash&&repeated.rawHeadCount===2,'duplicate_probe_raw_changed');
  await close();return {schema:'independent-coding-exact-retransmission-probe@1',heldoutInputsUsed:false,realModelCalls:0,stubModelCalls:0,sourceDeliveries:3,uniqueRecords:2,exactDuplicateReceipt:true,newEventChangedMaterial:true,rawVersionsUnchangedAfterDuplicate:true,materialRevisionUnchangedAfterDuplicate:appended.revision===repeated.revision,inputFingerprintUnchangedAfterDuplicate:appended.inputFingerprint===repeated.inputFingerprint,initial,appended,repeated,status:appended.revision===repeated.revision?'passed':'reproduced-product-gap'};
}
async function main(){
  const mode=process.env.MOTE_HELDOUT_MODE??'prepare';check(['prepare','clock-probe','duplicate-probe'].includes(mode),'live_mode_forbidden');report.mode=mode;check(process.env.MOTE_HELDOUT_OUTPUT,'output_required');
  output=await externalNew(process.env.MOTE_HELDOUT_OUTPUT);await mkdir(output,{mode:0o700});await mkdir(join(output,'DO_NOT_OPEN'),{mode:0o700});
  await writeFile(join(output,'DO_NOT_OPEN','README.txt'),'SEALED: contains heldout source text, opaque identities and future answers. Do not inspect during preparation or blind evaluation. Public metadata is in the parent directory.\n',{mode:0o600});
  report.startedAt=new Date().toISOString();report.revision=execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim();
  report.codeHashes=Object.fromEntries(await Promise.all(['scripts/test-heldout-memory-replay.ts','apps/server/src/app.ts','apps/server/src/memory-pipeline.ts','apps/server/src/memory-integration.ts','apps/server/src/memory-lifecycle.ts','apps/server/src/memory.ts','apps/server/src/opening-memory.ts','apps/server/src/evidence-reader.ts','apps/server/src/source-pipelines.ts','apps/server/src/coding-source-plugin.ts','apps/server/src/materials.ts','packages/agent/dist/bridge.js','packages/agent/dist/codex-session.js'].map(async file=>[file,sha256(await readFile(join(repositoryRoot,file)))])));
  if(mode!=='prepare'){phase=mode;report.probe=mode==='clock-probe'?await clockProbe():await duplicateProbe();report.status=report.probe.status==='passed'?'prepared':'prepared-product-gap';report.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({schema:report.schema,status:report.status,output,realModelCalls:0,stubModelCalls:report.stubModelCalls,semanticContentExposed:false}));return;}
  phase='freeze';report.inputs={corpus:{package:'heldout-corpus-v2',...await verifyFreeze(corpus,freezes.corpus)},evaluation:{package:'heldout-eval-v2-1',...await verifyFreeze(evaluation,freezes.evaluation)}};
  // Parse locally; never print values or exception details from these sealed files.
  const transport=await parse(join(corpus,'transport-manifest.json')),records=await lines(join(corpus,'source-records.ndjson')),items=await lines(join(corpus,'source-items.ndjson'));
  const questions=await parse(join(evaluation,'questions.json')),availability=await parse(join(evaluation,'checkpoint-availability.json'));
  equal([transport.deliveries.length,records.length,items.length,questions.questions.length,availability.checkpoints.length],[120,120,120,8,6],'fixed_counts_mismatch');
  const seenRecords=new Map<string,any>(),seenDeliveries=new Map<string,any>(),projects=new Set<string>(),sessions=new Set<string>();let duplicates=0,late=0;
  for(const [index,delivery] of transport.deliveries.entries()){
    check(delivery.ingestionOrder===index+1&&delivery.sourceRecordLine>=1&&delivery.sourceItemLine>=1,'transport_order_invalid');
    const raw=records[delivery.sourceRecordLine-1],item=items[delivery.sourceItemLine-1];check(raw&&item,'transport_line_invalid');check(sha256(raw.bytes)===delivery.sourceRecordSha256&&sha256(item.bytes)===delivery.sourceItemSha256,'transport_line_hash_invalid');
    check(sourceItemSchema.safeParse(item.value).success,'source_item_schema_invalid');check(raw.value.sourceRecordId===delivery.sourceRecordId&&item.value.externalId==='heldout-v2:'+delivery.sourceRecordId,'transport_identity_mismatch');
    check(item.value.document?.recordedAt===raw.value.recordedAt&&item.value.observedAt===raw.value.observedAt&&item.value.text===raw.value.text&&item.value.document?.timeBasis==='recorded','source_item_projection_mismatch');
    for(const key of ['wave','availableAfter','eventGroups','ingestionOrder','receivedAt','importedAt'])check(!Object.hasOwn(item.value,key),'orchestration_field_in_source');
    if(delivery.aliasOf){const prior=seenDeliveries.get(delivery.aliasOf);check(prior&&!delivery.isNewEvidence&&prior.sourceRecordSha256===delivery.sourceRecordSha256&&prior.sourceItemSha256===delivery.sourceItemSha256,'retransmit_not_exact');duplicates++;}
    else{check(!seenRecords.has(delivery.sourceRecordId)&&delivery.isNewEvidence,'unexpected_record_reuse');seenRecords.set(delivery.sourceRecordId,delivery);}
    if(delivery.lateFirstDelivery){check(!delivery.aliasOf&&Date.parse(raw.value.recordedAt)<Date.parse(raw.value.observedAt),'late_record_invalid');late++;}
    if(item.value.document?.coding){check(raw.value.coding&&typeof raw.value.coding.project==='string'&&typeof raw.value.coding.session==='string','coding_provenance_missing');projects.add(item.value.document.coding.projectKey);sessions.add(item.value.document.coding.sessionId);}
    seenDeliveries.set(delivery.deliveryId,delivery);
  }
  const codingDeliveries=items.filter(item=>Boolean(item.value.document?.coding)).length;equal([seenRecords.size,duplicates,late,projects.size,sessions.size,codingDeliveries],[114,6,4,3,8,40],'corpus_structure_mismatch');
  for(const checkpoint of availability.checkpoints){const expected=transport.deliveries.filter((d:any)=>d.wave<=checkpoint.checkpointWave);equal(expected.map((d:any)=>d.deliveryId),checkpoint.deliveryIds,'checkpoint_delivery_mismatch');equal([...new Set(expected.map((d:any)=>d.sourceRecordId))].sort(),[...checkpoint.availableSourceRecordIds].sort(),'checkpoint_record_mismatch');check(expected.every((d:any)=>Date.parse(d.availableAfter)<=Date.parse(checkpoint.contextTime)),'checkpoint_precedes_availability');}
  const questionCounts:Record<number,number>={};for(const question of questions.questions){const checkpoint=availability.checkpoints.find((c:any)=>c.checkpointWave===question.checkpointWave);check(checkpoint&&checkpoint.contextTime===question.contextTime,'question_checkpoint_time_mismatch');questionCounts[question.checkpointWave]=(questionCounts[question.checkpointWave]??0)+1;}
  equal(questionCounts,{2:1,3:1,4:1,5:1,6:4},'question_wave_counts');report.counts={deliveries:120,uniqueRecords:114,noteDeliveries:120-codingDeliveries,codingDeliveries,retransmissions:duplicates,lateNewRecords:late,projects:projects.size,sessions:sessions.size,sources:transport.sources.length,questions:8,questionCounts};report.checks.freezeAndSchema=true;
  const vault=join(output,'DO_NOT_OPEN','planning-vault'),runtime:Summary={deliveries:[],waveJobs:[],checkpoints:[]};const acks=new Map<string,string>(),previousMaterials=new Map<string,string>();let totalBatches=0,totalUnchanged=0,totalContinued=0,withinWaveCodingRevisions=0;
  phase='source-import';await open(vault);for(const source of transport.sources)await request('POST','/api/sources',source);
  report.recipeBindingHashes=recipes.map(recipe=>({recipe,bindingSha256:hashObject(node!.memoryStrategies.resolve(recipe).binding)}));
  for(let wave=1;wave<=6;wave++){
    phase='wave-'+wave;const deliveries=transport.deliveries.filter((d:any)=>d.wave===wave),checkpoint=availability.checkpoints.find((c:any)=>c.checkpointWave===wave);check(checkpoint,'wave_checkpoint_missing');const waveStarted=Date.now();
    for(const delivery of deliveries){const item=items[delivery.sourceItemLine-1].value,before=Date.now(),ack=await request('PUT','/api/sources/'+encodeURIComponent(delivery.sourceId)+'/items',item);
      const source=node!.sources.getSource(delivery.sourceId),archived=node!.sourcePipelines.select(source)?.storage==='archive',capture=archived?undefined:node!.store.evidence([ack.id])[0];
      if(archived){const original=node!.sourcePipelines.archive.readVersion(delivery.sourceId,archiveHash([item.externalId,item.revision]));check(original,'archive_original_missing');equal(original,sourceItemSchema.parse(item),'archive_original_changed');check(ack.id===sourceReceiptId(delivery.sourceId,item),'archive_receipt_identity_mismatch');}
      else{check(capture,'capture_missing');equal(capture.ocrText,item.text,'capture_text_changed');check(Date.parse(capture.capturedAt)===Date.parse(item.observedAt)&&capture.provenance?.document?.recordedAt===item.document.recordedAt,'capture_source_time_changed');}
      if(delivery.aliasOf){check(ack.duplicate===true&&ack.id===acks.get(delivery.aliasOf),'replay_identity_changed');}else{check(!ack.duplicate,'new_delivery_reported_duplicate');if(capture)check(Date.parse(capture.receivedAt)>=before&&Date.parse(capture.receivedAt)<=Date.now(),'received_time_not_real');}
      acks.set(delivery.deliveryId,ack.id);runtime.deliveries.push({deliveryId:delivery.deliveryId,receiptId:ack.id,storage:archived?'archive':'record',receivedAt:capture?.receivedAt,receiptWallInterval:[before,Date.now()],duplicate:ack.duplicate===true});
      if(archived){const beforeHeads=new Map(node!.store.db.prepare("SELECT id,revision FROM material_heads WHERE kind='mote.coding-session' AND retired=0").all().map(row=>[String(row.id),String(row.revision)]));await drain();const afterHeads=node!.store.db.prepare("SELECT id,revision FROM material_heads WHERE kind='mote.coding-session' AND retired=0").all();const revised=afterHeads.filter(row=>beforeHeads.has(String(row.id))&&beforeHeads.get(String(row.id))!==row.revision);if(delivery.aliasOf)check(revised.length===0,'archive_retransmit_rebuilt_material');else withinWaveCodingRevisions+=revised.length;}
    }
    await drain();const all=node!.store.db.prepare('SELECT id,revision,kind FROM material_heads WHERE retired=0 ORDER BY id').all(),changed=all.filter(row=>previousMaterials.get(String(row.id))!==row.revision),continued=changed.filter(row=>previousMaterials.has(String(row.id))),unchanged=all.length-changed.length;totalUnchanged+=unchanged;totalContinued+=continued.length;
    check(continued.every(row=>row.kind==='mote.coding-session'),'unexpected_material_rewrite');
    const ids=[...new Set(changed.flatMap(row=>node!.materials.evidenceIds(node!.materials.get(String(row.id))!.ref)))];check(ids.length>0,'wave_has_no_input');
    const job=node!.memoryPipeline.create({evidenceIds:ids,recipes,contextTime:checkpoint.contextTime,timeZone:'Asia/Shanghai',batchCharacters:12000});
    check(job.contextTime===checkpoint.contextTime&&job.status==='queued','planned_job_invalid');check(job.batches.every(batch=>batch.status==='pending'&&batch.attempts===0),'planned_job_started');
    const batches=node!.store.db.prepare('SELECT json FROM memory_batches WHERE job_id=? ORDER BY idx').all(job.id).map(row=>JSON.parse(String(row.json)));const perRecipe=recipes.map(recipe=>({recipe,batches:batches.filter(batch=>batch.strategy?.recipe.id===recipe.id).length}));check(perRecipe.every(row=>row.batches>0),'recipe_not_planned');
    runtime.waveJobs.push({wave,jobId:job.id,contextTime:checkpoint.contextTime,materialRefs:changed.map(row=>node!.materials.get(String(row.id))!.ref),batchKeys:batches.map(batch=>batch.chunks.map((chunk:any)=>chunk.key))});
    // Planning must never execute. Cancelling planning-only jobs cannot manufacture checkpoints.
    node!.memoryPipeline.cancel(job.id);check(Number(node!.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n)===0,'planning_created_checkpoint');totalBatches+=job.totalBatches;
    const snapshot=tables(node!.store.db);runtime.checkpoints.push({wave,contextTime:checkpoint.contextTime,tableHashes:snapshot});
    report.waves.push({wave,contextTime:checkpoint.contextTime,deliveries:deliveries.length,cumulativeUniqueReceipts:new Set([...acks.values()]).size,currentMaterials:all.length,newMaterials:changed.length-continued.length,revisedCodingMaterials:continued.length,unchangedMaterialsReused:unchanged,selectedEvidence:ids.length,jobs:1,batches:job.totalBatches,perRecipe,questionCount:questionCounts[wave]??0,extractionOuterCallUpperBound:2*job.totalBatches,integrationOuterCallCap:4,askOuterCalls:2*(questionCounts[wave]??0),sourceImportWallMs:Date.now()-waveStarted});
    for(const row of all)previousMaterials.set(String(row.id),String(row.revision));check(admissions===0,'unexpected_agent_admission');await save();
  }
  report.budget={extractionJobs:6,extractionBatches:totalBatches,extractionOuterCallUpperBound:2*totalBatches,integrationOuterCallCap:24,askOuterCalls:16,totalOuterCallUpperBound:2*totalBatches+24+16,outerMeaning:'One agent query; provider repair/internal turns can exceed this count and must be measured separately.',emptyCandidates:'Empty extraction/integration skips independent review, so actual calls may be lower.',integrationBound:'At most one explicit integration window per wave, 2 domains × generation/review; more than 50 eligible inputs is a stop/plan-revision condition, never silent truncation.',deletionReview:'No owner-deletion workflow in this frozen corpus; any extra deletion review is forbidden by the stage budget.',wallUpperBoundMs:(2*totalBatches+24+16)*300000};
  check(withinWaveCodingRevisions===30,'coding_continuation_revision_count');report.checks={...report.checks,realReceivedAt:'Record storage receivedAt checked against wall interval; archive-only coding preserves raw source values and records API receipt wall interval without inventing a receivedAt field.',duplicateIdentity:true,normalSourceApi:true,orchestrationMetadataExcluded:true,codingMaterialCrossWaveContinuation:totalContinued,codingMaterialWithinWaveRevisions:withinWaveCodingRevisions,unchangedMaterialSchedulingReuse:totalUnchanged,clockAlignment:'blocked; not falsely reported as passed'};
  await close();await closed(vault);const readOnly=new DatabaseSync(join(vault,'mote.sqlite'),{readOnly:true});try{check(Number(readOnly.prepare('SELECT count(*) n FROM model_usage').get()!.n)===0,'planning_usage_not_empty');report.terminalUsage={readAfterAppClose:true,newReceipts:0,inheritedReceipts:0,realCalls:0};sqliteCheck(readOnly);}finally{readOnly.close();}
  await writeFile(join(output,'DO_NOT_OPEN','runtime.json'),json(runtime),{mode:0o600});
  phase='snapshot-ablation';const left=join(output,'DO_NOT_OPEN','clone-1'),right=join(output,'DO_NOT_OPEN','clone-2');report.backups=[await cloneClosed(vault,left),await cloneClosed(vault,right)];const first=ablateClone(left,true),second=ablateClone(right,false);equal(first.protectedHash,second.protectedHash,'arms_protected_hash_mismatch');equal(first.index,second.index,'arms_original_index_mismatch');
  report.ablation={protectedTableCount:first.protectedTables,protectedHash:first.protectedHash,sharedIndexHashes:first.index,changedTables:first.changedTables,coverage:'Planning-only empty Memory state plus cancelled jobs; nonempty semantic ablation is not yet validated.'};
  // Fresh production aggregation in an isolated clone validates every retained deterministic index.
  phase='exact-index-reconstruction';await open(right);const beforeIndex=exactIndex(node!.store.db);node!.store.db.exec('DELETE FROM context_artifacts; INSERT INTO context_dirty(group_key) SELECT DISTINCT group_key FROM context_observations WHERE 1 ON CONFLICT(group_key) DO UPDATE SET generation=generation+1');await drain();equal(exactIndex(node!.store.db),beforeIndex,'exact_index_reconstruction_mismatch');await close();
  check(admissions===0,'unexpected_agent_admission');report.checks.exactIndexReconstructedFromOriginals=true;report.providerAdmissionAttempts=admissions;report.status='prepared-clock-blocked';report.finishedAt=new Date().toISOString();await save();
  console.log(JSON.stringify({schema:report.schema,status:report.status,output,counts:report.counts,budget:report.budget,realModelCalls:0,stubModelCalls:report.stubModelCalls,semanticContentExposed:false}));
}
export {base,corpus,evaluation,freezes,recipes,SafeFailure,check,equal,json,hashObject,externalNew,parse,verifyFreeze,lines,config,tables,closed,cloneClosed,ablateClone,exactIndex,sqliteCheck};
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)void (async()=>{try{
  if(['stage-ask-recovery-freeze','stage-normal-review-freeze','stage-normal-freeze','stage-freeze','stage-recovery-freeze','stage-resume-freeze','stage-ingress-freeze','stage-extract-freeze','stage-integration-freeze','stage-integration-live','stage-ask-freeze','stage-ask-live','stage-live'].includes(process.env.MOTE_HELDOUT_MODE??'')){const stage=await import('./test-heldout-memory-replay-stage.js');await stage.stageMain();}
  else await main();
}catch(error){try{await close();}catch{}report.status='failed';report.failure={phase,code:error instanceof SafeFailure?error.code:'internal_error_details_sealed'};report.providerAdmissionAttempts=admissions;await save();console.error(JSON.stringify({status:'failed',phase,code:report.failure.code,output,realModelCalls:['stage-live','stage-integration-live','stage-ask-live'].includes(process.env.MOTE_HELDOUT_MODE??'')?'unknown':0,ledger:process.env.MOTE_HELDOUT_LEDGER??null,semanticContentExposed:false}));process.exitCode=1;}})();
