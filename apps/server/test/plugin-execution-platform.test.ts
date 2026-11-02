import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProviderFailure} from '@mote/shared';
import {PluginHost} from '@mote/plugin-host';
import {ConfigService} from '../src/config-service.js';
import {ExecutionSettings,executionSettingsSchema} from '../src/execution-settings.js';
import {ExecutionFailure,type ExecutionHandler,type ExecutionGrant} from '../src/execution-engine.js';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';
import {modelConnection} from '../src/background-model-authorization.js';
import {MaterialStore} from '../src/materials.js';
import {SourceStore} from '../src/sources.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {createVaultPlatformAssembly} from '../src/plugins/vault-platform.js';
import {createAuthorizationPlatform} from '../src/plugins/authorization-platform.js';
import {centralServices} from '../src/plugins/central-contracts.js';
import {createExecutionPlatform,createExecutionHandlersFactory,createExecutionPlatformFactory,executionPlatformContribution,executionPlatformDeclaration} from '../src/plugins/execution-platform.js';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const identity=(id:string)=>({packageId:'generated.'+id,installationId:randomUUID(),instanceId:randomUUID(),activationId:randomUUID(),host:{kind:'central' as const,id:'generated-execution-host'}});
const base:ExecutionHandler={kind:'generated.execution',pool:'generated.execution',policy:EXECUTION_POLICIES.localProcessing,concurrency:()=>1,validate:()=>true,execute:async step=>step.id,commit:()=>{}};
async function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-execution-platform-'));
  const config=new ConfigService({path:join(directory,'mote.yaml'),initialDocument:{version:1,revision:0},watch:false});
  config.register({id:'execution',schema:executionSettingsSchema,defaultValue:executionSettingsSchema.parse({})});await config.initialize();const settings=new ExecutionSettings(config);
  const model=modelConnection('generated-model',{model:'generated',apiKey:'generated-only'}),dependents:(()=>Promise<unknown>)[]=[];
  let now=Date.now(),vault=createVaultPlatformAssembly({dataDir:directory});await vault.prepare();
  let authorization=createAuthorizationPlatform({ownerToken:'generated-execution-owner'},{store:vault.store,availableModelConnections:()=>[model]});await authorization.prepare();
  let platform=createExecutionPlatform({store:vault.store,settings,modelAuthorization:authorization.assembly.modelAuthorization,clock:()=>now});await platform.prepare();platform.start();
  let host=new PluginHost({kind:'central',id:'generated-execution-host'});
  const install=(handlers:readonly ExecutionHandler[])=>host.install({identity:identity('handlers'),contributions:[{id:'generated-handlers',apiVersion:'1'}],factory:createExecutionHandlersFactory(platform,handlers)});
  t.after(async()=>{for(const close of dependents.reverse())await close();await host.close();await platform.close();await authorization.close();await config.close();await vault.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,config,settings,model,install,beforeClose(close:()=>Promise<unknown>){dependents.push(close);},get platform(){return platform;},get host(){return host;},get authorization(){return authorization;},get store(){return vault.store;},advance(ms:number){now+=ms;},
    async restart(){await host.close();await platform.close();await authorization.close();await vault.close();vault=createVaultPlatformAssembly({dataDir:directory});await vault.prepare();authorization=createAuthorizationPlatform({ownerToken:'generated-execution-owner'},{store:vault.store,availableModelConnections:()=>[model]});await authorization.prepare();platform=createExecutionPlatform({store:vault.store,settings,modelAuthorization:authorization.assembly.modelAuthorization,clock:()=>now});await platform.prepare();platform.start();host=new PluginHost({kind:'central',id:'generated-execution-host'});},
  };
}

test('real vault restart retains retry receipts and commits one immutable operation only once',async t=>{
  const f=await fixture(t);f.store.db.exec('CREATE TABLE generated_execution_outputs(id TEXT PRIMARY KEY,value TEXT NOT NULL)');let calls=0;
  const handler:ExecutionHandler={...base,execute:async step=>{calls++;if(calls===1)throw new ExecutionFailure('transient','generated_retry',2000);return step.input.value;},commit:(step,value)=>{f.store.db.prepare('INSERT INTO generated_execution_outputs VALUES(?,?)').run(step.id,String(value));}};
  await f.install([handler]);const input={value:'Generated durable result',pin:{revision:1}},id=f.platform.submission.enqueue('generated:restart',handler.kind,input);
  await f.platform.submission.drain([id]);assert.equal(f.platform.receipt(id).step?.state,'waiting');assert.equal(f.platform.receipt(id).failure?.code,'generated_retry');const deadline=f.platform.receipt(id).step!.availableAt;
  await f.restart();await f.install([handler]);assert.equal(f.platform.submission.enqueue('generated:restart',handler.kind,input),id);assert.equal(f.platform.receipt(id).step?.availableAt,deadline);
  await f.platform.submission.drain([id]);assert.equal(calls,1);f.advance(2001);await f.platform.submission.drain([id]);
  assert.equal(f.platform.receipt(id).step?.state,'succeeded');assert.equal(calls,2);
  assert.equal(f.platform.submission.enqueue('generated:restart',handler.kind,input),id);await f.platform.submission.drain([id]);assert.equal(calls,2);
  assert.deepEqual(f.store.db.prepare('SELECT value FROM generated_execution_outputs').all().map(row=>row.value),[input.value]);
  assert.equal(f.platform.assembly.operations.detail('generated:restart').operation.state,'succeeded');
  await f.restart();await f.install([handler]);await f.platform.submission.drain([id]);assert.equal(calls,2);assert.equal(f.platform.receipt(id).step?.state,'succeeded');
});

test('restored jobs retain real C04 model grants and fail closed after an explicit epoch stop',async t=>{
  const f=await fixture(t),control=f.authorization.assembly.modelAuthorization,connection=f.model;let calls=0;
  const handler={...base,execute:async()=>{calls++;return null;}};await f.install([handler]);
  control.command({action:'authorize',revision:0,operationId:randomUUID(),connections:[connection],scope:{sourceIds:['generated-source'],dataKinds:['text']}});
  f.store.db.exec('BEGIN IMMEDIATE');control.receive('generated-original',{sourceId:'generated-source',dataKind:'text'});f.store.db.exec('COMMIT');control.automatic('generated-authorized-work',['generated-original'],'working');
  const id=await control.run('generated-authorized-work',async()=>f.platform.submission.enqueue('generated:grant',handler.kind,{revision:1}));
  control.command({action:'stop',revision:control.view().revision,operationId:randomUUID()});await f.restart();await f.install([handler]);await f.platform.submission.drain([id]);
  assert.equal(calls,0);assert.equal(f.platform.receipt(id).step?.state,'waiting');assert.equal(f.platform.receipt(id).step?.attempts,0);assert.equal(f.platform.receipt(id).failure?.code,'background_model_authorization_required');
});

test('scope handler removal fences late grants, preserves recoverable work and lets another pool advance',async t=>{
  const f=await fixture(t),started=deferred(),release=deferred();let grant!:ExecutionGrant,signal!:AbortSignal,commits=0;
  t.after(()=>release.resolve());f.store.db.exec('CREATE TABLE generated_late_commits(value TEXT)');
  const handler={...base,execute:async(_step:Parameters<ExecutionHandler['execute']>[0],current:AbortSignal,currentGrant:ExecutionGrant)=>{signal=current;grant=currentGrant;started.resolve();await release.promise;return 'generated late';},commit:()=>{commits++;}};
  const owner=await f.install([handler]);const id=f.platform.submission.enqueue('generated:inflight',handler.kind,{}),queued=f.platform.submission.enqueue('generated:queued',handler.kind,{}),run=f.platform.submission.drain([id]);await started.promise;
  await f.install([{...base,kind:'generated.other',pool:'generated.other',commit:()=>{commits++;}}]);const other=f.platform.submission.enqueue('generated:other','generated.other',{});await f.platform.submission.drain([other]);assert.equal(f.platform.receipt(other).step?.state,'succeeded');
  await owner.close('revoked');await run;assert.equal(signal.aborted,true);assert.equal(f.platform.receipt(id).step?.state,'waiting');assert.equal(f.platform.receipt(queued).step?.state,'waiting');
  assert.throws(()=>f.platform.submission.enqueue('generated:late',handler.kind,{}));assert.throws(()=>grant.commit(()=>f.store.db.prepare('INSERT INTO generated_late_commits VALUES(?)').run('forbidden')));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM generated_late_commits').get()!.n,0);release.resolve();await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(commits,1);
  await f.install([{...base,commit:()=>{commits++;}}]);await f.platform.submission.drain([id,queued]);assert.equal(f.platform.receipt(id).step?.state,'succeeded');assert.equal(f.platform.receipt(queued).step?.state,'succeeded');assert.equal(commits,3);
});

test('quiesce refuses new work but lets an accepted lease commit without starting the backlog',async t=>{
  const f=await fixture(t),started=deferred(),release=deferred();let calls=0,commits=0;t.after(()=>release.resolve());
  await f.install([{...base,execute:async()=>{calls++;started.resolve();await release.promise;return null;},commit:()=>{commits++;}}]);
  const id=f.platform.submission.enqueue('generated:accepted',base.kind,{}),queued=f.platform.submission.enqueue('generated:backlog',base.kind,{}),run=f.platform.submission.drain([id]);await started.promise;
  f.platform.quiesce();assert.throws(()=>f.platform.submission.enqueue('generated:new',base.kind,{}),{statusCode:503});assert.throws(()=>f.platform.assembly.executor.enqueue('generated:raw-new',base.kind,{}),{statusCode:503});
  await f.platform.tick();release.resolve();await run;assert.equal(calls,1);assert.equal(commits,1);assert.equal(f.platform.receipt(queued).step?.state,'waiting');
  await f.restart();await f.install([base]);await f.platform.submission.drain([queued]);assert.equal(f.platform.receipt(queued).step?.state,'succeeded');
});

test('four real gates consume configuration and durable provider cooldowns survive resource replacement',async t=>{
  const f=await fixture(t),settings={protocol:'openai-completions' as const,provider:'custom',baseUrl:'http://127.0.0.1:1234/v1',apiKey:'generated-private-key',headers:{}},provider=f.platform.assembly.providerAdmission;
  await assert.rejects(provider.run(settings,async()=>{throw new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:5000});}),ProviderFailure);
  f.config.setHandler<ReturnType<ExecutionSettings['execution']>>('execution',(next,previous)=>({apply:()=>{},publish:()=>f.platform.refreshSettings(next),rollback:()=>f.platform.refreshSettings(previous)}));
  await f.config.update('execution',{interactiveConcurrency:1,agentConcurrency:2,llmConcurrency:3,memoryConcurrency:1},f.config.revision);
  assert.deepEqual(Object.fromEntries(Object.entries(f.platform.assembly).filter(([key])=>key.endsWith('Gate')).map(([key,gate])=>[key,(gate as import('../src/concurrency.js').ConcurrencyGate).snapshot().limit])),{agentGate:2,llmGate:3,interactiveGate:1,interactiveModelGate:1});
  const gate=f.platform.assembly.interactiveGate,started=deferred(),release=deferred();t.after(()=>release.resolve());let accepted=false;
  const running=gate.run(async()=>{started.resolve();await release.promise;accepted=true;return 42;});await started.promise;const waiting=assert.rejects(gate.run(async()=>0));
  const lateFailure=assert.rejects(provider.run({...settings,apiKey:'generated-late-key'},async()=>{await release.promise;throw new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:60000});}),ProviderFailure);
  await f.platform.close();await waiting;assert.equal(accepted,false,'local close is not proof of remote rollback');assert.throws(()=>provider.check(settings),{statusCode:503});release.resolve();assert.equal(await running,42);await lateFailure;assert.equal(f.store.db.prepare('SELECT count(*) n FROM provider_cooldowns').get()!.n,1,'disposed admission must not write a late remote failure');assert.equal(f.store.db.isOpen,true);
  await f.restart();assert.throws(()=>f.platform.assembly.providerAdmission.check(settings),ProviderFailure);f.advance(5001);assert.doesNotThrow(()=>f.platform.assembly.providerAdmission.check(settings));
});

test('the actual SourcePipeline serializes work into the owned engine and publishes retained Coding material',async t=>{
  const f=await fixture(t),materials=new MaterialStore(f.store),runtime=new SourcePipelineRuntime(f.store,materials,[codingSourcePlugin],undefined,f.platform.assembly.executor);await runtime.ready;
  f.beforeClose(async()=>{await runtime.close();await materials.index?.close();});
  const sources=new SourceStore(f.store,runtime);sources.register({id:'generated-coding',name:'Generated coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});
  const event={externalId:'generated-event',revision:'1',observedAt:'2026-11-03T01:00:00Z',kind:'message',layer:'snapshot',text:'Generated durable source requirement and result.',document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'generated-session',projectKey:'generated-project',eventId:'000001',role:'user',attribution:'human',part:0,parts:1}}};
  const receipt=await sources.upsert('generated-coding',event);await runtime.tick();const published=materials.list().items[0];assert.ok(published);assert.match(materials.read(published.ref,{length:12000}).text,/Generated durable source requirement/);
  const steps=f.platform.assembly.executor.list({kind:'source.archive-group'}).items;assert.equal(steps.length,1);assert.equal(steps[0].state,'succeeded');assert.equal(steps[0].input.sourceId,'generated-coding');assert.ok(steps[0].input.checkpoint);
  const repeated=await sources.upsert('generated-coding',event);assert.equal(repeated.id,receipt.id);assert.equal(repeated.duplicate,true);await runtime.tick();assert.equal(materials.list().items[0].ref,published.ref);assert.equal(f.platform.assembly.executor.list({kind:'source.archive-group'}).items.length,1);
  await runtime.close();assert.equal(f.platform.assembly.executor.closed,false);await materials.index?.close();
});

test('H04 owns the restart factory and guards the flat public port without publishing raw handler authority',async t=>{
  const f=await fixture(t);await f.platform.close();const owner=identity('execution-owner');
  const platform=createExecutionPlatform({store:f.store,settings:f.settings,modelAuthorization:f.authorization.assembly.modelAuthorization});
  const handle=await f.host.install({identity:owner,contributions:[executionPlatformDeclaration],restartRequired:true,factory:createExecutionPlatformFactory(platform)});
  let committed=0;await f.host.install({identity:identity('public-submission-handler'),contributions:[{id:'generated-public-handler',apiVersion:'1'}],factory:createExecutionHandlersFactory(platform,[{...base,commit:()=>{committed++;}}])});
  const lease=await f.host.acquire(centralServices.execution,{service:centralServices.execution,provider:{scope:owner,contributionId:executionPlatformDeclaration.id},revision:0});const retained=lease.value;
  assert.equal(retained.get('generated-absent'),undefined);assert.equal(f.host.snapshot().contributions[0].restartRequired,true);assert.equal(executionPlatformContribution.provides.length,1);assert.equal('store' in retained,false);assert.equal('register' in retained,false);
  const id=retained.enqueue('generated:public-contract',base.kind,{revision:1});await retained.drain([id]);assert.equal(retained.get(id)?.state,'succeeded');assert.equal(committed,1);
  await handle.close('restart');assert.throws(()=>retained.get('generated-absent'),{code:'dependency_unavailable'});assert.equal(f.store.db.isOpen,true);assert.ok(f.store.stats());
});


test('a failed H04 handler prepare releases earlier registrations without deleting durable work',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.install([base,base]),/Duplicate execution handler/);
  assert.throws(()=>f.platform.submission.enqueue('generated:orphan',base.kind,{}),{statusCode:503});
  assert.equal(f.platform.assembly.executor.list().items.length,0);
  await f.install([base]);const id=f.platform.submission.enqueue('generated:reinstalled',base.kind,{revision:1});await f.platform.submission.drain([id]);assert.equal(f.platform.receipt(id).step?.state,'succeeded');assert.equal(f.store.db.isOpen,true);
});
