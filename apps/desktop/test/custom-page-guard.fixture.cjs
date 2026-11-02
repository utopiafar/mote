/* Manual hidden fixture (Electron 41.10.7) for the production custom-page
 * frame guard. Run explicitly, never on every push:
 *
 *   electron apps/desktop/test/custom-page-guard.fixture.cjs
 *
 * It compiles the production TypeScript guard with esbuild, binds a real
 * direct child frame through the same main-frame claim the desktop uses, and
 * proves that a leaked MessagePort cannot navigate the document or run a
 * replacement script. No network, no product build, no native helper. */
require('../../../scripts/fixture-background.cjs');
const {app, BrowserWindow, ipcMain} = require('electron');
const {createServer} = require('node:http');
const path = require('node:path');
const os = require('node:os');
const {mkdtempSync} = require('node:fs');
const {buildSync} = require('esbuild');

const profile = mkdtempSync(path.join(os.tmpdir(), 'mote-custom-page-guard-'));
app.setPath('userData', profile);
process.env.MOTE_PROFILE = 'default';

const guardModule = path.join(os.tmpdir(), `mote-custom-page-guard-${process.pid}.cjs`);
buildSync({
  entryPoints: [path.join(__dirname, '../src/plugin-host/desktop-host.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: guardModule,
  external: ['electron'],
  logLevel: 'silent',
});
const {CustomPageFrameGuard} = require(guardModule);

const nonce = 'fixture-nonce-1';
const instanceId = 'fixture-instance';
const documentKey = 'fixture-key';
const events = [];
const hits = {};
const revocations = [];
const guard = new CustomPageFrameGuard();
guard.setRevocationListener((webContentsId, revocation) => revocations.push({webContentsId, revocation}));
let window;
let webContentsId;
let hostUrl;

const pages = {
  '/host.html': `<!doctype html><meta charset="utf-8"><body><script>
const nonce = '${nonce}';
window.messages = [];
window.claimResults = [];
addEventListener('message', event => { window.messages.push(event.data); });
(async () => {
  const srcdoc = document.createElement('iframe');
  srcdoc.sandbox = 'allow-scripts';
  srcdoc.srcdoc = '<p>srcdoc</p>';
  document.body.append(srcdoc);
  const blank = document.createElement('iframe');
  blank.src = 'about:blank';
  document.body.append(blank);
  await window.prepareCustomPage({instanceId: '${instanceId}', nonce, documentKey: '${documentKey}', entryUrl: location.origin + '/entry1.html'});
  const target = document.createElement('iframe');
  target.sandbox = 'allow-scripts';
  target.src = '/entry1.html?moteFrame=' + nonce;
  document.body.append(target);
  for (const name of ['/same.html', '/same.html']) {
    const same = document.createElement('iframe');
    same.src = name;
    document.body.append(same);
  }
  target.addEventListener('load', async () => {
    try { window.claimResults.push({ok: await window.claimCustomPage({instanceId: '${instanceId}', nonce, documentKey: '${documentKey}'})}); }
    catch (error) { window.claimResults.push({error: String(error)}); }
  });
  // After the leaked port tries to navigate, a late claim must not reactivate
  // the revoked epoch.
  setTimeout(async () => {
    try { window.claimResults.push({ok: await window.claimCustomPage({instanceId: '${instanceId}', nonce, documentKey: '${documentKey}'})}); }
    catch (error) { window.claimResults.push({error: String(error)}); }
  }, 900);
})();
</script>`,
  '/entry1.html': `<!doctype html><meta charset="utf-8"><body><script>
parent.postMessage({kind: 'entry1-ran'}, '*');
const channel = new MessageChannel();
parent.postMessage({kind: 'port'}, '*', [channel.port2]);
channel.port1.onmessage = event => channel.port1.postMessage({kind: 'reply', echo: event.data});
setTimeout(() => { location.href = '/entry2.html'; }, 250);
// Cancelling one navigation leaves this document running; retry to prove the
// frame stays blocked instead of falling through on the next attempt.
setTimeout(() => { location.href = '/entry2.html'; }, 500);
setTimeout(() => { location.href = '/entry3.html'; }, 750);
</script>`,
  '/entry2.html': `<!doctype html><meta charset="utf-8"><body><script>parent.postMessage({kind: 'entry2-ran'}, '*')</script>`,
  '/entry3.html': `<!doctype html><meta charset="utf-8"><body><script>parent.postMessage({kind: 'entry3-ran'}, '*')</script>`,
  '/same.html': `<!doctype html><meta charset="utf-8"><body><script>parent.postMessage({kind: 'same-ran'}, '*')</script>`,
};

const server = createServer((request, response) => {
  hits[request.url] = (hits[request.url] ?? 0) + 1;
  const body = pages[request.url.split('?')[0]];
  if (!body) { response.statusCode = 404; response.end(); return; }
  response.setHeader('content-type', 'text/html');
  response.end(body);
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const trustedMain = event => {
  if (!(window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame?.url === hostUrl))
    throw new Error('untrusted custom page sender');
};

app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  hostUrl = `http://127.0.0.1:${port}/host.html`;

  window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'custom-page-guard.preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const contents = window.webContents;
  webContentsId = contents.id;

  contents.on('frame-created', (_event, details) => {
    if (details.frame) events.push({type: 'frame-created', frameTreeNodeId: details.frame.frameTreeNodeId, url: details.frame.url});
  });
  contents.on('will-frame-navigate', details => {
    const deny = guard.willNavigate(webContentsId, details);
    events.push({type: 'will-frame-navigate', url: details.url, isMainFrame: details.isMainFrame, frameTreeNodeId: details.frame?.frameTreeNodeId ?? null, processId: details.frame?.processId ?? null, routingId: details.frame?.routingId ?? null, deny});
    if (deny) details.preventDefault();
  });
  contents.on('will-redirect', details => {
    const deny = guard.willNavigate(webContentsId, details);
    events.push({type: 'will-redirect', url: details.url, isMainFrame: details.isMainFrame, frameTreeNodeId: details.frame?.frameTreeNodeId ?? null, deny});
    if (deny) details.preventDefault();
  });
  contents.on('did-start-navigation', details => { if (details.isMainFrame) guard.revokeWindow(webContentsId); });
  contents.on('did-frame-navigate', () => guard.prune(webContentsId, contents.mainFrame));
  contents.on('destroyed', () => guard.revokeWindow(webContentsId));

  ipcMain.handle('mote:custom-page-prepare', (event, target) => {
    trustedMain(event);
    if (!target || typeof target !== 'object') throw new TypeError('Invalid custom page target');
    return guard.prepare(webContentsId, target);
  });
  ipcMain.handle('mote:custom-page-claim', (event, claim) => {
    trustedMain(event);
    if (!claim || typeof claim !== 'object') throw new TypeError('Invalid custom page claim');
    return guard.claim(webContentsId, claim, event.sender.mainFrame);
  });

  await window.loadURL(hostUrl);
  await sleep(1600);

  const claimResults = await contents.executeJavaScript('window.claimResults');
  const messages = await contents.executeJavaScript('window.messages');
  const finalFrames = contents.mainFrame.framesInSubtree.map(frame => ({
    frameTreeNodeId: frame.frameTreeNodeId,
    url: frame.url,
    parentIsMain: frame.parent?.frameTreeNodeId === contents.mainFrame.frameTreeNodeId,
  }));
  const childClaims = [];
  for (const frame of contents.mainFrame.framesInSubtree) {
    if (frame.parent?.frameTreeNodeId !== contents.mainFrame.frameTreeNodeId) continue;
    childClaims.push({frameTreeNodeId: frame.frameTreeNodeId, claimType: await frame.executeJavaScript('typeof window.claimCustomPage')});
  }

  // Direct production-guard checks that a real event cannot force.
  const nullFrameDenied = guard.willNavigate(webContentsId, {url: 'http://127.0.0.1/entry2.html', isMainFrame: false, frame: null});
  const mainFrameAllowed = guard.willNavigate(webContentsId, {url: hostUrl, isMainFrame: true, frame: null}) === false;
  guard.prepare(webContentsId, {instanceId, nonce: 'revoked-pending', documentKey, entryUrl: `http://127.0.0.1:${port}/entry1.html`});
  guard.revokeWindow(webContentsId);
  let revokedPendingDenied = false;
  try { guard.claim(webContentsId, {instanceId, nonce: 'revoked-pending', documentKey}, contents.mainFrame); }
  catch { revokedPendingDenied = true; }

  const claim = claimResults.find(result => result.ok)?.ok;
  const lateClaimDenied = claimResults.some(result => result.error && /not prepared/.test(result.error));
  const sameFrames = finalFrames.filter(frame => frame.url.endsWith('/same.html'));
  const entryEvents = events.filter(event => event.type === 'will-frame-navigate' && /\/entry\d\.html/.test(event.url));
  const entry1 = entryEvents.find(event => event.url.endsWith('/entry1.html?moteFrame=' + nonce));
  const entry2Events = entryEvents.filter(event => event.url.endsWith('/entry2.html'));
  const entry3 = entryEvents.find(event => event.url.endsWith('/entry3.html'));

  const checks = {
    claimBound: Boolean(claim && Number.isInteger(claim.frameTreeNodeId) && claim.epoch >= 1),
    claimMatchesEntryFrame: Boolean(claim && entry1 && claim.frameTreeNodeId === entry1.frameTreeNodeId),
    noChannelInChildFrames: childClaims.length >= 5 && childClaims.every(frame => frame.claimType === 'undefined'),
    sameUrlFramesDistinct: sameFrames.length === 2 && new Set(sameFrames.map(frame => frame.frameTreeNodeId)).size === 2,
    entry2Blocked: !hits['/entry2.html'] && !messages.some(message => message?.kind === 'entry2-ran'),
    repeatedEntry2Blocked: entry2Events.length >= 2 && entry2Events.every(event => event.deny
      && entry1 && event.frameTreeNodeId === entry1.frameTreeNodeId) && !hits['/entry2.html'],
    entry3Blocked: Boolean(entry3 && entry3.deny && entry1 && entry3.frameTreeNodeId === entry1.frameTreeNodeId)
      && !hits['/entry3.html'] && !messages.some(message => message?.kind === 'entry3-ran'),
    revocationPushed: revocations.length === 1 && revocations[0].webContentsId === webContentsId
      && revocations[0].revocation.instanceId === instanceId && revocations[0].revocation.nonce === nonce
      && revocations[0].revocation.documentKey === documentKey
      && revocations[0].revocation.frameTreeNodeId === claim?.frameTreeNodeId
      && revocations[0].revocation.epoch === claim?.epoch,
    portLeakedBeforeBlock: messages.some(message => message?.kind === 'port'),
    noPrecommitEventForBlankOrSrcdoc: !events.some(event => event.type === 'will-frame-navigate' && (event.url === 'about:blank' || event.url === 'about:srcdoc')),
    lateClaimDenied,
    nullFrameDenied,
    mainFrameAllowed,
    revokedPendingDenied,
  };
  const result = {checks, claimResults, claim, messages, finalFrames, childClaims, entry1, entry2Events, entry3, revocations, events, hits};
  console.log('CUSTOM_PAGE_GUARD_FIXTURE ' + JSON.stringify(result));
  app.exit(Object.values(checks).every(Boolean) ? 0 : 1);
}).catch(error => {
  console.error(error);
  app.exit(1);
});
