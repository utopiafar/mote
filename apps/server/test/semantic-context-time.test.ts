import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {MemoryLifecycle,freezeSemanticContextTime,type LifecycleWindow} from '../src/memory-lifecycle.js';
import {requestMemoryIntegration} from '../src/memory-integration.js';
import {defaultMemoryIntegrationRecipe} from '../src/memory-integration-policy.js';
import {reviewMemory,memoryReviewReceipt} from '../src/memory-review.js';
import {Store} from '../src/store.js';

// Mechanical, independently generated text fixtures; all model calls are local stubs.
const early='2001-01-02T03:04:05+08:00',later='2001-02-02T03:04:05+08:00',expiry='2001-03-01T00:00:00Z';
const token='generated-semantic-clock-owner-token',headers={authorization:'Bearer '+token};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-stub',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false});
type Node=Awaited<ReturnType<typeof buildApp>>;
const empty=(answer='Generated answer'):QueryResult=>({answer,citations:[],trace:[],runId:randomUUID()});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
const ids=(page:{items:unknown[]})=>page.items.map(item=>(item as {id:string}).id).sort();
const catalogIds=(value:unknown)=>(value as {entries:{id:string}[]}).entries.map(item=>item.id).sort();
const realTime=(value:string|undefined,start:number)=>{assert.ok(value);assert.ok(Date.parse(value)>=start&&Date.parse(value)<=Date.now(),value);};
function disabled(node:Node){const s=node.lifecycle.settings();node.lifecycle.configure({...s,extraction:{...s.extraction,enabled:false},consolidation:{...s.consolidation,enabled:false},insights:{...s.insights,enabled:false},working:{...s.working,enabled:false}});}
async function appFixture(t:TestContext,query:(input:QueryInput,reader:ContextReader)=>Promise<QueryResult>,clock?:()=>string){
  const directory=mkdtempSync(join(tmpdir(),'mote-semantic-clock-'));
  const node=await buildApp(config(directory),{backgroundWorker:false,semanticContextTime:clock,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:input=>query(input,reader)})});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  disabled(node);await node.app.ready();return {node,directory};
}
async function note(node:Node,text:string){
  const id=randomUUID();await node.store.ingest({id,deviceId:'generated',deviceName:'Generated device',platform:'import',source:'note',capturedAt:'2000-12-01T00:00:00Z',durationMs:0,ocrText:text});return node.store.evidence([id])[0];
}
function draft(record:ReturnType<Node['store']['evidence']>[number],claims:Record<string,unknown>[]):QueryResult {
  return {answer:JSON.stringify({memories:claims.map(claim=>({domain:'personal',uncertainty:'Generated fixture only',admission:{layer:'memory',reason:'Generated time contract',scope:'Generated fixture',attribution:'user'},evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText}],...claim}))}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:'Generated',excerpt:record.ocrText}],trace:[],runId:randomUUID()};
}
async function timedCard(node:Node){
  const record=await note(node,'Generated access expires at '+expiry);
  return node.memories.publish(node.memories.extract(fixtureMemoryResult(node.memories,draft(record,[{title:'Generated access',statement:'Generated access ['+record.id+']',validUntil:expiry}])),'generated').items[0].id);
}

test('five stub calls share frozen generation/review/Ask times and preserve real receipts',async t=>{
  const start=Date.now(),calls:QueryInput[]=[];let semantic=early,samples=0,oldId='',timedId='',newId='';
  let record:Awaited<ReturnType<typeof note>>,node!:Node;
  const f=await appFixture(t,async(input,reader)=>{
    calls.push(input);
    if(input.skill==='memory-integration'){
      const old=node.memories.get(oldId);
      return draft(record,[{title:'Generated beta',statement:'Generated beta replaces alpha ['+record.id+']',relatedMemoryIds:[old.id],relations:[{kind:'supersedes',memoryId:old.id,fingerprint:old.fingerprint,version:old.version}]}]);
    }
    if(input.responseMode==='memory-extraction')return draft(record,[
      {title:'Generated alpha',statement:'Generated alpha ['+record.id+']'},
      {title:'Generated access',statement:'Generated access ['+record.id+']',validUntil:expiry},
    ]);
    assert.equal(input.contextTime,later);
    assert.deepEqual(input.openingMemories!.map(m=>m.id).sort(),[newId,timedId].sort());
    assert.deepEqual(ids(await reader.memories!({})),[newId,timedId].sort());
    assert.deepEqual(catalogIds(await reader.catalog!({path:'/context/memory'})),[newId,timedId].sort());
    assert.deepEqual(ids(await reader.memories!({asOf:'2001-04-01T00:00:00Z'})),[newId]);
    assert.deepEqual(ids(await reader.memories!({includeHistory:true})),[oldId,newId,timedId].sort());
    return empty();
  },()=>{samples++;return semantic;});node=f.node;
  record=await note(node,'Generated dial alpha. Generated access expires at '+expiry+'. Generated dial beta replaces alpha.');
  realTime(record.receivedAt,start);
  const request={evidenceIds:[record.id],recipes:[{id:'mote.personal-memory',version:'1'}],contextTime:early};
  const job=await node.memoryPipeline.run(node.memoryPipeline.create(request).id);
  assert.equal(job.status,'completed');assert.equal(job.totalBatches,1);assert.equal(calls.length,2);assert.equal(samples,0);
  const cards=job.memoryIds.map(id=>node.memories.get(id));oldId=cards.find(m=>m.title==='Generated alpha')!.id;timedId=cards.find(m=>m.title==='Generated access')!.id;
  for(const card of cards){assert.equal(card.reviewReceipt?.contextTime,early);realTime(card.reviewReceipt?.checkedAt,start);realTime(card.createdAt,start);}
  assert.equal(node.memoryPipeline.create(request).totalBatches,0,'same semantic checkpoint is reusable');
  const different=node.memoryPipeline.create({...request,contextTime:later});assert.equal(different.totalBatches,1,'a different context time is a different checkpoint');node.memoryPipeline.cancel(different.id);
  semantic=later;
  requestMemoryIntegration({recipe:defaultMemoryIntegrationRecipe,inputs:[{id:oldId,version:node.memories.get(oldId).version,fingerprint:node.memories.get(oldId).fingerprint}]},{lifecycle:node.lifecycle,memories:node.memories,pipeline:node.memoryPipeline});
  assert.equal(samples,1);
  const state=JSON.parse(String(node.store.db.prepare("SELECT json FROM memory_lifecycle_state WHERE id='consolidation'").get()!.json));
  assert.equal(state.active.contextTime,later);assert.ok(state.active.startedAt>=start);
  semantic='2002-01-01T00:00:00Z';await node.lifecycle.tick();assert.equal(samples,1,'queued window cannot resample');
  const view=node.lifecycle.view().extensions.find(e=>e.id==='consolidation')!;assert.equal(view.error,undefined);assert.equal(view.active,undefined);
  const integrated=node.memories.list({includeHistory:true}).map(m=>node.memories.get(m.id)).find(m=>m.tier==='consolidated')!;assert.ok(integrated);newId=integrated.id;
  assert.equal(integrated.reviewReceipt?.contextTime,later);assert.equal(node.memories.get(oldId).supersededAt,later);realTime(node.memories.get(oldId).updatedAt,start);
  assert.ok(ids(node.memories.page({asOf:early})).includes(oldId));assert.ok(!ids(node.memories.page({asOf:later})).includes(oldId));
  assert.ok(ids(node.memories.page({asOf:later})).includes(timedId));assert.ok(!ids(node.memories.page({})).includes(timedId));
  semantic=later;const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated clock check'}});assert.equal(response.statusCode,200,response.body);
  assert.equal(samples,2);assert.deepEqual(calls.map(input=>input.contextTime),[early,early,later,later,later]);
  await node.app.close();
  const db=new DatabaseSync(join(f.directory,'mote.sqlite'),{readOnly:true});
  try{const usage=db.prepare('SELECT json FROM model_usage').all().map(row=>JSON.parse(String(row.json)));assert.equal(usage.length,5);assert.ok(usage.every(row=>row.status==='completed'));for(const row of usage)realTime(row.createdAt,start);}finally{db.close();}
});

test('simultaneous Ask sessions isolate default Memory and catalog times',{timeout:15000},async t=>{
  const first=deferred(),second=deferred(),release=deferred();let sample=0,timedId='';const seen:string[]=[];
  t.after(()=>release.resolve());
  const {node}=await appFixture(t,async(input,reader)=>{
    const historical=input.question==='Generated historical';seen.push(input.contextTime!);
    (historical?first:second).resolve();await release.promise;
    const expected=historical?[timedId]:[];
    assert.deepEqual(input.openingMemories!.map(m=>m.id),expected);
    assert.deepEqual(ids(await reader.memories!({})),expected);
    assert.deepEqual(catalogIds(await reader.catalog!({path:'/context/memory'})),expected);
    assert.deepEqual(ids(await reader.memories!({asOf:early})),[timedId]);return empty();
  },()=>++sample===1?early:'2002-01-01T00:00:00Z');
  timedId=(await timedCard(node)).id;
  const a=node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated historical'}});await first.promise;
  const b=node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated later'}});await second.promise;
  release.resolve();const results=await Promise.all([a,b]);for(const result of results)assert.equal(result.statusCode,200,result.body);
  assert.deepEqual(seen,[early,'2002-01-01T00:00:00Z']);assert.equal(sample,2);
});

test('Ask samples before model queuing and every working summary inherits the same time',{timeout:15000},async t=>{
  const entered=deferred(),release=deferred(),thirdSample=deferred();let samples=0,semantic=early;const calls:QueryInput[]=[];
  t.after(()=>release.resolve());
  const {node}=await appFixture(t,async input=>{calls.push(input);if(input.skill==='working-memory')assert.deepEqual(input.contextEvidenceDependencies,{version:1,complete:true,ids:[]});if(input.question==='Generated blocker'){entered.resolve();await release.promise;}return empty(input.skill==='working-memory'?'Generated complete summary':'Generated answer');},()=>{samples++;if(samples===3)thirdSample.resolve();return semantic;});
  node.featureServices.interactiveGate.configure(1);
  const conversations=node.featureServices.conversations;
  let conversationId:string|undefined;
  // These owner-generated prefixes read no original evidence. Their complete
  // empty lineage is explicit, as a real host receipt would record it.
  for(let i=0;i<5;i++)conversationId=conversations.append(conversationId?conversations.get(conversationId):undefined,{question:'Generated prefix '+i},{...empty('X'.repeat(2000)),evidenceDependencies:{version:1,complete:true,ids:[]}}).conversationId;
  const settings=node.lifecycle.settings();node.lifecycle.configure({...settings,contextCharacters:4000,summaryCharacters:1000});
  const compacted=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated follow-up',conversationId}});assert.equal(compacted.statusCode,200,compacted.body);
  assert.ok(calls.some(input=>input.skill==='working-memory'));assert.ok(calls.every(input=>input.contextTime===early));assert.equal(samples,1);
  const blocker=node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated blocker'}});await entered.promise;
  semantic=later;const queued=node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated queued'}});await thirdSample.promise;
  semantic='2002-01-01T00:00:00Z';release.resolve();for(const result of await Promise.all([blocker,queued]))assert.equal(result.statusCode,200,result.body);
  assert.equal(calls.find(input=>input.question==='Generated queued')?.contextTime,later);assert.equal(samples,3);
});

test('default host clock is real and HTTP bodies cannot inject semantic time',async t=>{
  const start=Date.now(),calls:QueryInput[]=[];const {node}=await appFixture(t,async input=>{calls.push(input);return empty();});
  const rejected=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated',contextTime:early}});assert.equal(rejected.statusCode,400);assert.equal(calls.length,0);
  const accepted=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated'}});assert.equal(accepted.statusCode,200,accepted.body);realTime(calls[0].contextTime,start);
  const denied=await node.app.inject({method:'POST',url:'/api/memory-integrations',headers,payload:{recipe:defaultMemoryIntegrationRecipe,memoryIds:[randomUUID()],contextTime:early}});assert.equal(denied.statusCode,400);
});

test('invalid host times fail before model work or creation of a lifecycle window',async t=>{
  let semantic='not-a-time',calls=0;const {node}=await appFixture(t,async()=>{calls++;return empty();},()=>semantic);
  for(const invalid of ['not-a-time','2001-01-01T00:00:00','2001-02-30T00:00:00Z','2001-01-01']){
    semantic=invalid;assert.throws(()=>freezeSemanticContextTime(()=>invalid));
    const response=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated'}});assert.equal(response.statusCode,400,response.body);
    assert.throws(()=>node.lifecycle.request('consolidation',[randomUUID()],'generated'));
    assert.equal(node.lifecycle.view().extensions.find(e=>e.id==='consolidation')!.active,undefined);
  }
  assert.equal(calls,0);assert.equal(freezeSemanticContextTime(()=>early),early);
});

for(const manual of [false,true])test(`${manual?'manual':'automatic'} lifecycle windows retain semantic time across retries and restart`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-window-clock-')),store=new Store(directory);let now=Date.now(),semantic=early,samples=0,calls=0,fail=true;
  const windows:LifecycleWindow[]=[],clock=()=>{samples++;return semantic;};
  let lifecycle=new MemoryLifecycle(store,()=>true,()=>now,undefined,clock);
  const register=()=>lifecycle.register({id:'consolidation',version:'generated',stream:'evidence',async run(window,checkpoint){calls++;windows.push(window);checkpoint('generated checkpoint');if(fail)throw Error('Generated failure');}});
  register();const settings=lifecycle.settings();lifecycle.configure({...settings,consolidation:{...settings.consolidation,minChanges:1}});
  t.after(async()=>{await lifecycle.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const id=randomUUID();if(manual)lifecycle.request('consolidation',[id],'generated checkpoint');else store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'upsert',?)").run(id,new Date().toISOString());
  await lifecycle.tick();assert.equal(samples,1);assert.equal(calls,1);assert.equal(windows[0].contextTime,early);assert.equal(windows[0].startedAt,now);
  const original=lifecycle.view().extensions[0].active!.id,retryAt=lifecycle.view().extensions[0].retryAt!;assert.ok(retryAt>now);
  semantic=later;now++;await lifecycle.tick();assert.equal(calls,1);assert.equal(samples,1);
  await lifecycle.close();lifecycle=new MemoryLifecycle(store,()=>true,()=>now,undefined,clock);register();
  assert.equal(lifecycle.view().extensions[0].active?.id,original);await lifecycle.tick();assert.equal(calls,1);
  now=retryAt;await lifecycle.tick();assert.equal(calls,2);assert.equal(samples,1);assert.equal(windows[1].contextTime,early);assert.equal(windows[1].startedAt,windows[0].startedAt);
  fail=false;lifecycle.retry('consolidation',original);await lifecycle.tick();assert.equal(calls,3);assert.equal(samples,1);assert.equal(windows[2].contextTime,early);
  if(manual)lifecycle.request('consolidation',[randomUUID()],'generated checkpoint');else store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'upsert',?)").run(randomUUID(),new Date().toISOString());
  await lifecycle.tick();assert.equal(samples,2);assert.equal(windows[3].contextTime,later);assert.equal(windows[3].startedAt,now);
});

test('integration windows missing their frozen clock are refused without sampling a new clock',async t=>{
  let samples=0;const calls:QueryInput[]=[];
  const {node}=await appFixture(t,async input=>{calls.push(input);return empty('{"memories":[]}');},()=>{samples++;return later;});
  const card=await timedCard(node);requestMemoryIntegration({recipe:defaultMemoryIntegrationRecipe,inputs:[{id:card.id,version:card.version,fingerprint:card.fingerprint}]},{lifecycle:node.lifecycle,memories:node.memories,pipeline:node.memoryPipeline});assert.equal(samples,1);
  node.store.db.prepare("UPDATE memory_lifecycle_state SET json=json_set(json_remove(json,'$.active.contextTime'),'$.active.startedAt',?) WHERE id='consolidation'").run(Date.parse(early));
  await assert.rejects(node.lifecycle.tick(),/Unsupported lifecycle window/);assert.equal(samples,1);assert.equal(calls.length,0);
});

test('a queued integration survives closing and reopening its SQLite vault without resampling',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-reopened-clock-')),calls:QueryInput[]=[];let semantic=early,samples=0;
  const dependencies={backgroundWorker:false,semanticContextTime:()=>{samples++;return semantic;},agent:{configured:true,close:async()=>{},query:async(input:QueryInput)=>{calls.push(input);return empty('{"memories":[]}');}}};
  let node=await buildApp(config(directory),dependencies);disabled(node);
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const card=await timedCard(node),queued=requestMemoryIntegration({recipe:defaultMemoryIntegrationRecipe,inputs:[{id:card.id,version:card.version,fingerprint:card.fingerprint}]},{lifecycle:node.lifecycle,memories:node.memories,pipeline:node.memoryPipeline});
  assert.equal(samples,1);await node.app.close();semantic=later;
  node=await buildApp(config(directory),dependencies);
  assert.equal(node.lifecycle.view().extensions.find(e=>e.id==='consolidation')!.active?.id,queued.id);
  await node.lifecycle.tick();assert.equal(samples,1);assert.equal(calls.length,1);assert.equal(calls[0].contextTime,early);
});

test('explicit validity wins over reviewed time and owner corrections keep their real clock',async t=>{
  const start=Date.now();const {node}=await appFixture(t,async()=>empty(),()=>early);const record=await note(node,'Generated first, replacement, and owner correction evidence.');
  const original=node.memories.publish(node.memories.extract(fixtureMemoryResult(node.memories,draft(record,[{title:'Generated original',statement:'Generated original ['+record.id+']'}])),'generated').items[0].id);
  const explicit='2001-01-03T00:00:00Z',candidate=draft(record,[{title:'Generated explicit',statement:'Generated explicit replacement ['+record.id+']',validFrom:explicit,relations:[{kind:'supersedes',memoryId:original.id,fingerprint:original.fingerprint,version:original.version}]}]);
  const reviewed=await reviewMemory({question:'Generated review',contextTime:later},candidate,async()=>({...candidate,runId:randomUUID()}));
  const replacement=node.memories.extract(fixtureMemoryResult(node.memories,reviewed),'generated',{reviewReceipt:memoryReviewReceipt(reviewed)}).items[0];assert.equal(node.memories.get(original.id).supersededAt,explicit);
  const corrected=await node.memories.correct(replacement.id,{version:replacement.version,title:'Generated owner correction',statement:'Generated owner statement'});realTime(corrected.validFrom,start);assert.equal(node.memories.get(replacement.id).supersededAt,corrected.validFrom);
});
