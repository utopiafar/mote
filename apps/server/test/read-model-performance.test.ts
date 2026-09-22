import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {modelConfiguration} from '../src/model-configuration.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {Conversations} from '../src/conversations.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {Indexer} from '../src/indexer.js';
const note=(text='Generated explicit decision: use local backups.')=>({id:randomUUID(),deviceId:'fixture-device',deviceName:'Fixture',platform:'import',source:'note',capturedAt:'2026-09-21T01:00:00Z',durationMs:0,ocrText:text});
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'mote-read-models-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return store;}

test('metadata overview performs zero evidence reads and direct mutations revoke it transactionally',async t=>{
 const store=fixture(t),record=note();await store.ingest(record);const memories=new MemoryStore(store);
 const saved=memories.extract({answer:JSON.stringify({memories:[{title:'Backup decision',statement:`Local backups [${record.id}]`,uncertainty:'Fixture',evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText}]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:'Fixture',excerpt:record.ocrText}],trace:[],runId:randomUUID()},'fixture');
 memories.readEvidence=()=>{throw Error('Original read from an overview');};
 assert.equal(memories.page({deviceId:record.deviceId,after:'2026-09-20T00:00:00Z',limit:1}).items.length,1);
 assert.equal(memories.get(saved.items[0].id).title,'Backup decision');
 store.db.exec('BEGIN');store.db.prepare("UPDATE captures SET json=json_set(json,'$.ocrText',?) WHERE id=?").run('Changed fixture',record.id);
 assert.equal(memories.page().items.length,0);store.db.exec('ROLLBACK');assert.equal(memories.page().items.length,1);
 store.delete(record.id);assert.equal(memories.page({includeStale:true}).items.length,0);
});
test('status reads counters, preserves rollback and exposes physical snapshot freshness',async t=>{
 const store=fixture(t);await store.ingestBatch([note(),note()]);
 store.measurePhysicalStorage=()=>{throw Error('HTTP stats must not scan disk');};
 assert.equal(store.stats().captures,2);assert.equal(store.stats().physicalPending,true);
 store.db.exec('BEGIN');store.db.prepare('DELETE FROM captures WHERE id=?').run(store.list({limit:1}).items[0].id);assert.equal(store.stats().captures,1);store.db.exec('ROLLBACK');assert.equal(store.stats().captures,2);
 store.db.prepare("INSERT INTO settings VALUES('physical-storage-snapshot',?)").run(JSON.stringify({bytes:1234,asOf:'2026-09-21T00:00:00Z'}));assert.equal(store.stats().bytes,1234);assert.equal(store.stats().physicalPending,false);
});
test('conversation writes append one turn and pages neither load nor rewrite earlier turns',t=>{
 const store=fixture(t),conversations=new Conversations(store),answer={answer:'Generated response '.repeat(200),citations:[],trace:[],runId:randomUUID()};
 let id:string|undefined;for(let i=0;i<45;i++)id=conversations.append(id?conversations.get(id):undefined,{question:'Generated question '+i},answer).conversationId;
 const page=conversations.page(id!),previous=conversations.page(id!,{cursor:page.nextCursor!});assert.equal(page.turns.length,20);assert.equal(page.turnCount,45);assert.equal(page.turns[0].question,'Generated question 25');assert.equal(previous.turns.at(-1)!.question,'Generated question 24');
 assert.ok(String(store.db.prepare('SELECT json FROM conversations WHERE id=?').get(id!)!.json).length<500);
 const untouched=store.db.prepare('SELECT json FROM conversation_turns WHERE conversation_id=? AND idx=0').get(id!)!.json;
 conversations.append(conversations.get(id!),{question:'One more'},answer);assert.equal(store.db.prepare('SELECT json FROM conversation_turns WHERE conversation_id=? AND idx=0').get(id!)!.json,untouched);
});
test('artifact-only downstream gets no ancestral observations and upstream deletion revokes descendants',async t=>{
 const store=fixture(t),runtime=new ProcessingRuntime(store);t.after(()=>runtime.close());const record=note();await store.ingest(record);store.archive.aggregate();const parent=store.archive.page().items[0]!;
 runtime.registry.register({id:'fixture.artifact-only',version:'1',lane:'semantic',async process(input){assert.deepEqual(input.observations,[]);assert.equal(input.artifacts[0].outputs[0].text,record.ocrText);return [{kind:'semantic',text:'Generated compact interpretation',metadata:{evidenceRanges:[{id:record.id,offset:0,length:record.ocrText.length}]}}];}});
 const job=runtime.enqueue([{name:'semantic',processor:'fixture.artifact-only',artifactInputs:[{id:parent.id,revision:parent.revision}]}]);await runtime.tick();
 const out=JSON.parse(String(store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(job.semantic)!.json)).outputs[0];assert.ok(store.archive.get(out));store.delete(record.id);assert.equal(store.archive.get(out),undefined);
});
test('semantic memory input is bounded to selected spans, with original exact-quote validation',async t=>{
 const store=fixture(t),record=note('Generated introduction. KEEP THIS DECISION. '+'Other text. '.repeat(2000));await store.ingest(record);
 const artifact='a'.repeat(64),revision='b'.repeat(64),start=record.ocrText.indexOf('KEEP THIS DECISION.');
 store.archive.save(artifact,artifact,revision,{kind:'semantic',text:'A generated decision summary',metadata:{evidenceRanges:[{id:record.id,offset:start,length:19}]}},[{id:record.id,fingerprint:store.archive.fingerprint(record.id)!}],'fixture','1','fixture');
 const memories=new MemoryStore(store),seen:any[]=[],pipeline=new MemoryPipeline({store,memories,configured:()=>true,model:()=> 'fixture',query:async input=>{seen.push(input);return {answer:JSON.stringify({memories:[{title:'Selected decision',statement:`Keep this decision [${record.id}]`,uncertainty:'Generated fixture',evidenceIds:[record.id],evidence:[{id:record.id,quote:record.ocrText.slice(start,start+19)}]}]}),citations:[{id:record.id,capturedAt:record.capturedAt,appName:'Fixture',excerpt:record.ocrText.slice(start,start+19)}],trace:[],runId:randomUUID()};}});t.after(()=>pipeline.close());
 const job=pipeline.createFromArtifacts([artifact],'fixture-semantic')!;await pipeline.run(job.id);assert.equal(seen.length,1);assert.deepEqual(seen[0].evidenceRanges,[{id:record.id,offset:start,length:19}]);assert.ok(seen[0].question.includes('A generated decision summary'));assert.equal(memories.page().items.length,1);
 store.db.prepare("UPDATE captures SET json=json_set(json,'$.ocrText','Changed generated decision') WHERE id=?").run(record.id);assert.equal(memories.page({includeStale:true}).items.length,0);
});
test('query embedding has a short deadline and lexical evidence remains usable',async t=>{
 const store=fixture(t),record=note('Generated retrieval phrase');await store.ingest(record);const indexer=new Indexer(store,{embeddingModel:'fixture',embeddingBaseUrl:'http://127.0.0.1:1',embeddingApiKey:''});t.after(()=>indexer.close());
 let budget=0;indexer.embed=async(_text,timeout)=>{budget=timeout!;throw Error('generated timeout');};
 const result=await indexer.search({query:'retrieval'});assert.equal(budget,1200);assert.equal(result[0].id,record.id);assert.equal(result.retrieval.degraded,true);
});
test('interactive admission stays available while the background agent lane is saturated',async t=>{
 const {buildApp}=await import('../src/app.js');const dir=mkdtempSync(join(tmpdir(),'mote-interactive-lane-'));
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
 const {app,agent}=await buildApp({dataDir:dir,token:'synthetic-interactive-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:0,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'https://synthetic.invalid',apiKey:'synthetic',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',agentConcurrency:1},{agent:{configured:true,close:async()=>{},query:async input=>{if(input.executionLane!=='interactive')await held;return {answer:'Generated answer',citations:[],trace:[],runId:randomUUID()};}}});
 t.after(async()=>{release();await app.close();rmSync(dir,{recursive:true,force:true});});
 const background=agent.query({question:'Generated background work'});await new Promise(r=>setImmediate(r));
 const response=await Promise.race([app.inject({method:'POST',url:'/api/query',headers:{authorization:'Bearer synthetic-interactive-token'},payload:{question:'Generated foreground question'}}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Foreground starved by background lane')),1500);timer.unref();})]);
 assert.equal(response.statusCode,200,response.body);release();await background;
});
test('conversation revision prevents stale append after same-millisecond evidence revocation',t=>{
 const store=fixture(t),conversations=new Conversations(store),result={answer:'Generated',citations:[],trace:[],runId:randomUUID()};
 const id=conversations.append(undefined,{question:'Generated'},result).conversationId,previous=conversations.get(id);
 store.db.prepare("UPDATE conversations SET json=json_set(json,'$.revision',json_extract(json,'$.revision')+1) WHERE id=?").run(id);
 assert.throws(()=>conversations.append(previous,{question:'Stale'},result),/Conversation changed/);
});
test('semantic boundary grants actual bounded lengths for more than eight representatives',async t=>{
 const {buildApp}=await import('../src/app.js');const store=fixture(t);let ranges:{id:string;offset:number;length:number}[]=[];
 const runtime=await buildApp({dataDir:store.directory,token:'synthetic-semantic-token',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:0,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'https://synthetic.invalid',apiKey:'synthetic',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},{store,agent:{configured:true,close:async()=>{},query:async input=>{ranges=input.evidenceRanges??[];return {answer:JSON.stringify({summary:'Generated ten short observations',evidence:[],events:[],memoryCandidates:[],actionCues:[]}),citations:[],trace:[],runId:randomUUID()};}}});
 try{
 const records=Array.from({length:10},(_,i)=>note('Generated short observation '+i));await store.ingestBatch(records);
 const id='c'.repeat(64),revision='d'.repeat(64);store.archive.save(id,id,revision,{kind:'segment',text:records.map(r=>r.ocrText).join('\n'),metadata:{complete:true}},records.map(r=>({id:r.id,fingerprint:store.archive.fingerprint(r.id)!})),'fixture','1','fixture');
 const job=runtime.workflows.enqueue([{name:'semantic',processor:'mote.segment-understanding',artifactInputs:[{id,revision}],config:{artifactId:id,modelFingerprint:modelConfiguration(runtime.modelSettings.select('memory').id,runtime.modelSettings.select('memory').settings,runtime.modelSettings.view().revision).fingerprint}}]).semantic;await runtime.workflows.tick();
 assert.equal(store.db.prepare('SELECT state FROM processing_jobs WHERE id=?').get(job)!.state,'succeeded');assert.equal(ranges.length,10);assert.equal(ranges.reduce((n,r)=>n+r.length,0),records.reduce((n,r)=>n+r.ocrText.length,0));
 }finally{await runtime.app.close();}
});
