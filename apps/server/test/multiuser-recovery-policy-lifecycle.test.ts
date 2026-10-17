import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {cpSync,existsSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../src/app.js';
import {createServer} from 'node:http';
import sharp from 'sharp';
import {defaultModelSettings} from '../src/model-settings.js';
import {scopedFilesFixture} from './fixtures/scoped-files.js';
import {waitForScopedState} from './fixtures/scoped-process.js';
import {backupScopedInstance,restoreScopedInstance} from '../../../scripts/scoped-backup.mjs';

const tables=['mp_file_policies','mp_file_plans','mp_file_policy_bindings'] as const;
const policy={version:1,services:[],profiles:[{id:'text',name:'Generated text policy',processorId:'text.utf8',parameters:{},diarizationProcessor:'audio.diarize',summarize:false},{id:'archive',name:'Generated original',processorId:'archive',parameters:{},diarizationProcessor:'audio.diarize',summarize:false}],rules:[{type:'text/*',profileId:'text'},{type:'*/*',profileId:'archive'}]};
function read<T>(directory:string,work:(db:DatabaseSync)=>T):T{
 const db=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});
 try{db.exec('PRAGMA busy_timeout=5000');return work(db);}finally{db.close();}
}
function rows(directory:string,userId?:string){return read(directory,db=>Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+(userId?' WHERE user_id=?':'')+' ORDER BY user_id'+(table==='mp_file_plans'?',id':table==='mp_file_policy_bindings'?',original_id':'')).all(...(userId?[userId]:[]))])));}
async function seed(t:Parameters<typeof scopedFilesFixture>[0]){
 const f=await scopedFilesFixture(t),files=[];
 for(const [account,label] of [[f.a,'A'],[f.b,'B']] as const){
  const view=await f.checked(account.token,'/api/file-processing');
  await f.checked(account.token,'/api/file-processing','PUT',{revision:view.revision,settings:{...view.settings,automatic:true,understandingEnabled:false},policy});
  const file=await f.upload(account.token,'generated-policy-lifecycle','GENERATED_POLICY_LIFECYCLE_'+label);
  await waitForScopedState(async()=>(await f.checked(account.token,'/api/files/'+file.id)).processing.indexed,()=> 'Generated named text did not complete',10000);files.push(file);
 }
 assert.equal(files[0].id,files[1].id);
 for(const user of [f.a,f.b])for(const table of tables)assert.ok(rows(f.directory,user.userId)[table].length>0,table+' must be nonempty');
 return {...f,files};
}

test('new named policy tables survive stopped native restore, with old authority retired and incomplete catalogs rejected',async t=>{
 const f=await seed(t),snapshot=f.directory+'-policy-backup',target=f.directory+'-policy-restored';
 t.after(()=>{rmSync(snapshot,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});});
 const before=rows(f.directory),completed=read(f.directory,db=>db.prepare("SELECT id,input,state FROM execution_steps WHERE kind='processing.pipeline' ORDER BY id").all());
 const deploymentId=f.host.deploymentId;await f.host.app.close();
 await backupScopedInstance({source:f.directory,out:snapshot});await restoreScopedInstance({from:snapshot,target,deploymentId});
 assert.deepEqual(rows(target),before,'native restore must retain immutable plan rows and their bindings');
 read(target,db=>{assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('SELECT count(*) n FROM task_authorizations WHERE revoked=0').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM auth_credentials WHERE revoked_at IS NULL').get()!.n,0);});
 const restored=await buildApp({dataDir:target});try{
  for(const [index,user] of [f.a,f.b].entries()){
   const headers={'x-mote-protocol-version':'2',authorization:'Bearer '+user.token};assert.equal((await restored.app.inject({url:'/api/auth/self',headers})).statusCode,401);
   const fresh=await restored.accounts!.login(index===0?'generated-a':'generated-b','Generated-joint-files-password','generated','client',0);assert.equal(fresh.userId,user.userId);
   headers.authorization='Bearer '+fresh.token;
   const page=await restored.app.inject({url:'/api/file-processing',headers});assert.equal(page.statusCode,200,page.body);assert.equal(page.json().settings.automatic,false);assert.deepEqual(page.json().policy,policy);
   const chunks=await restored.app.inject({url:'/api/files/'+f.files[index].id+'/chunks',headers});assert.equal(chunks.statusCode,200,chunks.body);assert.equal(chunks.json().items[0].ocrText,'GENERATED_POLICY_LIFECYCLE_'+(index===0?'A':'B'));
  }
  assert.deepEqual(rows(target),before);
  assert.deepEqual(read(target,db=>db.prepare("SELECT id,input,state FROM execution_steps WHERE kind='processing.pipeline' ORDER BY id").all()),completed,'completed work must not be replayed at source reopen');
 }finally{await restored.app.close();}
 for(const table of tables){
  const damaged=snapshot+'-'+table,rejected=target+'-'+table;t.after(()=>{rmSync(damaged,{recursive:true,force:true});rmSync(rejected,{recursive:true,force:true});});cpSync(snapshot,damaged,{recursive:true});
  const db=new DatabaseSync(join(damaged,'mote.sqlite'));try{db.exec('PRAGMA foreign_keys=OFF');db.exec('DROP TABLE '+table);}finally{db.close();}
  const manifestPath=join(damaged,'backup-manifest.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));manifest.checksums['mote.sqlite']=createHash('sha256').update(readFileSync(join(damaged,'mote.sqlite'))).digest('hex');writeFileSync(manifestPath,JSON.stringify(manifest));
  await assert.rejects(restoreScopedInstance({from:damaged,target:rejected,deploymentId}),/Incomplete.*instance.*database/);assert.equal(existsSync(rejected),false,table+' omission must reject before target publication');
 }
});

test('same-account portable merge preserves current named plans without new grants, and account erasure removes only its new tables',async t=>{
 const f=await seed(t),before=rows(f.directory),bBefore=await f.checked(f.b.token,'/api/files/'+f.files[1].id),taskRows=(db:DatabaseSync)=>db.prepare("SELECT u.task_id,u.grant_id FROM user_tasks u JOIN execution_steps e ON e.id=u.task_id WHERE e.kind='processing.pipeline' ORDER BY u.task_id").all(),tasks=read(f.directory,taskRows);
 const exportId=randomUUID();await f.checked(f.a.token,'/api/portable/exports','POST',{operationId:exportId});
 await waitForScopedState(async()=>(await f.checked(f.a.token,'/api/portable/exports/'+exportId)).state==='completed',()=> 'Generated personal export did not complete',10000);
 const archive=await f.checked(f.a.token,'/api/portable/exports/'+exportId+'/content');
 // This candidate declares complete applied-plan portable recovery OPEN. Record
 // its actual wire shape without making omission a permanent expected contract.
 t.diagnostic('Personal archive top-level fields: '+Object.keys(archive).sort().join(','));
 const processing=archive.domains.find((domain:any)=>domain.domain==='processing'),configuration=archive.domains.find((domain:any)=>domain.domain==='configuration');
 t.diagnostic('Personal processing payload fields: '+Object.keys(processing.payload).sort().join(',')+'; configuration filePolicy present: '+Object.hasOwn(configuration.payload.document,'filePolicy'));
 const importId=randomUUID();let receipt=await f.checked(f.a.token,'/api/portable/imports','POST',{operationId:importId,archive});
 for(let attempt=0;receipt.state==='working';attempt++){assert.ok(attempt<500,JSON.stringify(receipt));await delay(10);receipt=await f.checked(f.a.token,'/api/portable/imports/'+importId);}
 assert.equal(receipt.state,'completed',JSON.stringify(receipt));await f.restart();
 assert.deepEqual(rows(f.directory),before,'merge must preserve the existing same-account plans');
 assert.deepEqual(read(f.directory,taskRows),tasks,'a personal merge must not grant fresh processing execution');
 assert.deepEqual(await f.checked(f.b.token,'/api/files/'+f.files[1].id),bBefore);
 assert.deepEqual(await f.checked(f.a.token,'/api/portable/imports','POST',{operationId:importId,archive}),receipt);
 const deletion=await f.checked(f.admin.token,'/api/admin/accounts/'+f.a.userId,'DELETE',{operationId:randomUUID()});
 await waitForScopedState(async()=>(await f.checked(f.admin.token,'/api/admin/account-deletions/'+deletion.id)).state==='completed',()=> 'Generated policy account erasure did not complete',15000);
 for(const table of tables){assert.deepEqual(rows(f.directory,f.a.userId)[table],[]);assert.deepEqual(rows(f.directory,f.b.userId)[table],before[table].filter(row=>row.user_id===f.b.userId));}
 assert.equal((await f.request(f.a.token,'/api/file-processing')).statusCode,401);assert.deepEqual(await f.checked(f.b.token,'/api/files/'+f.files[1].id),bBefore);
});

test('relogin and disable-enable cannot replay a still-held named media call or restore its old publication grant',async t=>{
 let release!:()=>void,calls=0;
 const held=new Promise<void>(resolve=>release=resolve),server=createServer(async(req,res)=>{
  for await(const _ of req){}const number=++calls;if(number===1)await held;
  res.setHeader('X-Mote-Execution','local');res.end(JSON.stringify({durationMs:0,engine:'generated-policy-lifecycle',segments:[{startMs:0,endMs:0,text:number===1?'GENERATED_RETIRED_ACK':'GENERATED_FRESH_ACK'}]}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{release();server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()));});
 const address=server.address();assert.ok(address&&typeof address!=='string');const f=await scopedFilesFixture(t),view=await f.checked(f.a.token,'/api/file-processing');
 const mediaPolicy={version:1,services:[{id:'image',name:'Generated owned reference',kind:'image',reference:{kind:'personal',id:'same-media'}}],profiles:[{id:'image',name:'Generated image',processorId:'image.http',serviceId:'image',parameters:{},summarize:false},{id:'archive',name:'Generated original',processorId:'archive',parameters:{},summarize:false}],rules:[{type:'image/*',profileId:'image'},{type:'*/*',profileId:'archive'}]};
 await f.checked(f.a.token,'/api/file-processing','PUT',{revision:view.revision,settings:{...view.settings,automatic:true,understandingEnabled:false},policy:mediaPolicy,models:{profiles:[{id:'same-media',name:'Generated complete media',settings:{...defaultModelSettings(),provider:'custom',protocol:'mote-media',baseUrl:'http://127.0.0.1:'+address.port,apiKey:'GENERATED_POLICY_LIFECYCLE_KEY',model:''}}],selections:{}}});
 const png=await sharp({create:{width:2,height:2,channels:3,background:'#748962'}}).png().toBuffer(),file=await f.uploadBytes(f.a.token,'generated-live-reconfiguration',png,'image/png');
 await waitForScopedState(()=>calls===1,()=> 'Generated transport was not issued',12000);
 const task=()=>read(f.directory,db=>db.prepare('SELECT task_id FROM mp_admissions WHERE user_id=? AND original_id=? AND task_id IS NOT NULL ORDER BY rowid DESC LIMIT 1').get(f.a.userId,file.original.ref.slice(9))!.task_id),oldTask=task();
 await f.checked(f.a.token,'/api/auth/logout','POST',{});
 const fresh=await f.checked(undefined,'/api/auth/login','POST',{username:'generated-a',password:'Generated-joint-files-password',mode:'client'});assert.equal((await f.request(f.a.token,'/api/file-processing')).statusCode,401);
 assert.equal(read(f.directory,db=>db.prepare('SELECT revoked FROM task_authorizations WHERE task_id=?').get(oldTask)!.revoked),0,'session exit alone must preserve the admitted grant');
 let page=await f.checked(fresh.token,'/api/file-processing');await f.checked(fresh.token,'/api/file-processing','PUT',{revision:page.revision,settings:{...page.settings,enabled:false},policy:page.policy});
 let paused:any;await waitForScopedState(async()=>{paused=await f.checked(fresh.token,'/api/files/'+file.id);return paused.job?.state==='blocked'&&paused.job?.error==='processing_disabled';},()=>JSON.stringify(paused),12000);
 assert.notEqual(task(),oldTask);assert.equal(read(f.directory,db=>db.prepare('SELECT attempts FROM execution_steps WHERE id=?').get(task())!.attempts),0);
 page=await f.checked(fresh.token,'/api/file-processing');await f.checked(fresh.token,'/api/file-processing','PUT',{revision:page.revision,settings:{...page.settings,enabled:true},policy:page.policy});
 let current:any;await waitForScopedState(async()=>{current=await f.checked(fresh.token,'/api/files/'+file.id);return current.cancellation.wait==='running'||current.job?.error==='external_result_unknown';},()=>JSON.stringify(current),12000);
 assert.equal(calls,1);assert.equal(current.processing.indexed,false);
 assert.equal((await f.request(fresh.token,'/api/files/'+file.id+'/retry','POST',{operationId:randomUUID(),stage:'transcribe',confirmUnknown:true})).statusCode,409,'unknown acknowledgement cannot release a still-live worker');
 release();await waitForScopedState(async()=>{current=await f.checked(fresh.token,'/api/files/'+file.id);return current.cancellation.wait!=='running';},()=>JSON.stringify(current),12000);
 if(current.cancellation.wait==='unknown'){
  assert.equal(calls,1);assert.equal((await f.request(fresh.token,'/api/files/'+file.id+'/retry','POST',{operationId:randomUUID(),stage:'transcribe'})).statusCode,409);
  await f.checked(fresh.token,'/api/files/'+file.id+'/retry','POST',{operationId:randomUUID(),stage:'transcribe',confirmUnknown:true});
 }
 await waitForScopedState(async()=>{current=await f.checked(fresh.token,'/api/files/'+file.id);return current.processing.indexed;},()=>JSON.stringify(current),15000);
 assert.equal(calls,2);assert.equal((await f.checked(fresh.token,'/api/files/'+file.id+'/chunks')).items[0].ocrText,'GENERATED_FRESH_ACK');
 // Cancellation fences execution without necessarily changing the durable
 // authorization row's historical revoked bit. The old lease cannot publish.
 assert.equal(read(f.directory,db=>db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(oldTask)!.fence),null);
 assert.equal(read(f.directory,db=>db.prepare('SELECT state FROM execution_steps WHERE id=?').get(oldTask)!.state),'cancelled');
 const b=await f.upload(f.b.token,'generated-live-reconfiguration','GENERATED_INDEPENDENT_B');await f.checked(f.b.token,'/api/processing','POST',{originalRef:b.original.ref,operationId:'generated-lifecycle-b-positive'});
 await waitForScopedState(async()=>(await f.checked(f.b.token,'/api/files/'+b.id)).processing.indexed,()=> 'Independent B processing failed',10000);assert.equal(calls,2);
});
