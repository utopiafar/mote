import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalRunStatus,executionEnvelope,retryDelay,standardRetryPolicy} from '../dist/execution.js';

test('current domain states have explicit execution projections',()=>{
  assert.equal(canonicalRunStatus({state:'completed'}),'succeeded');
  assert.equal(canonicalRunStatus({status:'waiting_for_model',errorCode:'model_unconfigured'}),'waiting');
  assert.equal(canonicalRunStatus({state:'interrupted'}),'queued');
  const value=executionEnvelope({status:'waiting_for_model',attempts:2,errorCode:'model_unconfigured'});
  assert.equal(value.status,'waiting');
  assert.equal(value.waiting?.reason,'provider_unavailable');
  assert.deepEqual(value.allowedActions,['continue','cancel']);
  assert.equal(value.attempts,2);
});

test('failure scope distinguishes item failures from shared provider waits',()=>{
  const provider=executionEnvelope({status:'failed',errorCode:'model_unconfigured'});
  assert.equal(provider.failure?.scope,'provider');
  assert.equal(provider.failure?.recovery,'needs_action');
  const item=executionEnvelope({status:'failed',errorCode:'invalid_model_output'});
  assert.equal(item.failure?.scope,'item');
  assert.equal(item.failure?.recovery,'permanent');
  assert.deepEqual(item.allowedActions,['reprocess']);
});

test('backoff is bounded and deterministic when randomness is injected',()=>{
  assert.equal(retryDelay(standardRetryPolicy,1,()=>0),24000);
  assert.equal(retryDelay(standardRetryPolicy,2,()=>1),72000);
  assert.equal(retryDelay({...standardRetryPolicy,maxDelayMs:50000},20,()=>.5),50000);
});

test('unknown and missing states are rejected instead of granting recovery actions',()=>{
  for(const input of [{status:'old_pending_state'},{status:'canceled'},{}])assert.throws(()=>executionEnvelope(input),/Unsupported domain execution state/);
});
