require('../../../scripts/fixture-language.cjs');
const { app, nativeImage } = require('electron');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
const { NsfwController } = require('../dist/nsfw');
const { VisionModelStore } = require('@mote/local-inference');
const { defaultConfig } = require('../dist/config');
// Generated artwork only. Never invokes desktopCapturer or reads the user's display.
app.whenReady().then(async () => {
  const directory = resolve(process.env.MOTE_QWEN_MODEL_DIR || '../../.mote/models/qwen');
  const helper = resolve('native/bin/mote-qwen');
  const image = process.env.MOTE_VISION_FIXTURE_IMAGE ? nativeImage.createFromPath(resolve(process.env.MOTE_VISION_FIXTURE_IMAGE)) : nativeImage.createFromBitmap(Buffer.alloc(256 * 256 * 4, 255), { width: 256, height: 256 });
  assert(!image.isEmpty());
  const input = { bitmap: image.toBitmap(), ...image.getSize() };
  const gate = new NsfwController('/unused', helper, () => {}, { store: new VisionModelStore(directory) });
  const results = [];
  try {
    const cfg = defaultConfig(); await gate.initialize(); assert.equal(gate.status().modelState, 'ready');
    for (let i = 0; i < 2; i++) { const decision = await gate.classify(input, cfg); assert.equal(typeof decision.allow, 'boolean'); results.push({ decision, durationMs: gate.status().lastDurationMs, loadMs: gate.status().lastLoadMs, visionMs: gate.status().lastVisionMs }); }
    gate.reset(); await gate.ensureReady();
    const abort = new AbortController(); const pending = gate.classify(input, cfg, abort.signal); const timer = setTimeout(() => abort.abort(), 25);
    await assert.rejects(pending); clearTimeout(timer);
    const recovered = await gate.classify(input, cfg); assert.equal(typeof recovered.allow, 'boolean');
    process.stdout.write(JSON.stringify({ ok: true, fixtureOnly: true, realModel: 'Qwen3.5-0.8B Q4_K_M + F16 projector', backend: 'cpu', results, cancelKilledWorker: true, freshWorkerRecovered: true }) + '\n');
  } finally { gate.close(); }
  app.quit();
}).catch(error => { process.stderr.write('Vision smoke failed: ' + error.message + '\n'); app.exit(1); });
