const { DurableQueue } = require('../dist/queue');
const { NoteDraftStore } = require('../dist/note-draft');
const { defaultConfig, validateServerUrl, isLoopback } = require('../dist/config');
const { uploadCapture } = require('../dist/transport');
const { mkdtemp, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
(async () => {
  const serverUrl = validateServerUrl(process.env.MOTE_FIXTURE_SERVER || 'http://127.0.0.1:47838');
  if (!isLoopback(new URL(serverUrl).hostname) || !process.env.MOTE_FIXTURE_TOKEN) throw new Error('Only an explicit loopback test node and fixture token are accepted');
  const directory = await mkdtemp(join(tmpdir(), 'mote-note-fixture-'));
  try {
    const cfg = { ...defaultConfig(), deviceName: 'Generated Mac Note Fixture', serverUrl, token: process.env.MOTE_FIXTURE_TOKEN };
    const queue = new DurableQueue(join(directory, 'queue'), cfg); await queue.initialize();
    const store = new NoteDraftStore(join(directory, 'notes')); await store.initialize();
    const input = { ...store.get(), text: '合成 Mac 草稿恢复及同步验证，不含个人资料。', mood: '平静（合成）', revision: 1 };
    await store.update(input);
    await assert.rejects(store.submit(input, cfg, 'macos', { enqueue: async event => { await queue.enqueue(event); throw new Error('simulated interruption after enqueue'); } }));
    const restarted = new NoteDraftStore(join(directory, 'notes')); await restarted.initialize();
    const result = await restarted.submit(restarted.get(), cfg, 'macos', queue);
    const item = await queue.next(); assert.equal(item.record.event.id, result.id); assert.equal(item.image, undefined);
    await uploadCapture(cfg, item.record.event, item.image); await uploadCapture(cfg, item.record.event, item.image);
    await queue.acknowledge(result.id); assert.equal(queue.stats().depth, 0);
    process.stdout.write(JSON.stringify({ ok: true, fixtureOnly: true, id: result.id, noImage: true, simulatedInterruptedSubmitRecovered: true, serverIdempotency: true, queueDepth: 0 }) + '\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
})().catch(error => { process.stderr.write('Note fixture failed: ' + error.message + '\n'); process.exitCode = 1; });
