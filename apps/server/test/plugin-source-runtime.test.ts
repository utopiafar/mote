import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Plugin} from '@deepseek-ai/cordis';
import {PluginHost} from '@mote/plugin-host';
import {ConfigService} from '../src/config-service.js';
import {ExecutionSettings,executionSettingsSchema} from '../src/execution-settings.js';
import {MaterialStore} from '../src/materials.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {SourceItemRecipeCatalog} from '../src/source-item-recipe.js';
import {materialId} from '../src/materials.js';
import {fixtureMemoryPipeline} from './fixtures/memory-result.js';
import {generatedMemoryOutput} from './fixtures/memory-planning.js';
import {createVaultPlatformAssembly} from '../src/plugins/vault-platform.js';
import {createAuthorizationPlatform} from '../src/plugins/authorization-platform.js';
import {createExecutionPlatform,createExecutionHandlersFactory} from '../src/plugins/execution-platform.js';
import {createSourceRuntime,createSourceRuntimeFactory,sourceRuntimeDeclaration,sourceRuntimeContribution} from '../src/plugins/source-runtime.js';
import {codingSourceDeclaration,createCodingSourceFactory,createCodingSourceRoutes} from '../src/coding-source-plugin.js';

const ownerToken='generated-source-owner',sourceId='generated-coding';
const identity=()=>({packageId:'generated.source-runtime',installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID(),host:{kind:'central' as const,id:'generated-source-host'}});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const event=(id='one')=>({externalId:id,revision:'1',observedAt:'2026-11-03T01:00:00Z',kind:'message',layer:'snapshot',text:'Generated source requirement '+id,document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'generated-session',projectKey:'generated-project',eventId:id,role:'user',attribution:'human',part:0,parts:1}}});
const lowPriority:Plugin={name:'generated-low-priority',inject:['moteSourcePipelines'],apply:context=>{context.effect(()=>context.moteSourcePipelines.register({...context.moteSourcePipelines.get('mote.coding')!,id:'generated.low',priority:-10}));}};
async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-source-runtime-')),config=new ConfigService({path:join(directory,'mote.yaml'),initialDocument:{version:1,revision:0},watch:false});
  config.register({id:'execution',schema:executionSettingsSchema,defaultValue:executionSettingsSchema.parse({})});await config.initialize();const settings=new ExecutionSettings(config);
  const open=async()=>{
    const vault=createVaultPlatformAssembly({dataDir:directory});await vault.prepare();const store=vault.store,materials=new MaterialStore(store),memoryWork=new MaterialMemoryWork(store,materials);
    const authorization=createAuthorizationPlatform({ownerToken},{store,availableModelConnections:()=>[]});await authorization.prepare();
    const execution=createExecutionPlatform({store,settings,modelAuthorization:authorization.assembly.modelAuthorization});await execution.prepare();execution.start();const host=new PluginHost({kind:'central',id:'generated-source-host'});
    const dependencies={store,materials,execution,memoryWork},platform=createSourceRuntime({},dependencies);
    const owner=await host.install({identity:identity(),contributions:[sourceRuntimeDeclaration],factory:createSourceRuntimeFactory(platform)}),runtime=platform.runtimeForAssembly;
    const sources=new SourceStore(store,runtime),files=new FileStore(store,sources);
    const codingOwner=await host.install({identity:identity(),contributions:[codingSourceDeclaration],factory:createCodingSourceFactory({runtime,sources,store},createCodingSourceRoutes(runtime),{plugins:[lowPriority]})});
    authorization.bindRepositories({sources,files,materials,memoryInputs:memoryWork.inputs,memoryWork});await authorization.start();
    return {vault,store,materials,memoryWork,authorization,execution,host,platform,owner,codingOwner,runtime,sources,files,dependencies};
  };
  let current=await open();
  const close=async()=>{await current.host.close();await current.authorization.close();await current.execution.close();await current.files.close();await current.materials.index?.close();await current.vault.close();};
  t.after(async()=>{await close();await config.close();rmSync(directory,{recursive:true,force:true});});
  current.sources.register({id:sourceId,name:'Generated coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});
  return {get state(){return current;},async restart(){await close();current=await open();},
    async receive(items:unknown,source=sourceId){const {authorization}=current,request=authorization.bindRequest({authorization:'Bearer '+ownerToken,method:Array.isArray(items)?'POST':'PUT',route:Array.isArray(items)?'/api/sources/:id/items/batch':'/api/sources/:id/items',params:{id:source}});
      try{if(Array.isArray(items))return await authorization.withSource(request,source,items,()=>authorization.sourceIntake.sourceBatch(source,items,authorization.commits.capture()));return await authorization.withSource(request,source,items,()=>authorization.sourceIntake.sourceItem(source,items,authorization.commits.capture()));}finally{authorization.releaseRequest(request);}},
  };
}

test('persisted low-priority binding wins while fresh sources use default priority and reject ambiguity',async t=>{
  const f=await fixture(t),s=f.state;
  s.runtime.registry.register({...s.runtime.registry.get('mote.coding')!,id:'generated.high',priority:100});
  assert.equal(s.runtime.select(s.sources.getSource(sourceId))?.id,'generated.high');s.runtime.configure(sourceId,{pipelineId:'generated.low',settleSeconds:0});assert.equal(s.runtime.select(s.sources.getSource(sourceId))?.id,'generated.low');
  s.sources.register({id:'generated-unbound',name:'Generated unbound',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});assert.equal(s.runtime.select(s.sources.getSource('generated-unbound'))?.id,'generated.high');
  assert.throws(()=>s.runtime.registry.register({...s.runtime.registry.get('mote.coding')!,id:'generated.conflict',priority:100}),/Ambiguous/);
  await f.receive(event());await s.runtime.tick();assert.equal(s.store.db.prepare('SELECT pipeline_id FROM source_pipeline_work').get()!.pipeline_id,'generated.low');
  await f.restart();assert.equal(f.state.runtime.select(f.state.sources.getSource(sourceId))?.id,'generated.low');assert.equal(f.state.store.db.prepare('SELECT count(*) n FROM source_pipeline_bindings WHERE source_id=?').get(sourceId)!.n,1);
});

test('actual C04 intake receipts flow through recipe checkpoints to MaterialStore and duplicate replay stays immutable after restart',async t=>{
  const f=await fixture(t),s=f.state;let snapshots=0;const snapshot=s.runtime.recipes.snapshot.bind(s.runtime.recipes);
  t.mock.method(s.runtime.recipes,'snapshot',async(...args:Parameters<typeof snapshot>)=>{snapshots++;return snapshot(...args);});
  const raw=[event(),event('two')],first=await f.receive(raw);assert.ok('receipts' in first);assert.equal(first.receipts.length,2);const row=s.store.db.prepare('SELECT archive_checkpoint,recipe_id,recipe_component_pins FROM source_pipeline_work').get()!;
  assert.equal(row.recipe_id,'mote.coding');assert.match(String(row.archive_checkpoint),/^[a-f0-9]{64}$/);assert.ok(JSON.parse(String(row.recipe_component_pins)).length>0);
  await s.runtime.tick();const material=s.materials.list().items[0];assert.ok(material);assert.match(s.materials.read(material.ref,{length:12000}).text,/Generated source requirement one/);assert.equal(snapshots,1);
  const work=s.store.db.prepare('SELECT * FROM source_pipeline_work').all(),models=s.store.db.prepare('SELECT * FROM background_model_receipts').all();
  const repeated=await f.receive(raw);assert.ok('receipts' in repeated);assert.deepEqual(repeated.receipts.map(receipt=>receipt.id),first.receipts.map(receipt=>receipt.id));assert.ok(repeated.receipts.every(receipt=>receipt.duplicate));await s.runtime.tick();assert.equal(snapshots,1);assert.deepEqual(s.store.db.prepare('SELECT * FROM source_pipeline_work').all(),work);assert.deepEqual(s.store.db.prepare('SELECT * FROM background_model_receipts').all(),models);assert.equal(s.store.stats().captures,0);
  await f.restart();const restored=await f.receive(raw);assert.ok('receipts' in restored);assert.deepEqual(restored.receipts.map(receipt=>receipt.id),first.receipts.map(receipt=>receipt.id));assert.ok(restored.receipts.every(receipt=>receipt.duplicate));await f.state.runtime.tick();assert.equal(f.state.materials.list().items[0].ref,material.ref);assert.equal(f.state.store.db.prepare('SELECT archive_checkpoint FROM source_pipeline_work').get()!.archive_checkpoint,row.archive_checkpoint);assert.equal(f.state.store.db.prepare('SELECT count(*) n FROM source_archive_versions').get()!.n,2);
});

test('a bound archive cannot fall through to records when its pipeline is missing or reinstalled with different storage',async t=>{
  const f=await fixture(t),s=f.state,base=s.runtime.registry.get('mote.coding')!,remove=s.runtime.registry.register({...base,id:'generated.switch',priority:100});
  s.runtime.configure(sourceId,{pipelineId:'generated.switch'});await f.receive(event());await s.runtime.tick();const ref=s.materials.list().items[0].ref,checkpoint=s.store.db.prepare('SELECT archive_checkpoint FROM source_pipeline_work').get()!.archive_checkpoint;
  remove();await assert.rejects(f.receive(event('missing')),{statusCode:409});assert.throws(()=>s.runtime.selectionForRead(s.sources.getSource(sourceId)),{statusCode:409});assert.equal(s.runtime.memoryAllowed(sourceId),false);
  s.runtime.registry.register({...base,id:'generated.switch',priority:100,storage:'records',recipe:undefined});await assert.rejects(f.receive(event('mismatch')),{statusCode:409});assert.throws(()=>s.runtime.configure(sourceId,{pipelineId:'generated.switch'}),{statusCode:409});
  assert.equal(s.runtime.memoryAllowed(sourceId),false);assert.throws(()=>s.runtime.selectionForRead(s.sources.getSource(sourceId)),{statusCode:409});
  assert.equal(s.store.stats().captures,0);assert.equal(s.store.db.prepare('SELECT count(*) n FROM source_archive_versions').get()!.n,1);assert.equal(s.store.db.prepare('SELECT archive_checkpoint FROM source_pipeline_work').get()!.archive_checkpoint,checkpoint);assert.equal(s.materials.list().items[0].ref,ref);
});

for(const mode of ['quiesce','stop'] as const)test(`H04 source ${mode} refuses receipts, keeps archive and fences only the stopped epoch`,async t=>{
  const f=await fixture(t),s=f.state,started=deferred(),release=deferred(),snapshot=s.runtime.recipes.snapshot.bind(s.runtime.recipes);let otherCommits=0;
  // A genuine recipe reader result is paused before its original scope resumes.
  t.mock.method(s.runtime.recipes,'snapshot',async(...args:Parameters<typeof snapshot>)=>{const result=await snapshot(...args);started.resolve();await release.promise;return result;});
  t.after(()=>release.resolve());await f.receive(event());const checkpoint=s.store.db.prepare('SELECT archive_checkpoint FROM source_pipeline_work').get()!.archive_checkpoint,epoch=s.runtime.registry.epochs.get('mote.coding'),run=s.runtime.tick();await started.promise;
  let closing:Promise<void>|undefined;if(mode==='stop')closing=s.owner.close('disabled');else await s.owner.quiesce('upgrade');
  try{
    await assert.rejects(f.receive(event('late')),{statusCode:409});assert.equal(s.runtime.memoryAllowed(sourceId),mode==='quiesce');if(mode==='stop')assert.throws(()=>s.runtime.selectionForRead(s.sources.getSource(sourceId)),{statusCode:409});else assert.equal(s.runtime.selectionForRead(s.sources.getSource(sourceId))?.id,'mote.coding');
    await s.host.install({identity:identity(),contributions:[{id:'generated-other-handler',apiVersion:'1'}],factory:createExecutionHandlersFactory(s.execution,[{kind:'generated.other',pool:'generated.other',concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{otherCommits++;}}])});
    const id=s.execution.submission.enqueue('generated:other','generated.other',{});await s.execution.submission.drain([id]);assert.equal(otherCommits,1);assert.equal(s.execution.assembly.executor.closed,false);
  }finally{release.resolve();}
  await run;await closing;assert.equal(s.materials.list().items.length,mode==='stop'?0:1);assert.equal(s.store.db.prepare('SELECT archive_checkpoint FROM source_pipeline_work').get()!.archive_checkpoint,checkpoint);assert.equal(s.store.db.prepare('SELECT count(*) n FROM source_archive_versions').get()!.n,1);
  await f.restart();assert.notEqual(f.state.runtime.registry.epochs.get('mote.coding'),epoch);await f.state.runtime.tick();assert.equal(f.state.materials.list().items.length,1);assert.equal(f.state.store.db.prepare('SELECT state FROM source_pipeline_work').get()!.state,'complete');
});

test('failed H04 source initialization releases scoped registration and keeps borrowed execution and archive usable',async t=>{
  const f=await fixture(t),s=f.state;await f.receive(event());await s.codingOwner.close('restart');await s.owner.close('restart');
  const fail:Plugin=()=>{throw new Error('Generated recipe install failure');};
  const bad=createSourceRuntime({plugins:[fail]},s.dependencies);
  await assert.rejects(s.host.install({identity:identity(),contributions:[sourceRuntimeDeclaration],factory:createSourceRuntimeFactory(bad)}),/Generated recipe install failure/);
  assert.equal(s.store.db.isOpen,true);assert.equal(s.execution.assembly.executor.closed,false);assert.equal(s.store.db.prepare('SELECT count(*) n FROM source_archive_versions').get()!.n,1);assert.deepEqual(sourceRuntimeContribution.provides,[]);
  const restored=createSourceRuntime({},s.dependencies),handle=await s.host.install({identity:identity(),contributions:[sourceRuntimeDeclaration],factory:createSourceRuntimeFactory(restored)}),runtime=restored.runtimeForAssembly;s.sources.pipelines=runtime;
  const coding=await s.host.install({identity:identity(),contributions:[codingSourceDeclaration],factory:createCodingSourceFactory({runtime,sources:s.sources,store:s.store},createCodingSourceRoutes(runtime))});
  await runtime.tick();assert.equal(s.materials.list().items.length,1);await coding.close('disabled');await handle.close('disabled');assert.equal(s.store.db.isOpen,true);
});


for(const storage of ['archive','records'] as const)for(const revoke of [false,true])test(`accepted ${storage} Memory ${revoke?'still rejects actual revocation':'survives source quiesce and restart without replay'}`,async t=>{
  const f=await fixture(t),s=f.state,source=storage==='archive'?sourceId:'generated-records';
  const recordsMaterial=async(id:string)=>{
    s.sources.register({id,name:'Generated records',kind:'custom',deviceId:'generated-device',platform:'import'});
    const receipt=await f.receive({...event(),document:undefined,layer:'original'},id);assert.ok('id' in receipt);
    const material=s.materials.publish({id:materialId(id,'one'),kind:'mote.file',schemaVersion:1,title:'Generated records Material',origin:{sourceId:id,externalId:'one'},
      blocks:[{id:'body',kind:'text',format:'plain',text:'Generated source requirement one',memberIds:['original']}],members:[{id:'original',kind:'capture',ref:'capture:'+receipt.id}],
      coverage:{state:'complete'},artifacts:[{key:'source-body',state:'ready'}],fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
    s.memoryWork.observe(material.id,['source-body'],{inputKey:receipt.id,change:'source'});return material;
  };
  if(storage==='archive'){s.runtime.configure(source,{settleSeconds:0});await f.receive(event());await s.runtime.tick();}
  else await recordsMaterial(source);
  s.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();
  const entered=deferred(),release=deferred();let calls=0;
  const reader=new EvidenceReader(s.store,s.sources,s.files,undefined,undefined,s.materials,s.runtime,new SourceItemRecipeCatalog(s.store,'1'),ref=>s.memoryWork.readyForMemory(ref));
  let pipeline=fixtureMemoryPipeline({store:s.store,executor:s.execution.assembly.executor,memories:reader.memories,models:{model:()=> 'generated-memory-model',configured:()=>true},
    admission:{materialInput:(ref,required)=>s.materials.input(ref,required),materialRequirements:ref=>s.memoryWork.sourceRequirements(ref),materialAllowedForMemory:(ref,_profile,required)=>reader.materialAllowedForMemory(ref,undefined,required),
      automaticAllowed:job=>s.memoryWork.authorized(job)&&(job.automaticGrants??(job.automaticGrant?[job.automaticGrant]:[])).every(grant=>s.runtime.memoryAllowed(grant.sourceId))},
    phases:{review:async(_input,draft)=>draft,query:async input=>{calls++;entered.resolve();await release.promise;const id=input.evidenceIds[0];return {answer:generatedMemoryOutput(input,[{title:'Generated source conclusion',statement:`Generated requirement [${id}]`,uncertainty:'Generated fixture only',evidenceIds:[id],...(storage==='archive'?{coding:{kind:'decision',scope:'session',applicability:'Generated fixture session',validation:'user_confirmed'}}:{})}]),citations:[{id,capturedAt:reader.memories.readEvidence([id])[0].capturedAt,appName:'Generated source',excerpt:''}],trace:[],runId:'generated-source-memory'};}}});
  // The only simulated boundary is the external model response; all admission,
  // claims, execution, evidence validation and completion transactions are real.
  t.after(async()=>{release.resolve();await pipeline.close();});
  assert.equal(await s.runtime.drainMemory(pipeline,true),1);await entered.promise;
  const job=pipeline.list()[0],grants=job.automaticGrants;assert.ok(grants?.length);assert.equal(s.memoryWork.authorized(job),true);
  const fresh=await recordsMaterial('generated-fresh-memory');s.store.db.prepare('UPDATE material_memory_requests SET ready_at=0').run();
  await s.owner.quiesce('upgrade');
  assert.equal(await s.runtime.drainMemory(pipeline,true),0,'quiesce fences fresh Memory admission');assert.equal(pipeline.list().length,1);assert.equal(s.store.db.prepare('SELECT job_id FROM material_memory_requests WHERE material_id=?').get(fresh.id)!.job_id,null);
  if(revoke)s.memoryWork.inputs.forgetSource(source);
  release.resolve();const completed=await pipeline.run(job.id);
  if(revoke){assert.notEqual(completed.status,'completed');assert.equal(reader.memories.count(),0);assert.equal(s.memoryWork.authorized(job),false);}
  else{
    assert.equal(completed.status,'completed',JSON.stringify(completed.failureReceipt));assert.equal(reader.memories.count(),1);assert.equal(calls,1);assert.equal(s.memoryWork.authorized(job),true);
    assert.deepEqual(completed.automaticGrants,grants);await pipeline.close();await f.restart();
    const next=f.state,nextReader=new EvidenceReader(next.store,next.sources,next.files,undefined,undefined,next.materials);
    pipeline=fixtureMemoryPipeline({store:next.store,executor:next.execution.assembly.executor,memories:nextReader.memories,models:{model:()=> 'generated-memory-model',configured:()=>true},phases:{query:async()=>{throw Error('Completed Memory must not be replayed');}}});
    assert.equal((await pipeline.run(job.id)).status,'completed');assert.equal(nextReader.memories.count(),1);assert.equal(calls,1);
  }
});
