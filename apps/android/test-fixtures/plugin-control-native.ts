import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {zipSync, strToU8} from 'fflate';
import {buildApp} from '../../server/src/app.js';
import type {Config} from '../../server/src/config.js';
import {GitHubPluginReleases} from '../../server/src/plugin-release.js';
import {sha256} from '../../server/src/store.js';

// Real Central plugin-control routes feed the production Kotlin client. Only
// the unavailable Android transport runtime is replaced by JDK HTTP in the JVM
// test; the generated GitHub/HTTP release boundary is the resolver stand-in.
const root = fileURLToPath(new URL('../../../', import.meta.url));
assert.deepEqual(process.argv.slice(2), [], 'This case accepts no arguments');
const directory = await mkdtemp(join(tmpdir(), 'mote-plugin-control-native-'));
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
  const node = await buildApp(config, {backgroundWorker: false, agent: {configured: false,
    query: async () => { throw Error('No model belongs in the plugin control contract'); }, close: async () => {}}});
  central = node;
  const origin = await node.app.listen({host: '127.0.0.1', port: 0});
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(origin + path, {method: body ? 'POST' : 'GET',
      headers: {authorization: 'Bearer ' + token, 'content-type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined});
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok) throw Error(`${path} failed (${response.status}): ${JSON.stringify(value)}`);
    return value as any;
  };
  const archive = zipSync({'provider.mjs': strToU8('export function createMemoryProvider(){throw Error("Unexpected worker execution")};')});
  const base = 'https://github.com/generated-fixture/plugin-control/releases/download/v1/';
  const manifest = {
    schemaVersion: 1, id: 'generated.plugin-control', name: 'Generated control package', version: 'fixture-1',
    runtime: 'worker', entry: 'provider.mjs', archive: {asset: 'adapter.zip', sha256: sha256(archive)},
    capabilities: ['memory.repository'],
    configuration: [{id: 'endpoint', label: 'Generated endpoint', type: 'text', required: true}],
    dependencies: [], access: ['Generated fixture access'],
  };
  const releases = new GitHubPluginReleases(node.pluginCenter.releases.directory, async url => {
    if (url.endsWith('/releases/tags/v1')) return {bytes: strToU8(JSON.stringify({tag_name: 'v1', draft: false, assets: [
      {name: 'mote-plugin.json', browser_download_url: base + 'mote-plugin.json'},
      {name: 'adapter.zip', browser_download_url: base + 'adapter.zip'},
    ]}))};
    if (url.endsWith('/commits/v1')) return {bytes: strToU8(JSON.stringify({sha: 'a'.repeat(40)}))};
    if (url === base + 'mote-plugin.json') return {bytes: strToU8(JSON.stringify(manifest))};
    if (url === base + 'adapter.zip') return {bytes: archive};
    throw Error('Unexpected generated release URL: ' + url);
  });
  node.pluginCenter.releases.resolve = releases.resolve.bind(releases);
  node.pluginCenter.releases.install = releases.install.bind(releases);

  const preview = await request('/api/plugins/resolve', {repository: 'generated-fixture/plugin-control', tag: 'v1'});
  const initial = await request('/api/plugins');
  await request('/api/plugins/install', {operationId: randomUUID(), expectedRevision: initial.revision, previewId: preview.id});
  const until = async (check: () => boolean, message: string) => {
    const end = Date.now() + 5000;
    while (!check()) {
      assert.ok(Date.now() < end, message);
      await new Promise(done => setTimeout(done, 5));
    }
  };
  await until(() => Boolean(node.pluginCenter.view().packages[0]) && node.pluginCenter.view().packages[0]!.state !== 'installing',
    'generated plugin installation settles');
  const packageId = node.pluginCenter.view().packages[0]!.id;
  const instance = await request('/api/plugin-instances', {operationId: randomUUID(),
    expectedRevision: (await request('/api/plugins')).revision, packageId,
    name: 'Generated control instance', scope: 'default', configuration: {endpoint: 'generated-reference'}});
  const inventory = await request('/api/plugins');
  const pkg = inventory.packages.find((value: {id: string}) => value.id === packageId);
  assert.ok(pkg, 'real control response contains the installed package');
  assert.equal(pkg.state, 'installed');
  assert.equal(pkg.configurationSchema[0].id, 'endpoint');
  const instanceView = inventory.instances.find((value: {id: string}) => value.id === instance.id);
  assert.ok(instanceView, 'real control response contains the configured instance');
  assert.equal(instanceView.configuration.endpoint, 'generated-reference');
  assert.equal(instanceView.observed, 'configured');
  assert.equal(inventory.catalog[0].repository, 'mem0ai/mem0');

  if (interrupted) throw Error('Plugin control contract interrupted before Gradle started');
  const args = ['-p', 'apps/android', '--no-daemon', ':app:testDebugUnitTest', '--rerun',
    '--tests', 'dev.mote.collector.plugins.PluginCenterNativeContractTest'];
  child = spawn(resolve(root, 'apps/android/gradlew'), args, {cwd: root, stdio: 'inherit', detached: process.platform !== 'win32',
    env: {...process.env, MOTE_PLUGIN_CONTROL_ORIGIN: origin, MOTE_PLUGIN_CONTROL_TOKEN: token,
      MOTE_PLUGIN_CONTROL_PACKAGE_ID: packageId, MOTE_PLUGIN_CONTROL_INSTANCE_ID: instance.id}});
  await new Promise<void>((done, reject) => {
    let processFailure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      processFailure = Error('Plugin control contract Gradle process exceeded 15 minutes');
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
      else if (code !== 0 || interrupted) reject(Error(`Plugin control contract Gradle failed (${signal ?? code})`));
      else done();
    });
  });
  const report = await readFile(resolve(root,
    'apps/android/app/build/test-results/testDebugUnitTest/TEST-dev.mote.collector.plugins.PluginCenterNativeContractTest.xml'), 'utf8');
  const suite = report.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
  assert.ok(Number(suite.match(/\btests="(\d+)"/)?.[1]) >= 1, 'The real plugin control contract case must execute');
  for (const attribute of ['skipped', 'failures', 'errors']) assert.match(suite, new RegExp(`\\b${attribute}="0"`), `Plugin control contract ${attribute}`);
  console.log('Real Fastify → Kotlin plugin control contract passed (generated SQLite/HTTP; no device or model).');
} catch (error) {
  failure = error;
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  for (const cleanup of [async () => { terminate(); }, async () => { await central?.app.close(); }, async () => { await rm(directory, {recursive: true, force: true}); }]) {
    try { await cleanup(); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Plugin control contract failed; cleanup also failed') : error; }
  }
}
if (failure) throw failure;
