// Page snapshots always run hidden, even when other fixtures can opt into UI.
delete process.env.MOTE_TEST_SHOW_UI;
require('../../../scripts/fixture-background.cjs');
require('../../../scripts/fixture-language.cjs');

const assert = require('node:assert/strict');
const { once } = require('node:events');
const { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { readFile, realpath } = require('node:fs/promises');
const { createServer } = require('node:http');
const { tmpdir } = require('node:os');
const { extname, join, resolve, sep } = require('node:path');
const { app, BrowserWindow, nativeImage, nativeTheme } = require('electron');

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

function fixtureServer(dist, api, report) {
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
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(file)] ?? 'application/octet-stream' });
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

async function run(name) {
  assert(name && /^[\p{L}\p{N}_-]+$/u.test(name),
    'Usage: node_modules/.bin/electron apps/web/test/page-snapshots-browser.cjs <fixture>');
  const out = resolve(web, '../../.mote/page-snapshots', name);
  const report = { screenshots: [], unmatchedRequests: [], consoleErrors: [], blockedRequests: [], windowShown: false };
  let profile, server, window;
  mkdirSync(out, { recursive: true });
  try {
    for (const { file } of variants) rmSync(join(out, file), { force: true });
    const fixture = loadFixture(name);
    const dist = realpathSync(join(web, 'dist'));
    profile = mkdtempSync(join(tmpdir(), 'mote-page-snapshots-'));
    app.setPath('userData', profile);
    app.setPath('sessionData', profile);
    await app.whenReady();

    server = fixtureServer(dist, fixture.api, report);
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
