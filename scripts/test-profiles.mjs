#!/usr/bin/env node
// Real central subprocesses, encrypted generated pixels, disposable dev/test profiles only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, stat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { repository, profilePaths, loadProfile, nativeIdentity, stopNative, atomicJson } from './profile-lib.mjs';
import { command, cli, updateEnvironment, initializeFixture, request, note, capture, image } from './profile-fixtures.mjs';

const directory = await mkdtemp(join(tmpdir(), 'mote-profiles-fixture-'));
const home = join(directory, 'profiles'), restoreHome = join(directory, 'restored');
const profiles = [];
try {
  let dev = await initializeFixture(home, 'dev'), test = await initializeFixture(home, 'test'); profiles.push(dev, test);
  assert.notEqual(dev.env.MOTE_TOKEN, test.env.MOTE_TOKEN); assert.notEqual(dev.dataDir, test.dataDir); assert.notEqual(dev.project, test.project);
  assert.equal((await stat(dev.envFile)).mode & 0o777, 0o600);
  assert.equal(dev.env.MOTE_LOG_DIR, './logs'); assert.equal(dev.env.MOTE_LOG_MAX_ENTRIES, '2000'); assert.equal(dev.env.MOTE_AGENT_TRACE_ENABLED, '1'); assert.equal(test.env.MOTE_AGENT_TRACE_ENABLED, '0');
  const hostile = { MOTE_PROFILE: 'prod', MOTE_ENV_FILE: '/missing/formal.env', MOTE_DATA_DIR: '/missing/formal-data', MOTE_TOKEN: 'synthetic-hostile-ambient-token', MOTE_MODEL: 'ambient-model-must-not-load', MOTE_MODEL_API_KEY: 'synthetic-ambient-key', MOTE_DEBUG: '1' };
  const isolated = await cli(home, undefined, 'exec', ['--', process.execPath, '-e', "console.log(JSON.stringify({profile:process.env.MOTE_PROFILE,file:process.env.MOTE_ENV_FILE,model:process.env.MOTE_MODEL,key:process.env.MOTE_MODEL_API_KEY,debug:process.env.MOTE_DEBUG,url:process.env.MOTE_URL}))"], { env: hostile });
  assert.deepEqual(JSON.parse(isolated.stdout), { profile: 'dev', file: dev.envFile, model: '', key: '', debug: '0', url: dev.url });
  await cli(home, 'dev', 'init', [], { fail: true });
  await cli(join(directory, 'reserved'), 'dev', 'init', ['--port', '47832'], { fail: true });
  const originalEnv = await readFile(dev.envFile, 'utf8');
  assert.match(originalEnv, /^MOTE_DATA_DIR=/m);
  await writeFile(dev.envFile, originalEnv.replace(/^MOTE_DATA_DIR=.*$/m, 'MOTE_DATA_DIR=../test/data'));
  await cli(home, 'dev', 'status', [], { fail: true }); await writeFile(dev.envFile, originalEnv);
  const launch = JSON.parse((await cli(home, 'dev', 'launchd')).stdout), xml = await readFile(launch.generated, 'utf8');
  assert.equal(launch.installed, false); assert.ok(xml.includes('/dev/null')); assert.ok(!xml.includes(dev.env.MOTE_TOKEN));
  if (process.platform === 'darwin') assert.equal((await command('plutil', ['-lint', launch.generated])).code, 0);
  console.info('[profiles] Private defaults, explicit environment, reserved formal port and launchd generation passed');

  await cli(home, 'dev', 'start', [], { env: hostile }); await cli(home, 'test', 'start');
  assert.equal(JSON.parse((await cli(home, 'dev', 'status')).stdout).healthy, true);
  await request(dev, '/api/status', { status: 401, token: test.env.MOTE_TOKEN });
  const saved = note(), screen = capture();
  await request(dev, '/api/notes', { method: 'POST', body: saved, status: 201 });
  await request(dev, '/api/captures', { method: 'POST', body: screen, status: 201 });
  assert.equal((await request(test, '/api/notes')).items.length, 0);
  assert.deepEqual(await request(dev, `/api/captures/${screen.id}/image`, { binary: true }), image);
  const source = join(directory, 'selected-files'); await mkdir(source); await writeFile(join(source, 'synthetic.md'), '合成文件同步资料：每个环境独立确认与重试。');
  const importArgs = ['--', process.execPath, '--import', 'tsx', join(repository, 'scripts/import-files.ts'), '--root', source];
  for (const p of [dev, test]) {
    assert.match((await cli(home, p.profile, 'exec', importArgs)).stdout, /Imported 1 changed/);
    assert.match((await cli(home, p.profile, 'exec', importArgs)).stdout, /Imported 0 changed/);
    const syncDirectory=join(p.directory,'file-sync');
    const syncFiles=(await readdir(syncDirectory)).filter(name=>name.endsWith('.json')||name.endsWith('.json.sqlite'));
    const stateFiles=syncFiles.filter(name=>name.endsWith('.json.sqlite')).map(name=>name.slice(0,-7));
    assert.equal(stateFiles.length,1);
    assert.deepEqual(syncFiles.filter(name=>name.endsWith('.atime.json')),[stateFiles[0]+'.atime.json']);
    assert.equal((await stat(join(syncDirectory,stateFiles[0]+'.atime.json'))).mode&0o777,0o600);
  }
  for (const p of [dev, test]) assert.equal((await request(p, '/api/captures?source=file')).items.length, 1);
  await writeFile(join(source, 'explicit-env.md'), 'Synthetic explicit MOTE_ENV_FILE, without process MOTE_URL.');
  for (const p of [dev, test]) {
    const clean = Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('MOTE_')).map(key => [key, undefined]));
    const imported = await command(process.execPath, ['--import', 'tsx', join(repository, 'scripts/import-files.ts'), '--root', source], { env: { ...clean, MOTE_ENV_FILE: p.envFile } });
    assert.equal(imported.code, 0, imported.stderr); assert.match(imported.stdout, /Imported 1 changed/);
    assert.equal((await request(p, '/api/captures?source=file')).items.length, 2);
  }
  await cli(home, 'dev', 'backup', ['--out', join(directory, 'running-backup')], { fail: true });
  assert.equal((await request(dev, `/api/notes/${saved.id}`)).ocrText, saved.text);
  console.info('[profiles] Two real central processes, independent tokens/vaults and encrypted image roundtrip passed');

  await cli(home, 'dev', 'stop');
  const snapshot = join(directory, 'snapshot'); await cli(home, 'dev', 'backup', ['--out', snapshot]);
  const entries = await readdir(snapshot); assert.deepEqual(entries.sort(), ['backup-manifest.json', 'blobs', 'mote.sqlite']);
  const manifest = JSON.parse(await readFile(join(snapshot, 'backup-manifest.json'), 'utf8')); assert.equal(Object.keys(manifest.checksums).length, 2);
  const blob = Object.keys(manifest.checksums).find(name => name.startsWith('blobs/'));
  assert.notDeepEqual(await readFile(join(snapshot, blob)), image, 'Encrypted stored blob must not become plaintext in backup');
  const restored = await initializeFixture(restoreHome, 'test', { dataKey: dev.env.MOTE_DATA_KEY }); profiles.push(restored);
  // An unrelated central process's vault lock also prevents restore, even without our process.json.
  await writeFile(join(restored.dataDir, 'server.pid'), String(process.pid));
  await cli(restoreHome, 'test', 'restore', ['--from', snapshot], { fail: true }); await rm(join(restored.dataDir, 'server.pid'));
  await cli(restoreHome, 'test', 'restore', ['--from', snapshot]); await cli(restoreHome, 'test', 'start');
  assert.equal((await request(restored, `/api/notes/${saved.id}`)).ocrText, saved.text);
  assert.deepEqual(await request(restored, `/api/captures/${screen.id}/image`, { binary: true }), image);
  await cli(restoreHome, 'test', 'stop');
  await cli(restoreHome, 'test', 'restore', ['--from', snapshot], { fail: true });
  const tampered = join(directory, 'tampered'); await cp(snapshot, tampered, { recursive: true }); await writeFile(join(tampered, blob), 'synthetic corruption');
  const before = await readFile(join(restored.dataDir, 'mote.sqlite'));
  await cli(restoreHome, 'test', 'restore', ['--from', tampered], { fail: true }); assert.deepEqual(await readFile(join(restored.dataDir, 'mote.sqlite')), before);
  console.info('[profiles] Offline backup, SHA validation, vault lock, empty-only restore and encrypted blob recovery passed');

  // A separately built release fixture uses the actual server; no semantic/mock API substitutes.
  const release = join(directory, 'release-next'); await mkdir(join(release, 'apps/server/dist'), { recursive: true });
  await writeFile(join(release, 'package.json'), '{"type":"module"}');
  await writeFile(join(release, 'apps/server/dist/index.js'), `import ${JSON.stringify(new URL('apps/server/dist/index.js', 'file://' + repository + '/').href)};\n`);
  await cli(home, 'dev', 'start'); await cli(home, 'dev', 'upgrade', ['--release', release]);
  assert.equal((await request(dev, `/api/notes/${saved.id}`)).ocrText, saved.text);
  const afterUpgrade = note(); await request(dev, '/api/notes', { method: 'POST', body: afterUpgrade, status: 201 });
  await cli(home, 'dev', 'rollback', ['--restore-data']);
  assert.equal((await request(dev, `/api/notes/${saved.id}`)).ocrText, saved.text);
  await request(dev, `/api/notes/${afterUpgrade.id}`, { status: 404 });
  assert.deepEqual(await request(dev, `/api/captures/${screen.id}/image`, { binary: true }), image);
  assert.ok((await readdir(dev.directory)).some(name => name.startsWith('data.before-rollback-')));
  dev = await loadProfile(profilePaths('dev', home));
  assert.equal(dev.meta.release, repository); assert.ok(dev.meta.previous.backup.includes('pre-rollback-'));
  const supervisor = await nativeIdentity(dev); process.kill(supervisor.record.pid, 'SIGKILL');
  const orphanDeadline = Date.now() + 5000;
  while (!(await nativeIdentity(dev)).recoveredChild) { if (Date.now() > orphanDeadline) throw Error('Killed supervisor child was not recovered'); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.equal(JSON.parse((await cli(home, 'dev', 'status')).stdout).recoveredChild, true);
  const foreground = spawn(process.execPath, [join(repository, 'scripts/mote.mjs'), 'run', '--profile', 'dev', '--home', home], { cwd: repository, stdio: 'ignore' });
  const foregroundExit = new Promise(resolve => foreground.once('close', code => resolve(code)));
  try {
    await new Promise(resolve => setTimeout(resolve, 500)); assert.equal(foreground.exitCode, null, 'Recovered run must continue supervising');
    foreground.kill('SIGTERM');
    assert.equal(await Promise.race([foregroundExit, new Promise(resolve => { const timer = setTimeout(() => resolve('timeout'), 10000); timer.unref(); })]), 0);
    assert.equal((await nativeIdentity(dev)).running, false);
  } finally { if (foreground.exitCode === null) foreground.kill('SIGKILL'); }
  await atomicJson(dev.processFile, { pid: process.pid, marker: randomUUID() });
  await cli(home, 'dev', 'stop', [], { fail: true }); await rm(dev.processFile);
  console.info('[profiles] Actual release upgrade, snapshot rollback, preservation of new data and PID identity protection passed');

  // The bounded supervisor must cap large chunks and repeated restarts independently of server logging.
  const noisy = join(directory, 'noisy.mjs'), log = join(directory, 'bounded.log');
  await writeFile(noisy, "process.stdout.write('synthetic-private-body\\n'.repeat(60000)); process.stderr.write('synthetic-private-token'.repeat(100000));");
  for (let i = 0; i < 2; i++) assert.equal((await command(process.execPath, [join(repository, 'scripts/central-runner.mjs'), noisy, log, `--mote-instance=${randomUUID()}`], { env: { MOTE_LOG_MAX_MB: '0.1', MOTE_LOG_MAX_FILES: '3' } })).code, 0);
  for (const name of (await readdir(directory)).filter(name => name.startsWith('bounded.log'))) { assert.ok((await stat(join(directory, name))).size <= Math.floor(0.1 * 1024 * 1024)); assert.ok(!(await readFile(join(directory, name), 'utf8')).includes('synthetic-private')); }
  assert.equal((await readdir(directory)).filter(name => name.startsWith('bounded.log')).length, 3);
  console.info('[profiles] Bounded native stdout/stderr rotation passed; no formal node or live model was used');
} finally {
  for (const p of profiles.reverse()) { const state = await nativeIdentity(p).catch(() => null); if (state?.running && state.managed) await stopNative(p); }
  await rm(directory, { recursive: true, force: true });
}
