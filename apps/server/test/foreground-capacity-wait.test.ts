import {withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ProviderFailure,type QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const answer=(insight:boolean):QueryResult=>({answer:insight?JSON.stringify({title:'Generated review',markdown:'Generated review.',html:'<p>Generated review.</p>'}):'Generated answer.',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}});
const configuration=(dataDir:string):Config=>({dataDir,token:'generated-capacity-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'http://127.0.0.1:1234/v1',apiKey:'generated-not-live',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
async function until<T>(read:()=>T,ready:(value:T)=>boolean){const deadline=Date.now()+4000;for(;;){const value=read();if(ready(value))return value;if(Date.now()>=deadline)assert.fail('Generated capacity fixture did not reach its expected state');await delay(10);}}

for(const feature of ['query','insight'] as const)for(const mode of ['worker-busy','host-cooldown'] as const)test(`synchronous HTTP ${feature} keeps one request alive through ${mode} and publishes once after release`,{timeout:15000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-foreground-capacity-')),config=configuration(directory);
 let calls=0;
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>{calls++;if(mode==='worker-busy'&&calls===1)throw new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:1000,executionStarted:false});return answer(feature==='insight');}}});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 if(mode==='host-cooldown')await assert.rejects(node.featureServices.providerAdmission.run(node.modelSettings.select(feature==='query'?'chat':'insight').settings,async()=>{throw new ProviderFailure({category:'transient',code:'provider_unavailable',retryAfterMs:1000,executionStarted:false});}),ProviderFailure);
 await node.app.listen({host:'127.0.0.1',port:0});
 const headers={authorization:'Bearer '+config.token,'content-type':'application/json'},path=feature==='query'?'/api/query':'/api/insights';let settled=false;
 const response=fetch(new URL(path,node.app.listeningOrigin),{method:'POST',headers,body:JSON.stringify(feature==='query'?{question:'Generated capacity question'}:{}),signal:AbortSignal.timeout(12000)}).then(value=>{settled=true;return value;});
 const waiting=await until(()=>feature==='query'?node.featureServices.queryRuns.list()[0]:node.insightRuns.list()[0],run=>Boolean(run?.execution?.status==='retry_wait'));
 assert.ok(waiting);assert.equal(waiting.status,'running');assert.equal(waiting.error,undefined);assert.equal(waiting.execution!.attempts,0);assert.equal(settled,false);
 assert.equal(calls,mode==='worker-busy'?1:0);assert.equal(node.store.db.prepare('SELECT count(*) n FROM conversation_turns').get()!.n,0);assert.equal(node.store.db.prepare('SELECT count(*) n FROM insights').get()!.n,0);
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM model_usage').get()!.n,calls,'a host cooldown cannot invent a failed model-call receipt');
 const operationId=waiting.operationId!,step=node.executor.list({operationId}).items.find(step=>step.state==='waiting')!;
 assert.ok(step);assert.equal(step.error,mode==='worker-busy'?'rate_limited':'provider_unavailable');assert.equal(node.executor.failure(step.id)!.availableAt,step.availableAt);
 const statusPath=feature==='query'?'/api/query-runs/':'/api/insight-runs/';
 const observed=await fetch(new URL(statusPath+waiting.id,node.app.listeningOrigin),{headers});assert.equal(observed.status,200);assert.equal((await observed.json()).execution.status,'retry_wait');
 // Drive the production executor after its persisted eligibility time. No task,
 // cooldown, lease or receipt state is rewritten to release the generated call.
 await delay(Math.max(0,step.availableAt-Date.now())+20);await node.executor.tick();
 const completed=await response;assert.equal(completed.status,200,await completed.clone().text());
 const result=await completed.json();assert.equal(feature==='query'?result.answer:result.artifact.title,feature==='query'?'Generated answer.':'Generated review');
 const run=feature==='query'?node.featureServices.queryRuns.get(waiting.id):node.insightRuns.get(waiting.id);assert.equal(run.status,'completed');assert.equal(run.error,undefined);assert.equal(run.execution!.attempts,1);
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM conversations').get()!.n,feature==='query'?1:0);
 assert.equal(calls,mode==='worker-busy'?2:1);assert.equal(node.store.db.prepare('SELECT count(*) n FROM conversation_turns').get()!.n,feature==='query'?1:0);assert.equal(node.store.db.prepare('SELECT count(*) n FROM insights').get()!.n,feature==='insight'?1:0);
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM model_usage').get()!.n,calls);assert.equal(node.store.db.prepare("SELECT count(*) n FROM model_usage WHERE json_extract(json,'$.status')='completed'").get()!.n,1);
 await node.executor.tick();assert.equal(calls,mode==='worker-busy'?2:1);assert.equal(node.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE operation_id=? AND state='succeeded'").get(operationId)!.n,1);
});

test('a cooldown reported while the actual model gate is occupied creates no unissued usage receipt',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-late-model-cooldown-')),config=configuration(directory),release=deferred();let calls=0;
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,_reader,host)=>({configured:true,close:async()=>{},query:input=>host.runModel!(async()=>{calls++;return answer(false);},input.signal)})});
 t.after(async()=>{release.resolve();await node.app.close();await rm(directory,{recursive:true,force:true});});
 const {llmGate,queryAgent,providerAdmission}=node.featureServices;llmGate.configure(1);
 const occupied=llmGate.run(()=>release.promise),pending=withFixtureOwnerModelWork(node,()=>queryAgent({question:'Generated gate-race question'}));
 const rejection=assert.rejects(pending,(error:unknown)=>error instanceof ProviderFailure&&error.details.admissionWaiting===true);
 await until(()=>llmGate.snapshot().waiting,count=>count===1);
 await assert.rejects(providerAdmission.run(node.modelSettings.select('chat').settings,async()=>{throw new ProviderFailure({category:'transient',code:'provider_unavailable',retryAfterMs:1000});}),ProviderFailure);
 release.resolve();await occupied;await rejection;assert.equal(calls,0);assert.equal(node.store.db.prepare('SELECT count(*) n FROM model_usage').get()!.n,0);
 await delay(Math.max(0,providerAdmission.snapshot().nextEligibleAt!-Date.now())+20);
 await withFixtureOwnerModelWork(node,()=>queryAgent({question:'Generated gate-race question after release'}));assert.equal(calls,1);assert.equal(node.store.db.prepare("SELECT count(*) n FROM model_usage WHERE json_extract(json,'$.status')='completed'").get()!.n,1);
});

test('cancelling while the actual model gate is occupied creates no unissued usage receipt',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-cancel-model-queue-')),config=configuration(directory),release=deferred(),controller=new AbortController();let calls=0;
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,_reader,host)=>({configured:true,close:async()=>{},query:input=>host.runModel!(async()=>{calls++;return answer(false);},input.signal)})});
 t.after(async()=>{release.resolve();await node.app.close();await rm(directory,{recursive:true,force:true});});
 const {llmGate,queryAgent}=node.featureServices;llmGate.configure(1);
 const occupied=llmGate.run(()=>release.promise),pending=withFixtureOwnerModelWork(node,()=>queryAgent({question:'Generated cancelled model queue',signal:controller.signal}));
 const rejection=assert.rejects(pending,(error:unknown)=>error instanceof DOMException&&error.name==='AbortError');
 await until(()=>llmGate.snapshot().waiting,count=>count===1);controller.abort();await rejection;
 assert.equal(calls,0);assert.equal(node.store.db.prepare('SELECT count(*) n FROM model_usage').get()!.n,0);
 release.resolve();await occupied;await delay(20);assert.equal(calls,0);assert.equal(llmGate.snapshot().waiting,0);assert.equal(node.store.db.prepare('SELECT count(*) n FROM model_usage').get()!.n,0);
});

test('admission waiting preserves already reported partial usage, while a file-analysis cooldown invents none',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-partial-admission-')),config=configuration(directory);let calls=0,partial=true;
 const query:NonNullable<Parameters<typeof buildApp>[1]>['agent']={configured:true,close:async()=>{},query:async input=>{
  calls++;if(partial){input.onUsage?.({measurement:'thread_cumulative',complete:false,requests:0,reportedRequests:0,inputTokens:19,outputTokens:3,totalTokens:22});throw new ProviderFailure({category:'transient',code:'provider_unavailable',admissionWaiting:true,executionStarted:false,retryAfterMs:1000});}return answer(false);
 }};
 const node=await buildApp(config,{backgroundWorker:false,agent:query,createModelAgent:async()=>query!});t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 await assert.rejects(withFixtureOwnerModelWork(node,()=>node.featureServices.queryAgent({question:'Generated partial model operation'})),ProviderFailure);
 const receipts=node.store.db.prepare('SELECT json FROM model_usage').all().map(row=>JSON.parse(String(row.json)));assert.equal(receipts.length,1);assert.equal(receipts[0].status,'failed');assert.equal(receipts[0].tokens.totalTokens,22);assert.equal(receipts[0].tokens.complete,false);
 partial=false;
 await assert.rejects(node.featureServices.providerAdmission.run(node.modelSettings.select('file').settings,async()=>{throw new ProviderFailure({category:'transient',code:'provider_unavailable',retryAfterMs:1000});}),ProviderFailure);
 await assert.rejects(withFixtureOwnerModelWork(node,()=>node.processing.analyze('generated-file',[],'Generated file analysis')),ProviderFailure);assert.equal(calls,1);assert.equal(node.store.db.prepare('SELECT count(*) n FROM model_usage').get()!.n,1);
 await delay(Math.max(0,node.featureServices.providerAdmission.snapshot().nextEligibleAt!-Date.now())+20);
 await withFixtureOwnerModelWork(node,()=>node.processing.analyze('generated-file',[],'Generated file analysis after release'));assert.equal(calls,2);assert.equal(node.store.db.prepare("SELECT count(*) n FROM model_usage WHERE json_extract(json,'$.operation')='file-analysis'").get()!.n,1);
});
