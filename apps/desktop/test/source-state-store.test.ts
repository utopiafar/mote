import {test,afterEach} from 'vitest';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {sourceState,sourceStatePatch} from '../src/source-state-store';

test('legacy source state migrates after interrupted database creation; over-budget changes roll back with checkpoint',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-state-')),path=join(directory,'source.json');afterEach(()=>rm(directory,{recursive:true,force:true}));
 const before={version:2,known:{a:{revision:'1'}},pendingRealtime:[{revision:'1'}],pendingHistory:[],checkpoint:{cursor:1}};
 await writeFile(path,JSON.stringify(before));new DatabaseSync(path+'.sqlite').close();
 assert.deepEqual(sourceState(path),before);await assert.rejects(access(path));await access(path+'.pre-sqlite');
 const next={...before,checkpoint:{cursor:2},pendingRealtime:[{body:'x'.repeat(1000)}]};
 assert.throws(()=>sourceState(path,sourceStatePatch(before,next),100),/队列已满/);
 assert.deepEqual(sourceState(path),before);
 const ack={...before,pendingRealtime:[],checkpoint:{cursor:2}};const patch=sourceStatePatch(before,ack);
 assert.ok(patch.every(p=>p.section!=='known'));sourceState(path,patch,100);assert.deepEqual(sourceState(path),ack);
});


test('opening source state waits for a concurrent initialization transaction',async()=>{
 const {Worker}=await import('node:worker_threads');
 const directory=await mkdtemp(join(tmpdir(),'mote-state-lock-')),path=join(directory,'source.json');
 afterEach(()=>rm(directory,{recursive:true,force:true}));
 const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(workerData); db.exec('BEGIN EXCLUSIVE'); parentPort.postMessage('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200); db.exec('COMMIT'); db.close();`,{eval:true,workerData:path+'.sqlite'});
 const exited=new Promise<void>((resolve,reject)=>{worker.once('exit',code=>code?reject(Error('Fixture worker failed')):resolve());worker.once('error',reject);});
 await new Promise<void>(resolve=>worker.once('message',()=>resolve()));
 assert.equal(sourceState(path),undefined);await exited;
 sourceState(path,[{section:'state',key:'checkpoint',value:{cursor:7}}]);
 assert.deepEqual(sourceState(path)?.checkpoint,{cursor:7});
});


test('directory scan checkpoints persist only changed catalog rows and migrate inline SQLite catalogs',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-catalog-state-')),path=join(directory,'source.json');afterEach(()=>rm(directory,{recursive:true,force:true}));
 const catalog=Object.fromEntries(Array.from({length:1000},(_,i)=>['file-'+i,{size:i,lastSeenScan:1,hash:'generated-'+i}]));
 const before={version:2,known:{},pendingRealtime:[],pendingHistory:[],checkpoint:{version:1,root:'/generated',scanNumber:1,catalog}};
 sourceState(path,sourceStatePatch({},before),100);assert.deepEqual(sourceState(path),before);
 const next={...before,checkpoint:{...before.checkpoint,catalog:{...catalog,'file-7':{size:42,lastSeenScan:2,hash:'changed'}}}};
 const patches=sourceStatePatch(before,next);assert.deepEqual(patches.map(p=>[p.section,p.key]),[['catalog','file-7']]);
 sourceState(path,patches,100);assert.deepEqual(sourceState(path),next);
 const db=new DatabaseSync(path+'.sqlite');
 assert.equal(db.prepare("SELECT count(*) n FROM entries WHERE section='catalog'").get()!.n,1000);
 db.prepare("UPDATE entries SET value=? WHERE section='state' AND key='checkpoint'").run(Buffer.from(JSON.stringify(before.checkpoint)));
 db.exec("DELETE FROM entries WHERE section='catalog'");db.close();
 assert.deepEqual(sourceState(path),before);
 const inspect=new DatabaseSync(path+'.sqlite');assert.ok(Number(inspect.prepare("SELECT length(value) n FROM entries WHERE section='state' AND key='checkpoint'").get()!.n)<200);inspect.close();
 sourceState(path,sourceStatePatch(before,{...before,checkpoint:undefined}));assert.equal(sourceState(path)?.checkpoint,undefined);
 const cleared=new DatabaseSync(path+'.sqlite');assert.equal(cleared.prepare("SELECT count(*) n FROM entries WHERE section='catalog'").get()!.n,0);cleared.close();
});

test('outbox arrays migrate into ordered per-revision rows and one ACK deletes only one row',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-outbox-')),path=join(directory,'source.json');afterEach(()=>rm(directory,{recursive:true,force:true}));
 const before={version:2,known:{},pendingRealtime:[{externalId:'one',revision:'2'},{externalId:'one',revision:'3'},{externalId:'two',revision:'1'}],pendingHistory:[]};
 sourceState(path,sourceStatePatch({},before));
 const db=new DatabaseSync(path+'.sqlite');db.exec("DELETE FROM entries WHERE section='pendingRealtime'");db.prepare("INSERT INTO entries VALUES('state','pendingRealtime',?)").run(Buffer.from(JSON.stringify(before.pendingRealtime)));db.close();
 assert.deepEqual(sourceState(path),before);
 const next={...before,pendingRealtime:before.pendingRealtime.slice(1)},patches=sourceStatePatch(before,next);
 assert.equal(patches.length,1);assert.equal(patches[0].section,'pendingRealtime');assert.equal(patches[0].value,undefined);
 sourceState(path,patches);assert.deepEqual(sourceState(path),next);
 const inspect=new DatabaseSync(path+'.sqlite');assert.equal(inspect.prepare("SELECT count(*) n FROM entries WHERE section='pendingRealtime'").get()!.n,2);assert.equal(inspect.prepare("SELECT count(*) n FROM entries WHERE section='state' AND key='pendingRealtime'").get()!.n,0);inspect.close();
});
