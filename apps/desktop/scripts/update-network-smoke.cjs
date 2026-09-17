require('../../../scripts/fixture-language.cjs');
// Isolated Electron networking fixture; never loads Mote main, user profiles or Keychain.
// Optional --public-version=0.6.0 additionally verifies/downloads that existing public release.
const { app, net, session } = require('electron');
const { mkdtempSync } = require('node:fs');
const { mkdir, writeFile, readFile, readdir, rm } = require('node:fs/promises');
const { createServer } = require('node:http');
const { generateKeyPairSync, createHash, sign } = require('node:crypto');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { createUpdateNetwork } = require('../dist/update-network');
const { createChromiumUpdateFetch } = require('../dist/electron-update-fetch');
const { inspectUpdateArchive } = require('../dist/update-archive');
const { RELEASE_KEY_ID, selectReleaseAsset } = require('@mote/shared/release');
const directory = mkdtempSync(join(tmpdir(), 'mote-system-update-network-'));
app.setPath('userData', directory); app.setPath('sessionData', directory);
app.commandLine.appendSwitch('disable-background-networking');
const option = prefix => process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
const publicVersion = option('--public-version='), report = option('--report=');
const watchdog = setTimeout(() => { console.error('Update network fixture timed out'); app.exit(1); }, publicVersion ? 180000 : 30000);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let server;
const wait = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('fixture event timeout'); };
app.whenReady().then(async () => {
  const isolated = session.fromPartition('mote-update-network-fixture', { cache: false });
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const body = Buffer.alloc(256 * 1024, 71), version = '9.8.7';
  const asset = { component: 'desktop', platform: 'darwin', arch: 'arm64', format: 'zip', name: 'fixture.zip', url: `https://github.com/utopiafar/mote/releases/download/v${version}/fixture.zip`, size: body.length, sha256: sha(body), bundleId: 'dev.mote.collector', signing: 'adhoc' };
  const manifest = { schemaVersion: 1, version, channel: 'stable', repository: 'utopiafar/mote', tag: 'v' + version, notesUrl: `https://github.com/utopiafar/mote/releases/tag/v${version}`, publishedAt: new Date().toISOString(), assets: [asset], images: [] };
  const keys = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { format: 'pem', type: 'spki' }, privateKeyEncoding: { format: 'pem', type: 'pkcs8' } });
  const payload = Buffer.from(JSON.stringify(manifest)), envelope = JSON.stringify({ schemaVersion: 1, keyId: RELEASE_KEY_ID, payload: payload.toString('base64'), signature: sign('RSA-SHA256', payload, keys.privateKey).toString('base64') });
  let mode = 'normal', unexpectedCredentials = false, stoppedStreams = 0, nativeOptions = [];
  server = createServer((request, response) => {
    if (request.headers.authorization || request.headers.cookie || request.headers['proxy-authorization']) unexpectedCredentials = true;
    if (request.url.endsWith('mote-release.json')) { response.writeHead(302, { Location: mode === 'outside' ? 'https://outside.invalid/archive' : mode === 'http' ? 'http://github.com/archive' : 'https://release-assets.githubusercontent.com/fixture-manifest' }); response.end(); }
    else if (request.url === '/fixture-manifest') { response.setHeader('Content-Type', 'application/json'); response.end(envelope); }
    else if (mode === 'slow') {
      response.setHeader('Content-Length', String(body.length)); let sent = 0;
      const timer = setInterval(() => { const chunk = body.subarray(sent, sent + 4096); sent += chunk.length; response.write(chunk); if (sent === body.length) { clearInterval(timer); response.end(); } }, 10);
      response.on('close', () => { clearInterval(timer); if (!response.writableFinished) stoppedStreams++; });
    } else { response.setHeader('Content-Length', String(body.length)); response.end(mode === 'corrupt' ? Buffer.alloc(body.length) : body); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await isolated.cookies.set({ url: origin, name: 'mote-fixture-cookie', value: 'synthetic-cookie' });
  // The test request factory maps logical allowed HTTPS URLs to one local fixture server.
  // Production supplies only the isolated session, with no URL rewrite.
  const fetcher = createChromiumUpdateFetch(options => { nativeOptions.push(options); return net.request({ ...options, url: origin + new URL(options.url).pathname, session: isolated }); });
  const network = createUpdateNetwork(fetcher);
  console.log(JSON.stringify({phase:'generated-manifest-through-chromium'}));
  const check = await network.check({ version, publicKey: keys.publicKey, currentVersion: '1.0.0' }); assert(check.available);
  const path = join(directory, 'fixture.zip'); await network.download(check.manifest.assets[0], path); assert.deepEqual(await readFile(path), body); await rm(path);
  for (const unsafe of ['outside', 'http']) { mode = unsafe; const before = nativeOptions.length; await assert.rejects(network.check({ version, publicKey: keys.publicKey }), error => error.code === 'update_host_rejected'); assert.equal(nativeOptions.length, before + 1); }
  mode = 'normal'; await assert.rejects(network.check({ version }), error => error.code === 'invalid_manifest_signature');
  mode = 'corrupt'; await assert.rejects(network.download(asset, join(directory, 'corrupt.zip')), error => error.code === 'asset_checksum_mismatch');
  mode = 'slow'; const controller = new AbortController();
  await assert.rejects(network.download(asset, join(directory, 'cancelled.zip'), { signal: controller.signal, onProgress: () => controller.abort() }), error => error.code === 'update_request_cancelled');
  await wait(() => stoppedStreams === 1);
  const response = await fetcher(asset.url, { redirect: 'manual', headers: { Authorization: 'synthetic-auth', Cookie: 'synthetic-cookie', 'Proxy-Authorization': 'synthetic-proxy' } });
  const reader = response.body.getReader(); assert.equal((await reader.read()).done, false); await reader.cancel(); await wait(() => stoppedStreams === 2);
  const aborted = new AbortController(); aborted.abort(); const before = nativeOptions.length;
  await assert.rejects(fetcher(asset.url, { redirect: 'manual', signal: aborted.signal }), error => error.name === 'AbortError'); assert.equal(nativeOptions.length, before);
  assert.equal(unexpectedCredentials, false);
  for (const options of nativeOptions) assert(options.credentials === 'omit' && options.redirect === 'manual' && options.useSessionCookies === false);
  assert(!(await readdir(directory)).some(name => name.endsWith('.partial') || name === 'corrupt.zip' || name === 'cancelled.zip'));
  const result = { ok: true, electron: process.versions.electron, isolatedSession: true, chromiumNetwork: true, sharedManualRedirects: true, unsafeRedirectsRejected: true, signatureStillVerified: true, streamingShaStillVerified: true, noCookiesOrAuthorization: true, abortAndBodyCancelCloseSocket: true, partialDownloadsRemoved: true, normalMoteMainStarted: false, realKeychainAccessed: false };
  if (publicVersion) {
    console.log(JSON.stringify({ phase: 'public-release-check-over-system-network' }));
    let requests = 0;
    const publicNetwork = createUpdateNetwork(createChromiumUpdateFetch(options => { assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual'); requests++; return net.request({ ...options, session: isolated }); }));
    const checked = await publicNetwork.check({ version: publicVersion, currentVersion: '0.5.1', channel: 'stable' }); assert.equal(checked.manifest.version, publicVersion);
    const publicAsset = selectReleaseAsset(checked.manifest, { component: 'desktop', platform: 'darwin', arch: process.arch, format: 'zip' }); assert(publicAsset); const checkRequests = requests;
    console.log(JSON.stringify({ phase: 'public-asset-streaming-download-over-system-network' }));
    const destination = join(directory, publicAsset.name); let received = 0;
    await publicNetwork.download(publicAsset, destination, { onProgress: bytes => { received = bytes; } }); assert.equal(received, publicAsset.size); assert.equal(await inspectUpdateArchive(destination), 'Mote Collector.app');
    result.public = { version: publicVersion, size: publicAsset.size, sha256: publicAsset.sha256, checkRequests, downloadRequests: requests - checkRequests, pinnedPublicKeyVerified: true, verifiedDownload: true, zipLayoutVerified: true, environmentProxyFlagRequired: false };
  }
  if (report) { await mkdir(resolve(report, '..'), { recursive: true }); await writeFile(report, JSON.stringify(result, null, 2), { mode: 0o600 }); }
  console.log(JSON.stringify(result));
}).then(async () => { clearTimeout(watchdog); server?.closeAllConnections(); server?.close(); await rm(directory, { recursive: true, force: true }); app.quit(); }).catch(error => { clearTimeout(watchdog); console.error('Update network fixture failed: ' + error.message); server?.closeAllConnections(); server?.close(); app.exit(1); });
