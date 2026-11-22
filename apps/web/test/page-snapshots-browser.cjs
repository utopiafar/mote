// Page snapshots always run hidden, even when other fixtures can opt into UI.
delete process.env.MOTE_TEST_SHOW_UI;
require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { readFile, realpath } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { extname, join, resolve, sep } = require('node:path');
const { app, BrowserWindow, nativeImage, nativeTheme } = require('electron');
const { pageRulesInBase, retiredPageRules, preConsolidationChatBytes } = require('./pf5-css-policy.cjs');

const web = resolve(__dirname, '..');
const wide = { width: 1440, height: 1050 };
const narrow = { width: 390, height: 844 };
const variants = ['light', 'dark'].flatMap(theme => [wide, narrow].map(size => ({
  ...size,
  theme,
  file: `${theme}-${size.width}.png`,
})));
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('no-proxy-server');
app.on('window-all-closed', () => {});

function loadFixture(name) {
  const fixture = JSON.parse(readFileSync(join(__dirname, 'page-fixtures', name + '.json'), 'utf8'));
  assert(typeof fixture?.route === 'string' && fixture.route.startsWith('#/'), 'Expected a hash route');
  assert(typeof fixture.waitFor === 'string' && fixture.waitFor.trim(), 'Expected a waitFor selector');
  assert(fixture.api && typeof fixture.api === 'object' && !Array.isArray(fixture.api), 'Expected API fixtures');
  for (const [key, value] of Object.entries(fixture.api)) {
    assert(value && Number.isInteger(value.status) && value.status >= 200 && value.status <= 599,
      `Expected an HTTP response status for ${key}`);
  }
  return fixture;
}

function fixtureServer(dist, api, report, stylesheetResponses) {
  return createServer(async (request, response) => {
    request.resume();
    response.setHeader('Cache-Control', 'no-store');
    try {
      const { pathname, search } = new URL(request.url, 'http://127.0.0.1');
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const key = `${request.method} ${pathname}`;
        const exact = key + search;
        const match = api[exact] ?? api[key];
        if (match === undefined) report.unmatchedRequests.push(exact);
        response.writeHead(match?.status ?? 404, { 'Content-Type': mimeTypes['.json'] });
        response.end(JSON.stringify(match === undefined ? { error: 'fixture_not_found' } : match.body));
        return;
      }

      const path = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      const file = await realpath(resolve(dist, '.' + path));
      if (!file.startsWith(dist + sep)) {
        response.writeHead(404).end();
        return;
      }
      const bytes = await readFile(file);
      const extension = extname(file);
      if (stylesheetResponses && extension === '.css') {
        response.once('finish', () => stylesheetResponses.push({ path: pathname, body: bytes }));
      }
      response.writeHead(200, { 'Content-Type': mimeTypes[extension] ?? 'application/octet-stream', 'Content-Length': bytes.length });
      response.end(bytes);
    } catch (error) {
      if (error instanceof URIError || ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) {
        response.writeHead(404).end();
      } else {
        report.error ??= error.message;
        response.writeHead(500).end();
      }
    }
  });
}

async function waitForPaint(contents, selector) {
  let timer;
  try {
    const ready = contents.executeJavaScript(`(async () => {
      while (!document.querySelector(${JSON.stringify(selector)})) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Let overlay scrollbars and deferred image loads settle before capture.
      await new Promise(resolve => setTimeout(resolve, 800));
      const bodyColor = getComputedStyle(document.body).backgroundColor;
      return {
        width: innerWidth,
        height: innerHeight,
        // A transparent body shows the document canvas color set on <html>.
        backgroundColor: bodyColor === 'rgba(0, 0, 0, 0)'
          ? getComputedStyle(document.documentElement).backgroundColor
          : bodyColor,
      };
    })()`);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting to paint ${selector}`)), 20_000);
    });
    return await Promise.race([ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkChatStylesheets(contents, responses, file, results) {
  const { mounted, resources } = await contents.executeJavaScript(`({
    mounted: Array.from(document.styleSheets, sheet => sheet.href)
      .filter(Boolean).map(href => new URL(href).pathname).sort(),
    resources: performance.getEntriesByType('resource')
      .filter(entry => new URL(entry.name).pathname.endsWith('.css'))
      .map(entry => ({ path: new URL(entry.name).pathname, bytes: entry.decodedBodySize })),
  })`);
  const byPath = (a, b) => a.path.localeCompare(b.path);
  const served = responses.map(({ path, body }) => ({ path, bytes: body.length })).sort(byPath);
  const bytes = served.reduce((total, response) => total + response.bytes, 0);
  const sha256 = Object.fromEntries(responses.map(({ path, body }) => [path, createHash('sha256').update(body).digest('hex')]));
  results.push({ file, served, mounted, resources, bytes, sha256 });

  assert.deepEqual(resources.sort(byPath), served, `Stylesheet response sizes for ${file}`);
  assert.deepEqual(mounted, served.map(response => response.path).sort(), `Mounted stylesheets for ${file}`);
  assert.equal(served.length, 2, `External stylesheets for ${file}`);
  const base = responses.find(response => /^\/assets\/main-[\w-]+\.css$/.test(response.path));
  assert.ok(base, `Base stylesheet for ${file}`);
  assert.ok(served.some(response => /^\/assets\/chat-page-[\w-]+\.css$/.test(response.path)), `Chat stylesheet for ${file}`);
  assert.deepEqual(pageRulesInBase(base.body.toString('utf8')), [], `Page rules in HTTP response ${base.path}`);
  assert.ok(bytes < preConsolidationChatBytes, `Chat stylesheet bytes for ${file}: ${bytes} < ${preConsolidationChatBytes}`);
}

function checkBuiltStylesheets(dist) {
  const files = readdirSync(dist, { recursive: true }).filter(file => file.endsWith('.css'));
  assert.ok(files.length, 'Expected built stylesheets');
  const found = files.flatMap(file => retiredPageRules(readFileSync(join(dist, file), 'utf8'))
    .map(rule => `${file}: ${rule}`));
  assert.deepEqual(found, [], 'Retired page selectors in built stylesheets');
  return files.length;
}

async function checkInlineStyles(contents, file) {
  const css = await contents.executeJavaScript(`Array.from(document.querySelectorAll('style'), style => style.textContent)`);
  assert.deepEqual(css.flatMap(retiredPageRules), [], `Retired page selectors in inline styles for ${file}`);
}

async function run(name) {
  assert(name && /^[\p{L}\p{N}_-]+$/u.test(name),
    'Usage: node_modules/.bin/electron apps/web/test/page-snapshots-browser.cjs <fixture>');
  const out = resolve(web, '../../.mote/page-snapshots', name);
  const report = { screenshots: [], unmatchedRequests: [], consoleErrors: [], blockedRequests: [], windowShown: false };
  const stylesheetResponses = name === 'chat' ? [] : null;
  if (stylesheetResponses) report.stylesheets = [];
  let profile, server, window;
  mkdirSync(out, { recursive: true });
  try {
    for (const { file } of variants) rmSync(join(out, file), { force: true });
    const fixture = loadFixture(name);
    const dist = realpathSync(join(web, 'dist'));
    if (stylesheetResponses) report.builtStylesheetsChecked = checkBuiltStylesheets(dist);
    profile = mkdtempSync(join(tmpdir(), 'mote-page-snapshots-'));
    app.setPath('userData', profile);
    app.setPath('sessionData', profile);
    await app.whenReady();

    server = fixtureServer(dist, fixture.api, report, stylesheetResponses);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const [route, params] = fixture.route.split('?');
    const query = new URLSearchParams(params);
    // The renderer exchanges a generated handoff code against the fixture API.
    query.set('loginTicket', '0'.repeat(43));
    const url = `${origin}/${route}?${query}`;

    window = new BrowserWindow({
      ...wide,
      show: false,
      useContentSize: true,
      webPreferences: {
        partition: 'page-snapshots',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.on('show', () => {
      report.windowShown = true;
      window.hide();
    });
    report.windowShown = window.isVisible();
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('console-message', event => {
      if (event.level === 'error') report.consoleErrors.push(event.message);
    });
    contents.session.webRequest.onBeforeRequest((details, callback) => {
      const target = new URL(details.url);
      // Inline resources can render without making a network request.
      const inline = target.protocol === 'data:' || target.protocol === 'about:' ||
        (target.protocol === 'blob:' && target.origin === origin);
      const allowed = inline || (target.protocol === 'http:' && target.origin === origin);
      if (!allowed) report.blockedRequests.push(`${details.method} ${details.url}`);
      callback({ cancel: !allowed });
    });
    contents.debugger.attach('1.3');
    for (const { file, theme, width, height } of variants) {
      // Start a renderer before emulating metrics, and load a fresh page for each variant.
      await window.loadURL('about:blank');
      if (stylesheetResponses) stylesheetResponses.length = 0;
      nativeTheme.themeSource = theme;
      window.setContentSize(width, height);
      await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: width === narrow.width,
      });
      await window.loadURL(url);
      const state = await waitForPaint(contents, fixture.waitFor);
      assert.deepEqual([state.width, state.height], [width, height], `Viewport for ${file}`);
      // Capture the emulated pixels, independent of the host display scale.
      const { data } = await contents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: false,
      });
      const png = Buffer.from(data, 'base64');
      assert.deepEqual(nativeImage.createFromBuffer(png).getSize(), { width, height }, `PNG size for ${file}`);
      writeFileSync(join(out, file), png);
      report.screenshots.push({ file, theme, ...state });
      if (stylesheetResponses) await checkChatStylesheets(contents, stylesheetResponses, file, report.stylesheets);
      await checkInlineStyles(contents, file);
    }
  } catch (error) {
    report.error ??= error.message;
    console.error(error);
  } finally {
    if (window && !window.isDestroyed()) {
      report.windowShown ||= window.isVisible();
      window.destroy();
    }
    if (server?.listening) {
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
    if (profile) rmSync(profile, { recursive: true, force: true });
  }

  report.passed = !report.error && !report.windowShown && report.screenshots.length === variants.length &&
    [report.unmatchedRequests, report.consoleErrors, report.blockedRequests].every(items => items.length === 0);
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.passed ? 'Captured page snapshots for' : 'Page snapshot checks failed for'} ${name}. See ${join(out, 'report.json')}`);
  app.exit(report.passed ? 0 : 1);
}

run(process.argv[2]).catch(error => {
  console.error(error);
  app.exit(1);
});
