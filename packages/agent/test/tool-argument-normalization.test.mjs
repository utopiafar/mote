import test from 'node:test';
import assert from 'node:assert/strict';
import {startBridge} from '../dist/bridge.js';
import {normalizeImageReadArguments,normalizeOptionalToolArguments} from '../dist/tools/argument-normalization.js';
import {catalogRequest} from './catalog-request.mjs';

const schema = {
  type: 'object',
  properties: {
    query: {type: 'string'},
    after: {type: 'string'},
    before: {type: 'string'},
    deviceId: {type: 'string'},
    limit: {type: 'integer'},
    source: {type: 'string'},
    appId: {type: 'string'},
    collection: {type: 'string'},
    cursor: {type: 'string'},
  },
  required: ['query'],
  additionalProperties: false,
};

test('optional empty, whitespace and null placeholders are treated as absent', () => {
  const args = {
    query: 'generated',
    after: '',
    before: '  \t\n',
    deviceId: null,
    limit: 50,
    source: '',
    appId: ' ',
    collection: null,
    cursor: '',
  };
  const normalized = normalizeOptionalToolArguments(schema, args);
  assert.deepEqual(normalized, {query: 'generated', limit: 50});
  assert.notEqual(normalized, args);
  assert.equal(args.after, '');
  assert.equal(args.collection, null);
});

test('required empty values and unknown keys are never dropped', () => {
  const required = normalizeOptionalToolArguments({...schema, required: ['query', 'after']}, {query: '', after: ''});
  assert.deepEqual(required, {query: '', after: ''});
  const unknown = normalizeOptionalToolArguments(schema, {query: 'generated', unknown: ''});
  assert.deepEqual(unknown, {query: 'generated', unknown: ''});
});

test('non-empty values are preserved for the existing validators', () => {
  const args = {query: 'generated', after: 'not-a-time', source: 'not-a-source', cursor: 'not-a-token', limit: 0};
  assert.deepEqual(normalizeOptionalToolArguments(schema, args), args);
});

test('an unpinned read_image placeholder region is treated as an omitted crop', () => {
  const placeholder = {id: 'generated-image', attachmentId: '', view: 'image', expectedImageSha256: '', region: {x: 0, y: 0, width: 1, height: 1}};
  assert.deepEqual(normalizeImageReadArguments(placeholder), {id: 'generated-image', attachmentId: '', view: 'image'});
  const nullRegion = {id: 'generated-image', region: null};
  assert.deepEqual(normalizeImageReadArguments(nullRegion), {id: 'generated-image'});
  const pinned = {id: 'generated-image', expectedImageSha256: 'a'.repeat(64), region: {x: 1, y: 2, width: 3, height: 4}};
  assert.equal(normalizeImageReadArguments(pinned), pinned, 'a valid pinned crop is preserved');
  const metadata = {id: 'generated-image', view: 'metadata', expectedImageSha256: 'a'.repeat(64), region: {x: 1, y: 2, width: 3, height: 4}};
  assert.deepEqual(normalizeImageReadArguments(metadata), {id: 'generated-image', view: 'metadata', expectedImageSha256: 'a'.repeat(64)});
  const malformed = {id: 'generated-image', expectedImageSha256: 'not-a-hash', region: {x: 1, y: 2, width: 3, height: 4}};
  assert.equal(normalizeImageReadArguments(malformed), malformed, 'a nonempty malformed hash still reaches the validator');
  const unsupported = {id: 'generated-image', region: {x: 0, y: 0, width: 2, height: 2}};
  assert.equal(normalizeImageReadArguments(unsupported), unsupported, 'an unpinned non-placeholder crop still reaches the validator');
});

test('read_image absorbs the interpretation placeholder and directImages echoes', () => {
  const described = {id: 'generated-image', expectedImageSha256: '', region: {x: 0, y: 0, width: 1, height: 1, description: 'Generated placeholder'}};
  assert.deepEqual(normalizeImageReadArguments(described), {id: 'generated-image'}, 'the answer-schema description does not make the placeholder a real crop');
  const pinnedPlaceholder = {id: 'generated-image', expectedImageSha256: 'a'.repeat(64), region: {x: 0, y: 0, width: 1, height: 1, description: 'Generated placeholder'}};
  assert.deepEqual(normalizeImageReadArguments(pinnedPlaceholder), {id: 'generated-image'}, 'a pinned annotated placeholder still inspects the full original');
  const pinnedPixel = {id: 'generated-image', expectedImageSha256: 'a'.repeat(64), region: {x: 0, y: 0, width: 1, height: 1}};
  assert.equal(normalizeImageReadArguments(pinnedPixel), pinnedPixel, 'an exact pinned 1x1 crop without annotations stays a valid region');
  const fullRead = {id: 'generated-image', expectedImageSha256: 'a'.repeat(64)};
  assert.deepEqual(normalizeImageReadArguments(fullRead), {id: 'generated-image'}, 'a full read drops a crop-only hash pin that view-less readers cannot verify');
  const describedCrop = {id: 'generated-image', expectedImageSha256: 'a'.repeat(64), region: {x: 1, y: 2, width: 3, height: 4, description: 'Generated crop note'}};
  assert.deepEqual(normalizeImageReadArguments(describedCrop), {id: 'generated-image', expectedImageSha256: 'a'.repeat(64), region: {x: 1, y: 2, width: 3, height: 4}}, 'annotation keys are removed while valid geometry is preserved');
  const hashAlias = {id: 'generated-image', hash: 'b'.repeat(64), region: {x: 1, y: 2, width: 3, height: 4}};
  assert.deepEqual(normalizeImageReadArguments(hashAlias), {id: 'generated-image', expectedImageSha256: 'b'.repeat(64), region: {x: 1, y: 2, width: 3, height: 4}}, 'a crop hash alias becomes the declared pin');
  const echoed = {id: 'generated-image', name: 'Generated image', mimeType: 'image/png', hash: 'a'.repeat(64), sizeBytes: 7};
  assert.deepEqual(normalizeImageReadArguments(echoed), {id: 'generated-image'}, 'directImages metadata is not a read_image argument');
});

const record = {
  id: '7b4e3cf4-6a2d-4c8f-9a10-5d6e7f8091a2',
  capturedAt: '2026-02-03T04:05:06Z',
  appName: 'Generated normalization note',
  ocrText: 'Generated evidence for tool argument normalization.',
};
const reader = {
  search: async () => [record],
  timeline: async () => ({items: [record], nextCursor: null}),
  evidence: async ({ids}) => ids.includes(record.id) ? [record] : [],
  activity: async () => ({}),
  devices: async () => [],
  materialCatalog: async () => ({items: [], nextCursor: null}),
  memories: async () => ({items: [], references: [], evidence: [], sourceSpans: [], nextCursor: null}),
};

async function fixture(t, overrides = {}) {
  const bridge = await startBridge({...reader, ...overrides}, {question: 'Generated normalization fixture'}, 40);
  t.after(() => bridge.close());
  const call = async (tool, args = {}) => {
    const response = await fetch(bridge.url + '/' + tool, {method: 'POST', headers: {Authorization: 'Bearer ' + bridge.token}, body: JSON.stringify(args)});
    return {status: response.status, body: await response.json()};
  };
  return {bridge, call};
}

test('captured OpenAI Responses payloads validate and execute with optional placeholders', async t => {
  const {call} = await fixture(t);
  const captured = {
    search_context: {after: '', before: '', deviceId: '', limit: 50, source: '', appId: '', collection: '', query: 'generated'},
    material_catalog: {query: 'generated', after: '', before: '', deviceId: '', limit: 50, sourceId: '', kind: '', cursor: ''},
    memories: {after: '', before: '', deviceId: '', limit: 40, cursor: '', includeHistory: false, includeEvidence: false, asOf: '', query: 'generated', layer: 'memory', tier: 'episode', kind: 'episodic', id: ''},
    timeline: {after: '', before: '', deviceId: '', limit: 12, source: '', appId: '', collection: '', cursor: ''},
  };
  for (const [tool, args] of Object.entries(captured)) {
    const result = await call(tool, args);
    assert.equal(result.status, 200, tool + ': ' + JSON.stringify(result.body));
  }
});

test('catalog capability arguments use the same optional normalization', async t => {
  let seen;
  const {bridge} = await fixture(t, {sources: async args => { seen = args; return {items: [], nextCursor: null}; }});
  const response = await catalogRequest(bridge, 'sources', {after: '', before: '', deviceId: '', query: '', cursor: ''});
  assert.equal(response.status, 200);
  assert.equal(seen.after, undefined);
  assert.equal(seen.before, undefined);
  assert.equal(seen.deviceId, undefined);
  assert.equal(seen.query, undefined);
  assert.equal(seen.cursor, undefined);
});

test('required empty and non-empty invalid values still reach their existing validators', async t => {
  const {call} = await fixture(t);
  const required = await call('material_read', {ref: ''});
  assert.equal(required.status, 400);
  assert.equal(required.body.toolError.code, 'invalid_tool_arguments');
  assert.equal(required.body.toolError.message, 'Use the owner-selected pinned material ref or one returned by material_catalog in this run');
  for (const [tool, args, message] of [
    ['search_context', {query: 'generated', after: 'not-a-time'}, 'after must be an ISO timestamp'],
    ['search_context', {query: 'generated', source: 'not-a-source'}, 'Invalid source'],
    ['search_context', {query: 'generated', appId: 'x'.repeat(301)}, 'Invalid appId'],
    ['timeline', {cursor: 'x'.repeat(4097)}, 'cursor must be a pagination token returned by timeline'],
    ['memories', {asOf: 'not-a-time'}, 'Invalid memory validity time'],
  ]) {
    const result = await call(tool, args);
    assert.equal(result.status, 400, tool);
    assert.equal(result.body.toolError.code, 'invalid_tool_arguments', tool);
    assert.equal(result.body.toolError.message, message, tool);
  }
});
