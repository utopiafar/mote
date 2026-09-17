import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {type FileRevision} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {MemoryStore,memoryEvidenceFingerprint} from '../src/memory.js';
import {memorySchema} from '../src/memory-schema.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ContextReader} from '@mote/agent';

function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-files-generated-')),store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources);
  sources.register({id:'generated-files',name:'Generated recordings',kind:'local-files',deviceId:'fixture-phone',platform:'android',retention:'archive'});
  const memories=new MemoryStore(store,ids=>[...store.evidence(ids),...files.evidence(ids)],id=>files.isCurrentEvidence(id)||store.isCurrentEvidence(id));
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,sources,files,memories};
}
const bytes=Buffer.from('generated recording fixture');
function manifest(externalId='recording',revision='v1',previousRevision:string|null=null,observedAt='2026-09-16T01:00:00Z'):FileRevision{return {sourceId:'generated-files',previousRevision,item:{externalId,revision,observedAt,title:'Generated recording.wav',kind:'file',layer:'original',text:'',mimeType:'audio/wav',deleted:false},relativePath:'fixtures/recording.wav',sizeBytes:bytes.length,sha256:sha256(bytes)};}
async function upload(files:FileStore,input=manifest()){const session=files.begin(input,()=>{});files.part(session.uploadId,0,bytes,()=>{});return files.commit(session.uploadId,()=>{});}
function artifact(store:Store,captureId:string,kind='transcript',text='合成转写：我计划下周联系，尚未完成。'){
  const artifactId=randomUUID(),chunkId=randomUUID();
  store.db.prepare('INSERT INTO file_artifacts VALUES(?,?,?,?,?,?,1)').run(artifactId,captureId,kind,new Date().toISOString(),'generated','{}');
  store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(chunkId,artifactId,captureId,1000,2500,text,JSON.stringify({speaker:'SPEAKER_00',uncertain:true}));
  return {artifactId,chunkId};
}
const result=(id:string,quote?:string)=>({answer:JSON.stringify({memories:[{title:'合成记录',statement:`尚未完成的联系计划 [${id}]`,uncertainty:'转写可能有误',evidenceIds:[id],...(quote?{evidence:[{id,offset:0,quote}]}:{})}]}),citations:[{id,capturedAt:'2026-09-16T01:00:00Z',appName:'Generated recording',excerpt:'合成转写'}],trace:[],runId:'generated-file-memory'});

test('typed file chunks retain traceable references and reject arbitrary derived summaries',async t=>{
  const {store,files,memories}=fixture(t),parent=await upload(files),chunk=artifact(store,parent.id),record=files.evidence([chunk.chunkId])[0];
  const saved=memories.extract(result(chunk.chunkId,record.ocrText),'fixture-model').items[0];
  assert.equal(memorySchema.parse(saved).evidence![0].fileEvidence?.captureId,parent.id);
  assert.deepEqual(saved.evidence![0].fileEvidence,record.fileEvidence);
  assert.equal(saved.evidence![0].fileEvidence?.artifactId,chunk.artifactId);
  assert.equal(saved.evidence![0].fileEvidence?.startMs,1000);
  assert.equal(saved.evidence![0].fileEvidence?.speaker,'SPEAKER_00');
  assert.equal(saved.evidence![0].fileEvidence?.uncertain,true);
  assert.equal(saved.evidence![0].quote,record.ocrText);
  assert.equal(memories.publish(saved.id).status,'published');
  assert.equal(memories.list({deviceId:'fixture-phone'}).length,1);
  assert.deepEqual((store.db.prepare('SELECT evidence_id FROM memory_dependencies WHERE memory_id=? ORDER BY evidence_id').all(saved.id) as {evidence_id:string}[]).map(r=>r.evidence_id),[parent.id,chunk.chunkId].sort());
  const summary=artifact(store,parent.id,'summary','模型摘要不是独立原文');
  assert.equal(files.isCurrentEvidence(summary.chunkId),false);
  assert.throws(()=>memories.extract(result(summary.chunkId),'fixture'),{statusCode:409});
  const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>result(chunk.chunkId)});t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[chunk.chunkId]});assert.equal(job.totalBatches,1);assert.equal((await pipeline.run(job.id)).status,'completed');
  assert.throws(()=>pipeline.create({evidenceIds:[summary.chunkId]}),{statusCode:409});
  const amended={...record,fileEvidence:{...record.fileEvidence as object,startMs:1001}};
  assert.notEqual(memoryEvidenceFingerprint(record),memoryEvidenceFingerprint(amended));
  const repeated={...result(chunk.chunkId),answer:JSON.stringify({...JSON.parse(result(chunk.chunkId).answer),citationIds:[chunk.chunkId]})};
  assert.equal(memories.extract(repeated,'fixture').items.length,1);
  assert.throws(()=>memories.extract({...repeated,answer:JSON.stringify({...JSON.parse(repeated.answer),citationIds:[parent.id]})},'fixture'),{statusCode:502});
});

test('preferred corrected transcript supersedes old chunks and invalidates only the dependent file memories and checkpoints',async t=>{
  const {store,files,memories}=fixture(t),a=await upload(files),b=await upload(files,manifest('other')),first=artifact(store,a.id),other=artifact(store,b.id);
  const unrelated=memories.extract(result(other.chunkId),'fixture').items[0];memories.publish(unrelated.id);
  const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>result(first.chunkId)});t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[first.chunkId]}),done=await pipeline.run(job.id),memoryId=done.memoryIds[0];
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n,1);
  const corrected=artifact(store,a.id,'corrected-dialogue','人工确认校正后的合成转写。');
  // Old transcript remains archived and a.current=1, but preference rules exclude it.
  assert.equal(files.evidence([first.chunkId]).length,1);assert.equal(files.isCurrentEvidence(first.chunkId),false);
  assert.equal(files.isCurrentEvidence(corrected.chunkId),true);
  assert.throws(()=>memories.publish(memoryId),{statusCode:409});
  store.invalidateMemoryEvidence(a.id);
  assert.equal(memories.get(memoryId).status,'stale');assert.equal(memories.get(unrelated.id).status,'published');
  assert.equal(pipeline.get(job.id).status,'failed');assert.equal(pipeline.get(job.id).batches[0].status,'invalidated');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n,0);
  assert.equal(pipeline.create({evidenceIds:[corrected.chunkId]}).totalBatches,1);
  assert.throws(()=>pipeline.create({evidenceIds:[first.chunkId]}),{statusCode:409});
});

test('privacy removal of a parent file while extracting a chunk cannot resurrect memories or checkpoints',async t=>{
  const {store,files,memories}=fixture(t),parent=await upload(files),first=artifact(store,parent.id),prior=memories.extract(result(first.chunkId),'fixture').items[0];
  let enter!:()=>void,finish!:(value:ReturnType<typeof result>)=>void;const entered=new Promise<void>(r=>enter=r);
  const pipeline=new MemoryPipeline({store,memories,model:()=> 'fixture',configured:()=>true,query:async()=>{enter();return new Promise(r=>finish=r);}});t.after(()=>pipeline.close());
  const job=pipeline.create({evidenceIds:[first.chunkId]}),running=pipeline.run(job.id);await entered;
  files.forget(parent.id);assert.equal(files.evidence([first.chunkId]).length,0);assert.throws(()=>memories.get(prior.id),{statusCode:404});
  finish(result(first.chunkId));const done=await running;
  assert.equal(done.status,'failed');assert.equal(done.batches[0].status,'invalidated');assert.equal(memories.list({includeStale:true}).length,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memory_checkpoints').get()!.n,0);
});

test('source disappearance retains transcript evidence while a new predecessor revision invalidates it even with an older source clock',async t=>{
  const {files,store,memories}=fixture(t),parent=await upload(files),first=artifact(store,parent.id);
  const removed=manifest('recording','removed','v1','2026-09-16T02:00:00Z');delete removed.sha256;removed.item.deleted=true;await files.revision(removed,()=>{});
  assert.equal(files.detail(parent.id).originMissing,true);assert.equal(files.isCurrentEvidence(first.chunkId),true);
  const memory=memories.extract(result(first.chunkId),'fixture').items[0];memories.publish(memory.id);
  const next=await upload(files,manifest('recording','v2','removed','2026-09-15T01:00:00Z'));
  assert.equal(files.isCurrentEvidence(first.chunkId),false);assert.equal(memories.get(memory.id).status,'stale');
  const nextChunk=artifact(store,next.id);assert.equal(files.isCurrentEvidence(nextChunk.chunkId),true);
});

test('Memory API expands all preferred file chunks, validates chunk scope, and deleting a cited chunk forgets its parent',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-file-api-generated-'));
  const config:Config={dataDir:directory,token:'synthetic-memory-file-api-token',tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
  let reader!:ContextReader;
  const node=await buildApp(config,{createModelAgent:async(_settings,value)=>{reader=value;return {configured:true,close:async()=>{},query:async()=>({answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()})};}});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  node.sources.register({id:'generated-files',name:'Generated recordings',kind:'local-files',deviceId:'fixture-phone',platform:'android',retention:'archive'});
  const parent=await upload(node.files),first=artifact(node.store,parent.id),ids=[first.chunkId];
  for(let index=1;index<205;index++){
    const id=randomUUID();ids.push(id);
    node.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(id,first.artifactId,parent.id,index*3000,index*3000+1000,'合成转写片段 '+index,'{}');
  }
  const headers={authorization:`Bearer ${config.token}`};
  for(const payload of [{evidenceIds:[ids[0]],deviceId:'other'},{evidenceIds:[ids[0]],before:'2020-01-01T00:00:00Z'},{evidenceIds:[randomUUID()]}])assert.equal((await node.app.inject({method:'POST',url:'/api/memory-jobs',headers,payload})).statusCode,409);
  const explicit=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers,payload:{evidenceIds:[parent.id]}});
  assert.equal(explicit.statusCode,202,explicit.body);assert.deepEqual(new Set(explicit.json().evidenceIds),new Set(ids));
  assert.equal((await node.memoryPipeline.run(explicit.json().id)).status,'completed');
  const automatic=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers,payload:{deviceId:'fixture-phone'}});
  assert.equal(automatic.statusCode,202,automatic.body);assert.deepEqual(new Set(automatic.json().evidenceIds),new Set(ids));
  assert.equal(automatic.json().skippedChunks,205);
  const current=await reader.fileChunks!({id:parent.id,offset:0});assert.equal(current[0].revisionState,'current');
  const citation=await node.app.inject({url:'/api/captures/'+ids[0],headers});assert.equal(citation.json().fileEvidence.captureId,parent.id);
  const memory=node.memories.extract(result(ids[0]),'fixture').items[0];
  const removed=await node.app.inject({method:'DELETE',url:'/api/captures/'+ids[0],headers});assert.equal(removed.statusCode,200,removed.body);
  assert.equal(node.files.evidence(ids).length,0);assert.throws(()=>node.files.version(parent.id),{statusCode:404});assert.throws(()=>node.memories.get(memory.id),{statusCode:404});
});

test('full local indexes enter memory batches without archived originals; lightweight indexes wait for evidence',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-local-index-api-'));
 const {configFromEnv}=await import('../src/config.js');const config=configFromEnv({MOTE_DATA_DIR:directory,MOTE_TOKEN:'generated-index-memory-token',MOTE_RETENTION_DAYS:'0'});
 const node=await buildApp(config,{createModelAgent:async()=>({configured:true,close:async()=>{},query:async()=>({answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()})})});t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 node.sources.register({id:'indexes',deviceId:'generated-device',name:'Generated indexes',kind:'local-files',platform:'macos',retention:'snapshot'});
 const text='Generated complete original evidence',descriptor={version:1,fileId:'generated-file',contentVersion:'a'.repeat(64),mode:'index',coverage:'full',parser:'utf8',status:'ready',totalCharacters:text.length,offset:0,length:text.length,allowRead:true};
 const full=await node.files.revision({sourceId:'indexes',item:{externalId:'full',revision:'v1',observedAt:new Date().toISOString(),title:'full.txt',kind:'file',layer:'snapshot',text,document:{fileIndex:descriptor}},sizeBytes:100},()=>{});
 const response=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers:{authorization:'Bearer '+config.token,'accept-language':'en'},payload:{evidenceIds:[full.id]}});assert.equal(response.statusCode,202,response.body);assert.deepEqual(response.json().evidenceIds,[full.id]);assert.equal(response.json().language,'en');assert.equal(response.json().totalBatches,1);await node.memoryPipeline.run(response.json().id);
 const light=await node.files.revision({sourceId:'indexes',item:{externalId:'light',revision:'v1',observedAt:new Date().toISOString(),title:'light.txt',kind:'file',layer:'snapshot',text,document:{fileIndex:{...descriptor,coverage:'lightweight',totalCharacters:500}}},sizeBytes:500},()=>{});
 assert.equal(node.memoryPipeline.create({evidenceIds:[light.id]}).totalBatches,0);assert.throws(()=>node.memories.extract(result(light.id,text),'fixture'),/Lightweight/);
 const saved=node.memories.extract(result(full.id,text),'fixture').items[0];assert.equal(saved.evidence![0].fileIndex?.contentVersion,descriptor.contentVersion);assert.equal(saved.evidence![0].quote,text);
});
