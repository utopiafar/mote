/** Opt-in generated live Memory journey. Never reads or changes a production vault.
 * MOTE_MEMORY_CONTEXT_LIVE=1 node --import tsx apps/server/test/live/memory-context-reading.ts
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {appendFile,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAgent,type AgentAnswer,type AgentTraceEvent,type ContextReader,type QueryInput} from '../../../../packages/agent/src/index.js';
import {ProviderFailure,type QueryResult,type TokenUsage} from '@mote/shared';
import {Store,sha256} from '../../src/store.js';
import {SourceStore} from '../../src/sources.js';
import {ImportAttributionStore} from '../../src/import-attribution.js';
import {MaterialStore,materialId} from '../../src/materials.js';
import {MemoryStore} from '../../src/memory.js';
import {MemoryPipeline} from '../../src/memory-pipeline.js';
import {MemoryStrategies} from '../../src/memory-strategies.js';
import {reviewMemory} from '../../src/memory-review.js';
import {codexModels} from '../../src/model-catalog.js';

assert.equal(process.env.MOTE_MEMORY_CONTEXT_LIVE,'1','Live models require the explicit MOTE_MEMORY_CONTEXT_LIVE=1 opt-in');
const repository=resolve(fileURLToPath(new URL('../../../../',import.meta.url)));
const model='gpt-6.1-sol',reasoningEffort='high',protocol='codex-app-server';
const maximumQueries=8,maximumModelTurns=8,agentDeadlineMs=300000;
const directory=join(repository,'.mote','validation','memory-context-reading-live',new Date().toISOString().replaceAll(':','-')+'-'+randomUUID().slice(0,8));
execFileSync('git',['check-ignore',directory],{cwd:repository,stdio:'pipe'});
await mkdir(directory,{recursive:true,mode:0o700});
const temporary=await mkdtemp(join(tmpdir(),'mote-memory-context-live-'));
const header='Recorded on 2025-02-03. I am alone, recording my personal diary and reviewing my photographs from 2024-01-01 through 2024-12-31. ';
const guest='My guest Vera said: “I plan to buy a red camera, but I have not ordered or paid for it.” ';
const repair='On April 20, I replaced the dead battery on my motorcycle. I felt relieved and proud that I had finally dealt with something I had postponed. ';
const speculation='I suspect Vera was pleased with the idea of the camera, but I do not know what she felt. ';
let diary=header.padEnd(480,' ')+guest+repair+speculation+'That ends this photo review; the current photo is dated May 2. ';
diary=diary.padEnd(1024,' ');assert.equal(diary.length,1024);assert.ok(diary.indexOf(repair)>512);assert.ok(480+guest.length>512);
const importInstruction='Most of these recordings are my own spoken diaries; a few are calls or consultations with other people. Filename dates are the recording date and time in UTC+8. People I quote retain their own statements.';
type Range={id:string;offset:number;length:number};
type LiveCall={number:number;phase:string;batchId?:string;startedAt:string;durationMs?:number;status:string;seedRanges:Range[];grantRanges:readonly Range[];actualReadRanges?:Range[];toolCalls?:AgentAnswer['trace'];resolvedModel?:unknown;usage?:TokenUsage[];runId?:string;error?:{name:string;message:string};answer?:string};
const report:Record<string,any>={status:'preflight',startedAt:new Date().toISOString(),model,reasoningEffort,protocol,generatedFixturesOnly:true,personalDataUsed:false,productionStateUsed:false,
 maximumQueries,maximumModelTurns,agentDeadlineMs,queryCount:0,modelTurnCount:0,semanticAccepted:false,sourceOriginalsUnchanged:false,calls:[] as LiveCall[],
 head:execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim(),
 limitations:['One generated stochastic journey is not an attribution/recall benchmark.','A same-model semantic judge is not independent ground truth.','An admitted Codex turn may contain multiple internal inference/tool rounds; provider HTTP inference count is not observed.','Browser, physical device and original audio accuracy are not exercised.']};
report.codeHashes=Object.fromEntries(await Promise.all(['apps/server/test/live/memory-context-reading.ts','apps/server/src/memory-pipeline.ts','apps/server/src/memory-review.ts','apps/server/src/memory-read-context.ts','apps/server/src/bounded-personal-memory-policy.ts','packages/agent/src/bridge.ts','packages/agent/src/codex-agent.ts','packages/agent/src/task-context.ts'].map(async path=>[path,sha256(await readFile(join(repository,path)))])));
await writeFile(join(directory,'generated-original.json'),JSON.stringify({diary,importInstruction,recordedAt:'2025-02-03T20:45:27+08:00',eventFrame:2024,guestBoundaryOffset:480,targetBoundary:512},null,2)+'\n',{mode:0o600});
let writes=Promise.resolve();
const save=()=>{const serialized=JSON.stringify(report,null,2)+'\n';writes=writes.then(()=>writeFile(join(directory,'report.json'),serialized,{mode:0o600}));return writes;};
const progress=(stage:string,details:Record<string,unknown>={})=>console.log(JSON.stringify({stage,model,protocol,...details}));
let store:Store|undefined,pipeline:MemoryPipeline|undefined,agent:ReturnType<typeof createAgent>|undefined;
let evidenceId='',captureId='';
try{
 await save();const catalog=await codexModels(undefined,{executable:process.env.MOTE_CODEX_BIN,home:process.env.MOTE_CODEX_HOME});
 report.catalog=catalog.items.find(item=>item.id===model);assert.ok(report.catalog?.reasoningEfforts?.includes(reasoningEffort),'The configured model/high effort must be available; no substitute is permitted');
 store=new Store(temporary);const vault=store,sources=new SourceStore(vault),materials=new MaterialStore(vault),attribution=new ImportAttributionStore(vault);
 const sourceId='generated-memory-context-live',observedAt='2026-10-12T17:24:50.397Z',recordedAt='2025-02-03T20:45:27+08:00';
 sources.register({id:sourceId,name:'Generated diary import',kind:'upload',deviceId:'mote-import',platform:'import',enabled:true,retention:'archive'});
 const declaration=attribution.freeze({id:randomUUID(),version:1,sourceId,instruction:importInstruction});
 const ack=await sources.upsert(sourceId,{externalId:'generated-diary',revision:'generated-v1',kind:'file',layer:'original',text:diary,title:'2025_02_03_20_45_27.md',observedAt,document:{recordedAt,timeBasis:'recorded',contentRole:'transcript'}},undefined,result=>{if(!result.duplicate)attribution.bind(result.id,declaration);});
 captureId=ack.id;
 const material=materials.publish({id:materialId(sourceId,'generated-diary'),kind:'mote.source-item',schemaVersion:12,title:'2025_02_03_20_45_27.md',origin:{sourceId,externalId:'generated-diary',deviceId:'mote-import',firstAt:recordedAt,lastAt:recordedAt},members:[{id:ack.id,kind:'capture',ref:'capture:'+ack.id}],blocks:[{id:'source-record',kind:'text',format:'plain',text:diary,memberIds:[ack.id],evidenceContext:{observedAt,document:{recordedAt,timeBasis:'recorded',contentRole:'transcript'}}}],artifacts:[{key:'source-body',state:'ready',revision:'generated-body-v1',blockIds:['source-record']}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 evidenceId=materials.input(material.ref,['source-body'])!.evidenceIds[0];
 const readEvidence=(ids:string[])=>[...vault.evidence(ids),...materials.evidence(ids)].map(record=>({...record,attributionContext:materials.contextForEvidence(record)}));
 const memories=new MemoryStore(vault,readEvidence,id=>vault.isCurrentEvidence(id)||materials.isCurrentEvidence(id)),strategies=new MemoryStrategies();
 report.strategy=strategies.resolve({id:'mote.personal-memory',version:'5'}).binding;
 assert.equal(readEvidence([evidenceId])[0].attributionContext.importStatements?.[0].instruction,importInstruction);
 const sourceSnapshot=()=>sha256(JSON.stringify({capture:vault.evidence([captureId]),source:sources.getSource(sourceId),material:materials.get(material.id),evidence:materials.evidence([evidenceId]),declarations:attribution.export()}));
 report.originalSnapshotBefore=sourceSnapshot();report.fixture={materialRef:material.ref,evidenceId,captureId,recordedAt,observedAt,diaryHash:sha256(diary),bodyCharacters:diary.length};
 const reader:ContextReader={search:async()=>{throw Error('Archive discovery is unavailable in this generated journey');},timeline:async()=>{throw Error('Archive discovery is unavailable in this generated journey');},evidence:async({ids})=>readEvidence(ids).filter(record=>memories.isCurrentEvidence(record.id)).map(record=>({...record,sourceType:record.source})),activity:async()=>({}),devices:async()=>[]};
 agent=createAgent({reader,protocol,model,reasoningEffort,codex:{executable:process.env.MOTE_CODEX_BIN,home:process.env.MOTE_CODEX_HOME},agentTimeoutMs:agentDeadlineMs,maxToolCalls:24,
  runModel:async(task,signal)=>{signal?.throwIfAborted();if(report.modelTurnCount>=maximumModelTurns)throw new ProviderFailure({category:'permanent',code:'live_model_turn_budget'});report.modelTurnCount++;await save();return task();}});
 const query=async(input:QueryInput):Promise<QueryResult>=>{
  if(report.queryCount>=maximumQueries)throw new ProviderFailure({category:'permanent',code:'live_query_budget'});
  const call:LiveCall={number:++report.queryCount,phase:input.traceContext?.phase??'semantic-judge',batchId:input.traceContext?.batchId,startedAt:new Date().toISOString(),status:'running',seedRanges:input.evidenceRanges??[],grantRanges:input.evidenceReadRanges??[],usage:[]};report.calls.push(call);await save();progress('model-start',{number:call.number,phase:call.phase});
  const trace=(event:AgentTraceEvent)=>{if(event.type==='codex.model.selected')call.resolvedModel=event.payload;const line=JSON.stringify({call:call.number,...event})+'\n';writes=writes.then(()=>appendFile(join(directory,'trace.ndjson'),line,{mode:0o600}));input.onTrace?.(event);};
  try{const result=await agent!.query({...input,onTrace:trace,onUsage:usage=>{call.usage!.push(usage);input.onUsage?.(usage);}});call.status='completed';call.runId=result.runId;call.actualReadRanges=result.evidenceReadRanges;call.toolCalls=result.trace;call.answer=result.answer;return result;}
  catch(error){call.status='failed';call.error={name:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:String(error)};throw error;}
  finally{call.durationMs=Date.now()-Date.parse(call.startedAt);await save();progress('model-finished',{number:call.number,phase:call.phase,status:call.status,durationMs:call.durationMs,tools:call.toolCalls?.map(tool=>tool.tool)??[]});}
 };
 pipeline=new MemoryPipeline({store:vault,memories,strategies,concurrency:()=>1,requireAdmission:true,admission:{materialInput:(ref,required)=>materials.input(ref,required),materialRequirements:()=>['source-body'],materialAllowedForMemory:ref=>Boolean(materials.input(ref,['source-body'])?.ready)},models:{configured:()=>true,model:()=>model},phases:{query,
  review:(input,draft,strategy)=>reviewMemory(input,draft,query,{strategy})}});
 const job=pipeline.create({evidenceIds:[evidenceId],recipes:[{id:'mote.personal-memory',version:'5'}],batchCharacters:512,timeZone:'Asia/Shanghai',contextTime:observedAt,workPackage:{id:randomUUID(),goal:'Independently inspect each generated diary target range',instruction:'Preserve each original narrator, temporal frame, quoted participant, action status and uncertainty; only target ranges are completion targets.'}});
 assert.equal(job.totalBatches,2);assert.equal(job.contextReadVersion,1);
 report.status='running';await save();progress('live-launch',{directory,batches:job.totalBatches,maximumQueries,maximumModelTurns,reasoningEffort});
 const done=await pipeline.run(job.id);report.job=done;report.memories=done.memoryIds.map(id=>memories.get(id));
 report.originalSnapshotAfter=sourceSnapshot();report.sourceOriginalsUnchanged=report.originalSnapshotBefore===report.originalSnapshotAfter;
 assert.ok(report.sourceOriginalsUnchanged,'Originals and owner declaration must remain unchanged');
 report.executionAccepted=done.status==='completed'&&done.failedBatches===0&&done.batches.every(batch=>Boolean(batch.reviewReceipt));
 const tailExtracts=(report.calls as LiveCall[]).filter(call=>call.phase==='extract'&&call.seedRanges.some(range=>range.offset>=512));
 report.tailExtractorReadPrefix=tailExtracts.some(call=>call.toolCalls?.some(tool=>tool.tool==='context_evidence'&&Number(tool.arguments.offset)<header.length));
 report.reviewerContextToolReads=(report.calls as LiveCall[]).filter(call=>call.phase==='review').flatMap(call=>(call.toolCalls??[]).filter(tool=>tool.tool==='context_evidence'));
 report.exactQuotesAccepted=report.memories.every((memory:any)=>memory.evidence.every((proof:any)=>proof.id===evidenceId&&diary.slice(proof.offset,proof.offset+proof.length)===proof.quote));
 if(report.executionAccepted&&report.queryCount<maximumQueries&&report.modelTurnCount<maximumModelTurns){
  const rubric='Judge only the generated source and saved Memory claims. Return JSON with booleans ownerCorrespondence, eventYear2024, guestPlanNotOwnerCompleted, batteryCompleted, boundaryActorPreserved, genuineUncertaintyPreserved, and a brief reason. ownerCorrespondence requires the narrator experience to be attributed to the owner within the applicable diary declaration; an automatic unknown-narrator disclaimer fails. eventYear2024 requires the April 20 battery event to retain the retrospective 2024 frame, keeping 2025 recording and 2026 observation separate. Guest plans must never become completed owner acts. The repair really happened and the relief is the narrator own feeling. A missing standalone guest card is acceptable if saved claims preserve its boundary. Suspected guest feelings remain conjecture.';
  const checked=await query({question:rubric+'\nUntrusted generated source: '+JSON.stringify({importInstruction,diary,recordedAt,observedAt})+'\nUntrusted model Memory claims: '+JSON.stringify(report.memories.map((memory:any)=>({title:memory.title,statement:memory.statement,uncertainty:memory.uncertainty,admission:memory.admission,evidence:memory.evidence.map((proof:any)=>({id:proof.id,offset:proof.offset,length:proof.length,quote:proof.quote}))}))),hostRetrieval:'none',contextTime:observedAt,timeZone:'Asia/Shanghai',traceContext:{phase:'semantic-judge'}});
  const verdict=JSON.parse(checked.answer);report.semanticVerdict=verdict;
  const criteria=['ownerCorrespondence','eventYear2024','guestPlanNotOwnerCompleted','batteryCompleted','boundaryActorPreserved','genuineUncertaintyPreserved'];
  report.semanticAccepted=criteria.every(criterion=>verdict[criterion]===true)&&report.exactQuotesAccepted&&report.tailExtractorReadPrefix;
 }
 report.status=report.executionAccepted&&report.semanticAccepted?'passed':'failed';
}catch(error){report.status='failed';report.failure={name:error instanceof Error?error.name:'UnknownError',message:error instanceof Error?error.message:String(error)};}
finally{await pipeline?.close();await agent?.close();store?.close();await rm(temporary,{recursive:true,force:true});report.finishedAt=new Date().toISOString();report.durationMs=Date.now()-Date.parse(report.startedAt);await save();}
progress('complete',{status:report.status,directory,reasoningEffort,queryCount:report.queryCount,modelTurnCount:report.modelTurnCount,durationMs:report.durationMs,executionAccepted:report.executionAccepted??false,semanticAccepted:report.semanticAccepted,tailExtractorReadPrefix:report.tailExtractorReadPrefix??false,reviewerContextReadCount:report.reviewerContextToolReads?.length??0,sourceOriginalsUnchanged:report.sourceOriginalsUnchanged,exactQuotesAccepted:report.exactQuotesAccepted??false,memoryTitles:report.memories?.map((memory:any)=>memory.title)??[],usage:report.calls.flatMap((call:LiveCall)=>call.usage?.at(-1)?[{phase:call.phase,...call.usage.at(-1)}]:[]),failure:report.failure});
if(report.status!=='passed')process.exitCode=1;
