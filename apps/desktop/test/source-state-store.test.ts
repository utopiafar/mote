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
