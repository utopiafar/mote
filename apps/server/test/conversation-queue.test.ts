import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import sharp from 'sharp';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {buildApp,type QueryAgent} from '../src/app.js';
import {TaskRecords} from '../src/task-records.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';

const token='generated-conversation-queue-owner',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'});
const result=(answer:string,ids:string[]=[])=>({answer,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids}});
const signal=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
async function until<T>(read:()=>T|Promise<T>,description:string):Promise<NonNullable<T>>{
  const deadline=Date.now()+10000;let value:T;
  do{value=await read();if(value)return value as NonNullable<T>;await new Promise(resolve=>setTimeout(resolve,10));}while(Date.now()<deadline);
  throw Error(`Timed out waiting for ${description}: ${JSON.stringify(value)}`);
}
async function fixture(t:TestContext,query:QueryAgent['query']){
  const dir=mkdtempSync(join(tmpdir(),'mote-conversation-queue-'));
  let implementation=query;
  const build=()=>buildApp(config(dir),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:(input,lease)=>implementation(input,lease)}});
  let node=await build();
  t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
  return {get node(){return node;},setQuery(next:QueryAgent['query']){implementation=next;},async restart(){await node.app.close();node=await build();}};
}
async function main(node:Awaited<ReturnType<typeof buildApp>>){const response=await node.app.inject({url:'/api/conversations/main',headers});assert.equal(response.statusCode,200,response.body);return response.json().id as string;}
async function post(node:Awaited<ReturnType<typeof buildApp>>,conversationId:string,question:string,auth=headers,scope:object={kind:'all'},clientRequestId=randomUUID()){
  const payload={conversationId,clientRequestId,question,scope};
  const response=await node.app.inject({method:'POST',url:'/api/conversations/messages',headers:auth,payload});assert.equal(response.statusCode,202,response.body);return {message:response.json(),payload};
}
async function message(node:Awaited<ReturnType<typeof buildApp>>,conversationId:string,id:string){const response=await node.app.inject({url:`/api/conversations/${conversationId}/messages/${id}`,headers});assert.equal(response.statusCode,200,response.body);return response.json();}
async function settled(node:Awaited<ReturnType<typeof buildApp>>,conversationId:string,id:string){return until(async()=>{const current=await message(node,conversationId,id);return ['completed','failed','cancelled'].includes(current.status)?current:undefined;},'message settlement');}

test('the production query adapter sends two queued turns in order to a controlled loopback provider',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-queue-provider-')),entered=signal(),release=signal(),lateEntered=signal(),lateRelease=signal(),requests:string[]=[];
  const provider=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;requests.push(body);const index=requests.length;
    if(index===1){entered.release();await release.promise;}
    if(index===3){lateEntered.release();await lateRelease.promise;}
    if(res.destroyed)return;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=(value:unknown)=>res.write('data: '+JSON.stringify(value)+'\n\n');
    send({id:'generated-provider-'+index,choices:[{index:0,delta:{role:'assistant',content:JSON.stringify({answer:'Generated provider answer '+index,citationIds:[]})},finish_reason:null}]});
    send({id:'generated-provider-'+index,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const cfg:Config={...config(dir),modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,modelMaxTokens:512};
  const node=await buildApp(cfg,{backgroundWorker:false});
  t.after(async()=>{release.release();lateRelease.release();await node.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
  const id=await main(node),invitation=(await node.app.inject({method:'POST',url:'/api/connections/invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'Generated provider phone'}})).json();
  const redeemed=(await node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.invitation.code,deviceId:'generated-provider-phone',deviceName:'Generated phone',platform:'android'}})).json();
  const first=await post(node,id,'GENERATED PROVIDER FIRST');await entered.promise;
  const second=await post(node,id,'GENERATED PROVIDER SECOND',{authorization:`Bearer ${redeemed.token}`});assert.equal(second.message.status,'queued');assert.equal(requests.length,1);
  release.release();assert.equal((await settled(node,id,first.message.id)).status,'completed');assert.equal((await settled(node,id,second.message.id)).status,'completed');
  assert.equal(requests.length,2);assert.match(requests[0],/GENERATED PROVIDER FIRST/);assert.doesNotMatch(requests[0],/GENERATED PROVIDER SECOND/);assert.match(requests[1],/GENERATED PROVIDER SECOND/);assert.match(requests[1],/Generated provider answer 1/);
  const saved=(await node.app.inject({url:`/api/conversations/${id}`,headers})).json();assert.deepEqual(saved.turns.map((turn:any)=>[turn.id,turn.result.answer]),[[first.message.id,'Generated provider answer 1'],[second.message.id,'Generated provider answer 2']]);
  const late=await post(node,id,'GENERATED PROVIDER CANCEL');await lateEntered.promise;
  const cancelled=await node.app.inject({method:'POST',url:`/api/conversations/${id}/messages/${late.message.id}/cancel`,headers});assert.equal(cancelled.json().status,'cancelled');
  const next=await post(node,id,'GENERATED PROVIDER AFTER CANCEL');lateRelease.release();assert.equal((await settled(node,id,next.message.id)).status,'completed');
  const after=(await node.app.inject({url:`/api/conversations/${id}`,headers})).json();assert.equal(after.turns.find((turn:any)=>turn.id===late.message.id).result,undefined);assert.equal(after.turns.find((turn:any)=>turn.id===next.message.id).result.answer,'Generated provider answer 4');
});

test('a controlled loopback provider resumes the original turn after both admission and in-flight restarts',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-queue-provider-restart-')),startGate=signal(),entered=signal(),providerGate=signal();let calls=0;
  const provider=createServer(async(req,res)=>{
    for await(const _ of req){}const index=++calls;
    if(index===1){entered.release();await providerGate.promise;}
    if(res.destroyed)return;
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const send=(value:unknown)=>res.write('data: '+JSON.stringify(value)+'\n\n');
    send({id:'generated-restart-'+index,choices:[{index:0,delta:{role:'assistant',content:JSON.stringify({answer:'Generated resumed provider answer',citationIds:[]})},finish_reason:null}]});
    send({id:'generated-restart-'+index,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const cfg:Config={...config(dir),modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,modelMaxTokens:512};
  let node=await buildApp(cfg,{backgroundWorker:false});
  t.after(async()=>{startGate.release();providerGate.release();await node.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
  const original=node.modelAuthorization.run.bind(node.modelAuthorization);
  t.mock.method(node.modelAuthorization,'run',async(id:string,task:any,abort?:AbortSignal)=>{if(id.startsWith('owner-query:'))await startGate.promise;return original(id,task,abort);});
  const id=await main(node),turn=await post(node,id,'Generated provider restart');
  await until(()=>{const current=node.conversations.message(turn.message.id);return current.runId&&!node.store.db.prepare('SELECT 1 FROM query_runs WHERE id=?').get(current.runId)?current:undefined;},'saved message before provider admission');
  await node.app.close();startGate.release();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
  node=await buildApp(cfg,{backgroundWorker:false});await entered.promise;assert.equal(calls,1);
  await node.app.close();providerGate.release();node=await buildApp(cfg,{backgroundWorker:false});
  const completed=await settled(node,id,turn.message.id);assert.equal(completed.status,'completed',JSON.stringify(completed));assert.equal(calls,2);
  const saved=(await node.app.inject({url:`/api/conversations/${id}`,headers})).json();assert.equal(saved.turns.length,1);assert.equal(saved.turns[0].id,turn.message.id);assert.equal(saved.turns[0].result.answer,'Generated resumed provider answer');
});

test('two clients keep accepted messages in sequence and the real query completes each original turn',async t=>{
  const entered=signal(),release=signal(),seen:QueryInput[]=[];
  const f=await fixture(t,async input=>{seen.push(input);if(input.question==='Generated first'){entered.release();await release.promise;}return result('Answer to '+input.question);});t.after(()=>release.release());
  const id=await main(f.node),invitation=(await f.node.app.inject({method:'POST',url:'/api/connections/invitations',headers,payload:{serverUrl:'https://generated.invalid',label:'Generated second client'}})).json();
  const redeemed=(await f.node.app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.invitation.code,deviceId:'generated-phone',deviceName:'Generated phone',platform:'android'}})).json();
  const first=await post(f.node,id,'  Generated first  ');await entered.promise;
  const tasks=new TaskRecords(f.node.store),task=tasks.create({operationId:'generated-independent-task',kind:'assistant',requestId:randomUUID(),input:{goal:'Generated long work'},evidenceDependencies:{version:1,complete:true,ids:[]}},()=>{});assert.equal(task.state,'waiting');
  const second=await post(f.node,id,'Generated second',{authorization:`Bearer ${redeemed.token}`});
  assert.deepEqual([first.message.seq,second.message.seq],[0,1]);assert.equal(second.message.status,'queued');assert.equal(seen.length,1);
  const pending=(await f.node.app.inject({url:`/api/conversations/${id}`,headers})).json();assert.deepEqual(pending.turns.map((turn:any)=>turn.question),['  Generated first  ','Generated second']);
  assert.equal(pending.status,'queued');assert.equal(pending.turnCount,2);
  const listed=(await f.node.app.inject({url:'/api/conversations',headers})).json();assert.equal(listed.items.find((item:any)=>item.id===id).turnCount,2);
  const retried=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:second.payload});assert.equal(retried.statusCode,202,retried.body);assert.equal(retried.json().id,second.message.id);
  const conflicting=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{...second.payload,question:'Changed input'}});assert.equal(conflicting.statusCode,409);
  release.release();assert.equal((await settled(f.node,id,first.message.id)).status,'completed');assert.equal((await settled(f.node,id,second.message.id)).status,'completed');
  assert.deepEqual(seen.map(input=>input.question),['Generated first','Generated second']);assert.equal(seen[1].conversation?.turns[0]?.answer,'Answer to Generated first');
  const saved=(await f.node.app.inject({url:`/api/conversations/${id}`,headers})).json();assert.equal(saved.turns.length,2);
  assert.deepEqual(saved.turns.map((turn:any)=>turn.id),[first.message.id,second.message.id]);assert.deepEqual(saved.turns.map((turn:any)=>turn.result.answer),['Answer to Generated first','Answer to Generated second']);
  assert.equal(tasks.get(task.id).state,'waiting');
});

test('cancelled queued and running messages never receive a late answer and the next turn proceeds',async t=>{
  const firstStarted=signal(),firstRelease=signal(),lateStarted=signal(),lateRelease=signal(),seen:string[]=[];
  const f=await fixture(t,async input=>{seen.push(input.question);if(input.question==='Held first'){firstStarted.release();await firstRelease.promise;}if(input.question==='Held late'){lateStarted.release();await lateRelease.promise;}return result('Generated answer '+input.question);});
  t.after(()=>{firstRelease.release();lateRelease.release();});const id=await main(f.node),first=await post(f.node,id,'Held first');await firstStarted.promise;
  const queued=await post(f.node,id,'Cancelled before start');const cancel=(messageId:string)=>f.node.app.inject({method:'POST',url:`/api/conversations/${id}/messages/${messageId}/cancel`,headers});
  assert.equal((await cancel(queued.message.id)).json().status,'cancelled');firstRelease.release();assert.equal((await settled(f.node,id,first.message.id)).status,'completed');
  const held=await post(f.node,id,'Held late');await lateStarted.promise;assert.equal((await cancel(held.message.id)).json().status,'cancelled');
  const next=await post(f.node,id,'After cancellation');lateRelease.release();assert.equal((await settled(f.node,id,next.message.id)).status,'completed');
  assert.equal((await message(f.node,id,held.message.id)).status,'cancelled');assert.ok(!seen.includes('Cancelled before start'));
  const saved=(await f.node.app.inject({url:`/api/conversations/${id}`,headers})).json();assert.equal(saved.turns.find((turn:any)=>turn.id===held.message.id).result,undefined);assert.doesNotMatch(JSON.stringify(saved),/Generated answer Held late/);
});

test('quiescing keeps accepted messages readable and retryable while refusing new admission',async t=>{
  const entered=signal(),release=signal();const f=await fixture(t,async()=>{entered.release();await release.promise;return result('Generated draining answer');});t.after(()=>release.release());
  const id=await main(f.node),turn=await post(f.node,id,'Generated draining question');await entered.promise;
  f.node.queryRunServices.quiesce('disabled');assert.equal((await message(f.node,id,turn.message.id)).id,turn.message.id);
  const retry=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:turn.payload});assert.equal(retry.statusCode,202,retry.body);assert.equal(retry.json().id,turn.message.id);
  const refused=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{...turn.payload,clientRequestId:randomUUID()}});assert.equal(refused.statusCode,503);
  release.release();assert.equal((await settled(f.node,id,turn.message.id)).status,'completed');
});

test('restart after admission and while a result is in flight recovers exactly the same turn',async t=>{
  const blocked=signal(),started=signal();let calls=0;
  const f=await fixture(t,async input=>{calls++;started.release();await new Promise<void>(resolve=>{if(input.signal?.aborted)return resolve();input.signal?.addEventListener('abort',()=>resolve(),{once:true});});return result('Interrupted result');});
  const originalRun=f.node.modelAuthorization.run.bind(f.node.modelAuthorization);
  t.mock.method(f.node.modelAuthorization,'run',async(id:string,task:any,abort?:AbortSignal)=>{if(id.startsWith('owner-query:'))await blocked.promise;return originalRun(id,task,abort);});
  const id=await main(f.node),received=await post(f.node,id,'Generated restart');
  await until(()=>{const current=f.node.conversations.message(received.message.id);return current.runId&&!f.node.store.db.prepare('SELECT 1 FROM query_runs WHERE id=?').get(current.runId)?current:undefined;},'admitted turn before query start');
  await f.node.app.close();blocked.release();await new Promise(resolve=>setImmediate(resolve));
  await f.restart();assert.equal(await main(f.node),id);await started.promise;assert.equal(calls,1);
  f.setQuery(async()=>{calls++;return result('Recovered answer');});await f.restart();
  const completed=await settled(f.node,id,received.message.id);assert.equal(completed.status,'completed',JSON.stringify({completed,turn:f.node.conversations.message(received.message.id),run:f.node.queryRuns.get(received.message.id)}));
  const saved=(await f.node.app.inject({url:`/api/conversations/${id}`,headers})).json();assert.equal(saved.turns.length,1);assert.equal(saved.turns[0].id,received.message.id);assert.equal(saved.turns[0].result.answer,'Recovered answer');assert.equal(calls,2);
  await f.restart();assert.equal((await message(f.node,id,received.message.id)).status,'completed');assert.equal(calls,2);
});

test('empty and selected scopes reach the real query bridge without disclosing another source',async t=>{
  let f!:Awaited<ReturnType<typeof fixture>>;const seen:QueryInput[]=[];let other='';
  f=await fixture(t,async input=>{
    seen.push(input);const bridge=await startBridge(f.node.featureServices.archiveReader,input);
    try{
      const response=await fetch(bridge.url+'/evidence',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({ids:[other]})});
      assert.notEqual(response.status,200,'an out-of-scope original cannot be read through the bridge');
      if(input.hostToolSelection)return {answer:'Generated owner-only answer',citations:[],trace:[],runId:randomUUID()};
      return result('Generated scoped answer',input.evidenceIds??[]);
    }finally{await bridge.close();}
  });
  const ids:string[]=[];
  for(const sourceId of ['generated-visible','generated-hidden']){
    assert.equal((await f.node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id:sourceId,name:sourceId,kind:'custom',deviceId:'generated-device',platform:'import'}})).statusCode,200);
    const saved=await f.node.app.inject({method:'PUT',url:`/api/sources/${sourceId}/items`,headers,payload:{externalId:'generated-item',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'snapshot',text:`Generated ${sourceId} body`}});assert.equal(saved.statusCode,200,saved.body);ids.push(saved.json().id);
  }
  other=ids[1];const id=await main(f.node);
  const sourceOnly=await post(f.node,id,'Source only',headers,{kind:'selection',sourceIds:['generated-visible']});assert.equal((await settled(f.node,id,sourceOnly.message.id)).status,'completed');assert.equal(seen[0].evidenceIds,undefined,'a source grant is not an expanded original selection');
  seen.length=0;
  const selected=await post(f.node,id,'Selected source',headers,{kind:'selection',sourceIds:['generated-visible'],evidenceIds:ids});assert.equal((await settled(f.node,id,selected.message.id)).status,'completed');assert.deepEqual(seen[0].evidenceIds,[ids[0]]);
  const empty=await post(f.node,id,'Empty selection',headers,{kind:'selection',sourceIds:[]});assert.equal((await settled(f.node,id,empty.message.id)).status,'completed');assert.deepEqual(seen[1].hostToolSelection,[]);assert.equal(seen[1].evidenceIds,undefined);assert.deepEqual(seen[1].openingMemories,[]);assert.equal(seen[1].conversation?.turns.length,0);
  const next=await post(f.node,id,'Continue empty selection',headers,{kind:'selection',sourceIds:[]});assert.equal((await settled(f.node,id,next.message.id)).status,'completed');assert.deepEqual(seen[2].conversation?.turns.map(turn=>turn.question),['Empty selection']);
  const anchored=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{conversationId:id,clientRequestId:randomUUID(),question:'Selected anchor',scope:{kind:'selection',evidenceIds:[ids[0]]},anchorEvidenceIds:[ids[0]]}});assert.equal(anchored.statusCode,202,anchored.body);assert.equal((await settled(f.node,id,anchored.json().id)).status,'completed');assert.deepEqual(seen[3].anchorEvidenceIds,[ids[0]]);
  const outside=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{conversationId:id,clientRequestId:randomUUID(),question:'Outside anchor',scope:{kind:'selection',evidenceIds:[ids[0]]},anchorEvidenceIds:[ids[1]]}});assert.equal(outside.statusCode,202,outside.body);assert.equal((await settled(f.node,id,outside.json().id)).status,'failed');assert.equal(seen.length,4);
  const sourceAnchor=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{conversationId:id,clientRequestId:randomUUID(),question:'Source-only anchor',scope:{kind:'selection',sourceIds:['generated-visible']},anchorEvidenceIds:[ids[0]]}});assert.equal(sourceAnchor.statusCode,202,sourceAnchor.body);assert.equal((await settled(f.node,id,sourceAnchor.json().id)).status,'completed');assert.deepEqual(seen[4].anchorEvidenceIds,[ids[0]]);assert.equal(seen[4].evidenceIds,undefined);
  const outsideSource=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{conversationId:id,clientRequestId:randomUUID(),question:'Outside source anchor',scope:{kind:'selection',sourceIds:['generated-visible']},anchorEvidenceIds:[ids[1]]}});assert.equal(outsideSource.statusCode,202,outsideSource.body);assert.equal((await settled(f.node,id,outsideSource.json().id)).status,'failed');assert.equal(seen.length,5);
});

test('a source with 31 originals reaches the production provider without seeding a bulk prompt',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-source-provider-')),requests:string[]=[];
  const provider=createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;requests.push(body);
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end('data: '+JSON.stringify({id:'generated-source-provider',choices:[{index:0,delta:{role:'assistant',content:JSON.stringify({answer:'Generated source answer',citationIds:[]})},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const node=await buildApp({...config(dir),modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,modelMaxTokens:512},{backgroundWorker:false});
  t.after(async()=>{await node.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
  node.sources.register({id:'generated-bulk-source',name:'Generated bulk source',kind:'custom',deviceId:'generated-device',platform:'import'});
  // 31 is the smallest source that would fail a mistaken conversion to the
  // existing strict 30-original selection, before any provider request.
  for(let i=0;i<31;i++)await node.sources.upsert('generated-bulk-source',{externalId:'file-'+i,revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'snapshot',title:'GENERATED_BULK_TITLE_'+i,text:'GENERATED_BULK_BODY_'+i,document:{path:'generated-bulk-path/'+i+'.txt',contentRole:'other',timeBasis:'unknown'}});
  const id=await main(node),turn=await post(node,id,'Generated source-only request',headers,{kind:'selection',sourceIds:['generated-bulk-source']});
  assert.equal((await settled(node,id,turn.message.id)).status,'completed');assert.equal(requests.length,1);
  assert.match(requests[0],/Generated source-only request/);assert.doesNotMatch(requests[0],/GENERATED_BULK_TITLE|GENERATED_BULK_BODY|generated-bulk-path/);
  const payload=node.delegation.journal.payload<{prepared:QueryInput}>('query:'+turn.message.id);
  assert.equal(payload.prepared.evidenceIds,undefined);assert.equal(payload.prepared.processingEvidence,undefined);assert.equal(payload.prepared.hostToolSelection,undefined,'ordinary on-demand retrieval remains available');
});

test('source-only history excludes the wider main summary and exposes only compatible turns through history tools',async t=>{
  let f!:Awaited<ReturnType<typeof fixture>>,failure:unknown;
  f=await fixture(t,async input=>{
    const bridge=await startBridge(f.node.featureServices.archiveReader,input);
    try{
      assert.doesNotMatch(JSON.stringify(input.conversation),/GENERATED_HIDDEN|GENERATED_WIDE/);
      assert.equal(input.conversation?.workingMemory,undefined);
      assert.deepEqual(input.conversation?.turns.map(turn=>turn.question),['Generated visible history']);
      const call=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});const body=await response.json() as any;assert.equal(response.status,200,JSON.stringify(body));return body;};
      const history=await call('conversation_history',{}),search=await call('conversation_search',{query:'GENERATED_HIDDEN'});
      assert.deepEqual(history.data.items.map((item:any)=>item.question),['Generated visible history']);assert.deepEqual(search.data.items,[]);
      assert.doesNotMatch(JSON.stringify({history,search}),/GENERATED_HIDDEN|GENERATED_WIDE/);
      return {...result('Generated scoped follow-up'),trace:bridge.trace,evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
    }catch(error){failure=error;throw error;}finally{await bridge.close();}
  });
  const id=await main(f.node),ids:string[]=[];
  for(const sourceId of ['generated-visible','generated-hidden']){
    f.node.sources.register({id:sourceId,name:sourceId,kind:'custom',deviceId:'generated-device',platform:'import'});
    ids.push((await f.node.sources.upsert(sourceId,{externalId:'item',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated history original'})).id);
  }
  f.node.conversations.append(f.node.conversations.get(id),{question:'Generated visible history',kind:'selection',sourceIds:['generated-visible']},result('Generated visible answer',[ids[0]]));
  f.node.conversations.append(f.node.conversations.get(id),{question:'GENERATED_WIDE_QUESTION',kind:'all'},result('GENERATED_WIDE_ANSWER',ids));
  f.node.conversations.append(f.node.conversations.get(id),{question:'GENERATED_HIDDEN_QUESTION',kind:'selection',sourceIds:['generated-hidden']},result('GENERATED_HIDDEN_ANSWER',[ids[1]]));
  f.node.conversations.append(f.node.conversations.get(id),{question:'GENERATED_HIDDEN_TAINTED_HISTORY',kind:'selection',sourceIds:['generated-visible']},result('GENERATED_HIDDEN_TAINTED_ANSWER',[ids[0]]));
  const conversation=f.node.conversations.get(id),summary={text:'GENERATED_WIDE_SUMMARY',coveredThroughSeq:3,contextVersion:0,generatedAt:'2026-10-03T00:00:00Z',fingerprint:createHash('sha256').update(JSON.stringify([3,0,conversation.turns])).digest('hex'),evidenceDependencies:{version:1,complete:true,ids}};
  f.node.store.db.prepare('INSERT INTO working_memories(id,json) VALUES(?,?)').run(id,JSON.stringify(summary));
  const turn=await post(f.node,id,'Generated source follow-up',headers,{kind:'selection',sourceIds:['generated-visible']});
  const finished=await settled(f.node,id,turn.message.id);if(failure)throw failure;assert.equal(finished.status,'completed',JSON.stringify(f.node.conversations.message(turn.message.id)));
});

test('empty, unknown and disabled source grants never fall back to all, and outside anchors still fail',async t=>{
  let f!:Awaited<ReturnType<typeof fixture>>,failure:unknown;const seen:QueryInput[]=[];
  f=await fixture(t,async input=>{
    seen.push(input);
    try{
      const reader=f.node.featureServices.archiveReader;
      const search=await reader.search({query:'GENERATED_RESTRICTED'}),sources=await reader.sources!({}),items=await reader.sourceItems!({}),memories=await reader.memories!({});
      assert.equal(search.length,0);assert.deepEqual((sources as any).items,[]);assert.deepEqual(items.items,[]);assert.deepEqual(memories.items,[]);assert.deepEqual(input.openingMemories,[]);
      return result('Generated owner text answer');
    }catch(error){failure=error;throw error;}
  });
  f.node.sources.register({id:'generated-disabled',name:'GENERATED_RESTRICTED_TITLE',kind:'custom',deviceId:'generated-device',platform:'import'});
  const original=(await f.node.sources.upsert('generated-disabled',{externalId:'item',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'GENERATED_RESTRICTED_BODY'})).id;
  const disabled=await f.node.app.inject({method:'PATCH',url:'/api/sources/generated-disabled',headers,payload:{enabled:false}});assert.equal(disabled.statusCode,200,disabled.body);
  const id=await main(f.node);
  for(const sourceIds of [[],['generated-missing'],['generated-disabled']]){
    const turn=await post(f.node,id,'Generated restricted request',headers,{kind:'selection',sourceIds});
    const finished=await settled(f.node,id,turn.message.id);if(failure)throw failure;assert.equal(finished.status,'completed',JSON.stringify(finished));
  }
  for(const input of seen)assert.deepEqual(input.hostToolSelection,[],'empty or unavailable source grants expose no archive tools');
  const outside=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{conversationId:id,clientRequestId:randomUUID(),question:'Generated outside source anchor',scope:{kind:'selection',sourceIds:['generated-missing']},anchorEvidenceIds:[original]}});
  assert.equal(outside.statusCode,202,outside.body);assert.equal((await settled(f.node,id,outside.json().id)).status,'failed');assert.equal(seen.length,3,'an outside anchor cannot reach the model');
});

test('history receipts survive later completed turns but reject changes to a turn actually read',async t=>{
  const f=await fixture(t,async input=>result('Generated history answer',input.evidenceIds??[]));const id=await main(f.node);
  const note={id:randomUUID(),deviceId:'generated-device',deviceName:'Generated device',platform:'android',capturedAt:'2026-10-01T00:00:00Z',text:'Generated history original',metadata:{version:1,observedAt:'2026-10-01T00:00:00Z'}};
  const created=await f.node.app.inject({method:'POST',url:'/api/notes',headers,payload:note});assert.equal(created.statusCode,201,created.body);
  const scope={kind:'selection',evidenceIds:[note.id]},first=await post(f.node,id,'First history',headers,scope);assert.equal((await settled(f.node,id,first.message.id)).status,'completed');
  const snapshot=f.node.conversations.historyContext(f.node.conversations.get(id));
  const second=await post(f.node,id,'Later history',headers,scope);assert.equal((await settled(f.node,id,second.message.id)).status,'completed');
  assert.deepEqual([...f.node.conversations.assertHistoryContext(snapshot)],[],'an unrelated appended turn does not invalidate the pinned prefix');
  const removed=await f.node.app.inject({method:'DELETE',url:`/api/notes/${note.id}`,headers});assert.equal(removed.statusCode,200,removed.body);
  assert.throws(()=>f.node.conversations.assertHistoryContext(snapshot),/Conversation changed|lineage changed/,'a changed turn that was actually read invalidates the receipt');
});

test('withdrawing selected evidence while a query is in flight cannot publish the late result',async t=>{
  const entered=signal(),release=signal();const f=await fixture(t,async input=>{entered.release();await release.promise;return result('Generated withdrawn late answer',input.evidenceIds??[]);});t.after(()=>release.release());
  const note={id:randomUUID(),deviceId:'generated-device',deviceName:'Generated device',platform:'android',capturedAt:'2026-10-01T00:00:00Z',text:'Generated selected note',metadata:{version:1,observedAt:'2026-10-01T00:00:00Z'}};
  const created=await f.node.app.inject({method:'POST',url:'/api/notes',headers,payload:note});assert.equal(created.statusCode,201,created.body);
  const id=await main(f.node),turn=await post(f.node,id,'Generated withdrawal',headers,{kind:'selection',evidenceIds:[note.id]});await entered.promise;
  const removed=await f.node.app.inject({method:'DELETE',url:`/api/notes/${note.id}`,headers});assert.equal(removed.statusCode,200,removed.body);release.release();
  assert.equal((await settled(f.node,id,turn.message.id)).status,'failed');
  const history=await f.node.app.inject({url:`/api/conversations/${id}`,headers});assert.doesNotMatch(history.body,/Generated withdrawn late answer/);
});

test('a queued message rechecks its selection after withdrawal without invalidating an unrelated running answer',async t=>{
  const entered=signal(),release=signal(),seen:string[]=[];const f=await fixture(t,async input=>{seen.push(input.question);if(input.question==='Unrelated first'){entered.release();await release.promise;}return result('Generated answer '+input.question,input.evidenceIds??[]);});t.after(()=>release.release());
  const note={id:randomUUID(),deviceId:'generated-device',deviceName:'Generated device',platform:'android',capturedAt:'2026-10-01T00:00:00Z',text:'Generated queued original',metadata:{version:1,observedAt:'2026-10-01T00:00:00Z'}};
  const created=await f.node.app.inject({method:'POST',url:'/api/notes',headers,payload:note});assert.equal(created.statusCode,201,created.body);
  const id=await main(f.node),first=await post(f.node,id,'Unrelated first');await entered.promise;
  const second=await post(f.node,id,'Queued selected question',headers,{kind:'selection',evidenceIds:[note.id]});assert.equal(second.message.status,'queued');
  const removed=await f.node.app.inject({method:'DELETE',url:`/api/notes/${note.id}`,headers});assert.equal(removed.statusCode,200,removed.body);release.release();
  assert.equal((await settled(f.node,id,first.message.id)).status,'completed');assert.equal((await settled(f.node,id,second.message.id)).status,'failed');assert.deepEqual(seen,['Unrelated first']);
});

test('a changed message revision cannot publish the previous in-flight answer',async t=>{
  const entered=signal(),release=signal();const f=await fixture(t,async()=>{entered.release();await release.promise;return result('Generated stale revision answer');});t.after(()=>release.release());
  const id=await main(f.node),turn=await post(f.node,id,'Generated revision race');await entered.promise;
  // Inject a concurrent turn revision; there is deliberately no public edit
  // command yet. The query itself still enters and completes through HTTP.
  f.node.store.db.prepare("UPDATE conversation_turns SET json=json_set(json,'$.version',json_extract(json,'$.version')+1) WHERE id=?").run(turn.message.id);
  release.release();assert.equal((await settled(f.node,id,turn.message.id)).status,'failed');
  const history=await f.node.app.inject({url:`/api/conversations/${id}`,headers});assert.doesNotMatch(history.body,/Generated stale revision answer/);
});

test('a separate query-run request cannot replace a queued message scope',async t=>{
  const gate=signal(),seen:QueryInput[]=[];const f=await fixture(t,async input=>{seen.push(input);return result('Generated constrained answer');});t.after(()=>gate.release());
  const run=f.node.modelAuthorization.run.bind(f.node.modelAuthorization);
  t.mock.method(f.node.modelAuthorization,'run',async(id:string,task:any,abort?:AbortSignal)=>{if(id.startsWith('owner-query:'))await gate.promise;return run(id,task,abort);});
  const id=await main(f.node),turn=await post(f.node,id,'Generated protected question',headers,{kind:'selection',evidenceIds:[]});
  await until(()=>{const current=f.node.conversations.message(turn.message.id);return current.runId&&!f.node.store.db.prepare('SELECT 1 FROM query_runs WHERE id=?').get(current.runId)?current:undefined;},'message before query run');
  const forged=await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id:turn.message.id,input:{conversationId:id,question:'Generated protected question'}}});assert.equal(forged.statusCode,409,forged.body);assert.equal(seen.length,0);
  gate.release();assert.equal((await settled(f.node,id,turn.message.id)).status,'completed');assert.deepEqual(seen[0].hostToolSelection,[]);
});

test('a withdrawn image loses its title and a late response cannot publish',async t=>{
  const entered=signal(),release=signal();const f=await fixture(t,async input=>{assert.equal(input.directImages?.length,1);entered.release();await release.promise;return result('Generated late image answer');});t.after(()=>release.release());
  const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#224466'}}).png().toBuffer(),hash=createHash('sha256').update(bytes).digest('hex');
  f.node.sources.register({id:'generated-queue-image',name:'Generated',kind:'upload',deviceId:'generated-device',platform:'import',retention:'archive'});
  const upload=f.node.files.begin({sourceId:'generated-queue-image',item:{externalId:'image',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'GENERATED_PRIVATE_ATTACHMENT_NAME',kind:'file',layer:'original',text:'',mimeType:'image/png'},sha256:hash,sizeBytes:bytes.length},()=>{});
  f.node.files.part(upload.uploadId,0,bytes,()=>{});const imageId=(await f.node.files.commit(upload.uploadId,()=>{})).captureId,id=await main(f.node);
  const payload={conversationId:id,clientRequestId:randomUUID(),question:'Generated image question',scope:{kind:'all'},attachmentIds:[imageId]};
  const response=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload});assert.equal(response.statusCode,202,response.body);const turn=response.json();await entered.promise;
  const before=await f.node.app.inject({url:`/api/conversations/${id}`,headers});assert.match(before.body,/GENERATED_PRIVATE_ATTACHMENT_NAME/);
  assert.doesNotMatch(String(f.node.store.db.prepare('SELECT json FROM conversation_turns WHERE id=?').get(turn.id)!.json),/GENERATED_PRIVATE_ATTACHMENT_NAME/,'the immutable input does not retain a derived filename');
  const deleted=await f.node.app.inject({method:'DELETE',url:`/api/captures/${imageId}`,headers});assert.equal(deleted.statusCode,200,deleted.body);
  const pending=await f.node.app.inject({url:`/api/conversations/${id}`,headers});assert.doesNotMatch(pending.body,/GENERATED_PRIVATE_ATTACHMENT_NAME/);assert.equal((await message(f.node,id,turn.id)).attachmentIds,undefined);
  const retry=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload});assert.equal(retry.statusCode,202,retry.body);assert.equal(retry.json().id,turn.id);assert.equal(retry.json().attachmentIds,undefined);
  const changed=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{...payload,attachmentIds:[]}});assert.equal(changed.statusCode,409);
  release.release();assert.equal((await settled(f.node,id,turn.id)).status,'failed');const history=await f.node.app.inject({url:`/api/conversations/${id}`,headers});assert.doesNotMatch(history.body,/Generated late image answer|GENERATED_PRIVATE_ATTACHMENT_NAME/);
});

test('deleting a conversation during a query does not recreate its turn',async t=>{
  const entered=signal(),release=signal();const f=await fixture(t,async()=>{entered.release();await release.promise;return result('Generated deleted conversation answer');});t.after(()=>release.release());
  const id=await main(f.node),turn=await post(f.node,id,'Generated delete while running');await entered.promise;
  const deleted=await f.node.app.inject({method:'DELETE',url:`/api/conversations/${id}`,headers});assert.equal(deleted.json().deleted,1);release.release();
  await until(()=>{const work=f.node.delegation.get('query:'+turn.message.id);return work.status==='stale'||work.status==='cancelled'||work.status==='failed'?work.status:undefined;},'deleted query to stop');
  assert.equal((await f.node.app.inject({url:`/api/conversations/${id}`,headers})).statusCode,404);
  const listed=await f.node.app.inject({url:'/api/conversations',headers});assert.doesNotMatch(listed.body,/Generated deleted conversation answer|Generated delete while running/);
});

test('one-turn model selection is persisted and part of idempotent admission',async t=>{
  const f=await fixture(t,async()=>result('Generated model answer'));
  const id=await main(f.node),payload={conversationId:id,clientRequestId:randomUUID(),question:'Generated model question',scope:{kind:'all'},modelProfileId:'env:deployment',modelOverride:'generated-model'};
  let response=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload});
  assert.equal(response.statusCode,202,response.body);const message=response.json();
  assert.equal(message.modelProfileId,'env:deployment');assert.equal(message.modelOverride,'generated-model');
  assert.equal(f.node.conversations.message(message.id).modelProfileId,'env:deployment');
  assert.equal((await settled(f.node,id,message.id)).status,'completed');
  response=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload});
  assert.equal(response.statusCode,202,response.body);assert.equal(response.json().id,message.id);
  const conflict=await f.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{...payload,modelOverride:'generated-other-model'}});
  assert.equal(conflict.statusCode,409,conflict.body);
});

test('query preparation applies the saved model budget to C4 before the next conversation request',async t=>{
 const seen:QueryInput[]=[];
 const f=await fixture(t,async input=>{
  seen.push(input);
  if(input.skill==='working-memory')return result('Generated compact summary of earlier dialogue');
  return result('Generated answer '+input.question+' '+('x'.repeat(2500)));
 });
 const id=await main(f.node);
 for(let i=0;i<4;i++){const turn=await post(f.node,id,'Generated history '+i);assert.equal((await settled(f.node,id,turn.message.id)).status,'completed');}
 const configResponse=await f.node.app.inject({url:'/api/configuration',headers}),configView=configResponse.json();
 const configured=await f.node.app.inject({method:'PUT',url:'/api/configuration/conversations',headers,payload:{revision:configView.revision,value:{context:{historyRatio:0.01,lowWatermarkRatio:0.5,contextWindow:120000,contextWindowSource:'configured'}}}});
 assert.equal(configured.statusCode,200,configured.body);
 const next=await post(f.node,id,'Generated follow-up after budget change');const finished=await settled(f.node,id,next.message.id);
 assert.equal(finished.status,'completed',JSON.stringify(finished));
 const compactions=seen.filter(input=>input.skill==='working-memory');assert.ok(compactions.length>0,'the existing C4 summarizer was used');
 const final=seen.find(input=>input.question==='Generated follow-up after budget change')!;
 assert.equal(final.modelBudget?.contextWindow,120000);assert.equal(final.modelBudget?.historyRatio,0.01);assert.match(final.conversation?.workingMemory?.text??'',/compact summary/);
 assert.ok(final.conversation!.turns.length>0,'the latest dialogue tail remains present');
 assert.equal(f.node.conversations.get(id).turns.length,5,'compaction does not remove the original history');
});
