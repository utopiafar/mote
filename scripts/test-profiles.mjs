#!/usr/bin/env node
// Real central subprocesses, encrypted generated pixels, disposable dev/test profiles only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm, stat, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { repository, profilePaths, loadProfile, deploymentEnvironment, nativeIdentity, stopNative, atomicJson, updateProfileConfiguration, setPublicUrl } from './profile-lib.mjs';
import { command, cli, updateEnvironment, initializeFixture, request, note, capture, image } from './profile-fixtures.mjs';

const directory = await mkdtemp(join(tmpdir(), 'mote-profiles-fixture-'));
const home = join(directory, 'profiles'), restoreHome = join(directory, 'restored');
const profiles = [];
// Observe the actual file watcher through its authenticated view before checking
// idempotence. An immediate file read missed the normalization rewrite regression.
async function settledConfiguration(p) {
  const deadline = Date.now() + 10000; let previous, stable = 0;
  while (Date.now() < deadline) {
    const view = await request(p, '/api/configuration'), raw = await readFile(p.configFile, 'utf8');
    const signature = JSON.stringify({ revision: view.revision, raw });
    stable = signature === previous ? stable + 1 : 0; previous = signature;
    if (stable >= 8) return { view, raw, profile: await loadProfile(profilePaths(p.profile, p.home)) };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Generated profile configuration watcher did not settle');
}
try {
  let dev = await initializeFixture(home, 'dev'), test = await initializeFixture(home, 'test'); profiles.push(dev, test);
  assert.notEqual(dev.env.MOTE_TOKEN, test.env.MOTE_TOKEN); assert.notEqual(dev.dataDir, test.dataDir); assert.notEqual(dev.project, test.project);
  const devMedia = deploymentEnvironment(dev), testMedia = deploymentEnvironment(test);
  assert.notEqual(devMedia.MOTE_MEDIA_ASR_ENDPOINT, testMedia.MOTE_MEDIA_ASR_ENDPOINT);
  assert.notEqual(devMedia.MOTE_MEDIA_OCR_ENDPOINT, testMedia.MOTE_MEDIA_OCR_ENDPOINT);
  assert.equal(devMedia.MOTE_MEDIA_ASR_ENDPOINT, `http://127.0.0.1:${devMedia.MOTE_MEDIA_ASR_PORT}/transcribe`);
  assert.equal(devMedia.MOTE_MEDIA_OCR_ENDPOINT, `http://127.0.0.1:${devMedia.MOTE_MEDIA_OCR_PORT}/ocr`);
  assert.equal((await stat(dev.configFile)).mode & 0o777, 0o600);
  assert.equal(dev.env.MOTE_LOG_DIR, './logs'); assert.equal(dev.env.MOTE_LOG_MAX_ENTRIES, '2000'); assert.equal(dev.env.MOTE_AGENT_TRACE_ENABLED, '1'); assert.equal(test.env.MOTE_AGENT_TRACE_ENABLED, '0');
  assert.equal(dev.document.diagnostics.debug, true); assert.equal(test.document.diagnostics.debug, false);
  assert.equal(dev.env.MOTE_LOG_MAX_MB, '100'); assert.equal(Object.hasOwn(dev.savedDocument.diagnostics, 'maxBytes'), false); assert.equal(test.env.MOTE_LOG_MAX_MB, '2');
  assert.equal(JSON.parse((await cli(home, 'dev', 'config')).stdout).diagnostics.logMaxMiB, 100);
  assert.equal(JSON.parse((await cli(home, 'test', 'config')).stdout).diagnostics.logMaxMiB, 2);
  const hostile = { MOTE_PROFILE: 'prod', MOTE_ENV_FILE: '/missing/formal.env', MOTE_DATA_DIR: '/missing/formal-data', MOTE_TOKEN: 'synthetic-hostile-ambient-token', MOTE_MODEL: 'ambient-model-must-not-load', MOTE_MODEL_API_KEY: 'synthetic-ambient-key', MOTE_DEBUG: '1' };
  const isolated = await cli(home, undefined, 'exec', ['--', process.execPath, '-e', "console.log(JSON.stringify({profile:process.env.MOTE_PROFILE,file:process.env.MOTE_CONFIG_FILE,model:process.env.MOTE_MODEL,key:process.env.MOTE_MODEL_API_KEY,debug:process.env.MOTE_DEBUG,url:process.env.MOTE_URL}))"], { env: hostile });
  assert.deepEqual(JSON.parse(isolated.stdout), { profile: 'dev', file: dev.configFile, url: dev.url });
  await cli(home, 'dev', 'init', [], { fail: true });
  await cli(join(directory, 'reserved'), 'dev', 'init', ['--port', '47832'], { fail: true });
  const originalEnv = await readFile(dev.configFile, 'utf8');
  assert.match(originalEnv, /dataDir: \.\/data/);
  await updateProfileConfiguration(dev, document => { document.storage.dataDir = '../test/data'; });
  await cli(home, 'dev', 'status', [], { fail: true }); await writeFile(dev.configFile, originalEnv);
  const launch = JSON.parse((await cli(home, 'dev', 'launchd')).stdout), xml = await readFile(launch.generated, 'utf8');
  assert.equal(launch.installed, false); assert.ok(xml.includes('/dev/null')); assert.ok(!xml.includes(dev.env.MOTE_TOKEN));
  if (process.platform === 'darwin') assert.equal((await command('plutil', ['-lint', launch.generated])).code, 0);
  console.info('[profiles] Private defaults, explicit environment, reserved formal port and launchd generation passed');

  await cli(home, 'dev', 'start', [], { env: hostile }); await cli(home, 'test', 'start');
  assert.equal(JSON.parse((await cli(home, 'dev', 'status')).stdout).healthy, true);
  assert.deepEqual((await request(dev, '/api/diagnostics')).limits, { maxFileBytes: 100 * 1024 * 1024, maxFiles: 3, maxEvents: 2000 });
  assert.deepEqual((await request(test, '/api/diagnostics')).limits, { maxFileBytes: 2 * 1024 * 1024, maxFiles: 3, maxEvents: 2000 });
  // Upgrading an existing numeric DEV setting never overwrites it. Adopting the
  // larger default is explicit and applies only after the owner's next restart.
  await cli(home, 'dev', 'stop');
  dev = await updateEnvironment(dev, { MOTE_LOG_MAX_MB: '2' });
  const legacyEnv = await readFile(dev.configFile);
  await cli(home, 'dev', 'start');
  assert.deepEqual(await readFile(dev.configFile), legacyEnv);
  assert.equal((await request(dev, '/api/diagnostics')).limits.maxFileBytes, 2 * 1024 * 1024);
  const adoption = JSON.parse((await cli(home, 'dev', 'log-retention', ['--defaults'])).stdout);
  assert.deepEqual(adoption, { profile: 'dev', changed: true, before: { maxFileMiB: 2, maxFiles: 3 }, after: { maxFileMiB: 100, maxFiles: 3 }, restartRequired: true });
  assert.equal((await request(dev, '/api/diagnostics')).limits.maxFileBytes, 2 * 1024 * 1024);
  const adopted = await settledConfiguration(dev);
  assert.equal(Object.hasOwn(adopted.profile.savedDocument.diagnostics, 'maxBytes'), false, 'The running watcher must preserve the profile-default omission');
  assert.equal(JSON.parse((await cli(home, 'dev', 'config')).stdout).diagnostics.logMaxMiBSource, 'profile-default');
  const repeatedAdoption = JSON.parse((await cli(home, 'dev', 'log-retention', ['--defaults'])).stdout);
  assert.deepEqual(repeatedAdoption, { profile: 'dev', changed: false, before: { maxFileMiB: 100, maxFiles: 3 }, after: { maxFileMiB: 100, maxFiles: 3 }, restartRequired: true });
  const repeated = await settledConfiguration(dev);
  assert.equal(repeated.raw, adopted.raw, 'Repeated adoption after watcher acceptance must not rewrite YAML');
  assert.equal(repeated.view.revision, adopted.view.revision, 'Repeated adoption must not change the revision');
  const execution = repeated.view.domains.find(domain => domain.id === 'execution');
  await request(dev, '/api/configuration/execution', { method: 'PUT', body: { revision: repeated.view.revision, value: { ...execution.saved, agentConcurrency: execution.saved.agentConcurrency + 1 } } });
  const unrelatedSave = await settledConfiguration(dev);
  assert.equal(unrelatedSave.view.revision, repeated.view.revision + 1);
  assert.equal(Object.hasOwn(unrelatedSave.profile.savedDocument.diagnostics, 'maxBytes'), false, 'An unrelated online save must preserve profile-default provenance');
  assert.equal(JSON.parse((await cli(home, 'dev', 'config')).stdout).diagnostics.logMaxMiBSource, 'profile-default');
  assert.equal((await request(dev, '/api/diagnostics')).limits.maxFileBytes, 2 * 1024 * 1024, 'Adoption and unrelated hot edits must leave capacity restart-required');
  await cli(home, 'dev', 'stop'); await cli(home, 'dev', 'start');
  dev = await loadProfile(profilePaths('dev', home));
  assert.equal((await request(dev, '/api/diagnostics')).limits.maxFileBytes, 100 * 1024 * 1024);
  // A number equal to the default is still a deliberate explicit override.
  await updateProfileConfiguration(dev, document => { document.diagnostics.maxBytes = 100 * 1024 * 1024; });
  const explicitDefault = await settledConfiguration(dev), explicitExecution = explicitDefault.view.domains.find(domain => domain.id === 'execution');
  await request(dev, '/api/configuration/execution', { method: 'PUT', body: { revision: explicitDefault.view.revision, value: { ...explicitExecution.saved, agentConcurrency: explicitExecution.saved.agentConcurrency + 1 } } });
  const explicitSaved = await settledConfiguration(dev);
  assert.equal(explicitSaved.profile.savedDocument.diagnostics.maxBytes, 100 * 1024 * 1024);
  assert.equal(JSON.parse((await cli(home, 'dev', 'config')).stdout).diagnostics.logMaxMiBSource, 'explicit');
  dev = explicitSaved.profile;
  console.info('[profiles] DEV defaults, explicit limits, settled watcher adoption/idempotence, unrelated online save and real restart passed');
  const beforeConfiguration = await request(dev, '/api/configuration');
  await setPublicUrl(dev, 'https://generated-profile.invalid');
  const configurationDeadline = Date.now() + 10000; let changedConfiguration;
  do { changedConfiguration = await request(dev, '/api/configuration'); if (changedConfiguration.revision > beforeConfiguration.revision) break; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < configurationDeadline);
  assert.equal(changedConfiguration.revision, beforeConfiguration.revision + 1, 'CLI atomic YAML revision must be accepted by the running watcher');
  const changedServer = changedConfiguration.domains.find(domain => domain.id === 'server');
  assert.equal(changedServer.saved.publicUrl, 'https://generated-profile.invalid'); assert.equal(changedServer.effective.publicUrl, ''); assert.equal(changedServer.status, 'restart-required');
  await request(dev, '/api/status', { status: 401, token: test.env.MOTE_TOKEN });
  const saved = note(), screen = capture();
  await request(dev, '/api/notes', { method: 'POST', body: saved, status: 201 });
  await request(dev, '/api/captures', { method: 'POST', body: screen, status: 201 });
  assert.equal((await request(test, '/api/notes')).items.length, 0);
  assert.deepEqual(await request(dev, `/api/captures/${screen.id}/image`, { binary: true }), image);
  const source = join(directory, 'selected-files'); await mkdir(source); await writeFile(join(source, 'synthetic.md'), '合成文件同步资料：每个环境独立确认与重试。');
  const importArgs = ['--', process.execPath, '--import', 'tsx', join(repository, 'scripts/import-files.ts'), '--root', source, '--allow-transient-upload'];
  for (const p of [dev, test]) {
    assert.match((await cli(home, p.profile, 'exec', importArgs)).stdout, /Received 1 changed/);
    assert.match((await cli(home, p.profile, 'exec', importArgs)).stdout, /Received 0 changed/);
    const syncDirectory=join(p.directory,'file-sync');
    const syncFiles=(await readdir(syncDirectory)).filter(name=>name.endsWith('.json')||name.endsWith('.json.sqlite'));
    const stateFiles=syncFiles.filter(name=>name.endsWith('.json.sqlite')).map(name=>name.slice(0,-7));
    assert.equal(stateFiles.length,1);
    assert.deepEqual(syncFiles.filter(name=>name.endsWith('.atime.json')),[stateFiles[0]+'.atime.json']);
    assert.equal((await stat(join(syncDirectory,stateFiles[0]+'.atime.json'))).mode&0o777,0o600);
  }
  for (const p of [dev, test]) assert.equal((await request(p, '/api/captures?source=file')).items.length, 1);
  await writeFile(join(source, 'explicit-env.md'), 'Synthetic explicit MOTE_CONFIG_FILE, without process MOTE_URL.');
  for (const p of [dev, test]) {
    const clean = Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('MOTE_')).map(key => [key, undefined]));
    const imported = await command(process.execPath, ['--import', 'tsx', join(repository, 'scripts/import-files.ts'), '--root', source, '--allow-transient-upload'], { env: { ...clean, MOTE_CONFIG_FILE: p.configFile } });
    assert.equal(imported.code, 0, imported.stderr); assert.match(imported.stdout, /Received 1 changed/);
    assert.equal((await request(p, '/api/captures?source=file')).items.length, 2);
  }
  await cli(home, 'dev', 'backup', ['--out', join(directory, 'running-backup')], { fail: true });
  assert.equal((await request(dev, `/api/notes/${saved.id}`)).ocrText, saved.text);
  console.info('[profiles] Two real central processes, independent tokens/vaults and encrypted image roundtrip passed');

  await cli(home, 'dev', 'stop');
  const snapshot = join(directory, 'snapshot'); await cli(home, 'dev', 'backup', ['--out', snapshot]);
  const entries = await readdir(snapshot); assert.deepEqual(entries.sort(), ['backup-manifest.json', 'blobs', 'files', 'mote.sqlite']);
  const manifest = JSON.parse(await readFile(join(snapshot, 'backup-manifest.json'), 'utf8'));
  assert.ok(Object.hasOwn(manifest.checksums, 'mote.sqlite')); assert.ok(Object.keys(manifest.checksums).length >= 2, 'Backup includes the database and encrypted evidence; formal Material assets may add objects');
  const blob = Object.keys(manifest.checksums).find(name => name.startsWith('files/objects/') && name.endsWith('/0.aes'));
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
  for (const marker of ['log-retention-config.mjs', 'config-service.js']) await cp(join(repository, 'apps/server/dist', marker), join(release, 'apps/server/dist', marker));
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
  const supervisor = await nativeIdentity(dev);
  const activeDataDir = dev.dataDir; await updateProfileConfiguration(dev, document => { document.storage.dataDir = './pending-data'; document.storage.source = join(dev.directory, 'pending-data'); });
  dev = await loadProfile(profilePaths('dev', home)); assert.notEqual(dev.dataDir, activeDataDir); assert.equal(supervisor.record.dataDir, activeDataDir);
  process.kill(supervisor.record.pid, 'SIGKILL');
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
  await updateProfileConfiguration(dev, document => { document.diagnostics.maxBytes = Math.floor(0.1 * 1024 * 1024); document.diagnostics.maxFiles = 3; });
  for (let i = 0; i < 2; i++) assert.equal((await command(process.execPath, [join(repository, 'scripts/central-runner.mjs'), noisy, log, `--mote-instance=${randomUUID()}`], { env: { MOTE_CONFIG_FILE: dev.configFile } })).code, 0);
  for (const name of (await readdir(directory)).filter(name => name.startsWith('bounded.log'))) { assert.ok((await stat(join(directory, name))).size <= Math.floor(0.1 * 1024 * 1024)); assert.ok(!(await readFile(join(directory, name), 'utf8')).includes('synthetic-private')); }
  assert.equal((await readdir(directory)).filter(name => name.startsWith('bounded.log')).length, 3);
  console.info('[profiles] Bounded native stdout/stderr rotation passed; no formal node or live model was used');
} finally {
  for (const p of profiles.reverse()) { const state = await nativeIdentity(p).catch(() => null); if (state?.running && state.managed) await stopNative(p); }
  await rm(directory, { recursive: true, force: true });
}
