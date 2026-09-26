/** Opt-in replay of complete authored originals; every artifact stays outside Git. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {codexModels} from '../apps/server/src/model-catalog.js';
import {sha256} from '../apps/server/src/store.js';
import type {MemoryJobDetail} from '../apps/server/src/memory-pipeline.js';

const recordSchema=z.object({key:z.string(),at:z.string().datetime({offset:true}),text:z.string().min(1).max(100000),textSha256:z.string().length(64),origin:z.record(z.unknown())}).strict();
const manifestSchema=z.object({personalDataUsed:z.boolean(),sourceRun:z.string(),selectionMethod:z.string(),heldOutAfter:z.string(),records:z.array(recordSchema).min(20).max(200),waves:z.array(z.number().int().positive().max(100)).min(2).max(10)}).strict();
function outside(path:string){const value=resolve(path),part=relative(repositoryRoot,value);assert.ok(part==='..'||part.startsWith('../'),'Private runs must stay outside Git');return value;}
assert.ok(process.env.MOTE_REPLAY_MANIFEST&&process.env.MOTE_REPLAY_OUTPUT,'Set MOTE_REPLAY_MANIFEST and a new MOTE_REPLAY_OUTPUT outside Git');
const manifestPath=outside(process.env.MOTE_REPLAY_MANIFEST),manifestBytes=await readFile(manifestPath),manifest=manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
assert.equal(manifest.waves.reduce((a,b)=>a+b,0),manifest.records.length);
assert.equal(new Set(manifest.records.map(r=>r.key)).size,manifest.records.length);
for(const record of manifest.records){assert.equal(sha256(record.text),record.textSha256);assert.ok(record.at.slice(0,10)<manifest.heldOutAfter);}
const directory=outside(process.env.MOTE_REPLAY_OUTPUT),resuming=process.env.MOTE_REPLAY_RESUME==='1';
const requestedBatchCharacters=process.env.MOTE_REPLAY_BATCH_CHARACTERS?z.coerce.number().int().min(256).max(12000).parse(process.env.MOTE_REPLAY_BATCH_CHARACTERS):undefined;
let report:Record<string,any>;
if(resuming){
 report=JSON.parse(await readFile(join(directory,'report.json'),'utf8'));
 assert.ok(report.status!=='passed'&&report.manifestSha256===sha256(manifestBytes)&&report.model==='gpt-6-sol'&&report.reasoningEffort==='max');
 await writeFile(join(directory,`report.previous-${randomUUID()}.json`),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
}else{
 await mkdir(directory,{mode:0o700});
 await writeFile(join(directory,'manifest.json'),manifestBytes,{mode:0o600,flag:'wx'});
 report={startedAt:new Date().toISOString(),status:'running',manifestSha256:sha256(manifestBytes),model:'gpt-6-sol',reasoningEffort:'max',personalDataUsed:manifest.personalDataUsed,
  selectionMethod:manifest.selectionMethod,heldOutAfter:manifest.heldOutAfter,ingress:'Exact authored text through notes; original Material references retained in manifest. Linked image bytes are not replayed.',
  browserTested:false,physicalDevicesTested:false,mediaProcessingTested:false,semanticQualityAccepted:false,
  priority:['functionality','performance','cost'],agentDeadlineMs:300000,records:manifest.records.map(r=>({key:r.key,id:randomUUID(),at:r.at,textSha256:r.textSha256})),waves:[],readsDuringModelWork:[]};
}
report.runnerHashes??=[];report.runnerHashes.push({at:new Date().toISOString(),hash:sha256(await readFile(join(repositoryRoot,'scripts/test-progressive-memory-live.ts'))),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',cwd:repositoryRoot}).trim(),
 agentFiles:Object.fromEntries(await Promise.all(['packages/agent/dist/instructions.js','packages/agent/dist/task-context.js','apps/server/src/evidence-reader.ts','apps/server/src/memory-policy.ts','apps/server/src/memory.ts','apps/server/src/memory-review.ts'].map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])))});
const vault=join(directory,'vault'),token=randomBytes(32).toString('hex'),deviceId='private-progressive-replay';
const config:Config={dataKey:undefined,dataDir:vault,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,maxStorageBytes:500_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
 model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',
 diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:300000,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME,memoryConcurrency:1};
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
function progress(stage:string,data:Record<string,unknown>={}){console.log(JSON.stringify({stage,...data}));}
async function save(){if(node)report.usage=node.featureServices.usageLedger.summary('2020-01-01','2100-01-01','UTC',{},'skill',1,200);await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
async function request(method:'GET'|'POST'|'PUT',url:string,payload?:unknown){const response=await node!.app.inject({method,url,headers:{authorization:`Bearer ${token}`,'x-mote-ingress-version':'2'},...(payload?{payload}:{})});assert.ok(response.statusCode>=200&&response.statusCode<300,`${method} ${url}: ${response.statusCode} ${response.body}`);return response.json();}
async function start(){
 node=await buildApp(config);const settings=node.lifecycle.settings();for(const id of ['extraction','consolidation','insights','working'] as const)settings[id].enabled=false;node.lifecycle.configure(settings);await node.app.ready();
 if(requestedBatchCharacters!==undefined&&settings.batchCharacters!==requestedBatchCharacters){(report.batchBudgetChanges??=[]).push({at:new Date().toISOString(),from:settings.batchCharacters,to:requestedBatchCharacters,existingJobRangesUnchanged:true});settings.batchCharacters=requestedBatchCharacters;await request('PUT','/api/memory-settings',settings);}
 assert.equal(node.modelSettings.current().model,config.model);assert.equal(node.modelSettings.current().reasoningEffort,'max');
}
async function close(){const old=node;if(old){await save();await old.app.close();node=undefined;}}
async function waitForJob(wave:Record<string,any>,task:Promise<MemoryJobDetail>){
 let settled=false,failure:unknown,completed:MemoryJobDetail|undefined;
 task.then(value=>{completed=value;settled=true;},error=>{failure=error;settled=true;});
 let last='',lastRead=0;
 while(!settled){
  const job=node!.memoryPipeline.get(wave.jobId);wave.job=job;
  const signature=JSON.stringify(job.batches.map(b=>[b.status,b.phase,b.stage]));
  if(signature!==last){last=signature;progress('memory-progress',{wave:wave.index,completed:job.completedBatches,failed:job.failedBatches,total:job.totalBatches,status:job.status,phase:job.batches.find(b=>b.status==='running')?.phase});await save();}
  if(job.runningBatches&&Date.now()-lastRead>15000){
   const at=Date.now(),page=await request('GET','/api/notes?limit=12&deviceId='+deviceId);
   assert.ok(page.items.length>0&&page.items.length<=12);report.readsDuringModelWork.push({at:new Date().toISOString(),wave:wave.index,durationMs:Date.now()-at,items:page.items.length});lastRead=Date.now();
  }
  await delay(1000);
 }
 if(failure)throw failure;
 assert.ok(completed);wave.job=completed;await save();return completed;
}
function checkMemories(job:MemoryJobDetail){
 const memories=job.memoryIds.map(id=>node!.memories.get(id));
 for(const memory of memories){assert.ok(memory.reviewRunId);for(const span of memory.evidence??[]){const original=node!.memories.readEvidence([span.id])[0];assert.ok(original);assert.equal(original.ocrText.slice(span.offset!,span.offset!+span.length!),span.quote);}}
 return memories;
}
try{
 report.status='running';delete report.failure;await save();progress('catalog',{directory});
 const catalog=await codexModels(undefined,{executable:config.codexBin,home:config.codexHome});report.catalog=catalog.items.find(item=>item.id===config.model);assert.ok(report.catalog?.reasoningEfforts?.includes('max'));
 await start();
 let offset=0;
 for(const [index,count] of manifest.waves.entries()){
  const originals=manifest.records.slice(offset,offset+count),saved=report.records.slice(offset,offset+count);offset+=count;
  let wave=report.waves[index];
  if(!wave){wave={index,count,cumulative:offset,status:'running',startedAt:new Date().toISOString()};report.waves.push(wave);await save();}
  if(wave.status==='passed')continue;
  progress('ingress',{wave:index,count,cumulative:offset});
  for(const [i,original] of originals.entries()){
   const payload={id:saved[i].id,deviceId,deviceName:'Private authored replay',platform:'import',capturedAt:original.at,text:original.text};
   const ack=await request('POST','/api/notes',payload);assert.equal(ack.id,saved[i].id);
   const duplicate=await request('POST','/api/notes',payload);assert.equal(duplicate.id,ack.id);assert.equal(duplicate.duplicate,true);
   const stored=node!.memories.readEvidence([ack.id])[0];assert.ok(stored);assert.equal(stored.ocrText,original.text);saved[i].storedAt=stored.capturedAt;
  }
  const ids=saved.map((r:{id:string})=>r.id);
  if(!wave.jobId){const job=await request('POST','/api/memory-jobs',{evidenceIds:ids,timeZone:'Asia/Shanghai'});wave.jobId=job.id;wave.job=job;await save();}
  let job=node!.memoryPipeline.get(wave.jobId);
  if(job.status==='failed'){
   assert.equal(process.env.MOTE_REPLAY_RETRY,'1','A failed model batch requires explicit MOTE_REPLAY_RETRY=1 after diagnosis');
   job=await waitForJob(wave,node!.memoryPipeline.retry(job.id));
  }else if(job.status==='paused'||job.status==='pausing'){
   await request('POST',`/api/memory-jobs/${job.id}/resume`);job=await waitForJob(wave,node!.memoryPipeline.run(job.id));
  }else if(index===1&&!wave.pauseCheckpoint&&job.totalBatches>1&&job.status!=='completed'){
   const active=node!.memoryPipeline.run(job.id),deadline=Date.now()+30000;
   while(!node!.memoryPipeline.get(job.id).runningBatches&&Date.now()<deadline)await delay(50);
   assert.ok(node!.memoryPipeline.get(job.id).runningBatches,'No active batch to pause');
   await request('POST',`/api/memory-jobs/${job.id}/pause`);job=await waitForJob(wave,active);
   assert.equal(job.status,'paused');assert.ok(job.completedBatches>0&&job.pendingBatches!>0,'Restart must preserve both completed and pending work');
   wave.pauseCheckpoint={job:structuredClone(job),memories:checkMemories(job),at:new Date().toISOString()};await save();
   await close();await start();
   const recovered=node!.memoryPipeline.get(job.id);assert.equal(recovered.status,'paused');assert.deepEqual(recovered.memoryIds,job.memoryIds);
   await request('POST',`/api/memory-jobs/${job.id}/resume`);job=await waitForJob(wave,node!.memoryPipeline.run(job.id));
  }else job=await waitForJob(wave,node!.memoryPipeline.run(job.id));
  assert.equal(job.status,'completed',JSON.stringify(job.batches.map(b=>({index:b.index,status:b.status,error:b.errorCode}))));
  if(wave.pauseCheckpoint)for(const prior of wave.pauseCheckpoint.job.batches.filter((b:{status:string})=>b.status==='completed')){
   const after=job.batches.find(b=>b.id===prior.id);assert.ok(after);assert.equal(after.attempts,prior.attempts);assert.deepEqual(after.memoryIds,prior.memoryIds);
  }
  wave.memories=checkMemories(job);wave.status='passed';wave.finishedAt=new Date().toISOString();await save();
  progress('wave-finished',{wave:index,count,cumulative:offset,batches:job.totalBatches,memories:job.memoryIds.length});
 }
 const allIds=report.records.map((r:{id:string})=>r.id),replay=await request('POST','/api/memory-jobs',{evidenceIds:allIds,timeZone:'Asia/Shanghai'});
 assert.equal(replay.totalBatches,0,'Completed extraction checkpoints should avoid model calls');
 assert.equal(replay.skippedChunks,report.waves.reduce((n:number,w:any)=>n+w.job.batches.reduce((sum:number,b:any)=>sum+b.evidenceRanges.length,0),0));report.checkpointReplay=replay;
 for(const [i,record] of manifest.records.entries())assert.equal(sha256(node!.memories.readEvidence([allIds[i]])[0].ocrText),record.textSha256);
 report.memories=report.waves.flatMap((w:{memories:unknown[]})=>w.memories);report.recordCount=allIds.length;report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await save();await close();progress('finished',{status:report.status,report:join(directory,'report.json')});}
