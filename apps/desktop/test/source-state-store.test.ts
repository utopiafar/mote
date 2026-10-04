import {test,afterEach} from 'vitest';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';import {sourceState,sourceStatePatch} from '../src/source-state-store';
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'mote-state3-'));afterEach(()=>rm(directory,{recursive:true,force:true}));return join(directory,'source.json');}
test('rejects JSON and old SQLite source states without converting or clearing them',async()=>{
 const path=await fixture(),raw=JSON.stringify({version:2,pendingRealtime:[{externalId:'generated',revision:'old'}]});await writeFile(path,raw);
 assert.throws(()=>sourceState(path),/Unsupported desktop storage format/);assert.equal(await readFile(path,'utf8'),raw);
 await rm(path);const db=new DatabaseSync(path+'.sqlite');db.exec('CREATE TABLE entries(section TEXT,key TEXT,value BLOB)');db.prepare('INSERT INTO entries VALUES(?,?,?)').run('state','version',Buffer.from('2'));db.close();
 const before=await readFile(path+'.sqlite');assert.throws(()=>sourceState(path),/Unsupported desktop storage format/);assert.deepEqual(await readFile(path+'.sqlite'),before);
});
test('current row outbox capacity rolls back with its checkpoint and ACK deletes only its own revision',async()=>{
 const path=await fixture(),before={version:3,known:{a:{revision:'1'}},pendingRealtime:[{externalId:'one',revision:'1'}],pendingHistory:[],checkpoint:{cursor:1}};
 sourceState(path,sourceStatePatch({},before));assert.deepEqual(sourceState(path),before);
 const next={...before,checkpoint:{cursor:2},pendingRealtime:[{externalId:'one',revision:'2',body:'x'.repeat(1000)}]};
 assert.throws(()=>sourceState(path,sourceStatePatch(before,next),100),/队列已满/);assert.deepEqual(sourceState(path),before);
 const ack={...before,pendingRealtime:[],checkpoint:{cursor:2}};sourceState(path,sourceStatePatch(before,ack),100);assert.deepEqual(sourceState(path),ack);
 const inspect=new DatabaseSync(path+'.sqlite');assert.equal(inspect.prepare('PRAGMA user_version').get()!.user_version,3);inspect.close();
});
test('current initialization waits for a concurrent transaction',async()=>{
 const {Worker}=await import('node:worker_threads'),path=await fixture();sourceState(path);
 const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData);db.exec('BEGIN EXCLUSIVE');parentPort.postMessage('locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);db.exec('COMMIT');db.close();`,{eval:true,workerData:path+'.sqlite'});
 const exited=new Promise<void>((resolve,reject)=>{worker.once('exit',code=>code?reject(Error('Fixture worker failed')):resolve());worker.once('error',reject);});await new Promise<void>(resolve=>worker.once('message',()=>resolve()));
 assert.equal(sourceState(path),undefined);await exited;sourceState(path,[{section:'state',key:'checkpoint',value:{cursor:7}}]);assert.deepEqual(sourceState(path)?.checkpoint,{cursor:7});
});
test('current catalog commits only changed rows and rejects embedded old layouts',async()=>{
 const path=await fixture(),catalog=Object.fromEntries(Array.from({length:1000},(_,i)=>['file-'+i,{size:i,lastSeenScan:1}]));
 const before={version:3,known:{},pendingRealtime:[],pendingHistory:[],checkpoint:{version:1,root:'/generated',scanNumber:1,catalog}};sourceState(path,sourceStatePatch({},before));assert.deepEqual(sourceState(path),before);
 const next={...before,checkpoint:{...before.checkpoint,catalog:{...catalog,'file-7':{size:42,lastSeenScan:2}}}},patches=sourceStatePatch(before,next);assert.deepEqual(patches.map(p=>[p.section,p.key]),[['catalog','file-7']]);sourceState(path,patches);assert.deepEqual(sourceState(path),next);
 const db=new DatabaseSync(path+'.sqlite');db.prepare("UPDATE entries SET value=? WHERE section='state' AND key='checkpoint'").run(Buffer.from(JSON.stringify(before.checkpoint)));db.close();assert.throws(()=>sourceState(path),/Unsupported desktop storage format/);
});
test('whole outbox arrays are rejected without clearing their pending bodies',async()=>{
 const path=await fixture();sourceState(path);const db=new DatabaseSync(path+'.sqlite');db.prepare("INSERT INTO entries VALUES('state','pendingRealtime',?)").run(Buffer.from('[{"externalId":"one","revision":"1"}]'));db.close();assert.throws(()=>sourceState(path),/Unsupported desktop storage format/);
 const inspect=new DatabaseSync(path+'.sqlite');assert.ok(inspect.prepare("SELECT value FROM entries WHERE section='state' AND key='pendingRealtime'").get());inspect.close();
});
