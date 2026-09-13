#!/usr/bin/env node
// Real Docker integration, synthetic data only. No image publication or model API calls.
// Requires Node 24+ and a running Docker daemon; no npm dependencies are needed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runId = randomUUID();
const image = `mote-container-fixture:${runId}`;
const container = `mote-container-fixture-${runId}`;
const volume = `mote-container-fixture-${runId}`;
const fixtureToken = `synthetic-container-token-only-${runId}`;
const dockerEnv = { ...process.env, MOTE_TOKEN: fixtureToken, MOTE_DATA_KEY: randomBytes(32).toString('hex') };
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(`Interrupted by ${signal}`)));
let daemonAvailable = false;

function docker(args, { capture = false, timeoutMs = 120_000, cleanup = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!cleanup && abort.signal.aborted) { reject(abort.signal.reason); return; }
    const child = spawn('docker', args, { cwd: root, env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failure, finished = false;
    const stop = reason => { failure = reason; child.kill('SIGKILL'); };
    const onAbort = () => stop(abort.signal.reason ?? new Error('Container check interrupted'));
    const timer = setTimeout(() => stop(new Error(`docker ${args[0]} timed out after ${timeoutMs} ms`)), timeoutMs);
    if (!cleanup) abort.signal.addEventListener('abort', onAbort, { once: true });
    const consume = (chunk, stream) => {
      if (!capture) stream.write(chunk);
      else {
        output += chunk.toString('utf8');
        if (Buffer.byteLength(output) > 2 * 1024 * 1024) stop(new Error('Docker command output exceeded 2 MiB'));
      }
    };
    child.stdout.on('data', chunk => consume(chunk, process.stdout));
    child.stderr.on('data', chunk => consume(chunk, process.stderr));
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer); abort.signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(output.trim());
    };
    child.once('error', error => finish(new Error(`Cannot run Docker: ${error.message}. Install Docker and start its daemon.`)));
    child.once('close', code => finish(failure ?? (code === 0 ? undefined : new Error(`docker ${args[0]} exited ${code}${capture && output ? `: ${output.trim()}` : ''}`))));
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (abort.signal.aborted) throw abort.signal.reason;
    const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', container], { capture: true }));
    assert.equal(state.Running, true, `Container stopped before becoming healthy (exit ${state.ExitCode})`);
    if (state.Health?.Status === 'healthy') return;
    assert.ok(state.Health, 'The image must supply a Docker HEALTHCHECK');
    await sleep(1000, undefined, { signal: abort.signal });
  }
  throw new Error('Container did not reach Docker healthy status within 120 seconds');
}

async function startContainer() {
  await docker(['run', '--detach', '--name', container, '--label', `dev.mote.fixture=${runId}`,
    '--publish', '127.0.0.1::47832', '--mount', `type=volume,source=${volume},target=/data`,
    '--env', 'MOTE_TOKEN', '--env', 'MOTE_DATA_KEY',
    '--health-interval', '2s', '--health-start-period', '1s', '--health-timeout', '5s', '--health-retries', '30', image], { capture: true });
  await waitForHealth();
  return baseUrl();
}
async function baseUrl() {
  const published = await docker(['port', container, '47832/tcp'], { capture: true });
  assert.match(published, /^127\.0\.0\.1:\d+$/, 'Only a random loopback port may be exposed');
  return `http://${published}`;
}

async function request(base, path, { status = 200, method = 'GET', body, token = fixtureToken } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: expected HTTP ${status}, got ${response.status}: ${text.slice(0, 1000)}`);
  return { response, text, json: () => JSON.parse(text) };
}

const note = {
  id: randomUUID(), deviceId: `container-fixture-${runId}`, deviceName: 'Synthetic Docker fixture', platform: 'linux',
  capturedAt: new Date().toISOString(), text: '  合成容器验收随手记\n验证原文、幂等与重启持久化。  ', mood: '平静（合成）',
};
async function assertSavedNote(base) {
  const saved = (await request(base, `/api/notes/${note.id}`)).json();
  assert.equal(saved.id, note.id); assert.equal(saved.deviceId, note.deviceId);
  assert.equal(saved.source, 'note'); assert.equal(saved.durationMs, 0);
  assert.equal(saved.ocrText, note.text, 'Note whitespace and original text must survive unchanged');
  assert.equal(saved.mood, note.mood); assert.equal(saved.capturedAt, note.capturedAt);
  assert.equal(saved.blobHash, null, 'A manual note must not create a fabricated image blob');
  const list = (await request(base, `/api/notes?deviceId=${note.deviceId}`)).json();
  assert.ok(Array.isArray(list.items));
  assert.equal(list.items.length, 1, 'Repeated submissions must not create another note');
  assert.equal(list.items[0].id, note.id);
}
async function assertDuplicate(base) {
  const duplicate = (await request(base, '/api/notes', { method: 'POST', status: 200, body: note })).json();
  assert.equal(duplicate.id, note.id); assert.equal(duplicate.duplicate, true);
  await assertSavedNote(base);
}

try {
  await docker(['version', '--format', '{{.Server.Version}}'], { capture: true, timeoutMs: 30_000 });
  daemonAvailable = true;
  console.info('[container] Building the repository Dockerfile (local tag only)');
  await docker(['build', '--tag', image, '--file', 'Dockerfile', '.'], { timeoutMs: 15 * 60_000 });
  await docker(['volume', 'create', '--label', `dev.mote.fixture=${runId}`, volume], { capture: true });
  let base = await startContainer();
  assert.equal((await request(base, '/api/health', { token: null })).json().ok, true);
  const page = await request(base, '/', { token: null });
  assert.match(page.response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(page.text, /<div id="root"><\/div>/, 'Built web UI must be served from the runtime image');
  await request(base, '/api/notes', { status: 401, token: null });
  await request(base, '/api/notes', { status: 401, token: 'synthetic-wrong-token-only' });
  await request(base, '/api/notes', { method: 'POST', body: note, status: 401, token: null });
  console.info('[container] Healthy runtime, bundled web UI and 401 authentication checks passed');
  const created = (await request(base, '/api/notes', { method: 'POST', status: 201, body: note })).json();
  assert.equal(created.id, note.id); assert.equal(created.duplicate, false);
  await assertSavedNote(base); await assertDuplicate(base);
  console.info('[container] Synthetic note create/read and duplicate ACK checks passed');
  await docker(['restart', '--time', '10', container], { capture: true });
  await waitForHealth(); base = await baseUrl();
  await assertSavedNote(base); await assertDuplicate(base);
  console.info('[container] Same-container restart preserved the note and idempotency key');
  // Recreating with the same named /data volume also rules out accidental storage in the writable container layer.
  await docker(['rm', '--force', container], { capture: true });
  base = await startContainer();
  await assertSavedNote(base); await assertDuplicate(base);
  await request(base, '/api/notes', { status: 401, token: null });
  console.info('[container] Replacement container recovered the named volume; all real Docker checks passed');
} catch (error) {
  console.error(`[container] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  if (daemonAvailable) {
    await docker(['logs', '--tail', '160', container], { cleanup: true, timeoutMs: 15_000 }).catch(() => undefined);
    await docker(['inspect', '--format', '{{json .State}}', container], { cleanup: true, timeoutMs: 15_000 }).catch(() => undefined);
  }
  process.exitCode = 1;
} finally {
  if (daemonAvailable) {
    // Exact UUID names only: never prune unrelated containers, volumes, images or build caches.
    await docker(['rm', '--force', container], { capture: true, cleanup: true, timeoutMs: 30_000 }).catch(() => undefined);
    await docker(['volume', 'rm', volume], { capture: true, cleanup: true, timeoutMs: 30_000 }).catch(() => undefined);
    await docker(['image', 'rm', image], { capture: true, cleanup: true, timeoutMs: 30_000 }).catch(() => undefined);
  }
}
