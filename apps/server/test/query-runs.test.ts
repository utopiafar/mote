import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
const token='generated-query-owner-token',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'https://synthetic.invalid',apiKey:'synthetic-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''});
test('background admission survives client departure, deduplicates and persists progress, result and usage',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-query-runs-'));let complete!:()=>void,calls=0;
  const agent:QueryAgent={configured:true,close:async()=>{},query:async input=>{
    calls++;input.onProgress?.({stage:'tool',tool:'search_context',phase:'started'});
    input.onUsage?.({requests:1,reportedRequests:1,inputTokens:30,outputTokens:10,totalTokens:40,cacheReadTokens:20,cacheWriteTokens:0});
    await new Promise<void>(r=>{complete=r;});input.onProgress?.({stage:'tool',tool:'search_context',phase:'completed',count:3});
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
  assert.equal((await app.inject({url:'/api/query-runs',headers:{authorization:`Bearer ${credential.token}`}})).statusCode,403);
  complete();let finished:any;
  for(let i=0;i<20;i++){await new Promise(r=>setImmediate(r));finished=(await app.inject({url:`/api/query-runs/${id}`,headers})).json();if(finished.status==='completed')break;}
  assert.equal(finished.status,'completed');assert.ok(!JSON.stringify(finished).includes('Generated question'));
  const conversation=(await app.inject({url:`/api/conversations/${finished.conversationId}`,headers})).json();assert.equal(conversation.turns[0].result.usage.tokens.totalTokens,40);
  assert.deepEqual(conversation.turns[0].result.usage.attribution,{agentId:'context-query',moduleId:'conversations',skillId:null});
  const today=new Date().toISOString().slice(0,10),url=`/api/usage?from=${today}&to=${today}&groupBy=module&agentId=context-query&skillId=__none__`;
  const summary=(await app.inject({url,headers})).json();assert.equal(summary.groups[0].id,'conversations');assert.equal(summary.total.totalTokens,40);
  assert.equal((await app.inject({url})).statusCode,401);
  assert.equal((await app.inject({url,headers:{authorization:`Bearer ${credential.token}`}})).statusCode,403);
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

test('interrupted runs recover as failures, and deleted evidence clears public status messages',async t=>{
  const {Store}=await import('../src/store.js');const {QueryRuns}=await import('../src/query-runs.js');
  const dir=mkdtempSync(join(tmpdir(),'mote-query-progress-')),store=new Store(dir),runs=new QueryRuns(store);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  let observe!:Parameters<Parameters<QueryRuns['start']>[2]>[0],finish!:(v:{conversationId:string;turnId:string})=>void;
  const id=randomUUID();runs.start(id,{question:'fixture'},async progress=>{observe=progress;return new Promise(resolve=>{finish=resolve;});});
  await new Promise(r=>setImmediate(r));
  observe({stage:'model',message:'Generated private status'});assert.ok(JSON.stringify(runs.get(id)).includes('Generated private status'));
  // The same deletion invalidation used for capture retention must clear all derived prose.
  store.invalidateConversationAnswers();assert.ok(!JSON.stringify(runs.get(id)).includes('Generated private status'));
  store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'delete',?)").run(randomUUID(),new Date().toISOString());
  observe({stage:'model',message:'Must not restore removed status'});
  finish({conversationId:randomUUID(),turnId:randomUUID()});await runs.close();
  assert.ok(!JSON.stringify(runs.get(id)).includes('Generated private status'));assert.ok(!JSON.stringify(runs.get(id)).includes('Must not restore'));
  store.db.prepare("UPDATE query_runs SET json=json_set(json,'$.status','running') WHERE id=?").run(id);
  const restarted=new QueryRuns(store);assert.equal(restarted.get(id).status,'failed');assert.equal(restarted.get(id).error?.code,'interrupted');
});

test('execution entrypoints attribute insight, memory and isolated file analysis without inspecting prompt text',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-attribution-entrypoints-'));let failFile=false,closedFiles=0;
  const emit=(input:Parameters<QueryAgent['query']>[0])=>input.onUsage?.({requests:1,reportedRequests:1,inputTokens:30,outputTokens:10,totalTokens:40,cacheReadTokens:20,cacheWriteTokens:0});
  const agent:QueryAgent={configured:true,close:async()=>{},query:async input=>{emit(input);return {answer:input.skill==='memory-extraction'?JSON.stringify({memories:[]}):'Generated report',citations:[],trace:[],runId:randomUUID()};}};
  const {app,processing}=await buildApp(config(dir),{agent,createModelAgent:async()=>({configured:true,close:async()=>{closedFiles++;},query:async input=>{emit(input);if(failFile)throw Error('Generated model failure');return {answer:'Generated file summary',citations:[],trace:[],runId:randomUUID()};}})});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const insight=await app.inject({method:'POST',url:'/api/insights',headers,payload:{}});assert.equal(insight.statusCode,200,insight.body);
  const memory=await app.inject({method:'POST',url:'/api/memories/extract',headers,payload:{}});assert.equal(memory.statusCode,200,memory.body);
  await processing.analyze('generated-file-id',[],'Generated prompt mentioning unrelated skills and agents');
  failFile=true;await assert.rejects(processing.analyze('generated-file-id',[],'Generated failure'));assert.equal(closedFiles,2);
  const today=new Date().toISOString().slice(0,10),summary=(await app.inject({url:`/api/usage?from=${today}&to=${today}&groupBy=module`,headers})).json();
  assert.equal(summary.total.runs,4);assert.equal(summary.total.failed,1);assert.equal(summary.total.totalTokens,160);
  assert.deepEqual(summary.items.map((r:any)=>r.attribution).sort((a:any,b:any)=>a.moduleId.localeCompare(b.moduleId)),[
    {agentId:'file-analysis',moduleId:'files',skillId:null},{agentId:'file-analysis',moduleId:'files',skillId:null},
    {agentId:'context-query',moduleId:'insights',skillId:'personal-insight'}, {agentId:'context-query',moduleId:'memories',skillId:'memory-extraction'},
  ]);
});

test('explicit cancellation reaches the executing agent and cannot archive a late answer',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-query-cancel-'));let observed:AbortSignal|undefined,release!:()=>void;
  const agent:QueryAgent={configured:true,close:async()=>{},query:async input=>{
    observed=input.signal;await new Promise<void>(r=>{release=r;});return {answer:'Late generated answer',citations:[],trace:[],runId:randomUUID()};
  }};
  const {app}=await buildApp(config(dir),{agent});t.after(async()=>{release?.();await app.close();rmSync(dir,{recursive:true,force:true});});
  const id=randomUUID();await app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'fixture'}}});
  await new Promise(r=>setImmediate(r));assert.ok(observed);
  assert.equal((await app.inject({method:'POST',url:`/api/query-runs/${id}/cancel`})).statusCode,401);
  const cancelled=await app.inject({method:'POST',url:`/api/query-runs/${id}/cancel`,headers});assert.equal(cancelled.json().status,'cancelled');assert.equal(observed.aborted,true);
  release();await new Promise(r=>setTimeout(r,30));
  assert.equal((await app.inject({url:`/api/query-runs/${id}`,headers})).json().status,'cancelled');
  assert.equal((await app.inject({url:'/api/conversations',headers})).json().items.length,0);
});

test('export bundles require owner access, include originals and never include model credentials',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-export-bundle-'));const {app,store}=await buildApp(config(dir));
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const id=randomUUID();await app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'fixture',deviceName:'fixture',platform:'import',capturedAt:new Date().toISOString(),text:'Generated note export'}});
  assert.equal((await app.inject({url:'/api/export-bundle?mode=data'})).statusCode,401);
  const response=await app.inject({url:'/api/export-bundle?mode=metadata',headers});assert.equal(response.statusCode,200,response.body);
  const {gunzipSync}=await import('node:zlib');const tar=gunzipSync(response.rawPayload).toString();assert.ok(tar.includes('Generated note export'));assert.ok(!tar.includes('synthetic-key'));assert.ok(!tar.includes(token));
  const {ArchivedFileStore}=await import('../src/archived-files.js');const originals=new ArchivedFileStore(store);
  originals.put({name:'generated.txt',bytes:Buffer.from('Synthetic original bytes')});
  const data=await app.inject({url:'/api/export-bundle?mode=data',headers});assert.equal(data.statusCode,200);
  assert.ok(gunzipSync(data.rawPayload).toString().includes('Synthetic original bytes'));
  const meta=await app.inject({url:'/api/export-bundle?mode=metadata',headers});assert.ok(!gunzipSync(meta.rawPayload).toString().includes('Synthetic original bytes'));
});
