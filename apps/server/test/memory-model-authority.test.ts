import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MaterialStore} from '../src/materials.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {createMemoryModelAuthorityJobReader} from '../src/memory-model-authority.js';

test('Memory authority projection reads produced jobs without model execution, preserves grant precedence and fresh durable metadata',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-model-authority-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 const reader=createMemoryModelAuthorityJobReader(store);
 const pipeline=new MemoryPipeline({store,memories,models:{model:()=> 'generated',configured:()=>true},phases:{query:async()=>{throw Error('Reading metadata must not invoke a model');}}});
 t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
 sources.register({id:'generated',name:'Generated originals',kind:'custom',deviceId:'generated-device',platform:'import'});
 const record=await sources.upsert('generated',{externalId:'original',revision:'1',text:'Generated original for authorization metadata',observedAt:'2026-09-15T01:00:00Z',kind:'file',layer:'original'});
 const first={sourceId:'generated',inputKey:'first-receipt',scope:'memory.first'},second={sourceId:'generated',inputKey:'second-receipt',scope:'memory.second'};
 const manual=pipeline.create({evidenceIds:[record.id]}),single=pipeline.create({evidenceIds:[record.id],automaticGrant:first}),pooled=pipeline.create({evidenceIds:[record.id],automaticGrant:first,automaticGrants:[second]});
 assert.equal(reader.modelAuthorityJob('missing-generated-job'),undefined);
 assert.deepEqual(Object.keys(reader),['modelAuthorityJob']);
 for(const [job,grants] of [[manual,[]],[single,[first]],[pooled,[second]]] as const){
  const expected={id:job.id,automaticGrants:grants,evidenceIds:[record.id]},projection=reader.modelAuthorityJob(job.id)!;
  assert.deepEqual(projection,expected);
  projection.evidenceIds.length=0;projection.automaticGrants.length=0;
  assert.deepEqual(reader.modelAuthorityJob(job.id),expected,'mutating a projection cannot replace durable authorization metadata');
  assert.equal(pipeline.get(job.id).status,'queued');
 }
 // The dependency fixture installs the referenced Material schema before deleting its job.
 new MaterialStore(store);
 store.db.prepare('DELETE FROM memory_jobs WHERE id=?').run(manual.id);
 assert.equal(reader.modelAuthorityJob(manual.id),undefined,'lookup observes current metadata rather than caching a deleted job');
});
