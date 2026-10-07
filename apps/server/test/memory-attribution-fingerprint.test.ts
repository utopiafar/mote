import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore,memoryEvidenceFingerprint} from '../src/memory.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

test('default unknown keeps legacy evidence fingerprints while explicit correction saves its own lineage',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'mote-memory-attribution-')),store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const sources=new SourceStore(store);sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});
  const {id}=await sources.upsert('generated',{externalId:'interview',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'I retained the completed interview transcript.'});
  const original=store.evidence([id])[0],unknown={version:1 as const,ownerRelation:'unknown' as const,basis:'default' as const};
  assert.equal(memoryEvidenceFingerprint(original),memoryEvidenceFingerprint({...original,attributionContext:unknown}));
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
