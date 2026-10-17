import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore} from '../src/materials.js';
import {FileStore} from '../src/files.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {Conversations} from '../src/conversations.js';
import {MemoryStore,memoryEvidenceFingerprint} from '../src/memory.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

test('default unknown keeps legacy evidence fingerprints while explicit correction saves its own lineage',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-memory-attribution-')),store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const sources=new SourceStore(store);sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
  const {id}=await sources.upsert('generated',{externalId:'interview',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'I retained the completed interview transcript.'});
  const original=store.evidence([id])[0],unknown={version:1 as const,ownerRelation:'unknown' as const,basis:'default' as const};
  assert.equal(memoryEvidenceFingerprint(original),memoryEvidenceFingerprint({...original,attributionContext:unknown}));
  assert.equal(memoryEvidenceFingerprint(original),memoryEvidenceFingerprint({...original,attributionContext:{...unknown,sourceContextDeclarations:[],sourceContextStatements:[]}}));
  assert.notEqual(memoryEvidenceFingerprint(original),memoryEvidenceFingerprint({...original,attributionContext:{...unknown,sourceContextDeclarations:[{sourceId:'generated',version:1,fingerprint:'a'.repeat(64)}]}}));
  assert.notEqual(memoryEvidenceFingerprint(original),memoryEvidenceFingerprint({...original,attributionContext:{...unknown,sourceContextStatements:[{sourceId:'generated',version:1,description:'Generated source description'}]}}));
  const attributionContext={version:1 as const,ownerRelation:'mixed' as const,basis:'owner_material' as const,correction:{version:1,ownerRelation:'mixed' as const}};
  const record={...original,attributionContext};
  assert.notEqual(memoryEvidenceFingerprint(original),memoryEvidenceFingerprint(record));
  const reset={...unknown,correction:{version:2,ownerRelation:null}};
  assert.notEqual(memoryEvidenceFingerprint(original),memoryEvidenceFingerprint({...original,attributionContext:reset}));
  const memories=new MemoryStore(store,ids=>ids.includes(id)?[record]:[]);
  const result=fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated activity',statement:'Retained the completed transcript ['+id+']',uncertainty:'Fixture only',evidenceIds:[id]}]}),citations:[{id,capturedAt:record.capturedAt,appName:'Generated',excerpt:record.ocrText}],trace:[],runId:'generated'});
  const saved=memories.extract(result,'fixture').items[0];
  assert.deepEqual(memories.get(saved.id).evidence[0].attributionContext,attributionContext);
  assert.equal(saved.evidence[0].contentHash,memoryEvidenceFingerprint(record));
  assert.equal(record.ocrText.slice(saved.evidence[0].offset,saved.evidence[0].offset!+saved.evidence[0].length!),saved.evidence[0].quote);
});

test('description-only source changes fence raw and ASR Memory extraction and clear answers derived from those memories',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-memory-source-description-')),store=new Store(dir),sources=new SourceStore(store),materials=new MaterialStore(store),files=new FileStore(store,sources);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const sourceId='generated-recordings';sources.register({id:sourceId,name:'Generated recordings',kind:'local-files',deviceId:'generated',platform:'android',retention:'archive'});
  const raw=await sources.upsert(sourceId,{externalId:'generated-message',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated participant plans a walk.'});
  const bytes=Buffer.from('GENERATED RECORDING'),upload=files.begin({sourceId,previousRevision:null,item:{externalId:'generated-call',revision:'1',observedAt:'2026-10-01T00:00:00Z',title:'Generated call',kind:'file',layer:'original',text:'',mimeType:'audio/wav'},relativePath:'generated.wav',sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
  files.part(upload.uploadId,0,bytes,()=>{});const audio=await files.commit(upload.uploadId,()=>{}),artifactId=randomUUID(),chunkId=randomUUID();
  store.db.prepare('INSERT INTO file_artifacts VALUES(?,?,?,?,?,?,1)').run(artifactId,audio.id,'transcript','2026-10-01T00:00:00Z','fixture','{}');
  store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(chunkId,artifactId,audio.id,0,1000,'Generated speaker plans a visit.','{}');
  const reader=new EvidenceReader(store,sources,files,undefined,undefined,materials),memories=reader.memories,ids=[raw.id,chunkId],before=memories.readEvidence(ids);
  assert.equal(materials.list().items.length,0);
  for(const record of before){
    assert.deepEqual(record.attributionContext,{version:1,ownerRelation:'unknown',basis:'default'});
    const {attributionContext:_,...legacy}=record;assert.equal(memoryEvidenceFingerprint(record),memoryEvidenceFingerprint(legacy));
  }
  const resultFor=(id:string)=>fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated retained plan',statement:'Generated participant plans a visit ['+id+']',uncertainty:'Generated fixture only',evidenceIds:[id]}]}),citations:[{id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated',excerpt:memories.readEvidence([id])[0].ocrText}],trace:[],runId:randomUUID()});
  const pending=ids.map(id=>resultFor(id)),fingerprints=Object.fromEntries(before.map(record=>[record.id,memoryEvidenceFingerprint(record)]));
  const saved=pending.map(result=>{const memory=memories.extract(result,'fixture').items[0];return memories.publish(memory.id,memory.version);}),conversations=new Conversations(store);
  const answers=saved.map(memory=>conversations.append(undefined,{question:'Generated question',timeZone:'UTC'},{answer:'Generated answer from a derived memory',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[memory.id]}}));
  sources.updateContext(sourceId,{expectedVersion:0,description:'These generated records are my phone calls; speakers remain uncertain.'});
  const current=memories.readEvidence(ids);
  for(const record of current){
    assert.equal(record.attributionContext?.ownerRelation,'unknown');assert.equal(record.attributionContext?.basis,'default');
    assert.equal(record.attributionContext?.sourceContextDeclarations?.[0].version,1);
    assert.notEqual(memoryEvidenceFingerprint(record),fingerprints[record.id]);assert.equal(memories.isCurrentEvidence(record.id),true);
  }
  for(let index=0;index<ids.length;index++)assert.throws(()=>memories.extract(pending[index],'fixture',{expectedFingerprints:{[ids[index]]:fingerprints[ids[index]]}}),{statusCode:409,message:'Memory evidence changed during extraction'});
  for(const memory of saved)assert.equal(memories.get(memory.id).status,'stale');
  assert.equal(memories.page({layer:'memory'}).items.length,0);
  for(const answer of answers){const turn=conversations.get(answer.conversationId).turns[0];assert.equal(turn.evidenceDeleted,undefined);assert.equal(turn.evidenceStale,true);assert.equal(turn.result?.answer,'Generated answer from a derived memory');assert.equal(turn.question,'Generated question');}
  const currentFingerprints=Object.fromEntries(current.map(record=>[record.id,memoryEvidenceFingerprint(record)])),pendingRevision=ids.map(id=>resultFor(id)),chunks=store.db.prepare('SELECT * FROM file_chunks').all();
  sources.updateContext(sourceId,{expectedVersion:1,description:'Updated generated phone call description.'});
  for(let index=0;index<ids.length;index++){
    assert.notEqual(memoryEvidenceFingerprint(memories.readEvidence([ids[index]])[0]),currentFingerprints[ids[index]]);
    assert.throws(()=>memories.extract(pendingRevision[index],'fixture',{expectedFingerprints:{[ids[index]]:currentFingerprints[ids[index]]}}),{statusCode:409,message:'Memory evidence changed during extraction'});
  }
  assert.deepEqual(store.db.prepare('SELECT * FROM file_chunks').all(),chunks);assert.equal(files.isCurrentEvidence(chunkId),true);
  assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='memory_input_authorizations'").get()!.n,0);
});
