/** Opt-in, bounded automatic-source replay in a fresh private vault. Real model
 * execution is separate from semantic acceptance and from held-out evaluation. */
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {documentSchema,type UsageReceipt} from '@mote/shared';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {codexModels} from '../apps/server/src/model-catalog.js';
import {sha256} from '../apps/server/src/store.js';
import {usageTotals} from '../apps/server/src/usage.js';
import {materialId} from '../apps/server/src/materials.js';

function outside(path:string){const value=resolve(path),part=relative(repositoryRoot,value);assert.ok(part==='..'||part.startsWith('../'),'Private runs must stay outside Git');return value;}
assert.ok(process.env.MOTE_AUTO_MANIFEST&&process.env.MOTE_AUTO_OUTPUT,'Set MOTE_AUTO_MANIFEST and a new MOTE_AUTO_OUTPUT outside Git');
const manifestBytes=await readFile(outside(process.env.MOTE_AUTO_MANIFEST));
const manifest=z.object({personalDataUsed:z.boolean(),selectionMethod:z.string(),records:z.array(z.object({key:z.string(),at:z.string().datetime({offset:true}),text:z.string().min(1).max(2500),textSha256:z.string().length(64),origin:z.object({documentTime:documentSchema}).passthrough()}).passthrough()).min(1).max(3)}).passthrough().parse(JSON.parse(manifestBytes.toString()));
assert.equal(new Set(manifest.records.map(r=>r.key)).size,manifest.records.length);
for(const record of manifest.records){assert.equal(sha256(record.text),record.textSha256);assert.equal(record.origin.documentTime.contentRole,'authored');assert.equal(Date.parse(record.origin.documentTime.recordedAt!),Date.parse(record.at));}
const directory=outside(process.env.MOTE_AUTO_OUTPUT);await mkdir(directory,{mode:0o700});
await writeFile(join(directory,'manifest.json'),manifestBytes,{mode:0o600,flag:'wx'});
const vault=join(directory,'vault'),token=randomBytes(32).toString('hex'),sourceId='private-automatic-authored';
const recipes=[{id:'mote.personal-memory',version:'2'},{id:'mote.coding-memory',version:'2'}];
const config:Config={dataKey:undefined,dataDir:vault,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,maxStorageBytes:500_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:300000,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME,memoryConcurrency:1};
const report:Record<string,any>={status:'running',startedAt:new Date().toISOString(),purpose:'targeted automatic-source composition',semanticQualityAccepted:false,heldOut:false,personalDataUsed:manifest.personalDataUsed,selectionMethod:manifest.selectionMethod,manifestSha256:sha256(manifestBytes),recipes,model:'gpt-6-sol',reasoningEffort:'max',batchCharacters:4000,maximumModelCalls:manifest.records.length*3,maximumDurationMs:20*60*1000,browserTested:false,physicalDevicesTested:false,mediaProcessingTested:false,calls:[],records:[],foregroundReads:[],unexpectedReplayAttempts:0,head:execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim()};
report.codeHashes=Object.fromEntries(await Promise.all(['scripts/test-automatic-memory-live.ts','apps/server/src/memory-extraction-drafts.ts','apps/server/src/evidence-store.ts','apps/server/src/memory-pipeline.ts','apps/server/src/memory-lifecycle.ts','apps/server/src/memory-recipe-settings.ts','apps/server/src/material-memory-work.ts','apps/server/src/memory-input-authorization.ts','apps/server/src/materials.ts','apps/server/src/material-organizers.ts','apps/server/src/material-readiness.ts','apps/server/src/evidence-reader.ts','apps/server/src/source-pipelines.ts','apps/server/src/memory-strategies.ts','apps/server/src/memory-strategy-contract.ts','apps/server/src/app.ts','apps/server/src/personal-memory-review-policy.ts','packages/agent/dist/instructions.js','packages/agent/dist/task-context.js'].map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
let node:Awaited<ReturnType<typeof buildApp>>|undefined,noModel=false,writes=Promise.resolve();
function progress(stage:string,details:Record<string,unknown>={}){console.log(JSON.stringify({stage,...details}));}
function save(){
  if(node){const receipts=node.store.db.prepare('SELECT json FROM model_usage').all().map(r=>JSON.parse(String(r.json)) as UsageReceipt);report.usage={total:usageTotals(receipts),items:receipts};report.jobs=node.memoryPipeline.list().map(j=>node!.memoryPipeline.get(j.id));}
  const json=JSON.stringify(report,null,2)+'\n';writes=writes.then(()=>writeFile(join(directory,'report.json'),json,{mode:0o600}));return writes;
}
async function request(method:'GET'|'POST'|'PUT',url:string,payload?:Record<string,unknown>){const response=await node!.app.inject({method,url,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2'},...(payload===undefined?{}:{payload})});assert.ok(response.statusCode>=200&&response.statusCode<300,`${method} ${url}: ${response.statusCode}`);return response.json();}
async function start(){
  node=await buildApp(config,{backgroundWorker:false});
  assert.equal(node.modelSettings.current().model,'gpt-6-sol');assert.equal(node.modelSettings.current().reasoningEffort,'max');
  const query=node.agent.query.bind(node.agent);
  node.agent.query=async input=>{
    if(noModel){report.unexpectedReplayAttempts++;throw Error('Unexpected model attempt during no-replay verification');}
    const phase=input.traceContext?.phase;assert.ok(phase==='extract'||phase==='review');
    assert.ok(report.calls.length<report.maximumModelCalls,'Automatic comparison call limit reached');
    assert.ok(report.calls.filter((c:any)=>c.phase===phase).length<manifest.records.length*(phase==='review'?2:1),'Unexpected repeated automatic stage');
    const call:Record<string,any>={phase,jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId,startedAt:new Date().toISOString(),status:'running'};report.calls.push(call);await save();progress('model-start',{number:report.calls.length,phase});
    try{const result=await query(input);call.status='completed';call.runId=result.runId;return result;}
    catch(error){call.status='failed';throw error;}
    finally{call.durationMs=Date.now()-Date.parse(call.startedAt);await save();}
  };
  const settings=node.lifecycle.settings();settings.batchCharacters=report.batchCharacters;settings.extraction.enabled=true;
  for(const id of ['consolidation','insights','working'] as const)settings[id].enabled=false;
  node.lifecycle.configure(settings);await node.app.ready();
}
async function close(){if(node){await save();await node.app.close();node=undefined;}}
const payload=(r:typeof manifest.records[number])=>({externalId:sha256(r.key),revision:sha256(JSON.stringify([r.textSha256,r.origin.documentTime])),observedAt:report.startedAt,kind:'message',layer:'original',text:r.text,document:r.origin.documentTime});
try{
  await save();const catalog=await codexModels(undefined,{executable:config.codexBin,home:config.codexHome});report.catalog=catalog.items.find(m=>m.id==='gpt-6-sol');assert.ok(report.catalog?.reasoningEfforts?.includes('max'));
  await start();await request('PUT','/api/memory-recipe-settings',{recipes});
  await request('POST','/api/sources',{id:sourceId,name:'Private automatic authored replay',kind:'custom',deviceId:sourceId,platform:'import',retention:'archive'});
  for(const original of manifest.records){
    const value=payload(original),ack=await request('PUT',`/api/sources/${sourceId}/items`,value),duplicate=await request('PUT',`/api/sources/${sourceId}/items`,value);
    assert.equal(duplicate.id,ack.id);assert.equal(duplicate.duplicate,true);assert.equal(sha256(node!.memories.readEvidence([ack.id])[0].ocrText),original.textSha256);
    report.records.push({key:original.key,id:ack.id,textSha256:original.textSha256,at:original.at});
  }
  for(let i=0;i<10;i++){if(await node!.materialOrganizer.tick(100)===0)break;}
  for(const [index,original] of manifest.records.entries()){
    const material=node!.materials.get(materialId(sourceId,sha256(original.key)))!;assert.ok(material&&node!.materialMemoryWork.readyForMemory(material.ref));
    const ids=node!.materials.evidenceIds(material.ref),evidence=node!.memories.readEvidence(ids);assert.equal(evidence.length,1);assert.equal(JSON.parse(evidence[0].ocrText).text,original.text);assert.deepEqual(evidence[0].provenance!.document,original.origin.documentTime);
    assert.ok(evidence[0].ocrText.length<=report.batchCharacters,'Each whole original must fit one batch');
    Object.assign(report.records[index],{materialRef:material.ref,evidenceIds:ids,formalTextSha256:sha256(evidence[0].ocrText)});
  }
  node!.sourcePipelines.drainMemory(node!.memoryPipeline,true,100);await save();
  assert.equal(report.jobs.length,manifest.records.length*2);for(const job of report.jobs){
    assert.ok(job.automaticGrant);assert.equal(job.batchCharacters,report.batchCharacters);assert.equal(job.totalBatches,1);
    assert.equal(job.materialInputs?.length,1);const pin=job.materialInputs[0];assert.deepEqual(pin.required,['source-body']);
    const input=node!.materials.input(pin.materialId,pin.required);assert.ok(input?.ready);assert.equal(pin.fingerprint,input.fingerprint);assert.deepEqual(pin.evidenceIds,job.evidenceIds);
  }
  for(const original of report.records){const jobs=report.jobs.filter((j:any)=>j.evidenceIds.some((id:string)=>original.evidenceIds.includes(id)));assert.equal(jobs.length,2);assert.equal(jobs[0].contextTime,jobs[1].contextTime);}
  let signature='',lastRead=0;
  while(true){
    await save();if(report.jobs.some((j:any)=>['failed','cancelled','waiting_for_model'].includes(j.status)))throw Error('An automatic recipe failed; inspect saved job diagnostics before retry');
    if(report.jobs.every((j:any)=>j.status==='completed'))break;
    assert.ok(Date.now()-Date.parse(report.startedAt)<report.maximumDurationMs,'Automatic comparison exceeded its wall-clock limit');
    const current=JSON.stringify(report.jobs.map((j:any)=>[j.id,j.status,j.batches[0]?.phase]));if(current!==signature){signature=current;progress('jobs',{completed:report.jobs.filter((j:any)=>j.status==='completed').length,total:report.jobs.length});}
    if(Date.now()-lastRead>20000){const at=Date.now(),page=await request('GET',`/api/sources/${sourceId}/items?limit=12`);assert.equal(page.items.length,manifest.records.length);report.foregroundReads.push({at:new Date(at).toISOString(),durationMs:Date.now()-at,items:page.items.length});lastRead=Date.now();}
    await delay(1000);node!.sourcePipelines.drainMemory(node!.memoryPipeline,true,100);
  }
  assert.equal(report.calls.filter((c:any)=>c.phase==='extract').length,manifest.records.length,'Same-source recipes must share generation');
  report.memories=report.jobs.flatMap((j:any)=>j.memoryIds.map((id:string)=>node!.memories.get(id)));
  for(const memory of report.memories){assert.ok(memory.strategy&&memory.reviewReceipt);assert.equal(memory.reviewReceipt.strategy.fingerprint,memory.strategy.review.fingerprint);for(const span of memory.evidence){const e=node!.memories.readEvidence([span.id])[0];assert.equal(e.ocrText.slice(span.offset,span.offset+span.length),span.quote);}}
  const products=new Map(node!.store.db.prepare('SELECT id,json FROM memories').all().map(r=>[String(r.id),String(r.json)])),jobIds=report.jobs.map((j:any)=>j.id).sort();
  const count=report.calls.length;noModel=true;await close();await start();
  await request('PUT','/api/memory-recipe-settings',{recipes:[recipes[1]]});
  for(const original of manifest.records)assert.equal((await request('PUT',`/api/sources/${sourceId}/items`,payload(original))).duplicate,true);
  await request('PUT','/api/memory-recipe-settings',{recipes});
  for(let i=0;i<6;i++){node!.sourcePipelines.drainMemory(node!.memoryPipeline,true,100);await delay(1000);}
  assert.equal(report.unexpectedReplayAttempts,0);assert.equal(report.calls.length,count);assert.deepEqual(node!.memoryPipeline.list().map(j=>j.id).sort(),jobIds);
  for(const [id,json] of products)assert.equal(node!.store.db.prepare('SELECT json FROM memories WHERE id=?').get(id)?.json,json);
  for(const original of report.records)assert.equal(sha256(node!.memories.readEvidence([original.id])[0].ocrText),original.textSha256);
  report.restartAndSelectionNoReplay=true;report.productsUnchangedAfterStrategyChange=true;report.sourceHashesUnchanged=true;await close();
  const traces=[];for(const name of await readdir(join(vault,'logs'))){if(!/^central\.\d+\.ndjson$/.test(name))continue;for(const line of (await readFile(join(vault,'logs',name),'utf8')).trim().split('\n')){if(line){const event=JSON.parse(line);if(event.trace?.type==='query.started')traces.push(event.trace);}}}
  report.traceCalls=traces.map(t=>({traceId:t.traceId,jobId:t.jobId,batchId:t.batchId,phase:t.tracePhase,model:t.model}));assert.equal(traces.length,report.calls.length);assert.ok(traces.every(t=>t.model==='gpt-6-sol'));
  report.status='passed';
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await close();report.finishedAt=new Date().toISOString();await save();progress('finished',{status:report.status,report:join(directory,'report.json')});}
