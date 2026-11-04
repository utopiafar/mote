import {withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {AgentYieldError,type QueryInput} from '@mote/agent';
import {runQueryQualityExperiment,type QueryQualityStrategy} from '../src/query-quality-experiment.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store,StoreError} from '../src/store.js';
import {ConfigService} from '../src/config-service.js';
import {hostRun,hostTerminal} from './fixtures/host-run.js';

const result=(answer='Generated grounded answer')=>({answer,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:[]}});
const controls={} as NonNullable<QueryInput['hostControlChannel']>;
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
const scope={after:'2017-06-01T00:00:00Z',before:'2017-10-01T00:00:00Z',timeZone:'Asia/Shanghai',contextTime:'2017-09-27T11:23:00Z'};
for(const [strategy,expected] of [['base',['base']],['review',['base','review']],['research-writer',['research','writer']],['both',['research','writer','review']]] as const)test(`trusted ${strategy} preserves scope and model while separating model interpretations from evidence`,async()=>{
  const calls:{input:QueryInput;stage:string}[]=[];
  const answer=await runQueryQualityExperiment({question:'How did the generated toy-building sessions change?',...scope,hostControlChannel:controls,modelProfileId:'generated',modelOverride:'fixture'},strategy,async(input,stage)=>{calls.push({input,stage});return result(stage+' final');});
  assert.deepEqual(calls.map(call=>call.stage),expected);assert.equal(answer.answer,expected.at(-1)+' final');
  for(const {input,stage} of calls){for(const key of Object.keys(scope) as (keyof typeof scope)[])assert.equal(input[key],scope[key]);assert.equal(input.modelProfileId,'generated');assert.equal(input.modelOverride,'fixture');if(stage==='writer'||stage==='review'){assert.equal(input.hostControlChannel,undefined);assert.match(input.taskContext!.untrustedInterpretations!,/no|cannot|navigation/i);assert.match(input.question,/original evidence|original user question/i);}}
});
test('delegated readers are not recursively wrapped and yielded research does not start a writer',async()=>{
  let calls=0;await runQueryQualityExperiment({question:'Generated reader question'},'both',async(_input,stage)=>{calls++;assert.equal(stage,'research');return result();});assert.equal(calls,1);
  const yielded=new AgentYieldError();
  await assert.rejects(runQueryQualityExperiment({question:'Generated parent',hostControlChannel:controls},'both',async()=>{calls++;throw yielded;}),error=>error===yielded);assert.equal(calls,2);
});

const config=(dataDir:string):Config=>({dataDir,token:'generated-quality-owner-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false});
for(const borrowed of [true,false])test(`formal startup rejects a retired source journal without mutation (${borrowed?'borrowed':'owned'} Store)`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-quality-retired-schema-')),cfg=config(directory),store=new Store(directory);let fixtureClosed=false;
 const first=await buildApp(cfg,{store,queryQualityExperiment:'base',backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>result()}});
 t.after(async()=>{await first.app.close();if(!fixtureClosed)store.close();rmSync(directory,{recursive:true,force:true});});
 await first.app.close();
 const sql=String(store.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='activity_memory_continuation_update'").get()!.sql).replace('UPDATE activity_memory_items SET','UPDATE activity_memory_items AS i SET').replace('WHERE activity_memory_items.ref IN','WHERE i.ref IN');
 store.db.exec('DROP TRIGGER activity_memory_continuation_update');store.db.exec(sql);
 store.db.exec('DROP TABLE delegation_source_context_dependencies; CREATE TABLE delegation_source_context_dependencies(work_id TEXT NOT NULL REFERENCES delegation_works(id) ON DELETE CASCADE,unit_id TEXT NOT NULL,source_id TEXT NOT NULL,version INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(work_id,unit_id,source_id,version,fingerprint))');
 store.db.prepare('INSERT INTO delegation_works VALUES(?,?)').run('generated-retained-work','{"goal":"Generated retained work"}');
 store.db.prepare('INSERT INTO delegation_source_context_dependencies VALUES(?,?,?,?,?)').run('generated-retained-work','','generated-source',7,'a'.repeat(64));
 const snapshot=(value:Pick<Store,'db'>)=>({schema:value.db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all(),works:value.db.prepare('SELECT * FROM delegation_works ORDER BY id').all(),dependencies:value.db.prepare('SELECT * FROM delegation_source_context_dependencies').all()});
 const before=snapshot(store);if(!borrowed){store.close();fixtureClosed=true;}
 let closedStore:Store|undefined,configClosed=false,modelCreated=false;
 const storeClose=Store.prototype.close,configClose=ConfigService.prototype.close;
 t.mock.method(Store.prototype,'close',function(this:Store){closedStore=this;return storeClose.call(this);});
 t.mock.method(ConfigService.prototype,'close',async function(this:ConfigService){await configClose.call(this);configClosed=true;});
 await assert.rejects(buildApp(cfg,{...(borrowed?{store}:{}),queryQualityExperiment:'base',backgroundWorker:false,createModelAgent:async()=>{modelCreated=true;return {configured:true,close:async()=>{},query:async()=>result()};}}),error=>{
  assert.ok(error instanceof StoreError);assert.equal(error.statusCode,409);assert.match(error.message,/unsupported delegation source-context schema/i);return true;
 });
 assert.equal(modelCreated,false,'rejection precedes model runtime construction');assert.equal(configClosed,true,'failed startup releases its configuration watcher');
 if(borrowed){assert.equal(closedStore,undefined);assert.equal(store.db.prepare('SELECT 1 AS current').get()!.current,1,'the caller retains its borrowed Store');assert.deepEqual(snapshot(store),before);}
 else {assert.ok(closedStore);assert.throws(()=>closedStore!.db.prepare('SELECT 1').get(),/not open/,'failed startup releases its owned Store');const reopened=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});try{const actual=snapshot({db:reopened}),journal=(value:typeof before)=>({...value,schema:value.schema.filter(row=>String(row.name).startsWith('delegation_')||row.name==='activity_memory_continuation_update')});assert.deepEqual(journal(actual),journal(before));}finally{reopened.close();}}
});
test('formal repeated current startup preserves the source journal and supports Ask HTTP',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-quality-current-schema-')),cfg=config(directory),store=new Store(directory),nodes:Awaited<ReturnType<typeof buildApp>>[]=[];
 const start=async()=>{const node=await buildApp(cfg,{store,queryQualityExperiment:'base',backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>result()}});nodes.push(node);await node.app.ready();return node;};
 t.after(async()=>{for(const node of nodes)await node.app.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const first=await start();await first.app.close();
 const columns=store.db.prepare('PRAGMA table_info(delegation_source_context_dependencies)').all();assert.ok(columns.some(row=>row.name==='kind'));
 const second=await start();assert.deepEqual(store.db.prepare('PRAGMA table_info(delegation_source_context_dependencies)').all(),columns);
 assert.ok(!String(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='activity_memory_continuation_update'").get()!.sql).includes(' AS i SET'));
 store.db.exec('ALTER TABLE delegation_source_context_dependencies RENAME TO generated_dependency_rename; ALTER TABLE generated_dependency_rename RENAME TO delegation_source_context_dependencies');
 const answer=await second.app.inject({method:'POST',url:'/api/query',headers:{authorization:'Bearer '+cfg.token},payload:{question:'Generated repeated current startup'}});assert.equal(answer.statusCode,200,answer.body);assert.equal(answer.json().answer,'Generated grounded answer');
});
for(const strategy of ['base','review','research-writer','both'] as QueryQualityStrategy[])test(`Ask HTTP ${strategy} continuation reports all operation fragments rather than the last model usage`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-quality-http-')),cfg=config(directory),calls:QueryInput[]=[];
  const node=await buildApp(cfg,{queryQualityExperiment:strategy,backgroundWorker:false,semanticContextTime:()=>scope.contextTime,agent:{configured:true,close:async()=>{},query:async(input,lease)=>{
    lease?.onFinalizer?.('host');
    calls.push(input);hostRun(input,{usage:{requests:1,reportedRequests:1,inputTokens:7,outputTokens:3,totalTokens:10,cacheReadTokens:0,cacheWriteTokens:0}});return result('Generated final '+input.traceContext?.phase);
  }}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+cfg.token},api=(method:'GET'|'POST',url:string,payload?:unknown)=>node.app.inject({method,url,headers,payload:payload as any});
  const first=await api('POST','/api/query',{question:'Generated first question',timeZone:'Asia/Shanghai'});assert.equal(first.statusCode,200,first.body);
  const stages=strategy==='both'?3:strategy==='base'?1:2,firstValue=first.json();assert.equal(firstValue.operationUsage.total.runs,stages);assert.equal(firstValue.operationUsage.total.totalTokens,10*stages);assert.equal(firstValue.usage.tokens.totalTokens,10);
  const id=randomUUID(),created=await api('POST','/api/query-runs',{id,input:{question:'Generated follow-up',conversationId:firstValue.conversationId}});assert.equal(created.statusCode,202,created.body);
  let run:any;for(let i=0;i<200;i++){run=(await api('GET','/api/query-runs/'+id)).json();if(run.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(run.status,'completed',JSON.stringify(run));assert.equal(run.conversationId,firstValue.conversationId);assert.equal(run.operationUsage.total.runs,stages);assert.equal(run.operationUsage.total.totalTokens,10*stages);assert.equal(run.operationUsage.items.length,stages);
  assert.ok(calls.slice(stages).every(input=>input.conversation?.turns.length===1));assert.ok(calls.every(input=>input.contextTime===scope.contextTime));
  const hiddenMode=await api('POST','/api/query',{question:'Generated',qualityStrategy:'review'});assert.equal(hiddenMode.statusCode,400,'trusted experiment selection never becomes a user HTTP setting');
  await assert.rejects(withFixtureOwnerModelWork(node,()=>node.featureServices.queryAgent({question:'Generated background',traceContext:{operationId:'memory:generated'}},'query','memories')),/background model work/);
});

test('durable quality stages resume the interrupted writer without repeating completed research',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-quality-restart-')),cfg=config(directory),entered=deferred(),calls:string[]=[],nodes:Awaited<ReturnType<typeof buildApp>>[]=[];
  const first=await buildApp(cfg,{queryQualityExperiment:'both',backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input,lease)=>{
    lease?.onFinalizer?.('host');
    const phase=input.traceContext!.phase!;calls.push(phase);
    if(phase==='quality.writer'){
      entered.resolve();
      return new Promise((_,reject)=>{
        const abort=()=>{hostTerminal(input,'cancelled');reject(input.signal!.reason);};
        input.signal!.addEventListener('abort',abort,{once:true});
        if(input.signal!.aborted)abort();
      });
    }
    hostRun(input,{usage:{requests:1,reportedRequests:1,inputTokens:7,outputTokens:3,totalTokens:10,cacheReadTokens:0,cacheWriteTokens:0}});return result('Saved research interpretation');
  }}});nodes.push(first);
  t.after(async()=>{for(const node of nodes)await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const id=randomUUID(),headers={authorization:'Bearer '+cfg.token},created=await first.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated restart scope',...scope}}});
  assert.equal(created.statusCode,400,'contextTime is host owned');
  const accepted=await first.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated restart scope',timeZone:scope.timeZone}}});assert.equal(accepted.statusCode,202,accepted.body);
  await entered.promise;await first.app.close();assert.deepEqual(calls,['quality.research','quality.writer']);
  const second=await buildApp(cfg,{queryQualityExperiment:'both',backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async(input,lease)=>{
    lease?.onFinalizer?.('host');
    calls.push(input.traceContext!.phase!);assert.equal(input.hostControlChannel,undefined);assert.match(input.taskContext!.untrustedInterpretations!,/Saved research interpretation|Generated resumed writer/);
    hostRun(input,{usage:{requests:1,reportedRequests:1,inputTokens:7,outputTokens:3,totalTokens:10,cacheReadTokens:0,cacheWriteTokens:0}});return result('Generated resumed writer');
  }}});nodes.push(second);await second.app.ready();
  let run:any;for(let i=0;i<500;i++){run=(await second.app.inject({method:'GET',url:'/api/query-runs/'+id,headers})).json();if(run.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(run.status,'completed',JSON.stringify(run));assert.deepEqual(calls,['quality.research','quality.writer','quality.writer','quality.review']);
  assert.equal(run.operationUsage.total.runs,4,'operation accounting retains the interrupted attempt as well as each completed stage');
});

for(const change of ['reasoning','endpoint'] as const)test(`quality stage fence stops after a ${change} configuration change`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-quality-settings-')),cfg=config(directory),calls:string[]=[];let node!:Awaited<ReturnType<typeof buildApp>>;
  node=await buildApp(cfg,{queryQualityExperiment:'both',backgroundWorker:false,createModelAgent:async()=>({configured:true,close:async()=>{},query:async input=>{
    calls.push(input.traceContext!.phase!);
    const profile=node.modelSettings.select('chat','generated-quality');await node.modelSettings.updateProfile(profile.id,{revision:node.modelSettings.view().revision,name:profile.name,settings:{...profile.settings,...(change==='reasoning'?{reasoningEffort:'low'}:{baseUrl:'http://127.0.0.1:2/v1'})}});
    return result();
  }})});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const original=node.modelSettings.select('chat');await node.modelSettings.updateProfile('generated-quality',{revision:node.modelSettings.view().revision,name:'Generated stage fence',settings:{...original.settings,baseUrl:'http://127.0.0.1:1/v1'}});
  const response=await node.app.inject({method:'POST',url:'/api/query',headers:{authorization:'Bearer '+cfg.token},payload:{question:'Generated stage configuration',modelProfileId:'generated-quality'}});
  assert.equal(response.statusCode,409,response.body);assert.deepEqual(calls,['quality.research'],'writer and review never silently mix configurations');
});
