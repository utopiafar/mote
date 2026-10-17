import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {scopedFilesFixture} from './fixtures/scoped-files.js';
import {waitForScopedState} from './fixtures/scoped-process.js';

const policy={version:1,services:[],profiles:[{id:'text',name:'Generated archived text plan',processorId:'text.utf8',parameters:{},summarize:false},{id:'archive',name:'Generated original only',processorId:'archive',parameters:{},summarize:false}],rules:[{type:'text/*',profileId:'text'},{type:'*/*',profileId:'archive'}]};
function read<T>(directory:string,work:(db:DatabaseSync)=>T){const db=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});try{db.exec('PRAGMA busy_timeout=5000');return work(db);}finally{db.close();}}
async function fixture(t:Parameters<typeof scopedFilesFixture>[0]){
 const f=await scopedFilesFixture(t),files=[];
 for(const [user,label] of [[f.a,'A'],[f.b,'B']] as const){const view=await f.checked(user.token,'/api/file-processing');await f.checked(user.token,'/api/file-processing','PUT',{revision:view.revision,settings:{...view.settings,automatic:true,understandingEnabled:false},policy});const file=await f.upload(user.token,'same-archived-policy','GENERATED_ARCHIVED_PLAN_'+label);files.push(file);await waitForScopedState(async()=>(await f.checked(user.token,'/api/files/'+file.id)).processing.indexed,()=> 'Generated text plan did not finish',12000);}
 const exported=async(token=f.a.token)=>{const id=randomUUID();await f.checked(token,'/api/portable/exports','POST',{operationId:id});await waitForScopedState(async()=>(await f.checked(token,'/api/portable/exports/'+id)).state==='completed',()=> 'Generated archive did not finish',10000);return f.checked(token,'/api/portable/exports/'+id+'/content');};
 const imported=async(archive:unknown,id=randomUUID(),token=f.a.token)=>{let receipt=await f.checked(token,'/api/portable/imports','POST',{operationId:id,archive});await waitForScopedState(async()=>{receipt=await f.checked(token,'/api/portable/imports/'+id);return receipt.state!=='working';},()=>JSON.stringify(receipt),10000);return receipt;};
 const data=(userId=f.a.userId)=>read(f.directory,db=>({plans:db.prepare('SELECT id,original_id,json FROM mp_file_plans WHERE user_id=? ORDER BY id').all(userId),bindings:db.prepare('SELECT original_id,plan_id FROM mp_file_policy_bindings WHERE user_id=? ORDER BY original_id').all(userId)}));
 const authority=()=>read(f.directory,db=>({tasks:db.prepare('SELECT * FROM user_tasks ORDER BY task_id').all(),grants:db.prepare('SELECT * FROM task_authorizations ORDER BY task_id').all(),calls:db.prepare('SELECT * FROM task_external_calls ORDER BY issuance_id').all(),confirmations:db.prepare('SELECT * FROM task_external_retry_confirmations ORDER BY confirmation_id').all()}));
 return {...f,files,exported,imported,data,authority};
}

test('personal export includes owned immutable plan history and binding closure without execution or credentials',async t=>{
 const f=await fixture(t),before=f.data(),archive=await f.exported(),processing=archive.domains.find((domain:any)=>domain.domain==='processing').payload;
 assert.ok(processing.policyPlans,'RED: applied named plans and bindings are absent from the actual personal archive');
 assert.deepEqual(processing.policyPlans,{version:1,...before});assert.equal(JSON.stringify(processing.policyPlans).includes(f.b.userId),false);assert.equal(JSON.stringify(processing.policyPlans).includes('grant_id'),false);
});

test('personal merge restores missing named applied plans as data and keeps current policy, other owner and authority after restart',async t=>{
 const f=await fixture(t),before=f.data(),beforeB=f.data(f.b.userId),saved=await f.exported(),file=f.files[0],old=await f.checked(f.a.token,'/api/files/'+file.id);
 assert.equal((await f.request(f.a.token,'/api/captures/'+file.id,'DELETE')).statusCode,200);assert.deepEqual(f.data(),{plans:[],bindings:[]});
 const view=await f.checked(f.a.token,'/api/file-processing');await f.checked(f.a.token,'/api/file-processing','PUT',{revision:view.revision,settings:{...view.settings,automatic:false},policy:{...policy,rules:[{type:'*/*',profileId:'archive'}]}});
 const current=await f.checked(f.a.token,'/api/file-processing'),authority=f.authority(),id=randomUUID(),receipt=await f.imported(saved,id);assert.equal(receipt.state,'completed',JSON.stringify(receipt));
 assert.deepEqual(f.data(),before,'RED: missing applied plan history and binding must round-trip');assert.deepEqual(f.data(f.b.userId),beforeB);assert.deepEqual(f.authority(),authority);assert.deepEqual(await f.checked(f.a.token,'/api/file-processing'),current);
 assert.equal((await f.checked(f.a.token,'/api/files/'+file.id)).processing.appliedPolicy.id,old.processing.appliedPolicy.id);
 assert.deepEqual(await f.imported(saved,id),receipt);assert.equal((await f.imported(saved)).state,'completed');await f.restart();assert.deepEqual(f.data(),before);assert.deepEqual(f.authority(),authority);assert.deepEqual(f.data(f.b.userId),beforeB);
});
