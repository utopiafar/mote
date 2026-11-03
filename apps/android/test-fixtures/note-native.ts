import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';

// The real Central route produces the note-save receipt consumed by the Kotlin
// plugin parser. Generated SQLite/HTTP only; no model or personal data.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'mote-note-native-'));
const token = randomBytes(32).toString('hex');
const config: Config = {dataDir: directory, token, tokenPath: 'generated-only', host: '127.0.0.1', port: 0,
  maxStorageBytes: 50_000_000, maxExportBytes: 10_000_000, retentionDays: 0, insightIntervalHours: 0,
  allowedOrigins: [], model: '', modelBaseUrl: '', apiKey: '', allowUnauthenticatedLocal: false,
  embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', logLevel: 'silent'};
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
    query: async () => { throw Error('No model belongs in the note native contract'); }, close: async () => {}}});
  const id = randomUUID();
  const payload = {id, deviceId: 'generated-note-native', deviceName: 'Generated note native', platform: 'android',
    capturedAt: '2026-11-04T00:00:00.000Z', text: 'Generated note text with exact spacing.  '};
  const headers = {authorization: 'Bearer ' + token};
  const first = await central.app.inject({method: 'POST', url: '/api/notes', headers, payload});
  assert.equal(first.statusCode, 201, first.body);
  const repeated = await central.app.inject({method: 'POST', url: '/api/notes', headers, payload});
  assert.equal(repeated.statusCode, 200, 'The retry preserves the original note identity');
  const fixture = join(directory, 'note-save.json');
  await writeFile(fixture, JSON.stringify({first: first.json(), duplicate: repeated.json()}), {mode: 0o600});
  if (interrupted) throw Error('Note native contract interrupted before Gradle started');
  const result = join(directory, 'note-save-result.json');
  const args = ['-p', 'apps/android', '--no-daemon', ':app:testDebugUnitTest', '--rerun',
    '--tests', 'dev.mote.collector.NotesPluginContractTest'];
  child = spawn(resolve(root, 'apps/android/gradlew'), args, {cwd: root, stdio: 'inherit', detached: process.platform !== 'win32',
    env: {...process.env, MOTE_NOTE_NATIVE_FIXTURE: fixture, MOTE_NOTE_NATIVE_RESULT: result, MOTE_NOTE_NATIVE_ID: id}});
  await new Promise<void>((done, reject) => {
    const timeout = setTimeout(() => {
      terminate();
      reject(Error('Note native contract Gradle process exceeded 10 minutes'));
    }, 10 * 60 * 1000);
    child!.once('error', error => { clearTimeout(timeout); reject(error); });
    child!.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || interrupted) reject(Error(`Note native contract Gradle failed (${signal ?? code})`));
      else done();
    });
  });
  const parsed = JSON.parse(await readFile(result, 'utf8'));
  assert.equal(parsed.id, id, 'Kotlin parsed the real Central note id');
  assert.equal(parsed.duplicate, true, 'Kotlin parsed the duplicate receipt');
  const report = await readFile(resolve(root, 'apps/android/app/build/test-results/testDebugUnitTest/TEST-dev.mote.collector.NotesPluginContractTest.xml'), 'utf8');
  const suite = report.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
  assert.ok(Number(suite.match(/\btests="(\d+)"/)?.[1]) >= 1, 'The real Kotlin note contract case must execute');
  for (const attribute of ['skipped', 'failures', 'errors']) assert.match(suite, new RegExp(`\\b${attribute}="0"`), `Note contract ${attribute}`);
  console.log('Real Fastify → Kotlin note receipt contract passed (generated SQLite/HTTP; no device or model).');
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  for (const cleanup of [async () => { terminate(); }, async () => { await central?.app.close(); }, async () => { await rm(directory, {recursive: true, force: true}); }]) {
    try { await cleanup(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Note contract failed; cleanup also failed') : error; }
  }
}
if (failure) throw failure;
