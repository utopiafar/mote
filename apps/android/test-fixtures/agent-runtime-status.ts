import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {agentRuntimeReadiness,agentRuntimeStatusReceiptSchema} from '@mote/shared/agent-runtime-status';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
import type {ModelAgentFactory} from '../../server/src/model-agent.js';
import {parseAgentRuntimeStatus} from '../../web/src/agent-runtime-status.js';
import {readAgentRuntimeStatus} from '../../desktop/src/agent-runtime-status.js';
import {ApiError} from '../../web/src/api.js';
import {ConnectionError} from '../../desktop/src/connection.js';

// One real Central configuration/status response feeds the production Web, Mac
// and Kotlin parsers. The Kotlin contract test reads the same generated body
// from private temporary files, so schema drift fails before a device is used.
const root = fileURLToPath(new URL('../../../', import.meta.url));
assert.deepEqual(process.argv.slice(2), [], 'This case accepts no arguments');
const directory = await mkdtemp(join(tmpdir(), 'mote-runtime-status-'));
const owner = randomBytes(32).toString('hex');
const secret = 'generated-runtime-status-secret-do-not-echo';
const receiptPath = join(directory, 'receipt.json');
const badRevisionPath = join(directory, 'bad-revision.json');
const unconfiguredPath = join(directory, 'unconfigured.json');
const config: Config = {dataDir: join(directory, 'data'), token: owner, tokenPath: 'generated-only', host: '127.0.0.1', port: 0,
  maxStorageBytes: 10_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0, allowedOrigins: [],
  model: 'generated-runtime-model', modelBaseUrl: 'https://fixture.invalid/v1', apiKey: secret, modelProvider: 'custom',
  modelProtocol: 'openai-completions', modelReasoningEffort: 'auto', allowUnauthenticatedLocal: false, embeddingModel: '',
  embeddingBaseUrl: '', embeddingApiKey: '', diagnosticsEnabled: false};
const factory: ModelAgentFactory = async settings => ({configured: true,
  query: async () => ({answer: settings.model, citations: [], trace: [], runId: 'generated-runtime-status-run'}),
  close: async () => {}});
let central: Awaited<ReturnType<typeof buildApp>> | undefined;
let unconfigured: Awaited<ReturnType<typeof buildApp>> | undefined;
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
  central = await buildApp(config, {backgroundWorker: false, createModelAgent: factory});
  const origin = await central.app.listen({host: '127.0.0.1', port: 0});
  const response = await fetch(origin + '/api/agent-runtime-settings', {headers: {authorization: 'Bearer ' + owner}});
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(secret), false, 'credentials never enter the status receipt');
  assert.equal(serialized.includes('executable'), false);
  assert.equal(serialized.includes('packagePath'), false);

  // [U] one serialized status, accepted by every production parser.
  const shared = agentRuntimeStatusReceiptSchema.parse(body);
  assert.equal(shared.features.chat.model, 'generated-runtime-model');
  assert.equal(shared.features.chat.configured, true);
  assert.equal(shared.configuration.domain?.status, 'applied');
  assert.equal(agentRuntimeReadiness(shared), 'ready');
  const web = parseAgentRuntimeStatus(body);
  assert.deepEqual(web, shared);
  const mac = await readAgentRuntimeStatus({serverUrl: origin, token: owner});
  assert.deepEqual(mac, shared);

  // [K] a bad revision never projects configured state, while the current
  // selection in the last accepted receipt stays readable for display.
  const bad = {...(body as Record<string, unknown>), revision: -1};
  assert.equal(agentRuntimeStatusReceiptSchema.safeParse(bad).success, false);
  assert.throws(() => parseAgentRuntimeStatus(bad), error => error instanceof ApiError && error.code === 'invalid_response');
  await assert.rejects(readAgentRuntimeStatus({serverUrl: origin, token: owner}, async () => Response.json(bad)),
    error => error instanceof ConnectionError && error.code === 'INVALID_RESPONSE');
  assert.equal(web.features.chat.profileId, shared.features.chat.profileId);

  // The real unconfigured node keeps its default selection readable but never
  // projects ready on any production parser.
  unconfigured = await buildApp({...config, dataDir: join(directory, 'data-unconfigured'), model: '', modelBaseUrl: '', apiKey: ''},
    {backgroundWorker: false});
  const unconfiguredOrigin = await unconfigured.app.listen({host: '127.0.0.1', port: 0});
  const unconfiguredResponse = await fetch(unconfiguredOrigin + '/api/agent-runtime-settings', {headers: {authorization: 'Bearer ' + owner}});
  assert.equal(unconfiguredResponse.status, 200);
  const unconfiguredBody: unknown = await unconfiguredResponse.json();
  const unconfiguredShared = agentRuntimeStatusReceiptSchema.parse(unconfiguredBody);
  assert.equal(agentRuntimeReadiness(unconfiguredShared), 'unconfigured');
  assert.equal(unconfiguredShared.features.chat.configured, false);
  assert.equal(unconfiguredShared.saved.profiles.some(profile => profile.id === unconfiguredShared.features.chat.profileId), true);
  assert.deepEqual(parseAgentRuntimeStatus(unconfiguredBody), unconfiguredShared);
  assert.deepEqual(await readAgentRuntimeStatus({serverUrl: unconfiguredOrigin, token: owner}), unconfiguredShared);

  await writeFile(receiptPath, JSON.stringify(body), {mode: 0o600});
  await writeFile(badRevisionPath, JSON.stringify(bad), {mode: 0o600});
  await writeFile(unconfiguredPath, JSON.stringify(unconfiguredBody), {mode: 0o600});
  if (interrupted) throw Error('Runtime-status contract interrupted before Gradle started');
  child = spawn(resolve(root, 'apps/android/gradlew'), ['-p', 'apps/android', '--no-daemon', ':app:testDebugUnitTest', '--rerun',
    '--tests', 'dev.mote.collector.RuntimeStatusReceiptTest',
    '--tests', 'dev.mote.collector.RuntimeStatusReceiptContractTest'], {cwd: root, stdio: 'inherit', detached: process.platform !== 'win32',
    env: {...process.env, MOTE_RUNTIME_STATUS_RECEIPT: receiptPath, MOTE_RUNTIME_STATUS_BAD_REVISION: badRevisionPath,
      MOTE_RUNTIME_STATUS_UNCONFIGURED: unconfiguredPath}});
  await new Promise<void>((done, reject) => {
    let failed: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      failed = Error('Runtime-status Gradle process exceeded 15 minutes');
      terminate();
      force = setTimeout(() => {
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failed = new AggregateError([failed, error], 'Gradle timeout and termination failed'); }
        }
      }, 5000);
    }, 15 * 60 * 1000);
    child!.once('error', error => { failed = error; });
    child!.once('close', (code, signal) => {
      clearTimeout(timeout); clearTimeout(force);
      if (failed) reject(failed);
      else if (code !== 0 || interrupted) reject(Error(`Runtime-status Gradle failed (${signal ?? code})`));
      else done();
    });
  });
  const report = async (name: string, minimum: number) => {
    const value = await readFile(resolve(root, `apps/android/app/build/test-results/testDebugUnitTest/TEST-dev.mote.collector.${name}.xml`), 'utf8');
    const suite = value.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
    assert.ok(Number(suite.match(/\btests="(\d+)"/)?.[1]) >= minimum, `The ${name} cases must execute`);
    for (const attribute of ['skipped', 'failures', 'errors']) assert.match(suite, new RegExp(`\\b${attribute}="0"`), `${name} ${attribute}`);
  };
  await report('RuntimeStatusReceiptTest', 4);
  await report('RuntimeStatusReceiptContractTest', 3);
  console.log('Real Central configuration/status → Web, Mac and Kotlin production parsers passed (generated receipt; no device, server credential or model).');
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  try { terminate(); }
  catch (error) { failure = failure ? new AggregateError([failure, error], 'Runtime-status failed; cleanup also failed') : error; }
  for (const app of [central, unconfigured]) {
    if (!app) continue;
    try { await app.app.close(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Runtime-status failed; Central cleanup also failed') : error; }
  }
  try { await rm(directory, {recursive: true, force: true}); }
  catch (error) { failure = failure ? new AggregateError([failure, error], 'Runtime-status failed; fixture cleanup also failed') : error; }
}
if (failure) throw failure;
