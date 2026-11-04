import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {HostPluginContext} from '@mote/plugin-host';
import {activityConfigurationSchema,type ActivityConfiguration} from '../src/activity-configuration.js';
import type {ConfigService} from '../src/config-service.js';
import {ServerDiagnostics} from '../src/diagnostics.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionHandler} from '../src/execution-engine.js';
import {MaterialStore} from '../src/materials.js';
import {Operations} from '../src/operations.js';
import {Store} from '../src/store.js';
import {UsageLedger} from '../src/usage.js';
import {createActivityServices,createActivityServicesFactory,activityServicesContribution,type ActivityServicesDependencies} from '../src/plugins/activity-services.js';

const at='2026-11-04T10:00:00.000Z';
const profile='generated-activity-profile',model='generated-activity-model';
function screen(id=randomUUID(),text='Generated visible screen evidence'){
  return {id,deviceId:'generated-device',deviceName:'Generated device',platform:'android',capturedAt:at,durationMs:1000,source:'screen',appId:'generated.app',appName:'Generated app',ocrText:text,windowTitle:'',privacy:{collection:'content'},metadata:{version:1,observedAt:at}};
}
function configuration(initial:Partial<ActivityConfiguration>={}):ConfigService {
  let value=activityConfigurationSchema.parse({enabled:true,modelProfileId:profile,...initial}),revision=4;
  return {
    get revision(){return revision;},
    current:(id:string)=>{if(id!=='activity')throw Error('Unexpected configuration domain');return structuredClone(value);},
    setHandler:()=>{},
    replace:async(id:string,next:ActivityConfiguration)=>{
      if(id!=='activity')throw Error('Unexpected configuration domain');
      value=activityConfigurationSchema.parse(next);revision++;return structuredClone(value);
    },
  } as unknown as ConfigService;
}
function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-activity-services-')),store=new Store(directory),engine=new ExecutionEngine(store),operations=new Operations(store),materials=new MaterialStore(store);
  const counts={registrations:0,releases:0};
  const register=engine.register.bind(engine);
  engine.register=(handler:ExecutionHandler)=>{counts.registrations++;const release=register(handler);return async()=>{await release();counts.releases++;};};
  t.after(async()=>{await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,engine,operations,materials,counts};
}
function dependencies(f:ReturnType<typeof fixture>,calls:QueryInput[],options:{during?:()=>Promise<void>}={}):ActivityServicesDependencies{
  return {
    store:f.store,operations:f.operations,materials:f.materials,executor:f.engine,config:configuration(),isCollector:()=>false,pollIntervalMs:60_000,
    agentView:{
      archiveReader:{} as unknown as ContextReader,
      diagnostics:{snapshot:()=>({lastSeq:0,agentTrace:{enabled:false}}),events:()=>({items:[],nextSeq:0,oldestSeq:null})},
      evidenceReader:{artifact:()=>undefined},
    },
    options:{
      query:async(input:QueryInput):Promise<QueryResult>=>{
        calls.push(input);await options.during?.();
        const records=f.store.evidence(input.evidenceIds??[]);
        return {answer:JSON.stringify({activities:records.map(record=>({existingActivityId:null,title:'Generated observation',statement:record.ocrText,uncertainty:'Generated fixture only',evidence:[{id:record.id,quote:record.ocrText,offset:0,source:'text'}]})),coverage:'complete',limitation:'Generated fixture only'}),
          citations:records.map(record=>({id:record.id,capturedAt:record.capturedAt,appName:record.appName??'Generated app',excerpt:record.ocrText})),trace:[],runId:randomUUID()};
      },
      selection:()=>({owner:'models',fingerprint:'generated-activity-fingerprint',revision:4,profileId:profile,provider:'generated-provider',model,configured:true}),
      lane:()=>({enabled:true,concurrency:1}),
    },
  };
}
function services(f:ReturnType<typeof fixture>,calls:QueryInput[],options:{during?:()=>Promise<void>}={}){
  return createActivityServices(dependencies(f,calls,options));
}
test('repeated stop and start keeps one poll, one handler and one set of durable activity tasks',async t=>{
  const f=fixture(t),calls:QueryInput[]=[],service=services(f,calls);
  const originalSetInterval=globalThis.setInterval,originalClearInterval=globalThis.clearInterval,polls=new Set<ReturnType<typeof setInterval>>();
  let timers=0,cleared=0;
  globalThis.setInterval=((handler:TimerHandler,timeout?:number,...args:unknown[])=>{const handle=originalSetInterval(handler,timeout,...args);if(timeout===60_000){timers++;polls.add(handle);}return handle;}) as typeof setInterval;
  globalThis.clearInterval=((handle:ReturnType<typeof setInterval>)=>{if(polls.delete(handle))cleared++;return originalClearInterval(handle);}) as typeof clearInterval;
  t.after(()=>{globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval;});
  service.prepare();service.start();service.start();
  assert.equal(timers,1,'an active start never creates a second poll');
  assert.equal(f.counts.registrations,1);
  const app=Fastify();app.setErrorHandler((error,_request,reply)=>reply.code(error.name==='ZodError'?400:(error as {statusCode?:number}).statusCode??500).send({error:error.message}));t.after(()=>app.close());
  service.routes(app);service.agentViewRoutes(app);await app.ready();
  assert.equal((await app.inject({url:'/api/work-activity'})).statusCode,200);
  assert.equal((await app.inject({url:'/api/processing/activity'})).statusCode,200);
  assert.equal((await app.inject({url:'/api/agent-view/runs'})).statusCode,200,'the Agent view is part of the activity route table');
  const first=screen();await f.store.ingest(first);
  const steps=()=>Number(f.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='activity.understand'").get()!.n);
  assert.equal(steps(),1);
  await service.tick();assert.equal(calls.length,1);assert.equal(f.materials.list({kind:'mote.activity'}).items.length,1);
  service.quiesce('shutdown');
  assert.equal(cleared,1,'quiesce stops the poll');
  assert.equal((await app.inject({url:'/api/work-activity'})).statusCode,503);
  assert.equal((await app.inject({url:'/api/agent-view/runs'})).statusCode,503);
  assert.equal((await app.inject({method:'PUT',url:'/api/processing/activity',payload:{revision:4,settings:{enabled:true,modelProfileId:profile}}})).statusCode,503);
  const ignored=screen();await f.store.ingest(ignored);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM activity_intake_receipts WHERE capture_id=?').get(ignored.id)!.n,0,'quiesce stops prospective admission');
  await service.stop('disabled');
  assert.equal(f.counts.registrations,1);assert.equal(f.counts.releases,1,'stop unregisters the automatic-activity handler');
  service.start();
  assert.equal(f.counts.registrations,2);assert.equal(f.counts.releases,1);
  assert.equal(timers,2,'a fresh activation starts exactly one replacement poll');
  assert.equal((await app.inject({url:'/api/work-activity'})).statusCode,200,'the same route table resumes without remounting');
  assert.equal((await app.inject({url:'/api/agent-view/runs'})).statusCode,200,'the Agent view resumes on the same activity activation');
  assert.equal((await app.inject({method:'PUT',url:'/api/processing/activity',payload:{revision:4,settings:{enabled:true,modelProfileId:profile}}})).statusCode,200);
  const second=screen();await f.store.ingest(second);
  assert.equal(steps(),2,'only the new capture adds a durable activity task');
  await service.tick();assert.equal(calls.length,2);
  await service.close();
  assert.equal(f.counts.releases,2);assert.equal(cleared,2);
});
test('stopping the plugin prevents a late automatic-activity analysis from publishing',async t=>{
  const f=fixture(t),calls:QueryInput[]=[];
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),blocked=new Promise<void>(resolve=>release=resolve);
  const service=services(f,calls,{during:async()=>{entered();await blocked;}});
  service.prepare();service.start();await f.store.ingest(screen());
  const ticking=service.tick();await started;
  const stopping=service.stop('disabled');release();
  await Promise.allSettled([ticking,stopping]);
  assert.equal(calls.length,1);
  assert.equal(f.materials.list({kind:'mote.activity'}).items.length,0,'a stopped activation cannot publish a late result');
  await service.close();
});
test('the activity projection reads the exact operation, attempt and usage receipts produced for the same work',async t=>{
  const f=fixture(t),calls:QueryInput[]=[],service=services(f,calls),startedAt=Date.now();
  service.prepare();service.start();
  let executions=0;
  const handler:ExecutionHandler={kind:'fixture.processing',pool:'fixture.processing',concurrency:()=>1,policy:{timeoutMs:null,maxAttempts:2,maxRecoveryWindowMs:null},validate:()=>true,
    execute:async()=>{executions++;if(executions===1)throw new ExecutionFailure('transient','fixture_retry');return {generated:true};},commit:()=>{},classify:error=>error instanceof ExecutionFailure?error:new ExecutionFailure('permanent','fixture_failed')};
  f.engine.register(handler);
  const operationId='workflow:generated-operation',stepId=f.engine.enqueue(operationId,'fixture.processing',{jobId:'generated-job'});
  await f.engine.drain([stepId]);
  assert.equal(f.engine.get(stepId)!.attempts,1);
  f.store.db.prepare('UPDATE execution_steps SET available_at=0 WHERE id=?').run(stepId);
  await f.engine.drain([stepId]);
  const step=f.engine.get(stepId)!;
  assert.equal(step.state,'succeeded');assert.equal(step.attempts,2);
  const operation=f.operations.detail(operationId,0,5);
  assert.equal(operation.operation.id,operationId);assert.equal(operation.steps[0]?.attempts,2);
  const activity=service.activity.detail(operationId);
  assert.equal(activity.id,operation.operation.id);
  assert.equal(activity.kind,operation.operation.kind);
  assert.equal(activity.state,'completed');
  assert.deepEqual(activity.technical.operationIds,[operation.operation.id]);
  assert.equal(activity.createdAt,new Date(operation.operation.createdAt).toISOString());
  assert.equal(activity.updatedAt,new Date(operation.operation.updatedAt).toISOString());
  assert.ok(Date.parse(activity.createdAt)>=startedAt-1000&&Date.parse(activity.updatedAt)>=Date.parse(activity.createdAt));
  const usage=new UsageLedger(f.store),meter=usage.start('generated-provider',model,'fixture',{operationId:operation.operation.id,agentId:'fixture',moduleId:'fixture',skillId:null});
  meter.update({requests:1,reportedRequests:1,inputTokens:3,outputTokens:2,totalTokens:5,cacheReadTokens:0,cacheWriteTokens:0});
  const receipt=meter.finish('completed'),measured=usage.operation(activity.technical.operationIds[0],activity.createdAt,activity.updatedAt);
  assert.equal(measured.items.length,1);
  assert.equal(measured.items[0]?.id,receipt.id);
  assert.equal(measured.items[0]?.attribution?.operationId,activity.technical.operationIds[0]);
  assert.equal(measured.modelDurationMs,receipt.durationMs);
  await service.close();
});
test('the Agent view reads only actual execution traces with status, time, metering and complete pagination',async t=>{
  const f=fixture(t),calls:QueryInput[]=[],directory=mkdtempSync(join(tmpdir(),'mote-agent-view-services-'));
  const diagnostics=new ServerDiagnostics({directory,traceEnabled:true});
  t.after(async()=>{await diagnostics.close();rmSync(directory,{recursive:true,force:true});});
  await diagnostics.init();
  const base=dependencies(f,calls),service=createActivityServices({...base,agentView:{...base.agentView,diagnostics}});
  service.prepare();service.start();
  const app=Fastify();app.setErrorHandler((error,_request,reply)=>reply.code(error.name==='ZodError'?400:(error as {statusCode?:number}).statusCode??500).send({error:error.message}));
  t.after(()=>app.close());service.agentViewRoutes(app);await app.ready();
  // A declared execution step that has not run is not a recorded Agent run.
  f.engine.register({kind:'fixture.declared',pool:'fixture.declared',concurrency:()=>1,validate:()=>true,execute:async()=>({generated:true}),commit:()=>{}});
  f.engine.enqueue('workflow:generated-declared','fixture.declared',{generated:true});
  assert.deepEqual((await app.inject({url:'/api/agent-view/runs'})).json().items,[]);
  // The real execution emits the same trace shape the query assembly forwards.
  const runId=randomUUID();
  f.engine.register({kind:'fixture.agent-view',pool:'fixture.agent-view',concurrency:()=>1,validate:()=>true,execute:async()=>{
    diagnostics.agentTrace({type:'run.started',runId,payload:{model:'generated-model',provider:'generated-provider'}});
    for(let index=0;index<100;index++)diagnostics.agentTrace({type:'tool.completed',runId,tool:'evidence',status:'succeeded',durationMs:index,payload:{index}});
    diagnostics.agentTrace({type:'model.completed',runId,status:'succeeded',durationMs:42.5,payload:{response:'Generated answer'}});
    diagnostics.agentTrace({type:'run.completed',runId,status:'succeeded',payload:{citations:[]}});
    diagnostics.record('queue.snapshot',{queueDepth:0});
    return {generated:true};
  },commit:()=>{}});
  const stepId=f.engine.enqueue('query:generated-agent-view','fixture.agent-view',{generated:true});
  await f.engine.drain([stepId]);
  const runsResponse=await app.inject({url:'/api/agent-view/runs'});assert.equal(runsResponse.statusCode,200,runsResponse.body);
  const runs=runsResponse.json();
  assert.deepEqual(runs.items.map((run:{runId:string})=>run.runId),[runId],'only the executed run is listed, not the waiting step');
  assert.match(runs.items[0].at,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(runs.items[0].firstSeq>0);assert.equal(runs.recording.enabled,true);
  type Event={seq:number;at:string;trace:{type:string;status?:string;durationMs?:number}};
  const seen:Event[]=[];let afterSeq=0,pages=0;
  for(let page=0;page<5;page++){
    const response=await app.inject({url:'/api/agent-view/events?runId='+encodeURIComponent(runId)+'&afterSeq='+afterSeq});assert.equal(response.statusCode,200,response.body);
    const body=response.json() as {items:Event[];nextSeq:number};seen.push(...body.items);pages++;
    if(body.nextSeq<=afterSeq)break;afterSeq=body.nextSeq;
  }
  assert.ok(pages>1,'the retained run spans more than one bounded page');
  assert.equal(seen.length,103,'every actual trace event is reachable across bounded pages');
  assert.equal(new Set(seen.map(event=>event.seq)).size,103);
  assert.deepEqual(seen.map(event=>event.seq),[...seen.map(event=>event.seq)].sort((a,b)=>a-b));
  assert.ok(seen.every(event=>/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.at)));
  const model=seen.find(event=>event.trace.type==='model.completed')!;
  assert.equal(model.trace.status,'succeeded');assert.equal(model.trace.durationMs,42.5);
  assert.equal(seen.find(event=>event.trace.type==='run.completed')!.trace.status,'succeeded');
  assert.equal((await app.inject({url:'/api/agent-view/events?afterSeq=-1'})).statusCode,400,'invalid pagination is a visible error branch');
  await service.close();
});
test('the host factory owns the same activity service and defers its disposal',async t=>{
  const f=fixture(t),calls:QueryInput[]=[],deferred:Array<()=>unknown>=[];
  assert.equal(activityServicesContribution.id,'activity-services');
  const lifecycle=createActivityServicesFactory(dependencies(f,calls))({scope:{defer:(dispose:()=>unknown)=>deferred.push(dispose)}} as unknown as HostPluginContext);
  lifecycle.prepare();lifecycle.start();
  const app=Fastify();t.after(()=>app.close());lifecycle.routes(app);lifecycle.agentViewRoutes(app);await app.ready();
  assert.equal((await app.inject({url:'/api/work-activity'})).statusCode,200);
  assert.equal((await app.inject({url:'/api/agent-view/runs'})).statusCode,200);
  await lifecycle.dispose();
  assert.equal(deferred.length,1);
  assert.equal((await app.inject({url:'/api/work-activity'})).statusCode,503,'disposing the activation fences the mounted route');
  assert.equal((await app.inject({url:'/api/agent-view/runs'})).statusCode,503,'the Agent view shares the same activation fence');
});
