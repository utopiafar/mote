import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp,type QueryAgent} from '../src/app.js';
import {Conversations} from '../src/conversations.js';
import {Store} from '../src/store.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';

const token='generated-conversation-owner-token',headers={authorization:`Bearer ${token}`};
const answer=(text='Generated assistant reply')=>({answer:text,citations:[],trace:[],runId:randomUUID()});
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''});
const agent=(query:QueryAgent['query']):QueryAgent=>({configured:true,query,close:async()=>{}});

test('server conversations survive restart, preserve follow-up dialogue and allow explicit scope changes',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-conversations-')),seen:QueryInput[]=[];
  let running=await buildApp(config(dir),{agent:agent(async input=>{seen.push(input);return answer('Synthetic first answer');})});
  t.after(async()=>{await running.app.close();rmSync(dir,{recursive:true,force:true});});
  const scope={after:'2026-09-01T00:00:00Z',before:'2026-09-02T00:00:00Z',deviceId:'generated-phone',timeZone:'Asia/Shanghai'};
  const first=await running.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'关于我那份合成观测笔记',...scope}});
  assert.equal(first.statusCode,200);const {conversationId,turnId}=first.json();
  assert.ok(conversationId&&turnId);assert.equal(seen[0].conversation,undefined);
  await running.app.close();
  running=await buildApp(config(dir),{agent:agent(async input=>{seen.push(input);return answer('Synthetic continued answer');})});
  const list=await running.app.inject({url:'/api/conversations',headers});assert.equal(list.headers['cache-control'],'no-store');
  assert.equal(list.json().items[0].id,conversationId);assert.equal(list.json().items[0].title,'关于我那份合成观测笔记');
  const next=await running.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId,question:'继续解释它'}});
  assert.equal(next.statusCode,200);assert.equal(next.json().conversationId,conversationId);assert.notEqual(next.json().turnId,turnId);
  assert.equal(seen[1].deviceId,undefined);assert.equal(seen[1].after,undefined);assert.equal(seen[1].before,undefined);assert.equal(seen[1].timeZone,scope.timeZone);
  assert.deepEqual(seen[1].conversation,{turns:[{question:'关于我那份合成观测笔记',answer:'Synthetic first answer',scope,createdAt:seen[1].conversation!.turns[0].createdAt}],omittedTurns:0});
  const detail=(await running.app.inject({url:`/api/conversations/${conversationId}`,headers})).json();
  assert.equal(detail.turnCount,2);assert.deepEqual(detail.turns.map((turn:any)=>turn.question),['关于我那份合成观测笔记','继续解释它']);
  assert.equal(detail.turns[0].result.answer,'Synthetic first answer');
  const all=await running.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId,question:'使用全部资料继续',after:null,before:null,deviceId:null,timeZone:'UTC'}});
  assert.equal(all.statusCode,200);assert.equal(seen[2].after,undefined);assert.equal(seen[2].deviceId,undefined);assert.equal(seen[2].timeZone,'UTC');
  assert.equal((await running.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId,question:'invalid',conversation:{turns:[]}}})).statusCode,400);
  assert.equal((await running.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId,question:'invalid',before:'2026-09-01T00:00:00Z',after:'2026-09-02T00:00:00Z'}})).statusCode,400);
});

test('new answers receive bounded visible memory leads and respect explicit archive scope',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-opening-memory-')),seen:QueryInput[]=[];
  const {app,sources,memories,store}=await buildApp(config(dir),{agent:agent(async input=>{seen.push(input);return answer();})});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'fixture',platform:'import'});
  async function card(key:string,quote:string){
    const original=await sources.upsert('generated',{externalId:key,text:quote,revision:'1',observedAt:'2026-09-18T00:00:00Z',title:'Generated',kind:'file',layer:'original'});
    const result={answer:JSON.stringify({memories:[{title:`Generated ${key}`,statement:`${quote} [${original.id}]`,uncertainty:'Only in this fixture',admission:{layer:'memory',reason:'Generated project choice for future reference',scope:'Generated project',attribution:'user'},evidenceIds:[original.id],evidence:[{id:original.id,quote}]}]}),citations:[{id:original.id,capturedAt:'2026-09-18T00:00:00Z',appName:'Generated',excerpt:quote}],trace:[],runId:randomUUID()};
    return {original,memory:memories.extract(result,'fixture',{requireAdmission:true}).items[0]};
  }
  const published=await card('published','Generated published project choice');
  const proposed=await card('proposed','Generated proposed project choice');
  memories.publish(published.memory.id);
  assert.equal((await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Tell me about this generated project'}})).statusCode,200);
  assert.deepEqual(seen[0].openingMemories?.map(item=>[item.id,item.status]),[[published.memory.id,'published'],[proposed.memory.id,'proposed']]);
  assert.ok(seen[0].openingMemories!.every(item=>!('evidence' in item)));
  assert.equal((await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Only later records',after:'2026-09-19T00:00:00Z'}})).statusCode,200);
  assert.deepEqual(seen[1].openingMemories,[]);
  store.delete(published.original.id);
  assert.equal((await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Again'}})).statusCode,200);
  assert.deepEqual(seen[2].openingMemories?.map(item=>item.id),[proposed.memory.id]);
});

test('only the owner can read, continue or delete saved conversations',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-conversation-auth-'));
  const {app}=await buildApp(config(dir),{agent:agent(async()=>answer())});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const first=(await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated private dialogue'}})).json();
  const invitation=(await app.inject({method:'POST',url:'/api/connections/invitations',headers,payload:{serverUrl:'https://synthetic.invalid',label:'Generated phone'}})).json();
  const redeemed=(await app.inject({method:'POST',url:'/api/connections/redeem',payload:{code:invitation.invitation.code,deviceId:'fixture-phone',deviceName:'Fixture phone',platform:'android'}})).json();
  for(const route of ['/api/conversations',`/api/conversations/${first.conversationId}`]) {
    assert.equal((await app.inject(route)).statusCode,401);
    assert.equal((await app.inject({url:route,headers:{authorization:`Bearer ${redeemed.token}`}})).statusCode,403);
  }
  assert.equal((await app.inject({method:'DELETE',url:`/api/conversations/${first.conversationId}`,headers:{authorization:`Bearer ${redeemed.token}`}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/query',headers:{authorization:`Bearer ${redeemed.token}`},payload:{question:'continue',conversationId:first.conversationId}})).statusCode,403);
  assert.equal((await app.inject({method:'DELETE',url:`/api/conversations/${first.conversationId}`,headers})).json().deleted,1);
  assert.equal((await app.inject({url:`/api/conversations/${first.conversationId}`,headers})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'continue',conversationId:first.conversationId}})).statusCode,404);
});

test('failed answers remain visible and concurrent or deleted conversations cannot be overwritten',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-conversation-race-'));
  let complete!:(result:ReturnType<typeof answer>)=>void,started!:()=>void;
  let hold=false,fail=false;
  const began=new Promise<void>(resolve=>{started=resolve;});
  const {app}=await buildApp(config(dir),{agent:agent(async()=>{
    if(fail)throw new Error('Generated provider failure');
    if(hold){started();return new Promise(resolve=>{complete=resolve;});}
    return answer();
  })});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  fail=true;assert.equal((await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated failing question'}})).statusCode,500);
  const failedList=(await app.inject({url:'/api/conversations',headers})).json();assert.equal(failedList.items.length,1);assert.equal(failedList.items[0].status,'failed');
  const failed=(await app.inject({url:`/api/conversations/${failedList.items[0].id}`,headers})).json();assert.equal(failed.turns[0].status,'failed');assert.equal(failed.turns[0].question,'Generated failing question');assert.equal(failed.turns[0].error.code,'internal');
  fail=false;const first=(await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated success'}})).json();
  hold=true;
  const pending=app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId:first.conversationId,question:'Held followup'}}).then(value=>value);
  await began;
  assert.equal((await app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId:first.conversationId,question:'Concurrent followup'}})).statusCode,409);
  await app.inject({method:'DELETE',url:`/api/conversations/${first.conversationId}`,headers});
  complete(answer('Must not resurrect deleted conversation'));
  assert.equal((await pending).statusCode,409);
  assert.equal((await app.inject({url:'/api/conversations',headers})).json().items.length,1);
});

test('capture deletion removes derived history content and prevents in-flight answers restoring it',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-conversation-privacy-'));
  const seen:QueryInput[]=[];let hold=false,started!:()=>void,complete!:(result:ReturnType<typeof answer>)=>void;
  const began=new Promise<void>(resolve=>{started=resolve;});
  const {app,store}=await buildApp(config(dir),{agent:agent(async input=>{seen.push(input);if(hold){started();return new Promise(resolve=>{complete=resolve;});}return answer('Generated derived sensitive sentinel');})});
  t.after(async()=>{await app.close();rmSync(dir,{recursive:true,force:true});});
  const record={id:randomUUID(),deviceId:'fixture',deviceName:'Fixture',platform:'import',capturedAt:'2026-09-01T00:00:00Z',source:'note',ocrText:'Generated evidence',durationMs:0};
  await store.ingest(record);
  const first=(await app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated question'}})).json();
  hold=true;const pending=app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId:first.conversationId,question:'Held followup'}}).then(value=>value);await began;
  await app.inject({method:'DELETE',url:`/api/captures/${record.id}`,headers});complete(answer('Generated derived sensitive sentinel'));
  assert.equal((await pending).statusCode,409);
  const detail=await app.inject({url:`/api/conversations/${first.conversationId}`,headers});
  assert.ok(!detail.body.includes('Generated derived sensitive sentinel'));assert.equal(detail.json().turns[0].evidenceDeleted,true);assert.equal(detail.json().turns[0].question,'Generated question');
  hold=false;await app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId:first.conversationId,question:'Continue with remaining evidence'}});
  assert.equal(seen.at(-1)!.conversation!.turns[0].evidenceDeleted,true);assert.ok(!JSON.stringify(seen.at(-1)!.conversation).includes('Generated derived sensitive sentinel'));
});

test('conversation listing paginates deterministically and model context is bounded while full turns remain stored',t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-conversation-store-')),store=new Store(dir),conversations=new Conversations(store);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const first=conversations.append(undefined,{question:'Generated first conversation'},answer());
  const second=conversations.append(undefined,{question:'Generated second conversation'},answer());
  const page=conversations.list({limit:1});assert.equal(page.items.length,1);assert.ok(page.nextCursor);
  const next=conversations.list({limit:1,cursor:page.nextCursor!});assert.equal(next.items.length,1);assert.notEqual(page.items[0].id,next.items[0].id);assert.equal(next.nextCursor,null);
  assert.deepEqual(new Set([page.items[0].id,next.items[0].id]),new Set([first.conversationId,second.conversationId]));
  assert.throws(()=>conversations.list({cursor:'bad'}));
  for(let index=0;index<25;index++)conversations.append(conversations.get(first.conversationId),{question:`Generated followup ${index}`},answer('Generated response '.repeat(1800)));
  const saved=conversations.get(first.conversationId),context=conversations.context(saved);
  assert.equal(saved.turnCount,26);assert.ok(context.omittedTurns>0);assert.ok(context.turns.every(turn=>turn.answerTruncated));
  assert.equal(context.turns.at(-1)!.question,'Generated followup 24');assert.ok(JSON.stringify(context.turns).length<60100);
  assert.ok(store.logicalBytes()>800000);assert.equal(saved.turns.at(-1)!.result.answer.length,'Generated response '.repeat(1800).length);
});
