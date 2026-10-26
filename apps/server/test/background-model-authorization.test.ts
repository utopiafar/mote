import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {BackgroundModelAuthorization,modelConnection,type ModelConnection} from '../src/background-model-authorization.js';
import {Store} from '../src/store.js';
import {ExecutionEngine,type ExecutionStep} from '../src/execution-engine.js';

function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-model-authority-')),store=new Store(directory);
  let connections=[modelConnection('fixture',{provider:'generated',model:'small',apiKey:'fixture-only'})];
  let control=new BackgroundModelAuthorization(store,()=>connections);
  t.after(()=>{control.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const receive=(id:string,sourceId='fixture')=>{store.db.exec('BEGIN IMMEDIATE');try{control.receive(id,{sourceId,dataKind:'text'});store.db.exec('COMMIT');}catch(error){store.db.exec('ROLLBACK');throw error;}};
  const command=(action:'authorize'|'pause'|'stop')=>control.command({action,operationId:randomUUID(),revision:control.view().revision,...(action==='authorize'?{connections,scope:{sourceIds:['fixture'],dataKinds:['text']}}:{})});
  return {store,get control(){return control;},get connection(){return connections[0];},receive,command,
    replaceConnection(){connections=[modelConnection('fixture',{provider:'generated',model:'replacement',apiKey:'fixture-only'})];},
    restart(){control.close();control=new BackgroundModelAuthorization(store,()=>connections);}};
}

test('a configured model cannot process old data after first approval, duplicate delivery, derived publication or restart',async t=>{
  const f=fixture(t);f.receive('old');assert.throws(()=>f.control.automatic('old-job',['old']));
  f.command('authorize');f.receive('old');assert.throws(()=>f.control.automatic('old-job',['old']));
  f.store.db.exec('BEGIN IMMEDIATE');f.control.derive('new-projection',['old']);f.store.db.exec('COMMIT');
  assert.throws(()=>f.control.automatic('projection-job',['new-projection']));
  f.restart();assert.equal(f.control.view().state,'enabled');assert.throws(()=>f.control.automatic('old-job',['old']));
  f.receive('new');const work=f.control.automatic('new-job',['new']);let sends=0;
  await f.control.run(work,async()=>{f.control.assertCurrent(f.connection);sends++;});assert.equal(sends,1);
  assert.throws(()=>f.control.assertCurrent(f.connection));
  await assert.rejects(f.control.run('unissued-http-boolean',async()=>{sends++;}));assert.equal(sends,1);
});

test('pause drains admitted work, never fills the pause gap, and source/data restrictions apply to historical references',async t=>{
  const f=fixture(t);f.command('authorize');f.receive('accepted');f.control.automatic('admitted',['accepted']);
  f.command('pause');f.receive('gap');
  await f.control.run('admitted',async()=>{
    f.control.assertCurrent(f.connection);
    // References are checked by approved scope, not their receipt age.
    f.control.assertDisclosure([{sourceId:'fixture',dataKind:'text'}]);
    assert.throws(()=>f.control.assertDisclosure([{sourceId:'other-source',dataKind:'text'}]));
    assert.throws(()=>f.control.assertDisclosure([{sourceId:'fixture',dataKind:'image'}]));
  });
  assert.throws(()=>f.control.automatic('new-admission-while-paused',['accepted']));
  f.command('authorize');f.receive('gap');assert.throws(()=>f.control.automatic('gap-job',['gap']));
  f.receive('after');f.control.automatic('after-job',['after']);
});

test('stopping aborts a transmitted request and fences its late result; restart cannot replay the old authority',async t=>{
  const f=fixture(t);f.command('authorize');f.receive('input');f.control.automatic('in-flight',['input']);
  let entered!:()=>void,release!:()=>void,published=false,wasAborted=false;
  const started=new Promise<void>(r=>entered=r),provider=new Promise<void>(r=>release=r);
  const request=f.control.run('in-flight',async signal=>{f.control.assertCurrent(f.connection);entered();await provider;wasAborted=signal.aborted;f.control.assertCurrent(f.connection);published=true;});
  await started;f.command('stop');release();await assert.rejects(request);assert.equal(wasAborted,true);assert.equal(published,false);
  f.restart();f.command('authorize');assert.throws(()=>f.control.automatic('in-flight',['input']));
  f.receive('replacement-trigger');f.control.automatic('replacement-job',['replacement-trigger']);
});

test('a replacement connection does not inherit an earlier approval or reset existing explicit manual work',async t=>{
  const f=fixture(t);f.command('authorize');f.receive('input');f.control.automatic('background',['input']);
  const previous=f.connection;f.replaceConnection();
  await assert.rejects(f.control.run('background',async()=>f.control.assertCurrent(f.connection)));
  await assert.rejects(f.control.run('background',async()=>f.control.assertCurrent(previous)));
  f.control.manual('explicit-ask','manual');let calls=0;
  await f.control.run('explicit-ask',async()=>{f.control.assertCurrent(f.connection);calls++;});assert.equal(calls,1);
  f.command('stop');await f.control.run('explicit-ask',async()=>f.control.assertCurrent(f.connection));
  assert.throws(()=>f.control.manual('explicit-ask','probe'));
});

test('stale or forged approvals do not change the owner decision and command retry cannot stop twice',t=>{
  const f=fixture(t),bad:ModelConnection={id:'fixture',fingerprint:'0'.repeat(64)};
  assert.throws(()=>f.control.command({action:'authorize',operationId:randomUUID(),revision:0,connections:[bad],scope:{sourceIds:null,dataKinds:['text']}}));
  assert.equal(f.control.view().state,'unapproved');f.command('authorize');
  const stop={action:'stop',operationId:randomUUID(),revision:f.control.view().revision};f.control.command(stop);const epoch=f.control.view().epoch;
  f.control.command(stop);assert.equal(f.control.view().epoch,epoch);
  assert.throws(()=>f.control.command({...stop,action:'pause'}));
  assert.throws(()=>f.control.command({action:'authorize',operationId:randomUUID(),revision:0,connections:[f.connection],scope:{sourceIds:null,dataKinds:['text']}}));
  assert.equal(f.control.view().state,'stopped');
});

test('one durable step cannot combine a broad manual authority and a narrow automatic authority',async t=>{
  const f=fixture(t);f.command('authorize');f.receive('input');f.control.automatic('background',['input']);f.control.manual('manual','manual');
  const step:ExecutionStep={id:'generated-step',operationId:'generated-operation',kind:'generated',pool:'generated',input:{},state:'waiting',attempts:0,availableAt:0};
  await f.control.run('manual',async()=>f.control.captureStep(step));
  await f.control.runStep(step,async()=>{
    assert.equal(f.control.currentId,'manual');
    await assert.rejects(f.control.run('background',async()=>{throw Error('must never enter mixed authority');}),/different model authority/);
    assert.equal(f.control.currentId,'manual');
  },new AbortController().signal);
});

test('a shared executor restores only its step authority and prevents stopped late publication',async t=>{
  const f=fixture(t),engine=new ExecutionEngine(f.store);engine.bindModelAuthority(f.control);t.after(()=>engine.close());
  f.command('authorize');f.receive('input');f.control.automatic('background',['input']);f.control.manual('unrelated-owner-request','manual');
  let entered!:()=>void,release!:()=>void,published=false,receivedAbort=false;
  const started=new Promise<void>(r=>entered=r),provider=new Promise<void>(r=>release=r);
  engine.register({kind:'generated-model',pool:'generated-model',concurrency:()=>1,validate:()=>true,
    execute:async(_step,signal)=>{assert.equal(f.control.currentId,'background');f.control.assertCurrent(f.connection);entered();await provider;receivedAbort=signal.aborted;return 'generated';},
    commit:()=>{published=true;}});
  await f.control.run('background',async()=>{engine.enqueue('operation','generated-model',{}, {id:'step'});});
  const running=f.control.run('unrelated-owner-request',async()=>engine.drain(['step']));await started;
  f.command('stop');release();await running;
  assert.equal(receivedAbort,true);assert.equal(published,false);assert.notEqual(engine.get('step')!.state,'succeeded');
});
