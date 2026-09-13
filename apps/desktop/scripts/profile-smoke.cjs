// Electron worker. Run through test-profiles.mjs; it creates the only permitted fixture directory.
const { app, dialog } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join, basename } = require('node:path');
const { createServer } = require('node:http');
const assert = require('node:assert/strict');
const arg = name => process.argv.find(v => v.startsWith(name + '='))?.slice(name.length + 1);
const root = arg('--fixture-root'), name = arg('--profile'), phase = arg('--phase');
assert(root && basename(root).startsWith('mote-native-profiles-') && readFileSync(join(root, 'fixture-marker'), 'utf8') === 'synthetic-only');
assert(['dev','test'].includes(name) && ['write','read'].includes(phase));
for (const key of Object.keys(process.env)) if (key.startsWith('MOTE_')) delete process.env[key];
process.env.MOTE_PROFILE = name;
app.setPath('userData', join(root, 'legacy'));
const token = 'synthetic-support-token-' + name + '-0123456789';
const privateNote = '仅合成笔记 PRIVATE_NOTE_' + name;
const output = join(root, name + '-support.json');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
const timeout = setTimeout(() => { process.stderr.write('profile fixture timeout\n'); app.exit(1); }, 25000);
let receiver;
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      const run = code => window.webContents.executeJavaScript(code);
      let status = await run('window.mote.status()');
      assert.equal(status.running, false); assert.equal(status.environment.profile, name);
      assert.equal(status.environment.dataDirectory, join(root, 'legacy-profiles', name));
      assert.equal(app.getPath('sessionData'), join(status.environment.dataDirectory, 'session'));
      assert.equal(status.nsfw.modelState, 'missing');
      assert.equal(await run('document.querySelector("#login").disabled'), true);
      assert((await run('document.querySelector("#environment").textContent')).includes(name));
      if (phase === 'write') {
        assert.equal(status.config.serverUrl, 'http://127.0.0.1:' + (name === 'dev' ? 47842 : 47852));
        assert.equal(status.config.tokenConfigured, false); assert.equal(status.queueDepth, 0);
        const before = await run('window.mote.noteDraft()'); assert.equal(before.text, '');
        receiver = createServer((req, res) => { req.resume(); res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"synthetic deny"}'); });
        await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
        const config = { ...status.config, token, serverUrl: 'http://127.0.0.1:' + receiver.address().port, deviceName: 'private fixture device ' + name, diagnosticsEnabled: true };
        await run(`window.mote.configure(${JSON.stringify(config)})`);
        await run(`window.mote.saveNote(${JSON.stringify({ ...before, text: privateNote, mood: 'private mood', revision: before.revision + 1 })})`);
        await run('window.mote.noteDraft().then(d => window.mote.updateNoteDraft({...d,text:"private remaining draft",revision:d.revision+1}))');
        // Retry is an actual native IPC -> loopback HTTP 401 -> persistent queue failure path.
        for (let i = 0; i < 50; i++) {
          await run('window.mote.retry()'); status = await run('window.mote.status()');
          if (status.lastUploadError) break;
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        assert.equal(status.queueDepth, 1); assert(status.lastUploadError);
        writeFileSync(join(root, name + '-identity.json'), JSON.stringify({ deviceId: status.config.deviceId }), { mode: 0o600 });
      } else {
        assert.equal(status.config.deviceId, JSON.parse(readFileSync(join(root, name + '-identity.json'), 'utf8')).deviceId);
        assert.equal(status.config.tokenConfigured, true); assert.equal(status.queueDepth, 1);
        assert.equal((await run('window.mote.noteDraft()')).text, 'private remaining draft');
      }
      assert.deepEqual(await run('window.mote.exportSupport()'), { canceled: false });
      const report = readFileSync(output, 'utf8'); const bundle = JSON.parse(report);
      assert.equal(bundle.app.profile, name); assert(bundle.events.some(e => e.stage === 'UPLOAD' && e.code === 'AUTH' && e.httpStatus === 401));
      const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
      const exportedStrings = strings(bundle);
      for (const value of [token, privateNote, 'private remaining draft', 'private mood', 'private fixture device', status.config.deviceId, status.config.reviewPolicy, status.config.serverUrl, root]) { assert(!report.includes(value)); assert(!exportedStrings.some(text => text.includes(value))); }
      assert.equal((await run('window.mote.status()')).running, false);
      // Keep both worker processes alive briefly: their instance locks must be independent.
      await new Promise(resolve => setTimeout(resolve, 400));
      process.stdout.write(JSON.stringify({ ok: true, fixtureOnly: true, profile: name, phase, captureStayedStopped: true, supportContentExcluded: true, offlineQueueRetained: true }) + '\n');
      clearTimeout(timeout); receiver?.close(); app.quit();
    })().catch(error => { process.stderr.write(`profile fixture failed: ${error.message}\n`); receiver?.close(); app.exit(1); });
  });
});
require('../dist/main');
