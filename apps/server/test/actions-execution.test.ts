import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ProviderFailure,type QueryResult} from '@mote/shared';
import type {QueryInput} from '@mote/agent';
import {Actions} from '../src/actions.js';
import {Store} from '../src/store.js';
import {FileStore} from '../src/files.js';
import {SourceStore} from '../src/sources.js';
import {ExecutionEngine} from '../src/execution-engine.js';
const text='Generated appointment is only proposed.';
const event={title:'Generated event',start:'2099-02-01T09:00:00Z',end:'2099-02-01T10:00:00Z',timeZone:'UTC',allDay:false,location:'',description:''};
const empty=():QueryResult=>({answer:'{"actions":[]}',citations:[],trace:[],runId:randomUUID()});
const answer=(id:string):QueryResult=>({...empty(),answer:JSON.stringify({actions:[{kind:'calendar.create',event,uncertainty:'proposal',sameAs:null,evidence:[{id,quote:text}]}]}),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:text}]});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
async function fixture(t:TestContext,query:(input:QueryInput)=>Promise<QueryResult>){const directory=mkdtempSync(join(tmpdir(),'mote-actions-execution-')),store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources);let now=Date.now();const engine=new ExecutionEngine(store,()=>now),actions=new Actions(store,files,query,()=>true,{executor:engine});const extra:(()=>Promise<unknown>)[]=[];t.after(async()=>{for(const close of extra.reverse())await close();await actions.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});actions.configure({enabled:true,timeZone:'UTC',reviewDeviceIds:[]});sources.register({id:'fixture',kind:'custom',name:'Generated',deviceId:'fixture',platform:'import'});const add=()=>sources.upsert('fixture',{externalId:randomUUID(),revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text});return {store,sources,files,engine,actions,extra,add,advance:(ms:number)=>now+=ms};}

test('action model work has a real Operation and two hosts execute one immutable intake only once',async t=>{
 const entered=deferred(),release=deferred();let calls=0,trace:QueryInput['traceContext'];const f=await fixture(t,async input=>{calls++;trace=input.traceContext;entered.resolve();await release.promise;return answer(input.evidenceIds![0]);});const record=await f.add();const secondEngine=new ExecutionEngine(f.store),second=new Actions(f.store,f.files,async()=>{calls++;return empty();},()=>true,{executor:secondEngine});f.extra.push(()=>secondEngine.close(),()=>second.close());
 const running=f.actions.tick();await entered.promise;const step=f.engine.get('actions:'+trace!.jobId)!;assert.equal(step.state,'running');assert.equal(trace!.operationId,step.operationId);assert.ok(f.store.db.prepare('SELECT 1 FROM operation_parents WHERE parent_id=? AND child_id=?').get('capture:'+record.id,step.operationId));await second.tick();assert.equal(calls,1);release.resolve();await running;await second.tick();assert.equal(calls,1);assert.equal(f.actions.list().length,1);assert.equal(f.actions.progress().jobs[0].status,'completed');
});

test('another host cancellation revokes action proposal and shared checkpoint commit before abort arrives',async t=>{
 let other!:ExecutionEngine;const f=await fixture(t,async input=>{other.cancel('actions:'+input.traceContext!.jobId);assert.equal(input.signal!.aborted,false);return answer(input.evidenceIds![0]);});other=new ExecutionEngine(f.store);f.extra.push(()=>other.close());await f.add();await f.actions.tick();assert.equal(f.actions.list().length,0);assert.equal(f.store.db.prepare("SELECT state FROM execution_steps WHERE kind='actions.extract'").get()!.state,'cancelled');assert.equal(f.actions.progress().jobs[0].status,'cancelled');await f.actions.tick();assert.equal(f.actions.list().length,0);
});

test('provider budget blocking and Retry-After are engine states and resume only within their grant',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;if(calls===1)throw new ProviderFailure({category:'blocked',code:'model_token_budget'});if(calls===2)throw new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:60000});return empty();});await f.add();await f.actions.tick();assert.equal(f.actions.progress().jobs[0].status,'blocked');assert.equal(f.actions.progress().errorCode,'model_token_budget');await f.actions.tick();assert.equal(calls,1);f.actions.retry();await f.actions.tick();assert.equal(calls,2);assert.equal(f.actions.progress().jobs[0].status,'pending');await f.actions.tick();assert.equal(calls,2);f.advance(60001);await f.actions.tick();assert.equal(calls,3);assert.equal(f.actions.progress().jobs[0].status,'completed');
});

test('legacy action receipts migrate without replay and settings changes cannot publish an in-flight proposal',async t=>{
 let mutate=()=>{};const f=await fixture(t,async input=>{mutate();return answer(input.evidenceIds![0]);});await f.add();mutate=()=>f.actions.configure({...f.actions.settings(),timeZone:'Asia/Shanghai'});await f.actions.tick();assert.equal(f.actions.list().length,0);assert.equal(f.actions.progress().errorCode,'action_settings_changed');
 const key='a'.repeat(64);f.store.db.prepare('INSERT INTO action_jobs(key,id,offset,length,fingerprint,status,attempts) VALUES(?,?,0,1,?,\'completed\',2)').run(key,randomUUID(),'b'.repeat(64));const other=new Actions(f.store,f.files,async()=>{throw Error('Completed legacy job must not replay');},()=>false);f.extra.push(()=>other.close());assert.equal(other.engine.get('actions:'+key)?.state,'succeeded');assert.equal(other.engine.get('actions:'+key)?.attempts,2);
});

test('application action analysis usage and semantic children resolve to the admitted parent operation',async t=>{
 const {buildApp}=await import('../src/app.js'),directory=mkdtempSync(join(tmpdir(),'mote-action-operation-api-'));let node:Awaited<ReturnType<typeof buildApp>>;
 node=await buildApp({dataDir:directory,token:'generated-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-model',modelBaseUrl:'https://synthetic.invalid',apiKey:'generated',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{agent:{configured:true,close:async()=>{},query:async input=>{
  if(node.executor.get(input.traceContext!.jobId!)?.kind==='context-dag.semantic'){const id=input.evidenceIds![0];return {...empty(),answer:JSON.stringify({summary:'Generated appointment',evidence:[{id,quote:text}],events:[],memoryCandidates:[],actionCues:[{kind:'calendar.create',event,uncertainty:'proposed',evidence:[{id,quote:text}]}]}),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:text}]};}
  assert.equal(input.skill,'calendar-extraction');assert.equal(node.executor.get('actions:'+input.traceContext!.jobId)?.operationId,input.traceContext!.operationId);return answer(input.evidenceIds![0]);
 }}});t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});assert.equal(node.actions.engine,node.executor);
 node.sources.register({id:'fixture',kind:'custom',name:'Generated',deviceId:'fixture',platform:'import'});await node.sources.upsert('fixture',{externalId:'one',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text});node.actions.configure({enabled:true,timeZone:'UTC',reviewDeviceIds:[]});await node.actions.tick();assert.equal(node.actions.list().length,1);const step=node.store.db.prepare("SELECT operation_id FROM execution_steps WHERE kind='actions.extract'").get()!;const receipt=JSON.parse(String(node.store.db.prepare("SELECT json FROM model_usage WHERE json_extract(json,'$.attribution.moduleId')='actions'").get()!.json));assert.equal(receipt.attribution.operationId,step.operation_id);assert.ok(receipt.attribution.jobId);assert.ok(node.store.db.prepare('SELECT 1 FROM operation_parents WHERE parent_id=?').get(String(step.operation_id)));
});
