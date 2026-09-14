// Only generated invitations, QR pixels and an isolated profile; no personal screen/calendar/Keychain access.
const { app, dialog, safeStorage } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { readFile, rm } = require('node:fs/promises');
const { createServer } = require('node:http');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { defaultConfig } = require('../dist/config');
const { connectionUri } = require('@mote/shared/connection');
const QRCode = require('qrcode');
const profile = mkdtempSync(join(tmpdir(), 'mote-connection-fixture-'));
app.setPath('userData', profile); process.env.MOTE_PROFILE = 'legacy';
for (const key of ['MOTE_URL', 'MOTE_TOKEN', 'MOTE_ENV_FILE']) delete process.env[key];
// Test-only reversible adapter keeps this fixture independent of real macOS Keychain entries.
safeStorage.isEncryptionAvailable = () => true;
safeStorage.encryptString = value => Buffer.from('fixture:' + Buffer.from(value).toString('base64'));
safeStorage.decryptString = value => Buffer.from(value.toString().slice(8), 'base64').toString();
const oldToken = 'old-synthetic-owner-token-' + 'o'.repeat(32), token = 'new-synthetic-collector-token-' + 'c'.repeat(32), owner = 'separate-synthetic-admin-token-' + 'a'.repeat(32);
const config = { ...defaultConfig(), deviceName: 'Synthetic onboarding Mac', serverUrl: 'http://127.0.0.1:1', excludedAppIds: ['dev.synthetic.private'], masks: [{ x: 0, y: 0, width: 0.1, height: 0.1 }], ocrEnabled: false };
writeFileSync(join(profile, 'config.json'), JSON.stringify({ version: 1, config, encryptedToken: safeStorage.encryptString(oldToken).toString('base64') }));
mkdirSync(join(profile, 'models')); writeFileSync(join(profile, 'models', 'preserved-fixture'), 'synthetic-model-marker');
let releaseFirstRedeem, selected, origin, invitation, failRedeem = true, requests = 0, ownerApiHeaders = [], finished = false, responseToken = token, uploadsAllowed = false; const uploadBodies = [];
const server = createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/connections/redeem') {
    requests++; assert.equal(req.headers.authorization, undefined);
    const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.deviceId, config.deviceId); assert.equal(body.code, invitation.code); assert.equal(body.platform, 'macos');
    if (requests === 1) await new Promise(resolve => { releaseFirstRedeem = resolve; });
    if (failRedeem) { res.writeHead(503); res.end('{"ignored":"provider body"}'); return; }
    res.end(JSON.stringify({ serverUrl: origin, token: responseToken, credentialId: 'fixture-collector', scope: 'collector' })); return;
  }
  if (req.url === '/api/connections/self') {
    const isOwner = req.headers.authorization === 'Bearer ' + owner;
    if (!isOwner && req.headers.authorization !== 'Bearer ' + responseToken) { res.writeHead(401); res.end('{}'); return; }
    res.end(JSON.stringify({ credential: { id: isOwner ? 'fixture-owner' : 'fixture-collector', scope: isOwner ? 'owner' : 'collector', label: 'Synthetic', ...(!isOwner ? { deviceId: config.deviceId } : {}) }, node: { version: 'synthetic', profile: 'test' }, capabilities: { ingest: true, ownSources: true, archiveRead: isOwner } })); return;
  }
  if (req.url === '/api/captures') { const body = JSON.parse(Buffer.concat(chunks).toString()); uploadBodies.push(body); if (!uploadsAllowed || req.headers.authorization !== 'Bearer ' + responseToken) { res.writeHead(401); res.end('{}'); return; } res.end(JSON.stringify({ id: body.id })); return; }
  if (req.url === '/api/fixture-owner') { ownerApiHeaders.push(req.headers.authorization); res.end('{}'); return; }
  if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Synthetic owner UI</title><p>Generated central fixture</p><script>fetch("/api/fixture-owner")</script>'); return; }
  res.writeHead(404); res.end('{}');
});
const until = async fn => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Connection fixture phase timeout'); };
const timeout = setTimeout(() => { process.stderr.write('Connection fixture timed out\n'); app.exit(1); }, 45000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    if (!window.webContents.getURL().startsWith('file:')) return;
    const js = code => window.webContents.executeJavaScript(code);
    void (async () => {
      assert.equal((await js('window.mote.status()')).running, false);
      const originalFile = await readFile(join(profile, 'config.json'));
      const original = (await js('window.mote.status()')).config;
      await js('document.querySelector("#connection-input").value=' + JSON.stringify(connectionUri(invitation)) + '; document.querySelector("#connection-preview").click()');
      await until(() => js('!document.querySelector("#connection-confirmation").hidden'));
      assert.equal(requests, 0); assert(await js('document.querySelector("#connection-connect").disabled'));
      assert.equal(await js('document.querySelector("#connection-origin").textContent'), origin);
      assert.equal(await js('document.querySelector("#connection-input").value'), '');
      await js('document.querySelector("#connection-confirm-origin").click(); document.querySelector("#connection-connect").click()');
      await until(() => requests === 1);
      for (const selector of ['#connection-cancel', '#connection-input', '#connection-confirm-origin']) assert(await js('document.querySelector(' + JSON.stringify(selector) + ').disabled'));
      await js('document.querySelector("#connection-cancel").click()'); assert.equal(await js('document.querySelector("#connection-confirmation").hidden'), false);
      releaseFirstRedeem(); await until(() => js('!document.querySelector("#connection-preview").disabled'));
      assert.deepEqual(await readFile(join(profile, 'config.json')), originalFile);
      failRedeem = false;
      // File and QR imports each only preview; neither sends a pairing request.
      selected = join(profile, 'invitation.json'); await js('document.querySelector("#connection-json").click()'); await until(() => js('!document.querySelector("#connection-confirmation").hidden'));
      await until(() => js('!document.querySelector("#connection-qr").disabled')); assert.equal(requests, 1);
      selected = join(profile, 'invitation.png'); await js('document.querySelector("#connection-qr").click()'); await until(() => js('!document.querySelector("#connection-confirmation").hidden'));
      await until(() => js('!document.querySelector("#connection-preview").disabled')); assert.equal(requests, 1);
      await js('document.querySelector("#connection-confirm-origin").click(); document.querySelector("#connection-connect").click()');
      await until(async () => (await js('window.mote.status()')).config.credentialScope === 'collector');
      const paired = await js('window.mote.status()'); assert.equal(paired.config.serverUrl, origin); assert.equal(paired.config.deviceId, original.deviceId); assert.deepEqual(paired.config.masks, original.masks); assert.deepEqual(paired.config.excludedAppIds, original.excludedAppIds); assert.equal(paired.running, false);
      const persisted = JSON.parse(await readFile(join(profile, 'config.json'), 'utf8')); assert.equal(safeStorage.decryptString(Buffer.from(persisted.encryptedToken, 'base64')), token); assert(!JSON.stringify(persisted).includes(token));
      assert.equal((await js('window.mote.testConnection()')).identity.credential.scope, 'collector');
      await assert.rejects(js('window.mote.openCentral()'), /采集权限/);
      await js('document.querySelector("#connection-owner-token").value=' + JSON.stringify(owner) + '; document.querySelector("#connection-owner-open").click()');
      await until(() => ownerApiHeaders.length > 0); assert.deepEqual(ownerApiHeaders, ['Bearer ' + owner]); assert.equal(await js('document.querySelector("#connection-owner-token").value'), '');
      assert(!readFileSync(join(profile, 'config.json'), 'utf8').includes(owner)); assert.equal(await readFile(join(profile, 'models', 'preserved-fixture'), 'utf8'), 'synthetic-model-marker');
      await js('document.querySelector("#connection-onboarding").scrollIntoView({behavior:"instant",block:"start"}); new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      mkdirSync(resolve(__dirname, '../release'), { recursive: true }); writeFileSync(resolve(__dirname, '../release/connection-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      const draft = await js('window.mote.noteDraft()'); await js('window.mote.saveNote(' + JSON.stringify({ ...draft, text: 'Synthetic offline queue blocks changing origin', revision: draft.revision + 1 }) + ')');
      await until(() => uploadBodies.length > 0);
      const preview = await js('window.mote.previewConnection(' + JSON.stringify(JSON.stringify({ ...invitation, serverUrl: 'http://127.0.0.1:1' })) + ')');
      await assert.rejects(js('window.mote.confirmConnection(' + JSON.stringify(preview.id) + ',' + JSON.stringify(preview.serverUrl) + ')'), /待上传/); assert.equal(requests, 2);
      // Repeat through the actual native confirmation UI with a revoked credential and a durable note.
      const previousUpload = structuredClone(uploadBodies[0]); assert(previousUpload);
      responseToken = 'replacement-synthetic-collector-' + 'r'.repeat(32);
      await js('document.querySelector("#connection-input").value=' + JSON.stringify(JSON.stringify(invitation)) + '; document.querySelector("#connection-preview").click()');
      await until(() => js('!document.querySelector("#connection-confirmation").hidden'));
      assert((await js('document.querySelector("#connection-resume").textContent')).includes('待传截图、随手记和来源版本'));
      assert(await js('document.querySelector("#connection-connect").disabled'));
      uploadsAllowed = true;
      await js('document.querySelector("#connection-confirm-origin").click(); document.querySelector("#connection-connect").click()');
      await until(async () => { const saved = JSON.parse(await readFile(join(profile, 'config.json'), 'utf8')); return safeStorage.decryptString(Buffer.from(saved.encryptedToken, 'base64')) === responseToken; });
      await until(() => js('!document.querySelector("#connection-preview").disabled'));
      await js('window.mote.retry()'); await until(async () => (await js('window.mote.status()')).queueDepth === 0);
      assert.equal(requests, 3); assert.deepEqual(uploadBodies.at(-1), previousUpload);
      console.log(JSON.stringify({ ok: true, fixtureOnly: true, jsonAndUriPreview: true, nativeVisionQrImport: true, explicitOriginRequired: true, connectingCannotPretendCancel: true, failedPairRetainsConfig: true, secureStoreAdapterUsed: true, existingDevicePrivacyAndModelPreserved: true, collectorCannotOpenAdmin: true, ephemeralOwnerOnlyInMain: true, pendingNoteBlocksOtherOrigin: true, sameOriginExplicitReauthorizationResumesNote: true, screenshotCaptureStayedStopped: true, realKeychainUntouched: true }));
      finished = true; clearTimeout(timeout); app.quit();
    })().catch(error => { process.stderr.write('Connection fixture failed: ' + error.message + '\n'); app.exit(1); });
  });
});
app.on('quit', () => { server.closeAllConnections(); server.close(); if (finished) void rm(profile, { recursive: true, force: true }); });
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  invitation = { format: 'mote.connection', version: 1, serverUrl: origin, code: 'a'.repeat(43), expiresAt: new Date(Date.now() + 300000).toISOString() };
  writeFileSync(join(profile, 'invitation.json'), JSON.stringify(invitation));
  await QRCode.toFile(join(profile, 'invitation.png'), connectionUri(invitation), { width: 900, margin: 4 });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
  require('../dist/main');
})().catch(error => { process.stderr.write('Connection fixture setup failed: ' + error.message + '\n'); app.exit(1); });
