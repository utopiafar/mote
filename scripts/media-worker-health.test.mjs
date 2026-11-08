import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const script = fileURLToPath(new URL('./media-worker-health.mjs', import.meta.url));
const composeFile = fileURLToPath(new URL('../compose.yaml', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mote-media-health-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function writeConfig(root, media) {
  await writeFile(join(root, 'mote.yaml'), JSON.stringify({ version: 1, revision: 0, ...(media === undefined ? {} : { media }) }));
}
function run(root, role) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, role], {
      env: { ...process.env, MOTE_CONFIG_FILE: join(root, 'mote.yaml') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
async function listener(t) {
  const server = createServer(socket => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { server, port: server.address().port };
}
async function closedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('an instance without media keeps both deliberately idle workers healthy', async t => {
  const root = await fixture(t);
  await writeConfig(root, undefined);
  for (const role of ['ocr', 'asr']) assert.equal((await run(root, role)).code, 0, `${role} must treat an unconfigured deployment as healthy`);
});

test('a configured OCR worker is healthy when its own port accepts connections', async t => {
  const root = await fixture(t);
  const { port } = await listener(t);
  await writeConfig(root, { modelDirectory: './models', workerToken: 'generated-worker-token', ocrPort: port });
  assert.equal((await run(root, 'ocr')).code, 0);
});

test('a configured OCR worker whose port is closed is unhealthy within the Compose timeout', async t => {
  const root = await fixture(t);
  await writeConfig(root, { modelDirectory: './models', workerToken: 'generated-worker-token', ocrPort: await closedPort() });
  const started = Date.now();
  const result = await run(root, 'ocr');
  assert.equal(result.code, 1);
  assert.ok(Date.now() - started < 5000, 'the probe must finish inside the 5s Compose healthcheck timeout');
});

test('an ASR-only deployment leaves OCR idle and follows the ASR port', async t => {
  const root = await fixture(t);
  const { server, port } = await listener(t);
  await writeConfig(root, { modelDirectory: './models', workerToken: 'generated-worker-token', asrPort: port });
  assert.equal((await run(root, 'ocr')).code, 0, 'a role without its own port is not configured');
  assert.equal((await run(root, 'asr')).code, 0);
  await new Promise(resolve => server.close(resolve));
  assert.equal((await run(root, 'asr')).code, 1);
});

test('an unknown worker role is rejected with usage instead of reporting health', async t => {
  const root = await fixture(t);
  await writeConfig(root, {});
  const result = await run(root, 'dialogue');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Usage: node scripts\/media-worker-health\.mjs <ocr\|asr>/);
});

function workerHealthProblems(compose) {
  const services = compose.services ?? {};
  const effective = name => {
    const service = services[name] ?? {};
    const base = service.extends ? services[typeof service.extends === 'string' ? service.extends : service.extends.service] ?? {} : {};
    return { ...base, ...service };
  };
  const problems = [];
  for (const [name, role] of [['ocr-worker', 'ocr'], ['asr-worker', 'asr']]) {
    const service = effective(name);
    const expected = ['CMD', 'node', 'scripts/media-worker-health.mjs', role];
    if (JSON.stringify(service.healthcheck?.test) !== JSON.stringify(expected)) problems.push(`${name} must probe its own ${role} port`);
    if (service.depends_on?.mote?.condition !== 'service_healthy') problems.push(`${name} must wait for a healthy Central`);
  }
  return problems;
}

test('Compose probes each worker itself and waits for a healthy Central', async () => {
  const compose = parse(await readFile(composeFile, 'utf8'));
  assert.deepEqual(workerHealthProblems(compose), []);
  const stale = structuredClone(compose);
  stale.services['ocr-worker'].healthcheck.test = ['CMD', 'node', 'apps/server/dist/healthcheck.js', '--shared-network'];
  stale.services['ocr-worker'].depends_on.mote.condition = 'service_started';
  assert.deepEqual(workerHealthProblems(stale), [
    'ocr-worker must probe its own ocr port',
    'ocr-worker must wait for a healthy Central',
    'asr-worker must wait for a healthy Central',
  ]);
});
