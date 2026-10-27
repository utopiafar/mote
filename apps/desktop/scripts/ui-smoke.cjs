require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');
const { app, BrowserWindow, dialog, Menu, ipcMain, shell, nativeImage, Tray } = require('electron');
const { randomUUID } = require('node:crypto');
const { imageHash } = require('../dist/queue');
const { mkdtempSync, writeFileSync, mkdirSync } = require('node:fs');
const { rm, realpath, stat, readFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { defaultConfig, ConfigStore } = require('../dist/config');
const { QueueStorage } = require('../dist/queue-storage');
// Unpackaged Electron otherwise reports its runtime version. Rollout evidence
// names the tested product version; DEV metadata exercises the real main branch.
if (process.env.MOTE_UI_ROLLOUT) app.getVersion = () => require('../package.json').version;

// A clean generated profile prevents reading existing settings or personal screenshots.
const profile = mkdtempSync(join(tmpdir(), 'mote-ui-fixture-'));
app.setPath('userData', profile);
process.env.MOTE_PROFILE = 'default'; delete process.env.MOTE_URL; delete process.env.MOTE_TOKEN; delete process.env.MOTE_ENV_FILE;
writeFileSync(join(profile, 'config.json'), JSON.stringify({ version:4, config: { ...defaultConfig(), serverUrl: '', deviceName: 'Synthetic Mac', metadataEnabled: false } }), { mode: 0o600 });
writeFileSync(join(profile,'storage-format.json'),JSON.stringify({version:4}),{mode:0o600});
const sourceFile = join(profile, 'synthetic-source.md');
writeFileSync(sourceFile, '合成原生来源 UI：仅用于测试 🧑🏽‍💻');
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [sourceFile] });
const errors = [];
const externalUrls = [];
shell.openExternal = async url => { externalUrls.push(url); };
let trayMenu;
const setTrayMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function(menu) { trayMenu = menu; return setTrayMenu.call(this, menu); };
const childProcess = require('node:child_process');
const originalExecFile = childProcess.execFile;
childProcess.execFile = function(file, args, ...rest) {
  if (file !== '/usr/bin/open') return originalExecFile.call(this, file, args, ...rest);
  externalUrls.push(args.at(-1));
  const callback = rest.at(-1);
  if (typeof callback === 'function') queueMicrotask(() => callback(null, '', ''));
  return { kill() {} };
};
childProcess.execFile[require('node:util').promisify.custom] = async (file, args, ...rest) => {
  if (file !== '/usr/bin/open') return require('node:util').promisify(originalExecFile)(file, args, ...rest);
  externalUrls.push(args.at(-1)); return { stdout: '', stderr: '' };
};
let finished = false;
let currentPhase = 'startup';
const timeout = setTimeout(() => { process.stderr.write('UI smoke timeout: ' + currentPhase + '\n'); app.exit(1); }, process.env.MOTE_UI_ART_ROUND || process.env.MOTE_UI_ROLLOUT ? 240000 : 45000);
let mainFixtureWindow;
app.on('browser-window-created', (_event, window) => {
  if (mainFixtureWindow) return;
  mainFixtureWindow = window;
  // Fixture screenshots and animation-frame checks must run even if another app is foreground.
  window.webContents.setBackgroundThrottling(false);
  window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  window.webContents.once('did-finish-load', () => {
    void (async () => {
      const mainJs = code => window.webContents.executeJavaScript(code);
      const quick = () => BrowserWindow.getAllWindows().find(candidate => candidate !== window && candidate.webContents.getURL().endsWith('#quick-note'));
      const js = code => (quick() || window).webContents.executeJavaScript(code);
      const closeQuick = async () => { const note=quick();if(note){note.close();await new Promise(resolve=>setTimeout(resolve,100));} };
      const waitQuick = async () => {for(let i=0;i<200;i++){const note=quick();if(note&&!note.webContents.isLoading()&&await note.webContents.executeJavaScript(`!document.querySelector('#note-text').disabled`))return;await new Promise(resolve=>setTimeout(resolve,25));}throw Error('Quick note did not become ready');};
      const output = resolve(process.env.MOTE_UI_SCREENSHOT || join(__dirname, '..', 'release', 'ui-fixture.png'));
      const outputDirectory = require('node:path').dirname(output);
      mkdirSync(outputDirectory, { recursive: true });
      await js("window.confirm=()=>true;true;");
      const settingsIdle = async phase => {
        currentPhase = phase;
        for (let i = 0; i < 200; i++) {
          if (await js(`!document.querySelector('#settings-fields').disabled`)) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error(`Settings operation did not complete: ${phase}`);
      };
      const recordsIdle = async phase => {
        currentPhase = phase;
        for (let i = 0; i < 400; i++) {
          if (await js(`document.querySelector('#records-status').getAttribute('aria-busy') === 'false'`)) return;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error(`Capture thumbnails did not settle: ${phase}`);
      };
      const navigate = async page => {
        currentPhase = 'navigate ' + page;
        await closeQuick();
        if(page==='notes'){await mainJs('window.mote.openQuickNote()');await waitQuick();assert(await js(`!document.querySelector('[data-page=notes]').hidden`));return;}
        await js(`(async () => {
          const visible = () => Array.from(document.querySelectorAll('[data-nav="${page}"]')).find(button => button.getClientRects().length);
          if (!visible()) {
            if ('${page}' === 'notes' || '${page}' === 'screen') {
              if (document.querySelector('#note-action').hidden) {
                document.querySelector('aside [data-nav="overview"]').click();
                await new Promise(resolve => requestAnimationFrame(resolve));
              }
              document.querySelector('#note-action').click();
              document.querySelector('#add-dialog [data-add-choice="' + ('${page}' === 'notes' ? 'note' : 'screen') + '"]').click();
              await new Promise(resolve => setTimeout(resolve, 180)); return;
            }
            const parent = '${page}' === 'sources' || '${page}' === 'uploads' ? 'overview' : 'settings';
            document.querySelector('aside [data-nav="' + parent + '"]').click();
            await new Promise(resolve => requestAnimationFrame(resolve));
          }
          const button = visible();
          if (!button) throw new Error('No visible route to ${page}');
          button.click();
          await new Promise(resolve => setTimeout(resolve, 180));
        })()`);
        assert(await js(`Array.from(document.querySelectorAll('[data-page]')).every(element => element.hidden === (element.dataset.page !== '${page}'))`), `Only ${page} should be visible`);
        assert(await js(`document.activeElement.matches('[data-page-title]')`), 'Navigation focuses the page heading');
        assert.equal(await js(`document.querySelectorAll('.page .back-button').length`), 0, 'Subpages use the single workspace parent control');
      };
      const status = await window.webContents.executeJavaScript('window.mote.status()');
      // Exercise the picker with generated identities; do not enumerate personal applications.
      ipcMain.removeHandler('mote:installed-applications');
      ipcMain.handle('mote:installed-applications', () => [{ appId: 'dev.mote.synthetic.private', appName: '合成私密应用' }]);
      ipcMain.removeHandler('mote:permission-status');
      ipcMain.handle('mote:permission-status', () => ({screen: 'granted', accessibility: 'denied', calendar: 'not-determined'}));
      let startRequested = false;
      ipcMain.removeHandler('mote:start');
      ipcMain.handle('mote:start', () => { startRequested = true; return status; });
      assert.equal(status.sync.state, 'unconfigured');
      assert.deepEqual(await js(`Array.from(document.querySelectorAll('.main-nav [data-nav]')).map(b => b.textContent.trim())`), ['首页','资料库','来源','问一问']);
      assert(await js(`!document.querySelector('[data-page=overview]').hidden`),'A new profile opens Workbench');
      await navigate('overview');
      assert.equal(await js(`document.querySelectorAll('.home-task-actions [data-add-choice]').length`), 3, 'Workbench offers note, import and source actions');
      assert(await js(`(() => {
        const luminance = color => color.match(/\\d+(?:\\.\\d+)?/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,index)=>sum+v*[.2126,.7152,.0722][index],0);
        const background=luminance(getComputedStyle(document.documentElement).backgroundColor);
        return Array.from(document.querySelectorAll('.home-page .text-button')).filter(button=>!button.disabled).every(button=>{
          const foreground=luminance(getComputedStyle(button).color);
          return (Math.max(background,foreground)+.05)/(Math.min(background,foreground)+.05)>=4.5;
        });
      })()`), 'Normal-size Home links meet measured 4.5:1 contrast on the actual Slate background');
      assert(await js(`document.querySelector('#start').getClientRects().length === 0`), 'Home starts with content actions');
      await js(`document.querySelector('#note-action').click()`);
      assert.equal(await js(`document.querySelectorAll('#add-dialog [data-add-choice]').length`),5,'Every Add entry offers the shared five choices');
      await js(`document.querySelector('#add-close').click()`);
      await js(`document.querySelector('#note-action').click();document.querySelector('#add-dialog [data-add-choice=lark]').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert(await js(`!document.querySelector('[data-page=connection]').hidden`), 'Feishu explains the missing central connection before opening its cloud settings');
      assert.equal(externalUrls.length,0,'Disconnected Feishu does not open an unauthenticated browser');
      await navigate('overview');
      for(let i=0;i<100&&!await js(`document.querySelector('#home-recent').children.length>0`);i++)await new Promise(resolve=>setTimeout(resolve,25));
      writeFileSync(join(outputDirectory, 'first-run-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      window.setSize(820, 620);
      await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      assert(await js(`document.documentElement.scrollWidth <= window.innerWidth`), 'Newcomer setup fits the minimum window width');
      writeFileSync(join(outputDirectory, 'first-run-compact-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      window.setSize(1140, 840);
      if (process.env.MOTE_UI_ROLLOUT_DIALOGS === 'capture') {
        const manifest=await require('./ui-dialog-rollout.cjs')({window,js,navigate,outputDirectory,kind:'capture'});
        process.stdout.write(JSON.stringify({dialogReady:true,captures:manifest.captures.length,manifest:join(outputDirectory,'dialog-manifest.json')})+'\n');finished=true;clearTimeout(timeout);app.quit();return;
      }
      if (process.env.MOTE_UI_ROLLOUT) {
        currentPhase='UI rollout matrix';
        const manifest=await require('./ui-rollout-matrix.cjs')({window,js,navigate,outputDirectory,profile,ipcMain});
        process.stdout.write(JSON.stringify({rolloutReady:true,captures:manifest.captures.length,manifest:join(outputDirectory,'rollout-manifest.json'),generatedOnly:true})+'\n');
        finished=true;clearTimeout(timeout);app.quit();return;
      }
      if (process.env.MOTE_UI_ART_ROUND) {
        currentPhase='art direction matrix';
        const manifest=await require('./art-direction-matrix.cjs')({window,js,navigate,outputDirectory,round:process.env.MOTE_UI_ART_ROUND,profile});
        clearTimeout(timeout);
        process.stdout.write(JSON.stringify({artDirectionReady:true,sourceCommit:manifest.sourceCommit,captures:manifest.captures.length,manifest:join(outputDirectory,'manifest.json'),generatedOnly:true})+'\n');
        if(process.env.MOTE_UI_REVIEW==='1')return;
        finished=true;app.exit(0);return;
      }
      if (process.env.MOTE_UI_REVIEW === '1') {
        // Keep only this clean generated profile open for independent live UI review.
        // Capture and permissions are already stubbed above; no personal applications are read.
        clearTimeout(timeout);
        window.setTitle('Mote — Generated UI Review');
        process.stdout.write(JSON.stringify({ reviewReady: true, generatedOnly: true, screenshotDirectory: outputDirectory }) + '\n');
        return;
      }
      await js(`document.querySelector('#note-action').click(); document.querySelector('#add-dialog [data-add-choice=note]').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      await waitQuick();
      assert(await js(`!document.querySelector('[data-page="notes"]').hidden`), 'A newcomer can write a note before configuring capture');
      assert.equal(quick().isVisible(),false,'Quick note obeys fixture-background');
      await closeQuick();
      assert(await js(`!document.querySelector('[data-page=overview]').hidden`), 'An offline note returns to home without starting capture');
      await navigate('screen');
      assert(await js(`!document.querySelector('#setup-prompt').hidden`), 'Screen recording has its own first-use scope setup');
      await js(`document.querySelector('#setup-primary').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert(await js(`!document.querySelector('[data-page="privacy"]').hidden && document.querySelector('aside [data-nav="overview"]').getAttribute('aria-current') === 'page'`), 'Initial setup opens the real privacy scope within collection');
      await js(`document.querySelector('#workspace-back').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert(await js(`!document.querySelector('[data-page="screen"]').hidden && !document.querySelector('#collection-workbench').hidden`), 'Scope setup returns to screen controls without requiring a node');
      await navigate('sources');
      assert(await js(`document.querySelector('aside [data-nav="sources"]').getAttribute('aria-current') === 'page' && document.querySelector('#workspace-back').hidden`),'Sources is a primary destination');
      await navigate('overview');
      await navigate('screen');
      await js(`document.querySelector('#start').click(); document.querySelector('#capture-confirm-start').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert(startRequested, 'No node URL or token needed to request local capture (IPC stub, no screen read)');

      // Permission prompts are fixtures: no actual system permissions or screenshots are requested.
      await js(`window.alert = message => { window.fixturePermissionAlert = message; }; undefined`);
      ipcMain.removeHandler('mote:permission-status');
      ipcMain.handle('mote:permission-status', () => ({screen: 'denied', accessibility: 'denied', calendar: 'denied'}));
      startRequested = false;
      await navigate('screen');
      await js(`document.querySelector('#start').click(); document.querySelector('#capture-confirm-start').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert(startRequested, 'Duration-only collection can start without screen permission (IPC stub, no personal reads)');
      assert(await js(`!document.querySelector('[data-page="screen"]').hidden && !window.fixturePermissionAlert`));
      await navigate('permissions');
      assert.equal(await js(`document.querySelector('#permission-screen').textContent`), '! 未授权');
      await navigate('overview');
      assert(await js(`Array.from(document.querySelectorAll('[data-page]')).filter(el => !el.hidden).every(el => el.dataset.page === 'overview')`));
      assert(await js(`document.querySelector('#server-url').getClientRects().length === 0 && document.querySelector('#diagnostics-enabled').getClientRects().length === 0`), 'Overview has no settings fields');
      await navigate('ask');
      assert(await js(`!document.querySelector('#ask-disconnected').hidden && document.querySelector('#ask-workspace').hidden && document.querySelector('#node-login-panel').hidden`), 'Offline Ask explains the connection requirement before requesting a central API');
      assert.equal(await js(`document.querySelector('#ask-error').textContent`), '', 'An absent node must not become a raw IPC failure');
      await js(`document.querySelector('#ask-question').value='generated offline question draft';`);
      window.webContents.send('mote:status', status);
      await js(`new Promise(resolve => requestAnimationFrame(resolve))`);
      assert(await js(`document.querySelector('#node-login-panel').hidden && !document.querySelector('#ask-disconnected').hidden`), 'A subsequent status event preserves the disconnected Ask surface');
      assert.equal(await js(`document.querySelector('#ask-question').value`), 'generated offline question draft', 'Status updates preserve the question draft');
      const authenticatedStatus = { ...status, config: { ...status.config, serverUrl: 'http://127.0.0.1:47999', tokenConfigured: true } };
      const previousAskHandler = ipcMain._invokeHandlers.get('mote:ask');
      const previousStatusHandler = ipcMain._invokeHandlers.get('mote:get-status');
      const previousCentralHandler = ipcMain._invokeHandlers.get('mote:central');
      const centralPages = [];
      const originalStatusSend = window.webContents.send;
      ipcMain.removeHandler('mote:ask'); ipcMain.handle('mote:ask', (_event, command) => command === 'history' || command === 'runs' ? { items: [] } : undefined);
      // Keep both IPC reads and status events in the same synthetic auth state.
      // A late real offline status must not race this isolated authenticated UI scenario.
      ipcMain.removeHandler('mote:get-status'); ipcMain.handle('mote:get-status', () => authenticatedStatus);
      ipcMain.removeHandler('mote:central'); ipcMain.handle('mote:central', (_event, page) => {centralPages.push(page);});
      window.webContents.send = function(channel, ...args) { return originalStatusSend.call(this, channel, ...(channel === 'mote:status' ? [authenticatedStatus] : args)); };
      try {
        await js(`window.mote.status().then(()=>new Promise(resolve=>requestAnimationFrame(resolve)))`);
        window.webContents.send('mote:status', authenticatedStatus);
        await js(`new Promise(resolve => requestAnimationFrame(resolve)); document.querySelector('#ask-refresh').click(); new Promise(resolve => setTimeout(resolve, 100))`);
        assert(await js(`document.querySelector('#node-login-panel').hidden && document.querySelector('#ask-disconnected').hidden`), 'Refreshing an authenticated Ask does not redisplay the token form');
        await navigate('overview');
        await js(`document.querySelector('#note-action').click();document.querySelector('#add-dialog [data-add-choice=lark]').click();new Promise(resolve=>setTimeout(resolve,100))`);
        assert.deepEqual(centralPages,['lark'],'Connected Feishu Add reaches the dedicated central page through real preload IPC');
        trayMenu.items.find(item => item.label === '打开中央仓库').click();
        await js(`new Promise(resolve => setTimeout(resolve, 100))`);
        assert.deepEqual(centralPages,['lark','overview'],'Tray Central reuses the existing renderer and preload owner-access path');
        assert.equal(await js(`document.querySelector('#ask-question').value`), 'generated offline question draft', 'Opening Central preserves the local question draft');
        let rejectCentral, pendingCentralCalls = 0;
        ipcMain.removeHandler('mote:central');
        ipcMain.handle('mote:central', () => { pendingCentralCalls++;return new Promise((_resolve,reject)=>{rejectCentral=reject;}); });
        const centralShortcut = trayMenu.items.find(item => item.label === '打开中央仓库');
        centralShortcut.click(); centralShortcut.click();
        await js(`new Promise(resolve => setTimeout(resolve, 100))`);
        assert.equal(pendingCentralCalls,1,'Repeated tray clicks share the existing busy guard');
        assert.equal(await js(`document.querySelector('#feedback').getAttribute('aria-busy')`),'true','Pending Central access has visible loading state');
        rejectCentral(new Error('generated central access denied'));
        await js(`new Promise(resolve => setTimeout(resolve, 100))`);
        assert(await js(`!document.querySelector('#feedback').hidden && document.querySelector('#feedback').textContent.includes('generated central access denied')`),'A denied Central request displays the existing error instead of opening another route');
        assert.equal(await js(`document.querySelector('#ask-question').value`),'generated offline question draft','A failed Central request preserves the local question draft');
        ipcMain.removeHandler('mote:central');ipcMain.handle('mote:central',(_event,page)=>{centralPages.push(page);});
        centralShortcut.click();
        await js(`new Promise(resolve => setTimeout(resolve, 100))`);
        assert.deepEqual(centralPages,['lark','overview','overview'],'Central shortcut remains usable after the error');
      } finally {
        window.webContents.send = originalStatusSend;
        ipcMain.removeHandler('mote:get-status'); ipcMain.handle('mote:get-status', previousStatusHandler);
        ipcMain.removeHandler('mote:central'); ipcMain.handle('mote:central', previousCentralHandler);
        ipcMain.removeHandler('mote:ask'); ipcMain.handle('mote:ask', previousAskHandler); window.webContents.send('mote:status', status);
      }
      await js(`new Promise(resolve => requestAnimationFrame(resolve)); document.querySelector('#ask-question').value='';`);
      await navigate('ask');
      await js(`document.querySelector('#ask-disconnected [data-nav="connection"]').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert(await js(`!document.querySelector('[data-page="connection"]').hidden`), 'Offline Ask leads to the existing connection setup');
      await navigate('overview');
      const settingsMenu = Menu.getApplicationMenu().items[0].submenu.items.find(item => item.accelerator === 'CmdOrCtrl+,');
      assert(settingsMenu, 'Standard settings menu exists'); settingsMenu.click();
      await js(`new Promise(resolve => requestAnimationFrame(resolve))`);
      assert(await js(`!document.querySelector('[data-page="settings"]').hidden`), 'Native settings menu routes to Settings');
      currentPhase = 'tray shortcuts and draft protection';
      const traySettings = trayMenu.items.find(item => item.label === '设置…');
      const trayCentral = trayMenu.items.find(item => item.label === '打开中央仓库');
      assert(traySettings && trayCentral, 'Tray exposes local settings and Central beside the workbench');
      await navigate('overview');
      traySettings.click(); traySettings.click();
      await js(`new Promise(resolve => requestAnimationFrame(resolve))`);
      assert(await js(`!document.querySelector('[data-page="settings"]').hidden`), 'Tray settings enters the existing Settings page');
      trayCentral.click(); trayCentral.click();
      await js(`new Promise(resolve => requestAnimationFrame(resolve))`);
      assert(await js(`!document.querySelector('[data-page="connection"]').hidden`), 'Disconnected tray Central opens the existing connection setup');
      assert.equal(externalUrls.length, 0, 'Disconnected tray Central never opens a browser');
      await js(`document.querySelector('#device-name').value='generated unsaved tray draft';document.querySelector('#device-name').dispatchEvent(new Event('input'));window.confirm=()=>false;undefined;`);
      traySettings.click();
      await js(`new Promise(resolve => requestAnimationFrame(resolve))`);
      assert(await js(`!document.querySelector('[data-page="connection"]').hidden && !document.querySelector('#settings-pending').hidden`), 'Declining tray navigation keeps the unsaved settings page');
      assert.equal(await js(`document.querySelector('#device-name').value`), 'generated unsaved tray draft', 'Tray navigation does not discard a declined draft');
      assert.equal((await js('window.mote.status()')).running, false, 'Tray navigation does not start collection');
      await js(`window.confirm=()=>true;undefined;`);
      traySettings.click();
      await js(`new Promise(resolve => requestAnimationFrame(resolve))`);
      await js(`document.querySelector('#open-feedback').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert.equal(externalUrls.length, 1);
      const feedbackUrl = new URL(externalUrls[0]);
      assert.equal(feedbackUrl.origin, 'https://github.com');
      assert.equal(feedbackUrl.pathname, '/utopiafar/mote/issues/new');
      assert.equal(feedbackUrl.searchParams.get('template'), 'bug_report.yml');
      assert(feedbackUrl.searchParams.get('version').includes(app.getVersion()));
      assert.equal(feedbackUrl.searchParams.get('environment'), '桌面客户端 · default');
      assert.equal(decodeURIComponent(externalUrls[0]).includes('Synthetic Mac'), false);
      // Simulate only the renderer running state; the collector never starts in this fixture.
      // Settings must remain editable while capturing, independently of actual native capture.
      const send = window.webContents.send.bind(window.webContents);
      const { Collector } = require('../dist/collector');
      const originalStatus = Collector.prototype.status;
      // Both pushed events and the renderer's periodic status query must see the same fixture.
      // Only the returned view changes; the collector itself remains stopped.
      Collector.prototype.status = function() { const value = originalStatus.call(this); assert.equal(value.running, false); return { ...value, running: true, state: 'capturing' }; };
      window.webContents.send = (channel, ...args) => send(channel, ...(channel === 'mote:status' ? [{ ...args[0], running: true, state: 'capturing' }] : args));
      try {
        window.webContents.send('mote:status', { ...status, running: true, state: 'capturing' });
        await navigate('capture');
        assert.equal((await js('window.mote.status()')).running, true, 'Status polling agrees with pushed synthetic capture state');
        // Cross a full polling interval to reproduce the previous event/poll race deterministically.
        await js(`new Promise(resolve => setTimeout(resolve, 1100))`);
        assert(await js(`!document.querySelector('#settings-fields').disabled`));
        assert(await js(`document.querySelector('#save-hint').textContent.includes('立即应用')`));
        await navigate('overview');
      } finally { Collector.prototype.status = originalStatus; window.webContents.send = send; window.webContents.send('mote:status', status); }
      await navigate('notes');
      for (let i = 0; i < 50 && await js(`document.querySelector('#note-text').disabled`); i++) await new Promise(resolve => setTimeout(resolve, 20));
      await js(`document.querySelector('#note-text').value = '跨页面保留的合成草稿'; document.querySelector('#note-text').dispatchEvent(new Event('input', {bubbles: true}));`);
      await navigate('settings'); await navigate('notes');
      assert.equal(await js(`document.querySelector('#note-text').value`), '跨页面保留的合成草稿');
      await navigate('records');
      await js(`document.querySelector('#note-action').click(); document.querySelector('#add-dialog [data-add-choice=note]').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      await waitQuick();
      assert(await js(`!document.querySelector('[data-page="notes"]').hidden`), 'Unified note action opens the standalone editor');
      assert(await mainJs(`!document.querySelector('[data-page=records]').hidden`),'Quick note retains the workstation context');
      assert.equal(await js(`document.querySelector('#note-text').value`), '跨页面保留的合成草稿');
      await closeQuick();
      assert(await mainJs(`!document.querySelector('[data-page="records"]').hidden`), 'Closing quick note retains the originating library');
      await navigate('settings'); await navigate('developer');
      assert(await js(`document.querySelector('#note-action').hidden`), 'Settings maintenance pages do not offer unrelated recording actions');
      const rawFixture = '  {"level":"info","code":"OK"}\nmalformed <script>fixture</script> 中文\n';
      ipcMain.removeHandler('mote:events-raw');
      ipcMain.handle('mote:events-raw', () => rawFixture);
      await js(`document.querySelector('#events-open').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert.equal(await js(`document.querySelector('[aria-label="原始日志"]').value`), rawFixture);
      assert(await js(`document.querySelector('[aria-label="原始日志"]').readOnly`));
      await js(`Array.from(document.querySelectorAll('#events-viewer button')).find(b => b.textContent === '全选').click()`);
      assert.equal(await js(`document.querySelector('[aria-label="原始日志"]').selectionEnd`), rawFixture.length);
      await js(`Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.fixtureCopiedLog = text; } } }); Array.from(document.querySelectorAll('#events-viewer button')).find(b => b.textContent === '复制全部').click(); new Promise(resolve => setTimeout(resolve, 20))`);
      assert.equal(await js(`window.fixtureCopiedLog`), rawFixture);
      await js(`navigator.clipboard.writeText = async () => { throw new Error('synthetic denied clipboard'); }; Array.from(document.querySelectorAll('#events-viewer button')).find(b => b.textContent === '复制全部').click(); new Promise(resolve => setTimeout(resolve, 20))`);
      assert(await js(`document.querySelector('#events-viewer [role="status"]').textContent.includes('剪贴板不可用')`));
      ipcMain.removeHandler('mote:events-raw');
      ipcMain.handle('mote:events-raw', () => { throw new Error('generated read failure'); });
      await js(`document.querySelector('#events-open').click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert(await js(`document.querySelector('#events-viewer').textContent.includes('日志读取失败')`));
      assert.equal(await js(`document.querySelector('[aria-label="原始日志"]').value`), rawFixture);
      await js(`document.querySelector('#jpeg-quality').value = '10'; document.querySelector('#jpeg-quality').dispatchEvent(new Event('input', {bubbles: true}));`);
      await js(`document.querySelector('#settings').requestSubmit()`);
      assert(await js(`!document.querySelector('[data-page="capture"]').hidden && document.activeElement.id === 'jpeg-quality'`), 'Invalid field is revealed and focused');
      await js(`document.querySelector('#settings-reset').click()`);
      assert.equal(await js(`document.querySelector('#jpeg-quality').value`), String(status.config.jpegQuality));
      assert(await js(`document.querySelector('#settings-pending').hidden`));
      await navigate('connection');
      assert(await js(`document.querySelector('#note-action').hidden`), 'Connection settings remain focused on configuration');
      await js(`document.querySelector('#device-name').value = '未保存的设备名称'; document.querySelector('#device-name').dispatchEvent(new Event('input', {bubbles: true}));`);
      assert(await js(`!document.querySelector('#settings-pending').hidden`));
      await js(`window.confirm = () => false; document.querySelector('aside [data-nav="ask"]').click();`);
      assert(await js(`!document.querySelector('[data-page="connection"]').hidden && !document.querySelector('#settings-pending').hidden && document.querySelector('#device-name').value === '未保存的设备名称'`), 'Cancelling navigation preserves the settings draft and current route');
      await js(`window.confirm = () => true; document.querySelector('#workspace-back').click()`);
      assert(await js(`!document.querySelector('[data-page="settings"]').hidden`));
      assert(await js(`document.querySelector('#settings-save-bar').hidden && document.querySelector('#settings-pending').hidden`), 'Settings menu has no abandoned draft or save bar');
      await navigate('connection');
      assert.equal(await js(`document.querySelector('#device-name').value`), status.config.deviceName, 'Back navigation discards unsaved settings');
      await js(`document.querySelector('#server-url').value = 'https://discarded.example'; document.querySelector('#server-url').dispatchEvent(new Event('input', {bubbles: true}));`);
      await navigate('overview');
      assert(await js(`document.querySelector('#settings-save-bar').hidden`));
      await navigate('connection');
      assert.equal(await js(`document.querySelector('#server-url').value`), status.config.serverUrl, 'Sidebar navigation discards unsaved settings');
      await js(`document.querySelector('#device-name').value = 'Discard with Escape'; document.querySelector('#device-name').dispatchEvent(new Event('input', {bubbles: true})); document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));`);
      assert(await js(`!document.querySelector('[data-page="overview"]').hidden && document.querySelector('#settings-save-bar').hidden`), 'Escape returns to the collection page that opened this connection');
      await navigate('connection');
      assert.equal(await js(`document.querySelector('#device-name').value`), status.config.deviceName, 'Escape discards unsaved settings');
      await js(`document.querySelector('#device-name').value = 'UI Fixture Renamed'; document.querySelector('#device-name').dispatchEvent(new Event('input', {bubbles: true})); document.querySelector('#settings').requestSubmit();`);
      await settingsIdle('save connection settings');
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
      await js(`document.querySelector('#use-installed-app').click(); for(const key of ['duration','screenshots','structured']) { const input=document.querySelector('#app-collection-rules [data-channel='+key+']'); input.checked=false; input.dispatchEvent(new Event('change',{bubbles:true})); } document.querySelector('[data-mask=notification]').click()`);
      assert.equal(await js(`document.querySelectorAll('#mask-editor input[type=range]').length`), 4);
      await js(`const width = document.querySelector('[aria-label="区域 1 宽度"]'); width.value = '25'; width.dispatchEvent(new Event('input', { bubbles: true }));`);
      await js(`document.querySelectorAll('#default-collection [data-channel]').forEach(input=>input.checked=input.dataset.channel==='duration'); document.querySelector('#settings').requestSubmit()`);
      await settingsIdle('save privacy settings');
      assert.deepEqual((await js('window.mote.status()')).config.appCollectionRules['dev.mote.synthetic.private'],{duration:false,screenshots:false,structured:false},'app detail checkboxes persist the explicit all-off rule');
      await js(`document.querySelector('#gate-text').value = 'synthetic.secret'; document.querySelector('#gate-failure').value = 'hold'; document.querySelector('#settings').requestSubmit()`);
      await settingsIdle('save upload review');
      assert.deepEqual((await js('window.mote.status()')).config.uploadGate, {enabled:true,blockedText:['synthetic.secret'],failureAction:'hold'});
      await js(`document.querySelector('#review-refresh').click()`);
      await js(`new Promise(resolve=>setTimeout(resolve,100))`); assert(await js(`document.querySelector('#review-pending').textContent.includes('没有待复核记录')`));

      await navigate('capture');
      await js(`document.querySelector('#interval-preset').value = '60'; document.querySelector('#interval-preset').dispatchEvent(new Event('change', { bubbles: true }));`);
      await js(`document.querySelector('#settings').requestSubmit()`);
      await settingsIdle('save capture settings');
      await navigate('sync');
      for (const mode of ['interval', 'batch', 'manual']) {
        await js(`document.querySelector('[name=sync-mode][value=${mode}]').click()`);
        assert.equal(await js(`document.querySelector('#sync-batch-field').hidden`), mode !== 'batch');
        assert.equal(await js(`document.querySelector('#sync-interval-field').hidden`), mode === 'manual');
      }
      await js(`document.querySelector('#settings').requestSubmit();`);
      await settingsIdle('save sync settings');
      let updated;
      for (let i = 0; i < 50; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        updated = await window.webContents.executeJavaScript('window.mote.status()');
        if (updated.config.deviceName === 'UI Fixture Renamed') break;
      }
      assert.equal(updated.config.deviceName, 'UI Fixture Renamed');
      assert.equal(updated.config.syncMode, 'manual'); assert.equal(updated.config.intervalMs, 60000); assert.deepEqual(updated.config.masks, [{ x: .7, y: 0, width: .25, height: .2 }]);
      assert.equal(updated.running, false); assert.deepEqual(updated.config.defaultCollection, {duration:true,screenshots:false,structured:false}); assert.deepEqual(updated.config.appCollectionRules, { 'dev.mote.synthetic.private': {duration:false,screenshots:false,structured:false} }); assert.equal(updated.config.metadataEnabled, false);
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
      ipcMain.removeHandler('mote:coding-agents');
      ipcMain.handle('mote:coding-agents', () => [{provider:'codex',name:'合成 Codex',path:'/generated/codex',available:true}]);
      let selectedCodingAgent;
      ipcMain.removeHandler('mote:source-coding');
      ipcMain.handle('mote:source-coding', (_event, provider) => { selectedCodingAgent = provider; });
      await js(`document.querySelector('#source-agent-discover').closest('details').open=true; document.querySelector('#source-agent-discover').click(); new Promise(resolve => setTimeout(resolve, 150))`);
      assert.equal(await js(`document.querySelector('#source-agent-choice').options.length`), 1);
      await js(`document.querySelector('#source-agent-add').click(); new Promise(resolve => setTimeout(resolve, 150))`);
      assert.equal(selectedCodingAgent, 'codex', 'Explicit coding source selection reaches IPC without reading personal sessions');
      await js(`document.querySelector('#source-files').click()`);
      for(let i=0;i<100&&await js(`document.querySelector('#source-confirmation').hidden`);i++)await new Promise(resolve=>setTimeout(resolve,25));
      assert.equal((await js('window.mote.sources()')).length,0,'Native selection alone does not start collection');
      assert.equal(await js(`document.querySelector('#source-continuous').checked`),false,'File import defaults to one-time');
      assert(await js(`document.querySelector('#source-initial-sync').disabled && document.querySelector('#source-initial-sync').value==='all'`),'One-shot confirmation cannot promise future-only history');
      await js(`document.querySelector('#source-continuous').checked=true;document.querySelector('#source-continuous').dispatchEvent(new Event('change'))`);
      assert.equal(await js(`document.querySelector('#source-initial-sync').disabled`),false,'Future autosync opt-in makes history scope configurable');
      await js(`document.querySelector('#source-continuous').checked=false;document.querySelector('#source-continuous').dispatchEvent(new Event('change'))`);
      assert(await js(`document.querySelector('#source-retention').getClientRects().length>0 && document.querySelector('#source-selected-names').textContent.includes('synthetic-source.md')`),'Scope and retention visible before consent');
      writeFileSync(join(outputDirectory,'import-confirmation-ui-fixture.png'),(await window.webContents.capturePage()).toPNG());
      await js(`document.querySelector('#source-confirm').click()`);
      let sources;
      for (let i = 0; i < 100; i++) { sources = await window.webContents.executeJavaScript('window.mote.sources()'); if (sources[0]?.pending === 1) break; await new Promise(resolve => setTimeout(resolve, 50)); }
      assert.equal(sources.length, 1); assert.equal(sources[0].pending, 1); assert.equal(sources[0].source.kind, 'local-files');
      for (let i = 0; i < 100 && !await js(`document.querySelector('#sync-message').textContent.includes('共 2 条待传')`); i++) await new Promise(resolve => setTimeout(resolve, 50));
      assert(await js(`document.querySelector('#sync-message').textContent.includes('共 2 条待传')`), 'Overview includes capture/note and source backlog');
      assert(await js(`!document.querySelector('[data-page=records]').hidden`),'A one-time import returns to Content');
      await navigate('sources');
      assert.equal(await js(`document.querySelectorAll('#source-list .source-card').length`),0,'One-time imports remain Content rather than active Sources');
      assert(await window.webContents.executeJavaScript('Boolean(document.querySelector("#source-calendar-connect"))'));
      ipcMain.removeHandler('mote:sources');
      ipcMain.handle('mote:sources',()=>[{...sources[0],source:{...sources[0].source,syncContinuously:true},pending:0,blocked:1,failures:[{externalId:'generated-blocked',title:'Generated <script>blocked</script>.txt',status:410}]}]);
      await navigate('overview');await navigate('sources');
      for(let i=0;i<100&&!await js(`!!document.querySelector('.source-failures')`);i++)await new Promise(resolve=>setTimeout(resolve,50));
      assert(await js(`document.querySelector('.source-failures')?.textContent.includes('本机待处理 1 项')&&document.querySelector('.source-failures')?.textContent.includes('中央已删除此文件')`),'A rejected file remains visible independently of the active queue');
      assert.equal(await js(`document.querySelectorAll('.source-failures script').length`),0,'Untrusted filenames remain text');
      assert(!errors.some(message => !message.includes('Electron Security Warning')), errors.join('\n'));
      await navigate('overview');
      for(let i=0;i<100&&!await js(`document.querySelector('#home-recent .content-row')`);i++)await new Promise(resolve=>setTimeout(resolve,25));
      writeFileSync(output, (await window.webContents.capturePage()).toPNG());
      await navigate('settings');
      writeFileSync(join(require('node:path').dirname(output), 'settings-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await navigate('sync');
      writeFileSync(join(require('node:path').dirname(output), 'sync-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await navigate('capture');
      writeFileSync(join(require('node:path').dirname(output), 'capture-settings-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await navigate('notes');
      writeFileSync(join(require('node:path').dirname(output), 'notes-ui-fixture.png'), (await (quick()||window).webContents.capturePage()).toPNG());
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
      await navigate('capture');await navigate('compression');
      for(let i=0;i<200&&await js(`document.querySelector('#compression-apply').disabled`);i++)await new Promise(resolve=>setTimeout(resolve,30));
      assert(await js(`document.querySelector('#compression-stats').textContent.includes('文件大小为原图的')`));
      await js(`document.querySelector('#compression-zoom').value='2';document.querySelector('#compression-zoom').dispatchEvent(new Event('change'))`);
      assert.equal(await js(`document.querySelector('#compression-after').style.width`),'5120px');
      await js(`document.querySelector('#compression-zoom').value='fit';document.querySelector('#compression-zoom').dispatchEvent(new Event('change'))`);
      writeFileSync(join(require('node:path').dirname(output), 'compression-preview-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      await js(`document.querySelector('#compression-apply').click()`);
      assert(await js(`!document.querySelector('#settings-pending').hidden`));
      await navigate('overview');
      // Exercise a real generated queue import and the normal content reader.
      // This is a durable regression for long English provenance-gutter labels;
      // the notification observer remains synthetic and no system permission is used.
      const notificationAt = new Date(Date.now() - 1000).toISOString();
      const notificationId = randomUUID();
      const notificationArchive = join(profile, 'generated-notification-archive.json');
      const notificationOriginal = 'Generated notification original; never a personal notification.';
      writeFileSync(notificationArchive, JSON.stringify({format:'mote-desktop-queue',version:4,blobs:{},records:[{
        event:{id:notificationId,deviceId:status.config.deviceId,deviceName:'Generated_Notification_Source_'+ 'x'.repeat(96),platform:'macos',capturedAt:notificationAt,
          durationMs:0,appId:'dev.mote.generated.notification',appName:'Generated notification',ocrText:'',source:'notification',
          privacy:{excluded:false,redacted:false,mode:'none',collection:'content'},
          metadata:{version:1,observedAt:notificationAt,collector:{method:'accessibility'},observation:{sessionId:notificationId,elapsedRealtimeMs:1},
            notification:{action:'posted',notificationKey:'ab'.repeat(32),postedAt:notificationAt,ongoing:false,groupSummary:false,text:notificationOriginal}}},
        blobBytes:0,attempts:0,nextAttemptAt:0
      }]}), {mode:0o600});
      const beforeMixPicker = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => ({canceled:false,filePaths:[notificationArchive]});
      try { assert.equal((await js('window.mote.importQueue()')).imported,1); }
      finally { dialog.showOpenDialog = beforeMixPicker; }
      const changeFixtureLanguage = async preference => {
        await navigate('settings');
        await js(`window.confirm=()=>true;document.querySelector('#language').value=${JSON.stringify(preference)};document.querySelector('#language').dispatchEvent(new Event('change'));true;`);
        for (let i=0;i<200;i++) {
          try { if (await js(`document.documentElement.lang===${JSON.stringify(preference)} && !!document.querySelector('#content-refresh') && document.querySelector('#workspace-location').textContent.trim()`)) break; }
          catch { /* Reload temporarily destroys the frame; wait for the new renderer. */ }
          await new Promise(resolve=>setTimeout(resolve,25));
        }
        assert.equal(await js('document.documentElement.lang'),preference);
        // Locale reload restores the default Content entry; its content loads normally.
        await new Promise(resolve=>setTimeout(resolve,100));
      };
      await changeFixtureLanguage('en');
      await navigate('notes');
      const switchedLanguageNote = 'Generated language-switch note; personal content is never used.';
      await js(`document.querySelector('#note-text').value=${JSON.stringify(switchedLanguageNote)};document.querySelector('#note-text').dispatchEvent(new Event('input'));document.querySelector('#note-form').requestSubmit();true;`);
      for(let i=0;i<200&&quick();i++)await new Promise(resolve=>setTimeout(resolve,25));
      assert.equal(quick(),undefined,'Save success closes the quick editor');
      await navigate('notes');assert.equal(await js(`document.querySelector('#note-text').value`),'','Saved note is not resurrected on reopen');await closeQuick();
      assert.equal((await js('window.mote.status()')).operations.find(job=>job.id==='mote:note')?.message,'Saving quick note · Operation finished','Main-process operation labels follow the changed language');
      window.setSize(820,620); await navigate('records');
      await js(`document.querySelector('#content-refresh').click();true;`);
      for(let i=0;i<200&&!await js(`!!document.querySelector('#content-feed [data-content-key="queue:${notificationId}"]')`);i++)await new Promise(resolve=>setTimeout(resolve,25));
      assert(await js(`(() => {
        const rows=Array.from(document.querySelectorAll('#content-feed .content-row'));
        if(!rows.some(row=>row.querySelector('.content-type').textContent==='Notifications') || !rows.some(row=>row.querySelector('.content-type').textContent==='Quick notes') || !rows.some(row=>row.querySelector('.content-type').textContent==='File')) return false;
        return rows.every(row=>['.content-type','.content-state','.content-row-copy small'].every(selector=>{const element=row.querySelector(selector),bounds=element.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(element);const rects=Array.from(range.getClientRects());
          return element.scrollWidth<=element.clientWidth && rects.every(rect=>rect.left>=bounds.left-.5 && rect.right<=bounds.right+.5) && (selector==='.content-row-copy small'||rects.length>0&&Math.max(...rects.map(rect=>rect.top))-Math.min(...rects.map(rect=>rect.top))<1);
        }));
      })()`),'Actual mixed-source records keep English types and long unbroken source metadata inside their narrow columns');
      assert(await js(`document.documentElement.scrollWidth<=innerWidth`),'Mixed-source content has no horizontal overflow');
      writeFileSync(join(outputDirectory,'mixed-source-content-en-compact.png'),(await window.webContents.capturePage()).toPNG());
      await js(`document.querySelector('#content-feed [data-content-key="queue:${notificationId}"]').click();true;`);
      for(let i=0;i<200&&!await js(`document.querySelector('#content-detail-body').textContent===${JSON.stringify(notificationOriginal)}`);i++)await new Promise(resolve=>setTimeout(resolve,25));
      assert.equal(await js(`document.querySelector('#content-detail-body').textContent`),notificationOriginal,'The real imported notification original remains readable');
      assert.equal(await js(`document.querySelector('#content-detail-close').textContent`),'Close details','Reader dismissal is an action, not the Off state translation');
      await js(`document.querySelector('#content-detail-close').click();true;`);
      await changeFixtureLanguage('zh-CN'); window.setSize(1140,840); await navigate('overview');
      const generatedJpeg = nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 160), { width: 64, height: 64 }).toJPEG(75);
      const hash = imageHash(generatedJpeg), day = new Date(), fixtureRecords = [];
      for (let index = 0; index < 31; index++) fixtureRecords.push({ event: { id: randomUUID(), deviceId: status.config.deviceId, deviceName: '合成截图设备', platform: 'macos', capturedAt: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12, 0, index).toISOString(), durationMs: 0, appId: 'dev.mote.fixture', appName: '合成截图', imageMime: 'image/jpeg', ocrText: '合成 OCR <script>不可执行的证据</script>', ocr: { status: 'completed' }, source: 'screen', privacy: { excluded: false, redacted: false, mode: 'local', reason: 'generated fixture only' } }, blobHash: hash, blobBytes: generatedJpeg.length, attempts: 0, nextAttemptAt: 0 });
      const fixtureArchive = join(profile, 'generated-records.json');
      writeFileSync(fixtureArchive, JSON.stringify({ format: 'mote-desktop-queue', version:4, records: fixtureRecords, blobs: { [hash]: generatedJpeg.toString('base64') } }));
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixtureArchive] });
      assert.equal((await js('window.mote.importQueue()')).imported, 31);
      const captureBrowser = require('../dist/capture-browser');
      const originalCaptureImage = captureBrowser.captureImage;
      let releaseThumbnails;
      const thumbnailsReady = new Promise(resolve => { releaseThumbnails = resolve; });
      captureBrowser.captureImage = async (...args) => { if (args[4]) await thumbnailsReady; return originalCaptureImage(...args); };
      try {
        await navigate('records');
        await js(`document.querySelector('#capture-library-tools').open=true`);
        await recordsIdle('sessions metadata only');
        assert.equal(await js(`document.querySelectorAll('.record-session').length`),1);
        assert.equal(await js(`document.querySelectorAll('.record-card').length`),0);
        writeFileSync(join(require('node:path').dirname(output), 'capture-sessions-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
        await js(`document.querySelector('.record-session').click()`);
        for (let i = 0; i < 100 && await js(`document.querySelectorAll('.record-card').length !== 30`); i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(await js(`document.querySelectorAll('.record-card').length`), 30);
        assert(await js(`document.querySelector('#records-status').getAttribute('aria-busy') === 'true'`), 'Cards appear while generated thumbnails are still loading');
        releaseThumbnails();
        await recordsIdle('first capture page thumbnails');
        assert(await js(`document.querySelector('#records-status').textContent.includes('31')`));
      } finally { releaseThumbnails(); captureBrowser.captureImage = originalCaptureImage; }
      await js(`document.querySelector('#records-next').click()`);
      for (let i = 0; i < 100 && await js(`document.querySelectorAll('.record-card').length !== 1`); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(await js(`document.querySelectorAll('.record-card').length`), 1);
      await recordsIdle('second capture page thumbnails');
      await js(`document.querySelector('.record-card').click()`);
      for (let i = 0; i < 100 && await js(`!document.querySelector('#record-detail-image').src.startsWith('data:image/jpeg')`); i++) await new Promise(resolve => setTimeout(resolve, 20));
      assert(await js(`document.querySelector('#record-detail-text').textContent.includes('<script>不可执行的证据</script>')`));
      assert(await js(`document.querySelector('#record-detail-image').src.startsWith('data:image/jpeg')`));
      assert(await js(`document.querySelector('#record-detail-text script') === null`));
      assert(await js(`document.querySelector('.record-card.selected').getAttribute('aria-pressed') === 'true'`), 'Chosen record remains visible as selected beside its detail');
      await js(`document.querySelector('#record-detail-close').click()`);
      assert(await js(`document.querySelector('#record-detail').hidden && document.activeElement.matches('.record-card')`), 'Closing details restores focus to the selected record');
      await js(`document.activeElement.click(); new Promise(resolve => setTimeout(resolve, 100))`);
      assert(await js(`document.documentElement.scrollWidth <= window.innerWidth`), 'Record detail fits the minimum window width');
      writeFileSync(join(require('node:path').dirname(output), 'capture-records-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
      window.setSize(1280, 860);
      await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      assert(await js(`(() => { const list = document.querySelector('#records-grid').getBoundingClientRect(), detail = document.querySelector('#record-detail').getBoundingClientRect(); return list.right < detail.left && detail.width > 280; })()`), 'Wide window keeps the selected record and its detail side by side');
      writeFileSync(join(outputDirectory, 'capture-records-wide-ui-fixture.png'), (await window.webContents.capturePage()).toPNG());
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
      const originalMigration = QueueStorage.prototype.migrate;
      QueueStorage.prototype.migrate = async function(...args) {
        const result = await originalMigration.apply(this, args);
        // The active directory can change before configure finishes. Make that interval deterministic
        // so the fixture must wait for the UI to enable the next action, including on fast local disks.
        await new Promise(resolve => setTimeout(resolve, 500));
        return result;
      };
      try {
        const oldStatus = await js('window.mote.status()');
        const rejected = await js(`window.mote.configure({...(${JSON.stringify(oldStatus.config)}),captureStorageDirectory:${JSON.stringify(join(external, 'unauthorized'))}}).then(()=>false, error=>error.message.includes('选择器'))`);
        assert(rejected, 'Renderer cannot submit arbitrary filesystem paths');
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [external] });
        await navigate('capture');
        await js(`document.querySelector('#capture-directory-choose').click()`);
        await settingsIdle('choose capture directory');
        assert(await js(`document.querySelector('#capture-directory').value.includes('Mote-Captures-')`));
        assert(await js(`document.querySelector('#capture-directory').readOnly`));
        const selected = await js(`document.querySelector('#capture-directory').value`);
        await js(`document.querySelector('#settings').requestSubmit()`);
        await settingsIdle('move capture directory');
        const moved = await js('window.mote.status()');
        assert.equal(moved.storage.directory, selected); assert.equal(moved.config.captureStorageDirectory, selected);
        assert.equal(moved.running, false); assert.equal(moved.queueDepth, oldStatus.queueDepth); assert.equal(moved.config.deviceId, oldStatus.config.deviceId);
        await assert.rejects(stat(oldStatus.storage.directory), {code:'ENOENT'});
        assert.equal(JSON.parse(await readFile(join(profile, 'config.json'),'utf8')).config.captureStorageDirectory, selected);
        await js(`document.querySelector('#capture-directory-default').click(); document.querySelector('#settings').requestSubmit()`);
        await settingsIdle('restore default capture directory');
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
          await navigate('screen'); assert(await js(`!document.querySelector('#storage-restart').hidden`));
        } finally { ConfigStore.prototype.save = originalSave; }
      } finally { QueueStorage.prototype.migrate = originalMigration; await rm(external, { recursive: true, force: true }); }
      process.stdout.write(JSON.stringify({ slowMigrationWaitsForSettingsCompletion: true, failedSettingsRolledBack: true, ambiguousCommitPreservesBothAndBlocksWrites: true, captureStorageNativePickerAndMigration: true, arbitraryStoragePathRejected: true, captureBrowserPagingAndOcrDetails: true, chargingOcrSettingSaved: true, feedbackLink: true, localOnlyStartIpcStub: true, uploadModeControls: true, installedAppPickerFixture: true, maskPresetsAndSlider: true, friendlyPresetsSaved: true, localBacklogConsent: true, navigationAndKeyboardFocus: true, actionFirstNavigation: true, sharedAddChooser: true, oneTimeFileConfirmation: true, screenScopeConfirmation: true, contextualReturnPaths: true, standaloneQuickNoteRetainsWorkstation: true, settingsDraftProtectedOnNavigationCancel: true, nativeSettingsMenu: true, settingsEditableWhileCapturing: true, noteDraftRetainedAcrossWindows: true, settingsDiscardedOnBackSidebarAndEscape: true, settingsMenuHasNoSaveBar: true, invalidSettingsRevealed: true, discardSettings: true, oneTimeImportOpensContent: true, minimumWindowLayout: true, gradedCollectionUiAndIpc: true, metadataDisabled: true, updatesUiAndChannelIpc: true, noUpdateNetworkRequest: true, ok: true, fixtureOnly: true, rendererLoaded: true, preloadIpc: true, savedSettings: true, offlineNotePersisted: true, captureStayedStopped: true, nativeFilePickerAndOfflineSource: true, calendarPermissionNotRequested: true, screenshot: output }) + '\n');
      finished = true; clearTimeout(timeout); app.quit();
    })().catch(error => { process.stderr.write(`UI smoke failed in ${currentPhase}: ${error.message}\n${errors.join('\n')}\n`); app.exit(1); });
  });
});
app.on('quit', () => { if (finished || process.env.MOTE_UI_REVIEW === '1') void rm(profile, { recursive: true, force: true }); });
// The fixture always runs in the background, including independent review. Patch only
// the fixture's Electron dependency, so production window behavior stays unchanged.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  const result = originalLoad.call(this, request, parent, isMain);
  if (process.env.MOTE_UI_ROLLOUT_DEV_ABOUT === '1' && request === '../package.json' && parent?.filename === join(__dirname, '../dist/main.js')) return { ...result, moteDevelopment: true };
  if (request !== 'electron') return result;
  return { ...result, BrowserWindow: class extends result.BrowserWindow {
    constructor(options) { super({ ...options, show: false }); }
    show() {}
    focus() {}
  } };
};
require('../dist/main');
