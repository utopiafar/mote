require('../../../scripts/fixture-language.cjs');
const { app, ipcMain, nativeImage, safeStorage } = require('electron');
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const { defaultConfig, ConfigStore } = require('../dist/config');
const { SyncHistory, captureHistoryItem, sourceHistoryItem } = require('../dist/sync-history');

// Everything in this profile and HTTP archive is generated. Collection never starts.
const profile = mkdtempSync(join(tmpdir(), 'mote-sync-ui-fixture-'));
app.setPath('userData', profile);
process.env.MOTE_PROFILE = 'default';
for (const name of ['MOTE_URL', 'MOTE_TOKEN', 'MOTE_ENV_FILE']) delete process.env[name];
const archive = new Map(), requests = [], errors = [];
const pixels = Buffer.alloc(64, 200);
const generatedImage = nativeImage.createFromBitmap(pixels, { width: 4, height: 4 }).toJPEG(70);
const server = createServer((req, res) => {
  requests.push(req.url);
  const path = req.url.split('?')[0], id = path.split('/')[3], record = archive.get(id);
  if (path.endsWith('/image') && record) { res.setHeader('Content-Type', 'image/jpeg'); res.end(generatedImage); return; }
  res.setHeader('Content-Type', 'application/json');
  if (path.startsWith('/api/capture-browser/') && record) { res.end(JSON.stringify(record)); return; }
  res.statusCode = 410; res.end('{}');
});
const timeout = setTimeout(() => { process.stderr.write('Sync history smoke timed out\n'); app.exit(1); }, 60000);
let finished = false;
app.on('browser-window-created', (_event, window) => {
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  window.webContents.once('did-finish-load', () => void (async () => {
    const js = code => window.webContents.executeJavaScript(code);
    const wait = async (code, label) => { for (let i = 0; i < 200; i++) { if (await js(code)) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error(label); };
    await wait('Boolean(window.mote && document.querySelector("aside [data-nav=uploads]"))', 'Renderer startup');
    const status = await js('window.mote.status()'); assert.equal(status.running, false);
    ipcMain.removeHandler('mote:permission-status');
    ipcMain.handle('mote:permission-status', () => ({ screen: 'denied', accessibility: 'denied', calendar: 'denied' }));
    const config = { ...defaultConfig(), ...status.config };
    let now = Date.now(); const history = new SyncHistory(join(profile, 'sync-history.sqlite'), () => ++now); await history.initialize();
    const fixtureEvent = (id, source = 'note', title = 'Generated app') => ({ id, deviceId: config.deviceId, deviceName: 'Synthetic Mac', platform: 'macos', capturedAt: new Date(now).toISOString(), durationMs: 0, appId: 'dev.mote.synthetic', appName: title, source, privacy: { excluded: false, redacted: false, mode: 'none' }, ocrText: '<script>window.fixtureExecuted=true</script> Generated evidence', ...(source === 'screen' ? { imageMime: 'image/jpeg' } : {}) });
    for (let i = 0; i < 21; i++) { const e = fixtureEvent(randomUUID()), r = history.begin(config, 'automatic'); history.attempt(r, [captureHistoryItem(e)]); history.settle(r, e.id, true, e.id, 201); history.addBytes(r, 500); history.finish(r); archive.set(e.id, e); }
    const run = history.begin(config, 'manual'), items = [];
    for (let i = 0; i < 23; i++) {
      const id = randomUUID(), source = i === 22 ? 'screen' : i === 21 ? 'coding' : i === 20 ? 'file' : 'note';
      const e = fixtureEvent(id, source, i === 21 ? '<img src=x onerror="window.fixtureExecuted=true">' : 'Generated ' + source + ' ' + i);
      let item = captureHistoryItem(e);
      if (source === 'coding' || source === 'file') { const definition = { id: 'generated-source', deviceId: config.deviceId, name: 'Generated source', kind: source === 'coding' ? 'coding-agent' : 'local-files', platform: 'macos', retention: 'snapshot', enabled: true }; const version = { externalId: String(i), revision: 'generated', observedAt: e.capturedAt, title: e.appName, text: e.ocrText, kind: source === 'coding' ? 'message' : 'file', layer: 'snapshot' }; item = sourceHistoryItem(definition, version); e.provenance = { sourceId: definition.id }; }
      history.attempt(run, [item]); history.settle(run, item.key, true, id, 201); archive.set(id, e); items.push(item);
    }
    history.addBytes(run, 20480); history.finish(run); history.close();
    await js('document.querySelector("aside [data-nav=uploads]").click()');
    await wait('document.querySelectorAll("[data-upload-run]").length === 20', 'Run pagination');
    assert.equal(await js('document.querySelector("#upload-received").textContent'), '44');
    assert.equal(await js('document.querySelector("#upload-next").disabled'), false);
    await js('document.querySelector("#upload-next").click()');
    await wait('document.querySelectorAll("[data-upload-run]").length === 2', 'Next run page');
    await js('document.querySelector("#upload-prev").click()');
    await wait('document.querySelectorAll("[data-upload-run]").length === 20', 'Previous run page');
    await js(`document.querySelector('[data-upload-run="${run}"]').click()`);
    await wait('Boolean(document.querySelector("#upload-view-all"))', 'Receipt modal');
    await js('document.querySelector("#upload-view-all").click()');
    await wait('document.querySelectorAll(".upload-record-pick").length === 20 && Boolean(document.querySelector(".upload-content-image"))', 'Content preview and native close event');
    assert.equal(await js('document.querySelector("#upload-content-dialog").open'), true);
    assert.equal(await js('document.querySelector("#upload-receipt-dialog").open'), false);
    await js(`document.querySelector('[data-upload-key="${items[21].key}"]').click()`);
    await wait('Boolean(document.querySelector(".upload-content-text")) && !document.querySelector(".upload-content-image")', 'Coding content');
    assert.equal(await js('document.querySelector(".upload-record-pick.selected").dataset.uploadKey'), items[21].key);
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await js('Boolean(window.fixtureExecuted)'), false, 'Evidence is text, never executable HTML');
    assert((await js('document.querySelector("#upload-content-preview").textContent')).includes('<script>'));
    const out = resolve(process.env.MOTE_SYNC_SCREENSHOTS || join(__dirname, '../release/sync-fixtures')); mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'content.png'), (await window.webContents.capturePage()).toPNG());
    await js('document.querySelector("#upload-content-next").click()');
    await wait('document.querySelectorAll(".upload-record-pick").length === 3', 'Content pagination');
    await js('document.querySelector("#upload-content-source").value="coding";document.querySelector("#upload-content-source").dispatchEvent(new Event("change"))');
    await wait('document.querySelectorAll(".upload-record-pick").length === 1 && Boolean(document.querySelector("#upload-preview-central"))', 'Source filter');
    const id = items[21].key;
    const captureId = (await js(`window.mote.syncHistoryContent(${JSON.stringify(run)},${JSON.stringify(id)})`)).captureId;
    archive.delete(captureId);
    await js('document.querySelector("#upload-preview-refresh").click()');
    await wait('Boolean(document.querySelector("#upload-content-preview [role=alert]"))', 'Expired archive preview');
    assert((await js('document.querySelector("#upload-content-preview").textContent')).includes('清理'));
    assert.equal((await js(`window.mote.syncHistoryContents({runId:${JSON.stringify(run)}})`)).run.received, 23);
    await js('document.querySelector("#upload-content-back").click()');
    await wait('Boolean(document.querySelector("#upload-view-all")) && document.querySelector("#upload-receipt-dialog").open', 'Return to receipt after native close event');
    await js('document.querySelector("#upload-receipt-dialog [data-upload-close]").click()');
    window.setSize(820, 620);
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert(await js('document.documentElement.scrollWidth <= innerWidth'), 'Overview fits minimum window');
    writeFileSync(join(out, 'overview-compact.png'), (await window.webContents.capturePage()).toPNG());
    window.setSize(1140, 840); await js('new Promise(resolve => requestAnimationFrame(resolve))');
    writeFileSync(join(out, 'overview.png'), (await window.webContents.capturePage()).toPNG());
    assert.equal((await js('window.mote.status()')).running, false); assert.deepEqual(errors, []);
    process.stdout.write(JSON.stringify({ ok: true, generatedFixturesOnly: true, captureStayedStopped: true, realPreloadIpc: true, receiptAndContentPagination: true, sourceFiltering: true, generatedScreenshotPreview: true, escapedUntrustedEvidence: true, archiveExpirationKeepsReceipt: true, nativeDialogTransitions: true, minimumWindowLayout: true, requests: requests.length, screenshots: out }) + '\n');
    finished = true; clearTimeout(timeout); await new Promise(resolve => server.close(resolve)); app.quit();
  })().catch(error => { process.stderr.write(error.stack + '\n'); app.exit(1); }));
});
app.on('quit', () => { void rm(profile, { recursive: true, force: true }); });
server.listen(0, '127.0.0.1', async () => {
  await app.whenReady();
  const config = { ...defaultConfig(), serverUrl: `http://127.0.0.1:${server.address().port}`, token: 'generated-token', deviceName: 'Synthetic Mac', syncMode: 'manual', metadataEnabled: false };
  const store = new ConfigStore(profile, { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) });
  await store.save(config);
  writeFileSync(join(profile, 'storage-format.json'), JSON.stringify({ version: 3 }), { mode: 0o600 });
  require('../dist/main');
});
