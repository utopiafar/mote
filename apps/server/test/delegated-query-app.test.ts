import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentYieldError,originalEvidenceReceipt,parseAnswer,type QueryInput} from '@mote/agent';
import {ProviderFailure,type QueryResult} from '@mote/shared';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';

const token='generated-delegation-app-owner',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',agentConcurrency:1,llmConcurrency:1,agentTimeoutMs:30000});
const scope={deviceId:'generated-selected-device',after:'2026-09-20T00:00:00Z',before:'2026-09-21T00:00:00Z',timeZone:'Asia/Shanghai'};
const original={id:'00000000-0000-4000-8000-000000000101',deviceId:scope.deviceId,deviceName:'Generated fixture',platform:'import',source:'note' as const,capturedAt:'2026-09-20T01:00:00Z',durationMs:0,ocrText:'Generated original: the sample project chose a local archive.'};
const plain=(answer='Generated answer'):QueryResult=>({answer,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}});
async function until<T>(read:()=>T|undefined):Promise<T>{for(let attempt=0;attempt<240;attempt++){const value=read();if(value!==undefined)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Generated fixture did not settle');}

for(const restart of [false,true])test(`full app delegation ${restart?'resumes after restart without repeating a successful child':'yields its only slot and saves an answer citing the original receipt'}`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-delegated-query-app-')),id=randomUUID();
 let node:Awaited<ReturnType<typeof buildApp>>,childCalls=0,active=0,maxActive=0,coordinatorCalls=0,heldResume=false,readCalls=0;
 const observed:QueryInput[]=[],order:string[]=[];
 const fixtureAgent=(holdResume:boolean):QueryAgent=>({configured:true,close:async()=>{},query:async input=>{
  active++;maxActive=Math.max(maxActive,active);observed.push(input);
  try{
   if(!input.hostControlChannel){
    childCalls++;order.push('child');assert.equal(input.question,'Inspect the generated original');assert.equal(input.deviceId,scope.deviceId);assert.equal(input.after,scope.after);assert.equal(input.before,scope.before);
    assert.equal(input.conversation,undefined);assert.equal(input.taskContext,undefined);assert.equal(input.openingMemories,undefined);assert.equal(input.directImages,undefined);
    const records=await node.featureServices.archiveReader.evidence({ids:[original.id],deviceId:input.deviceId,after:input.after,before:input.before});assert.equal(records.length,1);
    const receipt=originalEvidenceReceipt(records[0],0,original.ocrText.length);input.onEvidence?.([receipt]);
    return {...parseAnswer(JSON.stringify({answer:`Generated child found the local archive choice [${original.id}]`,citationIds:[original.id]}),new Map([[receipt.id,receipt]])),trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[original.id]}};
   }
   coordinatorCalls++;order.push('coordinator');const controls=input.hostControlChannel,delegation=input.taskContext!.delegation as {revision:number;units:{id:string;status:string;artifactId?:string}[]};
   if(!delegation.units.length){
    const submitted=await controls.execute('delegation_submit',{units:[{id:'original',capabilityId:'context.research',title:'Check the generated original',goal:'Read the scoped source',input:{question:'Inspect the generated original'},scope:{deviceId:scope.deviceId,after:scope.after,before:scope.before}}]});
    assert.equal((submitted.data as {units:unknown[]}).units.length,1);assert.equal(childCalls,0,'submission must immediately return a handle without waiting for the child');
    const yielded=await controls.execute('delegation_yield',{mode:'all',message:'Wait for the generated original check'});assert.equal(yielded.yield,true);throw new AgentYieldError();
   }
   assert.equal(delegation.units[0].status,'succeeded');assert.ok(delegation.units[0].artifactId);
   if(holdResume){heldResume=true;await new Promise<void>(resolve=>input.signal!.addEventListener('abort',()=>resolve(),{once:true}));throw input.signal!.reason;}
   const result=await controls.execute('delegation_read',{artifactId:delegation.units[0].artifactId,evidenceIds:[original.id]});readCalls++;
   assert.equal(result.evidence?.length,1);assert.equal(result.evidence![0].ocrText,original.ocrText);assert.deepEqual(result.evidence![0].textRange,{start:0,end:original.ocrText.length,total:original.ocrText.length,nextOffset:null});
   assert.match((result.data as {text:string}).text,/Generated child found/);
   input.onEvidence?.(result.evidence!);
   return {...parseAnswer(JSON.stringify({answer:`Generated final answer grounded in the original [${original.id}]`,citationIds:[original.id]}),new Map(result.evidence!.map(record=>[record.id,record]))),trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[original.id]}};
  }finally{active--;}
 }});
 node=await buildApp(config(directory),{agent:fixtureAgent(restart),backgroundWorker:false});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.store.ingest(original);
 const accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Research the generated project choice',...scope}}});assert.equal(accepted.statusCode,202,accepted.body);
 if(restart){
  await until(()=>heldResume?true:undefined);assert.equal(childCalls,1);assert.equal(node.featureServices.delegation.artifactMetadata('query:'+id).length,1);
  await node.app.close();node=await buildApp(config(directory),{agent:fixtureAgent(false),backgroundWorker:false});
 }
 const run=await until(()=>{const receipt=node.featureServices.queryRuns.get(id);return receipt.status==='completed'?receipt:undefined;});
 assert.equal(childCalls,1);assert.equal(maxActive,1);assert.equal(readCalls,1);assert.equal(coordinatorCalls,restart?3:2);assert.deepEqual(order.slice(0,3),['coordinator','child','coordinator']);
 const conversation=(await node.app.inject({url:'/api/conversations/'+run.conversationId,headers})).json();assert.equal(conversation.turnCount,1);assert.equal(conversation.turns[0].result.citations[0].id,original.id);assert.equal(conversation.turns[0].result.citations[0].excerpt,original.ocrText);
 const work=node.featureServices.delegation.get('query:'+id);assert.equal(work.status,'succeeded');assert.equal(work.units.length,1);assert.equal(work.units[0].attempts,1);assert.equal(work.events.filter(event=>event.type==='branch.completed').length,1);
 const activity=(await node.app.inject({url:'/api/work-activity/'+encodeURIComponent('query:'+id),headers})).json();assert.equal(activity.state,'completed');assert.equal(activity.branches[0].state,'completed');assert.ok(activity.artifacts.some((artifact:{kind:string})=>artifact.kind==='answer'));assert.ok(activity.events.some((event:{type:string})=>event.type==='branch.completed'));
 assert.equal(observed.filter(input=>!input.hostControlChannel).length,1);
});

test('a retryable provider attempt never writes a failed conversation before the successful answer',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-query-attempt-history-'));let calls=0;
 const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>{calls++;if(calls===1)throw new ProviderFailure({category:'transient',code:'provider_unavailable',retryAfterMs:1});return plain();}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),response=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated retryable question'}}});assert.equal(response.statusCode,202,response.body);
 const receipt=await until(()=>{const run=node.featureServices.queryRuns.get(id);return run.status==='completed'?run:undefined;});assert.equal(calls,2);
 const conversation=(await node.app.inject({url:'/api/conversations/'+receipt.conversationId,headers})).json();assert.equal(conversation.turnCount,1);assert.equal(conversation.status,'completed');assert.equal(node.store.db.prepare('SELECT count(*) n FROM conversation_turns').get()!.n,1);
});

test('durable query metadata omits model-authored progress prose while retaining execution fields',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-query-private-progress-')),secret='Generated private detail in a model progress update';
 const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{input.onProgress?.({stage:'model',message:secret,step:2});input.onProgress?.({stage:'tool',tool:'evidence',phase:'completed',count:1});return plain();}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated progress privacy question'}}});assert.equal(accepted.statusCode,202,accepted.body);
 const run=await until(()=>{const receipt=node.featureServices.queryRuns.get(id);return receipt.status==='completed'?receipt:undefined;});
 const raw=String(node.store.db.prepare('SELECT json FROM query_runs WHERE id=?').get(id)!.json);assert.ok(!raw.includes(secret));assert.ok(run.events.every(event=>event.message===undefined));assert.ok(run.events.some(event=>event.stage==='model'&&event.step===2));assert.ok(run.events.some(event=>event.tool==='evidence'&&event.phase==='completed'&&event.count===1));
});
