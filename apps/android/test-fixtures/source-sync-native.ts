import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';

// Real Central registration, source context and item ingress feed the
// production Kotlin source plugin. Only the unavailable Android HTTP runtime is
// replaced by JDK HTTP inside the JVM test. Generated SQLite/HTTP only.
const root = fileURLToPath(new URL('../../../', import.meta.url));
assert.deepEqual(process.argv.slice(2), [], 'This case accepts no arguments');
const directory = await mkdtemp(join(tmpdir(), 'mote-source-sync-'));
const token = randomBytes(32).toString('hex');
const config: Config = {
  dataDir: directory, token, tokenPath: 'generated-only', host: '127.0.0.1', port: 0,
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
    query: async () => { throw Error('No model belongs in the source sync contract'); }, close: async () => {}}});
  const origin = await central.app.listen({host: '127.0.0.1', port: 0});
  if (interrupted) throw Error('Source sync contract interrupted before Gradle started');
  const result = join(directory, 'source-sync-result.json');
  const args = ['-p', 'apps/android', '--no-daemon', ':app:testDebugUnitTest', '--rerun',
    '--tests', 'dev.mote.collector.plugins.SourceSyncContractTest'];
  child = spawn(resolve(root, 'apps/android/gradlew'), args, {cwd: root, stdio: 'inherit', detached: process.platform !== 'win32',
    env: {...process.env, MOTE_SOURCE_SYNC_ORIGIN: origin, MOTE_SOURCE_SYNC_TOKEN: token, MOTE_SOURCE_SYNC_RESULT: result}});
  await new Promise<void>((done, reject) => {
    let processFailure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      processFailure = Error('Source sync contract Gradle process exceeded 15 minutes');
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
      else if (code !== 0 || interrupted) reject(Error(`Source sync contract Gradle failed (${signal ?? code})`));
      else done();
    });
  });
  const parsed = JSON.parse(await readFile(result, 'utf8')) as {
    sourceId: string; externalId: string; revision: string; ack: string; contextVersion: number; duplicate: boolean;
  };
  assert.match(parsed.sourceId, /^generated-source-[a-f0-9]{16}$/);
  assert.match(parsed.ack, /^[a-f0-9-]{36}$/);
  assert.equal(parsed.contextVersion, 1);
  assert.equal(parsed.duplicate, true, 'The retried immutable source revision keeps its receipt');
  const listed = await central.app.inject({method: 'GET', url: `/api/source-items?sourceId=${encodeURIComponent(parsed.sourceId)}`,
    headers: {authorization: 'Bearer ' + token}});
  assert.equal(listed.statusCode, 200, listed.body);
  const items = (listed.json() as any).items as Array<{externalId: string; revision: string; sourceId: string}>;
  assert.equal(items.length, 1);
  assert.equal(items[0]!.sourceId, parsed.sourceId);
  assert.equal(items[0]!.externalId, parsed.externalId);
  assert.equal(items[0]!.revision, parsed.revision);
  const report = await readFile(resolve(root,
    'apps/android/app/build/test-results/testDebugUnitTest/TEST-dev.mote.collector.plugins.SourceSyncContractTest.xml'), 'utf8');
  const suite = report.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
  assert.ok(Number(suite.match(/\btests="(\d+)"/)?.[1]) >= 1, 'The real Kotlin source sync case must execute');
  for (const attribute of ['skipped', 'failures', 'errors']) assert.match(suite, new RegExp(`\\b${attribute}="0"`), `Source sync ${attribute}`);
  console.log('Real Fastify → Kotlin source registration/context/item sync passed (generated SQLite/HTTP; no device or model).');
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  for (const cleanup of [async () => { terminate(); }, async () => { await central?.app.close(); }, async () => { await rm(directory, {recursive: true, force: true}); }]) {
    try { await cleanup(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Source sync contract failed; cleanup also failed') : error; }
  }
}
if (failure) throw failure;
