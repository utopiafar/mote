import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseEvidenceRef,evidenceRefId,formatEvidenceRef} from '../dist/evidence-ref.js';

test('canonical immutable references round-trip across both namespaces and case variants',()=>{
  for(let i=0;i<400;i++)for(const kind of ['capture','memory']){
    const id=randomUUID(),ref=formatEvidenceRef(kind,id);
    assert.deepEqual(parseEvidenceRef(ref),{kind,id});
    assert.deepEqual(parseEvidenceRef(ref.toUpperCase()),{kind,id});
    assert.equal(evidenceRefId(id.toUpperCase(),kind),id);
    assert.equal(evidenceRefId(ref,kind==='capture'?'memory':'capture'),undefined);
  }
});

test('navigation, nested, path, padded and malformed references cannot become evidence IDs',()=>{
  const id=randomUUID();
  for(const ref of [`session:${id}`,`collection:${id}`,`memory:capture:${id}`,`capture:${id}/text`,` ${id}`,`${id}\n`,'',id.slice(1)]){
    assert.equal(parseEvidenceRef(ref),undefined,JSON.stringify(ref));
    assert.throws(()=>formatEvidenceRef('capture',ref));
  }
  assert.deepEqual(parseEvidenceRef(id),{kind:'capture',id});
});

test('derived artifact refs pin a case-sensitive revision and reject ambiguous encodings',async()=>{
 const {formatArtifactRef,parseArtifactRef}=await import('../dist/evidence-ref.js');
 for(const [id,revision] of [['a'.repeat(64),'b'.repeat(64)],['artifact:a/b 🌱','Revision:1']]){
  const ref=formatArtifactRef(id,revision);assert.deepEqual(parseArtifactRef(ref),{id,revision});
  assert.equal(parseEvidenceRef(ref),undefined);
  for(const invalid of [ref+':extra',ref+'\n',ref.replace('artifact:','ARTIFACT:'),'artifact:%zz:1','artifact::1'])assert.equal(parseArtifactRef(invalid),undefined);
 }
});
