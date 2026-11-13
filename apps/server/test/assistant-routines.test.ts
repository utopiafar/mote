import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {TaskRecords} from '../src/task-records.js';
import {hostRun} from './fixtures/host-run.js';

const headers={authorization:'Bearer generated-routine-owner'};
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
async function until(check:()=>boolean){const end=Date.now()+10000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for routine');}
const answer=(input:QueryInput):QueryResult=>({answer:JSON.stringify({answer:'Generated routine review',actions:[]}),citations:[],trace:[],runId:hostRun(input),
 evidenceDependencies:{version:1,complete:true,ids:[...(input.contextEvidenceDependencies?.ids??[])]}});
const processScript=String.raw`
 import {buildApp} from './src/app.ts';
 import {writeFileSync} from 'node:fs';
 import {join} from 'node:path';
 const config={dataDir:process.env.MOTE_TEST_DIRECTORY,dataKey:'64'.repeat(32),contentEncryptionEnabled:true,token:'generated-routine-owner',tokenPath:'fixture-only',host:'127.0.0.1',port:0,
  maxStorageBytes:20000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated-key',
  allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Unexpected model call in admission-only process');},close:async()=>{}}});let clock=Date.parse('2026-11-01T08:00:00Z');node.assistantRoutines.now=()=>clock;
 await node.app.ready();process.send({type:'ready'});
 process.on('message',async message=>{try{
  clock=Date.parse('2026-11-01T09:00:00Z');
  if(message.crash){const start=node.assistantRoutines.startTask;node.assistantRoutines.startTask=ref=>{const task=start(ref);writeFileSync(join(config.dataDir,'generated-crash-marker'),'enqueued');process.kill(process.pid,'SIGKILL');return task;};}
  const result=node.assistantRoutines.admit(message.ref);process.send({type:'result',...result});await node.app.close();process.exit(0);
 }catch(error){process.send({type:'error',message:String(error)});try{await node.app.close();}finally{process.exit(1);}}});`;

async function fixture(t:TestContext,query:(input:QueryInput)=>Promise<QueryResult>=async input=>answer(input),configured=true){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-routine-'));
 const config:Config={dataDir,dataKey:'64'.repeat(32),contentEncryptionEnabled:true,token:'generated-routine-owner',tokenPath:'fixture-only',host:'127.0.0.1',port:0,
  maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated-key',
  allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
 let clock=Date.parse('2026-11-01T08:00:00Z');
 const build=async()=>{
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured,query,close:async()=>{}}});
  (node.assistantRoutines as unknown as {now:()=>number}).now=()=>clock;
  await node.app.ready();return node;
 };
 let node=await build();
 t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 const note=async(deviceId:string)=>{const id=randomUUID(),r=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId,deviceName:'Generated',platform:'android',capturedAt:'2026-10-01T00:00:00Z',text:'Generated routine evidence '+deviceId}});assert.equal(r.statusCode,201,r.body);return id;};
 const create=async(scope:unknown={kind:'all'},extra:Record<string,unknown>={})=>{
  const response=await node.app.inject({method:'POST',url:'/api/assistant/routines',headers,payload:{requestId:randomUUID(),goal:'Review generated evidence',scope,timeZone:'UTC',trigger:{kind:'daily',localTime:'09:00'},...extra}});
  assert.equal(response.statusCode,200,response.body);return response.json();
 };
 const command=(action:'on'|'off'|'stop'|'exclude',excludedSourceIds:string[]=[])=>node.modelAuthorization.command({action,operationId:randomUUID(),revision:node.modelAuthorization.view().revision,...(action==='exclude'?{excludedSourceIds}:{})});
 return {get node(){return node;},dataDir,note,create,command,setClock(value:string){clock=Date.parse(value);},async restart(){await node.app.close();node=await build();}};
}

test('a due rule creates one real A2 task without a new source change and combines missed periods',async t=>{
 const calls:QueryInput[]=[];const f=await fixture(t,async input=>{calls.push(input);return answer(input);});
 const visible=await f.note('generated-allowed'),hidden=await f.note('generated-excluded');
 f.command('on');f.command('exclude',['device:generated-excluded']);
 const rule=await f.create();assert.equal(rule.nextDue,'2026-11-01T09:00:00.000Z');
 f.setClock('2026-11-04T10:00:00Z');
 const due={ruleId:rule.id,revision:rule.revision,scheduledAt:rule.nextDue};
 const first=f.node.assistantRoutines.admit(due),again=f.node.assistantRoutines.admit(due);assert.equal(first.taskId,again.taskId);
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(first.taskId)?.state==='succeeded');
 assert.equal(calls.length,1);assert.ok(calls[0].evidenceIds?.includes(visible));assert.ok(!calls[0].evidenceIds?.includes(hidden));
 assert.match(calls[0].question,/2026-11-01T09:00:00.000Z through 2026-11-04T09:00:00.000Z/);
 assert.equal(f.node.assistantRoutines.get(rule.id).nextDue,'2026-11-05T09:00:00.000Z');
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_routine_occurrences').get()!.n,1);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.task'").get()!.n,1);
 const response=await f.node.app.inject({url:`/api/assistant/tasks/${first.taskId}?`+new URLSearchParams({scope:JSON.stringify({kind:'all'})}),headers});
 assert.equal(response.statusCode,200,response.body);assert.equal(response.json().result.answer,'Generated routine review');
 assert.deepEqual(response.json().coverage,{from:'2026-11-01T09:00:00.000Z',through:'2026-11-04T09:00:00.000Z'});
 await f.restart();assert.equal(f.node.assistantRoutines.get(rule.id).nextDue,'2026-11-05T09:00:00.000Z');
 assert.equal(f.node.assistantRoutines.admit(due).taskId,first.taskId);
});

test('an answered routine keeps automatic source exclusions in its resumed read set',async t=>{
 const calls:QueryInput[]=[];
 const f=await fixture(t,async input=>{calls.push(input);
  if(calls.length===1)return {...answer(input),answer:JSON.stringify({state:'needs_owner_input',question:{prompt:'Generated routine choice',reason:'Generated reason',choices:[{id:'first',label:'Generated first choice',answer:'Generated first choice'}],evidence:[]}})};
  return answer(input);
 });
 const allowed=await f.note('generated-allowed'),hidden=await f.note('generated-excluded');
 f.command('on');f.command('exclude',['device:generated-excluded']);
 const rule=await f.create();f.setClock('2026-11-04T10:00:00Z');
 const task=f.node.assistantRoutines.admit({ruleId:rule.id,revision:rule.revision,scheduledAt:rule.nextDue});
 await until(()=>Boolean(f.node.store.db.prepare("SELECT 1 FROM owner_questions WHERE json_extract(json,'$.state')='open'").get()));
 const operation=String(f.node.store.db.prepare('SELECT operation_id FROM task_records WHERE id=?').get(task.taskId)!.operation_id);
 const response=await f.node.app.inject({url:'/api/owner-questions?operationId='+encodeURIComponent(operation),headers});assert.equal(response.statusCode,200,response.body);
 const question=response.json().items[0];assert.ok(question);
 const reply=await f.node.app.inject({method:'POST',url:'/api/owner-questions/'+question.id+'/reply',headers,payload:{requestId:randomUUID(),expectedRevision:question.revision,action:'answer',choiceId:'first'}});
 assert.equal(reply.statusCode,200,reply.body);
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(task.taskId)?.state==='succeeded');
 assert.equal(calls.length,2);
 assert.ok(calls[0].evidenceIds?.includes(allowed));assert.ok(!calls[0].evidenceIds?.includes(hidden));
 assert.ok(calls[1].evidenceIds?.includes(allowed));assert.ok(!calls[1].evidenceIds?.includes(hidden),'the owner answer must not add an automatically excluded source');
});

test('missed daily occurrences preserve the first DST overlap and resume at the next local time',async t=>{
 const f=await fixture(t);await f.note('generated-dst');f.command('on');f.setClock('2026-11-01T00:00:00Z');
 const rule=await f.create({kind:'all'},{timeZone:'America/New_York',trigger:{kind:'daily',localTime:'01:30'}});
 assert.equal(rule.nextDue,'2026-11-01T05:30:00.000Z');f.setClock('2026-11-04T07:00:00Z');
 const task=f.node.assistantRoutines.admit({ruleId:rule.id,revision:rule.revision,scheduledAt:rule.nextDue});
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(task.taskId)?.state==='succeeded');
 const view=await f.node.app.inject({url:`/api/assistant/tasks/${task.taskId}?`+new URLSearchParams({scope:JSON.stringify({kind:'all'})}),headers});
 assert.deepEqual(view.json().coverage,{from:'2026-11-01T05:30:00.000Z',through:'2026-11-04T06:30:00.000Z'});
 assert.equal(f.node.assistantRoutines.get(rule.id).nextDue,'2026-11-05T06:30:00.000Z');
});

test('two Central processes waking the same due rule commit only one occurrence and one task',async t=>{
 const f=await fixture(t);await f.note('generated-processes');f.command('on');const rule=await f.create();
 await f.node.app.close();
 const cwd=fileURLToPath(new URL('..',import.meta.url));
 const children=[0,1].map(()=>spawn(process.execPath,['--import','tsx','--input-type=module','-e',processScript],{cwd,env:{...process.env,MOTE_TEST_DIRECTORY:f.dataDir},stdio:['ignore','ignore','pipe','ipc']}));
 t.after(()=>{for(const child of children)if(child.exitCode===null)child.kill();});
 const states=children.map(child=>{
  let stderr='';child.stderr!.on('data',chunk=>{stderr+=String(chunk);});
  let ready=false,result:{type:string;taskId?:string;message?:string}|undefined;
  child.on('message',message=>{const value=message as typeof result;if(value?.type==='ready')ready=true;else result=value;});
  return {child,get ready(){return ready;},get result(){return result;},get stderr(){return stderr;}};
 });
 await until(()=>states.every(state=>state.ready||state.child.exitCode!==null));
 for(const state of states)assert.equal(state.ready,true,state.stderr);
 const due={ruleId:rule.id,revision:rule.revision,scheduledAt:rule.nextDue};
 for(const state of states)state.child.send({ref:due});
 await until(()=>states.every(state=>state.result!==undefined||state.child.exitCode!==null));
 for(const state of states)assert.equal(state.result?.type,'result',state.result?.message??state.stderr);
 assert.equal(states[0].result?.taskId,states[1].result?.taskId);
 await until(()=>states.every(state=>state.child.exitCode!==null));
 for(const state of states)assert.equal(state.child.exitCode,0,state.stderr);
 await f.restart();
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_routine_occurrences').get()!.n,1);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.task'").get()!.n,1);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_receipts WHERE identity LIKE 'routine:%'").get()!.n,1);
});

test('a process killed after task enqueue leaves the occurrence due for recovery',async t=>{
 const f=await fixture(t);await f.note('generated-crash');f.command('on');const rule=await f.create();await f.node.app.close();
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',processScript],{
  cwd:fileURLToPath(new URL('..',import.meta.url)),env:{...process.env,MOTE_TEST_DIRECTORY:f.dataDir},stdio:['ignore','ignore','pipe','ipc']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();});
 let ready=false,stderr='';child.stderr!.on('data',chunk=>{stderr+=String(chunk);});
 child.on('message',message=>{const value=message as {type:string};if(value.type==='ready')ready=true;});
 await until(()=>ready||child.exitCode!==null);assert.equal(ready,true,stderr);
 const due={ruleId:rule.id,revision:rule.revision,scheduledAt:rule.nextDue};child.send({ref:due,crash:true});
 await until(()=>child.signalCode!==null||child.exitCode!==null);assert.equal(child.signalCode,'SIGKILL',stderr);assert.equal(existsSync(join(f.dataDir,'generated-crash-marker')),true);
 const db=new DatabaseSync(join(f.dataDir,'mote.sqlite'),{readOnly:true});
 try{
  assert.equal(db.prepare('SELECT next_due FROM assistant_routines WHERE id=?').get(rule.id)!.next_due,rule.nextDue);
  assert.equal(db.prepare('SELECT count(*) n FROM assistant_routine_occurrences').get()!.n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM task_records WHERE kind='assistant.task'").get()!.n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM background_model_receipts WHERE identity LIKE 'routine:%'").get()!.n,0);
 }finally{db.close();}
 f.setClock('2026-11-01T09:00:00Z');await f.restart();
 const recovered=f.node.assistantRoutines.admit(due);
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(recovered.taskId)?.state==='succeeded');
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_routine_occurrences').get()!.n,1);
});

test('a failure after enqueue rolls back receipt, task and due advancement before restart',async t=>{
 const f=await fixture(t);await f.note('generated-rollback');f.command('on');const rule=await f.create();f.setClock('2026-11-01T09:00:00Z');
 const due={ruleId:rule.id,revision:rule.revision,scheduledAt:rule.nextDue},original=f.node.batchProcessing.submit.bind(f.node.batchProcessing);
 const failure=t.mock.method(f.node.batchProcessing,'submit',(...args:Parameters<typeof original>)=>{original(...args);throw Error('Generated crash before commit');});
 assert.throws(()=>f.node.assistantRoutines.admit(due),/Generated crash/);failure.mock.restore();
 assert.equal(f.node.assistantRoutines.get(rule.id).nextDue,rule.nextDue);
 for(const table of ['assistant_routine_occurrences','background_model_work','background_model_trigger_claims','assistant_task_scopes'])assert.equal(f.node.store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0,table);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_receipts WHERE identity LIKE 'routine:%'").get()!.n,0);
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM task_records WHERE kind IN ('assistant.task','batch','batch.item')").get()!.n,0);
 await f.restart();
 // Startup's existing poll may already have admitted the due occurrence.
 const retried=f.node.assistantRoutines.admit(due);
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(retried.taskId)?.state==='succeeded');
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_routine_occurrences').get()!.n,1);
});

test('off, pause and empty selections admit no unauthorized model calls; admitted work drains on off',async t=>{
 const calls:QueryInput[]=[];const f=await fixture(t,async input=>{calls.push(input);return answer(input);});
 await f.note('generated-scope');const rule=await f.create();f.setClock('2026-11-01T09:00:00Z');
 assert.equal(f.node.assistantRoutines.tick(),0);assert.equal(calls.length,0);
 f.command('on');const task=f.node.assistantRoutines.admit({ruleId:rule.id,revision:rule.revision,scheduledAt:rule.nextDue});f.command('off');
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(task.taskId)?.state==='succeeded');assert.equal(calls.length,1);
 f.command('on');const empty=await f.create({kind:'selection',evidenceIds:[]});f.setClock('2026-11-02T09:00:00Z');
 const blocked=f.node.assistantRoutines.admit({ruleId:empty.id,revision:empty.revision,scheduledAt:empty.nextDue});
 assert.equal(f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(blocked.taskId)?.state,'blocked');assert.equal(calls.length,1);
 const paused=await f.node.app.inject({method:'POST',url:`/api/assistant/routines/${rule.id}`,headers,payload:{expectedRevision:rule.revision,enabled:false}});
 assert.equal(paused.statusCode,200,paused.body);assert.throws(()=>f.node.assistantRoutines.admit({ruleId:rule.id,revision:rule.revision,scheduledAt:'2026-11-02T09:00:00.000Z'}));
 const resumed=await f.node.app.inject({method:'POST',url:`/api/assistant/routines/${rule.id}`,headers,payload:{expectedRevision:paused.json().revision,enabled:true}});
 assert.equal(resumed.json().nextDue,'2026-11-03T09:00:00.000Z');
});

test('a paused matter blocks its rule without starving another due rule',async t=>{
 const f=await fixture(t);await f.note('generated-matters');f.command('on');
 const matters=f.node.featureServices.assistantMatters,authority={currentEvidence:()=>[],currentTask:()=>undefined};
 const matter=matters.command({type:'create',requestId:randomUUID(),goal:'Generated matter',scope:{kind:'all'}},authority);
 const pausedRule=await f.create({kind:'all'},{matterId:matter.id});
 const other=await f.create({kind:'all'},{trigger:{kind:'daily',localTime:'09:01'}});
 const paused=matters.command({type:'pause',matterId:matter.id,expectedRevision:matter.revision},authority);
 f.setClock('2026-11-01T09:01:00Z');assert.equal(f.node.assistantRoutines.tick(1),1);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_routine_occurrences WHERE rule_id=?').get(pausedRule.id)!.n,0);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_routine_occurrences WHERE rule_id=?').get(other.id)!.n,1);
 matters.command({type:'resume',matterId:matter.id,expectedRevision:paused.revision},authority);
 assert.equal(f.node.assistantRoutines.tick(1),1);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_routine_occurrences WHERE rule_id=?').get(pausedRule.id)!.n,1);
});

test('before-event work follows the current event version and rejects a cancelled late result',async t=>{
 const entered=gate(),release=gate();t.after(()=>release.release());let calls=0;
 const f=await fixture(t,async input=>{calls++;entered.release();await release.promise;return answer(input);});
 await f.note('generated-calendar-context');
 const source=await f.node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id:'generated-calendar',name:'Generated calendar',kind:'custom',deviceId:'generated-calendar-device',platform:'import',retention:'snapshot'}});
 assert.equal(source.statusCode,200,source.body);
 const event=async(revision:string,start:string,status:'confirmed'|'cancelled'='confirmed')=>{
  const response=await f.node.app.inject({method:'PUT',url:'/api/sources/generated-calendar/items',headers,payload:{externalId:'generated-event',revision,observedAt:`2026-10-0${revision}T00:00:00Z`,
   kind:'calendar',layer:'snapshot',text:'Generated calendar event',calendar:{start,end:'2026-11-01T12:00:00Z',allDay:false,status}}});
  assert.equal(response.statusCode,200,response.body);
 };
 await event('1','2026-11-01T11:00:00Z');f.command('on');
 const extra={trigger:{kind:'before-event',leadMinutes:30},event:{sourceId:'generated-calendar',externalId:'generated-event'}};
 const forbidden=await f.node.app.inject({method:'POST',url:'/api/assistant/routines',headers,payload:{requestId:randomUUID(),goal:'Generated event',scope:{kind:'selection',evidenceIds:[]},timeZone:'UTC',...extra}});
 assert.equal(forbidden.statusCode,409);
 const rule=await f.create({kind:'all'},extra);assert.equal(rule.nextDue,'2026-11-01T10:30:00.000Z');
 // A changed event is discovered before the previously saved later due time.
 f.setClock('2026-11-01T09:00:00Z');await event('2','2026-11-01T10:00:00Z');f.node.assistantRoutines.tick();
 assert.equal(f.node.assistantRoutines.get(rule.id).nextDue,'2026-11-01T09:30:00.000Z');
 assert.throws(()=>f.node.assistantRoutines.admit({ruleId:rule.id,revision:rule.revision,scheduledAt:rule.nextDue}));
 f.setClock('2026-11-01T09:30:00Z');const task=f.node.assistantRoutines.admit({ruleId:rule.id,revision:rule.revision,scheduledAt:'2026-11-01T09:30:00.000Z'});
 await entered.promise;await event('3','2026-11-01T10:00:00Z','cancelled');release.release();
 const step=f.node.store.db.prepare("SELECT id FROM execution_steps WHERE operation_id=? AND kind='batch.item'")
  .get('assistant.task:'+String(f.node.store.db.prepare('SELECT request_id FROM task_records WHERE id=?').get(task.taskId)!.request_id))!;
 await until(()=>!f.node.executor.isActiveStep(String(step.id)));await f.node.executor.tick();
 assert.equal(f.node.store.db.prepare('SELECT result_json FROM task_records WHERE id=?').get(task.taskId)!.result_json,null);
 f.node.assistantRoutines.tick();assert.equal(f.node.assistantRoutines.get(rule.id).nextDue,null);assert.equal(calls,1);
 // A later event revision with the same due instant is still the same occurrence.
 await event('4','2026-11-01T10:00:00Z');f.node.assistantRoutines.tick();
 assert.equal(f.node.assistantRoutines.get(rule.id).nextDue,null);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_routine_occurrences').get()!.n,1);
 // Creation and resume at the already-passed preparation time do not backfill it.
 const late=await f.create({kind:'all'},extra);assert.equal(late.nextDue,null);f.node.assistantRoutines.tick();
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_routine_occurrences WHERE rule_id=?').get(late.id)!.n,0);
 const pausedLate=f.node.assistantRoutines.update({ruleId:late.id,expectedRevision:late.revision,enabled:false});
 const resumedLate=f.node.assistantRoutines.update({ruleId:late.id,expectedRevision:pausedLate.revision,enabled:true});
 assert.equal(resumedLate.nextDue,null);f.node.assistantRoutines.tick();
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_routine_occurrences WHERE rule_id=?').get(late.id)!.n,0);
 f.setClock('2026-11-01T10:30:00Z');await event('5','2026-11-01T10:00:00Z');f.node.assistantRoutines.tick();
 assert.equal(f.node.assistantRoutines.get(rule.id).nextDue,null);assert.equal(calls,1);
});

test('only an owner can configure a rule, and arbitrary or future occurrences cannot mint a receipt',async t=>{
 const f=await fixture(t);f.command('on');const rule=await f.create();
 const unauthenticated=await f.node.app.inject({url:`/api/assistant/routines/${rule.id}`});assert.equal(unauthenticated.statusCode,401);
 const {invitation}=f.node.connections.invite({serverUrl:'https://generated.invalid',label:'Generated collector'},'collector');
 const collector=await f.node.connections.redeem({code:invitation.code,deviceId:'generated-collector',deviceName:'Generated collector',platform:'android'});
 const rejected=await f.node.app.inject({method:'POST',url:'/api/assistant/routines',headers:{authorization:'Bearer '+collector.token},payload:{}});assert.equal(rejected.statusCode,403);
 assert.throws(()=>f.node.assistantRoutines.admit({ruleId:rule.id,revision:rule.revision,scheduledAt:rule.nextDue}));
 assert.throws(()=>f.node.assistantRoutines.admit({ruleId:rule.id,revision:rule.revision,scheduledAt:'2026-11-01T08:00:00.000Z'}));
 f.node.store.db.exec('BEGIN IMMEDIATE');
 try{assert.throws(()=>f.node.modelAuthorization.receiveRoutineOccurrence(rule.id,rule.revision,rule.nextDue));}
 finally{f.node.store.db.exec('ROLLBACK');}
 assert.equal(f.node.store.db.prepare("SELECT count(*) n FROM background_model_receipts WHERE identity LIKE 'routine:%'").get()!.n,0);
});

for(const action of ['edit','pause','exclude','stop'] as const)test(`${action} before a queued routine sends prevents the model call`,async t=>{
 let calls=0;const f=await fixture(t,async input=>{calls++;return answer(input);});
 const id=await f.note('generated-before-send');f.command('on');const rule=await f.create({kind:'selection',evidenceIds:[id]});
 f.setClock('2026-11-01T09:00:00Z');const task=f.node.assistantRoutines.admit({ruleId:rule.id,revision:rule.revision,scheduledAt:rule.nextDue});
 if(action==='edit'||action==='pause')f.node.assistantRoutines.update({ruleId:rule.id,expectedRevision:rule.revision,...(action==='pause'?{enabled:false}:{goal:'Changed generated goal'})});
 else if(action==='exclude')f.command('exclude',['device:generated-before-send']);else f.command('stop');
 await f.node.executor.tick();
 const state=f.node.store.db.prepare('SELECT state,result_json FROM task_records WHERE id=?').get(task.taskId)!;
 assert.notEqual(state.state,'succeeded');assert.equal(state.result_json,null);assert.equal(calls,0);
});

for(const action of ['edit','pause','exclude','stop'] as const)test(`${action} during a model call prevents its late routine result`,async t=>{
 const entered=gate(),release=gate();t.after(()=>release.release());let calls=0,held:QueryInput|undefined;
 const f=await fixture(t,async input=>{calls++;held=input;entered.release();await release.promise;return answer(input);});
 const id=await f.note('generated-protected');f.command('on');const rule=await f.create({kind:'selection',evidenceIds:[id]});f.setClock('2026-11-01T09:00:00Z');
 const task=f.node.assistantRoutines.admit({ruleId:rule.id,revision:rule.revision,scheduledAt:rule.nextDue});await entered.promise;
 if(action==='edit'||action==='pause'){
  const response=await f.node.app.inject({method:'POST',url:`/api/assistant/routines/${rule.id}`,headers,payload:{expectedRevision:rule.revision,...(action==='pause'?{enabled:false}:{goal:'Updated generated review'})}});
  assert.equal(response.statusCode,200,response.body);
 }else if(action==='exclude')f.command('exclude',['device:generated-protected']);else {f.command('stop');assert.equal(held?.signal?.aborted,true);}
 const step=f.node.store.db.prepare("SELECT id FROM execution_steps WHERE operation_id=? AND kind='batch.item'")
  .get('assistant.task:'+String(f.node.store.db.prepare('SELECT request_id FROM task_records WHERE id=?').get(task.taskId)!.request_id))!;
 release.release();await until(()=>!f.node.executor.isActiveStep(String(step.id)));
 await f.node.executor.tick();
 const saved=f.node.store.db.prepare('SELECT state,result_json FROM task_records WHERE id=?').get(task.taskId)!;
 assert.notEqual(saved.state,'succeeded');assert.equal(saved.result_json,null);assert.equal(calls,1);
 if(action==='stop'){await f.restart();f.command('on');assert.notEqual(f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(task.taskId)!.state,'succeeded');}
});

test('scheduled work waits for a configured model without sending its input',async t=>{
 let calls=0;const f=await fixture(t,async input=>{calls++;return answer(input);},false);
 await f.note('generated-budget');f.command('on');const rule=await f.create();f.setClock('2026-11-01T09:00:00Z');
 const result=f.node.assistantRoutines.admit({ruleId:rule.id,revision:rule.revision,scheduledAt:rule.nextDue});
 await until(()=>f.node.store.db.prepare('SELECT state FROM task_records WHERE id=?').get(result.taskId)?.state==='blocked');
 assert.equal(calls,0);assert.equal(new TaskRecords(f.node.store).get(result.taskId).state,'blocked');
});
