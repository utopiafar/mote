require('../../../scripts/fixture-language.cjs');
const { app, nativeImage } = require('electron');
const { mkdtemp, rm } = require('node:fs/promises');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { defaultConfig, isLoopback, validateServerUrl } = require('../dist/config');
const { maskBitmap } = require('../dist/privacy');
const { recognizeText } = require('../dist/native');
const { DurableQueue } = require('../dist/queue');
const { uploadCapture } = require('../dist/transport');

const profile = mkdtempSync(join(tmpdir(), 'mote-electron-fixture-profile-'));
app.setPath('userData', profile);
app.whenReady().then(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-native-fixture-'));
  try {
    const serverUrl = validateServerUrl(process.env.MOTE_FIXTURE_SERVER || 'http://127.0.0.1:47834');
    assert(isLoopback(new URL(serverUrl).hostname), 'Synthetic smoke target must be loopback');
    const token = process.env.MOTE_FIXTURE_TOKEN;
    assert(token, 'Set MOTE_FIXTURE_TOKEN to the local test server token');
    const config = { ...defaultConfig(), serverUrl, token, deviceName: 'Desktop synthetic fixture' };
    const generated = execFileSync('swift', [join(__dirname, 'generate-fixture.swift')], { maxBuffer: 12 * 1024 * 1024 });
    const source = nativeImage.createFromBuffer(generated);
    const { width, height } = source.getSize();
    // The lower 40% contains generated PRIVATE AREA text, and must disappear from OCR.
    const safePixels = maskBitmap(source.toBitmap(), width, height, [{ x: 0, y: 0.6, width: 1, height: 0.4 }]);
    const sanitized = nativeImage.createFromBitmap(safePixels, { width, height }).toJPEG(75);
    const ocrText = await recognizeText(join(__dirname, '..', 'native', 'bin', 'mote-helper'), sanitized);
    assert.match(ocrText, /MOTE GENERATED DESKTOP FIXTURE/);
    assert.doesNotMatch(ocrText, /PRIVATE AREA/);
    const queue = new DurableQueue(directory, config); await queue.initialize();
    const ids = [randomUUID(), randomUUID()];
    const events = ids.map((id, index) => ({
      id, deviceId: config.deviceId, deviceName: config.deviceName, platform: 'macos',
      capturedAt: new Date(Date.now() - (1 - index) * 15000).toISOString(), durationMs: index ? 15000 : 0,
      appId: 'dev.mote.synthetic-fixture', appName: 'Mote Generated Fixture', imageMime: 'image/jpeg',
      ocrText, source: 'screen', privacy: { excluded: false, redacted: true, mode: 'local', reason: 'generated lower-area mask applied before local OCR and queue' },
    }));
    for (const event of events) await queue.enqueue(event, sanitized);
    const archive = await queue.exportArchive();
    assert.equal(archive.records.length, 2); assert.equal(Object.keys(archive.blobs).length, 1);
    for (let i = 0; i < 2; i++) {
      const entry = await queue.next(); assert(entry);
      await uploadCapture(config, entry.record.event, entry.image);
      await queue.acknowledge(entry.record.event.id);
    }
    // A network retry after an ambiguous ACK must be accepted under the same event ID.
    await uploadCapture(config, events[0], sanitized);
    assert.equal(queue.stats().depth, 0);
    process.stdout.write(JSON.stringify({ ok: true, fixtureOnly: true, deviceId: config.deviceId, ids, nativeVisionOcr: true, maskedTextAbsent: true, imageDeduplicated: true, matchingAckClearedQueue: true, idempotentRetry: true }) + '\n');
  } finally { await rm(directory, { recursive: true, force: true }); await rm(profile, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { process.stderr.write(`Generated fixture smoke failed: ${error.message}\n`); app.exit(1); });
