import test from 'node:test';
import assert from 'node:assert/strict';
import {hasCompleteTokenUsage} from '@mote/shared';
import {createRuntimeUsageEvents, normalizeRuntimeUsage, runtimeUsageComplete} from '../dist/host/runtime-events.js';

const sample = (total = 1000, extra = {}) => ({requests: 1, reportedRequests: 1, inputTokens: total - 100, outputTokens: 100, totalTokens: total, ...extra});
const sparse = {requests: 1, reportedRequests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15};

test('normalization copies known fields, keeps unknown cache buckets unknown and rejects malformed samples', () => {
  assert.deepEqual(normalizeRuntimeUsage({...sample(1000), cacheReadTokens: 700, cacheWriteTokens: 0, reasoningTokens: 15, measurement: 'thread_cumulative', complete: true}), {
    requests: 1, reportedRequests: 1, inputTokens: 900, outputTokens: 100, totalTokens: 1000,
    cacheReadTokens: 700, cacheWriteTokens: 0, reasoningTokens: 15, measurement: 'thread_cumulative', complete: true,
  });
  const unknownCache = normalizeRuntimeUsage(sparse);
  assert.deepEqual(unknownCache, sparse);
  assert.ok(!Object.hasOwn(unknownCache, 'cacheReadTokens'), 'a missing cache bucket stays unknown, never zero');
  assert.ok(!Object.hasOwn(unknownCache, 'cacheWriteTokens'));
  assert.deepEqual(normalizeRuntimeUsage({...sparse, privateBody: 'generated-private'}), sparse, 'unknown provider fields are not forwarded');
  for (const invalid of [undefined, null, [], 'usage', {requests: 1}, {...sparse, inputTokens: -1}, {...sparse, outputTokens: 1.5},
    {...sparse, totalTokens: Number.POSITIVE_INFINITY}, {...sparse, cacheReadTokens: Number.NaN}, {...sparse, measurement: 'incremental'},
    {...sparse, complete: 'yes'}, new (class Usage { requests = 1; reportedRequests = 1; inputTokens = 10; outputTokens = 5; totalTokens = 15; })()]) {
    assert.equal(normalizeRuntimeUsage(invalid), undefined);
  }
});

test('partial and interrupted samples stay incomplete while a fully reported sample is complete', () => {
  const partial = normalizeRuntimeUsage({requests: 2, reportedRequests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15});
  assert.equal(partial.complete, undefined);
  assert.equal(runtimeUsageComplete(partial), false);
  assert.equal(hasCompleteTokenUsage(partial), false);
  const interrupted = normalizeRuntimeUsage({...sparse, complete: false});
  assert.equal(interrupted.complete, false);
  assert.equal(runtimeUsageComplete(interrupted), false);
  assert.equal(runtimeUsageComplete(normalizeRuntimeUsage(sparse)), true);
  const thread = normalizeRuntimeUsage({...sparse, measurement: 'thread_cumulative', complete: true, requests: 0, reportedRequests: 0});
  assert.equal(runtimeUsageComplete(thread), true);
  assert.equal(runtimeUsageComplete(normalizeRuntimeUsage({...sparse, measurement: 'thread_cumulative', requests: 0, reportedRequests: 0})), false);
});

test('duplicate cumulative samples are observed once per attempt while richer or distinct updates survive', () => {
  const seen = [];
  const events = createRuntimeUsageEvents(event => seen.push(event));
  const first = sample(1000);
  assert.equal(events.emit('attempt-a', first), 'observed');
  assert.equal(events.emit('attempt-a', structuredClone(first)), 'duplicate');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].attemptId, 'attempt-a');
  assert.ok(Object.isFrozen(seen[0].usage));
  assert.equal(events.emit('attempt-a', {...first, cacheReadTokens: 250}), 'observed', 'a later known cache bucket is new information');
  assert.equal(events.emit('attempt-a', {...first, cacheReadTokens: 250, complete: false}), 'observed', 'interruption is new information');
  assert.equal(events.emit('attempt-b', first), 'observed', 'another attempt owns its own series');
  assert.equal(events.emit('attempt-c', {...first, privateBody: 'generated-private'}), 'observed');
  assert.equal(events.emit('attempt-c', first), 'duplicate', 'unknown fields do not create a distinct observation');
  assert.equal(events.emit('attempt-c', {...first, inputTokens: -1}), 'invalid');
  assert.equal(events.emit('', first), 'invalid');
  assert.equal(seen.length, 5);
  events.forget('attempt-a');
  assert.equal(events.emit('attempt-a', first), 'observed');
});

test('a throwing observer cannot change the accepted series or later observations', () => {
  const seen = [];
  let fail = true;
  const events = createRuntimeUsageEvents(event => {
    seen.push(event);
    if (fail) throw new Error('Generated observer failure');
    event.usage.totalTokens = 1;
  });
  const first = sample(1000);
  assert.equal(events.emit('attempt-a', first), 'observed');
  assert.equal(seen.length, 1);
  assert.equal(events.emit('attempt-a', first), 'duplicate');
  assert.equal(seen.length, 1, 'a throwing observer cannot make the accepted sample replayable');
  fail = false;
  assert.equal(events.emit('attempt-a', sample(1200)), 'observed');
  assert.equal(seen.length, 2);
  assert.equal(events.emit('attempt-a', sample(1200)), 'duplicate');
  assert.ok(Object.isFrozen(seen[0].usage), 'observation receives an immutable copy');
});

test('a cancelled stream keeps its partial usage partial and cannot be promoted by a repeat', () => {
  const seen = [];
  const events = createRuntimeUsageEvents(event => seen.push(event));
  const partial = {requests: 2, reportedRequests: 1, inputTokens: 100, outputTokens: 50, totalTokens: 150, complete: false};
  assert.equal(events.emit('attempt-a', partial), 'observed');
  assert.deepEqual(seen[0].usage, partial);
  assert.equal(runtimeUsageComplete(seen[0].usage), false);
  assert.equal(events.emit('attempt-a', partial), 'duplicate');
  assert.equal(seen.length, 1);
  assert.equal(events.emit('attempt-a', {...partial, complete: undefined}), 'observed');
  assert.equal(runtimeUsageComplete(seen[1].usage), false, 'the missing request keeps the sample unknown even without the explicit flag');
});
