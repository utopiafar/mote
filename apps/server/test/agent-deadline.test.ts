import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getEventListeners} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentTimeoutError,type QueryInput} from '@mote/agent';
import type {QueryResult,UsageReceipt} from '@mote/shared';
import {buildApp} from '../src/app.js';
import {agentDeadline} from '../src/agent-deadline.js';
import type {Config} from '../src/config.js';

async function fixture(t:TestContext,query:(input:QueryInput)=>Promise<QueryResult>){
  const directory=mkdtempSync(join(tmpdir(),'mote-host-deadline-'));
  const config:Config={dataDir:directory,dataKey:undefined,token:'generated-host-deadline-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:true,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,agentTimeoutMs:5000};
  // The real host creates the deadline and usage receipt. The fixture never
  // constructs a provider or makes a network request.
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  return {...node,headers:{authorization:'Bearer '+config.token},receipts:()=>node.store.db.prepare('SELECT json FROM model_usage').all().map(row=>JSON.parse(String(row.json)) as UsageReceipt)};
}

function untilAborted(signal:AbortSignal){
  if(signal.aborted)return Promise.resolve();
  return new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
}
const answer=():QueryResult=>({answer:'Generated answer.',citations:[],trace:[],runId:randomUUID()});

test('host review deadline reaches the Memory pipeline as provider_timeout without a commit',async t=>{
  let calls=0,reviewReason:unknown;
  const f=await fixture(t,async input=>{
    calls++;
    if(input.traceContext?.phase==='review'){
      await untilAborted(input.signal!);reviewReason=input.signal!.reason;
      // A consumer preserving the host reason exercises the same public signal
      // boundary as an outer deadline racing the Agent's own rejection.
      throw reviewReason;
    }
    const id=input.evidenceIds![0];
    return {answer:JSON.stringify({memories:[{title:'Generated experience',statement:`A generated activity was proposed [${id}]`,uncertainty:'Outcome unknown',admission:{layer:'observation',attribution:'user',reason:'Generated source record',scope:'Generated activity'},evidenceIds:[id],evidence:[{id,quote:'Generated activity proposed.'}]}]}),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:'Generated activity proposed.'}],trace:[],runId:randomUUID()};
  });
  const id=randomUUID();await f.store.ingest({id,deviceId:'generated-device',deviceName:'Generated device',platform:'import',capturedAt:'2026-01-01T00:00:00Z',source:'note',ocrText:'Generated activity proposed.',durationMs:0});
  const job=f.memoryPipeline.create({evidenceIds:[id]}),failed=await f.memoryPipeline.run(job.id);
  assert.equal(calls,2);assert.equal(failed.status,'failed');assert.equal(failed.batches[0].phase,'review');
  assert.equal(failed.batches[0].errorCode,'provider_timeout');assert.ok(reviewReason instanceof AgentTimeoutError);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM memories').get()!.n,0);
  const receipts=f.receipts();assert.equal(receipts.length,2);assert.deepEqual(receipts.map(row=>row.status),['completed','failed']);
  assert.equal(receipts[1].tokens,undefined);assert.equal(receipts[1].estimatedCost,null);
});

test('ordinary query host rejects a late successful result with its typed timeout and one failed receipt',async t=>{
  let calls=0,hostReason:unknown;
  const f=await fixture(t,async input=>{
    calls++;await untilAborted(input.signal!);hostReason=input.signal!.reason;
    await new Promise<void>(resolve=>setImmediate(resolve));return answer();
  });
  // Isolate runQuery's own deadline from the HTTP route's earlier RunExecution
  // deadline, whose cancellation reason must remain owned by that executor.
  await assert.rejects(f.featureServices.runQuery({question:'Generated deadline question'}),AgentTimeoutError);
  assert.ok(hostReason instanceof AgentTimeoutError);
  assert.equal(calls,1);const receipts=f.receipts();assert.equal(receipts.length,1);assert.equal(receipts[0].status,'failed');assert.equal(receipts[0].estimatedCost,null);
});

test('HTTP execution timeout still returns 504 and cannot commit a late answer or duplicate a receipt',async t=>{
  let calls=0,settled!:()=>void;const finished=new Promise<void>(resolve=>settled=resolve);
  const f=await fixture(t,async input=>{
    calls++;await untilAborted(input.signal!);
    await new Promise<void>(resolve=>setImmediate(resolve));settled();return answer();
  });
  const response=await f.app.inject({method:'POST',url:'/api/query',headers:f.headers,payload:{question:'Generated HTTP deadline question'}});
  assert.equal(response.statusCode,504);assert.equal(response.json().error,'timeout');
  await finished;await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(calls,1);const receipts=f.receipts();assert.equal(receipts.length,1);assert.equal(receipts[0].status,'failed');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM conversation_turns').get()!.n,0);
  assert.equal(f.featureServices.queryRuns.list()[0].status,'failed');assert.equal(f.featureServices.queryRuns.list()[0].error?.code,'timeout');
});

test('an earlier caller cancellation keeps its exact reason through the real host',async t=>{
  const parent=new AbortController(),reason=new Error('Generated caller cancellation');let observed:AbortSignal|undefined,calls=0;
  // Even a caller-provided error with a timeout-looking name is not reclassified.
  reason.name='TimeoutError';
  const f=await fixture(t,async input=>{
    calls++;observed=input.signal;parent.abort(reason);
    await new Promise<void>(resolve=>setImmediate(resolve));return answer();
  });
  await assert.rejects(f.featureServices.queryAgent({question:'Generated cancellation question',signal:parent.signal}),error=>error===reason);
  assert.equal(observed!.reason,reason);assert.equal(calls,1);
  assert.equal(getEventListeners(parent.signal,'abort').length,0);
  const receipts=f.receipts();assert.equal(receipts.length,1);assert.equal(receipts[0].status,'failed');
});

test('completed host queries detach their caller listener without aborting a successful signal',async t=>{
  const parent=new AbortController();let observed:AbortSignal|undefined;
  const f=await fixture(t,async input=>{observed=input.signal;return answer();});
  await f.featureServices.queryAgent({question:'Generated success question',signal:parent.signal});
  assert.equal(getEventListeners(parent.signal,'abort').length,0);assert.equal(observed!.aborted,false);
  parent.abort(new Error('Generated later cancellation'));assert.equal(observed!.aborted,false);
  const receipts=f.receipts();assert.equal(receipts.length,1);assert.equal(receipts[0].status,'completed');
});

test('host deadline disposal clears timers and listeners on completion or either first abort',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const parent=new AbortController(),deadline=agentDeadline(parent.signal,80);
  assert.equal(getEventListeners(parent.signal,'abort').length,1);
  t.mock.timers.tick(80);assert.ok(deadline.signal!.reason instanceof AgentTimeoutError);
  assert.equal(getEventListeners(parent.signal,'abort').length,0);
  const timeoutReason=deadline.signal!.reason;parent.abort(new Error('Generated late user cancellation'));
  assert.equal(deadline.signal!.reason,timeoutReason);deadline.dispose();

  const cancelled=new AbortController(),firstReason=new Error('Generated user cancellation'),delayed=agentDeadline(cancelled.signal,80);
  cancelled.abort(firstReason);t.mock.timers.tick(120);
  assert.equal(delayed.signal!.reason,firstReason,'later timeout cannot overwrite an earlier user abort, even while a provider is still settling');
  assert.equal(getEventListeners(cancelled.signal,'abort').length,0);delayed.dispose();

  const completed=new AbortController(),disposed=agentDeadline(completed.signal,80);disposed.dispose();disposed.dispose();
  t.mock.timers.tick(120);completed.abort(firstReason);
  assert.equal(disposed.signal!.aborted,false);assert.equal(getEventListeners(completed.signal,'abort').length,0);

  const alreadyCancelled=agentDeadline(cancelled.signal,80);assert.equal(alreadyCancelled.signal!.reason,firstReason);
  const unlimited=agentDeadline(completed.signal,null);assert.equal(unlimited.signal,completed.signal);unlimited.dispose();
});
