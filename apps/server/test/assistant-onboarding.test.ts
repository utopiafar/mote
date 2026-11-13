import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {estimateSerializedTokens,type QueryInput} from '@mote/agent';
import {fileCoverageSchema,type QueryResult,type QueryScope} from '@mote/shared';
import {Store,StoreError} from '../src/store.js';
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
import type {Config} from '../src/config.js';

const all:QueryScope={kind:'all'},headers={authorization:'Bearer generated-onboarding-owner'};
const at='2020-01-02T00:00:00Z';
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(done=>{release=done;});return {promise,release};};
type Context={materials:{ref:string;title:string;origin:{sourceId:string}}[];originals:{id:string;offset:number;quote:string}[];cards:{id:string}[];memories:{statement:string}[]};
const empty=(input:QueryInput,answer:string):QueryResult=>({answer,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[...(input.contextEvidenceDependencies?.ids??input.evidenceIds??[])]}});

/** Real SQLite, owner HTTP command, Memory executor, follow-up parser and card store.
 * Only the two model boundaries are controlled. No real profile is opened. */
async function fixture(t:TestContext){
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
   const result=empty(input,JSON.stringify({memories:[{title:'Generated bounded fact',statement:`${record.ocrText} [${id}]`,uncertainty:'Generated evidence only',evidenceIds:[id]}]}));
   result.citations=[{id,capturedAt:record.capturedAt,appName:'Generated',excerpt:record.ocrText}];
   return fixtureMemoryResult(reader.memories,result,input.evidenceRanges,input);
  }
  const marker='\nUntrusted context: ',context=JSON.parse(input.question.slice(input.question.indexOf(marker)+marker.length)) as Context;contexts.push(context);
  const original=context.originals[0];assert.ok(original,'A14 receives an actual original');
  return empty(input,JSON.stringify({reason:'Generated historical review with original time preserved.',cards:[{action:'new',cardId:null,relatedCardIds:[],title:context.materials[0].title,
   body:'Generated useful follow-up based on the selected original.',reason:'Generated explicit fixture interpretation.',evidence:[original],matterId:null}],commitments:[]}));
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
   phases:{query:memoryQuery,review:(input,result)=>reviewMemory(input,result,async request=>memoryQuery(request as MemoryPipelineQuery))}});
  batch=new BatchProcessing(store,engine,control,async input=>{try{return await model(input,'assistant');}catch(error){modelFailure=error;throw error;}},assertCurrent,()=>control.assertCurrent(connection),()=>{},()=>undefined,()=>1,false,reader.memories);
  followup=new AssistantFollowup(store,materials,reader,cards,new AssistantCommitments(store,reader),new AssistantMatters(store),batch,assertCurrent);
  onboarding=new AssistantOnboarding(store,materials,reader,control,memory,followup,()=>[connection],assertCurrent,()=>['source-body']);
  app=Fastify({logger:false});app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof StoreError?error.statusCode:400).send({error:error.message}));
  registerAssistantOnboardingRoutes(app,onboarding,request=>{if(request.headers.authorization!==headers.authorization)throw new StoreError('Owner required',403);});
  await app.ready();
 };
 const close=async()=>{await onboarding.close();await app.close();await batch.close();await memory.close();await engine.close();control.close();reader.dispose();store.close();};
 await start();t.after(async()=>{await close();rmSync(directory,{recursive:true,force:true});});
 const publish=(sourceId:string,captureId:string,text:string,state:'ready'|'pending'|'failed'='ready')=>{
  const id=materialId(sourceId,'selected'),previous=materials.get(id);
  return materials.publish({id,kind:'mote.message',schemaVersion:1,title:'Generated '+sourceId,origin:{sourceId,externalId:'selected',deviceId:'generated',firstAt:at,lastAt:at},
   members:[{id:'original',kind:'capture',ref:'capture:'+captureId}],blocks:state==='ready'?[{id:'body',kind:'text',format:'plain',text,memberIds:['original']}]:[],
   artifacts:[{key:'source-body',state:state==='ready'?'ready':'pending',blockIds:state==='ready'?['body']:[]},{key:'extracted-text',state,blockIds:state==='ready'?['body']:[]}],
   coverage:{state:state==='ready'?'complete':'pending'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}} satisfies MaterialDraft,{expectedRevision:previous?.revision??null});
 };
 const add=async(sourceId:string,text:string,state:'ready'|'pending'|'failed'='ready')=>{
  sources.register({id:sourceId,name:'Generated '+sourceId,kind:'custom',deviceId:'generated',platform:'import'});
  const capture=await sources.upsert(sourceId,{externalId:'selected',revision:'original-v1',observedAt:at,kind:'message',layer:'original',text});
  store.db.exec('BEGIN IMMEDIATE');control.receive('capture:'+capture.id,{sourceId},false);store.db.exec('COMMIT');
  return {id:capture.id,text,material:publish(sourceId,capture.id,text,state)};
 };
 const post=async(refs:string[],scope:QueryScope=all,requestId=randomUUID())=>{
  const response=await app.inject({method:'POST',url:'/api/assistant/onboarding',headers,payload:{requestId,scope,materialRefs:refs}});
  assert.equal(response.statusCode,202,response.body);return response.json() as ReturnType<AssistantOnboarding['get']>;
 };
 const read=async(id:string,scope:QueryScope=all)=>{
  const response=await app.inject({method:'GET',url:`/api/assistant/onboarding/${id}?scope=${encodeURIComponent(JSON.stringify(scope))}`,headers});
  assert.equal(response.statusCode,200,response.body);return response.json() as ReturnType<AssistantOnboarding['get']>;
 };
 const until=async(check:()=>boolean|Promise<boolean>)=>{
  const end=Date.now()+10000;
  while(Date.now()<end){await onboarding.tick();await engine.tick();if(modelFailure)throw modelFailure;if(await check())return;await new Promise(done=>setTimeout(done,10));}
  throw Error('Generated onboarding did not reach the expected state: '+JSON.stringify(store.db.prepare('SELECT * FROM assistant_onboarding_items').all()));
 };
 return {get store(){return store;},get sources(){return sources;},get materials(){return materials;},get cards(){return cards;},get onboarding(){return onboarding;},get reader(){return reader;},get followup(){return followup;},get memory(){return memory;},get app(){return app;},get control(){return control;},
  calls,contexts,add,publish,post,read,until,async restart(){await close();await start();},hold(kind:'memory'|'assistant'){const hold={kind,entered:gate(),release:gate()};modelHold=hold;t.after(()=>hold.release.release());return hold;}};
}

test('two selected historical sources give a useful partial result, then resume only the late original after restart without notifications',async t=>{
 const f=await fixture(t),work=await f.add('work','Generated work requirement: prepare the release.'),life=await f.add('life','Generated life requirement: confirm the trip.','pending');
 await f.onboarding.tick();assert.equal(f.calls.length,0,'synced old data without an owner start is never sent');
 const requestId=randomUUID(),run=await f.post([work.material.ref,life.material.ref],all,requestId);
 await f.until(async()=>{const progress=await f.read(run.id);return progress.completed===1;});
 const partial=await f.read(run.id);assert.deepEqual(partial.coverage.sync,{completed:2,total:2,reason:'selected_synced_materials_only'});
 assert.equal(partial.coverage.extraction.completed,1);assert.equal(partial.coverage.semantic.completed,1);assert.equal(partial.pending,1);
 assert.equal(partial.items[0].result?.cardIds.length,1);assert.equal(partial.items[1].coverage.extraction.status,'pending');
 for(const item of partial.items)for(const dimension of Object.values(item.coverage))fileCoverageSchema.parse(dimension);
 assert.equal(f.cards.page({scope:all}).items.length,1);assert.equal(f.reader.memories.page().items.length,1,'normal reviewed Memory publication was used');
 const repeat=await f.post([work.material.ref,life.material.ref],all,requestId);assert.equal(repeat.id,run.id);
 const before=f.calls.length;await f.restart();f.publish('life',life.id,life.text);
 await f.until(async()=>{const progress=await f.read(run.id);return progress.completed===2;});
 const completed=await f.read(run.id);assert.equal(completed.state,'completed');assert.equal(completed.pending,0);assert.equal(completed.failed,0);
 assert.equal(f.calls.filter(call=>call.kind==='assistant').length,2);
 assert.ok(f.calls.slice(before).filter(call=>call.kind==='memory').every(call=>call.sourceIds.length===1&&call.sourceIds[0]==='life'),'completed work is not extracted again');
 assert.equal(f.cards.page({scope:all}).items.length,2);assert.equal(f.reader.memories.page().items.length,2);
 const notifications=new AssistantNotifications(f.cards,()=>notificationSettingsSchema.parse({}));assert.deepEqual(notifications.snapshot(all).items,[]);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM background_model_receipts WHERE eligible=1').get()!.n,0,'historical permission creates no automatic receipts');
 assert.ok(f.contexts.every(context=>context.materials.every(material=>material.origin.sourceId==='work'||material.origin.sourceId==='life')));
 assert.equal(f.contexts[0].memories.length,1);assert.equal(f.contexts[1].memories.length,2,'both domains share the same current Memory reader');
 const narrow=await f.read(run.id,{kind:'selection',sourceIds:['work']});assert.equal(narrow.coverage.sync.total,1);assert.doesNotMatch(JSON.stringify(narrow),/Generated life|confirm the trip/);
 const lifeOnly=await f.read(run.id,{kind:'selection',sourceIds:['life']});assert.equal(lifeOnly.items.length,1);assert.equal(lifeOnly.items[0].result,undefined,'a mixed-source analysis is withheld in a narrow read');
 assert.equal('position' in lifeOnly.items[0],false,'the original item index must not reveal hidden selection counts');
 assert.equal((await f.read(run.id,{kind:'selection',sourceIds:[]})).coverage.sync.total,0);
});

test('owner cancellation during either model phase prevents late Memory and assistant publication',async t=>{
 for(const phase of ['memory','assistant'] as const)await t.test(phase,async t=>{
  const f=await fixture(t),note=await f.add('cancel-'+phase,'Generated cancellable '+phase),hold=f.hold(phase);
  const run=await f.post([note.material.ref]);await f.until(()=>f.calls.some(call=>call.kind===phase));await hold.entered.promise;
  const current=await f.read(run.id),response=await f.app.inject({method:'POST',url:`/api/assistant/onboarding/${run.id}/cancel`,headers,payload:{expectedRevision:current.revision,scope:all}});
  assert.equal(response.statusCode,200,response.body);hold.release.release();
  await f.until(async()=>{await f.onboarding.tick();return (await f.read(run.id)).state==='cancelled';});
  assert.equal(f.cards.page({scope:all}).items.length,0);assert.equal(f.reader.memories.page().items.length,phase==='memory'?0:1);
  await f.restart();await f.onboarding.tick();assert.equal(f.cards.page({scope:all}).items.length,0);assert.equal(f.reader.memories.page().items.length,phase==='memory'?0:1);
 });
});

test('cancellation retains completed coverage and a new owner start can continue only the unfinished selection',async t=>{
 const f=await fixture(t),work=await f.add('finished','Generated finished selection.'),late=await f.add('unfinished','Generated unfinished selection.','pending');
 const requestId=randomUUID(),run=await f.post([work.material.ref,late.material.ref],all,requestId);
 await f.until(async()=>(await f.read(run.id)).completed===1);
 const progress=await f.read(run.id),cancelled=await f.app.inject({method:'POST',url:`/api/assistant/onboarding/${run.id}/cancel`,headers,payload:{expectedRevision:progress.revision,scope:all}});
 assert.equal(cancelled.statusCode,200,cancelled.body);assert.equal(cancelled.json().completed,1);assert.equal(cancelled.json().cancelled,1);
 const replay=await f.app.inject({method:'POST',url:'/api/assistant/onboarding',headers,payload:{requestId,scope:all,materialRefs:[work.material.ref,late.material.ref]}});
 assert.equal(replay.statusCode,409,'replaying a cancelled command cannot renew permission');
 const before=f.calls.length,next=await f.post([late.material.ref]);f.publish('unfinished',late.id,late.text);
 await f.until(async()=>(await f.read(next.id)).completed===1);
 assert.ok(f.calls.slice(before).filter(call=>call.kind==='memory').every(call=>call.sourceIds.every(source=>'unfinished'===source)));
 assert.equal((await f.read(run.id)).state,'cancelled');assert.equal(f.cards.page({scope:all}).items.length,2);
});

test('empty and out-of-scope selections create no work; extraction failure stays visible and an unselected sibling is never disclosed',async t=>{
 const f=await fixture(t),selected=await f.add('selected','Generated chosen body.'),hidden=await f.add('hidden','GENERATED_HIDDEN_BODY'),broken=await f.add('broken','Generated failed extraction.','failed');
 const empty=await f.app.inject({method:'POST',url:'/api/assistant/onboarding',headers,payload:{requestId:randomUUID(),scope:{kind:'selection',sourceIds:[]},materialRefs:[selected.material.ref]}});
 assert.equal(empty.statusCode,404);assert.equal(f.calls.length,0);
 const outside=await f.app.inject({method:'POST',url:'/api/assistant/onboarding',headers,payload:{requestId:randomUUID(),scope:{kind:'selection',sourceIds:['selected']},materialRefs:[hidden.material.ref]}});
 assert.equal(outside.statusCode,404);
 const run=await f.post([broken.material.ref,selected.material.ref]);
 await f.until(async()=>{const state=await f.read(run.id);return state.completed===1&&state.failed===1;});
 const state=await f.read(run.id);assert.equal(state.items[0].reason,'extraction_failed');assert.equal(state.coverage.semantic.completed,1);
 assert.ok(f.calls.every(call=>!call.ids.includes(hidden.id)));assert.doesNotMatch(JSON.stringify(f.contexts),/GENERATED_HIDDEN_BODY|Generated hidden/);
 const earlier=f.calls.length;await f.onboarding.tick();await f.onboarding.tick();assert.equal(f.calls.length,earlier,'an unchanged failed item is not analyzed every poll');
});

test('replacing or forgetting a selected original cannot widen the historical grant or retain its private selection',async t=>{
 const f=await fixture(t),note=await f.add('replace','Generated pending original.','pending'),run=await f.post([note.material.ref]);
 await f.sources.upsert('replace',{externalId:'selected',revision:'unselected-v2',observedAt:at,kind:'message',layer:'original',text:'GENERATED_UNSELECTED_REPLACEMENT'});
 await f.onboarding.tick();assert.equal(f.calls.length,0);assert.equal((await f.read(run.id)).items.length,0);
 const item=f.store.db.prepare('SELECT selection_id FROM assistant_onboarding_items WHERE onboarding_id=?').get(run.id)!;
 f.materials.forget(note.material.id);
 assert.equal(f.store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(item.selection_id)!.input_json,null);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM assistant_onboarding_items WHERE onboarding_id=?').get(run.id)!.n,0);
});

test('an interrupted progress write rolls back assistant admission instead of leaving an orphan model call',async t=>{
 const f=await fixture(t),note=await f.add('checkpoint','Generated checkpoint input.');
 f.store.db.exec(`CREATE TRIGGER generated_onboarding_checkpoint_failure BEFORE UPDATE OF followup_id ON assistant_onboarding_items
  WHEN new.followup_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'Generated checkpoint failure'); END;`);
 const run=await f.post([note.material.ref]);
 await f.until(async()=>{const progress=await f.read(run.id);return progress.failed===1;});
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.followup'").get()!.n,0);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE kind='batch.item'").get()!.n,0);
 assert.equal(f.calls.filter(call=>call.kind==='assistant').length,0,'failed admission does not send a model request');
 assert.equal(f.reader.memories.page().items.length,1,'the earlier reviewed Memory checkpoint is retained');
});

test('assembled server mounts owner-only onboarding commands without enabling automatic processing',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'mote-onboarding-host-'));
 const config:Config={dataDir,token:'generated-onboarding-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('An unconfigured production guard must not send');},close:async()=>{}}});
 t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 const unauthorized=await node.app.inject({method:'POST',url:'/api/assistant/onboarding',payload:{}});assert.equal(unauthorized.statusCode,401);
 const {invitation}=node.connections.invite({serverUrl:'https://generated.invalid',label:'Generated collector'},'collector');
 const collector=await node.connections.redeem({code:invitation.code,deviceId:'generated-collector',deviceName:'Generated collector',platform:'android'});
 const forbidden=await node.app.inject({method:'POST',url:'/api/assistant/onboarding',headers:{authorization:'Bearer '+collector.token},payload:{}});assert.equal(forbidden.statusCode,403);
 const id=randomUUID(),note=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-device',deviceName:'Generated',platform:'import',capturedAt:at,text:'Generated host onboarding material.'}});
 assert.equal(note.statusCode,201,note.body);await node.materialOrganizer.tick(100);
 const material=node.materials.list({kind:'mote.note'}).items.find(value=>value.origin.externalId===id);assert.ok(material);
 const response=await node.app.inject({method:'POST',url:'/api/assistant/onboarding',headers,payload:{requestId:randomUUID(),scope:all,materialRefs:[material.ref]}});
 assert.equal(response.statusCode,202,response.body);assert.equal(response.json().coverage.sync.total,1);
 assert.equal(node.modelAuthorization.view().state,'off','manual onboarding never opens background processing');
});
