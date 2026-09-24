import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {MaterialMemoryWork,type MaterialMemoryRunner} from '../src/material-memory-work.js';

function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-material-memory-')),store=new Store(directory),materials=new MaterialStore(store);
  let now=1000;const work=new MaterialMemoryWork(store,materials,()=>now);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const draft=(text='Generated material body',artifacts:MaterialDraft['artifacts']=[{key:'source-body',state:'ready'},{key:'extracted-text',state:'pending'}],anchor=true):MaterialDraft=>({
    id:materialId('generated-source','generated-item'),kind:'mote.file',schemaVersion:1,title:'Generated file',
    origin:{sourceId:'generated-source',externalId:'generated-item'},
    blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['original']}],
    members:[{id:'original',kind:anchor?'archive':'capture',ref:anchor?'archive:generated':'capture:00000000-0000-4000-8000-000000000000'}],
    coverage:{state:'partial',reason:'processing_pending'},artifacts,
    fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'},
  });
  return {store,materials,work,draft,advance:(ms:number)=>{now+=ms;}};
}

function fakeRunner(){
  const jobs=new Map<string,{id:string;status:string}>(),byOrigin=new Map<string,string>(),created:string[]=[],ran:string[]=[],cancelled:string[]=[];
  const runner:MaterialMemoryRunner={
    create:({originKey})=>{let id=byOrigin.get(originKey);if(!id){id=`memory-${byOrigin.size+1}`;byOrigin.set(originKey,id);jobs.set(id,{id,status:'queued'});created.push(originKey);}return {id};},
    get:id=>{const job=jobs.get(id);if(!job)throw Error('Missing memory job');return job;},
    run:async id=>{ran.push(id);},
    cancel:id=>{cancelled.push(id);const job=jobs.get(id);if(job)job.status='cancelled';},
  };
  return {runner,jobs,created,ran,cancelled};
}

test('named ready artifact admits partial material; pending, failed, missing, default material and absent anchor do not',t=>{
  const {store,materials,work,draft}=fixture(t);
  const material=materials.publish(draft());
  work.observe(material.id,['source-body']);assert.equal(work.readyForMemory(material.ref),true);
  assert.equal(materials.get(material.ref)?.coverage.state,'partial');
  work.observe(material.id,['extracted-text']);assert.equal(work.readyForMemory(material.ref),false);
  work.observe(material.id,['missing-artifact']);assert.equal(work.readyForMemory(material.ref),false);
  work.observe(material.id,['material']);assert.equal(work.readyForMemory(material.ref),false);
  const failed=materials.publish(draft('Generated failed body',[{key:'source-body',state:'ready'},{key:'extracted-text',state:'failed'}]),{expectedRevision:material.revision});
  work.observe(failed.id,['extracted-text']);assert.equal(work.readyForMemory(failed.ref),false);
  // Synthetic anchors are currently built by MaterialStore for archived members.
  // Removing the anchor simulates a source-item body not yet represented as evidence.
  store.db.prepare('DELETE FROM material_evidence WHERE material_id=? AND revision=?').run(failed.id,failed.revision);
  work.observe(failed.id,['source-body']);assert.equal(work.readyForMemory(failed.ref),false);
  assert.equal(work.readyForMemory(material.ref),false);
});

test('queue resumes after restart, pins revision and cancels work after supersession or withdrawal',async t=>{
  const {store,materials,work,draft,advance}=fixture(t),fake=fakeRunner();
  const first=materials.publish(draft('Generated version one'));
  work.observe(first.id,['source-body'],100);
  assert.equal(work.drain(fake.runner,true),0);assert.equal(fake.created.length,0);
  advance(100);assert.equal(work.drain(fake.runner,true),1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(fake.created,[first.ref]);assert.deepEqual(fake.ran,['memory-1']);
  const recovered=new MaterialMemoryWork(store,materials,()=>1100);
  assert.equal(recovered.readyForMemory(first.ref),true);
  assert.equal(recovered.drain(fake.runner,true),1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(fake.created,[first.ref]);assert.equal(fake.ran.length,2);
  const second=materials.publish(draft('Generated version two'),{expectedRevision:first.revision});
  recovered.observe(second.id,['source-body']);
  assert.equal(recovered.readyForMemory(first.ref),false);
  assert.equal(recovered.readyForMemory(second.ref),true);
  assert.equal(recovered.drain(fake.runner,true),1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(fake.cancelled,['memory-1']);assert.deepEqual(fake.created,[first.ref,second.ref]);
  recovered.withdraw(second.id);assert.equal(recovered.readyForMemory(second.ref),false);
  recovered.drain(fake.runner,true);assert.deepEqual(fake.cancelled,['memory-1','memory-2']);
});

test('retired material and disabled scheduling cannot authorize memory',t=>{
  const {materials,work,draft}=fixture(t),fake=fakeRunner();
  const material=materials.publish(draft());work.observe(material.id,['source-body']);
  assert.equal(work.drain(fake.runner,false),0);assert.equal(fake.created.length,0);
  materials.retire(material.id,{expectedRevision:material.revision});
  assert.equal(work.readyForMemory(material.ref),false);
  work.drain(fake.runner,true);assert.equal(fake.created.length,0);
});

test('completed, failed and cancelled receipts do not starve new materials with a one-job drain limit',t=>{
  const {materials,work,draft}=fixture(t),fake=fakeRunner();
  const publish=(externalId:string)=>materials.publish({...draft(`Body for ${externalId}`),
    id:materialId('generated-source',externalId),origin:{sourceId:'generated-source',externalId}});
  const first=publish('first');work.observe(first.id,['source-body']);
  assert.equal(work.drain(fake.runner,true,1),1);
  fake.jobs.get('memory-1')!.status='completed';
  const second=publish('second');work.observe(second.id,['source-body']);
  assert.equal(work.drain(fake.runner,true,1),1);
  assert.deepEqual(fake.created,[first.ref,second.ref]);
  fake.jobs.get('memory-2')!.status='failed';
  const third=publish('third');work.observe(third.id,['source-body']);
  assert.equal(work.drain(fake.runner,true,1),1);
  assert.deepEqual(fake.created,[first.ref,second.ref,third.ref]);
  fake.jobs.get('memory-3')!.status='cancelled';
  const fourth=publish('fourth');work.observe(fourth.id,['source-body']);
  assert.equal(work.drain(fake.runner,true,1),1);
  assert.deepEqual(fake.created,[first.ref,second.ref,third.ref,fourth.ref]);
  assert.equal(work.readyForMemory(first.ref),true);
  assert.equal(work.readyForMemory(second.ref),true);
});
