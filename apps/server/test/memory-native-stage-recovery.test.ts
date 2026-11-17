import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {constants} from 'node:sqlite';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {MemoryNativeStages} from '../src/memory-native-stages.js';

test('native recovery SQLite failure after handler registration leaves no callback and permits same-engine retry',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-h5-native-resource-'));
  const store=new Store(directory,{dataKey:'39'.repeat(32),contentEncryptionEnabled:true});
  const engine=new ExecutionEngine(store),sibling=new ExecutionEngine(store);
  let retry:MemoryNativeStages|undefined,callbackCalls=0,siblingCalls=0,deniedReads=0;
  let firstError:unknown,retryError:unknown,orphanEnqueueError:unknown,orphanStep:string|undefined;
  const originalKey=Buffer.from(store.key);
  store.db.prepare('INSERT INTO settings VALUES(?,?)').run('generated-h5-resource-history','retained');
  sibling.register({kind:'generated.h5-healthy',pool:'generated-h5',concurrency:()=>1,validate:()=>true,
    execute:async()=>{siblingCalls++;},commit:()=>{}});
  try{
    // SQLite denies only the original recovery read. DDL, ledger registration,
    // and engine.register have already run; no production method is replaced.
    store.db.setAuthorizer((code,object,column)=>{
      if(code===constants.SQLITE_READ&&object==='memory_engine_stage_cleanups'&&column==='state'){deniedReads++;return constants.SQLITE_DENY;}
      return constants.SQLITE_OK;
    });
    try{new MemoryNativeStages(store,engine,{settle:async()=>{callbackCalls++;}});}
    catch(error){firstError=error;}
    finally{store.db.setAuthorizer(null);}
    assert.ok(firstError instanceof Error,'the real recovery query must fail');
    assert.match(firstError.message,/memory_engine_stage_cleanups.*prohibited|not authorized/);
    assert.equal((firstError as Error&{code?:string}).code,'ERR_SQLITE_ERROR');
    assert.equal(firstError.cause,undefined,'the original SQLite failure must remain visible');
    assert.ok(deniedReads>0);
    assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='memory_engine_stage_cleanups'").get()?.n,1,
      'the intended recovery failure must occur after successful schema installation');

    // An object whose constructor failed must not leave an invocable handler.
    store.db.prepare('INSERT INTO memory_engine_stage_cleanups VALUES(?,?,?)').run('generated-orphan','{}','pending');
    try{
      orphanStep=engine.enqueue('generated-orphan-operation','memory.engine-stage-cleanup',{id:'generated-orphan'});
      await engine.drain([orphanStep]);
    }catch(error){orphanEnqueueError=error;}

    const healthy=sibling.enqueue('generated-sibling-operation','generated.h5-healthy',{});
    await sibling.drain([healthy]);
    assert.equal(sibling.get(healthy)?.state,'succeeded');
    assert.equal(siblingCalls,1,'a sibling engine on the same SQLite handle must remain usable');
    assert.equal(engine.closed,false);assert.equal(sibling.closed,false);
    assert.equal(store.db.prepare('SELECT value FROM settings WHERE key=?').get('generated-h5-resource-history')?.value,'retained');
    assert.deepEqual(store.key,originalKey);
    try{retry=new MemoryNativeStages(store,engine,{settle:async()=>{}});}
    catch(error){retryError=error;}
    assert.equal(callbackCalls,0,'a failed constructor left a live native cleanup callback');
    assert.equal(orphanStep,undefined);
    assert.ok(orphanEnqueueError instanceof Error);assert.match(orphanEnqueueError.message,/Execution handler unavailable/);
    assert.equal(retryError,undefined,'same-engine retry must not collide with a failed constructor handler');
    assert.ok(retry);
  }finally{
    store.db.setAuthorizer(null);
    await retry?.close();await engine.close();await sibling.close();store.close();
    rmSync(directory,{recursive:true,force:true});
  }
});
