import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {QueryInput} from '@mote/agent';
import type {SourceContextDeclaration} from '@mote/shared';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Conversations} from '../src/conversations.js';
import {SourceContextStore} from '../src/source-context.js';
import {WorkingMemory} from '../src/working-memory.js';
import {defaultLifecycleSettings} from '../src/memory-lifecycle.js';

const token='generated-source-context-conversation-token',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''});
const answer=(text:string,pins:SourceContextDeclaration[]=[])=>({answer:text,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[] as string[]},...(pins.length?{sourceContextDependencies:pins}:{})});
const agent=(query:QueryAgent['query']):QueryAgent=>({configured:true,query,close:async()=>{}});

test('source-only answers survive restart with stale status and historical prose in follow-up context',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-source-dialogue-')),seen:QueryInput[]=[];
  let pin:SourceContextDeclaration;
  let running=await buildApp(config(dir),{agent:agent(async input=>{seen.push(input);return answer('Generated source description interpretation',[pin]);})});
  t.after(async()=>{await running.app.close();rmSync(dir,{recursive:true,force:true});});
  running.sources.register({id:'generated-call-directory',name:'Generated recordings',kind:'local-files',deviceId:'generated-phone',platform:'android'});
  running.sources.updateContext('generated-call-directory',{expectedVersion:0,description:'Generated phone calls; I am one participant.'});
  pin=new SourceContextStore(running.store).identity('generated-call-directory')!;
  const first=await running.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Keep my explicitly stated fixture constraint'}});
  assert.equal(first.statusCode,200);const conversationId=first.json().conversationId;
  assert.deepEqual(first.json().sourceContextDependencies,[pin]);assert.deepEqual(first.json().evidenceDependencies.ids,[]);
  await running.app.close();
  running=await buildApp(config(dir),{agent:agent(async input=>{seen.push(input);return answer('Generated fresh interpretation');})});
  running.sources.updateContext('generated-call-directory',{expectedVersion:1,description:'Generated shared archive; participants vary.'});
  const second=await running.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Continue using current context',conversationId}});
  assert.equal(second.statusCode,200);
  const previous=seen.at(-1)!.conversation!;
  assert.equal(previous.turns[0].question,'Keep my explicitly stated fixture constraint');
  assert.equal(previous.turns[0].answer,'Generated source description interpretation');assert.equal(previous.turns[0].evidenceStale,true);assert.equal(previous.turns[0].contextStale,true);
  assert.equal(previous.omittedTurns,0);assert.deepEqual(previous.evidenceDependencies,{version:1,complete:true,ids:[]});
  assert.equal(previous.sourceContextDependencies,undefined);
  const history=(await running.app.inject({url:`/api/conversations/${conversationId}`,headers})).json();
  assert.equal(history.turns[0].result.answer,'Generated source description interpretation');
  assert.deepEqual(history.turns[0].result.sourceContextDependencies,[pin]);
});

test('source-only query cannot publish after its metadata version changes during model work',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-source-query-race-'));
  let pin:SourceContextDeclaration,started!:()=>void,finish!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;}),wait=new Promise<void>(resolve=>{finish=resolve;});
  const running=await buildApp(config(dir),{agent:agent(async()=>{started();await wait;return answer('Generated obsolete metadata reply',[pin]);})});
  t.after(async()=>{await running.app.close();rmSync(dir,{recursive:true,force:true});});
  running.sources.register({id:'generated-racing-source',name:'Generated source',kind:'local-files',deviceId:'generated-phone',platform:'android'});
  running.sources.updateContext('generated-racing-source',{expectedVersion:0,description:'Generated version one'});
  pin=new SourceContextStore(running.store).identity('generated-racing-source')!;
  const pending=running.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated held source-only query'}});
  await began;
  const changed=await running.app.inject({method:'PATCH',url:'/api/sources/generated-racing-source/context',headers,payload:{expectedVersion:1,description:'Generated version two'}});
  assert.equal(changed.statusCode,200);finish();
  assert.equal((await pending).statusCode,409);
  const conversations=new Conversations(running.store),history=conversations.list().items;
  assert.ok(history.every(item=>item.status==='failed'));
});

test('working summaries pin source versions, clear stale summaries, and fence late compaction without model requeue',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-source-working-'));
  const running=await buildApp(config(dir));
  t.after(async()=>{await running.app.close();rmSync(dir,{recursive:true,force:true});});
  const {sources,store}=running,contexts=new SourceContextStore(store),conversations=new Conversations(store),working=new WorkingMemory(store,conversations);
  sources.register({id:'generated-working-source',name:'Generated source',kind:'local-files',deviceId:'generated-phone',platform:'android'});
  sources.updateContext('generated-working-source',{expectedVersion:0,description:'Generated first context'});
  const firstPin=contexts.identity('generated-working-source')!;
  const receipt=conversations.append(undefined,{question:'Generated explicit preference'},answer('Generated old reply',[firstPin]));
  let modelCalls=0;
  await working.compact(receipt.conversationId,defaultLifecycleSettings,async input=>{modelCalls++;assert.deepEqual(input.contextSourceContextDependencies,[firstPin]);return answer('Generated pinned summary');},1);
  assert.deepEqual(working.get(conversations.get(receipt.conversationId))!.sourceContextDependencies,[firstPin]);
  sources.updateContext('generated-working-source',{expectedVersion:1,description:'Generated replacement context'});
  assert.equal(modelCalls,1);assert.equal(working.get(conversations.get(receipt.conversationId)),undefined);
  const fresh=working.context(conversations.get(receipt.conversationId),defaultLifecycleSettings);
  assert.equal(fresh.workingMemory,undefined);assert.equal(fresh.turns[0].contextStale,true);
  const secondPin=contexts.identity('generated-working-source')!;
  conversations.append(conversations.get(receipt.conversationId),{question:'Generated new constraint'},answer('Generated current reply',[secondPin]));
  await assert.rejects(working.compact(receipt.conversationId,defaultLifecycleSettings,async()=>{
    modelCalls++;sources.updateContext('generated-working-source',{expectedVersion:2,description:'Generated third context'});return answer('Generated late summary');
  },2),/Source context changed/);
  assert.equal(working.get(conversations.get(receipt.conversationId)),undefined);assert.equal(modelCalls,2);
});
