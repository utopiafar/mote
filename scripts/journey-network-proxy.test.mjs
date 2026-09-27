import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { command, startProxy } from './journey-network-proxy.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mote-network-fixture-'));
  const received = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url === '/slow') return;
    if (req.headers['x-large']) { res.writeHead(201).end(Buffer.alloc(21)); return; }
    if (req.headers['x-fail']) { res.writeHead(422, { 'content-type': 'application/json', 'x-result': 'invalid' }).end('{"error":"fixture"}'); return; }
    if (req.headers['x-truncate']) { res.writeHead(201, { 'content-length': 100 }); res.write('partial'); setImmediate(() => res.destroy()); return; }
    res.writeHead(201, { 'content-type': 'application/octet-stream', 'x-result': 'committed' });
    res.write(Buffer.from([0, 1, 255]));
    res.end(Buffer.from('fixture receipt'));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const control = join(directory, 'control.json');
  const config = { upstream: `http://127.0.0.1:${upstream.address().port}`, control, ...options };
  let proxy = await startProxy(config);
  t.after(async () => { await proxy.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { control, received, get proxy() { return proxy; }, async restart() { await proxy.close(); proxy = await startProxy(config); } };
}
function send(url, { path = '/api/notes', body = Buffer.from('fixture private body'), headers = {}, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${url}${path}`, { method, headers: { 'content-type': 'application/octet-stream', authorization: 'Bearer fixture-secret', 'content-length': body.length, ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once('error', reject);
    });
    request.once('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('Test timeout')));
    request.end(body);
  });
}

test('default pass-through preserves bytes, query, authorization and content headers', async t => {
  const f = await fixture(t);
  const body = Buffer.from([0, 255, 13, 10, 42]);
  const result = await send(f.proxy.url, { path: '/api/notes?fixture=1', body });
  assert.equal(result.status, 201);
  assert.equal(result.headers['x-result'], 'committed');
  assert.equal(result.headers['content-type'], 'application/octet-stream');
  assert.deepEqual(result.body, Buffer.concat([Buffer.from([0, 1, 255]), Buffer.from('fixture receipt')]));
  assert.deepEqual(f.received[0].body, body);
  assert.equal(f.received[0].url, '/api/notes?fixture=1');
  assert.equal(f.received[0].headers.authorization, 'Bearer fixture-secret');
  await assert.rejects(readFile(f.proxy.receiptPath), { code: 'ENOENT' });
});

for (const path of ['/api/captures', '/api/captures/batch', '/api/captures/bundle', '/api/notes']) {
  test(`arm drops ACK only after complete successful response: ${path}`, async t => {
    const f = await fixture(t);
    await command(f.control, 'arm');
    await assert.rejects(send(f.proxy.url, { path }));
    assert.equal(f.received.length, 1, 'fake upstream received request before client failed');
    const receiptText = await readFile(f.proxy.receiptPath, 'utf8');
    const receipt = JSON.parse(receiptText);
    assert.equal(receipt.event, 'upstream-success-ack-dropped');
    assert.equal(receipt.path, path);
    assert.equal(receipt.status, 201);
    const expected = Buffer.concat([Buffer.from([0, 1, 255]), Buffer.from('fixture receipt')]);
    assert.equal(receipt.bodyBytes, expected.length);
    assert.equal(receipt.bodySha256, createHash('sha256').update(expected).digest('hex'));
    assert.ok(!receiptText.includes('fixture-secret'));
    assert.ok(!receiptText.includes('fixture private body'));
    assert.ok(!receiptText.includes('fixture receipt'));
    assert.deepEqual(Object.keys(receipt).sort(), ['bodyBytes', 'bodySha256', 'commandId', 'event', 'path', 'status', 'time'].sort());
    assert.equal((await stat(f.proxy.receiptPath)).mode & 0o077, 0);
    await assert.rejects(send(f.proxy.url, { path }));
    assert.equal(f.received.length, 1, 'offline must not contact upstream');
    await f.restart();
    await assert.rejects(send(f.proxy.url, { path }));
    await command(f.control, 'arm');
    await assert.rejects(send(f.proxy.url, { path }));
    assert.equal(f.received.length, 1, 'arm alone cannot recover offline mode');
    await command(f.control, 'recover');
    assert.equal((await send(f.proxy.url, { path })).status, 201);
    assert.equal(f.received.length, 2, 'normal retransmission reaches upstream; deduplication is upstream responsibility');
    assert.equal((await readFile(f.proxy.receiptPath, 'utf8')).trim().split('\n').length, 1);
  });
}

test('error response and non-target path do not consume arm', async t => {
  const f = await fixture(t);
  await command(f.control, 'arm');
  const error = await send(f.proxy.url, { headers: { 'x-fail': 'yes' } });
  assert.equal(error.status, 422);
  assert.equal(error.headers['x-result'], 'invalid');
  assert.equal(error.body.toString(), '{"error":"fixture"}');
  assert.equal((await send(f.proxy.url, { path: '/api/notes/other' })).status, 201);
  assert.equal((await send(f.proxy.url, { method: 'PUT' })).status, 201);
  await assert.rejects(readFile(f.proxy.receiptPath), { code: 'ENOENT' });
  await assert.rejects(send(f.proxy.url));
  assert.equal(JSON.parse(await readFile(f.proxy.receiptPath, 'utf8')).status, 201);
});

test('partial 2xx cannot count as a complete success receipt and arm remains available', async t => {
  const f = await fixture(t);
  await command(f.control, 'arm');
  await assert.rejects(send(f.proxy.url, { headers: { 'x-truncate': 'yes' } }));
  await assert.rejects(readFile(f.proxy.receiptPath), { code: 'ENOENT' });
  await assert.rejects(send(f.proxy.url));
  assert.equal(JSON.parse(await readFile(f.proxy.receiptPath, 'utf8')).status, 201);
});

test('upstream wait and buffered response bytes are bounded', async t => {
  const f = await fixture(t, { timeoutMs: 100, maxBytes: 20 });
  await assert.rejects(send(f.proxy.url, { path: '/slow', body: Buffer.from('small') }));
  await command(f.control, 'arm');
  await assert.rejects(send(f.proxy.url, { body: Buffer.alloc(21) }));
  await assert.rejects(send(f.proxy.url, { body: Buffer.from('small'), headers: { 'x-large': 'yes' } }));
  await assert.rejects(readFile(f.proxy.receiptPath), { code: 'ENOENT' });
});

test('requires explicit loopback upstream and private absolute control path', async () => {
  await assert.rejects(startProxy({ upstream: 'http://example.com', control: '/tmp/no-write.json' }), /loopback/);
  await assert.rejects(startProxy({ upstream: 'http://127.0.0.1:80/path', control: '/tmp/no-write.json' }), /loopback/);
  await assert.rejects(command('relative.json', 'arm'), /absolute/);
});


test('SIGTERM closes active upstream and downstream connections', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-network-signal-'));
  let upstreamRequest;
  const upstream = http.createServer((req) => { upstreamRequest = req; req.resume(); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['scripts/journey-network-proxy.mjs', '--upstream', `http://127.0.0.1:${upstream.address().port}`, '--port', '0', '--control', join(directory, 'control.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const [line] = await once(child.stdout, 'data');
  const proxy = JSON.parse(line.toString());
  const pending = assert.rejects(send(proxy.listening, { path: '/slow' }));
  await new Promise(resolve => upstream.once('request', resolve));
  const socket = upstreamRequest.socket;
  const closed = once(socket, 'close');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [0, null]);
  await pending;
  await closed;
});
