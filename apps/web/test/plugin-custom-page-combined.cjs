/* Combined hidden fixture (Electron 41) — real CustomPluginPage + real
 * CustomPageFrameGuard + real preload IPC. Covers prepare->claim->channel/
 * invoke, two navigation denials, revocation ends the channel, late claim
 * denied, and a fresh remount getting a new epoch/channel. */
const {app, BrowserWindow, ipcMain} = require('electron');
const {createServer} = require('node:http');
const path = require('node:path');
const os = require('node:os');
const {mkdtempSync, rmSync, writeFileSync} = require('node:fs');
const {buildSync} = require('esbuild');
const assert = require('node:assert/strict');
const pause = ms => new Promise(r => setTimeout(r, ms));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mote-u08-combo-'));
// Real producer pieces from the desktop branch, vendored via git objects.
const {execSync} = require('node:child_process');
execSync('git show FETCH_HEAD:apps/desktop/src/plugin-host/desktop-host.ts > ' + path.join(tmp, 'desktop-host.ts'), {cwd: __dirname});
execSync('git show FETCH_HEAD:apps/desktop/src/plugin-host/ipc-registry.ts > ' + path.join(tmp, 'ipc-registry.ts'), {cwd: __dirname});
execSync('git show FETCH_HEAD:apps/desktop/src/plugin-host/native-registry.ts > ' + path.join(tmp, 'native-registry.ts'), {cwd: __dirname});
execSync('git show FETCH_HEAD:apps/desktop/src/plugin-host/declarative-view.ts > ' + path.join(tmp, 'declarative-view.ts'), {cwd: __dirname});
buildSync({entryPoints: [path.join(tmp, 'desktop-host.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(tmp, 'guard.cjs'), external: ['electron', '@mote/*'], logLevel: 'silent'});
// The guard imports shared types only — external is fine for test scope.
const {CustomPageFrameGuard} = require(path.join(tmp, 'guard.cjs'));
buildSync({entryPoints: [path.join(__dirname, 'custom-page-combined-harness.tsx')], bundle: true, platform: 'browser', format: 'iife', outfile: path.join(tmp, 'bundle.js'), logLevel: 'silent', external: ['@mote/*']});

// Real preload: same contract shape as apps/desktop/src/preload.ts.
writeFileSync(path.join(tmp, 'preload.cjs'), `const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('mote', {
  customPagePrepare: target => ipcRenderer.invoke('mote:custom-page-prepare', target),
  customPageClaim: claim => ipcRenderer.invoke('mote:custom-page-claim', claim),
  onCustomPageRevoked: callback => {
    const handler = (_e, v) => callback(v);
    ipcRenderer.on('mote:custom-page-revoked', handler);
    return () => ipcRenderer.removeListener('mote:custom-page-revoked', handler);
  },
});`);

const nonce = 'combo-nonce-1', nonce2 = 'combo-nonce-2', instanceId = 'combo-inst', documentKey = 'combo-doc';
const hits = {};
const req = (key, id = 'r1', method = 'read') => ({contractVersion: '1', nonce, documentKey, instanceId, generation: 1, requestId: id, kind: 'request', method});
const pages = {
  '/harness.html': `<!doctype html><div id="root"></div><script>window.__HARNESS__=${JSON.stringify({nonce, nonce2, instanceId, documentKey})};</script><script src="/bundle.js"></script>`,
  '/entry1.html': `<script>new Image().src='/ran1';let received=[];
addEventListener('message',e=>{if(e.data&&e.data.kind==='channel'){const port=e.ports[0];window.__port=port;port.onmessage=m=>received.push(m.data);
port.postMessage({contractVersion:e.data.contractVersion,nonce:e.data.nonce,documentKey:e.data.documentKey,instanceId:e.data.instanceId,generation:e.data.generation,requestId:'r1',kind:'request',method:'read'});}});
setTimeout(()=>{try{location.href='/entry2.html';}catch(_){}},250);
setTimeout(()=>{try{location.href='/entry3.html';}catch(_){}},450);
setTimeout(()=>{window.__port&&window.__port.postMessage({contractVersion:'1',nonce:'${nonce}',documentKey:'${documentKey}',instanceId:'${instanceId}',generation:2,requestId:'r2',kind:'request',method:'read'});},650);
setTimeout(()=>{parent.postMessage({kind:'e1-report',received},'*');},900);
</script>`,
  '/entry2.html': `<script>parent.postMessage({kind:'entry2-ran'},'*');</script>`,
  '/entry3.html': `<script>parent.postMessage({kind:'entry3-ran'},'*');</script>`,
  '/entry4.html': `<script>new Image().src='/ran4';
addEventListener('message',e=>{if(e.data&&e.data.kind==='channel'){const port=e.ports[0];port.onmessage=m=>parent.postMessage({kind:'e4-response',value:m.data},'*');port.postMessage({contractVersion:e.data.contractVersion,nonce:e.data.nonce,documentKey:e.data.documentKey,instanceId:e.data.instanceId,generation:e.data.generation,requestId:'r9',kind:'request',method:'read'});}});
setTimeout(()=>{parent.postMessage({kind:'e4-done'},'*');},800);
</script>`,
};

app.whenReady().then(async () => {
  const server = createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(require('node:fs').readFileSync(path.join(tmp, 'bundle.js'))); return; }
    const page = pages[req.url && req.url.split('?')[0]];
    if (!page) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'text/html'); res.end(page);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const hostUrl = 'http://127.0.0.1:' + server.address().port + '/harness.html';
  const guard = new CustomPageFrameGuard();
  const win = new BrowserWindow({show: false, webPreferences: {preload: path.join(tmp, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false}});
  const contents = win.webContents, wcId = contents.id;
  const events = [];
  contents.on('will-frame-navigate', d => { const deny = guard.willNavigate(wcId, d); events.push({t: Date.now(), type: 'will-frame', url: d.url, main: d.isMainFrame, id: d.frame?.frameTreeNodeId, deny}); if (deny) d.preventDefault(); });
  contents.on('will-redirect', d => { const deny = guard.willNavigate(wcId, d); events.push({t: Date.now(), type: 'will-redirect', url: d.url, id: d.frame?.frameTreeNodeId, deny}); if (deny) d.preventDefault(); });
  contents.on('did-start-navigation', d => { events.push({t: Date.now(), type: 'did-start', url: d.url, main: d.isMainFrame}); if (d.isMainFrame) guard.revokeWindow(wcId); });
  contents.on('did-frame-navigate', d => { events.push({t: Date.now(), type: 'did-frame', url: d.url, main: d.isMainFrame}); guard.prune(wcId, contents.mainFrame); });
  contents.on('destroyed', () => guard.revokeWindow(wcId));
  guard.setRevocationListener((id, revocation) => { events.push({t: Date.now(), type: 'revocation', revocation}); if (!win.isDestroyed()) contents.send('mote:custom-page-revoked', revocation); });
  const trustedMain = event => {
    if (!(win && !win.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame?.url === hostUrl))
      throw new Error('untrusted custom page sender');
  };
  ipcMain.handle('mote:custom-page-prepare', (e, t) => { trustedMain(e); return guard.prepare(wcId, t); });
  ipcMain.handle('mote:custom-page-claim', (e, c) => { trustedMain(e); return guard.claim(wcId, c, e.sender.mainFrame); });
  await win.loadURL(hostUrl);
  contents.on('console-message', e => console.log('[ui]', e.message.slice(0, 200)));
  const js = code => contents.executeJavaScript(code);
  const until = async (fn, label) => { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await pause(80); }
    const diag = {hits, mote: await js('typeof window.mote').catch(e=>String(e)), got: await js('JSON.stringify((window.got||[]).slice(0,6))').catch(e=>String(e)), html: await js('document.body.innerHTML.slice(0,200)').catch(e=>String(e)), claimable: await js('typeof window.claimCustomPage').catch(e=>String(e)), moteKeys: await js('window.mote?Object.keys(window.mote):null').catch(e=>String(e))};
    throw Error('timed out: ' + label + ' ' + JSON.stringify(diag)); };

  // First mount: real prepare->claim->channel->invoke.
  try { await until(() => js('window.calls&&window.calls.length>=1'), 'first real invocation'); }
  catch (e) {
    const direct = await js(`window.mote.customPageClaim({instanceId:'${instanceId}',nonce:'${nonce}',documentKey:'${documentKey}'}).then(g=>'grant:'+JSON.stringify(g),e=>'err:'+String(e.message||e))`);
    console.log('DIRECT-CLAIM', direct, 'EVENTS', JSON.stringify(events));
    throw e;
  }
  await pause(1100); // navigation attempts + revocation + post-death request
  const got = await js('window.got||[]'), calls = await js('window.calls'), e1 = got.find(m => m && m.kind === 'e1-report');
  assert.equal(calls.length, 1, 'revocation ended the channel — the post-death request never invoked: ' + JSON.stringify(calls));
  assert.ok(e1 && e1.received.length === 0, 'entry1 received no responses after the channel died: ' + JSON.stringify(got));
  assert.ok(!hits['/entry2.html'] && !hits['/entry3.html'], 'both navigation attempts were denied by the guard');

  // Late claim for the revoked binding must fail and not reactivate.
  const late = await js(`window.mote.customPageClaim({instanceId:'${instanceId}',nonce:'${nonce}',documentKey:'${documentKey}'}).then(()=>'ok',e=>String(e.message||e))`);
  assert.match(late, /not prepared|revoked|denied/i, 'late claim rejected after revocation: ' + late);

  // Fresh remount: new iframe+nonce gets a new epoch/channel.
  await js(`window.__mountSecond()`);
  await until(() => js('window.got&&window.got.some(m=>m&&m.kind==="e4-done")'), 'second mount loaded and reported');
  const calls2 = await js('window.calls');
  assert.equal(calls2.length, 2, 'the remount got a working new channel: ' + JSON.stringify(calls2));
  const got2 = await js('window.got||[]');
  const e4 = got2.find(m => m && m.kind === 'e4-response');
  assert.ok(e4 && e4.value && e4.value.ok === true, 'the remount received a real response: ' + JSON.stringify(got2));

  console.log('COMBINED ' + JSON.stringify({calls: calls2, e1Received: e1.received.length, late, passed: true}));
  server.close(); app.exit(0);
}).catch(error => { console.error(error); rmSync(tmp, {recursive: true, force: true}); app.exit(1); });
