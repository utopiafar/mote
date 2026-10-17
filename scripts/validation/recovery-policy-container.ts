// Generated-only, opt-in production Docker startup with nonempty named plans.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {scopedFilesFixture} from '../../apps/server/test/fixtures/scoped-files.js';
import {waitForScopedState} from '../../apps/server/test/fixtures/scoped-process.js';
import {backupScopedInstance} from '../scoped-backup.mjs';
import {initialize,profilePaths,loadProfile,restoreProfile,backupProfile,dockerConfigurationUser} from '../profile-lib.mjs';

const image=process.env.MOTE_CONTAINER_VALIDATION_IMAGE;
test('production container restores current named policy plans and erases only the selected owner',{skip:!image},async t=>{
 const runId='mote-recovery7-policy-'+randomUUID(),root=mkdtempSync(join(tmpdir(),runId+'-')),container=runId+'-central',volumes=new Set<string>();
 const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']}).trim(),imageId=docker(['image','inspect',image!,'--format','{{.Id}}']);
 let profile:any,created=false,index=0;
 const execute=async(command:string,args:string[])=>{assert.equal(command,'docker');return docker(args[0]==='run'?['run','--name',runId+'-helper-'+(++index),'--label','dev.mote.fixture='+runId,...args.slice(1)]:args);};
 t.after(()=>{
  if(created){const state=JSON.parse(docker(['inspect',container]))[0];assert.equal(state.Config.Labels['dev.mote.fixture'],runId);if(state.State.Running)docker(['stop','--time','20',container]);docker(['rm',container]);}
  for(const volume of volumes){const state=JSON.parse(docker(['volume','inspect',volume]))[0];assert.ok(state.Labels?.['dev.mote.fixture']===runId||state.Labels?.['dev.mote.profile']===profile.project);docker(['volume','rm',volume]);}rmSync(root,{recursive:true,force:true});
 });
 const f=await scopedFilesFixture(t),tables=['mp_file_policies','mp_file_plans','mp_file_policy_bindings'],files:any[]=[],policy={version:1,services:[],profiles:[{id:'text',name:'Generated text',processorId:'text.utf8',parameters:{},diarizationProcessor:'audio.diarize',summarize:false},{id:'archive',name:'Generated original',processorId:'archive',parameters:{},diarizationProcessor:'audio.diarize',summarize:false}],rules:[{type:'text/*',profileId:'text'},{type:'*/*',profileId:'archive'}]};
 const rows=(directory:string)=>{const db=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});try{return Object.fromEntries(tables.map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY user_id'+(table==='mp_file_plans'?',id':table==='mp_file_policy_bindings'?',original_id':'')).all()]));}finally{db.close();}};
 for(const [user,label] of [[f.a,'A'],[f.b,'B']] as const){const page=await f.checked(user.token,'/api/file-processing');await f.checked(user.token,'/api/file-processing','PUT',{revision:page.revision,settings:{...page.settings,automatic:true,understandingEnabled:false},policy});const file=await f.upload(user.token,'same-generated-policy','GENERATED_CONTAINER_POLICY_'+label);files.push(file);await waitForScopedState(async()=>(await f.checked(user.token,'/api/files/'+file.id)).processing.indexed,()=> 'Generated policy text did not finish',15000);}
 const before=rows(f.directory);for(const table of tables)assert.equal(before[table].length,2);assert.equal(files[0].id,files[1].id);await f.host.app.close();
 const archive=join(root,'archive');await backupScopedInstance({source:f.directory,out:archive});
 const paths=profilePaths('policy',join(root,'profiles'));await initialize(paths,{runtime:'docker',image});profile=await loadProfile(paths);docker(['volume','create','--label','dev.mote.fixture='+runId,profile.meta.volume]);volumes.add(profile.meta.volume);
 const restored=await restoreProfile(profile,archive,{execute});assert.ok(restored.volume);volumes.add(restored.volume);profile=await loadProfile(paths);const user=await dockerConfigurationUser(profile,execute);
 docker(['run','--pull','never','--detach','--name',container,'--label','dev.mote.fixture='+runId,'--network','none','--security-opt','no-new-privileges:true','--cap-drop','ALL','--user',user,'--mount',`type=volume,source=${restored.volume},target=/data`,'--mount',`type=bind,source=${profile.directory},target=/config`,'--env','MOTE_CONFIG_FILE=/config/mote.yaml',image!]);created=true;
 const request=(url:string,token?:string,method='GET',payload?:unknown)=>JSON.parse(docker(['exec',container,'node','-e',`(async()=>{const r=await fetch('http://127.0.0.1:${profile.port}'+${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{'content-type':'application/json','x-mote-protocol-version':'2',...${JSON.stringify(token?{authorization:'Bearer '+token}:{})}},body:${JSON.stringify(payload===undefined?undefined:JSON.stringify(payload))}});console.log(JSON.stringify({status:r.status,json:await r.json()}));})().catch(()=>process.exit(1));`]));
 const checked=(...args:Parameters<typeof request>)=>{const result=request(...args);assert.equal(result.status,200,JSON.stringify(result.json));return result.json;},login=(username:string)=>checked('/api/auth/login',undefined,'POST',{username,password:'Generated-joint-files-password',mode:'client'});
 for(let cycle=0;cycle<2;cycle++){
  if(cycle)docker(['start',container]);docker(['exec',container,'node','-e',`(async()=>{for(let n=0;n<150;n++){try{if((await fetch('http://127.0.0.1:${profile.port}/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,200));}process.exit(1);})();`]);
  for(const old of [f.a,f.b])assert.equal(request('/api/auth/self',old.token).status,401);
  for(const [index,old] of [f.a,f.b].entries()){const fresh=login(index===0?'generated-a':'generated-b');assert.equal(fresh.userId,old.userId);const page=checked('/api/file-processing',fresh.token);assert.deepEqual(page.policy,policy);assert.equal(page.settings.automatic,false);const chunks=checked('/api/files/'+files[index].id+'/chunks',fresh.token);assert.equal(chunks.items[0].ocrText,'GENERATED_CONTAINER_POLICY_'+(index===0?'A':'B'));}
  if(cycle){const admin=login('generated-admin'),deletion=checked('/api/admin/accounts/'+f.a.userId,admin.token,'DELETE',{operationId:randomUUID()});await waitForScopedState(()=>checked('/api/admin/account-deletions/'+deletion.id,admin.token).state==='completed',()=> 'Container account erasure did not complete',20000);assert.equal(request('/api/files/'+files[0].id,login('generated-b').token).status,200);}
  docker(['stop','--time','20',container]);assert.equal(JSON.parse(docker(['inspect',container]))[0].State.ExitCode,0);
  const readback=join(root,'readback-'+cycle);await backupProfile(profile,readback,{execute});
  for(const table of tables)assert.deepEqual(rows(readback)[table],cycle?before[table].filter(row=>row.user_id===f.b.userId):before[table]);
  const db=new DatabaseSync(join(readback,'mote.sqlite'),{readOnly:true});try{assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('SELECT count(*) n FROM task_authorizations WHERE revoked=0').get()!.n,0);}finally{db.close();}
 }
 console.log(JSON.stringify({result:'PASS',runId,image,imageId,runtimeCandidate:process.env.MOTE_RECOVERY_CANDIDATE??null,sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),runnerSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),nonemptyTables:tables,initialRowsPerTable:2,productionStartupCycles:2,exactStoppedRoundtrip:true,oldTokensRejected:true,oldGrantsRevived:0,accountErasureOwnerIsolated:true,syntheticOnly:true}));
});
