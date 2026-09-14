import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientRequest, ClientRequestConstructorOptions } from 'electron';
import { RELEASE_KEY_ID, type ReleaseManifest } from '@mote/shared/release';
import { createChromiumUpdateFetch } from '../src/electron-update-fetch';
import { createUpdateNetwork } from '../src/update-network';

const body = Buffer.from('generated streaming archive bytes');
const version = '9.8.7', assetUrl = `https://github.com/utopiafar/mote/releases/download/v${version}/fixture.zip`;
const asset = { component: 'desktop' as const, platform: 'darwin' as const, arch: 'arm64' as const, format: 'zip' as const, name: 'fixture.zip', url: assetUrl, size: body.length, sha256: createHash('sha256').update(body).digest('hex'), bundleId: 'dev.mote.collector', signing: 'adhoc' as const };
const manifest: ReleaseManifest = { schemaVersion: 1, version, channel: 'stable', publishedAt: '2026-09-14T00:00:00Z', repository: 'utopiafar/mote', tag: 'v' + version, notesUrl: `https://github.com/utopiafar/mote/releases/tag/v${version}`, assets: [asset], images: [] };
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { format: 'pem', type: 'spki' }, privateKeyEncoding: { format: 'pem', type: 'pkcs8' } });
const payload = Buffer.from(JSON.stringify(manifest));
const envelope = JSON.stringify({ schemaVersion: 1, keyId: RELEASE_KEY_ID, payload: payload.toString('base64'), signature: sign('RSA-SHA256', payload, privateKey).toString('base64') });
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mote-update-network-')); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });

class Request extends EventEmitter {
  aborted = false;
  incoming?: Readable;
  constructor(readonly options: ClientRequestConstructorOptions, private dispatch: (value: Request) => void) { super(); }
  end() { this.emit('finish'); this.emit('close'); this.dispatch(this); } // Electron 41 closes the writable side before HTTP response.
  abort() { if (this.aborted) return; this.aborted = true; this.incoming?.destroy(); this.emit('abort'); this.emit('close'); }
  respond(content: string | Buffer | Readable, statusCode = 200) {
    this.incoming = typeof content === 'string' || Buffer.isBuffer(content) ? Readable.from([Buffer.from(content)]) : content;
    Object.assign(this.incoming, { statusCode, headers: {} });
    this.incoming.once('end', () => this.emit('close'));
    this.emit('response', this.incoming);
  }
  redirect(url: string) { this.emit('redirect', 302, 'GET', url, { location: [url] }); }
}
function transport(dispatch: (value: Request) => void) {
  const requests: Request[] = [];
  const fetch = createChromiumUpdateFetch(options => { const request = new Request(options, dispatch); requests.push(request); return request as unknown as ClientRequest; });
  return { requests, fetch, network: createUpdateNetwork(fetch) };
}

it('uses injected Chromium for signed checks and streaming downloads with manual redirects and omitted credentials', async () => {
  const nativeFetch = vi.fn(() => { throw Error('Node fetch must not be used'); }); vi.stubGlobal('fetch', nativeFetch);
  const client = transport(request => {
    if (request.options.url?.endsWith('mote-release.json')) request.redirect('https://release-assets.githubusercontent.com/fixture-manifest');
    else if (request.options.url?.endsWith('fixture-manifest')) request.respond(envelope);
    else if (request.options.url === assetUrl) request.redirect('https://release-assets.githubusercontent.com/fixture-zip');
    else request.respond(Readable.from([body.subarray(0, 8), body.subarray(8)]));
  });
  const checked = await client.network.check({ version, currentVersion: '1.0.0', publicKey });
  expect(checked.manifest.assets[0]).toEqual(asset); expect(checked.available).toBe(true);
  let received = 0; const destination = join(directory, 'verified.zip');
  await client.network.download(checked.manifest.assets[0], destination, { onProgress: count => { received = count; } });
  expect(await readFile(destination)).toEqual(body); expect(received).toBe(body.length); expect(nativeFetch).not.toHaveBeenCalled();
  expect(client.requests).toHaveLength(4);
  for (const request of client.requests) expect(request.options).toMatchObject({ credentials: 'omit', useSessionCookies: false, redirect: 'manual', bypassCustomProtocolHandlers: true });
  expect(client.requests[0].aborted).toBe(true); expect(client.requests[2].aborted).toBe(true);
});

it('keeps the pinned signature check and rejects redirect targets before any request to another host or HTTP', async () => {
  const signed = transport(request => request.respond(envelope));
  await expect(signed.network.check({ version })).rejects.toMatchObject({ code: 'invalid_manifest_signature' });
  for (const target of ['https://outside.example/archive', 'http://github.com/archive']) {
    const client = transport(request => request.redirect(target));
    await expect(client.network.check({ version })).rejects.toMatchObject({ code: 'update_host_rejected' });
    expect(client.requests).toHaveLength(1); expect(client.requests[0].aborted).toBe(true);
  }
});

it('drops explicit authentication headers and cancels the underlying request when a body consumer stops', async () => {
  const stream = new Readable({ read() { this.push(Buffer.alloc(16384)); } });
  const client = transport(request => request.respond(stream));
  const response = await client.fetch(assetUrl, { redirect: 'manual', headers: { Authorization: 'synthetic-secret', Cookie: 'synthetic-cookie', 'Proxy-Authorization': 'synthetic-proxy', Accept: 'application/octet-stream' } });
  expect(client.requests[0].options.headers).toEqual({ accept: 'application/octet-stream' });
  const reader = response.body!.getReader(); expect((await reader.read()).done).toBe(false); await reader.cancel();
  expect(client.requests[0].aborted).toBe(true); expect(stream.destroyed).toBe(true);
});

it('propagates abort before headers and after the first chunk, deleting incomplete downloads', async () => {
  const before = new AbortController(); before.abort();
  const unused = transport(() => { throw Error('must not start'); });
  await expect(unused.fetch(assetUrl, { redirect: 'manual', signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(unused.requests).toHaveLength(0);
  const pending = new AbortController(), waiting = transport(() => {});
  const waitingResponse = waiting.fetch(assetUrl, { redirect: 'manual', signal: pending.signal }); pending.abort();
  await expect(waitingResponse).rejects.toMatchObject({ name: 'AbortError' }); expect(waiting.requests[0].aborted).toBe(true);
  const controller = new AbortController();
  const during = transport(request => request.respond(new Readable({ read() { this.push(body.subarray(0, 4)); } })));
  await expect(during.network.download(asset, join(directory, 'cancelled.zip'), { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toMatchObject({ code: 'update_request_cancelled' });
  expect(during.requests[0].aborted).toBe(true); expect(await readdir(directory)).toEqual([]);
});

it('rejects a stream with the right length but wrong SHA and removes its partial file', async () => {
  const client = transport(request => request.respond(Buffer.alloc(body.length)));
  await expect(client.network.download(asset, join(directory, 'wrong.zip'))).rejects.toMatchObject({ code: 'asset_checksum_mismatch' });
  expect(await readdir(directory)).toEqual([]);
});
