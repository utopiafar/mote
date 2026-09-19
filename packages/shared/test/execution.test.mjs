import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalRunStatus,executionEnvelope,retryDelay,standardRetryPolicy} from '../dist/execution.js';

test('legacy states are additive-normalized without changing their wire meaning',()=>{
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

test('unknown legacy status remains runnable instead of becoming a destructive failure',()=>{
  const value=executionEnvelope({status:'old_pending_state',attempts:1});
  assert.equal(value.status,'waiting');
  assert.equal(value.failure,undefined);
  assert.ok(value.allowedActions.includes('continue'));
});
