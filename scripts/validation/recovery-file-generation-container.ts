// Synthetic opt-in check. Reuses an existing production image; never pulls/builds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {scopedFilesFixture} from '../../apps/server/test/fixtures/scoped-files.js';
import {backupScopedInstance} from '../scoped-backup.mjs';
import {initialize,profilePaths,loadProfile,restoreProfile,backupProfile,dockerConfigurationUser} from '../profile-lib.mjs';

const image=process.env.MOTE_CONTAINER_VALIDATION_IMAGE;
test('production container recovery preserves nonzero file incarnations and fences pre-retirement intent', {skip:!image}, async t=>{
 const runId='mote-recovery7-generation-'+randomUUID(),root=mkdtempSync(join(tmpdir(),runId+'-')),container=runId+'-central',volumes=new Set<string>();
 const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']}).trim();
 const imageId=docker(['image','inspect',image!,'--format','{{.Id}}']);
 let profile:any,containerCreated=false,index=0;
 const execute=async(command:string,args:string[])=>{assert.equal(command,'docker');return docker(args[0]==='run'?['run','--name',runId+'-helper-'+(++index),'--label','dev.mote.fixture='+runId,...args.slice(1)]:args);};
 t.after(()=>{
  if(containerCreated){const state=JSON.parse(docker(['inspect',container]))[0];assert.equal(state.Config.Labels['dev.mote.fixture'],runId);if(state.State.Running)docker(['stop','--time','20',container]);docker(['rm',container]);}
  for(const volume of volumes){const state=JSON.parse(docker(['volume','inspect',volume]))[0];assert.ok(state.Labels?.['dev.mote.fixture']===runId||state.Labels?.['dev.mote.profile']===profile.project);docker(['volume','rm',volume]);}
  rmSync(root,{recursive:true,force:true});
 });
 const f=await scopedFilesFixture(t),externalId='generated-container-incarnation',body='GENERATED_NONZERO_CONTAINER_INCARNATION',a=await f.upload(f.a.token,externalId,body),b=await f.upload(f.b.token,externalId,body),path='/api/files/'+a.id;
 assert.equal(a.id,b.id);
 const first=await f.checked(f.a.token,path),firstIntent={operationId:randomUUID(),originalGeneration:first.originalGeneration},originalPath='/api/ingress/originals/'+first.originalRef.slice(9),oldTicket=await f.checked(f.a.token,originalPath+'/tickets','POST',{});
 const deleted=await f.checked(f.a.token,path,'DELETE',{operationId:randomUUID(),originalGeneration:first.originalGeneration});await f.checked(f.a.token,path+'/allow-again','POST',deleted.decision);await f.upload(f.a.token,externalId,body);
 const middle=await f.checked(f.a.token,path),middleIntent={operationId:randomUUID(),originalGeneration:middle.originalGeneration};assert.ok(middle.originalGeneration>first.originalGeneration);
 const middleTicket=await f.checked(f.a.token,originalPath+'/tickets','POST',{});
 await f.checked(f.a.token,'/api/sources/same-source','DELETE',{});
 await f.checked(f.a.token,'/api/ingress/sources','POST',{id:'same-source',name:'Generated replacement source',kind:'local-files',deviceId:'same-device',platform:'import',retention:'archive'});
 assert.equal((await f.upload(f.a.token,externalId,body)).id,a.id);
 const current=await f.checked(f.a.token,path);assert.ok(current.originalGeneration>middle.originalGeneration);
 for(const ticket of [oldTicket,middleTicket])assert.equal((await f.request(f.a.token,originalPath+'/content?ticket='+encodeURIComponent(ticket.ticket))).statusCode,404);
 for(const intent of [firstIntent,middleIntent])assert.equal((await f.request(f.a.token,path,'DELETE',intent)).statusCode,409);
 assert.equal((await f.checked(f.b.token,path)).originalGeneration,0);
 await f.host.app.close();
 const archive=join(root,'archive');await backupScopedInstance({source:f.directory,out:archive});
 const paths=profilePaths('generation',join(root,'profiles'));await initialize(paths,{runtime:'docker',image});profile=await loadProfile(paths);
 docker(['volume','create','--label','dev.mote.fixture='+runId,profile.meta.volume]);volumes.add(profile.meta.volume);
 const restored=await restoreProfile(profile,archive,{execute});assert.ok(restored.volume);volumes.add(restored.volume);profile=await loadProfile(paths);assert.equal(restored.deploymentId,f.a.deploymentId);
 const user=await dockerConfigurationUser(profile,execute);
 docker(['run','--pull','never','--detach','--name',container,'--label','dev.mote.fixture='+runId,'--network','none','--security-opt','no-new-privileges:true','--cap-drop','ALL','--user',user,'--mount',`type=volume,source=${restored.volume},target=/data`,'--mount',`type=bind,source=${profile.directory},target=/config`,'--env','MOTE_CONFIG_FILE=/config/mote.yaml',image!]);containerCreated=true;
 const request=(url:string,token?:string,method='GET',payload?:unknown)=>JSON.parse(docker(['exec',container,'node','-e',`(async()=>{const response=await fetch('http://127.0.0.1:${profile.port}'+${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json','x-mote-protocol-version':'2','x-mote-ingress-version':'3',...${JSON.stringify(token?{authorization:'Bearer '+token}:{})}},body:${JSON.stringify(payload===undefined?undefined:JSON.stringify(payload))}});const bytes=Buffer.from(await response.arrayBuffer());let json;try{json=JSON.parse(bytes.toString());}catch{}console.log(JSON.stringify({status:response.status,json,base64:bytes.toString('base64')}));})().catch(()=>process.exit(1));`]));
 const checked=(...args:Parameters<typeof request>)=>{const result=request(...args);assert.equal(result.status,200,JSON.stringify(result.json));return result.json;};
 let freshGeneration=current.originalGeneration;
 for(let cycle=0;cycle<2;cycle++){
  if(cycle)docker(['start',container]);
  docker(['exec',container,'node','-e',`(async()=>{for(let n=0;n<150;n++){try{if((await fetch('http://127.0.0.1:${profile.port}/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,200));}process.exit(1);})();`]);
  for(const previous of [f.a,f.b])assert.equal(request('/api/auth/self',previous.token).status,401);
  const login=(username:string)=>checked('/api/auth/login',undefined,'POST',{username,password:'Generated-joint-files-password',mode:'client'}),freshA=login('generated-a'),freshB=login('generated-b');assert.equal(freshA.userId,f.a.userId);assert.equal(freshB.userId,f.b.userId);
  assert.equal(checked(path,freshA.token).originalGeneration,current.originalGeneration);assert.equal(checked(path,freshB.token).originalGeneration,0);
  for(const intent of [firstIntent,middleIntent])assert.equal(request(path,freshA.token,'DELETE',intent).status,409);
  for(const ticket of [oldTicket,middleTicket])assert.equal(request(originalPath+'/content?ticket='+encodeURIComponent(ticket.ticket),freshA.token).status,404);
  const ticket=checked(originalPath+'/tickets',freshA.token,'POST',{}),content=originalPath+'/content?ticket='+encodeURIComponent(ticket.ticket),bytes=request(content,freshA.token);assert.equal(bytes.status,200);assert.equal(Buffer.from(bytes.base64,'base64').toString(),body);assert.equal(request(content,freshB.token).status,404);
  if(cycle){const receipt=checked(path,freshA.token,'DELETE',{operationId:randomUUID(),originalGeneration:current.originalGeneration});assert.equal(receipt.deleted,1);freshGeneration=receipt.decision.generation;assert.ok(freshGeneration>current.originalGeneration);assert.equal(request(path,freshA.token).status,404);assert.equal(request(path,freshB.token).status,200);}
  docker(['stop','--time','20',container]);const state=JSON.parse(docker(['inspect',container]))[0];assert.equal(state.State.ExitCode,0);assert.equal(state.State.Running,false);
 }
 const readback=join(root,'readback');await backupProfile(profile,readback,{execute});
 const db=new DatabaseSync(join(readback,'mote.sqlite'),{readOnly:true});try{const row=db.prepare('SELECT generation FROM ig_file_generations WHERE user_id=? AND source_id=? AND external_id=?').get(f.a.userId,'same-source',externalId);assert.equal(row?.generation,freshGeneration);assert.equal(db.prepare('SELECT count(*) n FROM ig_file_generations WHERE user_id=?').get(f.b.userId)!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM ig_originals WHERE user_id=?').get(f.a.userId)!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM ig_originals WHERE user_id=?').get(f.b.userId)!.n,1);}finally{db.close();}
 console.log(JSON.stringify({result:'PASS',runId,image,imageId,sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runtimeCandidate:process.env.MOTE_RECOVERY_CANDIDATE??null,runnerSha256:createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),sourceDirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),firstGeneration:first.originalGeneration,middleGeneration:middle.originalGeneration,restoredGeneration:current.originalGeneration,finalGeneration:freshGeneration,productionStartupCycles:2,staleIntent409:4,oldTickets404BeforeCredentialRotation:2,currentExactBytes:true,crossOwnerTicket404:true,otherOwnerPreserved:true,stoppedReadbackPreservesCounter:true,syntheticOnly:true}));
});
