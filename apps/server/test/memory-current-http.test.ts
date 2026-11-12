import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {TaskRecords} from '../src/task-records.js';
import {readCurrentMemoryPage} from '../src/current-memory.js';

const headers={authorization:'Bearer generated-current-memory-owner'};
async function fixture(t:TestContext,query:(input:QueryInput)=>Promise<any>=async()=>({answer:'Generated answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}})){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-current-memory-'));
 const config:Config={dataDir,token:'generated-current-memory-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,query,close:async()=>{}}});await node.app.ready();
 t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 const add=async(text:string,deviceId='generated-work')=>{
  const id=randomUUID(),capturedAt='2026-10-01T00:00:00.000Z';
  const response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId,deviceName:'Generated device',platform:'import',capturedAt,text}});assert.equal(response.statusCode,201,response.body);
  return id;
 };
 const memory=(id:string,title:string,extra:Record<string,unknown>={})=>{
  const record=node.store.evidence([id])[0]!;
  const raw={answer:JSON.stringify({memories:[{title,statement:`${record.ocrText} [${id}]`,uncertainty:'Generated fixture',evidenceIds:[id],...extra}]}),citations:[{id,capturedAt:record.capturedAt,appName:'Generated',excerpt:record.ocrText}],trace:[],runId:randomUUID()};
  const draft=node.memories.extract(fixtureMemoryResult(node.memories,raw),'generated').items[0]!;
  return {draft,published:node.memories.publish(draft.id,draft.version),raw};
 };
 return {node,add,memory};
}

test('the correction API invalidates dependent frozen work and the next real chat reads the new version',async t=>{
 const calls:QueryInput[]=[];
 const f=await fixture(t,async input=>{calls.push(input);return {answer:'Generated answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}};});
 const id=await f.add('The generated appointment is on Monday.'),old=f.memory(id,'Generated Monday appointment').published;
 const chat=async()=>{const response=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'What is the generated appointment?'}});assert.equal(response.statusCode,200,response.body);return response.json();};
 const before=await chat();assert.ok(calls.at(-1)!.openingMemories?.some(item=>item.id===old.id));
 const previousChange=Number(f.node.store.db.prepare('SELECT coalesce(max(seq),0) n FROM changes').get()!.n);
 const tasks=new TaskRecords(f.node.store),task=tasks.create({operationId:randomUUID(),kind:'generated.review',requestId:randomUUID(),input:{body:'Generated old appointment'},evidenceDependencies:{version:1,complete:true,ids:[old.id]}},()=>{});
 const corrected=await f.node.app.inject({method:'POST',url:`/api/memories/${old.id}/correct`,headers,payload:{version:old.version,title:'Generated Tuesday appointment',statement:'The appointment was moved to Tuesday.'}});assert.equal(corrected.statusCode,200,corrected.body);
 const next=corrected.json();assert.equal(f.node.store.evidence([next.correction.noteId])[0].ocrText,'The appointment was moved to Tuesday.');
 assert.ok(f.node.store.db.prepare("SELECT 1 FROM changes WHERE seq>? AND id=? AND operation='upsert'").get(previousChange,next.correction.noteId),'the existing change stream records the new owner evidence');
 assert.ok(f.node.store.db.prepare("SELECT 1 FROM memory_events WHERE stream='memory' AND entity=?").get(next.id),'the existing Memory stream records the current revision');
 assert.equal(tasks.get(task.id).state,'stale');assert.equal(f.node.store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(task.id)!.input_json,null);
 assert.throws(()=>tasks.saveResult(task.id,task.revision,{answer:'Generated late Monday result'},{version:1,complete:true,ids:[old.id]},()=>{}),{statusCode:409});
 const prior=f.node.conversations.get(before.conversationId);assert.equal(prior.turns[0].evidenceStale,true);
 await chat();assert.ok(calls.at(-1)!.openingMemories?.some(item=>item.id===next.id));assert.ok(!calls.at(-1)!.openingMemories?.some(item=>item.id===old.id));
 const forAssistant=await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'all'},{level:'detail'});assert.deepEqual(forAssistant.items.map(item=>item.id),[next.id]);assert.match(forAssistant.items[0].statement,/moved to Tuesday/);
 const page=await f.node.app.inject({url:'/api/memories?status=published',headers});assert.equal(page.statusCode,200,page.body);assert.deepEqual(page.json().items.map((item:any)=>item.id),[next.id]);
});

test('forgetting a Memory clears the K3 task input that used the Memory and fences late results',async t=>{
 const f=await fixture(t),id=await f.add('Generated retained original.'),memory=f.memory(id,'Generated fact').published,tasks=new TaskRecords(f.node.store);
 const task=tasks.create({operationId:randomUUID(),kind:'generated.review',requestId:randomUUID(),input:{body:memory.statement},evidenceDependencies:{version:1,complete:true,ids:[memory.id]}},()=>{});
 const removed=await f.node.app.inject({method:'DELETE',url:`/api/memories/${memory.id}`,headers});assert.equal(removed.statusCode,200,removed.body);
 assert.equal(tasks.get(task.id).state,'stale');assert.equal(f.node.store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(task.id)!.input_json,null);
 assert.throws(()=>tasks.saveResult(task.id,task.revision,{}, {version:1,complete:true,ids:[memory.id]},()=>{}),{statusCode:409});
});

test('topic catalog does not disclose labels derived from memories outside the requested device scope',async t=>{
 const f=await fixture(t),work=await f.add('Generated work context.','generated-work'),life=await f.add('Generated private life context.','generated-life');
 const a=f.memory(work,'Generated work memory').published,b=f.memory(life,'Generated private memory').published;
 const registry=f.node.featureServices.contextTrees,topics=registry.automatic!;
 const removePerson=registry.register({id:'generated.person',version:'1',label:'GENERATED_PRIVATE_PERSON',nodes:[{id:'person',label:'GENERATED_PRIVATE_PERSON_NODE',select:{memoryIds:[b.id]}}]});t.after(removePerson);
 const dispose=topics.register({id:'generated.scope',version:'1',classify:async()=>({trees:[{id:'mixed',label:'GENERATED_PRIVATE_TOPIC',nodes:[{id:'work',label:'GENERATED_PRIVATE_NODE',memoryIds:[a.id]}]}]})});t.after(dispose);
 await topics.classify({operationId:randomUUID(),classifierId:'generated.scope',memoryIds:[a.id,b.id]},{admissionId:'generated',signal:new AbortController().signal,assertCurrent:()=>{}});
 const all=await f.node.app.inject({url:'/api/context-trees',headers});assert.match(all.body,/GENERATED_PRIVATE_TOPIC/);assert.match(all.body,/GENERATED_PRIVATE_PERSON/);
 const scoped=await f.node.app.inject({url:'/api/context-trees?deviceId=generated-work',headers});assert.equal(scoped.statusCode,200,scoped.body);assert.doesNotMatch(scoped.body,/GENERATED_PRIVATE_TOPIC|GENERATED_PRIVATE_NODE|GENERATED_PRIVATE_PERSON/);
 const tree=all.json().items.find((item:any)=>item.label==='GENERATED_PRIVATE_TOPIC');
 const hiddenNode=await f.node.app.inject({url:`/api/context-trees/${tree.id}/nodes/work?deviceId=generated-work`,headers});assert.equal(hiddenNode.statusCode,404,hiddenNode.body);
 const hiddenPerson=await f.node.app.inject({url:'/api/context-trees/generated.person/nodes/person?deviceId=generated-work',headers});assert.equal(hiddenPerson.statusCode,404,hiddenPerson.body);
 const page=await f.node.app.inject({url:'/api/memories?deviceId=generated-work',headers});assert.equal(page.statusCode,200,page.body);assert.match(page.body,/Generated work memory/);assert.doesNotMatch(page.body,/Generated private memory/);assert.equal(page.json().items.length,1);
});

test('the shared current reader paginates and intersects source and evidence selections without mixed-scope leaks',async t=>{
 const seen:QueryInput[]=[],f=await fixture(t,async input=>{seen.push(input);return {answer:'Generated answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}};});
 for(const id of ['generated-work-source','generated-life-source'])f.node.sources.register({id,name:id,kind:'custom',deviceId:'generated',platform:'import'});
 const work=(await f.node.sources.upsert('generated-work-source',{externalId:'work',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated work original.'})).id;
 const life=(await f.node.sources.upsert('generated-life-source',{externalId:'life',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated private life original.'})).id;
 const workMemory=f.memory(work,'Generated work title').published,lifeMemory=f.memory(life,'Generated private title').published;
 const mixedRaw={answer:JSON.stringify({memories:[{title:'Generated mixed private title',statement:`Generated combined statement [${work}] [${life}]`,uncertainty:'Generated',evidenceIds:[work,life]}]}),citations:[work,life].map(id=>({id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',excerpt:''})),trace:[],runId:randomUUID()};
 const mixed=f.node.memories.extract(fixtureMemoryResult(f.node.memories,mixedRaw),'generated').items[0]!;f.node.memories.publish(mixed.id,mixed.version);
 const reader=f.node.featureServices.evidenceReader;
 const first=await readCurrentMemoryPage(reader,{kind:'all'},{limit:1});assert.equal(first.items.length,1);assert.ok(first.nextCursor);
 const second=await readCurrentMemoryPage(reader,{kind:'all'},{limit:1,cursor:first.nextCursor!});assert.equal(second.items.length,1);assert.notEqual(first.items[0].id,second.items[0].id);
 for(const scope of [{kind:'selection' as const,sourceIds:['generated-work-source']},{kind:'selection' as const,evidenceIds:[work]},{kind:'selection' as const,sourceIds:['generated-work-source'],evidenceIds:[work]}]){
  const page=await readCurrentMemoryPage(reader,scope,{level:'detail',limit:10});assert.deepEqual(page.items.map(item=>item.id),[workMemory.id]);assert.doesNotMatch(JSON.stringify(page),/private life|private title|mixed private/i);
 }
 for(const scope of [{kind:'selection' as const,sourceIds:[]},{kind:'selection' as const,evidenceIds:[]},{kind:'selection' as const,sourceIds:['generated-work-source'],evidenceIds:[life]}])assert.deepEqual((await readCurrentMemoryPage(reader,scope)).items,[]);
 const response=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated work only',evidenceIds:[work]}});assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(seen.at(-1)!.openingMemories?.map(item=>item.id),[workMemory.id]);assert.doesNotMatch(JSON.stringify(seen.at(-1)!.openingMemories),/private|mixed/i);
 assert.ok(!seen.at(-1)!.contextEvidenceDependencies?.ids.includes(lifeMemory.id));
});

test('a correction fences an already running chat before its old answer can publish',async t=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const f=await fixture(t,async()=>{entered();await gate;return {answer:'GENERATED_OBSOLETE_ANSWER',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}};});t.after(()=>release());
 const original=await f.add('Generated booking for Monday.'),old=f.memory(original,'Generated booking').published,id=randomUUID();
 const accepted=await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated booking question'}}});assert.equal(accepted.statusCode,202,accepted.body);await started;
 const corrected=await f.node.app.inject({method:'POST',url:`/api/memories/${old.id}/correct`,headers,payload:{version:old.version,title:'Generated cancelled booking',statement:'The booking was cancelled.'}});assert.equal(corrected.statusCode,200,corrected.body);release();
 let status:any;for(let n=0;n<100;n++){const response=await f.node.app.inject({url:`/api/query-runs/${id}`,headers});status=response.json();if(status.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.notEqual(status.status,'completed',JSON.stringify(status));assert.doesNotMatch(JSON.stringify(status),/GENERATED_OBSOLETE_ANSWER/);
});

for(const mutation of ['correct','forget'] as const)test(`${mutation} invalidates dependent consolidations and their frozen task inputs`,async t=>{
 const f=await fixture(t),id=await f.add('Generated owner appointment.'),old=f.memory(id,'Generated appointment').published;
 const raw=fixtureMemoryResult(f.node.memories,{answer:JSON.stringify({memories:[{title:'Generated combined interpretation',statement:`The generated appointment has a related constraint [${id}]`,uncertainty:'Generated',evidenceIds:[id],relatedMemoryIds:[old.id]}]}),citations:[{id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',excerpt:''}],trace:[],runId:randomUUID()});
 const options={tier:'consolidated' as const,relatedMemoryIds:[old.id]},draft=f.node.memories.extract(raw,'generated',options).items[0]!,child=f.node.memories.publish(draft.id,draft.version),tasks=new TaskRecords(f.node.store);
 const task=tasks.create({operationId:randomUUID(),kind:'generated.review',requestId:randomUUID(),input:{body:child.statement},evidenceDependencies:{version:1,complete:true,ids:[child.id]}},()=>{});
 const response=mutation==='correct'?await f.node.app.inject({method:'POST',url:`/api/memories/${old.id}/correct`,headers,payload:{version:old.version,title:'Generated corrected',statement:'The generated appointment was cancelled.'}}):await f.node.app.inject({method:'DELETE',url:`/api/memories/${old.id}`,headers});assert.equal(response.statusCode,200,response.body);
 assert.equal(f.node.memories.get(child.id).status,'stale');assert.equal(tasks.get(task.id).state,'stale');assert.equal(f.node.store.db.prepare('SELECT input_json FROM task_records WHERE id=?').get(task.id)!.input_json,null);
 assert.throws(()=>f.node.memories.extract(raw,'generated',options));
});

test('correction removes only dependent stored insight bodies and leaves independent reports available',async t=>{
 const f=await fixture(t),id=await f.add('Generated appointment.'),old=f.memory(id,'Generated appointment').published;
 const create=async(dependencies:string[],answer:string)=>{const reportId=randomUUID();await f.node.insightRuns.perform(randomUUID(),{},async()=>({runId:reportId,answer,citations:[],trace:[],evidenceDependencies:{version:1,complete:true,ids:dependencies}}));return reportId;};
 const dependent=await create([old.id],'GENERATED_OUTDATED_INSIGHT'),independent=await create([],'GENERATED_INDEPENDENT_INSIGHT');
 assert.equal((await f.node.app.inject({url:`/api/insights/${dependent}`,headers})).statusCode,200);
 const response=await f.node.app.inject({method:'POST',url:`/api/memories/${old.id}/correct`,headers,payload:{version:old.version,title:'Generated cancellation',statement:'The appointment was cancelled.'}});assert.equal(response.statusCode,200,response.body);
 assert.equal((await f.node.app.inject({url:`/api/insights/${dependent}`,headers})).statusCode,404);
 const remaining=await f.node.app.inject({url:'/api/insights',headers});assert.equal(remaining.statusCode,200,remaining.body);assert.match(remaining.body,/GENERATED_INDEPENDENT_INSIGHT/);assert.doesNotMatch(remaining.body,/GENERATED_OUTDATED_INSIGHT/);
 assert.equal((await f.node.app.inject({url:`/api/insights/${independent}`,headers})).statusCode,200);
});

test('rescheduling and expiry preserve history without treating a past plan as completed',async t=>{
 const f=await fixture(t),a=await f.add('Generated Monday plan.'),b=await f.add('Generated rescheduled plan.'),old=f.memory(a,'Generated Monday',{validFrom:'2026-10-01T00:00:00Z'}).published;
 const raw=fixtureMemoryResult(f.node.memories,{answer:JSON.stringify({memories:[{title:'Generated Tuesday plan',statement:`The generated plan was moved to Tuesday [${a}] [${b}]`,uncertainty:'Whether it happened is unknown.',validFrom:'2026-10-02T00:00:00Z',validUntil:'2026-10-03T00:00:00Z',evidenceIds:[a,b],relations:[{kind:'supersedes',memoryId:old.id,fingerprint:old.fingerprint,version:old.version}]}]}),citations:[a,b].map(id=>({id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',excerpt:''})),trace:[],runId:randomUUID()});
 const draft=f.node.memories.extract(raw,'generated').items[0]!,next=f.node.memories.publish(draft.id,draft.version);
 const at=async(value:string,history=false)=>(await f.node.app.inject({url:`/api/memories?status=published&asOf=${encodeURIComponent(value)}${history?'&includeHistory=true':''}`,headers})).json().items;
 assert.deepEqual((await at('2026-10-01T12:00:00Z')).map((item:any)=>item.id),[old.id]);
 assert.deepEqual((await at('2026-10-02T12:00:00Z')).map((item:any)=>item.id),[next.id]);
 assert.deepEqual(await at('2026-10-04T00:00:00Z'),[]);
 const history=await at('2026-10-04T00:00:00Z',true);assert.equal(history.length,2);assert.equal(f.node.memories.get(next.id).uncertainty,'Whether it happened is unknown.');assert.doesNotMatch(f.node.memories.get(next.id).statement,/completed/i);
});

test('exact reviewed replay deduplicates and an empty model selection is a valid result for one saved item',async t=>{
 const f=await fixture(t),id=await f.add('Generated item saved once.');
 const empty=f.node.memories.extract({answer:'{"memories":[]}',citations:[{id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',excerpt:'Generated item saved once.'}],trace:[],runId:randomUUID()},'generated');assert.deepEqual(empty.items,[]);assert.equal(f.node.memories.count(),0);
 const saved=f.memory(id,'Generated saved item');
 const repeated=f.node.memories.extract(fixtureMemoryResult(f.node.memories,saved.raw),'generated');assert.equal(repeated.items[0].id,saved.published.id);assert.equal(f.node.memories.count(),1);
});
