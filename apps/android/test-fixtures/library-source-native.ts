import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
import {materialId} from '../../server/src/materials.js';

/** Exact Library reference contract. Generated SQLite and loopback HTTP only;
 * the production Kotlin reader consumes real Material and evidence responses. */
const root = fileURLToPath(new URL('../../../', import.meta.url));
const all = process.argv.slice(2);
assert.ok(all.length === 0 || all.length === 1 && all[0] === '--all-unit-tests', 'Expected only --all-unit-tests or no arguments');
const directory = await mkdtemp(join(tmpdir(), 'mote-library-reader-'));
const token = randomBytes(32).toString('hex');
const config: Config = {dataDir: directory, token, tokenPath: 'generated-only', host: '127.0.0.1', port: 0,
  maxStorageBytes: 50_000_000, maxExportBytes: 10_000_000, retentionDays: 0, insightIntervalHours: 0,
  allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
  embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent'};
const connectionFile = join(directory, 'connection.json');
let central: Awaited<ReturnType<typeof buildApp>> | undefined;
let child: ChildProcess | undefined;
let interrupted = false;
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
    query: async () => { throw Error('No model belongs in the Library reader contract'); }, close: async () => {}}});
  // Hold background organization so the published generated revision stays pinned.
  central.materialOrganizer.tick = async () => 0;
  const when = '2026-10-01T00:00:00Z';
  const sourceId = 'generated-library-reader';
  const externalId = 'generated-library-external';
  const body = Array.from({length: 180}, (_, index) => `Generated exact Library line ${String(index).padStart(3, '0')}`).join('\n');
  const published = central.materials.publish({
    id: materialId(sourceId, externalId), kind: 'mote.document', schemaVersion: 1,
    title: 'Generated exact Library material',
    origin: {sourceId, externalId, deviceId: 'generated-library-device', firstAt: when, lastAt: when},
    members: [],
    blocks: [{id: 'body', kind: 'text', format: 'plain', text: body, memberIds: []}],
    coverage: {state: 'complete'}, fidelity: {state: 'derived'}, retention: {original: 'retained', policy: 'keep'},
  });
  const first = central.materials.read(published.ref, {offset: 0, length: 4000});
  assert.ok(first.textRange.nextOffset !== null, 'Generated body must need a continuation page');
  const second = central.materials.read(published.ref, {offset: first.textRange.nextOffset, length: 4000});
  const members = central.materials.members(published.ref, {offset: 0, limit: 20});
  const evidenceId = randomUUID();
  central.store.ingest({id: evidenceId, deviceId: 'generated-library-device', deviceName: 'Generated library device',
    platform: 'import', source: 'note', capturedAt: when, durationMs: 0,
    ocrText: Array.from({length: 300}, (_, index) => `Generated evidence line ${String(index).padStart(3, '0')}`).join('\n')});
  const origin = await central.app.listen({host: '127.0.0.1', port: 0});
  const headers = {authorization: 'Bearer ' + token};
  const evidence = await central.app.inject({method: 'POST', url: '/api/context/read', headers,
    payload: {refs: ['capture:' + evidenceId], offset: 0, length: 4000}});
  assert.equal(evidence.statusCode, 200, 'Generated evidence read failed');
  const evidenceItem = evidence.json().items[0];
  assert.equal(evidenceItem.ref, 'capture:' + evidenceId);
  assert.ok(evidenceItem.textRange.nextOffset !== null, 'Generated evidence must need a continuation page');
  await writeFile(connectionFile, JSON.stringify({
    generatedOnly: true, origin, token, materialId: published.id, revision: published.revision,
    first: {text: first.text, offset: first.textRange.offset, total: first.textRange.total, nextOffset: first.textRange.nextOffset},
    second: {text: second.text, offset: second.textRange.offset, total: second.textRange.total, nextOffset: second.textRange.nextOffset},
    memberTotal: members.total,
    evidence: {captureId: evidenceId, text: evidenceItem.text, offset: evidenceItem.textRange.offset,
      total: evidenceItem.textRange.total, nextOffset: evidenceItem.textRange.nextOffset},
  }), {mode: 0o600});
  if (interrupted) throw Error('Library reader contract interrupted before Gradle started');
  const args = ['-p', 'apps/android', '--no-daemon', ':app:testDebugUnitTest', '--rerun',
    ...(all.length ? [] : ['--tests', 'dev.mote.collector.plugins.NativeLibraryReaderContractTest'])];
  child = spawn(resolve(root, 'apps/android/gradlew'), args, {cwd: root, stdio: 'inherit', detached: process.platform !== 'win32',
    env: {...process.env, MOTE_LIBRARY_NATIVE_CONNECTION: connectionFile}});
  await new Promise<void>((done, reject) => {
    let failure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      failure = Error('Library reader contract Gradle process exceeded 15 minutes');
      terminate();
      force = setTimeout(() => {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure = new AggregateError([failure, error], 'Gradle timeout and termination failed'); }
        }
      }, 5000);
    }, 15 * 60 * 1000);
    child!.once('error', error => { failure = error; });
    child!.once('close', (code, signal) => {
      clearTimeout(timeout); clearTimeout(force);
      if (failure) reject(failure);
      else if (code !== 0 || interrupted) reject(Error(`Library reader contract Gradle failed (${signal ?? code})`));
      else done();
    });
  });
  const report = await readFile(resolve(root, 'apps/android/app/build/test-results/testDebugUnitTest/TEST-dev.mote.collector.plugins.NativeLibraryReaderContractTest.xml'), 'utf8');
  const suite = report.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
  assert.ok(Number(suite.match(/\btests="(\d+)"/)?.[1]) >= 3, 'The real exact-reference cases must execute');
  for (const attribute of ['skipped', 'failures', 'errors']) assert.match(suite, new RegExp(`\\b${attribute}="0"`), `Library reader contract ${attribute}`);
  console.log('Real Fastify → Kotlin exact Library reference contract passed (generated SQLite/HTTP; no device or model).');
} finally {
  terminate();
  await central?.app.close();
  await rm(directory, {recursive: true, force: true});
}
