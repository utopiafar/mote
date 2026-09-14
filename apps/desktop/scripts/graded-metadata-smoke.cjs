// Generated data against an explicitly supplied disposable node. Does not load Electron or inspect the screen.
const assert = require('node:assert/strict');
const { readFile, writeFile, mkdir, mkdtemp, realpath, rm, utimes } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { defaultConfig, validateServerUrl, isLoopback } = require('../dist/config');
const { DurableQueue } = require('../dist/queue');
const { uploadCapture, heartbeat } = require('../dist/transport');
const { scanSourceFiles } = require('../dist/source-files');
const { SourceSync } = require('../dist/source-sync');
const { DEFAULT_SOURCE_OPTIONS } = require('../dist/source-types');
(async () => {
  assert(process.argv[2], 'Pass a private generated-node connection JSON file');
  const connection = JSON.parse(await readFile(process.argv[2], 'utf8')); assert.equal(connection.generatedOnly, true);
  const serverUrl = validateServerUrl(connection.serverUrl); assert(isLoopback(new URL(serverUrl).hostname)); assert.equal(typeof connection.token, 'string');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'mote-graded-metadata-smoke-')));
  try {
    const config = { ...defaultConfig(), serverUrl, token: connection.token, deviceName: 'Generated desktop metadata fixture' };
    const request = async (path, body, method = body ? 'POST' : 'GET') => { const response = await fetch(serverUrl + path, { method, redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + connection.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); assert(response.ok, `Generated API response ${response.status}`); return response.json(); };
    const at = Date.now(); const metadata = { version: 1, observedAt: new Date(at).toISOString(), collector: { version: require('../package.json').version }, device: { model: 'Generated model', osVersion: 'synthetic' }, state: { batteryPercent: 42, charging: false, idleSeconds: 0, screenLocked: false }, capture: { intervalMs: 15000 } };
    const events = [0, 1].map(i => ({ id: randomUUID(), deviceId: config.deviceId, deviceName: config.deviceName, platform: 'macos', capturedAt: new Date(at - (1 - i) * 15000).toISOString(), durationMs: i ? 15000 : 0, appId: 'dev.mote.synthetic.activity', appName: 'Generated Activity App', source: 'activity', privacy: { excluded: false, redacted: false, mode: 'none', collection: 'activity' }, metadata }));
    let queue = new DurableQueue(join(directory, 'queue'), config); await queue.initialize(); for (const event of events) await queue.enqueue(event);
    const first = await queue.next(); await uploadCapture(config, first.record.event); // Simulate remote success followed by lost ACK/local process exit.
    queue = new DurableQueue(join(directory, 'queue'), config); await queue.initialize(); assert.deepEqual((await queue.next()).record.event, first.record.event);
    while (queue.stats().depth) { const item = await queue.next(); await uploadCapture(config, item.record.event); await queue.acknowledge(item.record.event.id); }
    assert.deepEqual((await queue.exportArchive()).blobs, {});
    for (const event of events) { const saved = await request('/api/captures/' + event.id); assert.equal(saved.source, 'activity'); assert.equal(saved.durationMs, event.durationMs); assert.deepEqual(saved.metadata, metadata); for (const key of ['imageBase64', 'imageMime', 'ocrText', 'title', 'mood']) assert(!saved[key]); }
    const { capture, ...heartbeatMetadata } = metadata; await heartbeat(config, { deviceId: config.deviceId, deviceName: config.deviceName, platform: 'macos', status: 'paused', queueDepth: 0, metadata: heartbeatMetadata });
    const device = (await request('/api/devices')).items.find(item => item.id === config.deviceId || item.deviceId === config.deviceId); assert(device); assert.deepEqual(device.metadata, heartbeatMetadata);
    const selected = join(directory, 'selected'); await mkdir(selected); const file = join(selected, 'generated.md'); await writeFile(file, '合成文件版本；不存在真实个人内容 🧑🏽‍💻');
    const source = { id: 'desktop-metadata-' + randomUUID(), name: 'Generated desktop files', kind: 'local-files', deviceId: config.deviceId, platform: 'macos', retention: 'snapshot', enabled: true };
    const engine = new SourceSync(join(directory, 'source-state.json')); await engine.initialize(); const markers = join(directory, 'atime.json');
    const scan = await scanSourceFiles(selected, DEFAULT_SOURCE_OPTIONS, undefined, markers); await engine.syncScan(scan, true, source, request); assert.equal(engine.status().pending, 0);
    assert.equal((await engine.syncScan(await scanSourceFiles(selected, DEFAULT_SOURCE_OPTIONS, undefined, markers), true, source, request)).changes, 0);
    const modifiedAt = scan.items[0].modifiedAt; await utimes(file, new Date('2023-01-02T03:04:05Z'), new Date(modifiedAt));
    const change = await scanSourceFiles(selected, DEFAULT_SOURCE_OPTIONS, undefined, markers); assert.equal((await engine.syncScan(change, true, source, request)).changes, 1);
    await rm(file); assert.equal((await engine.syncScan(await scanSourceFiles(selected, DEFAULT_SOURCE_OPTIONS, undefined, markers), true, source, request)).changes, 1);
    const sourceItems = await request('/api/sources/' + source.id + '/items?includeDeleted=true'); assert(JSON.stringify(sourceItems).includes('deletionObservedAt'));
    const result = { ok: true, generatedOnly: true, deviceId: config.deviceId, ids: events.map(e => e.id), sourceId: source.id, activityWithoutContent: true, persistedAckLossRetry: true, exactMetadataRoundTrip: true, heartbeatMetadata: true, fileMetadataOnlyRevision: true, selfReadNoRevision: true, deletionObservedAt: true, realScreensOrCalendarRead: false };
    if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2), { mode: 0o600 }); process.stdout.write(JSON.stringify(result) + '\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
})().catch(error => { process.stderr.write('Generated graded-metadata fixture failed: ' + error.message + '\n'); process.exitCode = 1; });
