/** One opt-in extraction or saved-draft review diagnostic; never publishes Memory or changes production limits. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {z} from 'zod';
import type {QueryInput} from '@mote/agent';
import type {CaptureRecord} from '@mote/shared';
import {startBridge} from '../packages/agent/src/bridge.js';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {codexModels} from '../apps/server/src/model-catalog.js';
import {memoryEvidenceFingerprint,MemoryOutputValidationError} from '../apps/server/src/memory.js';
import {memoryProfile} from '../apps/server/src/memory-profiles.js';
import {memoryReviewReceipt} from '../apps/server/src/memory-review.js';
import {sha256} from '../apps/server/src/store.js';

function external(path:string){const full=resolve(path),part=relative(repositoryRoot,full);assert.ok(part==='..'||part.startsWith('../'),'Keep private diagnostics outside Git');return full;}
assert.ok(process.env.MOTE_MEMORY_DIAG_SOURCE&&process.env.MOTE_MEMORY_DIAG_OUTPUT&&process.env.MOTE_MEMORY_DIAG_BATCH);
const source=external(process.env.MOTE_MEMORY_DIAG_SOURCE),directory=external(process.env.MOTE_MEMORY_DIAG_OUTPUT),batchIndex=z.coerce.number().int().min(0).parse(process.env.MOTE_MEMORY_DIAG_BATCH);
const sourceBytes=await readFile(join(source,'report.json')),prior=JSON.parse(sourceBytes.toString('utf8')),manifestBytes=await readFile(join(source,'manifest.json')),manifest=JSON.parse(manifestBytes.toString('utf8'));
const reviewBytes=process.env.MOTE_MEMORY_DIAG_REVIEW_REPORT?await readFile(external(process.env.MOTE_MEMORY_DIAG_REVIEW_REPORT)):undefined;
const reviewSource=reviewBytes?JSON.parse(reviewBytes.toString('utf8')):undefined;
assert.equal(prior.model,'gpt-6-sol');assert.equal(prior.reasoningEffort,'max');assert.equal(prior.manifestSha256,sha256(manifestBytes));assert.equal(prior.agentDeadlineMs,300000);
const job=prior.waves[0].job,batch=job.batches.find((value:any)=>value.index===batchIndex);
assert.ok(batch?.status==='failed'&&batch.errorCode==='provider_timeout'&&batch.phase==='extract','Choose a measured extraction timeout');
const ranges:{id:string;offset:number;length:number}[]=batch.evidenceRanges,ids=[...new Set(ranges.map(r=>r.id))];assert.ok(ids.length>0&&ids.length<=20);
const originals=ids.map(id=>{const mapping=prior.records.find((r:any)=>r.id===id),original=manifest.records.find((r:any)=>r.key===mapping?.key);assert.ok(original);assert.equal(sha256(original.text),original.textSha256);return {id,...original};});
for(const range of ranges){const original=originals.find(r=>r.id===range.id)!;assert.equal(range.offset,0);assert.equal(range.length,original.text.length,'This diagnostic reuses complete note records');}
const logs=join(source,'vault','logs'),traceRows:any[]=[];
for(const name of (await readdir(logs)).filter(name=>/^central\.\d+\.ndjson$/.test(name))){const text=await readFile(join(logs,name),'utf8');const lines=text.split('\n');lines.pop();for(const line of lines)if(line.trim())traceRows.push(JSON.parse(line));}
const baseline=traceRows.filter(r=>r.trace?.type==='context.assembled'&&r.trace.batchId===batch.id&&r.trace.tracePhase==='extract').sort((a,b)=>a.seq-b.seq).at(-1);
assert.ok(baseline&&baseline.trace.payload.seedEvidence.length===ids.length,'The failed call must have a saved original-evidence snapshot');
if(reviewSource){assert.equal(reviewSource.status,'diagnostic_completed');assert.equal(reviewSource.reviewTested,false);assert.equal(reviewSource.sourceBatchId,batch.id);assert.equal(reviewSource.model,'gpt-6-sol');assert.equal(reviewSource.reasoningEffort,'max');assert.equal(reviewSource.sourceContextHash,sha256(JSON.stringify(baseline)));assert.deepEqual(reviewSource.sourceRanges,ranges);assert.equal(reviewSource.contextTime,job.createdAt);assert.ok(reviewSource.result);}
await mkdir(directory,{mode:0o700});await writeFile(join(directory,'source-report.json'),sourceBytes,{mode:0o600,flag:'wx'});
await writeFile(join(directory,'source-context.json'),JSON.stringify(baseline,null,2)+'\n',{mode:0o600,flag:'wx'});
const vault=join(directory,'vault'),token=randomBytes(32).toString('hex');
const config:Config={dataKey:undefined,dataDir:vault,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,maxStorageBytes:100000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
 model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',
 diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:reviewSource?300000:600000,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME,memoryConcurrency:1};
const report:any={status:'running',startedAt:new Date().toISOString(),sourceRun:source,sourceReportHash:sha256(sourceBytes),sourceContextHash:sha256(JSON.stringify(baseline)),manifestHash:sha256(manifestBytes),
 personalDataUsed:prior.personalDataUsed,diagnosticOnly:true,baselineAgentDeadlineMs:300000,diagnosticAgentDeadlineMs:config.agentTimeoutMs,model:config.model,reasoningEffort:'max',
 originalDeadlineAccepted:false,performanceAccepted:false,semanticQualityAccepted:false,reviewTested:false,fullReplayTested:false,ordinaryQueryTested:false,memoriesPublished:false,
 contextTime:job.createdAt,sourceBatchId:batch.id,sourceRanges:ranges,originals,baselineContextMetrics:baseline.trace.payload.metrics,otherIsolatedWorkMayBeConcurrent:true,
 mode:reviewSource?'review':'extraction',extractionRepeated:false,...(reviewBytes?{reviewSourceHash:sha256(reviewBytes),draftRunId:reviewSource.result.runId}:{})};
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
async function save(){if(node)report.usage=node.featureServices.usageLedger.summary('2020-01-01','2100-01-01','UTC',{},'skill',1,200);await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
try{
 await save();const catalog=await codexModels(undefined,{executable:config.codexBin,home:config.codexHome});assert.ok(catalog.items.find(m=>m.id===config.model)?.reasoningEfforts?.includes('max'));
 report.runtimeHashes=Object.fromEntries(await Promise.all(['packages/agent/dist/instructions.js','packages/agent/dist/task-context.js','apps/server/src/evidence-reader.ts','apps/server/src/memory-policy.ts','apps/server/src/memory.ts','apps/server/src/memory-review.ts','scripts/diagnose-memory-deadline-live.ts'].map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
 for(const [path,hash] of Object.entries(prior.runnerHashes.at(-1).agentFiles??{}))assert.equal(report.runtimeHashes[path],hash,'Keep the latest failed replay code unchanged');
 node=await buildApp(config);const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);await node.app.ready();
 assert.equal(node.modelSettings.select('memory').settings.agentTimeoutMs,config.agentTimeoutMs);
 for(const original of originals){
  const response:{statusCode:number;body:string}=await node.app.inject({method:'POST',url:'/api/notes',headers:{authorization:`Bearer ${token}`,'x-mote-ingress-version':'2'},payload:{id:original.id,deviceId:'private-progressive-replay',deviceName:'Private authored replay',platform:'import',capturedAt:original.at,text:original.text}});
  assert.equal(response.statusCode,201,response.body);const record:CaptureRecord=node.memories.readEvidence([original.id])[0];assert.equal(record.ocrText,original.text);
 }
 // The Agent projection fingerprint and Memory dependency fingerprint have
 // different contracts. Compare the actual projected evidence, not their hashes.
 const bridge=await startBridge(node.featureServices.archiveReader,{question:'Verify diagnostic input',skill:'memory-extraction',evidenceIds:ids,evidenceRanges:ranges,timeZone:job.timeZone},4);
 try{assert.deepEqual(bridge.seedEvidence,baseline.trace.payload.seedEvidence,'Keep the complete model-visible originals unchanged');report.evidenceSnapshotUnchanged=true;}
 finally{await bridge.close();}
 const profile=memoryProfile(node.memories.readEvidence([ids[0]])[0]);assert.ok(ids.every(id=>memoryProfile(node!.memories.readEvidence([id])[0]).group===profile.group));
 const baselineEnvelope=JSON.parse(baseline.trace.payload.prompt);assert.equal(profile.prompt,baselineEnvelope.request,'Keep the original extraction contract');
 const expectedFingerprints=Object.fromEntries(ids.map(id=>[id,memoryEvidenceFingerprint(node!.memories.readEvidence([id])[0])]));
 const input:QueryInput={contextTime:job.createdAt,executionLane:'background',language:'zh-CN',question:profile.prompt,skill:profile.skill,responseMode:'memory-extraction',evidenceIds:ids,evidenceRanges:ranges,timeZone:job.timeZone,
  traceContext:{operationId:'deadline-diagnostic:'+randomUUID(),phase:'extract'},
  validateOutput:result=>{try{node!.memories.extract(result,config.model,{profile:profile.id,requireAdmission:true,evidenceRanges:ranges,expectedFingerprints,validateOnly:true});}catch(error){if(error instanceof MemoryOutputValidationError)return {code:error.code,feedback:error.repairInstruction};throw error;}},
  onProgress:event=>console.log(JSON.stringify({stage:event.stage,at:new Date().toISOString()}))};
 await save();const started=Date.now();
 try{if(reviewSource){
   node.memories.extract(reviewSource.result,config.model,{profile:profile.id,requireAdmission:true,evidenceRanges:ranges,expectedFingerprints,validateOnly:true});
   report.result=await node.featureServices.reviewExtraction(input,reviewSource.result);report.reviewDurationMs=Date.now()-started;report.reviewTested=true;report.reviewReceipt=memoryReviewReceipt(report.result);
   assert.equal(report.reviewReceipt?.decision,'independent');
  }else{report.result=await node.featureServices.queryAgent(input,'query','memories');report.extractionDurationMs=Date.now()-started;}}
 finally{report.observedDurationMs=Date.now()-started;}
 node.memories.extract(report.result,config.model,{profile:profile.id,requireAdmission:true,evidenceRanges:ranges,expectedFingerprints,validateOnly:true});
 assert.equal(node.store.db.prepare('SELECT count(*) AS n FROM memories').get()!.n,0,'Diagnostic must not save or publish Memory');
 report.proposalCount=JSON.parse(report.result.answer).memories.length;report.status='diagnostic_completed';
}catch(error){report.status='diagnostic_failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await save();await node?.app.close();console.log(JSON.stringify({status:report.status,report:join(directory,'report.json'),durationMs:report.observedDurationMs}));}
