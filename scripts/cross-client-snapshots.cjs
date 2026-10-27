require('./fixture-background.cjs');
require('./fixture-language.cjs');
/** Manual visual check: the same owner scenes from Web, Mac and (optionally) Android side by side.
 * Generated data and private temporary profiles only; no model, personal capture or network beyond loopback. */
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, relative } = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const net = require('node:net');
const assert = require('node:assert/strict');

const repo = resolve(__dirname, '..'), root = mkdtempSync(join(tmpdir(), 'mote-cross-client-')), out = join(repo, '.mote/cross-client');
const androidArgument = process.argv.indexOf('--android'), androidDirectory = androidArgument > 0 ? resolve(process.argv[androidArgument + 1] ?? '') : undefined;
// Scene ids are the shared primary destinations plus settings; each client contributes its own route or fixture file.
const scenes = [
  { id: 'home', label: '首页', web: 'today', desktop: 'ui-fixture.png' },
  { id: 'library', label: '资料库', web: 'library', desktop: 'capture-records-ui-fixture.png' },
  { id: 'sources', label: '来源', web: 'connections', desktop: 'source-ui-fixture.png' },
  { id: 'ask', label: '问一问', web: 'ask' },
  { id: 'settings', label: '设置', web: 'preferences', desktop: 'settings-ui-fixture.png' },
];
const viewports = [{ id: 'wide', width: 1360, height: 900 }, { id: 'phone', width: 390, height: 844 }];
// A 1x1 generated PNG keeps fixture captures valid without any screen content.
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let server, stderr = '';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { const end = Date.now() + 30000; while (Date.now() < end) { if (server?.exitCode != null) throw Error('Generated server exited: ' + stderr); if (await fn()) return; await delay(80); } throw Error('Timed out: ' + label); }

for (const file of ['apps/server/dist/index.js', 'apps/web/dist/index.html', 'apps/desktop/dist/main.js'])
  assert.ok(existsSync(join(repo, file)), `Missing ${file}; run npm run build first`);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'web'), { recursive: true, mode: 0o700 });
app.setPath('userData', join(root, 'browser'));
app.on('window-all-closed', () => {});

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
  const window = new BrowserWindow({ width: 1360, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = window.webContents, js = code => wc.executeJavaScript(code);
  const browser = await request('/api/login/session', { serverUrl: base, deviceId: randomUUID(), deviceName: 'Generated UI browser', platform: 'other', durationMs: 0 });
  await window.loadURL(base);
  await js(`sessionStorage.setItem('mote.connection',${JSON.stringify(JSON.stringify({ token: browser.token, viewScope: randomUUID() }))});location.reload()`);
  await until(() => js(`!!document.querySelector('[data-session="ready"]')`), 'web session');
  for (const viewport of viewports) {
    window.setSize(viewport.width, viewport.height);
    for (const scene of scenes) {
      await js(`location.hash='#/${scene.web}'`);
      await until(() => js(`!!document.querySelector('.content h1')`), scene.id + ' ' + viewport.id);
      // Resources load after the heading; a short settle keeps loading placeholders out of the sheet.
      await delay(800);
      writeFileSync(join(out, 'web', `${scene.id}-${viewport.id}.png`), (await wc.capturePage()).toPNG());
    }
  }
  window.destroy();
  server.kill();
}

function captureDesktop() {
  // The Mac fixture owns its generated profile and writes every scene it renders next to this path.
  const target = join(out, 'desktop', 'ui-fixture.png');
  mkdirSync(join(out, 'desktop'), { recursive: true, mode: 0o700 });
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['scripts/ui-smoke.cjs'], { cwd: join(repo, 'apps/desktop'), env: { ...process.env, MOTE_UI_SCREENSHOT: target }, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = ''; child.stderr.on('data', chunk => { log = (log + chunk).slice(-8000); });
    child.on('exit', code => code === 0 ? done() : fail(Error('Mac fixture failed: ' + log)));
  });
}

function writeSheet() {
  mkdirSync(join(out, 'android'), { recursive: true, mode: 0o700 });
  const cell = path => path && existsSync(join(out, path)) ? `<a href="${path}"><img src="${path}" alt=""></a>` : '<span class="missing">未提供</span>';
  const rows = scenes.map(scene => {
    const android = androidDirectory && existsSync(join(androidDirectory, scene.id + '.png')) ? (copyFileSync(join(androidDirectory, scene.id + '.png'), join(out, 'android', scene.id + '.png')), `android/${scene.id}.png`) : undefined;
    return `<tr><th>${scene.label}</th><td>${cell(`web/${scene.id}-wide.png`)}</td><td>${cell(scene.desktop && `desktop/${scene.desktop}`)}</td><td class="phone">${cell(`web/${scene.id}-phone.png`)}</td><td class="phone">${cell(android)}</td></tr>`;
  }).join('\n');
  writeFileSync(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Mote 三端对照</title><style>body{font:14px -apple-system,sans-serif;margin:24px;background:#f7f5f1;color:#292623}table{border-collapse:collapse}th,td{border:1px solid #d8d2c9;padding:8px;vertical-align:top;background:#fffdf9}th{text-align:left;white-space:nowrap}img{display:block;width:420px}td.phone img{width:180px}.missing{color:#6b625b}</style><h1>Mote 三端对照</h1><p>生成数据，仅供人工比对。Android 列来自 --android 目录中的 home/library/sources/ask/settings.png。</p><table><tr><th></th><th>Web 宽屏</th><th>Mac</th><th>Web 手机</th><th>Android</th></tr>${rows}</table>`);
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    await captureWeb();
    await captureDesktop();
    writeSheet();
    process.stdout.write(JSON.stringify({ ok: true, fixtureOnly: true, physicalDevice: false, liveModels: false, sheet: relative(repo, join(out, 'index.html')) }) + '\n');
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error) + '\n');
    server?.kill();
    code = 1;
  }
  rmSync(root, { recursive: true, force: true });
  app.exit(code);
});
