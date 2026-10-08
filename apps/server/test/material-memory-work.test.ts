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

for(const planned of [false,true])for(const prior of ['paused','failed'])test(`explicitly resumed ${prior} product rejoins the ${planned?'planned':'legacy'} queue after restart without renewing a grant`,async t=>{
  const {store,materials,work,draft,receive,advance}=fixture(t),fake=fakeRunner(),material=materials.publish(draft());receive('raw');work.observe(material.id,['source-body'],{inputKey:'raw',change:'source'});
  const planner=async(catalog:import('../src/material-memory-work.js').MemoryWorkCandidate[])=>[{members:catalog.map(item=>item.key),goal:'Inspect generated original',instruction:'Preserve identity'}];
  const drain=(queue:MaterialMemoryWork,enabled=true)=>planned?queue.drainPlanned(fake.runner,enabled,planner):queue.drain(fake.runner,enabled);
  await drain(work);await new Promise(resolve=>setImmediate(resolve));fake.jobs.get('memory-1')!.status=prior;advance(6000);await drain(work);
  assert.equal(store.db.prepare('SELECT ready_at FROM material_memory_requests').get()!.ready_at,Number.MAX_SAFE_INTEGER);
  fake.ran.length=0;
  const recovered=new MaterialMemoryWork(store,materials,()=>7000);
  await drain(recovered);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fake.ran,[],'terminal failures and pauses do not automatically retry');
  fake.jobs.get('memory-1')!.status='queued';
  await drain(recovered,false);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fake.ran,[],'disabled scheduling cannot launch an explicit resume');
  await drain(recovered);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fake.ran,['memory-1']);assert.equal(fake.created.length,1);
  const row=store.db.prepare('SELECT ready_at,error,job_id FROM material_memory_requests').get()!;
  assert.equal(row.job_id,'memory-1');assert.equal(row.error,null);assert.ok(Number(row.ready_at)<Number.MAX_SAFE_INTEGER);
  assert.equal(store.db.prepare('SELECT job_id FROM memory_input_authorizations').get()!.job_id,'memory-1','the existing claim is preserved');
});

test('dormant queue rotation skips a full page of paused products and preserves a revoked resumed grant',async t=>{
  const {store,materials,work,draft,receive,advance}=fixture(t),fake=fakeRunner();
  for(let n=0;n<12;n++){const externalId='item-'+String(n).padStart(2,'0'),material=materials.publish({...draft(),id:materialId('generated-source',externalId),origin:{sourceId:'generated-source',externalId}});receive(externalId);work.observe(material.id,['source-body'],{inputKey:externalId,change:'source'});}
  work.drain(fake.runner,true,100);await new Promise(resolve=>setImmediate(resolve));for(const job of fake.jobs.values())job.status='paused';advance(6000);work.drain(fake.runner,true,100);fake.ran.length=0;
  const rows=store.db.prepare('SELECT material_id,scope,job_id FROM material_memory_requests ORDER BY material_id,scope').all(),last=rows.at(-1)!;fake.jobs.get(String(last.job_id))!.status='queued';
  const recovered=new MaterialMemoryWork(store,materials,()=>7000);recovered.drain(fake.runner,true,10);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fake.ran,[]);recovered.drain(fake.runner,true,10);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(fake.ran,[last.job_id]);
  const revoked=rows[0];fake.jobs.get(String(revoked.job_id))!.status='queued';store.db.prepare('UPDATE memory_input_authorizations SET authorized=0 WHERE job_id=?').run(revoked.job_id);
  recovered.drain(fake.runner,true,10);await new Promise(resolve=>setImmediate(resolve));assert.equal(fake.ran.includes(String(revoked.job_id)),false);
  recovered.drain(fake.runner,false,10);assert.ok(fake.cancelled.includes(String(revoked.job_id)));
  assert.equal(fake.created.length,12);
});

test('model-selected packages atomically consume independent receipts and preserve cross-source identities',async t=>{
  const {store,materials,work,draft,receive}=fixture(t),fake=fakeRunner();
  const one=materials.publish(draft('Generated first diary'));receive('first-raw');work.observe(one.id,['source-body'],{inputKey:'first-raw',change:'source'});
  new SourceStore(store).register({id:'generated-other',name:'Other generated source',kind:'custom',deviceId:'other-fixture',platform:'import'});
  const two=materials.publish({...draft('Generated second diary'),id:materialId('generated-other','second'),origin:{sourceId:'generated-other',externalId:'second'}});store.db.exec('BEGIN IMMEDIATE');work.inputs.receive({sourceId:'generated-other',inputKey:'second-raw'});store.db.exec('COMMIT');work.observe(two.id,['source-body'],{inputKey:'second-raw',change:'source'});
  let created:Parameters<MaterialMemoryRunner['create']>[0]|undefined;const runner={...fake.runner,create:(input:Parameters<MaterialMemoryRunner['create']>[0])=>{created=input;return fake.runner.create(input);}};
  assert.equal(await work.drainPlanned(runner,true,async catalog=>[{members:catalog.map(item=>item.key),goal:'Inspect both original diaries',instruction:'Keep each original identity'}]),1);
  assert.equal(created?.automaticGrants?.length,2);assert.equal(created?.workPackage?.inputs?.length,2);assert.deepEqual(created?.workPackage?.inputs?.map(input=>input.inputKey).sort(),['first-raw','second-raw']);
  assert.equal(store.db.prepare('SELECT count(DISTINCT job_id) n FROM memory_input_authorizations WHERE job_id IS NOT NULL').get()!.n,1);
  assert.equal(work.authorized({id:'memory-1',automaticGrants:created!.automaticGrants}),true);
  work.observe(two.id,['source-body'],{inputKey:'second-raw',change:'rebuild',automatic:false});
  assert.equal(work.authorized({id:'memory-1',automaticGrants:created!.automaticGrants}),false,'one revoked receipt cannot retain a package grant');
  work.drain(fake.runner,false);assert.deepEqual(fake.cancelled,['memory-1']);
});

test('a planning race leaves every receipt unconsumed and planning metadata never grants unseen content',async t=>{
  const {store,materials,work,draft,receive}=fixture(t),fake=fakeRunner();
  const material=materials.publish(draft());receive('fresh');work.observe(material.id,['source-body'],{inputKey:'fresh',change:'source'});
  assert.equal(await work.drainPlanned(fake.runner,true,async catalog=>{assert.ok(!JSON.stringify(catalog).includes('Generated material body'));work.observe(material.id,['source-body'],{inputKey:'fresh',change:'rebuild',automatic:false});return [{members:[catalog[0].key],goal:'Inspect',instruction:'Original only'}];}),0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE job_id IS NOT NULL').get()!.n,0);assert.equal(fake.created.length,0);
});

test('a failed member claim does not consume the successful prefix of a package',t=>{
  const {store,work,receive}=fixture(t);receive('one');receive('two',false);
  store.db.exec('BEGIN IMMEDIATE');try{assert.equal(work.inputs.claimMany([{sourceId:'generated-source',inputKey:'one',scope:'memory.default'},{sourceId:'generated-source',inputKey:'two',scope:'memory.default'}],'package'),false);store.db.exec('COMMIT');}catch(error){store.db.exec('ROLLBACK');throw error;}
  assert.equal(work.inputs.available('generated-source','one'),true);assert.equal(store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE job_id IS NOT NULL').get()!.n,0);
});

test('bounded planning catalogs interleave sources before a large older backlog can hide a newer source',t=>{
  const {store,materials,work,draft,receive,advance}=fixture(t);
  for(let index=0;index<20;index++){
    const externalId='generated-backlog-'+index,material=materials.publish({...draft('Generated older diary '+index),id:materialId('generated-source',externalId),origin:{sourceId:'generated-source',externalId}});
    receive('older-'+index);work.observe(material.id,['source-body'],{inputKey:'older-'+index,change:'source'});
  }
  advance(1000);
  new SourceStore(store).register({id:'generated-later-source',name:'Later generated source',kind:'custom',deviceId:'fixture-later',platform:'import'});
  const externalId='generated-later-diary',later=materials.publish({...draft('Generated later source diary'),id:materialId('generated-later-source',externalId),origin:{sourceId:'generated-later-source',externalId}});
  store.db.exec('BEGIN IMMEDIATE');work.inputs.receive({sourceId:'generated-later-source',inputKey:'later'});store.db.exec('COMMIT');work.observe(later.id,['source-body'],{inputKey:'later',change:'source'});
  const catalog=work.catalog(8);
  assert.equal(catalog.length,8);
  assert.equal(catalog[1].sourceId,'generated-later-source','the first pending member of each source precedes a second member');
  assert.equal(new Set(catalog.map(member=>member.key)).size,8);
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_input_authorizations WHERE job_id IS NOT NULL').get()!.n,0,'catalog fairness cannot consume grants');
});

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

test('current scoped queue reopens without replaying completed automatic work',async t=>{
 const {store,materials,work,draft,receive}=fixture(t),fake=fakeRunner();const first=materials.publish(draft());receive('input');work.observe(first.id,['source-body'],{inputKey:'input',change:'source'});assert.equal(work.drain(fake.runner,true),1);await new Promise(resolve=>setImmediate(resolve));
 fake.jobs.get('memory-1')!.status='completed';const reopened=new MaterialMemoryWork(store,materials);assert.equal(reopened.readyForMemory(first.ref),true);assert.equal(reopened.drain(fake.runner,true),0);assert.deepEqual(fake.cancelled,[]);assert.equal(fake.created.length,1);
});

test('a removed job in the cancellation journal does not indefinitely block unrelated fresh work',async t=>{
  const {materials,work,draft,receive}=fixture(t),fake=fakeRunner();
  const first=materials.publish(draft());receive('first');work.observe(first.id,['source-body'],{inputKey:'first',change:'source'});work.drain(fake.runner,true);
  await new Promise(resolve=>setImmediate(resolve));work.withdraw(first.id);fake.jobs.delete('memory-1');
  const next=materials.publish(draft('Fresh original'),{expectedRevision:first.revision});receive('second');work.observe(next.id,['source-body'],{inputKey:'second',change:'source'});
  const cancel=fake.runner.cancel;fake.runner.cancel=id=>{if(!fake.jobs.has(id))throw new StoreError('Memory job not found',404);return cancel(id);};
  assert.equal(work.drain(fake.runner,true),1);
});

test('pure attribution correction withdraws claimed and unclaimed work without renewing a raw receipt',async t=>{
  const {store,materials,work,draft,receive}=fixture(t),fake=fakeRunner();
  let current=materials.publish(draft());receive('initial');work.observe(current.id,['source-body'],{inputKey:'initial',change:'source'});
  assert.equal(work.drain(fake.runner,true),1);await new Promise(resolve=>setImmediate(resolve));
  const receipt=store.db.prepare('SELECT * FROM memory_input_authorizations').get();
  const corrected=materials.correctContext(current.id,current.revision,'third_party');
  assert.notEqual(corrected.revision,current.revision);assert.equal(store.db.prepare('SELECT count(*) n FROM material_memory_requests').get()!.n,0);
  work.drain(fake.runner,true);assert.deepEqual(fake.cancelled,['memory-1']);assert.deepEqual(store.db.prepare('SELECT * FROM memory_input_authorizations').get(),receipt);
  work.observe(corrected.id,['source-body'],{inputKey:'initial',change:'rebuild'});assert.equal(work.drain(fake.runner,true),0);
  current=materials.publish(draft('Generated new input'),{expectedRevision:corrected.revision});receive('second');work.observe(current.id,['source-body'],{inputKey:'second',change:'source'});
  const before=store.db.prepare('SELECT * FROM memory_input_authorizations ORDER BY input_key').all();
  const second=materials.correctContext(current.id,current.revision,'mixed');
  work.observe(second.id,['source-body'],{inputKey:'second',change:'rebuild'});assert.equal(work.drain(fake.runner,true),0);
  assert.deepEqual(store.db.prepare('SELECT * FROM memory_input_authorizations ORDER BY input_key').all(),before,'an unclaimed receipt is not reused by correction');
  assert.equal(fake.created.length,1);
});
