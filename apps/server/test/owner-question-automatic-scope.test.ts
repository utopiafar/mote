import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';

async function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-auto-owner-scope-'));
 const config:Config={dataDir:directory,dataKey:'ab'.repeat(32),contentEncryptionEnabled:true,token:'generated-auto-question-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTraceEnabled:false,memoryConcurrency:1,logLevel:'silent'};
 const control:{beforeDeclared?:(input:QueryInput)=>Promise<void>}={};
 const generate=async(input:QueryInput):Promise<QueryResult>=>{
  const members=(input.taskContext?.memoryWork as {members:MemoryWorkMember[]}|undefined)?.members;assert.ok(members,'the generated fixture exercises real extraction and independent review');
  if(members.some(member=>member.attributionContext?.ownerStatements?.length))await control.beforeDeclared?.(input);
  const memories:any[]=[],coverage=members.map(member=>{
   if(member.attributionContext?.ownerStatements?.length){const index=memories.length;memories.push({domain:'personal',title:'Generated uncertainty',statement:`The owner felt uncertain [${member.id}]`,uncertainty:'This generated conversation only.',admission:{layer:'memory',reason:'A generated expressed personally meaningful experience',scope:'This generated conversation only',attribution:'user'},evidenceIds:[member.id],evidence:[{id:member.id,quote:'I felt uncertain.'}]});return {key:member.key,state:'checked',candidateIndexes:[index]};}
   return {key:member.key,state:'needs_owner_input',candidateIndexes:[],question:{prompt:'Which generated speaker corresponds to you?',choices:[{id:'first',label:'First speaker',answer:'The first speaker corresponds to me.'}],evidence:[{id:member.id,quote:'I felt uncertain.'}]}};
  });
  return {runId:'generated-'+randomUUID(),citations:memories.flatMap(memory=>memory.evidenceIds.map((id:string)=>({id,capturedAt:'2026-09-01T00:00:00Z',appName:'Generated',excerpt:''}))),trace:[],answer:JSON.stringify({memories,coverage,capacity:{saturated:false}})};
 };
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:generate},createModelAgent:async()=>({configured:true,close:async()=>{},query:generate})});await node.app.ready();
 const settings=node.lifecycle.settings();for(const id of ['working','consolidation','insights'] as const)settings[id].enabled=false;node.lifecycle.configure(settings);
 const api=(method:'GET'|'POST'|'PUT',url:string,payload?:unknown)=>node.app.inject({method,url,payload,headers:{authorization:'Bearer '+config.token,'x-mote-ingress-version':'2'}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const originals:string[]=[];
 for(const externalId of ['one','two']){
  if(!node.sources.listSources().some(source=>source.id==='generated-auto'))assert.equal((await api('POST','/api/sources',{id:'generated-auto',name:'Generated automatic source',kind:'custom',deviceId:'generated',platform:'import',retention:'archive'})).statusCode,200);
  const result=await api('PUT','/api/sources/generated-auto/items',{externalId,revision:'1',observedAt:'2026-09-01T00:00:00Z',kind:'message',layer:'original',text:'Generated speaker: I felt uncertain.',document:{contentRole:'transcript',recordedAt:'2026-09-01T00:00:00Z',timeBasis:'recorded'}});assert.equal(result.statusCode,200,result.body);originals.push(result.json().id);await node.materialOrganizer.tick();await node.sourcePipelines.tick();
 }
 assert.equal(await node.sourcePipelines.drainMemory(node.memoryPipeline,true),1,'the ordinary automatic scheduler packs both receipt-authorized materials');
 const job=node.memoryPipeline.list().find(value=>value.automaticGrants?.length===2)!;assert.ok(job);assert.equal((await node.memoryPipeline.run(job.id)).status,'waiting_for_input');
 const pending=(await api('GET','/api/owner-questions?operationId='+encodeURIComponent('memory:'+job.id))).json().items;assert.equal(pending.length,2);
 const reply=(question:any)=>api('POST','/api/owner-questions/'+question.id+'/reply',{requestId:randomUUID(),expectedRevision:question.revision,action:'answer',choiceId:'first'});
 return {node,api,job,pending,reply,originals,control};
}

for(const mutation of ['none','explicit-cancel','recipe-revoke','delete-current'] as const)test(`automatic pooled owner questions retain independent scope after another reply: ${mutation}`,{timeout:30000},async t=>{
 const f=await fixture(t),first=f.pending[0],second=f.pending[1];
 const answered=await f.reply(first);assert.equal(answered.statusCode,200,answered.body);const continuation=await f.node.memoryPipeline.run(answered.json().continuationId.slice('memory:'.length));assert.equal(continuation.status,'completed',JSON.stringify(continuation.batches));
 for(const row of f.node.store.db.prepare('SELECT json FROM memory_batches').all())assert.doesNotMatch(String(row.json),/Which generated speaker|I felt uncertain\.|The first speaker corresponds to me\./,'question text, quote, choice and owner declaration stay private');
 const retired=f.node.store.db.prepare("SELECT json FROM memory_batches WHERE job_id=? AND json_extract(json,'$.privateRetired')=1").all(f.job.id);assert.ok(retired.length);for(const row of retired)assert.doesNotMatch(String(row.json),/aes:|ownerStatements|\"question\":/,'updating replacement metadata cannot restore retired private prose');
 // Drain the durable revocation caused by the first material's declaration.
 await f.node.sourcePipelines.drainMemory(f.node.memoryPipeline,false);
 assert.equal(f.node.memoryPipeline.get(f.job.id).cancellationCause,'authority');
 const current=await f.api('GET','/api/owner-questions/'+second.id);assert.equal(current.statusCode,200,current.body);assert.equal(current.json().state,'open','another material changing must not obsolete this current original');
 const cards=(await f.api('GET','/api/work-activity')).json().items.filter((item:any)=>item.kind==='memory');assert.equal(cards.length,1,'the current continuation belongs to its original Activity goal');const card=cards[0];assert.equal(card.progress.total,2);assert.equal(card.progress.needsInput,1);assert.equal(card.progress.completed,1);assert.ok(card.technical.operationIds.includes(answered.json().continuationId));
 const detail=(await f.api('GET','/api/work-activity/'+encodeURIComponent(card.id))).json();assert.deepEqual(detail.progress,card.progress);assert.equal(detail.technical.operationIds.length,2);assert.ok(detail.branches.some((branch:any)=>branch.operationId===answered.json().continuationId));assert.equal(card.artifacts[0].count,1);assert.equal(detail.artifacts[0].count,1,'current reviewed continuation memories remain in their original goal');
 if(mutation==='explicit-cancel')assert.equal((await f.api('POST','/api/memory-jobs/'+f.job.id+'/cancel')).statusCode,200);
 if(mutation==='recipe-revoke')assert.equal((await f.api('PUT','/api/memory-recipe-settings',{sourceId:'generated-auto',recipes:[{id:'mote.daily-event-memory',version:'1'}]})).statusCode,200);
 if(mutation==='delete-current'){
  const dependency=f.node.store.db.prepare('SELECT evidence_id FROM owner_question_dependencies WHERE question_id=?').get(second.id);assert.ok(dependency);f.node.store.delete(String(dependency.evidence_id));
 }
 const result=await f.reply(current.json());assert.equal(result.statusCode,mutation==='none'?200:409,result.body);
 if(mutation==='none')assert.equal(result.json().state,'answered');
 else assert.equal((await f.api('GET','/api/owner-questions/'+second.id)).json().state,'obsolete');
});

test('forgetting an answered original retires both its question and its private declaration',{timeout:30000},async t=>{
 const f=await fixture(t),question=f.pending[0],response=await f.reply(question);assert.equal(response.statusCode,200,response.body);const answered=response.json();await f.node.memoryPipeline.run(answered.continuationId.slice('memory:'.length));
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM material_owner_declarations WHERE id=?').get(question.id)!.n,1);
 const original=f.node.store.db.prepare('SELECT evidence_id FROM owner_question_dependencies WHERE question_id=?').get(question.id);assert.ok(original);f.node.store.delete(String(original.evidence_id));
 const retired=(await f.api('GET','/api/owner-questions/'+question.id)).json();assert.equal(retired.state,'obsolete');assert.equal(retired.messages.length,0);assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM material_owner_declarations WHERE id=?').get(question.id)!.n,0);
 for(const row of f.node.store.db.prepare('SELECT json FROM owner_questions WHERE id=?').all(question.id))assert.doesNotMatch(String(row.json),/aes:|The first speaker corresponds/);
 const remaining=(await f.api('GET','/api/owner-questions/'+f.pending[1].id)).json();assert.equal(remaining.state,'open','forgetting one original preserves the other independent owner question');
});

test('an owner-authorized continuation remains running in its original Activity goal until fresh review finishes',{timeout:30000},async t=>{
 const f=await fixture(t);let release!:()=>void,started!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});f.control.beforeDeclared=()=>{started();return hold;};
 const answer=await f.reply(f.pending[0]);assert.equal(answer.statusCode,200,answer.body);await entered;
 try{
 const cards=(await f.api('GET','/api/work-activity')).json().items.filter((item:any)=>item.kind==='memory');assert.equal(cards.length,1);assert.equal(cards[0].state,'running');assert.ok(cards[0].technical.operationIds.includes(answer.json().continuationId));assert.equal(cards[0].artifacts.length,0);
 const detail=(await f.api('GET','/api/work-activity/'+encodeURIComponent(cards[0].id))).json();assert.equal(detail.state,'running');assert.deepEqual(detail.progress,cards[0].progress);assert.ok(detail.branches.some((branch:any)=>branch.operationId===answer.json().continuationId&&branch.state==='running'));
 }finally{release();}const child=await f.node.memoryPipeline.run(answer.json().continuationId.slice('memory:'.length));assert.equal(child.status,'completed');assert.equal(child.memoryIds.length,1);
});

test('explicit cancellation of a completed unknown evaluation prevents later new information from resuming it',{timeout:30000},async t=>{
 const f=await fixture(t);for(const question of f.pending){const response=await f.api('POST','/api/owner-questions/'+question.id+'/reply',{requestId:randomUUID(),expectedRevision:question.revision,action:'unknown'});assert.equal(response.statusCode,200,response.body);}
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.node.memoryPipeline.get(f.job.id).status,'completed');assert.equal((await f.api('POST','/api/memory-jobs/'+f.job.id+'/cancel')).statusCode,200);
 const closed=(await f.api('GET','/api/owner-questions/'+f.pending[0].id)).json();assert.equal(closed.state,'obsolete');assert.equal((await f.reply(closed)).statusCode,409);
});

for(const cause of ['owner','authority'] as const)test(`${cause} parent cancellation fences a late continuation review according to its independent authority`,{timeout:30000},async t=>{
 const f=await fixture(t);let release!:()=>void,started!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});f.control.beforeDeclared=input=>{if(input.traceContext?.phase==='review'){started();return hold;}return Promise.resolve();};
 const response=await f.reply(f.pending[0]);assert.equal(response.statusCode,200,response.body);const childId=response.json().continuationId.slice('memory:'.length);await entered;
 try{
  // End the unrelated pending evaluation, so stopping the completed parent
  // must still stop its admitted child when the owner explicitly asks.
  const sibling=f.pending[1],closed=await f.api('POST','/api/owner-questions/'+sibling.id+'/reply',{requestId:randomUUID(),expectedRevision:sibling.revision,action:'unknown'});assert.equal(closed.statusCode,200,closed.body);await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(f.node.memoryPipeline.get(f.job.id).status,'completed');
  const child=f.node.memoryPipeline.get(childId),grandchild=f.node.memoryPipeline.create({evidenceIds:child.evidenceIds,recipes:child.recipes,originKey:'generated-grandchild-'+cause});
  // A generated durable descendant fixture checks transitive cancellation;
  // the in-flight child above uses the real owner reply entry point.
  f.node.store.db.prepare("UPDATE memory_jobs SET json=json_set(json,'$.continuationOf',?) WHERE id=?").run(childId,grandchild.id);
  if(cause==='owner')assert.equal((await f.api('POST','/api/memory-jobs/'+f.job.id+'/cancel')).statusCode,200);else f.node.memoryPipeline.cancel(f.job.id,{cause:'authority'});
  assert.equal(f.node.memoryPipeline.get(childId).status,cause==='owner'?'cancelled':'running');assert.equal(f.node.memories.list().length,0,'the blocked independent review has not committed');
  assert.equal(f.node.memoryPipeline.get(grandchild.id).status,cause==='owner'?'cancelled':'queued','explicit cancellation reaches every structural descendant; grant revocation does not');
 }finally{release();}
 const child=await f.node.memoryPipeline.run(childId);assert.equal(child.status,cause==='owner'?'cancelled':'completed');assert.equal(f.node.memories.list().length,cause==='owner'?0:1,'a late review cannot save Memory after explicit parent cancellation');
});
