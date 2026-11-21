import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';

const token='generated-conversation-settings-owner';
const headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):ConfigurationPlatformOptions=>({path:(dataDir)+'/mote.yaml',privateCredential:{token:token,tokenPath:'fixture-only'},initialDocument:{version:1,revision:0,storage:{dataDir:dataDir,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'generated-model',baseUrl:'https://generated.invalid',apiKey:'generated-key',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}});

test('conversation settings preserve context values and multipleConversations no longer opens a list',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-conversation-settings-'));
  const agent={configured:true,close:async()=>{},query:async()=>({answer:'Generated answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[]}})};
  let node=await buildApp(config(dir),{backgroundWorker:false,agent});
  t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
  const get=async(url:string)=>node.app.inject({url,headers});
  const put=async(url:string,payload:unknown)=>node.app.inject({method:'PUT',url,headers,payload});
  const settings=async()=>{const response=await get('/api/configuration');assert.equal(response.statusCode,200,response.body);return response.json();};
  const domain=(view:any)=>view.domains.find((item:any)=>item.id==='conversations').effective;
  let view=await settings();
  assert.deepEqual(domain(view),{multipleConversations:false,context:{historyRatio:0.5,lowWatermarkRatio:0.5,contextWindow:null,contextWindowSource:'conservative'}});
  const mainResponse=await get('/api/conversations/main');assert.equal(mainResponse.statusCode,200,mainResponse.body);
  const original=mainResponse.json().id;
  assert.equal((await node.app.inject({method:'POST',url:'/api/conversations',headers,payload:{}})).statusCode,404);
  assert.equal((await put('/api/conversations/main',{id:original})).statusCode,404);
  let response=await put('/api/configuration/conversations',{revision:view.revision,value:{multipleConversations:true}});
  assert.equal(response.statusCode,200,response.body);view=response.json();
  assert.equal((await get('/api/conversations/main')).json().id,original);
  // Three saved side conversations exist in the store, but no route lists them.
  const sideIds:string[]=[];
  for(const question of ['Generated side one','Generated side two','Generated side three'])sideIds.push(node.conversations.append(undefined,{question},{answer:'Generated side answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}}).conversationId);
  assert.equal((await get('/api/conversations')).statusCode,404);
  assert.equal((await get(`/api/conversations/${sideIds[0]}`)).json().turns[0].question,'Generated side one');
  assert.equal((await get(`/api/conversations/${original}`)).statusCode,200);
  assert.equal((await get('/api/conversations/main')).json().id,original);
  response=await put('/api/configuration/conversations',{revision:view.revision,value:{multipleConversations:false,context:{historyRatio:0.1,lowWatermarkRatio:0.25,contextWindow:8000,contextWindowSource:'configured'}}});
  assert.equal(response.statusCode,200,response.body);view=response.json();
  assert.equal((await get('/api/conversations/main')).json().id,original);
  assert.equal((await get(`/api/conversations/${sideIds[2]}`)).json().turns[0].question,'Generated side three');
  const missing=await get(`/api/conversations/${randomUUID()}`);assert.equal(missing.statusCode,404);

  for(const context of [{historyRatio:-0.1},{historyRatio:1.1},{lowWatermarkRatio:1},{contextWindowSource:'unknown'},{contextWindowSource:'configured',contextWindow:null},{contextWindow:0},{window:'unknown'}]){
    response=await put('/api/configuration/conversations',{revision:view.revision,value:{context}});
    assert.equal(response.statusCode,400,JSON.stringify({context,status:response.statusCode,body:response.body}));
  }
  assert.deepEqual(domain(await settings()),domain(view));
  response=await put('/api/configuration/conversations',{revision:view.revision,value:{multipleConversations:true}});
  assert.equal(response.statusCode,200,response.body);view=response.json();
  await node.app.close();node=await buildApp(config(dir),{backgroundWorker:false,agent});
  assert.equal((await get('/api/conversations/main')).json().id,original);
  assert.deepEqual(domain(await settings()),domain(view));
  assert.equal((await get('/api/conversations')).statusCode,404);
  assert.equal((await get(`/api/conversations/${original}`)).statusCode,200);
  assert.equal((await get(`/api/conversations/${sideIds[0]}`)).json().turns[0].question,'Generated side one');
});

test('default Ask selects the main conversation while unnamed legacy and run queries stay independent',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-conversation-default-'));
  const seen:any[]=[];
  const agent={configured:true,close:async()=>{},query:async(input:any)=>{seen.push(input);return {answer:'Generated answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:input.evidenceIds??[]}};}};
  const node=await buildApp(config(dir),{backgroundWorker:false,agent});
  t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
  const get=(url:string)=>node.app.inject({url,headers});
  const post=(url:string,payload:unknown)=>node.app.inject({method:'POST',url,headers,payload});
  const settle=async(id:string)=>{for(let attempt=0;attempt<200;attempt++){const run=(await get(`/api/query-runs/${id}`)).json();if(run.status!=='running')return run;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Generated query did not settle');};
  const main=(await get('/api/conversations/main')).json().id;
  const selected=randomUUID();
  await node.store.ingest({id:selected,deviceId:'generated-conversation-device',deviceName:'Generated device',platform:'import',source:'note',capturedAt:'2026-11-01T00:00:00Z',durationMs:0,ocrText:'Generated selected original'});
  // The desktop client explicitly opens the server's main conversation and
  // sends its identity; the server does not guess from an absent id.
  const first={id:randomUUID(),input:{question:'Generated first main question',conversationId:main,evidenceIds:[selected]}};
  let response=await post('/api/query-runs',first);assert.equal(response.statusCode,202,response.body);assert.equal(response.json().conversationId,main);
  assert.equal((await settle(first.id)).status,'completed');
  const detail=await get(`/api/conversations/${main}`);assert.equal(detail.json().title,'Generated first main question');assert.deepEqual(detail.json().scope.evidenceIds,[selected]);

  const side=node.conversations.append(undefined,{question:'Generated side conversation'},{answer:'Generated side answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}}).conversationId;
  assert.equal((await get('/api/conversations/main')).json().id,main);

  // A retry keeps targeting the conversation captured by its first receipt,
  // even when a known side conversation also exists.
  response=await post('/api/query-runs',first);assert.equal(response.statusCode,202,response.body);assert.equal(response.json().conversationId,main);
  assert.equal((await post('/api/query-runs',{...first,input:{question:'Changed retry'}})).statusCode,409);
  const next={id:randomUUID(),input:{question:'Generated new main question',conversationId:side}};
  response=await post('/api/query-runs',next);assert.equal(response.statusCode,202,response.body);assert.equal(response.json().conversationId,side);
  assert.equal((await settle(next.id)).status,'completed');

  // No conversationId is not a synonym for "main". It neither shares the
  // main conversation nor inherits its private selection.
  const unnamed={id:randomUUID(),input:{question:'Generated unnamed query'}};
  response=await post('/api/query-runs',unnamed);assert.equal(response.statusCode,202,response.body);
  const unnamedRun=await settle(unnamed.id);assert.equal(unnamedRun.status,'completed');
  assert.notEqual(unnamedRun.conversationId,main);assert.notEqual(unnamedRun.conversationId,side);
  assert.equal(seen.at(-1).evidenceIds,undefined);
  const unnamedDetail=await get(`/api/conversations/${unnamedRun.conversationId}`);assert.equal(unnamedDetail.json().scope.evidenceIds,undefined);

  // The legacy synchronous entrypoint keeps its original independent contract.
  const legacy=await post('/api/query',{question:'Generated legacy ordinary query'});assert.equal(legacy.statusCode,200,legacy.body);
  assert.notEqual(legacy.json().conversationId,main);assert.notEqual(legacy.json().conversationId,side);assert.equal(seen.at(-1).evidenceIds,undefined);

  // An explicitly selected conversation does inherit its current selection,
  // and an explicit null clears it without affecting other conversations.
  const follow=await post('/api/query',{conversationId:main,question:'Generated explicit main follow-up'});assert.equal(follow.statusCode,200,follow.body);assert.deepEqual(seen.at(-1).evidenceIds,[selected]);
  const cleared=await post('/api/query',{conversationId:main,question:'Generated explicit clear',evidenceIds:null});assert.equal(cleared.statusCode,200,cleared.body);assert.equal(seen.at(-1).evidenceIds,undefined);
  assert.equal((await get(`/api/conversations/${main}`)).json().scope.evidenceIds,undefined);
  assert.equal((await get(`/api/conversations/${main}`)).json().turns.length,3);
});
