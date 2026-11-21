import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test,{type TestContext} from 'node:test';
import {
 ideasIgnoreAllResultSchema,ideasViewSchema,
 type IdeaItem,type NavState,type QueryScope,
} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {AssistantCardPublication} from '../src/assistant-cards.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import type {OwnerQuestionProvider} from '../src/owner-question-contract.js';
import {TaskRecords} from '../src/task-records.js';

const token='generated-ideas-owner',headers={authorization:'Bearer '+token};
const all:QueryScope={kind:'all'};
const scoped=(scope:QueryScope)=>new URLSearchParams({scope:JSON.stringify(scope)});
const ideasUrl=(scope:QueryScope=all)=>'/api/assistant/ideas?'+scoped(scope);
const ignoreAllUrl='/api/assistant/ideas/ignore-all';
const captureAt='2026-11-20T01:00:00Z';
type Original={id:string;text:string};

async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-ideas-'));
 const config:ConfigurationPlatformOptions={
  path:join(directory,'mote.yaml'),privateCredential:{token,tokenPath:'fixture'},
  initialDocument:{version:1,revision:0,storage:{dataDir:directory,maxExportBytes:1_000_000},
   server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},
   models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},
    embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}},
 };
 const node=await buildApp(config,{backgroundWorker:false,agent:{
  configured:false,query:async()=>{throw Error('Unexpected model call');},close:async()=>{},
 }});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const {app,store,featureServices}=node,{assistantCards:cards,ownerQuestions:questions}=featureServices;
 const provider:OwnerQuestionProvider={
  id:'fixture.ideas',version:'1',installationEpoch:'generated',validate:()=>true,
  answer:()=>({kind:'continued',continuationId:'fixture:continued'}),
 };
 questions.register(provider);

 const capture=async(text:string):Promise<Original>=>{
  const id=randomUUID();
  await store.ingest({id,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:captureAt,durationMs:0,ocrText:text});
  return {id,text};
 };
 const publish=(kind:AssistantCardPublication['kind'],original?:Original,override:Partial<AssistantCardPublication>={},expectedRevision?:number)=>
  cards.publish({id:randomUUID(),kind,matterId:null,version:'v1',state:'open',title:'Generated '+kind,body:'Generated card detail',
   evidence:original?[{id:original.id,quote:original.text}]:[],evidenceDependencies:{version:1,complete:true,ids:original?[original.id]:[]},
   ...override},expectedRevision,all,()=>{});
 const question=(original?:Original)=>questions.create(provider,{
  key:randomUUID(),operationId:'fixture:ideas',workId:'fixture:ideas',title:'Generated clarification',
  prompt:'Which generated record should be used?',choices:[],evidence:original?[{id:original.id,quote:original.text}]:[],
  dependencyIds:original?[original.id]:[],
 });
 const read=async(scope:QueryScope=all)=>{
  const response=await app.inject({url:ideasUrl(scope),headers});
  assert.equal(response.statusCode,200,response.body);
  return ideasViewSchema.parse(response.json());
 };
 const nav=async()=>{
  const response=await app.inject({url:'/api/nav-state',headers});
  assert.equal(response.statusCode,200,response.body);
  return {count:response.json<NavState>().badges.ideas,etag:response.headers.etag};
 };
 const ignoreAll=(upToSeq:number)=>app.inject({method:'POST',url:ignoreAllUrl,headers,payload:{upToSeq}});
 const taskInput=async(item:IdeaItem)=>{
  const response=await app.inject({url:'/api/assistant-cards/'+item.id+'?'+scoped(all),headers});
  assert.equal(response.statusCode,200,response.body);
  const card=response.json<ReturnType<typeof cards.get>>();
  assert.equal(card.revision,item.revision);
  assert.ok(card.taskScope);
  return {cardId:item.id,expectedRevision:item.revision,goal:card.title,scope:card.taskScope,requestId:randomUUID()};
 };
 const start=(input:Awaited<ReturnType<typeof taskInput>>)=>app.inject({method:'POST',url:'/api/assistant/tasks',headers,payload:input});
 return {app,store,cards,capture,publish,question,read,nav,ignoreAll,taskInput,start,connections:node.connections};
}

test('ID1-01 suggestions, question cards and clarifications share the list and badge',async t=>{
 const f=await fixture(t),original=await f.capture('Generated scope for suggestions');
 const first=f.publish('suggestion',original),second=f.publish('suggestion',original);
 const question=f.publish('question',original),clarification=f.question(original);
 f.publish('activity',original);
 f.publish('suggestion',original,{state:'resolved'});
 const view=await f.read();
 assert.deepEqual(view.mine.map(item=>item.id),[second.id,first.id]);
 assert.ok(view.mine.every(item=>item.source==='card'&&item.kind==='suggestion'));
 assert.deepEqual(view.mine[0].actions,['start','later','ignore']);
 assert.deepEqual(view.yours.map(item=>[item.id,item.source,item.kind,item.actions]),[
  [question.id,'card','question',['answer','later','ignore']],
  [clarification.id,'owner-question','needs-info',['answer']],
 ]);
 assert.deepEqual(view.started,[]);
 assert.equal(view.watermark,view.yours[0].seq);
 assert.equal((await f.nav()).count,4);
 assert.equal((await f.read()).revision,view.revision);
});

test('ID1-02 starting a suggestion moves it into started with current task progress',async t=>{
 const f=await fixture(t),original=await f.capture('Generated accepted suggestion original');
 const card=f.publish('suggestion',original);
 const before=await f.read();
 assert.equal((await f.nav()).count,1);
 const command=await f.taskInput(before.mine[0]);
 const response=await f.start({...command,goal:'Generated edited task goal'});
 assert.equal(response.statusCode,200,response.body);
 const {taskId}=response.json<{taskId:string}>();
 const current=await f.read(),record=new TaskRecords(f.store).get(taskId);
 assert.deepEqual(current.mine,[]);
 assert.equal(current.started.length,1);
 assert.equal(current.started[0].taskId,taskId);
 assert.equal(current.started[0].title,'Generated edited task goal');
 assert.equal(current.started[0].state,record.state);
 assert.match(current.started[0].progress??'',/0\/1/);
 assert.ok(Date.parse(current.started[0].updatedAt)>=Date.parse(record.updatedAt));
 assert.notEqual(current.revision,before.revision);
 assert.equal(f.cards.get(card.id,all).acceptedTaskId,taskId);
 assert.equal((await f.nav()).count,0);
});

test('ID1-03 a stale watermark keeps new cards and newly published versions',async t=>{
 const f=await fixture(t);
 const edited=f.publish('suggestion'),dismissed=f.publish('question'),clarification=f.question();
 const before=await f.read();
 const fresh=f.publish('suggestion');
 f.publish('suggestion',undefined,{id:edited.id,version:'v2'},edited.revision);
 const response=await f.ignoreAll(before.watermark);
 assert.equal(response.statusCode,200,response.body);
 const result=ideasIgnoreAllResultSchema.parse(response.json()),after=await f.read();
 assert.deepEqual(result,{ignored:1,revision:after.revision});
 assert.deepEqual(after.mine.map(item=>item.id),[edited.id,fresh.id]);
 assert.ok(after.mine.every(item=>item.seq>before.watermark));
 assert.deepEqual(after.yours.map(item=>item.id),[clarification.id]);
 assert.equal(f.cards.get(dismissed.id,all).feedback.at(-1)?.action,'ignore');
 assert.equal((await f.nav()).count,3);
 const retried=await f.ignoreAll(before.watermark);
 assert.equal(retried.statusCode,200,retried.body);
 assert.deepEqual(retried.json(),{ignored:0,revision:after.revision});
});

test('ID1-04 a snoozed card stays out of both views until tomorrow at 09:00',async t=>{
 const f=await fixture(t);
 let now=Date.parse('2026-11-21T08:00:00+08:00');
 t.mock.method(Date,'now',()=>now);
 const until='2026-11-22T09:00:00+08:00',card=f.publish('suggestion');
 const before=await f.nav();
 const response=await f.app.inject({method:'POST',url:'/api/assistant-cards/'+card.id+'/feedback?'+scoped(all),
  headers,payload:{expectedRevision:card.revision,action:'later',until}});
 assert.equal(response.statusCode,200,response.body);
 const hidden=await f.read(),navHidden=await f.nav();
 assert.equal(before.count,1);
 assert.deepEqual(hidden.mine,[]);
 assert.equal(navHidden.count,0);
 now=Date.parse(until)-1;
 assert.equal((await f.read()).revision,hidden.revision);
 assert.equal((await f.nav()).etag,navHidden.etag);
 now++;
 const due=await f.read(),navDue=await f.nav();
 assert.deepEqual(due.mine.map(item=>item.id),[card.id]);
 assert.equal(navDue.count,1);
 assert.notEqual(navDue.etag,navHidden.etag);
 assert.notEqual(due.revision,hidden.revision);
});

test('ID1-05 two tabs starting the same revision admit only one task and batch',async t=>{
 const f=await fixture(t),original=await f.capture('Generated simultaneous start original');
 f.publish('suggestion',original);
 const [idea]=(await f.read()).mine;
 const command=await f.taskInput(idea),inputs=[command,{...command,requestId:randomUUID()}];
 const responses=await Promise.all(inputs.map(f.start));
 assert.deepEqual(responses.map(response=>response.statusCode).sort(),[200,409]);
 const winner=responses.findIndex(response=>response.statusCode===200);
 const {taskId}=responses[winner].json<{taskId:string}>();
 const replay=await f.start(inputs[winner]);
 assert.equal(replay.statusCode,200,replay.body);
 assert.equal(replay.json().taskId,taskId);
 const tasks=f.store.db.prepare("SELECT id FROM task_records WHERE kind='assistant.task'").all();
 assert.deepEqual(tasks.map(row=>row.id),[taskId]);
 assert.equal(f.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='batch.item'").get()?.n,1);
 assert.deepEqual((await f.read()).started.map(item=>item.taskId),[taskId]);
});

test('ID1-06 answering through the chat question route removes the clarification and lowers the badge',async t=>{
 const f=await fixture(t);
 const pending=f.question(),card=f.publish('question');
 const before=await f.read(),navBefore=await f.nav();
 assert.ok(before.yours.some(item=>item.id===pending.id&&item.actions.includes('answer')));
 assert.equal(navBefore.count,2);
 const response=await f.app.inject({method:'POST',url:'/api/owner-questions/'+pending.id+'/reply',headers,
  payload:{requestId:randomUUID(),expectedRevision:pending.revision,action:'answer',answer:'Use the first generated record.'}});
 assert.equal(response.statusCode,200,response.body);
 assert.equal(response.json().state,'answered');
 const after=await f.read();
 assert.deepEqual(after.yours.map(item=>item.id),[card.id]);
 assert.equal((await f.nav()).count,1);
 assert.notEqual(after.revision,before.revision);
 f.publish('question',undefined,{id:card.id,version:'v2',state:'resolved'},card.revision);
 assert.deepEqual((await f.read()).yours,[]);
 assert.equal((await f.nav()).count,0);
});

test('scoped ideas hide other originals and cannot supply a global dismissal watermark',async t=>{
 const f=await fixture(t);
 const selected=await f.capture('Generated selected original'),outside=await f.capture('Generated unselected original');
 const card=f.publish('suggestion',selected),other=f.publish('suggestion',outside);
 const question=f.question(selected),otherQuestion=f.question(outside);
 const ungrounded=f.publish('suggestion');
 assert.deepEqual((await f.read()).mine.find(item=>item.id===ungrounded.id)?.actions,['later','ignore']);
 const scope:QueryScope={kind:'selection',evidenceIds:[selected.id]};
 const filtered=await f.read(scope);
 assert.deepEqual(filtered.mine.map(item=>item.id),[card.id]);
 assert.deepEqual(filtered.yours.map(item=>item.id),[question.id]);
 assert.equal(filtered.watermark,0);
 const ignored=await f.ignoreAll(filtered.watermark);
 assert.equal(ignored.statusCode,200,ignored.body);
 assert.equal(ignored.json().ignored,0);
 assert.equal((await f.nav()).count,5);
 f.store.delete(selected.id);
 const remaining=await f.read();
 assert.deepEqual(remaining.mine.map(item=>item.id),[ungrounded.id,other.id]);
 assert.deepEqual(remaining.yours.map(item=>item.id),[otherQuestion.id]);
 assert.equal((await f.nav()).count,3);
});

test('ideas include pending clarifications beyond the first owner-question page',async t=>{
 const f=await fixture(t);
 const ids=Array.from({length:101},()=>f.question().id);
 const view=await f.read();
 assert.deepEqual(view.yours.map(item=>item.id).sort(),ids.sort());
 assert.equal(view.watermark,0);
 assert.equal((await f.nav()).count,view.yours.length);
});

test('idea routes require owner authorization and a valid scope and watermark',async t=>{
 const f=await fixture(t);
 assert.equal((await f.app.inject({url:ideasUrl()})).statusCode,401);
 assert.equal((await f.app.inject({method:'POST',url:ignoreAllUrl,payload:{upToSeq:0}})).statusCode,401);
 const agent=(await f.connections.mintMcp({serverUrl:'https://generated.invalid',label:'Generated scoped agent',access:'read'},
  {directory:join(tmpdir(),'generated-agent-ideas'),mcpEnabled:true})).config.mcpServers.mote.headers.Authorization;
 assert.equal((await f.app.inject({url:ideasUrl(),headers:{authorization:agent}})).statusCode,403);
 assert.equal((await f.app.inject({method:'POST',url:ignoreAllUrl,headers:{authorization:agent},payload:{upToSeq:0}})).statusCode,403);
 assert.equal((await f.app.inject({url:'/api/assistant/ideas?scope=invalid',headers})).statusCode,400);
 assert.equal((await f.ignoreAll(-1)).statusCode,400);
});

test('bulk ignore rolls back prior card feedback when a later write fails',async t=>{
 const f=await fixture(t),first=f.publish('question'),second=f.publish('suggestion');
 const before=await f.read();
 f.store.db.exec(`CREATE TEMP TRIGGER generated_ignore_failure BEFORE INSERT ON assistant_card_feedback
  WHEN new.card_id='${first.id}' BEGIN SELECT RAISE(ABORT,'Generated feedback write failure'); END`);
 const failed=await f.ignoreAll(before.watermark);
 assert.equal(failed.statusCode,500,failed.body);
 assert.equal((await f.read()).revision,before.revision);
 assert.equal((await f.nav()).count,2);
 assert.deepEqual(f.cards.get(second.id,all).feedback,[]);
 f.store.db.exec('DROP TRIGGER generated_ignore_failure');
 const retried=await f.ignoreAll(before.watermark);
 assert.equal(retried.statusCode,200,retried.body);
 assert.equal(retried.json().ignored,2);
 assert.equal((await f.nav()).count,0);
});
