require('../../../scripts/fixture-language.cjs');
// Real central server, Electron image decoding and generated pixels only. No screen capture APIs.
const { app, nativeImage } = require('electron');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const assert = require('node:assert/strict');
const { DurableQueue } = require('../dist/queue');
const { defaultConfig } = require('../dist/config');
const { browseCaptures, captureDetail, captureImage, captureDayRange } = require('../dist/capture-browser');
const { prepareScreenshot, maskScreenshot } = require('../dist/capture-frame');
const { uploadCapture, uploadDeferredOcr } = require('../dist/transport');
const root = mkdtempSync(join(tmpdir(), 'mote-capture-browser-fixture-'));
app.setPath('userData', join(root, 'electron'));
app.on('window-all-closed', () => {});
let server;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => { const listener = net.createServer(); listener.once('error', reject); listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); }); });
(async () => {
  await app.whenReady();
  // Generated four-corner fixture proves no crop, including a high-DPI native representation.
  const width = 120, height = 80, pixels = Buffer.alloc(width * height * 4, 255);
  for (const [x, y, color] of [[0,0,[0,0,255]],[119,0,[0,255,0]],[0,79,[255,0,0]],[119,79,[0,255,255]]]) {
    const i = (y * width + x) * 4; pixels.set(color, i);
  }
  for (const scaleFactor of [1, 2]) {
    const source = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor });
    const frame = prepareScreenshot(source, { width: 120, height: 80 }, 1280);
    assert.deepEqual(frame.getSize(), { width: 120, height: 80 });
    assert.deepEqual(frame.toBitmap(), pixels);
    const masked = maskScreenshot(frame, [{x:0,y:0,width:0.5,height:0.5}]).toBitmap();
    assert.deepEqual([...masked.subarray(0,4)], [0,0,0,255]);
    assert.deepEqual(masked.subarray(masked.length-4), pixels.subarray(pixels.length-4));
  }
  assert.throws(() => prepareScreenshot(nativeImage.createFromBitmap(Buffer.alloc(120*80*4), {width:120,height:80}), {width:120,height:80}, 1280), /空白/);
  assert.throws(() => prepareScreenshot(nativeImage.createFromBitmap(pixels, {width:120,height:80}), {width:80,height:120}, 1280), /尺寸/);
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, token = randomBytes(32).toString('hex');
  const envFile = join(root, 'fixture.env');
  writeFileSync(envFile, `MOTE_PROFILE=test\nMOTE_HOST=127.0.0.1\nMOTE_PORT=${port}\nMOTE_TOKEN=${token}\nMOTE_DATA_DIR=${join(root, 'data')}\n`, { mode: 0o600 });
  const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith('MOTE_')) delete env[key];
  const repository = resolve(__dirname, '../../..');
  server = spawn('node', [join(repository, 'apps/server/dist/index.js')], { cwd: repository, env: { ...env, MOTE_ENV_FILE: envFile }, stdio: ['ignore', 'ignore', 'pipe'] });
  let failure = ''; server.stderr.on('data', data => { failure += data; });
  let ready = false;
  for (let n = 0; n < 100; n++) { if (server.exitCode !== null) throw new Error('Fixture server exited: ' + failure.slice(0, 300)); try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {} await wait(100); }
  assert(ready, 'Fixture central server starts');
  const config = { ...defaultConfig(), serverUrl: origin, token, deviceName: '合成截图浏览设备', nsfwEnabled: false };
  const queue = new DurableQueue(join(root, 'queue'), config); await queue.initialize();
  const jpeg = nativeImage.createFromBitmap(Buffer.alloc(96 * 64 * 4, 140), { width: 96, height: 64 }).toJPEG(75);
  const date = new Date(), day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const range = captureDayRange(day); const ids = [];
  for (let n = 0; n < 31; n++) {
    const event = { id: randomUUID(), deviceId: config.deviceId, deviceName: config.deviceName, platform: 'macos', capturedAt: new Date(Date.parse(range.after) + 3600000 + n * 1000).toISOString(), durationMs: 0, appId: 'dev.mote.fixture', appName: 'Generated capture', imageMime: 'image/jpeg', source: 'screen', ocr: { status: 'pending', reason: 'charging' }, privacy: { excluded: false, redacted: false, mode: 'local', reason: 'generated fixture pixels' } };
    ids.push(event.id); await queue.enqueue(event, jpeg); await uploadCapture(config, event, jpeg);
  }
  const local = await browseCaptures(queue, config, { location: 'local', day }); assert.equal(local.totalCount, 31); assert.equal(local.items.length, 30);
  const central = await browseCaptures(queue, config, { location: 'central', day }); assert.equal(central.totalCount, 31); assert.equal(central.items.length, 30); assert(central.nextCursor);
  const last = await browseCaptures(queue, config, { location: 'central', day, cursor: central.nextCursor }); assert.equal(last.items.length, 1); assert.equal(last.nextCursor, undefined, 'Server terminal null cursor is normalized');
  const empty = await browseCaptures(queue, config, { location: 'central', day: '2000-01-01' }); assert.equal(empty.items.length, 0); assert.equal(empty.nextCursor, undefined);
  const id = ids[0];
  assert.equal((await captureDetail(queue, config, 'central', id)).ocr.status, 'pending');
  assert.match(await captureImage(queue, config, 'local', id, true), /^data:image\/jpeg;base64,/);
  assert.match(await captureImage(queue, config, 'central', id, true), /^data:image\/jpeg;base64,/);
  assert.match(await captureImage(queue, config, 'central', id, false), /^data:image\/jpeg;base64,/);
  await uploadDeferredOcr(config, id, '合成 OCR <script>文本证据</script>');
  await uploadDeferredOcr(config, id, '合成 OCR <script>文本证据</script>');
  const detail = await captureDetail(queue, config, 'central', id); assert.equal(detail.ocr.status, 'completed'); assert.equal(detail.ocrText, '合成 OCR <script>文本证据</script>');
  const original = queue.recordsForBrowser().find(r => r.event.id === id).event; await uploadCapture(config, original, jpeg); // Original pending payload still ACKs after OCR patch.
  assert.equal((await captureDetail(queue, config, 'central', id)).ocr.status, 'completed');
  await assert.rejects(captureImage(queue, { ...config, deviceId: randomUUID() }, 'central', id, true), /不属于/);
  await assert.rejects(captureDetail(queue, { ...config, deviceId: randomUUID() }, 'central', id), /不属于/);
  console.info(JSON.stringify({ ok: true, fixtureOnly: true, generatedPixels: true, localAndCentralPaging: true, terminalNullCursor: true, authenticatedThumbnailsAndOriginal: true, deferredOcrIdempotent: true, originalPostRetryAfterOcr: true, currentDeviceScope: true }));
})().then(() => finish(0), error => { console.error(error); void finish(1); });
async function finish(code) {
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await Promise.race([new Promise(resolve => server.once('close', resolve)), wait(5000)]); }
  rmSync(root, { recursive: true, force: true }); app.exit(code);
}
