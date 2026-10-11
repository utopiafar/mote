import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {Store} from '../src/store.js';
import {MemoryStore} from '../src/memory.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases,type PluginManifest} from '../src/plugin-release.js';
import {MemoryAdapters} from '../src/memory-adapters.js';
import {MemoryBindings} from '../src/memory-bindings.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {ModelSettingsStore} from '../src/model-settings.js';
import {memorySchema} from '../src/memory-schema.js';
import {memoryProviderKey} from '../src/memory-provider-contract.js';

// A generated compatible release exercises the actual installer, configured
// child process, MemoryAdapters canary and plan mapping. It is not a claim about
// a real GitHub community package, semantic ranking or a complete engine.
const worker=String.raw`import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export async function createMemoryProvider(config){
 const path=config.directory+'/records.json';let state={records:[],ops:{}};if(config.mode!=='volatile')try{state=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const save=()=>config.mode==='volatile'?Promise.resolve():writeFile(path,JSON.stringify(state));
 const result=(input,status)=>({opId:input.opId,namespace:input.namespace,key:input.key,payloadDigest:hash({namespace:input.namespace,key:input.key,...(status==='applied'?{memory:input.memory}:{})}),state:status,eraseVerified:false,recordedAt:'2026-10-12T00:00:00Z',...(status==='removed'?{currentRemoved:true}: {})});
 return {
  async health(){await writeFile(config.directory+'/self-health-called','generated-only');return {providerId:'generated.plugin',version:'1.0.0',ready:true,verified:{persistentCrud:true,scopedRetrieval:true,immutableRecords:true,idempotentReplay:true,history:true,physicalErase:true},problems:[]};},
  async put(input){const payload=hash(input),prior=state.ops[input.opId];if(prior){if(prior.payload!==payload)throw Error('op_conflict');return prior.receipt;}const priorRecord=state.records.find(r=>same(r.namespace,input.namespace)&&same(r.key,input.key));if(priorRecord&&!same(priorRecord.memory,input.memory))throw Error('immutable_conflict');if(!priorRecord)state.records.push({namespace:input.namespace,key:input.key,memory:input.memory});const receipt=result(input,'applied');state.ops[input.opId]={payload,receipt};await save();return receipt;},
  async read(input){return state.records.find(r=>same(r.namespace,input.namespace)&&same(r.key,input.key))?.memory??null;},
  async search(input){return state.records.filter(r=>same(r.namespace,input.namespace)&&(input.keys===undefined||input.keys.some(k=>same(k,r.key)))).slice(0,input.limit??10);},
  async export(input){return state.records.filter(r=>same(r.namespace,input.namespace));},
  async remove(input){const payload=hash(input),prior=state.ops[input.opId];if(prior){if(prior.payload!==payload)throw Error('op_conflict');return prior.receipt;}state.records=state.records.filter(r=>!(same(r.namespace,input.namespace)&&same(r.key,input.key)));const receipt=result(input,'removed');state.ops[input.opId]={payload,receipt};await save();return receipt;},
  async close(){}
 };
}`;
for(const mode of ['persistent','volatile'])test('real adapter wiring checks '+mode+' third-party release without accepting engine selfclaims',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-adapter-wiring-')),vault=join(directory,'vault'),stateDirectory=join(directory,'plugin-state');await mkdir(stateDirectory,{mode:0o700});
 const store=new Store(vault),executor=new ExecutionEngine(store),archive=zipSync({'provider.mjs':strToU8(worker)}),digest=createHash('sha256').update(archive).digest('hex'),repo='generated/adapter',tag='v1.0.0',base=`https://github.com/${repo}/releases/download/${tag}/`;
 const manifest:PluginManifest={schemaVersion:1,id:'generated.adapter',name:'Generated compatible adapter',version:'1.0.0',runtime:'worker',entry:'provider.mjs',archive:{asset:'adapter.zip',sha256:digest},capabilities:['repository','retrieval','engine'],configuration:[{id:'directory',label:'Generated private storage',type:'text',required:true},{id:'mode',label:'Fixture mode',type:'text',required:true}],dependencies:[],access:['Generated fixture directory']};
 const releases=new GitHubPluginReleases(join(vault,'plugins/packages'),async url=>({bytes:url.endsWith('/releases/tags/'+tag)?strToU8(JSON.stringify({tag_name:tag,draft:false,assets:[{name:'mote-plugin.json',browser_download_url:base+'mote-plugin.json'},{name:'adapter.zip',browser_download_url:base+'adapter.zip'}]})):url.endsWith('/commits/'+tag)?strToU8(JSON.stringify({sha:'a'.repeat(40)})):url===base+'mote-plugin.json'?strToU8(JSON.stringify(manifest)):url===base+'adapter.zip'?archive:(()=>{throw Error('Unexpected generated release request');})()}));
 const plugins=new PluginCenter(store,executor,releases),models=new ModelSettingsStore({directory:join(directory,'model-settings'),environment:{provider:'custom',protocol:'openai-completions',baseUrl:'https://generated.invalid/v1',model:'generated-unused',reasoningEffort:'auto',maxTokens:1024,modelRequestTimeoutMs:5000,agentTimeoutMs:5000,allowUnauthenticatedLocal:false,apiKey:'',headers:{},extraBody:{}},prepare:async()=>({activate(){},async dispose(){}}),probe:async()=>{throw Error('A storage canary must not call a model');}}),adapters=new MemoryAdapters(join(vault,'plugins/instances'),plugins,models),bindings=new MemoryBindings(store,new MemoryStore(store),new MemoryAutomation(store),plugins,executor);
 plugins.probe=(id,signal)=>adapters.probe(id,signal);plugins.configurationAllowed=(type,value)=>adapters.configurationAllowed(type,value);bindings.providerFactory=id=>adapters.provider(id);
 t.after(async()=>{await bindings.close();await adapters.close();await plugins.close();await executor.close();await models.close();store.close();await rm(directory,{recursive:true,force:true});});await models.initialize();
 const preview=await plugins.resolve({repository:repo,tag}),installId=randomUUID();plugins.install({previewId:preview.id,expectedRevision:plugins.revision(),operationId:installId});await executor.drain(['plugin-install:'+installId]);assert.equal(plugins.view().packages[0].state,'installed');
 const instanceId=randomUUID();plugins.configure(undefined,{packageId:plugins.view().packages[0].id,name:'Generated '+mode,scope:'default',configuration:{directory:stateDirectory,mode},expectedRevision:plugins.revision(),operationId:instanceId});const checkId=randomUUID();plugins.action(instanceId,'check',{expectedRevision:plugins.instanceView(instanceId).revision,operationId:checkId});await executor.drain(['plugin-check:'+checkId]);
 const checked=plugins.instanceView(instanceId);assert.equal(checked.capabilities.find(c=>c.id==='engine')?.state,'unsupported','engine selfclaims never make the unsupported ABI available');await assert.rejects(readFile(join(stateDirectory,'self-health-called')),{code:'ENOENT'},'host checks never call worker-declared health');
 if(mode==='persistent'){
  assert.equal(checked.observed,'ready');assert.equal(checked.capabilities.find(c=>c.id==='repository')?.state,'verified');assert.equal(checked.capabilities.find(c=>c.id==='retrieval')?.state,'verified');plugins.action(instanceId,'enable',{expectedRevision:checked.revision,operationId:randomUUID()});const plan=bindings.plans().find(p=>p.instanceId===instanceId)!;assert.equal(plan.available,true);assert.equal(plan.mode,'modules');assert.equal(plan.modules.find(m=>m.stage==='review')?.id,'mote.review');assert.equal(plan.modules.find(m=>m.stage==='extract')?.id,'mote.extract');assert.equal(plan.modules.find(m=>m.stage==='repository')?.instanceId,instanceId);
  const namespace={ownerId:'generated-owner',instanceId,bindingRevision:22},memory=memorySchema.parse({id:randomUUID(),version:1,fingerprint:'b'.repeat(64),createdAt:'2026-10-12T00:00:00Z',title:'Generated old configuration',statement:'Only configuration A owns this generated record.',uncertainty:'Generated transport fixture',status:'published',domain:'personal',tier:'episode',kind:'episodic',model:'fixture',runId:'fixture',evidenceIds:[randomUUID()],evidence:[],admission:{layer:'memory',reason:'Generated',scope:'Generated only',attribution:'observed'}});await adapters.provider(instanceId,namespace).put({namespace,key:memoryProviderKey(memory),memory,opId:randomUUID()});
  plugins.action(instanceId,'disable',{expectedRevision:plugins.instanceView(instanceId).revision,operationId:randomUUID()});const nextDirectory=join(directory,'new-config-state');await mkdir(nextDirectory,{mode:0o700});plugins.configure(instanceId,{name:'Generated new config',scope:'default',configuration:{directory:nextDirectory,mode},expectedRevision:plugins.instanceView(instanceId).revision,operationId:randomUUID()});await adapters.close();
  const restarted=new MemoryAdapters(join(vault,'plugins/instances'),plugins,models);try{assert.equal(await restarted.provider(instanceId).read({namespace,key:memoryProviderKey(memory)}),null,'current B runtime has no A data');assert.deepEqual(await restarted.provider(instanceId,namespace).read({namespace,key:memoryProviderKey(memory)}),memory,'old namespace recreates its exact fixed generic worker configuration');await restarted.provider(instanceId,namespace).remove({namespace,key:memoryProviderKey(memory),opId:randomUUID()});assert.equal(await restarted.provider(instanceId,namespace).read({namespace,key:memoryProviderKey(memory)}),null);}finally{await restarted.close();}
 }else{
  assert.equal(checked.observed,'blocked');assert.equal(checked.capabilities.find(c=>c.id==='repository')?.state,'unknown');assert.ok(!checked.allowedActions.includes('enable'));assert.throws(()=>plugins.action(instanceId,'enable',{expectedRevision:checked.revision,operationId:randomUUID()}),/unavailable/);assert.equal(bindings.plans().find(p=>p.instanceId===instanceId)?.available,false);
 }
});
