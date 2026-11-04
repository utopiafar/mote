import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {MaterialStore} from '../src/materials.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {createProcessingServices,type ProcessingServicesDependencies} from '../src/plugins/processing-services.js';
import {fileProcessingSchema} from '@mote/shared';

const token='generated-prc01-owner',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false});
const record=(text='Generated processing plugin evidence')=>({id:randomUUID(),deviceId:'generated-prc01-device',deviceName:'Generated fixture',platform:'import',capturedAt:'2026-11-01T00:00:00Z',durationMs:0,source:'note' as const,appName:'Fixture',ocrText:text,privacy:{excluded:false,redacted:false,mode:'none'}});
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const fixtureFingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)??'null').digest('hex');

test('processing disables without admitting writes, drains accepted work and re-enables one durable runtime',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-prc01-lifecycle-'));
  let node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in generated fixture');},close:async()=>{}}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const source=record(),calls:{id:string}[]=[];
  await node.store.ingest(source);
  let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  node.workflows.registry.register({id:'generated.prc01-lifecycle',version:'1',lane:'extract',async process(){calls.push({id:'accepted'});entered();await held;return [{kind:'text',text:'Generated accepted output',metadata:{}}];}});
  const accepted=await node.app.inject({method:'POST',url:'/api/processing/workflows',headers,payload:{steps:[{name:'one',processor:'generated.prc01-lifecycle',inputs:[source.id]}]}});
  assert.equal(accepted.statusCode,202,accepted.body);
  const id=(accepted.json() as {one:string}).one;
  const running=node.processingServices.tick();
  await started;
  node.processingServices.quiesce('disabled');
  assert.equal(node.processingServices.port.phase,'quiescing');
  const rejected=await node.app.inject({method:'POST',url:'/api/processing/workflows',headers,payload:{steps:[{name:'two',processor:'generated.prc01-lifecycle',inputs:[source.id]}]}});
  assert.equal(rejected.statusCode,503,rejected.body);
  assert.throws(()=>node.workflows.enqueue([{name:'two',processor:'generated.prc01-lifecycle',inputs:[source.id]}]),{statusCode:503});
  assert.equal((await node.app.inject({url:'/api/processing',headers})).statusCode,200,'accepted receipts stay readable while quiescing');
  // Re-enabling must not install a second handler or poll: the stopped
  // activation reuses the same runtime, registry and durable job rows.
  let registrations=0;const register=node.executor.register.bind(node.executor);
  node.executor.register=((handler:Parameters<ExecutionEngine['register']>[0])=>{registrations++;return register(handler);}) as ExecutionEngine['register'];
  const stopping=node.processingServices.stop('disabled');
  let settled=false;void stopping.then(()=>settled=true);await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(settled,false,'stop drains the accepted poll before answering');
  release();await Promise.all([running,stopping]);
  assert.deepEqual(calls,[{id:'accepted'}]);
  assert.equal(node.workflows.engine.get(id)?.state,'succeeded','accepted work commits during drain');
  assert.equal(node.processingServices.port.phase,'stopped');
  assert.equal((await node.app.inject({url:'/api/processing',headers})).statusCode,503);
  node.processingServices.start();
  assert.equal(registrations,0,'re-enable reuses the one activation handler set');
  assert.equal(node.processingServices.port.phase,'active');
  const reopened=await node.app.inject({url:'/api/processing',headers});
  assert.equal(reopened.statusCode,200,reopened.body);
  assert.ok((reopened.json() as {jobs:{id:string;state:string}[]}).jobs.some(job=>job.id===id&&job.state==='succeeded'));
  const second=await node.app.inject({method:'POST',url:'/api/processing/workflows',headers,payload:{steps:[{name:'next',processor:'generated.prc01-lifecycle',inputs:[source.id],config:{attempt:2}}]}});
  assert.equal(second.statusCode,202,second.body);
  await node.processingServices.tick();
  assert.equal(calls.length,2,'the durable registry receives new work after re-enable');
  await node.app.close();
  node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in generated fixture');},close:async()=>{}}});
  const restarted=await node.app.inject({url:'/api/processing',headers});
  assert.equal(restarted.statusCode,200,restarted.body);
  assert.ok((restarted.json() as {jobs:{id:string;state:string}[]}).jobs.some(job=>job.id===id&&job.state==='succeeded'),'the same profile keeps the committed receipt');
  await node.app.close();
});

test('a component epoch change during processing blocks the old output and a new definition retries',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-prc01-epoch-'));
  const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in generated fixture');},close:async()=>{}}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const source=record(),outputs:string[]=[];
  await node.store.ingest(source);
  let release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  const revoke=node.workflows.registry.register({id:'generated.prc01-epoch',version:'1',lane:'extract',async process(){entered();await held;return [{kind:'text',text:'Generated obsolete output',metadata:{}}];}});
  const accepted=await node.app.inject({method:'POST',url:'/api/processing/workflows',headers,payload:{steps:[{name:'one',processor:'generated.prc01-epoch',inputs:[source.id]}]}});
  assert.equal(accepted.statusCode,202,accepted.body);
  const id=(accepted.json() as {one:string}).one,running=node.processingServices.tick();
  await started;
  revoke();
  node.workflows.registry.register({id:'generated.prc01-epoch',version:'1',lane:'extract',async process(){outputs.push('v2');return [{kind:'text',text:'Generated replacement output',metadata:{}}];}});
  release();await running;
  const blocked=node.workflows.engine.get(id)!;
  assert.equal(blocked.state,'blocked',blocked.error);
  const row=node.store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(id)!;
  assert.deepEqual(JSON.parse(String(row.json)).outputs,[],'the retired component cannot commit');
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM context_artifacts').get()!.n,0);
  node.workflows.retry(id);await node.processingServices.tick();
  assert.equal(node.workflows.engine.get(id)?.state,'succeeded');
  assert.deepEqual(outputs,['v2']);
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM context_artifacts WHERE json_extract(json,'$.processor')='generated.prc01-epoch'").get()!.n,1);
});

test('a mid-prepare failure releases the borrowed engine handlers, vault transaction and timers',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-prc01-prepare-')),store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources),engine=new ExecutionEngine(store),materials=new MaterialStore(store);
  const originalSetInterval=globalThis.setInterval,originalClearInterval=globalThis.clearInterval;
  let created=0,cleared=0;const timers=new Set<ReturnType<typeof setInterval>>();
  globalThis.setInterval=((handler:TimerHandler,timeout?:number,...args:unknown[])=>{const handle=originalSetInterval(handler,timeout,...args);timers.add(handle);created++;return handle;}) as typeof setInterval;
  globalThis.clearInterval=((handle:ReturnType<typeof setInterval>)=>{if(timers.delete(handle))cleared++;return originalClearInterval(handle);}) as typeof clearInterval;
  const dependencies={
    store,files,configService:undefined,diagnostics:undefined,executor:engine,backendContext:undefined,materials,
    sourcePipelines:{setProductConsumer(){},options:()=>({consumers:[]})},mediaAssets:undefined,
    modules:[],modelAuthority:undefined,analyze:undefined,
    analysisSnapshot:()=>({settings:fileProcessingSchema.parse({}),identity:{kind:'profile',id:'generated'}}),analysisRevision:()=>0,
    semanticFingerprint:()=>'generated',
  } as unknown as ProcessingServicesDependencies;
  const platform=createProcessingServices(dependencies),exec=store.db.exec.bind(store.db);
  const failure=new Error('Generated file processing DDL failure');
  store.db.exec=((sql:string)=>{if(String(sql).includes('CREATE TABLE IF NOT EXISTS file_diarization_overrides'))throw failure;return exec(sql);}) as typeof store.db.exec;
  try{
    await assert.rejects(platform.prepare(),failure);
    assert.equal(store.db.isTransaction,false,'a failed prepare leaves no open transaction');
    assert.throws(()=>platform.workflows,{statusCode:503});
    assert.throws(()=>platform.processing,{statusCode:503});
    assert.equal(created,cleared,'no timer is left behind');
    store.db.exec=exec;
    const reopened=new ProcessingRuntime(store,[],{},Date.now,engine,materials);
    await reopened.ready;
    await reopened.close();
  }finally{
    store.db.exec=exec;globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval;
    await platform.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});
  }
});

test('a real file recipe output and processor declaration bind one product name, kind, revision and config fingerprint',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-prc01-contract-'));
  const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in generated fixture');},close:async()=>{}}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  node.sources.register({id:'generated-prc01-source',name:'Generated source',kind:'local-files',deviceId:'generated-prc01-device',platform:'android',retention:'archive'});
  const bytes=Buffer.from('Generated recipe text with a real transcript.'),manifest={sourceId:'generated-prc01-source',item:{externalId:'generated-recipe.txt',revision:'1',observedAt:'2026-11-01T00:00:00Z',title:'Generated recipe.txt',kind:'file' as const,layer:'original' as const,text:'',mimeType:'text/plain',deleted:false},relativePath:'generated-recipe.txt',sizeBytes:bytes.length,sha256:sha256(bytes)};
  const session=node.files.begin(manifest,()=>{});node.files.part(session.uploadId,0,bytes,()=>{});const ack=await node.files.commit(session.uploadId,()=>{});
  let detail=node.files.detail(ack.id);
  for(let attempt=0;attempt<20&&detail.job?.state!=='succeeded';attempt++){await node.processingServices.tick();detail=node.files.detail(ack.id);}
  assert.equal(detail.job?.state,'succeeded',JSON.stringify(detail.job));
  const transcript=detail.artifacts.find(artifact=>artifact.kind==='text');
  assert.ok(transcript);
  const recipe=node.processing.runtime.recipes.resolve({id:'mote.file-extraction',version:'1'},{semanticTurns:false});
  assert.equal(recipe.recipe.output,'extract');
  const decoded=node.processing.runtime.outputs.decode({id:'mote.transcript',version:'2'},node.processing.artifact(transcript!.id).transcript);
  assert.equal(decoded.kind,'text');
  assert.deepEqual(decoded.type,{id:'mote.transcript',version:'2'});
  assert.match(decoded.transcript.segments.map(segment=>segment.text).join(''),/Generated recipe text/);
  const note=record('Generated archived segment from the real recipe source'),noteId=note.id;
  await node.store.ingest(note);
  await node.store.archive.aggregate(32);
  const segment=node.store.db.prepare("SELECT id FROM context_artifacts WHERE kind='segment' AND json_extract(json,'$.metadata.entries[0].ids[0]')=?").get(noteId) as {id:string}|undefined;
  assert.ok(segment,'the archived evidence became a real segment');
  const revision=node.store.archive.revision(segment!.id)!;
  node.workflows.registry.register({id:'generated.prc01-contract',version:'1',lane:'aggregate',produces:[{key:'generated.product',kind:'text'}],async process(input){
    assert.equal(input.artifacts[0]?.outputs[0]?.id,segment!.id,'the declared recipe output is the exact input revision');
    return [{kind:'text',text:'Generated consumer output',metadata:{productKey:'generated.product',schemaVersion:1}}];
  }});
  const configValue={fixture:'generated-prc01'};
  const accepted=await node.app.inject({method:'POST',url:'/api/processing/workflows',headers,payload:{steps:[{name:'one',processor:'generated.prc01-contract',artifactInputs:[{id:segment!.id,revision}],config:configValue}]}});
  assert.equal(accepted.statusCode,202,accepted.body);
  const id=(accepted.json() as {one:string}).one;
  await node.processingServices.tick();
  const view=node.workflows.view().jobs.find(job=>job.id===id)!;
  assert.equal(view.state,'succeeded');
  assert.equal(view.outputs.length,1);
  const outputId=view.outputs[0]!;
  const artifact=node.store.archive.get(outputId)!;
  assert.equal(artifact.kind,'text');
  assert.equal(artifact.metadata.productKey,'generated.product');
  assert.equal(artifact.revision,node.store.archive.revision(outputId));
  assert.equal(artifact.configFingerprint,fixtureFingerprint(canonical(configValue)));
  assert.equal(view.products?.['generated.product'],outputId,'the declared product name maps to the committed revision');

  node.workflows.registry.register({id:'generated.prc01-mismatch',version:'1',lane:'aggregate',produces:[{key:'generated.product',kind:'text'}],async process(){return [{kind:'image-text',text:'Generated mismatched output',metadata:{productKey:'generated.product'}}];}});
  const mismatched=await node.app.inject({method:'POST',url:'/api/processing/workflows',headers,payload:{steps:[{name:'bad',processor:'generated.prc01-mismatch',inputs:[],artifactInputs:[{id:segment!.id,revision}]}]}});
  assert.equal(mismatched.statusCode,202,mismatched.body);
  const badId=(mismatched.json() as {bad:string}).bad;
  await node.processingServices.tick();
  const failed=node.workflows.engine.get(badId)!;
  assert.equal(failed.state,'failed');assert.equal(failed.error,'permanent');
  assert.equal(node.store.db.prepare("SELECT count(*) n FROM context_artifacts WHERE json_extract(json,'$.processor')='generated.prc01-mismatch'").get()!.n,0);
});
