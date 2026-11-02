import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parameterSchemaSpecToJsonSchema} from '@deepseek-ai/dsh-tools';
import {ToolRegistry} from '../dist/tools/registry.js';
import {toolInputSchema} from '../dist/tools/runtime-schema.js';
import {ContextToolError} from '../dist/tool-errors.js';
import {createImageReadPack} from '../dist/tools/packs/images.js';
import {
  codexImageMetadata,
  codexImageSteerInputs,
  dshImageAttachmentInput,
  dshPreparedValue,
} from '../dist/tools/image-result.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const bytes = Buffer.from('generated-image-bytes');
const encoded = bytes.toString('base64');
const image = {mimeType: 'image/png', data: encoded};

const viewFor = (buffer = bytes, {region = null, transform} = {}) => {
  const digest = sha256(buffer), actual = transform ?? (region ? 'crop-encoded-raster-png@1' : 'original-bytes@1');
  const viewId = sha256(JSON.stringify([digest, 'encoded-raster-pixels-v1', region, actual]));
  return {
    original: {sha256: digest, width: 8, height: 8, mimeType: 'image/png', orientation: 1, pages: 1},
    coordinateSpace: 'encoded-raster-pixels-v1',
    region,
    transform: actual,
    viewId,
    ...(actual === 'metadata@1' ? {} : {output: {sha256: digest, width: region?.width ?? 8, height: region?.height ?? 8, mimeType: 'image/png', sizeBytes: buffer.length}}),
  };
};

const makePort = (result, {calls = [], scope = {}} = {}) => ({
  tool: {name: 'generated-pin', version: '1', fingerprint: 'f'.repeat(64)},
  scope,
  signal: new AbortController().signal,
  assertCurrent() { calls.push(['assert']); },
  async read(operation, ...args) {
    calls.push([operation, args]);
    if (operation !== 'readImage') throw new Error('fixture reader has no ' + operation);
    return typeof result === 'function' ? result(...args) : result;
  },
  actionCatalog() { throw new Error('fixture never compares calendars'); },
  progress() {},
});

function registryFixture() {
  const registry = new ToolRegistry();
  for (const descriptor of createImageReadPack()) registry.register(descriptor);
  const snapshot = registry.snapshot(registry.registered());
  const entry = snapshot.entries[0];
  return {snapshot, entry, run: (args, port) => snapshot.resolve({name: entry.name, version: entry.version, fingerprint: entry.fingerprint}).execute(args, port)};
}

test('read_image descriptor pins the production schema and declares only readImage', () => {
  const {entry} = registryFixture();
  assert.equal(entry.name, 'read_image');
  assert.equal(entry.version, '1');
  assert.equal(entry.kind, 'image');
  assert.equal(entry.exposure, 'native');
  assert.deepEqual(entry.requires, ['readImage']);
  assert.deepEqual(toolInputSchema(entry.fields), {...parameterSchemaSpecToJsonSchema(entry.fields), additionalProperties: false});
});

test('invalid image requests fail before the reader is called', async () => {
  const {run} = registryFixture(), calls = [];
  const region = {x: 0, y: 0, width: 4, height: 4};
  await assert.rejects(run({id: 'generated-image', region}, makePort(image, {calls})), error => error instanceof ContextToolError && error.code === 'invalid_image_region' && error.recovery === 'correct_arguments');
  await assert.rejects(run({id: 'generated-image', region, view: 'metadata', expectedImageSha256: 'a'.repeat(64)}, makePort(image, {calls})), error => error.code === 'invalid_image_region');
  await assert.rejects(run({id: 'generated-image', region: {...region, width: 2049}, expectedImageSha256: 'a'.repeat(64)}, makePort(image, {calls})), error => ['invalid_image_region', 'invalid_tool_arguments'].includes(error.code), 'a 2049-pixel region side is rejected before reading');
  await assert.rejects(run({id: 'generated-image', extra: true}, makePort(image, {calls})), error => error.code === 'invalid_tool_arguments', 'the published schema is closed');
  await assert.rejects(run({}, makePort(image, {calls})), error => error.code === 'invalid_tool_arguments');
  assert.deepEqual(calls.filter(([operation]) => operation !== 'assert'), [], 'rejected arguments never reach the reader');
});

test('metadata reads return only the view and never claim delivered pixels', async () => {
  const {run} = registryFixture();
  const view = viewFor(bytes, {transform: 'metadata@1'});
  const result = await run({id: 'generated-image', view: 'metadata'}, makePort({mimeType: 'image/png', imageView: view}));
  assert.equal(result.source, 'untrusted_personal_context');
  assert.equal(result.imageView.delivery, 'metadata');
  assert.equal(result.image, undefined);
  assert.equal('imageDelivery' in result, false, 'the pack never mints a delivery token');
  assert.equal('imageBudget' in result, false, 'the parent owns the image budget');
  await assert.rejects(run({id: 'generated-image', view: 'metadata'}, makePort({...image, imageView: view})), error => error.code === 'invalid_image_region');
});

test('image reads carry the requested bytes but stay pending until the Host sender confirms', async () => {
  const {run} = registryFixture();
  const result = await run({id: 'generated-image'}, makePort({...image, imageView: viewFor()}));
  assert.equal(result.image.data, encoded);
  assert.equal(result.imageView.delivery, 'pending');
  assert.equal('imageDelivery' in result, false);
  assert.deepEqual(result.image.data, encoded);
});

test('view identity, region bounds and output checks reject stale or forged images', async () => {
  const {run} = registryFixture();
  const region = {x: 2, y: 2, width: 4, height: 4}, digest = sha256(bytes);
  await assert.rejects(run({id: 'generated-image', region, expectedImageSha256: digest}, makePort({...image, imageView: {...viewFor(bytes, {region}), viewId: 'b'.repeat(64)}})), error => error.code === 'invalid_image_region');
  await assert.rejects(run({id: 'generated-image', expectedImageSha256: 'c'.repeat(64)}, makePort({...image, imageView: viewFor()})), error => error.code === 'invalid_image_region');
  await assert.rejects(run({id: 'generated-image', region, expectedImageSha256: digest}, makePort({...image, imageView: {...viewFor(bytes, {region}), region: {x: 6, y: 6, width: 4, height: 4}}})), error => error.code === 'invalid_image_region');
  const wrongOutput = viewFor();
  wrongOutput.output = {...wrongOutput.output, sha256: 'd'.repeat(64)};
  await assert.rejects(run({id: 'generated-image'}, makePort({...image, imageView: wrongOutput})), error => error.code === 'invalid_image_region');
  await assert.rejects(run({id: 'generated-image', region, expectedImageSha256: digest}, makePort({...image, imageView: {...viewFor(bytes, {region}), original: {...viewFor(bytes, {region}).original, pages: 2}}})), error => error.code === 'invalid_image_region');
});

test('a reader without view support cannot be asked for regions or metadata', async () => {
  const {run} = registryFixture();
  await assert.rejects(run({id: 'generated-image', region: {x: 0, y: 0, width: 2, height: 2}, expectedImageSha256: 'a'.repeat(64)}, makePort(image)), error => error instanceof ContextToolError && error.code === 'image_view_unsupported' && error.recovery === 'use_existing_evidence');
  await assert.rejects(run({id: 'generated-image', view: 'metadata'}, makePort(image)), error => error.code === 'image_view_unsupported');
});

test('pure runtime adapters prepare payloads without sending, confirming or copying pixels into metadata', () => {
  const view = {...viewFor(), id: 'generated-image', delivery: 'pending'};
  const payload = {source: 'untrusted_personal_context', id: 'generated-image', imageView: view, image, imageBudget: {remainingPayloads: 3}, toolUsage: {}, imageDelivery: 'generated-token'};
  const attachment = dshImageAttachmentInput(image);
  assert.equal(attachment.mediaType, 'image/png');
  assert.equal(attachment.name, 'capture');
  assert.deepEqual(attachment.data, bytes);

  const rendered = dshPreparedValue({text: 'untrusted image payload text', images: [image]}, [{id: 'generated-attachment'}]);
  assert.deepEqual(rendered, {text: 'untrusted image payload text', attachments: [{id: 'generated-attachment'}]});
  assert.deepEqual(dshPreparedValue({text: 'metadata only'}, []), {text: 'metadata only'});

  const metadata = codexImageMetadata(payload);
  assert.equal(JSON.stringify(metadata).includes(encoded), false, 'metadata never duplicates base64');
  assert.equal('imageDelivery' in metadata, false, 'metadata never carries a delivery token');
  assert.equal(metadata.id, 'generated-image');
  assert.deepEqual(metadata.imageView, view);
  assert.deepEqual(codexImageMetadata({...payload, view: 'image', region: {x: 1, y: 2, width: 3, height: 4}, expectedImageSha256: 'e'.repeat(64)}),
    {source: 'untrusted_personal_context', id: 'generated-image', view: 'image', region: {x: 1, y: 2, width: 3, height: 4}, expectedImageSha256: 'e'.repeat(64), imageView: view, imageBudget: {remainingPayloads: 3}, toolUsage: {}},
    'the Host-admitted selection stays beside the resolved view');

  const steer = codexImageSteerInputs(metadata, image);
  assert.equal(steer[0].type, 'text');
  assert.equal(steer[0].text_elements.length, 0);
  assert.equal(steer[0].text.includes(encoded), false);
  assert.equal(steer[1].type, 'image');
  assert.equal(steer[1].url, `data:image/png;base64,${encoded}`);
});

test('DSH prepared value matches the render contract consumed by context-plugin', () => {
  // This mirrors runtime/dsh/context-plugin.ts output.render exactly: it reads
  // {text, attachments?} and maps each attachment to an image content item.
  const render = value => {
    const result = value;
    return [{type: 'text', text: result.text}, ...(result.attachments ?? []).map(attachment => ({type: 'image', attachment}))];
  };
  const attachment = {id: 'generated-attachment'};
  const rendered = render(dshPreparedValue({text: 'untrusted image payload text', images: [{mimeType: 'image/png', data: encoded}]}, [attachment]));
  assert.deepEqual(rendered, [
    {type: 'text', text: 'untrusted image payload text'},
    {type: 'image', attachment},
  ]);
  assert.deepEqual(render(dshPreparedValue({text: 'metadata only'}, [])), [{type: 'text', text: 'metadata only'}]);
});
