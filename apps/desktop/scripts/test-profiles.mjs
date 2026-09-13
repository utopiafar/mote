import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const electron = require('electron'), directory = dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'mote-native-profiles-'));
await writeFile(join(root, 'fixture-marker'), 'synthetic-only', { mode: 0o600 });
async function worker(name, phase) {
  const child = spawn(electron, [join(directory, 'profile-smoke.cjs'), `--fixture-root=${root}`, `--profile=${name}`, `--phase=${phase}`], { stdio: ['ignore','pipe','pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  assert.equal(code, 0, `Native ${name}/${phase} failed: ${stderr.slice(-2500)}`);
  const result = stdout.trim().split('\n').map(line => { try { return JSON.parse(line); } catch { return undefined; } }).find(v => v?.ok);
  assert(result); process.stdout.write(JSON.stringify(result) + '\n');
}
try {
  const written = await Promise.allSettled(['dev','test'].map(name => worker(name, 'write')));
  for (const result of written) if (result.status === 'rejected') throw result.reason;
  const dev = JSON.parse(await readFile(join(root, 'dev-identity.json'), 'utf8'));
  const test = JSON.parse(await readFile(join(root, 'test-identity.json'), 'utf8'));
  assert.notEqual(dev.deviceId, test.deviceId);
  const restarted = await Promise.allSettled(['dev','test'].map(name => worker(name, 'read')));
  for (const result of restarted) if (result.status === 'rejected') throw result.reason;
  process.stdout.write(JSON.stringify({ ok: true, separateElectronInstances: true, restartIdentityAndDraft: true, independentCredentialsAndOutbox: true, noCaptureOrModels: true }) + '\n');
} finally { await rm(root, { recursive: true, force: true }); }
