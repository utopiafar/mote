import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {TOPIC_CLASSIFICATION_INSTRUCTION} from '../src/automatic-topics.js';
import {planGeneratedMemory,generatedMemoryOutput} from './fixtures/memory-planning.js';
async function fixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-topics-host-')),token='generated-topic-owner',headers={authorization:'Bearer '+token};
 const config:Config={dataDir:directory,token,tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let holdMemoryReview=false,interruptible=false,calls=0,hold:Promise<void>|undefined,entered:()=>void=()=>{},release:()=>void=()=>{};
 const dependencies:NonNullable<Parameters<typeof buildApp>[1]>={backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  if(input.question.startsWith(TOPIC_CLASSIFICATION_INSTRUCTION)){
   calls++;const records=JSON.parse(input.question.slice(TOPIC_CLASSIFICATION_INSTRUCTION.length+1));entered();
   if(hold&&interruptible)await Promise.race([hold,new Promise<void>((_resolve,reject)=>{if(input.signal?.aborted)reject(input.signal.reason);else input.signal?.addEventListener('abort',()=>reject(input.signal!.reason),{once:true});})]);else await hold;
   input.assertContextAuthority?.();
   return {answer:JSON.stringify({trees:[{id:'generated',label:'Generated quiet work',nodes:[{id:'focus',label:'Focused mornings',memoryIds:records.map((record:any)=>record.id)}]}]}),citations:[],trace:[],runId:randomUUID()};
  }
  if(await planGeneratedMemory(input))return {answer:'Generated plan submitted.',citations:[],trace:[],runId:randomUUID()};
  if(holdMemoryReview&&input.traceContext?.phase==='review'){entered();await hold;}
  const records=await reader.evidence({ids:input.evidenceIds??[]}),record=records.find(record=>record.ocrText.includes('quiet mornings'));assert.ok(record);
  const candidate={domain:'personal',title:'Generated focus',statement:`The generated owner prefers quiet mornings [${record.id}]`,uncertainty:'Generated fixture only',admission:{layer:'memory',reason:'Explicit generated preference',scope:'Generated fixture',attribution:'user'},evidenceIds:[record.id],evidence:[{id:record.id,quote:'I prefer quiet mornings.'}]};
  return {answer:generatedMemoryOutput(input,[candidate]),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:''}],trace:[],runId:randomUUID()};
 }})};
 let node=await buildApp(config,dependencies);
 t.after(async()=>{release();await node.app.close();await rm(directory,{recursive:true,force:true});});
 const command=async(action:'authorize'|'stop'|'pause')=>{const view=(await node.app.inject({url:'/api/model-authorization',headers})).json();const result=await node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers,payload:{revision:view.authorization.revision,operationId:randomUUID(),action,...(action==='authorize'?{connections:view.connections,scope:{sourceIds:['generated-topics'],dataKinds:['text']}}:{})}});assert.equal(result.statusCode,200,result.body);};
 node.sources.register({id:'generated-topics',name:'Generated topics',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'});
 node.memoryRecipeSettings.configure({sourceId:'generated-topics',recipes:[{id:'mote.personal-memory',version:'5'}]});
 return {get node(){return node;},headers,command,get calls(){return calls;},hold(canInterrupt=false,memoryReview=false){interruptible=canInterrupt;holdMemoryReview=memoryReview;let notify!:()=>void;const started=new Promise<void>(resolve=>notify=resolve);entered=notify;hold=new Promise<void>(resolve=>release=resolve);return {started,release};},
 async intake(){await node.sources.upsert('generated-topics',{externalId:randomUUID(),revision:'1',observedAt:new Date().toISOString(),kind:'message',layer:'original',text:'I prefer quiet mornings.'});await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();await node.sourcePipelines.drainMemory(node.memoryPipeline,true,100);const job=node.memoryPipeline.list()[0];assert.ok(job);return node.memoryPipeline.run(job.id);},
 async settle(){for(let i=0;i<10;i++){await node.executor.tick();const ids=node.store.db.prepare("SELECT id FROM execution_steps WHERE kind='memory.topics'").all().map(row=>String(row.id));await node.executor.drain(ids);if(ids.every(id=>!['running','waiting'].includes(node.executor.get(id)!.state)))break;}},
 async restart(){await node.app.close();node=await buildApp(config,dependencies);},
 };
}

test('actual fresh Memory publication schedules durable topics under its original admission exactly once',async t=>{
 const f=await fixture(t);await f.command('authorize');const done=await f.intake();assert.equal(done.status,'completed',JSON.stringify(done));await f.settle();assert.equal(f.calls,1,JSON.stringify({steps:f.node.store.db.prepare("SELECT id,kind,state,error,input FROM execution_steps WHERE kind IN ('memory.topics','memory.batch')").all(),memories:f.node.memories.list().map(row=>({id:row.id,status:row.status})),authority:f.node.store.db.prepare('SELECT * FROM background_model_step_authority').all()}));
 const step=f.node.store.db.prepare("SELECT id,input FROM execution_steps WHERE kind='memory.topics'").get()!;assert.ok(step);
 const parent=JSON.parse(String(step.input)).parentId;
 assert.equal(f.node.modelAuthorization.stepAuthority(String(step.id)),f.node.modelAuthorization.stepAuthority(parent));
 const claims=f.node.store.db.prepare('SELECT work_id,purpose FROM background_model_trigger_claims').all();
 assert.equal(claims.length,1);assert.equal(claims[0].work_id,f.node.modelAuthorization.stepAuthority(String(step.id)));assert.match(String(claims[0].purpose),/^memory:recipe\//);
 const before=f.node.memories.list().length;
 const catalog=await f.node.app.inject({url:'/api/context-trees',headers:f.headers});assert.equal(catalog.statusCode,200,catalog.body);assert.match(catalog.body,/Generated quiet work/);
 await f.restart();await f.settle();assert.equal(f.calls,1);assert.equal(f.node.memories.list().length,before);
 assert.match((await f.node.app.inject({url:'/api/context-trees',headers:f.headers})).body,/Generated quiet work/);
});

test('stop fences a late topic result without deleting its already published Memory',async t=>{
 const f=await fixture(t);await f.command('authorize');const held=f.hold(),working=f.intake();await held.started;await f.command('stop');held.release();await working;await f.settle();
 assert.equal(f.calls,1);assert.ok(f.node.memories.list().length>0);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,0);
 await f.restart();await f.settle();assert.equal(f.calls,1);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,0);
});


test('interrupted topic work resumes after restart and pause with its original admission and no fresh trigger',async t=>{
 const f=await fixture(t);await f.command('authorize');const held=f.hold(true),working=f.intake();await held.started;await working;
 const step=f.node.store.db.prepare("SELECT id FROM execution_steps WHERE kind='memory.topics'").get()!,admission=f.node.modelAuthorization.stepAuthority(String(step.id));assert.ok(admission);
 await f.command('pause');await f.restart();held.release();await f.settle();
 assert.equal(f.calls,2);assert.equal(f.node.modelAuthorization.stepAuthority(String(step.id)),admission);
 const claims=f.node.store.db.prepare('SELECT work_id,purpose FROM background_model_trigger_claims').all();
 assert.equal(claims.length,1);assert.equal(claims[0].work_id,f.node.modelAuthorization.stepAuthority(String(step.id)));assert.match(String(claims[0].purpose),/^memory:recipe\//);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,1);
 assert.match((await f.node.app.inject({url:'/api/context-trees',headers:f.headers})).body,/Generated quiet work/);
});


test('stopping the original Memory review blocks both Memory publication and its topic dependent',async t=>{
 const f=await fixture(t);await f.command('authorize');const held=f.hold(false,true),working=f.intake();await held.started;await f.command('stop');held.release();
 // Model completion may be retained as an error, but neither publication is allowed.
 await f.node.executor.drain(f.node.store.db.prepare('SELECT id FROM execution_steps').all().map(row=>String(row.id)));void working.catch(()=>{});
 assert.equal(f.node.memories.list().length,0);assert.equal(f.calls,0);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='memory.topics'").get()!.n,0);
});


test('revoked original blocks the next topic send and publication while the frozen Memory body still exists',async t=>{
 const f=await fixture(t);await f.command('authorize');const held=f.hold(),working=f.intake();await held.started;await working;
 const original=f.node.store.db.prepare('SELECT id FROM captures LIMIT 1').get()!;f.node.store.delete(String(original.id));held.release();await f.settle();
 assert.equal(f.calls,1);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,0);
});
