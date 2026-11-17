import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {ProviderFailure} from '@mote/shared';
import type {QueryInput} from '@mote/agent';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {ContentStorageService} from '../src/content-storage.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {reviewMemory} from '../src/memory-review.js';
import {MemoryPhaseOutputs} from '../src/memory-phase-outputs.js';
import {generatedMemoryOutput} from './fixtures/memory-planning.js';

async function fixture(t:import('node:test').TestContext,encrypted=false){
 const directory=mkdtempSync(join(tmpdir(),'mote-phase-lifecycle-')),key='ab'.repeat(32);let store=new Store(directory,encrypted?{dataKey:key,contentEncryptionEnabled:true}:{}),sources=new SourceStore(store),memories=new MemoryStore(store);
 sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
 const record=await sources.upsert('generated',{externalId:'one',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'Generated',kind:'file',layer:'original',text:'Generated complete original for durable independent Memory phases.'});
 const state={extractCalls:0,reviewCalls:0,native:false,nativeCalls:0,reviewOrigins:[] as unknown[],extractFailures:0,reviewFailures:0,retryAfterMs:0,extractAt:[] as number[],held:undefined as Promise<void>|undefined,entered:undefined as (()=>void)|undefined};
 const response=(input:QueryInput,runId:string)=>({answer:generatedMemoryOutput(input,[]),citations:[],trace:[],runId});
 const open=()=>new MemoryPipeline({store,memories,concurrency:()=>2,
  nativeStages:{prepare:async(input,context)=>{if(!state.native)return;state.nativeCalls++;context.provider={instanceId:'generated-native',configurationIdentity:'generated-config',namespace:{ownerId:'mote-owner',instanceId:'generated-native',bindingRevision:1}};return response(input,context.opId);}},models:{configured:()=>true,model:()=> 'generated'},phases:{
  query:async input=>{state.extractCalls++;state.extractAt.push(Date.now());if(state.extractFailures-->0)throw new ProviderFailure({category:'transient',code:'provider_network',retryAfterMs:state.retryAfterMs});return response(input,'generated-extract-'+state.extractCalls);},
  review:(input,draft,_strategy,draftOrigin)=>{state.reviewOrigins.push(draftOrigin);return reviewMemory(input,draft,async request=>{state.reviewCalls++;state.entered?.();if(state.held)await state.held;if(state.reviewFailures-->0)throw new ProviderFailure({category:'transient',code:'provider_network',retryAfterMs:0});return response(request,'generated-review-'+state.reviewCalls);},{draftOrigin});}}});
 let pipeline=open();t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
 return {get store(){return store;},get pipeline(){return pipeline;},get sources(){return sources;},state,record,directory,
  async restart(withKey=true){await pipeline.close();store.close();store=new Store(directory,encrypted&&withKey?{dataKey:key}:{});sources=new SourceStore(store);memories=new MemoryStore(store);pipeline=open();},
  async decrypt(){store.contentEncryption.setEnabled(false);const service=new ContentStorageService(store,new FileStore(store,sources),new ArchivedFileStore(store));service.start();for(let i=0;i<1000&&service.snapshot().job.state==='running';i++)await setImmediate();assert.equal(service.snapshot().job.failed,0);assert.equal(service.snapshot().job.state,'completed');}};
}

test('extraction and independent review each receive three attempts without multiplying the parent budget',async t=>{
 const f=await fixture(t);f.state.extractFailures=2;f.state.reviewFailures=2;
 const job=await f.pipeline.run(f.pipeline.create({evidenceIds:[f.record.id]}).id);assert.equal(job.status,'completed');assert.equal(f.state.extractCalls,3);assert.equal(f.state.reviewCalls,3);
 const children=f.store.db.prepare("SELECT attempts,state FROM execution_steps WHERE kind LIKE 'memory.phase.%'").all();assert.equal(children.length,2);assert.ok(children.every(child=>child.attempts===3&&child.state==='succeeded'));
});

for(const encrypted of [false,true])test(`restart and owner retry preserve completed extraction and its independent receipt (${encrypted?'encrypted':'plain'})`,async t=>{
 const f=await fixture(t,encrypted);f.state.reviewFailures=3;
 const failed=await f.pipeline.run(f.pipeline.create({evidenceIds:[f.record.id]}).id);assert.equal(failed.status,'failed');assert.equal(f.state.extractCalls,1);assert.equal(f.state.reviewCalls,3);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_phase_outputs').get()!.n,1);
 if(encrypted){const raw=String(f.store.db.prepare('SELECT json FROM memory_phase_outputs').get()!.json);assert.match(raw,/aes:/);assert.ok(!raw.includes('generated-extract'));await f.decrypt();}
 await f.restart(!encrypted);
 const availableAt=Math.max(...failed.batches.map(batch=>batch.availableAt??0));if(availableAt>Date.now())await new Promise(resolve=>setTimeout(resolve,availableAt-Date.now()+5));
 const automatic=await f.pipeline.retry(failed.id,false);assert.equal(automatic.status,'failed');assert.equal(f.state.reviewCalls,3);
 const completed=await f.pipeline.retry(failed.id);assert.equal(completed.status,'completed');assert.equal(f.state.extractCalls,1);assert.equal(f.state.reviewCalls,4);
 const row=f.store.db.prepare("SELECT step_id,input_hash FROM memory_phase_outputs WHERE phase='review'").get()!,saved=new MemoryPhaseOutputs(f.store,f.pipeline.engine).read<{reviewReceipt:{draftRunId:string;reviewRunId:string;decision:string}}>(String(row.step_id),String(row.input_hash))!;
 assert.equal(saved.reviewReceipt.draftRunId,'generated-extract-1');assert.equal(saved.reviewReceipt.reviewRunId,'generated-review-4');assert.equal(saved.reviewReceipt.decision,'independent');
});

test('deletion during independent review removes extraction output and fences every late phase write',async t=>{
 const f=await fixture(t);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);f.state.entered=entered;f.state.held=new Promise<void>(resolve=>release=resolve);
 const job=f.pipeline.create({evidenceIds:[f.record.id]}),running=f.pipeline.run(job.id);await started;
 try{assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_phase_outputs').get()!.n,1);f.store.delete(f.record.id);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_phase_outputs').get()!.n,0);}finally{release();}
 const ended=await running;assert.equal(ended.status,'failed');assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_phase_outputs').get()!.n,0);assert.equal(f.state.extractCalls,1);assert.equal(f.state.reviewCalls,1);
});

test('a child backoff and its consumed failure survive an actual Store restart',async t=>{
 const f=await fixture(t);f.state.extractFailures=1;f.state.retryAfterMs=250;
 const job=f.pipeline.create({evidenceIds:[f.record.id]}),running=f.pipeline.run(job.id);
 let saved:{attempts:number;available_at:number}|undefined;
 for(let i=0;i<1000;i++){saved=f.store.db.prepare("SELECT attempts,available_at FROM execution_steps WHERE kind LIKE 'memory.phase.%' AND state='waiting' AND attempts=1").get() as typeof saved;if(saved)break;await setImmediate();}
 assert.ok(saved);assert.equal(f.state.extractCalls,1);assert.ok(saved.available_at>f.state.extractAt[0]);
 await f.restart();await running;
 const retained=f.store.db.prepare("SELECT attempts,available_at FROM execution_steps WHERE kind LIKE 'memory.phase.%'").get()!;
 assert.equal(retained.attempts,1);assert.equal(retained.available_at,saved.available_at);
 const recovering=f.pipeline.run(job.id);if(saved.available_at>Date.now())await new Promise(resolve=>setTimeout(resolve,saved.available_at-Date.now()+5));await f.pipeline.engine.tick();const completed=await recovering;assert.equal(completed.status,'completed');assert.equal(f.state.extractCalls,2);assert.ok(f.state.extractAt[1]>=saved.available_at);assert.equal(f.state.reviewCalls,1);
});

test('native extraction origin and provider draft pins survive failed review and restart without native replay',async t=>{
 const f=await fixture(t);f.state.native=true;f.state.reviewFailures=3;
 const failed=await f.pipeline.run(f.pipeline.create({evidenceIds:[f.record.id]}).id);assert.equal(failed.status,'failed');assert.equal(f.state.nativeCalls,1);assert.equal(f.state.extractCalls,0);
 const row=f.store.db.prepare("SELECT step_id,input_hash FROM memory_phase_outputs WHERE phase='extract'").get()!;
 const saved=new MemoryPhaseOutputs(f.store,f.pipeline.engine).read<{draftOrigin:string;nativeDraft:{context:{provider:unknown}};engineDrafts:unknown[]}>(String(row.step_id),String(row.input_hash))!;
 assert.equal(saved.draftOrigin,'native-engine');assert.deepEqual(saved.nativeDraft.context.provider,{instanceId:'generated-native',configurationIdentity:'generated-config',namespace:{ownerId:'mote-owner',instanceId:'generated-native',bindingRevision:1}});assert.equal(saved.engineDrafts.length,1);
 await f.restart();const completed=await f.pipeline.retry(failed.id);assert.equal(completed.status,'completed');assert.equal(f.state.nativeCalls,1);assert.equal(f.state.extractCalls,0);assert.equal(f.state.reviewCalls,4);assert.deepEqual(f.state.reviewOrigins,Array(4).fill('native-engine'));
});
