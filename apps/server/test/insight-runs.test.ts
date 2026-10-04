import {readAgentCredential} from './login-fixture.js';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentProviderError,type QueryInput} from '@mote/agent';
import {buildApp,type QueryAgent} from '../src/app.js';
import {InsightRuns} from '../src/insight-runs.js';
import type {Config} from '../src/config.js';
const headers={authorization:'Bearer generated-insight-runs-owner-token'};
async function fixture(t:TestContext,agent:QueryAgent){
  const dir=await mkdtemp(join(tmpdir(),'mote-insight-runs-'));
  const config:Config={dataDir:dir,token:headers.authorization.slice(7),tokenPath:join(dir,'token'),host:'127.0.0.1',port:0,dataKey:'31'.repeat(32),maxStorageBytes:20_000_000,maxExportBytes:10_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  const value=await buildApp(config,{agent});t.after(async()=>{await agent.close();await value.app.close();await rm(dir,{recursive:true,force:true});});return value;
}
test('review launch acknowledges immediately, survives reconnect, reports real tools, and is idempotent',async t=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let calls=0;
  const result={answer:JSON.stringify({title:'Generated report',markdown:'Generated report',html:'<p>Generated report</p>'}),citations:[],trace:[],runId:randomUUID()};
  const {app,insightRuns,store}=await fixture(t,{configured:true,query:async(input:QueryInput)=>{calls++;input.onProgress?.({stage:'tool',tool:'timeline',count:4,...{arguments:{secret:'never-store'},reasoning:'never-store'}});await gate;return result;},close:async()=>release()});
  const payload={requestId:randomUUID(),prompt:'Synthetic report request',timeZone:'Asia/Shanghai'};
  const response=await app.inject({method:'POST',url:'/api/insight-runs',headers,payload});assert.equal(response.statusCode,202,response.body);assert.equal(response.json().status,'running');
  const detail=await app.inject({url:'/api/insight-runs/'+payload.requestId,headers});assert.equal(detail.json().events.at(-1).tool,'timeline');assert.equal(detail.json().events.at(-1).count,4);assert.ok(!detail.body.includes('never-store'));
  assert.equal((await app.inject({method:'POST',url:'/api/insight-runs',headers,payload})).statusCode,202);assert.equal(calls,1);
  assert.equal((await app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{...payload,prompt:'changed'}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{...payload,requestId:randomUUID()}})).statusCode,429);
  assert.equal((await app.inject({url:'/api/insight-runs',headers})).json().items[0].id,payload.requestId);
  release();await insightRuns.close();
  const completed=(await app.inject({url:'/api/insight-runs/'+payload.requestId,headers})).json();assert.equal(completed.status,'completed');assert.equal(completed.result.answer,'Generated report');assert.equal(completed.result.artifact.title,'Generated report');
  const lateCancel=await app.inject({method:'POST',url:`/api/insight-runs/${payload.requestId}/cancel`,headers});assert.equal(lateCancel.json().status,'completed');assert.equal(lateCancel.json().result.answer,'Generated report');
  store.db.exec('DELETE FROM insights');assert.equal(insightRuns.detail(payload.requestId).result,undefined,'deleted reports are never revived by job polling');
});
test('a review publishes when another original arrives during model generation',async t=>{
  let entered!:()=>void,release!:()=>void;
  const running=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
  const {app,insightRuns,store}=await fixture(t,{configured:true,query:async()=>{entered();await gate;return {answer:JSON.stringify({title:'Generated report',markdown:'Generated report',html:'<p>Generated report</p>'}),citations:[],trace:[],runId:randomUUID()};},close:async()=>release()});
  const id=randomUUID(),response=await app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{requestId:id}});
  assert.equal(response.statusCode,202);await running;
  await store.ingest({id:randomUUID(),deviceId:'generated-device',deviceName:'Generated device',platform:'macos',source:'activity',appId:'fixture.app',appName:'Generated activity',capturedAt:new Date(Date.now()-60000).toISOString(),durationMs:30000,privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}});
  release();await insightRuns.close();
  assert.equal(insightRuns.get(id).status,'completed');
  assert.equal(store.insights().length,1);
});
test('failures and interrupted runs are visible without provider secrets; run endpoints require ownership',async t=>{
  const {app,store,insightRuns}=await fixture(t,{configured:true,query:async()=>{throw new AgentProviderError();},close:async()=>{}});
  assert.equal((await app.inject('/api/insight-runs')).statusCode,401);
  const id=randomUUID();await app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{requestId:id}});await insightRuns.close();
  assert.equal(insightRuns.get(id).status,'failed');assert.equal(insightRuns.get(id).error?.code,'agent_response');
  store.db.prepare("UPDATE insight_runs SET json=json_set(json,'$.status','running') WHERE id=?").run(id);
  store.db.prepare("UPDATE execution_steps SET state='running',lease_until=0,fence=NULL,error=NULL WHERE id=?").run(`insight:${id}`);
  const recovered=new InsightRuns(store);assert.equal(recovered.get(id).error?.code,'interrupted');
  const invalid=await app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{requestId:randomUUID(),after:'2026-09-16T00:00:00Z',before:'2026-09-15T00:00:00Z'}});assert.equal(invalid.statusCode,400);
});

test('owner HTTP cancellation aborts a review and fences late reports without replay',async t=>{
 let release!:()=>void,entered!:()=>void,signal:AbortSignal|undefined,calls=0;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const {app,store,insightRuns,connections}=await fixture(t,{configured:true,query:async input=>{calls++;signal=input.signal;entered();await gate;return {answer:'Generated late report',citations:[],trace:[],runId:randomUUID()};},close:async()=>release()});
 const id=randomUUID();assert.equal((await app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{requestId:id}})).statusCode,202);await started;
 const {invitation}=connections.invite({serverUrl:'http://127.0.0.1:3456',label:'Generated collector'}),collector=await readAgentCredential(connections);
 for(const [authorization,code] of [['',401],['Bearer '+collector.token,403]] as const)assert.equal((await app.inject({method:'POST',url:`/api/insight-runs/${id}/cancel`,headers:{authorization}})).statusCode,code);
 const response=await app.inject({method:'POST',url:`/api/insight-runs/${id}/cancel`,headers});assert.equal(response.statusCode,200);assert.equal(response.json().status,'cancelled');assert.equal(signal?.aborted,true);
 release();await insightRuns.close();assert.equal(insightRuns.get(id).status,'cancelled');assert.equal(store.insights().length,0);assert.equal(calls,1);
 assert.equal((await app.inject({method:'POST',url:`/api/insight-runs/${id}/cancel`,headers})).json().status,'cancelled');
 const restored=new InsightRuns(store);assert.equal(restored.get(id).status,'cancelled');await restored.close();assert.equal(calls,1);
});
