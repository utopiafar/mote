const { app, dialog } = require('electron');
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { defaultConfig } = require('../dist/config');

// A clean generated profile prevents reading existing settings or personal screenshots.
const profile = mkdtempSync(join(tmpdir(), 'mote-ui-fixture-'));
app.setPath('userData', profile);
process.env.MOTE_PROFILE = 'legacy'; delete process.env.MOTE_URL; delete process.env.MOTE_TOKEN; delete process.env.MOTE_ENV_FILE;
writeFileSync(join(profile, 'config.json'), JSON.stringify({ version: 1, config: { ...defaultConfig(), deviceName: 'Synthetic Mac', ocrEnabled: false } }), { mode: 0o600 });
const sourceFile = join(profile, 'synthetic-source.md');
writeFileSync(sourceFile, '合成原生来源 UI：仅用于测试 🧑🏽‍💻');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourceFile] });
const errors = [];
let finished = false;
const timeout = setTimeout(() => { process.stderr.write('UI smoke timeout\n'); app.exit(1); }, 20000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      const status = await window.webContents.executeJavaScript('window.mote.status()');
      assert.equal(status.running, false); assert.equal(status.config.deviceName, 'Synthetic Mac'); assert.equal(status.queueDepth, 0);
      await window.webContents.executeJavaScript(`document.querySelector('#device-name').value = 'UI Fixture Renamed'; document.querySelector('#settings').requestSubmit();`);
      let updated;
      for (let i = 0; i < 50; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        updated = await window.webContents.executeJavaScript('window.mote.status()');
        if (updated.config.deviceName === 'UI Fixture Renamed') break;
      }
      assert.equal(updated.config.deviceName, 'UI Fixture Renamed');
      assert.equal(updated.running, false);
      const savedNote = await window.webContents.executeJavaScript('window.mote.noteDraft().then(draft => window.mote.saveNote({...draft,text:"Synthetic native app note",mood:"calm",revision:draft.revision+1}))');
      assert.match(savedNote.id, /^[a-f0-9-]{36}$/);
      const noteStatus = await window.webContents.executeJavaScript('window.mote.status()');
      assert.equal(noteStatus.queueDepth, 1);
      for (let i = 0; i < 50; i++) {
        if (await window.webContents.executeJavaScript('document.querySelector("#queue-count").textContent === "1"')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      for (let i = 0; i < 50; i++) {
        if (await window.webContents.executeJavaScript('!document.querySelector("#settings-fields").disabled')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert(await window.webContents.executeJavaScript('!document.querySelector("#settings-fields").disabled'));
      await window.webContents.executeJavaScript(`document.querySelector('#source-files').click()`);
      let sources;
      for (let i = 0; i < 100; i++) { sources = await window.webContents.executeJavaScript('window.mote.sources()'); if (sources[0]?.pending === 1) break; await new Promise(resolve => setTimeout(resolve, 50)); }
      assert.equal(sources.length, 1); assert.equal(sources[0].pending, 1); assert.equal(sources[0].source.kind, 'local-files');
      assert(await window.webContents.executeJavaScript('Boolean(document.querySelector("#source-calendar-connect"))'));
      assert(!errors.some(message => !message.includes('Electron Security Warning')), errors.join('\n'));
      const output = resolve(process.env.MOTE_UI_SCREENSHOT || join(__dirname, '..', 'release', 'ui-fixture.png'));
      mkdirSync(require('node:path').dirname(output), { recursive: true });
      writeFileSync(output, (await window.webContents.capturePage()).toPNG());
      await window.webContents.executeJavaScript('document.querySelector("#local-sources").scrollIntoView()');
      writeFileSync(join(require('node:path').dirname(output), 'source-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      process.stdout.write(JSON.stringify({ ok: true, fixtureOnly: true, rendererLoaded: true, preloadIpc: true, savedSettings: true, offlineNotePersisted: true, captureStayedStopped: true, nativeFilePickerAndOfflineSource: true, calendarPermissionNotRequested: true, screenshot: output }) + '\n');
      finished = true; clearTimeout(timeout); app.quit();
    })().catch(error => { process.stderr.write(`UI smoke failed: ${error.message}\n`); app.exit(1); });
  });
});
app.on('quit', () => { if (finished) void rm(profile, { recursive: true, force: true }); });
require('../dist/main');
