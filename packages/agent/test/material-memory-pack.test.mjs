import test from 'node:test';
import assert from 'node:assert/strict';
import {formatEvidenceRef} from '@mote/shared';
import {ToolRegistry} from '../dist/tools/registry.js';
import {createMaterialsPack} from '../dist/tools/packs/materials.js';
import {createMemoriesPack} from '../dist/tools/packs/memories.js';
import {createDerivedNavigationPack} from '../dist/tools/packs/derived-navigation.js';

const materialRef = 'material:mat_' + 'a'.repeat(64) + '@' + 'b'.repeat(64);
const originalId = '00000000-0000-4000-8000-000000000001';
const lifecycle = () => {
  const controller = new AbortController();
  return {signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted(); }};
};
const packs = () => [
  ...createMaterialsPack({timeZone: 'UTC'}),
  ...createMemoriesPack({timeZone: 'UTC'}),
  ...createDerivedNavigationPack({timeZone: 'UTC', contextTime: '2024-01-03T00:00:00.000Z', incrementalEvidenceIds: ['a', 'b', 'c']}),
];
function assembly() {
  const registry = new ToolRegistry(), lease = lifecycle();
  for (const descriptor of packs()) registry.register(descriptor, lease);
  const snapshot = registry.snapshot(registry.registered());
  return {registry, snapshot};
}
function port(responses, scope = {after: '2024-01-01T00:00:00.000Z', before: '2024-02-01T00:00:00.000Z', deviceId: 'generated-device', limit: 5}) {
  const calls = [];
  return {
    calls,
    port: {
      tool: {name: 'generated', version: '1', fingerprint: 'f'.repeat(64)},
      scope, signal: new AbortController().signal,
      assertCurrent() {}, progress() {},
      actionCatalog() { throw Error('unexpected actionCatalog'); },
      async read(operation, ...args) {
        calls.push({operation, args: args.length === 1 ? args[0] : args});
        if (!(operation in responses)) throw Error('unexpected HostSessionPort operation: ' + operation);
        return typeof responses[operation] === 'function' ? responses[operation](...args) : responses[operation];
      },
    },
  };
}
async function execute(snapshot, name, args, session) {
  const entry = snapshot.entries.find(entry => entry.name === name);
  assert.ok(entry, 'missing tool ' + name);
  return snapshot.resolve(entry).execute(args, session);
}

test('all six descriptors register with exact kind/exposure/requires', () => {
  const {registry, snapshot} = assembly();
  assert.deepEqual(registry.registered().map(entry => entry.name).sort(), ['changes', 'context_index', 'material_catalog', 'material_read', 'memories', 'segments']);
  const entries = Object.fromEntries(snapshot.entries.map(entry => [entry.name, entry]));
  assert.deepEqual(entries.material_catalog.requires, ['materialCatalog']);
  assert.deepEqual(entries.material_read.requires, ['materialRead', 'evidence']);
  assert.deepEqual(entries.memories.requires, ['memories']);
  assert.deepEqual(entries.context_index.requires, ['catalog']);
  assert.deepEqual(entries.segments.requires, ['segments']);
  assert.deepEqual(entries.changes.requires, ['evidence']);
  for (const entry of snapshot.entries) assert.equal(entry.kind, 'derived');
  assert.deepEqual([entries.material_catalog.exposure, entries.material_read.exposure, entries.memories.exposure], ['native', 'native', 'native']);
  assert.deepEqual([entries.context_index.exposure, entries.segments.exposure, entries.changes.exposure], ['catalog', 'catalog', 'catalog']);
  assert.equal(JSON.stringify(snapshot).includes('execute'), false);
  assert.equal(JSON.stringify(snapshot).includes('reader'), false);
});

test('material catalog uses the untrusted body and material_read verifies original evidence', async () => {
  const {snapshot} = assembly();
  const catalog = {items: [{id: 'mat_' + 'a'.repeat(64), ref: materialRef}], nextCursor: null};
  const original = {id: originalId, capturedAt: '2024-01-01T00:00:00.000Z', appName: 'A', deviceId: 'generated-device', ocrText: 'body', contentLayer: 'L1_machine_extraction'};
  const readPage = {
    material: {id: 'mat_' + 'a'.repeat(64), ref: materialRef}, text: 'body',
    textRange: {offset: 0, total: 4, nextOffset: null},
    spans: [{blockId: 'block-1', kind: 'text', memberIds: [originalId], pageRange: {start: 0, end: 4}, materialRange: {start: 0, end: 4}}],
    originalRefs: [formatEvidenceRef('capture', originalId)], originalRefsTotal: 1, sourceSpans: [{record: original, offset: 0, length: 4}],
  };
  const session = port({materialCatalog: catalog, materialRead: readPage, evidence: [original]});
  assert.deepEqual(await execute(snapshot, 'material_catalog', {query: 'coding', limit: 2}, session.port), {source: 'untrusted_personal_context', data: catalog});
  assert.equal(session.calls[0].operation, 'materialCatalog');
  assert.equal(session.calls[0].args.query, 'coding');
  await assert.rejects(execute(snapshot, 'material_catalog', {deviceId: 'other'}, session.port), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(execute(snapshot, 'material_catalog', {limit: 0}, session.port), error => error.code === 'invalid_tool_arguments');
  assert.equal(session.calls.length, 1);

  const value = await execute(snapshot, 'material_read', {ref: materialRef, offset: 0, length: 4}, session.port);
  assert.equal(value.source, 'untrusted_personal_context');
  assert.equal(value.data.text, 'body');
  assert.equal(value.data.sourceEvidence.length, 1);
  assert.equal(value.data.sourceEvidence[0].ocrText, 'body');
  assert.deepEqual(value.data.originalRefs, [formatEvidenceRef('capture', originalId)]);
  assert.equal(session.calls[1].operation, 'materialRead');
  assert.equal(session.calls[2].operation, 'evidence');
  assert.deepEqual(session.calls[2].args.ids, [originalId]);
  await assert.rejects(execute(snapshot, 'material_read', {ref: 'material:bad'}, session.port), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(execute(snapshot, 'material_read', {ref: materialRef, offset: -1}, session.port), error => error.code === 'invalid_tool_arguments');
});

test('memories defaults list to durable memory and detail to history without a layer', async () => {
  const {snapshot} = assembly();
  const page = {items: [{id: 'memory-1', evidence: [{quote: 'saved quote', id: 'original-1'}]}], references: []};
  const session = port({memories: page});
  const list = await execute(snapshot, 'memories', {}, session.port);
  assert.equal(session.calls[0].args.layer, 'memory');
  assert.equal(session.calls[0].args.includeHistory, undefined);
  assert.equal(list.source, 'untrusted_personal_context');
  const detail = await execute(snapshot, 'memories', {id: 'memory-1', includeEvidence: true}, session.port);
  assert.equal(session.calls[1].args.includeHistory, true);
  assert.equal(session.calls[1].args.layer, undefined);
  assert.equal(detail.data.items[0].evidence[0].id, 'original-1');
  assert.equal(detail.data.items[0].evidence[0].quote, undefined);
  await assert.rejects(execute(snapshot, 'memories', {includeEvidence: true}, session.port), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(execute(snapshot, 'memories', {layer: 'unknown'}, session.port), error => error.code === 'invalid_tool_arguments');
  assert.equal(session.calls.length, 2);
});

test('derived navigation returns untrusted bodies, overview metadata, and scope-bounded pages', async () => {
  const {snapshot} = assembly();
  const records = [
    {id: 'a', capturedAt: '2024-01-01T00:00:00.000Z', appName: 'A', sourceType: 'screen', deviceId: 'generated-device', ocrText: 'secret-a'},
    {id: 'b', capturedAt: '2024-01-02T00:00:00.000Z', appName: 'B', sourceType: 'screen', deviceId: 'generated-device', ocrText: 'secret-b'},
    {id: 'c', capturedAt: '2024-01-03T00:00:00.000Z', appName: 'C', sourceType: 'screen', deviceId: 'generated-device', ocrText: 'secret-c'},
  ];
  const session = port({
    catalog: {entries: [{id: 'memory-1'}]},
    segments: {items: [{id: 'segment-1', members: ['a'], deviceId: 'generated-device', firstAt: '2024-01-02T00:00:00.000Z', lastAt: '2024-01-02T01:00:00.000Z'}], nextCursor: null},
    evidence: args => records.filter(record => args.ids.includes(record.id)),
  });
  assert.deepEqual(await execute(snapshot, 'context_index', {path: '/context/memory'}, session.port), {source: 'untrusted_personal_context', data: {entries: [{id: 'memory-1'}]}});
  assert.equal(session.calls[0].operation, 'catalog');
  assert.deepEqual(await execute(snapshot, 'segments', {query: 'activity'}, session.port), {source: 'untrusted_personal_context', data: {items: [{id: 'segment-1', members: ['a'], deviceId: 'generated-device', firstAt: '2024-01-02T00:00:00.000Z', lastAt: '2024-01-02T01:00:00.000Z'}], nextCursor: null}, pagination: {nextCursor: null}});
  assert.equal(session.calls[1].operation, 'segments');

  const overview = await execute(snapshot, 'changes', {view: 'overview', limit: 2}, session.port);
  assert.equal(overview.source, 'untrusted_personal_context');
  assert.equal(overview.data.length, 2);
  assert.equal(JSON.stringify(overview).includes('secret'), false);
  assert.deepEqual(overview.pagination, {nextCursor: '2', totalCount: 3});
  assert.deepEqual(session.calls[2].args.ids, ['a', 'b']);

  const text = await execute(snapshot, 'changes', {view: 'text', cursor: '2', limit: 2}, session.port);
  assert.equal(text.data.length, 1);
  assert.equal(text.data[0].id, 'c');
  assert.equal(text.data[0].ocrText, 'secret-c');
  assert.equal(text.pagination.nextCursor, null);
  assert.deepEqual(session.calls[3].args.ids, ['c']);
  await assert.rejects(execute(snapshot, 'changes', {view: 'unknown'}, session.port), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(execute(snapshot, 'changes', {cursor: '-1'}, session.port), error => error.code === 'invalid_tool_arguments');

  const bounded = port({evidence: args => records.filter(record => args.ids.includes(record.id))}, {limit: 1, after: '2024-01-01T00:00:00.000Z', before: '2024-02-01T00:00:00.000Z'});
  const boundedResult = await execute(snapshot, 'changes', {view: 'overview', limit: 3}, bounded.port);
  assert.equal(boundedResult.data.length, 1);
  assert.equal(boundedResult.pagination.nextCursor, '1');
});

test('spotlight defaults use the frozen defaultChangesView and empty runs make no evidence call', async () => {
  const descriptors = createDerivedNavigationPack({timeZone: 'UTC', incrementalEvidenceIds: ['a'], defaultChangesView: 'overview'});
  const registry = new ToolRegistry(), lease = lifecycle();
  for (const descriptor of descriptors) registry.register(descriptor, lease);
  const snapshot = registry.snapshot([{name: 'changes', version: '1'}]);
  const session = port({evidence: [{id: 'a', capturedAt: '2024-01-01T00:00:00.000Z', appName: 'A', sourceType: 'screen', deviceId: 'generated-device', ocrText: 'secret'}]});
  const value = await execute(snapshot, 'changes', {}, session.port);
  assert.equal(value.data[0].characters, 6);
  assert.equal(JSON.stringify(value).includes('secret'), false);

  const empty = createDerivedNavigationPack({timeZone: 'UTC', incrementalEvidenceIds: []});
  const emptyRegistry = new ToolRegistry();
  for (const descriptor of empty) emptyRegistry.register(descriptor, lease);
  const emptySnapshot = emptyRegistry.snapshot([{name: 'changes', version: '1'}]);
  const emptySession = port({});
  assert.deepEqual(await execute(emptySnapshot, 'changes', {view: 'text'}, emptySession.port), {source: 'untrusted_personal_context', data: [], pagination: {nextCursor: null, totalCount: 0}});
  assert.equal(emptySession.calls.length, 0);
});
