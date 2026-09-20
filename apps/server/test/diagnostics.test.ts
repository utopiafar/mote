import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,readdir,rm,writeFile,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentNotConfiguredError,AgentResponseError,AgentTimeoutError } from '@mote/agent';
import { ServerDiagnostics,safeError,serializeDiagnosticEvent } from '../src/diagnostics.js';
import { buildApp,type QueryAgent } from '../src/app.js';
import type { Config } from '../src/config.js';

const marker='SYNTHETIC_PRIVATE_BODY_TOKEN_URL_QUERY';
const config=(dataDir:string):Config=>({dataDir,token:'synthetic-observability-token-only',tokenPath:join(dataDir,'synthetic-token-file'),host:'127.0.0.1',port:47832,dataKey:undefined,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'synthetic-provider-credential',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsDebug:true});
const inactive:QueryAgent={configured:false,query:async()=>{throw new Error('fixture must not run');},close:async()=>{}};

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
  await d.flush();const text=await readFile(join(directory,'central.0.ndjson'),'utf8');assert.ok(!text.includes(marker));assert.ok(!JSON.stringify(d.snapshot()).includes(directory));
  const rows=d.events().items;assert.equal(rows.length,2);assert.equal(rows[0].count,2);assert.equal(rows[0].durationMs,1.25);assert.equal(rows[0].requestId,undefined);assert.equal(rows[0].category,undefined);assert.equal(rows[0].bytes,undefined);
  assert.equal((await stat(join(directory,'central.0.ndjson'))).mode&0o777,0o600);
});

test('diagnostic log lines truncate instead of dropping oversized events',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-line-limit-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const base={seq:1,at:'2026-09-20T12:00:00.000Z',instanceId:randomUUID(),event:'server.started',level:'info'};
  const accepted=serializeDiagnosticEvent({...base,padding:'x'.repeat(19*1024)} as never);const truncated=serializeDiagnosticEvent({...base,seq:2,padding:'x'.repeat(25*1024)} as never);
  assert.ok(Buffer.byteLength(accepted)<=20*1024);assert.ok(Buffer.byteLength(truncated)<=20*1024);assert.equal(JSON.parse(accepted).truncated,undefined);assert.equal(JSON.parse(truncated).truncated,true);
  const legacyOversized=JSON.stringify({...base,seq:3,padding:'x'.repeat(25*1024)})+'\n';await writeFile(join(directory,'central.0.ndjson'),accepted+legacyOversized);
  const d=new ServerDiagnostics({directory,maxBytes:64*1024,maxFiles:1});await d.init();assert.equal(d.events().items.length,2);assert.deepEqual(d.events().items.map(event=>event.seq),[1,3]);await d.close();
});

test('log rotation, memory, pending queue and forward cursor remain bounded under bursts',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-bounds-'));const d=new ServerDiagnostics({directory,maxBytes:1024,maxFiles:3,maxEntries:17});t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
  for(let round=0;round<20;round++) {for(let i=0;i<100;i++)d.record('request.completed',{count:i});assert.ok(d.snapshot().pendingWrites<=81);await d.flush();}
  assert.equal(d.snapshot().retainedEvents,17);assert.ok(d.snapshot().droppedEvents>0);assert.equal(d.snapshot().pendingWrites,0);
  const files=(await readdir(directory)).filter(name=>/^central\.\d+\.ndjson$/.test(name));assert.ok(files.length<=3);
  for(const file of files)assert.ok((await stat(join(directory,file))).size<=1024);
  const all=d.events(0,500).items;let cursor=0,received:number[]=[];
  for(;;){const page=d.events(cursor,3);if(!page.items.length)break;received.push(...page.items.map(r=>r.seq));cursor=page.nextSeq;}
  assert.deepEqual(received,all.map(r=>r.seq));assert.deepEqual(d.recent(3).map(r=>r.seq),all.slice(-3).map(r=>r.seq));
});

test('daily boundaries rotate without changing indexed file compatibility',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-daily-'));let now=new Date('2026-09-20T23:59:59.000Z');
  const options=()=>({directory,debug:true,maxBytes:1024,maxFiles:3,now:()=>now});const d=new ServerDiagnostics(options());t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
  d.record('server.started');await d.flush();await d.close();
  now=new Date('2026-09-21T00:00:00.000Z');const restarted=new ServerDiagnostics(options());await restarted.init();restarted.record('server.started');await restarted.flush();
  const current=JSON.parse((await readFile(join(directory,'central.0.ndjson'),'utf8')).trim());const history=JSON.parse((await readFile(join(directory,'central.1.ndjson'),'utf8')).trim());
  assert.equal(current.at.slice(0,10),'2026-09-21');assert.equal(history.at.slice(0,10),'2026-09-20');assert.equal((await restarted.readRaw(0)).trim(),JSON.stringify(current));assert.equal((await restarted.readRaw(1)).trim(),JSON.stringify(history));
  await restarted.close();
});

test('restart filters foreign fields, discards partial writes, bounds old logs and preserves sequence',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-restart-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const event={seq:8,at:new Date().toISOString(),instanceId:randomUUID(),event:'source.completed',level:'info',operation:'evidence',count:1,message:marker,requestId:marker};
  await writeFile(join(directory,'central.0.ndjson'),JSON.stringify(event)+'\n{"unfinished":"'+marker,{mode:0o644});
  await writeFile(join(directory,'central.1.ndjson'),'x'.repeat(3000));await writeFile(join(directory,'central.9.ndjson'),'old');await writeFile(join(directory,'unrelated.txt'),marker);
  const d=new ServerDiagnostics({directory,maxBytes:1024,maxFiles:2,maxEntries:20});await d.init();assert.equal(d.events().items.length,1);assert.ok(!JSON.stringify(d.events()).includes(marker));d.record('server.started');await d.close();
  const text=await readFile(join(directory,'central.0.ndjson'),'utf8');const lines=text.trim().split('\n').map(row=>JSON.parse(row));assert.equal(lines.at(-1).seq,9);assert.equal((await stat(join(directory,'central.1.ndjson'))).size,0);await assert.rejects(stat(join(directory,'central.9.ndjson')),{code:'ENOENT'});assert.equal(await readFile(join(directory,'unrelated.txt'),'utf8'),marker);
});

test('write failures are nonfatal and fixed, close waits for startup and pending writes and rejects later records',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-close-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const bad=join(directory,marker);await writeFile(bad,'synthetic occupied file');const failed=new ServerDiagnostics({directory:bad});await failed.init();failed.record('request.completed');await failed.close();assert.ok(failed.snapshot().writeFailures>0);assert.ok(!JSON.stringify(failed.snapshot()).includes(marker));
  const d=new ServerDiagnostics({directory:join(directory,'logs')});const initializing=d.init();await Promise.all([initializing,d.close(),d.close()]);d.record('server.started');assert.equal(d.snapshot().lastSeq,0);
  const active=new ServerDiagnostics({directory:join(directory,'active')});await active.init();for(let i=0;i<40;i++)active.record('request.completed');const closing=active.close();assert.equal(active.close(),closing);await closing;const before=await readFile(join(directory,'active','central.0.ndjson'),'utf8');active.record('request.completed');await delay(5);assert.equal(await readFile(join(directory,'active','central.0.ndjson'),'utf8'),before);assert.equal(active.snapshot().pendingWrites,0);
});

test('real agent error classes map to safe categories without exposing provider messages',()=>{
  assert.equal(safeError(new AgentNotConfiguredError()).category,'model_not_configured');assert.equal(safeError(new AgentNotConfiguredError()).status,503);
  const timeout=safeError(new AgentTimeoutError());assert.equal(timeout.status,504);assert.equal(timeout.category,'timeout');assert.ok(!JSON.stringify(timeout).includes(marker));
  const error=safeError(new AgentResponseError(marker));assert.equal(error.status,502);assert.equal(error.category,'agent_response');assert.ok(!JSON.stringify(error).includes(marker));
  const limited=safeError(new AgentResponseError(marker,'output_limit'));assert.equal(limited.reason,'output_limit');assert.match(limited.message,/输出上限/);assert.ok(!JSON.stringify(limited).includes(marker));
  const malformed=safeError(new AgentResponseError(marker,'invalid_json'));assert.equal(malformed.reason,'invalid_json');assert.notEqual(malformed.message,limited.message);
  assert.equal(safeError(Object.assign(new AgentResponseError(marker),{reason:marker})).reason,'invalid_response');
  assert.ok(!JSON.stringify(safeError(Object.assign(new Error(marker),{name:marker,code:marker,statusCode:502}))).includes(marker));
  assert.equal(safeError({get name(){throw new Error(marker);}}).category,'internal');
});

test('a second live logger cannot rotate another logger files and an old same-PID lock recovers',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-owner-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(join(directory,'central.lock'),JSON.stringify({pid:process.pid,startedAt:1,instanceId:randomUUID()}));
  const first=new ServerDiagnostics({directory});await first.init();first.record('server.started');await first.flush();
  const original=await readFile(join(directory,'central.0.ndjson'),'utf8');const second=new ServerDiagnostics({directory,maxBytes:1024,maxFiles:1});await second.init();second.record('agent.failed',{category:'internal'},'error');await second.close();assert.ok(second.snapshot().writeFailures>0);assert.equal(await readFile(join(directory,'central.0.ndjson'),'utf8'),original);
  await first.close();await assert.rejects(stat(join(directory,'central.lock')),{code:'ENOENT'});
});

test('authenticated support API correlates stages while excluding all fixture body, credentials and raw URL metadata',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-api-'));const cfg=config(directory);const {app,diagnostics}=await buildApp(cfg,{agent:inactive});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});const headers={authorization:`Bearer ${cfg.token}`,'x-request-id':marker};
  for(const url of ['/api/diagnostics','/api/diagnostics/events','/api/support-bundle'])assert.equal((await app.inject(url)).statusCode,401);
  const f={id:randomUUID(),deviceId:marker,deviceName:marker,platform:'import',capturedAt:'2020-01-02T12:00:00Z',text:marker,mood:marker};
  const saved=await app.inject({method:'POST',url:`/api/notes?raw=${marker}`,headers,payload:f});assert.equal(saved.statusCode,201);const id=saved.headers['x-request-id'];assert.match(String(id),/^[0-9a-f-]{36}$/);assert.notEqual(id,marker);
  const list=await app.inject({url:'/api/notes',headers});assert.equal(list.statusCode,200);
  const invalid=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:marker,[marker]:marker}});assert.equal(invalid.statusCode,503);assert.equal(invalid.json().requestId,invalid.headers['x-request-id']);assert.ok(!invalid.body.includes(marker));
  const bundle=await app.inject({url:'/api/support-bundle',headers});assert.equal(bundle.statusCode,200);assert.match(String(bundle.headers['content-disposition']),/attachment/);assert.match(String(bundle.headers['cache-control']),/no-store/);const body=bundle.json();
  assert.equal(body.snapshot.storage.captures,1);assert.equal(body.snapshot.queue.index.textReady,1);assert.ok(body.events.some((e:any)=>e.event==='ingest.completed'&&e.requestId===id&&e.operation==='note'));assert.ok(body.events.some((e:any)=>e.event==='source.completed'&&e.requestId===list.headers['x-request-id']));
  for(const secret of [marker,cfg.token,cfg.apiKey,directory,'2020-01-02'])assert.ok(!bundle.body.includes(secret));
  await diagnostics.flush();for(const name of await readdir(join(directory,'logs'))){const text=await readFile(join(directory,'logs',name),'utf8');for(const secret of [marker,cfg.token,cfg.apiKey,directory])assert.ok(!text.includes(secret));}
});

test('concurrent requests keep independent request IDs, and SDK failures cannot leak into responses or support exports',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-agent-'));const cfg=config(directory);
  const agent:QueryAgent={configured:true,close:async()=>{},query:async args=>{await delay(args.question==='fixture slow'?15:1);if(args.question===marker)throw Object.assign(new Error(marker+' https://provider.invalid/?key='+marker),{name:marker,code:marker,statusCode:502});return {answer:args.question,citations:[],trace:[],runId:randomUUID()};}};
  const {app,diagnostics}=await buildApp(cfg,{agent});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});const headers={authorization:`Bearer ${cfg.token}`};
  const responses=await Promise.all(['fixture slow','fixture fast'].map(question=>app.inject({method:'POST',url:'/api/query',headers,payload:{question}})));const ids=responses.map(r=>r.headers['x-request-id']);assert.notEqual(ids[0],ids[1]);for(const id of ids)assert.equal(diagnostics.events().items.filter(e=>e.requestId===id&&e.event==='agent.completed').length,1);
  const failed=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:marker}});assert.equal(failed.statusCode,502);assert.ok(!failed.body.includes(marker));assert.equal(failed.json().requestId,failed.headers['x-request-id']);
  for(const url of [`/api/${marker}?token=${marker}`,`/api/%zz?token=${marker}`]){const result=await app.inject({url,headers});assert.ok(result.statusCode>=400);assert.ok(!result.body.includes(marker));}
  const bundle=await app.inject({url:'/api/support-bundle',headers});assert.ok(!bundle.body.includes(marker));assert.ok(bundle.json().events.some((e:any)=>e.requestId===failed.headers['x-request-id']&&e.event==='agent.failed'));
});

test('disabled central diagnostics keeps the authenticated numeric status available without recording',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-off-api-'));const cfg={...config(directory),diagnosticsEnabled:false};const {app}=await buildApp(cfg,{agent:inactive});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${cfg.token}`};await app.inject({url:'/api/status',headers});const bundle=(await app.inject({url:'/api/support-bundle',headers})).json();assert.equal(bundle.snapshot.enabled,false);assert.equal(bundle.snapshot.retainedEvents,0);assert.deepEqual(bundle.events,[]);await assert.rejects(stat(join(directory,'logs')),{code:'ENOENT'});
});

test('rate limits keep their HTTP status and return a correlated safe error',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-rate-'));const cfg=config(directory);const {app}=await buildApp(cfg,{agent:inactive});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${cfg.token}`};let last;
  for(let i=0;i<11;i++)last=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:marker}});
  assert.equal(last!.statusCode,429);assert.equal(last!.json().error,'rate_limited');assert.equal(last!.json().requestId,last!.headers['x-request-id']);assert.ok(!last!.body.includes(marker));
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
  const responses=await Promise.all([1,2].map(()=>built.app.inject({method:'POST',url:'/api/query',headers:{authorization:`Bearer ${cfg.token}`},payload:{question:'synthetic bridge request'}})));
  for(const response of responses){assert.equal(response.statusCode,200);assert.equal(diagnostics.events().items.filter(e=>e.event==='source.completed'&&e.requestId===response.headers['x-request-id']).length,1);}
  assert.ok(!JSON.stringify(diagnostics.events()).includes(marker));
});

test('background indexing records timings, queue state and only a fixed failure marker',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-index-'));const cfg={...config(directory),embeddingModel:'synthetic-model',embeddingBaseUrl:'http://127.0.0.1:1'};
  const {app,indexer,store,diagnostics}=await buildApp(cfg,{agent:inactive});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  let calls=0;t.mock.method(indexer,'embed',async()=>{calls++;throw new Error(marker);});
  const id=randomUUID();await store.ingest({id,deviceId:'fixture',deviceName:'fixture',platform:'import',capturedAt:'2020-01-01T00:00:00Z',source:'note',ocrText:marker,durationMs:0});await indexer.tick();
  assert.equal(calls,1);assert.equal(store.indexCounts().failed,1);const stored=store.db.prepare('SELECT index_error FROM captures WHERE id=?').get(id) as {index_error:string};assert.equal(stored.index_error,'Embedding operation failed');
  const failed=diagnostics.events().items.find(e=>e.event==='index.failed');assert.ok(failed);assert.equal(failed.operation,'embedding');assert.equal(typeof failed.durationMs,'number');assert.match(failed.requestId!,/^[a-f0-9-]{36}$/);assert.ok(diagnostics.events().items.some(e=>e.event==='queue.snapshot'&&e.failed===1&&e.requestId===failed.requestId));assert.ok(!JSON.stringify(diagnostics.events()).includes(marker));
});

test('explicit agent timeout returns correlated 504 diagnostics while invalid answers remain 502',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-diagnostics-timeout-')),cfg=config(directory);
  let failure:Error=new AgentTimeoutError();
  const agent:QueryAgent={configured:true,close:async()=>{},query:async()=>{throw failure;}};
  const {app,diagnostics}=await buildApp(cfg,{agent});t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${cfg.token}`};
  const timed=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:marker}});
  assert.equal(timed.statusCode,504);assert.equal(timed.json().error,'timeout');assert.equal(timed.json().requestId,timed.headers['x-request-id']);assert.match(timed.json().message,/超时/);
  const events=diagnostics.events(0,500).items.filter(e=>e.requestId===timed.headers['x-request-id']);
  assert.ok(events.some(e=>e.event==='agent.failed'&&e.category==='timeout'));
  assert.ok(events.some(e=>e.event==='request.failed'&&e.category==='timeout'&&e.statusCode===504));
  failure=new AgentResponseError(marker);const invalid=await app.inject({method:'POST',url:'/api/query',headers,payload:{question:marker}});
  assert.equal(invalid.statusCode,502);assert.equal(invalid.json().error,'agent_response');
  const bundle=await app.inject({url:'/api/support-bundle',headers});for(const privateValue of [marker,cfg.token,cfg.apiKey])assert.ok(!bundle.body.includes(privateValue));
});

test('raw log endpoint returns file text verbatim with owner authentication and no cache', async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'mote-raw-log-'));
  const {app,diagnostics}=await buildApp(config(dataDir),{agent:inactive});
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  const unauthorized=await app.inject({method:'GET',url:'/api/diagnostics/logs'});
  assert.equal(unauthorized.statusCode,401);
  await diagnostics.flush();
  const path=join(dataDir,'logs','central.0.ndjson');
  const raw='  {"level":"info"}\nmalformed <script>中文 fixture</script>\n';
  await writeFile(path,raw);
  // Read directly so debug request-start writes do not alter the exact-byte assertion.
  assert.equal(await diagnostics.readRaw(),raw);
  await writeFile(join(dataDir,'logs','central.1.ndjson'),raw);
  assert.equal(await diagnostics.readRaw(1),raw);
  const latestPage=await diagnostics.readPage(0,1,1);assert.deepEqual(latestPage,{items:['malformed <script>中文 fixture</script>'],page:1,pageSize:1,totalLines:2,totalPages:2,hasPrevious:true,hasNext:false});
  const olderPage=await diagnostics.readPage(0,2,1);assert.deepEqual(olderPage.items,['  {"level":"info"}']);
  await assert.rejects(diagnostics.readRaw(9));
  const result=await app.inject({method:'GET',url:'/api/diagnostics/logs',headers:{authorization:`Bearer ${config(dataDir).token}`}});
  assert.equal(result.statusCode,200);assert.match(result.headers['content-type']!,/^text\/plain/);
  assert.equal(result.headers['cache-control'],'no-store');assert.ok(result.body.startsWith(raw));
  const pageResult=await app.inject({method:'GET',url:'/api/diagnostics/log-pages?file=0&page=1&pageSize=1',headers:{authorization:`Bearer ${config(dataDir).token}`}});
  assert.equal(pageResult.statusCode,200);assert.equal(pageResult.headers['cache-control'],'no-store');const pageBody=pageResult.json();assert.equal(pageBody.page,1);assert.equal(pageBody.pageSize,1);assert.equal(pageBody.totalLines,pageBody.totalPages);assert.ok(pageBody.items.length===1);assert.ok(pageBody.totalLines>=latestPage.totalLines);
  const filtered=await app.inject({method:'GET',url:'/api/diagnostics/log-pages?file=0&page=1&pageSize=10&stage=unknown',headers:{authorization:`Bearer ${config(dataDir).token}`}});
  assert.equal(filtered.statusCode,200);assert.equal(filtered.json().totalLines,2);assert.equal((await app.inject({method:'GET',url:'/api/diagnostics/log-pages?stage=invalid',headers:{authorization:`Bearer ${config(dataDir).token}`}})).statusCode,400);
});

test('stage failures use warning for rejected input and error for failed execution', async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-levels-'));const d=new ServerDiagnostics({directory,debug:true});
  t.after(async()=>{await d.close();await rm(directory,{recursive:true,force:true});});await d.init();
  await assert.rejects(d.measure('ingest','note',()=>{throw {statusCode:400};}));
  await assert.rejects(d.measure('index','embedding',()=>{throw new Error('synthetic');}));
  assert.deepEqual(d.events().items.map(e=>e.level),['debug','warn','debug','error']);
  assert.deepEqual(d.events().items.map(e=>e.stage),['ingest','ingest','index','index']);
  const ingestPage=await d.readPage(0,1,100,'ingest');assert.equal(ingestPage.totalLines,2);assert.ok(ingestPage.items.every(line=>JSON.parse(line).stage==='ingest'));
});
