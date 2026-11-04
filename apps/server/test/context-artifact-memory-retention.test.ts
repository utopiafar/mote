import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {MemoryStore} from '../src/memory.js';
import {SourceStore} from '../src/sources.js';
import {reviewMemory} from '../src/memory-review.js';
import {fixtureMemoryPipeline} from './fixtures/memory-result.js';

async function fixture(t:any){
 const directory=await mkdtemp(join(tmpdir(),'mote-artifact-memory-'));let store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store),calls=0;
 sources.register({id:'generated',name:'Generated original',kind:'custom',deviceId:'generated',platform:'import'});
 const item=(revision:string,text:string)=>({externalId:'generated-original',revision,observedAt:`2026-10-0${revision}T00:00:00Z`,kind:'message',layer:'original',text});
 const first=await sources.upsert('generated',item('1','I prefer a blue bowl.'));
 const inputs=()=>[{id:first.id,fingerprint:store.archive.fingerprint(first.id)!}],id='a'.repeat(64),group='generated-group',output={kind:'semantic',text:'Generated contextual interpretation',metadata:{evidenceRanges:[{id:first.id,offset:0,length:21}]}};
 const publish=(revision='1'.repeat(64),text=output.text)=>store.archive.save(id,group,revision,{...output,text},inputs(),'generated-processor','1','generated-config');
 const artifact=publish();
 const pipeline=fixtureMemoryPipeline({store,memories,models:{configured:()=>true,model:()=> 'generated-model'},phases:{review:async(input,draft)=>{calls++;return reviewMemory(input,draft,async()=>({...draft,runId:randomUUID()}));},query:async input=>{
  calls++;const work=(input.taskContext as any)?.memoryWork,members=work?.members??[];
  return {answer:JSON.stringify({memories:[{title:'Generated preference',statement:`Prefers a blue bowl [${first.id}]`,uncertainty:'Generated only',evidenceIds:[first.id]}],coverage:members.map((member:any)=>({key:member.key,state:'checked',candidateIndexes:[0]}))}),citations:[{id:first.id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',excerpt:'I prefer a blue bowl.'}],trace:[],runId:randomUUID()};
 }}});
 let pipelineClosed=false;t.after(async()=>{if(!pipelineClosed)await pipeline.close();store.close();await rm(directory,{recursive:true,force:true});});
 const job=pipeline.create({evidenceIds:[first.id],artifactRefs:[{id,revision:artifact.revision}],recipes:[{id:'mote.personal-memory',version:'5'}],workPackage:{id:'generated-package',goal:'Inspect the generated original',instruction:'Preserve original provenance'}});
 const done=await pipeline.run(job.id);assert.equal(done.status,'completed',JSON.stringify(done.priorValidationFailure??{errorCode:done.errorCode}));assert.equal(done.memoryIds.length,1);
 const memory=memories.publish(done.memoryIds[0]);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memory_artifact_dependencies WHERE memory_id=?').get(memory.id)!.n,1);
 
 return {get store(){return store;},get sources(){return sources;},get memories(){return memories;},directory,id,group,first,memory,artifact,inputs,publish,pipeline,job,calls:()=>calls,item,async restart(){await pipeline.close();pipelineClosed=true;store.close();store=new Store(directory);sources=new SourceStore(store);memories=new MemoryStore(store);}};
}

test('an identical immutable artifact replay preserves published Memory, checkpoints and descendants without model work',async t=>{
 const f=await fixture(t),checkpoints=f.store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n;
 const child=f.store.archive.save('c'.repeat(64),'generated-child','3'.repeat(64),{kind:'semantic',text:'Generated descendant',metadata:{}},[],'generated','1','generated',[],[{id:f.id,revision:f.artifact.revision}]);
 const events=f.store.db.prepare('SELECT COUNT(*) n FROM artifact_events').get()!.n;
 assert.ok(Number(checkpoints)>0);const replay=f.publish();
 assert.equal(f.memories.get(f.memory.id).status,'published');assert.deepEqual(replay,f.artifact);
 assert.deepEqual(f.store.archive.get(child.id),{...child,text:'Generated descendant'});
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM artifact_events').get()!.n,events);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n,checkpoints);
 await f.pipeline.run(f.job.id);assert.equal(f.calls(),2);
});

test('an immutable replay still validates current input fingerprints before reuse',async t=>{
 const f=await fixture(t);
 assert.throws(()=>f.store.archive.save(f.id,f.group,f.artifact.revision,{kind:'semantic',text:'Generated contextual interpretation',metadata:{evidenceRanges:[{id:f.first.id,offset:0,length:21}]}},[{id:f.first.id,fingerprint:'obsolete'}],'generated-processor','1','generated-config'),/evidence_changed/);
 assert.equal(f.memories.get(f.memory.id).status,'published');assert.equal(f.calls(),2);
});

test('same-revision changed output remains a replacement, without erasing Memory',async t=>{
 const f=await fixture(t);f.publish(f.artifact.revision,'Generated corrected interpretation');
 assert.equal(f.memories.get(f.memory.id).status,'stale');
 assert.equal(f.store.archive.get(f.id)!.text,'Generated corrected interpretation');
});

for(const operation of ['replace','source-revision','parent-cascade'] as const)test(`artifact ${operation} retains stale Memory across restart; explicit original deletion still erases it`,async t=>{
 const f=await fixture(t);
 if(operation==='replace')f.publish('2'.repeat(64),'Generated changed interpretation');
 else if(operation==='source-revision')await f.sources.upsert('generated',f.item('2','I now prefer a green bowl.'));
 else {
  const parent=f.store.archive.save('b'.repeat(64),'generated-parent','1'.repeat(64),{kind:'semantic',text:'Generated parent',metadata:{}},f.inputs(),'generated','1','generated');
  f.store.db.prepare('INSERT INTO artifact_dependencies VALUES(?,?,?)').run(f.id,parent.id,parent.revision);
  f.store.db.prepare('DELETE FROM context_artifacts WHERE id=?').run(parent.id);
 }
 const stale=f.memories.get(f.memory.id);assert.equal(stale.status,'stale');assert.equal(stale.staleReason,'evidence_changed');assert.equal(stale.statement,f.memory.statement);
 assert.equal(f.memories.page().items.some((memory:any)=>memory.id===f.memory.id),false);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n,0);assert.equal(f.calls(),2,'cache invalidation does not grant historical model work');
 await f.restart();assert.equal(f.memories.get(f.memory.id).status,'stale');
 f.store.delete(f.first.id);assert.throws(()=>f.memories.get(f.memory.id),{statusCode:404});
});

test('opening an existing vault replaces the legacy destructive artifact trigger',async t=>{
 const f=await fixture(t);
 f.store.db.exec(`DROP TRIGGER artifact_memory_invalidation;CREATE TRIGGER artifact_memory_invalidation BEFORE DELETE ON context_artifacts BEGIN DELETE FROM memories WHERE id IN (SELECT memory_id FROM memory_artifact_dependencies WHERE artifact_id=old.id);END;`);
 await f.restart();f.store.db.prepare('DELETE FROM context_artifacts WHERE id=?').run(f.id);
 assert.equal(f.memories.get(f.memory.id).status,'stale');
});

test('immutable replay retains descendants for valid mixed-case original UUIDs',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-artifact-case-')),store=new Store(directory);
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const ids=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'];
 for(const id of ids)await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated original '+id});
 const inputs=ids.map(id=>({id,fingerprint:store.archive.fingerprint(id)!})),id='d'.repeat(64),revision='1'.repeat(64),output={kind:'semantic',text:'Generated interpretation',metadata:{}};
 const first=store.archive.save(id,'generated-case',revision,output,inputs,'generated','1','generated');
 const child=store.archive.save('e'.repeat(64),'generated-child',revision,output,[],'generated','1','generated',[],[{id,revision}]);
 const events=store.db.prepare('SELECT COUNT(*) n FROM artifact_events').get()!.n;
 assert.deepEqual(store.archive.save(id,'generated-case',revision,output,inputs,'generated','1','generated'),first);
 assert.ok(store.archive.get(child.id),'an identical original set cannot withdraw descendants');
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM artifact_events').get()!.n,events);
});
