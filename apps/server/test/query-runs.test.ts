import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp,type QueryAgent} from '../src/app.js';
import {ProviderFailure} from '@mote/shared';
import type {Config} from '../src/config.js';
import {hostRun,hostTerminal,hostUsage} from './fixtures/host-run.js';
const token='generated-query-owner-token',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'https://synthetic.invalid',apiKey:'synthetic-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''});
test('background admission survives client departure, deduplicates and persists progress, result and usage',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-query-runs-'));let complete!:()=>void,calls=0,heldRun='';
  const agent:QueryAgent={configured:true,close:async()=>{},query:async(input,lease)=>{
    lease?.onFinalizer?.('host');
    calls++;input.onProgress?.({stage:'tool',tool:'search_context',phase:'started'});
    heldRun=hostUsage(input,{requests:1,reportedRequests:1,inputTokens:30,outputTokens:10,totalTokens:40,cacheReadTokens:20,cacheWriteTokens:0});
    await new Promise<void>(r=>{complete=r;});input.onProgress?.({stage:'tool',tool:'search_context',phase:'completed',count:3});
    hostTerminal(input,'completed',heldRun);
    return {answer:'Generated answer',citations:[],trace:[],runId:randomUUID()};
  }};
  const {app,store}=await buildApp(config(dir),{agent});t.after(async()=>{complete?.();await app.close();rmSync(dir,{recursive:true,force:true});});
  const id=randomUUID(),payload={id,input:{question:'Generated question'}};
  const accepted=await app.inject({method:'POST',url:'/api/query-runs',headers,payload});assert.equal(accepted.statusCode,202);
  await new Promise(r=>setImmediate(r));
  const active=(await app.inject({url:`/api/query-runs/${id}`,headers})).json();assert.equal(active.status,'running');assert.equal(active.events[0].phase,'started');
  assert.equal((await app.inject({method:'POST',url:'/api/query-runs',headers,payload})).statusCode,202);assert.equal(calls,1);
  assert.equal((await app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'different'}}})).statusCode,409);
  assert.equal((await app.inject({url:`/api/query-runs/${id}`})).statusCode,401);
  const invitation=(await app.inject({method:'POST',url:'/api/connections/invitations',headers,payload:{serverUrl:'https://synthetic.invalid',label:'fixture'}})).json();
  const credential=(await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.invitation.code,deviceId:'fixture',deviceName:'fixture',platform:'android'}})).json();
  assert.equal((await app.inject({url:'/api/query-runs',headers:{authorization:`Bearer ${credential.token}`}})).statusCode,200);
  complete();let finished:any;
  for(let i=0;i<20;i++){await new Promise(r=>setImmediate(r));finished=(await app.inject({url:`/api/query-runs/${id}`,headers})).json();if(finished.status==='completed')break;}
  assert.equal(finished.status,'completed');assert.ok(!JSON.stringify(finished).includes('Generated question'));
  const conversation=(await app.inject({url:`/api/conversations/${finished.conversationId}`,headers})).json();assert.equal(conversation.turns[0].result.usage.tokens.totalTokens,40);
  assert.equal(conversation.turns[0].result.usage.attribution.operationId,`query:${id}`);assert.ok(conversation.turns[0].result.usage.attribution.requestId);
  const {agentId,moduleId,skillId}=conversation.turns[0].result.usage.attribution;assert.deepEqual({agentId,moduleId,skillId},{agentId:'context-query',moduleId:'conversations',skillId:null});
  const today=new Date().toISOString().slice(0,10),url=`/api/usage?from=${today}&to=${today}&groupBy=module&agentId=context-query&skillId=__none__`;
  const summary=(await app.inject({url,headers})).json();assert.equal(summary.groups[0].id,'conversations');assert.equal(summary.total.totalTokens,40);
  assert.equal((await app.inject({url})).statusCode,401);
  assert.equal((await app.inject({url,headers:{authorization:`Bearer ${credential.token}`}})).statusCode,200);
  assert.equal((await app.inject({url:url.replace('groupBy=module','groupBy=invalid'),headers})).statusCode,400);
  assert.equal((await app.inject({url:url+'&status=invalid',headers})).statusCode,400);
  await app.inject({method:'DELETE',url:`/api/conversations/${finished.conversationId}`,headers});
  assert.ok(!(await app.inject({url:`/api/query-runs/${id}`,headers})).body.includes('Generated answer'));
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM model_usage').get() as any).n,1);
});

test('failed background queries retain a retryable conversation history entry',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-query-run-failure-'));
  const {app}=await buildApp(config(dir),{agent:{configured:true,close:async()=>{},query:async()=>{throw Object.assign(new Error('Generated provider secret'),{name:'AgentProviderError'});}}});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const id=randomUUID();await app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated failed question'}}});
  let run:any;
  for(let attempt=0;attempt<30;attempt++){await new Promise(resolve=>setImmediate(resolve));run=(await app.inject({url:`/api/query-runs/${id}`,headers})).json();if(run.status==='failed')break;}
  assert.equal(run.status,'failed');assert.ok(run.conversationId);assert.ok(!JSON.stringify(run).includes('Generated provider secret'));
  const conversation=(await app.inject({url:`/api/conversations/${run.conversationId}`,headers})).json();
  assert.equal(conversation.status,'failed');assert.equal(conversation.turns[0].status,'failed');assert.equal(conversation.turns[0].question,'Generated failed question');assert.equal(conversation.turns[0].error.message,'模型服务请求未完成，请检查地址、凭据和模型配置。');
});

test('unrelated archive deletion does not fail a query, but deleting used evidence does',async t=>{
  for(const deleteUsed of [false,true])await t.test(deleteUsed?'used evidence':'unrelated evidence',async sub=>{
    const dir=mkdtempSync(join(tmpdir(),'mote-query-deletion-'));
    let entered!:()=>void,release!:()=>void;
    const running=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
    const {app,store}=await buildApp(config(dir),{agent:{configured:true,close:async()=>release(),query:async()=>{entered();await gate;return {answer:'Generated answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[used.id]}};}}});
    sub.after(async()=>{release();await app.close();rmSync(dir,{recursive:true,force:true});});
    const capture=()=>({id:randomUUID(),deviceId:'fixture',deviceName:'Generated device',platform:'macos',source:'activity' as const,appId:'fixture.app',appName:'Generated activity',capturedAt:'2026-09-20T00:00:30.000Z',durationMs:30000,privacy:{excluded:false,redacted:false,mode:'none' as const,collection:'activity' as const}});
    const used=capture(),other=capture();await store.ingest(used);await store.ingest(other);
    const pending=app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated question'}});
    await running;store.delete(deleteUsed?used.id:other.id);release();
    const response=await pending;
    assert.equal(response.statusCode,deleteUsed?409:200,response.body);
  });
});

test('execution entrypoints attribute insight, memory and isolated file analysis without inspecting prompt text',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-attribution-entrypoints-'));let failFile=false,closedFiles=0;
  const usage={requests:1,reportedRequests:1,inputTokens:30,outputTokens:10,totalTokens:40,cacheReadTokens:20,cacheWriteTokens:0};
  const emit=(input:Parameters<QueryAgent['query']>[0])=>{input.onUsage?.(usage);hostRun(input,{usage});};
  const agent:QueryAgent={configured:true,close:async()=>{},query:async(input,lease)=>{lease?.onFinalizer?.('host');emit(input);return {answer:input.skill==='memory-extraction'?JSON.stringify({memories:[]}):input.skill==='personal-insight'?JSON.stringify({title:'Generated report',markdown:'Generated report',html:'<p>Generated report</p>'}):'Generated report',citations:[],trace:[],runId:randomUUID()};}};
  const {app,processing,store,featureServices}=await buildApp(config(dir),{agent,createModelAgent:async(_settings,_reader,_host,identity)=>{assert.ok(identity);assert.equal(identity.kind,'profile');return {configured:true,close:async()=>{closedFiles++;},query:async input=>{emit(input);if(failFile)throw Error('Generated model failure');return {answer:'Generated file summary',citations:[],trace:[],runId:randomUUID()};}};}});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const insight=await app.inject({method:'POST',url:'/api/insights',headers,payload:{}});assert.equal(insight.statusCode,200,insight.body);
  await store.ingest({id:randomUUID(),deviceId:'generated-memory',deviceName:'Generated',platform:'import',source:'note',capturedAt:new Date().toISOString(),durationMs:0,ocrText:'Generated attribution evidence'});
  const memory=await app.inject({method:'POST',url:'/api/memories/extract',headers,payload:{}});assert.equal(memory.statusCode,200,memory.body);
  await featureServices.withMediaOwnerIntent('generated-file-id',()=>processing.analyze('generated-file-id',[],'Generated prompt mentioning unrelated skills and agents'));
  failFile=true;await assert.rejects(featureServices.withMediaOwnerIntent('generated-file-id',()=>processing.analyze('generated-file-id',[],'Generated failure')));assert.equal(closedFiles,2);
  const today=new Date().toISOString().slice(0,10),summary=(await app.inject({url:`/api/usage?from=${today}&to=${today}&groupBy=module`,headers})).json();
  assert.equal(summary.total.runs,4);assert.equal(summary.total.failed,1);assert.equal(summary.total.totalTokens,160);
  assert.deepEqual(summary.items.map((r:any)=>({agentId:r.attribution.agentId,moduleId:r.attribution.moduleId,skillId:r.attribution.skillId})).sort((a:any,b:any)=>a.moduleId.localeCompare(b.moduleId)),[
    {agentId:'file-analysis',moduleId:'files',skillId:null},{agentId:'file-analysis',moduleId:'files',skillId:null},
    {agentId:'context-query',moduleId:'insights',skillId:'personal-insight'}, {agentId:'context-query',moduleId:'memories',skillId:'memory-extraction'},
  ]);
});

test('direct Memory extraction preserves a generated range beyond the retired count and character gates',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-extract-without-read-budget-')),seen:Array<{ids:string[];ranges:unknown[]}>=[];
  const {app,store,memories}=await buildApp(config(dir),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
    if(input.skill==='memory-extraction')seen.push({ids:input.evidenceIds??[],ranges:input.evidenceRanges??[]});
    return {answer:JSON.stringify({memories:[]}),citations:[],trace:[],runId:randomUUID()};
  }}});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const texts:string[]=[];
  for(let index=0;index<101;index++){
    const id=randomUUID(),text=`Generated record ${index}. `+'Generated direct extraction evidence. '.repeat(30);texts.push(text);
    await store.ingest({id,deviceId:'generated-budget-regression',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00.000Z',durationMs:0,ocrText:text});
  }
  const response=await app.inject({method:'POST',url:'/api/memories/extract',headers,payload:{}});
  assert.equal(response.statusCode,200,response.body);assert.equal(seen.length,1);
  assert.equal(seen[0]!.ids.length,101);assert.equal(seen[0]!.ranges.length,101);
  assert.deepEqual(memories.readEvidence(seen[0]!.ids).map(record=>record.ocrText).sort(),texts.sort());
  assert.ok((seen[0]!.ranges as Array<{length:number}>).reduce((sum,range)=>sum+range.length,0)>100000);
});

test('explicit cancellation reaches the executing agent and cannot archive a late answer',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-query-cancel-'));let observed:AbortSignal|undefined,release!:()=>void,started!:()=>void;
  const startedPromise=new Promise<void>(resolve=>{started=resolve;});
  const agent:QueryAgent={configured:true,close:async()=>{},query:async input=>{
    observed=input.signal;started();await new Promise<void>(r=>{release=r;});return {answer:'Late generated answer',citations:[],trace:[],runId:randomUUID()};
  }};
  const {app}=await buildApp(config(dir),{agent});t.after(async()=>{release?.();await app.close();rmSync(dir,{recursive:true,force:true});});
  const id=randomUUID();await app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'fixture'}}});
  await startedPromise;assert.ok(observed);
  assert.equal((await app.inject({method:'POST',url:`/api/query-runs/${id}/cancel`})).statusCode,401);
  const cancelled=await app.inject({method:'POST',url:`/api/query-runs/${id}/cancel`,headers});assert.equal(cancelled.json().status,'cancelled');assert.equal(observed.aborted,true);
  release();await new Promise(r=>setTimeout(r,30));
  assert.equal((await app.inject({url:`/api/query-runs/${id}`,headers})).json().status,'cancelled');
  assert.equal((await app.inject({url:'/api/conversations',headers})).json().items.length,0);
});

test('export bundles require owner access, include originals and never include model credentials',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-export-bundle-'));const {app,store}=await buildApp(config(dir));
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const id=randomUUID();await app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'fixture',deviceName:'fixture',platform:'import',client:'web',capturedAt:new Date().toISOString(),text:'Generated note export'}});
  assert.equal((await app.inject({url:'/api/export-bundle?mode=data'})).statusCode,401);
  const response=await app.inject({url:'/api/export-bundle?mode=metadata',headers});assert.equal(response.statusCode,200,response.body);
  const {gunzipSync}=await import('node:zlib');const tar=gunzipSync(response.rawPayload).toString();assert.ok(tar.includes('Generated note export'));assert.ok(!tar.includes('synthetic-key'));assert.ok(!tar.includes(token));
  const {ArchivedFileStore}=await import('../src/archived-files.js');const originals=new ArchivedFileStore(store);
  originals.put({name:'generated.txt',bytes:Buffer.from('Synthetic original bytes')});
  const data=await app.inject({url:'/api/export-bundle?mode=data',headers});assert.equal(data.statusCode,200);
  assert.ok(gunzipSync(data.rawPayload).toString().includes('Synthetic original bytes'));
  const meta=await app.inject({url:'/api/export-bundle?mode=metadata',headers});assert.ok(!gunzipSync(meta.rawPayload).toString().includes('Synthetic original bytes'));
});

const runWrites=(t:any,store:any)=>{
  const sql:string[]=[],original=store.db.prepare.bind(store.db);
  t.mock.method(store.db,'prepare',(query:string)=>{sql.push(query);return original(query);});
  return {sql,updates:()=>sql.filter(query=>query.startsWith('UPDATE query_runs')).length};
};
const persistedRun=(store:any,id:string)=>String((store.db.prepare('SELECT json FROM query_runs WHERE id=?').get(id) as {json:string}).json);
const settledStatus=async(store:any,id:string)=>{for(let i=0;i<30;i++){await new Promise(r=>setImmediate(r));const status=(store.db.prepare("SELECT json_extract(json,'$.status') status FROM query_runs WHERE id=?").get(id) as {status:string}|undefined)?.status;if(status!=='running')return status;}};
const settledWork=async(store:any,id:string)=>{let last='';for(let i=0;i<60;i++){await new Promise(r=>setImmediate(r));const work=store.db.prepare("SELECT json_extract(json,'$.status') status,json_extract(json,'$.updatedAt') updatedAt FROM delegation_works WHERE id=?").get('query:'+id) as {status?:string;updatedAt?:string}|undefined;if(work?.status==='succeeded'&&work.updatedAt===last)return;last=work?.updatedAt??'';}};
const settleReads=async(app:any,store:any,id:string)=>{let last='',detail:any;for(let i=0;i<40;i++){await new Promise(r=>setImmediate(r));detail=(await app.inject({url:`/api/query-runs/${id}`,headers})).json();const now=persistedRun(store,id);if(now===last)return detail;last=now;}return detail;};

test('repeated reads of a completed run do not write to the store',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-query-run-readonly-'));
  const agent:QueryAgent={configured:true,close:async()=>{},query:async(input,lease)=>{lease?.onFinalizer?.('host');hostRun(input,{usage:{requests:1,reportedRequests:1,inputTokens:30,outputTokens:10,totalTokens:40,cacheReadTokens:20,cacheWriteTokens:0}});return {answer:'Generated answer',citations:[],trace:[],runId:randomUUID()};}};
  const {app,store}=await buildApp(config(dir),{agent});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const id=randomUUID();
  assert.equal((await app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated question'}}})).statusCode,202);
  assert.equal(await settledStatus(store,id),'completed','the run committed its completed receipt');
  await settledWork(store,id);
  const log=runWrites(t,store);
  const first=await app.inject({url:`/api/query-runs/${id}`,headers});assert.equal(first.statusCode,200,first.body);assert.equal(first.json().status,'completed');
  assert.equal(log.updates(),1,'the first read observing the transition writes the settled receipt exactly once');
  assert.equal((await settleReads(app,store,id)).status,'completed','in-flight projection updates settle as one-off real writes');
  log.sql.length=0;
  const before=persistedRun(store,id);
  for(let i=0;i<10;i++){const detail=await app.inject({url:`/api/query-runs/${id}`,headers});assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().status,'completed');}
  assert.equal(log.updates(),0,'repeated reads of a stable run must not UPDATE the row');
  assert.equal(persistedRun(store,id),before,'persisted bytes stay identical');
  const list=await app.inject({url:'/api/query-runs',headers});assert.equal(list.statusCode,200,list.body);
  assert.equal(log.updates(),0,'listing does not rewrite stable runs');
  assert.equal(persistedRun(store,id),before);
});

test('running reads return fresh usage without writes and the completed transition writes once',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-query-run-transition-'));let entered!:()=>void,release!:()=>void,held:Parameters<QueryAgent['query']>[0],heldRun='';
  const running=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  const agent:QueryAgent={configured:true,close:async()=>{},query:async(input,lease)=>{lease?.onFinalizer?.('host');held=input;heldRun=hostUsage(input,{requests:1,reportedRequests:1,inputTokens:30,outputTokens:10,totalTokens:40,cacheReadTokens:20,cacheWriteTokens:0});entered();await gate;hostTerminal(input,'completed',heldRun);return {answer:'Generated answer',citations:[],trace:[],runId:randomUUID()};}};
  const {app,store}=await buildApp(config(dir),{agent});
  t.after(async()=>{release();await app.close();rmSync(dir,{recursive:true,force:true});});
  const id=randomUUID();
  assert.equal((await app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated question'}}})).statusCode,202);
  await running;
  const log=runWrites(t,store);
  const first=(await app.inject({url:`/api/query-runs/${id}`,headers})).json();
  assert.equal(first.status,'running');assert.ok(first.operationUsage,'a running read returns the live computed usage');
  assert.equal(first.operationUsage.total.totalTokens,40);
  log.sql.length=0;
  const whileRunning=persistedRun(store,id);
  hostUsage(held!,{requests:2,reportedRequests:2,inputTokens:60,outputTokens:20,totalTokens:80,cacheReadTokens:20,cacheWriteTokens:0},heldRun);
  const second=(await app.inject({url:`/api/query-runs/${id}`,headers})).json();
  assert.equal(second.status,'running');assert.equal(second.operationUsage.total.totalTokens,80,'the next read recomputes live usage');
  const third=(await app.inject({url:`/api/query-runs/${id}`,headers})).json();
  assert.equal(third.status,'running');
  assert.equal(log.updates(),0,'running reads return fresh usage without persisting it');
  assert.equal(persistedRun(store,id),whileRunning,'the stored row stays untouched while running');
  release();
  assert.equal(await settledStatus(store,id),'completed','the commit persisted the terminal status');
  await settledWork(store,id);
  log.sql.length=0;
  const settled=(await app.inject({url:`/api/query-runs/${id}`,headers})).json();
  assert.equal(settled.status,'completed');
  assert.equal(log.updates(),1,'the first read observing the transition writes the settled receipt exactly once');
  assert.equal((await settleReads(app,store,id)).status,'completed','in-flight projection updates settle as one-off real writes');
  log.sql.length=0;
  const persisted=JSON.parse(persistedRun(store,id));
  assert.equal(persisted.status,'completed');assert.equal(persisted.operationUsage.total.totalTokens,80,'stable terminal usage is written once with the receipt');
  const stable=persistedRun(store,id);
  for(let i=0;i<5;i++){const detail=await app.inject({url:`/api/query-runs/${id}`,headers});assert.equal(detail.json().status,'completed');}
  assert.equal(log.updates(),0,'stable terminal reads stop writing');
  assert.equal(persistedRun(store,id),stable);
});

test('a held retry deadline returns a fresh countdown without rewriting the row',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-query-run-retry-wait-')),id=randomUUID();
  let entered!:()=>void,enteredWaiter!:(id:string)=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),waiterStarted=new Promise<string>(resolve=>enteredWaiter=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const operations:string[]=[];
  const agent:QueryAgent={configured:true,close:async()=>release(),query:async input=>{
    const operationId=input.traceContext?.operationId;assert.ok(operationId?.startsWith('query:'));
    operations.push(operationId);
    if(operationId==='query:'+id)entered();else enteredWaiter(operationId.slice('query:'.length));
    await gate;
    throw new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:3600000});
  }};
  const {app,store,executor}=await buildApp(config(dir),{agent});
  t.after(async()=>{release();await app.close();rmSync(dir,{recursive:true,force:true});});
  assert.equal((await app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated question'}}})).statusCode,202);
  await started;
  const pending=app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Held waiter question'}}).then(response=>response);
  const heldRunId=await waiterStarted;assert.notEqual(heldRunId,id);
  const stepOf=(runId:string)=>store.db.prepare("SELECT id,state,error,available_at FROM execution_steps WHERE operation_id=? AND kind='delegation.coordinator.query'").get('query:'+runId) as {id:string;state:string;error?:string;available_at:number};
  // Wait for the real worker to settle both provider failures. Counting event
  // loop turns cannot establish that the 50ms waiter refreshed its projection.
  const drained=executor.drain([stepOf(id).id,stepOf(heldRunId).id]);release();await drained;
  assert.deepEqual(operations.sort(),['query:'+id,'query:'+heldRunId].sort());
  for(const runId of [id,heldRunId]){
    const held=stepOf(runId);assert.equal(held.state,'waiting');assert.equal(held.error,'rate_limited');
    assert.ok(held.available_at>Date.now(),'the coordinator is held at a future retry deadline');
    const detail=(await app.inject({url:`/api/query-runs/${runId}`,headers})).json();
    assert.equal(detail.execution.status,'retry_wait','the real provider failure reaches the HTTP projection');
    assert.equal((await settleReads(app,store,runId)).execution.status,'retry_wait');
  }
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const log=runWrites(t,store),stable=persistedRun(store,id),stableWaiter=persistedRun(store,heldRunId);
  let countdown=0;
  for(let i=0;i<3;i++){
    t.mock.timers.tick(5000);
    const run=(await app.inject({url:`/api/query-runs/${id}`,headers})).json();
    assert.equal(run.status,'running');assert.equal(run.execution.status,'retry_wait');
    const next=Number(run.execution.failure?.retryAfterMs);
    assert.ok(next>0&&(!countdown||next<countdown),'each read returns the live remaining countdown');
    countdown=next;
  }
  const list=await app.inject({url:'/api/query-runs',headers});assert.equal(list.statusCode,200,list.body);
  const pollsBefore=log.sql.filter(query=>query==='SELECT json FROM query_runs WHERE id=?').length;
  for(let i=0;i<3;i++){t.mock.timers.tick(2000);await new Promise(r=>setTimeout(r,90));}
  assert.ok(log.sql.filter(query=>query==='SELECT json FROM query_runs WHERE id=?').length-pollsBefore>=3,'the pending foreground waiter really polled across clock ticks');
  assert.equal(log.updates(),0,'detail, list and waiter polls issue zero updates while the deadline is held');
  assert.equal(persistedRun(store,id),stable,'persisted bytes stay identical across clock ticks');
  assert.equal(persistedRun(store,heldRunId),stableWaiter,'the foreground waiter row also stays byte-identical');
  await app.inject({method:'POST',url:`/api/query-runs/${heldRunId}/cancel`,headers});
  const waiterResponse=await pending;assert.notEqual(waiterResponse.statusCode,200);
});
