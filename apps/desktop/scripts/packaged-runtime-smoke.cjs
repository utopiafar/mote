// Run using the packaged Electron executable with ELECTRON_RUN_AS_NODE=1.
// Reads only generated pixels and explicitly supplied model files, never a display or user profile.
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const resources = resolve(process.argv[2]);
const bundle = join(resources, 'app.asar');
const { defaultConfig } = require(join(bundle, 'dist/config.js'));
const { NsfwController } = require(join(bundle, 'dist/nsfw.js'));
const { DesktopUpdater } = require(join(bundle, 'dist/updater.js'));
const { inspectBundle } = require(join(bundle, 'dist/update-install.js'));
assert.equal(typeof DesktopUpdater, 'function'); // Requires the shared release ESM from packaged CommonJS.
const version = require(join(bundle, 'package.json')).version;
if (process.env.MOTE_EXPECTED_VERSION) assert.equal(version, process.env.MOTE_EXPECTED_VERSION);
const { VisionModelStore } = require(join(bundle, 'node_modules/@mote/local-inference'));
const { DiagnosticsRecorder } = require(join(bundle, 'node_modules/@mote/diagnostics'));
assert.equal(typeof DiagnosticsRecorder, 'function');
const gate = new NsfwController('/unused', join(resources, 'native/mote-qwen'), () => {}, { store: new VisionModelStore(resolve(process.env.MOTE_QWEN_MODEL_DIR || '../../.mote/models/qwen')) });
(async () => {
  try {
    await inspectBundle(join(resources, 'native/mote-updater'), resolve(resources, '../..'), version, process.arch);
    const decision = await gate.classify({ bitmap: Buffer.alloc(256 * 256 * 4, 255), width: 256, height: 256 }, defaultConfig());
    assert.equal(typeof decision.allow, 'boolean');
    process.stdout.write(JSON.stringify({ok:true, fixtureOnly:true, version,packagedAsarModules:true, packagedNativeHelper:true, packagedUpdaterAndSharedRelease:true, decision, durationMs:gate.status().lastDurationMs}) + '\n');
  } finally { gate.close(); }
})().catch(error => { process.stderr.write('Packaged runtime smoke failed: ' + error.message + '\n'); process.exitCode = 1; });
