require('../../../scripts/fixture-background.cjs');
const {app, BrowserWindow} = require('electron');
const {mkdtempSync, rmSync, readFileSync} = require('node:fs');
const {tmpdir} = require('node:os');
const {join, resolve} = require('node:path');
const {execFileSync} = require('node:child_process');
const {createServer} = require('node:http');
const assert = require('node:assert/strict');

const repo = resolve(__dirname, '../../..');
const temporary = mkdtempSync(join(tmpdir(), 'mote-u08b-page-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const nonce = 'nonce-' + Math.random().toString(36).slice(2);
const nonce2 = 'nonce-' + Math.random().toString(36).slice(2);
const documentKey = 'key-' + Math.random().toString(36).slice(2);
const documentKey2 = 'key-' + Math.random().toString(36).slice(2);
execFileSync(join(repo, 'node_modules/.bin/esbuild'), [
  'apps/web/test/custom-page-harness.tsx', '--bundle', '--format=iife',
  '--outfile=' + join(temporary, 'bundle.js'), '--jsx=automatic',
], {cwd: repo});

const entry = page => `<script>
addEventListener('message', event => {
  if (event.data && event.data.kind === 'channel' && event.ports[0]) {
    const port = event.ports[0], handshake = event.data;
    port.postMessage({...handshake, kind: 'request', requestId: 'initial-' + ${JSON.stringify(page)},
      method: 'read', payload: {stage: 'initial-' + ${JSON.stringify(page)}}});
    parent.postMessage({kind: 'bridge-port', page: ${JSON.stringify(page)}, handshake}, '*', [port]);
    let storage = 'available';
    try { localStorage.getItem('mote.fixtureToken'); } catch { storage = 'blocked'; }
    parent.postMessage({kind: 'security', page: ${JSON.stringify(page)}, mote: typeof window.mote,
      storage, handshakeKeys: Object.keys(handshake).sort()}, '*');
  }
  if (event.data && event.data.kind === 'navigate') location.href = '/entry2.html';
});
</script>`;
const pages = {
  '/entry1.html': entry('one'),
  '/entry3.html': entry('two'),
  '/entry2.html': `<script>let channels = 0;
    addEventListener('message', event => { if (event.data && event.data.kind === 'channel') channels++; });
    setTimeout(() => parent.postMessage({kind: 'replacement-report', channels}, '*'), 150);
    </script>`,
};

async function run() {
  const hits = {};
  const server = createServer((req, res) => {
    const path = req.url && req.url.split('?')[0];
    hits[path] = (hits[path] || 0) + 1;
    if (path === '/harness.html') {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><div id="root"></div><script>
        localStorage.setItem('mote.fixtureToken', 'generated-not-a-secret');
        window.__HARNESS__ = ${JSON.stringify({nonce, nonce2, documentKey, documentKey2, instanceId: 'inst:one'})};
        </script><script src="/bundle.js"></script>`);
      return;
    }
    if (path === '/bundle.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(readFileSync(join(temporary, 'bundle.js')));
      return;
    }
    if (!pages[path]) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'text/html');
    res.end(pages[path]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await app.whenReady();
  const window = new BrowserWindow({width: 900, height: 700, show: false,
    webPreferences: {sandbox: true, nodeIntegration: false, contextIsolation: true}});
  await window.loadURL(`http://127.0.0.1:${port}/harness.html`);
  window.webContents.on('console-message', event => console.log('[ui]', event.message.slice(0, 300)));
  const js = code => window.webContents.executeJavaScript(code);
  const until = async (fn, label) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { if (await fn()) return; await pause(80); }
    throw Error('timed out: ' + label + ' ' + JSON.stringify({hits,
      calls: await js('window.calls'), rejected: await js('window.rejected'),
      got: await js('window.got')}));
  };
  const request = (bridge, requestId, payload, extra = {}) => `(() => {
    const b = window.bridges[${bridge}];
    b.port.postMessage({...b.data.handshake, kind: 'request', requestId: ${JSON.stringify(requestId)},
      method: 'read', payload: ${JSON.stringify(payload)}, ...${JSON.stringify(extra)}});
  })()`;

  await until(() => js('window.bridges.length === 1 && window.calls.length === 1'), 'first browser RPC');
  assert.equal(await js('typeof window.mote'), 'undefined', 'the browser host has no window.mote API');
  assert.equal(await js('window.channelsCreated'), 1, 'the first document received exactly one channel');
  const firstSecurity = (await js('window.got')).find(message => message.kind === 'security' && message.page === 'one');
  assert.deepEqual(firstSecurity, {kind: 'security', page: 'one', mote: 'undefined', storage: 'blocked',
    handshakeKeys: ['contractVersion', 'documentKey', 'generation', 'instanceId', 'kind', 'nonce']},
  'the opaque frame has no host API or stored token and the handshake carries only RPC identity');

  await js(`(() => {
    const h = window.bridges[0].data.handshake;
    window.postMessage({...h, kind: 'request', requestId: 'wrong-source', method: 'read',
      payload: {attack: 'wrong-source'}}, '*');
  })()`);
  await js(request(0, 'guessed-instance', {attack: 'guessed-instance'}, {instanceId: 'inst:guessed'}));
  await js(request(0, 'oversized', {attack: 'oversized', padding: 'x'.repeat(70000)}));
  await pause(150);
  assert.equal(await js('window.calls.length'), 1, 'wrong source, guessed instance and oversized messages never invoke');
  const rejected = await js('window.rejected');
  assert.ok(rejected.some(reason => reason.startsWith('instance:guessed-instance')), JSON.stringify(rejected));
  assert.ok(rejected.some(reason => reason.startsWith('oversized:oversized')), JSON.stringify(rejected));

  for (let index = 0; index < 10; index++)
    await js(request(0, 'budget-' + index, {hold: true}));
  await until(() => js('window.calls.length >= 9'), 'pending request budget admits its bound');
  await pause(150);
  assert.equal(await js('window.calls.length'), 9, 'only eight of ten concurrent requests invoke');
  assert.equal(await js(`window.rejected.filter(reason => reason.startsWith('budget:budget-')).length`), 2);
  await js('window.readGates.splice(0).forEach(release => release())');
  await until(() => js(`window.got.filter(message => message.kind === 'rpc-response').length === 9`), 'admitted requests settle');

  await js(`window.__unmount(); ${request(0, 'after-unmount', {attack: 'after-unmount'})}; window.__reinstall()`);
  await until(() => js('window.bridges.length === 2 && window.calls.length === 10'), 'fresh reinstall RPC');
  assert.equal(await js('window.channelsCreated'), 2, 'reinstall creates one fresh channel');
  assert.equal(await js(`window.calls.some(call => call.payload && call.payload.attack)`), false,
    'the retained pre-uninstall channel never invokes again');

  await js(`document.querySelector('iframe.plugin-custom-page').contentWindow.postMessage({kind: 'navigate'}, '*')`);
  await until(() => js(`window.got.some(message => message.kind === 'replacement-report')`), 'replacement document loaded');
  await js(request(1, 'old-frame', {attack: 'old-frame'}));
  await pause(200);
  assert.equal(await js('window.calls.length'), 10, 'the old frame port is dead after navigation');
  assert.equal(await js(`window.calls.some(call => call.payload && call.payload.attack)`), false,
    'no rejected message reached the host API');
  const replacement = (await js('window.got')).find(message => message.kind === 'replacement-report');
  assert.equal(replacement.channels, 0, 'the replacement document never receives a channel');
  const secondSecurity = (await js('window.got')).find(message => message.kind === 'security' && message.page === 'two');
  assert.equal(secondSecurity.mote, 'undefined');
  assert.equal(secondSecurity.storage, 'blocked');
  assert.deepEqual(secondSecurity.handshakeKeys, firstSecurity.handshakeKeys);
  return {window, server};
}

run().then(async ({window, server}) => {
  console.log(JSON.stringify({passed: true}));
  window.destroy();
  server.close();
  rmSync(temporary, {recursive: true, force: true});
  app.exit(0);
}).catch(error => {
  console.error(error);
  rmSync(temporary, {recursive: true, force: true});
  app.exit(1);
});
