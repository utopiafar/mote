/** G5 candidate-release journey (manual selection only; not part of ordinary checks).
 *
 * Covers the release acceptance in three separated scenarios:
 *  1. Build the default Central distribution, start the packaged artifact from
 *     a clean temporary home, inventory every declared feature and stop it.
 *  2. Exercise platform-provider replacement, a business plugin stopped while a
 *     request is in flight, and a same-profile restart of the packaged candidate.
 *  3. Restore a stopped generated profile from a CLI backup, plus the existing
 *     real-host checks for unknown remote writes, revoked sources and native
 *     stage cleanup.
 *
 * Every scenario keeps evidence kinds explicit: this journey uses generated
 * fixtures and loopback processes only. It never calls a real model, never uses
 * a physical device and never publishes an artifact. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {cp, mkdtemp, mkdir, rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createPrivateProcess, type PrivateProcess} from '../../test-fixtures/native-plugins/process.mjs';

const repository = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const work = await mkdtemp(join(tmpdir(), 'mote-rel06-release-'));
const startedAt = new Date().toISOString();

type Evidence = {
  fixtureOnly: boolean;
  liveModel: false;
  physicalDevice: false;
  network: false;
};
type Check = {
  id: string;
  kind: 'package' | 'process' | 'test';
  passed: boolean;
  durationMs: number;
  detail?: string;
  tests?: string[];
};
type Scenario = {
  id: 'default-distribution' | 'provider-and-plugin-lifecycle' | 'backup-restore';
  status: 'passed' | 'failed';
  evidence: Evidence;
  checks: Check[];
  durationMs: number;
  error?: string;
};
type Report = {
  status: 'passed' | 'failed';
  candidate: string;
  dirty: boolean;
  startedAt: string;
  finishedAt: string;
  evidence: Evidence;
  scenarios: Scenario[];
  failure?: string;
};

const evidence: Evidence = {fixtureOnly: true, liveModel: false, physicalDevice: false, network: false};

function message(error: unknown) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function command(command: string, args: string[], options: {cwd?: string; timeoutMs?: number} = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repository,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 30 * 60_000,
  });
  const stdout = String(result.stdout ?? ''), stderr = String(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [stdout, stderr].filter(Boolean).join('\n').trim().slice(-4000);
    throw Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}${detail ? `\n${detail}` : ''}`);
  }
  return {stdout, stderr};
}

function jsonLines(output: string) {
  return output.split(/\r?\n/).flatMap(line => {
    if (!line.trim().startsWith('{')) return [];
    try { return [JSON.parse(line) as Record<string, unknown>]; }
    catch { return []; }
  });
}

function runTests(file: string, pattern?: string): Check {
  const started = Date.now();
  const args = ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-timeout=180000'];
  if (pattern) args.push('--test-name-pattern', pattern);
  args.push(file);
  const result = spawnSync(process.execPath, args, {
    cwd: repository,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 20 * 60_000,
  });
  const output = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`;
  const tests: string[] = [], failures: string[] = [];
  for (const match of output.matchAll(/^(not ok|ok) \d+ - (.+?)(?: # (?:SKIP|TODO).*)?$/gm)) {
    const name = match[2]!.trim();
    (match[1] === 'ok' ? tests : failures).push(name);
  }
  const passed = result.status === 0 && failures.length === 0 && tests.length > 0;
  const detail = passed
    ? `${tests.length} real-host test${tests.length === 1 ? '' : 's'} passed`
    : `${result.error?.message ?? `exit ${result.status ?? result.signal}`}; failed=${failures.length}; passed=${tests.length}${failures.length ? `: ${failures.join('; ')}` : ''}${output ? `\n${output.trim().slice(-3000)}` : ''}`;
  return {id: `${file}${pattern ? ` [${pattern}]` : ''}`, kind: 'test', passed, durationMs: Date.now() - started, detail, tests};
}

async function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(error => error ? reject(error) : port ? resolvePort(port) : reject(Error('Could not allocate a loopback port')));
    });
  });
}

async function waitFor(predicate: () => Promise<boolean>, description: string, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return; } catch { /* retry until the deadline */ }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw Error(`Timed out waiting for ${description}`);
}

function scenario(id: Scenario['id'], run: (checks: Check[]) => Promise<void>): Promise<Scenario> {
  return (async () => {
    const started = Date.now(), checks: Check[] = [];
    try {
      await run(checks);
      return {id, status: 'passed', evidence, checks, durationMs: Date.now() - started};
    } catch (error) {
      return {id, status: 'failed', evidence, checks, durationMs: Date.now() - started, error: message(error)};
    }
  })();
}

/** Scenario 1: REL05 packages the current candidate; its clean-run starts the
 * artifact from a fresh home and inventories the complete default feature set. */
async function defaultDistribution(checks: Check[]) {
  const output = join(work, 'distribution'), started = Date.now();
  const build = command(process.execPath, ['scripts/plugin-distribution.mjs', 'build', '--out', output, '--products', 'central']);
  const built = jsonLines(build.stdout).find(value => value.event === 'distribution.built');
  assert.ok(built, 'plugin-distribution build did not report distribution.built');
  assert.ok(Array.isArray(built.products) && built.products.includes('central'), 'the Central distribution was not built');
  checks.push({id: 'packaged-default-distribution', kind: 'package', passed: true, durationMs: Date.now() - started, detail: `built ${built.products.join(', ')}`});

  const cleanStarted = Date.now();
  const clean = command(process.execPath, ['scripts/plugin-distribution.mjs', 'clean-run', '--out', output]);
  const result = jsonLines(clean.stdout).find(value => value.event === 'distribution.clean_run');
  assert.ok(result, 'plugin-distribution clean-run did not report distribution.clean_run');
  assert.equal(typeof result.features, 'number');
  assert.ok(Number(result.features) > 0, 'the packaged distribution has no feature');
  assert.equal(typeof result.packages, 'number');
  assert.ok(Number(result.packages) > 0, 'the packaged distribution has no package');
  assert.equal(result.stopped, true, 'the packaged distribution did not stop after the clean run');
  checks.push({
    id: 'clean-profile-default-feature-inventory', kind: 'package', passed: true, durationMs: Date.now() - cleanStarted,
    detail: `packaged v${String(result.health && (result.health as {version?:unknown}).version)}; ${result.features} features; ${result.packages} packages; generated note/sdk sample read back`,
  });
  return {artifact: join(output, 'central')};
}

/** Scenario 2: same-profile restart of the packaged candidate. */
async function candidateRestart(artifact: string, checks: Check[]) {
  const started = Date.now(), candidate = join(work, 'candidate'), home = join(work, 'candidate-home'), port = await freePort();
  await cp(artifact, candidate, {recursive: true});
  const cli = join(candidate, 'scripts/mote.mjs'), profile = 'release';
  let running = false;
  try {
    command(process.execPath, [cli, 'init', '--profile', profile, '--home', home, '--port', String(port)], {cwd: candidate});
    command(process.execPath, [cli, 'start', '--profile', profile, '--home', home], {cwd: candidate});
    running = true;
    const token = command(process.execPath, [cli, 'token', '--profile', profile, '--home', home], {cwd: candidate}).stdout.trim();
    assert.ok(token.length >= 32, 'the packaged candidate did not publish an owner token');
    const url = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await fetch(url + '/api/health', {signal: AbortSignal.timeout(1000)})).ok, 'the packaged candidate health');
    const note = {id: randomUUID(), deviceId: 'generated-release-device', deviceName: 'Generated release candidate', platform: 'import', capturedAt: new Date().toISOString(), text: `Generated release candidate note ${randomUUID()}`};
    const write = async (path: string, options: RequestInit = {}) => fetch(new URL(path, url), {...options, headers: {Authorization: `Bearer ${token}`, ...(options.body ? {'Content-Type': 'application/json'} : {})}});
    assert.equal((await write('/api/notes', {method: 'POST', body: JSON.stringify(note)})).status, 201);
    assert.equal(((await (await write(`/api/notes/${encodeURIComponent(note.id)}`)).json()) as {ocrText?:string}).ocrText, note.text);

    command(process.execPath, [cli, 'stop', '--profile', profile, '--home', home], {cwd: candidate});
    running = false;
    command(process.execPath, [cli, 'start', '--profile', profile, '--home', home], {cwd: candidate});
    running = true;
    await waitFor(async () => (await fetch(url + '/api/health', {signal: AbortSignal.timeout(1000)})).ok, 'the restarted packaged candidate health');
    assert.equal(((await (await write(`/api/notes/${encodeURIComponent(note.id)}`)).json()) as {ocrText?:string}).ocrText, note.text);
    const inventory = await (await write('/api/features')).json() as {features?: unknown[]};
    assert.ok(Array.isArray(inventory.features) && inventory.features.length > 0, 'the restarted candidate published no feature inventory');
    checks.push({id: 'packaged-candidate-same-profile-restart', kind: 'process', passed: true, durationMs: Date.now() - started, detail: `generated original survived restart; ${inventory.features.length} features`});
  } finally {
    if (running) {
      try { command(process.execPath, [cli, 'stop', '--profile', profile, '--home', home], {cwd: candidate}); }
      catch { /* best effort after a failed candidate check */ }
    }
  }
}

/** Scenario 3: a stopped generated profile is backed up by the real CLI and
 * restored into a fresh data directory before a second real host process reads
 * the original. */
async function profileBackupRestore(checks: Check[]) {
  const started = Date.now(), snapshot = join(work, 'profile-backup'), restoredData = join(work, 'restored-data');
  let first: PrivateProcess | undefined, second: PrivateProcess | undefined;
  try {
    first = await createPrivateProcess({healthTimeoutMs: 30000});
    const note = {id: randomUUID(), deviceId: 'generated-backup-device', deviceName: 'Generated backup candidate', platform: 'import', capturedAt: new Date().toISOString(), text: `Generated profile backup note ${randomUUID()}`};
    assert.equal(((await first.writeNote(note)) as {receipt?:{state?:string}}).receipt?.state, 'received');
    const stopped = await first.stop();
    assert.equal(stopped.exited, true);
    assert.equal(stopped.code, 0);

    command(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', '--data', first.dataDir, '--out', snapshot]);
    const restore = `import {restoreProfile} from ${JSON.stringify(pathToFileURL(join(repository, 'scripts/profile-lib.mjs')).href)};await restoreProfile({meta:{runtime:'native'},dataDir:${JSON.stringify(restoredData)},processFile:${JSON.stringify(join(work, 'absent-process'))}},${JSON.stringify(snapshot)});`;
    command(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', restore]);

    second = await createPrivateProcess({dataDir: restoredData, healthTimeoutMs: 30000});
    assert.equal(((await second.readNote(note.id)) as {ocrText?:string}).ocrText, note.text, 'the restored process lost the backed-up original');
    const next = {id: randomUUID(), deviceId: 'generated-restored-device', deviceName: 'Generated restored candidate', platform: 'import', capturedAt: new Date().toISOString(), text: `Generated restored write note ${randomUUID()}`};
    assert.equal(((await second.writeNote(next)) as {receipt?:{state?:string}}).receipt?.state, 'received');
    await second.restart();
    assert.equal(((await second.readNote(note.id)) as {ocrText?:string}).ocrText, note.text);
    assert.equal(((await second.readNote(next.id)) as {ocrText?:string}).ocrText, next.text);
    checks.push({id: 'stopped-profile-backup-restore-restart', kind: 'process', passed: true, durationMs: Date.now() - started, detail: 'generated original restored into a fresh data directory, then read after a real process restart'});
  } finally {
    await second?.close({strict: false}).catch(() => undefined);
    await first?.close({strict: false}).catch(() => undefined);
  }
}

const scenarios: Scenario[] = [];
let artifact: string | undefined;
let failure: string | undefined;

const distribution = await scenario('default-distribution', async checks => {
  artifact = (await defaultDistribution(checks)).artifact;
});
scenarios.push(distribution);
failure ??= distribution.error;

const lifecycle = await scenario('provider-and-plugin-lifecycle', async checks => {
  const provider = runTests('apps/server/test/plugin-bootstrap.test.ts', 'restart replacement sends real HTTP writes');
  checks.push(provider);
  assert.ok(provider.passed, 'platform-provider replacement did not pass');

  const hot = runTests('apps/server/test/plugin-control-upgrade-failure.test.ts', 'a hot upgrade registers the new activation|a provider hot upgrade retires dependents');
  checks.push(hot);
  assert.ok(hot.passed, 'business-plugin hot stop/start did not pass');

  const connector = runTests('apps/server/test/plugin-instance-state-host.test.ts', 'a running server installs, stops and re-enables one connector');
  checks.push(connector);
  assert.ok(connector.passed, 'the real host connector stop/start did not pass');

  assert.ok(artifact, 'the packaged candidate is unavailable because the default distribution scenario failed');
  await candidateRestart(artifact, checks);
});
scenarios.push(lifecycle);
failure ??= lifecycle.error;

const backup = await scenario('backup-restore', async checks => {
  const unknownWrite = runTests('apps/server/test/memory-publication-retirement.test.ts', 'a deleted unpublished stage keeps only reconciliation identities');
  checks.push(unknownWrite);
  assert.ok(unknownWrite.passed, 'the unknown remote write recovery did not pass');

  const revoked = runTests('apps/server/test/memory-publication-retirement.test.ts', 'real source deletion retires all host publication prose');
  checks.push(revoked);
  assert.ok(revoked.passed, 'the revoked-source retirement did not pass');

  const native = runTests('apps/server/test/native-engine-checkpoint.test.ts', 'pending native cleanup permits|restart replays (failed|stale|cancelled|blocked) native cleanup');
  checks.push(native);
  assert.ok(native.passed, 'native prepared-cleanup recovery did not pass');

  const combined = runTests('apps/server/test/combined-backup-recovery.test.ts');
  checks.push(combined);
  assert.ok(combined.passed, 'the current-format combined backup restore did not pass');

  await profileBackupRestore(checks);
});
scenarios.push(backup);
failure ??= backup.error;

const candidate = command('git', ['rev-parse', 'HEAD']).stdout.trim();
const dirty = command('git', ['status', '--porcelain']).stdout.trim() !== '';
const report: Report = {
  status: scenarios.every(value => value.status === 'passed') ? 'passed' : 'failed',
  candidate,
  dirty,
  startedAt,
  finishedAt: new Date().toISOString(),
  evidence,
  scenarios,
  ...(failure ? {failure} : {}),
};
console.log(JSON.stringify(report));
await rm(work, {recursive: true, force: true});
if (report.status !== 'passed') process.exitCode = 1;
