import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildContextEnvelope,parseAnswer,type QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {TaskRecords} from '../src/task-records.js';
import {readCurrentMemoryPage} from '../src/current-memory.js';
import {authorizeFixtureModels,fixtureTopicResult} from './fixtures/model-authorization.js';
import {fixtureMemoryWorkResult} from './fixtures/memory-planning.js';
import {RANGE_SELECTION_PERSONAL_RECIPE,SINGLE_PASS_PERSONAL_RECIPE} from '../src/memory-range-selection-policy.js';

const headers={authorization:'Bearer generated-current-memory-owner'};
async function fixture(t:TestContext,query:(input:QueryInput)=>Promise<any>=async()=>({answer:'Generated answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}}),overrides:Partial<Config>={}){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-current-memory-'));
 const config:Config={dataDir,token:'generated-current-memory-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1000000,insightIntervalHours:0,allowedOrigins:[],model:'generated',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',...overrides};
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

for(const recipe of [RANGE_SELECTION_PERSONAL_RECIPE,SINGLE_PASS_PERSONAL_RECIPE])test(`${recipe.id} publishes explicit standing choices and the real chat keeps every paged item without original rereads`,async t=>{
 let generated:{text:string;standing:boolean;thirdParty?:boolean}[]=[],extracts=0,reviews=0,chats=0;const seen:QueryInput[]=[];
 const f=await fixture(t,async input=>{
  const topic=fixtureTopicResult(input);if(topic)return topic;
  if(input.responseMode==='memory-extraction'){
   if(input.traceContext?.phase==='review')reviews++;else extracts++;
   assert.match(input.question,/contextPriority/);
   const id=input.evidenceIds![0],record=f.node.memories.readEvidence([id])[0];
   const memories=generated.map((entry,index)=>({domain:'personal',title:'Generated context '+index,statement:entry.text+` [${id}]`,uncertainty:index===0?'Generated applicability uncertainty. '.repeat(16)+'UNCERTAINTY TAIL':'Generated uncertainty',
    admission:{layer:'memory',reason:'Generated explicit model choice',scope:entry.thirdParty?'Only the generated third-party speaker':'Only the generated owner project',attribution:entry.thirdParty?'third_party':'user'},
    ...(entry.standing?{contextPriority:'standing'}:{}),evidenceIds:[id],evidence:[{id,quote:entry.text}]}));
   if(input.traceContext?.phase==='review')assert.equal((input.taskContext?.untrustedMemoryDraft as {memories:any[]}).memories.filter(value=>value.contextPriority==='standing').length,generated.filter(value=>value.standing).length);
   return fixtureMemoryWorkResult(input,{answer:JSON.stringify({memories}),citations:[{id,capturedAt:record.capturedAt,appName:record.appName,excerpt:''}],trace:[],runId:randomUUID()});
  }
  chats++;seen.push(input);const envelope=buildContextEnvelope(input,[]);
  assert.match(envelope.memoryLeadInstruction!,/may reason from it directly/);assert.match(envelope.memoryLeadInstruction!,/not that it is an owner instruction, a verified fact or Action authorization/);
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
  const bridge=await startBridge(f.node.featureServices.evidenceReader.agent({diagnostics:f.node.featureServices.diagnostics}),input,6);
  try{
   assert.equal(bridge.records.size,0,'opening context does not manufacture original delivery');
   const answer=parseAnswer(JSON.stringify({answer:'Generated advice using the supplied scoped Memory without a source quotation.',citationIds:[]}),bridge.records);
   return {...answer,trace:[],runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
  }finally{await bridge.close();}
 });
 await authorizeFixtureModels(f.node);
 f.node.sources.register({id:'generated-standing-source',name:'Generated standing originals',kind:'custom',deviceId:'generated-work',platform:'import'});
 const produce=async(externalId:string,entries:typeof generated)=>{
  generated=entries;
  await f.node.sources.upsert('generated-standing-source',{externalId,revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:entries.map(entry=>entry.text).join('\n'),document:{contentRole:'authored'}});
  await f.node.materialOrganizer.tick();await f.node.sourcePipelines.tick();
  const material=f.node.materials.list({sourceId:'generated-standing-source'}).items.find(item=>item.origin.externalId===externalId)!;assert.ok(material);
  const response=await f.node.app.inject({method:'POST',url:'/api/memory-jobs',headers,payload:{evidenceIds:f.node.materials.evidenceIds(material.ref),recipes:[recipe]}});assert.equal(response.statusCode,202,response.body);
  const job=await f.node.memoryPipeline.run(response.json().id);assert.equal(job.status,'completed');return job.memoryIds.map(id=>f.node.memories.get(id));
 };
 const standing=await produce('standing',Array.from({length:103},(_,index)=>({text:index===0?'Generated third-party standing constraint. '+'Scoped applicability detail. '.repeat(32)+'EXACT CONDITION TAIL':`Generated standing owner constraint ${String(index).padStart(3,'0')}.`,standing:true,thirdParty:index===0})));
 assert.equal(standing.length,103);assert.ok(standing.every(value=>value.contextPriority==='standing'&&value.status==='published'));
 const firstPage=await f.node.app.inject({url:'/api/memories?contextPriority=standing&limit=100',headers});assert.equal(firstPage.statusCode,200,firstPage.body);assert.equal(firstPage.json().items.length,100);assert.ok(firstPage.json().nextCursor);
 const secondPage=await f.node.app.inject({url:'/api/memories?contextPriority=standing&limit=100&cursor='+encodeURIComponent(firstPage.json().nextCursor),headers});assert.equal(secondPage.statusCode,200,secondPage.body);assert.equal(secondPage.json().items.length,3);
 await produce('newer-ordinary',Array.from({length:12},(_,index)=>({text:`Generated newer ordinary preference ${index}; no standing selection was made.`,standing:false})));
 assert.equal(extracts,2);assert.equal(reviews,recipe.id===SINGLE_PASS_PERSONAL_RECIPE.id?0:2);
 const configuration=(await f.node.app.inject({url:'/api/configuration',headers})).json();
 const capacity=await f.node.app.inject({method:'PUT',url:'/api/configuration/conversations',headers,payload:{revision:configuration.revision,value:{context:{contextWindow:256000,contextWindowSource:'configured'}}}});assert.equal(capacity.statusCode,200,capacity.body);
 const chat=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Give generated project advice from the available context.'}});assert.equal(chat.statusCode,200,chat.body);assert.equal(chats,1);assert.deepEqual(chat.json().citations,[]);
 const input=seen[0],selected=input.openingMemories!.filter(value=>value.contextPriority==='standing');
 assert.deepEqual(new Set(selected.map(value=>value.id)),new Set(standing.map(value=>value.id)));assert.equal(input.openingMemories!.length,108);
 const thirdParty=selected.find(value=>value.id===standing[0].id)!;assert.equal(thirdParty.admission?.attribution,'third_party');assert.equal(thirdParty.statement,standing[0].statement);assert.equal(thirdParty.uncertainty,standing[0].uncertainty);assert.match(thirdParty.statement,/EXACT CONDITION TAIL/);assert.match(thirdParty.uncertainty,/UNCERTAINTY TAIL/);
 assert.ok(standing.every(value=>input.contextEvidenceDependencies?.ids.includes(value.id)));
});

test('complete standing context uses the actual product budget and fails before model dispatch instead of truncating',async t=>{
 let calls=0;const f=await fixture(t,async()=>{calls++;return {answer:'Generated budget answer',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}};},{modelMaxTokens:512});
 const view=(await f.node.app.inject({url:'/api/configuration',headers})).json();
 const configured=await f.node.app.inject({method:'PUT',url:'/api/configuration/conversations',headers,payload:{revision:view.revision,value:{context:{contextWindow:32000,contextWindowSource:'configured'}}}});assert.equal(configured.statusCode,200,configured.body);
 const chat=()=>f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated small request'}});
 assert.equal((await chat()).statusCode,200);assert.equal(calls,1);
 const original=await f.add('Generated standing-budget original.'),statement='Generated complete scoped constraint. '.repeat(13000)+`TAIL MUST REMAIN [${original}]`;
 const memory=f.memory(original,'Generated large standing context',{statement,contextPriority:'standing'}).published;
 const response=await chat();assert.equal(response.statusCode,413,response.body);assert.equal(response.json().error,'too_large');assert.equal(typeof response.json().requestId,'string');assert.equal(calls,1,'a request that cannot hold standing context is rejected before the provider');
 const failure=f.node.queryRuns.list().find(run=>run.status==='failed');assert.ok(failure);assert.equal(failure.error?.diagnostic?.code,'contextWindowExceeded');assert.equal(failure.error?.diagnostic?.stage,'validation');
 assert.equal(f.node.memories.get(memory.id).statement,statement);assert.equal(f.node.memories.get(memory.id).status,'published');
});

test('standing is an explicit fingerprinted choice and owner correction preserves it until explicitly cleared',async t=>{
 const seen:QueryInput[]=[],f=await fixture(t,async input=>{seen.push(input);return {answer:'Generated scoped advice',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:input.contextEvidenceDependencies};});
 const original=await f.add('Generated owner constraint.'),standing=f.memory(original,'Generated constraint',{contextPriority:'standing'}).published;
 const normal=f.memory(original,'Generated same statement without standing').published;assert.notEqual(standing.fingerprint,normal.fingerprint);assert.equal(normal.contextPriority,undefined);
 const correct=async(id:string,version:number,contextPriority?:null)=>{
  const response=await f.node.app.inject({method:'POST',url:'/api/memories/'+id+'/correct',headers,payload:{version,title:'Generated corrected constraint',statement:'Generated revised applicability. '+'Complete limitation. '.repeat(45)+'TAIL CONDITION',...(contextPriority===null?{contextPriority:null}:{})}});
  assert.equal(response.statusCode,200,response.body);return response.json();
 };
 const current=await correct(standing.id,standing.version);assert.equal(current.contextPriority,'standing');
 const response=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated revised advice'}});assert.equal(response.statusCode,200,response.body);
 assert.ok(seen.at(-1)!.openingMemories?.some(item=>item.id===current.id&&item.contextPriority==='standing'&&item.statement===current.statement));assert.ok(!seen.at(-1)!.openingMemories?.some(item=>item.id===standing.id));
 const cleared=await correct(current.id,current.version,null);assert.equal(cleared.contextPriority,undefined);
 assert.equal((await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'all'},{contextPriority:'standing'})).items.length,0,'clearing is explicit and does not infer another standing item from its wording or kind');
 assert.throws(()=>f.memory(original,'Generated observation cannot become standing',{contextPriority:'standing',admission:{layer:'observation',reason:'Generated observation',scope:'Only the generated record',attribution:'observed'}}),/Standing context requires selected memory/);
});

for(const mutation of ['correct','forget','source-version','privacy-revoke'] as const)test(`an already admitted standing context cannot publish a late answer after ${mutation}`,async t=>{
 let entered!:()=>void,release!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
 const f=await fixture(t,async input=>{assert.ok(input.openingMemories?.some(item=>item.contextPriority==='standing'));entered();await held;return {answer:'GENERATED_STALE_STANDING_ADVICE',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:input.contextEvidenceDependencies};});
 t.after(()=>release());
 f.node.sources.register({id:'generated-standing-fence',name:'Generated standing source',kind:'custom',deviceId:'generated',platform:'import'});
 const item={externalId:'constraint',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message' as const,layer:'original' as const,text:'Generated standing project constraint.'},original=await f.node.sources.upsert('generated-standing-fence',item),memory=f.memory(original.id,'Generated standing constraint',{contextPriority:'standing'}).published;
 const id=randomUUID(),accepted=await f.node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated standing advice'}}});assert.equal(accepted.statusCode,202,accepted.body);await started;
 try{
  if(mutation==='correct'){
   const response=await f.node.app.inject({method:'POST',url:'/api/memories/'+memory.id+'/correct',headers,payload:{version:memory.version,title:'Generated updated standing constraint',statement:'The generated constraint changed.'}});assert.equal(response.statusCode,200,response.body);
  }else if(mutation==='forget'){
   const response=await f.node.app.inject({method:'DELETE',url:'/api/memories/'+memory.id,headers});assert.equal(response.statusCode,200,response.body);
  }else if(mutation==='source-version')await f.node.sources.upsert('generated-standing-fence',{...item,revision:'2',text:'Generated replacement constraint.'});
  else f.node.store.db.prepare("UPDATE captures SET json=json_set(json,'$.privacy.excluded',json('true')) WHERE id=?").run(original.id);
 }finally{release();}
 let run=f.node.queryRuns.get(id);for(let attempt=0;attempt<100&&run.status==='running';attempt++){await new Promise<void>(resolve=>setImmediate(resolve));run=f.node.queryRuns.get(id);}
 assert.notEqual(run.status,'completed',JSON.stringify(run));assert.doesNotMatch(JSON.stringify(run),/GENERATED_STALE_STANDING_ADVICE/);assert.equal(f.node.delegation.result('query:'+id),undefined);
 assert.equal(f.node.featureServices.evidenceReader.currentMemoryLeadsAllowed([{id:memory.id,title:memory.title,statement:memory.statement,uncertainty:memory.uncertainty,contextPriority:'standing',status:'published',tier:memory.tier,createdAt:memory.createdAt,admission:{scope:memory.admission.scope,attribution:memory.admission.attribution}}]),false);
});

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
 const workMemory=f.memory(work,'Generated work title',{contextPriority:'standing'}).published,lifeMemory=f.memory(life,'Generated private title',{contextPriority:'standing'}).published;
 const mixedRaw={answer:JSON.stringify({memories:[{title:'Generated mixed private title',statement:`Generated combined statement [${work}] [${life}]`,uncertainty:'Generated',contextPriority:'standing',evidenceIds:[work,life]}]}),citations:[work,life].map(id=>({id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',excerpt:''})),trace:[],runId:randomUUID()};
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
 const f=await fixture(t),a=await f.add('Generated Monday plan.'),b=await f.add('Generated rescheduled plan.'),old=f.memory(a,'Generated Monday',{contextPriority:'standing',validFrom:'2026-10-01T00:00:00Z'}).published;
 const raw=fixtureMemoryResult(f.node.memories,{answer:JSON.stringify({memories:[{title:'Generated Tuesday plan',contextPriority:'standing',statement:`The generated plan was moved to Tuesday [${a}] [${b}]`,uncertainty:'Whether it happened is unknown.',validFrom:'2026-10-02T00:00:00Z',validUntil:'2026-10-03T00:00:00Z',evidenceIds:[a,b],relations:[{kind:'supersedes',memoryId:old.id,fingerprint:old.fingerprint,version:old.version}]}]}),citations:[a,b].map(id=>({id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',excerpt:''})),trace:[],runId:randomUUID()});
 const draft=f.node.memories.extract(raw,'generated').items[0]!,next=f.node.memories.publish(draft.id,draft.version);
 const at=async(value:string,history=false)=>(await f.node.app.inject({url:`/api/memories?status=published&asOf=${encodeURIComponent(value)}${history?'&includeHistory=true':''}`,headers})).json().items;
 assert.deepEqual((await at('2026-10-01T12:00:00Z')).map((item:any)=>item.id),[old.id]);
 assert.deepEqual((await at('2026-10-02T12:00:00Z')).map((item:any)=>item.id),[next.id]);
 assert.deepEqual(await at('2026-10-04T00:00:00Z'),[]);
 assert.deepEqual((await readCurrentMemoryPage(f.node.featureServices.evidenceReader,{kind:'all'},{contextPriority:'standing',asOf:'2026-10-04T00:00:00Z'})).items,[],'expired standing context is not retained as a current constraint');
 const history=await at('2026-10-04T00:00:00Z',true);assert.equal(history.length,2);assert.equal(f.node.memories.get(next.id).uncertainty,'Whether it happened is unknown.');assert.doesNotMatch(f.node.memories.get(next.id).statement,/completed/i);
});

test('exact reviewed replay deduplicates and an empty model selection is a valid result for one saved item',async t=>{
 const f=await fixture(t),id=await f.add('Generated item saved once.');
 const empty=f.node.memories.extract({answer:'{"memories":[]}',citations:[{id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',excerpt:'Generated item saved once.'}],trace:[],runId:randomUUID()},'generated');assert.deepEqual(empty.items,[]);assert.equal(f.node.memories.count(),0);
 const saved=f.memory(id,'Generated saved item');
 const repeated=f.node.memories.extract(fixtureMemoryResult(f.node.memories,saved.raw),'generated');assert.equal(repeated.items[0].id,saved.published.id);assert.equal(f.node.memories.count(),1);
});
