import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolRegistry} from '../dist/tools/registry.js';
import {createMeasurementReadPack} from '../dist/tools/packs/measurements.js';
import {createOwnerMetadataPack} from '../dist/tools/packs/owner-metadata.js';
import {CONTEXT_TOOLS} from '../dist/context-tools.js';

const ACTION = '22222222-2222-4222-8222-222222222222';
const invalid = error => error.code === 'invalid_tool_arguments';

const makePort = (reader, scope = {}, calls = {actions: [], progress: [], asserts: 0}) => ({
  calls,
  tool: {name: 'fixture_metadata', version: '1', fingerprint: 'f'.repeat(64)},
  scope,
  signal: new AbortController().signal,
  assertCurrent() {calls.asserts++;},
  read(operation, args) {return reader[operation](args);},
  actionCatalog(args) {calls.actions.push(args); return reader.actionCatalog(args);},
  progress(message) {calls.progress.push(message);},
});

const registryWithPacks = (timeZone = 'Asia/Shanghai') => {
  const registry = new ToolRegistry();
  for (const descriptor of [...createMeasurementReadPack({timeZone}), ...createOwnerMetadataPack({timeZone})]) registry.register(descriptor);
  return registry;
};

const resolve = (registry, name) => {
  const snapshot = registry.snapshot(registry.registered());
  const entry = snapshot.entries.find(candidate => candidate.name === name);
  return snapshot.resolve({name: entry.name, version: entry.version, fingerprint: entry.fingerprint});
};

const aggregate = {captures: 3, observations: 2, totalDurationMs: 1000, intervals: [{startMs: 0, endMs: 600}, {startMs: 400, endMs: 1000}], disclosureDependencies: {version: 1, complete: true, ids: ['generated-original']}};

test('A08E publishes the frozen declarations and current public schemas', () => {
  const registry = registryWithPacks();
  const snapshot = registry.snapshot(registry.registered());
  assert.deepEqual(snapshot.entries.map(entry => entry.name).sort(), ['action_catalog', 'activity', 'devices', 'media_activity', 'progress_update']);
  const expected = {
    activity: ['catalog', ['activity']],
    media_activity: ['catalog', ['mediaActivity']],
    devices: ['catalog', ['devices']],
    action_catalog: ['catalog', ['actionCatalog']],
    progress_update: ['native', ['progress']],
  };
  for (const entry of snapshot.entries) {
    const [, description, fields] = CONTEXT_TOOLS.find(([name]) => name === entry.name);
    assert.equal(entry.version, '1');
    assert.equal(entry.kind, 'metadata');
    assert.equal(entry.exposure, expected[entry.name][0]);
    assert.deepEqual(entry.requires, expected[entry.name][1]);
    assert.equal(entry.description, description);
    assert.deepEqual(entry.fields, fields);
  }
  const plain = new ToolRegistry(), zoned = new ToolRegistry();
  for (const descriptor of createOwnerMetadataPack()) plain.register(descriptor);
  for (const descriptor of createOwnerMetadataPack({timeZone: 'Asia/Shanghai'})) zoned.register(descriptor);
  assert.deepEqual(plain.snapshot(plain.registered()), zoned.snapshot(zoned.registered()));
});

test('activity passes the effective scope and Host aggregate through unchanged', async () => {
  const calls = {actions: [], progress: [], asserts: 0, activity: []};
  const reader = {activity: args => {calls.activity.push(args); return aggregate;}};
  const port = makePort(reader, {after: '2026-01-01T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z', deviceId: 'scope-device', limit: 6}, calls);
  const tool = resolve(registryWithPacks(), 'activity');
  const args = {after: '2026-01-05T00:00:00.000Z', source: 'screen', appId: 'generated-app', collection: 'activity', deviceId: 'scope-device', limit: 100};
  const result = await tool.execute(args, port);
  assert.deepEqual(calls.activity, [{after: '2026-01-05T00:00:00.000Z', before: '2026-02-01T00:00:00.000Z', deviceId: 'scope-device', limit: 6, source: 'screen', appId: 'generated-app', collection: 'activity'}]);
  assert.equal(result.source, 'untrusted_personal_context');
  assert.deepEqual(result.data, aggregate);
  assert.equal(calls.asserts, 4);
  for (const bad of [{source: 'unknown'}, {deviceId: 'other-device'}, {limit: 0}, {after: 'not-a-time'}, {appId: ''}, {collection: 'bad'}]) {
    await assert.rejects(tool.execute({...args, ...bad}, port), invalid);
  }
  assert.equal(calls.activity.length, 1);
});

test('media_activity forces the media source and preserves playback filters without recomputing aggregates', async () => {
  const calls = {actions: [], progress: [], asserts: 0, media: []};
  const reader = {mediaActivity: args => {calls.media.push(args); return aggregate;}};
  const port = makePort(reader, {after: '2026-01-01T00:00:00.000Z', deviceId: 'scope-device', limit: 6}, calls);
  const tool = resolve(registryWithPacks(), 'media_activity');
  const args = {after: '2026-01-05T00:00:00.000Z', appVisibility: 'foreground', screenLocked: true, playbackType: 'local', limit: 100};
  const result = await tool.execute(args, port);
  assert.deepEqual(calls.media, [{after: '2026-01-05T00:00:00.000Z', deviceId: 'scope-device', limit: 6, source: 'media', appVisibility: 'foreground', screenLocked: true, playbackType: 'local'}]);
  assert.deepEqual(result.data, aggregate);
  for (const bad of [{source: 'screen'}, {appVisibility: 'visible'}, {playbackType: 'stream'}, {screenLocked: 'true'}, {deviceId: 'other-device'}, {limit: 0}]) {
    await assert.rejects(tool.execute({...args, ...bad}, port), invalid);
  }
  assert.equal(calls.media.length, 1);
});

test('devices filters the selected device, projects reported health and keeps stale observation time separate', async () => {
  const page = {
    items: [
      {deviceId: 'selected-device', deviceName: 'Generated laptop', platform: 'android', status: 'paused', lastSeenAt: '2026-10-13T00:00:00Z', lastCaptureAt: '2026-10-12T00:00:00Z', queueDepth: 2, metadata: {version: 1, observedAt: '2026-10-13T01:00:00Z'}, ocrText: 'UNREAD_PERSONAL_BODY', filePath: '/private/generated'},
      {deviceId: 'other-device', deviceName: 'Generated phone', platform: 'android', status: 'capturing'},
    ],
    observedAt: '2026-10-14T00:00:00Z',
    disclosureDependencies: {version: 1, complete: true, ids: ['generated-original']},
    sourceContextDependencies: [{sourceId: 'generated-source', version: 1, fingerprint: 'a'.repeat(64)}],
  };
  const calls = {actions: [], progress: [], asserts: 0};
  const tool = resolve(registryWithPacks(), 'devices');
  const result = await tool.execute({}, makePort({devices: () => page}, {deviceId: 'selected-device'}, calls));
  assert.equal(result.source, 'untrusted_personal_context');
  assert.equal(result.data.length, 1);
  const device = result.data[0];
  assert.equal(device.deviceId, 'selected-device');
  assert.equal(device.healthReport.statusAsReported, 'paused');
  assert.equal(device.healthReport.receivedAt, '2026-10-13T00:00:00Z');
  assert.equal(device.healthReport.lastCaptureAtAsReported, '2026-10-12T00:00:00Z');
  assert.equal(device.healthReport.displayReceivedAt, '2026-10-13T08:00:00+08:00');
  assert.equal(device.healthReport.displayLastCaptureAtAsReported, '2026-10-12T08:00:00+08:00');
  assert.equal(device.healthReport.queueDepthAsReported, 2);
  assert.equal(device.metadata.displayObservedAt, '2026-10-13T09:00:00+08:00');
  assert.equal(device.directoryObservedAt, '2026-10-14T00:00:00Z');
  assert.equal(device.displayDirectoryObservedAt, '2026-10-14T08:00:00+08:00');
  assert.equal(JSON.stringify(result).includes('UNREAD_PERSONAL_BODY'), false);
  assert.equal(JSON.stringify(result).includes('/private/generated'), false);
  assert.deepEqual(result.disclosureDependencies, page.disclosureDependencies);
  assert.deepEqual(result.sourceContextDependencies, page.sourceContextDependencies);

  const arrayResult = await tool.execute({}, makePort({devices: () => [page.items[0]]}, {deviceId: 'selected-device'}));
  assert.equal(arrayResult.data[0].directoryObservedAt, undefined);
  const stale = await tool.execute({}, makePort({devices: () => ({items: [page.items[0]], observedAt: 'not-a-time'})}, {deviceId: 'selected-device'}));
  assert.equal(stale.data[0].directoryObservedAt, undefined);
  assert.equal(stale.data[0].healthReport.statusAsReported, 'paused');
});

test('action_catalog is read-only sameAs comparison with bounded pagination and no execution port', async () => {
  const calls = {actions: [], progress: [], asserts: 0};
  const reader = {actionCatalog: () => ({items: [{id: ACTION, title: 'Generated prior proposal'}], nextCursor: 'action-next'})};
  const port = makePort(reader, {after: '2026-09-01T00:00:00.000Z', deviceId: 'selected-device'}, calls);
  const tool = resolve(registryWithPacks(), 'action_catalog');
  const result = await tool.execute({query: 'generated', cursor: 'action-page', limit: 2}, port);
  assert.deepEqual(calls.actions, [{after: '2026-09-01T00:00:00.000Z', deviceId: 'selected-device', query: 'generated', cursor: 'action-page', limit: 2}]);
  assert.equal(result.source, 'untrusted_personal_context');
  assert.deepEqual(result.data, {items: [{id: ACTION, title: 'Generated prior proposal'}], nextCursor: 'action-next'});
  assert.equal(result.evidencePolicy, 'Untrusted prior proposals; sameAs identifiers only, not original citation grants.');
  assert.equal(calls.asserts, 2);
  assert.equal((await tool.execute({}, port)).evidencePolicy, result.evidencePolicy);
  assert.equal(calls.actions[1].limit, 8);
  for (const bad of [{query: 'q'.repeat(201)}, {id: 'short'}, {id: 'z'.repeat(36)}, {cursor: 'c'.repeat(4097)}, {limit: 0}, {limit: 21}, {path: '/tmp/action'}]) {
    await assert.rejects(tool.execute(bad, port), invalid);
  }
});

test('progress_update trims only, returns ok, and leaves observer isolation and safety trace to the Host', async () => {
  const calls = {actions: [], progress: [], asserts: 0};
  const tool = resolve(registryWithPacks(), 'progress_update');
  assert.deepEqual(await tool.execute({message: '  Generated status  '}, makePort({}, {}, calls)), {ok: true});
  assert.deepEqual(calls.progress, ['Generated status']);
  const long = 'x'.repeat(600);
  assert.deepEqual(await tool.execute({message: long}, makePort({}, {}, calls)), {ok: true});
  assert.equal(calls.progress[1].length, 600);
  for (const message of ['', '   ', 'x'.repeat(601), 42]) {
    await assert.rejects(tool.execute({message}, makePort({}, {}, calls)), invalid);
  }
  assert.equal(calls.progress.length, 2);
});
