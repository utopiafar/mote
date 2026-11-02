import test from 'node:test';
import assert from 'node:assert/strict';
// P0 schema checks run directly on the new production parser; no SDK, model or assembled Host.
import {parseRuntimeOutcome, RuntimeContractError} from '../src/runtime/contracts.ts';

const completed = text => ({terminal: {kind: 'completed'}, candidate: {text}});

test('runtime boundary accepts candidate text, leaving semantic/citation validation to Host', () => {
  for (const text of ['', 'not JSON', JSON.stringify({answer: 'Generated answer', citationIds: ['unread-id']})]) {
    assert.deepEqual(parseRuntimeOutcome(completed(text)), completed(text));
  }
  // Even well-formed model JSON is only text here, not a product result or proof of retrieved evidence.
  assert.throws(() => parseRuntimeOutcome({answer: 'Generated answer', citations: [], trace: [], runId: 'forged'}), RuntimeContractError);
  assert.throws(() => parseRuntimeOutcome({terminal: {kind: 'completed'}}), RuntimeContractError);
});

test('runtime cannot submit Host receipts, grants, evidence or result authority at any outcome layer', () => {
  for (const [key, authority] of Object.entries({
    citations: [{id: 'unread-id'}], imageReadReceipts: [], evidenceReadRanges: [], evidenceDependencies: {ids: ['unread-id']},
    sourceContextDependencies: [], contextUsage: {}, ledger: {}, grant: {}, result: {}, runId: 'forged',
  })) {
    for (const payload of [
      {...completed('Generated'), [key]: authority},
      {terminal: {kind: 'completed'}, candidate: {text: 'Generated', [key]: authority}},
      {terminal: {kind: 'completed', [key]: authority}, candidate: {text: 'Generated'}},
    ]) assert.throws(() => parseRuntimeOutcome(payload), RuntimeContractError, key);
  }
});

test('typed terminal distinguishes output exhaustion from success without accepting failure candidates', () => {
  const truncated = {terminal: {kind: 'output_limit'}, candidate: {text: '{"answer":"truncated'}};
  assert.deepEqual(parseRuntimeOutcome(truncated), truncated);
  assert.deepEqual(parseRuntimeOutcome({terminal: {kind: 'output_limit'}}), {terminal: {kind: 'output_limit'}});
  for (const terminal of [
    {kind: 'failed', reason: 'tools_unverified'}, {kind: 'failed', reason: 'tool_failure'},
    {kind: 'cancelled', cause: 'revoked'}, {kind: 'cancelled', cause: 'deadline_exceeded'}, {kind: 'yielded'},
  ]) {
    assert.deepEqual(parseRuntimeOutcome({terminal}), {terminal});
    assert.throws(() => parseRuntimeOutcome({terminal, candidate: {text: 'Do not publish a late answer'}}), RuntimeContractError);
  }
  for (const terminal of [{kind: 'unknown'}, {kind: 'failed', reason: 'raw provider text'}, {kind: 'cancelled'}, {kind: 'completed', reason: 'tool_failure'}]) {
    assert.throws(() => parseRuntimeOutcome({terminal}), RuntimeContractError);
  }
});

test('typed provider failure retains retry/admission facts without raw exception fields', () => {
  const providerFailure = {category: 'transient', code: 'rate_limited', retryAfterMs: 1250, executionStarted: false, admissionWaiting: true};
  const outcome = {terminal: {kind: 'failed', reason: 'provider_error', providerFailure}};
  assert.deepEqual(parseRuntimeOutcome(outcome), outcome);
  for (const bad of [
    {...providerFailure, message: 'private-key'}, {...providerFailure, retryAfterMs: -1},
    {...providerFailure, retryAfterMs: Infinity}, {...providerFailure, executionStarted: true},
    {...providerFailure, category: 'raw message'}, {...providerFailure, code: 'free-form provider error'},
  ]) assert.throws(() => parseRuntimeOutcome({terminal: {...outcome.terminal, providerFailure: bad}}), RuntimeContractError);
});

test('candidate parsing does not run getters or coerce object-shaped discriminants', () => {
  let called = false;
  const accessor = Object.defineProperty({}, 'text', {get() { called = true; return 'private'; }});
  const coercion = {toString() { called = true; return 'revoked'; }};
  for (const payload of [
    {terminal: {kind: 'completed'}, candidate: accessor},
    {terminal: {kind: 'cancelled', cause: coercion}},
    {terminal: {kind: 'failed', reason: coercion}},
    {terminal: {kind: 'failed', reason: 'provider_error', providerFailure: {category: coercion, code: 'provider_failed'}}},
    {...completed('Generated'), [Symbol('authority')]: true},
  ]) assert.throws(() => parseRuntimeOutcome(payload), RuntimeContractError);
  assert.equal(called, false);
  const source = completed('Generated'), parsed = parseRuntimeOutcome(source);
  source.candidate.text = 'changed after parsing';
  assert.equal(parsed.candidate.text, 'Generated');
});
