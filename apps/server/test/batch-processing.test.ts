import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {ExecutionFailure} from '../src/execution-engine.js';
import {TaskRecords} from '../src/task-records.js';
import {agentModelConnection} from '../src/model-authorization-host.js';
import {BatchProcessing} from '../src/batch-processing.js';
import {hostRun} from './fixtures/host-run.js';
import type {QueryRunLease} from '../src/query-agent.js';
import {SourceContextStore} from '../src/source-context.js';
import {assertSourceContextDependencies} from '../src/source-context-lineage.js';

const headers={authorization:'Bearer generated-batch-owner-token'};
const answer=(input:QueryInput):QueryResult=>({answer:`Generated answer: ${input.question}`,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[...(input.contextEvidenceDependencies?.ids??[])]}});
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
const reached=(signal:Promise<void>)=>Promise.race([signal,new Promise<never>((_,reject)=>{const timeout=setTimeout(()=>reject(Error('Timed out waiting for generated model')),10000);timeout.unref();})]);
async function until(check:()=>boolean){const end=Date.now()+10000;while(Date.now()<end){if(check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out waiting for generated batch state');}
async function fixture(t:TestContext,model:(input:QueryInput,lease?:QueryRunLease)=>Promise<QueryResult>,productionGuard=false){
  const dataDir=mkdtempSync(join(tmpdir(),'mote-batch-'));
  const config:Config={dataDir,dataKey:'43'.repeat(32),contentEncryptionEnabled:true,token:'generated-batch-owner-token',tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelBaseUrl:'https://generated.invalid',apiKey:'generated-key',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  const build=()=>buildApp(config,{backgroundWorker:false,agent:{configured:true,query:model,close:async()=>{}}});
  let node=await build();
  // A generated provider has no external model window. Exercise the actual
  // query adapter and executor under that controlled boundary; the assembled
  // production guard is checked separately below.
  const attach=async()=>{
    if(productionGuard)return node.batchProcessing;
    await node.batchProcessing.close();
    return new BatchProcessing(node.store,node.executor,node.modelAuthorization,input=>node.query.queryAgent(input,'query','conversations'),ids=>{
      if(ids.some(id=>!node.store.isCurrentEvidence(id)))throw Error('Generated evidence is unavailable');
    },ids=>node.modelAuthorizationHost.assertEvidence(ids),result=>assertSourceContextDependencies(new SourceContextStore(node.store),result.sourceContextDependencies),()=>undefined);
  };
  let batch=await attach();await node.app.ready();
  t.after(async()=>{await batch.close();await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
  return {get node(){return node;},get batch(){return batch;},async restart(){await batch.close();await node.app.close();node=await build();batch=await attach();await node.app.ready();},async note(label:string,deviceId='generated-device'){
    const id=randomUUID(),r=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId,deviceName:'Generated',platform:'android',capturedAt:'2026-10-01T00:00:00Z',text:`Generated original ${label}`}});
    assert.equal(r.statusCode,201,r.body);return id;
  },command(action:'on'|'off'|'stop'|'exclude',excludedSourceIds:string[]=[]){const control=node.modelAuthorization;return control.command({action,operationId:randomUUID(),revision:control.view().revision,...(action==='exclude'?{excludedSourceIds}:{})});}};
}
const manual=(node:Awaited<ReturnType<typeof buildApp>>)=>{const profile=node.modelSettings.select('chat');return {kind:'manual' as const,identities:[],connections:[agentModelConnection({kind:'profile',id:profile.id},profile.settings)]};};
const request=(ids:string[],reduce='Summarize generated items')=>({operationId:'workflow:'+randomUUID(),requestId:randomUUID(),items:ids.map((id,index)=>({question:`Generated item ${index+1}`,evidenceIds:[id]})),reduce});

test('completed items survive a real server restart and only the interrupted item is retried',async t=>{
  const calls:string[]=[],times:string[]=[],third=gate(),entered=gate();let block=true;t.after(()=>third.release());
  const f=await fixture(t,async input=>{calls.push(input.question);times.push(input.contextTime!);assert.equal(input.executionLane,'background');
    if(input.question==='Generated item 3'&&block){entered.release();await third.promise;}return answer(input);});
  const ids=[await f.note('one'),await f.note('two'),await f.note('three')],batch=f.batch.submit(request(ids),manual(f.node));
  await reached(entered.promise);
  assert.equal(f.batch.progress(batch.id).completed,2);
  const stored=f.node.store.db.prepare("SELECT input_json,result_json FROM task_records WHERE kind LIKE 'batch%'").all();
  assert.ok(stored.every(row=>String(row.input_json).startsWith('aes:')&&(row.result_json===null||String(row.result_json).startsWith('aes:'))));
  assert.ok(f.batch.progress(batch.id).items.every(step=>!JSON.stringify(step.input).includes('Generated item')));
  const closing=(async()=>{await f.batch.close();await f.node.app.close();})();await until(()=>!f.node.executor.isActiveStep(f.batch.progress(batch.id).items[2].id));
  block=false;third.release();await closing;
  await f.restart();
  await until(()=>f.batch.progress(batch.id).task.state==='succeeded');
  assert.deepEqual(calls.filter(q=>q.startsWith('Generated item')),
    ['Generated item 1','Generated item 2','Generated item 3','Generated item 3']);
  assert.equal(calls.filter(q=>q==='Summarize generated items').length,1);assert.equal(new Set(times).size,1);assert.ok(times[0]);
  assert.equal(f.batch.progress(batch.id).completed,3);
  assert.equal(f.batch.result(batch.id)?.answer,'Generated answer: Summarize generated items');
});

test('a failed reducer retries without repeating successful items, and one item needs no reducer',async t=>{
  const calls:string[]=[];let fail=true;
  const f=await fixture(t,async input=>{calls.push(input.question);if(input.question==='Summarize generated items'&&fail){fail=false;throw new ExecutionFailure('permanent','generated_reduce_failed');}return answer(input);});
  const ids=[await f.note('one'),await f.note('two'),await f.note('three')],batch=f.batch.submit(request(ids),manual(f.node));
  await until(()=>f.batch.progress(batch.id).reduce?.state==='failed');
  assert.equal(f.batch.progress(batch.id).completed,3);
  await f.restart();assert.equal(f.batch.progress(batch.id).completed,3);
  f.batch.retry(batch.id);
  await until(()=>f.batch.progress(batch.id).task.state==='succeeded');
  assert.deepEqual(calls,['Generated item 1','Generated item 2','Generated item 3','Summarize generated items','Summarize generated items']);
  const single={operationId:'workflow:'+randomUUID(),requestId:randomUUID(),items:[{question:'Generated single query',evidenceIds:[ids[0]]}]};
  const one=f.batch.submit(single,manual(f.node));await until(()=>f.batch.progress(one.id).task.state==='succeeded');
  assert.equal(f.batch.result(one.id)?.answer,'Generated answer: Generated single query');
  assert.equal(f.batch.progress(one.id).reduce,undefined);
  assert.equal(f.batch.submit(single,manual).id,one.id);
  await new Promise(resolve=>setTimeout(resolve,25));assert.equal(calls.filter(q=>q==='Generated single query').length,1);
});

test('cancel before start or during a model call prevents all late item and reduce publication',async t=>{
  const started=gate(),release=gate(),calls:string[]=[];let inFlight:QueryInput|undefined;t.after(()=>release.release());
  const f=await fixture(t,async input=>{calls.push(input.question);inFlight=input;started.release();await release.promise;return answer(input);});
  const id=await f.note('one'),queued=f.batch.submit(request([id]),manual(f.node));
  f.batch.cancel(queued.id);await new Promise(resolve=>setTimeout(resolve,25));assert.deepEqual(calls,[]);
  const running=f.batch.submit(request([id]),manual(f.node));await reached(started.promise);
  f.batch.cancel(running.id);assert.equal(inFlight!.signal!.aborted,true);release.release();
  await until(()=>f.batch.progress(running.id).items.every(step=>step.state==='cancelled'));
  assert.equal(f.batch.progress(running.id).task.state,'cancelled');
  assert.equal(f.batch.progress(running.id).reduce?.state,'cancelled');
  assert.equal(f.node.store.db.prepare('SELECT result_json FROM task_records WHERE id=?').get(running.id)!.result_json,null);
  assert.deepEqual(calls,['Generated item 1']);
});

test('off drains already admitted automatic steps but admits no new work or empty selections',async t=>{
  const calls:string[]=[];const f=await fixture(t,async input=>{calls.push(input.question);return answer(input);});
  const ids=[await f.note('one'),await f.note('two'),await f.note('three'),await f.note('new')];f.command('on');
  const roots=ids.slice(0,3).map(id=>'capture:'+id),batch=f.batch.submit(request(ids.slice(0,3)),{kind:'automatic',purpose:'working',roots});
  f.command('off');
  assert.throws(()=>f.batch.submit(request([ids[3]]),{kind:'automatic',purpose:'working',roots:['capture:'+ids[3]]}));
  await until(()=>f.batch.progress(batch.id).task.state==='succeeded');
  assert.deepEqual(calls,['Generated item 1','Generated item 2','Generated item 3','Summarize generated items']);
  f.command('on');
  assert.throws(()=>f.batch.submit({operationId:'workflow:'+randomUUID(),requestId:randomUUID(),items:[{question:'No permitted evidence',evidenceIds:[]}]},{kind:'automatic',purpose:'working',roots:['capture:'+ids[3]]}));
  assert.equal(calls.length,4);
  assert.throws(()=>f.batch.submit(request([ids[0]]),{kind:'automatic',purpose:'working',roots:['capture:'+ids[0]]}));
});

test('stop cancels queued and in-flight automatic batches, including a late response after restart',async t=>{
  const entered=gate(),release=gate(),calls:string[]=[];let held:QueryInput|undefined;t.after(()=>release.release());
  const f=await fixture(t,async input=>{calls.push(input.question);held=input;entered.release();await release.promise;return answer(input);});
  const ids=[await f.note('one'),await f.note('two')];f.command('on');
  const running=f.batch.submit(request([ids[0]]),{kind:'automatic',purpose:'working',roots:['capture:'+ids[0]]});await reached(entered.promise);
  const queued=f.batch.submit(request([ids[1]]),{kind:'automatic',purpose:'working',roots:['capture:'+ids[1]]});
  f.command('stop');assert.equal(held!.signal!.aborted,true);release.release();
  assert.equal(f.batch.progress(running.id).task.state,'cancelled');assert.equal(f.batch.progress(queued.id).task.state,'cancelled');
  await f.restart();f.command('on');await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal(f.batch.progress(running.id).task.state,'cancelled');assert.equal(f.batch.progress(queued.id).task.state,'cancelled');
  assert.equal(f.node.store.db.prepare('SELECT result_json FROM task_records WHERE id=?').get(running.id)!.result_json,null);
  assert.deepEqual(calls,['Generated item 1']);
});

test('retiring one original erases its checkpoint and prevents the aggregate or a late result',async t=>{
  const entered=gate(),release=gate();let calls=0;t.after(()=>release.release());
  const f=await fixture(t,async input=>{calls++;if(input.question==='Generated item 2'){entered.release();await release.promise;}return answer(input);});
  const ids=[await f.note('one'),await f.note('two')],batch=f.batch.submit(request(ids),manual(f.node));await reached(entered.promise);
  assert.equal(f.batch.progress(batch.id).completed,1);
  const childId=String(f.batch.progress(batch.id).items[0].input.itemId);
  f.node.store.delete(ids[0]);release.release();
  await until(()=>f.batch.progress(batch.id).task.state==='stale'&&!f.node.executor.isActiveStep(f.batch.progress(batch.id).items[1].id));
  const tasks=new TaskRecords(f.node.store);assert.equal(tasks.get(childId).state,'stale');
  const child=f.node.store.db.prepare('SELECT input_json,result_json FROM task_records WHERE id=?').get(childId)!;assert.equal(child.input_json,null);assert.equal(child.result_json,null);
  assert.equal(f.node.store.db.prepare('SELECT result_json FROM task_records WHERE id=?').get(batch.id)!.result_json,null);
  assert.equal(calls,2);
});


test('stopping during reduce rejects its late output after completed item checkpoints',async t=>{
  const entered=gate(),release=gate(),calls:string[]=[];let reducer:QueryInput|undefined;t.after(()=>release.release());
  const f=await fixture(t,async input=>{calls.push(input.question);if(input.question==='Summarize generated items'){reducer=input;entered.release();await release.promise;}return answer(input);});
  const id=await f.note('one');f.command('on');
  const batch=f.batch.submit(request([id]),{kind:'automatic',purpose:'working',roots:['capture:'+id]});
  await reached(entered.promise);assert.equal(f.batch.progress(batch.id).completed,1);
  f.command('stop');assert.equal(reducer!.signal!.aborted,true);release.release();
  await until(()=>!f.node.executor.isActiveStep(f.batch.progress(batch.id).reduce!.id));
  assert.equal(f.batch.progress(batch.id).task.state,'cancelled');
  assert.equal(f.batch.progress(batch.id).reduce?.state,'cancelled');
  assert.equal(f.node.store.db.prepare('SELECT result_json FROM task_records WHERE id=?').get(batch.id)!.result_json,null);
  assert.deepEqual(calls,['Generated item 1','Summarize generated items']);
});

test('excluding contextual evidence during a call prevents publication even when another root admitted it',async t=>{
  const entered=gate(),release=gate(),calls:string[]=[];t.after(()=>release.release());
  const f=await fixture(t,async input=>{calls.push(input.question);entered.release();await release.promise;return answer(input);});
  const root=await f.note('root','generated-root'),context=await f.note('context','generated-context');f.command('on');
  const batch=f.batch.submit({operationId:'workflow:'+randomUUID(),requestId:randomUUID(),items:[{question:'Generated contextual query',evidenceIds:[context]}]},
    {kind:'automatic',purpose:'working',roots:['capture:'+root]});
  await reached(entered.promise);f.command('exclude',['device:generated-context']);release.release();
  await until(()=>!f.node.executor.isActiveStep(f.batch.progress(batch.id).items[0].id));
  assert.notEqual(f.batch.progress(batch.id).items[0].state,'succeeded');
  assert.equal(f.node.store.db.prepare('SELECT result_json FROM task_records WHERE id=?').get(batch.id)!.result_json,null);
  assert.deepEqual(calls,['Generated contextual query']);
});

test('a waiting background batch leaves the interactive query lane available',async t=>{
  const entered=gate(),release=gate(),calls:string[]=[];t.after(()=>release.release());
  const f=await fixture(t,async input=>{calls.push(input.question);if(input.question==='Generated item 1'){entered.release();await release.promise;}return answer(input);});
  const ids=[await f.note('one'),await f.note('two'),await f.note('three')];
  const batch=f.batch.submit(request(ids),manual(f.node));await reached(entered.promise);
  const response=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated interactive question'}});
  assert.equal(response.statusCode,200,response.body);assert.ok(calls.includes('Generated interactive question'));
  assert.equal(f.batch.progress(batch.id).completed,0);release.release();
  await until(()=>f.batch.progress(batch.id).task.state==='succeeded');
});


test('assembled batches wait for a verified complete-request budget before any model call',async t=>{
  let calls=0;const f=await fixture(t,async input=>{calls++;return answer(input);},true);
  const id=await f.note('budget'),batch=f.batch.submit({operationId:'workflow:'+randomUUID(),requestId:randomUUID(),items:[{question:'Generated guarded query',evidenceIds:[id]}]},manual(f.node));
  await until(()=>f.batch.progress(batch.id).items[0].state==='blocked');
  assert.equal(f.batch.progress(batch.id).items[0].error,'model_context_budget_unavailable');assert.equal(f.batch.progress(batch.id).items[0].attempts,0);
  assert.equal(calls,0);assert.equal(f.node.store.db.prepare('SELECT result_json FROM task_records WHERE id=?').get(batch.id)!.result_json,null);
});


test('item and reduce calls retain the existing query usage receipts',async t=>{
  const f=await fixture(t,async(input,lease)=>{
    lease?.onFinalizer?.('host');const runId=hostRun(input,{usage:{requests:1,reportedRequests:1,inputTokens:12,outputTokens:4,totalTokens:16,cacheReadTokens:0,cacheWriteTokens:0}});
    return {...answer(input),runId};
  });
  const id=await f.note('usage'),input=request([id]),batch=f.batch.submit(input,manual(f.node));
  await until(()=>f.batch.progress(batch.id).task.state==='succeeded');
  const receipts=(f.node.store.db.prepare("SELECT json FROM model_usage WHERE json_extract(json,'$.attribution.operationId')=?").all(input.operationId) as {json:string}[]).map(row=>JSON.parse(row.json));
  assert.equal(receipts.length,2);assert.ok(receipts.every(receipt=>receipt.status==='completed'&&receipt.tokens.inputTokens===12&&receipt.tokens.outputTokens===4));
  assert.equal(f.batch.result(batch.id)?.usage?.status,'completed');
});


test('an admitted automatic batch resumes after restart while the owner switch remains off',async t=>{
  const entered=gate(),release=gate(),calls:string[]=[];let block=true;t.after(()=>release.release());
  const f=await fixture(t,async input=>{calls.push(input.question);if(block){entered.release();await release.promise;}return answer(input);});
  const id=await f.note('off-restart');f.command('on');
  const batch=f.batch.submit({operationId:'workflow:'+randomUUID(),requestId:randomUUID(),items:[{question:'Generated admitted work',evidenceIds:[id]}]},
    {kind:'automatic',purpose:'working',roots:['capture:'+id]});
  await reached(entered.promise);f.command('off');
  const closing=(async()=>{await f.batch.close();await f.node.app.close();})();
  await until(()=>!f.node.executor.isActiveStep(f.batch.progress(batch.id).items[0].id));
  block=false;release.release();await closing;await f.restart();
  await until(()=>f.batch.progress(batch.id).task.state==='succeeded');
  assert.equal(f.node.modelAuthorization.view().state,'off');assert.deepEqual(calls,['Generated admitted work','Generated admitted work']);
});


test('a source context revision during reduce invalidates earlier item context before publication',async t=>{
  const entered=gate(),release=gate();let pin:ReturnType<SourceContextStore['identity']>;t.after(()=>release.release());
  const f=await fixture(t,async input=>{
    if(input.question==='Summarize generated items'){assert.deepEqual(input.contextSourceContextDependencies,[pin]);entered.release();await release.promise;return answer(input);}
    return {...answer(input),sourceContextDependencies:[pin!]};
  });
  f.node.sources.register({id:'generated-context-source',name:'Generated source',kind:'local-files',deviceId:'generated-device',platform:'import'});
  f.node.sources.updateContext('generated-context-source',{expectedVersion:0,description:'Generated original declaration'});
  pin=new SourceContextStore(f.node.store).identity('generated-context-source')!;
  const id=await f.note('source-context'),batch=f.batch.submit(request([id]),manual(f.node));
  await reached(entered.promise);
  f.node.sources.updateContext('generated-context-source',{expectedVersion:1,description:'Generated revised declaration'});release.release();
  await until(()=>!f.node.executor.isActiveStep(f.batch.progress(batch.id).reduce!.id));
  assert.notEqual(f.batch.progress(batch.id).reduce!.state,'succeeded');
  assert.equal(f.node.store.db.prepare('SELECT result_json FROM task_records WHERE id=?').get(batch.id)!.result_json,null);
});


test('a rejected outer cancellation cannot abort work that the transaction rolls back',async t=>{
  const entered=gate(),release=gate();let held:QueryInput|undefined;t.after(()=>release.release());
  const f=await fixture(t,async input=>{held=input;entered.release();await release.promise;return answer(input);});
  const id=await f.note('transaction'),batch=f.batch.submit({operationId:'workflow:'+randomUUID(),requestId:randomUUID(),items:[{question:'Generated transactional cancellation',evidenceIds:[id]}]},manual(f.node));
  await reached(entered.promise);f.node.store.db.exec('BEGIN IMMEDIATE');
  try{assert.throws(()=>f.batch.cancel(batch.id),{statusCode:409});}finally{f.node.store.db.exec('ROLLBACK');}
  assert.equal(held!.signal!.aborted,false);release.release();
  await until(()=>f.batch.progress(batch.id).task.state==='succeeded');
});

test('an owner request with an empty selection can answer without opening archive retrieval',async t=>{
  let observed:QueryInput|undefined;const f=await fixture(t,async input=>{observed=input;return answer(input);});
  await f.note('must-remain-outside-selection');
  const batch=f.batch.submit({operationId:'workflow:'+randomUUID(),requestId:randomUUID(),items:[{question:'Generated owner-only question',evidenceIds:[]}]},manual(f.node));
  await until(()=>f.batch.progress(batch.id).task.state==='succeeded');
  assert.deepEqual(observed!.evidenceIds,[]);assert.equal(observed!.hostRetrieval,'none');
  assert.deepEqual(observed!.contextEvidenceDependencies,{version:1,complete:true,ids:[]});
  assert.equal(f.batch.result(batch.id)?.answer,'Generated answer: Generated owner-only question');
});
