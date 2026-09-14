const { app, dialog, Menu, ipcMain, shell, nativeImage } = require('electron');
const { randomUUID } = require('node:crypto');
const { imageHash } = require('../dist/queue');
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs');
const { rm, realpath, stat, readFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { defaultConfig, ConfigStore } = require('../dist/config');

// A clean generated profile prevents reading existing settings or personal screenshots.
const profile = mkdtempSync(join(tmpdir(), 'mote-ui-fixture-'));
app.setPath('userData', profile);
process.env.MOTE_PROFILE = 'legacy'; delete process.env.MOTE_URL; delete process.env.MOTE_TOKEN; delete process.env.MOTE_ENV_FILE;
writeFileSync(join(profile, 'config.json'), JSON.stringify({ version: 1, config: { ...defaultConfig(), serverUrl: '', deviceName: 'Synthetic Mac', ocrEnabled: false, metadataEnabled: false } }), { mode: 0o600 });
const sourceFile = join(profile, 'synthetic-source.md');
writeFileSync(sourceFile, '合成原生来源 UI：仅用于测试 🧑🏽‍💻');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourceFile] });
const errors = [];
const externalUrls = [];
shell.openExternal = async url => { externalUrls.push(url); };
let finished = false;
const timeout = setTimeout(() => { process.stderr.write('UI smoke timeout\n'); app.exit(1); }, 30000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      const js = code => window.webContents.executeJavaScript(code);
      const navigate = async page => {
        await js(`document.querySelector('[data-nav="${page}"]').click(); new Promise(resolve => setTimeout(resolve, 180))`);
        assert(await js(`Array.from(document.querySelectorAll('[data-page]')).every(element => element.hidden === (element.dataset.page !== '${page}'))`), `Only ${page} should be visible`);
        assert(await js(`document.activeElement.matches('[data-page-title]')`), 'Navigation focuses the page heading');
      };
      const status = await window.webContents.executeJavaScript('window.mote.status()');
      // Exercise the picker with generated identities; do not enumerate personal applications.
      ipcMain.removeHandler('mote:installed-applications');
      ipcMain.handle('mote:installed-applications', () => [{ appId: 'dev.mote.synthetic.private', appName: '合成私密应用' }]);
      let startRequested = false;
      ipcMain.removeHandler('mote:start');
      ipcMain.handle('mote:start', () => { startRequested = true; return status; });
      assert.equal(status.sync.state, 'unconfigured');
      await js(`document.querySelector('#start').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert(startRequested, 'No node URL or token needed to request local capture (IPC stub, no screen read)');

      assert(await js(`Array.from(document.querySelectorAll('[data-page]')).filter(el => !el.hidden).every(el => el.dataset.page === 'overview')`));
      assert(await js(`document.querySelector('#server-url').getClientRects().length === 0 && document.querySelector('#diagnostics-enabled').getClientRects().length === 0`), 'Overview has no settings fields');
      const settingsMenu = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.accelerator === 'CmdOrCtrl+,');
      assert(settingsMenu, 'Standard settings menu exists'); settingsMenu.click();
      await js(`new Promise(resolve => requestAnimationFrame(resolve))`);
      assert(await js(`!document.querySelector('[data-page="settings"]').hidden`), 'Native settings menu routes to Settings');
      await js(`document.querySelector('#open-feedback').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert.equal(externalUrls.length, 1);
      const feedbackUrl = new URL(externalUrls[0]);
      assert.equal(feedbackUrl.origin, 'https://github.com');
      assert.equal(feedbackUrl.pathname, '/utopiafar/mote/issues/new');
      assert.equal(feedbackUrl.searchParams.get('template'), 'bug_report.yml');
      assert(feedbackUrl.searchParams.get('version').includes(app.getVersion()));
      assert.equal(feedbackUrl.searchParams.get('environment'), '桌面客户端 · legacy');
      assert.equal(decodeURIComponent(externalUrls[0]).includes('Synthetic Mac'), false);
      // Simulate only the renderer running state; the collector never starts in this fixture.
      // Settings must remain editable while capturing, independently of actual native capture.
      const send = window.webContents.send.bind(window.webContents);
      window.webContents.send = (channel, ...args) => send(channel, ...(channel === 'mote:status' ? [{ ...args[0], running: true, state: 'capturing' }] : args));
      window.webContents.send('mote:status', { ...status, running: true, state: 'capturing' });
      await navigate('capture');
      assert(await js(`!document.querySelector('#settings-fields').disabled`));
      assert(await js(`document.querySelector('#save-hint').textContent.includes('立即应用')`));
      await navigate('overview');
      window.webContents.send = send;
      window.webContents.send('mote:status', status);
      await navigate('notes');
      for (let i = 0; i < 50 && await js(`document.querySelector('#note-text').disabled`); i++) await new Promise(resolve => setTimeout(resolve, 20));
      await js(`document.querySelector('#note-text').value = '跨页面保留的合成草稿'; document.querySelector('#note-text').dispatchEvent(new Event('input', {bubbles: true}));`);
      await navigate('settings'); await navigate('notes');
      assert.equal(await js(`document.querySelector('#note-text').value`), '跨页面保留的合成草稿');
      await navigate('settings'); await navigate('developer');
      await js(`document.querySelector('#jpeg-quality').value = '10'; document.querySelector('#jpeg-quality').dispatchEvent(new Event('input', {bubbles: true}));`);
      await navigate('capture');
      await js(`document.querySelector('#settings').requestSubmit()`);
      assert(await js(`!document.querySelector('[data-page="developer"]').hidden && document.activeElement.id === 'jpeg-quality'`), 'Invalid hidden field is revealed and focused');
      await js(`document.querySelector('#settings-reset').click()`);
      assert.equal(await js(`document.querySelector('#jpeg-quality').value`), String(status.config.jpegQuality));
      assert(await js(`document.querySelector('#settings-pending').hidden`));
      await navigate('connection');
      await js(`document.querySelector('#device-name').value = '未保存的设备名称'; document.querySelector('#device-name').dispatchEvent(new Event('input', {bubbles: true}));`);
      await navigate('overview'); await navigate('connection');
      assert.equal(await js(`document.querySelector('#device-name').value`), '未保存的设备名称');
      const update = await window.webContents.executeJavaScript('window.mote.updateStatus()');
      assert.equal(update.currentVersion, app.getVersion()); assert.equal(update.state, 'idle'); assert.equal(update.canInstall, false);
      assert(await window.webContents.executeJavaScript('Boolean(document.querySelector("#update-install"))'));
      await window.webContents.executeJavaScript('window.mote.updateChannel("preview")');
      assert.equal((await window.webContents.executeJavaScript('window.mote.updateStatus()')).channel, 'preview');
      await window.webContents.executeJavaScript('window.mote.updateChannel("stable")');
      assert.equal(status.running, false); assert.equal(status.config.deviceName, 'Synthetic Mac'); assert.equal(status.queueDepth, 0);
      await navigate('privacy');
      await js(`document.querySelector('#add-app-rule').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert.equal(await js(`document.querySelector('#installed-app-choice').options[0].textContent`), '合成私密应用 · dev.mote.synthetic.private');
      await js(`document.querySelector('#use-installed-app').click(); document.querySelector('#app-collection-rules select').value = 'off'; document.querySelector('[data-mask=notification]').click()`);
      assert.equal(await js(`document.querySelectorAll('#mask-editor input[type=range]').length`), 4);
      await js(`const width = document.querySelector('[aria-label="区域 1 宽度"]'); width.value = '25'; width.dispatchEvent(new Event('input', { bubbles: true }));`);
      await navigate('capture');
      await js(`document.querySelector('#ocr-charging').checked = true; document.querySelector('#ocr-charging').dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#interval-preset').value = '60'; document.querySelector('#interval-preset').dispatchEvent(new Event('change', { bubbles: true }));`);
      await navigate('sync');
      for (const mode of ['interval', 'batch', 'manual']) {
        await js(`document.querySelector('[name=sync-mode][value=${mode}]').click()`);
        assert.equal(await js(`document.querySelector('#sync-batch-field').hidden`), mode !== 'batch');
        assert.equal(await js(`document.querySelector('#sync-interval-field').hidden`), mode === 'manual');
      }
      await js(`document.querySelector('#device-name').value = 'UI Fixture Renamed'; document.querySelector('#default-collection').value = 'activity'; document.querySelector('#settings').requestSubmit();`);
      let updated;
      for (let i = 0; i < 50; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        updated = await window.webContents.executeJavaScript('window.mote.status()');
        if (updated.config.deviceName === 'UI Fixture Renamed') break;
      }
      assert.equal(updated.config.deviceName, 'UI Fixture Renamed');
      assert.equal(updated.config.ocrOnlyWhileCharging, true); assert.equal(updated.config.syncMode, 'manual'); assert.equal(updated.config.intervalMs, 60000); assert.deepEqual(updated.config.masks, [{ x: .7, y: 0, width: .25, height: .2 }]);
      assert.equal(updated.running, false); assert.equal(updated.config.defaultCollection, 'activity'); assert.deepEqual(updated.config.appCollectionRules, { 'dev.mote.synthetic.private': 'off' }); assert.equal(updated.config.metadataEnabled, false);
      const savedNote = await window.webContents.executeJavaScript('window.mote.noteDraft().then(draft => window.mote.saveNote({...draft,text:"Synthetic native app note",mood:"calm",revision:draft.revision+1}))');
      assert.match(savedNote.id, /^[a-f0-9-]{36}$/);
      const noteStatus = await window.webContents.executeJavaScript('window.mote.status()');
      assert.equal(noteStatus.queueDepth, 1); assert.equal(noteStatus.sync.state, 'unconfigured'); assert(noteStatus.sync.localBacklogUnbound);
      await navigate('connection');
      assert(await js(`!document.querySelector('#local-backlog-confirmation').hidden`), 'Initial backlog adoption has an explicit confirmation');
      await js(`document.querySelector('#confirm-local-backlog').checked = true; document.querySelector('#server-url').dispatchEvent(new Event('input', { bubbles: true }));`);
      assert(!await js(`document.querySelector('#confirm-local-backlog').checked`), 'Editing destination clears adoption consent');
      await js(`document.querySelector('#settings-reset').click()`);
      for (let i = 0; i < 50; i++) {
        if (await window.webContents.executeJavaScript('document.querySelector("#queue-count").textContent === "1"')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      for (let i = 0; i < 50; i++) {
        if (await window.webContents.executeJavaScript('!document.querySelector("#settings-fields").disabled')) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert(await window.webContents.executeJavaScript('!document.querySelector("#settings-fields").disabled'));
      await navigate('sources');
      await window.webContents.executeJavaScript(`document.querySelector('#source-files').click()`);
      let sources;
      for (let i = 0; i < 100; i++) { sources = await window.webContents.executeJavaScript('window.mote.sources()'); if (sources[0]?.pending === 1) break; await new Promise(resolve => setTimeout(resolve, 50)); }
      assert.equal(sources.length, 1); assert.equal(sources[0].pending, 1); assert.equal(sources[0].source.kind, 'local-files');
      for (let i = 0; i < 100 && !await js(`document.querySelector('#sync-message').textContent.includes('共 2 条待传')`); i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert(await js(`document.querySelector('#sync-message').textContent.includes('共 2 条待传')`), 'Overview includes capture/note and source backlog');
      for (let i = 0; i < 100 && !await js(`document.querySelector('#source-list .source-card') !== null`); i++) await new Promise(resolve => setTimeout(resolve, 50));
      await js(`document.querySelector('#source-list .source-card button').click()`);
      assert(await js(`document.querySelector('#source-editor-title').closest('details').open`), 'Editing a source reveals its rules');
      await js(`document.querySelector('#source-cancel-edit').click()`);
      assert(await window.webContents.executeJavaScript('Boolean(document.querySelector("#source-calendar-connect"))'));
      assert(!errors.some(message => !message.includes('Electron Security Warning')), errors.join('\n'));
      const output = resolve(process.env.MOTE_UI_SCREENSHOT || join(__dirname, '..', 'release', 'ui-fixture.png'));
      mkdirSync(require('node:path').dirname(output), { recursive: true });
      await navigate('overview');
      writeFileSync(output, (await window.webContents.capturePage()).toPNG());
      await navigate('settings');
      writeFileSync(join(require('node:path').dirname(output), 'settings-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await navigate('sync');
      writeFileSync(join(require('node:path').dirname(output), 'sync-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await navigate('capture');
      writeFileSync(join(require('node:path').dirname(output), 'capture-settings-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await navigate('notes');
      writeFileSync(join(require('node:path').dirname(output), 'notes-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await navigate('sources');
      await js(`document.querySelector('#source-editor-title').closest('details').open = false; window.scrollTo(0, 0)`);
      writeFileSync(join(require('node:path').dirname(output), 'source-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await navigate('about');
      await window.webContents.executeJavaScript('document.querySelector("#app-updates").scrollIntoView({behavior:"instant",block:"start"}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      writeFileSync(join(require('node:path').dirname(output), 'update-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await navigate('privacy');
      await window.webContents.executeJavaScript('document.querySelector("#default-collection").scrollIntoView({behavior:"instant",block:"start"}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      writeFileSync(join(require('node:path').dirname(output), 'graded-collection-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await js(`document.querySelector('#mask-preview').closest('.panel').scrollIntoView({behavior:'instant', block:'start'})`);
      writeFileSync(join(require('node:path').dirname(output), 'mask-editor-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await navigate('overview'); window.setSize(820, 620);
      await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      assert(await js(`document.documentElement.scrollWidth <= window.innerWidth`), 'No horizontal overflow at minimum window width');
      writeFileSync(join(require('node:path').dirname(output), 'compact-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      assert.equal((await js('window.mote.status()')).running, false);
      const generatedJpeg = nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 160), { width: 64, height: 64 }).toJPEG(75);
      const hash = imageHash(generatedJpeg), day = new Date(), fixtureRecords = [];
      for (let index = 0; index < 31; index++) fixtureRecords.push({ event: { id: randomUUID(), deviceId: status.config.deviceId, deviceName: '合成截图设备', platform: 'macos', capturedAt: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, index).toISOString(), durationMs: 0, appId: 'dev.mote.fixture', appName: '合成截图', imageMime: 'image/jpeg', ocrText: '合成 OCR <script>不可执行的证据</script>', ocr: { status: 'completed' }, source: 'screen', privacy: { excluded: false, redacted: false, mode: 'local', reason: 'generated fixture only' } }, blobHash: hash, blobBytes: generatedJpeg.length, attempts: 0, nextAttemptAt: 0 });
      const fixtureArchive = join(profile, 'generated-records.json');
      writeFileSync(fixtureArchive, JSON.stringify({ format: 'mote-desktop-queue', version: 1, records: fixtureRecords, blobs: { [hash]: generatedJpeg.toString('base64') } }));
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixtureArchive] });
      assert.equal((await js('window.mote.importQueue()')).imported, 31);
      await navigate('records');
      for (let i = 0; i < 100 && await js(`document.querySelectorAll('.record-card').length !== 30`); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(await js(`document.querySelectorAll('.record-card').length`), 30);
      assert(await js(`document.querySelector('#records-status').textContent.includes('31')`));
      await js(`document.querySelector('#records-next').click()`);
      for (let i = 0; i < 100 && await js(`document.querySelectorAll('.record-card').length !== 1`); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(await js(`document.querySelectorAll('.record-card').length`), 1);
      await js(`document.querySelector('.record-card').click()`);
      for (let i = 0; i < 100 && await js(`!document.querySelector('#record-detail-image').src.startsWith('data:image/jpeg')`); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert(await js(`document.querySelector('#record-detail-text').textContent.includes('<script>不可执行的证据</script>')`));
      assert(await js(`document.querySelector('#record-detail-image').src.startsWith('data:image/jpeg')`));
      assert(await js(`document.querySelector('#record-detail-text script') === null`));
      writeFileSync(join(require('node:path').dirname(output), 'capture-records-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      assert.equal((await js('window.mote.status()')).running, false);
      const originalSave = ConfigStore.prototype.save;
      const beforeFailedSave = await js('window.mote.status()');
      ConfigStore.prototype.save = async function(config) { if (config.deviceName === 'Synthetic Save Failure') throw new Error('synthetic config persistence failure'); return originalSave.call(this, config); };
      try {
        const rejected = await js(`window.mote.configure({...(${JSON.stringify(beforeFailedSave.config)}),deviceName:'Synthetic Save Failure',intervalMs:15000,jpegQuality:55}).then(()=>false,error=>error.message.includes('synthetic config persistence failure'))`);
        assert(rejected, 'Config persistence failure is reported');
        const afterFailedSave = await js('window.mote.status()');
        assert.deepEqual(afterFailedSave.config, beforeFailedSave.config, 'Runtime settings roll back after save failure');
        assert.equal(afterFailedSave.running, false); assert.equal(afterFailedSave.storage.recoveryRequired, undefined);
        const disk = JSON.parse(await readFile(join(profile, 'config.json'),'utf8')).config;
        assert.equal(disk.deviceName, beforeFailedSave.config.deviceName); assert.equal(disk.intervalMs, beforeFailedSave.config.intervalMs); assert.equal(disk.jpegQuality, beforeFailedSave.config.jpegQuality);
      } finally { ConfigStore.prototype.save = originalSave; }
      const external = await realpath(mkdtempSync(join(tmpdir(), 'mote-storage-ui-fixture-')));
      try {
        const oldStatus = await js('window.mote.status()');
        const rejected = await js(`window.mote.configure({...(${JSON.stringify(oldStatus.config)}),captureStorageDirectory:${JSON.stringify(join(external, 'unauthorized'))}}).then(()=>false, error=>error.message.includes('选择器'))`);
        assert(rejected, 'Renderer cannot submit arbitrary filesystem paths');
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [external] });
        await navigate('capture');
        await js(`document.querySelector('#capture-directory-choose').click()`);
        for (let i = 0; i < 100 && !await js(`document.querySelector('#capture-directory').value.includes('Mote-Captures-')`); i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert(await js(`document.querySelector('#capture-directory').readOnly`));
        const selected = await js(`document.querySelector('#capture-directory').value`);
        await js(`document.querySelector('#settings').requestSubmit()`);
        for (let i = 0; i < 100 && (await js('window.mote.status()')).storage.directory !== selected; i++) await new Promise(resolve => setTimeout(resolve, 20));
        const moved = await js('window.mote.status()');
        assert.equal(moved.storage.directory, selected); assert.equal(moved.config.captureStorageDirectory, selected);
        assert.equal(moved.running, false); assert.equal(moved.queueDepth, oldStatus.queueDepth); assert.equal(moved.config.deviceId, oldStatus.config.deviceId);
        await assert.rejects(stat(oldStatus.storage.directory), {code:'ENOENT'});
        assert.equal(JSON.parse(await readFile(join(profile, 'config.json'),'utf8')).config.captureStorageDirectory, selected);
        await js(`document.querySelector('#capture-directory-default').click(); document.querySelector('#settings').requestSubmit()`);
        for (let i = 0; i < 100 && (await js('window.mote.status()')).storage.directory !== oldStatus.storage.directory; i++) await new Promise(resolve => setTimeout(resolve, 20));
        const restored = await js('window.mote.status()'); assert.equal(restored.storage.directory, oldStatus.storage.directory); assert.equal(restored.config.captureStorageDirectory, ''); assert.equal(restored.running, false); assert.equal(restored.queueDepth, moved.queueDepth);
        await assert.rejects(stat(selected), {code:'ENOENT'});
        const crashTarget = (await js('window.mote.chooseCaptureDirectory()')).directory;
        ConfigStore.prototype.save = async function(config) { await originalSave.call(this, config); throw new Error('synthetic failure after durable pointer rename'); };
        try {
          const rejected = await js(`window.mote.configure({...(${JSON.stringify(restored.config)}),captureStorageDirectory:${JSON.stringify(crashTarget)}}).then(()=>false,error=>error.message.includes('需要恢复'))`);
          assert(rejected, 'Ambiguous commit explicitly requires recovery');
          const recovering = await js('window.mote.status()'); assert.equal(recovering.running, false); assert(recovering.storage.recoveryRequired); assert.equal(recovering.state, 'error');
          assert((await stat(crashTarget)).isDirectory()); assert((await stat(restored.storage.directory)).isDirectory());
          assert.equal(JSON.parse(await readFile(join(profile, 'config.json'),'utf8')).config.captureStorageDirectory, crashTarget);
          assert(await js(`window.mote.retry().then(()=>false,error=>error.message.includes('需要恢复'))`));
          assert(await js(`window.mote.importQueue().then(()=>false,error=>error.message.includes('需要恢复'))`));
          assert(await js(`window.mote.saveNote({}).then(()=>false,error=>error.message.includes('需要恢复'))`));
          await navigate('overview'); assert(await js(`!document.querySelector('#storage-restart').hidden`));
        } finally { ConfigStore.prototype.save = originalSave; }
      } finally { await rm(external, { recursive: true, force: true }); }
      process.stdout.write(JSON.stringify({ failedSettingsRolledBack: true, ambiguousCommitPreservesBothAndBlocksWrites: true, captureStorageNativePickerAndMigration: true, arbitraryStoragePathRejected: true, captureBrowserPagingAndOcrDetails: true, chargingOcrSettingSaved: true, feedbackLink: true, localOnlyStartIpcStub: true, uploadModeControls: true, installedAppPickerFixture: true, maskPresetsAndSlider: true, friendlyPresetsSaved: true, localBacklogConsent: true, navigationAndKeyboardFocus: true, nativeSettingsMenu: true, settingsEditableWhileCapturing: true, draftAndConfigRetainedAcrossPages: true, hiddenInvalidSettingsRevealed: true, discardSettings: true, sourceEditorRevealed: true, minimumWindowLayout: true, gradedCollectionUiAndIpc: true, metadataDisabled: true, updatesUiAndChannelIpc: true, noUpdateNetworkRequest: true, ok: true, fixtureOnly: true, rendererLoaded: true, preloadIpc: true, savedSettings: true, offlineNotePersisted: true, captureStayedStopped: true, nativeFilePickerAndOfflineSource: true, calendarPermissionNotRequested: true, screenshot: output }) + '\n');
      finished = true; clearTimeout(timeout); app.quit();
    })().catch(error => { process.stderr.write(`UI smoke failed: ${error.message}\n`); app.exit(1); });
  });
});
app.on('quit', () => { if (finished) void rm(profile, { recursive: true, force: true }); });
require('../dist/main');
