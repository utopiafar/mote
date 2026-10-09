/** Opt-in generated-fixture regression. Never opens an existing daily vault.
 * Structural checks do not replace the frozen external semantic review rubric. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {z} from 'zod';
import type {UsageReceipt} from '@mote/shared';
import type {Memory} from '../apps/server/src/memory.js';
import {buildApp} from '../apps/server/src/app.js';
import {repositoryRoot,type Config} from '../apps/server/src/config.js';
import {materialId} from '../apps/server/src/materials.js';
import {codexModels} from '../apps/server/src/model-catalog.js';
import {sha256} from '../apps/server/src/store.js';
import {usageTotals} from '../apps/server/src/usage.js';

const frozenHash='cffcdbc96dc7b816323c224def13b14bb0c20628b0b58f2c3c32185a5d945130';
const recordSchema=z.object({key:z.string(),at:z.string().datetime({offset:true}),text:z.string().min(1).max(3000),sha256:z.string().length(64)});
const schema=z.object({schema:z.literal('mote-effective-memory-generated@1'),personalDataUsed:z.literal(false),heldOut:z.literal(false),contextTime:z.string().datetime(),initialRecords:z.array(recordSchema).length(6),newEvidence:recordSchema,correction:z.object({ofKey:z.string(),title:z.string(),statement:z.string(),validFrom:z.string().datetime({offset:true})}),questions:z.array(z.object({id:z.string(),text:z.string()})).length(3),limits:z.object({maximumOuterModelCalls:z.literal(14),perCallTimeoutMs:z.literal(300000),maximumRunDurationMs:z.literal(3600000),maximumAutomaticRetries:z.literal(0)})});
function outside(path:string){const value=resolve(path),part=relative(repositoryRoot,value);assert.ok(part==='..'||part.startsWith('../'),'Run files must stay outside Git');return value;}
assert.ok(process.env.MOTE_EFFECTIVE_MANIFEST&&process.env.MOTE_EFFECTIVE_OUTPUT,'Set the frozen MOTE_EFFECTIVE_MANIFEST and a new MOTE_EFFECTIVE_OUTPUT outside Git');
const manifestBytes=await readFile(outside(process.env.MOTE_EFFECTIVE_MANIFEST));
assert.equal(sha256(manifestBytes),frozenHash,'This harness only sends its frozen generated fixture to the model');
const fixture=schema.parse(JSON.parse(manifestBytes.toString()));
for(const record of [...fixture.initialRecords,fixture.newEvidence])assert.equal(sha256(record.text),record.sha256);
const directory=outside(process.env.MOTE_EFFECTIVE_OUTPUT),resume=process.env.MOTE_EFFECTIVE_RESUME==='1',full=process.env.MOTE_EFFECTIVE_STAGES==='full',preflight=process.env.MOTE_EFFECTIVE_PREFLIGHT==='1';
assert.ok(!preflight||!resume,'Preflight always uses a new isolated vault');
const reportPath=join(directory,'report.json'),invocationStarted=Date.now();
const report:Record<string,any>=resume?JSON.parse(await readFile(reportPath,'utf8')):{schema:'mote-effective-memory-run@1',status:'prepared',startedAt:new Date().toISOString(),fixtureSha256:frozenHash,personalDataUsed:false,heldOut:false,semanticQualityAccepted:false,model:'gpt-6-sol',reasoningEffort:'max',browserTested:false,physicalDevicesTested:false,mediaProcessingTested:false,records:[],calls:[],questions:[],steps:{},invocations:[],failures:[],publishRequests:0};
if(resume){assert.equal(report.fixtureSha256,frozenHash);assert.equal(report.status,'core-passed','Resume only a finished, structurally passed core run; diagnose failures separately');}
else {await mkdir(directory,{mode:0o700});await writeFile(join(directory,'manifest.json'),manifestBytes,{mode:0o600,flag:'wx'});}
const vault=join(directory,'vault'),token=randomBytes(32).toString('hex'),sourceId='generated-effective-memory';
const config:Config={dataKey:undefined,dataDir:vault,token,tokenPath:join(vault,'token'),host:'127.0.0.1',port:0,maxStorageBytes:200_000_000,maxExportBytes:20_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'gpt-6-sol',modelReasoningEffort:'max',modelProvider:'codex',modelProtocol:'codex-app-server',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'warn',diagnosticsEnabled:true,agentTraceEnabled:true,agentTimeoutMs:fixture.limits.perCallTimeoutMs,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME,memoryConcurrency:1};
const invocation:Record<string,any>={startedAt:new Date().toISOString(),stages:full?'full':'core',node:process.version,platform:process.platform,architecture:process.arch,head:execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryRoot,encoding:'utf8'}).trim(),diffStat:execFileSync('git',['diff','--stat'],{cwd:repositoryRoot,encoding:'utf8'}),codexVersion:execFileSync(config.codexBin??'codex',['--version'],{encoding:'utf8'}).trim()};
const codePaths=['scripts/test-effective-memory-live.ts','apps/server/src/memory.ts','apps/server/src/memory-deletions.ts','apps/server/src/memory-pipeline.ts','apps/server/src/memory-review.ts','apps/server/src/memory-extraction-drafts.ts','apps/server/src/memory-routes.ts','apps/server/src/agent-feature-host.ts','packages/agent/dist/instructions.js','packages/agent/dist/task-context.js','packages/agent/dist/skills.js'];
invocation.codeHashes=Object.fromEntries(await Promise.all(codePaths.map(async path=>[path,sha256(await readFile(join(repositoryRoot,path)))])));
invocation.command={executable:process.execPath,args:process.execArgv.concat(process.argv.slice(1)),environment:{MOTE_EFFECTIVE_MANIFEST:process.env.MOTE_EFFECTIVE_MANIFEST,MOTE_EFFECTIVE_OUTPUT:directory,MOTE_EFFECTIVE_RESUME:resume?'1':'0',MOTE_EFFECTIVE_STAGES:full?'full':'core',MOTE_EFFECTIVE_PREFLIGHT:preflight?'1':'0'}};
const snapshotDirectory=join(directory,'code-'+String(report.invocations.length+1));await mkdir(snapshotDirectory,{mode:0o700});
await writeFile(join(snapshotDirectory,'working-tree.patch'),execFileSync('git',['diff','--binary'],{cwd:repositoryRoot}),{mode:0o600});
for(const path of codePaths)await writeFile(join(snapshotDirectory,path.replaceAll('/','__')),await readFile(join(repositoryRoot,path)),{mode:0o600});
invocation.codeSnapshot=snapshotDirectory;
report.invocations.push(invocation);
let node:Awaited<ReturnType<typeof buildApp>>|undefined,failNextReview=!resume,writes=Promise.resolve();
function progress(stage:string,details:Record<string,unknown>={}){console.log(JSON.stringify({stage,...details}));}
function receipts(){return node!.store.db.prepare('SELECT json FROM model_usage ORDER BY created_at,id').all().map(row=>JSON.parse(String(row.json)) as UsageReceipt);}
function save(){
  if(node){const items=receipts();report.usage={total:usageTotals(items),items};report.jobs=node.memoryPipeline.list().map(job=>node!.memoryPipeline.get(job.id));report.memories=node.store.db.prepare('SELECT json FROM memories ORDER BY id').all().map(row=>JSON.parse(String(row.json)));}
  const json=JSON.stringify(report,null,2)+'\n';writes=writes.then(()=>writeFile(reportPath,json,{mode:0o600}));return writes;
}
async function open(){
  node=await buildApp(config,{backgroundWorker:false});
  const settings=node.lifecycle.settings();settings.batchCharacters=12000;for(const key of ['consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
  assert.equal(node.modelSettings.current().model,'gpt-6-sol');assert.equal(node.modelSettings.current().reasoningEffort,'max');
  const query=node.agent.query.bind(node.agent);
  node.agent.query=async input=>{
    assert.ok(!preflight,'Preflight cannot call any model');
    const phase=input.traceContext?.phase??'ask';
    if(phase==='review'&&failNextReview){failNextReview=false;report.injectedReviewFailure={at:new Date().toISOString(),batchId:input.traceContext?.batchId,jobId:input.traceContext?.jobId,beforeProviderCall:true};await save();throw Error('Generated harness: deliberate one-time review interruption before provider call');}
    assert.ok(report.calls.length<(full?fixture.limits.maximumOuterModelCalls:3),'Frozen outer-call protection reached');
    assert.ok(Date.now()-invocationStarted<fixture.limits.maximumRunDurationMs,'Frozen runtime protection reached');
    const call:Record<string,any>={phase,startedAt:new Date().toISOString(),status:'running',jobId:input.traceContext?.jobId,batchId:input.traceContext?.batchId,trace:[]};report.calls.push(call);await save();progress('model-start',{number:report.calls.length,phase});
    try{const result=await query({...input,onTrace:event=>{call.trace.push(event);input.onTrace?.(event);}});call.status='completed';call.runId=result.runId;call.result=result;return result;}
    catch(error){call.status='failed';call.failure=error instanceof Error?error.message:String(error);throw error;}
    finally{call.durationMs=Date.now()-Date.parse(call.startedAt);await save();progress('model-finished',{number:report.calls.indexOf(call)+1,phase,status:call.status,durationMs:call.durationMs});}
  };
  await node.app.ready();
}
async function close(){if(node){await save();await node.app.close();node=undefined;}}
async function request(method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:Record<string,unknown>){
  assert.ok(!url.endsWith('/publish'),'This journey must never confirm or publish a card');
  const response=await node!.app.inject({method,url,headers:{authorization:'Bearer '+token,'x-mote-ingress-version':'2'},...(payload===undefined?{}:{payload})});
  assert.ok(response.statusCode>=200&&response.statusCode<300,`${method} ${url}: ${response.statusCode} ${response.body}`);return response.json();
}
async function ingest(record:z.infer<typeof recordSchema>){
  const document={contentRole:'authored',recordedAt:record.at},payload={externalId:record.key,revision:sha256(JSON.stringify([record.sha256,document])),observedAt:new Date().toISOString(),kind:'message',layer:'original',text:record.text,document};
  const ack=await request('PUT',`/api/sources/${sourceId}/items`,payload),duplicate=await request('PUT',`/api/sources/${sourceId}/items`,payload);assert.equal(duplicate.id,ack.id);assert.equal(duplicate.duplicate,true);
  for(let attempt=0;attempt<20;attempt++)if(await node!.materialOrganizer.tick(100)===0)break;
  const material=node!.materials.get(materialId(sourceId,record.key));assert.ok(material&&node!.materialMemoryWork.readyForMemory(material.ref));
  const ids=node!.materials.evidenceIds(material.ref),evidence=node!.memories.readEvidence(ids);assert.equal(evidence.length,1);assert.equal(JSON.parse(evidence[0].ocrText).text,record.text);
  const saved={...record,id:ack.id,materialRef:material.ref,evidenceIds:ids,formalTextSha256:sha256(evidence[0].ocrText)};report.records.push(saved);await save();return saved;
}
async function extract(key:string,evidenceIds:string[]){
  const job=await request('POST','/api/memory-jobs',{evidenceIds,recipes:[{id:'mote.personal-memory',version:'2'}],contextTime:fixture.contextTime,timeZone:'Asia/Shanghai'});report.steps[key]={jobId:job.id,startedAt:new Date().toISOString()};await save();
  const done=await node!.memoryPipeline.run(job.id);report.steps[key].job=done;await save();return done;
}
function cardsFor(key:string){const record=report.records.find((item:any)=>item.key===key);assert.ok(record);return report.memories.filter((m:Memory)=>m.admission?.layer==='memory'&&m.status!=='stale'&&!m.supersededBy&&m.evidenceIds.some(id=>record.evidenceIds.includes(id))) as Memory[];}
function verifyCards(){
  for(const memory of report.memories as Memory[]){assert.equal(memory.status,'published','Every committed, internally reviewed Memory must be effective without confirmation');assert.ok(memory.reviewReceipt||memory.model==='owner');for(const span of memory.evidence??[]){const original=node!.memories.readEvidence([span.id])[0];assert.ok(original);assert.equal(original.ocrText.slice(span.offset!,span.offset!+span.length!),span.quote);}}
}
async function ask(questionId:string){
  const question=fixture.questions.find(item=>item.id===questionId)!;assert.ok(question);const before=new Set(receipts().map(item=>item.id));
  const entry:Record<string,any>={id:questionId,question:question.text,status:'running',startedAt:new Date().toISOString()};report.questions.push(entry);await save();progress('ask-start',{id:questionId});
  try{const response=await node!.app.inject({method:'POST',url:'/api/query',headers:{authorization:'Bearer '+token},payload:{question:question.text,timeZone:'Asia/Shanghai'}});entry.httpStatus=response.statusCode;entry.response=response.json();assert.equal(response.statusCode,200,response.body);assert.equal(entry.response.modelSelection.model,'gpt-6-sol');assert.equal(entry.response.usage.status,'completed');assert.ok(entry.response.citations.length>0,'A supported answer must retain citations');entry.status='completed';await writeFile(join(directory,questionId+'.md'),entry.response.answer+'\n',{mode:0o600});}
  catch(error){entry.status='failed';entry.failure=error instanceof Error?error.message:String(error);throw error;}
  finally{entry.durationMs=Date.now()-Date.parse(entry.startedAt);const items=receipts().filter(item=>!before.has(item.id));entry.usage={total:usageTotals(items),items};await save();}
}
async function run(){try{
  report.status='running';await save();const catalog=await codexModels(undefined,{executable:config.codexBin,home:config.codexHome});report.catalog=catalog.items.find(item=>item.id==='gpt-6-sol');assert.ok(report.catalog?.reasoningEfforts?.includes('max'));
  await open();
  if(!resume){
    await request('POST','/api/sources',{id:sourceId,name:'Generated effective Memory regression',kind:'custom',deviceId:sourceId,platform:'import',retention:'archive'});
    for(const record of fixture.initialRecords)await ingest(record);
    if(preflight){assert.equal(report.calls.length,0);assert.equal(receipts().length,0);report.status='preflight-passed';return;}
    const first=await extract('initial',report.records.flatMap((record:any)=>record.evidenceIds));
    assert.equal(first.status,'failed','The deliberate interruption must produce a failed checkpoint');assert.ok(report.injectedReviewFailure);assert.equal(report.memories.length,0,'An unreviewed draft must not become current Memory');
    const draftRows=node!.store.db.prepare('SELECT input_hash,json FROM memory_extraction_drafts ORDER BY batch_id').all();assert.ok(draftRows.length);report.steps.recovery={before:first,draftHashes:draftRows.map(row=>sha256(String(row.json))),extractionCallsBefore:report.calls.filter((call:any)=>call.phase==='extract').length};
    await close();await open();assert.equal(node!.memoryPipeline.get(first.id).status,'failed');
    const recovered=await node!.memoryPipeline.retry(first.id);report.steps.recovery.after=recovered;assert.equal(recovered.status,'completed');assert.equal(report.calls.filter((call:any)=>call.phase==='extract').length,report.steps.recovery.extractionCallsBefore,'Retry must reuse the valid extraction draft across restart');
    await save();verifyCards();for(const key of ['current-workflow','training-detail','old-interest'])assert.ok(cardsFor(key).length>0,`Missing useful generated fixture Memory: ${key}`);
    report.steps.recovery.passed=true;report.steps.automatic={noConfirmation:true,committedMemoryCount:report.memories.length};await save();
    await ask('current-and-details');report.status='core-passed';await save();
  }
  if(full){
    const prior=cardsFor(fixture.correction.ofKey);assert.equal(prior.length,1,'Inspect fragmented workflow output before choosing a correction target');
    const unchanged=cardsFor('training-detail').map(memory=>JSON.stringify(memory)),old=prior[0];
    const correction=await request('POST',`/api/memories/${old.id}/correct`,{version:old.version,title:fixture.correction.title,statement:fixture.correction.statement,validFrom:fixture.correction.validFrom});assert.equal(correction.status,'published');assert.equal(node!.memories.get(old.id).supersededBy,correction.id);
    report.steps.correction={old:node!.memories.get(old.id),current:correction};await save();assert.deepEqual(cardsFor('training-detail').map(memory=>JSON.stringify(memory)),unchanged);await ask('corrected-current-history');await ask('attribution-and-conflict');
    const removed=cardsFor('old-interest');assert.ok(removed.length>0);for(const memory of removed)await request('DELETE',`/api/memories/${memory.id}`);report.steps.deletion={deleted:removed};
    const original=fixture.initialRecords.find(record=>record.key==='old-interest')!,duplicate=await ingest({...original,key:'old-interest-reimport'});
    const replay=await extract('deleted-old-replay',duplicate.evidenceIds);assert.equal(replay.status,'completed');await save();assert.equal(cardsFor('old-interest-reimport').length,0,'A transport identity change must not resurrect the deleted conclusion from the same old evidence');
    assert.equal(sha256(node!.memories.readEvidence([report.records.find((record:any)=>record.key==='old-interest').id])[0].ocrText),original.sha256,'Deleting a Memory must preserve its original');
    const fresh=await ingest(fixture.newEvidence),reconsidered=await extract('new-evidence',fresh.evidenceIds);assert.equal(reconsidered.status,'completed');await save();
    report.steps.newEvidence={memories:cardsFor('new-interest'),semanticReviewRequired:true};verifyCards();report.status='structural-passed';
  }
}catch(error){report.status='failed';const failure={at:new Date().toISOString(),message:error instanceof Error?error.message:String(error)};report.failures.push(failure);report.failure=failure.message;process.exitCode=1;}
finally{invocation.finishedAt=new Date().toISOString();invocation.durationMs=Date.now()-invocationStarted;report.finishedAt=invocation.finishedAt;await close();await save();progress('finished',{status:report.status,report:reportPath,semanticQualityAccepted:false});}}
await run();
