import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {zipSync,strToU8} from 'fflate';
import {PluginHost} from '@mote/plugin-host';
import {serviceContract,type ScopeIdentity,type ServiceBinding} from '@mote/plugin-api/contracts';
import {Store,sha256} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {MemoryBindings} from '../src/memory-bindings.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {MemoryStore} from '../src/memory.js';
import {WorkerMemoryProvider} from '../src/worker-memory-provider.js';
import {GitHubPluginReleases,type PluginManifest} from '../src/plugin-release.js';
import {PluginControlStore} from '../src/plugins/plugin-control-store.js';
import {createPluginControlPlatform,pluginControlDeclaration,type TrustedPluginBuild} from '../src/plugin-center.js';

const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
function directory(t:TestContext){const path=mkdtempSync(join(tmpdir(),'mote-c07-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
const read=serviceContract<{read():number}>('fixture.read','1');
function build(options:{replacement?:'hot'|'restart';requires?:ServiceBinding[];entered?:()=>void}={}):TrustedPluginBuild{
  return {packageId:'fixture.build',version:'1.0.0',replacement:options.replacement??'hot',requires:options.requires,
    contribution:{id:'fixture.build.port',version:'1.0.0',surface:'data',runtime:'host',provides:[{kind:'service',id:read.id,apiVersion:'1',cardinality:'single'}]},
    factory:context=>({prepare(){options.entered?.();},start(){context.provide('fixture.build.port',read,{read:()=>7});},quiesce(){},stop(){},dispose(){}})};
}
async function platform(path:string,builds:TrustedPluginBuild[]=[],releases?:GitHubPluginReleases){
  const store=new Store(path),executor=new ExecutionEngine(store),host=new PluginHost({kind:'central',id:randomUUID()});
  const control=createPluginControlPlatform({store,executor,host,releases:releases??new GitHubPluginReleases(join(path,'packages'))},builds);
  const identity:ScopeIdentity={host:host.identity,packageId:'mote.control',installationId:'control-install',instanceId:'control-instance',activationId:randomUUID()};
  const handle=await host.install({identity,contributions:[pluginControlDeclaration],factory:control.factory});
  await control.startBuilds();
  return {store,executor,host,control,handle,plugins:control.assembly,async close(){await handle.close('shutdown');await host.close();await executor.close();store.close();}};
}
const selection={packageId:'fixture.build',version:'1.0.0',configurationRevision:0};
function binding(identity:ScopeIdentity):ServiceBinding{return {service:read,provider:{scope:identity,contributionId:'fixture.build.port'},revision:0};}

// User failure: a lost response or two stale editors must not duplicate effects
// or lose the acknowledgement after reopening the same private vault.
test('control intent and receipt commit atomically; replay and CAS survive restart',async t=>{
  const path=directory(t);let store=new Store(path),control=new PluginControlStore(store);
  const input=command(control.revision());let applied=0;
  assert.equal(control.command('enable',input,()=>control.revision(),()=>applied++),true);
  const receipt=control.receipt(input.operationId)!;assert.equal(receipt.revision,2);
  assert.equal(control.command('enable',input,()=>control.revision(),()=>applied++),false);assert.equal(applied,1);
  assert.throws(()=>control.command('disable',input,()=>control.revision(),()=>{}),{statusCode:409});
  const stale=command(1);assert.throws(()=>control.command('enable',stale,()=>control.revision(),()=>{}),{statusCode:409});assert.equal(control.receipt(stale.operationId),undefined);
  const failed=command(2);assert.throws(()=>control.command('fail',failed,()=>control.revision(),()=>{store.db.prepare('UPDATE plugin_center SET revision=99').run();throw Error('fixture rollback');}));
  assert.equal(control.revision(),2);assert.equal(control.receipt(failed.operationId),undefined);
  store.close();store=new Store(path);t.after(()=>store.close());control=new PluginControlStore(store);
  assert.deepEqual(control.receipt(input.operationId),receipt);assert.equal(control.command('enable',input,()=>control.revision(),()=>applied++),false);assert.equal(applied,1);
  const expected=control.revision(),results=await Promise.allSettled([1,2].map(()=>Promise.resolve().then(()=>control.command('edit',command(expected),()=>control.revision(),()=>{}))));
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);assert.equal(results.filter(value=>value.status==='rejected'&&value.reason.statusCode===409).length,1);
});

test('two actual host instances isolate leases; disable retains identity and retirement preserves state ownership',async t=>{
  const f=await platform(directory(t),[build()]);t.after(()=>f.close());
  const a=await f.plugins.selectBuild('one',{...command(f.plugins.revision()),selection});
  const b=await f.plugins.selectBuild('two',{...command(f.plugins.revision()),selection});
  assert.equal(a.observed,'active');assert.equal(b.observed,'active');assert.notEqual(a.installationId,b.installationId);
  assert.equal(f.host.snapshot().contributions.length,3,'control and both builds share the same real host');
  const leaseA=await f.host.acquire(read,binding(a.active!.identity)),leaseB=await f.host.acquire(read,binding(b.active!.identity));
  assert.equal(leaseA.value.read(),7);assert.equal(leaseB.value.read(),7);
  const disabled=await f.plugins.selectBuild('one',{...command(a.revision),selection:null});
  assert.equal(disabled.observed,'stopped');assert.equal(disabled.installationId,a.installationId);
  assert.throws(()=>leaseA.value.read());assert.equal(leaseB.value.read(),7);
  const next=await f.plugins.selectBuild('one',{...command(disabled.revision),selection});
  assert.equal(next.installationId,a.installationId);assert.notEqual(next.active!.identity.activationId,a.active!.identity.activationId);
  f.plugins.references=id=>id==='one'?['submitted memory operation']:[];
  const draining=await f.plugins.selectBuild('one',{...command(next.revision),selection:null});assert.equal(draining.observed,'draining');assert.ok(draining.active);
  await assert.rejects(f.plugins.retireBuild('one',command(draining.revision)),{statusCode:409});
  f.plugins.references=()=>[];
  const stopped=await f.plugins.selectBuild('one',{...command(draining.revision),selection:null});
  const retired=await f.plugins.retireBuild('one',command(stopped.revision));assert.equal(retired.retired,true);assert.equal(retired.installationId,a.installationId);
  await assert.rejects(f.plugins.selectBuild('one',{...command(retired.revision),selection}),{statusCode:409});
  await leaseA.release();await leaseB.release();
});

test('restart-only selection saves intent without activation and applies only in a new host startup',async t=>{
  const path=directory(t);let starts=0,f=await platform(path,[build({replacement:'restart',entered:()=>starts++})]);
  const input={...command(f.plugins.revision()),selection};const desired=await f.plugins.selectBuild('foundation',input);
  assert.equal(desired.restartRequired,true);assert.equal(desired.active,null);assert.equal(starts,0);
  await f.plugins.selectBuild('foundation',input);assert.equal(starts,0);
  const receipt=f.plugins.commandReceipt(input.operationId);await f.close();
  f=await platform(path,[build({replacement:'restart',entered:()=>starts++})]);t.after(()=>f.close());
  const actual=f.plugins.buildView('foundation');assert.equal(actual.observed,'active');assert.equal(actual.installationId,desired.installationId);assert.equal(starts,1);
  assert.deepEqual(f.plugins.commandReceipt(input.operationId),receipt);
  const pending=await f.plugins.selectBuild('foundation',{...command(actual.revision),selection:{...selection,configurationRevision:1}});
  assert.equal(pending.restartRequired,true);assert.equal(pending.active!.configurationRevision,0);assert.equal(starts,1);
  const disabled=await f.plugins.selectBuild('foundation',{...command(pending.revision),selection:null});
  const again=await f.plugins.selectBuild('foundation',{...command(disabled.revision),selection:null});
  assert.equal(again.restartRequired,true);assert.ok(again.active,'repeated stop selection cannot hot-unload a restart platform');
  await f.close();f=await platform(path,[build({replacement:'restart',entered:()=>starts++})]);
  assert.equal(f.plugins.buildView('foundation').observed,'stopped');assert.equal(f.plugins.buildView('foundation').restartRequired,false);assert.equal(starts,1);
});

test('missing exact dependency is blocked and receipt replay never retries a factory',async t=>{
  let calls=0;
  const missing:ServiceBinding={service:read,provider:{scope:{host:{kind:'central',id:'missing-host'},packageId:'missing',installationId:'missing',instanceId:'missing',activationId:'missing'},contributionId:'missing'},revision:0};
  const f=await platform(directory(t),[build({requires:[missing],entered:()=>calls++})]);t.after(()=>f.close());
  const input={...command(f.plugins.revision()),selection};const result=await f.plugins.selectBuild('one',input);
  assert.equal(result.desired!.packageId,selection.packageId);assert.equal(result.observed,'blocked');assert.equal(result.active,null);assert.deepEqual(result.blockers,['dependency_unavailable']);assert.equal(calls,0);
  await f.plugins.selectBuild('one',input);assert.equal(calls,0);
});

function releaseFixture(path:string,hold?:{entered:()=>void;wait:Promise<void>},memory=false,sourceOverride?:string){
  const source=sourceOverride??(memory?`export function createMemoryProvider(){return {health(){return {providerId:'generated.empty',version:'1',ready:true,verified:{persistentCrud:true,scopedRetrieval:true,immutableRecords:true,idempotentReplay:true,history:true,physicalErase:false},problems:[]}},export(){return []},read(){return null},search(){return []},close(){}}}`:`import {appendFileSync,existsSync,writeFileSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises'; export async function createMemoryProvider(c){if(existsSync(c.log+'.hold')){writeFileSync(c.log+'.initializing','');while(existsSync(c.log+'.hold'))await delay(5);}return {health(){return {capabilities:[{id:'repository',state:'verified'}],issues:[]}},put(){appendFileSync(c.log,'submitted\\n');process.exit(17)},close(){}}}`);
  const archive=zipSync({'worker.mjs':strToU8(source)}),repository='generated-fixture/control',tag='v1.0.0',base=`https://github.com/${repository}/releases/download/${tag}/`;
  const manifest:PluginManifest={schemaVersion:1,id:'fixture.worker',name:'Fixture worker',version:'1.0.0',runtime:'worker',entry:'worker.mjs',archive:{asset:'worker.zip',sha256:sha256(Buffer.from(archive))},capabilities:['repository','retrieval'],configuration:[{id:'log',label:'Fixture submission log',type:'text',required:true}],dependencies:[],access:['Generated private profile']};
  const releases=new GitHubPluginReleases(join(path,'packages'),async url=>{
    if(url===`https://api.github.com/repos/${repository}/releases/tags/${tag}`)return {bytes:strToU8(JSON.stringify({tag_name:tag,draft:false,assets:['mote-plugin.json','worker.zip'].map(name=>({name,browser_download_url:base+name}))}))};
    if(url===`https://api.github.com/repos/${repository}/commits/${tag}`)return {bytes:strToU8(JSON.stringify({sha:'a'.repeat(40)}))};
    if(url===base+'mote-plugin.json'){hold?.entered();await hold?.wait;return {bytes:strToU8(JSON.stringify(manifest))};}
    if(url===base+'worker.zip')return {bytes:archive};throw Error('Unexpected external fixture URL');
  });return {releases,repository,tag};
}
async function until(check:()=>boolean){const deadline=Date.now()+5000;while(!check()){assert.ok(Date.now()<deadline,'controlled operation settles');await delay(5);}}

test('real release enters the same host; unknown capability blocks readiness and lost mutation is never retried',async t=>{
  const path=directory(t),r=releaseFixture(path),f=await platform(path,[],r.releases);t.after(()=>f.close());
  const preview=await f.plugins.resolve({repository:r.repository,tag:r.tag});
  f.plugins.install({...command(f.plugins.revision()),previewId:preview.id});await until(()=>f.plugins.view().packages[0]?.state==='installed');
  const pkg=f.plugins.view().packages[0]!,instance=f.plugins.configure(undefined,{...command(f.plugins.revision()),packageId:pkg.id,name:'Generated',scope:'default',configuration:{log:join(path,'submitted.log')}});
  f.plugins.action(instance.id,'check',command(instance.revision));await until(()=>f.plugins.instanceView(instance.id).observed!=='checking');
  const checked=f.plugins.instanceView(instance.id);assert.equal(checked.observed,'blocked');assert.ok(checked.capabilities.some(value=>value.state==='unknown'));assert.ok(!checked.allowedActions.includes('enable'));
  const snapshot=f.host.snapshot();assert.equal(snapshot.contributions.length,2);const child=snapshot.contributions.find(value=>value.identity.scope.instanceId===instance.id)!;
  assert.equal(child.identity.scope.installationId,f.plugins.packageForInstance(instance.id).installationId);
  const runtime=f.plugins.runtime(instance.id);
  await assert.rejects(runtime.call('put',{}));assert.equal(readFileSync(join(path,'submitted.log'),'utf8'),'submitted\n');
  assert.deepEqual(f.plugins.instanceView(instance.id).issues,['plugin_worker_unavailable_reconciliation_required']);
  assert.ok(!f.host.snapshot().contributions.some(value=>value.identity.scope.instanceId===instance.id&&value.availability.state==='active'));
  await assert.rejects(f.plugins.runtime(instance.id).call('put',{}));assert.equal(readFileSync(join(path,'submitted.log'),'utf8'),'submitted\n','lost submitted effect is not automatically retried');
  writeFileSync(join(f.plugins.packageForInstance(instance.id).directory,'worker.mjs'),'tampered');
  await f.plugins.resetRuntime(instance.id);assert.throws(()=>f.plugins.runtime(instance.id),/integrity|digest|changed|match/i);
});

test('worker package and trusted native builds expose the same control projection fields',async t=>{
  const path=directory(t),r=releaseFixture(path),f=await platform(path,[build()],r.releases);t.after(()=>f.close());
  const native=await f.plugins.selectBuild('native',{...command(f.plugins.revision()),selection});assert.equal(native.runtime,'host');
  const preview=await f.plugins.resolve({repository:r.repository,tag:r.tag});f.plugins.install({...command(f.plugins.revision()),previewId:preview.id});await until(()=>f.plugins.view().packages[0]?.state==='installed');
  const instance=f.plugins.configure(undefined,{...command(f.plugins.revision()),packageId:f.plugins.view().packages[0]!.id,name:'Generated shared projection',scope:'default',configuration:{log:join(path,'submitted.log')}});
  f.plugins.probe=async()=>({capabilities:[{id:'repository',state:'verified'},{id:'retrieval',state:'verified'}],issues:[]});
  f.plugins.action(instance.id,'check',command(instance.revision));await until(()=>f.plugins.instanceView(instance.id).observed!=='checking');f.plugins.action(instance.id,'enable',command(f.plugins.instanceView(instance.id).revision));
  const worker=f.plugins.buildView(instance.id);
  assert.equal(worker.runtime,'worker');assert.equal(worker.observed,'active');
  assert.deepEqual(Object.keys(worker).sort(),Object.keys(native).sort(),'Web and Android consume one field set for both build sources');
});

test('control JSON rows are charged and a quota failure rolls intent, state and receipt back together',t=>{
  const path=directory(t),limits:{maxStorageBytes?:number}={},store=new Store(path,limits);t.after(()=>store.close());const control=new PluginControlStore(store);
  const before=store.logicalBytes();const input=command(control.revision());
  control.command('select',input,()=>control.revision(),()=>control.saveBuild({id:'fixture',packageId:'fixture.build',installationId:randomUUID(),revision:1,desired:selection,retired:false,observed:'queued',blockers:[],operationId:input.operationId}));
  const rows=store.db.prepare("SELECT name,bytes FROM storage_ledger WHERE name IN ('plugin_control_receipts','plugin_build_instances') ORDER BY name").all();
  assert.equal(rows.length,2);assert.ok(rows.every(row=>Number(row.bytes)>128));assert.ok(store.logicalBytes()>before);
  const previous=control.build('fixture')!,revision=control.revision(),failed=command(revision);
  // A generated profile's actual ledger is the enforcement boundary, not a
  // fake reserveMetadata method or a second per-plugin quota counter.
  limits.maxStorageBytes=store.logicalBytes()+64;
  assert.throws(()=>control.command('select',failed,()=>control.revision(),()=>control.saveBuild({...previous,blockers:['x'.repeat(1024)]})),{statusCode:507});
  assert.deepEqual(control.build('fixture'),previous);assert.equal(control.revision(),revision);assert.equal(control.receipt(failed.operationId),undefined);
});

test('worker EOF cancels and drains an accepted call before closing provider resources',async t=>{
  const path=directory(t),entry=join(path,'drain.mjs'),log=join(path,'order.log');
  writeFileSync(entry,`import {appendFileSync,writeFileSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';export function createMemoryProvider(c){let closed=false;return {async put(_,signal){writeFileSync(c.entered,'');await new Promise(done=>signal.addEventListener('abort',done,{once:true}));await delay(10);if(closed)throw Error('resource closed before accepted work');appendFileSync(c.log,'drained\\n');},close(){closed=true;appendFileSync(c.log,'closed\\n');}}}`);
  const {WorkerPluginRuntime}=await import('../src/plugin-runtime.js');
  const runtime=new WorkerPluginRuntime(entry,{log,entered:join(path,'entered')},path);t.after(()=>runtime.close());
  const pending=runtime.call('put',{});const rejected=assert.rejects(pending,/unavailable/);
  await until(()=>{try{readFileSync(join(path,'entered'));return true;}catch{return false;}});
  await runtime.close();await rejected;assert.equal(readFileSync(log,'utf8'),'drained\nclosed\n');
});

// Descriptive metadata cannot make an unpublished implementation ready.
test('missing publication cleans its lifecycle and a failed receipt is not retried on restart',async t=>{
  const path=directory(t);let starts=0,disposed=0;
  const broken:TrustedPluginBuild={...build(),factory:()=>({prepare(){},start(){starts++;},quiesce(){},stop(){},dispose(){disposed++;}})};
  let f=await platform(path,[broken]);
  const result=await f.plugins.selectBuild('broken',{...command(f.plugins.revision()),selection});
  assert.equal(result.observed,'blocked');assert.equal(result.active,null);assert.equal(starts,1);assert.equal(disposed,1);
  await f.close();f=await platform(path,[broken]);t.after(()=>f.close());
  assert.equal(f.plugins.buildView('broken').observed,'blocked');assert.equal(starts,1);assert.equal(disposed,1);
});

test('caller cancellation during actual hosted worker startup leaves shared initialization alive',async t=>{
  const path=directory(t),r=releaseFixture(path),f=await platform(path,[],r.releases);t.after(()=>f.close());
  const preview=await f.plugins.resolve({repository:r.repository,tag:r.tag});f.plugins.install({...command(f.plugins.revision()),previewId:preview.id});await until(()=>f.plugins.view().packages[0]?.state==='installed');
  const log=join(path,'held.log');writeFileSync(log+'.hold','');
  const instance=f.plugins.configure(undefined,{...command(f.plugins.revision()),packageId:f.plugins.view().packages[0]!.id,name:'Held startup',scope:'default',configuration:{log}});
  const runtime=f.plugins.runtime(instance.id),controller=new AbortController(),pending=runtime.call('health',{},controller.signal),rejected=assert.rejects(pending,/revoked/);
  await until(()=>{try{readFileSync(log+'.initializing');return true;}catch{return false;}});
  controller.abort();await rejected;
  rmSync(log+'.hold');assert.deepEqual(await runtime.call('health',{}),{capabilities:[{id:'repository',state:'verified'}],issues:[]});
  await f.handle.quiesce('upgrade');await assert.rejects(runtime.call('health',{}),/quiescing/);
});

test('a release resolve returning after owner shutdown cannot persist a late preview',async t=>{
  let entered!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(done=>entered=done),wait=new Promise<void>(done=>release=done);
  const path=directory(t),r=releaseFixture(path,{entered,wait});
  const f=await platform(path,[],r.releases);t.after(()=>f.close());
  const resolving=f.plugins.resolve({repository:r.repository,tag:r.tag}),rejected=assert.rejects(resolving,/quiescing/);
  await waiting;await f.handle.close('disabled');release();await rejected;
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM plugin_release_previews').get()!.count,0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM plugin_commands').get()!.count,0);
});

for(const retained of [false,true])test(`checked disabled instance resumes without another check${retained?' while the actual Memory binding retains it':''}`,async t=>{
  const path=directory(t),r=releaseFixture(path,undefined,true),f=await platform(path,[],r.releases);t.after(()=>f.close());
  const automation=new MemoryAutomation(f.store),bindings=new MemoryBindings(f.store,new MemoryStore(f.store),automation,f.plugins,f.executor);t.after(()=>bindings.close());
  f.plugins.probe=async(id,signal)=>{
    const health=await new WorkerMemoryProvider(f.plugins.runtime(id)).recover({namespace:{ownerId:'mote-owner',instanceId:id,bindingRevision:1}});signal.throwIfAborted();
    return {capabilities:f.plugins.packageForInstance(id).manifest.capabilities.map(id=>({id,state:health.ready&&(id==='repository'?health.verified.persistentCrud&&health.verified.immutableRecords&&health.verified.idempotentReplay:health.verified.scopedRetrieval)?'verified' as const:'unknown' as const})),issues:health.problems};
  };
  const preview=await f.plugins.resolve({repository:r.repository,tag:r.tag});f.plugins.install({...command(f.plugins.revision()),previewId:preview.id});await until(()=>f.plugins.view().packages[0]?.state==='installed');
  const instance=f.plugins.configure(undefined,{...command(f.plugins.revision()),packageId:f.plugins.view().packages[0]!.id,name:'Resume fixture',scope:'default',configuration:{log:join(path,'fixture.log')}});
  f.plugins.action(instance.id,'check',command(instance.revision));await until(()=>f.plugins.instanceView(instance.id).observed!=='checking');
  let current=f.plugins.instanceView(instance.id);assert.equal(current.observed,'ready');assert.ok(current.capabilities.every(value=>value.state==='verified'));
  current=f.plugins.action(instance.id,'enable',command(current.revision));
  if(retained){
    const preparation=command(bindings.view().revision);bindings.prepare({...preparation,targetPlanId:'instance:'+instance.id,scope:'default',feeAcknowledged:true});
    await until(()=>['verified','blocked','failed'].includes(bindings.view().preparation?.state??''));assert.equal(bindings.view().preparation!.state,'verified');
    bindings.action('activate',{...command(bindings.view().revision),preparationId:preparation.operationId});
    automation.command('resume',command(automation.view().revision));assert.equal(bindings.accepting(),true);
    assert.ok(f.plugins.references(instance.id).some(value=>value.includes('Current Memory binding')));
  }
  const bindingBefore=bindings.binding(),identity=f.plugins.instanceIdentity(instance.id),capabilities=current.capabilities;
  const disabled=f.plugins.action(instance.id,'disable',command(current.revision));
  assert.equal(disabled.observed,retained?'draining':'disabled');assert.deepEqual(disabled.capabilities,capabilities);
  if(retained){assert.equal(bindings.accepting(),false);assert.ok(!disabled.allowedActions.includes('check'));assert.throws(()=>f.plugins.action(instance.id,'check',command(disabled.revision)),{statusCode:409});}
  assert.ok(disabled.allowedActions.includes('enable'),'completed capability verification still admits resume');
  const enable=command(disabled.revision),resumed=f.plugins.action(instance.id,'enable',enable);
  assert.equal(resumed.desired,true);assert.equal(resumed.observed,'ready');assert.deepEqual(bindings.binding(),bindingBefore);assert.deepEqual(f.plugins.instanceIdentity(instance.id),identity);
  assert.deepEqual(f.plugins.action(instance.id,'enable',enable),resumed,'lost response replay does not reapply enable');
  if(retained)assert.equal(bindings.accepting(),true);
});

for(const mode of ['reset','reconfigure'] as const)test(`${mode} closes an actually stalled hosted worker before initialization settles`,async t=>{
  const path=directory(t),r=releaseFixture(path),f=await platform(path,[],r.releases);t.after(()=>f.close());
  const preview=await f.plugins.resolve({repository:r.repository,tag:r.tag});f.plugins.install({...command(f.plugins.revision()),previewId:preview.id});await until(()=>f.plugins.view().packages[0]?.state==='installed');
  const log=join(path,'old.log');writeFileSync(log+'.hold','');
  const instance=f.plugins.configure(undefined,{...command(f.plugins.revision()),packageId:f.plugins.view().packages[0]!.id,name:'Stalled initialization',scope:'default',configuration:{log}});
  const old=f.plugins.runtime(instance.id),pending=old.call('health',{}),rejected=assert.rejects(pending);
  await until(()=>{try{readFileSync(log+'.initializing');return true;}catch{return false;}});
  let closing:Promise<void>;
  if(mode==='reset')closing=f.plugins.resetRuntime(instance.id);
  else{
    f.plugins.configure(instance.id,{...command(f.plugins.instanceView(instance.id).revision),name:'Replacement',scope:'default',configuration:{log:join(path,'new.log')}});
    closing=old.close();
    assert.deepEqual(await f.plugins.runtime(instance.id).call('health',{}),{capabilities:[{id:'repository',state:'verified'}],issues:[]},'replacement initializes independently of the stalled old worker');
  }
  let timer:ReturnType<typeof setTimeout>|undefined,stopped:boolean;
  try{stopped=await Promise.race([closing.then(()=>true),new Promise<boolean>(done=>{timer=setTimeout(()=>done(false),7000);})]);}
  finally{if(timer)clearTimeout(timer);rmSync(log+'.hold',{force:true});await closing;await rejected;}
  assert.equal(stopped,true,'close reaches the existing worker shutdown deadline without releasing initialization');
  if(mode==='reconfigure')assert.equal(f.host.snapshot().contributions.filter(value=>value.identity.scope.instanceId===instance.id).length,1,'only the replacement scope remains installed');
  else assert.equal(f.host.snapshot().contributions.filter(value=>value.identity.scope.instanceId===instance.id).length,0);
});

test('an unstarted restart selection does not prevent hot activation while a live restart provider is preserved',async t=>{
  const path=directory(t),restart=build({replacement:'restart'}),hot:TrustedPluginBuild={...build(),version:'1.1.0',contribution:{...build().contribution,version:'1.1.0'}};
  let f=await platform(path,[restart,hot]);t.after(()=>f.close());
  const pending=await f.plugins.selectBuild('foundation',{...command(f.plugins.revision()),selection});assert.equal(pending.active,null);
  const active=await f.plugins.selectBuild('foundation',{...command(pending.revision),selection:{...selection,version:'1.1.0'}});
  assert.equal(active.observed,'active');assert.equal(active.restartRequired,false);assert.equal(active.active!.version,'1.1.0');assert.equal(active.installationId,pending.installationId);
  const next=await f.plugins.selectBuild('foundation',{...command(active.revision),selection});assert.equal(next.restartRequired,true);assert.equal(next.active!.version,'1.1.0');
  await f.close();f=await platform(path,[restart,hot]);assert.equal(f.plugins.buildView('foundation').active!.version,'1.0.0');
  const actual=f.plugins.buildView('foundation'),deferred=await f.plugins.selectBuild('foundation',{...command(actual.revision),selection:{...selection,version:'1.1.0'}});
  assert.equal(deferred.restartRequired,true);assert.equal(deferred.active!.version,'1.0.0','an actually running restart provider is not hot-unloaded');
});

test('quiesce refuses a new hosted RPC while an accepted worker mutation drains before cleanup',async t=>{
  const path=directory(t),source=`import {appendFileSync,existsSync,writeFileSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';export function createMemoryProvider(c){return {health(){appendFileSync(c.log,'unexpected-health\\n');return {}},async put(_,signal){const abort=()=>appendFileSync(c.log,'aborted\\n');signal.addEventListener('abort',abort,{once:true});try{appendFileSync(c.log,'accepted\\n');writeFileSync(c.log+'.entered','');while(!existsSync(c.log+'.release'))await delay(5);signal.throwIfAborted();appendFileSync(c.log,'completed\\n');return {committed:true};}finally{signal.removeEventListener('abort',abort)}},close(){appendFileSync(c.log,'closed\\n')}}}`;
  const r=releaseFixture(path,undefined,false,source),f=await platform(path,[],r.releases);t.after(()=>f.close());
  const preview=await f.plugins.resolve({repository:r.repository,tag:r.tag});f.plugins.install({...command(f.plugins.revision()),previewId:preview.id});await until(()=>f.plugins.view().packages[0]?.state==='installed');
  const log=join(path,'drain.log'),instance=f.plugins.configure(undefined,{...command(f.plugins.revision()),packageId:f.plugins.view().packages[0]!.id,name:'Accepted drain',scope:'default',configuration:{log}});
  const runtime=f.plugins.runtime(instance.id),first=runtime.call('put',{}).then(value=>({value}),error=>({error}));
  await until(()=>{try{readFileSync(log+'.entered');return true;}catch{return false;}});
  const scope=f.host.snapshot().contributions.find(value=>value.identity.scope.instanceId===instance.id)!.identity.scope;
  const port=serviceContract<unknown>('mote.plugin.worker-runtime','1'),lease=await f.host.acquire(port,{service:port,provider:{scope,contributionId:'worker-runtime'},revision:0});
  let stopping:Promise<void>|undefined;
  try{
    await f.handle.quiesce('upgrade');
    await assert.rejects(runtime.call('health',{}),/quiescing/);
    assert.equal(lease.signal.aborted,false,'admission refusal must not revoke the accepted operation');
    assert.equal(f.host.snapshot().contributions.find(value=>value.identity.scope.activationId===scope.activationId)!.availability.state,'unavailable');
    let closed=false;stopping=f.handle.close('upgrade');void stopping.then(()=>{closed=true;});
    await delay(0);assert.equal(closed,false);assert.equal(lease.signal.aborted,false,'graceful close still waits for the held operation');
    writeFileSync(log+'.release','');assert.deepEqual(await first,{value:{committed:true}});
    await stopping;assert.equal(readFileSync(log,'utf8'),'accepted\ncompleted\nclosed\n');assert.equal(lease.signal.aborted,true);
  }finally{writeFileSync(log+'.release','');await first;if(stopping)await stopping;await lease.release();}
});
