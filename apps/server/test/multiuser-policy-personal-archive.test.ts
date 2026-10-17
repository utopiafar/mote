import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {scopedFilesFixture} from './fixtures/scoped-files.js';
import {waitForScopedState} from './fixtures/scoped-process.js';
import {createServer} from 'node:http';
import sharp from 'sharp';
import {defaultModelSettings} from '../src/model-settings.js';

const policy={version:1,services:[],profiles:[{id:'text',name:'Generated archived text plan',processorId:'text.utf8',parameters:{},summarize:false},{id:'archive',name:'Generated original only',processorId:'archive',parameters:{},summarize:false}],rules:[{type:'text/*',profileId:'text'},{type:'*/*',profileId:'archive'}]};
function read<T>(directory:string,work:(db:DatabaseSync)=>T){const db=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});try{db.exec('PRAGMA busy_timeout=5000');return work(db);}finally{db.close();}}
async function fixture(t:Parameters<typeof scopedFilesFixture>[0]){
 const f=await scopedFilesFixture(t),files=[];
 for(const [user,label] of [[f.a,'A'],[f.b,'B']] as const){const view=await f.checked(user.token,'/api/file-processing');await f.checked(user.token,'/api/file-processing','PUT',{revision:view.revision,settings:{...view.settings,automatic:true,understandingEnabled:false},policy});const file=await f.upload(user.token,'same-archived-policy','GENERATED_ARCHIVED_PLAN_'+label);files.push(file);await waitForScopedState(async()=>(await f.checked(user.token,'/api/files/'+file.id)).processing.indexed,()=> 'Generated text plan did not finish',12000);}
 const exported=async(token=f.a.token)=>{const id=randomUUID();await f.checked(token,'/api/portable/exports','POST',{operationId:id});await waitForScopedState(async()=>(await f.checked(token,'/api/portable/exports/'+id)).state==='completed',()=> 'Generated archive did not finish',10000);return f.checked(token,'/api/portable/exports/'+id+'/content');};
 const imported=async(archive:unknown,id=randomUUID(),token=f.a.token)=>{let receipt=await f.checked(token,'/api/portable/imports','POST',{operationId:id,archive});await waitForScopedState(async()=>{receipt=await f.checked(token,'/api/portable/imports/'+id);return receipt.state!=='working';},()=>JSON.stringify(receipt),10000);return receipt;};
 const data=(userId=f.a.userId)=>read(f.directory,db=>({plans:db.prepare('SELECT id,original_id,json FROM mp_file_plans WHERE user_id=? ORDER BY id').all(userId),bindings:db.prepare('SELECT original_id,plan_id FROM mp_file_policy_bindings WHERE user_id=? ORDER BY original_id').all(userId)}));
 const authority=()=>read(f.directory,db=>({tasks:db.prepare('SELECT task_id,user_id,grant_id,input FROM user_tasks ORDER BY task_id').all(),grants:db.prepare('SELECT * FROM task_authorizations ORDER BY task_id').all(),calls:db.prepare('SELECT * FROM task_external_calls ORDER BY issuance_id').all(),confirmations:db.prepare('SELECT * FROM task_external_retry_confirmations ORDER BY confirmation_id').all()}));
 return {...f,files,exported,imported,data,authority};
}

test('personal export includes owned immutable plan history and binding closure without execution or credentials',async t=>{
 const f=await fixture(t),view=await f.checked(f.a.token,'/api/file-processing');await f.checked(f.a.token,'/api/file-processing','PUT',{revision:view.revision,settings:view.settings,policy:{...policy,services:[{id:'unused',name:'Generated unused definition',kind:'model',reference:{kind:'personal',id:'not-selected'}}]}});
 const before=f.data(),archive=await f.exported(),processing=archive.domains.find((domain:any)=>domain.domain==='processing').payload;
 assert.ok(processing.policyPlans,'RED: applied named plans and bindings are absent from the actual personal archive');
 assert.deepEqual(processing.policyPlans,JSON.parse(JSON.stringify({version:1,...before})));assert.equal(JSON.stringify(processing.policyPlans).includes(f.b.userId),false);assert.equal(JSON.stringify(processing.policyPlans).includes('grant_id'),false);
 assert.deepEqual(JSON.parse(processing.policyPlans.plans[0].json).services,[]);assert.equal(archive.domains.find((domain:any)=>domain.domain==='configuration').payload.document.filePolicy.policy.services[0].id,'unused');
});

test('personal merge restores missing named applied plans as data and keeps current policy, other owner and authority after restart',async t=>{
 const f=await fixture(t),before=f.data(),beforeB=f.data(f.b.userId),saved=await f.exported(),file=f.files[0],old=await f.checked(f.a.token,'/api/files/'+file.id);
 assert.equal((await f.request(f.a.token,'/api/captures/'+file.id,'DELETE')).statusCode,200);assert.deepEqual(f.data(),{plans:[],bindings:[]});
 const view=await f.checked(f.a.token,'/api/file-processing');await f.checked(f.a.token,'/api/file-processing','PUT',{revision:view.revision,settings:{...view.settings,automatic:false},policy:{...policy,rules:[{type:'*/*',profileId:'archive'}]}});
 const current=await f.checked(f.a.token,'/api/file-processing'),authority=f.authority(),id=randomUUID(),receipt=await f.imported(saved,id);assert.equal(receipt.state,'completed',JSON.stringify(receipt));
 assert.deepEqual(f.data(),before,'RED: missing applied plan history and binding must round-trip');assert.deepEqual(f.data(f.b.userId),beforeB);assert.deepEqual(f.authority(),authority);assert.deepEqual(await f.checked(f.a.token,'/api/file-processing'),current);
 assert.equal((await f.checked(f.a.token,'/api/files/'+file.id)).processing.appliedPolicy.id,old.processing.appliedPolicy.id);
 const controls=read(f.directory,db=>db.prepare('SELECT * FROM mp_file_controls ORDER BY user_id,original_id').all());assert.deepEqual(await f.imported(saved,id),receipt);assert.equal((await f.imported(saved)).state,'completed');await f.restart();assert.deepEqual(f.data(),before);assert.deepEqual(f.authority(),authority);assert.deepEqual(f.data(f.b.userId),beforeB);assert.deepEqual(read(f.directory,db=>db.prepare('SELECT * FROM mp_file_controls ORDER BY user_id,original_id').all()),controls);
});

test('older personal policy history preserves the current binding and controls; changed immutable IDs reject atomically',async t=>{
 const f=await fixture(t),saved=await f.exported(),file=f.files[0],page=await f.checked(f.a.token,'/api/file-processing');
 await f.checked(f.a.token,'/api/file-processing','PUT',{revision:page.revision,settings:page.settings,policy:{...policy,profiles:policy.profiles.map(profile=>({...profile,diarizationProcessor:'audio.diarize-wespeaker'}))}});
 const selected=await f.checked(f.a.token,'/api/file-processing'),preview=await f.checked(f.a.token,'/api/file-processing/preview','POST',{revision:selected.revision});assert.equal(preview.count,1);await f.checked(f.a.token,'/api/file-processing/reprocess','POST',{token:preview.token});
 await waitForScopedState(async()=>(await f.checked(f.a.token,'/api/files/'+file.id)).job?.state==='succeeded',()=> 'Fresh named text reprocess did not finish',12000);
 const current=f.data(),authority=f.authority(),controls=read(f.directory,db=>db.prepare('SELECT * FROM mp_file_controls ORDER BY user_id,original_id').all());assert.equal(current.plans.length,2);
 assert.equal((await f.imported(saved)).state,'completed');assert.deepEqual(f.data(),current);assert.deepEqual(f.authority(),authority);assert.deepEqual(read(f.directory,db=>db.prepare('SELECT * FROM mp_file_controls ORDER BY user_id,original_id').all()),controls);
 const changed=structuredClone(saved),row=changed.domains.find((domain:any)=>domain.domain==='processing').payload.policyPlans.plans[0],body=JSON.parse(row.json);body.profile.name='Generated conflicting same ID';row.json=JSON.stringify(body);
 const receipt=await f.imported(changed);assert.equal(receipt.state,'failed');assert.equal(receipt.error,'archive_conflict');assert.deepEqual(f.data(),current);assert.deepEqual(f.authority(),authority);
});

test('legacy plan-less processing archives merge safely, while future or malformed plan sections reject without partial publication',async t=>{
 const f=await fixture(t),saved=await f.exported(),before=f.data(),authority=f.authority(),legacy=structuredClone(saved);delete legacy.domains.find((domain:any)=>domain.domain==='processing').payload.policyPlans;
 assert.equal((await f.imported(legacy)).state,'completed');assert.deepEqual(f.data(),before);
 const variants:Record<string,(value:any)=>void>={
  future:value=>value.version=2,
  duplicatePlan:value=>value.plans.push(structuredClone(value.plans[0])),
  duplicateBinding:value=>value.bindings.push(structuredClone(value.bindings[0])),
  missingPlan:value=>value.plans=[],
  danglingPlan:value=>value.bindings[0].plan_id='0'.repeat(64),
  missingOriginal:value=>{value.plans[0].original_id='0'.repeat(64);value.bindings[0].original_id='0'.repeat(64);},
  wrongOriginal:value=>value.bindings[0].original_id='1'.repeat(64),
  invalidId:value=>value.plans[0].id='../generated',
  owner:value=>value.plans[0].user_id=f.b.userId,
  malformedJSON:value=>value.plans[0].json='{',
  wrongRule:value=>{const body=JSON.parse(value.plans[0].json);body.rule.profileId='missing';value.plans[0].json=JSON.stringify(body);},
  wrongSource:value=>{const body=JSON.parse(value.plans[0].json);body.rule.sourceId='missing';value.plans[0].json=JSON.stringify(body);},
  wrongMime:value=>{const body=JSON.parse(value.plans[0].json);body.rule.type='audio/*';value.plans[0].json=JSON.stringify(body);},
  missingService:value=>{const body=JSON.parse(value.plans[0].json);body.profile.serviceId='missing';value.plans[0].json=JSON.stringify(body);},
  embeddedCredential:value=>{const body=JSON.parse(value.plans[0].json);body.services=[{id:'media',name:'Generated forbidden',kind:'image',reference:{kind:'personal',id:'same'},apiKey:'GENERATED_MUST_NOT_IMPORT'}];value.plans[0].json=JSON.stringify(body);},
  falseArchive:value=>{const body=JSON.parse(value.plans[0].json);body.archiveOnly=true;value.plans[0].json=JSON.stringify(body);},
 };
 for(const [name,mutate] of Object.entries(variants))await t.test(name,async()=>{const broken=structuredClone(saved);mutate(broken.domains.find((domain:any)=>domain.domain==='processing').payload.policyPlans);const receipt=await f.imported(broken);assert.equal(receipt.state,'failed',JSON.stringify(receipt));assert.deepEqual(f.data(),before);assert.deepEqual(f.authority(),authority);});
 for(const token of [f.b.token,f.admin.token])assert.equal((await f.request(token,'/api/portable/imports','POST',{operationId:randomUUID(),archive:saved})).statusCode,403);
 assert.deepEqual(f.data(f.b.userId).bindings.length,1);
});

async function mediaFixture(t:Parameters<typeof scopedFilesFixture>[0],unknown=false){
 let calls=0;const server=createServer(async(req,res)=>{for await(const _ of req){}calls++;if(unknown){req.socket.destroy();return;}res.setHeader('X-Mote-Execution','local');res.end(JSON.stringify({durationMs:0,engine:'generated-archive',segments:[{startMs:0,endMs:0,text:'GENERATED_EXTERNAL_MUST_NOT_REPLAY'}]}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});const address=server.address();assert.ok(address&&typeof address!=='string');const f=await fixture(t),view=await f.checked(f.a.token,'/api/file-processing');
 const mediaPolicy={version:1,services:[{id:'image',name:'Generated complete reference',kind:'image',reference:{kind:'personal',id:'same-media'}}],profiles:[{id:'image',name:'Generated historic media',processorId:'image.http',serviceId:'image',parameters:{},summarize:false},{id:'archive',name:'Generated original only',processorId:'archive',parameters:{},summarize:false}],rules:[{type:'image/*',profileId:'image'},{type:'*/*',profileId:'archive'}]};
 await f.checked(f.a.token,'/api/file-processing','PUT',{revision:view.revision,settings:{...view.settings,enabled:unknown,automatic:true,understandingEnabled:false},policy:mediaPolicy,models:{profiles:[{id:'same-media',name:'Generated complete media',settings:{...defaultModelSettings(),provider:'custom',protocol:'mote-media',baseUrl:'http://127.0.0.1:'+address.port,apiKey:'GENERATED_ARCHIVE_SECRET',model:''}}],selections:{}}});
 const png=await sharp({create:{width:2,height:2,channels:3,background:'#286993'}}).png().toBuffer(),file=await f.uploadBytes(f.a.token,'generated-archived-media',png,'image/png');
 await waitForScopedState(async()=>{const state=await f.checked(f.a.token,'/api/files/'+file.id);return unknown?state.cancellation.wait==='unknown':['blocked','failed'].includes(state.job?.state);},()=> 'Generated media state did not settle',16000);
 return {...f,file,calls:()=>calls};
}

test('missing current model references restore only historical plan data and never call a provider or reactivate the old blocked grant',async t=>{
 const f=await mediaFixture(t),saved=await f.exported(),file=f.file,old=read(f.directory,db=>db.prepare('SELECT task_id FROM mp_admissions WHERE user_id=? AND original_id=? ORDER BY rowid DESC LIMIT 1').get(f.a.userId,file.original.ref.slice(9))!.task_id),bBefore=f.data(f.b.userId);assert.equal(f.calls(),0);assert.equal(JSON.stringify(saved).includes('GENERATED_ARCHIVE_SECRET'),false);
 assert.equal((await f.request(f.a.token,'/api/captures/'+file.id,'DELETE')).statusCode,200);
 const view=await f.checked(f.a.token,'/api/configuration');await f.checked(f.a.token,'/api/configuration/models','PUT',{revision:view.revision,value:{profiles:[],selections:{}}});const authority=f.authority();
 const receipt=await f.imported(saved);assert.equal(receipt.state,'completed',JSON.stringify(receipt));assert.equal(f.calls(),0);assert.deepEqual(f.authority(),authority);assert.deepEqual(f.data(f.b.userId),bBefore);
 const applied=(await f.checked(f.a.token,'/api/files/'+file.id)).processing.appliedPolicy;assert.equal(applied.profile.id,'image');assert.equal(applied.services[0].reference.id,'same-media');assert.ok(read(f.directory,db=>Number(db.prepare('SELECT generation FROM mp_file_controls WHERE user_id=? AND original_id=?').get(f.a.userId,file.original.ref.slice(9))!.generation))>0);
 const retry=await f.request(f.a.token,'/api/tasks/'+old+'/retry','POST',{});assert.ok([200,401,404,409].includes(retry.statusCode),retry.body);
 if(retry.statusCode===200){await f.host.execution!.engine.drain([String(old)]);assert.equal(read(f.directory,db=>db.prepare('SELECT state FROM execution_steps WHERE id=?').get(old)!.state),'stale','retry acknowledgement cannot make the old input current');}
 await f.restart();assert.equal(f.calls(),0);assert.deepEqual(f.authority(),authority);
 const deletion=await f.checked(f.admin.token,'/api/admin/accounts/'+f.a.userId,'DELETE',{operationId:randomUUID()});await waitForScopedState(async()=>(await f.checked(f.admin.token,'/api/admin/account-deletions/'+deletion.id)).state==='completed',()=> 'Applied-plan erasure did not finish',15000);assert.deepEqual(f.data(),{plans:[],bindings:[]});assert.deepEqual(f.data(f.b.userId),bBefore);
});

test('a local unfinished grant cannot be revalidated by restoring its missing binding, and local cancellation remains authoritative',async t=>{
 const f=await mediaFixture(t),saved=await f.exported(),originalId=f.file.original.ref.slice(9),db=new DatabaseSync(join(f.directory,'mote.sqlite'));
 // Deliberate corruption of this generated DB models a missing binding beside
 // surviving local controls and old blocked execution; no production data.
 try{db.prepare('DELETE FROM mp_file_policy_bindings WHERE user_id=? AND original_id=?').run(f.a.userId,originalId);db.prepare('INSERT INTO mp_file_controls VALUES(?,?,0,0)').run(f.a.userId,originalId);}finally{db.close();}
 const authority=f.authority(),before=f.data(),blocked=await f.imported(saved);assert.equal(blocked.state,'failed');assert.equal(blocked.error,'archive_conflict');assert.deepEqual(f.authority(),authority);assert.deepEqual(f.data(),before);assert.equal(f.calls(),0);
 await f.checked(f.a.token,'/api/files/'+f.file.id+'/cancel','POST',{});const controls=read(f.directory,db=>db.prepare('SELECT * FROM mp_file_controls WHERE user_id=?').all(f.a.userId)),cancelledAuthority=f.authority();assert.equal((await f.imported(saved)).state,'completed');assert.deepEqual(read(f.directory,db=>db.prepare('SELECT * FROM mp_file_controls WHERE user_id=?').all(f.a.userId)),controls);assert.deepEqual(f.authority(),cancelledAuthority);assert.equal(f.calls(),0);
});

test('personal policy import neither settles nor acknowledges a real unresolved physical call',async t=>{
 const f=await mediaFixture(t,true),saved=await f.exported(),authority=f.authority(),before=f.data();assert.equal(f.calls(),1);assert.ok(authority.calls.some(row=>row.user_id===f.a.userId&&['issued','unknown'].includes(String(row.state))));
 const receipt=await f.imported(saved);assert.equal(receipt.state,'failed');assert.equal(receipt.error,'archive_conflict');assert.deepEqual(f.authority(),authority);assert.deepEqual(f.data(),before);await f.restart();assert.deepEqual(f.authority(),authority);assert.equal(f.calls(),1);
});

test('invalid policy closure rolls back earlier canonical original restoration and leaves B and execution history intact',async t=>{
 const f=await fixture(t),saved=await f.exported(),file=f.files[0],bBefore=f.data(f.b.userId);assert.equal((await f.request(f.a.token,'/api/captures/'+file.id,'DELETE')).statusCode,200);
 const authority=f.authority();saved.domains.find((domain:any)=>domain.domain==='processing').payload.policyPlans.bindings[0].plan_id='0'.repeat(64);
 const receipt=await f.imported(saved);assert.equal(receipt.state,'failed');assert.equal((await f.request(f.a.token,'/api/captures/'+file.id)).statusCode,404);assert.deepEqual(f.data(),{plans:[],bindings:[]});assert.deepEqual(f.data(f.b.userId),bBefore);assert.deepEqual(f.authority(),authority);
 assert.equal(read(f.directory,db=>db.prepare('SELECT count(*) n FROM ig_originals WHERE user_id=? AND capture_id=?').get(f.a.userId,file.id)!.n),0);
});

test('reconstructing an absent control and binding fences surviving old tasks without changing their grants or original incarnation',async t=>{
 const f=await mediaFixture(t),saved=await f.exported(),originalId=f.file.original.ref.slice(9),old=read(f.directory,db=>db.prepare('SELECT task_id FROM mp_admissions WHERE user_id=? AND original_id=? ORDER BY rowid DESC LIMIT 1').get(f.a.userId,originalId)!.task_id),incarnation=(await f.checked(f.a.token,'/api/files/'+f.file.id)).originalGeneration;
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'));try{db.prepare('DELETE FROM mp_file_policy_bindings WHERE user_id=? AND original_id=?').run(f.a.userId,originalId);}finally{db.close();}
 const authority=f.authority();assert.equal((await f.imported(saved)).state,'completed');assert.deepEqual(f.authority(),authority);assert.equal((await f.checked(f.a.token,'/api/files/'+f.file.id)).originalGeneration,incarnation);assert.equal(read(f.directory,db=>db.prepare('SELECT generation FROM mp_file_controls WHERE user_id=? AND original_id=?').get(f.a.userId,originalId)!.generation),1);
 const retry=await f.request(f.a.token,'/api/tasks/'+old+'/retry','POST',{});assert.equal(retry.statusCode,200,retry.body);await f.host.execution!.engine.drain([String(old)]);assert.equal(read(f.directory,db=>db.prepare('SELECT state FROM execution_steps WHERE id=?').get(old)!.state),'stale');assert.equal(f.calls(),0);assert.deepEqual(f.authority(),authority);
});

test('a B-only canonical original cannot supply an A plan parent even with a valid same-deployment envelope',async t=>{
 const f=await fixture(t),foreign=await f.upload(f.b.token,'generated-only-b-plan-parent','GENERATED_B_ONLY_PLAN_PARENT');await waitForScopedState(async()=>(await f.checked(f.b.token,'/api/files/'+foreign.id)).processing.indexed,()=> 'Generated B-only positive did not finish',12000);
 const saved=await f.exported(),before=f.data(),beforeB=f.data(f.b.userId),authority=f.authority(),plans=saved.domains.find((domain:any)=>domain.domain==='processing').payload.policyPlans;
 plans.plans[0].original_id=foreign.original.ref.slice(9);plans.bindings[0].original_id=foreign.original.ref.slice(9);
 assert.equal((await f.imported(saved)).state,'failed');assert.deepEqual(f.data(),before);assert.deepEqual(f.data(f.b.userId),beforeB);assert.deepEqual(f.authority(),authority);assert.equal((await f.request(f.a.token,'/api/files/'+foreign.id)).statusCode,404);assert.equal((await f.request(f.b.token,'/api/files/'+foreign.id)).statusCode,200);
});

test('a corrupt surviving local binding cannot be repaired underneath historical execution by importing its missing plan',async t=>{
 const f=await fixture(t),saved=await f.exported(),id=f.data().plans[0].id,db=new DatabaseSync(join(f.directory,'mote.sqlite'));
 // Fault injection is confined to this generated DB. A dangling local binding
 // must fail closed rather than make historical input current as a side effect.
 try{db.exec('PRAGMA foreign_keys=OFF');db.prepare('DELETE FROM mp_file_plans WHERE user_id=? AND id=?').run(f.a.userId,id);}finally{db.close();}
 const authority=f.authority(),before=f.data(),receipt=await f.imported(saved);assert.equal(receipt.state,'failed','RED: import must not silently activate a surviving dangling binding');assert.equal(receipt.error,'archive_conflict');assert.deepEqual(f.data(),before);assert.deepEqual(f.authority(),authority);
});
