/** Opt-in review-only comparison on a private snapshot of a completed replay.
 * Fails before generation if exact draft reuse is unavailable. Never rewrites
 * the baseline vault/report or treats execution success as semantic acceptance. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {backup,DatabaseSync} from 'node:sqlite';
import {chmod,cp,mkdir,readFile,readdir,realpath,writeFile} from 'node:fs/promises';
import {basename,join,relative,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import type {UsageReceipt} from '@mote/shared';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {sha256} from '../apps/server/src/store.js';
import {usageTotals} from '../apps/server/src/usage.js';
import {memoryStrategyRefSchema} from '../apps/server/src/memory-strategy-contract.js';
import type {MemoryJobDetail} from '../apps/server/src/memory-pipeline.js';
import {requestLocale} from '../apps/server/src/i18n.js';

function outside(path:string){const value=resolve(path),part=relative(repositoryRoot,value);assert.ok(part==='..'||part.startsWith('../'),'Private comparisons must stay outside Git');return value;}
assert.ok(process.env.MOTE_REVIEW_BASELINE&&process.env.MOTE_REVIEW_OUTPUT,'Set a completed private MOTE_REVIEW_BASELINE and a new MOTE_REVIEW_OUTPUT');
const baselineDirectory=outside(await realpath(process.env.MOTE_REVIEW_BASELINE));
const directory=outside(process.env.MOTE_REVIEW_OUTPUT),baselineBytes=await readFile(join(baselineDirectory,'report.json'));
const baseline=JSON.parse(baselineBytes.toString()),recipe=memoryStrategyRefSchema.parse(JSON.parse(process.env.MOTE_REVIEW_RECIPE??'{"id":"mote.personal-memory","version":"2"}'));
assert.equal(baseline.status,'passed');assert.equal(baseline.model,'gpt-6-sol');assert.equal(baseline.reasoningEffort,'max');
assert.ok(baseline.recipes?.some((r:{id:string;version:string})=>r.id===recipe.id&&r.version!==recipe.version));
const baselineJobs=baseline.codeHashes?.['scripts/test-automatic-memory-live.ts']?baseline.jobs:baseline.waves?.map((w:any)=>w.job);
assert.ok(Array.isArray(baselineJobs)&&baselineJobs.every((job:any)=>job.status==='completed'&&Array.isArray(job.batches)),'Use a completed automatic or wave-based replay');
const priorBatches=baselineJobs.flatMap((job:any)=>job.batches.filter((b:any)=>b.strategy?.recipe.id===recipe.id).map((batch:any)=>({jobId:job.id,batch})));
assert.ok(priorBatches.length>0&&priorBatches.length<=8,'Use a bounded completed sample');
assert.ok(priorBatches.every((item:any)=>item.batch.status==='completed'));
await mkdir(directory,{mode:0o700});
const vault=join(directory,'vault');
const source=new DatabaseSync(join(baselineDirectory,'vault/mote.sqlite'),{readOnly:true});
try{
  const active=source.prepare("SELECT count(*) n FROM memory_jobs WHERE json_extract(json,'$.status') NOT IN ('completed','failed','cancelled')").get();
  assert.equal(active!.n,0,'Do not snapshot a replay with unfinished work');
  await cp(join(baselineDirectory,'vault'),vault,{recursive:true,errorOnExist:true,force:false,filter:path=>!['mote.sqlite','mote.sqlite-wal','mote.sqlite-shm','logs'].includes(basename(path))});
  await chmod(vault,0o700);
  await backup(source,join(vault,'mote.sqlite'));
}finally{source.close();}
const token=randomBytes(32).toString('hex');
const config:Config={dataKey:undefined,dataDir:vault,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,maxStorageBytes:500_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:300000,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME,memoryConcurrency:1};
const report:Record<string,any>={startedAt:new Date().toISOString(),status:'running',semanticQualityAccepted:false,heldOut:false,baselineDirectory,baselineReportSha256:sha256(baselineBytes),recipe,model:config.model,reasoningEffort:'max',personalDataUsed:baseline.personalDataUsed,extractionAllowed:false,unexpectedExtractionAttempts:0,maximumModelCalls:priorBatches.length,maximumDurationMs:priorBatches.length*300000+60000,browserTested:false,physicalDevicesTested:false,mediaProcessingTested:false,calls:[],jobIds:[],head:execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim()};
report.codeHashes=Object.fromEntries(await Promise.all(['scripts/review-memory-recipe-live.ts','apps/server/src/personal-memory-review-policy.ts','apps/server/src/coding-memory-review-policy.ts','apps/server/src/memory-strategies.ts','apps/server/src/memory-pipeline.ts','apps/server/src/memory-review.ts','packages/agent/dist/task-context.js','packages/agent/dist/instructions.js'].map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
async function save(){
  if(node){
    const receipts=(node.store.db.prepare('SELECT json FROM model_usage').all() as {json:string}[]).map(r=>JSON.parse(r.json) as UsageReceipt).filter(r=>report.jobIds.includes(r.attribution?.jobId));
    report.usage={total:usageTotals(receipts),items:receipts};
  }
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
}
function progress(stage:string,details:Record<string,unknown>={}){console.log(JSON.stringify({stage,...details}));}
try{
  await save();node=await buildApp(config,{backgroundWorker:false});
  const settings=node.lifecycle.settings();for(const id of ['consolidation','insights','working'] as const)settings[id].enabled=false;node.lifecycle.configure(settings);
  await node.app.ready();
  assert.equal(node.modelSettings.current().model,'gpt-6-sol');assert.equal(node.modelSettings.current().reasoningEffort,'max');
  report.binding=node.memoryStrategies.resolve(recipe).binding;
  assert.ok(priorBatches.every((item:any)=>item.batch.strategy.extract.fingerprint===report.binding.extract.fingerprint),'Only the reviewer may change');
  const oldMemories=new Map((node.store.db.prepare('SELECT id,json FROM memories').all() as {id:string;json:string}[]).map(r=>[r.id,r.json]));
  const sharedDrafts=node.store.db.prepare('SELECT json FROM memory_extraction_drafts WHERE shared=1').all().map(row=>JSON.parse(String(row.json)));
  assert.ok(sharedDrafts.length,'The original shared generation must still be available');
  const draftRunIds=new Set(sharedDrafts.map(draft=>draft.runId));
  report.baselineDrafts=sharedDrafts.map(draft=>({runId:draft.runId,answerSha256:sha256(draft.answer)}));
  const query=node.agent.query.bind(node.agent);
  node.agent.query=async input=>{
    if(input.traceContext?.phase!=='review')report.unexpectedExtractionAttempts++;
    assert.equal(input.traceContext?.phase,'review','Exact draft cache missed: abort before paid generation');
    assert.ok(report.calls.length<priorBatches.length,'Bounded comparison review budget exceeded');
    const call:any={startedAt:new Date().toISOString(),phase:input.traceContext?.phase,batchId:input.traceContext?.batchId,status:'running'};report.calls.push(call);await save();
    progress('review-start',{call:report.calls.length,total:priorBatches.length});
    try{const result=await query(input);call.status='completed';call.runId=result.runId;return result;}
    catch(error){call.status='failed';throw error;}
    finally{call.durationMs=Date.now()-Date.parse(call.startedAt);await save();}
  };
  // Preserve each existing generation group exactly, including order, ranges,
  // artifacts and evaluation context. New jobs have distinct review identities.
  report.jobs=[];report.memories=[];
  for(const {jobId:baselineJobId,batch:old} of priorBatches){
    const prior=node.memoryPipeline.get(baselineJobId),stored=prior.batches.find(b=>b.id===old.id);
    assert.equal(prior.status,'completed');assert.ok(stored);assert.equal(stored.status,'completed');
    assert.deepEqual(stored.strategy,old.strategy);assert.deepEqual(stored.evidenceRanges,old.evidenceRanges);
    const ranges=old.evidenceRanges,batchCharacters=Math.max(256,...ranges.map((r:any)=>r.length));
    const job=requestLocale.run(prior.language??'zh-CN',()=>node!.memoryPipeline.create({contextTime:prior.contextTime??prior.createdAt,timeZone:prior.timeZone,modelProfileId:prior.modelProfileId,modelOverride:prior.modelOverride,recipes:[recipe],evidenceIds:[...new Set(ranges.map((r:any)=>r.id))] as string[],evidenceRanges:ranges,batchCharacters:Math.max(batchCharacters,ranges.reduce((sum:number,r:any)=>sum+r.length,0)),...(old.artifactRefs?.length?{artifactRefs:old.artifactRefs}:{})}));
    assert.equal(job.totalBatches,1);assert.deepEqual(job.batches[0].evidenceRanges,ranges);
    assert.equal(job.contextTime,prior.contextTime??prior.createdAt);assert.equal(job.timeZone,prior.timeZone);assert.equal(job.language,prior.language??'zh-CN');
    const ids=new Set(job.evidenceIds),pins=prior.materialInputs?.filter(pin=>pin.evidenceIds.some(id=>ids.has(id)));
    assert.deepEqual(job.materialInputs,pins?.length?pins:undefined);
    assert.deepEqual(job.materialRefs,Object.fromEntries(Object.entries(prior.materialRefs??{}).filter(([id])=>ids.has(id))));
    report.jobIds.push(job.id);await save();
    let done=false;const task:Promise<MemoryJobDetail>=node.memoryPipeline.run(job.id).finally(()=>{done=true;});
    while(!done){await delay(1000);report.currentJob=node.memoryPipeline.get(job.id);await save();if(Date.now()-Date.parse(report.startedAt)>report.maximumDurationMs){node.memoryPipeline.cancel(job.id);await task;throw Error('Bounded review comparison exceeded its deadline');}}
    const result=await task;report.jobs.push({baselineJobId,baselineBatchId:old.id,job:result});delete report.currentJob;await save();
    assert.equal(result.status,'completed',JSON.stringify(result.batches.map(b=>({status:b.status,error:b.errorCode}))));
    assert.deepEqual(result.configuration,prior.configuration,'The saved model configuration must not change');
    for(const id of result.memoryIds){const memory=node.memories.get(id);assert.deepEqual(memory.strategy,report.binding);assert.equal(memory.reviewReceipt?.strategy?.fingerprint,report.binding.review.fingerprint);assert.ok(draftRunIds.has(memory.reviewReceipt?.draftRunId),'A reviewed product must refer to an existing baseline draft');report.memories.push(memory);}
  }
  for(const [id,json] of oldMemories)assert.equal(node.store.db.prepare('SELECT json FROM memories WHERE id=?').get(id)?.json,json,'Prior products must remain unchanged');
  for(const original of baseline.records){assert.equal(sha256(node.memories.readEvidence([original.id])[0].ocrText),original.textSha256);}
  report.baselineProductsUnchanged=true;report.sourceHashesUnchanged=true;
  await save();await node.app.close();node=undefined;
  const traces=[];for(const name of await readdir(join(vault,'logs'))){if(!/^central\.\d+\.ndjson$/.test(name))continue;for(const line of (await readFile(join(vault,'logs',name),'utf8')).trim().split('\n')){if(!line)continue;const event=JSON.parse(line);if(event.trace?.type==='query.started')traces.push(event.trace);}}
  report.traceCalls=traces.map(t=>({traceId:t.traceId,batchId:t.batchId,phase:t.tracePhase,model:t.model}));
  assert.equal(traces.length,priorBatches.length);assert.ok(traces.every(t=>t.tracePhase==='review'&&t.model==='gpt-6-sol'));
  assert.equal(sha256(await readFile(join(baselineDirectory,'report.json'))),report.baselineReportSha256);
  report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await save();if(node){await node.app.close();node=undefined;}progress('finished',{status:report.status,report:join(directory,'report.json')});}
