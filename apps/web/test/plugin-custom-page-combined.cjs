/* Combined hidden fixture (Electron 41) — real CustomPluginPage + real
 * CustomPageFrameGuard + a generated IPC adapter mirroring the frozen
 * preload contract (the production preload itself is NOT under test here —
 * this fixture proves the real main-process guard and IPC path, not the
 * production preload file). Covers prepare->claim->channel/invoke, two
 * navigation denials, revocation ending the channel, an in-flight claim
 * whose success lands after revocation, a deferred prepare whose props
 * change, late claim denied, and a fresh remount earning a new epoch. */
require('../../../scripts/fixture-background.cjs');
const {app, BrowserWindow, ipcMain} = require('electron');
const {createServer} = require('node:http');
const path = require('node:path');
const os = require('node:os');
const {mkdtempSync, rmSync, writeFileSync} = require('node:fs');
const {buildSync} = require('esbuild');
const assert = require('node:assert/strict');
const pause = ms => new Promise(r => setTimeout(r, ms));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'mote-u08-combo-'));
app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'mote-u08-profile-')));
// Real producer pieces pinned to the exact reviewed commit — FETCH_HEAD
// would drift under our feet.
const DESKTOP_SHA = 'b1447b25ba2a55f1cdd5193f6b8660720b2a94cf';
const {execSync} = require('node:child_process');
const actualSha = execSync('git rev-parse ' + DESKTOP_SHA + '^{commit}', {cwd: __dirname, encoding: 'utf8'}).trim();
if (actualSha !== DESKTOP_SHA) throw new Error('desktop source drifted: ' + actualSha);
for (const f of ['desktop-host.ts', 'ipc-registry.ts', 'native-registry.ts', 'declarative-view.ts'])
  execSync('git show ' + DESKTOP_SHA + ':apps/desktop/src/plugin-host/' + f + ' > ' + path.join(tmp, f), {cwd: __dirname});
console.log('COMBINED-HEADS ' + JSON.stringify({desktop: actualSha, consumer: execSync('git rev-parse HEAD', {encoding: 'utf8'}).trim()}));
buildSync({entryPoints: [path.join(tmp, 'desktop-host.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(tmp, 'guard.cjs'), external: ['electron', '@mote/*'], logLevel: 'silent'});
// The guard imports shared types only — external is fine for test scope.
const {CustomPageFrameGuard} = require(path.join(tmp, 'guard.cjs'));
buildSync({entryPoints: [path.join(__dirname, 'custom-page-combined-harness.tsx')], bundle: true, platform: 'browser', format: 'iife', outfile: path.join(tmp, 'bundle.js'), logLevel: 'silent', external: ['@mote/*']});

// Generated IPC adapter mirroring the frozen preload contract — the
// production preload file is not under test; the IPC surface and the real
// main-process guard are.
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

const nonce = 'combo-nonce-1', nonce2 = 'combo-nonce-2', nonce3 = 'combo-nonce-3', nonceLate = 'combo-nonce-late', instanceId = 'combo-inst', documentKey = 'combo-doc';
let releaseClaim; const claimBarrier = new Promise(r => {releaseClaim = r;});
let releasePrepare; const prepareBarrier = new Promise(r => {releasePrepare = r;});
const hits = {};
const pages = {
  '/harness.html': `<!doctype html><div id="root"></div><script>window.__HARNESS__=${JSON.stringify({nonce, nonce2, nonce3, nonceLate, instanceId, documentKey})};</script><script src="/bundle.js"></script>`,
  '/entry1.html': `<script>new Image().src='/ran1';let received=[];
addEventListener('message',e=>{if(e.data&&e.data.kind==='channel'){const port=e.ports[0];window.__port=port;window.__handshake=e.data;port.onmessage=m=>received.push(m.data);
port.postMessage({contractVersion:e.data.contractVersion,nonce:e.data.nonce,documentKey:e.data.documentKey,instanceId:e.data.instanceId,generation:e.data.generation,requestId:'r1',kind:'request',method:'read'});}});
setTimeout(()=>{try{location.href='/entry2.html';}catch(_){}},250);
setTimeout(()=>{try{location.href='/entry3.html';}catch(_){}},450);
// The post-death request reuses the handshake identity/generation exactly —
// only requestId changes — so refusal can only be revocation, not a stale
// epoch mismatch.
setTimeout(()=>{if(window.__port&&window.__handshake){const h=window.__handshake;window.__port.postMessage({contractVersion:h.contractVersion,nonce:h.nonce,documentKey:h.documentKey,instanceId:h.instanceId,generation:h.generation,requestId:'r2',kind:'request',method:'read'});}},650);
setTimeout(()=>{parent.postMessage({kind:'e1-report',received},'*');},900);
</script>`,
  '/entry2.html': `<script>parent.postMessage({kind:'entry2-ran'},'*');</script>`,
  '/entry3.html': `<script>parent.postMessage({kind:'entry3-ran'},'*');</script>`,
  '/entry5.html': `<script>new Image().src='/ran5';let channels=0;
addEventListener('message',e=>{if(e.data&&e.data.kind==='channel')channels++;});
setTimeout(()=>{try{location.href='/entry2.html';}catch(_){}},200);
setTimeout(()=>{parent.postMessage({kind:'e5-report',channels},'*');},700);
</script>`,
  '/entry6.html': `<script>new Image().src='/ran6';parent.postMessage({kind:'e6-ran'},'*');</script>`,
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
  ipcMain.handle('mote:custom-page-prepare', async (e, t) => { trustedMain(e); const out = guard.prepare(wcId, t); if (t.nonce === nonce3) await prepareBarrier; return out; });
  ipcMain.handle('mote:custom-page-claim', async (e, c) => { trustedMain(e); const grant = guard.claim(wcId, c, e.sender.mainFrame); if (c.nonce === nonceLate) await claimBarrier; return grant; });
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

  // In-flight claim: the real grant is computed in main, its IPC response
  // held, the entry navigates (denied+revoked), then the stale grant lands
  // — it must NOT rebuild a channel.
  await js('window.__mountLate()');
  await until(() => hits['/ran5'], 'late-claim entry loaded');
  await pause(400); // entry5 navigates at ~200ms: deny + revocation pushed
  releaseClaim();
  await until(() => js('window.got&&window.got.some(m=>m&&m.kind==="e5-report")'), 'entry5 reported');
  const e5 = (await js('window.got||[]')).find(m => m && m.kind === 'e5-report');
  assert.ok(e5 && e5.channels === 0, 'the late grant never rebuilt a channel: ' + JSON.stringify(e5));
  const calls3 = await js('window.calls');
  assert.equal(calls3.length, 2, 'no stale-grant invocation: ' + JSON.stringify(calls3));

  // Deferred prepare: props swap while the prepare response is held — the
  // stale continuation must not navigate the frame to the old entry.
  await js('window.__mountSwappable()');
  await pause(300);
  await js('window.__swapProps()');
  // React applies the swap asynchronously — wait for the NEW effect's own
  // prepare/navigation before releasing the old barrier, so the release
  // provably lands after the old effect was cleaned up.
  await until(() => hits['/entry6.html?moteFrame=late-doc'], 'new effect navigated');
  releasePrepare();
  await pause(600);
  assert.ok(!hits['/entry5.html?moteFrame=' + nonce3], 'the stale prepare never navigated the swapped frame: ' + JSON.stringify(Object.keys(hits).filter(u=>/entry5|entry6/.test(u))));

  console.log('COMBINED ' + JSON.stringify({calls: await js('window.calls'), e1Received: e1.received.length, late, passed: true}));
  server.close(); rmSync(tmp, {recursive: true, force: true}); app.exit(0);
}).catch(error => { console.error(error); rmSync(tmp, {recursive: true, force: true}); app.exit(1); });
