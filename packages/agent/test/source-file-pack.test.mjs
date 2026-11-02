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

const makeReader = (overrides = {}) => {
  const calls = {};
  const track = (name, fn) => (args) => {calls[name] = [...(calls[name] ?? []), args]; return fn(args);};
  return {
    calls,
    sources: track('sources', () => ({items: [{sourceId: 'source-generated', name: 'Generated source'}], nextCursor: 'source-next'})),
    sourceItems: track('sourceItems', () => ({
      items: [
        {id: CURRENT, provenance: {sourceId: 'source-generated', revision: 2}, ocrText: 'Current generated revision'},
        {id: TOMBSTONE, provenance: {sourceId: 'source-generated', revision: 1, deleted: true}, ocrText: ''},
        {id: REFERENCE, provenance: {sourceId: 'source-generated', revision: 1, layer: 'reference'}, ocrText: ''},
      ],
      nextCursor: 'items-next',
      totalCount: 3,
    })),
    sourceHistory: track('sourceHistory', () => [{id: CURRENT, revision: 1, ocrText: 'Historical generated revision'}]),
    readFileEvidence: track('readFileEvidence', args => {
      const text = '0123456789abcdefghijklmnopqrstuvwxyz'.repeat(4);
      const start = Math.min(args.offset, text.length), end = Math.min(start + args.length, text.length);
      return {status: 'available', record: {id: args.id, ocrText: text.slice(start, end), textRange: {start, end, total: text.length, nextOffset: end < text.length ? end : null}, fileEvidence: {version: 2, processingState: 'ready'}}};
    }),
    fileChunks: track('fileChunks', args => Array.from({length: 30}, (_, index) => ({id: `chunk-${args.offset + index}`, chunkIndex: args.offset + index, fileEvidence: {chunkOffset: args.offset + index}}))),
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

test('source/file packs publish the current fields and explicit catalog declarations', () => {
  const registry = registryWithPacks();
  const snapshot = registry.snapshot(registry.registered());
  assert.deepEqual(snapshot.entries.map(entry => entry.name).sort(), ['file_chunks', 'read_file_evidence', 'source_history', 'source_items', 'sources']);
  for (const entry of snapshot.entries) {
    const [, description, fields] = CONTEXT_TOOLS.find(([name]) => name === entry.name);
    assert.equal(entry.description, description);
    assert.deepEqual(entry.fields, fields);
    assert.equal(entry.exposure, 'catalog');
    assert.equal(entry.requires.length, 1);
  }
  const plain = new ToolRegistry(), zoned = new ToolRegistry();
  for (const descriptor of createFileReadPack()) plain.register(descriptor);
  for (const descriptor of createFileReadPack({timeZone: 'Asia/Shanghai'})) zoned.register(descriptor);
  assert.deepEqual(plain.snapshot(plain.registered()), zoned.snapshot(zoned.registered()));
});

test('sources keeps query/cursor/device inside the authorized scope and rejects invalid filters before I/O', async () => {
  const reader = makeReader(), port = makePort(reader, {after: '2026-01-01T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z', deviceId: 'generated-device'});
  const tool = resolve(registryWithPacks(), 'sources');
  const args = {query: 'generated source', after: '2026-01-10T00:00:00.000Z', before: '2026-03-01T00:00:00.000Z', deviceId: 'generated-device', limit: 5, cursor: 'source-cursor'};
  assert.deepEqual(await tool.execute(args, port), {items: [{sourceId: 'source-generated', name: 'Generated source'}], nextCursor: 'source-next'});
  assert.deepEqual(reader.calls.sources, [{after: '2026-01-10T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z', deviceId: 'generated-device', limit: 5, cursor: 'source-cursor', query: 'generated source'}]);
  for (const bad of [{deviceId: 'other-device'}, {after: 'not-a-time'}, {query: 'x'.repeat(501)}, {limit: 0}, {cursor: 'c'.repeat(4097)}]) {
    await assert.rejects(tool.execute({...args, ...bad}, port), invalid);
  }
  assert.equal(reader.calls.sources.length, 1);
});

test('source_items preserves tombstones, references and pagination without promoting them', async () => {
  const reader = makeReader(), port = makePort(reader, {deviceId: 'generated-device', after: '2026-01-01T00:00:00.000Z'});
  const tool = resolve(registryWithPacks(), 'source_items');
  const args = {sourceId: 'source-generated', kind: 'event', includeDeleted: true, cursor: 'items-cursor', after: '2026-01-05T00:00:00.000Z'};
  const page = await tool.execute(args, port);
  assert.deepEqual(reader.calls.sourceItems, [{after: '2026-01-05T00:00:00.000Z', deviceId: 'generated-device', cursor: 'items-cursor', sourceId: 'source-generated', kind: 'event', includeDeleted: true}]);
  assert.equal(page.nextCursor, 'items-next');
  assert.equal(page.items.find(item => item.id === TOMBSTONE).provenance.deleted, true);
  assert.equal(page.items.find(item => item.id === REFERENCE).provenance.layer, 'reference');
  assert.equal(page.items.find(item => item.id === CURRENT).provenance.revision, 2);
  for (const bad of [{includeDeleted: 'yes'}, {sourceId: 's'.repeat(129)}, {deviceId: 'other-device'}]) {
    await assert.rejects(tool.execute({...args, ...bad}, port), invalid);
  }
  assert.equal(reader.calls.sourceItems.length, 1);
});

test('source_history returns only the requested exact discovered id and historical revisions', async () => {
  const reader = makeReader(), port = makePort(reader, {after: '2026-01-01T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z', deviceId: 'generated-device', limit: 6});
  const tool = resolve(registryWithPacks(), 'source_history');
  assert.deepEqual(await tool.execute({id: CURRENT}, port), [{id: CURRENT, revision: 1, ocrText: 'Historical generated revision'}]);
  assert.deepEqual(reader.calls.sourceHistory, [{after: '2026-01-01T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z', deviceId: 'generated-device', limit: 6, id: CURRENT}]);
  for (const id of ['/etc/passwd', 'https://example.invalid/file', 'has space']) {
    await assert.rejects(tool.execute({id}, port), invalid);
  }
  assert.equal(reader.calls.sourceHistory.length, 1);
});

test('read_file_evidence preserves UTF-16 offsets and rejects paths, URLs and out-of-range requests', async () => {
  const reader = makeReader(), port = makePort(reader, {deviceId: 'generated-device', limit: 7});
  const tool = resolve(registryWithPacks(), 'read_file_evidence');
  const defaults = await tool.execute({id: CURRENT}, port);
  assert.deepEqual(reader.calls.readFileEvidence[0], {deviceId: 'generated-device', limit: 7, id: CURRENT, offset: 0, length: 8000});
  assert.equal(defaults.record.textRange.start, 0);
  assert.equal(defaults.record.fileEvidence.version, 2);
  const paged = await tool.execute({id: CURRENT, offset: 5, length: 12}, port);
  assert.equal(paged.record.textRange.start, 5);
  assert.equal(paged.record.textRange.end, 17);
  assert.equal(paged.record.ocrText, '56789abcdefg');
  for (const bad of [{offset: -1}, {offset: 10000001}, {offset: 1.5}, {length: 0}, {length: 16001}, {id: '/etc/passwd'}, {id: 'https://example.invalid/file'}, {id: 'has space'}]) {
    await assert.rejects(tool.execute({id: CURRENT, ...bad}, port), invalid);
  }
  assert.equal(reader.calls.readFileEvidence.length, 2);
});

test('file_chunks keeps chunk offsets across pages and rejects invalid requests', async () => {
  const reader = makeReader(), port = makePort(reader, {deviceId: 'generated-device'});
  const tool = resolve(registryWithPacks(), 'file_chunks');
  const first = await tool.execute({id: CURRENT}, port);
  assert.equal(first.length, 30);
  assert.deepEqual(reader.calls.fileChunks[0], {deviceId: 'generated-device', id: CURRENT, offset: 0});
  assert.equal(first[0].fileEvidence.chunkOffset, 0);
  const next = await tool.execute({id: CURRENT, offset: 30}, port);
  assert.deepEqual(reader.calls.fileChunks[1], {deviceId: 'generated-device', id: CURRENT, offset: 30});
  assert.equal(next[0].fileEvidence.chunkOffset, 30);
  for (const bad of [{offset: -1}, {offset: 1.5}, {id: '/etc/passwd'}, {id: 'https://example.invalid/file'}, {id: 'has space'}]) {
    await assert.rejects(tool.execute({id: CURRENT, ...bad}, port), invalid);
  }
  assert.equal(reader.calls.fileChunks.length, 2);
});

test('the parent port remains the discovery authority for unknown file identities', async () => {
  const reader = makeReader({
    readFileEvidence: args => {
      if (args.id === UNKNOWN) throw new ContextToolError('invalid_tool_arguments', 'Discover the file before requesting evidence', 'correct_arguments');
      return {status: 'unavailable'};
    },
    fileChunks: args => {
      if (args.id === UNKNOWN) throw new ContextToolError('invalid_tool_arguments', 'Discover the file before reading its chunks', 'correct_arguments');
      return [];
    },
  });
  const port = makePort(reader);
  await assert.rejects(resolve(registryWithPacks(), 'read_file_evidence').execute({id: UNKNOWN}, port), invalid);
  await assert.rejects(resolve(registryWithPacks(), 'file_chunks').execute({id: UNKNOWN}, port), invalid);
});
