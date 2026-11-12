import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {AssistantTaskInput,QueryScope} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {AssistantTaskAcceptance} from '../src/assistant-task-acceptance.js';
import {BatchProcessing} from '../src/batch-processing.js';
import type {MatterAuthority} from '../src/assistant-matters.js';
import {agentModelConnection} from '../src/model-authorization-host.js';
import {SourceContextStore} from '../src/source-context.js';
import {assertSourceContextDependencies} from '../src/source-context-lineage.js';
import {StoreError} from '../src/store.js';
import {TaskRecords} from '../src/task-records.js';

const token='generated-acceptance-owner';
const headers={authorization:`Bearer ${token}`};
const dependencies=(ids:string[])=>({version:1 as const,complete:true as const,ids});
async function until(check:()=>boolean){
 const deadline=Date.now()+10000;
 while(Date.now()<deadline){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}
 throw Error('Timed out waiting for generated task');
}

async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-assistant-acceptance-'));
 const config:Config={dataDir:directory,dataKey:'53'.repeat(32),contentEncryptionEnabled:true,token,tokenPath:'fixture',host:'127.0.0.1',port:0,
  maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
  model:'generated-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated-key',allowUnauthenticatedLocal:false,
  embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 let calls=0;
 const build=()=>buildApp(config,{backgroundWorker:false,agent:{configured:true,query:async()=>{calls++;throw Error('Unexpected model call');},close:async()=>{}}});
 let node=await build();await node.app.ready();
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const current=(ids:readonly string[])=>{if(ids.some(id=>!node.store.isCurrentEvidence(id)))throw new StoreError('Generated evidence unavailable',409);};
 const authority=():MatterAuthority=>({
  currentEvidence:ids=>ids.flatMap(id=>{
   const record=node.store.evidence([id])[0];
   return record&&node.store.isCurrentEvidence(id)?[{id,title:record.windowTitle??'',sourceId:record.provenance?.sourceId,deviceId:record.deviceId,at:record.capturedAt}]:[];
  }),
  currentTask:id=>{try{const task=new TaskRecords(node.store).get(id);return {id:task.id,state:task.state,revision:task.revision,updatedAt:task.updatedAt};}catch{return undefined;}},
 });
 const accept=()=>new AssistantTaskAcceptance(node.store,node.featureServices.assistantCards,node.featureServices.assistantMatters);
 const enqueue=(evidenceIds:string[])=>((task:{operationId:string},request:AssistantTaskInput)=>{
  const profile=node.modelSettings.select('chat');
  node.batchProcessing.submit({operationId:task.operationId,requestId:request.requestId,items:[{question:request.goal,evidenceIds}]},
   {kind:'manual',identities:[],connections:[agentModelConnection({kind:'profile',id:profile.id},profile.settings)]});
 });
 const note=async()=>{
  const id=randomUUID(),response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-device',deviceName:'Generated',platform:'android',capturedAt:'2026-10-01T00:00:00Z',text:'Generated original evidence'}});
  assert.equal(response.statusCode,201,response.body);return id;
 };
 const publish=(id:string,matterId:string|null,evidenceId:string,scope:QueryScope,version='v1',expectedRevision?:number)=>node.featureServices.assistantCards.publish({
  id,kind:'suggestion',matterId,version,state:'open',title:'Generated suggestion',body:'Generated suggestion based on the original',
  evidence:[{id:evidenceId,quote:'Generated original evidence'}],evidenceDependencies:dependencies([evidenceId]),
 },expectedRevision,scope,current);
 return {get node(){return node;},get calls(){return calls;},current,authority,accept,enqueue,note,publish,
  async restart(){await node.app.close();node=await build();await node.app.ready();}};
}

test('accepting a suggestion atomically links its frozen task and matter, including after a lost response and restart',async t=>{
 const f=await fixture(t),id=await f.note(),scope={kind:'selection' as const,evidenceIds:[id]};
 const matter=f.node.featureServices.assistantMatters.command({type:'create',requestId:randomUUID(),goal:'Generated matter',scope,evidenceIds:[id]},f.authority());
 const cardId=randomUUID(),card=f.publish(cardId,matter.id,id,scope);
 const request={requestId:randomUUID(),goal:'Generated owner goal',scope},ref={cardId,expectedRevision:card.revision};
 const task=f.accept().acceptSuggestion(request,ref,f.authority(),f.current,f.enqueue([id]));
 assert.equal(f.node.featureServices.assistantCards.get(cardId,scope).acceptedTaskId,task.id);
 assert.deepEqual(f.node.featureServices.assistantMatters.get(matter.id).taskIds,[task.id]);
 const batch=f.node.store.db.prepare("SELECT id FROM task_records WHERE kind='batch' AND operation_id=?").get(task.operationId)!;
 await until(()=>f.node.batchProcessing.progress(String(batch.id)).items[0]?.state==='blocked');
 assert.equal(f.node.batchProcessing.progress(String(batch.id)).items[0].error,'model_context_budget_unavailable');
 assert.equal(f.calls,0);
 await f.restart();
 const repeated=f.accept().acceptSuggestion(request,ref,f.authority(),f.current,()=>{throw Error('A retry must not enqueue');});
 assert.equal(repeated.id,task.id);
 assert.equal(f.node.store.db.prepare("SELECT count(*) AS n FROM task_records WHERE kind='assistant.task'").get()!.n,1);
 assert.deepEqual(f.node.featureServices.assistantMatters.get(matter.id).taskIds,[task.id]);
 assert.throws(()=>f.accept().acceptSuggestion({...request,goal:'Changed owner goal'},ref,f.authority(),f.current,f.enqueue([id])),{statusCode:409});
 const tasks=new TaskRecords(f.node.store),frozen=tasks.input<{request:AssistantTaskInput}>(task.id,task.revision,f.current);
 assert.deepEqual(frozen.request,request,'the original owner command is immutable');

 const current=f.node.featureServices.assistantCards.get(cardId,scope);
 const updated=f.publish(cardId,matter.id,id,scope,'v2',current.revision);
 assert.equal(tasks.get(task.id).state,'stale');
 assert.equal(f.node.store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(task.id)!.input_json,null);
 const work=f.node.store.db.prepare("SELECT state,input_json,result_json FROM task_records WHERE operation_id=? AND kind IN ('batch','batch.item')").all(task.operationId);
 assert.equal(work.length,2);assert.ok(work.every(row=>row.state==='stale'&&row.input_json===null&&row.result_json===null));
 assert.equal(updated.acceptedTaskId,null);
 assert.throws(()=>f.accept().acceptSuggestion(request,ref,f.authority(),f.current,f.enqueue([id])),{statusCode:409});
 const revised={...request,requestId:randomUUID(),goal:'Generated revised owner goal'};
 const next=f.accept().acceptSuggestion(revised,{cardId,expectedRevision:updated.revision},f.authority(),f.current,f.enqueue([id]));
 assert.notEqual(next.id,task.id);
 const deleted=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+id,headers});assert.equal(deleted.statusCode,200,deleted.body);
 assert.equal(tasks.get(next.id).state,'stale');
 assert.equal(f.node.store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(next.id)!.input_json,null);
});

test('an enqueue failure rolls back the task, real batch, card link and matter edit together',async t=>{
 const f=await fixture(t),id=await f.note(),scope={kind:'selection' as const,evidenceIds:[id]};
 const matter=f.node.featureServices.assistantMatters.command({type:'create',requestId:randomUUID(),goal:'Generated matter',scope,evidenceIds:[id]},f.authority());
 const cardId=randomUUID(),card=f.publish(cardId,matter.id,id,scope),request={requestId:randomUUID(),goal:'Generated owner goal',scope};
 const before=f.node.store.db.prepare('SELECT count(*) AS n FROM execution_steps').get()!.n;
 assert.throws(()=>f.accept().acceptSuggestion(request,{cardId,expectedRevision:card.revision},f.authority(),f.current,(task,input)=>{
  f.enqueue([id])(task,input);throw Error('Generated enqueue failure');
 }),/Generated enqueue failure/);
 assert.equal(f.node.store.db.prepare('SELECT count(*) AS n FROM task_records').get()!.n,0);
 assert.equal(f.node.store.db.prepare('SELECT count(*) AS n FROM execution_steps').get()!.n,before);
 assert.deepEqual(f.node.featureServices.assistantCards.get(cardId,scope),card);
 assert.deepEqual(f.node.featureServices.assistantMatters.get(matter.id),matter);
 assert.throws(()=>f.accept().acceptSuggestion(request,{cardId,expectedRevision:card.revision},f.authority(),f.current,()=>{}),{statusCode:409});
 assert.equal(f.node.store.db.prepare('SELECT count(*) AS n FROM task_records').get()!.n,0,'a no-op adapter cannot create a task');
});

test('acceptance cannot widen a suggestion beyond the current evidence selection',async t=>{
 const f=await fixture(t),id=await f.note(),outside=await f.note(),cardId=randomUUID();
 const card=f.publish(cardId,null,id,{kind:'all'});
 const empty={kind:'selection' as const,evidenceIds:[]};
 assert.throws(()=>f.accept().acceptSuggestion({requestId:randomUUID(),goal:'Generated owner goal',scope:empty},
  {cardId,expectedRevision:card.revision},f.authority(),f.current,f.enqueue([])),{statusCode:404});
 const selection={kind:'selection' as const,evidenceIds:[id]};
 assert.throws(()=>f.accept().acceptSuggestion({requestId:randomUUID(),goal:'Generated owner goal',scope:selection},
  {cardId,expectedRevision:card.revision},f.authority(),f.current,f.enqueue([id,outside])),{statusCode:409},'the execution adapter cannot add another original');
 assert.equal(f.node.store.db.prepare('SELECT count(*) AS n FROM task_records').get()!.n,0);
});

test('an owner correction retires the accepted task and erases its private input',async t=>{
 const f=await fixture(t),id=await f.note(),scope={kind:'selection' as const,evidenceIds:[id]};
 const cardId=randomUUID(),card=f.publish(cardId,null,id,scope),request={requestId:randomUUID(),goal:'Generated private goal',scope};
 const task=f.accept().acceptSuggestion(request,{cardId,expectedRevision:card.revision},f.authority(),f.current,f.enqueue([id]));
 const linked=f.node.featureServices.assistantCards.get(cardId,scope);
 f.node.featureServices.assistantCards.feedback(cardId,{expectedRevision:linked.revision,action:'correct',note:'Generated owner correction'},scope);
 assert.equal(new TaskRecords(f.node.store).get(task.id).state,'stale');
 assert.equal(f.node.store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(task.id)!.input_json,null);
 assert.equal(f.node.featureServices.assistantCards.get(cardId,scope).acceptedTaskId,null);
});

test('a source declaration change retires the accepted task and its batch before disclosure',async t=>{
 const f=await fixture(t),sourceId='generated-acceptance-source';
 f.node.sources.register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});
 f.node.sources.updateContext(sourceId,{expectedVersion:0,description:'Generated source declaration'});
 const original=await f.node.sources.upsert(sourceId,{externalId:'generated-document',revision:'v1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated source evidence'});
 const pin=new SourceContextStore(f.node.store).identity(sourceId)!;
 const scope={kind:'selection' as const,evidenceIds:[original.id]},cardId=randomUUID();
 const card=f.node.featureServices.assistantCards.publish({id:cardId,kind:'suggestion',matterId:null,version:'v1',state:'open',
  title:'Generated suggestion',body:'Generated suggestion',evidence:[{id:original.id,quote:'Generated source evidence'}],
  evidenceDependencies:dependencies([original.id]),sourceContextDependencies:[pin]},undefined,scope,f.current);
 const task=f.accept().acceptSuggestion({requestId:randomUUID(),goal:'Generated owner goal',scope},
  {cardId,expectedRevision:card.revision},f.authority(),f.current,f.enqueue([original.id]));
 f.node.sources.updateContext(sourceId,{expectedVersion:1,description:'Generated revised declaration'});
 const rows=f.node.store.db.prepare('SELECT state,input_json,result_json FROM task_records WHERE operation_id=?').all(task.operationId);
 assert.equal(rows.length,3);assert.ok(rows.every(row=>row.state==='stale'&&row.input_json===null&&row.result_json===null));
 assert.equal(f.calls,0);
});

test('loopback-provider batch results survive restart and a late answer cannot publish after correction',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-acceptance-provider-'));
 let evidenceId='',calls=0,wireEvidence=false,release!:()=>void,entered!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const provider=createServer(async(req,res)=>{
  let body='';for await(const part of req)body+=part;const index=++calls;
  if(index%2===0){wireEvidence=body.includes('GENERATED ACCEPTANCE ORIGINAL');if(index===4){entered();await held;}}
  if(res.destroyed)return;
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=(value:unknown)=>res.write('data: '+JSON.stringify(value)+'\n\n');
  const delta=index%2===1?{role:'assistant',tool_calls:[{index:0,id:'generated-read-'+index,type:'function',function:{name:'evidence',arguments:JSON.stringify({ids:[evidenceId]})}}]}
   :{role:'assistant',content:JSON.stringify({answer:'Generated supported answer',citationIds:[evidenceId]})};
  send({id:'generated-acceptance-'+index,choices:[{index:0,delta,finish_reason:null}]});
  send({id:'generated-acceptance-'+index,choices:[{index:0,delta:{},finish_reason:index%2===1?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}});
  res.end('data: [DONE]\n\n');
 });
 await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
 const config:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,
  retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',
  modelBaseUrl:`http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,modelMaxTokens:512,apiKey:'generated-only',
  allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,logLevel:'silent'};
 let node=await buildApp(config,{backgroundWorker:false});await node.app.ready();await node.batchProcessing.close();
 // The fixture-only adapter permits the controlled small request. Production
 // retains its complete-request budget guard; this is not evidence that it is ready.
 const current=(ids:readonly string[])=>{if(ids.some(id=>!node.store.isCurrentEvidence(id)))throw new StoreError('Generated evidence unavailable',409);};
 const attach=()=>new BatchProcessing(node.store,node.executor,node.modelAuthorization,input=>node.query.queryAgent(input,'query','conversations'),current,
  ids=>node.modelAuthorizationHost.assertEvidence(ids),result=>assertSourceContextDependencies(new SourceContextStore(node.store),result.sourceContextDependencies),()=>undefined);
 let batch=attach();
 t.after(async()=>{release();await batch.close();await node.app.close();provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
 evidenceId=randomUUID();const response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:evidenceId,deviceId:'generated-device',deviceName:'Generated',platform:'android',capturedAt:'2026-10-01T00:00:00Z',text:'GENERATED ACCEPTANCE ORIGINAL'}});
 assert.equal(response.statusCode,201,response.body);
 const scope={kind:'selection' as const,evidenceIds:[evidenceId]};
 const start=()=>{
  const cardId=randomUUID(),cards=node.featureServices.assistantCards;
  const card=cards.publish({id:cardId,kind:'suggestion',matterId:null,version:'v1',state:'open',title:'Generated suggestion',body:'Generated suggestion',
   evidence:[{id:evidenceId,quote:'GENERATED ACCEPTANCE ORIGINAL'}],evidenceDependencies:dependencies([evidenceId])},undefined,scope,current);
  const service=new AssistantTaskAcceptance(node.store,cards,node.featureServices.assistantMatters),request={requestId:randomUUID(),goal:'Generated owner goal',scope};
  const authority:MatterAuthority={currentEvidence:()=>[],currentTask:()=>undefined};
  const task=service.acceptSuggestion(request,{cardId,expectedRevision:card.revision},authority,current,(accepted,input)=>{
   const profile=node.modelSettings.select('chat');
   batch.submit({operationId:accepted.operationId,requestId:input.requestId,items:[{question:input.goal,evidenceIds:[evidenceId]}]},
    {kind:'manual',identities:[],connections:[agentModelConnection({kind:'profile',id:profile.id},profile.settings)]});
  });
  const work=node.store.db.prepare("SELECT id FROM task_records WHERE operation_id=? AND kind='batch'").get(task.operationId)!;
  return {task,cardId,batchId:String(work.id)};
 };
 const first=start();
 await until(()=>batch.progress(first.batchId).task.state==='succeeded');
 assert.equal(wireEvidence,true,'the actual read-only evidence tool delivered the generated original to the provider');
 assert.equal(batch.result(first.batchId)?.answer,'Generated supported answer');
 assert.deepEqual(batch.result(first.batchId)?.citations.map(citation=>citation.id),[evidenceId]);
 await batch.close();await node.app.close();node=await buildApp(config,{backgroundWorker:false});await node.app.ready();await node.batchProcessing.close();batch=attach();
 assert.equal(batch.result(first.batchId)?.answer,'Generated supported answer','the K4 result is still readable after a restart');
 const {task,cardId,batchId}=start();
 await Promise.race([started,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Timed out waiting for loopback provider')),10000);timer.unref();})]);
 assert.equal(wireEvidence,true);
 const cards=node.featureServices.assistantCards;
 const currentCard=cards.get(cardId,scope);
 cards.feedback(cardId,{expectedRevision:currentCard.revision,action:'correct',note:'Generated correction'},scope);
 release();
 const step=batch.progress(batchId).items[0];
 await until(()=>!node.executor.isActiveStep(step.id));
 const records=node.store.db.prepare('SELECT state,input_json,result_json FROM task_records WHERE operation_id=?').all(task.operationId);
 assert.equal(records.length,3);assert.ok(records.every(row=>row.state==='stale'&&row.input_json===null&&row.result_json===null));
 assert.equal(calls,4);
});
