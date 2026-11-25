import {authorizeFixtureModels} from './fixtures/model-authorization.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,open,readFile,readdir,rm,writeFile,stat } from 'node:fs/promises';
import {readdirSync} from 'node:fs';
import {DEFAULT_LOG_RETENTION} from '../src/log-retention-config.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentNotConfiguredError,AgentResponseError,AgentTimeoutError,AgentProviderError } from '@mote/agent';
import { ServerDiagnostics,safeError,serializeDiagnosticEvent } from '../src/diagnostics.js';
import { DiagnosticLogStore } from '../src/diagnostic-log-store.mjs';
import { buildApp,type QueryAgent } from '../src/app.js';
import type { ConfigurationPlatformOptions } from '../src/config.js';
import type { DiagnosticsSettingsValue } from '../src/execution-settings.js';

const marker='SYNTHETIC_PRIVATE_BODY_TOKEN_URL_QUERY';
const config=(dataDir:string,diagnostics:Partial<DiagnosticsSettingsValue>={}):ConfigurationPlatformOptions=>({path:(dataDir)+'/mote.yaml',privateCredential:{token:'synthetic-observability-token-only',tokenPath:join(dataDir,'synthetic-token-file')},initialDocument:{version:1,revision:0,storage:{dataDir:dataDir,dataKey:undefined,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:47832,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'synthetic-provider-credential',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{debug:true,...diagnostics}}});
const inactive:QueryAgent={configured:false,query:async()=>{throw new Error('fixture must not run');},close:async()=>{}};

const currentFiles=(directory:string)=>readdirSync(directory).filter(name=>/^central\.(error|warn|info|debug|trace)\./.test(name)).sort((a,b)=>Number(b.split('.')[3])-Number(a.split('.')[3])||b.localeCompare(a));
const filePath=(directory:string,index=0)=>join(directory,currentFiles(directory)[index]);
const seedPath=(directory:string,index=0,at=new Date().toISOString())=>join(directory,`central.info.${Date.parse(at)-index}.${Date.parse(at)-index}.${randomUUID()}.ndjson`);
const allRaw=async(directory:string)=>(await Promise.all(currentFiles(directory).map(name=>readFile(join(directory,name),'utf8')))).join('');
const fixtureRetention=(maxBytes:number)=>Object.fromEntries(Object.entries(DEFAULT_LOG_RETENTION).map(([key,value])=>[key,{...value,maxBytes}])) as typeof DEFAULT_LOG_RETENTION;

async function within<T>(task:Promise<T>,message:string):Promise<T> {
 const controller=new AbortController();
 try{return await Promise.race([task,delay(2000,undefined,{signal:controller.signal}).then(()=>{throw new Error(message);})]);}
 finally{controller.abort();}
}

// Keep real filesystem IO and the retention mutex. Only control when the next
// generated public record arrives, so every completed append has a successor.
function continuousWrites(t:import('node:test').TestContext,logger:ServerDiagnostics) {
 let active=true,produced=0;const append=DiagnosticLogStore.prototype.append;
 t.mock.method(DiagnosticLogStore.prototype,'append',async function(this:DiagnosticLogStore,records:Parameters<typeof append>[0]) {
  const files=await append.call(this,records);
  if(active&&logger.accepts('debug')&&records.some(record=>JSON.parse(record.line).instanceId===logger.instanceId))logger.record('source.completed',{count:++produced},'debug');
  return files;
 });
 return {stop:()=>{active=false;},get produced(){return produced;}};
}

test('OpenCode request usage persists safe counters without detailed tracing',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-opencode-usage-'));
 const logger=new ServerDiagnostics({directory,traceEnabled:false});await logger.init();
 t.after(async()=>{await logger.close();await rm(directory,{recursive:true,force:true});});
 const modelRequestId=randomUUID(),runId=randomUUID(),attemptId=randomUUID(),batchId=randomUUID(),jobId=randomUUID();
 const record={modelRequestId,runId,attemptId,batchId,jobId,memoryPhase:'review',operationId:'memory:'+jobId,
   upstreamRequestId:'req-generated',durationMs:27,httpStatus:200,promptTokens:200,billedInputTokens:0,
   billedCacheReadTokens:200,allowanceUsd:0.00000127,upstreamBody:marker};
 logger.record('agent.opencode_request_usage',record);
 await logger.close();
 const raw=await allRaw(directory);
 assert.ok(!raw.includes(marker));
 const row=JSON.parse(raw.trim());
 assert.equal(row.event,'agent.opencode_request_usage');
 assert.equal(row.modelRequestId,modelRequestId);
 assert.equal(row.runId,runId);
 assert.equal(row.attemptId,attemptId);
 assert.equal(row.batchId,batchId);
 assert.equal(row.operationId,'memory:'+jobId);
 assert.equal(row.memoryPhase,'review');
 assert.equal(row.upstreamRequestId,'req-generated');
 assert.equal(row.billedInputTokens,0);
 assert.equal(row.billedCacheReadTokens,200);
 assert.equal(row.billedCacheWrite1hTokens,null);
 assert.equal(row.allowanceUsd,0.00000127);
});

test('sustained debug arrivals and a bounded burst persist in order without filling the diagnostic queue',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-arrivals-')),now=Date.now();
 // Real metadata work across both writers' ordinary channels, using generated
 // records only. The producer never waits for a disk append or a flush.
 for(const [family,channel,count] of [['central','debug',2],['central','info',2],['central','warn',2],['central','error',2],['supervisor','info',2],['supervisor','debug',1],['supervisor','error',2]] as const)for(let index=0;index<count;index++){
  const at=now-index-1,row={seq:0,instanceId:randomUUID(),at:new Date(at).toISOString(),event:'server.started',level:channel,stage:'system'};
  await writeFile(join(directory,`${family}.${channel}.${at}.${at}.${randomUUID()}.ndjson`),JSON.stringify(row)+'\n',{mode:0o600});
 }
 const logger=new ServerDiagnostics({directory,debug:true,now:()=>new Date(now)});await logger.init();
 t.after(async()=>{await logger.close();await rm(directory,{recursive:true,force:true});});
 let produced=0,peakPending=0;
 const produce=()=>logger.record('source.completed',{count:++produced},'debug');
 for(let index=0;index<256;index++)produce();
 const start=performance.now();
 // 180 events/s for 15 s plus the initial 256-event burst. On the regression,
 // per-record lock handoffs cap drain below arrival rate and overflow 1024.
 for(let tick=0;tick<450;tick++){
  await delay(Math.max(0,start+tick*1000/30-performance.now()));
  for(let index=0;index<6;index++)produce();
  peakPending=Math.max(peakPending,logger.snapshot().pendingWrites);
 }
 await logger.close();
 const status=logger.snapshot();
 assert.equal(status.writeFailures,0);assert.equal(status.pendingWrites,0);
 assert.equal(status.droppedEvents,0,'sustained arrivals must not overflow the existing bounded queue');
 assert.ok(peakPending<=1088,'the existing 1024 queued + 64 in-flight bound remains in force');
 const rows=(await allRaw(directory)).trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.instanceId===logger.instanceId);
 assert.equal(produced,2956);
 assert.deepEqual(rows.map(row=>row.count),Array.from({length:produced},(_,index)=>index+1),'every generated event survives once in sequence, including the suffix drained at close');
});

test('flush finishes its accepted prefix while generated diagnostic writes continue, and close persists the suffix',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-prefix-')),logger=new ServerDiagnostics({directory,debug:true});
 await logger.init();const producer=continuousWrites(t,logger);
 t.after(async()=>{producer.stop();await logger.close();await rm(directory,{recursive:true,force:true});});
 logger.record('source.completed',{count:0},'debug');
 await within(logger.flush(),'flush waited for future diagnostic writes instead of its accepted prefix');
 assert.ok(producer.produced>0);assert.ok(logger.snapshot().pendingWrites>0,'a later write is still pending when the prefix completes');
 await logger.close();producer.stop();
 const rows=(await allRaw(directory)).trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(rows.map(row=>row.count),Array.from({length:producer.produced+1},(_,index)=>index),'every accepted record is persisted once in order, including the suffix at close');
 assert.equal(logger.snapshot().pendingWrites,0);assert.equal(logger.snapshot().droppedEvents,0);assert.equal(logger.snapshot().writeFailures,0);
});

test('diagnostic settings and disk-backed reads complete while debug producers remain active',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-busy-api-')),cfg=config(directory);
 const {app,diagnostics}=await buildApp(cfg,{agent:inactive,backgroundWorker:false});await diagnostics.flush();
 const producer=continuousWrites(t,diagnostics),headers={authorization:'Bearer '+cfg.privateCredential!.token};
 t.after(async()=>{producer.stop();await app.close();await rm(directory,{recursive:true,force:true});});
 const before=(await app.inject({url:'/api/diagnostics-settings',headers})).json();
 diagnostics.record('source.completed',{count:0},'debug');
 const unchanged=diagnostics.snapshot().lastSeq;diagnostics.agentTrace({type:'fixture.before-publication'});assert.equal(diagnostics.snapshot().lastSeq,unchanged);
 const saved=await within(app.inject({method:'PUT',url:'/api/diagnostics-settings',headers,payload:{...before,traceEnabled:true}}).then(response=>response),'settings save was starved by later debug records');
 assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().revision,before.revision+1);assert.equal(saved.json().traceEnabled,true);
 diagnostics.agentTrace({type:'fixture.after-publication',payload:{prompt:'Generated trace after committed opt-in'}});
 const status=await within(app.inject({url:'/api/diagnostics',headers}).then(response=>response),'diagnostic retention waited for the debug producer to stop');
 assert.equal(status.statusCode,200,status.body);assert.equal(status.json().agentTrace.enabled,true);assert.ok(producer.produced>0);assert.ok(diagnostics.snapshot().pendingWrites>0);
 const page=await within(app.inject({url:'/api/diagnostics/log-pages',headers}).then(response=>response),'disk-backed diagnostic pagination was starved by later debug records');
 assert.equal(page.statusCode,200,page.body);assert.ok(page.json().totalLines>0);
 producer.stop();await app.close();
 const rows=(await allRaw(join(directory,'logs'))).trim().split('\n').map(line=>JSON.parse(line));
 const generated=rows.filter(row=>row.event==='source.completed');
 assert.deepEqual(generated.map(row=>row.count),Array.from({length:producer.produced+1},(_,index)=>index));
 assert.equal(rows.filter(row=>row.trace?.type==='fixture.before-publication').length,0);assert.equal(rows.filter(row=>row.trace?.type==='fixture.after-publication').length,1);
 assert.equal(diagnostics.snapshot().pendingWrites,0);assert.equal(diagnostics.snapshot().droppedEvents,0);assert.equal(diagnostics.snapshot().writeFailures,0);
});

test('diagnostic status and live settings remain available with a finite 1000-record disk backlog',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-finite-backlog-')),logDirectory=join(directory,'logs'),cfg=config(directory);
 await mkdir(logDirectory,{mode:0o700});const instanceId=randomUUID(),now=Date.now();let seq=0;
 // Generated representatives of every retained Central/supervisor channel;
 // metadata inventory is real, and no production file contents are reused.
 for(const [family,channel,count] of [['central','debug',2],['central','info',2],['central','warn',2],['central','error',2],['supervisor','info',2],['supervisor','debug',1],['supervisor','error',2]] as const)for(let index=0;index<count;index++){
  const at=now-index-1,event={seq:++seq,instanceId,at:new Date(at).toISOString(),event:'server.started',level:channel,stage:'system'};
  await writeFile(join(logDirectory,`${family}.${channel}.${at}.${at}.${randomUUID()}.ndjson`),JSON.stringify(event)+'\n',{mode:0o600});
 }
 const {app,diagnostics}=await buildApp(cfg,{agent:inactive,backgroundWorker:false}),headers={authorization:'Bearer '+cfg.privateCredential!.token};
 const before=(await app.inject({url:'/api/diagnostics-settings',headers})).json();await diagnostics.flush();
 const written=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),append=DiagnosticLogStore.prototype.append;let first=true;
 t.mock.method(DiagnosticLogStore.prototype,'append',async function(this:DiagnosticLogStore,records:Parameters<typeof append>[0]) {
  const files=await append.call(this,records);if(first){first=false;written.resolve();await release.promise;}return files;
 });
 t.after(async()=>{release.resolve();await app.close();await rm(directory,{recursive:true,force:true});});
 for(let count=0;count<1000;count++)diagnostics.record('source.completed',{count},'debug');
 await within(written.promise,'the first generated backlog record did not reach disk');assert.equal(diagnostics.snapshot().pendingWrites,1000);
 const supervisor=new DiagnosticLogStore(logDirectory,{family:'supervisor'});
 await supervisor.append([{channel:'warn',at:new Date().toISOString(),line:JSON.stringify({event:'server.started'})+'\n'}]);
 const unchanged=diagnostics.snapshot().lastSeq;diagnostics.agentTrace({type:'fixture.before-backlog-opt-in'});assert.equal(diagnostics.snapshot().lastSeq,unchanged);
 const [status,saved]=await Promise.all([
  within(app.inject({url:'/api/diagnostics',headers}).then(response=>response),'diagnostic status unnecessarily waited for the finite disk backlog'),
  within(app.inject({method:'PUT',url:'/api/diagnostics-settings',headers,payload:{...before,traceEnabled:true}}).then(response=>response),'live settings unnecessarily waited for the finite disk backlog'),
 ]);
 assert.equal(status.statusCode,200,status.body);assert.ok(status.json().pendingWrites>=1000);assert.ok(status.json().retention.totalBytes>0);
 assert.ok(status.json().retention.files.some((file:{family:string;channel:string})=>file.family==='supervisor'&&file.channel==='warn'),'status refreshes another writer\'s new persisted file without draining Central');
 assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().revision,before.revision+1);assert.equal(saved.json().traceEnabled,true);
 diagnostics.agentTrace({type:'fixture.committed-backlog-opt-in',payload:{prompt:'Generated accepted trace'}});
 const disabled=await within(app.inject({method:'PUT',url:'/api/diagnostics-settings',headers,payload:{...saved.json(),traceEnabled:false}}).then(response=>response),'trace opt-out unnecessarily waited for old diagnostic records');
 assert.equal(disabled.statusCode,200,disabled.body);assert.equal(disabled.json().traceEnabled,false);
 const stopped=diagnostics.snapshot().lastSeq;diagnostics.agentTrace({type:'fixture.after-backlog-opt-out'});assert.equal(diagnostics.snapshot().lastSeq,stopped);
 let readCompleted=false;const raw=diagnostics.readRaw().then(value=>{readCompleted=true;return value;});
 await Promise.resolve();assert.equal(readCompleted,false,'raw file reads retain their accepted-prefix barrier');
 release.resolve();await Promise.all([raw,app.close()]);
 const rows=(await allRaw(logDirectory)).trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(rows.filter(row=>row.instanceId===diagnostics.instanceId&&row.event==='source.completed').map(row=>row.count),Array.from({length:1000},(_,index)=>index));
 assert.equal(rows.filter(row=>row.trace?.type==='fixture.committed-backlog-opt-in').length,1);
 assert.equal(rows.filter(row=>['fixture.before-backlog-opt-in','fixture.after-backlog-opt-out'].includes(row.trace?.type)).length,0);
 assert.equal(diagnostics.snapshot().pendingWrites,0);assert.equal(diagnostics.snapshot().droppedEvents,0);assert.equal(diagnostics.snapshot().writeFailures,0);
});

test('an evicted flush prefix finishes before a later error suffix, while close still waits for that suffix',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-evicted-prefix-')),logger=new ServerDiagnostics({directory,debug:true,maxEntries:2});await logger.init();
 const prefixWritten=Promise.withResolvers<void>(),releasePrefix=Promise.withResolvers<void>(),releaseSuffix=Promise.withResolvers<void>();
 const append=DiagnosticLogStore.prototype.append;let first=true;
 t.mock.method(DiagnosticLogStore.prototype,'append',async function(this:DiagnosticLogStore,records:Parameters<typeof append>[0]) {
  if(first){first=false;const files=await append.call(this,records);prefixWritten.resolve();await releasePrefix.promise;return files;}
  await releaseSuffix.promise;return append.call(this,records);
 });
 t.after(async()=>{releasePrefix.resolve();releaseSuffix.resolve();await logger.close();await rm(directory,{recursive:true,force:true});});
 logger.record('source.completed',{count:0});await within(prefixWritten.promise,'the generated prefix did not reach disk');
 logger.record('source.completed',{count:1},'debug');logger.record('source.completed',{count:2},'debug');const prefix=logger.flush();
 logger.record('source.failed',{count:3},'error');logger.record('source.failed',{count:4},'error');
 let suffixSettled=false;const suffix=logger.flush().then(()=>{suffixSettled=true;});releasePrefix.resolve();
 await within(prefix,'a prefix already removed by priority eviction stranded its waiter');assert.equal(suffixSettled,false);
 let closed=false;const closing=logger.close().then(()=>{closed=true;});assert.equal(closed,false);releaseSuffix.resolve();
 await within(Promise.all([suffix,closing]),'close stranded an accepted error suffix');
 const rows=(await allRaw(directory)).trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(rows.map(row=>row.count).sort(),[0,3,4]);assert.equal(logger.snapshot().droppedEvents,2);assert.equal(logger.snapshot().pendingWrites,0);assert.equal(logger.snapshot().writeFailures,0);
});

test('flush settles a real append failure without replaying its already persisted bytes',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-failed-prefix-')),logger=new ServerDiagnostics({directory});await logger.init();
 t.after(async()=>{await logger.close();await rm(directory,{recursive:true,force:true});});
 // Fail state publication after the record bytes are appended, using only a
 // generated filesystem obstacle rather than replacing the append result.
 await mkdir(join(directory,'retention-state.json.tmp'));logger.record('source.completed',{count:1});
 await within(logger.flush(),'a failed append stranded its prefix waiter');await logger.close();
 assert.equal(logger.snapshot().writeFailures,1);assert.equal(logger.snapshot().pendingWrites,0);assert.equal(logger.snapshot().droppedEvents,1);
 const rows=(await allRaw(directory)).trim().split('\n').map(line=>JSON.parse(line));assert.deepEqual(rows.map(row=>row.count),[1]);
});

test('close persists a record accepted immediately after a completed flush',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-flush-close-')),logger=new ServerDiagnostics({directory});await logger.init();
 t.after(async()=>{await logger.close();await rm(directory,{recursive:true,force:true});});
 logger.record('source.completed',{count:1});await logger.flush();logger.record('source.completed',{count:2});
 await within(logger.close(),'close missed a record admitted before the drain continuation');
 assert.deepEqual((await allRaw(directory)).trim().split('\n').map(line=>JSON.parse(line).count),[1,2]);assert.equal(logger.snapshot().pendingWrites,0);
});

test('an aborted diagnostic settings client can commit later, and its stale revision cannot overwrite that commit',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-aborted-save-')),cfg=config(directory);
 const {app,diagnostics,configService}=await buildApp(cfg,{agent:inactive,backgroundWorker:false}),headers={authorization:'Bearer '+cfg.privateCredential!.token};
 const before=(await app.inject({url:'/api/diagnostics-settings',headers})).json();await diagnostics.flush();
 const releasePreparation=Promise.withResolvers<void>(),preparing=Promise.withResolvers<void>(),committed=Promise.withResolvers<void>();
 const unsubscribe=configService.onChange(()=>{if(configService.revision>before.revision)committed.resolve();});
 const prepare=diagnostics.prepareConfiguration.bind(diagnostics);
 // Control a real prepared candidate's handoff to the transaction. Live capture
 // flags no longer wait for unrelated log IO, but another participant may wait.
 t.mock.method(diagnostics,'prepareConfiguration',async value=>{const candidate=await prepare(value);preparing.resolve();await releasePreparation.promise;return candidate;});
 const controller=new AbortController();
 t.after(async()=>{controller.abort();releasePreparation.resolve();unsubscribe();await app.close();await rm(directory,{recursive:true,force:true});});
 const address=await app.listen({host:'127.0.0.1',port:0});
 const payload={...before,traceEnabled:true};
 const request=fetch(address+'/api/diagnostics-settings',{method:'PUT',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
 await within(preparing.promise,'the settings request did not enter preparation');controller.abort();await assert.rejects(request,{name:'AbortError'});
 const pending=(await app.inject({url:'/api/diagnostics-settings',headers})).json();assert.equal(pending.revision,before.revision);assert.equal(pending.traceEnabled,false);
 releasePreparation.resolve();await within(committed.promise,'the accepted transaction did not commit after its client disconnected');
 const after=(await app.inject({url:'/api/diagnostics-settings',headers})).json();assert.equal(after.revision,before.revision+1);assert.equal(after.traceEnabled,true);
 const stale=await app.inject({method:'PUT',url:'/api/diagnostics-settings',headers,payload:{...before,traceEnabled:false}});assert.equal(stale.statusCode,409);assert.equal(configService.revision,after.revision);
 const restored=await app.inject({method:'PUT',url:'/api/diagnostics-settings',headers,payload:{...after,traceEnabled:false}});assert.equal(restored.statusCode,200,restored.body);assert.equal(restored.json().traceEnabled,false);assert.equal(restored.json().revision,after.revision+1);
});

test('mixed ordinary and trace eviction reports the actual ring across toggles and restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-trace-count-'));
 let logger=new ServerDiagnostics({directory,traceEnabled:true,maxEntries:2});
 t.after(async()=>{await logger.close();await rm(directory,{recursive:true,force:true});});
 const check=()=>{
  const entries=logger.events(0,10).items,snapshot=logger.snapshot();
  assert.equal(snapshot.agentTrace.retainedEvents,entries.filter(entry=>entry.event==='agent.trace').length);
  assert.ok(snapshot.agentTrace.retainedEvents<=snapshot.retainedEvents);
 };
 await logger.init();
 logger.agentTrace({type:'generated.trace'});logger.record('server.started');check();
 logger.record('server.started');check();assert.equal(logger.snapshot().agentTrace.retainedEvents,0);
 logger.agentTrace({type:'generated.second'});logger.agentTrace({type:'generated.third'});check();
 await logger.configure({enabled:true,debug:false,traceEnabled:false,level:'info'});
 logger.record('server.started');check();logger.record('server.started');check();
 await logger.close();logger=new ServerDiagnostics({directory,traceEnabled:true,maxEntries:2});await logger.init();check();
 assert.equal(logger.snapshot().agentTrace.retainedEvents,0);
 logger.agentTrace({type:'generated.after-restart'});logger.record('server.started');check();
 await logger.close();logger=new ServerDiagnostics({directory,traceEnabled:true,maxEntries:2});await logger.init();check();
 assert.equal(logger.snapshot().agentTrace.retainedEvents,0,'ordinary events have priority over detailed traces in the memory ring');
});

test('safe fragment timings preserve measured queue/session units without arbitrary model content',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-safe-fragment-timing-')),d=new ServerDiagnostics({directory,traceEnabled:false});
 t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
 d.record('agent.fragment_timing',{lane:'interactive',unit:'agent_fragment',queueWaitMs:12.3456,durationMs:67,status:'yielded',...{prompt:marker,token:marker}} as never);
 d.record('agent.harness_timing',{lane:marker,unit:marker,status:marker,queueWaitMs:NaN,durationMs:80,body:marker} as never);
 await d.flush();const rows=d.events().items;assert.equal(rows.length,2);assert.equal(rows[0].queueWaitMs,12.346);assert.equal(rows[0].lane,'interactive');assert.equal(rows[0].status,'yielded');assert.equal(rows[0].unit,'agent_fragment');
 assert.equal(rows[1].lane,undefined);assert.equal(rows[1].unit,undefined);assert.equal(rows[1].status,undefined);assert.equal(rows[1].queueWaitMs,undefined);
 const text=await readFile(filePath(directory),'utf8');assert.ok(!text.includes(marker));await d.close();const reopened=new ServerDiagnostics({directory});await reopened.init();assert.equal(reopened.events().items[0].unit,'agent_fragment');await reopened.close();
});

test('disabled and silent diagnostics neither read nor create files or events',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mote-diagnostics-disabled-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const options of [{enabled:false},{level:'silent' as const,debug:true}]) {
    const directory=join(root,randomUUID()),d=new ServerDiagnostics({directory,...options});await d.init();d.record('request.completed',{count:1});await d.measure('agent','query',async()=>42);await d.close();
    assert.equal(d.snapshot().retainedEvents,0);assert.equal(d.snapshot().lastSeq,0);assert.equal(d.snapshot().enabled,false);await assert.rejects(stat(directory),{code:'ENOENT'});
  }
});

test('event whitelist excludes content even when supplied as Error-like fields and arbitrary metadata',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-whitelist-'));const d=new ServerDiagnostics({directory,debug:true});t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
  const requestId=randomUUID();
  d.run(requestId,()=>d.record('source.completed',{operation:'evidence',count:2,durationMs:1.25,...{message:marker,error:marker,body:marker,token:marker,requestId:marker,route:marker,category:marker,reason:marker,bytes:NaN}} as never));
  d.record(marker,{count:3});d.record('request.completed',{operation:marker,requestId:marker} as never);
  await d.flush();const text=await readFile(filePath(directory),'utf8');assert.ok(!text.includes(marker));assert.ok(!JSON.stringify(d.snapshot()).includes(directory));
  const rows=d.events().items;assert.equal(rows.length,2);assert.equal(rows[0].count,2);assert.equal(rows[0].durationMs,1.25);assert.equal(rows[0].requestId,undefined);assert.equal(rows[0].category,undefined);assert.equal(rows[0].bytes,undefined);
  assert.equal((await stat(filePath(directory))).mode&0o777,0o600);
});

test('diagnostic log lines truncate instead of dropping oversized events',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-line-limit-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const base={seq:1,at:'2026-09-20T12:00:00.000Z',instanceId:randomUUID(),event:'server.started',level:'info'};
  const accepted=serializeDiagnosticEvent({...base,padding:'x'.repeat(19*1024)} as never);const truncated=serializeDiagnosticEvent({...base,seq:2,padding:'x'.repeat(25*1024)} as never);
  assert.ok(Buffer.byteLength(accepted)<=20*1024);assert.ok(Buffer.byteLength(truncated)<=20*1024);assert.equal(JSON.parse(accepted).truncated,undefined);assert.equal(JSON.parse(truncated).truncated,true);
  const legacyOversized=JSON.stringify({...base,seq:3,padding:'x'.repeat(25*1024)})+'\n';await writeFile(seedPath(directory,0,base.at),accepted+legacyOversized);
  const d=new ServerDiagnostics({directory,maxBytes:64*1024,now:()=>new Date(base.at)});await d.init();assert.equal(d.events().items.length,2);assert.deepEqual(d.events().items.map(event=>event.seq),[1,3]);await d.close();
});

test('opt-in Agent trace is written to its separate stream and survives reload while safe exports exclude it',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-agent-trace-')),traceId=randomUUID(),requestId=randomUUID(),jobId=randomUUID(),batchId=randomUUID();
  const d=new ServerDiagnostics({directory,traceEnabled:true,debug:false});t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
  d.agentTrace({type:'context.assembled',runId:randomUUID(),stage:'starting',payload:{prompt:marker,context:{source:'synthetic fixture'}}},{traceId,requestId,jobId,batchId,batchIndex:3,attempt:2,phase:'extract',operation:'query',moduleId:'memories',profileId:'codex',provider:'codex',protocol:'codex-app-server',model:'synthetic-model'});
  await d.flush();const raw=await readFile(filePath(directory),'utf8');assert.ok(raw.includes('agent.trace'));assert.ok(raw.includes(marker));
  const event=d.events().items.find(row=>row.event==='agent.trace');assert.ok(event);assert.equal(event?.requestId,requestId);assert.equal(event?.jobId,jobId);assert.equal((event?.trace as Record<string,unknown>).traceId,traceId);assert.equal((event?.trace as Record<string,unknown>).payload&&((event?.trace as Record<string,unknown>).payload as Record<string,unknown>).prompt,marker);
  const exported=await d.exportRange(new Date(Date.now()-1000).toISOString(),new Date(Date.now()+1000).toISOString());assert.deepEqual(exported.events,[]);
  await d.close();const reloaded=new ServerDiagnostics({directory,traceEnabled:true});await reloaded.init();assert.equal(reloaded.events().items.filter(row=>row.event==='agent.trace').length,1);assert.equal(reloaded.snapshot().agentTrace.enabled,true);await reloaded.close();
});

test('100 MiB retention keeps real generated trace logs above the old 8 MiB ceiling across reads and restart',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-large-')),now=new Date('2026-09-20T12:00:00.000Z');
  const options={directory,maxBytes:100*1024*1024,maxEntries:3,traceEnabled:true,now:()=>now};
  const d=new ServerDiagnostics(options);let restarted:ServerDiagnostics|undefined;t.after(async()=>{await restarted?.close();await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
  for(let index=0;index<9;index++){d.agentTrace({type:'fixture.model.completed',step:index,payload:'生成的 diagnostic fixture '.repeat(33_000)});await d.flush();}
  d.record('server.started');await d.flush();
  const traceFile=d.snapshot().retention.files.find(f=>f.channel==='trace')!;const traceIndex=d.snapshot().retention.files.findIndex(f=>f.channel==='trace');const size=traceFile.bytes;assert.ok(size>8*1024*1024);assert.ok(size<100*1024*1024);
  assert.equal(d.snapshot().limits.maxFileBytes,100*1024*1024);assert.equal(d.snapshot().retainedEvents,3);assert.equal(d.snapshot().droppedEvents,0);
  assert.equal(Buffer.byteLength(await d.readRaw(traceIndex)),size);
  // Pagination and safe export must traverse lines directly, without materializing a raw file first.
  t.mock.method(d,'readRaw',async()=>{throw new Error('whole-file reader must not be used');});
  const latest=await d.readPage(traceIndex,1,2);assert.equal(latest.totalLines,9);assert.deepEqual(latest.items.map(line=>JSON.parse(line).seq),[8,9]);
  const oldest=await d.readPage(traceIndex,999,2);assert.equal(oldest.page,5);assert.deepEqual(oldest.items.map(line=>JSON.parse(line).seq),[1]);
  const filtered=await d.readPage(d.snapshot().retention.files.findIndex(f=>f.channel==='info'),1,2,'system');assert.equal(filtered.totalLines,1);assert.equal(JSON.parse(filtered.items[0]).event,'server.started');
  const exported=await d.exportRange('2026-09-20T12:00:00.000Z','2026-09-21T00:00:00.000Z');
  assert.deepEqual(exported.events.map(event=>event.seq),[10]);assert.equal(exported.oldestRetainedAt,now.toISOString());assert.equal(exported.retentionLimited,false);assert.equal(exported.invalidLines,0);
  await d.close();restarted=new ServerDiagnostics(options);await restarted.init();
  assert.deepEqual(restarted.recent().map(event=>event.seq),[8,9,10]);assert.equal(restarted.snapshot().readFailures,0);assert.equal(restarted.snapshot().lastSeq,10);
  restarted.record('server.started');await restarted.flush();assert.equal(JSON.parse((await restarted.readPage(restarted.snapshot().retention.files.findIndex(f=>f.channel==='info'),1,1)).items[0]).seq,11);
});

test('large-file retention does not expand ordinary or per-trace payload limits',async t=>{
  const root=await mkdtemp(join(tmpdir(),'mote-diagnostics-trace-limits-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const maxBytes of [2*1024*1024,8*1024*1024,100*1024*1024]){
    const d=new ServerDiagnostics({directory:join(root,String(maxBytes)),maxBytes,traceEnabled:true});await d.init();
    try{
      d.agentTrace({type:'fixture.accepted',payload:['x'.repeat(900_000),'x'.repeat(900_000)]});await d.flush();
      assert.equal(d.recent()[0].trace?.truncated,undefined);
      if(maxBytes>2*1024*1024){d.agentTrace({type:'fixture.near_trace_ceiling',payload:Array.from({length:8},()=> 'x'.repeat(1_000_000))});await d.flush();assert.equal(d.recent().at(-1)!.trace?.truncated,undefined);}
      const payload=Array.from({length:maxBytes===2*1024*1024?3:9},()=> 'x'.repeat(1_000_000));
      d.agentTrace({type:'fixture.too_large',payload});await d.flush();assert.equal(d.recent().at(-1)!.trace?.truncated,true);assert.equal(typeof d.recent().at(-1)!.trace?.payload,'string');
      d.agentTrace({type:'fixture.string_limit',payload:'x'.repeat(1_000_001)});await d.flush();const trace=d.recent().at(-1)!.trace!;assert.equal(trace.truncated,true);assert.equal((trace.payload as string).length,1_000_000);
      for(const line of (await d.readRaw()).trim().split('\n'))assert.ok(Buffer.byteLength(line)+1<=Math.min(maxBytes,8*1024*1024));
      const ordinary=serializeDiagnosticEvent({seq:1,at:'2026-09-20T12:00:00.000Z',instanceId:randomUUID(),event:'server.started',level:'info',padding:'x'.repeat(100*1024)} as never);
      assert.ok(Buffer.byteLength(ordinary)<=20*1024);assert.equal(JSON.parse(ordinary).truncated,true);
    }finally{await d.close();}
  }
  assert.equal(new ServerDiagnostics({directory:join(root,'default')}).snapshot().limits.maxFileBytes,16*1024*1024);
  assert.equal(new ServerDiagnostics({directory:join(root,'clamped'),maxBytes:200*1024*1024}).snapshot().limits.maxFileBytes,100*1024*1024);
});

test('100 MiB segments respect a 300 MiB stream budget and midnight does not impose a file-count limit',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-large-boundary-')),maxBytes=100*1024*1024,instanceId=randomUUID();let now=new Date('2026-09-20T23:59:59.000Z');
  let d:ServerDiagnostics|undefined;t.after(async()=>{await d?.close();await rm(directory,{recursive:true,force:true});});
  // Sparse generated fixtures reach the exact disk-size boundary without writing 300 MiB of payloads.
  // Newlines every MiB bound the malformed fixture lines; each file also contains a valid event.
  for(let index=0;index<3;index++){
    const file=await open(seedPath(directory,index,now.toISOString()),'w');
    try{
      await file.writeFile(JSON.stringify({seq:3-index,at:now.toISOString(),instanceId,event:'server.started',level:'info'})+'\n');await file.truncate(maxBytes);
      for(let position=1024*1024-1;position<maxBytes;position+=1024*1024)await file.write('\n',position,'utf8');
    }finally{await file.close();}
  }
  assert.equal((await Promise.all([0,1,2].map(async index=>(await stat(filePath(directory,index))).size))).reduce((sum,size)=>sum+size,0),300*1024*1024);
  d=new ServerDiagnostics({directory,maxBytes,retention:fixtureRetention(300*1024*1024),now:()=>now});await d.init();
  assert.equal(d.snapshot().lastSeq,3);assert.equal((await stat(filePath(directory))).size,maxBytes);
  d.record('server.started');await d.flush();assert.equal(JSON.parse((await d.readPage(0,1,1)).items[0]).seq,4);
  const history=await open(join(directory,d.snapshot().retention.files.find(file=>file.bytes===maxBytes)!.name),'r');try{assert.equal((await history.stat()).size,maxBytes);const head=Buffer.alloc(512);const {bytesRead}=await history.read(head,0,512,0);assert.equal(JSON.parse(head.subarray(0,bytesRead).toString().split('\n')[0]).seq,3);}finally{await history.close();}
  const files=(await readdir(directory)).filter(name=>/^central\.(error|warn|info|debug|trace)\./g.test(name));assert.equal(files.length,3);
  const sizes=await Promise.all(files.map(async name=>(await stat(join(directory,name))).size));assert.ok(sizes.every(size=>size<=maxBytes));assert.ok(sizes.reduce((sum,size)=>sum+size,0)<=300*1024*1024);
  now=new Date('2026-09-21T00:00:00.000Z');d.record('server.started');await d.flush();
  assert.equal(JSON.parse((await d.readPage(0,1,1)).items[0]).seq,5);assert.equal(JSON.parse((await d.readPage(1,1,1)).items[0]).seq,4);
  assert.equal(d.snapshot().retention.files.filter(file=>file.bytes===maxBytes).length,2);assert.equal(d.snapshot().retention.files.length,4,'midnight does not delete a retained segment just to enforce a count');await d.close();
});

test('chunked readers preserve dense ordinary log ordering across many chunk boundaries',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-dense-')),instanceId=randomUUID(),at='2026-09-20T12:00:00.000Z';
  const rows=Array.from({length:10_000},(_,index)=>JSON.stringify({seq:index+1,at,instanceId,event:'source.completed',level:'info',operation:'evidence',count:index}));
  await writeFile(seedPath(directory,0,at),rows.join('\n')+'\n');assert.ok((await stat(filePath(directory))).size>64*1024);
  const d=new ServerDiagnostics({directory,maxBytes:100*1024*1024,maxEntries:17,now:()=>new Date(at)});t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
  assert.equal(d.snapshot().lastSeq,10_000);assert.equal(d.snapshot().readFailures,0);assert.equal(d.snapshot().retainedEvents,17);
  assert.deepEqual((await d.readPage(0,1,3,'source')).items.map(line=>JSON.parse(line).seq),[9998,9999,10_000]);
  const oldest=await d.readPage(0,9999,3);assert.equal(oldest.page,3334);assert.deepEqual(oldest.items.map(line=>JSON.parse(line).seq),[1]);
  const exported=await d.exportRange(at,'2026-09-21T00:00:00.000Z');assert.equal(exported.events.length,10_000);assert.deepEqual(exported.events.map(event=>event.seq),Array.from({length:10_000},(_,index)=>index+1));assert.equal(exported.invalidLines,0);
});

test('chunked raw pages retain multibyte text, blank-line rules and incomplete malformed tails',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-chunk-text-')),d=new ServerDiagnostics({directory,maxBytes:100*1024*1024});
  t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
  const first='x'.repeat(64*1024-2)+'中文🚲 fixture',at='2026-09-20T12:00:00.000Z';
  const ordinary=JSON.stringify({seq:1,at,instanceId:randomUUID(),event:'server.started',level:'info'}),partial='{"unfinished":"generated fixture';
  const raw=first+'\n\n'+ordinary+'\n'+partial;await writeFile(seedPath(directory,0,new Date().toISOString()),raw);
  const allocations:number[]=[],allocate=Buffer.allocUnsafe;t.mock.method(Buffer,'allocUnsafe',(size:number)=>{allocations.push(size);return allocate(size);});
  assert.equal(await d.readRaw(),raw);assert.ok(allocations.includes(Buffer.byteLength(raw)));assert.ok(!allocations.includes(100*1024*1024));
  const latest=await d.readPage(0,1,2);assert.deepEqual(latest.items,[ordinary,partial]);assert.equal(latest.totalLines,3);
  assert.deepEqual((await d.readPage(0,2,2)).items,[first]);assert.deepEqual((await d.readPage(0,2,1,'unknown')).items,[first]);
  const exported=await d.exportRange(at,'2026-09-21T00:00:00.000Z');assert.equal(exported.invalidLines,2);assert.deepEqual(exported.events.map(event=>event.seq),[1]);
});

test('log rotation, memory, pending queue and forward cursor remain bounded under bursts',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-bounds-'));const d=new ServerDiagnostics({directory,maxBytes:1024,retention:fixtureRetention(3072),maxEntries:17});t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
  for(let round=0;round<20;round++) {for(let i=0;i<100;i++)d.record('request.completed',{count:i});assert.ok(d.snapshot().pendingWrites<=81);await d.flush();}
  assert.equal(d.snapshot().retainedEvents,17);assert.ok(d.snapshot().droppedEvents>0);assert.equal(d.snapshot().pendingWrites,0);
  const files=(await readdir(directory)).filter(name=>/^central\.(error|warn|info|debug|trace)\./g.test(name));assert.ok(files.length<=3);assert.ok(d.snapshot().retention.files.reduce((n,f)=>n+f.bytes,0)<=3072);assert.ok(d.snapshot().retention.totalBytes<=d.snapshot().retention.maxTotalBytes);
  for(const file of files)assert.ok((await stat(join(directory,file))).size<=1024);
  const all=d.events(0,500).items;let cursor=0,received:number[]=[];
  for(;;){const page=d.events(cursor,3);if(!page.items.length)break;received.push(...page.items.map(r=>r.seq));cursor=page.nextSeq;}
  assert.deepEqual(received,all.map(r=>r.seq));assert.deepEqual(d.recent(3).map(r=>r.seq),all.slice(-3).map(r=>r.seq));
});

test('daily boundaries create new segments and preserve previous days',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-daily-'));let now=new Date('2026-09-20T23:59:59.000Z');
  const options=()=>({directory,debug:true,maxBytes:1024,now:()=>now});const d=new ServerDiagnostics(options());t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
  d.record('server.started');await d.flush();await d.close();
  now=new Date('2026-09-21T00:00:00.000Z');const restarted=new ServerDiagnostics(options());await restarted.init();restarted.record('server.started');await restarted.flush();
  const current=JSON.parse((await readFile(filePath(directory),'utf8')).trim());const history=JSON.parse((await readFile(filePath(directory,1),'utf8')).trim());
  assert.equal(current.at.slice(0,10),'2026-09-21');assert.equal(history.at.slice(0,10),'2026-09-20');assert.equal((await restarted.readRaw(0)).trim(),JSON.stringify(current));assert.equal((await restarted.readRaw(1)).trim(),JSON.stringify(history));
  await restarted.close();
});

test('restart filters foreign fields, preserves malformed evidence and never truncates files for a smaller segment size',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-restart-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const event={seq:8,at:new Date().toISOString(),instanceId:randomUUID(),event:'source.completed',level:'info',operation:'evidence',count:1,message:marker,requestId:marker};
  const broken=seedPath(directory,0,event.at);await writeFile(broken,JSON.stringify(event)+'\n{"unfinished":"'+marker,{mode:0o644});
  const oversized=seedPath(directory,1,event.at);await writeFile(oversized,'x'.repeat(3000));await writeFile(join(directory,'central.9.ndjson'),'old');await writeFile(join(directory,'unrelated.txt'),marker);
  const d=new ServerDiagnostics({directory,maxBytes:1024,maxEntries:20});await d.init();assert.equal(d.events().items.length,1);assert.ok(!JSON.stringify(d.events()).includes(marker));d.record('server.started');await d.close();
  const text=await readFile(filePath(directory),'utf8');const lines=text.trim().split('\n').map(row=>JSON.parse(row));assert.equal(lines.at(-1).seq,9);assert.equal((await stat(oversized)).size,3000);assert.ok((await readFile(broken,'utf8')).endsWith(marker));assert.equal(await readFile(join(directory,'central.9.ndjson'),'utf8'),'old');assert.equal(await readFile(join(directory,'unrelated.txt'),'utf8'),marker);
});

test('write failures are nonfatal and fixed, close waits for startup and pending writes and rejects later records',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-close-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const bad=join(directory,marker);await writeFile(bad,'synthetic occupied file');const failed=new ServerDiagnostics({directory:bad});await failed.init();failed.record('request.completed');await failed.close();assert.ok(failed.snapshot().writeFailures>0);assert.ok(!JSON.stringify(failed.snapshot()).includes(marker));
  const d=new ServerDiagnostics({directory:join(directory,'logs')});const initializing=d.init();await Promise.all([initializing,d.close(),d.close()]);d.record('server.started');assert.equal(d.snapshot().lastSeq,0);
  const active=new ServerDiagnostics({directory:join(directory,'active')});await active.init();for(let i=0;i<40;i++)active.record('request.completed');const closing=active.close();assert.equal(active.close(),closing);await closing;const before=await readFile(filePath(join(directory,'active')),'utf8');active.record('request.completed');await delay(5);assert.equal(await readFile(filePath(join(directory,'active')),'utf8'),before);assert.equal(active.snapshot().pendingWrites,0);
});

test('real agent error classes map to safe categories without exposing provider messages',()=>{
  assert.equal(safeError(new AgentNotConfiguredError()).category,'model_not_configured');assert.equal(safeError(new AgentNotConfiguredError()).status,503);
  const timeout=safeError(new AgentTimeoutError());assert.equal(timeout.status,504);assert.equal(timeout.category,'timeout');assert.ok(!JSON.stringify(timeout).includes(marker));
  const error=safeError(new AgentResponseError(marker));assert.equal(error.status,502);assert.equal(error.category,'agent_response');assert.ok(!JSON.stringify(error).includes(marker));
  const limited=safeError(new AgentResponseError(marker,'output_limit'));assert.equal(limited.reason,'output_limit');assert.ok(limited.message);assert.ok(!JSON.stringify(limited).includes(marker));
  const malformed=safeError(new AgentResponseError(marker,'invalid_json'));assert.equal(malformed.reason,'invalid_json');assert.notEqual(malformed.reason,limited.reason);
  const imageDenied=safeError(new AgentResponseError(marker,'image_disclosure_disabled'));assert.equal(imageDenied.reason,'image_disclosure_disabled');assert.ok(imageDenied.message);assert.ok(!JSON.stringify(imageDenied).includes(marker));
  assert.equal(safeError(Object.assign(new AgentResponseError(marker),{reason:marker})).reason,'invalid_response');
  assert.ok(!JSON.stringify(safeError(Object.assign(new Error(marker),{name:marker,code:marker,statusCode:502}))).includes(marker));
  assert.equal(safeError({get name(){throw new Error(marker);}}).category,'internal');
});

test('actual storage exhaustion maps narrowly to a safe retryable full-storage error',()=>{
 for(const detail of [{code:'ENOSPC'},{code:'EDQUOT'},{errcode:13}]){
  const failure=Object.assign(new Error(marker),detail),view=safeError(failure);
  assert.equal(view.status,507);assert.equal(view.category,'storage_full');assert.ok(view.message);assert.ok(!JSON.stringify(view).includes(marker));
 }
 for(const detail of [{code:'EACCES'},{code:'EPERM'},{errcode:19},{errcode:8},{errcode:10}])assert.notEqual(safeError(Object.assign(new Error(marker),detail)).status,507);
});

test('a second live logger cannot rotate another logger files and an old same-PID lock recovers',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-owner-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'central.lock'),JSON.stringify({pid:process.pid,startedAt:1,instanceId:randomUUID()}));
  const first=new ServerDiagnostics({directory});await first.init();first.record('server.started');await first.flush();
  const original=await readFile(filePath(directory),'utf8');const second=new ServerDiagnostics({directory,maxBytes:1024});await second.init();second.record('agent.failed',{category:'internal'},'error');await second.close();assert.ok(second.snapshot().writeFailures>0);assert.equal(await readFile(filePath(directory),'utf8'),original);
  await first.close();await assert.rejects(stat(join(directory,'central.lock')),{code:'ENOENT'});
});

test('authenticated support API correlates stages while excluding all fixture body, credentials and raw URL metadata',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-api-'));const cfg=config(directory);const {app,diagnostics}=await buildApp(cfg,{agent:inactive});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});const headers={authorization:`Bearer ${cfg.privateCredential!.token}`,'x-request-id':marker};
  for(const url of ['/api/diagnostics','/api/diagnostics/events','/api/support-bundle'])assert.equal((await app.inject(url)).statusCode,401);
  const f={id:randomUUID(),deviceId:marker,deviceName:marker,platform:'import',capturedAt:'2020-01-02T12:00:00Z',text:marker,mood:marker};
  const saved=await app.inject({method:'POST',url:`/api/notes?raw=${marker}`,headers,payload:f});assert.equal(saved.statusCode,201);const id=saved.headers['x-request-id'];assert.match(String(id),/^[0-9a-f-]{36}$/);assert.notEqual(id,marker);
  const list=await app.inject({url:'/api/notes',headers});assert.equal(list.statusCode,200);
  const invalid=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:marker,[marker]:marker}});assert.equal(invalid.statusCode,503);assert.equal(invalid.json().requestId,invalid.headers['x-request-id']);assert.ok(!invalid.body.includes(marker));
  const bundle=await app.inject({url:'/api/support-bundle',headers});assert.equal(bundle.statusCode,200);assert.match(String(bundle.headers['content-disposition']),/attachment/);assert.match(String(bundle.headers['cache-control']),/no-store/);const body=bundle.json();
  assert.equal(body.snapshot.storage.captures,1);assert.equal(body.snapshot.queue.index.textReady,1);assert.ok(body.events.some((e:any)=>e.event==='ingest.completed'&&e.requestId===id&&e.operation==='note'));assert.ok(body.events.some((e:any)=>e.event==='source.completed'&&e.requestId===list.headers['x-request-id']));
  for(const secret of [marker,cfg.privateCredential!.token,cfg.initialDocument!.models.deployment.apiKey,directory,'2020-01-02'])assert.ok(!bundle.body.includes(secret));
  await diagnostics.flush();for(const name of await readdir(join(directory,'logs'))){const text=await readFile(join(directory,'logs',name),'utf8');for(const secret of [marker,cfg.privateCredential!.token,cfg.initialDocument!.models.deployment.apiKey,directory])assert.ok(!text.includes(secret));}
});

test('collector credentials cannot read owner-level diagnostics and the safe snapshot omits secrets',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-collector-'));const cfg=config(directory);const {app}=await buildApp(cfg,{agent:inactive});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${cfg.privateCredential!.token}`};
  const invitation=await app.inject({method:'POST',url:'/api/connections/collector-invitations',headers,payload:{serverUrl:'https://synthetic.invalid',label:'Generated collector'}});
  assert.equal(invitation.statusCode,200,invitation.body);
  const redeemed=await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.json().invitation.code,deviceId:'generated-collector',deviceName:'Generated collector',platform:'android'}});
  assert.equal(redeemed.statusCode,200,redeemed.body);const collector=redeemed.json().token as string;
  for(const url of ['/api/diagnostics','/api/diagnostics/events','/api/support-bundle']){
    const denied=await app.inject({url,headers:{authorization:`Bearer ${collector}`}});
    assert.equal(denied.statusCode,403,url);assert.ok(!denied.body.includes(collector));assert.ok(!denied.body.includes(cfg.privateCredential!.token));
  }
  const owner=await app.inject({url:'/api/diagnostics',headers});
  assert.equal(owner.statusCode,200,owner.body);
  for(const secret of [cfg.privateCredential!.token,cfg.initialDocument!.models.deployment.apiKey,directory,collector])assert.ok(!owner.body.includes(secret),'diagnostic snapshot must not include '+(secret===collector?'collector token':'secret material'));
});

test('concurrent requests keep independent request IDs, and SDK failures cannot leak into responses or support exports',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-agent-'));const cfg=config(directory);
  const agent:QueryAgent={configured:true,close:async()=>{},query:async args=>{await delay(args.question==='fixture slow'?15:1);if(args.question===marker)throw Object.assign(new Error(marker+' https://provider.invalid/?key='+marker),{name:marker,code:marker,statusCode:502});return {answer:args.question,citations:[],trace:[],runId:randomUUID()};}};
  const {app,diagnostics}=await buildApp(cfg,{agent});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});const headers={authorization:`Bearer ${cfg.privateCredential!.token}`};
  const responses=await Promise.all(['fixture slow','fixture fast'].map(question=>app.inject({method:'POST',url:'/api/query',headers,payload:{question}})));const ids=responses.map(r=>r.headers['x-request-id']);assert.notEqual(ids[0],ids[1]);for(const id of ids)assert.equal(diagnostics.events().items.filter(e=>e.requestId===id&&e.event==='agent.completed').length,1);
  const failed=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:marker}});assert.equal(failed.statusCode,502);assert.ok(!failed.body.includes(marker));assert.equal(failed.json().requestId,failed.headers['x-request-id']);
  for(const url of [`/api/${marker}?token=${marker}`,`/api/%zz?token=${marker}`]){const result=await app.inject({url,headers});assert.ok(result.statusCode>=400);assert.ok(!result.body.includes(marker));}
  const bundle=await app.inject({url:'/api/support-bundle',headers});assert.ok(!bundle.body.includes(marker));assert.ok(bundle.json().events.some((e:any)=>e.requestId===failed.headers['x-request-id']&&e.event==='agent.failed'));
});

test('enabled Agent trace is correlated with the request and is visible in ordinary diagnostics but not safe support export',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-agent-trace-api-'));
  const cfg=config(directory,{traceEnabled:true,traceExpiresAt:Date.now()+60*60*1000});
  const agent:QueryAgent={configured:true,close:async()=>{},query:async args=>{args.onTrace?.({type:'fixture.model.completed',stage:'model',status:'succeeded',payload:{prompt:marker,context:'synthetic fixture'}});return {answer:'fixture',citations:[],trace:[],runId:randomUUID()};}};
  const {app,diagnostics}=await buildApp(cfg,{agent});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});const headers={authorization:`Bearer ${cfg.privateCredential!.token}`};
  const response=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'synthetic trace request'}});assert.equal(response.statusCode,200);await diagnostics.flush();
  const ownerEvents=await app.inject({url:'/api/diagnostics/events',headers});
  assert.equal(ownerEvents.statusCode,200,ownerEvents.body);
  const {items}=ownerEvents.json<ReturnType<typeof diagnostics.events>>();
  const trace=items.find(event=>event.event==='agent.trace'&&event.requestId===response.headers['x-request-id']&&event.trace?.type==='fixture.model.completed');
  assert.ok(trace?.trace);
  assert.equal((trace.trace.payload as Record<string,unknown>).prompt,marker);
  assert.equal(diagnostics.snapshot().agentTrace.enabled,true);
  const bundle=await app.inject({url:'/api/support-bundle',headers});
  assert.equal(bundle.statusCode,200,bundle.body);
  assert.ok(!bundle.body.includes(marker));
});

test('disabled central diagnostics keeps the authenticated numeric status available without recording',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-off-api-'));
  const cfg=config(directory,{enabled:false});
  const {app}=await buildApp(cfg,{agent:inactive});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${cfg.privateCredential!.token}`};
  assert.equal((await app.inject({url:'/api/diagnostics'})).statusCode,401);
  assert.equal((await app.inject({url:'/api/status',headers})).statusCode,200);
  const status=await app.inject({url:'/api/diagnostics',headers});
  assert.equal(status.statusCode,200,status.body);
  assert.equal(status.json().enabled,false);
  assert.ok(status.json().runtime.rssBytes>0);
  const bundle=await app.inject({url:'/api/support-bundle',headers});
  assert.equal(bundle.statusCode,200,bundle.body);
  assert.equal(bundle.json().snapshot.enabled,false);
  assert.equal(bundle.json().snapshot.retainedEvents,0);
  assert.deepEqual(bundle.json().events,[]);
  await assert.rejects(stat(join(directory,'logs')),{code:'ENOENT'});
});

test('request bursts keep model configuration errors correlated and safe',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-rate-'));const cfg=config(directory);const {app}=await buildApp(cfg,{agent:inactive});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${cfg.privateCredential!.token}`};let last;
  for(let i=0;i<11;i++)last=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:marker}});
  assert.equal(last!.statusCode,503);assert.equal(last!.json().error,'model_not_configured');assert.equal(last!.json().requestId,last!.headers['x-request-id']);assert.ok(!last!.body.includes(marker));
});

test('request correlation survives the per-query local HTTP tool bridge boundary',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-tool-'));const cfg=config(directory);let diagnostics:ServerDiagnostics;
  const agent:QueryAgent={configured:true,close:async()=>{},query:async()=>{
    const bridge=createServer(async(_req,res)=>{await diagnostics.measure('source','evidence',async()=>{await delay(1);return [marker];},rows=>({count:rows.length}));res.end('synthetic tool ACK');});
    await new Promise<void>(resolve=>bridge.listen(0,'127.0.0.1',resolve));
    try{const response=await fetch(`http://127.0.0.1:${(bridge.address() as AddressInfo).port}/`,{signal:AbortSignal.timeout(2000)});await response.text();}
    finally{await new Promise<void>((resolve,reject)=>bridge.close(e=>e?reject(e):resolve()));}
    return {answer:'fixture',citations:[],trace:[],runId:randomUUID()};
  }};
  const built=await buildApp(cfg,{agent});diagnostics=built.diagnostics;t.after(async()=>{await built.app.close();await rm(directory,{recursive:true,force:true});});
  const responses=await Promise.all([1,2].map(()=>built.app.inject({method:'POST',url:'/api/query',headers:{authorization:`Bearer ${cfg.privateCredential!.token}`},payload:{question:'synthetic bridge request'}})));
  for(const response of responses){assert.equal(response.statusCode,200);assert.equal(diagnostics.events().items.filter(e=>e.event==='source.completed'&&e.requestId===response.headers['x-request-id']).length,1);}
  assert.ok(!JSON.stringify(diagnostics.events()).includes(marker));
});

test('background indexing records timings, queue state and only a fixed failure marker',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-index-'));const cfg=((sourceInput:ConfigurationPlatformOptions)=>({...sourceInput,initialDocument:{...sourceInput.initialDocument!,models:{...((sourceInput.initialDocument! as Record<string,unknown>)["models"] as Record<string,unknown>),embedding:{...(((sourceInput.initialDocument! as Record<string,unknown>)["models"] as Record<string,unknown>)["embedding"] as Record<string,unknown>),model:'synthetic-model',baseUrl:'http://127.0.0.1:1'}}}}))(config(directory));
  const node=await buildApp(cfg,{agent:inactive}),{app,indexer,store,diagnostics}=node;t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  await authorizeFixtureModels(node);
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error(marker);});
  const id=randomUUID();await store.ingest({id,deviceId:'fixture',deviceName:'fixture',platform:'import',capturedAt:'2020-01-01T00:00:00Z',source:'note',ocrText:marker,durationMs:0});await indexer.tick();
  assert.equal(calls,1);assert.equal(store.indexCounts().failed,1);const stored=store.db.prepare('SELECT index_error FROM captures WHERE id=?').get(id) as {index_error:string};assert.equal(stored.index_error,'embedding_transport');
  const failed=diagnostics.events().items.find(e=>e.event==='index.failed');assert.ok(failed);assert.equal(failed.operation,'embedding');assert.equal(typeof failed.durationMs,'number');assert.match(failed.requestId!,/^[a-f0-9-]{36}$/);assert.ok(diagnostics.events().items.some(e=>e.event==='queue.snapshot'&&e.failed===1&&e.requestId===failed.requestId));assert.ok(!JSON.stringify(diagnostics.events()).includes(marker));
});

test('explicit agent timeout returns correlated 504 diagnostics while invalid answers remain 502 and capacity waits stay recoverable',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-timeout-')),cfg=config(directory);
  let failure:Error=new AgentTimeoutError(),modelCalls=0;
  const agent:QueryAgent={configured:true,close:async()=>{},query:async()=>{modelCalls++;throw failure;}};
  const {app,diagnostics}=await buildApp(cfg,{agent});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${cfg.privateCredential!.token}`};
  const timed=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:marker}});
  assert.equal(timed.statusCode,504);assert.equal(timed.json().error,'timeout');assert.equal(timed.json().requestId,timed.headers['x-request-id']);assert.ok(timed.json().message);
  const events=diagnostics.events(0,500).items.filter(e=>e.requestId===timed.headers['x-request-id']);
  assert.ok(events.some(e=>e.event==='agent.failed'&&e.category==='timeout'));
  assert.ok(events.some(e=>e.event==='request.failed'&&e.category==='timeout'&&e.statusCode===504));
  failure=new AgentResponseError(marker);const invalid=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:marker}});
  assert.equal(invalid.statusCode,502);assert.equal(invalid.json().error,'agent_response');
  failure=new AgentProviderError({category:'blocked',code:'provider_authentication'});failure.message=marker;const auth=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:marker}});assert.equal(auth.statusCode,502);assert.equal(auth.json().recovery,'needs_action');assert.equal(auth.json().reason,'provider_authentication');assert.ok(!auth.body.includes(marker));
  failure=new AgentProviderError({category:'transient',code:'rate_limited',retryAfterMs:12000});failure.message=marker;
  const before=modelCalls,waitingIds=[randomUUID(),randomUUID()];
  // Synchronous release/publication is covered by foreground-capacity-wait.
  // Diagnostics observes durable waits here, then explicitly cancels them
  // instead of waiting for the generated twelve-second cooldown to expire.
  for(const id of waitingIds){
    assert.equal((await app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:marker}}})).statusCode,202);
    let background:any;for(let i=0;i<50;i++){await new Promise(r=>setImmediate(r));background=(await app.inject({url:'/api/query-runs/'+id,headers})).json();if(background.execution?.failure?.code==='rate_limited')break;}
    assert.equal(background.status,'running');assert.equal(background.execution.status,'retry_wait');assert.equal(background.execution.attempts,0);assert.equal(background.execution.failure.code,'rate_limited');assert.equal(background.error,undefined,'a capacity wait must not create terminal failure history');assert.equal(background.execution.failure.recovery,'auto_retry');assert.ok(background.execution.failure.retryAfterMs>0);assert.ok(background.execution.failure.retryAfterMs<=12000);
    assert.equal(modelCalls,before+1,'shared cooldown must wait before invoking another model');
  }
  assert.equal((await app.inject({url:'/api/execution-settings',headers})).json().providers.coolingDown,1);
  const bundle=await app.inject({url:'/api/support-bundle',headers});for(const privateValue of [marker,cfg.privateCredential!.token,cfg.initialDocument!.models.deployment.apiKey])assert.ok(!bundle.body.includes(privateValue));
  for(const id of waitingIds)assert.equal((await app.inject({method:'POST',url:'/api/query-runs/'+id+'/cancel',headers})).json().status,'cancelled');
  assert.equal(modelCalls,before+1);
});

test('raw log endpoint returns file text verbatim with owner authentication and no cache', async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mote-raw-log-'));
  const cfg=config(dataDir),headers={authorization:`Bearer ${cfg.privateCredential!.token}`};
  const {app,diagnostics}=await buildApp(cfg,{agent:inactive});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const unauthorized=await app.inject({method:'GET',url:'/api/diagnostics/logs'});
  assert.equal(unauthorized.statusCode,401);
  await diagnostics.flush();
  const path=seedPath(join(dataDir,'logs')),fileId=path.split('/').at(-1)!.split('.')[4];
  const raw='  {"level":"info"}\nmalformed <script>中文 fixture</script>\n';
  await writeFile(path,raw);
  // Read directly so debug request-start writes do not alter the exact-byte assertion.
  assert.equal(await diagnostics.readRaw(),raw);
  await writeFile(seedPath(join(dataDir,'logs'),1),raw);
  assert.equal(await diagnostics.readRaw(1),raw);
  const latestPage=await diagnostics.readPage(0,1,1);assert.deepEqual(latestPage,{items:['malformed <script>中文 fixture</script>'],page:1,pageSize:1,totalLines:2,totalPages:2,hasPrevious:true,hasNext:false});
  const olderPage=await diagnostics.readPage(0,2,1);assert.deepEqual(olderPage.items,['  {"level":"info"}']);
  await assert.rejects(diagnostics.readRaw(-1));
  const result=await app.inject({method:'GET',url:'/api/diagnostics/logs?file='+fileId,headers});
  assert.equal(result.statusCode,200);assert.match(result.headers['content-type']!,/^text\/plain/);
  assert.equal(result.headers['cache-control'],'no-store');assert.ok(result.body.startsWith(raw));
  const pageResult=await app.inject({method:'GET',url:'/api/diagnostics/log-pages?file='+fileId+'&page=1&pageSize=1',headers});
  assert.equal(pageResult.statusCode,200);assert.equal(pageResult.headers['cache-control'],'no-store');const pageBody=pageResult.json();assert.equal(pageBody.page,1);assert.equal(pageBody.pageSize,1);assert.equal(pageBody.totalLines,pageBody.totalPages);assert.ok(pageBody.items.length===1);assert.ok(pageBody.totalLines>=latestPage.totalLines);
  const filtered=await app.inject({method:'GET',url:'/api/diagnostics/log-pages?file='+fileId+'&page=1&pageSize=10&stage=unknown',headers});
  assert.equal(filtered.statusCode,200);assert.equal(filtered.json().totalLines,2);assert.equal((await app.inject({method:'GET',url:'/api/diagnostics/log-pages?stage=invalid',headers})).statusCode,400);
});

test('stage failures use warning for rejected input and error for failed execution', async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-levels-'));const d=new ServerDiagnostics({directory,debug:true});
  t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
  await assert.rejects(d.measure('ingest','note',()=>{throw {statusCode:400};}));
  await assert.rejects(d.measure('index','embedding',()=>{throw new Error('synthetic');}));
  assert.deepEqual(d.events().items.map(e=>e.level),['debug','warn','debug','error']);
  assert.deepEqual(d.events().items.map(e=>e.stage),['ingest','ingest','index','index']);
  await d.flush();const pages=await Promise.all(d.snapshot().retention.files.map((_,index)=>d.readPage(index,1,100,'ingest')));const rows=pages.flatMap(page=>page.items);assert.equal(rows.length,2);assert.ok(rows.every(line=>JSON.parse(line).stage==='ingest'));
});

test('memory validation diagnostics survive reload without trace opt-in and reject arbitrary details',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-validation-diagnostics-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const d=new ServerDiagnostics({directory,traceEnabled:false});await d.init();
  const batchId=randomUUID(),runId=randomUUID(),evidenceId=randomUUID();
  d.record('agent.memory_validation_failed',{batchId,runId,evidenceId,validationCode:'quote_ambiguous',validationPhase:'extract',candidateIndex:0,spanIndex:1,authorizedMatches:2,...{quote:marker,source:marker,message:marker}},'warn');
  const coverageDetails=[
    {fieldPath:'coverage[1].candidateIndexes[0]',problem:'unsupported_candidate_for_target',candidateIndex:0},
    {fieldPath:'coverage[2].candidateIndexes',problem:'missing_candidate_for_supporting_target',candidateIndex:1},
    {fieldPath:'coverage[2].key',problem:'unknown_target_key'},
    {fieldPath:'coverage[3].key',problem:'duplicate_target_key'},
  ];
  for(const details of coverageDetails){
    d.record('agent.memory_validation_failed',{batchId,runId,validationCode:'coverage',validationPhase:'review',...details},'warn');
  }
  d.record('agent.memory_validation_failed',{batchId:marker,validationCode:marker,validationPhase:marker,declaredOffset:-1,problem:marker} as never,'warn');
  await d.close();const raw=await readFile(filePath(directory),'utf8');assert.ok(!raw.includes(marker));
  const reloaded=new ServerDiagnostics({directory});await reloaded.init();t.after(()=>reloaded.close());
  const events=reloaded.events().items;assert.equal(events.length,coverageDetails.length+2);assert.equal(events[0].batchId,batchId);assert.equal(events[0].runId,runId);assert.equal(events[0].evidenceId,evidenceId);assert.equal(events[0].validationCode,'quote_ambiguous');assert.equal(events[0].validationPhase,'extract');assert.equal(events[0].authorizedMatches,2);assert.equal(events[0].stage,'agent');
  for(const [index,details] of coverageDetails.entries()){
    const event=events[index+1];
    assert.equal(event.validationPhase,'review');
    assert.equal(event.validationCode,'coverage');
    assert.equal(event.fieldPath,details.fieldPath);
    assert.equal(event.problem,details.problem);
    assert.equal(event.candidateIndex,details.candidateIndex);
  }
  const rejected=events.at(-1)!;
  assert.equal(rejected.validationCode,undefined);
  assert.equal(rejected.declaredOffset,undefined);
  assert.equal(rejected.problem,undefined);
});

test('saved diagnostic preferences apply immediately and survive app restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-live-preferences-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let {app}=await buildApp(config(directory,{enabled:false}),{agent:inactive});
 const headers={authorization:'Bearer synthetic-observability-token-only'};
 try{
  const {enabled,revision}=(await app.inject({url:'/api/diagnostics-settings',headers})).json();assert.equal(enabled,false);
  const update=await app.inject({method:'PUT',url:'/api/diagnostics-settings',headers,payload:{revision,enabled:true,debug:true,traceEnabled:true,level:'debug'}});assert.equal(update.statusCode,200,update.body);
  const status=(await app.inject({url:'/api/diagnostics',headers}));assert.equal(status.statusCode,200);
  assert.equal((await app.inject({url:'/api/diagnostics-settings',headers})).json().traceEnabled,true);
  const execution=await app.inject({method:'PUT',url:'/api/execution-settings',headers,payload:{revision:update.json().revision,agentConcurrency:6,llmConcurrency:3,memoryConcurrency:2}});assert.equal(execution.statusCode,200,execution.body);
  const invalid=await app.inject({method:'PUT',url:'/api/execution-settings',headers,payload:{revision:execution.json().revision,agentConcurrency:0,llmConcurrency:3,memoryConcurrency:2}});assert.equal(invalid.statusCode,400);
 }finally{await app.close();}
 ({app}=await buildApp(config(directory),{agent:inactive}));try{assert.equal((await app.inject({url:'/api/diagnostics-settings',headers})).json().traceEnabled,true);const settings=(await app.inject({url:'/api/execution-settings',headers})).json();assert.equal(settings.agentConcurrency,6);assert.equal(settings.queues.agents.limit,6);}finally{await app.close();}
});

test('live trace and logger toggles change the existing writer without restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-live-logger-')),d=new ServerDiagnostics({directory,enabled:false});t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});
 await d.init();await d.configure({enabled:true,debug:false,traceEnabled:true,level:'info'});
 d.agentTrace({type:'fixture.first',payload:{prompt:'generated'}},{});d.record('server.started');await d.flush();const count=d.recent().length;assert.ok(count>=2);
 await d.configure({enabled:true,debug:false,traceEnabled:false,level:'info'});d.agentTrace({type:'fixture.hidden',payload:{}},{});assert.equal(d.recent().length,count);
 await d.configure({enabled:false,debug:false,traceEnabled:false,level:'info'});d.record('server.started');assert.equal(d.recent().length,count);
 await d.configure({enabled:true,debug:false,traceEnabled:false,level:'info'});d.record('server.started');await d.flush();assert.equal(d.recent().length,count+1);assert.equal(d.snapshot().writeFailures,0);
});

test('tool rejections retain only approved error codes and budget metrics without requiring trace',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-tool-diagnostics-')),d=new ServerDiagnostics({directory,traceEnabled:false});
  try{await d.init();d.record('agent.tool_rejected',{toolErrorCode:'evidence_range_exceeded',remainingCalls:8,remainingCharacters:12000,repeatCount:1,...{message:'PRIVATE_FIXTURE',arguments:'PRIVATE_FIXTURE'}},'warn');
    d.record('agent.tool_rejected',{toolErrorCode:'PRIVATE_FIXTURE'},'warn');
    const entries=d.recent().filter(e=>e.event==='agent.tool_rejected');assert.equal(entries[0].toolErrorCode,'evidence_range_exceeded');assert.equal(entries[0].remainingCalls,8);assert.ok(!JSON.stringify(entries).includes('PRIVATE_FIXTURE'));
  }finally{await d.close();await rm(directory,{recursive:true,force:true});}
});

test('owner cleanup previews the exact time range, rejects collector writes and preserves later records',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-log-cleanup-api-'));const cfg=config(directory);const {app,diagnostics,connections}=await buildApp(cfg,{agent:inactive});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});const headers={authorization:'Bearer '+cfg.privateCredential!.token};
 await diagnostics.configure({enabled:true,debug:false,traceEnabled:true,level:'info'});diagnostics.agentTrace({type:'fixture.private',payload:{prompt:marker}});await diagnostics.flush();
 const unauthorized=await app.inject({method:'POST',url:'/api/diagnostics/cleanup-preview',payload:{kind:'all'}});assert.equal(unauthorized.statusCode,401);
 const {readAgentCredential}=await import('./login-fixture.js');connections.invite({serverUrl:'http://127.0.0.1:1234',label:'Generated collector'});const collector=await readAgentCredential(connections);
 assert.equal((await app.inject({method:'POST',url:'/api/diagnostics/cleanup-preview',headers:{authorization:'Bearer '+collector.token},payload:{kind:'all'}})).statusCode,403);
 const preview=await app.inject({method:'POST',url:'/api/diagnostics/cleanup-preview',headers,payload:{kind:'trace'}});assert.equal(preview.statusCode,200,preview.body);const plan=preview.json();assert.equal(plan.files.length,1);assert.ok(plan.bytes>0);assert.ok(plan.oldestAt);assert.ok(!preview.body.includes(marker));
 diagnostics.agentTrace({type:'fixture.later',payload:{prompt:'Generated later trace'}});await diagnostics.flush();
 assert.equal((await app.inject({method:'POST',url:'/api/diagnostics/cleanup',headers,payload:plan})).statusCode,409);
 const current=(await app.inject({method:'POST',url:'/api/diagnostics/cleanup-preview',headers,payload:{kind:'trace'}})).json();assert.equal((await app.inject({method:'POST',url:'/api/diagnostics/cleanup',headers,payload:current})).statusCode,200);
 const status=(await app.inject({url:'/api/diagnostics',headers})).json();assert.equal(status.retention.channels.find((c:any)=>c.channel==='trace').bytes,0);assert.ok(status.retention.channels.find((c:any)=>c.channel==='info').bytes>0);assert.equal(status.retention.lastCleanup.reason,'manual');
});

test('detailed tracing stops after 24 hours and repeated low-level noise cannot evict a failure summary',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-trace-expiry-'));let now=new Date('2026-10-01T00:00:00Z');const d=new ServerDiagnostics({directory,maxEntries:3,traceEnabled:true,now:()=>now});t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
 d.record('agent.failed',{category:'unavailable',diagnostic:{source:'http',httpStatus:503,stage:'model'}},'error');for(let i=0;i<10;i++)d.agentTrace({type:'fixture.noise'});assert.ok(d.recent().some(e=>e.level==='error'));await d.flush();
 now=new Date('2026-10-02T00:00:00Z');const seq=d.snapshot().lastSeq;d.agentTrace({type:'fixture.after-expiry'});assert.equal(d.snapshot().lastSeq,seq);assert.equal(d.snapshot().agentTrace.enabled,false);
});
