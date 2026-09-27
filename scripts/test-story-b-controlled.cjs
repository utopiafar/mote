/** Offscreen visual/readability check for the generated Story B capture pages. No product services. */
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parseArgs } = require('node:util');

const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) throw Error('Pass --out with a private output directory');
const output = resolve(values.out);
const fixture = join(__dirname, 'fixtures/story-b-controlled');
const scratch = mkdtempSync(join(tmpdir(), 'mote-story-b-pages-'));
mkdirSync(output, { recursive: true, mode: 0o700 });
chmodSync(output, 0o700);
app.setPath('userData', join(scratch, 'userData'));
app.on('window-all-closed', () => {});

const report = {
  status: 'running',
  generatedFixtureOnly: true,
  productModelCalls: 0,
  productCaptureRuns: 0,
  physicalDeviceTested: false,
  fixtureHashes: Object.fromEntries(['index.html', 'long.html', 'revision.html', 'styles.css'].map(name => [
    name, createHash('sha256').update(readFileSync(join(fixture, name))).digest('hex'),
  ])),
  checks: [],
  screenshots: [],
  unexpectedRequests: [],
};
const windows = [];
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms));

function check(name, condition, detail) {
  const pass = Boolean(condition);
  report.checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
  assert.ok(pass, `${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
}

async function measure(window, label) {
  const state = await window.webContents.executeJavaScript(`(() => {
    const badge = document.querySelector('.fixture-badge');
    const main = document.querySelector('main');
    return {
      title: document.title,
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      badgeVisible: !!badge && badge.getBoundingClientRect().width > 0,
      generatedBadge: badge?.textContent.includes('非真实用户经历'),
      mainReadable: !!main && getComputedStyle(main).fontSize !== '0px' && main.getBoundingClientRect().width > 280,
      remoteResources: performance.getEntriesByType('resource').filter(entry => /^https?:/i.test(entry.name)).map(entry => entry.name),
    };
  })()`);
  check(`${label}: no horizontal overflow`, state.scrollWidth <= state.width, state);
  check(`${label}: generated label and readable main`, state.badgeVisible && state.generatedBadge && state.mainReadable);
  check(`${label}: no remote resources`, state.remoteResources.length === 0, state.remoteResources);
  return state;
}

async function capture(window, name) {
  await pause(140);
  const file = join(output, `${name}.png`);
  writeFileSync(file, (await window.webContents.capturePage()).toPNG(), { mode: 0o600 });
  report.screenshots.push({ name, file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') });
}

async function navigate(window, selector) {
  const finished = new Promise((resolveFinished, rejectFinished) => {
    window.webContents.once('did-finish-load', resolveFinished);
    window.webContents.once('did-fail-load', (_event, code, description) => rejectFinished(Error(`${code}: ${description}`)));
  });
  const found = await window.webContents.executeJavaScript(`(() => {
    const link = document.querySelector(${JSON.stringify(selector)});
    if (!link) return false;
    link.click();
    return true;
  })()`);
  assert.ok(found, `Missing link: ${selector}`);
  await finished;
  check(`navigation through ${selector}`, await window.webContents.executeJavaScript('document.readyState === "complete"'));
}

async function runViewport({ name, width, height }) {
  const window = new BrowserWindow({
    width, height, show: false,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  windows.push(window);
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    report.unexpectedRequests.push(details.url);
    callback({ cancel: true });
  });
  await window.loadFile(join(fixture, 'index.html'));
  await measure(window, `${name} layout`);
  check(`${name}: layout paths and independent labels`, await window.webContents.executeJavaScript(`
    !!document.querySelector('#path-a') && !!document.querySelector('#path-b') &&
    document.querySelector('#layout-diagram').getBoundingClientRect().width >= 280 &&
    document.querySelector('#layout-diagram').textContent.includes('第三方观察') &&
    document.querySelector('#layout-diagram').textContent.includes('方格图')
  `));
  await capture(window, `${name}-layout-top`);
  await window.webContents.executeJavaScript(`document.querySelector('#layout-diagram').scrollIntoView({ block: 'center', behavior: 'instant' })`);
  check(`${name}: full diagram fits viewport`, await window.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('#layout-diagram').getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
  })()`));
  await capture(window, `${name}-layout-diagram`);

  await navigate(window, 'a[href="long.html"]');
  const longMetrics = await measure(window, `${name} long`);
  check(`${name}: long document spans three screens`, longMetrics.scrollHeight >= longMetrics.height * 2.75, longMetrics);
  check(`${name}: premise, exception, tail in order`, await window.webContents.executeJavaScript(`(() => {
    const ids = ['long-premise', 'long-exception', 'long-tail'];
    const nodes = ids.map(id => document.getElementById(id));
    return nodes.every(Boolean) && nodes[0].offsetTop < nodes[1].offsetTop && nodes[1].offsetTop < nodes[2].offsetTop &&
      nodes[0].textContent.includes('登记名单') && nodes[1].textContent.includes('交付状态') && nodes[2].textContent.includes('待签收');
  })()`));
  await capture(window, `${name}-long-premise`);
  for (const [section, suffix] of [['#long-exception', 'exception'], ['#long-tail-sentinel', 'tail']]) {
    await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(section)}).scrollIntoView({ block: 'center', behavior: 'instant' })`);
    check(`${name}: ${suffix} reachable and visible`, await window.webContents.executeJavaScript(`(() => {
      const r = document.querySelector(${JSON.stringify(section)}).getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    })()`));
    await capture(window, `${name}-long-${suffix}`);
  }

  await navigate(window, 'a[href="revision.html?v=1"]');
  await measure(window, `${name} revision v1`);
  check(`${name}: old version visible`, await window.webContents.executeJavaScript(`
    document.body.dataset.version === '1' &&
    document.getElementById('version-one').getClientRects().length > 0 &&
    document.getElementById('version-two').getClientRects().length === 0 &&
    document.getElementById('version-one').textContent.includes('周三 14:00')
  `));
  await capture(window, `${name}-revision-v1`);
  await navigate(window, '#revision-new');
  await measure(window, `${name} revision v2`);
  check(`${name}: explicit correction and new version visible`, await window.webContents.executeJavaScript(`
    document.body.dataset.version === '2' &&
    document.getElementById('version-one').getClientRects().length === 0 &&
    document.getElementById('version-two').getClientRects().length > 0 &&
    document.getElementById('version-two').textContent.includes('周四 15:30') &&
    document.getElementById('correction-note').textContent.includes('显式更正')
  `));
  await capture(window, `${name}-revision-v2`);
  await navigate(window, '#revision-old');
  check(`${name}: old version remains recoverable`, await window.webContents.executeJavaScript(`
    document.body.dataset.version === '1' && document.getElementById('version-one').getClientRects().length > 0
  `));
  await navigate(window, 'a[href="index.html"]');
  check(`${name}: navigation returns to layout`, await window.webContents.executeJavaScript(`document.title.includes('布局连线卡')`));
  window.destroy();
}

(async () => {
  await app.whenReady();
  for (const viewport of [{ name: 'desktop-1180x900', width: 1180, height: 900 }, { name: 'mobile-393x852', width: 393, height: 852 }]) {
    await runViewport(viewport);
  }
  check('no unexpected network requests', report.unexpectedRequests.length === 0, report.unexpectedRequests);
  report.status = 'passed';
})().catch(error => {
  report.status = 'failed';
  report.failure = error.stack;
  process.exitCode = 1;
}).finally(() => {
  writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, report: join(output, 'report.json'), failure: report.failure }));
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  rmSync(scratch, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
