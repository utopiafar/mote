import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolRegistry} from '../dist/tools/registry.js';
import {createSourceReadPack} from '../dist/tools/packs/sources.js';
import {createFileReadPack} from '../dist/tools/packs/files.js';
import {CONTEXT_TOOLS} from '../dist/context-tools.js';
import {ContextToolError} from '../dist/tool-errors.js';

const CURRENT = '11111111-1111-4111-8111-111111111111';
const TOMBSTONE = '22222222-2222-4222-8222-222222222222';
const REFERENCE = '33333333-3333-4333-8333-333333333333';
const UNKNOWN = '44444444-4444-4444-8444-444444444444';
const invalid = error => error.code === 'invalid_tool_arguments';

const makePort = (reader, scope = {}) => ({
  tool: {name: 'fixture_pack', version: '1', fingerprint: 'f'.repeat(64)},
  scope,
  signal: new AbortController().signal,
  assertCurrent() {},
  read(operation, args) {return reader[operation](args);},
  actionCatalog() {throw new Error('pack must not compare calendars');},
  progress() {throw new Error('pack must not publish progress');},
});

const fileEvidence = (startMs = 0) => ({captureId: '55555555-5555-4555-8555-555555555555', revision: '2', artifactId: '66666666-6666-4666-8666-666666666666', chunkId: '77777777-7777-4777-8777-777777777777', startMs, endMs: startMs + 1000});
const record = (id, extra = {}) => ({id, deviceId: 'generated-device', capturedAt: '2026-01-05T00:00:00.000Z', appName: 'Generated', ocrText: 'Generated text', provenance: {sourceId: 'source-generated', revision: 1}, ...extra});
const makeReader = (overrides = {}) => {
  const calls = {};
  const track = (name, fn) => (args) => {calls[name] = [...(calls[name] ?? []), args]; return fn(args);};
  return {
    calls,
    sources: track('sources', () => ({items: [{sourceId: 'source-generated', name: 'Generated source'}], nextCursor: 'source-next'})),
    sourceItems: track('sourceItems', () => ({
      items: [
        record(CURRENT, {ocrText: 'Current generated revision', provenance: {sourceId: 'source-generated', revision: 2}}),
        record(TOMBSTONE, {ocrText: '', provenance: {sourceId: 'source-generated', revision: 1, deleted: true}}),
        record(REFERENCE, {ocrText: '', provenance: {sourceId: 'source-generated', revision: 1, layer: 'reference'}}),
      ],
      nextCursor: 'items-next',
      totalCount: 3,
    })),
    sourceHistory: track('sourceHistory', () => [record(CURRENT, {provenance: {sourceId: 'source-generated', revision: 1}})]),
    readFileEvidence: track('readFileEvidence', args => {
      const text = '0123456789abcdefghijklmnopqrstuvwxyz'.repeat(4);
      const start = Math.min(args.offset, text.length), end = Math.min(start + args.length, text.length);
      return {status: 'available', reason: 'generated', record: record(args.id, {ocrText: text.slice(start, end), fileEvidence: fileEvidence(0)})};
    }),
    fileChunks: track('fileChunks', args => Array.from({length: 30}, (_, index) => record(`chunk-${args.offset + index}`, {ocrText: `chunk text ${args.offset + index}`, fileEvidence: fileEvidence((args.offset + index) * 1000)}))),
    ...overrides,
  };
};

const registryWithPacks = () => {
  const registry = new ToolRegistry();
  for (const descriptor of [...createSourceReadPack({timeZone: 'Asia/Shanghai'}), ...createFileReadPack({timeZone: 'Asia/Shanghai'})]) registry.register(descriptor);
  return registry;
};

const resolve = (registry, name) => {
  const snapshot = registry.snapshot(registry.registered());
  const entry = snapshot.entries.find(candidate => candidate.name === name);
  return snapshot.resolve({name: entry.name, version: entry.version, fingerprint: entry.fingerprint});
};

test('source/file packs publish the frozen declarations and the current public schemas', () => {
  const registry = registryWithPacks();
  const snapshot = registry.snapshot(registry.registered());
  assert.deepEqual(snapshot.entries.map(entry => entry.name).sort(), ['file_chunks', 'read_file_evidence', 'source_history', 'source_items', 'sources']);
  const expected = {
    sources: ['metadata', ['sources']],
    source_items: ['originals', ['sourceItems']],
    source_history: ['originals', ['sourceHistory']],
    read_file_evidence: ['originals', ['readFileEvidence']],
    file_chunks: ['originals', ['fileChunks']],
  };
  for (const entry of snapshot.entries) {
    const [, description, fields] = CONTEXT_TOOLS.find(([name]) => name === entry.name);
    assert.equal(entry.description, description);
    assert.deepEqual(entry.fields, fields);
    assert.equal(entry.exposure, 'catalog');
    assert.equal(entry.version, '1');
    assert.equal(entry.kind, expected[entry.name][0]);
    assert.deepEqual(entry.requires, expected[entry.name][1]);
  }
  const plain = new ToolRegistry(), zoned = new ToolRegistry();
  for (const descriptor of createFileReadPack()) plain.register(descriptor);
  for (const descriptor of createFileReadPack({timeZone: 'Asia/Shanghai'})) zoned.register(descriptor);
  assert.deepEqual(plain.snapshot(plain.registered()), zoned.snapshot(zoned.registered()));
});

test('sources normalizes shape arguments and returns the untrusted body; the parent keeps scope and page limits', async () => {
  const reader = makeReader(), port = makePort(reader, {after: '2026-01-01T00:00:00.000Z', deviceId: 'scope-device', limit: 6});
  const tool = resolve(registryWithPacks(), 'sources');
  const args = {query: 'generated source', after: '2026-01-10T00:00:00.000Z', before: '2026-03-01T00:00:00.000Z', deviceId: 'scope-device', limit: 100, cursor: 'source-cursor'};
  assert.deepEqual(await tool.execute(args, port), {source: 'untrusted_personal_context', data: {items: [{sourceId: 'source-generated', name: 'Generated source'}], nextCursor: 'source-next'}});
  assert.deepEqual(reader.calls.sources, [{after: '2026-01-10T00:00:00.000Z', before: '2026-03-01T00:00:00.000Z', deviceId: 'scope-device', limit: 6, cursor: 'source-cursor', query: 'generated source'}]);
  for (const bad of [{after: 'not-a-time'}, {query: 'x'.repeat(501)}, {limit: 0}, {cursor: 'c'.repeat(4097)}, {deviceId: 3}, {deviceId: 'other-device'}]) {
    await assert.rejects(tool.execute({...args, ...bad}, port), invalid);
  }
  assert.equal(reader.calls.sources.length, 1);
});

test('source_items preserves tombstones, references, pagination and display projection without promoting them', async () => {
  const reader = makeReader(), port = makePort(reader, {deviceId: 'scope-device', limit: 6});
  const tool = resolve(registryWithPacks(), 'source_items');
  const args = {sourceId: 'source-generated', kind: 'event', includeDeleted: true, cursor: 'items-cursor', after: '2026-01-05T00:00:00.000Z', limit: 10};
  const {source, data, pagination} = await tool.execute(args, port);
  assert.equal(source, 'untrusted_personal_context');
  assert.deepEqual(reader.calls.sourceItems, [{after: '2026-01-05T00:00:00.000Z', deviceId: 'scope-device', limit: 6, cursor: 'items-cursor', sourceId: 'source-generated', kind: 'event', includeDeleted: true}]);
  assert.deepEqual(pagination, {nextCursor: 'items-next', totalCount: 3});
  assert.deepEqual(data.map(item => item.id), [CURRENT, TOMBSTONE, REFERENCE]);
  assert.equal(data[0].displayCapturedAt, '2026-01-05T08:00:00+08:00');
  assert.equal(data[0].textRange.end, data[0].ocrText.length);
  assert.ok(data[0].textRange.end <= 600);
  assert.equal(data.find(item => item.id === TOMBSTONE).provenance.deleted, true);
  assert.equal(data.find(item => item.id === REFERENCE).provenance.layer, 'reference');
  assert.equal(data.find(item => item.id === CURRENT).provenance.revision, 2);
  for (const bad of [{includeDeleted: 'yes'}, {sourceId: 's'.repeat(129)}, {limit: 0}, {after: 'not-a-time'}, {deviceId: 'other-device'}]) {
    await assert.rejects(tool.execute({...args, ...bad}, port), invalid);
  }
  assert.equal(reader.calls.sourceItems.length, 1);
});

test('source_history projects historical revisions and leaves discovery to the parent port', async () => {
  const reader = makeReader(), port = makePort(reader, {after: '2026-01-01T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z', deviceId: 'scope-device', limit: 6});
  const tool = resolve(registryWithPacks(), 'source_history');
  const result = await tool.execute({id: CURRENT}, port);
  assert.equal(result.source, 'untrusted_personal_context');
  assert.deepEqual(reader.calls.sourceHistory, [{after: '2026-01-01T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z', deviceId: 'scope-device', limit: 6, id: CURRENT}]);
  assert.equal(result.data[0].id, CURRENT);
  assert.equal(result.data[0].provenance.revision, 1);
  assert.equal(result.data[0].displayCapturedAt, '2026-01-05T08:00:00+08:00');
  for (const id of [42, null, {}]) await assert.rejects(tool.execute({id}, port), invalid);
  assert.equal(reader.calls.sourceHistory.length, 1);
});

test('read_file_evidence keeps UTF-16 offsets, result status and local record projection', async () => {
  const reader = makeReader(), port = makePort(reader, {deviceId: 'scope-device'});
  const tool = resolve(registryWithPacks(), 'read_file_evidence');
  const defaults = await tool.execute({id: CURRENT}, port);
  assert.deepEqual(reader.calls.readFileEvidence[0], {deviceId: 'scope-device', id: CURRENT, offset: 0, length: 8000});
  assert.equal(defaults.source, 'untrusted_personal_context');
  assert.equal(defaults.data.status, 'available');
  assert.equal(defaults.data.reason, 'generated');
  assert.equal(defaults.data.record.textRange.start, 0);
  const paged = await tool.execute({id: CURRENT, offset: 5, length: 12}, port);
  assert.deepEqual(reader.calls.readFileEvidence[1], {deviceId: 'scope-device', id: CURRENT, offset: 5, length: 12});
  assert.equal(paged.data.record.ocrText, '56789abcdefg');
  assert.equal(paged.data.record.textRange.end, 12);
  assert.equal(paged.data.record.fileEvidence.revision, '2');
  for (const bad of [{offset: -1}, {offset: 10000001}, {offset: 1.5}, {length: 0}, {length: 16001}, {id: 42}, {id: null}]) {
    await assert.rejects(tool.execute({id: CURRENT, ...bad}, port), invalid);
  }
  assert.equal(reader.calls.readFileEvidence.length, 2);
});

test('file_chunks keeps chunk offsets, page cursor and display projection', async () => {
  const reader = makeReader(), port = makePort(reader, {deviceId: 'scope-device'});
  const tool = resolve(registryWithPacks(), 'file_chunks');
  const first = await tool.execute({id: CURRENT}, port);
  assert.deepEqual(reader.calls.fileChunks[0], {deviceId: 'scope-device', id: CURRENT, offset: 0});
  assert.equal(first.source, 'untrusted_personal_context');
  assert.equal(first.data.length, 30);
  assert.deepEqual(first.pagination, {nextCursor: '30'});
  assert.equal(first.data[0].fileEvidence.startMs, 0);
  assert.equal(first.data[0].displayCapturedAt, '2026-01-05T08:00:00+08:00');
  const next = await tool.execute({id: CURRENT, offset: 30}, port);
  assert.deepEqual(reader.calls.fileChunks[1], {deviceId: 'scope-device', id: CURRENT, offset: 30});
  assert.deepEqual(next.pagination, {nextCursor: '60'});
  assert.equal(next.data[0].fileEvidence.startMs, 30000);
  const short = makeReader({fileChunks: () => [record('chunk-short')]});
  assert.deepEqual((await tool.execute({id: CURRENT}, makePort(short))).pagination, {nextCursor: null});
  for (const bad of [{offset: -1}, {offset: 1.5}, {id: 42}, {id: null}]) {
    await assert.rejects(tool.execute({id: CURRENT, ...bad}, port), invalid);
  }
  assert.equal(reader.calls.fileChunks.length, 2);
});

test('the parent port remains the discovery authority for unknown file identities', async () => {
  const reader = makeReader({
    readFileEvidence: () => {throw new ContextToolError('invalid_tool_arguments', 'Discover the file before requesting evidence', 'correct_arguments');},
    fileChunks: () => {throw new ContextToolError('invalid_tool_arguments', 'Discover the file before reading its chunks', 'correct_arguments');},
  });
  const port = makePort(reader);
  await assert.rejects(resolve(registryWithPacks(), 'read_file_evidence').execute({id: UNKNOWN}, port), invalid);
  await assert.rejects(resolve(registryWithPacks(), 'file_chunks').execute({id: UNKNOWN}, port), invalid);
});
