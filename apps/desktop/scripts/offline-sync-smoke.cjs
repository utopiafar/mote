// Real Electron preload/main IPC and HTTP transports; generated notes/files only. Never start screen capture.
const { app, dialog, safeStorage, desktopCapturer, ipcMain } = require('electron');
const { mkdtempSync, writeFileSync, readdirSync, readFileSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { defaultConfig } = require('../dist/config');
const profile = mkdtempSync(join(tmpdir(), 'mote-offline-sync-fixture-'));
app.setPath('userData', profile); process.env.MOTE_PROFILE = 'legacy';
for (const key of ['MOTE_URL', 'MOTE_TOKEN', 'MOTE_ENV_FILE']) delete process.env[key];
safeStorage.isEncryptionAvailable = () => true;
safeStorage.encryptString = value => Buffer.from('fixture:' + Buffer.from(value).toString('base64'));
safeStorage.decryptString = value => Buffer.from(value.toString().slice(8), 'base64').toString();
desktopCapturer.getSources = async () => { throw new Error('Real screenshots are forbidden in this generated fixture'); };
const config = { ...defaultConfig(), serverUrl: '', syncMode: 'manual', deviceName: 'Synthetic offline Mac', metadataEnabled: false, ocrEnabled: false, nsfwEnabled: false };
writeFileSync(join(profile, 'config.json'), JSON.stringify({ version: 1, config }), { mode: 0o600 });
const file = join(profile, 'generated-source.md'); writeFileSync(file, 'Generated offline source version. No personal files.');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
const token = 'synthetic-offline-sync-token-' + 'x'.repeat(32), requests = [], captureBodies = [], sourceBodies = [];
let finished = false, origin, otherOrigin, otherRequests = 0, actualOrigin, central;
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ path: req.url, method: req.method });
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/captures') captureBodies.push(body);
    if (req.method === 'PUT' && req.url.endsWith('/items')) sourceBodies.push(body);
    // Forward to the real Mote server API/SQLite fixture, retaining transport payloads for equality checks.
    const response = await fetch(actualOrigin + req.url, { method: req.method, headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error' });
    const text = await response.text(); res.writeHead(response.status); res.end(text);
  } catch (error) { process.stderr.write('Fixture node rejected request: ' + error.message + '\n'); res.writeHead(500); res.end('{}'); }
});
const other = createServer((_req, res) => { otherRequests++; res.writeHead(500); res.end('{}'); });
const until = async fn => { for (let i = 0; i < 200; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Offline sync fixture phase timeout'); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const queueBodies = () => readdirSync(join(profile, 'queue/events')).filter(name => name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(profile, 'queue/events', name), 'utf8')).event).sort((a, b) => a.id.localeCompare(b.id));
const sourcePending = (url, credential, id) => JSON.parse(readFileSync(join(profile, 'local-sources/nodes', createHash('sha256').update(url + ':' + credential).digest('hex'), id + '.json'), 'utf8')).pending;
const timeout = setTimeout(() => { process.stderr.write('Offline sync fixture timeout\n'); app.exit(1); }, 35000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    if (!window.webContents.getURL().startsWith('file:')) return;
    // Fail closed if this fixture accidentally reaches the capture IPC; all other IPC handlers remain real.
    ipcMain.removeHandler('mote:start'); ipcMain.handle('mote:start', () => { throw new Error('Screen capture must remain stopped'); });
    const js = code => window.webContents.executeJavaScript(code);
    const invoke = (method, ...args) => js('window.mote[' + JSON.stringify(method) + '](' + args.map(arg => JSON.stringify(arg)).join(',') + ')');
    void (async () => {
      const initial = await invoke('status'); assert.equal(initial.running, false); assert.equal(initial.config.serverUrl, ''); assert.equal(initial.sync.state, 'unconfigured');
      const draft = await invoke('noteDraft'); const note = await invoke('saveNote', { ...draft, text: 'Generated offline note before any URL. 🧑🏽‍💻', revision: draft.revision + 1 });
      const options = { retention: 'snapshot', intervalSeconds: 30, trackDeletions: false, extensions: ['.md'], excludedPaths: [], redactLiterals: [] };
      await invoke('chooseSourceFiles', 'files', options);
      await until(async () => (await invoke('sources'))[0]?.pending === 1);
      const source = (await invoke('sources'))[0].source;
      const originalNote = queueBodies()[0], originalSource = structuredClone(sourcePending('', '', source.id)[0]);
      assert.equal(originalNote.id, note.id); assert.equal(originalSource.text, 'Generated offline source version. No personal files.');
      await pause(2200); assert.equal(requests.length, 0, 'No URL: automatic timer sends no requests');
      const waiting = await invoke('status'); assert.equal(waiting.sync.pendingRecords, 2); assert.equal(waiting.sync.localBacklogUnbound, true);
      const update = { ...waiting.config, serverUrl: origin, token, confirmLocalBacklog: false };
      await assert.rejects(invoke('configure', update), /待上传|归属/);
      assert.equal((await invoke('status')).config.serverUrl, ''); assert.deepEqual(queueBodies(), [originalNote]); assert.deepEqual(sourcePending('', '', source.id), [originalSource]);
      const bound = await invoke('configure', { ...update, confirmLocalBacklog: true });
      assert.equal(bound.config.serverUrl, origin); assert.equal(bound.sync.mode, 'manual'); assert.equal(bound.sync.localBacklogUnbound, false); assert.equal(bound.running, false);
      await pause(2200); assert.equal(requests.length, 0, 'First binding in manual mode must not auto-upload or heartbeat');
      assert.deepEqual(sourcePending(origin, token, source.id), [originalSource]);
      await invoke('retry');
      const synced = await invoke('status'); assert.equal(synced.queueDepth, 0); assert.equal(synced.sync.pendingRecords, 0); assert.equal((await invoke('sources'))[0].pending, 0);
      assert.deepEqual(captureBodies, [originalNote]); assert.deepEqual(sourceBodies, [originalSource]);
      assert.equal(requests.filter(request => request.path.includes('heartbeat')).length, 1, 'Manual sync sends one final explicit heartbeat');
      const device = (await fetch(actualOrigin + '/api/devices', { headers: { authorization: 'Bearer ' + token } }).then(response => response.json())).items.find(item => item.deviceId === config.deviceId);
      assert.deepEqual({ mode: device.sync.mode, state: device.sync.state, pending: device.sync.pendingRecords }, { mode: 'manual', state: 'idle', pending: 0 });
      const nextDraft = await invoke('noteDraft'); await invoke('saveNote', { ...nextDraft, text: 'Generated note that must stay bound to the first node.', revision: nextDraft.revision + 1 });
      writeFileSync(file, 'Generated second source version still belongs to the first node.');
      // Same-connection config update triggers a local rescan without an upload in manual mode.
      await invoke('configure', { ...(await invoke('status')).config, token: undefined });
      await until(async () => (await invoke('sources'))[0].pending === 1);
      const boundNotes = queueBodies(), boundSources = structuredClone(sourcePending(origin, token, source.id));
      const beforeAttempt = requests.length;
      await assert.rejects(invoke('configure', { ...(await invoke('status')).config, serverUrl: otherOrigin, token: 'synthetic-other-node-token-' + 'z'.repeat(32), confirmLocalBacklog: true }), /待上传|归属/);
      assert.equal((await invoke('status')).config.serverUrl, origin); assert.deepEqual(queueBodies(), boundNotes); assert.deepEqual(sourcePending(origin, token, source.id), boundSources);
      assert.equal(requests.length, beforeAttempt); assert.equal(otherRequests, 0);
      await invoke('retry'); assert.deepEqual(captureBodies.at(-1), boundNotes[0]); assert.deepEqual(sourceBodies.at(-1), boundSources[0]);
      assert.equal((await invoke('status')).sync.pendingRecords, 0); assert.equal((await invoke('status')).running, false);
      const stored = readFileSync(join(profile, 'config.json'), 'utf8'); assert(!stored.includes(token));
      process.stdout.write(JSON.stringify({ ok: true, fixtureOnly: true, realMainAndPreloadIpc: true, noUrlLocalNoteAndSource: true, firstBindingRequiresConfirmation: true, manualBindingHasNoAutomaticRequests: true, realCentralSqliteAcksDrainBothQueues: true, finalManualHeartbeatVisibleInDevicesApi: true, firstBindingPreservesOriginalPayloads: true, otherNodeRejectedWithoutPayloadMutation: true, captureStayedStopped: true, realKeychainUntouched: true }) + '\n');
      finished = true; clearTimeout(timeout); app.quit();
    })().catch(error => { process.stderr.write('Offline sync fixture failed: ' + error.stack + '\n'); app.exit(1); });
  });
});
app.on('quit', () => { for (const node of [server, other]) { node.closeAllConnections(); node.close(); } central?.kill('SIGTERM'); if (finished) void rm(profile, { recursive: true, force: true }); });
(async () => {
  const centralConfig = { dataDir: join(profile, 'central'), token, tokenPath: 'fixture-only', host: '127.0.0.1', port: 0, profile: 'test', maxStorageBytes: 10_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0, allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false, embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '' };
  const centralCode = `const {buildApp} = await import(${JSON.stringify(pathToFileURL(resolve(__dirname, '../../server/dist/app.js')).href)}); const {app} = await buildApp(${JSON.stringify(centralConfig)}, {agent:{configured:false,query:async()=>{throw Error('No live model in generated fixture');},close:async()=>{}}}); const origin = await app.listen({host:'127.0.0.1',port:0}); process.send({origin}); process.on('SIGTERM',async()=>{await app.close();process.exit(0);});`;
  central = spawn('node', ['--input-type=module', '-e', centralCode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  central.stderr.on('data', data => process.stderr.write(data));
  actualOrigin = await new Promise((resolve, reject) => { central.once('message', value => resolve(value.origin)); central.once('error', reject); central.once('exit', code => reject(new Error('Central fixture exited: ' + code))); });
  for (const node of [server, other]) await new Promise(resolve => node.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port; otherOrigin = 'http://127.0.0.1:' + other.address().port;
  require('../dist/main');
})().catch(error => { process.stderr.write('Offline sync fixture setup failed: ' + error.message + '\n'); app.exit(1); });
