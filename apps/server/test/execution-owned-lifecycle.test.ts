import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {ImportStore} from '../src/imports.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';

const nextTurn=()=>new Promise<void>(resolve=>setImmediate(resolve));
test('closing a completion backlog cancels its queued admission before the database closes',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-queued-close-')),store=new Store(directory),engine=new ExecutionEngine(store);let calls=0,dbClosed=false;
 try{
  engine.register({kind:'generated',pool:'generated',concurrency:()=>1,validate:()=>true,execute:async()=>{calls++;},commit:()=>{}});
  const ids=Array.from({length:80},(_,n)=>engine.enqueue('generated','generated',{n}));
  await engine.tick();assert.equal(calls,1);assert.equal(engine.get(ids[1])?.state,'waiting');
  await engine.close();store.close();dbClosed=true;await nextTurn();await nextTurn();
  assert.equal(calls,1);assert.equal(engine.closed,true);
 }finally{await engine.close();if(!dbClosed)store.close();rmSync(directory,{recursive:true,force:true});}
});
for(const shared of [false,true])test(`import stop closes ${shared?'its handlers while preserving the injected':'its own'} executor after job deletion`,async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-import-owned-close-')),store=new Store(directory),engine=new ExecutionEngine(store),imports=new ImportStore(store,new ArchivedFileStore(store),new SourceStore(store),shared?{executor:engine}:{});
 try{
  const job=await imports.create({files:[{name:'generated.txt',dataBase64:Buffer.from('Generated retained original').toString('base64')}]});
  await imports.prepare(job.id);const retained=store.db.prepare('SELECT id,state,attempts FROM execution_steps ORDER BY id').all();
  imports.delete(job.id);await imports.stop();assert.equal(engine.closed,false);assert.deepEqual(store.db.prepare('SELECT id,state,attempts FROM execution_steps ORDER BY id').all(),retained);
  if(shared){engine.register({kind:'remaining',pool:'remaining',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{}});const id=engine.enqueue('remaining','remaining',{});await engine.drain([id]);assert.equal(engine.get(id)?.state,'succeeded');}
 }finally{await imports.stop();await engine.close();store.close();await nextTurn();rmSync(directory,{recursive:true,force:true});}
});
for(const shared of [false,true])test(`organizer close preserves ${shared?'the shared executor and index':'a newer organizer index while closing its own executor'}`,async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-organizer-owned-close-')),store=new Store(directory),materials=new MaterialStore(store),engine=new ExecutionEngine(store),first=new MaterialOrganizerRuntime(store,materials,[],shared?engine:undefined);
 const second=shared?undefined:new MaterialOrganizerRuntime(store,materials);
 try{
  const currentIndex=materials.index!;await first.close();assert.equal(first.executor.closed,!shared);assert.equal(engine.closed,false);
  assert.equal(materials.index,currentIndex);await currentIndex.tick();assert.equal(second?.executor.closed??false,false);
 }finally{await first.close();await second?.close();await materials.index?.close();await engine.close();store.close();await nextTurn();rmSync(directory,{recursive:true,force:true});}
});
