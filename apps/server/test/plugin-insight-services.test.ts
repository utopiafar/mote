import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {InsightRuns} from '../src/insight-runs.js';
import {Store} from '../src/store.js';
import {createInsightServices,type InsightServicesDependencies} from '../src/plugins/insight-services.js';
import {hostRun} from './fixtures/host-run.js';

const headers={authorization:'Bearer generated-insight-plugin-owner'};
function generatedConfig(dataDir:string,token=headers.authorization.slice(7)):Config{
  return {dataDir,token,tokenPath:join(dataDir,'token'),host:'127.0.0.1',port:0,dataKey:'41'.repeat(32),maxStorageBytes:20_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
}
function profile(t:any){
  const directory=mkdtempSync(join(tmpdir(),'mote-insight-plugin-')),store=new Store(directory),executor=new ExecutionEngine(store),runs=new InsightRuns(store,{executor}),instances=[runs];
  t.after(async()=>{for(const instance of instances)await instance.close();await executor.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,executor,runs,track:(instance:InsightRuns)=>{instances.push(instance);return instance;}};
}
function dependencies(store:Store,runs:InsightRuns,query:InsightServicesDependencies['query']):InsightServicesDependencies{
  return {
    runs,query,
    modelAuthorization:{manual:async(_id,_connections,task)=>task(new AbortController().signal)} as InsightServicesDependencies['modelAuthorization'],
    availableModelConnections:()=>[],
    agent:{configuredFor:()=>true},
    modelSettings:{select:()=>({id:'generated-insight-profile',name:'Generated profile',settings:{}})} as unknown as InsightServicesDependencies['modelSettings'],
    isClosing:()=>false,
    diagnostics:{run:(_id,task)=>task()},
    readHistory:value=>store.insights(value),
    readReport:id=>store.insight(id),
  };
}
async function until<T>(read:()=>T|undefined,label:string):Promise<T>{
  for(let attempt=0;attempt<500;attempt++){const value=read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('Timed out waiting for '+label);
}

test('insight activation fences new runs, cancels accepted work, and serves the same durable profile after re-enable',async t=>{
  const {store,runs}=profile(t);
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const plugin=createInsightServices(dependencies(store,runs,async(_input,_observe,_signal,snapshot)=>{entered();await gate;return {runId:randomUUID(),answer:'Generated held review',citations:[],trace:[],...(snapshot?{snapshot}:{})};}));
  plugin.prepare();plugin.start();
  const app=Fastify();plugin.routes(app);t.after(()=>app.close());
  const id=randomUUID(),launch=await app.inject({method:'POST',url:'/api/insight-runs',payload:{requestId:id}});
  assert.equal(launch.statusCode,202,launch.body);await started;
  plugin.quiesce('disabled');
  const rejected=await app.inject({method:'POST',url:'/api/insight-runs',payload:{requestId:randomUUID()}});
  assert.equal(rejected.statusCode,503,rejected.body);
  assert.equal(runs.get(id).status,'running','accepted work keeps its receipt until stop drains it');
  await plugin.stop('disabled');
  assert.equal(runs.get(id).status,'cancelled');
  assert.throws(()=>runs.start(randomUUID(),{},async()=>({runId:randomUUID(),answer:'Generated blocked review',citations:[],trace:[]})),{statusCode:503},'a disabled activation also fences lifecycle callers');
  release();

  const revived=createInsightServices(dependencies(store,runs,async(_input,_observe,_signal,snapshot)=>({runId:randomUUID(),answer:'Generated re-enabled review',citations:[],trace:[],...(snapshot?{snapshot}:{})})));
  revived.prepare();revived.start();
  const nextApp=Fastify();revived.routes(nextApp);t.after(()=>nextApp.close());
  const nextId=randomUUID(),next=await nextApp.inject({method:'POST',url:'/api/insight-runs',payload:{requestId:nextId}});
  assert.equal(next.statusCode,202,next.body);
  await until(()=>runs.get(nextId).status==='completed'?'completed':undefined,'the re-enabled run');
  assert.equal(store.insights().items.length,1,'the cancelled attempt never publishes a report');
  assert.equal((await nextApp.inject({url:'/api/insight-runs/'+nextId})).json().result.answer,'Generated re-enabled review');
  assert.equal((await nextApp.inject({url:'/api/insights'})).json().items.length,1);
  assert.equal((await app.inject({url:'/api/insight-runs'})).statusCode,503,'the disabled activation stays fenced');
  await revived.close();
});

test('a restarted run manager recovers the same receipt and never publishes a second report',async t=>{
  const {store,executor,runs,track}=profile(t);
  const plugin=createInsightServices(dependencies(store,runs,async(_input,_observe,_signal,snapshot)=>({runId:randomUUID(),answer:'Generated restart review',citations:[],trace:[],...(snapshot?{snapshot}:{})})));
  plugin.prepare();plugin.start();
  const app=Fastify();plugin.routes(app);t.after(()=>app.close());
  const id=randomUUID();
  assert.equal((await app.inject({method:'POST',url:'/api/insight-runs',payload:{requestId:id}})).statusCode,202);
  const completed=await until(()=>runs.get(id).status==='completed'?runs.get(id):undefined,'the first report');
  const receipt={runId:completed.resultRunId,snapshot:completed.snapshot};
  await plugin.close();await runs.close();

  const restarted=track(new InsightRuns(store,{executor}));
  assert.equal(restarted.get(id).status,'completed');
  const replay=restarted.start(id,{},async()=>{throw Error('A completed request must not call the model again');});
  assert.equal(replay.resultRunId,receipt.runId);
  assert.deepEqual(replay.snapshot,receipt.snapshot);
  assert.equal(store.insights().items.length,1);
});

test('the plugin route publishes one real run snapshot into report history',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-insight-plugin-report-'));
  const config=generatedConfig(directory),captureId=randomUUID();let calls=0;
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input,lease)=>{
    lease?.onFinalizer?.('host');
    calls++;const at=new Date().toISOString();
    hostRun(input);
    return {answer:JSON.stringify({title:'Generated report',markdown:`Generated finding [${captureId}]`,html:`<p>Generated finding [${captureId}]</p>`}),citations:[{id:captureId,capturedAt:at,appName:'Generated',excerpt:'Generated original'}],trace:[],runId:randomUUID(),
      usage:{id:randomUUID(),provider:'generated-provider',model:'fixture-model',operation:'insight',createdAt:at,durationMs:1,status:'completed',estimatedCost:0,currency:'USD'}};
  }}});
  t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
  await node.store.ingest({id:captureId,deviceId:'generated-insight-device',deviceName:'Generated device',platform:'macos',source:'note',capturedAt:'2026-11-04T00:00:00.000Z',durationMs:0,ocrText:'Generated original for a report'});
  const id=randomUUID(),payload={requestId:id,prompt:'Generated report request',timeZone:'UTC'};
  assert.equal((await node.app.inject({method:'POST',url:'/api/insight-runs',headers,payload})).statusCode,202);
  const completed=await until(()=>node.insightRuns.get(id).status==='completed'?node.insightRuns.get(id):undefined,'the completed report');
  assert.equal(calls,1);
  const detail=(await node.app.inject({url:'/api/insight-runs/'+id,headers})).json();
  assert.equal(detail.result.runId,completed.resultRunId);assert.equal(detail.result.snapshot.id,id);
  assert.equal(detail.result.snapshot.asOf,completed.snapshot!.asOf);
  assert.equal(detail.result.snapshot.scope.before,completed.snapshot!.scope.before);
  assert.equal(detail.result.snapshot.scope.after,undefined);
  assert.equal(detail.result.citations[0].id,captureId);
  const history=(await node.app.inject({url:'/api/insights?limit=10',headers})).json();
  const saved=history.items.find((item:{runId:string})=>item.runId===completed.resultRunId);
  assert.ok(saved,'the published result is the report history source');
  assert.equal(saved.snapshot.asOf,completed.snapshot!.asOf);
  assert.deepEqual(saved.snapshot.scope,detail.result.snapshot.scope);
  assert.deepEqual(saved.citations,detail.result.citations);
  assert.equal(saved.usage.id,detail.result.usage.id);
  assert.equal(saved.usage.operation,'personal-insight');
  assert.equal((await node.app.inject({url:'/api/insights/'+completed.resultRunId,headers})).json().runId,completed.resultRunId);
  const inventory=(await node.app.inject({url:'/api/features',headers})).json();
  assert.ok(inventory.capabilities.some((item:{featureId:string;id:string})=>item.featureId==='mote.insights'&&item.id==='http:GET:/api/insights'));
  assert.equal((await node.app.inject({method:'POST',url:'/api/insight-runs',headers,payload})).statusCode,202);
  assert.equal(calls,1,'a repeated request reuses the fenced receipt instead of calling the model twice');
  assert.equal(node.store.insights().items.length,1);
});

test('deleting evidence while the report is in flight fences the old report out of history',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-insight-plugin-fence-'));
  const config=generatedConfig(directory),captureId=randomUUID();let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(_input:QueryInput)=>{entered();await gate;return {answer:JSON.stringify({title:'Generated late report',markdown:`Generated late finding [${captureId}]`,html:`<p>Generated late finding [${captureId}]</p>`}),citations:[{id:captureId,capturedAt:new Date().toISOString(),appName:'Generated',excerpt:'Generated original'}],trace:[],runId:randomUUID()};}}});
  t.after(async()=>{release();await node.app.close();await rm(directory,{recursive:true,force:true});});
  await node.store.ingest({id:captureId,deviceId:'generated-insight-device',deviceName:'Generated device',platform:'macos',source:'note',capturedAt:'2026-11-04T00:00:00.000Z',durationMs:0,ocrText:'Generated original that is deleted mid-run'});
  const id=randomUUID(),launch=await node.app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{requestId:id}});
  assert.equal(launch.statusCode,202,launch.body);await started;
  assert.equal(node.store.delete(captureId).deleted,1);
  release();
  const failed=await until(()=>node.insightRuns.get(id).status!=='running'?node.insightRuns.get(id):undefined,'the fenced report');
  assert.equal(failed.status,'failed');
  assert.ok(failed.error);
  assert.equal(node.store.insights().items.length,0,'deleted evidence cannot be revived by a late report');
  assert.equal(node.insightRuns.detail(id).result,undefined);
  const history=(await node.app.inject({url:'/api/insights',headers})).json();
  assert.deepEqual(history,{items:[],nextCursor:null});
});
