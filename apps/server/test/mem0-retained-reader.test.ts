import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {zipSync,strToU8} from 'fflate';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {PluginCenter} from '../src/plugin-center.js';
import {GitHubPluginReleases} from '../src/plugin-release.js';
import {MemoryAdapters} from '../src/memory-adapters.js';
import {ModelSettingsStore} from '../src/model-settings.js';
import {memorySchema} from '../src/memory-schema.js';
import {memoryProviderKey} from '../src/memory-provider-contract.js';

// The release and embedding transport are generated fixtures. The installer,
// profile mutation, fixed SDK subprocess and its SQLite history are real.
// Constant vectors prove persistence/authorization, not semantic quality.
for(const change of ['deleted','cleared'] as const)test('Mem0 retained literal history survives '+change+' embedding profile without sending cached credentials',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-mem0-retained-reader-')),vault=join(directory,'vault'),store=new Store(vault),executor=new ExecutionEngine(store);let embeddingRequests=0;
 const endpoint=createServer(async(req,res)=>{embeddingRequests++;let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw).input,texts=Array.isArray(input)?input:[input];res.setHeader('content-type','application/json');res.end(JSON.stringify({data:texts.map((_:unknown,index:number)=>({index,object:'embedding',embedding:[1,0,0]}))}));});await new Promise<void>(resolve=>endpoint.listen(0,'127.0.0.1',resolve));
 const archive=zipSync({'generated-source/README.md':strToU8('Generated pinned upstream provenance')}),releases=new GitHubPluginReleases(join(vault,'plugins/packages'),async url=>({bytes:url.endsWith('/releases/tags/ts-v3.3.1')?strToU8(JSON.stringify({tag_name:'ts-v3.3.1',draft:false,assets:[]})):url.endsWith('/commits/ts-v3.3.1')?strToU8(JSON.stringify({sha:'a'.repeat(40)})):url.endsWith('/zipball/'+'a'.repeat(40))?archive:(()=>{throw Error('Unexpected generated release request');})()})),plugins=new PluginCenter(store,executor,releases);
 const settings={provider:'custom',protocol:'openai-completions' as const,baseUrl:'https://generated.invalid/v1',model:'generated-unused',reasoningEffort:'auto' as const,maxTokens:1024,modelRequestTimeoutMs:5000,agentTimeoutMs:5000,allowUnauthenticatedLocal:false,apiKey:'generated-fixture-credential',headers:{},extraBody:{}},models=new ModelSettingsStore({directory:join(directory,'models'),environment:settings,prepare:async()=>({activate(){},async dispose(){}}),probe:async()=>{throw Error('No language model belongs in this storage journey');}});await models.initialize();await models.updateProfile('generated-embedding',{revision:models.view().revision,name:'Generated embedding credential',settings});
 let adapters=new MemoryAdapters(join(vault,'plugins/instances'),plugins,models);plugins.configurationAllowed=(field,value)=>adapters.configurationAllowed(field.type,value);
 t.after(async()=>{await adapters.close();await plugins.close();await executor.close();await models.close();store.close();endpoint.closeAllConnections();await new Promise<void>(resolve=>endpoint.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
 const preview=await plugins.resolve({repository:'mem0ai/mem0'}),installId=randomUUID();plugins.install({previewId:preview.id,operationId:installId,expectedRevision:plugins.revision()});await executor.drain(['plugin-install:'+installId]);
 const packageId=plugins.view().packages[0]!.id,instanceId=randomUUID(),uninitializedId=randomUUID(),configuration={embeddingBaseUrl:`http://127.0.0.1:${(endpoint.address() as {port:number}).port}/v1`,embeddingModel:'generated-vector',embeddingDimension:3,embeddingSecretReference:'model:generated-embedding'};
 for(const id of [instanceId,uninitializedId])plugins.configure(undefined,{packageId,name:'Generated '+id,scope:'default',configuration,expectedRevision:plugins.revision(),operationId:id});
 const namespace={ownerId:'generated-owner',instanceId,bindingRevision:4},identity=adapters.configurationIdentity(instanceId,namespace),memory=memorySchema.parse({id:randomUUID(),version:1,title:'Generated observatory',statement:'The generated observatory uses a silver telescope.',uncertainty:'Generated fixture only',status:'published',domain:'personal',tier:'episode',kind:'episodic',createdAt:'2026-10-12T00:00:00Z',evidenceIds:[randomUUID()],evidence:[],model:'fixture',runId:'fixture',fingerprint:'b'.repeat(64),admission:{layer:'memory',reason:'Generated',scope:'Generated only',attribution:'observed'}}),key=memoryProviderKey(memory),cached=adapters.provider(instanceId,namespace);
 await cached.put({namespace,key,memory,opId:randomUUID()});assert.equal((await cached.recover({namespace})).ready,true);assert.equal((await cached.health({namespace})).ready,true);const calls=embeddingRequests;assert.ok(calls>0);
 if(change==='deleted')await models.deleteProfile('generated-embedding',{revision:models.view().revision});else await models.updateProfile('generated-embedding',{revision:models.view().revision,name:'Generated cleared credential',settings:{...settings,apiKey:''}});
 const isCredentialError=(error:unknown)=>change==='deleted'?(error as {code?:string}).code==='model_profile_missing':(error as Error).message==='The credential reference is empty';
 const assertEmbeddingBlocked=async(provider:typeof cached)=>{await assert.rejects(provider.put({namespace,key,memory,opId:randomUUID()}),isCredentialError);await assert.rejects(provider.search({namespace,query:'Which instrument observes stars?'}),isCredentialError);await assert.rejects(provider.recover({namespace}),isCredentialError);};
 await assertEmbeddingBlocked(cached);assert.equal((await cached.health({namespace})).ready,false,'old health observations cannot certify a missing current embedding credential');assert.deepEqual(await cached.read({namespace,key}),memory);assert.equal((await cached.export({namespace})).length,1);assert.equal(embeddingRequests,calls,'cached SDK never submits another embedding with the retired key');
 await adapters.close();adapters=new MemoryAdapters(join(vault,'plugins/instances'),plugins,models);const retained=adapters.provider(instanceId,namespace);
 assert.equal(adapters.configurationIdentity(instanceId,namespace),identity,'literal fallback keeps the exact configuration generation');assert.deepEqual(await retained.read({namespace,key}),memory);assert.deepEqual((await retained.export({namespace})).map(record=>record.memory),[memory]);await assertEmbeddingBlocked(retained);assert.equal((await retained.health({namespace})).ready,false,'literal startup does not certify embedding capabilities');
 assert.throws(()=>adapters.provider(uninitializedId,{...namespace,instanceId:uninitializedId}),isCredentialError,'a new configuration with no native history must not use literal fallback');
 const removed=await retained.remove({namespace,key,opId:randomUUID()});assert.equal(removed.currentRemoved,true);assert.equal(removed.eraseVerified,false);assert.equal(await retained.read({namespace,key}),null);assert.equal((await retained.export({namespace})).length,0);assert.equal(embeddingRequests,calls,'cold read/export/remove perform zero embedding requests');
});
