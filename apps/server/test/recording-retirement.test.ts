import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecordingConnector,type RecordingProvider,type ConnectorContext} from '../src/connectors/index.js';
import {Store} from '../src/store.js';
import {connectorReader} from './fixtures/connector-reader.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {MaterialStore} from '../src/materials.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';
import {feishuTranscript} from '../src/connectors/recording-formats.js';

function deferred(){let resolve!:()=>void;return {promise:new Promise<void>(done=>resolve=done),resolve};}
for(const phase of ['account','discover','metadata','transcript','media'] as const)test(`recording close waits for an uncooperative ${phase} call before retiring its provider while shared siblings continue`,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-recording-retirement-')),store=new Store(directory),materials=new MaterialStore(store),engine=new ExecutionEngine(store),pipelines=new SourcePipelineRuntime(store,materials,[],undefined,engine);await pipelines.ready;
 const sources=new SourceStore(store,pipelines),files=new FileStore(store,sources),entered=deferred(),held=deferred();let enabled=false,exited=false,retired=0,sibling=0;
 sources.capabilities.register('generated.recordings',{lifecycle:'continuous',discovery:'provider-list',listening:'polling',readOriginal:'explicit-provider-read',synchronization:'revisions',externalWrite:false});
 const wait=async(boundary:typeof phase)=>{if(enabled&&boundary===phase){entered.resolve();await held.promise;exited=true;}};
 const raw='Generated diary\n\nOwner 00:00:00.000\nI prepared a generated plan.\n';
 const provider:RecordingProvider={id:'generated',version:'fixture@1',account:async()=>{await wait('account');return {id:'generated-owner'};},discover:async()=>{await wait('discover');return {ids:['original'],...(phase==='discover'?{next:'late-page'}:{})};},metadata:async()=>{await wait('metadata');return {id:'original',title:'Generated diary',durationMs:5000,recordedAt:'2026-09-20T00:00:00Z'};},transcript:async()=>{await wait('transcript');return {rawText:raw,transcript:feishuTranscript(raw,5000)};},media:async()=>{await wait('media');return {mimeType:'audio/wav',bytes:Buffer.concat([Buffer.from('RIFF0000WAVE'),Buffer.alloc(200)])};},close:async()=>{assert.equal(exited,true);retired++;}};
 const context:ConnectorContext={evidenceReader:connectorReader(store,sources),store,sources,files,sourcePipelines:pipelines,config:{dataDir:directory,token:'generated-owner-token',allowedOrigins:[],connectors:{directory}}},connector=new RecordingConnector(context,provider);
 const prepare=store.db.prepare.bind(store.db);let restore=()=>{};
 t.after(async()=>{restore();held.resolve();await connector.close();await files.close();await pipelines.close();await materials.index?.close();await engine.close();store.close();await rm(directory,{recursive:true,force:true});});
 const disposeSibling=engine.register({kind:'generated.sibling',pool:'generated.sibling',policy:EXECUTION_POLICIES.localProcessing,concurrency:()=>1,validate:()=>true,execute:async()=>null,commit:()=>{sibling++;}});t.after(disposeSibling);
 await connector.init();await connector.connect();enabled=true;
 await connector.select({enabled:true,start:'2026-09-01T00:00:00Z',end:'2026-10-01T00:00:00Z',autoSync:false,backupAudio:true});await entered.promise;
 const first=connector.close(),second=connector.close();assert.equal(first,second);let closed=false;void first.then(()=>{closed=true;});
 const id=engine.enqueue('generated-sibling-during-close','generated.sibling',{});await engine.drain([id]);
 assert.equal(sibling,1);assert.equal(retired,0);assert.equal(closed,false);assert.equal(store.db.isOpen,true);
 assert.throws(()=>connector.sync(),/connector_closed/);assert.throws(()=>connector.retry(),/connector_closed/);
 // All logical wrappers have retired; only the issued provider call remains.
 // Releasing it must not re-enter SQLite, even for its late pagination/receipt.
 let lateReads=0;store.db.prepare=(()=>{lateReads++;throw Error('Late recording callback entered SQLite');}) as typeof store.db.prepare;restore=()=>{store.db.prepare=prepare;};
 held.resolve();await first;restore();assert.equal(lateReads,0);assert.equal(retired,1);assert.equal(closed,true);
 assert.equal(connector.close(),first);await first;
 const after=engine.enqueue('generated-sibling-after-close','generated.sibling',{});await engine.drain([after]);assert.equal(sibling,2);
});

test('recording cleanup reports every disposer failure and still closes engine, provider and credential file exactly once',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-recording-cleanup-')),store=new Store(directory),sources=new SourceStore(store);
 const errors=[Error('generated unregister failure'),Error('generated engine failure'),Error('generated provider failure'),Error('generated credential flush failure')];let engineClosed=0,providerClosed=0,flushed=0,unregistered=0;
 const provider:RecordingProvider={id:'generated',version:'fixture@1',account:async()=>({id:'generated-owner'}),discover:async()=>({ids:[]}),metadata:async()=>{throw Error('unused');},transcript:async()=>{throw Error('unused');},media:async()=>{throw Error('unused');},close:async()=>{providerClosed++;throw errors[2];}};
 const connector=new RecordingConnector({store,sources,config:{dataDir:directory,token:'generated-owner-token',allowedOrigins:[],connectors:{directory}}},provider);
 t.after(async()=>{await connector.close().catch(()=>{});store.close();await rm(directory,{recursive:true,force:true});});
 await connector.init();
 const runtime=connector as unknown as {disposers:Array<()=>Promise<void>>;file:{flush():Promise<void>}};
 runtime.disposers=runtime.disposers.map((dispose,index)=>async()=>{unregistered++;await dispose();if(index===0)throw errors[0];});
 const closeEngine=connector.engine.close.bind(connector.engine);t.mock.method(connector.engine,'close',async()=>{engineClosed++;await closeEngine();throw errors[1];});
 const flush=runtime.file.flush.bind(runtime.file);t.mock.method(runtime.file,'flush',async()=>{flushed++;await flush();throw errors[3];});
 const first=connector.close(),second=connector.close();assert.equal(first,second);
 await assert.rejects(first,error=>error instanceof AggregateError&&assert.deepEqual(error.errors,errors)===undefined);
 assert.equal(unregistered,4);assert.equal(engineClosed,1);assert.equal(providerClosed,1);assert.equal(flushed,1);
 assert.equal(connector.close(),first);await assert.rejects(first,AggregateError);assert.equal(store.db.isOpen,true);
});
