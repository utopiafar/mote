import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,StoreError} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {MaterialMemoryWork,type MaterialMemoryRunner} from '../src/material-memory-work.js';

function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-material-memory-')),store=new Store(directory),materials=new MaterialStore(store);
  let now=1000;const work=new MaterialMemoryWork(store,materials,()=>now);
  new SourceStore(store).register({id:'generated-source',name:'Generated',kind:'custom',deviceId:'fixture',platform:'import'});
  const receive=(inputKey:string,automatic=true)=>{store.db.exec('BEGIN IMMEDIATE');try{work.inputs.receive({sourceId:'generated-source',inputKey},automatic);store.db.exec('COMMIT');}catch(error){store.db.exec('ROLLBACK');throw error;}};
  t.after(async()=>{await new Promise(resolve=>setImmediate(resolve));store.close();rmSync(directory,{recursive:true,force:true});});
  const draft=(text='Generated material body',artifacts:MaterialDraft['artifacts']=[{key:'source-body',state:'ready'},{key:'extracted-text',state:'pending'}],anchor=true):MaterialDraft=>({
    id:materialId('generated-source','generated-item'),kind:'mote.file',schemaVersion:1,title:'Generated file',
    origin:{sourceId:'generated-source',externalId:'generated-item'},
    blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['original']}],
    members:[{id:'original',kind:anchor?'archive':'capture',ref:anchor?'archive:generated':'capture:00000000-0000-4000-8000-000000000000'}],
    coverage:{state:'partial',reason:'processing_pending'},artifacts,
    fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'},
  });
  return {store,materials,work,draft,receive,advance:(ms:number)=>{now+=ms;}};
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

test('raw input grant survives initial processing, but completed input cannot be replayed by a derived revision',async t=>{
  const {materials,work,draft,receive}=fixture(t),fake=fakeRunner();
  const first=materials.publish(draft('',[{key:'source-body',state:'pending'}]));
  receive('raw-1');work.observe(first.id,['source-body'],{inputKey:'raw-1',change:'source'});
  assert.equal(work.drain(fake.runner,true),0);
  const processed=materials.publish(draft('Generated first extraction'),{expectedRevision:first.revision});
  work.observe(processed.id,['source-body'],{inputKey:'raw-1',change:'rebuild'});
  assert.equal(work.drain(fake.runner,true),1);
  await new Promise(resolve=>setImmediate(resolve));
  fake.jobs.get('memory-1')!.status='completed';
  const rebuilt=materials.publish(draft('Generated replacement processing'),{expectedRevision:processed.revision});
  work.observe(rebuilt.id,['source-body'],{inputKey:'raw-1',change:'rebuild'});
  assert.equal(work.readyForMemory(rebuilt.ref),true,'explicit owner requests may use current evidence');
  assert.equal(work.drain(fake.runner,true),0);
  assert.equal(fake.created.length,1,'processing version does not renew the paid grant');
  // A processing completion also appears in the source change journal. Its
  // unchanged raw identity must not bypass the same boundary.
  work.observe(rebuilt.id,['source-body'],{inputKey:'raw-1',change:'source'});
  assert.equal(work.drain(fake.runner,true),0);
  const revised=materials.publish(draft('Generated new original'),{expectedRevision:rebuilt.revision});
  receive('raw-2');work.observe(revised.id,['source-body'],{inputKey:'raw-2',change:'source'});
  assert.equal(work.drain(fake.runner,true),1);
  assert.equal(fake.created.length,2);
});

test('installation and later enabling do not grant historical work; revocation runs even while disabled',async t=>{
  const {store,materials,work,draft,receive}=fixture(t),fake=fakeRunner();
  const first=materials.publish(draft());
  work.observe(first.id,['source-body'],{inputKey:'old-raw',change:'rebuild'});
  assert.equal(work.readyForMemory(first.ref),true);
  assert.equal(work.drain(fake.runner,true),0);
  const second=materials.publish(draft('Received while disabled'),{expectedRevision:first.revision});
  receive('new-raw',false);work.observe(second.id,['source-body'],{inputKey:'new-raw',change:'source',automatic:false});
  work.observe(second.id,['source-body'],{inputKey:'new-raw',change:'rebuild',automatic:true});
  assert.equal(work.drain(fake.runner,true),0);
  const recovered=new MaterialMemoryWork(store,materials);
  assert.equal(recovered.drain(fake.runner,true),0,'restart does not manufacture a missing grant');
  const third=materials.publish(draft('Fresh enabled original'),{expectedRevision:second.revision});
  receive('fresh-raw');recovered.observe(third.id,['source-body'],{inputKey:'fresh-raw',change:'source'});
  assert.equal(recovered.drain(fake.runner,true),1);
  await new Promise(resolve=>setImmediate(resolve));
  recovered.observe(third.id,['source-body'],{inputKey:'fresh-raw',change:'rebuild',automatic:false});
  recovered.drain(fake.runner,false);
  assert.deepEqual(fake.cancelled,['memory-1']);
  assert.equal(recovered.readyForMemory(third.ref),true,'disable keeps evidence and historical artifacts');
});

test('forgetting a material removes even unscheduled authorization state and cancels its queued job',async t=>{
  const {store,materials,work,draft,receive}=fixture(t),fake=fakeRunner();
  const first=materials.publish(draft());receive('raw');work.observe(first.id,['source-body'],{inputKey:'raw',change:'source'});
  work.drain(fake.runner,true);await new Promise(resolve=>setImmediate(resolve));
  materials.forget(first.id);work.drain(fake.runner,false);
  assert.deepEqual(fake.cancelled,['memory-1']);
  assert.equal(store.db.prepare('SELECT count(*) n FROM material_memory_requests').get()!.n,0);
  const second=materials.publish(draft());work.observe(second.id,['source-body'],{inputKey:'history',change:'rebuild'});
  materials.forget(second.id);
  assert.equal(store.db.prepare('SELECT count(*) n FROM material_memory_requests').get()!.n,0);
});

test('a revoked grant cannot start a job between queue claim and asynchronous launch',async t=>{
  const {materials,work,draft,receive}=fixture(t),fake=fakeRunner();
  const material=materials.publish(draft());receive('raw');work.observe(material.id,['source-body'],{inputKey:'raw',change:'source'});
  assert.equal(work.drain(fake.runner,true),1);
  work.observe(material.id,['source-body'],{inputKey:'raw',change:'rebuild',automatic:false});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(fake.ran,[]);
  work.drain(fake.runner,false);assert.deepEqual(fake.cancelled,['memory-1']);
});

test('named ready artifact admits partial material; pending, failed, missing, default material and absent anchor do not',t=>{
  const {store,materials,work,draft}=fixture(t);
  const material=materials.publish(draft());
  work.observe(material.id,['source-body'],{inputKey:material.revision,change:'source'});assert.equal(work.readyForMemory(material.ref),true);
  assert.equal(materials.get(material.ref)?.coverage.state,'partial');
  work.observe(material.id,['extracted-text'],{inputKey:material.revision,change:'source'});assert.equal(work.readyForMemory(material.ref),false);
  work.observe(material.id,['missing-artifact'],{inputKey:material.revision,change:'source'});assert.equal(work.readyForMemory(material.ref),false);
  work.observe(material.id,['material'],{inputKey:material.revision,change:'source'});assert.equal(work.readyForMemory(material.ref),false);
  const failed=materials.publish(draft('Generated failed body',[{key:'source-body',state:'ready'},{key:'extracted-text',state:'failed'}]),{expectedRevision:material.revision});
  work.observe(failed.id,['extracted-text'],{inputKey:failed.revision,change:'source'});assert.equal(work.readyForMemory(failed.ref),false);
  // Synthetic anchors are currently built by MaterialStore for archived members.
  // Removing the anchor simulates a source-item body not yet represented as evidence.
  store.db.prepare('DELETE FROM material_evidence WHERE material_id=? AND revision=?').run(failed.id,failed.revision);
  work.observe(failed.id,['source-body'],{inputKey:failed.revision,change:'source'});assert.equal(work.readyForMemory(failed.ref),false);
  assert.equal(work.readyForMemory(material.ref),false);
});

test('queue resumes after restart, pins revision and cancels work after supersession or withdrawal',async t=>{
  const {store,materials,work,draft,advance,receive}=fixture(t),fake=fakeRunner();
  const first=materials.publish(draft('Generated version one'));
  receive(first.revision);work.observe(first.id,['source-body'],{inputKey:first.revision,change:'source'},100);
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
  receive(second.revision);recovered.observe(second.id,['source-body'],{inputKey:second.revision,change:'source'});
  assert.equal(recovered.readyForMemory(first.ref),false);
  assert.equal(recovered.readyForMemory(second.ref),true);
  assert.equal(recovered.drain(fake.runner,true),1);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(fake.cancelled,['memory-1']);assert.deepEqual(fake.created,[first.ref,second.ref]);
  recovered.withdraw(second.id);assert.equal(recovered.readyForMemory(second.ref),false);
  recovered.drain(fake.runner,true);assert.deepEqual(fake.cancelled,['memory-1','memory-2']);
});

test('retired material and disabled scheduling cannot authorize memory',t=>{
  const {materials,work,draft,receive}=fixture(t),fake=fakeRunner();
  const material=materials.publish(draft());receive(material.revision);work.observe(material.id,['source-body'],{inputKey:material.revision,change:'source'});
  assert.equal(work.drain(fake.runner,false),0);assert.equal(fake.created.length,0);
  materials.retire(material.id,{expectedRevision:material.revision});
  assert.equal(work.readyForMemory(material.ref),false);
  work.drain(fake.runner,true);assert.equal(fake.created.length,0);
});

test('completed, failed and cancelled receipts do not starve new materials with a one-job drain limit',t=>{
  const {materials,work,draft,receive}=fixture(t),fake=fakeRunner();
  const publish=(externalId:string)=>materials.publish({...draft(`Body for ${externalId}`),
    id:materialId('generated-source',externalId),origin:{sourceId:'generated-source',externalId}});
  const first=publish('first');receive(first.revision);work.observe(first.id,['source-body'],{inputKey:first.revision,change:'source'});
  assert.equal(work.drain(fake.runner,true,1),1);
  fake.jobs.get('memory-1')!.status='completed';
  const second=publish('second');receive(second.revision);work.observe(second.id,['source-body'],{inputKey:second.revision,change:'source'});
  assert.equal(work.drain(fake.runner,true,1),1);
  assert.deepEqual(fake.created,[first.ref,second.ref]);
  fake.jobs.get('memory-2')!.status='failed';
  const third=publish('third');receive(third.revision);work.observe(third.id,['source-body'],{inputKey:third.revision,change:'source'});
  assert.equal(work.drain(fake.runner,true,1),1);
  assert.deepEqual(fake.created,[first.ref,second.ref,third.ref]);
  fake.jobs.get('memory-3')!.status='cancelled';
  const fourth=publish('fourth');receive(fourth.revision);work.observe(fourth.id,['source-body'],{inputKey:fourth.revision,change:'source'});
  assert.equal(work.drain(fake.runner,true,1),1);
  assert.deepEqual(fake.created,[first.ref,second.ref,third.ref,fourth.ref]);
  assert.equal(work.readyForMemory(first.ref),true);
  assert.equal(work.readyForMemory(second.ref),true);
});

test('queue schema upgrade preserves material readiness and retires unpinned automatic work without replay',async t=>{
  const {store,materials,work,draft,receive}=fixture(t),fake=fakeRunner();
  const first=materials.publish(draft());receive('old-input');work.observe(first.id,['source-body'],{inputKey:'old-input',change:'source'});work.drain(fake.runner,true);
  await new Promise(resolve=>setImmediate(resolve));const evidence=materials.evidenceIds(first.ref);
  // An actual prior schema snapshot, not a second migration implementation.
  store.db.exec(`DROP TRIGGER material_memory_forget;
    DROP TRIGGER IF EXISTS ledger_material_memory_requests_insert; DROP TRIGGER IF EXISTS ledger_material_memory_requests_update; DROP TRIGGER IF EXISTS ledger_material_memory_requests_delete;
    DELETE FROM storage_ledger WHERE name='material_memory_requests'; DROP INDEX material_memory_requests_due;
    ALTER TABLE material_memory_requests RENAME TO scoped_fixture;
    CREATE TABLE material_memory_requests(material_id TEXT PRIMARY KEY,revision TEXT NOT NULL,required_json TEXT NOT NULL,ready_at INTEGER NOT NULL,job_id TEXT,error TEXT,input_key TEXT NOT NULL,auto_authorized INTEGER NOT NULL);
    INSERT INTO material_memory_requests SELECT material_id,revision,required_json,ready_at,job_id,error,input_key,auto_authorized FROM scoped_fixture;
    DROP TABLE scoped_fixture;`);
  const upgraded=new MaterialMemoryWork(store,materials);
  assert.equal(upgraded.readyForMemory(first.ref),true);assert.deepEqual(materials.evidenceIds(first.ref),evidence);
  assert.equal(upgraded.drain(fake.runner,true),0);assert.deepEqual(fake.cancelled,['memory-1']);assert.equal(fake.created.length,1);
  upgraded.observe(first.id,['source-body'],{inputKey:'old-input',change:'rebuild'});assert.equal(upgraded.drain(fake.runner,true),0);
  const next=materials.publish(draft('A newly received original'),{expectedRevision:first.revision});receive('new-input');upgraded.observe(next.id,['source-body'],{inputKey:'new-input',change:'source'});
  assert.equal(upgraded.drain(fake.runner,true),1);
});

test('a removed job in the cancellation journal does not indefinitely block unrelated fresh work',async t=>{
  const {materials,work,draft,receive}=fixture(t),fake=fakeRunner();
  const first=materials.publish(draft());receive('first');work.observe(first.id,['source-body'],{inputKey:'first',change:'source'});work.drain(fake.runner,true);
  await new Promise(resolve=>setImmediate(resolve));work.withdraw(first.id);fake.jobs.delete('memory-1');
  const next=materials.publish(draft('Fresh original'),{expectedRevision:first.revision});receive('second');work.observe(next.id,['source-body'],{inputKey:'second',change:'source'});
  const cancel=fake.runner.cancel;fake.runner.cancel=id=>{if(!fake.jobs.has(id))throw new StoreError('Memory job not found',404);return cancel(id);};
  assert.equal(work.drain(fake.runner,true),1);
});
