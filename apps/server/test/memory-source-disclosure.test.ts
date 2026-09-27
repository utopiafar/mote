import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {ServerDiagnostics} from '../src/diagnostics.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';

async function fixture(t:any){
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-disclosure-')),store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated',name:'Generated originals',kind:'custom',deviceId:'generated-device',platform:'import'});
  const text='Generated preface. Relax shoulders before turning. Other generated detail.',at='2026-09-20T00:00:00.000Z';
  const originalId=(await sources.upsert('generated',{externalId:'lesson',revision:'1',observedAt:at,kind:'message',layer:'original',text})).id;
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials),agent=reader.agent({diagnostics});
  function saveMemory(evidenceId=originalId,quote='Relax shoulders before turning.',overrides:Record<string,unknown>={}){
    const record=reader.memories.readEvidence([evidenceId])[0],offset=record.ocrText.indexOf(quote),id=randomUUID();
    const ref={id:evidenceId,deviceId:record.deviceId,capturedAt:record.capturedAt,receivedAt:record.receivedAt,offset,length:quote.length,quote,contentHash:memoryEvidenceFingerprint(record),...overrides};
    const memory={id,title:'Generated lesson',statement:'Scoped generated lesson',uncertainty:'Generated evidence only',status:'published',createdAt:at,model:'fixture',runId:'fixture',fingerprint:'a'.repeat(64),evidenceIds:[evidenceId],evidence:[ref],admission:{layer:'memory',reason:'fixture',scope:'training',attribution:'user'}};
    store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(id,at,JSON.stringify(memory));
    store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(id,evidenceId);
    return id;
  }
  return {store,sources,materials,diagnostics,reader,agent,saveMemory,originalId,text,at};
}

test('supporting original disclosure is opt-in, scoped, permission checked and freshly verified',async t=>{
  const f=await fixture(t),id=f.saveMemory();
  const overview=await f.agent.memories!({});assert.equal(overview.sourceSpans,undefined);
  const metadata=await f.agent.memories!({id});assert.equal(metadata.sourceSpans,undefined);
  const detail=await f.agent.memories!({id,includeEvidence:true});assert.equal(detail.sourceSpans!.length,1);
  const span=detail.sourceSpans![0];assert.equal(span.record.id,f.originalId);assert.equal(span.record.ocrText.slice(span.offset,span.offset+span.length),'Relax shoulders before turning.');
  assert.deepEqual(detail.sourceCoverage,{references:1,delivered:1,partial:false});
  for(const scope of [{deviceId:'outside'},{before:f.at},{after:'2026-10-01T00:00:00Z'}]){
    const denied=await f.agent.memories!({id,includeEvidence:true,...scope});assert.equal(denied.items.length,0);assert.deepEqual(denied.sourceSpans,[]);
  }
  const restricted=f.reader.agent({diagnostics:f.diagnostics,exposurePolicy:new EvidenceExposurePolicy([{sourceId:'generated',operation:'expand',allow:false}])});
  const denied=await restricted.memories!({id,includeEvidence:true});assert.equal(denied.items.length,1);assert.deepEqual(denied.sourceSpans,[]);assert.equal(denied.sourceCoverage?.partial,true);
  f.store.delete(f.originalId);assert.equal((await f.agent.memories!({id,includeEvidence:true})).items.length,0);
});

test('stale fingerprints, fabricated quotes and invalid locators cannot become original evidence',async t=>{
  const f=await fixture(t);
  for(const change of [{contentHash:'b'.repeat(64)},{quote:'Generated invented quote'},{offset:-1},{length:100000},{offset:undefined}]){
    const id=f.saveMemory(undefined,undefined,change),result=await f.agent.memories!({id,includeEvidence:true});
    assert.equal(result.items.length,1);assert.deepEqual(result.sourceSpans,[]);assert.equal(result.sourceCoverage?.partial,true);
  }
});

test('material supporting text uses its canonical proof identity through the decorated query projection',async t=>{
  const f=await fixture(t);
  const material=f.materials.publish({id:materialId('generated','lesson'),kind:'mote.message',schemaVersion:1,title:'Generated lesson material',
    origin:{sourceId:'generated',externalId:'lesson',deviceId:'generated-device',firstAt:f.at,lastAt:f.at},
    blocks:[{id:'body',kind:'text',format:'plain',text:f.text,memberIds:['original']}],members:[{id:'original',kind:'capture',ref:'capture:'+f.originalId}],
    coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
  f.materials.setSearchable(material.id,true);
  const anchor=f.materials.evidenceIds(material.ref)[0],id=f.saveMemory(anchor);
  const result=await f.agent.memories!({id,includeEvidence:true});
  assert.equal(result.items.length,1);assert.equal(result.sourceSpans?.length,1);assert.equal(result.sourceSpans![0].record.id,anchor);
  f.materials.retire(material.id,{expectedRevision:material.revision});
  assert.equal((await f.agent.memories!({id,includeEvidence:true})).sourceSpans?.length,0);
});
