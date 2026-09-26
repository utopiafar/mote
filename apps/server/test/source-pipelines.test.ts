import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {sourceItemSchema} from '@mote/shared';

const item=(i:number,session='session-a',text='Generated user requirement and tool result.')=>({externalId:'event-'+i,revision:'1',observedAt:'2026-09-24T01:00:00.000Z',kind:'message',layer:'snapshot',text,document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:session,projectKey:'generated-project',eventId:String(i).padStart(6,'0'),role:'user',part:0,parts:1}}});
async function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-source-pipeline-')),store=new Store(directory),materials=new MaterialStore(store);
  const runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated Coding',kind:'coding-agent',deviceId:'device',platform:'macos'});
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials);
  t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});return {directory,store,materials,runtime,sources,reader};
}
function intercept(runtime:SourcePipelineRuntime,hook:NonNullable<import('../src/source-pipelines.js').SourcePipeline['organize']>){
  const original=runtime.registry.get('mote.coding')!;
  const {recipe:_,...legacy}=original;
  const unregister=runtime.registry.register({...legacy,id:'fixture.interceptor',priority:1,organize:hook});
  runtime.configure('coding',{pipelineId:'fixture.interceptor',memory:false,settleSeconds:0});
  return {original,unregister};
}
test('a receipt arriving during organization invalidates the draft before publication',async t=>{
  const {store,materials,runtime,sources}=await fixture(t);
  let received=false;
  const {original}=intercept(runtime,input=>{
    if(!received){received=true;runtime.receive(sources.getSource('coding'),[sourceItemSchema.parse(item(2,'session-a','New generated input'))],()=>{});}
    return original.organize!(input);
  });
  await sources.upsert('coding',item(1,'session-a','Old generated input'));
  const before=store.db.prepare('SELECT generation FROM source_pipeline_work').get()!;
  await runtime.tick();
  assert.equal(materials.list().items.length,0);
  const pending=store.db.prepare('SELECT state,generation FROM source_pipeline_work').get()!;
  assert.equal(pending.state,'pending');assert.ok(Number(pending.generation)>Number(before.generation));
  await runtime.tick();const published=materials.list().items[0];assert.ok(published);
  const body=materials.read(published.ref,{length:12000}).text;
  assert.match(body,/Old generated input/);assert.match(body,/New generated input/);
});
test('rolled-back archive receive leaves its batch unreferenced until a committed retry',async t=>{
  const {store,materials,runtime,sources}=await fixture(t);
  await sources.upsert('coding',item(1,'session-a','Committed generated input'));
  const orphan=sourceItemSchema.parse(item(2,'session-a','Orphan generated input'));
  const group=runtime.registry.get('mote.coding')!.group!(orphan);
  store.db.exec('BEGIN IMMEDIATE');runtime.archive.receive('coding',[orphan],[group]);store.db.exec('ROLLBACK');
  await runtime.tick();const committed=materials.list().items[0];assert.ok(committed);
  assert.match(materials.read(committed.ref,{length:12000}).text,/Committed generated input/);
  assert.doesNotMatch(materials.read(committed.ref,{length:12000}).text,/Orphan generated input/);
  assert.equal(store.db.prepare('SELECT state FROM source_pipeline_work').get()!.state,'complete');
  assert.equal((await sources.upsert('coding',orphan)).duplicate,false);await runtime.tick();
  const published=materials.list().items[0];assert.ok(published);
  assert.match(materials.read(published.ref,{length:12000}).text,/Orphan generated input/);
});
test('configuration and plugin changes during organization leave newer work untouched',async t=>{
  const {store,materials,runtime,sources}=await fixture(t);
  let reconfigured=false;
  const {original}=intercept(runtime,input=>{
    if(!reconfigured){reconfigured=true;runtime.configure('coding',{pipelineId:'fixture.interceptor',index:false,memory:false,settleSeconds:0});}
    return original.organize!(input);
  });
  await sources.upsert('coding',item(1));await runtime.tick();
  assert.equal(materials.list().items.length,0);
  assert.equal(store.db.prepare('SELECT state FROM source_pipeline_work').get()!.state,'pending');
  await runtime.tick();assert.equal(materials.list().items.length,1);
  assert.equal(materials.list({query:'Generated'}).items.length,0);

  let uninstall=false;let unregister=()=>{};
  const {recipe:_,...legacy}=original;
  const next=runtime.registry.register({...legacy,id:'fixture.uninstall',priority:2,organize:input=>{
    if(!uninstall){uninstall=true;unregister();}return original.organize!(input);
  }});unregister=next;
  runtime.configure('coding',{pipelineId:'fixture.uninstall',memory:false});
  await runtime.tick();
  assert.equal(materials.list().items[0].title,'session-a');
  assert.equal(store.db.prepare('SELECT state FROM source_pipeline_work').get()!.state,'blocked');
  await runtime.tick();assert.equal(store.db.prepare('SELECT state FROM source_pipeline_work').get()!.state,'blocked');
});
test('forget during organization cannot resurrect erased source material',async t=>{
  const {materials,runtime,sources,store}=await fixture(t);
  const {original}=intercept(runtime,input=>{runtime.forget('coding');return original.organize!(input);});
  await sources.upsert('coding',item(1));await runtime.tick();
  assert.equal(materials.list().items.length,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM source_pipeline_work').get()!.n,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM source_archive_sizes').get()!.n,0);
});
test('pipeline version change during organization waits for the new version',async t=>{
  const {materials,runtime,sources,store}=await fixture(t);
  let updated=false;
  const {original}=intercept(runtime,input=>{
    if(!updated){updated=true;runtime.registry.get('fixture.interceptor')!.version='6';}
    return original.organize!(input);
  });
  await sources.upsert('coding',item(1));await runtime.tick();
  assert.equal(materials.list().items.length,0);
  assert.equal(store.db.prepare('SELECT version FROM source_pipeline_work').get()!.version,'5');
  await runtime.tick();assert.equal(materials.list().items.length,1);
  assert.equal(store.db.prepare('SELECT version FROM source_pipeline_work').get()!.version,'6');
});
test('1,000 raw events remain file-only; complete conversation is indexed and cited by material sections',async t=>{
  const {store,materials,runtime,sources,reader}=await fixture(t);
  for(let offset=0;offset<1000;offset+=500)await sources.upsertBatch('coding',Array.from({length:500},(_,i)=>item(offset+i,'session-a',`Unique generated event ${offset+i}. `+'abcd '.repeat(90))));
  for(const table of ['captures','source_versions','source_heads','context_observations','captures_fts','captures_trigram'])assert.equal(store.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n,0,table);
  assert.equal(store.db.prepare('SELECT count(*) n FROM source_pipeline_work').get()!.n,1);
  assert.equal(materials.list().items.length,0);await runtime.tick();
  const material=materials.list({query:'Unique generated event'}).items[0];assert.ok(material);assert.equal(material.coverage.state,'complete');assert.ok(material.textLength>400_000);
  let text='',offset=0;do{const page=materials.read(material.ref,{offset,length:12000});text+=page.text;if(page.textRange.nextOffset===null)break;assert.ok(page.textRange.nextOffset>offset);offset=page.textRange.nextOffset;}while(true);
  assert.ok(text.includes('Unique generated event 0.'));assert.ok(text.includes('Unique generated event 999.'));assert.equal(materials.list().items.length,1);
  const page=reader.materialRead({ref:material.ref});assert.ok(page.originalRefs.length);const evidence=reader.evidence(page.originalRefs);assert.ok(evidence[0].ocrText.startsWith('# Coding conversation'));assert.ok(reader.memories.isCurrentEvidence(evidence[0].id));
  assert.equal(reader.materialCatalog({deviceId:'other'}).items.length,0);assert.equal(reader.materialCatalog({sourceId:'other'}).items.length,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM material_fts_blocks').get()!.n,material.blockCount);
});
test('retry, crash/reopen, conflicting revision, and atomic publication preserve receipts',async t=>{
  const {store,materials,runtime,sources,directory}=await fixture(t);
  const first=await sources.upsert('coding',item(1));assert.equal(first.duplicate,false);
  assert.equal((await sources.upsert('coding',item(1))).duplicate,true);
  await assert.rejects(sources.upsert('coding',item(1,'session-a','conflicting')),/different content/);
  // Another process connection reads durable pending work and publishes after restart.
  const other=new Store(directory),otherMaterials=new MaterialStore(other),reopened=new SourcePipelineRuntime(other,otherMaterials,[codingSourcePlugin]);await reopened.ready;
  await reopened.tick();assert.equal(otherMaterials.list().items.length,1);await reopened.close();other.close();
  const before=materials.list().items[0];const ids=materials.evidenceIds(before.ref);
  await sources.upsert('coding',item(2));await runtime.tick();const after=materials.list().items[0];assert.notEqual(after.revision,before.revision);assert.equal(after.sequence,2);assert.equal(materials.isCurrentEvidence(ids[0]),false);
  assert.ok(materials.get(before.ref));assert.ok(Number(store.db.prepare('SELECT count(*) n FROM material_fts_blocks').get()!.n)>=after.blockCount);
});
test('Cordis uninstall blocks archive work, ordinary records stay supported, index can be disabled',async t=>{
  const {store,materials,runtime,sources}=await fixture(t);
  sources.register({id:'notes',name:'Generated notes',kind:'upload',deviceId:'device',platform:'import'});
  await sources.upsert('notes',{externalId:'note',revision:'1',observedAt:'2026-09-24T01:00:00Z',kind:'file',layer:'snapshot',text:'ordinary record'});
  assert.equal(store.db.prepare('SELECT count(*) n FROM captures').get()!.n,1);
  await sources.upsert('coding',item(1));runtime.configure('coding',{index:false,memory:false,settleSeconds:0});await runtime.tick();assert.equal(materials.list({query:'Generated'}).items.length,0);
  await runtime.close();await assert.rejects(sources.upsert('coding',item(2)),/unavailable/);
  const empty=new SourcePipelineRuntime(store,materials);await empty.ready;await assert.rejects(new SourceStore(store,empty).upsert('coding',item(2)),/unavailable/);await empty.close();
});
test('model extraction first reads the assembled conversation, never raw upload records',async t=>{
  const {store,materials,runtime,sources,reader}=await fixture(t);runtime.configure('coding',{settleSeconds:0});
  await sources.upsertBatch('coding',[item(1),item(2,'session-a','Second generated message.')]);await runtime.tick();
  let calls=0;const pipeline=new MemoryPipeline({store,memories:reader.memories,materialAllowedForMemory:ref=>reader.materialAllowedForMemory(ref),configured:()=>true,model:()=> 'fixture',query:async input=>{
    calls++;assert.equal(input.skill,'coding-memory');const records=reader.evidence(input.evidenceIds);assert.ok(records[0].ocrText.includes('Second generated message.'));assert.ok(records[0].ocrText.includes('Generated user requirement'));return {answer:'{"memories":[]}',citations:[],trace:[],runId:'fixture'};
  }});
  runtime.drainMemory(pipeline,true);const job=store.db.prepare('SELECT job_id FROM material_memory_work').get()!;assert.ok(job.job_id);await pipeline.run(String(job.job_id));assert.ok(calls>0);await pipeline.close();
  const material=materials.list().items[0];materials.forget(material.id);assert.equal(materials.list({query:'Generated'}).items.length,0);assert.equal(store.db.prepare('SELECT count(*) n FROM material_evidence').get()!.n,0);
});

test('short Chinese search, source revision moves, explicit erasure and stable duplicate heads',async t=>{
  const {materials,runtime,sources,reader,store}=await fixture(t);
  await sources.upsert('coding',item(1,'session-a','中文需求'));await runtime.tick();
  assert.equal(materials.list({query:'中文'}).items.length,1);
  await sources.upsert('coding',{...item(1,'session-b','Moved requirement'),revision:'2',observedAt:'2026-09-24T02:00:00Z'});await runtime.tick();
  assert.equal(materials.list({query:'中文'}).items.length,0);assert.equal(materials.list({query:'Moved'}).items.length,1);
  await sources.upsert('coding',{...item(1,'session-a','中文需求'),observedAt:'2026-09-24T03:00:00Z'});await runtime.tick();
  assert.equal(materials.list({query:'中文'}).items.length,0);
  const current=materials.list({query:'Moved'}).items[0];const ids=materials.evidenceIds(current.ref);
  assert.equal(reader.evidence(ids,{before:'2026-09-24T01:30:00Z'}).length,0);
  runtime.forget('coding');assert.equal(materials.list().items.length,0);assert.equal(reader.evidence(ids).length,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM source_archive_sizes').get()!.n,0);
  await assert.rejects(sources.upsert('coding',item(2)),/paused/);
});

test('a second installed pipeline composes the same archive and publishing services without core dispatch changes',async t=>{
  const {sources,runtime,materials,store}=await fixture(t);
  sources.capabilities.register('fixture.document',{lifecycle:'one-shot',discovery:'explicit-selection',listening:'none',readOriginal:'none',synchronization:'import-only',externalWrite:false});
  const unregister=runtime.registry.register({id:'fixture.documents',version:'1',sourceKinds:['fixture.document'],storage:'archive',index:'material',modelInput:'material',group:item=>item.externalId,
    organize:({source,items,group})=>({id:materialId(source.id,group),kind:'fixture.document',schemaVersion:1,title:'Fixture document',origin:{sourceId:source.id,externalId:group,deviceId:source.deviceId},blocks:[{id:'body',kind:'text',format:'plain',text:items[0].text,memberIds:['archive']}],members:[{id:'archive',kind:'archive',ref:'archive:fixture'}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}})});
  sources.register({id:'documents',name:'Fixture',kind:'fixture.document',deviceId:'device',platform:'import'});
  await sources.upsert('documents',{externalId:'doc',revision:'1',observedAt:'2026-09-24T00:00:00Z',kind:'file',layer:'snapshot',text:'Searchable fixture document'});await runtime.tick();assert.equal(materials.list({query:'Searchable'}).items.length,1);assert.equal(store.db.prepare('SELECT count(*) n FROM captures').get()!.n,0);unregister();await assert.rejects(sources.upsert('documents',{externalId:'doc',revision:'2',observedAt:'2026-09-24T00:00:00Z',kind:'file',layer:'snapshot',text:'next'}),/unavailable/);
});

test('Memory waits for named outputs while a partial material remains queryable',async t=>{
  const {sources,runtime,materials,reader,store}=await fixture(t);
  sources.capabilities.register('fixture.partial',{lifecycle:'one-shot',discovery:'explicit-selection',listening:'none',readOriginal:'none',synchronization:'import-only',externalWrite:false});
  runtime.registry.register({id:'fixture.partial',version:'1',sourceKinds:['fixture.partial'],storage:'archive',index:'material',modelInput:'material',memory:true,memoryDependencies:['parsed-text'],group:item=>item.externalId,
    organize:({source,items,group})=>({id:materialId(source.id,group),kind:'fixture.partial',schemaVersion:1,title:'Partial fixture',origin:{sourceId:source.id,externalId:group,deviceId:source.deviceId},
      blocks:[{id:'body',kind:'text',format:'plain',text:items[0]!.text,memberIds:['archive']}],members:[{id:'archive',kind:'archive',ref:'archive:fixture'}],
      coverage:{state:'partial',reason:'attachment_pending'},artifacts:[{key:'parsed-text',state:'ready'},{key:'attachment',state:'pending'}],fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}})});
  sources.register({id:'partial',name:'Fixture',kind:'fixture.partial',deviceId:'device',platform:'import'});
  await sources.upsert('partial',{externalId:'doc',revision:'1',observedAt:'2026-09-24T00:00:00Z',kind:'file',layer:'snapshot',text:'Generated partial evidence'});
  runtime.configure('partial',{settleSeconds:0});await runtime.tick();
  const material=materials.list().items.find(item=>item.origin.sourceId==='partial');assert.ok(material);
  assert.equal(material.coverage.state,'partial');assert.match(reader.materialRead({ref:material.ref}).text,/Generated partial evidence/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM material_memory_work WHERE material_id=?').get(material.id)!.n,1);
  runtime.configure('partial',{memoryDependencies:['attachment'],settleSeconds:0});await runtime.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM material_memory_work WHERE material_id=?').get(material.id)!.n,0);
});

test('HTTP source upload, material search and actual agent bridge cite assembled evidence end to end',async t=>{
  const {buildApp}=await import('../src/app.js');
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
  const {parseAnswer}=await import('@mote/agent');
  const directory=mkdtempSync(join(tmpdir(),'mote-source-http-'));
  const config={dataDir:directory,token:'generated-fixture-token',tokenPath:'fixture',host:'127.0.0.1',port:47832,dataKey:undefined,maxStorageBytes:100_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  const node=await buildApp(config,{agent:{configured:false,query:async()=>{throw Error('No online model');},close:async()=>{}}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+config.token};
  assert.equal((await node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'}})).statusCode,200);
  const upload=await node.app.inject({method:'POST',url:'/api/sources/coding/items/batch',headers,payload:{items:[item(1,'session','Fixture bridge proof'),item(2,'session','Second message')]}});assert.equal(upload.statusCode,200,upload.body);assert.equal(upload.json().receipts.length,2);
  await node.sourcePipelines.tick();
  const catalog=await node.app.inject({url:'/api/materials?query=bridge',headers});assert.equal(catalog.statusCode,200);assert.equal(catalog.json().items.length,1);
  const reader=new EvidenceReader(node.store,node.sources,undefined,undefined,undefined,node.materials);
  const bridge=await startBridge(reader.agent({diagnostics:node.diagnostics}),{question:'Fixture',deviceId:'device'},20);t.after(()=>bridge.close());
  const call=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});assert.equal(response.status,200);return response.json();};
  const discovered=await call('material_catalog',{query:'bridge'});const ref=discovered.data.items[0].ref;
  const page=await call('material_read',{ref});const id=page.data.originalRefs[0];assert.ok(id);assert.notEqual(id,upload.json().receipts[0].id);
  await call('evidence',{ids:[id]});const answer=parseAnswer(JSON.stringify({answer:`The assembled conversation contains the proof [${id}]`,citationIds:[id]}),bridge.records);assert.equal(answer.citations[0].id,id);assert.equal(answer.citations[0].provenance?.externalId,ref.split('@')[0].slice('material:'.length));assert.equal(answer.citations[0].provenance?.revision,ref.split('@')[1]);
  assert.equal(node.store.db.prepare('SELECT count(*) n FROM captures').get()!.n,0);
});

test('fragment boundaries preserve exact text and partial messages wait for their remaining parts',async t=>{
  const {runtime,sources,materials,store}=await fixture(t);
  const body='甲🙂乙'.repeat(4500);const first=item(1,'session-a',body);first.document.coding.parts=2;
  await sources.upsert('coding',first);await runtime.tick();const partial=materials.list().items[0];assert.equal(partial.coverage.state,'partial');assert.equal(store.db.prepare('SELECT count(*) n FROM material_memory_work').get()!.n,0);
  const second={...first,externalId:'part-two',text:'The end.',document:{...first.document,coding:{...first.document.coding,part:1}}};
  await sources.upsert('coding',second);await runtime.tick();const full=materials.list().items[0];assert.equal(full.coverage.state,'complete');
  let text='',offset=0;for(;;){const page=materials.read(full.ref,{offset});text+=page.text;if(page.textRange.nextOffset===null)break;offset=page.textRange.nextOffset;}assert.ok(text.includes(body));assert.ok(text.includes('The end.'));
});

test('explicit pipeline replacement rebuilds groups without introducing raw records',async t=>{
  const {runtime,sources,materials}=await fixture(t);await sources.upsert('coding',item(1));await runtime.tick();
  const installed=runtime.registry.get('mote.coding')!;
  const {recipe:_,...legacy}=installed;
  runtime.registry.register({...legacy,id:'fixture.replacement',version:'3',priority:1,organize:input=>({...installed.organize!(input)!,title:'Replacement title'})});
  runtime.configure('coding',{pipelineId:'fixture.replacement',memory:false});await runtime.tick();assert.equal(materials.list().items[0].title,'Replacement title');assert.equal(runtime.options('coding').pipelineId,'fixture.replacement');
});

test('file journal preserves both groups when a move is interrupted before SQL commit',async t=>{
  const {store,sources,runtime,materials}=await fixture(t);
  await sources.upsert('coding',item(1,'old','Previous body'));await runtime.tick();
  const moved={...item(1,'new','Replacement body'),revision:'2',observedAt:'2026-09-24T02:00:00Z'};
  const parsed=(await import('@mote/shared')).sourceItemSchema.parse(moved);
  const group=runtime.registry.get('mote.coding')!.group!(parsed);
  store.db.exec('BEGIN IMMEDIATE');runtime.archive.receive('coding',[parsed],[group]);store.db.exec('ROLLBACK');
  await sources.upsert('coding',moved);await runtime.tick();
  assert.equal(materials.list({query:'Previous body'}).items.length,0);
  assert.equal(materials.list({query:'Replacement body'}).items.length,1);
});

test('encrypted raw archive survives bulk decrypt and a keyless restart',async t=>{
  const {FileStore}=await import('../src/files.js');const {ArchivedFileStore}=await import('../src/archived-files.js');const {ContentStorageService}=await import('../src/content-storage.js');
  const {setImmediate}=await import('node:timers/promises');const {readdirSync,readFileSync}=await import('node:fs');
  const directory=mkdtempSync(join(tmpdir(),'mote-encrypted-source-'));
  let store=new Store(directory,{dataKey:'ab'.repeat(32),contentEncryptionEnabled:true});let runtime=new SourcePipelineRuntime(store,new MaterialStore(store),[codingSourcePlugin]);await runtime.ready;
  t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated',kind:'coding-agent',deviceId:'device',platform:'macos'});
  await sources.upsert('coding',item(1,'session','Encrypted generated conversation'));
  const parent=join(directory,'source-archive',readdirSync(join(directory,'source-archive'))[0]);
  assert.ok(readdirSync(parent).every(name=>name.endsWith('.aes')));
  assert.ok(readdirSync(parent).every(name=>!readFileSync(join(parent,name)).includes(Buffer.from('Encrypted generated conversation'))));
  store.contentEncryption.setEnabled(false);const service=new ContentStorageService(store,new FileStore(store,sources),new ArchivedFileStore(store));service.start();
  for(let i=0;i<1000&&service.snapshot().job.state==='running';i++)await setImmediate();
  assert.equal(service.snapshot().job.state,'completed');assert.equal(service.snapshot().job.failed,0);
  await runtime.close();store.close();store=new Store(directory);const materials=new MaterialStore(store);runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;await runtime.tick();
  assert.equal(materials.list({query:'Encrypted generated conversation'}).items.length,1);
});

test('a missing pipeline can be replaced from its persisted storage contract',async t=>{
 const {runtime,sources,materials}=await fixture(t);const original=runtime.registry.get('mote.coding')!;
 const unregister=runtime.registry.register({...original,id:'fixture.old',priority:2});runtime.configure('coding',{pipelineId:'fixture.old',memory:false,settleSeconds:0});
 await sources.upsert('coding',item(1));await runtime.tick();unregister();
 runtime.registry.register({...original,id:'fixture.new',priority:2});
 assert.doesNotThrow(()=>runtime.configure('coding',{pipelineId:'fixture.new',memory:false,settleSeconds:0}));await runtime.tick();assert.equal(materials.list().items.length,1);
});
