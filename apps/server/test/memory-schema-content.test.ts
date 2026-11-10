import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memorySchema,memoryEvidenceSchema} from '../src/memory-schema.js';
import {claimSchema} from '../src/memory.js';

test('memory content and evidence quotes are not rejected by former card-length thresholds',()=>{
  const evidenceId=randomUUID(),at='2026-10-12T00:00:00Z';
  const evidence=memoryEvidenceSchema.parse({id:evidenceId,capturedAt:at,receivedAt:at,quote:'q'.repeat(12001),contentHash:'a'.repeat(64)});
  assert.equal(evidence.quote?.length,12001);
  const memory=memorySchema.parse({id:randomUUID(),version:1,domain:'personal',tier:'episode',kind:'episodic',
    title:'Generated title '.repeat(20),statement:'Generated statement. '.repeat(500),uncertainty:'Generated uncertainty. '.repeat(150),
    status:'published',createdAt:at,evidenceIds:[evidenceId],evidence:[{...evidence,quote:'q'.repeat(12001)}],
    model:'fixture',runId:'fixture',fingerprint:'b'.repeat(64),
    admission:{layer:'memory',reason:'Generated fixture',scope:'Generated fixture only',attribution:'observed'}});
  assert.ok(memory.title.length>160);assert.ok(memory.statement.length>6000);assert.ok(memory.uncertainty.length>2000);
  const claim=claimSchema.parse({title:'Generated claim '.repeat(20),statement:'Generated claim body. '.repeat(500),uncertainty:'Generated claim uncertainty. '.repeat(150),
    evidenceIds:[evidenceId],evidence:[{id:evidenceId,quote:'q'.repeat(12001)}]});
  assert.ok(claim.title.length>160);assert.ok(claim.statement.length>6000);assert.ok(claim.uncertainty.length>2000);assert.equal(claim.evidence![0]!.quote!.length,12001);
});
