import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {modelConfiguration} from '../src/model-configuration.js';
import {modelSettingsFromConfig} from '../src/model-agent.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
const empty=()=>({answer:'{"memories":[]}',citations:[],trace:[],runId:'generated-config-run'});
const snapshot=(fingerprint='one',revision=1)=>({owner:'models' as const,fingerprint,revision,profileId:'generated-profile',provider:'generated',model:'generated-model'});
async function fixture(t:any){
 const dir=mkdtempSync(join(tmpdir(),'mote-memory-config-')),store=new Store(dir),sources=new SourceStore(store),memories=new MemoryStore(store);
 sources.register({id:'generated',name:'Generated source',kind:'custom',deviceId:'generated',platform:'import'});
 const a=await sources.upsert('generated',{externalId:'long',revision:'1',observedAt:'2024-01-01T00:00:00Z',title:'Generated note',kind:'file',layer:'original',text:'文'.repeat(600)});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,memories,id:a.id};
}
for(const changed of [false,true])test(`Memory configuration ${changed?'blocks changed extraction before review and rebases only on retry':'ignores an unrelated saved revision'}`,async t=>{
 const f=await fixture(t);let config=snapshot(),calls=0,reviews=0;
 const pipeline=new MemoryPipeline({...f,batchCharacters:256,model:()=>config.model,configured:()=>true,configuration:()=>config,query:async()=>{calls++;if(calls===1)config=snapshot(changed?'two':'one',2);return empty();},review:async(_input,result)=>{reviews++;return result;}} as ConstructorParameters<typeof MemoryPipeline>[0]);t.after(()=>pipeline.close());
 const job=pipeline.create({evidenceIds:[f.id]}),first=await pipeline.run(job.id);
 if(changed){assert.equal(first.status,'waiting_for_model');assert.equal(first.errorCode,'configuration_changed');assert.equal(first.completedBatches,0);assert.equal(reviews,0);assert.equal(calls,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);assert.equal((await pipeline.retry(job.id)).status,'completed');assert.equal(calls,4);}
 else {assert.equal(first.status,'completed');assert.equal(calls,3);}
 const done=pipeline.get(job.id);assert.equal(reviews,3);assert.ok(done.batches.every(b=>(b as any).configuration.fingerprint===(changed?'two':'one')));
});

test('Memory recovery preserves configuration and completed checkpoints until explicit rebase',async t=>{
 const f=await fixture(t);let config=snapshot(),available=true,calls=0;
 const options={...f,batchCharacters:256,model:()=>config.model,configured:()=>available,configuration:()=>config,query:async()=>{calls++;if(calls===1)available=false;return empty();}};
 let pipeline=new MemoryPipeline(options);const job=pipeline.create({evidenceIds:[f.id]});assert.equal((await pipeline.run(job.id)).completedBatches,1);await pipeline.close();
 config=snapshot('two',2);available=true;pipeline=new MemoryPipeline(options);t.after(()=>pipeline.close());
 const blocked=await pipeline.run(job.id);assert.equal(blocked.status,'waiting_for_model');assert.equal(blocked.errorCode,'configuration_changed');assert.equal(calls,1);
 const done=await pipeline.retry(job.id);assert.equal(done.status,'completed');assert.equal(calls,3);assert.equal((done.batches[0] as any).configuration.fingerprint,'one');assert.equal((done.batches[1] as any).configuration.fingerprint,'two');
});


test('model receipts exclude credentials and ignore unrelated revisions and object key order',()=>{
 const settings=modelSettingsFromConfig({model:'generated-model',apiKey:'generated-secret',modelHeaders:{first:'one',second:'two'}} as Parameters<typeof modelSettingsFromConfig>[0]);
 const first=modelConfiguration('fixture',settings,1),same=modelConfiguration('fixture',{...settings,headers:{second:'two',first:'one'}},2);
 assert.equal(first.fingerprint,same.fingerprint);assert.notEqual(first.revision,same.revision);assert.ok(!JSON.stringify(first).includes('generated-secret'));
 assert.notEqual(first.fingerprint,modelConfiguration('fixture',{...settings,apiKey:'replacement'},1).fingerprint);
 assert.notEqual(first.fingerprint,modelConfiguration('fixture',{...settings,model:'another-model'},1).fingerprint);
});

test('a configuration change during Memory review cannot save candidates or checkpoints',async t=>{
 const f=await fixture(t);let config=snapshot(),reviews=0;
 const pipeline=new MemoryPipeline({...f,model:()=>config.model,configuration:()=>config,configured:()=>true,query:async()=>empty(),review:async()=>{reviews++;config=snapshot('changed',2);return empty();}});t.after(()=>pipeline.close());
 const job=pipeline.create({evidenceIds:[f.id]}),done=await pipeline.run(job.id);assert.equal(done.status,'waiting_for_model');assert.equal(done.errorCode,'configuration_changed');assert.equal(reviews,1);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);assert.equal(done.memoryIds.length,0);
});
