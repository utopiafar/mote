import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentYieldError,originalEvidenceReceipt,parseAnswer} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ModelAgentFactory} from '../src/model-agent.js';
import {withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {createQueryRunsPlatform,type QueryRunDependencies} from '../src/plugins/query-runs.js';

const token='generated-query-runs-owner',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',agentConcurrency:1,llmConcurrency:1,agentTimeoutMs:30000});
const modelConfig=(dataDir:string):Config=>({...config(dataDir),model:'original-fixture',modelBaseUrl:'https://model.example.invalid/v1',apiKey:'synthetic-original-key',modelProvider:'custom',modelProtocol:'openai-completions',modelReasoningEffort:'auto'});
const plain=(model='Generated answer'):QueryResult=>({answer:model,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}});
const original={id:'00000000-0000-4000-8000-000000000201',deviceId:'generated-query-run-device',deviceName:'Generated fixture',platform:'import',source:'note' as const,capturedAt:'2026-09-20T01:00:00Z',durationMs:0,ocrText:'Generated original: the sample project selected a durable receipt.'};
async function until<T>(read:()=>T|undefined,describe?:()=>unknown):Promise<T>{for(let attempt=0;attempt<240;attempt++){const value=read();if(value!==undefined)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Generated fixture did not settle'+(describe?': '+JSON.stringify(describe()):''));}

test('the query-runs plugin quiesces, stops and reopens the same durable receipts without remounting routes',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-query-runs-plugin-'));
  let node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>plain()}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const first=randomUUID(),accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id:first,input:{question:'Generated durable receipt'}}});
  assert.equal(accepted.statusCode,202,accepted.body);
  const completed=await until(()=>{const run=node.queryRuns.get(first);return run.status==='completed'?run:undefined;});
  assert.equal(completed.id,first);
  // [K] The HTTP producer validates a real request; this plugin consumes it and
  // exposes the saved receipt. A mismatched replay of the same ID is refused.
  const mismatch=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id:first,input:{question:'Generated different question'}}});
  assert.equal(mismatch.statusCode,409,mismatch.body);
  const malformed=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id:randomUUID(),input:{}}});
  assert.equal(malformed.statusCode,400,malformed.body);
  assert.equal((await node.app.inject({url:'/api/query-runs/'+first,headers})).statusCode,200);

  node.queryRunServices.quiesce('disabled');
  const rejected=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id:randomUUID(),input:{question:'Generated refused while quiescing'}}});
  assert.equal(rejected.statusCode,503,rejected.body);
  assert.equal((await node.app.inject({url:'/api/query-runs/'+first,headers})).statusCode,200,'accepted receipts stay readable while quiescing');

  await node.queryRunServices.stop('disabled');
  assert.throws(()=>node.queryRunServices.port.get(first),{statusCode:503});
  assert.equal((await node.app.inject({url:'/api/query-runs/'+first,headers})).statusCode,503,'a stopped activation answers 503 without remounting');

  await node.queryRunServices.start();
  const second=randomUUID(),reopened=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id:second,input:{question:'Generated after re-enable'}}});
  assert.equal(reopened.statusCode,202,reopened.body);
  await until(()=>{const run=node.queryRuns.get(second);return run.status==='completed'?run:undefined;});
  assert.equal(node.queryRuns.get(first).status,'completed','the same activation reads the earlier receipt');
  const list=(await node.app.inject({url:'/api/query-runs',headers})).json() as {items:{id:string;status:string}[]};
  assert.deepEqual(new Set(list.items.map(run=>run.id)),new Set([first,second]));

  await node.app.close();
  node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>plain()}});
  const restarted=(await node.app.inject({url:'/api/query-runs/'+first,headers})).json() as {id:string;status:string};
  assert.equal(restarted.id,first);assert.equal(restarted.status,'completed');
});

test('a prepare failure releases the delegation timer and leaves no transaction or facade behind',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-query-runs-prepare-')),store=new Store(directory),engine=new ExecutionEngine(store);
  const originalSetInterval=globalThis.setInterval,originalClearInterval=globalThis.clearInterval;
  let created=0,cleared=0;const timers=new Set<ReturnType<typeof setInterval>>();
  globalThis.setInterval=((handler:TimerHandler,timeout?:number,...args:unknown[])=>{const handle=originalSetInterval(handler,timeout,...args);timers.add(handle);created++;return handle;}) as typeof setInterval;
  globalThis.clearInterval=((handle:ReturnType<typeof setInterval>)=>{if(timers.delete(handle))cleared++;return originalClearInterval(handle);}) as typeof clearInterval;
  const dependencies={
    store,executor:engine,executionObserver:{hostTick(){}},runtimeSettings:{execution:()=>({agentConcurrency:1,interactiveConcurrency:1})},
    evidenceReader:{},sourceContexts:{},assertModelEvidence(){},files:{},conversations:{},working:{},lifecycleSettings:()=>({}),archiveReader:{},agent:{configured:true},
    modelEvidenceAuthority:{},modelSettings:{select(){throw Error('unused');},view(){throw Error('unused');}},queryAgent:async()=>plain(),usageLedger:{operation(){return {items:[],modelDurationMs:0} as never;}},
  } as unknown as QueryRunDependencies;
  const platform=createQueryRunsPlatform(dependencies),exec=store.db.exec.bind(store.db),failure=new Error('Generated query receipt DDL failure');
  store.db.exec=((sql:string)=>{if(String(sql).includes('CREATE TABLE IF NOT EXISTS query_runs'))throw failure;return exec(sql);}) as typeof store.db.exec;
  try{
    await assert.rejects(platform.prepare(),failure);
    assert.equal(store.db.isTransaction,false,'a failed prepare leaves no open transaction');
    assert.throws(()=>platform.delegation,{statusCode:503});
    assert.throws(()=>platform.queryRuns,{statusCode:503});
    assert.equal(created,cleared,'the partially prepared delegation timer was released');
  }finally{
    store.db.exec=exec;globalThis.setInterval=originalSetInterval;globalThis.clearInterval=originalClearInterval;
    await platform.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});
  }
});

test('an accepted run keeps its original model while later runs use the saved model',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-query-model-pin-')),calls:{model:string;question:string}[]=[];
  let releaseChild!:()=>void;const childHeld=new Promise<void>(resolve=>releaseChild=resolve);
  const agent:ModelAgentFactory=async settings=>({configured:true,close:async()=>{},query:async input=>{
    calls.push({model:settings.model,question:input.question});
    if(input.hostControlChannel&&!input.taskContext?.delegation?.units.length){
      await input.hostControlChannel.execute('delegation_submit',{units:[{id:'original',capabilityId:'context.research',title:'Generated research',goal:'Inspect the generated original',input:{question:'Generated child question'}}]});
      await input.hostControlChannel.execute('delegation_yield',{mode:'all'});throw new AgentYieldError();
    }
    if(!input.hostControlChannel)await childHeld;
    return plain(settings.model);
  }});
  const node=await buildApp(modelConfig(directory),{createModelAgent:agent,backgroundWorker:false});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const runtime=node.delegation,id=randomUUID();
  const accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated pinned run'}}});
  assert.equal(accepted.statusCode,202,accepted.body);
  await until(()=>node.delegation.get('query:'+id).status==='waiting'?true:undefined);
  assert.equal(calls.filter(call=>call.question==='Generated pinned run').at(-1)?.model,'original-fixture');
  // The real AgentRuntimeHost revalidates the captured model connection on every
  // fragment. A model-only switch leaves that connection identity unchanged, so
  // the accepted run resumes under its original model while later runs use the saved one.
  const view=(await node.app.inject({url:'/api/model-settings',headers})).json() as {revision:number;settings:Record<string,unknown>};
  const {apiKeyConfigured:_key,headersConfigured:_headers,extraBodyConfigured:_body,...settings}=view.settings;
  const saved=await node.app.inject({method:'PUT',url:'/api/model-settings',headers,payload:{revision:view.revision,settings:{...settings,model:'next-fixture'}}});
  assert.equal(saved.statusCode,200,saved.body);
  assert.equal(node.modelSettings.select('chat').settings.model,'next-fixture');
  assert.equal(node.queryRunServices.delegation,runtime,'an ordinary model switch does not replace the accepted run runtime');
  releaseChild();
  await until(()=>{const run=node.queryRuns.get(id);return run.status==='completed'?run:undefined;},()=>node.queryRuns.get(id));
  const prepared=(node.delegation.journal.payload<{prepared?:{modelProfileId?:string;modelOverride?:string}}>('query:'+id).prepared);
  assert.equal(prepared?.modelOverride,'original-fixture');
  const resumed=calls.filter(call=>call.question==='Generated pinned run');
  assert.ok(resumed.length>=2);assert.equal(resumed.at(-1)?.model,'original-fixture','the resumed fragment keeps the pinned model');
  const receipt=node.queryRuns.get(id);
  const conversation=(await node.app.inject({url:'/api/conversations/'+receipt.conversationId,headers})).json() as {turns:{result:{configuration:{model:string}}}[]};
  assert.equal(conversation.turns[0]!.result.configuration.model,'original-fixture','the public receipt keeps the pinned model');

  const next=randomUUID(),acceptedNext=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id:next,input:{question:'Generated new run'}}});
  assert.equal(acceptedNext.statusCode,202,acceptedNext.body);
  await until(()=>{const run=node.queryRuns.get(next);return run.status==='completed'?run:undefined;});
  assert.equal(calls.filter(call=>call.question==='Generated new run').at(-1)?.model,'next-fixture','a new run uses the saved model');
  assert.equal(node.queryRuns.get(id).status,'completed');
});

for(const trigger of ['delete','revoke'] as const)test(`a ${trigger} during a delegated run rejects the late commit and records a visible failure receipt`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-query-run-'+trigger+'-'));
  let node:Awaited<ReturnType<typeof buildApp>>,entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const agent:QueryAgent={configured:true,close:async()=>{},query:async input=>{
    if(input.hostControlChannel){
      const units=input.taskContext!.delegation!.units;
      if(!units.length){await input.hostControlChannel.execute('delegation_submit',{units:[{id:'original',capabilityId:'context.research',title:'Generated research',goal:'Inspect the generated original',input:{question:'Generated fenced child'}}]});throw new AgentYieldError();}
      return plain('Generated resumed answer');
    }
    const records=await node.featureServices.archiveReader.evidence({ids:[original.id]});
    const evidence=records.map(record=>originalEvidenceReceipt(record,0,record.ocrText.length));
    input.onEvidence?.(evidence);
    entered();await held;
    return {...parseAnswer(JSON.stringify({answer:`Generated late child [${original.id}]`,citationIds:[original.id]}),new Map(evidence.map(receipt=>[receipt.id,receipt]))),trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[original.id]}};
  }};
  node=await buildApp(config(directory),{backgroundWorker:false,agent});
  t.after(async()=>{release();await node.app.close();rmSync(directory,{recursive:true,force:true});});
  await node.store.ingest(original);
  const id=randomUUID(),pending=withFixtureOwnerModelWork(node,()=>node.queryRuns.perform(id,{question:'Generated fenced question'}));
  await started;
  if(trigger==='delete')node.store.delete(original.id);else node.store.invalidateConversationAnswers([original.id]);
  await assert.rejects(pending);
  const failed=node.queryRuns.get(id);
  assert.equal(failed.status,'failed');
  assert.ok(failed.error?.code,'the failed run keeps a visible error receipt');
  assert.ok(failed.conversationId,'the visible failure receipt keeps the foreground question');
  assert.equal(node.delegation.artifactMetadata('query:'+id).length,0);
  assert.equal(node.delegation.result('query:'+id),undefined);
  const conversation=(await node.app.inject({url:'/api/conversations/'+failed.conversationId,headers})).json() as {turns:{status:string;error?:{code:string};question:string}[]};
  assert.equal(conversation.turns.length,1);
  assert.equal(conversation.turns[0]!.status,'failed');
  assert.equal(conversation.turns[0]!.question,'Generated fenced question');
  assert.ok(conversation.turns[0]!.error?.code);
  release();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(node.delegation.artifactMetadata('query:'+id).length,0,'a late child cannot publish after deletion or revocation');
});

test('an explicit plugin stop cancels accepted runs, aborts the model and fences its late result',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-query-run-stop-'));
  const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{signal=input.signal;entered();await held;return plain('Generated late answer');}}});
  let release!:()=>void,entered!:()=>void,signal:AbortSignal|undefined;
  const held=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
  t.after(async()=>{release();await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const id=randomUUID(),accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated stopped question'}}});
  assert.equal(accepted.statusCode,202,accepted.body);
  await started;
  const stopping=node.queryRunServices.stop('disabled');
  const cancelled=await until(()=>{const run=node.queryRuns.get(id);return run.status==='cancelled'?run:undefined;},()=>node.queryRuns.get(id));
  assert.equal(signal?.aborted,true);
  assert.equal(cancelled.turnId,undefined,'an explicit stop publishes no conversation turn');
  assert.equal(cancelled.execution?.status,'cancelled');
  release();await stopping;
  assert.equal(node.queryRuns.get(id).status,'cancelled','the cancellation receipt stays readable after stop');
  assert.equal(node.delegation.artifactMetadata('query:'+id).length,0);
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM conversation_turns').get()!.n,0);
  assert.throws(()=>node.queryRuns.start(randomUUID(),{question:'Generated closed query'}),{statusCode:503});
});
