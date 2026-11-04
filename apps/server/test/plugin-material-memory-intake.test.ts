import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PluginHost} from '@mote/plugin-host';
import sharp from 'sharp';
import type {CaptureInput} from '@mote/shared';
import {Store} from '../src/store.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {SourceStore} from '../src/sources.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {screenImageSource} from '../src/image-inputs.js';
import {sha256} from '../src/store.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {centralServices} from '../src/plugins/central-contracts.js';
import {createMaterialMemoryIntake,createMaterialMemoryIntakeFactory,materialMemoryIntakeDeclaration,type MaterialMemoryIntakeBindings} from '../src/plugins/material-memory-intake.js';
import type {MaterialMemoryRunner,MemoryWorkCandidate} from '../src/material-memory-work.js';
import type {MemoryInputSelection} from '../src/evidence-read-ports.js';

const sourceId='generated-memory-intake-source',externalId='generated-item',body='Generated source item body with a retained decision.';
const codingEvent=(id='one')=>({externalId:id,revision:'1',observedAt:'2026-11-03T01:00:00Z',kind:'message',layer:'snapshot',text:'Generated source requirement '+id,
  document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'generated-session',projectKey:'generated-project',eventId:id,role:'user',attribution:'human',part:0,parts:1}}});

function fakeRunner(){
  const jobs=new Map<string,{id:string;status:string;errorCode?:string}>(),byOrigin=new Map<string,string>(),created:Parameters<MaterialMemoryRunner['create']>[0][]=[],ran:string[]=[],cancelled:string[]=[];
  const runner:MaterialMemoryRunner={
    create:input=>{let id=byOrigin.get(input.originKey);if(!id){id=`memory-${byOrigin.size+1}`;byOrigin.set(input.originKey,id);jobs.set(id,{id,status:'queued'});created.push(input);}return {id};},
    get:id=>{const job=jobs.get(id);if(!job)throw Error('Missing generated Memory job');return job;},
    run:async id=>{ran.push(id);},
    cancel:id=>{cancelled.push(id);const job=jobs.get(id);if(job)job.status='cancelled';},
  };
  return {runner,jobs,created,ran,cancelled};
}

function profile(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-material-memory-intake-')),host=new PluginHost({kind:'central',id:'generated-material-memory-intake-host'});
  let store=new Store(directory);
  t.after(async()=>{await host.close();if(store.db.isOpen)store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,host,get store(){return store;},reopen(){store.close();store=new Store(directory);return store;}};
}

async function install(host:PluginHost,store:Store,materials:MaterialStore,captureOriginal?:(input:CaptureInput)=>void){
  const platform=createMaterialMemoryIntake({store,materials,...(captureOriginal?{captureOriginal}:{})});let bindings:MaterialMemoryIntakeBindings|undefined;
  const handle=await host.install({
    identity:{host:host.identity,packageId:'generated.material-memory-intake',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID()},
    contributions:[materialMemoryIntakeDeclaration],factory:createMaterialMemoryIntakeFactory(platform,value=>{bindings=value;}),
  });
  const candidateLease=await host.acquire(centralServices.memoryCandidates,bindings!.memoryCandidates);
  const selectionLease=await host.acquire(centralServices.memoryInputSelection,bindings!.memoryInputSelection);
  return {platform,handle,candidates:candidateLease.value,selection:selectionLease.value,work:platform.workForAssembly,
    async close(){await candidateLease.release();await selectionLease.release();await handle.close('disabled');}};
}

function draft(text=body):MaterialDraft{
  return {id:materialId(sourceId,externalId),kind:'mote.message',schemaVersion:1,title:'Generated item',origin:{sourceId,externalId},
    blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['original']}],members:[{id:'original',kind:'archive',ref:'archive:generated'}],
    coverage:{state:'complete'},artifacts:[{key:'source-body',state:'ready'}],fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
}

test('a real SourcePipeline output enters the ledger and the planner consumes the same required pin',async t=>{
  const f=profile(t);
  const open=async()=>{
    const materials=new MaterialStore(f.store),engine=new ExecutionEngine(f.store),entry=await install(f.host,f.store,materials);
    const runtime=new SourcePipelineRuntime(f.store,materials,[codingSourcePlugin],undefined,engine,entry.work);
    runtime.quiesce();await runtime.ready;runtime.start();
    const sources=new SourceStore(f.store,runtime);sources.register({id:'generated-coding',name:'Generated coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});
    runtime.configure('generated-coding',{settleSeconds:0});
    return {materials,engine,entry,runtime,sources,fake:fakeRunner()};
  };
  let current=await open(),closed=false;
  const close=async()=>{if(closed)return;closed=true;await current.runtime.close();await current.entry.close();await current.engine.close();};
  t.after(close);
  await current.sources.upsert('generated-coding',codingEvent('one'));
  await current.runtime.tick();
  const material=current.materials.list().items[0];assert.ok(material);
  assert.deepEqual(current.entry.work.sourceRequirements(material.ref),['conversation']);
  const candidate=current.entry.work.catalog()[0];assert.ok(candidate);
  const selected=current.materials.input(candidate.ref,['conversation']);assert.ok(selected?.ready);
  assert.equal(candidate.fingerprint,selected.fingerprint);
  assert.deepEqual(current.entry.work.planningInput(candidate).evidenceIds,selected.evidenceIds);
  let planned:MemoryWorkCandidate[]=[];
  assert.equal(await current.entry.work.drainPlanned(current.fake.runner,true,async catalog=>{planned=catalog;return [{members:[catalog[0].key],goal:'Inspect one generated source range',instruction:'Preserve the exact original identity'}];}),1);
  assert.equal(planned[0]?.fingerprint,selected.fingerprint);
  assert.deepEqual(current.fake.created[0]?.evidenceIds,selected.evidenceIds);
  assert.equal(current.fake.created[0]?.workPackage?.inputs?.[0]?.fingerprint,selected.fingerprint);
  assert.equal(current.fake.created[0]?.workPackage?.inputs?.[0]?.inputKey,f.store.db.prepare('SELECT archive_checkpoint FROM source_pipeline_work').get()!.archive_checkpoint);
  assert.equal(current.entry.work.authorized({id:'memory-1',automaticGrants:current.fake.created[0]?.automaticGrants}),true);
  current.fake.jobs.get('memory-1')!.status='completed';

  await close();f.store.close();f.reopen();
  current=await open();closed=false;
  const replay=fakeRunner();replay.jobs.set('memory-1',{id:'memory-1',status:'completed'});
  await current.sources.upsert('generated-coding',codingEvent('one'));
  await current.runtime.tick();
  assert.equal(await current.entry.work.drain(replay.runner,true),0);
  assert.equal(replay.created.length,0,'a replayed confirmed checkpoint must not create another Memory job');
  assert.equal(replay.ran.length,0);
  assert.equal(f.store.db.prepare('SELECT job_id FROM material_memory_requests').get()!.job_id,'memory-1');

  current.runtime.forget('generated-coding');
  assert.equal(current.entry.work.catalog().length,0);
  assert.throws(()=>current.entry.work.planningInput(candidate),{statusCode:409});
});

test('real material organizer output enters the ledger; revision and late planner results cannot create work',async t=>{
  const f=profile(t),materials=new MaterialStore(f.store),engine=new ExecutionEngine(f.store),entry=await install(f.host,f.store,materials);
  const fake=fakeRunner();
  const sources=new SourceStore(f.store,undefined,entry.work.inputs),organizers=new MaterialOrganizerRuntime(f.store,materials,[],engine,entry.work);
  t.after(async()=>{await organizers.close();await entry.close();await engine.close();});
  sources.register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import',retention:'archive'});
  const item={externalId,revision:'1',observedAt:'2026-09-20T00:00:00Z',kind:'message' as const,layer:'original' as const,text:body};
  await sources.upsert(sourceId,item);await organizers.tick();
  const material=materials.get(materialId(sourceId,externalId));assert.ok(material);
  assert.deepEqual(entry.work.sourceRequirements(material.ref),['source-body']);
  const candidate=entry.work.catalog()[0];assert.ok(candidate);
  const selected=materials.input(candidate.ref,['source-body']);assert.ok(selected?.ready);
  assert.equal(candidate.fingerprint,selected.fingerprint);
  assert.equal(entry.work.planningInput(candidate).evidenceIds.length,selected.evidenceIds.length);
  let planned:MemoryWorkCandidate[]=[];
  assert.equal(await entry.work.drainPlanned(fake.runner,true,async catalog=>{planned=catalog;return [{members:[catalog[0].key],goal:'Inspect one generated processed range',instruction:'Preserve the declared source output'}];}),1);
  assert.equal(planned[0]?.fingerprint,selected.fingerprint);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fake.created.length,1);

  await sources.upsert(sourceId,{...item,revision:'2',observedAt:'2026-09-20T00:00:01Z',text:body+' Revised.'});await organizers.tick();
  const revised=materials.get(material.id)!;assert.notEqual(revised.revision,material.revision);
  assert.throws(()=>entry.work.planningInput(candidate),{statusCode:409},'an old revision pin is rejected');
  assert.equal(entry.work.authorized({id:'memory-1',automaticGrants:[{sourceId:candidate.sourceId,inputKey:candidate.inputKey,scope:candidate.scope}]}),false);
  const current=entry.work.catalog()[0];assert.ok(current);
  assert.equal(await entry.work.drainPlanned(fake.runner,true,async catalog=>{
    entry.candidates.withdraw(current.materialId);
    return [{members:[catalog[0].key],goal:'Inspect a withdrawn range',instruction:'This late result must not enqueue work'}];
  }),0);
  assert.equal(fake.created.length,1,'a planner result returned after withdrawal creates no new job');

  await sources.upsert(sourceId,{...item,revision:'3',observedAt:'2026-09-20T00:00:02Z',deleted:true,text:''});await organizers.tick();
  assert.equal(materials.get(material.id),undefined);
  assert.equal(entry.work.catalog().length,0);
  assert.throws(()=>entry.work.planningInput(current),{statusCode:409});
});

test('quiesce fences new observations, stop withdraws capture intake, and restart reads the persisted ledger',async t=>{
  const f=profile(t);
  let materials=new MaterialStore(f.store),entry=await install(f.host,f.store,materials);
  new SourceStore(f.store).register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});
  const material=materials.publish(draft());
  f.store.db.exec('BEGIN IMMEDIATE');try{entry.work.inputs.receive({sourceId,inputKey:'generated-raw'});f.store.db.exec('COMMIT');}catch(error){f.store.db.exec('ROLLBACK');throw error;}
  entry.candidates.observe(material.id,['source-body'],{inputKey:'generated-raw',change:'source'});
  const selection:MemoryInputSelection={
    memoryPlanSelection:()=>({manualPlans:[],evidenceIds:['generated-plan'],unavailable:[]}),
    memorySelection:()=>({evidenceIds:['generated-selection'],waiting:[],unavailable:[]}),
  };
  entry.platform.bindSelection(selection);
  assert.deepEqual(entry.selection.memorySelection(),{evidenceIds:['generated-selection'],waiting:[],unavailable:[]});
  await entry.handle.quiesce('upgrade');
  assert.throws(()=>entry.candidates.observe(material.id,['source-body'],{inputKey:'generated-raw',change:'source'}),{statusCode:503});
  entry.candidates.withdraw(material.id);
  assert.equal(entry.work.catalog().length,0);
  const first=material;
  await entry.close();

  materials=new MaterialStore(f.store);entry=await install(f.host,f.store,materials);
  f.store.db.exec('BEGIN IMMEDIATE');try{entry.work.inputs.receive({sourceId,inputKey:'generated-restart'});f.store.db.exec('COMMIT');}catch(error){f.store.db.exec('ROLLBACK');throw error;}
  entry.candidates.observe(first.id,['source-body'],{inputKey:'generated-restart',change:'source'});
  assert.deepEqual(entry.work.sourceRequirements(first.ref),['source-body']);
  assert.equal(entry.work.catalog().length,1);
  await entry.close();

  f.store.close();f.reopen();
  materials=new MaterialStore(f.store);entry=await install(f.host,f.store,materials);
  t.after(()=>entry.close());
  assert.deepEqual(entry.work.sourceRequirements(first.ref),['source-body']);
  assert.equal(entry.work.catalog().length,1,'the persisted ledger survives a process restart');
  assert.equal(entry.work.catalog()[0]?.fingerprint,materials.input(first.ref,['source-body'])?.fingerprint);
});

test('failed prepare releases the ledger transaction and restores the context observer',async t=>{
  const f=profile(t),materials=new MaterialStore(f.store),prior=materials.onContextChanged,exec=f.store.db.exec.bind(f.store.db);let fail=true;
  t.mock.method(f.store.db,'exec',(sql:string,...args:unknown[])=>{
    if(fail&&sql.includes('CREATE TABLE IF NOT EXISTS material_memory_requests'))throw Error('Generated intake prepare failure');
    return exec(sql,...args as []);
  });
  await assert.rejects(install(f.host,f.store,materials),/Generated intake prepare failure/);
  assert.equal(f.store.db.isOpen,true);
  assert.equal(f.store.db.isTransaction,false);
  assert.equal(materials.onContextChanged,prior);
  fail=false;
  const entry=await install(f.host,f.store,materials);t.after(()=>entry.close());
  new SourceStore(f.store).register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});
  const material=materials.publish(draft());
  f.store.db.exec('BEGIN IMMEDIATE');try{entry.work.inputs.receive({sourceId,inputKey:'generated-recovered'});f.store.db.exec('COMMIT');}catch(error){if(f.store.db.isTransaction)f.store.db.exec('ROLLBACK');throw error;}
  entry.candidates.observe(material.id,['source-body'],{inputKey:'generated-recovered',change:'source'});
  assert.equal(entry.work.catalog().length,1);
});

test('the owner installs and removes the single capture receipt observer',async t=>{
  const f=profile(t),materials=new MaterialStore(f.store),seen:CaptureInput[]=[];
  const entry=await install(f.host,f.store,materials,input=>seen.push(input));
  t.after(()=>entry.close());
  assert.equal(typeof f.store.captureInputReceived,'function');
  const bytes=await sharp({create:{width:8,height:8,channels:3,background:'#aabbcc'}}).png().toBuffer();
  const input:CaptureInput={id:randomUUID(),deviceId:'generated-device',deviceName:'Generated device',platform:'macos',capturedAt:'2026-09-20T00:00:00.000Z',durationMs:0,source:'screen',imageMime:'image/png',imageBase64:bytes.toString('base64'),ocrText:'Generated screen text'};
  await f.store.ingest(input);
  assert.deepEqual(seen.map(item=>item.id),[input.id]);
  const sourceId=screenImageSource(input.deviceId,sha256);
  assert.deepEqual(entry.work.inputs.list(sourceId,input.id).map(grant=>grant.authorized),[true]);
  await entry.handle.quiesce('upgrade');
  assert.equal(f.store.captureInputReceived,undefined);
});
