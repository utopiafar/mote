import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {serviceContract,type ServiceBinding} from '@mote/plugin-api/contracts';
import {PluginHostError} from '@mote/plugin-host';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {sha256} from '../src/store.js';
import type {PluginManifest,PluginReleaseTransport} from '../src/plugin-release.js';

const repository=fileURLToPath(new URL('../../../',import.meta.url));
const command=(expectedRevision:number)=>({operationId:randomUUID(),expectedRevision});
const withdrawn=(error:unknown)=>error instanceof PluginHostError&&['stale_scope','dependency_unavailable'].includes(error.code);
const until=async(check:()=>boolean|Promise<boolean>,label:string)=>{const deadline=Date.now()+8000;while(!await check()){assert.ok(Date.now()<deadline,label);await new Promise(resolve=>setTimeout(resolve,5));}};
type Release={manifest:PluginManifest;archive:Uint8Array};
function descriptor(manifest:PluginManifest){return {apiVersion:1,id:manifest.id,version:manifest.version,contributions:manifest.contributions,capabilities:manifest.capabilities,required:manifest.dependencies.filter(value=>value.required!==false),optional:manifest.dependencies.filter(value=>value.required===false)};}
function declaration(id:string,dependencies:PluginManifest['dependencies']=[],ports=['generated.domain.log']):PluginManifest{return {
 schemaVersion:1,id,name:'Generated '+id,version:'1.0.0',trust:'external',runtime:'service',entry:'plugin.mjs',archive:{asset:'domain.zip',sha256:'0'.repeat(64)},
 contributions:[{id:id+'.port',version:'1',surface:'data',runtime:'service',entry:'plugin.mjs',provides:ports.map(id=>({kind:'service',id,apiVersion:'1',cardinality:'single'})),capabilities:['domain.state']}],capabilities:['domain.state'],
 configuration:[{id:'mode',label:'Generated mode',type:'text'},{id:'controlFile',label:'Generated control',type:'text'}],dependencies,access:['Generated instance state only'],
};}
async function release(manifest:PluginManifest,body:string,exported=descriptor(manifest)):Promise<Release>{
 const source=`import {serviceContract} from '@mote/plugin-sdk';import {readFile,writeFile,appendFile} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';export const manifest=${JSON.stringify(exported)};export async function createPlugin(context,input){${body}}`;
 const bundled=await build({stdin:{contents:source,resolveDir:repository,sourcefile:'generated-domain.mjs'},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
 const archive=zipSync({'plugin.mjs':bundled.outputFiles[0]!.contents});return {manifest:{...manifest,archive:{...manifest.archive,sha256:sha256(archive)}},archive};
}
const provider=String.raw`
 const config=input.configuration,state=context.state,scope=context.scope;let record,closed=false;
 const flags=async()=>JSON.parse(await readFile(config.controlFile,'utf8'));
 const gate=async key=>{if(!(await flags())[key])return;await writeFile(config.controlFile+'.'+key,'entered');while((await flags())[key])await delay(5);};
 scope.defer(async()=>{closed=true;await appendFile(config.controlFile+'.disposed.'+scope.identity.instanceId,'disposed\n');});
 if(config.mode==='factory')await gate('factory');
 const port=Object.freeze({state(){scope.assertCurrent();return record?.value??{items:[]};},async add({text}){scope.assertCurrent();if(closed)throw Error('closed');const prior=await state.get('items');await gate('write');record=await state.compareAndSet('items',prior?.revision??null,{items:[...(prior?.value.items??[]),text]});return record.value;}});
 return {async prepare(){record=await state.get('items');if(config.mode==='prepare-failure')throw Error('Generated prepare failure');if(config.mode==='check-write')await state.compareAndSet('check-write',null,true);},
  async start(){if(config.mode==='missing')return;if(config.mode==='start-failure'||(await flags()).fail)throw Error('Generated start failure');
   for(const declaration of manifest.contributions)for(const declared of declaration.provides){
    const contract=serviceContract(config.mode==='extra-port'?'generated.undeclared':declared.id,config.mode==='wrong-api'?'2':declared.apiVersion);
    context.provide(config.mode==='extra-contribution'?'generated.undeclared':declaration.id,config.mode==='invalid-contract'?{...contract,undeclared:true}:contract,config.mode==='undefined-port'?undefined:port,config.mode==='invalid-revision'?0.5:0);
    if(config.mode==='partial'){await gate('start');if((await flags()).partialFailure)throw Error('Generated partial failure');}
   }
   if(config.mode==='start')await gate('start');if(config.mode==='late-write')await state.compareAndSet('late-start',null,true);
  },quiesce(){closed=true;},stop(){closed=true;},async dispose(){closed=true;await appendFile(config.controlFile+'.lifecycle-disposed.'+scope.identity.instanceId,'disposed\n');}};
`;
const consumer=String.raw`
 const pin=[...input.required,...input.optional].find(value=>value.service.id==='template.collection.log');let lease,record;
 return {async prepare(){record=await context.state.get('received');if(pin)lease=await context.services.acquire(serviceContract('template.collection.log','1'),pin);},
  start(){context.provide(manifest.contributions[0].id,serviceContract(manifest.contributions[0].provides[0].id,'1'),Object.freeze({
   async add(text){const item=await lease.value.add({text});const prior=await context.state.get('received');record=await context.state.compareAndSet('received',prior?.revision??null,{text:item.text});return item;},
   state(){return {received:record?.value??null,provider:lease?lease.value.summary():null,required:input.required.length,optional:input.optional.length};}
  }),0);},quiesce(){},stop(){},dispose(){}};
`;

async function fixture(t:TestContext){
 const directory=await mkdtemp(join(tmpdir(),'mote-production-domain-')),controlFile=join(directory,'control.json');await writeFile(controlFile,'{}');
 const releases=new Map<string,Release>(),config:Config={dataDir:join(directory,'data'),token:'generated-domain-owner',tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const transport:PluginReleaseTransport=async url=>{
  const item=[...releases.values()].find(value=>url.includes('/generated/'+value.manifest.id+'/'));assert.ok(item,'only generated release transport is used');
  const base='https://github.com/generated/'+item.manifest.id+'/releases/download/v1/';
  if(url.endsWith('/releases/tags/v1'))return {bytes:strToU8(JSON.stringify({tag_name:'v1',draft:false,assets:['mote-plugin.json',item.manifest.archive.asset].map(name=>({name,browser_download_url:base+name}))}))};
  if(url.endsWith('/commits/v1'))return {bytes:strToU8(JSON.stringify({sha:'a'.repeat(40)}))};
  if(url===base+'mote-plugin.json')return {bytes:strToU8(JSON.stringify(item.manifest))};if(url===base+item.manifest.archive.asset)return {bytes:item.archive};throw Error('Unexpected generated release URL');
 };
 const start=async()=>{const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,async close(){},async query(){throw Error('No model calls in domain fixture');}}});Object.defineProperty(node.pluginCenter.releases,'transport',{value:transport});return node;};
 let node=await start();t.after(async()=>{await writeFile(controlFile,'{}');await node.app.close();await rm(directory,{recursive:true,force:true});});
 const request=async(method:'GET'|'POST'|'PATCH',url:string,payload?:unknown)=>{const response=await node.app.inject({method,url,headers:{authorization:'Bearer '+config.token},...(payload===undefined?{}:{payload:payload as object})});assert.ok(response.statusCode<400,response.body);return response.json();};
 const install=async(item:Release)=>{releases.set(item.manifest.id,item);const preview=await request('POST','/api/plugins/resolve',{repository:'generated/'+item.manifest.id,tag:'v1'}),id=item.manifest.id+'@'+preview.source.digest;await request('POST','/api/plugins/install',{...command(node.pluginCenter.revision()),previewId:preview.id});await until(()=>node.pluginCenter.view().packages.some(value=>value.id===id&&value.state==='installed'),'formal domain archive installs');assert.equal(sha256(await readFile(join(config.dataDir,'plugins/packages',preview.source.digest,'mote-source.zip'))),preview.source.digest);return id;};
 const configure=async(packageId:string,mode='normal',id?:string,operationId=randomUUID())=>{const fields=node.pluginCenter.view().packages.find(value=>value.id===packageId)!.configurationSchema!;return request(id?'PATCH':'POST','/api/plugin-instances'+(id?'/'+id:''),{...command(id?node.pluginCenter.instanceView(id).revision:node.pluginCenter.revision()),operationId,...(id?{}:{packageId}),name:'Generated '+mode,scope:'default',configuration:Object.fromEntries(Object.entries({mode,controlFile}).filter(([key])=>fields.some(value=>value.id===key)))});};
 const action=(id:string,kind:'check'|'enable'|'disable')=>request('POST','/api/plugin-instances/'+id+'/'+kind,command(node.pluginCenter.instanceView(id).revision));
 const settle=async(id:string)=>{await until(()=>node.pluginCenter.instanceView(id).observed!=='checking','domain operation settles');return node.pluginCenter.instanceView(id);};
 const check=async(id:string)=>{await action(id,'check');return settle(id);},enable=async(id:string)=>{assert.equal((await action(id,'enable')).observed,'checking');return settle(id);};
 const binding=(id:string,serviceId:string,apiVersion='1'):ServiceBinding=>{const entry=node.bootstrap.host.snapshot().contributions.find(value=>value.identity.scope.instanceId===id&&value.availability.state==='active');assert.ok(entry,'binding comes from an actual active host contribution');return {service:{id:serviceId,apiVersion},provider:entry.identity,revision:0};};
 return {directory,controlFile,config,install,configure,request,action,check,enable,binding,get node(){return node;},control:(value:object)=>writeFile(controlFile,JSON.stringify(value)),entered:(key:string)=>until(async()=>Boolean(await readFile(controlFile+'.'+key).catch(()=>undefined)),'controlled '+key+' gate reached'),async restart(){await node.app.close();node=await start();}};
}

async function template(f:Awaited<ReturnType<typeof fixture>>){
 const output=join(f.directory,'template-release');await promisify(execFile)(process.execPath,[join(repository,'examples/domain-plugin/scripts/pack.mjs'),'--mote',repository,'--out',output,'--data-only'],{timeout:120000});
 const manifest=JSON.parse(await readFile(join(output,'mote-plugin.json'),'utf8')) as PluginManifest;
 assert.deepEqual(manifest.contributions?.map(value=>value.surface),['data'],'the actual template needs no ingress or presentation disguise');return {manifest,archive:await readFile(join(output,manifest.archive.asset))};
}

test('a pure domain template installs formally, serves a typed consumer and restores the same durable instance without a source adapter',async t=>{
 const f=await fixture(t),before=f.node.modelAuthorization.view(),sources=f.node.pluginCenter.view().sourceContributions;
 const complete=join(f.directory,'complete-template');await promisify(execFile)(process.execPath,[join(repository,'examples/domain-plugin/scripts/pack.mjs'),'--mote',repository,'--out',complete],{timeout:120000});
 const full=JSON.parse(await readFile(join(complete,'mote-plugin.json'),'utf8')) as PluginManifest;assert.ok(full.contributions?.some(value=>value.surface==='page'&&value.id==='template-collection.page'));assert.ok(unzipSync(await readFile(join(complete,full.archive.asset)))['web/index.html'],'the separate original page payload is retained');
 const fullInstance=await f.configure(await f.install({manifest:full,archive:await readFile(join(complete,full.archive.asset))}));assert.equal((await f.check(fullInstance.id)).observed,'blocked','an unsupported presentation capability is not reported ready');const page=f.node.pluginCenter.instanceView(fullInstance.id).capabilities.find(value=>value.id==='collection.page');assert.equal(page?.state,'unknown');assert.match(page?.reason??'',/page.*not loaded/);
 const item=await template(f),pkg=await f.install(item),instance=await f.configure(pkg);assert.equal((await f.check(instance.id)).observed,'ready');
 assert.ok(!f.node.bootstrap.host.snapshot().contributions.some(value=>value.identity.scope.instanceId===instance.id),'check leaves no live domain activation');
 assert.equal((await f.enable(instance.id)).observed,'ready');const contract=serviceContract<{add(input:{text:string}):Promise<{text:string}>;state():{items:{text:string}[]}}>('template.collection.log','1'),binding=f.binding(instance.id,contract.id),lease=await f.node.bootstrap.host.acquire(contract,binding);
 assert.equal((await lease.value.add({text:'Generated typed item'})).text,'Generated typed item');assert.equal(lease.value.state().items.length,1);
 const identity=f.node.pluginCenter.instanceIdentity(instance.id);await f.restart();assert.throws(()=>lease.value.state(),{code:'stale_scope'});assert.deepEqual(f.node.pluginCenter.instanceIdentity(instance.id),identity);assert.equal(f.node.pluginCenter.instanceView(instance.id).observed,'ready',JSON.stringify(f.node.pluginCenter.instanceView(instance.id)));
 const reopened=await f.node.bootstrap.host.acquire(contract,f.binding(instance.id,contract.id));assert.equal(reopened.value.state().items[0]?.text,'Generated typed item');assert.notEqual(reopened.binding.provider.scope.activationId,binding.provider.scope.activationId);
 assert.deepEqual(f.node.modelAuthorization.view(),before);assert.deepEqual(f.node.pluginCenter.view().sourceContributions,sources);
 await f.action(instance.id,'disable');assert.equal(reopened.signal.aborted,true);assert.throws(()=>reopened.value.state(),withdrawn);await reopened.release();await lease.release();
});

test('installed domain declarations do not satisfy required dependencies; actual consumers pin live providers, restore in order and stop with them',async t=>{
 const f=await fixture(t),providerPackage=await f.install(await template(f)),required=[{kind:'service' as const,id:'template.collection.log',version:'1'}];
 const consumerManifest=declaration('generated.consumer',required,['generated.consumer.read']),consumerPackage=await f.install(await release(consumerManifest,consumer));
 const one=await f.configure(consumerPackage,'normal',undefined,'00000000-0000-4000-8000-000000000001');assert.equal((await f.check(one.id)).observed,'blocked','an installed package is not an active dependency');
 const source=await f.configure(providerPackage,'normal',undefined,'ffffffff-ffff-4fff-8fff-ffffffffffff');await f.check(source.id);assert.equal((await f.check(one.id)).observed,'blocked','checked but disabled providers are unavailable');assert.equal(f.node.pluginCenter.instanceView(source.id).desired,false);
 await f.enable(source.id);assert.equal((await f.check(one.id)).observed,'ready');assert.equal((await f.enable(one.id)).observed,'ready');
 const contract=serviceContract<{add(text:string):Promise<{text:string}>;state():{received:{text:string}|null;provider:{items:number};required:number}}>('generated.consumer.read','1'),lease=await f.node.bootstrap.host.acquire(contract,f.binding(one.id,contract.id));
 await lease.value.add('Generated through installed consumer');assert.equal(lease.value.state().received?.text,'Generated through installed consumer');assert.equal(lease.value.state().required,1);
 await f.restart();assert.equal(f.node.pluginCenter.instanceView(one.id).observed,'ready','the lower-sorted consumer restores after its actual provider');const restored=await f.node.bootstrap.host.acquire(contract,f.binding(one.id,contract.id));assert.equal(restored.value.state().provider.items,1);assert.equal(restored.value.state().received?.text,'Generated through installed consumer');
 for(const dependency of [{kind:'package' as const,id:'template.collection',version:f.node.pluginCenter.packageForInstance(source.id).manifest.version},{kind:'contribution' as const,id:'template-collection.port',version:'1'}]){
  const manifest=declaration('generated.'+dependency.kind,[],['generated.'+dependency.kind+'.read']);const item={...manifest,contributions:manifest.contributions!.map(value=>({...value,requires:[dependency]}))},instance=await f.configure(await f.install(await release(item,consumer)));
  assert.equal((await f.check(instance.id)).observed,'ready');assert.equal((await f.enable(instance.id)).observed,'ready');const pin=await f.node.bootstrap.host.acquire(serviceContract<{state():{provider:{items:number}}}>('generated.'+dependency.kind+'.read','1'),f.binding(instance.id,'generated.'+dependency.kind+'.read'));assert.equal(pin.value.state().provider.items,1);await pin.release();
 }
 await f.action(source.id,'disable');await until(()=>f.node.pluginCenter.instanceView(one.id).observed==='blocked','required consumer projects the revoked dependency');assert.equal(f.node.pluginCenter.buildView(one.id).active,null);assert.equal(f.node.pluginCenter.instanceView(one.id).desired,false);assert.equal(restored.signal.aborted,true);assert.throws(()=>restored.value.state(),withdrawn);
 await f.configure(providerPackage,'normal',source.id);await f.check(source.id);await f.enable(source.id);assert.equal(f.node.pluginCenter.instanceView(one.id).observed,'blocked','provider recovery never silently re-enables a consumer');assert.equal((await f.check(one.id)).observed,'ready');await f.enable(one.id);
 const replacement=await f.node.bootstrap.host.acquire(contract,f.binding(one.id,contract.id));assert.equal(replacement.value.state().provider.items,1);assert.notDeepEqual(restored.binding,replacement.binding);await replacement.release();await restored.release();await lease.release();
});

test('a typed data declaration needs no invented summary capability and its configuration check is invalidated on replacement',async t=>{
 const f=await fixture(t),base=declaration('generated.no-summary'),manifest={...base,capabilities:[],contributions:base.contributions!.map(({entry:_entry,...value})=>({...value,capabilities:[]}))};
 const pkg=await f.install(await release(manifest,provider)),instance=await f.configure(pkg);assert.ok(!instance.allowedActions.includes('enable'));
 assert.equal((await f.check(instance.id)).observed,'ready');assert.equal((await f.enable(instance.id)).observed,'ready');await f.restart();assert.equal(f.node.pluginCenter.instanceView(instance.id).observed,'ready');
 const lease=await f.node.bootstrap.host.acquire(serviceContract<{state():{items:unknown[]}}>('generated.domain.log','1'),f.binding(instance.id,'generated.domain.log'));assert.deepEqual(lease.value.state(),{items:[]});await f.action(instance.id,'disable');await lease.release();
 const replaced=await f.configure(pkg,'normal',instance.id);assert.ok(!replaced.allowedActions.includes('enable'),'a new configuration cannot reuse the old lifecycle check');assert.equal((await f.check(instance.id)).observed,'ready');
});

test('domain dependency resolution rejects ambiguous or incompatible live providers and keeps an absent optional dependency optional',async t=>{
 const f=await fixture(t),pkg=await f.install(await template(f)),a=await f.configure(pkg),b=await f.configure(pkg);for(const instance of [a,b]){await f.check(instance.id);await f.enable(instance.id);}
 const required=declaration('generated.ambiguous',[{kind:'service',id:'template.collection.log',version:'1'}],['generated.ambiguous.read']),bad=await f.configure(await f.install(await release(required,consumer))),ambiguous=await f.check(bad.id);assert.equal(ambiguous.observed,'blocked');assert.match(ambiguous.issues.join(','),/Ambiguous domain dependency/);
 await f.action(b.id,'disable');assert.equal((await f.check(bad.id)).observed,'ready');await f.enable(bad.id);await f.enable(b.id);await f.restart();assert.equal(f.node.pluginCenter.instanceView(bad.id).observed,'blocked','restart cannot choose whichever matching provider happens to restore first');assert.match(f.node.pluginCenter.instanceView(bad.id).issues.join(','),/Ambiguous domain dependency/);await f.action(b.id,'disable');
 const incompatible=declaration('generated.incompatible',[{kind:'service',id:'template.collection.log',version:'2'}],['generated.incompatible.read']),wrong=await f.configure(await f.install(await release(incompatible,consumer)));assert.equal((await f.check(wrong.id)).observed,'blocked');assert.match(f.node.pluginCenter.instanceView(wrong.id).issues.join(','),/api_incompatible/);
 const optional=declaration('generated.optional',[{kind:'service',id:'generated.missing',version:'1',required:false}],['generated.optional.read']),alone=await f.configure(await f.install(await release(optional,consumer)));assert.equal((await f.check(alone.id)).observed,'ready');assert.equal((await f.enable(alone.id)).observed,'ready');
 const lease=await f.node.bootstrap.host.acquire(serviceContract<{state():{required:number;optional:number}}>('generated.optional.read','1'),f.binding(alone.id,'generated.optional.read'));assert.deepEqual(lease.value.state(),{received:null,provider:null,required:0,optional:0});await lease.release();
});

test('domain checks and activation reject false ports, excess module declarations and lifecycle failures without removing a sibling',async t=>{
 const f=await fixture(t),manifest=declaration('generated.failures',[],['generated.domain.log','generated.domain.second']),pkg=await f.install(await release(manifest,provider));
 for(const mode of ['missing','extra-contribution','extra-port','wrong-api','undefined-port','invalid-contract','invalid-revision','prepare-failure','start-failure','check-write']){const instance=await f.configure(pkg,mode),checked=await f.check(instance.id);assert.equal(checked.observed,'blocked',mode);assert.ok(!checked.allowedActions.includes('enable'));assert.ok(!f.node.bootstrap.host.snapshot().contributions.some(value=>value.identity.scope.instanceId===instance.id));}
 const excess=declaration('generated.excess'),exported=descriptor(excess);exported.capabilities=['domain.state','generated.undeclared'];const invalid=await f.configure(await f.install(await release(excess,provider,exported)));assert.equal((await f.check(invalid.id)).observed,'blocked');
 const good=await f.configure(pkg);await f.check(good.id);await f.enable(good.id);const sibling=await f.node.bootstrap.host.acquire(serviceContract<{state():{items:unknown[]}}>('generated.domain.log','1'),f.binding(good.id,'generated.domain.log'));
 const failing=await f.configure(pkg,'partial');assert.equal((await f.check(failing.id)).observed,'ready');await f.control({partialFailure:true});assert.equal((await f.enable(failing.id)).observed,'blocked');assert.ok(!f.node.bootstrap.host.snapshot().contributions.some(value=>value.identity.scope.instanceId===failing.id));assert.deepEqual(sibling.value.state(),{items:[]});
 await f.control({});await f.restart();assert.equal(f.node.pluginCenter.instanceView(failing.id).observed,'blocked','failed activation needs an explicit owner retry');assert.equal(f.node.pluginCenter.instanceView(failing.id).desired,false);await sibling.release();
});

test('disable fences an accepted late state write and a suspended start, rolls back partial ports and leaves explicit retry available',async t=>{
 const f=await fixture(t),manifest=declaration('generated.lifecycle'),pkg=await f.install(await release(manifest,provider)),instance=await f.configure(pkg);await f.check(instance.id);await f.enable(instance.id);
 const contract=serviceContract<{add(input:{text:string}):Promise<{items:string[]}>;state():{items:string[]}}>('generated.domain.log','1'),lease=await f.node.bootstrap.host.acquire(contract,f.binding(instance.id,contract.id));await lease.value.add({text:'Generated retained'});
 await f.control({write:true});const pending=lease.value.add({text:'Generated withdrawn'});await f.entered('write');await f.action(instance.id,'disable');assert.equal(lease.signal.aborted,true);assert.throws(()=>lease.value.state(),{code:'stale_scope'});await f.control({});await assert.rejects(pending);await until(()=>!f.node.bootstrap.host.snapshot().contributions.some(value=>value.identity.scope.instanceId===instance.id),'disabled scope drains');
 await f.check(instance.id);await f.enable(instance.id);const restored=await f.node.bootstrap.host.acquire(contract,f.binding(instance.id,contract.id));assert.deepEqual(restored.value.state().items,['Generated retained'],'late compareAndSet cannot persist after withdrawal');await f.action(instance.id,'disable');await restored.release();await lease.release();
 const suspended=await f.configure(pkg,'start');await f.check(suspended.id);await f.control({start:true});await f.action(suspended.id,'enable');await f.entered('start');assert.equal(f.node.pluginCenter.buildView(suspended.id).active,null);const build=f.node.pluginCenter.buildView(suspended.id),stop=f.request('PATCH','/api/plugin-builds/'+suspended.id,{...command(build.revision),selection:null});await until(()=>!f.node.pluginCenter.instanceView(suspended.id).desired,'pending selection is withdrawn before start returns');await f.control({});assert.equal((await stop).observed,'stopped');assert.ok(!f.node.bootstrap.host.snapshot().contributions.some(value=>value.identity.scope.instanceId===suspended.id));assert.equal((await readFile(f.controlFile+'.lifecycle-disposed.'+suspended.id,'utf8')).trim().split('\n').length,2,'check and the cancelled activation each dispose exactly once');assert.equal((await f.enable(suspended.id)).observed,'ready','a new explicit enable owns a new scope');
 const late=await f.configure(pkg,'factory');await f.check(late.id);await f.control({factory:true});await f.action(late.id,'enable');await f.entered('factory');const pendingBuild=f.node.pluginCenter.buildView(late.id),closing=f.request('PATCH','/api/plugin-builds/'+late.id,{...command(pendingBuild.revision),selection:null});await until(()=>!f.node.pluginCenter.instanceView(late.id).desired,'pending factory loses authority before its result arrives');await f.control({});assert.equal((await closing).observed,'stopped');assert.equal((await readFile(f.controlFile+'.lifecycle-disposed.'+late.id,'utf8')).trim().split('\n').length,2,'the late factory result is adopted for disposal before cancellation is reported');assert.ok(!f.node.bootstrap.host.snapshot().contributions.some(value=>value.identity.scope.instanceId===late.id));
});

test('provider withdrawal before installation receipt consumption cannot project a revoked domain consumer ready',async t=>{
 const f=await fixture(t),pkg=await f.install(await template(f)),source=await f.configure(pkg);await f.check(source.id);await f.enable(source.id);
 const manifest=declaration('generated.receipt-race',[{kind:'service',id:'template.collection.log',version:'1'}],['generated.receipt-race.read']),instance=await f.configure(await f.install(await release(manifest,consumer)));assert.equal((await f.check(instance.id)).observed,'ready');
 const host=f.node.bootstrap.host,original=host.install.bind(host),contract=serviceContract<{state():{provider:{items:number}}}>('generated.receipt-race.read','1');let withdrawnBeforeReceipt=false,returnedSignal:AbortSignal|undefined;
 t.mock.method(host,'install',async(definition:Parameters<typeof host.install>[0])=>{
  const handle=await original(definition);
  if(definition.identity.instanceId===instance.id&&!withdrawnBeforeReceipt){
   withdrawnBeforeReceipt=true;returnedSignal=handle.signal;const lease=await host.acquire(contract,{service:contract,provider:{scope:handle.identity,contributionId:manifest.contributions![0]!.id},revision:0});assert.equal(lease.value.state().provider.items,0,'the actual typed consumer completed startup before the receipt is intercepted');
   await f.action(source.id,'disable');assert.equal(handle.signal.aborted,true,'the real host withdraws the required consumer before Plugin Center sees the handle');assert.equal(lease.signal.aborted,true);assert.throws(()=>lease.value.state(),withdrawn);await lease.release();
  }
  return handle;
 });
 const result=await f.enable(instance.id);assert.equal(withdrawnBeforeReceipt,true);assert.equal(returnedSignal?.aborted,true);assert.equal(result.observed,'blocked',JSON.stringify(result));assert.equal(result.desired,false);assert.ok(result.issues.length);assert.equal(f.node.pluginCenter.buildView(instance.id).active,null);assert.ok(!host.snapshot().contributions.some(value=>value.identity.scope.instanceId===instance.id));
 await f.enable(source.id);assert.equal(f.node.pluginCenter.instanceView(instance.id).observed,'blocked','dependency recovery does not silently retry the rejected consumer receipt');assert.equal((await f.check(instance.id)).observed,'ready');assert.equal((await f.enable(instance.id)).observed,'ready');const fresh=await host.acquire(contract,f.binding(instance.id,contract.id));assert.equal(fresh.value.state().provider.items,0);await fresh.release();
});

test('normal shutdown during a suspended domain start preserves the owner selection and restores the same instance',async t=>{
 const f=await fixture(t),manifest=declaration('generated.shutdown-race'),pkg=await f.install(await release(manifest,provider)),instance=await f.configure(pkg,'start');assert.equal((await f.check(instance.id)).observed,'ready');
 const identity=f.node.pluginCenter.instanceIdentity(instance.id);await f.control({start:true});await f.action(instance.id,'enable');await f.entered('start');assert.equal(f.node.pluginCenter.instanceView(instance.id).desired,true);assert.equal(f.node.pluginCenter.buildView(instance.id).active,null);
 const closing=f.node.pluginCenter.close();await f.control({});await closing;
 const row=f.node.store.db.prepare('SELECT json FROM plugin_build_instances WHERE id=?').get(instance.id)!,record=JSON.parse(String(row.json));assert.equal(record.instance.view.desired,true,JSON.stringify(record.instance.view));assert.ok(record.desired,'normal shutdown retains the durable build selection');assert.notEqual(record.instance.view.observed,'blocked');assert.deepEqual(record.instance.view.issues,[]);assert.ok(!f.node.bootstrap.host.snapshot().contributions.some(value=>value.identity.scope.instanceId===instance.id));assert.equal((await readFile(f.controlFile+'.lifecycle-disposed.'+instance.id,'utf8')).trim().split('\n').length,2,'check and the interrupted startup each dispose exactly once');
 await f.restart();assert.deepEqual(f.node.pluginCenter.instanceIdentity(instance.id),identity);assert.equal(f.node.pluginCenter.instanceView(instance.id).observed,'ready','the preserved selection restarts without a new owner enable');assert.equal(f.node.pluginCenter.instanceView(instance.id).desired,true);const contract=serviceContract<{add(input:{text:string}):Promise<{items:string[]}>}>('generated.domain.log','1'),lease=await f.node.bootstrap.host.acquire(contract,f.binding(instance.id,contract.id));assert.deepEqual((await lease.value.add({text:'Generated after restart'})).items,['Generated after restart']);await lease.release();
});
