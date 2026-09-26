/** Opt-in replay of complete authored originals; every artifact stays outside Git. */
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {documentSchema} from '@mote/shared';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {codexModels} from '../apps/server/src/model-catalog.js';
import {sha256} from '../apps/server/src/store.js';
import type {MemoryJobDetail} from '../apps/server/src/memory-pipeline.js';
import {materialId} from '../apps/server/src/materials.js';

const recordSchema=z.object({key:z.string(),at:z.string().datetime({offset:true}),text:z.string().min(1).max(100000),textSha256:z.string().length(64),origin:z.record(z.unknown())}).strict();
const manifestSchema=z.object({purpose:z.enum(['progressive','targeted']).default('progressive'),personalDataUsed:z.boolean(),sourceRun:z.string(),selectionMethod:z.string(),heldOutAfter:z.string(),records:z.array(recordSchema).min(1).max(200),waves:z.array(z.number().int().positive().max(100)).min(1).max(10)}).strict().refine(value=>value.purpose==='targeted'||value.records.length>=20&&value.waves.length>=2,'Progressive acceptance requires at least 20 records and two waves');
function outside(path:string){const value=resolve(path),part=relative(repositoryRoot,value);assert.ok(part==='..'||part.startsWith('../'),'Private runs must stay outside Git');return value;}
assert.ok(process.env.MOTE_REPLAY_MANIFEST&&process.env.MOTE_REPLAY_OUTPUT,'Set MOTE_REPLAY_MANIFEST and a new MOTE_REPLAY_OUTPUT outside Git');
const manifestPath=outside(process.env.MOTE_REPLAY_MANIFEST),manifestBytes=await readFile(manifestPath),manifest=manifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
assert.equal(manifest.waves.reduce((a,b)=>a+b,0),manifest.records.length);
assert.equal(new Set(manifest.records.map(r=>r.key)).size,manifest.records.length);
for(const record of manifest.records){assert.equal(sha256(record.text),record.textSha256);assert.ok(record.at.slice(0,10)<manifest.heldOutAfter);}
const directory=outside(process.env.MOTE_REPLAY_OUTPUT),resuming=process.env.MOTE_REPLAY_RESUME==='1';
const requestedIngress=process.env.MOTE_REPLAY_INGRESS?z.enum(['source','notes']).parse(process.env.MOTE_REPLAY_INGRESS):undefined;
const ingressOnly=process.env.MOTE_REPLAY_INGRESS_ONLY==='1';
const requestedBatchCharacters=process.env.MOTE_REPLAY_BATCH_CHARACTERS?z.coerce.number().int().min(256).max(12000).parse(process.env.MOTE_REPLAY_BATCH_CHARACTERS):undefined;
let report:Record<string,any>;
if(resuming){
 report=JSON.parse(await readFile(join(directory,'report.json'),'utf8'));
 assert.ok(report.status!=='passed'&&report.manifestSha256===sha256(manifestBytes)&&report.model==='gpt-6-sol'&&report.reasoningEffort==='max');
 await writeFile(join(directory,`report.previous-${randomUUID()}.json`),JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
 // Resuming an already ingressed run must preserve its original evidence IDs
 // and time semantics. A corrected source replay uses a separate vault.
 report.ingressMode??='notes';assert.equal(ingressOnly,report.ingressOnly??false);
 if(requestedIngress)assert.equal(report.ingressMode,requestedIngress);
}else{
 await mkdir(directory,{mode:0o700});
 await writeFile(join(directory,'manifest.json'),manifestBytes,{mode:0o600,flag:'wx'});
 report={startedAt:new Date().toISOString(),status:'running',manifestSha256:sha256(manifestBytes),model:'gpt-6-sol',reasoningEffort:'max',personalDataUsed:manifest.personalDataUsed,
  purpose:manifest.purpose,ingressMode:requestedIngress??'source',ingressOnly,selectionMethod:manifest.selectionMethod,heldOutAfter:manifest.heldOutAfter,
  browserTested:false,physicalDevicesTested:false,mediaProcessingTested:false,semanticQualityAccepted:false,
  priority:['functionality','performance','cost'],agentDeadlineMs:300000,records:manifest.records.map(r=>({key:r.key,id:randomUUID(),at:r.at,textSha256:r.textSha256})),waves:[],readsDuringModelWork:[]};
}
report.ingress=report.ingressMode==='source'?'Exact authored text and original document time through source ingress; observation time is this replay. Original Material references retained in manifest. Linked image bytes are not replayed.':'Exact authored text through notes; original document time is NOT preserved as provenance. Not evidence of faithful temporal import. Linked image bytes are not replayed.';
if(report.ingressMode==='source')for(const record of manifest.records){const document=documentSchema.parse(record.origin.documentTime);assert.equal(document.contentRole,'authored');assert.equal(document.timeBasis,'recorded');assert.ok(document.recordedAt);assert.equal(Date.parse(document.recordedAt),Date.parse(record.at));}
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
 if(report.ingressMode==='source')await request('POST','/api/sources',{id:deviceId,name:'Private authored replay',kind:'custom',deviceId,platform:'import',retention:'archive'});
}
async function close(){const old=node;if(old){await save();await old.app.close();node=undefined;}}
async function waitForJob(wave:Record<string,any>,task:Promise<MemoryJobDetail>,pauseAfterProgress=false){
 let settled=false,failure:unknown,completed:MemoryJobDetail|undefined;
 task.then(value=>{completed=value;settled=true;},error=>{failure=error;settled=true;});
 let last='',lastRead=0;
 while(!settled){
  const job=node!.memoryPipeline.get(wave.jobId);wave.job=job;
  const signature=JSON.stringify(job.batches.map(b=>[b.status,b.phase,b.stage]));
  if(signature!==last){last=signature;progress('memory-progress',{wave:wave.index,completed:job.completedBatches,failed:job.failedBatches,total:job.totalBatches,status:job.status,phase:job.batches.find(b=>b.status==='running')?.phase});await save();}
  if(pauseAfterProgress&&!wave.pauseRequested&&job.status==='running'&&job.completedBatches>0&&job.runningBatches!>0&&job.pendingBatches!>0){
   wave.pauseRequested={at:new Date().toISOString(),completedBatches:job.completedBatches,runningBatches:job.runningBatches,pendingBatches:job.pendingBatches};
   await request('POST',`/api/memory-jobs/${job.id}/pause`);await save();
  }
  if(job.runningBatches&&Date.now()-lastRead>15000){
   const at=Date.now(),page=await request('GET',report.ingressMode==='source'?`/api/sources/${deviceId}/items?limit=12`:'/api/notes?limit=12&deviceId='+deviceId);
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
 report.status='running';delete report.failure;delete report.finishedAt;await save();progress('catalog',{directory});
 if(!ingressOnly){const catalog=await codexModels(undefined,{executable:config.codexBin,home:config.codexHome});report.catalog=catalog.items.find(item=>item.id===config.model);assert.ok(report.catalog?.reasoningEfforts?.includes('max'));}
 await start();
 let offset=0;
 for(const [index,count] of manifest.waves.entries()){
  const originals=manifest.records.slice(offset,offset+count),saved=report.records.slice(offset,offset+count);offset+=count;
  let wave=report.waves[index];
  if(!wave){wave={index,count,cumulative:offset,status:'running',startedAt:new Date().toISOString()};report.waves.push(wave);await save();}
  if(wave.status==='passed')continue;
  progress('ingress',{wave:index,count,cumulative:offset});
  for(const [i,original] of originals.entries()){
   const document=report.ingressMode==='source'?documentSchema.parse(original.origin.documentTime):undefined;
   const payload=document?{externalId:sha256(original.key),revision:sha256(JSON.stringify([original.textSha256,document])),observedAt:report.startedAt,kind:'message',layer:'original',text:original.text,document}:{id:saved[i].id,deviceId,deviceName:'Private authored replay',platform:'import',capturedAt:original.at,text:original.text};
   const method=document?'PUT':'POST',url=document?`/api/sources/${deviceId}/items`:'/api/notes';
   const ack=await request(method,url,payload);if(saved[i].storedAt||!document)assert.equal(ack.id,saved[i].id);saved[i].id=ack.id;
   const duplicate=await request(method,url,payload);assert.equal(duplicate.id,ack.id);assert.equal(duplicate.duplicate,true);
   const stored=node!.memories.readEvidence([ack.id])[0];assert.ok(stored);assert.equal(stored.ocrText,original.text);saved[i].storedAt=stored.capturedAt;
   if(document){assert.deepEqual(stored.provenance?.document,document);assert.equal(Date.parse(stored.capturedAt),Date.parse(report.startedAt));saved[i].document=document;}
  }
  if(report.ingressMode==='source'){
   let settled=false;for(let attempt=0;attempt<100;attempt++){if(await node!.materialOrganizer.tick(100)===0){settled=true;break;}}assert.ok(settled,'Source Materials did not settle');
   for(const [i,original] of originals.entries()){
    const material=node!.materials.get(materialId(deviceId,sha256(original.key)));assert.ok(material);assert.equal(material.coverage.state,'complete');assert.ok(node!.materialMemoryWork.readyForMemory(material.ref));
    const ids=node!.materials.evidenceIds(material.ref),evidence=node!.memories.readEvidence(ids);assert.equal(evidence.length,1,'Authored source replay must preserve the complete source block');
    const body=JSON.parse(evidence[0].ocrText);assert.equal(body.text,original.text);assert.deepEqual(body.documentTime,saved[i].document);assert.equal(Date.parse(evidence[0].provenance!.document!.recordedAt!),Date.parse(original.at));
    saved[i].material=material;saved[i].memoryEvidenceIds=ids;saved[i].modelEvidence=evidence;
   }
   await save();
  }
  if(ingressOnly){wave.status='passed';wave.finishedAt=new Date().toISOString();await save();continue;}
  const ids=saved.flatMap((r:{id:string;memoryEvidenceIds?:string[]})=>r.memoryEvidenceIds??[r.id]);
  if(!wave.jobId){const job=await request('POST','/api/memory-jobs',{evidenceIds:ids,timeZone:'Asia/Shanghai'});wave.jobId=job.id;wave.job=job;await save();}
  let job=node!.memoryPipeline.get(wave.jobId);
  const needsPauseCheckpoint=index===1&&!wave.pauseCheckpoint&&job.totalBatches>1;
  if(needsPauseCheckpoint)delete wave.pauseRequested;
  if(job.status==='failed'||job.failedBatches>0){
   assert.equal(process.env.MOTE_REPLAY_RETRY,'1','A failed model batch requires explicit MOTE_REPLAY_RETRY=1 after diagnosis');
   const checkpoint={at:new Date().toISOString(),completed:job.batches.filter(b=>b.status==='completed').map(b=>({id:b.id,attempts:b.attempts,memoryIds:b.memoryIds})),preserved:false};
   (wave.retryCheckpoints??=[]).push(checkpoint);await save();
   job=await waitForJob(wave,node!.memoryPipeline.retry(job.id),needsPauseCheckpoint);
   for(const prior of checkpoint.completed){const after=job.batches.find(b=>b.id===prior.id);assert.ok(after);assert.equal(after.status,'completed');assert.equal(after.attempts,prior.attempts);assert.deepEqual(after.memoryIds,prior.memoryIds);}
   checkpoint.preserved=true;await save();
  }else if(job.status==='paused'||job.status==='pausing'){
   await request('POST',`/api/memory-jobs/${job.id}/resume`);job=await waitForJob(wave,node!.memoryPipeline.run(job.id),needsPauseCheckpoint);
  }else job=await waitForJob(wave,node!.memoryPipeline.run(job.id),needsPauseCheckpoint);
  if(needsPauseCheckpoint&&job.status==='paused'){
   assert.equal(job.status,'paused');assert.ok(job.completedBatches>0&&job.pendingBatches!>0,'Restart must preserve both completed and pending work');
   wave.pauseCheckpoint={job:structuredClone(job),memories:checkMemories(job),at:new Date().toISOString()};await save();
   await close();await start();
   const recovered=node!.memoryPipeline.get(job.id);assert.equal(recovered.status,'paused');assert.deepEqual(recovered.memoryIds,job.memoryIds);
   await request('POST',`/api/memory-jobs/${job.id}/resume`);job=await waitForJob(wave,node!.memoryPipeline.run(job.id));
  }
  if(needsPauseCheckpoint&&job.status==='completed')assert.ok(wave.pauseCheckpoint,'Wave completed without the required pause/restart evidence');
  assert.equal(job.status,'completed',JSON.stringify(job.batches.map(b=>({index:b.index,status:b.status,error:b.errorCode}))));
  if(wave.pauseCheckpoint)for(const prior of wave.pauseCheckpoint.job.batches.filter((b:{status:string})=>b.status==='completed')){
   const after=job.batches.find(b=>b.id===prior.id);assert.ok(after);assert.equal(after.attempts,prior.attempts);assert.deepEqual(after.memoryIds,prior.memoryIds);
  }
  wave.memories=checkMemories(job);wave.status='passed';wave.finishedAt=new Date().toISOString();await save();
  progress('wave-finished',{wave:index,count,cumulative:offset,batches:job.totalBatches,memories:job.memoryIds.length});
 }
 const allIds=report.records.map((r:{id:string})=>r.id),allMemoryIds=report.records.flatMap((r:{id:string;memoryEvidenceIds?:string[]})=>r.memoryEvidenceIds??[r.id]);
 if(!ingressOnly){const replay=await request('POST','/api/memory-jobs',{evidenceIds:allMemoryIds,timeZone:'Asia/Shanghai'});
 assert.equal(replay.totalBatches,0,'Completed extraction checkpoints should avoid model calls');
 assert.equal(replay.skippedChunks,report.waves.reduce((n:number,w:any)=>n+w.job.batches.reduce((sum:number,b:any)=>sum+b.evidenceRanges.length,0),0));report.checkpointReplay=replay;
 }
 for(const [i,record] of manifest.records.entries())assert.equal(sha256(node!.memories.readEvidence([allIds[i]])[0].ocrText),record.textSha256);
 report.memories=report.waves.flatMap((w:{memories?:unknown[]})=>w.memories??[]);report.recordCount=allIds.length;report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{report.finishedAt=new Date().toISOString();await save();await close();progress('finished',{status:report.status,report:join(directory,'report.json')});}
