import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {ContentStorageService} from '../src/content-storage.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {decodeMemoryBatch,decodeMemoryJob} from '../src/memory-private-storage.js';

const marker='GENERATED_PRIVATE_WORK_PROSE';
test('private work prose, coverage feedback and drafts obey encryption, owner reads and key retirement',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-memory-private-')),store=new Store(dir,{dataKey:'ab'.repeat(32),contentEncryptionEnabled:true}),sources=new SourceStore(store),memories=new MemoryStore(store);
 sources.register({id:'generated',name:'Generated fixture',kind:'custom',deviceId:'fixture',platform:'import'});
 const id=(await sources.upsert('generated',{externalId:'one',revision:'1',observedAt:'2026-09-01T00:00:00Z',text:'Synthetic evidence.',kind:'file',layer:'original'})).id;
 const pipeline=new MemoryPipeline({store,memories,configured:()=>true,model:()=> 'fixture',query:async input=>({runId:'fixture',trace:[],citations:[],answer:JSON.stringify({memories:[],coverage:(input.taskContext!.memoryWork as any).members.map((member:any)=>({key:member.key,state:'needs_context',candidateIndexes:[],reason:marker,contextRefs:[marker]})),capacity:{saturated:false}})}),review:async(_input,draft)=>({...draft,runId:'fresh-review'})});
 const files=new FileStore(store,sources),archived=new ArchivedFileStore(store),service=new ContentStorageService(store,files,archived);t.after(async()=>{await service.close();await pipeline.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const job=pipeline.create({evidenceIds:[id],workPackage:{id:'private-work',goal:marker,instruction:marker+' instructions'}}),done=await pipeline.run(job.id);
 assert.equal(done.workPackage?.goal,marker);assert.deepEqual(done.batches[0].coverage?.[0].contextRefs,[marker]);
 for(const table of ['memory_jobs','memory_batches','memory_extraction_drafts'])for(const row of store.db.prepare(`SELECT json FROM ${table}`).all()){assert.doesNotMatch(String(row.json),new RegExp(marker));assert.match(String(row.json),/aes:/);}
 assert.equal(store.db.prepare("SELECT json_extract(json,'$.workPackage.id') id FROM memory_jobs WHERE id=?").get(job.id)!.id,'private-work');
 service.configure(false);service.start();for(let attempt=0;attempt<1000&&service.snapshot().job.state==='running';attempt++)await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(service.snapshot().job.state,'completed');assert.equal(service.snapshot().job.failed,0);assert.equal(pipeline.get(job.id).workPackage?.goal,marker);assert.deepEqual(decodeMemoryBatch(store,String(store.db.prepare('SELECT json FROM memory_batches WHERE id=?').get(done.batches[0].id)!.json)).coverage?.[0].contextRefs,[marker]);
 assert.match(String(store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id)!.json),/json:/);const reopened=new Store(dir);try{assert.equal(decodeMemoryJob(reopened,String(reopened.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id)!.json)).workPackage?.goal,marker);}finally{reopened.close();}
});

test('deleting an original removes private and legacy work descriptions and cannot restore them through retry',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-memory-private-delete-')),store=new Store(dir,{dataKey:'ab'.repeat(32),contentEncryptionEnabled:true}),sources=new SourceStore(store),memories=new MemoryStore(store);sources.register({id:'generated',name:'Fixture',kind:'custom',deviceId:'fixture',platform:'import'});
 const id=(await sources.upsert('generated',{externalId:'one',revision:'1',observedAt:'2026-09-01T00:00:00Z',text:'Generated original.',kind:'file',layer:'original'})).id;
 const pipeline=new MemoryPipeline({store,memories,configured:()=>true,model:()=> 'fixture',query:async()=>{throw Error('No model read expected');},review:async(_input,draft)=>draft});t.after(async()=>{await pipeline.close();store.close();rmSync(dir,{recursive:true,force:true});});
 const job=pipeline.create({evidenceIds:[id],workPackage:{id:'deleted-work',goal:marker,instruction:marker}});
 store.delete(id);
 const saved=String(store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id)!.json);assert.doesNotMatch(saved,/aes:|GENERATED_PRIVATE_WORK_PROSE/);assert.equal(JSON.parse(saved).privateRetired,true);
 const done=await pipeline.retry(job.id);assert.equal(done.status,'failed');assert.ok(done.batches.every(batch=>batch.status==='invalidated'));assert.notEqual(done.workPackage?.goal,marker);assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT json FROM memory_jobs WHERE id=?').get(job.id)),/GENERATED_PRIVATE_WORK_PROSE|aes:/);
});
