import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {estimateSerializedTokens,type QueryInput} from '@mote/agent';
import {feedQuerySchema,fileCoverageSchema,onboardingStartResultSchema,onboardingViewSchema,type QueryResult,type QueryScope} from '@mote/shared';
import {EvidenceStore as Store,StoreError} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {BackgroundModelAuthorization,modelConnection} from '../src/background-model-authorization.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {BatchProcessing} from '../src/batch-processing.js';
import {AssistantFollowup} from '../src/assistant-followup.js';
import {AssistantOnboarding} from '../src/assistant-onboarding.js';
import {registerAssistantOnboardingRoutes} from '../src/assistant-onboarding-routes.js';
import {AssistantCards} from '../src/assistant-cards.js';
import {AssistantMatters} from '../src/assistant-matters.js';
import {AssistantCommitments} from '../src/assistant-commitments.js';
import {AssistantNotifications} from '../src/assistant-notifications.js';
import {notificationSettingsSchema} from '../src/notification-configuration.js';
import {reviewMemory} from '../src/memory-review.js';
import {fixtureMemoryPipeline,fixtureMemoryResult} from './fixtures/memory-result.js';
import type {MemoryPipelineQuery} from '../src/memory-pipeline.js';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';

const all:QueryScope={kind:'all'},headers={authorization:'Bearer generated-onboarding-owner'};
const at='2020-01-02T00:00:00Z';
const now='2020-01-31T00:00:00Z';
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(done=>{release=done;});return {promise,release};};
type Context={materials:{ref:string;title:string;origin:{sourceId:string}}[];originals:{id:string;offset:number;quote:string}[];cards:{id:string}[];memories:{statement:string}[]};
const empty=(input:QueryInput,answer:string):QueryResult=>({answer,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[...(input.contextEvidenceDependencies?.ids??input.evidenceIds??[])]}});

/** Real SQLite, owner HTTP command, Memory executor, batch and card store.
 * Only the two model boundaries are controlled. No real profile is opened. */
async function fixture(t:TestContext,options:{noSuggestions?:boolean;observations?:boolean;feed?:boolean;unreviewedMemory?:boolean}={}){
 t.mock.timers.enable({apis:['Date'],now:new Date(now)});
 const directory=mkdtempSync(join(tmpdir(),'mote-onboarding-'));
 const calls:{kind:'memory'|'assistant';ids:string[];sourceIds:string[]}[]=[],contexts:Context[]=[];
 const connection=modelConnection('generated-32k-model',{window:32000});
 let modelHold:{kind:'memory'|'assistant';entered:ReturnType<typeof gate>;release:ReturnType<typeof gate>}|undefined;
 let store:Store,sources:SourceStore,materials:MaterialStore,reader:EvidenceReader,control:BackgroundModelAuthorization,engine:ExecutionEngine;
 let memory:ReturnType<typeof fixtureMemoryPipeline>,batch:BatchProcessing,followup:AssistantFollowup,onboarding:AssistantOnboarding,cards:AssistantCards,app:ReturnType<typeof Fastify>;
 let modelFailure:unknown;
 const model=async(input:QueryInput,kind:'memory'|'assistant')=>{
  control.assertCurrent(connection);
  assert.ok(estimateSerializedTokens({question:input.question,context:input.taskContext,evidence:reader.memories.readEvidence(input.evidenceIds??[])}).tokens+4000<=32000,
   'generated request and reserve fit the declared fixture window');
  calls.push({kind,ids:[...(input.evidenceIds??[])],sourceIds:[...new Set(reader.memories.readEvidence(input.evidenceIds??[]).map(record=>record.provenance?.sourceId??''))]});
  const hold=modelHold;if(hold?.kind===kind){modelHold=undefined;hold.entered.release();await hold.release.promise;}
  if(kind==='memory'){
   const id=input.evidenceIds![0],record=reader.memories.readEvidence([id])[0];
   const lines=options.observations?record.ocrText.split('\n'):[record.ocrText];
   const memories=lines.map((line,index)=>({title:'Generated bounded fact '+index,statement:`${line} [${id}]`,uncertainty:'Generated evidence only',evidenceIds:[id],
    ...(options.observations?{admission:{layer:'observation',reason:'Generated context to recall',scope:'This generated fixture only',attribution:'observed'},evidence:[{id,quote:line}]}:{})}));
   const result=empty(input,JSON.stringify({memories}));
   result.citations=[{id,capturedAt:record.capturedAt,appName:'Generated',excerpt:record.ocrText}];
   return fixtureMemoryResult(reader.memories,result,input.evidenceRanges,input);
  }
  const context=input.taskContext as unknown as Context;assert.ok(context?.materials);contexts.push(context);
  if(options.noSuggestions)return empty(input,JSON.stringify({reason:'Generated current original was reviewed; no supported new help.',cards:[],commitments:[]}));
  const original=context.originals[0];assert.ok(original,'A14 receives an actual original');
  const card={action:'new',cardId:null,relatedCardIds:[],title:context.materials[0].title,
   body:'Generated useful follow-up based on the selected original.',reason:'Generated explicit fixture interpretation.',evidence:[original],matterId:null};
  return empty(input,JSON.stringify({reason:'Generated historical review with original time preserved.',
   cards:[card],activities:options.feed?[{...card,title:'Generated source update'}]:[]}));
 };
 const start=async()=>{
  store=new Store(directory,{dataKey:'43'.repeat(32),contentEncryptionEnabled:true});sources=new SourceStore(store);materials=new MaterialStore(store);
  reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials);cards=new AssistantCards(store,reader);
  control=new BackgroundModelAuthorization(store,()=>[connection]);engine=new ExecutionEngine(store);engine.bindModelAuthority(control);
  const assertCurrent=(ids:readonly string[])=>{if(!reader.contextDependenciesAllowed(ids))throw new StoreError('Generated evidence changed',409);};
  const memoryQuery=async(input:MemoryPipelineQuery)=>{try{return await model(input,'memory');}catch(error){modelFailure=error;throw error;}};
  memory=fixtureMemoryPipeline({store,memories:reader.memories,executor:engine,models:{configured:()=>true,model:()=> 'generated-32k'},
   admission:{materialInput:(ref,required)=>materials.input(ref,required),materialAllowedForMemory:(ref,_profile,required)=>reader.materialAllowedForMemory(ref,undefined,required),
    materialRequirements:()=>['source-body'],evidenceAllowedForMemory:id=>reader.contextDependenciesAllowed([id])},
   phases:{query:memoryQuery,...(!options.unreviewedMemory?{review:(input,result)=>reviewMemory(input,result,request=>memoryQuery(request as MemoryPipelineQuery))}:{})}});
  batch=new BatchProcessing(store,engine,control,async input=>{try{return await model(input,'assistant');}catch(error){modelFailure=error;throw error;}},assertCurrent,()=>control.assertCurrent(connection),()=>{},()=>undefined,()=>1,false,reader.memories,{
   assertDependencies:(id,ids)=>followup.assertBatchDependencies(id,ids),valid:()=>true,project:()=>{},commit:()=>{},
  });
  followup=new AssistantFollowup(store,materials,reader,cards,new AssistantCommitments(store,reader),new AssistantMatters(store),batch,assertCurrent);
  onboarding=new AssistantOnboarding(store,materials,reader,control,memory,followup,()=>[connection],assertCurrent,()=>['source-body']);
  onboarding.bindOutputs(batch,cards);
  app=Fastify({logger:false});app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof StoreError?error.statusCode:400).send({error:error.message}));
  registerAssistantOnboardingRoutes(app,onboarding,request=>{if(request.headers.authorization!==headers.authorization)throw new StoreError('Owner required',403);});
  await app.ready();
 };
 const close=async()=>{await onboarding.close();await app.close();await batch.close();await memory.close();await engine.close();control.close();reader.dispose();store.close();};
 const releaseHeldModels:Array<()=>void>=[];
 await start();t.after(async()=>{for(const release of releaseHeldModels)release();await close();rmSync(directory,{recursive:true,force:true});});
 const publish=(sourceId:string,captureId:string,text:string,state:'ready'|'pending'|'failed'='ready')=>{
  const capture=store.evidenceMetadata([captureId])[0],externalId=capture.provenance!.externalId,observedAt=capture.capturedAt;
  const id=materialId(sourceId,externalId),previous=materials.get(id);
  return materials.publish({id,kind:'mote.message',schemaVersion:1,title:'Generated '+sourceId,origin:{sourceId,externalId,deviceId:'generated',firstAt:observedAt,lastAt:observedAt},
   members:[{id:'original',kind:'capture',ref:'capture:'+captureId}],blocks:state==='ready'?[{id:'body',kind:'text',format:'plain',text,memberIds:['original']}]:[],
   artifacts:[{key:'source-body',state:state==='ready'?'ready':'pending',blockIds:state==='ready'?['body']:[]},{key:'extracted-text',state,blockIds:state==='ready'?['body']:[]}],
   coverage:{state:state==='ready'?'complete':'pending'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}} satisfies MaterialDraft,{expectedRevision:previous?.revision??null});
 };
 const add=async(sourceId:string,text:string,state:'ready'|'pending'|'failed'='ready',externalId='selected',observedAt=at)=>{
  sources.register({id:sourceId,name:'Generated '+sourceId,kind:'custom',deviceId:'generated',platform:'import'});
  const capture=await sources.upsert(sourceId,{externalId,revision:'original-v1',observedAt,kind:'message',layer:'original',text});
  store.db.exec('BEGIN IMMEDIATE');control.receive('capture:'+capture.id,{sourceId},false);store.db.exec('COMMIT');
  return {id:capture.id,text,material:publish(sourceId,capture.id,text,state)};
 };
 const post=async(sources:string[],commandId?:string,days=30)=>{
  const response=await app.inject({method:'POST',url:'/api/assistant/onboarding',headers:{...headers,...(commandId?{'idempotency-key':commandId}:{})},payload:{sources,window:{days}}});
  assert.equal(response.statusCode,202,response.body);return onboardingStartResultSchema.parse(response.json());
 };
 const read=async(id:string,scope:QueryScope=all)=>onboarding.get(id,scope);
 const view=async(id:string,scope?:QueryScope)=>{
  const url=`/api/assistant/onboarding/${id}`+(scope?'?'+new URLSearchParams({scope:JSON.stringify(scope)}):'');
  const response=await app.inject({method:'GET',url,headers});
  assert.equal(response.statusCode,200,response.body);return onboardingViewSchema.parse(response.json());
 };
 const until=async(check:()=>boolean|Promise<boolean>)=>{
  const end=performance.now()+10000;
  // tick() waits for work it starts. A deliberately held provider must remain
  // in flight while this test issues cancellation, rather than deadlocking the
  // polling helper before it can observe that the provider was entered.
  while(performance.now()<end){await onboarding.tick();void engine.tick().catch(error=>{modelFailure=error;});if(modelFailure)throw modelFailure;if(await check())return;await new Promise(done=>setTimeout(done,10));}
  throw Error('Generated onboarding did not reach the expected state: '+JSON.stringify(store.db.prepare('SELECT * FROM assistant_onboarding_items').all()));
 };
 return {get store(){return store;},get sources(){return sources;},get materials(){return materials;},get cards(){return cards;},get onboarding(){return onboarding;},get reader(){return reader;},get followup(){return followup;},get memory(){return memory;},get app(){return app;},get control(){return control;},
  calls,contexts,add,publish,post,read,view,until,async restart(){await close();await start();},hold(kind:'memory'|'assistant'){const hold={kind,entered:gate(),release:gate()};modelHold=hold;releaseHeldModels.push(()=>hold.release.release());return hold;}};
}

test('two selected historical sources give a useful partial result, then resume only the late original after restart without notifications',async t=>{
 const f=await fixture(t);
 await f.add('work','Generated work requirement: prepare the release.','ready','selected','2020-01-03T00:00:00Z');
 const life=await f.add('life','Generated life requirement: confirm the trip.','pending');
 await f.onboarding.tick();assert.equal(f.calls.length,0,'synced old data without an owner start is never sent');
 const requestId=randomUUID(),run=await f.post(['work','life'],requestId);
 await f.until(async()=>{const progress=await f.read(run.id);return progress.completed===1;});
 const partial=await f.read(run.id);assert.deepEqual(partial.coverage.sync,{completed:2,total:2,reason:'selected_synced_materials_only'});
 assert.equal(partial.coverage.extraction.completed,1);assert.equal(partial.coverage.semantic.completed,1);assert.equal(partial.pending,1);
 assert.equal(partial.items[0].result?.cardIds.length,1);assert.equal(partial.items[1].coverage.extraction.status,'pending');
 for(const item of partial.items)for(const dimension of Object.values(item.coverage))fileCoverageSchema.parse(dimension);
 assert.equal(f.cards.page({scope:all}).items.length,1);assert.equal(f.reader.memories.page().items.length,1,'normal reviewed Memory publication was used');
 const repeat=await f.post(['life','work'],requestId);assert.deepEqual(repeat,run);
 const before=f.calls.length;await f.restart();f.publish('life',life.id,life.text);
 await f.until(async()=>{const progress=await f.read(run.id);return progress.completed===2;});
 const completed=await f.read(run.id);assert.equal(completed.state,'completed');assert.equal(completed.pending,0);assert.equal(completed.failed,0);
 assert.equal(f.calls.filter(call=>call.kind==='assistant').length,2);
 assert.ok(f.calls.slice(before).filter(call=>call.kind==='memory').every(call=>call.sourceIds.length===1&&call.sourceIds[0]==='life'),'completed work is not extracted again');
 assert.equal(f.cards.page({scope:all}).items.length,2);assert.equal(f.reader.memories.page().items.length,2);
 const notifications=new AssistantNotifications(f.cards,()=>notificationSettingsSchema.parse({}));assert.deepEqual(notifications.snapshot(all).items,[]);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM background_model_receipts WHERE eligible=1').get()!.n,0,'historical permission creates no automatic receipts');
 assert.ok(f.contexts.every(context=>context.materials.every(material=>material.origin.sourceId==='work'||material.origin.sourceId==='life')));
 assert.ok(f.contexts.some(context=>context.memories.some(memory=>memory.statement.includes('Generated work requirement'))),
  'independently reviewed, published Memory is available to the analysis');
 assert.deepEqual(await f.view(run.id),{state:'completed',counts:{sources:2,materials:2,memories:2,ideas:2,feed:0}});
 const narrow=await f.read(run.id,{kind:'selection',sourceIds:['work']});assert.equal(narrow.coverage.sync.total,1);assert.equal(narrow.coverage.semantic.completed,1);assert.equal(narrow.items[0].result,undefined,'mixed-context result stays hidden without misreporting selected processing coverage');assert.doesNotMatch(JSON.stringify(narrow),/Generated life|confirm the trip/);
 const lifeOnly=await f.read(run.id,{kind:'selection',sourceIds:['life']});assert.equal(lifeOnly.items.length,1);assert.equal(lifeOnly.items[0].result,undefined,'a mixed-source analysis is withheld in a narrow read');
 assert.equal('position' in lifeOnly.items[0],false,'the original item index must not reveal hidden selection counts');
 assert.equal((await f.read(run.id,{kind:'selection',sourceIds:[]})).coverage.sync.total,0);
});

test('three old originals complete one bounded historical intake without replay or a notification storm',async t=>{
 const f=await fixture(t);await Promise.all([
  f.add('historical-work','Generated old work review: the release owner remains undecided.'),
  f.add('historical-life','Generated old life plan: the family visit date remains undecided.'),
  f.add('historical-reading','Generated old reading note: revisit the reference after the review.'),
 ]);
 await f.onboarding.tick();assert.equal(f.calls.length,0,'first discovery of old originals is not automatic model authority');
 const requestId=randomUUID(),sourceIds=['historical-work','historical-life','historical-reading'],run=await f.post(sourceIds,requestId);
 await f.until(async()=>{const progress=await f.read(run.id);return progress.completed===3;});
 const progress=await f.read(run.id);assert.equal(progress.state,'completed');assert.equal(progress.pending,0);assert.equal(progress.failed,0);
 assert.equal(progress.coverage.sync.total,3);assert.equal(progress.coverage.semantic.completed,3);
 assert.equal(f.calls.filter(call=>call.kind==='assistant').length,3);
 const calls=f.calls.length;assert.equal((await f.post(sourceIds,requestId)).id,run.id);
 await f.onboarding.tick();await f.onboarding.tick();assert.equal(f.calls.length,calls,'polling and the repeated owner request reuse completed coverage');
 assert.equal(f.cards.page({scope:all}).items.length,3,'quiet historical intake still preserves useful cards');
 assert.deepEqual(new AssistantNotifications(f.cards,()=>notificationSettingsSchema.parse({})).snapshot(all).items,[]);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM background_model_receipts WHERE eligible=1').get()!.n,0);
});

test('CN2-01 selects only three requested sources in the 30-day window and caps admission at 100',async t=>{
 const f=await fixture(t),sources=['generated-work','generated-life','generated-reading'];
 const boundary=await f.add(sources[0],'Generated lower boundary.','pending','inside','2020-01-01T00:00:00Z');
 const life=await f.add(sources[1],'Generated current life.','pending','inside');
 const reading=await f.add(sources[2],'Generated current reading.','pending','inside');
 await f.add(sources[0],'Generated just outside the lower boundary.','pending','early','2019-12-31T23:59:59.999Z');
 await f.add(sources[1],'Generated upper boundary.','pending','future',now);
 await f.add('generated-unselected','Generated unselected source.','pending');
 const windowed=await f.post(sources);
 assert.deepEqual((await f.read(windowed.id)).items.map(item=>item.material.ref).sort(),[boundary,life,reading].map(item=>item.material.ref).sort());
 assert.deepEqual((await f.view(windowed.id)).counts,{sources:3,materials:3,memories:0,ideas:0,feed:0});
 const newer=[];
 for(let index=0;index<105;index++){
  const observedAt=new Date(Date.parse(now)-(index+1)*1000).toISOString();
  newer.push(await f.add(sources[index%3],'Generated bounded intake '+index,'pending','bounded-'+index,observedAt));
 }
 const bounded=await f.post(sources);
 const selected=await f.read(bounded.id);
 assert.equal(selected.counts.materials,100);
 assert.deepEqual(selected.items.map(item=>item.material.ref),newer.slice(0,100).map(item=>item.material.ref));
 assert.deepEqual(f.calls,[],'pending extraction cannot disclose originals to a model');
});

test('CN2-02 routes nine observations through normal Memory review and counts ideas and activity separately',async t=>{
 for(const status of ['proposed','published'] as const)await t.test(status,async t=>{
  // Without a qualifying review receipt, the existing Memory fixture saves proposals.
  const f=await fixture(t,{observations:true,feed:true,unreviewedMemory:status==='proposed'});
  const observations=Array.from({length:9},(_,index)=>'Generated observation '+(index+1)+'.');
  // The unreviewed extraction contract accepts up to eight candidates per batch.
  const inputs=status==='proposed'?[observations.slice(0,8),observations.slice(8)]:[observations];
  for(const [index,lines] of inputs.entries())await f.add('observations',lines.join('\n'),'ready',String(index));
  const run=await f.post(['observations']);
  await f.until(async()=>(await f.read(run.id)).state==='completed');
  assert.deepEqual(await f.view(run.id),{state:'completed',counts:{sources:1,materials:inputs.length,memories:9,ideas:inputs.length,feed:inputs.length}});
  const memories=f.reader.memories.page({status,layer:'observation'}).items;
  assert.equal(memories.length,9);
  assert.equal(new Set(memories.map(memory=>memory.id)).size,9);
  assert.equal(f.reader.memories.page({status:status==='proposed'?'published':'proposed'}).items.length,0);
  if(status==='published')assert.ok(memories.every(memory=>f.reader.memories.get(memory.id).reviewReceipt?.reviewRunId));
  assert.equal(f.cards.page({scope:all}).items.filter(card=>card.kind==='suggestion').length,inputs.length);
  const activity=f.cards.feed(feedQuerySchema.parse({scope:JSON.stringify(all),window:'today',kinds:'activity'}));
  assert.equal(activity.items.length,inputs.length);assert.ok(activity.items.every(item=>item.kind==='activity'));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM assistant_commitments').get()!.n,0);
  await f.restart();
  assert.equal((await f.view(run.id)).counts.memories,9,'the saved outputs remain countable after restart');
 });
});

test('owner cancellation during either model phase prevents late Memory and assistant publication',async t=>{
 for(const phase of ['memory','assistant'] as const)await t.test(phase,async t=>{
  const f=await fixture(t);await f.add('cancel-'+phase,'Generated cancellable '+phase);const hold=f.hold(phase);
  const run=await f.post(['cancel-'+phase]);await f.until(()=>f.calls.some(call=>call.kind===phase));await hold.entered.promise;
  const current=await f.read(run.id),response=await f.app.inject({method:'POST',url:`/api/assistant/onboarding/${run.id}/cancel`,headers,payload:{expectedRevision:current.revision,scope:all}});
  assert.equal(response.statusCode,200,response.body);hold.release.release();
  await f.until(async()=>{await f.onboarding.tick();return (await f.read(run.id)).state==='cancelled';});
  assert.equal(f.cards.page({scope:all}).items.length,0);assert.equal(f.reader.memories.page().items.length,phase==='memory'?0:1);
  await f.restart();await f.onboarding.tick();assert.equal(f.cards.page({scope:all}).items.length,0);assert.equal(f.reader.memories.page().items.length,phase==='memory'?0:1);
 });
});

test('CN2-03 cancellation retains completed coverage and a new owner start can continue only the unfinished source',async t=>{
 const f=await fixture(t);await f.add('finished','Generated finished selection.');const late=await f.add('unfinished','Generated unfinished selection.','pending');
 const requestId=randomUUID(),run=await f.post(['finished','unfinished'],requestId);
 await f.until(async()=>(await f.read(run.id)).completed===1);
 const progress=await f.read(run.id),cancelled=await f.app.inject({method:'POST',url:`/api/assistant/onboarding/${run.id}/cancel`,headers,payload:{expectedRevision:progress.revision,scope:all}});
 assert.equal(cancelled.statusCode,200,cancelled.body);
 assert.deepEqual(onboardingViewSchema.parse(cancelled.json()),{state:'cancelled',counts:{sources:2,materials:2,memories:1,ideas:1,feed:0}});
 const retained=await f.read(run.id);assert.equal(retained.completed,1);assert.equal(retained.cancelled,1);
 const replay=await f.app.inject({method:'POST',url:'/api/assistant/onboarding',headers:{...headers,'idempotency-key':requestId},payload:{sources:['finished','unfinished'],window:{days:30}}});
 assert.equal(replay.statusCode,409,'replaying a cancelled command cannot renew permission');
 const before=f.calls.length,next=await f.post(['unfinished']);f.publish('unfinished',late.id,late.text);
 await f.until(async()=>(await f.read(next.id)).completed===1);
 assert.ok(f.calls.slice(before).filter(call=>call.kind==='memory').every(call=>call.sourceIds.every(source=>'unfinished'===source)));
 assert.equal((await f.read(run.id)).state,'cancelled');assert.equal(f.cards.page({scope:all}).items.length,2);
});

test('CN2-04 a new run reuses the reviewed coverage after the owner confirms an observation',async t=>{
 const f=await fixture(t,{observations:true,noSuggestions:true,unreviewedMemory:true});
 await f.add('repeat','Generated confirmed observation.');
 const first=await f.post(['repeat']);
 await f.until(async()=>(await f.read(first.id)).state==='completed');
 const [pending]=f.reader.memories.page({status:'proposed',layer:'observation'}).items;
 assert.ok(pending);
 const confirmed=f.reader.memories.publish(pending.id,pending.version);
 const before=f.calls.filter(call=>call.kind==='memory').length;
 const second=await f.post(['repeat']);
 assert.notEqual(second.id,first.id);
 await f.until(async()=>(await f.read(second.id)).state==='completed');
 assert.equal(f.calls.filter(call=>call.kind==='memory').length,before);
 assert.deepEqual(f.reader.memories.page({status:'published',layer:'observation'}).items.map(memory=>memory.id),[confirmed.id]);
 assert.equal(f.reader.memories.page({status:'proposed'}).items.length,0);
 assert.equal((await f.view(second.id)).counts.memories,0);
});

test('CN2-05 skips a source whose authorization has expired and reports it beside healthy work',async t=>{
 const f=await fixture(t),unavailable=await f.add('expired','GENERATED_EXPIRED_BODY');
 await f.add('healthy','Generated healthy original.');
 f.sources.reportStatus('expired',{state:'permission_required',code:'generated-expired'});
 const run=await f.post(['expired','healthy']);
 await f.until(async()=>(await f.read(run.id)).state==='completed');
 const expected={state:'completed',counts:{sources:1,materials:1,memories:1,ideas:1,feed:0,skippedSources:1}};
 assert.deepEqual(await f.view(run.id),expected);
 assert.ok(f.calls.every(call=>!call.ids.includes(unavailable.id)&&!call.sourceIds.includes('expired')));
 assert.doesNotMatch(JSON.stringify(f.contexts),/GENERATED_EXPIRED_BODY/);
 assert.deepEqual((await f.view(run.id,{kind:'selection',sourceIds:['healthy']})).counts,{sources:1,materials:1,memories:1,ideas:1,feed:0});
 f.sources.reportStatus('expired',{state:'idle'});
 await f.restart();
 assert.deepEqual(await f.view(run.id),expected,'a resumed connector cannot change a completed selection');
});

test('CN2-05 a revoked source cannot commit held Memory and the healthy source still completes',async t=>{
 const f=await fixture(t),hold=f.hold('memory');
 await f.add('healthy','Generated second original.');
 await f.add('revoked','Generated held original.','ready','selected','2020-01-03T00:00:00Z');
 const run=await f.post(['revoked','healthy']);
 await f.until(()=>f.calls.some(call=>call.sourceIds.includes('revoked')));await hold.entered.promise;
 f.store.db.exec('BEGIN IMMEDIATE');
 f.sources.reportStatus('revoked',{state:'permission_required',code:'generated-rolled-back-expiration'});
 f.store.db.exec('ROLLBACK');
 await Promise.resolve();
 const active=await f.read(run.id);
 assert.equal(active.counts.skippedSources,undefined,'a rolled-back source write cannot withdraw the in-flight job');
 assert.equal(active.items.find(item=>item.material.sourceId==='revoked')?.memory?.status,'running');
 f.sources.reportStatus('revoked',{state:'permission_required',code:'generated-expired'});
 hold.release.release();
 await f.until(async()=>(await f.read(run.id)).state==='completed');
 assert.deepEqual(await f.view(run.id),{state:'completed',counts:{sources:1,materials:1,memories:1,ideas:1,feed:0,skippedSources:1}});
 const [memory]=f.reader.memories.page({status:'published'}).items;
 assert.match(f.reader.memories.get(memory.id).statement,/Generated second original/);
 assert.equal(f.calls.filter(call=>call.sourceIds.includes('revoked')).length,1,'revocation fences the independent review and commit');
});

test('CN2-05 replaces held analysis when another source is withdrawn from its selection',async t=>{
 const f=await fixture(t),hold=f.hold('assistant');
 await f.add('withdrawn','GENERATED_WITHDRAWN_ORIGINAL','pending');
 await f.add('healthy','Generated healthy original.','ready','selected','2020-01-03T00:00:00Z');
 const run=await f.post(['healthy','withdrawn']);
 await f.until(()=>f.calls.some(call=>call.kind==='assistant'));await hold.entered.promise;
 f.sources.reportStatus('withdrawn',{state:'permission_required',code:'generated-expired'});
 await f.onboarding.tick();hold.release.release();
 await f.until(async()=>(await f.read(run.id)).state==='completed');
 assert.deepEqual(await f.view(run.id),{state:'completed',counts:{sources:1,materials:1,memories:1,ideas:1,feed:0,skippedSources:1}});
 assert.equal(f.calls.filter(call=>call.kind==='assistant').length,2,'the healthy item is reanalyzed under the reduced grant');
 assert.equal(f.cards.page({scope:all}).items.length,1,'only the analysis under the reduced grant publishes');
});

test('invalid or empty starts create no model work and failure stays visible without disclosing an unselected source',async t=>{
 const f=await fixture(t),selected=await f.add('selected','Generated chosen body.'),hidden=await f.add('hidden','GENERATED_HIDDEN_BODY');
 await f.add('broken','Generated failed extraction.','failed');f.sources.register({id:'empty',name:'Generated empty',kind:'custom',deviceId:'generated',platform:'import'});
 for(const payload of [{sources:[],window:{days:30}},{sources:['selected'],window:{days:0}},{sources:['selected'],window:{days:30},materialRefs:[selected.material.ref]}]){
  const invalid=await f.app.inject({method:'POST',url:'/api/assistant/onboarding',headers,payload});assert.equal(invalid.statusCode,400,invalid.body);
 }
 const empty=await f.post(['empty']);assert.deepEqual(await f.view(empty.id),{state:'completed',counts:{sources:0,materials:0,memories:0,ideas:0,feed:0}});
 assert.equal(f.calls.length,0);
 const run=await f.post(['broken','selected']);
 await f.until(async()=>{const state=await f.read(run.id);return state.completed===1&&state.failed===1;});
 const state=await f.read(run.id);assert.equal(state.items.find(item=>item.material.sourceId==='broken')?.reason,'extraction_failed');assert.equal(state.coverage.semantic.completed,1);
 assert.ok(f.calls.every(call=>!call.ids.includes(hidden.id)));assert.doesNotMatch(JSON.stringify(f.contexts),/GENERATED_HIDDEN_BODY|Generated hidden/);
 const earlier=f.calls.length;await f.onboarding.tick();await f.onboarding.tick();assert.equal(f.calls.length,earlier,'an unchanged failed item is not analyzed every poll');
});

test('replacing or forgetting a selected original cannot widen the historical grant or retain its private selection',async t=>{
 const f=await fixture(t),note=await f.add('replace','Generated pending original.','pending'),run=await f.post(['replace']);
 await f.sources.upsert('replace',{externalId:'selected',revision:'unselected-v2',observedAt:at,kind:'message',layer:'original',text:'GENERATED_UNSELECTED_REPLACEMENT'});
 await f.onboarding.tick();assert.equal(f.calls.length,0);assert.equal((await f.read(run.id)).items.length,0);
 const item=f.store.db.prepare('SELECT selection_id FROM assistant_onboarding_items WHERE onboarding_id=?').get(run.id)!;
 f.materials.forget(note.material.id);
 assert.equal(f.store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(item.selection_id)!.input_json,null);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM assistant_onboarding_items WHERE onboarding_id=?').get(run.id)!.n,0);
});

test('an interrupted progress write rolls back assistant admission instead of leaving an orphan model call',async t=>{
 const f=await fixture(t);await f.add('checkpoint','Generated checkpoint input.');
 f.store.db.exec(`CREATE TRIGGER generated_onboarding_checkpoint_failure BEFORE UPDATE OF followup_id ON assistant_onboarding_items
  WHEN new.followup_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'Generated checkpoint failure'); END;`);
 const run=await f.post(['checkpoint']);
 await f.until(async()=>{const progress=await f.read(run.id);return progress.failed===1;});
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.onboarding.analysis'").get()!.n,0);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='batch.item'").get()!.n,0);
 assert.equal(f.calls.filter(call=>call.kind==='assistant').length,0,'failed admission does not send a model request');
 assert.equal(f.reader.memories.page().items.length,1,'the earlier reviewed Memory checkpoint is retained');
});

test('assembled server mounts owner-only onboarding commands without enabling automatic processing',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'mote-onboarding-host-'));
 const config:ConfigurationPlatformOptions={path:(dataDir)+'/mote.yaml',privateCredential:{token:'generated-onboarding-owner',tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:dataDir,maxExportBytes:1000000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('An unconfigured production guard must not send');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 const unauthorized=await node.app.inject({method:'POST',url:'/api/assistant/onboarding',payload:{}});assert.equal(unauthorized.statusCode,401);
 const {invitation}=node.connections.invite({serverUrl:'https://generated.invalid',label:'Generated collector'},'collector');
 const collector=await node.connections.redeem({code:invitation.code,deviceId:'generated-collector',deviceName:'Generated collector',platform:'android'});
 const forbidden=await node.app.inject({method:'POST',url:'/api/assistant/onboarding',headers:{authorization:'Bearer '+collector.token},payload:{}});assert.equal(forbidden.statusCode,403);
 const id=randomUUID(),note=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-device',deviceName:'Generated',platform:'import',capturedAt:new Date(Date.now()-86400000).toISOString(),text:'Generated host onboarding material.'}});
 assert.equal(note.statusCode,201,note.body);await node.materialOrganizer.tick(100);
 const material=node.materials.list({kind:'mote.note'}).items.find(value=>value.origin.externalId===id);assert.ok(material);
 const response=await node.app.inject({method:'POST',url:'/api/assistant/onboarding',headers,payload:{sources:[material.origin.sourceId],window:{days:30}}});
 assert.equal(response.statusCode,202,response.body);const run=onboardingStartResultSchema.parse(response.json());
 const progress=await node.app.inject({method:'GET',url:'/api/assistant/onboarding/'+run.id,headers});
 assert.equal(progress.statusCode,200,progress.body);assert.equal(onboardingViewSchema.parse(progress.json()).counts.materials,1);
 assert.equal(node.modelAuthorization.view().state,'off','manual onboarding never opens background processing');
});


test('a completed zero-batch Memory job recovers its valid saved empty follow-up after a transient result write failure without a new model call',async t=>{
 const f=await fixture(t,{noSuggestions:true});await f.add('save-recovery','Generated current original with no supported suggestion.');
 const first=await f.post(['save-recovery']);await f.until(async()=>(await f.read(first.id)).state==='completed');
 f.store.db.exec("CREATE TEMP TRIGGER generated_followup_save_failure BEFORE UPDATE OF state ON task_records WHEN old.kind='assistant.onboarding.analysis' AND new.state='succeeded' BEGIN SELECT RAISE(ABORT,'generated transient result write failure'); END");
 const second=await f.post(['save-recovery']);await f.until(async()=>(await f.read(second.id)).failed===1);
 const failed=await f.read(second.id),item=failed.items[0];assert.equal(item.reason,'understanding_unavailable');assert.equal(item.memory?.status,'completed');assert.equal(item.memory?.totalBatches,0);
 const batch=f.store.db.prepare("SELECT b.state FROM task_records f JOIN task_records b ON b.operation_id=f.operation_id WHERE f.id=? AND b.kind='batch'").get(item.taskId!);assert.equal(batch?.state,'succeeded');
 const before=f.calls.length;f.store.db.exec('DROP TRIGGER generated_followup_save_failure');
 await f.until(async()=>(await f.read(second.id)).state==='completed');
 const recovered=await f.read(second.id);assert.equal(recovered.failed,0);assert.equal(recovered.items[0].reason,undefined);assert.deepEqual(recovered.items[0].result?.cardIds,[]);
 assert.equal(f.calls.length,before,'recovery validates and saves the existing model result instead of repeating processing');
});
