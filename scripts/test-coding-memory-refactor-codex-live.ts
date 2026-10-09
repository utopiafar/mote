/** Opt-in generated-only Coding archive/receipt journey through actual local Codex.
 * node --import tsx scripts/test-coding-memory-refactor-codex-live.ts
 * Outputs stay outside Git; background workers alone publish and schedule work.
 */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,relative,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {QueryInput} from '@mote/agent';
import type {CaptureRecord,SourceItem,UsageReceipt} from '@mote/shared';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {codexModels} from '../apps/server/src/model-catalog.js';
import {usageTotals} from '../apps/server/src/usage.js';

const output=process.env.MOTE_CODING_REFACTOR_OUTPUT?resolve(process.env.MOTE_CODING_REFACTOR_OUTPUT):await mkdtemp(join(tmpdir(),'mote-coding-refactor-live-'));
const part=relative(repositoryRoot,output);assert.ok(part==='..'||part.startsWith('../'),'Live outputs must remain outside Git');
await mkdir(output,{recursive:true,mode:0o700});
const model='gpt-6.1-sol',reasoningEffort='high',sourceId='generated-coding-refactor',recordedAt='2026-10-01T08:00:00Z',startedAt=Date.now(),maximumDurationMs=12*60*1000;
const token=randomBytes(32).toString('hex');
const config:Config={dataKey:undefined,dataDir:join(output,'vault'),token,tokenPath:join(output,'token'),host:'127.0.0.1',port:0,maxStorageBytes:100_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model,modelProvider:'codex',modelProtocol:'codex-app-server',modelReasoningEffort:reasoningEffort,agentTimeoutMs:300000,modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',diagnosticsEnabled:true,agentTraceEnabled:false,agentConcurrency:2,llmConcurrency:2,memoryConcurrency:1,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME};
const report:Record<string,any>={status:'running',startedAt:new Date(startedAt).toISOString(),purpose:'bounded actual Coding v2 candidate reuse and independent review',model,reasoningEffort,personalDataUsed:false,physicalDevicesTested:false,generatedEvidence:true,http:true,productionBackgroundWorker:true,manualDrain:false,sourceChanges:false,fixtureSettings:{sourceSettleSeconds:0,unrelatedLifecycleDisabled:true},maximumAgentCalls:3,maximumDurationMs,providerInternalRequests:'unobservable',calls:[],head:execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim(),gitStatus:execFileSync('git',['status','--short'],{cwd:repositoryRoot,encoding:'utf8'}).trim()};
const files=['scripts/test-coding-memory-refactor-codex-live.ts','apps/server/src/app.ts','apps/server/src/source-pipelines.ts','apps/server/src/material-memory-work.ts','apps/server/src/conversation-understanding.ts','apps/server/src/memory-pipeline.ts','apps/server/src/memory-review.ts','packages/agent/dist/codex-agent.js','packages/agent/dist/task-context.js'];
report.codeHashes=Object.fromEntries(await Promise.all(files.map(async path=>[path,createHash('sha256').update(await readFile(join(repositoryRoot,path))).digest('hex')])));
let node:Awaited<ReturnType<typeof buildApp>>|undefined,base='',writes=Promise.resolve();
function save(){const text=JSON.stringify(report,null,2)+'\n';writes=writes.then(()=>writeFile(join(output,'report.json'),text,{mode:0o600}));return writes;}
function progress(stage:string,detail:Record<string,unknown>={}){console.log(JSON.stringify({stage,...detail}));}
async function request(method:string,path:string,payload?:unknown){const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2','accept-language':'en',...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});const data=await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);return data;}
function event(id:string,role:'user'|'assistant'|'tool_result',text:string):SourceItem{return {externalId:id,revision:'1',observedAt:recordedAt,kind:'message',layer:'original',title:'Generated '+id,deleted:false,text,document:{recordedAt,timeBasis:'recorded',contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-quasar',projectName:'Generated Quasar',projectIdentity:'workspace',sessionId:'generated-session',eventId:id,role,...(role==='assistant'?{channel:'final'}:{}),attribution:role==='user'?'human':role==='assistant'?'agent':'unknown',part:0,parts:1}}};}
const items=[event('owner','user','In the generated Quasar workspace I debugged duplicate note creation after request retries. The first implementation retried POST /notes without a request identity; an injected transient disconnect after commit created two rows. I changed the SQLite write transaction to persist a unique idempotency key and the original response atomically. I reran a generated test with disconnect after commit and repeated the same key: one stored row and the original response were returned. A different key created a distinct row. This verified the retry invariant only for this synthetic SQLite write path; other transports and physical devices are untested.'),event('assistant','assistant','Generated test report: commit-then-disconnect followed by same-key retry returned one stored note and the original response. The implementation stores the idempotency key and response in the same SQLite transaction; a different key creates a distinct note. This is a generated local regression report, not independent physical-device or deployment validation.'),event('tool','tool_result','GENERATED_PRIVATE_PROCESS_TEXT: this raw tool body is excluded from the formal dialogue and must not reach a model.')];
try{
 await save();const catalog=await codexModels(undefined,{executable:config.codexBin,home:config.codexHome});assert.ok(catalog.items.find(item=>item.id===model)?.reasoningEfforts?.includes(reasoningEffort));report.catalogVerified=true;
 node=await buildApp(config,{backgroundWorker:true});const query=node.agent.query.bind(node.agent);
 node.agent.query=async(input:QueryInput)=>{
  const understanding=input.question.includes('FINAL UNIFIED RESPONSE CONTRACT:\nInterpret every supplied part'),phase=understanding?'understanding':input.traceContext?.phase;
  assert.ok(understanding||phase==='review','An exact complete v2 artifact must avoid a second extraction call');
  assert.ok(Date.now()-startedAt<maximumDurationMs,'Live duration budget exhausted');assert.ok(report.calls.length<report.maximumAgentCalls,'Live Agent call budget exhausted');
  if(understanding)assert.equal(report.calls.filter((call:any)=>call.phase==='understanding').length,0,'Understanding may run only once for this complete bounded dialogue');
  const call:Record<string,any>={phase,number:report.calls.length+1,operationId:input.traceContext?.operationId,jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId,evidenceRanges:input.evidenceRanges,contextTime:input.contextTime,startedAt:new Date().toISOString(),status:'running'};report.calls.push(call);await save();progress('model-start',{number:call.number,phase});
  try{const result=await query(input);call.status='completed';call.runId=result.runId;call.answer=result.answer;call.citations=result.citations;call.tools=result.trace.map(trace=>trace.tool);if(understanding){const value=JSON.parse(result.answer);assert.equal(value.capacity.saturated,false);assert.ok(value.coverage.length>0);call.completeUnsaturatedContract=true;}return result;}
  catch(error){call.status='failed';call.failure=error instanceof Error?error.message:String(error);throw error;}
  finally{call.durationMs=Date.now()-Date.parse(call.startedAt);await save();progress('model-finish',{number:call.number,phase,status:call.status,durationMs:call.durationMs});}
 };
 const lifecycle=node.lifecycle.settings();for(const key of ['working','consolidation','insights'] as const)lifecycle[key].enabled=false;node.lifecycle.configure(lifecycle);
 base=await node.app.listen({host:'127.0.0.1',port:0});
 await request('POST','/api/sources',{id:sourceId,name:'Generated Coding refactor journey',kind:'coding-agent',deviceId:'generated-coding-device',platform:'macos',retention:'archive'});
 await request('PUT','/api/memory-recipe-settings',{sourceId,recipes:[{id:'mote.coding-memory',version:'2'}]});
 // Fixture-only settling configuration; actual 5-second workers still own all
 // publication, readiness, receipt admission and model scheduling.
 node.sourcePipelines.configure(sourceId,{settleSeconds:0});
 await writeFile(join(output,'generated-input.json'),JSON.stringify(items,null,2)+'\n',{mode:0o600});report.ingress=await request('POST','/api/sources/'+sourceId+'/items/batch',{items});assert.equal(report.ingress.receipts.length,3);await save();
 let jobs:ReturnType<typeof node.memoryPipeline.get>[]=[];let nextLog=0;
 while(Date.now()-startedAt<maximumDurationMs){
  const page=await request('GET','/api/memory-jobs');jobs=await Promise.all(page.items.map((job:any)=>request('GET','/api/memory-jobs/'+job.id)));
  if(jobs.some(job=>['failed','cancelled','waiting_for_model','waiting_for_input'].includes(job.status)))throw Error('Automatic Coding job did not complete: '+JSON.stringify(jobs.map(job=>({status:job.status,errorCode:job.errorCode}))));
  if(jobs.length&&jobs.every(job=>job.status==='completed'))break;
  if(Date.now()>nextLog){progress('waiting',{for:'automatic Coding receipt and reviewed Memory',jobs:jobs.map(job=>job.status)});nextLog=Date.now()+30000;}
  await delay(1000);
 }
 assert.equal(jobs.length,1,'One complete Coding dialogue and selected recipe must produce one automatic job');assert.equal(jobs[0].status,'completed');const job=jobs[0];report.job=job;
 assert.equal(job.recipes?.[0].id,'mote.coding-memory');assert.ok(job.automaticGrants?.length||job.automaticGrant);assert.equal(job.batches.length,1);const batch=job.batches[0] as typeof job.batches[number]&{artifactRefs?:{id:string;revision:string}[]};assert.equal(batch.status,'completed');assert.ok(batch.artifactRefs?.length===1);
 const artifact=node.store.archive.get(batch.artifactRefs![0].id)!;report.understandingArtifact=artifact;assert.equal(artifact.metadata.productsVersion,2);assert.equal(artifact.metadata.complete,true);assert.equal((artifact.metadata.memoryCapacity as {saturated:boolean}).saturated,false);assert.match(String(artifact.metadata.generationContract),/^[a-f0-9]{64}$/);assert.equal(artifact.metadata.runId,report.calls.find((call:any)=>call.phase==='understanding').runId);
 const canonical=(ranges:unknown[])=>JSON.stringify(ranges.slice().sort((a:any,b:any)=>a.id.localeCompare(b.id)||a.offset-b.offset||a.length-b.length));assert.equal(canonical(artifact.metadata.evidenceRanges as unknown[]),canonical(batch.evidenceRanges));
 const completedKeys=new Set(batch.coverage!.map(member=>member.key));assert.equal(completedKeys.size,batch.evidenceRanges.length);assert.deepEqual(new Set((artifact.metadata.memoryCoverage as {key:string}[]).map(member=>member.key)),completedKeys);assert.ok(batch.coverage!.every(member=>member.state==='checked'||member.state==='no_candidates'));
 assert.equal(report.calls.filter((call:any)=>call.phase==='understanding').length,1);assert.equal(report.calls.filter((call:any)=>call.phase==='extract').length,0);assert.ok(report.calls.filter((call:any)=>call.phase==='review').length>=1);assert.equal(batch.reviewReceipt?.decision,'independent');assert.equal(batch.reviewReceipt?.draftRunId,artifact.metadata.runId);assert.equal(batch.reviewReceipt?.reviewRunId,report.calls.filter((call:any)=>call.phase==='review').at(-1).runId);
 report.memories=job.memoryIds.map(id=>node!.memories.get(id));assert.ok(report.memories.length>0,'The generated explicit failure mechanism, atomic remedy and concrete regression support a Coding product');
 for(const memory of report.memories){assert.equal(memory.domain,'coding');assert.equal(memory.reviewReceipt?.draftRunId,artifact.metadata.runId);for(const span of memory.evidence){const support:CaptureRecord|undefined=node.memories.readEvidence([span.id])[0];assert.ok(support);assert.equal(support.ocrText.slice(span.offset,span.offset+span.length),span.quote);}}
 const formal=node.materials.list({kind:'mote.coding-session'}).items;assert.equal(formal.length,1);report.material=formal[0];const original=node.materials.read(formal[0].ref,{length:12000});assert.ok(!original.text.includes('GENERATED_PRIVATE_PROCESS_TEXT'));assert.ok(original.text.includes('idempotency'));assert.equal(batch.coverage!.reduce((sum,member)=>sum+member.length,0),original.text.length,'All formal original characters are covered');
 report.receipts=node.store.db.prepare('SELECT input_key,scope,authorized,job_id FROM memory_input_authorizations WHERE job_id=?').all(job.id);assert.ok(report.receipts.length&&report.receipts.every((receipt:any)=>receipt.authorized===1&&receipt.job_id===job.id));
 const usage=node.store.db.prepare('SELECT json FROM model_usage').all().map(row=>JSON.parse(String(row.json)) as UsageReceipt);report.usage={total:usageTotals(usage),items:usage};assert.equal(usage.length,report.calls.length,'Artifact reuse must not create a fictional second extraction usage receipt');assert.ok(usage.every(receipt=>receipt.status==='completed'&&receipt.model===model&&receipt.tokens?.complete&&receipt.tokens.inputTokens+receipt.tokens.outputTokens>0));report.actualReportedUsage=true;report.reusedUnderstandingWithoutExtraction=true;report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally{if(node){report.jobs=node.memoryPipeline.list().map(job=>node!.memoryPipeline.get(job.id));const receipts=node.store.db.prepare('SELECT json FROM model_usage').all().map(row=>JSON.parse(String(row.json)) as UsageReceipt);report.usage={total:usageTotals(receipts),items:receipts};await node.app.close();}report.finishedAt=new Date().toISOString();report.durationMs=Date.now()-startedAt;await save();progress('finished',{status:report.status,report:join(output,'report.json')});}
