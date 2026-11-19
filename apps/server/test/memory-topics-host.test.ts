import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentResponseError,AgentTimeoutError,validateHostOutput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {TOPIC_CLASSIFICATION_INSTRUCTION} from '../src/automatic-topics.js';
import {planGeneratedMemory,generatedMemoryOutput} from './fixtures/memory-planning.js';
async function fixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-topics-host-')),token='generated-topic-owner',headers={authorization:'Bearer '+token};
 const config:ConfigurationPlatformOptions={path:(directory)+'/mote.yaml',privateCredential:{token:token,tokenPath:'generated'},initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'generated-model',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false}}};
 let holdMemoryReview=false,interruptible=false,calls=0,checkTopicValidation=false,validatedTopics=0,hold:Promise<void>|undefined,entered:()=>void=()=>{},release:()=>void=()=>{};
 const topicFailures:Error[]=[];
 const dependencies:NonNullable<Parameters<typeof buildApp>[1]>={backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  if(input.question.startsWith(TOPIC_CLASSIFICATION_INSTRUCTION)){
   calls++;const records=JSON.parse(input.question.slice(TOPIC_CLASSIFICATION_INSTRUCTION.length+1));entered();
   if(hold&&interruptible)await Promise.race([hold,new Promise<void>((_resolve,reject)=>{if(input.signal?.aborted)reject(input.signal.reason);else input.signal?.addEventListener('abort',()=>reject(input.signal!.reason),{once:true});})]);else await hold;
   input.assertContextAuthority?.();
   const failure=topicFailures.shift();if(failure)throw failure;
   const answer={answer:JSON.stringify({trees:[{id:'generated',label:'Generated quiet work',nodes:[{id:'focus',label:'Focused mornings',memoryIds:records.map((record:any)=>record.id)}]}]}),citations:[],trace:[],runId:randomUUID()};
   if(checkTopicValidation){
    const invalid={...answer,answer:JSON.stringify({trees:[{id:'generated',label:'Generated navigation',nodes:[{id:'empty',label:'Empty generated node',memoryIds:[]}]}]})};
    await assert.rejects(validateHostOutput(input,invalid),error=>error instanceof AgentResponseError&&error.reason==='host_validation');
    const unknownMemory={...answer,answer:JSON.stringify({trees:[{id:'generated',label:'Generated navigation',nodes:[{id:'unknown',label:'Unknown generated member',memoryIds:[randomUUID()]}]}]})};
    await assert.rejects(validateHostOutput(input,unknownMemory),error=>error instanceof AgentResponseError&&error.reason==='host_validation');
    await validateHostOutput(input,answer);validatedTopics++;
   }
   return answer;
  }
  if(await planGeneratedMemory(input))return {answer:'Generated plan submitted.',citations:[],trace:[],runId:randomUUID()};
  if(holdMemoryReview&&input.traceContext?.phase==='review'){entered();await hold;}
  const records=await reader.evidence({ids:input.evidenceIds??[]}),record=records.find(record=>record.ocrText.includes('quiet mornings'));assert.ok(record);
  const candidate={domain:'personal',title:'Generated focus',statement:`The generated owner prefers quiet mornings [${record.id}]`,uncertainty:'Generated fixture only',admission:{layer:'memory',reason:'Explicit generated preference',scope:'Generated fixture',attribution:'user'},evidenceIds:[record.id],evidence:[{id:record.id,quote:'I prefer quiet mornings.'}]};
  return {answer:generatedMemoryOutput(input,[candidate]),citations:[{id:record.id,capturedAt:record.capturedAt,appName:record.appName,excerpt:''}],trace:[],runId:randomUUID()};
 }})};
 let node=await buildApp(config,dependencies);
 t.after(async()=>{release();await node.app.close();await rm(directory,{recursive:true,force:true});});
 const command=async(action:'on'|'off'|'stop')=>{const view=(await node.app.inject({url:'/api/model-authorization',headers})).json();const result=await node.app.inject({method:'POST',url:'/api/model-authorization/commands',headers,payload:{revision:view.authorization.revision,operationId:randomUUID(),action}});assert.equal(result.statusCode,200,result.body);};
 node.sources.register({id:'generated-topics',name:'Generated topics',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'});
 node.memoryRecipeSettings.configure({sourceId:'generated-topics',recipes:[{id:'mote.personal-memory',version:'5'}]});
 return {get node(){return node;},headers,command,get calls(){return calls;},get validatedTopics(){return validatedTopics;},checkTopicValidation(){checkTopicValidation=true;},failNextTopic(error:Error){topicFailures.push(error);},hold(canInterrupt=false,memoryReview=false){interruptible=canInterrupt;holdMemoryReview=memoryReview;let notify!:()=>void;const started=new Promise<void>(resolve=>notify=resolve);entered=notify;hold=new Promise<void>(resolve=>release=resolve);return {started,release};},
 async intake(){await node.sources.upsert('generated-topics',{externalId:randomUUID(),revision:'1',observedAt:new Date().toISOString(),kind:'message',layer:'original',text:'I prefer quiet mornings.'});await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);node.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();await node.sourcePipelines.drainMemory(node.memoryPipeline,true,100);const job=node.memoryPipeline.list()[0];assert.ok(job);return node.memoryPipeline.run(job.id);},
 async settle(){for(let i=0;i<10;i++){await node.executor.tick();const ids=node.store.db.prepare("SELECT id FROM execution_steps WHERE kind='memory.topics'").all().map(row=>String(row.id));await node.executor.drain(ids);if(ids.every(id=>!['running','waiting'].includes(node.executor.get(id)!.state)))break;}},
 async restart(){await node.app.close();node=await buildApp(config,dependencies);},
 };
}

test('actual fresh Memory publication schedules durable topics under its original admission exactly once',async t=>{
 const f=await fixture(t);await f.command('on');const done=await f.intake();assert.equal(done.status,'completed',JSON.stringify(done));await f.settle();assert.equal(f.calls,1,JSON.stringify({steps:f.node.store.db.prepare("SELECT id,kind,state,error,input FROM execution_steps WHERE kind IN ('memory.topics','memory.batch')").all(),memories:f.node.memories.list().map(row=>({id:row.id,status:row.status})),authority:f.node.store.db.prepare('SELECT * FROM background_model_step_authority').all()}));
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

test('topic output reaches the Agent repair validator before a corrected classification publishes',async t=>{
 const f=await fixture(t);f.checkTopicValidation();await f.command('on');
 const done=await f.intake();assert.equal(done.status,'completed');await f.settle();
 assert.equal(f.validatedTopics,1,'invalid topic structure and membership must be rejected within the model conversation');
 assert.equal(f.calls,1,'output repair must not require a new topic operation');
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,1);
 assert.ok(f.node.memories.list().length>0,'topic validation preserves published Memory');
 assert.match((await f.node.app.inject({url:'/api/context-trees',headers:f.headers})).body,/Generated quiet work/);
});

test('a topic model timeout retries within the original admission and only publishes once',async t=>{
 const f=await fixture(t);f.failNextTopic(new AgentTimeoutError());await f.command('on');
 const job=await f.intake();assert.equal(job.status,'completed');await f.settle();
 const [step]=f.node.executor.list({operationId:'memory:'+job.id,kind:'memory.topics'}).items;
 assert.equal(step.state,'waiting');assert.equal(step.error,'provider_timeout');assert.equal(step.attempts,1);
 const admission=f.node.modelAuthorization.stepAuthority(step.id);assert.ok(admission);
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,step.availableAt-Date.now())+10));await f.settle();
 assert.equal(f.calls,2);assert.equal(f.node.executor.get(step.id)!.state,'succeeded');
 assert.equal(f.node.modelAuthorization.stepAuthority(step.id),admission);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,1);
});

test('retrying a completed Memory job recovers its blocked topics without reopening Memory or minting authority',async t=>{
 const f=await fixture(t);f.failNextTopic(new Error('Generated topic classification failure'));await f.command('on');
 const job=await f.intake();assert.equal(job.status,'completed');await f.settle();
 const operationId='memory:'+job.id,[step]=f.node.executor.list({operationId,kind:'memory.topics'}).items;
 assert.equal(step.state,'blocked');assert.equal(step.error,'topic_classification_failed');
 const admission=f.node.modelAuthorization.stepAuthority(step.id),work=f.node.store.db.prepare('SELECT count(*) n FROM background_model_work').get()!.n;
 const path='/api/memory-jobs/'+job.id+'/retry';
 assert.equal((await f.node.app.inject({method:'POST',url:path})).statusCode,401);
 const responses=await Promise.all([1,2].map(()=>f.node.app.inject({method:'POST',url:path,headers:f.headers})));
 for(const response of responses){assert.equal(response.statusCode,202,response.body);assert.equal(response.json().status,'completed');assert.deepEqual(response.json().memoryIds,job.memoryIds);}
 await f.settle();assert.equal(f.calls,2);assert.equal(f.node.executor.get(step.id)!.state,'succeeded');
 assert.equal(f.node.modelAuthorization.stepAuthority(step.id),admission);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM background_model_work').get()!.n,work);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,1);
});

test('an explicit topic retry preserves the rest of an in-progress Memory job and respects pause',async t=>{
 const f=await fixture(t);f.failNextTopic(new Error('Generated topic classification failure'));await f.command('on');
 const job=await f.intake();await f.settle();
 const operationId='memory:'+job.id,executor=f.node.executor,[topic]=executor.list({operationId,kind:'memory.topics'}).items;
 assert.equal(topic.state,'blocked');
 const primary=executor.list({operationId,kind:'memory.batch'}).items;
 const pipeline=f.node.memoryPipeline,get=pipeline.get.bind(pipeline);
 let status:'paused'|'running'='paused';
 t.mock.method(pipeline,'get',(id:string)=>({...get(id),status}));
 const retry=t.mock.method(pipeline,'acceptRetry');
 const path='/api/memory-jobs/'+job.id+'/retry?target=topics';
 assert.equal((await f.node.app.inject({method:'POST',url:path,headers:f.headers})).statusCode,409);
 assert.equal(executor.get(topic.id)!.state,'blocked');
 status='running';
 const accepted=await f.node.app.inject({method:'POST',url:path,headers:f.headers});
 assert.equal(accepted.statusCode,202,accepted.body);assert.equal(accepted.json().status,'running');
 await f.settle();assert.equal(executor.get(topic.id)!.state,'succeeded');assert.equal(f.calls,2);
 assert.deepEqual(executor.list({operationId,kind:'memory.batch'}).items,primary);
 assert.equal(retry.mock.callCount(),0,'topic retry must not invoke the primary retry path');
});

test('stop fences a late topic result without deleting its already published Memory',async t=>{
 const f=await fixture(t);await f.command('on');const held=f.hold(),working=f.intake();await held.started;await f.command('stop');held.release();await working;await f.settle();
 assert.equal(f.calls,1);assert.ok(f.node.memories.list().length>0);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,0);
 await f.restart();await f.settle();assert.equal(f.calls,1);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,0);
});


test('interrupted topic work resumes after restart and pause with its original admission and no fresh trigger',async t=>{
 const f=await fixture(t);await f.command('on');const held=f.hold(true),working=f.intake();await held.started;await working;
 const step=f.node.store.db.prepare("SELECT id FROM execution_steps WHERE kind='memory.topics'").get()!,admission=f.node.modelAuthorization.stepAuthority(String(step.id));assert.ok(admission);
 await f.command('off');await f.restart();await f.command('on');f.node.executor.retry(String(step.id),true);held.release();await f.settle();
 assert.equal(f.calls,2);assert.equal(f.node.modelAuthorization.stepAuthority(String(step.id)),admission);
 const claims=f.node.store.db.prepare('SELECT work_id,purpose FROM background_model_trigger_claims').all();
 assert.equal(claims.length,1);assert.equal(claims[0].work_id,f.node.modelAuthorization.stepAuthority(String(step.id)));assert.match(String(claims[0].purpose),/^memory:recipe\//);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,1);
 assert.match((await f.node.app.inject({url:'/api/context-trees',headers:f.headers})).body,/Generated quiet work/);
});


test('stopping the original Memory review blocks both Memory publication and its topic dependent',async t=>{
 const f=await fixture(t);await f.command('on');const held=f.hold(false,true),working=f.intake();await held.started;await f.command('stop');held.release();
 // Model completion may be retained as an error, but neither publication is allowed.
 await f.node.executor.drain(f.node.store.db.prepare('SELECT id FROM execution_steps').all().map(row=>String(row.id)));void working.catch(()=>{});
 assert.equal(f.node.memories.list().length,0);assert.equal(f.calls,0);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='memory.topics'").get()!.n,0);
});


test('revoked original blocks the next topic send and publication while the frozen Memory body still exists',async t=>{
 const f=await fixture(t);await f.command('on');const held=f.hold(),working=f.intake();await held.started;await working;
 const original=f.node.store.db.prepare('SELECT id FROM captures LIMIT 1').get()!;f.node.store.delete(String(original.id));held.release();await f.settle();
 assert.equal(f.calls,1);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM context_topic_batches').get()!.n,0);
});
