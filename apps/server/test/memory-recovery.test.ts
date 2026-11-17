import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {authorizeFixtureModels,fixtureTopicResult} from './fixtures/model-authorization.js';
import {fixtureMemoryPlan,fixtureMemoryWorkResult} from './fixtures/memory-planning.js';

// Production owner HTTP commands, receipt/queue claims, default lifecycle and
// publication. Only model responses and completed semantic artifacts are
// generated; this suite does not exercise an external model or native device.
async function fixture(t:import('node:test').TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-memory-recovery-'));
 const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:'generated-recovery-token',tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'generated',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false}}};
 const calls:QueryInput[]=[],control:{hold?:(input:QueryInput)=>Promise<void>}={};
 let node:Awaited<ReturnType<typeof buildApp>>;
 const dependencies={backgroundWorker:false,agent:{configured:true,async close(){},async query(input:QueryInput):Promise<QueryResult>{
  const topic=fixtureTopicResult(input);if(topic)return topic;
  const plan=await fixtureMemoryPlan(input);if(plan)return plan;
  calls.push(input);await control.hold?.(input);
  const evidence=node.memories.readEvidence(input.evidenceIds!)[0],id=evidence.id;
  const candidate={domain:'personal',title:'Generated recovery observation',statement:`The generated owner finished the prototype [${id}]`,uncertainty:'Generated fixture only.',admission:{layer:'memory',reason:'Generated evidenced owner experience',scope:'Generated prototype',attribution:'user'},evidenceIds:[id],evidence:[{id,quote:evidence.ocrText.trim()}]};
  return fixtureMemoryWorkResult(input,{answer:JSON.stringify({memories:[candidate]}),citations:[{id,capturedAt:evidence.capturedAt,appName:evidence.appName,excerpt:''}],trace:[],runId:randomUUID()});
 }}};
 node=await buildApp(config,dependencies);await node.app.ready();await authorizeFixtureModels(node);
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+config.privateCredential!.token};
 const view=async()=>{const response=await node.app.inject({url:'/api/memory-spaces/default/binding',headers});assert.equal(response.statusCode,200,response.body);return response.json();};
 const command=async(kind:'pause'|'resume'|'stop',payload?:{operationId:string;expectedRevision:number})=>{
  payload??={operationId:randomUUID(),expectedRevision:(await view()).revision};
  const response=await node.app.inject({method:'POST',url:'/api/memory-spaces/default/binding/'+kind,headers,payload});assert.equal(response.statusCode,200,response.body);return {value:response.json(),payload};
 };
 const exclude=async(sourceIds:string[])=>{
  const current=(await node.app.inject({url:'/api/model-authorization',headers})).json();
  const response=await node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers,payload:{revision:current.authorization.revision,operationId:randomUUID(),action:'exclude',excludedSourceIds:sourceIds}});assert.equal(response.statusCode,200,response.body);
 };
 const add=(externalId:string)=>node.sources.upsert('generated',{externalId,revision:'1',observedAt:'2026-09-15T01:00:00Z',kind:'message',layer:'original',text:'Generated owner finished the prototype: '+externalId,document:{contentRole:'authored'}});
 const publish=async()=>{await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);};
 const queue=async()=>{const pipeline=node.memoryPipeline;await node.sourcePipelines.drainMemory({create:input=>pipeline.create(input),state:id=>pipeline.state(id),cancel:id=>pipeline.cancel(id),run:async()=>{}},true,100);await new Promise(resolve=>setImmediate(resolve));};
 const run=async()=>{await node.sourcePipelines.drainMemory(node.memoryPipeline,true,100);await Promise.all(node.memoryPipeline.list().filter(job=>['queued','running','waiting_for_model'].includes(job.status)).map(job=>node.memoryPipeline.run(job.id)));};
 const semantic=async(label:string)=>{
  const id=randomUUID(),text='Generated owner finished the prototype: '+label;
  const response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-device',deviceName:'Generated',platform:'import',capturedAt:'2026-09-15T01:00:00Z',text}});assert.equal(response.statusCode,201,response.body);
  const artifactId=randomUUID().replaceAll('-','').repeat(2);
  node.store.archive.save(artifactId,artifactId,artifactId,{kind:'semantic',text:'Generated completed interpretation: '+label,metadata:{complete:true,evidenceRanges:[{id,offset:0,length:text.length}]}},[{id,fingerprint:node.store.archive.fingerprint(id)!}],'generated','1','generated');
  return {id,artifactId};
 };
 const configureLifecycle=async()=>{const settings=node.lifecycle.settings();settings.drainWindows=2;settings.extraction.minChanges=1;settings.extraction.maxItems=1;for(const id of ['consolidation','insights','working'] as const)settings[id].enabled=false;await node.lifecycle.save({revision:node.configService.revision,settings});};
 return {get node(){return node;},calls,control,view,command,exclude,add,publish,queue,run,semantic,configureLifecycle,
  source(){node.sources.register({id:'generated',name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});node.sourcePipelines.configure('generated',{settleSeconds:0});},
  jobs:()=>node.memoryPipeline.list().map(job=>node.memoryPipeline.get(job.id)),
  async restart(){await node.app.close();node=await buildApp(config,dependencies);await node.app.ready();},
 };
}

for(const stage of ['original','ready','claimed'] as const)test(`owner pause/resume and restart recover the admitted ${stage} exactly once without granting the gap`,async t=>{
 const f=await fixture(t);f.source();const old=await f.add('before-pause');
 if(stage!=='original')await f.publish();if(stage==='claimed')await f.queue();
 const originalJob=f.jobs()[0]?.id;
 assert.equal((await f.command('pause')).value.admission.state,'draining');
 const gap=await f.add('paused-gap');
 const receipt=()=>f.node.store.db.prepare('SELECT capture_id,scope,authorized,job_id,revoked_at,binding_json FROM memory_input_authorizations ORDER BY capture_id,scope').all();
 const before=receipt();assert.ok(before.some(row=>row.capture_id===old.id&&row.authorized===1));assert.ok(before.some(row=>row.capture_id===gap.id&&row.authorized===0));
 await f.restart();assert.equal((await f.view()).admission.desired,false);
 assert.deepEqual(receipt(),before,'restart cannot reconstruct or widen authorization');
 const resumed=await f.command('resume');await f.command('resume',resumed.payload);
 await f.publish();await f.run();
 const completed=f.jobs();assert.equal(completed.length,1);assert.equal(completed[0].status,'completed');if(originalJob)assert.equal(completed[0].id,originalJob,'the claimed operation retains its identity');
 assert.equal(completed[0].memoryIds.length,1);assert.equal(f.node.memories.get(completed[0].memoryIds[0]).status,'published');assert.equal(f.calls.length,2,'one extraction and its independent review');
 assert.ok(receipt().filter(row=>row.capture_id===gap.id).every(row=>row.authorized===0&&row.job_id===null),'the paused gap has no model grant or claim');
 assert.equal((await f.add('paused-gap')).duplicate,true);await f.publish();await f.run();assert.equal(f.calls.length,2);
 const fresh=await f.add('after-resume');await f.publish();await f.run();assert.equal(f.calls.length,4);assert.equal(f.node.memories.list().length,2);
 assert.ok(receipt().some(row=>row.capture_id===fresh.id&&row.authorized===1&&row.job_id));
 await f.restart();await f.publish();await f.run();assert.equal(f.calls.length,4);assert.equal(f.jobs().length,2,'completed jobs never replay');
});

test('Memory resume retains its receipt without bypassing a current source model exclusion',async t=>{
 const f=await fixture(t);f.source();const original=await f.add('model-excluded');await f.publish();
 await f.command('pause');await f.exclude(['generated']);await f.restart();await f.command('resume');
 assert.equal(f.node.memories.readEvidence([original.id]).length,1,'ordinary original reading remains available');
 await f.publish();await f.queue();const job=f.jobs()[0];assert.ok(job);const running=f.node.memoryPipeline.run(job.id);
 try{
  const waiting=()=>f.node.store.db.prepare("SELECT state,error,attempts FROM execution_steps WHERE operation_id=? AND kind='memory.batch'").all('memory:'+job.id);
  const deadline=Date.now()+5000;while(!waiting().some(step=>step.state==='waiting'&&step.error==='background_model_authorization_required')&&Date.now()<deadline)await wait(10);
  assert.ok(waiting().some(step=>step.state==='waiting'&&step.error==='background_model_authorization_required'&&step.attempts===0),'the actual batch retains a permission wait without spending an attempt');
  const grants=f.node.store.db.prepare('SELECT authorized,revoked_at FROM memory_input_authorizations WHERE capture_id=?').all(original.id);
  assert.ok(grants.length&&grants.every(row=>row.authorized===1&&row.revoked_at===null),'ordinary pause retains the original Memory receipt');
  assert.equal(f.calls.length,0,'a Memory receipt and read permission cannot authorize model disclosure');assert.equal(f.node.memories.list().length,0);
 }finally{await f.command('stop');await running;}
});

test('ordinary pause drains an unclaimed original receipt through the production queue before resuming',async t=>{
 const f=await fixture(t);f.source();await f.add('already-authorized');await f.command('pause');await f.add('paused-gap');
 await f.restart();await f.publish();await f.run();assert.equal(f.calls.length,2);assert.equal(f.jobs().length,1);assert.equal(f.node.memories.list().length,1);
 assert.equal((await f.view()).admission.state,'paused');await f.command('resume');await f.run();assert.equal(f.calls.length,2);
});

for(const claimed of [false,true])test(`owner immediate stop revokes ${claimed?'claimed':'unclaimed'} receipts across resume and restart`,async t=>{
 const f=await fixture(t);f.source();await f.add('withdrawn');await f.publish();if(claimed)await f.queue();
 const prior=f.jobs()[0]?.id;await f.command('pause');await f.command('stop');
 const revoked=f.node.store.db.prepare('SELECT authorized,revoked_at FROM memory_input_authorizations').all();assert.ok(revoked.length&&revoked.every(row=>row.authorized===1&&row.revoked_at!==null));
 await f.restart();await f.command('resume');await f.publish();await f.run();
 assert.equal(f.calls.length,0);assert.equal(f.node.memories.list().length,0);assert.equal(f.jobs().length,claimed?1:0);if(prior)assert.equal(f.node.memoryPipeline.get(prior).status,'cancelled');
 await f.add('fresh-after-stop');await f.publish();await f.run();assert.equal(f.calls.length,2);assert.equal(f.node.memories.list().length,1);
});

test('owner stop fences a late admitted review and restart/resume cannot publish it',async t=>{
 const f=await fixture(t);f.source();await f.add('late-review');await f.publish();await f.queue();const job=f.jobs()[0];
 let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
 f.control.hold=async input=>{if(input.traceContext?.phase==='review'){entered();await held;}};
 const running=f.run();await reached;
 try{await f.command('pause');await f.command('stop');}finally{release();await running;f.control.hold=undefined;}
 assert.equal(f.node.memoryPipeline.get(job.id).status,'cancelled');assert.equal(f.node.memories.list().length,0);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM memory_publications').get()!.n,0);
 await f.restart();await f.command('resume');await f.run();assert.equal(f.calls.length,2);assert.equal(f.node.memories.list().length,0);
});

test('owner resume preserves the default admitted extraction round through restart and publishes only its exact prefix',async t=>{
 const f=await fixture(t);await f.configureLifecycle();const first=await f.semantic('first'),second=await f.semantic('second');await f.semantic('unregistered-before-pause');
 let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
 f.control.hold=async input=>{if(f.calls.length===1){entered();await held;}};
 const running=f.node.lifecycle.tick();await reached;
 const extraction=()=>f.node.lifecycle.view().extensions.find(extension=>extension.id==='extraction')!;
 const approved=extraction().drainThrough!,window=extraction().active!;assert.ok(approved>window.through);assert.ok(window.checkpoint);
 try{await f.command('pause');await f.semantic('paused-gap');await f.command('resume');assert.equal(extraction().drainThrough,approved);assert.equal(extraction().active!.id,window.id);}finally{release();await running;f.control.hold=undefined;}
 assert.equal(f.node.memories.list().length,1);assert.equal(extraction().lastRun!.through,window.through);
 await f.restart();assert.equal(extraction().drainThrough,approved);await f.node.lifecycle.tick();await f.node.lifecycle.tick();
 assert.equal(f.calls.length,4);assert.equal(f.jobs().length,2);assert.ok(f.jobs().every(job=>job.status==='completed'&&job.memoryIds.length===1));
 const products=f.node.memories.list().map(memory=>f.node.memories.get(memory.id));assert.equal(products.length,2);assert.deepEqual(new Set(products.flatMap(memory=>memory.evidenceIds)),new Set([first.id,second.id]));
 assert.equal(extraction().lastRun!.through,approved,'the completion receipt never acknowledges skipped evidence as processed');assert.ok(extraction().cursor>approved,'unadmitted events are retired after the approved prefix');
 const fresh=await f.semantic('after-resume');await f.node.lifecycle.tick();await f.node.lifecycle.tick();assert.equal(f.calls.length,6);assert.equal(f.node.memories.list().length,3);assert.ok(f.node.memories.list().some(memory=>f.node.memories.get(memory.id).evidenceIds.includes(fresh.id)));
 await f.restart();await f.node.lifecycle.tick();assert.equal(f.calls.length,6);
});

for(const stop of [false,true])test(`owner ${stop?'stop revokes':'pause drains'} an admitted extraction round between windows across restart`,async t=>{
 const f=await fixture(t);await f.configureLifecycle();await f.semantic('first');await f.semantic('second');await f.semantic('not-admitted');await f.node.lifecycle.tick();
 const extraction=()=>f.node.lifecycle.view().extensions.find(extension=>extension.id==='extraction')!;
 assert.equal(extraction().active,undefined);assert.ok(extraction().drainThrough!>extraction().cursor);
 const paused=await f.command('pause');assert.equal(paused.value.admission.state,'draining');assert.equal(paused.value.admission.queued,1,'the finite tail remains visible without an active window');
 if(stop){await f.command('stop');assert.equal(extraction().drainThrough,undefined);}
 await f.restart();await f.node.lifecycle.tick();
 assert.equal(f.calls.length,stop?2:4);assert.equal(f.node.memories.list().length,stop?1:2);
 assert.equal((await f.view()).admission.state,'paused');
 await f.command('resume');await f.node.lifecycle.tick();assert.equal(f.calls.length,stop?2:4,'resume never turns unregistered history into a new authorization');
});
