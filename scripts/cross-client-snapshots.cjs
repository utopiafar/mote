delete process.env.MOTE_TEST_SHOW_UI;
require('./fixture-background.cjs');
require('./fixture-language.cjs');
/** Manual visual check: the same owner scenes from Web, Mac and (optionally) Android side by side.
 * Generated data and private temporary profiles only; no model, personal capture or network beyond loopback. */
const { app, BrowserWindow, nativeTheme } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, rmSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, relative } = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes, randomUUID } = require('node:crypto');
const net = require('node:net');
const assert = require('node:assert/strict');
const { officialNavigation } = require('../packages/shared/dist/ui-navigation.js');

const repo = resolve(__dirname, '..');
const macArgument = process.argv.indexOf('--mac-fixture');
const root = macArgument === -1 ? mkdtempSync(join(tmpdir(), 'mote-cross-client-')) : process.env.MOTE_SNAPSHOT_ROOT;
// Optional light/dark capture: MOTE_SNAPSHOT_SCHEME keeps both sheets instead of overwriting one.
const scheme = ['light', 'dark'].includes(process.env.MOTE_SNAPSHOT_SCHEME) ? process.env.MOTE_SNAPSHOT_SCHEME : undefined;
const out = join(repo, '.mote/cross-client' + (scheme ? '-' + scheme : ''));
const androidArgument = process.argv.indexOf('--android'), androidDirectory = androidArgument > 0 ? resolve(process.argv[androidArgument + 1] ?? '') : undefined;
const viewports = [{ id: 'wide', width: 1360, height: 900 }, { id: 'phone', width: 390, height: 844 }];
// A 1x1 generated PNG keeps fixture captures valid without any screen content.
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let server, stderr = '';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { const end = Date.now() + 30000; while (Date.now() < end) { if (server?.exitCode != null) throw Error('Generated server exited: ' + stderr); if (await fn()) return; await delay(80); } throw Error('Timed out: ' + label); }

async function showDestination(window, id) {
  const js = code => window.webContents.executeJavaScript(code);
  const selector = `[data-nav-item="${id}"]`;
  await until(() => js(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), id + ' navigation');
  await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const active = JSON.stringify(`${selector}[aria-current="page"]`);
  await until(() => js(`Boolean(document.querySelector(${active}) && document.querySelector('main')?.textContent.trim())`), id + ' content');
  // Page resources settle after the active navigation state updates.
  await delay(500);
}

async function captureWeb() {
  const port = await new Promise(done => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const value = socket.address().port; socket.close(() => done(value)); }); });
  const base = 'http://127.0.0.1:' + port, token = randomBytes(32).toString('hex'), configFile = join(root, 'mote.yaml');
  writeFileSync(configFile, JSON.stringify({ version: 1, revision: 0, server: { profile: 'test', host: '127.0.0.1', port, token }, storage: { dataDir: join(root, 'data') } }), { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MOTE_')));
  server = spawn('node', [join(repo, 'apps/server/dist/index.js')], { cwd: repo, env: { ...env, MOTE_CONFIG_FILE: configFile }, stdio: ['ignore', 'ignore', 'pipe'] });
  server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  await until(async () => { try { return (await fetch(base + '/api/health')).ok; } catch { return false; } }, 'server startup');
  const request = async (path, body) => { const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); assert.ok(response.ok, path + ' ' + response.status); return response.json(); };
  for (let index = 0; index < 6; index++) {
    const mobile = index % 2 === 1;
    await request('/api/captures', { id: randomUUID(), deviceId: mobile ? 'generated-android' : 'generated-mac', deviceName: mobile ? 'Generated Android' : 'Generated Mac', platform: mobile ? 'android' : 'macos', capturedAt: new Date(Date.now() - (6 - index) * 60000).toISOString(), durationMs: 15000, appName: 'Generated fixture', appId: 'fixture.generated', windowTitle: 'Generated cross-client record ' + (index + 1), ocrText: 'Generated text for the cross-client visual check only.', imageBase64: pixel, imageMime: 'image/png', source: 'screen', privacy: { excluded: false, redacted: false, mode: 'local' } });
  }
  // One normal device (no dot) and one needing permission (amber dot) make the
  // shared capture-status mapping visible in the device-list scene.
  await request('/api/devices/heartbeat', { deviceId: 'generated-mac', deviceName: 'Generated Mac', platform: 'macos', status: 'capturing', queueDepth: 12, lastCaptureAt: new Date().toISOString(), sync: { mode: 'manual', state: 'idle', intervalMinutes: 1, batchSize: 100, pendingRecords: 12 } });
  await request('/api/devices/heartbeat', { deviceId: 'generated-android', deviceName: 'Generated Android', platform: 'android', status: 'permission_required', queueDepth: 0 });
  const window = new BrowserWindow({ width: 1360, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'cross-client-fixture' } });
  const wc = window.webContents, js = code => wc.executeJavaScript(code);
  const browser = await request('/api/login/session', { serverUrl: base, deviceId: randomUUID(), deviceName: 'Generated UI browser', platform: 'other', durationMs: 0 });
  await window.loadURL(base);
  await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({ token: browser.token, viewScope: randomUUID() }))});location.reload()`);
  await until(() => js(`!!document.querySelector('[data-session="ready"]')`), 'web session');
  for (const viewport of viewports) {
    window.setSize(viewport.width, viewport.height);
    for (const scene of officialNavigation) {
      await showDestination(window, scene.id);
      writeFileSync(join(out, 'web', `${scene.id}-${viewport.id}.png`), (await wc.capturePage()).toPNG());
    }
  }
  window.destroy();
  return { base, token };
}

function captureDesktop({ base, token }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('MOTE_')));
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [__filename, '--mac-fixture'], {
      cwd: repo, env: { ...env, MOTE_SNAPSHOT_ROOT: root, MOTE_SNAPSHOT_SCHEME: scheme ?? '', MOTE_PROFILE: 'dev', MOTE_URL: base, MOTE_TOKEN: token },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let log = ''; child.stderr.on('data', chunk => { log = (log + chunk).slice(-8000); });
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(Error('Mac fixture failed: ' + log)));
  });
}

function startMacFixture() {
  const origin = new URL(process.env.MOTE_URL);
  assert.equal(origin.hostname, '127.0.0.1');
  assert.ok(process.env.MOTE_TOKEN && existsSync(root), 'The generated parent fixture must provide its token and profile directory');
  app.setPath('userData', join(root, 'mac'));
  require('../apps/desktop/package.json').moteDevelopment = true;
  const directory = join(out, 'desktop');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  app.whenReady().then(async () => {
    if (scheme) nativeTheme.themeSource = scheme;
    const mainWindow = () => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith(origin.origin + '/'));
    await until(mainWindow, 'Mac Central main window');
    const window = mainWindow(), js = code => window.webContents.executeJavaScript(code);
    await until(() => js('Boolean(window.moteDesktop?.deviceId && document.querySelector("[data-nav-item=chat][aria-current=page]"))'), 'Mac default Chat and preload');
    assert.equal(window.isVisible(), false);
    for (const scene of officialNavigation) {
      await showDestination(window, scene.id);
      writeFileSync(join(directory, `${scene.id}.png`), (await window.webContents.capturePage()).toPNG());
    }
    await showDestination(window, 'library');
    await until(() => js('Boolean(document.querySelector("[data-local-device] button"))'), 'Mac local device');
    await js('document.querySelector("[data-local-device] button").click()');
    await until(() => js('Boolean(document.querySelector("[data-local-capture-sync]"))'), 'Mac capture and sync entry');
    const local = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('file:'));
    assert.ok(local, 'The local Mac window is available');
    let opened = false;
    const show = local.show.bind(local);
    local.show = () => { opened = true; show(); };
    await js('document.querySelector("[data-local-capture-sync]").click()');
    await until(async () => opened && await local.webContents.executeJavaScript(
      "document.querySelector('[data-page=capture-sync]:not([hidden])')?.getClientRects().length",
    ), 'Mac local capture and sync window');
    assert.equal(local.isVisible(), false);
    // The renderer updates the route before Chromium paints the new page.
    await local.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Mac capture and sync did not paint')), 5000);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        clearTimeout(timeout);
        resolve(true);
      }));
    })`);
    const captureSync = await local.webContents.capturePage();
    assert.ok(!captureSync.isEmpty(), 'The Mac capture and sync screenshot is not empty');
    writeFileSync(join(directory, 'capture-sync.png'), captureSync.toPNG());
    app.quit();
  }).catch(error => { console.error(error); app.exit(1); });
  require('../apps/desktop/dist/main.js');
}

function writeSheet() {
  mkdirSync(join(out, 'android'), { recursive: true, mode: 0o700 });
  const cell = path => path && existsSync(join(out, path)) ? `<a href="${path}"><img src="${path}" alt=""></a>` : '<span class="missing">未提供</span>';
  const scenes = [...officialNavigation, { id: 'capture-sync', label: '采集与同步' }];
  const rows = scenes.map(scene => {
    const android = androidDirectory && existsSync(join(androidDirectory, scene.id + '.png')) ? (copyFileSync(join(androidDirectory, scene.id + '.png'), join(out, 'android', scene.id + '.png')), `android/${scene.id}.png`) : undefined;
    return `<tr><th>${scene.label}</th><td>${cell(`web/${scene.id}-wide.png`)}</td><td>${cell(`desktop/${scene.id}.png`)}</td><td class="phone">${cell(`web/${scene.id}-phone.png`)}</td><td class="phone">${cell(android)}</td></tr>`;
  }).join('\n');
  writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Mote 三端对照</title><style>body{font:14px -apple-system,sans-serif;margin:24px;background:#f7f5f1;color:#292623}table{border-collapse:collapse}th,td{border:1px solid #d8d2c9;padding:8px;vertical-align:top;background:#fffdf9}th{text-align:left;white-space:nowrap}img{display:block;width:420px}td.phone img{width:180px}.missing{color:#6b625b}</style><h1>Mote 三端对照</h1><p>生成数据，仅供人工比对。Android 列读取 --android 目录下按入口命名的截图。</p><table><tr><th></th><th>Web 宽屏</th><th>Mac</th><th>Web 手机</th><th>Android</th></tr>${rows}</table>`);
}

async function closeFixture() {
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = once(server, 'close', { signal: AbortSignal.timeout(10000) });
    server.kill();
    await closed;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (macArgument !== -1) {
  startMacFixture();
  return;
}

for (const file of ['apps/server/dist/index.js', 'apps/web/dist/index.html', 'apps/desktop/dist/main.js'])
  assert.ok(existsSync(join(repo, file)), `Missing ${file}; run npm run build first`);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'web'), { recursive: true, mode: 0o700 });
app.setPath('userData', join(root, 'browser'));
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  if (scheme) nativeTheme.themeSource = scheme;
  let code = 0;
  try {
    const central = await captureWeb();
    await captureDesktop(central);
    writeSheet();
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n');
    code = 1;
  }
  try {
    await closeFixture();
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n');
    code = 1;
  }
  if (code === 0) process.stdout.write(JSON.stringify({ ok: true, fixtureOnly: true, physicalDevice: false, liveModels: false, sheet: relative(repo, join(out, 'index.html')) }) + '\n');
  app.exit(code);
});
