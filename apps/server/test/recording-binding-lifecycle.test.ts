import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {RecordingConnector,type RecordingBindingGrant,type RecordingProvider} from '../src/connectors/recordings.js';
import {RecordingAuthorization} from '../src/plugins/recording-authorization.js';
import type {ConnectorContext} from '../src/connectors/types.js';
function deferred<T=void>(){let resolve!:(value:T)=>void;return {promise:new Promise<T>(done=>resolve=done),resolve};}
async function fixture(t:import('node:test').TestContext){const directory=await mkdtemp(join(tmpdir(),'mote-binding-lifecycle-')),store=new Store(directory),sources=new SourceStore(store),state={account:'generated-one',held:undefined as Promise<void>|undefined,entered:undefined as (()=>void)|undefined};
 sources.capabilities.register('feishu.recordings',{lifecycle:'continuous',discovery:'provider-list',listening:'polling',readOriginal:'explicit-provider-read',synchronization:'revisions',externalWrite:false});
 const provider:RecordingProvider={id:'feishu',version:'generated',account:async()=>{state.entered?.();if(state.held)await state.held;return {id:state.account};},discover:async()=>({ids:[]}),metadata:async()=>{throw Error('unused');},transcript:async()=>{throw Error('unused');},media:async()=>{throw Error('unused');}};
 const context={store,sources,config:{dataDir:directory,token:'generated-owner-token',allowedOrigins:[],connectors:{directory}}},connector=new RecordingConnector(context,provider);await connector.init();t.after(async()=>{await connector.close();store.close();await rm(directory,{recursive:true,force:true});});return {connector,context,store,sources,state,directory};}
for(const window of ['account','written'] as const)for(const action of ['cancel','disconnect','close','configure'] as const)test(`${action} during ${window} prevents late recording binding registration`,async t=>{
 const f=await fixture(t),entered=deferred(),held=deferred(),controller=new AbortController(),grant:RecordingBindingGrant={signal:controller.signal,assertCurrent:()=>controller.signal.throwIfAborted()};
 if(window==='account'){f.state.entered=()=>entered.resolve();f.state.held=held.promise;}else{const file=(f.connector as any).file,write=file.write.bind(file);let first=true;file.write=async(value:unknown)=>{await write(value);if(first){first=false;entered.resolve();await held.promise;}};}
 const pending=f.connector.connect(grant);await entered.promise;let stop:Promise<unknown>|undefined;
 if(action==='cancel')controller.abort();if(action==='disconnect')stop=f.connector.disconnect();if(action==='close')stop=f.connector.close();if(action==='configure')stop=f.connector.retireAuthorization({signal:new AbortController().signal,assertCurrent:()=>{}});
 held.resolve();await assert.rejects(pending);await stop;assert.equal(f.connector.status().connected,false);assert.ok(f.sources.listSources().every(source=>!source.enabled));
 const disk=JSON.parse(await readFile(join(f.directory,'feishu-recordings.json'),'utf8').catch(()=>'{"selection":{"enabled":false}}'));assert.equal(disk.account,undefined);assert.equal(disk.selection.enabled,false);
});

for(const action of ['cancel','close'] as const)test('rollback failure after '+action+' retires unsafe binding instead of reopening its prior source',async t=>{
 const f=await fixture(t);await f.connector.connect();await f.connector.select({enabled:true,start:'2026-10-01T00:00:00Z',autoSync:false,backupAudio:true});
 const file=(f.connector as any).file,write=file.write.bind(file),entered=deferred(),held=deferred(),controller=new AbortController();let writes=0;
 file.write=async(value:unknown)=>{if(++writes>1)throw Error('Generated rollback write failure');await write(value);entered.resolve();await held.promise;};f.state.account='generated-two';
 const pending=f.connector.connect({signal:controller.signal,assertCurrent:()=>controller.signal.throwIfAborted()});await entered.promise;let closing:Promise<void>|undefined;if(action==='cancel')controller.abort();else closing=f.connector.close();held.resolve();await assert.rejects(pending,{code:'recording_binding_write_failed'});await closing;assert.ok(f.sources.listSources().every(source=>!source.enabled));await assert.rejects(readFile(join(f.directory,'feishu-recordings.json')),{code:'ENOENT'});
});

test('old cancel cannot cancel a new authorization and check drains before configuration',async t=>{
 const f=await fixture(t),entered=deferred(),released=deferred();let configured=false,checks=0;const manager=new RecordingAuthorization(f.connector,{check:async signal=>{checks++;entered.resolve();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>released.promise.then(resolve),{once:true}));return {installed:true,configured:true};},configure:async()=>{configured=true;},login:async()=>{}});
 const checking=manager.check();await entered.promise;const initial=manager.status();manager.start('configure',{operationId:randomUUID(),expectedRevision:initial.revision,payload:{}});assert.equal(configured,false);released.resolve();await checking;
 for(let i=0;i<20&&!configured;i++)await new Promise(resolve=>setTimeout(resolve,2));assert.equal(configured,true);
 await manager.close();assert.ok(checks>=1);
 const other=new RecordingAuthorization(f.connector,{check:async()=>({installed:true,configured:true}),login:async signal=>new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))});
 const first=other.start('login',{operationId:randomUUID(),expectedRevision:other.status().revision});await other.cancel({expectedRevision:first.revision,taskId:first.task!.id});const second=other.start('login',{operationId:randomUUID(),expectedRevision:other.status().revision});await assert.rejects(other.cancel({expectedRevision:first.revision,taskId:first.task!.id}),{code:'recording_authorization_changed'});assert.equal(other.status().task!.id,second.task!.id);await other.close();
});


test('recording runtime projects only used capabilities and retains owned engine close',async t=>{
 const f=await fixture(t),context=(f.connector as unknown as {ctx:import('../src/connectors/recording-context.js').RecordingContext}).ctx;
 assert.deepEqual(Object.keys(context).sort(),['archives','closeEngine','configureDefaults','directory','engine','sources','state','syncIntervalMs','work']);
 for(const object of [context,context.sources,context.archives,context.engine,context.state,context.work]){
  assert.equal('store' in object,false);assert.equal('db' in object,false);assert.equal('config' in object,false);assert.equal('token' in object,false);assert.equal('capabilities' in object,false);
 }
 assert.deepEqual(Object.keys(context.engine).sort(),['cancelKind','drain','enqueue','get','register','retry','tick']);
 await f.connector.connect();assert.equal(f.connector.status().connected,true);
 await f.connector.close();assert.ok(f.sources.listSources().length===1);
 await assert.rejects(f.connector.connect(),/recording_binding_changed/);
});
