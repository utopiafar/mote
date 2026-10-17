import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {scopedFilesFixture} from './fixtures/scoped-files.js';
import {waitForScopedState} from './fixtures/scoped-process.js';

test('original processing preview and explicit reprocess retain owner and stale-state boundaries',async t=>{
 const f=await scopedFilesFixture(t),policy={version:1,services:[],profiles:[{id:'text',name:'Generated text',processorId:'text.utf8',parameters:{},summarize:false},{id:'archive',name:'Generated original only',processorId:'archive',parameters:{},summarize:false}],rules:[{type:'text/*',profileId:'text'},{type:'*/*',profileId:'archive'}]};
 for(const account of [f.a,f.b]){const page=await f.checked(account.token,'/api/file-processing');await f.checked(account.token,'/api/file-processing','PUT',{revision:page.revision,settings:{...page.settings,automatic:true},policy});}
 const a=await f.upload(f.a.token,'same-preview-file','GENERATED_A_PREVIEW'),b=await f.upload(f.b.token,'same-preview-file','GENERATED_B_PREVIEW');assert.equal(a.id,b.id);
 for(const [account,file]of [[f.a,a],[f.b,b]])await waitForScopedState(async()=>Boolean((await f.checked(account.token,'/api/files/'+file.id)).processing.indexed),()=> 'Waiting for generated text publication',8000);
 const page=await f.checked(f.a.token,'/api/file-processing'),preview=await f.request(f.a.token,'/api/file-processing/preview','POST',{revision:page.revision,sourceId:'same-source',type:'text/*',profileId:'text'});assert.equal(preview.statusCode,200,preview.body);const selected=preview.json();assert.equal(selected.count,1);assert.equal(selected.items[0].id,a.id);assert.equal(selected.bounded,false);
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'),{readOnly:true});try{
  const tasks=(user:string)=>db.prepare("SELECT u.task_id FROM user_tasks u JOIN execution_steps e ON e.id=u.task_id AND e.user_id=u.user_id WHERE u.user_id=? AND e.kind='processing.pipeline' ORDER BY u.task_id").all(user),beforeA=tasks(f.a.userId),beforeB=tasks(f.b.userId);
  assert.equal((await f.request(f.b.token,'/api/file-processing/reprocess','POST',{token:selected.token})).statusCode,409);assert.deepEqual(tasks(f.b.userId),beforeB);
  const result=await f.checked(f.a.token,'/api/file-processing/reprocess','POST',{token:selected.token});assert.equal(result.queued,1);assert.equal(tasks(f.a.userId).length,beforeA.length+1);assert.deepEqual(tasks(f.b.userId),beforeB);
  assert.equal((await f.request(f.a.token,'/api/file-processing/reprocess','POST',{token:selected.token})).statusCode,409,'a consumed preview cannot repeat admission');
  await waitForScopedState(async()=>{const detail=await f.checked(f.a.token,'/api/files/'+a.id);return detail.processing.indexed&&detail.job?.state==='succeeded';},()=> 'Waiting for explicit reprocessing',8000);
  const fresh=await f.checked(f.a.token,'/api/file-processing/preview','POST',{revision:page.revision,type:'text/*'});await f.checked(f.a.token,'/api/files/'+a.id+'/retry','POST',{operationId:randomUUID(),stage:'transcribe'});
  assert.equal((await f.request(f.a.token,'/api/file-processing/reprocess','POST',{token:fresh.token})).statusCode,409,'a changed file invalidates the whole preview');
  assert.deepEqual(tasks(f.b.userId),beforeB);assert.equal((await f.checked(f.b.token,'/api/files/'+b.id+'/chunks')).items[0].ocrText,'GENERATED_B_PREVIEW');
 }finally{db.close();}
});

test('a late batch admission failure rolls back every reprocess and leaves its preview retryable',async t=>{
 const f=await scopedFilesFixture(t),page=await f.checked(f.a.token,'/api/file-processing');await f.checked(f.a.token,'/api/file-processing','PUT',{revision:page.revision,settings:{...page.settings,automatic:true},policy:{version:1,services:[],profiles:[{id:'text',name:'Generated text',processorId:'text.utf8',parameters:{},summarize:false},{id:'archive',name:'Generated archive',processorId:'archive',parameters:{},summarize:false}],rules:[{type:'text/*',profileId:'text'},{type:'*/*',profileId:'archive'}]}});
 const files=[await f.upload(f.a.token,'generated-batch-one','GENERATED_BATCH_ONE'),await f.upload(f.a.token,'generated-batch-two','GENERATED_BATCH_TWO')];for(const file of files)await waitForScopedState(async()=>{const detail=await f.checked(f.a.token,'/api/files/'+file.id);return detail.processing.indexed&&detail.job?.state==='succeeded';},()=> 'Waiting for generated batch publication',8000);
 const current=await f.checked(f.a.token,'/api/file-processing'),preview=await f.checked(f.a.token,'/api/file-processing/preview','POST',{revision:current.revision}),second=await f.checked(f.a.token,'/api/files/'+preview.items[1].id);assert.equal(preview.count,2);
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'));try{
  const state=()=>({tasks:db.prepare("SELECT u.task_id FROM user_tasks u JOIN execution_steps e ON e.id=u.task_id AND e.user_id=u.user_id WHERE u.user_id=? AND e.kind LIKE 'processing.%' ORDER BY u.task_id").all(f.a.userId),controls:db.prepare('SELECT * FROM mp_file_controls WHERE user_id=? ORDER BY original_id').all(f.a.userId),bindings:db.prepare('SELECT * FROM mp_file_policy_bindings WHERE user_id=? ORDER BY original_id').all(f.a.userId)}),before=state();
  const id=second.originalRef.slice(9);assert.match(id,/^[a-f0-9]{64}$/);db.exec(`CREATE TRIGGER generated_policy_batch_fail BEFORE INSERT ON mp_file_retries WHEN NEW.original_id='${id}' BEGIN SELECT RAISE(ABORT,'generated_late_batch_failure'); END`);
  const rejected=await f.request(f.a.token,'/api/file-processing/reprocess','POST',{token:preview.token});assert.equal(rejected.statusCode,503,rejected.body);assert.deepEqual(state(),before,'no first-item admission or control generation survives the second-item failure');
  db.exec('DROP TRIGGER generated_policy_batch_fail');const queued=await f.checked(f.a.token,'/api/file-processing/reprocess','POST',{token:preview.token});assert.equal(queued.queued,2);
  for(const file of files)await waitForScopedState(async()=>{const detail=await f.checked(f.a.token,'/api/files/'+file.id);return detail.processing.indexed&&detail.job?.state==='succeeded';},()=> 'Waiting for committed batch',8000);
 }finally{db.close();}
});
