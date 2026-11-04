import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';

// Real Central declaration/projection routes feed the production Kotlin
// publisher. Only the unavailable Android transport runtime is replaced by JDK
// HTTP in the JVM test; no emulator, device calendar or OS grant is involved.
const root = fileURLToPath(new URL('../../../', import.meta.url));
assert.deepEqual(process.argv.slice(2), [], 'This case accepts no arguments');
const directory = await mkdtemp(join(tmpdir(), 'mote-native-capability-publisher-'));
const owner = randomBytes(32).toString('hex');
const deviceId = 'generated-capability-device';
const config: Config = {
  dataDir: directory, token: owner, tokenPath: 'generated-only', host: '127.0.0.1', port: 0,
  maxStorageBytes: 50_000_000, maxExportBytes: 10_000_000, retentionDays: 0, insightIntervalHours: 0,
  allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
  embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent',
};
let central: Awaited<ReturnType<typeof buildApp>> | undefined;
let child: ChildProcess | undefined;
let interrupted = false;
let failure: unknown;
const terminate = () => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
};
const interrupt = () => { interrupted = true; terminate(); };
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  central = await buildApp(config, {backgroundWorker: false, agent: {configured: false,
    query: async () => { throw Error('No model belongs in the capability publisher contract'); }, close: async () => {}}});
  const origin = await central.app.listen({host: '127.0.0.1', port: 0});
  const invitation = await central.app.inject({method: 'POST', url: '/api/connections/collector-invitations',
    headers: {authorization: 'Bearer ' + owner}, payload: {serverUrl: origin, label: 'Generated capability device', deviceId}});
  assert.equal(invitation.statusCode, 200, 'Generated collector invitation failed');
  const paired = await central.app.inject({method: 'POST', url: '/api/connections/redeem', payload: {
    code: invitation.json().invitation.code, deviceId, deviceName: 'Generated capability device', platform: 'android'}});
  assert.equal(paired.statusCode, 200, 'Generated collector redemption failed');
  assert.equal(paired.json().scope, 'collector');
  if (interrupted) throw Error('Native capability publisher interrupted before Gradle started');
  const args = ['-p', 'apps/android', '--no-daemon', ':app:testDebugUnitTest', '--rerun',
    '--tests', 'dev.mote.collector.plugins.NativeCapabilityPublicationContractTest'];
  child = spawn(resolve(root, 'apps/android/gradlew'), args, {cwd: root, stdio: 'inherit', detached: process.platform !== 'win32',
    env: {...process.env, MOTE_CAPABILITY_ORIGIN: origin, MOTE_CAPABILITY_TOKEN: paired.json().token, MOTE_CAPABILITY_DEVICE: deviceId}});
  await new Promise<void>((done, reject) => {
    let processFailure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      processFailure = Error('Native capability publisher Gradle process exceeded 15 minutes');
      terminate();
      force = setTimeout(() => {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') processFailure = new AggregateError([processFailure, error], 'Gradle timeout and termination failed'); }
        }
      }, 5000);
    }, 15 * 60 * 1000);
    child!.once('error', error => { processFailure = error; });
    child!.once('close', (code, signal) => {
      clearTimeout(timeout); clearTimeout(force);
      if (processFailure) reject(processFailure);
      else if (code !== 0 || interrupted) reject(Error(`Native capability publisher Gradle failed (${signal ?? code})`));
      else done();
    });
  });
  const report = await readFile(resolve(root,
    'apps/android/app/build/test-results/testDebugUnitTest/TEST-dev.mote.collector.plugins.NativeCapabilityPublicationContractTest.xml'), 'utf8');
  const suite = report.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
  assert.ok(Number(suite.match(/\btests="(\d+)"/)?.[1]) >= 1, 'The native capability publication case must execute');
  for (const attribute of ['skipped', 'failures', 'errors']) assert.match(suite, new RegExp(`\\b${attribute}="0"`), `Native capability publisher ${attribute}`);
  const inventory = await central.app.inject({url: '/api/action-capabilities', headers: {authorization: 'Bearer ' + owner}});
  assert.equal(inventory.statusCode, 200);
  const projection = inventory.json().deviceCapabilities.find((value: {id: string; version: number}) => value.id === 'calendar.manage' && value.version === 1);
  assert.ok(projection, 'Real inventory projects the device capability');
  assert.equal(projection.installed, false, 'installation is the provider fact, not the device declaration');
  assert.equal(projection.grant, 'required');
  assert.equal(projection.available, false);
  assert.equal(projection.authorized, false);
  assert.equal(projection.waitingDevice, false);
  console.log('Real Central declaration/projection → Kotlin capability publisher passed (generated SQLite/HTTP; no device calendar).');
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  for (const cleanup of [async () => { terminate(); }, async () => { await central?.app.close(); }, async () => { await rm(directory, {recursive: true, force: true}); }]) {
    try { await cleanup(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Native capability publisher failed; cleanup also failed') : error; }
  }
}
if (failure) throw failure;
