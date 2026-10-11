import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryInputAuthorization} from '../src/memory-input-authorization.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {MemoryLifecycle} from '../src/memory-lifecycle.js';

function fixture(t:import('node:test').TestContext){const directory=mkdtempSync(join(tmpdir(),'mote-automation-')),store=new Store(directory);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return store;}
const command=(control:MemoryAutomation)=>({expectedRevision:control.state().revision,operationId:randomUUID()});

test('real source receipts survive ordinary pause; denied gap never acquires permission on resume, duplicate delivery or restart',async t=>{
  const store=fixture(t);let control=new MemoryAutomation(store);
  const grants=new MemoryInputAuthorization(store,()=>control.accepting()),sources=new SourceStore(store,undefined,grants);
  sources.register({id:'fixture',name:'Generated',kind:'custom',deviceId:'fixture',platform:'import'});
  const receive=(externalId:string)=>sources.upsert('fixture',{externalId,revision:'1',observedAt:'2020-01-01T00:00:00Z',text:'Generated original '+externalId,kind:'message',layer:'original'});
  const old=await receive('before-pause');control.counts=()=>({queued:1,running:0,checkpointed:0,resultUnknown:0});
  const pause=command(control);assert.equal(control.command('pause',pause).state,'draining');assert.equal(grants.available('fixture',old.id),true);
  const gap=await receive('during-pause');assert.equal(grants.available('fixture',gap.id),false);
  control=new MemoryAutomation(store);assert.equal(control.accepting(),false);
  control.command('resume',command(control));assert.equal(control.state().generation,2);
  assert.equal(grants.available('fixture',gap.id),false);assert.equal((await receive('during-pause')).id,gap.id);assert.equal(grants.available('fixture',gap.id),false);
  const next=await receive('after-resume');assert.equal(grants.available('fixture',next.id),true);
  control.onStop=()=>{store.db.prepare('UPDATE memory_input_authorizations SET revoked_at=1 WHERE authorized=1 AND revoked_at IS NULL').run();};
  control.command('stop',command(control));assert.equal(grants.available('fixture',old.id),false);assert.equal(grants.available('fixture',next.id),false);
});

test('command retry is idempotent, stale revisions and reused intent IDs cannot change admission, and failed stop rolls back',t=>{
  const control=new MemoryAutomation(fixture(t)),pause=command(control);
  control.command('pause',pause);const revision=control.state().revision;
  control.command('pause',pause);assert.equal(control.state().revision,revision);
  assert.throws(()=>control.command('resume',pause),/identity conflict/);
  assert.throws(()=>control.command('resume',{...command(control),expectedRevision:1}),/changed/);
  control.command('resume',command(control));control.onStop=()=>{throw Error('Generated failure');};
  assert.throws(()=>control.command('stop',command(control)),/Generated failure/);assert.equal(control.accepting(),true);
});

test('paused integration drains an admitted window, resume skips the gap without resetting the frozen task, independent lanes continue',async t=>{
  const store=fixture(t),control=new MemoryAutomation(store);const lifecycle=new MemoryLifecycle(store,()=>true);
  t.after(()=>lifecycle.close());lifecycle.automaticAdmission=id=>!['extraction','consolidation'].includes(id)||control.accepting();control.onResume=()=>lifecycle.skipAutomaticBacklog();
  let calls=0,working=0,release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  lifecycle.register({id:'consolidation',version:'fixture',stream:'memory',async run(){calls++;if(calls===1){entered();await new Promise<void>(r=>release=r);}}});
  lifecycle.register({id:'working',version:'fixture',stream:'conversation',async run(){working++;}});
  lifecycle.configure({...lifecycle.settings(),consolidation:{...lifecycle.settings().consolidation,minChanges:1},working:{...lifecycle.settings().working,minChanges:1}});
  const event=(stream:string)=>store.db.prepare('INSERT INTO memory_events(stream,entity) VALUES(?,?)').run(stream,randomUUID());
  event('memory');const draining=lifecycle.tick();await ready;control.command('pause',command(control));event('memory');event('conversation');
  control.command('resume',command(control));release();await draining;
  await lifecycle.tick();assert.equal(calls,1,'resume did not create integration for the paused gap');assert.equal(working,1,'independent working lane is preserved');
  event('memory');await lifecycle.tick();assert.equal(calls,2,'later authorized increment is handled');
});
