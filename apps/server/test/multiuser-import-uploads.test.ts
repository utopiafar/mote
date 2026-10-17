import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import {scopedFilesFixture} from './fixtures/scoped-files.js';
import {waitForScopedState} from './fixtures/scoped-process.js';
import {rmSync,unlinkSync,existsSync} from 'node:fs';
import {backupScopedInstance,restoreScopedInstance} from '../../../scripts/scoped-backup.mjs';
import {identityHash} from '../src/scope/originals.js';

// Original generic import client protocol, through actual Accounts/production
// HTTP/SQLite/M03 originals. No unconfirmed capture or Material is published.
test('generic upload ACKs persist across restart, deduplicate exact parts and keep equal upload IDs private until explicit import',async t=>{
 const f=await scopedFilesFixture(t),id=randomUUID(),a=Buffer.from('Generated A archived import bytes'),b=Buffer.from('Generated B archived import bytes');
 const manifest={id,name:'generated/facts.txt',sizeBytes:a.length,mimeType:'text/plain'};
 const begin=await f.checked(f.a.token,'/api/import-uploads','POST',manifest);assert.equal(begin.id,id);assert.equal(begin.partBytes,4*1024*1024);assert.deepEqual(begin.parts,[]);
 await f.checked(f.b.token,'/api/import-uploads','POST',manifest);
 assert.equal((await f.request(f.a.token,'/api/import-uploads','POST',{...manifest,name:'changed.txt'})).statusCode,409);
 assert.equal((await f.request(f.a.token,'/api/import-uploads/'+id+'/commit','POST',{})).statusCode,409);
 const path='/api/import-uploads/'+id+'/parts/0',headers={'content-type':'application/octet-stream'};
 const part=await f.request(f.a.token,path,'PUT',a,headers);assert.equal(part.statusCode,200,part.body);
 assert.deepEqual((await f.request(f.a.token,path,'PUT',a,headers)).json(),part.json());
 assert.equal((await f.request(f.a.token,path,'PUT',Buffer.alloc(a.length,1),headers)).statusCode,409);
 assert.equal((await f.request(f.b.token,path,'PUT',b,headers)).statusCode,200);
 const fileA=await f.checked(f.a.token,'/api/import-uploads/'+id+'/commit','POST',{}),fileB=await f.checked(f.b.token,'/api/import-uploads/'+id+'/commit','POST',{});
 assert.equal(fileA.relativePath,manifest.name);assert.equal(fileA.name,'facts.txt');assert.equal(fileA.sizeBytes,a.length);assert.notEqual(fileA.id,fileB.id);
 assert.equal((await f.checked(f.a.token,'/api/import-uploads','POST',manifest)).fileId,fileA.id);
 assert.equal((await f.request(f.a.token,'/api/archived-files/'+fileA.id+'/content')).rawPayload.toString(),a.toString());
 assert.equal((await f.request(f.b.token,'/api/archived-files/'+fileA.id+'/content')).statusCode,404);
 assert.equal((await f.request(f.admin.token,'/api/archived-files/'+fileA.id)).statusCode,404);
 assert.deepEqual((await f.checked(f.a.token,'/api/files')).items,[]);
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM pd_captures').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM pd_materials').get()!.n,0);}finally{db.close();}
 await f.host.app.close();const restarted=await buildApp({dataDir:f.directory});try{
  const headers={authorization:'Bearer '+f.a.token,'x-mote-protocol-version':'2'};
  const replay=await restarted.app.inject({method:'POST',url:'/api/import-uploads',headers,payload:manifest});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().fileId,fileA.id);
  const content=await restarted.app.inject({url:'/api/archived-files/'+fileA.id+'/content',headers});assert.equal(content.statusCode,200,content.body);assert.deepEqual(content.rawPayload,a);
 }finally{await restarted.app.close();}
});

test('generic raw four-MiB parts survive a real host restart before commit without publishing evidence',async t=>{
 const f=await scopedFilesFixture(t),id=randomUUID(),part=Buffer.alloc(4*1024*1024,65),tail=Buffer.from('END'),manifest={id,name:'generated-large.txt',sizeBytes:part.length+tail.length,mimeType:'text/plain'};
 await f.checked(f.a.token,'/api/import-uploads','POST',manifest);
 assert.equal((await f.request(f.a.token,'/api/import-uploads/'+id+'/parts/0','PUT',part,{'content-type':'application/octet-stream'})).statusCode,200);
 await f.host.app.close();const host=await buildApp({dataDir:f.directory});
 try{
  const request=(url:string,method:any='GET',payload?:unknown,headers={})=>host.app.inject({url,method,headers:{authorization:'Bearer '+f.a.token,'x-mote-protocol-version':'2',...headers},...(payload===undefined?{}:{payload})});
  const begin=await request('/api/import-uploads','POST',manifest);assert.equal(begin.statusCode,200,begin.body);assert.equal(begin.json().parts.length,1);assert.equal(begin.json().parts[0].part,0);
  assert.equal((await request('/api/import-uploads/'+id+'/commit','POST',{})).statusCode,409);
  const saved=await request('/api/import-uploads/'+id+'/parts/1','PUT',tail,{'content-type':'application/octet-stream'});assert.equal(saved.statusCode,200,saved.body);
  const committed=await request('/api/import-uploads/'+id+'/commit','POST',{});assert.equal(committed.statusCode,200,committed.body);
  const content=await request('/api/archived-files/'+committed.json().id+'/content');assert.equal(content.statusCode,200,content.body);assert.deepEqual(content.rawPayload,Buffer.concat([part,tail]));
  const db=new DatabaseSync(join(f.directory,'mote.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM pd_captures').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM ig_import_parts').get()!.n,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);}finally{db.close();}
 }finally{await host.app.close();}
});

test('unconfirmed archived files participate in actual personal merge, erasure and stopped backup without renewing upload grants',async t=>{
 const f=await scopedFilesFixture(t),bytes=Buffer.from('Generated private unconfirmed original'),manifest={id:randomUUID(),name:'generated.txt',sizeBytes:bytes.length,mimeType:'text/plain'},files=[];
 for(const account of [f.a,f.b]){await f.checked(account.token,'/api/import-uploads','POST',manifest);const part=await f.request(account.token,'/api/import-uploads/'+manifest.id+'/parts/0','PUT',bytes,{'content-type':'application/octet-stream'});assert.equal(part.statusCode,200,part.body);files.push(await f.checked(account.token,'/api/import-uploads/'+manifest.id+'/commit','POST',{}));}
 await f.checked(f.a.token,'/api/ingress/gc','POST',{});
 assert.deepEqual((await f.request(f.a.token,'/api/archived-files/'+files[0].id+'/content')).rawPayload,bytes);
 const exportId=randomUUID();await f.checked(f.a.token,'/api/portable/exports','POST',{operationId:exportId});await waitForScopedState(async()=>(await f.checked(f.a.token,'/api/portable/exports/'+exportId)).state==='completed',()=>'unconfirmed original export did not settle');
 const archive=await f.checked(f.a.token,'/api/portable/exports/'+exportId+'/content'),ingress=archive.domains.find((domain:any)=>domain.domain==='ingress').payload;
 assert.equal(ingress.originals.length,0);assert.equal(ingress.archivedFiles.length,1);assert.equal(ingress.archivedFiles[0].id,files[0].id);assert.equal(ingress.objects.length,1);
 const imported=randomUUID();await f.checked(f.a.token,'/api/portable/imports','POST',{operationId:imported,archive});await waitForScopedState(async()=>(await f.checked(f.a.token,'/api/portable/imports/'+imported)).state!=='working',()=>'unconfirmed archive merge did not settle');assert.equal((await f.checked(f.a.token,'/api/portable/imports/'+imported)).state,'completed');
 const deletion=await f.checked(f.admin.token,'/api/admin/accounts/'+f.a.userId,'DELETE',{operationId:randomUUID()});await waitForScopedState(async()=>(await f.checked(f.admin.token,'/api/admin/account-deletions/'+deletion.id)).state==='completed',()=>'unconfirmed original physical erasure did not settle');
 assert.deepEqual((await f.request(f.b.token,'/api/archived-files/'+files[1].id+'/content')).rawPayload,bytes);
 const snapshot=f.directory+'-backup',target=f.directory+'-restore',bad=f.directory+'-bad-backup';t.after(()=>{for(const path of [snapshot,target,bad])rmSync(path,{recursive:true,force:true});});
 await f.host.app.close();await backupScopedInstance({source:f.directory,out:snapshot});await restoreScopedInstance({from:snapshot,target,deploymentId:f.host.deploymentId});
 const restored=await buildApp({dataDir:target});try{const b=await restored.accounts!.login('generated-b','Generated-joint-files-password','generated','client',0),headers={authorization:'Bearer '+b.token,'x-mote-protocol-version':'2'};assert.deepEqual((await restored.app.inject({url:'/api/archived-files/'+files[1].id+'/content',headers})).rawPayload,bytes);const stale=await restored.app.inject({method:'POST',url:'/api/import-uploads',headers,payload:manifest});assert.equal(stale.statusCode,409,'instance recovery never renews the earlier upload epoch');}finally{await restored.app.close();}
 unlinkSync(join(f.directory,'originals',identityHash([f.host.deploymentId,f.b.userId]),'objects',files[1].hash,'0.plain'));
 await assert.rejects(backupScopedInstance({source:f.directory,out:bad}));assert.equal(existsSync(bad),false,'missing unconfirmed original cannot publish an allegedly complete backup');
});

test('generic staging keeps the prior one-day cleanup and handles an explicitly empty original',async t=>{
 const f=await scopedFilesFixture(t),id=randomUUID(),manifest={id,name:'empty.txt',sizeBytes:0,mimeType:'text/plain'};
 await f.checked(f.a.token,'/api/import-uploads','POST',manifest);const file=await f.checked(f.a.token,'/api/import-uploads/'+id+'/commit','POST',{});
 const content=await f.request(f.a.token,'/api/archived-files/'+file.id+'/content');assert.equal(content.statusCode,200,content.body);assert.equal(content.rawPayload.length,0);
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'));try{db.prepare('UPDATE ig_import_uploads SET expires=0 WHERE user_id=? AND id=?').run(f.a.userId,id);}finally{db.close();}
 await f.checked(f.a.token,'/api/import-uploads','POST',{...manifest,id:randomUUID(),name:'next.txt'});
 assert.equal((await f.request(f.a.token,'/api/archived-files/'+file.id)).statusCode,404);
});

test('overlapping commit requests retain the same successful original when a second actual worker starts after the first ACK',async t=>{
 const {Originals}=await import('../src/scope/originals.js'),original=Originals.prototype.prepareArchive;
 const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};},firstEntered=gate(),secondEntered=gate(),releaseFirst=gate(),releaseSecond=gate();let calls=0;
 // Fault-schedule only: both production commit routes have read pending state;
 // the actual M03 worker/file/SQL transport is preserved after each barrier.
 Originals.prototype.prepareArchive=async function(...args:Parameters<typeof original>){const index=++calls;if(index===1){firstEntered.resolve();await releaseFirst.promise;}if(index===2){secondEntered.resolve();await releaseSecond.promise;}return original.apply(this,args);};
 t.after(()=>{Originals.prototype.prepareArchive=original;releaseFirst.resolve();releaseSecond.resolve();});
 const f=await scopedFilesFixture(t),id=randomUUID(),bytes=Buffer.from('Generated concurrent original');
 await f.checked(f.a.token,'/api/import-uploads','POST',{id,name:'concurrent.txt',sizeBytes:bytes.length,mimeType:'text/plain'});
 assert.equal((await f.request(f.a.token,'/api/import-uploads/'+id+'/parts/0','PUT',bytes,{'content-type':'application/octet-stream'})).statusCode,200);
 const first=f.request(f.a.token,'/api/import-uploads/'+id+'/commit','POST',{}).then(value=>value);await firstEntered.promise;
 const second=f.request(f.a.token,'/api/import-uploads/'+id+'/commit','POST',{}).then(value=>value);
 // A serialized implementation intentionally never admits the second worker.
 await Promise.race([secondEntered.promise,new Promise(resolve=>setTimeout(resolve,40))]);releaseFirst.resolve();const a=await first;releaseSecond.resolve();const b=await second;
 assert.equal(a.statusCode,200,a.body);assert.equal(b.statusCode,200,b.body);assert.deepEqual(a.json(),b.json());
 assert.deepEqual((await f.request(f.a.token,'/api/archived-files/'+a.json().id+'/content')).rawPayload,bytes);
});


test('account erasure holds generic-upload physical cleanup until its live original worker settles, without affecting B',async t=>{
 const {Originals}=await import('../src/scope/originals.js'),original=Originals.prototype.prepareArchive,gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};},entered=gate(),release=gate();let calls=0;
 Originals.prototype.prepareArchive=async function(...args:Parameters<typeof original>){if(++calls===1){entered.resolve();await release.promise;}return original.apply(this,args);};t.after(()=>{Originals.prototype.prepareArchive=original;release.resolve();});
 const f=await scopedFilesFixture(t),id=randomUUID(),bytes=Buffer.from('Generated erasure upload original'),manifest={id,name:'erase-generic.txt',sizeBytes:bytes.length,mimeType:'text/plain'};for(const account of [f.a,f.b]){await f.checked(account.token,'/api/import-uploads','POST',manifest);assert.equal((await f.request(account.token,'/api/import-uploads/'+id+'/parts/0','PUT',bytes,{'content-type':'application/octet-stream'})).statusCode,200);}
 const held=f.request(f.a.token,'/api/import-uploads/'+id+'/commit','POST',{});await entered.promise;const b=await f.checked(f.b.token,'/api/import-uploads/'+id+'/commit','POST',{}),deletion=await f.checked(f.admin.token,'/api/admin/accounts/'+f.a.userId,'DELETE',{operationId:randomUUID()});
 await waitForScopedState(async()=>(await f.checked(f.admin.token,'/api/admin/account-deletions/'+deletion.id)).state==='result_unknown',()=>'live original worker did not prevent claimed erasure',15000);const root=join(f.directory,'originals',identityHash([f.host.deploymentId,f.a.userId]));assert.equal(existsSync(root),true);assert.deepEqual((await f.request(f.b.token,'/api/archived-files/'+b.id+'/content')).rawPayload,bytes);assert.equal((await f.request(f.a.token,'/api/import-uploads','POST',manifest)).statusCode,401);
 release.resolve();const late=await held;assert.equal(late.statusCode,401,'retired A worker cannot publish a late archived file');await f.checked(f.admin.token,'/api/admin/account-deletions/'+deletion.id+'/retry','POST',{});await waitForScopedState(async()=>(await f.checked(f.admin.token,'/api/admin/account-deletions/'+deletion.id)).state==='completed',()=>'settled original worker did not permit physical erasure',15000);assert.equal(existsSync(root),false);assert.deepEqual((await f.request(f.b.token,'/api/archived-files/'+b.id+'/content')).rawPayload,bytes);
});


test('shared binary parser preserves Imports authentication, MIME, method, path and part bounds while B can commit',async t=>{
 const f=await scopedFilesFixture(t),id=randomUUID(),bytes=Buffer.from('Generated bounded binary'),path='/api/import-uploads/'+id+'/parts/0',mime={'content-type':'application/octet-stream'};
 const manifest={id,name:'bounded.txt',sizeBytes:bytes.length,mimeType:'text/plain'};
 for(const account of [f.a,f.b])await f.checked(account.token,'/api/import-uploads','POST',manifest);
 assert.equal((await f.request(undefined,path,'PUT',bytes,mime)).statusCode,401);
 assert.equal((await f.request(f.a.token,path,'PUT',bytes,{...mime,'x-mote-protocol-version':'1'})).statusCode,426);
 assert.equal((await f.request(f.a.token,path,'PUT',bytes,{...mime,'x-user-id':f.b.userId})).statusCode,401);
 for(const [body,type] of [[bytes.toString(),'text/plain'],[{type:'Buffer',data:[...bytes]},'application/json']] as const){
  const response=await f.request(f.a.token,path,'PUT',body,{'content-type':type});assert.equal(response.statusCode,400,response.body);
 }
 assert.equal((await f.request(f.a.token,path,'PUT',bytes,{'content-type':'application/x-generated-unsupported'})).statusCode,503,'the frozen global error handler rejects an unregistered MIME before staging');
 assert.equal((await f.request(f.a.token,path,'PUT',Buffer.alloc(4*1024*1024+1),mime)).statusCode,503,'the frozen global error handler rejects an oversized part before staging');
 assert.equal((await f.request(f.a.token,path,'PUT',bytes.subarray(1),mime)).statusCode,400);
 for(const url of ['/api/import-uploads/not-a-uuid/parts/0','/api/import-uploads/'+id+'/parts/-1','/api/import-uploads/'+id+'/parts/1.5','/api/import-uploads/'+id+'/parts/1e0','/api/import-uploads/'+id+'/parts/0x0'])assert.equal((await f.request(f.a.token,url,'PUT',bytes,mime)).statusCode,400);
 for(const [method,url] of [['POST',path],['PUT',path+'/extra'],['PUT','/api/import-uploads/'+id+'/not-parts/0']] as const){const response=await f.request(f.a.token,url,method,bytes,mime);assert.ok([400,503].includes(response.statusCode),JSON.stringify({method,url,status:response.statusCode,body:response.json()}));}
 assert.deepEqual((await f.checked(f.a.token,'/api/import-uploads','POST',manifest)).parts,[],'all rejected requests leave A staging unchanged');
 const db=new DatabaseSync(join(f.directory,'mote.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) n FROM ig_import_parts').get()!.n,0);assert.equal(db.prepare('SELECT count(*) n FROM pd_captures').get()!.n,0);}finally{db.close();}
 // B succeeds after every negative; A's equal upload ID remains empty/private.
 assert.equal((await f.request(f.b.token,path,'PUT',bytes,mime)).statusCode,200);
 const file=await f.checked(f.b.token,'/api/import-uploads/'+id+'/commit','POST',{});
 assert.deepEqual((await f.request(f.b.token,'/api/archived-files/'+file.id+'/content')).rawPayload,bytes);
 assert.equal((await f.request(f.a.token,'/api/archived-files/'+file.id+'/content')).statusCode,404);
 assert.deepEqual((await f.checked(f.a.token,'/api/import-uploads','POST',manifest)).parts,[]);
});
