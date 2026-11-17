import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import type {QueryInput} from '@mote/agent';
import {ProviderFailure,type QueryResult,type OperationDetail} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {agentModelConnection} from '../src/model-authorization-host.js';
import {SINGLE_PASS_PERSONAL_RECIPE} from '../src/memory-range-selection-policy.js';
import {authorizeFixtureModels,fixtureTopicResult} from './fixtures/model-authorization.js';
import {fixtureMemoryPlan,fixtureMemoryWorkResult} from './fixtures/memory-planning.js';

const reviewed={id:'mote.personal-memory',version:'5'};
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};};
async function until(check:()=>boolean,tick?:()=>Promise<unknown>){const end=Date.now()+10000;while(Date.now()<end){if(check())return;await tick?.();await wait(10);}assert.fail('Generated Memory consumer did not reach its expected state');}

// Only semantic responses are generated. Owner HTTP, the registered planner,
// receipt claims, queue, shared Engine, private stages and publication are real.
async function fixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-memory-task-consumer-'));
 const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:'generated-memory-consumer-owner',tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,dataKey:'64'.repeat(32),contentEncryptionEnabled:true,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'generated',baseUrl:'https://generated.invalid',apiKey:'generated-unused',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false}}};
 const headers={authorization:'Bearer '+config.privateCredential!.token},calls:QueryInput[]=[],releases:Array<()=>void>=[],control:{hold?:(input:QueryInput)=>Promise<void>;failReview?:boolean}={};
 let node:Awaited<ReturnType<typeof buildApp>>;
 const build=()=>buildApp(config,{backgroundWorker:false,agent:{configured:true,async close(){},async query(input:QueryInput):Promise<QueryResult>{
  const topic=fixtureTopicResult(input);if(topic)return topic;
  calls.push(input);const plan=await fixtureMemoryPlan(input);if(plan)return plan;
  if(!['extract','review'].includes(input.traceContext?.phase??'')){
   if(input.question.startsWith('Generated cancelled manual batch')||input.question.startsWith('Generated retained manual batch'))await control.hold?.(input);
   return {answer:'Generated independent manual result',runId:randomUUID(),citations:[],trace:[],evidenceDependencies:{version:1,complete:true,ids:[...(input.contextEvidenceDependencies?.ids??[])]}};
  }
  const evidence=node.memories.readEvidence(input.evidenceIds!)[0],id=evidence.id;
  const value={domain:'personal',contextPriority:'standing',title:'Generated scoped preference',statement:`The generated owner prefers this prototype's explicit retry policy [${id}]`,uncertainty:'Generated claim remains limited to this source and time.',admission:{layer:'memory',reason:'Generated explicit owner preference',scope:'Generated prototype only',attribution:'user'},evidenceIds:[id],evidence:[{id,quote:evidence.ocrText.trim()}]};
  await control.hold?.(input);
  if(input.traceContext?.phase==='review'&&control.failReview)throw new ProviderFailure({category:'permanent',code:'generated_review_failure'});
  return fixtureMemoryWorkResult(input,{answer:JSON.stringify({memories:[value]}),runId:randomUUID(),citations:[{id,capturedAt:evidence.capturedAt,appName:evidence.appName,excerpt:''}],trace:[]});
 }}});
 node=await build();await node.app.ready();await authorizeFixtureModels(node);
 t.after(async()=>{for(const release of releases)release();await node.app.close();await rm(directory,{recursive:true,force:true});});
 const post=async(url:string,payload:unknown={},status=200)=>{const response=await node.app.inject({method:'POST',url,headers,payload});assert.equal(response.statusCode,status,response.body);return response.json();};
 const detail=async(id:string)=>{const response=await node.app.inject({url:'/api/operations/'+encodeURIComponent(id)+'?limit=100',headers});assert.equal(response.statusCode,200,response.body);return response.json<OperationDetail>();};
 const jobs=()=>node.memoryPipeline.list().map(job=>node.memoryPipeline.get(job.id));
 const tick=async()=>{await node.sourcePipelines.drainMemory(node.memoryPipeline,true);await node.delegation.tick();};
 const originals:string[]=[];
 const inputs=async(sourceIds:readonly string[]=['generated-direct','generated-reviewed'])=>{
  for(const [sourceId,recipe] of [['generated-direct',SINGLE_PASS_PERSONAL_RECIPE],['generated-reviewed',reviewed]] as const){
   if(!sourceIds.includes(sourceId))continue;
   node.sources.register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});node.sourcePipelines.configure(sourceId,{settleSeconds:0});
   const selected=await node.app.inject({method:'PUT',url:'/api/memory-recipe-settings',headers,payload:{sourceId,recipes:[recipe]}});assert.equal(selected.statusCode,200,selected.body);
   const received=await node.sources.upsert(sourceId,{externalId:'generated-original',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated explicit retry preference for '+sourceId,document:{contentRole:'authored'}});originals.push(received.id);
  }
  await node.materialOrganizer.tick(10);await node.sourcePipelines.tick(10);
 };
 const plan=async(dispatch=true,expectedInputs=2)=>{
  const catalog=node.materialMemoryWork.catalog();assert.equal(catalog.length,expectedInputs);
  const configuration=node.memoryPipeline.modelSnapshot().configuration,evidenceIds=node.memoryPipeline.evidenceDependencies(catalog.flatMap(candidate=>node.materialMemoryWork.planningEvidence(candidate.materialId,candidate.scope)));
  // Use the installed coordinator's real typed admission; no fabricated plan,
  // unit, step, grant or result row is inserted by this fixture.
  const id='memory-plan:'+randomUUID();node.delegation.start({id,operationId:id,profileId:'memory.plan',goal:'Plan and process this authorized input catalog',input:{catalog,configuration,evidenceIds},scope:{contextTime:catalog.map(candidate=>candidate.contextTime).sort().at(-1)},allowedCapabilities:['memory.package']});
  await node.delegation.waitForPlan(id);if(dispatch)await tick();return node.delegation.get(id);
 };
 const membership=(id:string)=>node.store.db.prepare('SELECT step_id,active,optional,slot,generation FROM execution_operation_steps WHERE operation_id=? ORDER BY step_id').all(id);
 const manual=(question:string)=>{const profile=node.modelSettings.select('chat');return node.batchProcessing.submit({operationId:'workflow:'+randomUUID(),requestId:randomUUID(),items:[{question,evidenceIds:[originals[0]]}]},{kind:'manual',identities:[],connections:[agentModelConnection({kind:'profile',id:profile.id},profile.settings)]});};
 const memoryCommand=async(kind:'pause'|'resume'|'stop')=>{const current=(await node.app.inject({url:'/api/memory-spaces/default/binding',headers})).json();return post('/api/memory-spaces/default/binding/'+kind,{expectedRevision:current.revision,operationId:randomUUID()});};
 return {get node(){return node;},calls,control,originals,post,detail,jobs,tick,inputs,plan,membership,manual,memoryCommand,
  gate(){const value=gate();releases.push(value.release);return value;},
  count:(phase:string)=>calls.filter(input=>input.traceContext?.phase===phase).length,
  async restart(){await node.app.close();node=await build();await node.app.ready();},
 };
}

test('owner operation progress recovers real Memory children, preserves recipe decisions and retries only the failed review',async t=>{
 const f=await fixture(t);await f.inputs();f.control.failReview=true;const owner=await f.plan();
 await until(()=>f.jobs().some(job=>job.status==='failed')&&f.jobs().some(job=>job.status==='completed')&&f.node.delegation.get(owner.id).status==='failed',f.tick).catch(error=>{t.diagnostic(JSON.stringify({jobs:f.jobs().map(job=>({id:job.id,status:job.status,error:job.errorCode,batches:job.batches.map(batch=>({status:batch.status,error:batch.errorCode}))})),owner:f.node.delegation.get(owner.id).status,phases:f.calls.map(input=>input.traceContext?.phase)}));throw error;});
 const done=f.jobs().find(job=>job.status==='completed')!,failed=f.jobs().find(job=>job.status==='failed')!;
 assert.equal(done.batches[0].reviewReceipt!.decision,'not_required');assert.equal(done.batches[0].strategy!.review,null);assert.equal(f.count('planning'),1);assert.equal(f.count('extract'),2);assert.equal(f.count('review'),1);
 const progress=await f.detail(owner.operationId);assert.equal(progress.operation.state,'failed');assert.equal(progress.steps.filter(step=>step.kind==='memory.batch').length,2);
 assert.ok(f.node.store.db.prepare("SELECT state,attempts FROM execution_steps WHERE kind='memory.package-status' AND operation_id=?").all('memory:'+failed.id).every(step=>step.state==='blocked'&&step.attempts===0),'observing a failed product consumes no control invocation');
 const saved={batch:f.node.store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(done.batches[0].id)!.json,phases:f.node.store.db.prepare('SELECT * FROM memory_phase_outputs WHERE batch_id=? ORDER BY phase').all(done.batches[0].id),membership:f.membership(owner.operationId)};
 assert.match(String(saved.batch),/"private":"aes:/,'the completed product body stays in its encrypted domain storage');
 const publication=f.node.memories.get(done.memoryIds[0]);assert.equal(publication.contextPriority,'standing');assert.equal(publication.uncertainty,'Generated claim remains limited to this source and time.');
 await f.restart();await f.tick();assert.deepEqual(f.membership(owner.operationId),saved.membership);assert.equal((await f.detail(owner.operationId)).operation.total,progress.operation.total);
 f.control.failReview=false;await f.post('/api/memory-jobs/'+failed.id+'/retry',{},202);
 await until(()=>f.jobs().every(job=>job.status==='completed')&&f.node.delegation.get(owner.id).status==='succeeded',f.tick).catch(error=>{throw new Error(JSON.stringify({jobs:f.jobs().map(job=>({status:job.status,error:job.errorCode})),owner:f.node.delegation.get(owner.id).status,steps:f.node.store.db.prepare("SELECT kind,state,error FROM execution_steps WHERE kind='memory.package-status'").all()}),{cause:error});});
 const complete=await f.detail(owner.operationId);assert.equal(complete.operation.state,'succeeded');assert.equal(f.count('planning'),1);assert.equal(f.count('extract'),2);assert.equal(f.count('review'),2,'the valid failed-job extraction is reused too');
 assert.deepEqual(f.node.store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(done.batches[0].id)!.json,saved.batch);assert.deepEqual(f.node.store.db.prepare('SELECT * FROM memory_phase_outputs WHERE batch_id=? ORDER BY phase').all(done.batches[0].id),saved.phases);
 assert.deepEqual(f.node.memories.get(publication.id),publication);assert.equal(f.node.memories.list().length,2);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,2);
 const links=f.membership(owner.operationId);for(let replay=0;replay<3;replay++)await f.tick();assert.deepEqual(f.membership(owner.operationId),links);
 assert.equal(f.node.store.db.prepare('WITH RECURSIVE links(parent_id,child_id) AS (SELECT parent_id,child_id FROM operation_parents UNION SELECT l.parent_id,p.child_id FROM links l JOIN operation_parents p ON p.parent_id=l.child_id) SELECT 1 FROM links WHERE parent_id=child_id LIMIT 1').get(),undefined);
 await f.restart();await f.tick();assert.equal((await f.detail(owner.operationId)).operation.total,complete.operation.total);assert.equal(f.node.memories.list().length,2);assert.equal(f.count('extract'),2);assert.equal(f.count('review'),2);
});

test('Memory parent cancellation and unrelated manual batch cancellation remain independent despite shared execution membership',async t=>{
 const f=await fixture(t);await f.inputs();const memory=f.gate(),manual=f.gate();
 f.control.hold=async input=>{if(['extract','review'].includes(input.traceContext?.phase??'')){if(f.node.memoryPipeline.get(input.traceContext!.jobId!).recipes![0].id===reviewed.id)await memory.promise;}else await manual.promise;};
 const owner=await f.plan();await until(()=>f.count('extract')===2&&f.node.delegation.get(owner.id).units.some(unit=>unit.status==='succeeded'),f.tick);
 const completed=f.jobs().find(job=>job.status==='completed')!,product=f.node.memories.get(completed.memoryIds[0]);
 const first=f.manual('Generated cancelled manual batch');await until(()=>f.node.batchProcessing.progress(first.id).items[0].state==='running');
 f.node.batchProcessing.cancel(first.id);manual.release();await until(()=>f.node.batchProcessing.progress(first.id).task.state==='cancelled');
 assert.equal(f.jobs().filter(job=>job.status==='running').length,1);assert.equal((await f.detail(owner.operationId)).operation.state,'running');
 const second=f.manual('Generated retained manual batch');await until(()=>f.node.batchProcessing.progress(second.id).items[0].state==='running');
 f.node.delegation.cancel(owner.id);memory.release();await until(()=>f.jobs().some(job=>job.status==='cancelled')&&f.node.batchProcessing.progress(second.id).task.state==='succeeded',f.tick);
 assert.equal(f.node.batchProcessing.progress(second.id).task.state,'succeeded');assert.equal(f.node.batchProcessing.result(second.id)!.answer,'Generated independent manual result');assert.equal(f.node.batchProcessing.progress(first.id).task.state,'cancelled');
 assert.notEqual((await f.detail(owner.operationId)).operation.state,'succeeded');assert.equal(f.node.memories.list().length,1);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1);assert.deepEqual(f.node.memories.get(product.id),product);
 const automatic=f.count('extract');await f.restart();await f.tick();assert.equal(f.jobs().filter(job=>job.status==='cancelled').length,1);assert.equal(f.node.memoryPipeline.get(completed.id).status,'completed');assert.equal(f.count('extract'),automatic);assert.equal(f.node.memories.list().length,1);assert.equal(f.node.batchProcessing.progress(second.id).task.state,'succeeded');
});

test('linked Memory work retains pause authority while immediate stop withdraws grants and cannot revive the paused gap',async t=>{
 const f=await fixture(t);await f.inputs();const hold=f.gate();f.control.hold=async input=>{if(f.node.memoryPipeline.get(input.traceContext!.jobId!).recipes![0].id===reviewed.id)await hold.promise;};
 const owner=await f.plan();await until(()=>f.count('extract')===2&&f.jobs().some(job=>job.status==='completed'),f.tick);
 const product=f.node.memories.get(f.jobs().find(job=>job.status==='completed')!.memoryIds[0]);
 await f.memoryCommand('pause');
 const gap=await f.node.sources.upsert('generated-reviewed',{externalId:'paused-gap',revision:'1',observedAt:'2026-10-02T00:00:00Z',kind:'message',layer:'original',text:'Generated paused input',document:{contentRole:'authored'}});
 assert.ok(f.node.store.db.prepare('SELECT authorized FROM memory_input_authorizations WHERE capture_id=?').all(gap.id).every(row=>row.authorized===0));
 assert.equal(f.jobs().filter(job=>job.status==='running').length,1);assert.equal((await f.detail(owner.operationId)).operation.state,'running');
 await f.memoryCommand('stop');hold.release();f.control.hold=undefined;
 await until(()=>f.jobs().some(job=>job.status==='cancelled'),f.tick);assert.equal(f.node.memories.list().length,1);assert.deepEqual(f.node.memories.get(product.id),product);
 const grants=f.node.store.db.prepare('SELECT authorized,revoked_at,job_id FROM memory_input_authorizations WHERE capture_id!=?').all(gap.id);assert.ok(grants.every(row=>row.authorized===1&&row.revoked_at!==null&&row.job_id));
 await f.restart();await f.memoryCommand('resume');await f.node.materialOrganizer.tick(10);await f.node.sourcePipelines.tick(10);await f.tick();
 assert.equal(f.jobs().length,2);assert.equal(f.count('extract'),2);assert.equal(f.count('review'),0);assert.equal(f.node.memories.list().length,1);assert.notEqual((await f.detail(owner.operationId)).operation.state,'succeeded');
 assert.ok(f.node.store.db.prepare('SELECT authorized,job_id FROM memory_input_authorizations WHERE capture_id=?').all(gap.id).every(row=>row.authorized===0&&row.job_id===null));
});

test('owner stop after a rolled-back product link remains terminal across Host restart without relinking a revoked claim',async t=>{
 const f=await fixture(t);await f.inputs(['generated-reviewed']);const owner=await f.plan(false,1);
 f.node.store.db.exec("CREATE TEMP TRIGGER generated_stopped_product_link_failure BEFORE INSERT ON main.operation_parents BEGIN SELECT RAISE(ABORT,'Generated stopped product link failure'); END");
 await assert.rejects(f.tick(),/Generated stopped product link failure/);
 const job=f.jobs()[0];assert.equal(f.jobs().length,1);assert.equal(job.status,'queued');
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='memory.package-status'").get()!.n,0);
 await f.memoryCommand('stop');
 const stopped=f.node.memoryPipeline.get(job.id);assert.equal(stopped.status,'cancelled');assert.equal(stopped.cancellationCause,'authority');
 const claims=f.node.store.db.prepare('SELECT source_id,input_key,scope,authorized,job_id,revoked_at FROM memory_input_authorizations ORDER BY source_id,input_key,scope').all();
 assert.equal(claims.length,1);assert.ok(claims.every(row=>row.job_id===job.id&&row.authorized===1&&row.revoked_at!==null));
 assert.equal(f.node.delegation.get(owner.id).units[0].status,'waiting','the failed handoff has no product status step to propagate cancellation');
 assert.equal(f.count('extract'),0);assert.equal(f.count('review'),0);
 await f.restart();
 for(let replay=0;replay<3;replay++)await f.tick();
 assert.equal(f.node.delegation.get(owner.id).units[0].status,'cancelled');assert.equal(f.node.delegation.get(owner.id).status,'failed');
 const progress=await f.detail(owner.operationId),unit=f.node.delegation.get(owner.id).units[0];
 assert.equal(progress.operation.state,'cancelled','the public parent must retain its required product cancellation');assert.equal(progress.operation.counts.cancelled,1);assert.equal(progress.operation.total,2);
 const cancelled=progress.steps.find(step=>step.id===unit.stepId)!;assert.ok(cancelled);assert.equal(cancelled.kind,'delegation.unit.memory.package');assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.attempts,0);assert.equal(cancelled.current,true);assert.equal(cancelled.optional,undefined);
 assert.equal(f.node.modelAuthorization.stepAuthority(unit.stepId),undefined,'the cancellation fact has no model grant');
 const members=f.membership(owner.operationId);for(let replay=0;replay<3;replay++)await f.tick();assert.deepEqual(f.membership(owner.operationId),members);
 assert.equal(f.node.memoryPipeline.get(job.id).cancellationCause,'authority','observing product withdrawal cannot escalate it to owner cancellation');
 assert.deepEqual(f.node.store.db.prepare('SELECT source_id,input_key,scope,authorized,job_id,revoked_at FROM memory_input_authorizations ORDER BY source_id,input_key,scope').all(),claims);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='memory.package-status'").get()!.n,0);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM operation_parents WHERE parent_id=?').get(owner.operationId)!.n,0);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);assert.equal(f.node.memories.list().length,0);
 assert.equal(f.count('planning'),1);assert.equal(f.count('extract'),0);assert.equal(f.count('review'),0);
 await f.post('/api/memory-jobs/'+job.id+'/retry',{},409);
 await f.restart();await f.tick();assert.equal(f.jobs().length,1);assert.equal(f.node.delegation.get(owner.id).units[0].status,'cancelled');assert.equal(f.count('extract'),0);
 assert.equal((await f.detail(owner.operationId)).operation.state,'cancelled');assert.deepEqual(f.membership(owner.operationId),members);
});
