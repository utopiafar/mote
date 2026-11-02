import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolRegistry} from '../dist/tools/registry.js';
import {createMaterialReadPack} from '../dist/tools/packs/materials.js';
import {createMemoryReadPack} from '../dist/tools/packs/memories.js';
import {createDerivedNavigationPack} from '../dist/tools/packs/derived-navigation.js';

const materialRef = 'material:mat_' + 'a'.repeat(64) + '@' + 'b'.repeat(64);
const lifecycle = () => {
  const controller = new AbortController();
  return {signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted(); }};
};
const packs = () => [
  ...createMaterialReadPack({timeZone: 'UTC'}),
  ...createMemoryReadPack({timeZone: 'UTC'}),
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

test('all six descriptors register with exact schemas and declared Host operations', () => {
  const {registry, snapshot} = assembly();
  assert.deepEqual(registry.registered().map(entry => entry.name).sort(), ['changes', 'context_index', 'material_catalog', 'material_read', 'memories', 'segments']);
  const requires = Object.fromEntries(snapshot.entries.map(entry => [entry.name, entry.requires]));
  assert.deepEqual(requires.material_catalog, ['materialCatalog']);
  assert.deepEqual(requires.material_read, ['materialRead']);
  assert.deepEqual(requires.memories, ['memories']);
  assert.deepEqual(requires.context_index, ['catalog']);
  assert.deepEqual(requires.segments, ['segments']);
  assert.deepEqual(requires.changes, ['evidence']);
  assert.equal(JSON.stringify(snapshot).includes('execute'), false);
  assert.equal(JSON.stringify(snapshot).includes('reader'), false);
});

test('material catalog and read use only their declared port operations and preserve scope/page errors', async () => {
  const {snapshot} = assembly();
  const catalog = {items: [{id: 'mat_' + 'a'.repeat(64), ref: materialRef}], nextCursor: null};
  const readPage = {material: {id: 'mat_' + 'a'.repeat(64), ref: materialRef}, text: 'body', textRange: {offset: 0, total: 4, nextOffset: null}, spans: [], originalRefs: []};
  const session = port({materialCatalog: catalog, materialRead: readPage});
  assert.deepEqual(await execute(snapshot, 'material_catalog', {query: 'coding', limit: 2}, session.port), catalog);
  assert.deepEqual(session.calls[0], {operation: 'materialCatalog', args: {
    after: '2024-01-01T00:00:00.000Z', before: '2024-02-01T00:00:00.000Z', deviceId: 'generated-device', limit: 2,
    sourceId: undefined, kind: undefined, query: 'coding',
  }});
  await assert.rejects(execute(snapshot, 'material_catalog', {deviceId: 'other'}, session.port), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(execute(snapshot, 'material_catalog', {limit: 0}, session.port), error => error.code === 'invalid_tool_arguments');
  assert.equal(session.calls.length, 1);
  assert.deepEqual(await execute(snapshot, 'material_read', {ref: materialRef, offset: 0, length: 4}, session.port), readPage);
  assert.deepEqual(session.calls[1].operation, 'materialRead');
  assert.equal(session.calls.some(call => call.operation === 'evidence'), false);
  await assert.rejects(execute(snapshot, 'material_read', {ref: 'material:bad'}, session.port), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(execute(snapshot, 'material_read', {ref: materialRef, offset: -1}, session.port), error => error.code === 'invalid_tool_arguments');
});

test('memories validates detail flags before a read and uses the memories operation only', async () => {
  const {snapshot} = assembly();
  const page = {items: [{id: 'memory-1', evidence: [{quote: 'saved quote', id: 'original-1'}]}], references: []};
  const session = port({memories: page});
  const value = await execute(snapshot, 'memories', {id: 'memory-1', includeEvidence: true, layer: 'memory'}, session.port);
  assert.equal(value.items[0].evidence[0].id, 'original-1');
  assert.equal(value.items[0].evidence[0].quote, undefined);
  assert.deepEqual(session.calls[0].operation, 'memories');
  assert.equal(session.calls[0].args.includeEvidence, true);
  await assert.rejects(execute(snapshot, 'memories', {includeEvidence: true}, session.port), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(execute(snapshot, 'memories', {layer: 'unknown'}, session.port), error => error.code === 'invalid_tool_arguments');
  assert.equal(session.calls.length, 1);
});

test('derived navigation keeps paging and returns overview metadata without citable text', async () => {
  const {snapshot} = assembly();
  const records = [
    {id: 'a', capturedAt: '2024-01-01T00:00:00.000Z', appName: 'A', sourceType: 'screen', ocrText: 'secret-a'},
    {id: 'b', capturedAt: '2024-01-02T00:00:00.000Z', appName: 'B', sourceType: 'screen', ocrText: 'secret-b'},
    {id: 'c', capturedAt: '2024-01-03T00:00:00.000Z', appName: 'C', sourceType: 'screen', ocrText: 'secret-c'},
  ];
  const session = port({
    catalog: {entries: [{id: 'memory-1'}]},
    segments: {items: [{id: 'segment-1', members: ['a']}], nextCursor: null},
    evidence: args => records.filter(record => args.ids.includes(record.id)),
  });
  assert.deepEqual(await execute(snapshot, 'context_index', {path: '/context/memory'}, session.port), {entries: [{id: 'memory-1'}]});
  assert.equal(session.calls[0].operation, 'catalog');
  assert.deepEqual(await execute(snapshot, 'segments', {query: 'activity'}, session.port), {items: [{id: 'segment-1', members: ['a']}], nextCursor: null});
  assert.equal(session.calls[1].operation, 'segments');

  const overview = await execute(snapshot, 'changes', {view: 'overview', limit: 2}, session.port);
  assert.deepEqual(overview, {items: [
    {id: 'a', capturedAt: '2024-01-01T00:00:00.000Z', contentAt: '2024-01-01T00:00:00.000Z', appName: 'A', sourceType: 'screen', characters: 8},
    {id: 'b', capturedAt: '2024-01-02T00:00:00.000Z', contentAt: '2024-01-02T00:00:00.000Z', appName: 'B', sourceType: 'screen', characters: 8},
  ], nextCursor: '2', totalCount: 3});
  assert.equal(JSON.stringify(overview).includes('secret'), false);
  assert.deepEqual(session.calls[2].args.ids, ['a', 'b']);

  const text = await execute(snapshot, 'changes', {view: 'text', cursor: '2', limit: 2}, session.port);
  assert.deepEqual(text, {items: [records[2]], nextCursor: null, totalCount: 3});
  assert.deepEqual(session.calls[3].args.ids, ['c']);
  await assert.rejects(execute(snapshot, 'changes', {view: 'unknown'}, session.port), error => error.code === 'invalid_tool_arguments');
  await assert.rejects(execute(snapshot, 'changes', {cursor: '-1'}, session.port), error => error.code === 'invalid_tool_arguments');
});

test('empty incremental runs do not call evidence and preserve the empty page', async () => {
  const descriptors = createDerivedNavigationPack({timeZone: 'UTC', incrementalEvidenceIds: []});
  const registry = new ToolRegistry(), lease = lifecycle();
  for (const descriptor of descriptors) registry.register(descriptor, lease);
  const snapshot = registry.snapshot([{name: 'changes', version: '1'}]);
  const session = port({});
  assert.deepEqual(await execute(snapshot, 'changes', {view: 'text'}, session.port), {items: [], nextCursor: null, totalCount: 0});
  assert.equal(session.calls.length, 0);
});
