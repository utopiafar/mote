import test from 'node:test';
import assert from 'node:assert/strict';
import {parameterSchemaSpecToJsonSchema} from '@deepseek-ai/dsh-tools';
import {ToolRegistry} from '../dist/tools/registry.js';
import {toolInputSchema} from '../dist/tools/runtime-schema.js';
import {ContextToolError} from '../dist/tool-errors.js';
import {createOriginalReadPack} from '../dist/tools/packs/originals.js';
import {createAttributionPack} from '../dist/tools/packs/attribution.js';

const record = (overrides = {}) => ({
  id: 'generated-original',
  capturedAt: '2026-09-01T10:00:00.000Z',
  appName: 'Generated App',
  deviceId: 'generated-device',
  sourceType: 'note',
  ocrText: 'Generated original text with an emoji 😀 and a tail.',
  ...overrides,
});

const makePort = ({records = {}, scope = {}, calls = []} = {}) => ({
  tool: {name: 'generated-pin', version: '1', fingerprint: 'f'.repeat(64)},
  scope,
  signal: new AbortController().signal,
  assertCurrent() { calls.push(['assert']); },
  async read(operation, ...args) {
    calls.push([operation, args]);
    const value = records[operation];
    if (value === undefined) throw new Error('fixture reader has no ' + operation);
    return typeof value === 'function' ? value(...args) : value;
  },
  actionCatalog() { throw new Error('fixture never compares calendars'); },
  progress(message) { calls.push(['progress', message]); },
});

function registryFixture() {
  const registry = new ToolRegistry();
  for (const descriptor of [...createOriginalReadPack({timeZone: 'UTC'}), ...createAttributionPack()]) registry.register(descriptor);
  const snapshot = registry.snapshot(registry.registered());
  const pin = name => {
    const entry = snapshot.entries.find(candidate => candidate.name === name);
    assert.ok(entry, 'missing registered tool ' + name);
    return {name: entry.name, version: entry.version, fingerprint: entry.fingerprint};
  };
  return {registry, snapshot, run: (name, args, port) => snapshot.resolve(pin(name)).execute(args, port)};
}

test('pack descriptors pin the existing schemas and only declare Host read operations they use', () => {
  const {snapshot} = registryFixture();
  const byName = new Map(snapshot.entries.map(entry => [entry.name, entry]));
  assert.deepEqual([...byName.keys()].sort(), ['attribution_context', 'context_evidence', 'evidence', 'search_context', 'timeline']);
  for (const name of ['search_context', 'timeline', 'evidence', 'context_evidence']) assert.equal(byName.get(name).kind, 'originals');
  assert.equal(byName.get('attribution_context').kind, 'metadata');
  assert.deepEqual(byName.get('search_context').requires, ['search']);
  assert.deepEqual(byName.get('timeline').requires, ['timeline']);
  assert.deepEqual(byName.get('evidence').requires, ['evidence']);
  assert.deepEqual(byName.get('context_evidence').requires, ['evidence']);
  assert.deepEqual(byName.get('attribution_context').requires, ['evidence', 'sourceContext', 'materialRead']);
  // The published schema is the one production adapters compile, closed at the root.
  for (const entry of snapshot.entries) {
    const expected = {...parameterSchemaSpecToJsonSchema(entry.fields), additionalProperties: false};
    assert.deepEqual(toolInputSchema(entry.fields), expected);
  }
  const wire = JSON.parse(JSON.stringify(snapshot));
  assert.equal(wire.entries.length, 5);
  assert.equal('parse' in wire.entries[0] || 'execute' in wire.entries[0], false, 'snapshots stay pure DTOs');
});

test('invalid search/timeline arguments fail before any reader call', async () => {
  const {run} = registryFixture(), calls = [], port = makePort({calls});
  await assert.rejects(run('search_context', {query: 'x'.repeat(2001)}, port), error => error instanceof ContextToolError && error.code === 'invalid_tool_arguments' && error.recovery === 'correct_arguments');
  await assert.rejects(run('timeline', {cursor: ''}, port), error => error instanceof ContextToolError && error.code === 'invalid_tool_arguments');
  await assert.rejects(run('timeline', {after: '2026-09-02T00:00:00.000Z', before: '2026-09-01T00:00:00.000Z'}, port), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(run('search_context', {query: 'ok', deviceId: 'other'}, makePort({scope: {deviceId: 'generated-device'}})), error => error.code === 'invalid_tool_arguments');
  assert.deepEqual(calls.filter(([operation]) => operation !== 'assert'), [], 'rejected arguments never reach the reader');
});

test('search and timeline project UTF-16 safe previews and keep pagination', async () => {
  const {run} = registryFixture();
  const searchCalls = [];
  const search = await run('search_context', {query: 'emoji'}, makePort({calls: searchCalls, records: {search: [record()]}}));
  assert.equal(search.source, 'untrusted_personal_context');
  assert.equal(search.data.length, 1);
  assert.ok(search.data[0].textRange.nextOffset === null || Number.isInteger(search.data[0].textRange.nextOffset));
  assert.equal(search.data[0].textRange.total, record().ocrText.length);
  assert.equal(searchCalls.filter(([operation]) => operation === 'search').length, 1);

  const timeline = await run('timeline', {}, makePort({records: {timeline: {items: [record()], nextCursor: 'next-page', totalCount: 9}}}));
  assert.deepEqual(timeline.pagination, {nextCursor: 'next-page', totalCount: 9});
  assert.equal(timeline.data[0].id, 'generated-original');
  assert.equal(timeline.data[0].timeZone, 'UTC');
});

test('evidence pages stay inside the model paging window and never split a surrogate pair', async () => {
  const {run} = registryFixture();
  const text = 'ab😀cd';
  const page = await run('evidence', {ids: ['generated-original'], offset: 2, length: 1}, makePort({records: {evidence: [record({ocrText: text})]}}));
  assert.equal(page.data.length, 1);
  const projected = page.data[0];
  assert.equal(projected.textRange.total, text.length);
  assert.ok(!/[\uD800-\uDBFF]$/.test(projected.ocrText), 'page never ends on a lone high surrogate');
  assert.ok(!/^[\uDC00-\uDFFF]/.test(projected.ocrText), 'page never starts on a lone low surrogate');
  await assert.rejects(run('evidence', {ids: []}, makePort({records: {evidence: []}})), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(run('evidence', {ids: ['generated-original'], offset: -1}, makePort({records: {evidence: []}})), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(run('evidence', {ids: ['generated-original'], length: 12001}, makePort({records: {evidence: []}})), error => error.code === 'invalid_tool_arguments');
});

test('context_evidence reads one authorized id and rejects an unavailable original', async () => {
  const {run} = registryFixture();
  const page = await run('context_evidence', {id: 'generated-original', offset: 4, length: 12}, makePort({records: {evidence: [record()]}}));
  assert.equal(page.record.id, 'generated-original');
  assert.deepEqual([page.record.textRange.start, page.record.textRange.end], [4, 16]);
  await assert.rejects(run('context_evidence', {id: 'generated-missing', offset: 0}, makePort({records: {evidence: []}})), error => error instanceof ContextToolError && error.code === 'invalid_evidence_range');
  await assert.rejects(run('context_evidence', {id: 'generated-original', offset: 2}, makePort({records: {evidence: [record({ocrText: 'a😀b'})]}})), error => error.code === 'invalid_evidence_range', 'a low-surrogate start splits a UTF-16 pair');
});

test('attribution pages keep the fingerprint continuation and never grant citations', async () => {
  const {run} = registryFixture();
  const attributionContext = {version: 1, ownerRelation: 'owner', basis: 'default', correction: {version: 1, ownerRelation: 'owner'}};
  const portFor = () => makePort({records: {evidence: [record({attributionContext})]}});
  const first = await run('attribution_context', {id: 'generated-original', offset: 0, length: 20}, portFor());
  assert.equal(first.source, 'untrusted_personal_context');
  assert.equal(first.data.citationAuthority, false);
  assert.match(first.data.contextFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.data.offset, 0);
  assert.equal(first.data.total, JSON.stringify(attributionContext).length);
  assert.ok(first.data.nextOffset !== null, 'fixture context is longer than one short page');
  const second = await run('attribution_context', {id: 'generated-original', offset: first.data.nextOffset, length: 20, expectedFingerprint: first.data.contextFingerprint}, portFor());
  assert.equal(second.data.offset, first.data.nextOffset);
  assert.equal(second.data.contextFingerprint, first.data.contextFingerprint);
  await assert.rejects(run('attribution_context', {id: 'generated-original', offset: 1, length: 20, expectedFingerprint: 'a'.repeat(64)}, portFor()), error => error instanceof ContextToolError && error.code === 'attribution_context_changed' && error.recovery === 'correct_arguments');
  await assert.rejects(run('attribution_context', {id: 'generated-original', offset: 10}, portFor()), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(run('attribution_context', {id: 'generated-original', ref: 'material:(mat_' + 'a'.repeat(64) + ')@' + 'b'.repeat(64) + '}'}, portFor()), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(run('attribution_context', {id: 'generated-original', sourceContextRef: 'source_ctx'}, portFor()), error => error.code === 'invalid_tool_arguments');
});

test('attribution resolves only the locator it was given and keeps scope failures before disclosure', async () => {
  const {run} = registryFixture();
  const materialRefValue = `material:mat_${'a'.repeat(64)}@${'b'.repeat(64)}`;
  const materialPage = await run('attribution_context', {ref: materialRefValue}, makePort({records: {materialRead: {material: {ref: materialRefValue, attributionContext: {version: 1, ownerRelation: 'owner', basis: 'owner_material'}}, text: '', textRange: {offset: 0, total: 0, nextOffset: null}, spans: [], originalRefs: [], originalRefsTotal: 0, originalRefsTruncated: false}}}));
  assert.equal(materialPage.data.ref, materialRefValue);
  assert.equal(materialPage.data.citationAuthority, false);

  const sourcePage = await run('attribution_context', {sourceContextRef: 'generated-source-context'}, makePort({records: {sourceContext: {attributionContext: {version: 1, ownerRelation: 'unknown', basis: 'owner_source'}}}}));
  assert.equal(sourcePage.data.sourceContextRef, 'generated-source-context');

  await assert.rejects(run('attribution_context', {id: 'generated-original'}, makePort({scope: {deviceId: 'another-device'}, records: {evidence: [record()]}})), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(run('attribution_context', {ref: 'material:not-a-ref'}, makePort({records: {}})), error => error.code === 'invalid_tool_arguments');
});

