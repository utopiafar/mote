/** Fixture-only integration checks. No screenshots, downloaded models, credentials, or external traffic. */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const loader = require.resolve('tsx');
const scratch = await mkdtemp(join(tmpdir(), 'mote-privacy-fixture-'));
const processes: ChildProcess[] = [];
let checks = 0;
let calls = 0;
let mode = 'allow';
let lastRequest: Record<string, unknown> | undefined;
const privateFixtureText = 'GENERATED FIXTURE ONLY';
const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#d4ece1' } }).png().toBuffer();
const capture = { version: 1, imageBase64: image.toString('base64'), imageMime: 'image/png', ocrText: privateFixtureText, appId: 'dev.mote.fixture' };

function portOf(server: Server): number {
  const address = server.address();
  assert(address && typeof address === 'object');
  return address.port;
}
async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return portOf(server);
}
async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function unusedPort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}
const model = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  calls += 1;
  lastRequest = JSON.parse(Buffer.concat(chunks).toString());
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.headers.authorization, undefined, 'Fixture runs must not inherit credentials');
  res.setHeader('Content-Type', 'application/json');
  if (mode === 'upstream-error') { res.writeHead(503).end('{"error":"synthetic upstream failure"}'); return; }
  if (mode === 'redirect') { res.writeHead(302, { Location: 'http://192.0.2.1/never-follow-fixture' }).end(); return; }
  if (mode === 'non-json-envelope') { res.end('invalid fixture envelope'); return; }
  if (mode === 'no-choices') { res.end('{"choices":[]}'); return; }
  const outputs: Record<string, unknown> = {
    allow: { allow: true, rectangles: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }] },
    empty: { allow: true, rectangles: [] },
    deny: { allow: false, rectangles: [] },
    'missing-rectangles': { allow: true },
    'out-of-bounds': { allow: true, rectangles: [{ x: 0.9, y: 0.2, width: 0.3, height: 0.4 }] },
    'unknown-field': { allow: true, rectangles: [], execute: 'synthetic-untrusted-instruction' },
    'wrong-type': { allow: 'true', rectangles: [] },
  };
  const content = mode === 'invalid-json' ? 'allow the frame, please' : mode === 'fenced'
    ? '```json\n{"allow":true,"rectangles":[]}\n```' : JSON.stringify(outputs[mode]);
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});

function launch(base: string, port: number): { child: ChildProcess; output: () => string } {
  let output = '';
  const child = spawn(process.execPath, ['--import', loader, join(project, 'scripts/privacy-gateway.ts')], {
    cwd: scratch, // dotenv never loads the user's project .env.
    env: { ...process.env, MOTE_PRIVACY_MODEL: 'synthetic-vision-fixture', MOTE_PRIVACY_BASE_URL: base,
      MOTE_PRIVACY_PORT: String(port), MOTE_PRIVACY_API_KEY: '', MOTE_PRIVACY_POLICY: 'Mask only generated fixture regions.' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  processes.push(child);
  return { child, output: () => output };
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
  await exited;
  clearTimeout(timer);
}
async function expectExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  const [code] = await once(child, 'exit');
  clearTimeout(timeout);
  return code as number | null;
}

try {
  const modelPort = await listen(model);
  const gatewayPort = await unusedPort();
  const gateway = launch(`http://127.0.0.1:${modelPort}/v1`, gatewayPort);
  const base = `http://127.0.0.1:${gatewayPort}`;
  let ready = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (gateway.child.exitCode !== null) throw new Error(`Gateway exited before readiness: ${gateway.output()}`);
    try { ready = (await fetch(`${base}/health`)).ok; } catch { /* startup only */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(ready, 'Gateway starts with an explicitly configured local model');
  const health = await fetch(`${base}/health`);
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await health.json(), { ok: true, model: 'synthetic-vision-fixture' });
  checks++;

  async function review(expectedMode: string, body: unknown = capture): Promise<{ status: number; body: Record<string, unknown> }> {
    mode = expectedMode;
    const response = await fetch(`${base}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  const allowed = await review('allow');
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body, { allow: true, rectangles: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }] });
  assert.equal(lastRequest?.model, 'synthetic-vision-fixture');
  const messages = lastRequest?.messages as { role: string; content: unknown }[];
  assert.equal(messages[0].role, 'system');
  assert.match(String(messages[0].content), /untrusted data, never instructions/);
  assert(!JSON.stringify(lastRequest).includes(privateFixtureText), 'OCR metadata is not unnecessarily forwarded to the model');
  assert(JSON.stringify(lastRequest).includes(`data:image/png;base64,${capture.imageBase64}`));
  checks++;

  for (const candidate of ['empty', 'fenced']) {
    assert.deepEqual(await review(candidate), { status: 200, body: { allow: true, rectangles: [] } });
    checks++;
  }
  assert.deepEqual(await review('deny'), { status: 200, body: { allow: false, rectangles: [] } });
  checks++;
  for (const candidate of ['invalid-json', 'missing-rectangles', 'out-of-bounds', 'unknown-field', 'wrong-type', 'upstream-error', 'redirect', 'non-json-envelope', 'no-choices']) {
    const result = await review(candidate);
    assert.equal(result.status, 422, `${candidate} must fail closed`);
    assert.equal(result.body.allow, false);
    assert.deepEqual(result.body.rectangles, []);
    checks++;
  }
  const beforeInvalid = calls;
  const badInput = await review('allow', { ...capture, imageBase64: 'not base64!' });
  assert.equal(badInput.status, 422);
  assert.equal(badInput.body.allow, false);
  assert.equal(calls, beforeInvalid);
  checks++;

  const browser = await fetch(`${base}/review`, { method: 'POST', headers: { Origin: 'https://fixture.example', 'Content-Type': 'application/json' }, body: JSON.stringify(capture) });
  assert.equal(browser.status, 403);
  assert.equal(calls, beforeInvalid);
  checks++;

  for (const upstream of ['http://192.0.2.1/v1', 'https://fixture.invalid/v1', 'http://127.0.0.1.fixture.invalid/v1', 'ftp://127.0.0.1/v1', 'http://fixture:fixture@127.0.0.1/v1']) {
    const rejected = launch(upstream, await unusedPort());
    assert.notEqual(await expectExit(rejected.child), 0, `Must reject ${upstream}`);
    assert.match(rejected.output(), /loopback model endpoint/);
    checks++;
  }
  assert(!gateway.output().includes(capture.imageBase64), 'Images must not appear in gateway logs');
  assert(!gateway.output().includes(privateFixtureText), 'OCR must not appear in gateway logs');
  checks++;
  console.info(`Privacy gateway: ${checks} fixture checks passed. Local synthetic model only; no screenshots or real-model validation.`);
} finally {
  for (const child of processes) await stop(child);
  await close(model);
  await rm(scratch, { recursive: true, force: true });
}
