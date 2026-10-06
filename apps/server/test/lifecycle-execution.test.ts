import {fixtureMemoryPipeline} from './fixtures/memory-result.js';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {MemoryLifecycle} from '../src/memory-lifecycle.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {InsightRuns} from '../src/insight-runs.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {WorkingMemory} from '../src/working-memory.js';
import {Conversations} from '../src/conversations.js';
import {registerMemoryExtensions} from '../src/lifecycle-extensions.js';
import {ExecutionFailure} from '../src/execution-engine.js';
import {ProviderFailure} from '@mote/shared';
import Fastify from 'fastify';
import {registerMemoryRoutes} from '../src/memory-routes.js';
import {MemoryIntegrationSettings} from '../src/memory-integration-settings.js';
import {MemoryRecipeSettings} from '../src/memory-recipe-settings.js';
function fixture(t:TestContext){const directory=mkdtempSync(join(tmpdir(),'mote-lifecycle-execution-')),store=new Store(directory),engine=new ExecutionEngine(store);const closers:(()=>Promise<unknown>)[]=[];t.after(async()=>{for(const close of closers.reverse())await close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});return {store,engine,closers};}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
function event(store:Store){store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'upsert',?)").run(randomUUID(),new Date().toISOString());}
function configure(lifecycle:MemoryLifecycle){const settings=lifecycle.settings();lifecycle.configure({...settings,extraction:{...settings.extraction,minChanges:1},insights:{...settings.insights,minChanges:1}});}

test('a cancelled lifecycle window rejects late commits and does not silently rerun',async t=>{
 const {store,engine,closers}=fixture(t),lifecycle=new MemoryLifecycle(store,()=>true,Date.now,engine),entered=deferred(),release=deferred();closers.push(()=>lifecycle.close());let calls=0;
 lifecycle.register({id:'extraction',version:'fixture',stream:'evidence',async run(_window,checkpoint,execution){calls++;assert.ok(execution);checkpoint('before-provider');entered.resolve();await release.promise;execution.commit(()=>store.db.prepare("INSERT INTO settings VALUES('late-lifecycle-result','1')").run());}});configure(lifecycle);event(store);
 const running=lifecycle.tick();await entered.promise;const active=lifecycle.view().extensions[0].active!;assert.equal(engine.get('lifecycle:'+active.id)?.operationId,active.operationId);engine.cancel('lifecycle:'+active.id);release.resolve();await running;await lifecycle.tick();
 assert.equal(calls,1);assert.equal(lifecycle.view().extensions[0].status,'cancelled');assert.equal(lifecycle.view().extensions[0].cursor,0);assert.equal(store.db.prepare("SELECT 1 FROM settings WHERE key='late-lifecycle-result'").get(),undefined);
});

test('another lifecycle host cannot replace a live checkpoint or execute the same window',async t=>{
 const {store,engine,closers}=fixture(t),first=new MemoryLifecycle(store,()=>true,Date.now,engine),otherEngine=new ExecutionEngine(store),second=new MemoryLifecycle(store,()=>true,Date.now,otherEngine),entered=deferred(),release=deferred();closers.push(()=>otherEngine.close(),()=>first.close(),()=>second.close());let secondCalls=0;
 first.register({id:'extraction',version:'fixture',stream:'evidence',async run(_window,checkpoint){checkpoint('live-child');entered.resolve();await release.promise;}});second.register({id:'extraction',version:'fixture',stream:'evidence',async run(){secondCalls++;}});configure(first);event(store);
 const running=first.tick();await entered.promise;await second.tick();assert.equal(secondCalls,0);assert.equal(second.view().extensions[0].active?.checkpoint,'live-child');release.resolve();await running;await second.tick();assert.equal(secondCalls,0);assert.equal(second.view().extensions[0].cursor,1);
});

test('shutdown preserves the replayable checkpoint and restart resumes it once',async t=>{
 const {store,engine,closers}=fixture(t),first=new MemoryLifecycle(store,()=>true,Date.now,engine),entered=deferred();let calls=0;
 first.register({id:'extraction',version:'fixture',stream:'evidence',async run(_window,checkpoint,execution){calls++;checkpoint('resume-child');entered.resolve();await new Promise<void>((_resolve,reject)=>execution!.signal.addEventListener('abort',()=>reject(Error('shutdown')),{once:true}));}});configure(first);event(store);const running=first.tick();await entered.promise;await first.close();await running;
 const active=first.view().extensions[0].active!;assert.equal(engine.get('lifecycle:'+active.id)?.state,'waiting');const next=new MemoryLifecycle(store,()=>true,Date.now,engine);closers.push(()=>next.close());next.register({id:'extraction',version:'fixture',stream:'evidence',async run(window){calls++;assert.equal(window.checkpoint,'resume-child');}});await next.tick();await next.tick();assert.equal(calls,2);assert.equal(next.view().extensions[0].cursor,1);
});

test('automatic insights use versioned snapshots and real parent-child execution receipts',async t=>{
 let now=0;const {store,engine,closers}=fixture(t),sources=new SourceStore(store),files=new FileStore(store,sources),memories=new MemoryStore(store),pipeline=fixtureMemoryPipeline({store,memories,executor:engine,configured:()=>true,model:()=> 'generated',query:async()=>{throw Error('Extraction disabled');}}),insights=new InsightRuns(store,{executor:engine}),lifecycle=new MemoryLifecycle(store,()=>true,()=>now,engine);closers.push(()=>pipeline.close(),()=>insights.close(),()=>lifecycle.close());
 sources.register({id:'fixture',name:'Generated only',kind:'custom',deviceId:'generated',platform:'import'});let calls=0;
 registerMemoryExtensions({store,files,memories,pipeline,insights,lifecycle,working:new WorkingMemory(store,new Conversations(store)),model:()=> 'generated',query:async(input,module)=>{calls++;assert.equal(module,'insights');assert.ok(input.insightSnapshot);assert.equal(input.traceContext?.operationId,'insight:'+input.insightSnapshot.id);assert.ok(store.db.prepare('SELECT 1 FROM execution_steps WHERE operation_id=? AND state=\'running\'').get(input.traceContext!.operationId!));return {runId:randomUUID(),answer:JSON.stringify({title:'Generated fixed report '+calls,markdown:'Generated fixed report '+calls,html:'<p>Generated fixed report</p>'}),citations:[],trace:[]};}});
 const settings=lifecycle.settings();lifecycle.configure({...settings,extraction:{...settings.extraction,enabled:false},consolidation:{...settings.consolidation,enabled:false},working:{...settings.working,enabled:false},insights:{...settings.insights,minChanges:1,intervalHours:1}});
 const add=async(n:number)=>{const record=await sources.upsert('fixture',{externalId:String(n),revision:'1',observedAt:'2025-02-01T00:00:30.000Z',kind:'message',layer:'original',text:'Generated late original '+n});const id=String(n).repeat(64);store.archive.save(id,id,id,{kind:'semantic',text:'Generated semantics '+n,metadata:{complete:true}},[{id:record.id,fingerprint:store.archive.fingerprint(record.id)!}],'fixture','1','fixture');};
 await add(1);await lifecycle.tick();assert.equal(calls,0,'increments alone cannot bypass the Insight interval');now+=3600000;await lifecycle.tick();assert.equal(calls,1);const first=insights.list()[0];assert.equal(first.status,'completed');const saved=JSON.stringify(insights.detail(first.id));const relation=store.db.prepare('SELECT parent_id FROM operation_parents WHERE child_id=?').get(first.operationId!);assert.ok(String(relation?.parent_id).startsWith('workflow:lifecycle:'));assert.equal(store.db.prepare('SELECT state FROM operation_progress WHERE id=?').get(String(relation!.parent_id))!.state,'succeeded');
 await add(2);now+=3600000;await lifecycle.tick();assert.equal(calls,2);const next=insights.list().find(run=>run.id!==first.id)!;assert.equal(next.snapshot!.seriesId,first.snapshot!.seriesId);assert.equal(next.snapshot!.version,2);assert.equal(next.snapshot!.previousRunId,first.id);assert.equal(JSON.stringify(insights.detail(first.id)),saved);assert.equal(store.db.prepare('SELECT count(*) n FROM insights').get()!.n,2);
});

test('a parent cancellation from another host fences the automatic insight commit',async t=>{
 let now=0;const {store,engine,closers}=fixture(t),other=new ExecutionEngine(store),sources=new SourceStore(store),files=new FileStore(store,sources),memories=new MemoryStore(store),pipeline=fixtureMemoryPipeline({store,memories,executor:engine,configured:()=>true,model:()=> 'generated',query:async()=>{throw Error('Extraction disabled');}}),insights=new InsightRuns(store,{executor:engine}),lifecycle=new MemoryLifecycle(store,()=>true,()=>now,engine);closers.push(()=>other.close(),()=>pipeline.close(),()=>insights.close(),()=>lifecycle.close());
 sources.register({id:'fixture',name:'Generated only',kind:'custom',deviceId:'generated',platform:'import'});
 registerMemoryExtensions({store,files,memories,pipeline,insights,lifecycle,working:new WorkingMemory(store,new Conversations(store)),model:()=> 'generated',query:async input=>{other.cancel('lifecycle:'+input.traceContext!.jobId);assert.equal(input.signal!.aborted,false,'Other host has only revoked the durable fence');return {runId:randomUUID(),answer:JSON.stringify({title:'Late generated report',markdown:'Late generated report must not publish',html:'<p>Late generated report must not publish</p>'}),citations:[],trace:[]};}});
 const settings=lifecycle.settings();lifecycle.configure({...settings,extraction:{...settings.extraction,enabled:false},consolidation:{...settings.consolidation,enabled:false},working:{...settings.working,enabled:false},insights:{...settings.insights,minChanges:1,intervalHours:1}});
 const record=await sources.upsert('fixture',{externalId:'one',revision:'1',observedAt:'2025-02-01T00:00:30.000Z',kind:'message',layer:'original',text:'Generated only'}),id='f'.repeat(64);store.archive.save(id,id,id,{kind:'semantic',text:'Generated semantics',metadata:{complete:true}},[{id:record.id,fingerprint:store.archive.fingerprint(record.id)!}],'fixture','1','fixture');now+=3600000;await lifecycle.tick();assert.equal(store.db.prepare('SELECT count(*) n FROM insights').get()!.n,0);assert.equal(insights.list()[0].status,'failed');assert.equal(lifecycle.view().extensions.find(e=>e.id==='insights')!.status,'cancelled');
});

test('manual lifecycle work has bounded attempts, explicit retry and cancellation without advancing automatic history',async t=>{
 const {store,engine,closers}=fixture(t);let now=0,calls=0,fail=true;const lifecycle=new MemoryLifecycle(store,()=>true,()=>now,engine);closers.push(()=>lifecycle.close());
 lifecycle.register({id:'consolidation',version:'fixture',maxAttempts:3,stream:'memory',async run(window,checkpoint){calls++;assert.equal(window.manual,true);if(fail)throw Error('Generated failure');checkpoint('done');}});
 const s=lifecycle.settings();lifecycle.configure({...s,consolidation:{...s.consolidation,enabled:false}});
 const id=lifecycle.request('consolidation',[randomUUID()],'initial');
 for(let i=0;i<3;i++){await lifecycle.tick();now+=3600000;}
 assert.equal(calls,3);assert.equal(lifecycle.view().extensions[0].status,'failed');assert.equal(lifecycle.view().extensions[0].retryAt,undefined);await lifecycle.tick();assert.equal(calls,3);
 lifecycle.cancel('consolidation',id);await lifecycle.tick();assert.equal(calls,3);assert.equal(lifecycle.view().extensions[0].status,'cancelled');
 fail=false;lifecycle.retry('consolidation',id);await lifecycle.tick();assert.equal(calls,4);assert.equal(lifecycle.view().extensions[0].active,undefined);assert.equal(lifecycle.view().extensions[0].cursor,0);
});

test('legacy artifact extraction stops after three failed provider turns across restart and resumes only on explicit retry',async t=>{
 const {store,engine,closers}=fixture(t),sources=new SourceStore(store),files=new FileStore(store,sources),memories=new MemoryStore(store),working=new WorkingMemory(store,new Conversations(store));
 sources.register({id:'generated-lifecycle',name:'Generated lifecycle source',kind:'custom',deviceId:'fixture',platform:'import'});
 const content='Generated artifact extraction input.',record=await sources.upsert('generated-lifecycle',{externalId:'one',revision:'1',observedAt:'2026-09-27T00:00:00Z',kind:'message',layer:'original',text:content});
 const artifactId='e'.repeat(64);store.archive.save(artifactId,artifactId,artifactId,{kind:'semantic',text:'Generated interpretation',metadata:{complete:true,evidenceRanges:[{id:record.id,offset:0,length:content.length}]}},[{id:record.id,fingerprint:store.archive.fingerprint(record.id)!}],'fixture','1','fixture');
 let now=Date.now(),calls=0,fail=true;
 const pipeline=fixtureMemoryPipeline({store,memories,executor:engine,configured:()=>true,model:()=> 'generated',query:async()=>{calls++;if(fail)throw new ProviderFailure({category:'permanent',code:'generated_provider_failure'});return {runId:randomUUID(),answer:'{"memories":[]}',citations:[],trace:[]};}});closers.push(()=>pipeline.close());
 const register=(lifecycle:MemoryLifecycle)=>{
   registerMemoryExtensions({store,files,memories,pipeline,working,lifecycle,model:()=> 'generated',query:async()=>{throw Error('Unexpected integration query');},semanticArtifacts:async ids=>ids});
   const settings=lifecycle.settings();for(const id of ['consolidation','insights','working'] as const)settings[id].enabled=false;settings.extraction.minChanges=1;lifecycle.configure(settings);
 };
 let lifecycle=new MemoryLifecycle(store,()=>true,()=>now,engine);register(lifecycle);await lifecycle.tick();
 const first=lifecycle.view().extensions.find(e=>e.id==='extraction')!;assert.equal(calls,1);assert.equal(first.failures,1);assert.equal(first.maxAttempts,3);assert.equal(first.cursor,0);assert.ok(first.active?.checkpoint);
 await lifecycle.close();lifecycle=new MemoryLifecycle(store,()=>true,()=>now,engine);closers.push(()=>lifecycle.close());register(lifecycle);
 assert.equal(lifecycle.view().extensions.find(e=>e.id==='extraction')!.failures,1,'failure count survives a host restart');
 for(let attempt=2;attempt<=3;attempt++){now+=3600000;await lifecycle.tick();assert.equal(calls,attempt);assert.equal(lifecycle.view().extensions.find(e=>e.id==='extraction')!.failures,attempt);}
 const exhausted=lifecycle.view().extensions.find(e=>e.id==='extraction')!;assert.equal(exhausted.status,'failed');assert.equal(exhausted.retryAt,undefined);assert.equal(exhausted.cursor,0);
 now+=86400000;await lifecycle.tick();await lifecycle.tick();assert.equal(calls,3,'automatic ticks cannot purchase a fourth provider turn');
 const app=Fastify();closers.push(()=>app.close());registerMemoryRoutes(app,{store,files,memories,memoryPipeline:pipeline,lifecycle,memoryIntegrationSettings:new MemoryIntegrationSettings(store,pipeline.strategies),memoryRecipeSettings:new MemoryRecipeSettings(store,pipeline.strategies),evidenceReader:{} as never,modelSettings:{} as never,query:async()=>{throw Error('Unexpected query');},reviewExtraction:async(_input,result)=>result});
 const status=await app.inject({method:'GET',url:'/api/memory-settings'});assert.equal(status.statusCode,200);assert.equal(status.json().extensions.find((item:{id:string})=>item.id==='extraction').status,'failed','the API must not mask the terminal lifecycle state with a child job status');
 const stale=await app.inject({method:'POST',url:'/api/memory-settings/extraction/'+randomUUID()+'/retry'});assert.equal(stale.statusCode,409);assert.equal(calls,3);
 fail=false;const resumed=await app.inject({method:'POST',url:'/api/memory-settings/extraction/'+exhausted.active!.id+'/retry'});assert.equal(resumed.statusCode,202);await lifecycle.tick();assert.equal(calls,4);assert.equal(lifecycle.view().extensions.find(e=>e.id==='extraction')!.active,undefined);
});

test('legacy extraction waits for semantic dependencies without spending failure attempts',async t=>{
 const {store,engine,closers}=fixture(t),sources=new SourceStore(store),files=new FileStore(store,sources),memories=new MemoryStore(store),working=new WorkingMemory(store,new Conversations(store));
 sources.register({id:'generated-wait',name:'Generated wait source',kind:'custom',deviceId:'fixture',platform:'import'});
 const content='Generated waiting input.',record=await sources.upsert('generated-wait',{externalId:'one',revision:'1',observedAt:'2026-09-27T00:00:00Z',kind:'message',layer:'original',text:content});
 const artifactId='d'.repeat(64);store.archive.save(artifactId,artifactId,artifactId,{kind:'semantic',text:'Generated interpretation',metadata:{complete:true,evidenceRanges:[{id:record.id,offset:0,length:content.length}]}},[{id:record.id,fingerprint:store.archive.fingerprint(record.id)!}],'fixture','1','fixture');
 let now=Date.now(),checks=0,calls=0,modelReady=false;
 const pipeline=fixtureMemoryPipeline({store,memories,executor:engine,configured:()=>modelReady,model:()=> 'generated',query:async()=>{calls++;return {runId:randomUUID(),answer:'{"memories":[]}',citations:[],trace:[]};}});closers.push(()=>pipeline.close());
 const lifecycle=new MemoryLifecycle(store,()=>true,()=>now);closers.push(()=>lifecycle.close());
 registerMemoryExtensions({store,files,memories,pipeline,working,lifecycle,model:()=> 'generated',query:async()=>{throw Error('Unexpected integration query');},semanticArtifacts:async ids=>{checks++;if(checks<3)throw new ExecutionFailure('waiting','semantic_processing_pending',60000);return ids;}});
 const settings=lifecycle.settings();for(const id of ['consolidation','insights','working'] as const)settings[id].enabled=false;settings.extraction.minChanges=1;lifecycle.configure(settings);
 for(let i=0;i<2;i++){await lifecycle.tick();const state=lifecycle.view().extensions.find(e=>e.id==='extraction')!;assert.equal(state.failures,0);assert.equal(state.error,'semantic_processing_pending');assert.equal(state.status,'retry_wait');assert.equal(calls,0);now+=60000;}
 await lifecycle.tick();assert.equal(checks,3);assert.equal(calls,0);assert.equal(lifecycle.view().extensions.find(e=>e.id==='extraction')!.failures,0,'model admission is also not a provider failure');
 modelReady=true;now+=60000;await lifecycle.tick();assert.equal(calls,1);assert.equal(lifecycle.view().extensions.find(e=>e.id==='extraction')!.failures,0);
});
