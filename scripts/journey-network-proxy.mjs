#!/usr/bin/env node
// Isolated journey fault injector. Never reads tokens or request bodies into receipts.
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = new Set(['/api/captures', '/api/captures/batch', '/api/captures/bundle', '/api/notes']);
const HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function headersFor(headers) {
  const result = { ...headers };
  for (const key of [...HOP, ...String(headers.connection ?? '').split(',').map(x => x.trim().toLowerCase())]) delete result[key];
  return result;
}
async function privateDirectory(control) {
  if (!isAbsolute(control) || control === REPOSITORY || control.startsWith(`${REPOSITORY}/`)) throw new Error('Control path must be absolute and outside the repository.');
  await mkdir(dirname(control), { recursive: true, mode: 0o700 });
  if ((await stat(dirname(control))).mode & 0o077) throw new Error('Control directory must be private (chmod 700).');
}
async function readJson(path, fallback) {
  try {
    const handle = await open(path, 'r');
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 8192 || metadata.mode & 0o077) throw new Error('Invalid private control/state file.');
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function writeJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}
export async function command(control, action) {
  if (!['arm', 'recover'].includes(action)) throw new Error('Expected arm or recover.');
  await privateDirectory(control);
  await writeJson(control, { id: randomUUID(), action });
}
export async function startProxy({ upstream, port = 0, control, timeoutMs = 30_000, maxBytes = 32 * 1024 * 1024, maxConcurrent = 32 }) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Upstream must be an explicit loopback HTTP origin.');
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('Invalid bounds.');
  await privateDirectory(control);
  const statePath = `${control}.state.json`;
  const receiptPath = `${control}.receipts.jsonl`;
  let state = await readJson(statePath, { mode: 'online', commandId: null });
  if (!['online', 'armed', 'offline'].includes(state.mode)) throw new Error('Invalid persisted proxy state.');
  let serial = Promise.resolve();
  const locked = fn => { const next = serial.then(fn); serial = next.catch(() => {}); return next; };
  async function refresh() {
    const request = await readJson(control, null);
    if (!request || request.id === state.commandId) return;
    if (typeof request.id !== 'string' || !['arm', 'recover'].includes(request.action)) throw new Error('Invalid proxy command.');
    // Arming does not silently bring an offline transport back online.
    state = { commandId: request.id, mode: request.action === 'recover' ? 'online' : state.mode === 'offline' ? 'offline' : 'armed' };
    await writeJson(statePath, state);
  }
  const sockets = new Set();
  const upstreamRequests = new Set();
  const activeFailures = new Set();
  let candidate = false;
  let active = 0;
  const server = http.createServer(async (request, response) => {
    if (++active > maxConcurrent) { --active; response.writeHead(503).end(); return; }
    let settled = false;
    let ownsCandidate = false;
    let outgoing;
    let timer;
    const finish = () => {
      if (settled) return;
      settled = true;
      --active;
      clearTimeout(timer);
      if (outgoing) upstreamRequests.delete(outgoing);
      if (ownsCandidate) candidate = false;
      activeFailures.delete(fail);
    };
    response.once('close', () => { if (!response.writableFinished) outgoing?.destroy(); finish(); });
    response.once('finish', finish);
    const fail = () => { outgoing?.destroy(); response.destroy(); finish(); };
    activeFailures.add(fail);
    try {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      const mode = await locked(async () => {
        await refresh();
        if (state.mode === 'armed' && !candidate && request.method === 'POST' && TARGETS.has(pathname)) candidate = ownsCandidate = true;
        return state.mode;
      });
      if (mode === 'offline' || settled) { fail(); return; }
      timer = setTimeout(fail, timeoutMs);
      const headers = headersFor(request.headers);
      headers.host = target.host;
      outgoing = http.request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 80, method: request.method, path: request.url, headers }, incoming => {
        let responseBytes = 0;
        const chunks = [];
        const successfulCandidate = ownsCandidate && incoming.statusCode >= 200 && incoming.statusCode < 300;
        if (!successfulCandidate) response.writeHead(incoming.statusCode, headersFor(incoming.headers));
        incoming.on('data', chunk => {
          responseBytes += chunk.length;
          if (responseBytes > maxBytes) { incoming.destroy(); fail(); return; }
          if (successfulCandidate) chunks.push(chunk);
          else if (!response.write(chunk)) { incoming.pause(); response.once('drain', () => incoming.resume()); }
        });
        incoming.once('aborted', fail);
        incoming.once('error', fail);
        incoming.once('end', async () => {
          try {
            if (settled || !incoming.complete) { fail(); return; }
            if (!successfulCandidate) { response.end(); return; }
            const bytes = Buffer.concat(chunks);
            const dropped = await locked(async () => {
              await refresh();
              if (state.mode !== 'armed' || settled) return false;
              const receipt = { event: 'upstream-success-ack-dropped', commandId: state.commandId, path: pathname, status: incoming.statusCode, time: new Date().toISOString(), bodyBytes: bytes.length, bodySha256: createHash('sha256').update(bytes).digest('hex') };
              const log = await open(receiptPath, 'a', 0o600);
              try { await log.writeFile(`${JSON.stringify(receipt)}\n`); await log.sync(); } finally { await log.close(); }
              state = { ...state, mode: 'offline' };
              await writeJson(statePath, state);
              return true;
            });
            if (dropped) { for (const abort of activeFailures) abort(); return; }
            if (state.mode === 'offline') { fail(); return; }
            response.writeHead(incoming.statusCode, headersFor(incoming.headers));
            response.end(bytes);
          } catch { fail(); }
        });
      });
      upstreamRequests.add(outgoing);
      outgoing.once('error', fail);
      let requestBytes = 0;
      request.on('data', chunk => { requestBytes += chunk.length; if (requestBytes > maxBytes) fail(); });
      request.once('aborted', fail);
      request.once('error', fail);
      request.pipe(outgoing);
    } catch { fail(); }
  });
  server.maxConnections = maxConcurrent;
  server.requestTimeout = timeoutMs;
  server.headersTimeout = Math.min(timeoutMs, 10_000);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`, receiptPath, statePath,
    async close() {
      for (const request of upstreamRequests) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      await serial;
    },
  };
}
async function main() {
  const args = process.argv.slice(2);
  const action = ['arm', 'recover'].includes(args[0]) ? args.shift() : 'serve';
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!['--control', '--upstream', '--port'].includes(key) || !args.length) throw new Error('Usage: journey-network-proxy.mjs [arm|recover] --control /private/path/control.json [--upstream http://127.0.0.1:PORT --port PORT]');
    options[key.slice(2)] = args.shift();
  }
  if (!options.control) throw new Error('--control is required.');
  if (action !== 'serve') { await command(options.control, action); return; }
  if (!options.upstream || !options.port) throw new Error('--upstream and --port are required.');
  const proxy = await startProxy({ ...options, port: Number(options.port) });
  console.log(JSON.stringify({ listening: proxy.url, receiptPath: proxy.receiptPath }));
  let stopping = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void proxy.close().then(() => process.exit(0), () => process.exit(1));
  });
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(error => { console.error(error.message); process.exitCode = 1; });
