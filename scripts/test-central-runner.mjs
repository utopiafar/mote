// Isolated supervisor fixtures only: generated output, no central node, model or profile startup.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, stat, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { command } from './profile-fixtures.mjs';
import { repository } from './profile-lib.mjs';

const directory = await mkdtemp(join(tmpdir(), 'mote-central-runner-fixture-'));
const runner = join(repository, 'scripts/central-runner.mjs');
const settings = { MOTE_LOG_MAX_MB: '0.1', MOTE_LOG_MAX_FILES: '3' };
const launch = (entry, log) => [runner, entry, log, `--mote-instance=${randomUUID()}`];
try {
  const noisy = join(directory, 'noisy.mjs'), log = join(directory, 'bounded.log');
  await writeFile(noisy, "process.stdout.write('synthetic-private-body\\n'.repeat(60000)); process.stderr.write('synthetic-private-token'.repeat(100000));");
  const started = performance.now();
  for (let i = 0; i < 2; i++) assert.equal((await command(process.execPath, launch(noisy, log), { env: settings })).code, 0);
  const names = (await readdir(directory)).filter(name => name.startsWith('bounded.log'));
  assert.equal(names.length, 3);
  for (const name of names) {
    const path = join(directory, name), info = await stat(path);
    assert.ok(info.size <= Math.floor(0.1 * 1024 * 1024)); assert.equal(info.mode & 0o777, 0o600);
    assert.ok(!(await readFile(path, 'utf8')).includes('synthetic-private'));
  }
  const noisyMs = performance.now() - started;

  const tail = join(directory, 'tail.mjs'), tailLog = join(directory, 'tail.log');
  await writeFile(tail, `process.stdout.write('synthetic-private-body\\n'); process.stdout.write('{"event":"server.'); setTimeout(() => { process.stdout.write('listening","port":12345,"tokenConfigured":true,"secret":"synthetic-private-token"}'); process.exitCode=7; },10);`);
  assert.equal((await command(process.execPath, launch(tail, tailLog), { env: settings })).code, 7);
  const tailEvents = (await readFile(tailLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(tailEvents, [{ event: 'process.output_suppressed', stream: 'stdout', bytes: 22 }, { event: 'server.listening', port: 12345, tokenConfigured: true }]);

  const shutdown = join(directory, 'shutdown.mjs'), shutdownLog = join(directory, 'shutdown.log');
  await writeFile(shutdown, `process.on('SIGTERM',()=>{process.stdout.write('{"event":"server.stopped","secret":"synthetic-private-token"}');process.exit(0);}); console.log('{"event":"server.listening","port":12345}');setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, launch(shutdown, shutdownLog), { cwd: repository, env: { ...process.env, ...settings }, stdio: 'ignore' });
  const closed = new Promise(resolve => child.once('close', code => resolve(code)));
  try {
    const deadline = Date.now() + 10000;
    while (!(await readFile(shutdownLog, 'utf8').catch(() => '')).includes('server.listening')) { assert.ok(Date.now() < deadline, 'Supervisor must flush while child remains active'); await new Promise(resolve => setTimeout(resolve, 20)); }
    child.kill('SIGTERM');
    assert.equal(await Promise.race([closed, new Promise(resolve => { const timer = setTimeout(() => resolve('timeout'), 10000); timer.unref(); })]), 0);
    assert.deepEqual((await readFile(shutdownLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line)), [{ event: 'server.listening', port: 12345 }, { event: 'server.stopped' }]);
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); }

  const failedLog = join(directory, 'unwritable.log'); await mkdir(failedLog);
  assert.equal((await command(process.execPath, launch(shutdown, failedLog), { env: settings, timeoutMs: 10000 })).code, 1, 'Disk write failure must terminate the child and return failure');
  console.info(JSON.stringify({ status: 'passed', noisyRestarts: 2, stdoutLinesPerRestart: 60000, stderrBytesPerRestart: Buffer.byteLength('synthetic-private-token') * 100000, noisyMs: Math.round(noisyMs), boundedFiles: 3, fileMode: '0600', privateContentSuppressed: true, splitFinalLineFlushed: true, childExitCodePreserved: true, signalFlush: true, diskFailureStopsChild: true }));
} finally { await rm(directory, { recursive: true, force: true }); }
