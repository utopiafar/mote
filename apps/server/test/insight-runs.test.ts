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
  const result={answer:'Generated report',citations:[],trace:[],runId:randomUUID()};
  const {app,insightRuns,store}=await fixture(t,{configured:true,query:async(input:QueryInput)=>{calls++;input.onProgress?.({stage:'tool',tool:'timeline',count:4,...{arguments:{secret:'never-store'},reasoning:'never-store'}});await gate;return result;},close:async()=>release()});
  const payload={requestId:randomUUID(),prompt:'Synthetic report request',timeZone:'Asia/Shanghai'};
  const response=await app.inject({method:'POST',url:'/api/insight-runs',headers,payload});assert.equal(response.statusCode,202,response.body);assert.equal(response.json().status,'running');
  const detail=await app.inject({url:'/api/insight-runs/'+payload.requestId,headers});assert.equal(detail.json().events.at(-1).tool,'timeline');assert.equal(detail.json().events.at(-1).count,4);assert.ok(!detail.body.includes('never-store'));
  assert.equal((await app.inject({method:'POST',url:'/api/insight-runs',headers,payload})).statusCode,202);assert.equal(calls,1);
  assert.equal((await app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{...payload,prompt:'changed'}})).statusCode,409);
  assert.equal((await app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{...payload,requestId:randomUUID()}})).statusCode,429);
  assert.equal((await app.inject({url:'/api/insight-runs',headers})).json().items[0].id,payload.requestId);
  release();await insightRuns.close();
  const completed=(await app.inject({url:'/api/insight-runs/'+payload.requestId,headers})).json();assert.equal(completed.status,'completed');assert.equal(completed.result.answer,result.answer);
  store.db.exec('DELETE FROM insights');assert.equal(insightRuns.detail(payload.requestId).result,undefined,'deleted reports are never revived by job polling');
});
test('failures and interrupted runs are visible without provider secrets; run endpoints require ownership',async t=>{
  const {app,store,insightRuns}=await fixture(t,{configured:true,query:async()=>{throw new AgentProviderError();},close:async()=>{}});
  assert.equal((await app.inject('/api/insight-runs')).statusCode,401);
  const id=randomUUID();await app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{requestId:id}});await insightRuns.close();
  assert.equal(insightRuns.get(id).status,'failed');assert.equal(insightRuns.get(id).error?.code,'agent_response');
  store.db.prepare("UPDATE insight_runs SET json=json_set(json,'$.status','running') WHERE id=?").run(id);
  store.db.prepare('DELETE FROM execution_steps WHERE id=?').run(`insight:${id}`);
  const recovered=new InsightRuns(store);assert.equal(recovered.get(id).error?.code,'interrupted');
  const invalid=await app.inject({method:'POST',url:'/api/insight-runs',headers,payload:{requestId:randomUUID(),after:'2026-09-16T00:00:00Z',before:'2026-09-15T00:00:00Z'}});assert.equal(invalid.statusCode,400);
});
