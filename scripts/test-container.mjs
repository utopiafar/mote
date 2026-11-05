#!/usr/bin/env node
// Real Docker integration, synthetic data only. No image publication or model API calls.
// Requires Node 24+, installed locked dependencies and a running Docker daemon.
// --fixture-only validates generated YAML/mount arguments without contacting Docker.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfigDocument, serializeConfigDocument } from '../packages/shared/src/config-file.ts';
import { dockerConfigurationUser } from './profile-lib.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runId = randomUUID();
const image = `mote-container-fixture:${runId}`;
const container = `mote-container-fixture-${runId}`;
const storageInitializer = `${container}-storage-init`;
const backupContainer = `${container}-backup`;
const volume = `mote-container-fixture-${runId}`;
const modelsVolume = `${volume}-models`;
const configurationDirectory = await mkdtemp(join(tmpdir(), 'mote-container-config-'));
const configFile = join(configurationDirectory, 'mote.yaml');
const fixtureOnly = process.argv.includes('--fixture-only');
const requireNonDefaultUid = process.argv.includes('--require-non-default-uid');
let containerUser = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
const fixtureToken = `synthetic-container-token-only-${runId}`;
const dockerEnv = { ...process.env, MOTE_TOKEN: fixtureToken, MOTE_DATA_KEY: randomBytes(32).toString('hex') };
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(`Interrupted by ${signal}`)));
let daemonAvailable = false;

function docker(args, { capture = false, timeoutMs = 120_000, cleanup = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!cleanup && abort.signal.aborted) { reject(abort.signal.reason); return; }
    const child = spawn('docker', args, { cwd: root, env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failure, finished = false;
    const stop = reason => { failure = reason; child.kill('SIGKILL'); };
    const onAbort = () => stop(abort.signal.reason ?? new Error('Container check interrupted'));
    const timer = setTimeout(() => stop(new Error(`docker ${args[0]} timed out after ${timeoutMs} ms`)), timeoutMs);
    if (!cleanup) abort.signal.addEventListener('abort', onAbort, { once: true });
    const consume = (chunk, stream) => {
      if (!capture) stream.write(chunk);
      else {
        output += chunk.toString('utf8');
        if (Buffer.byteLength(output) > 2 * 1024 * 1024) stop(new Error('Docker command output exceeded 2 MiB'));
      }
    };
    child.stdout.on('data', chunk => consume(chunk, process.stdout));
    child.stderr.on('data', chunk => consume(chunk, process.stderr));
    const finish = error => {
      if (finished) return;
      finished = true; clearTimeout(timer); abort.signal.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(output.trim());
    };
    child.once('error', error => finish(new Error(`Cannot run Docker: ${error.message}. Install Docker and start its daemon.`)));
    child.once('close', code => finish(failure ?? (code === 0 ? undefined : new Error(`docker ${args[0]} exited ${code}${capture && output ? `: ${output.trim()}` : ''}`))));
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (abort.signal.aborted) throw abort.signal.reason;
    const state = JSON.parse(await docker(['inspect', '--format', '{{json .State}}', container], { capture: true }));
    assert.equal(state.Running, true, `Container stopped before becoming healthy (exit ${state.ExitCode})`);
    if (state.Health?.Status === 'healthy') return;
    assert.ok(state.Health, 'The image must supply a Docker HEALTHCHECK');
    await sleep(1000, undefined, { signal: abort.signal });
  }
  throw new Error('Container did not reach Docker healthy status within 120 seconds');
}

function volumeMounts() {
  return ['--mount', `type=volume,source=${volume},target=/data,volume-nocopy`, '--mount', `type=volume,source=${modelsVolume},target=/models,volume-nocopy`];
}
function startArguments() {
  return ['run', '--detach', '--name', container, '--label', `dev.mote.fixture=${runId}`, '--user', containerUser,
    '--publish', '127.0.0.1::47832', ...volumeMounts(),
    '--mount', `type=bind,source=${configurationDirectory},target=/config`, '--env', 'MOTE_CONFIG_FILE=/config/mote.yaml', '--env', 'MOTE_TOKEN', '--env', 'MOTE_DATA_KEY',
    '--health-interval', '2s', '--health-start-period', '1s', '--health-timeout', '5s', '--health-retries', '30', image];
}
async function startContainer() {
  // Match Compose's initialization policy: only empty roots are initialized;
  // any legacy nonempty ownership mismatch refuses without migration.
  await docker(['run', '--rm', '--name', storageInitializer, '--label', `dev.mote.fixture=${runId}`, '--network', 'none', '--user', '0:0', ...volumeMounts(), image,
    'node', 'scripts/storage-owner-entry.mjs', containerUser, '/data', '/models'], { capture: true });
  await docker(startArguments(), { capture: true });
  await waitForHealth();
  return baseUrl();
}
async function baseUrl() {
  const published = await docker(['port', container, '47832/tcp'], { capture: true });
  assert.match(published, /^127\.0\.0\.1:\d+$/, 'Only a random loopback port may be exposed');
  return `http://${published}`;
}

async function request(base, path, { status = 200, method = 'GET', body, token = fixtureToken } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
    headers: { 'X-Mote-Ingress-Version': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: expected HTTP ${status}, got ${response.status}: ${text.slice(0, 1000)}`);
  return { response, text, json: () => JSON.parse(text) };
}

const note = {
  id: randomUUID(), deviceId: `container-fixture-${runId}`, deviceName: 'Synthetic Docker fixture', platform: 'linux',
  capturedAt: new Date().toISOString(), text: '  合成容器验收记录\n验证原文、幂等与重启持久化。  ', mood: '平静（合成）',
};
async function assertSavedNote(base) {
  const saved = (await request(base, `/api/notes/${note.id}`)).json();
  assert.equal(saved.id, note.id); assert.equal(saved.deviceId, note.deviceId);
  assert.equal(saved.source, 'note'); assert.equal(saved.durationMs, 0);
  assert.equal(saved.ocrText, note.text, 'Note whitespace and original text must survive unchanged');
  assert.equal(saved.mood, note.mood); assert.equal(saved.capturedAt, note.capturedAt);
  assert.equal(saved.blobHash, null, 'A manual note must not create a fabricated image blob');
  const list = (await request(base, `/api/notes?deviceId=${note.deviceId}`)).json();
  assert.ok(Array.isArray(list.items));
  assert.equal(list.items.length, 1, 'Repeated submissions must not create another note');
  assert.equal(list.items[0].id, note.id);
}
async function assertDuplicate(base) {
  const duplicate = (await request(base, '/api/notes', { method: 'POST', status: 200, body: note })).json();
  assert.equal(duplicate.id, note.id); assert.equal(duplicate.duplicate, true);
  await assertSavedNote(base);
}

async function assertVendorHome(create = false) {
  // docker exec does not inherit CMD's environment. Read the actual Central
  // process and use that same HOME for both the write probe and official CLIs.
  const script = `
    import assert from 'node:assert/strict';
    import {readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
    import {join} from 'node:path';
    import {execFileSync} from 'node:child_process';
    import {managedCliBinary,cliReleases} from './apps/server/src/connectors/cli-runtime.mjs';
    const environment=Object.fromEntries(readFileSync('/proc/1/environ','utf8').split('\\0').filter(Boolean).map(entry=>{const at=entry.indexOf('=');return [entry.slice(0,at),entry.slice(at+1)];}));
    assert.equal(environment.HOME,'/data');
    assert.equal(process.getuid(),${Number(containerUser.split(':')[0])});
    for(const folder of ['.config/lark-cli','.dws']) {
      const directory=join(environment.HOME,folder),file=join(directory,'generated-persistence-fixture');
      if(${create}) {mkdirSync(directory,{recursive:true,mode:0o700});writeFileSync(file,${JSON.stringify(runId)},{mode:0o600,flag:'wx'});}
      assert.equal(statSync(directory).mode&0o777,0o700);assert.equal(statSync(file).mode&0o777,0o600);
      assert.equal(readFileSync(file,'utf8'),${JSON.stringify(runId)});
    }
    if(${create}) for(const provider of ['lark','dingtalk']) {
      const binary=managedCliBinary(provider),options={env:{...process.env,HOME:environment.HOME},encoding:'utf8',timeout:15000};
      const version=execFileSync(binary,provider==='dingtalk'?['version','--format','json']:['--version'],options);
      if(provider==='dingtalk')assert.equal(JSON.parse(version).version.replace(/^v/,''),cliReleases[provider].version);
      else assert.ok(version.includes(cliReleases[provider].version));
      assert.ok(execFileSync(binary,['--help'],options).length>0);
    }
    console.log(JSON.stringify({home:environment.HOME,uid:process.getuid(),privateGeneratedState:true,officialCliContracts:${create}}));
  `;
  console.info('[container] Vendor home: '+await docker(['exec',container,'node','--input-type=module','-e',script],{capture:true}));
}

async function assertPortableBackupExcludesVendorHome() {
  await docker(['stop','--time','10',container],{capture:true});
  const script = `
    import assert from 'node:assert/strict';
    import {readFileSync,existsSync} from 'node:fs';
    import {execFileSync} from 'node:child_process';
    const out='/tmp/generated-portable-backup';
    execFileSync(process.execPath,['scripts/backup.ts','--data','/data','--out',out],{stdio:'pipe',timeout:30000});
    const manifest=JSON.parse(readFileSync(out+'/backup-manifest.json','utf8'));
    assert.ok(manifest.checksums['mote.sqlite']);
    for(const prefix of ['.config','.dws']) {
      assert.equal(existsSync(out+'/'+prefix),false);
      assert.equal(Object.keys(manifest.checksums).some(key=>key.startsWith(prefix+'/')),false);
    }
    assert.equal(JSON.stringify(manifest).includes(${JSON.stringify(runId)}),false);
    console.log('Portable backup excludes generated vendor home state');
  `;
  console.info('[container] '+await docker(['run','--rm','--name',backupContainer,'--label',`dev.mote.fixture=${runId}`,'--network','none','--user',containerUser,...volumeMounts(),image,'node','--input-type=module','-e',script],{capture:true}));
}

async function prepareConfiguration() {
  const document = { version: 1, revision: 0,
    server: { profile: 'test', runtime: 'docker', host: '0.0.0.0', port: 47832, token: '${MOTE_TOKEN}' },
    storage: { dataDir: '/data', kind: 'docker-volume', source: volume, mount: '/data', dataKey: '${MOTE_DATA_KEY}', contentEncryptionEnabled: true },
    models: { deployment: { model: '' } }, diagnostics: { directory: '/data/logs', level: 'silent', traceEnabled: false },
    media: { modelDirectory: '/models', workerToken: '' },
  };
  await writeFile(configFile, serializeConfigDocument(document), { flag: 'wx', mode: 0o600 });
  assert.equal((await stat(configFile)).mode & 0o777, 0o600); assert.equal((await stat(configurationDirectory)).mode & 0o777, 0o700);
  const loaded = readConfigDocument(configFile, dockerEnv);
  assert.equal(loaded.document.server.token, fixtureToken); assert.equal(loaded.document.storage.dataKey, dockerEnv.MOTE_DATA_KEY);
  assert.deepEqual(loaded.savedDocument, document); assert.equal(loaded.document.models.deployment.model, '');
  const argv = startArguments();
  assert.deepEqual(argv.flatMap((value, index) => value === '--mount' && argv[index + 1].startsWith('type=volume,') ? [argv[index + 1]] : []), [
    `type=volume,source=${volume},target=/data,volume-nocopy`,
    `type=volume,source=${modelsVolume},target=/models,volume-nocopy`,
  ]);
  assert.ok(argv.includes(`type=bind,source=${configurationDirectory},target=/config`)); assert.ok(!argv.some(value => value.startsWith('MOTE_ENV_FILE=')));
  assert.deepEqual(argv.flatMap((value, index) => value === '--env' ? [argv[index + 1]] : []), ['MOTE_CONFIG_FILE=/config/mote.yaml', 'MOTE_TOKEN', 'MOTE_DATA_KEY']);
  assert.ok(argv.includes(containerUser)); assert.ok(!argv.join(' ').includes(fixtureToken));
}
try {
  await prepareConfiguration();
  if (fixtureOnly) console.info(JSON.stringify({ status: 'passed', fixtureOnly: true, privateYaml: true, parentDirectoryMount: true, declaredSecretReferences: true, noAutomaticMigration: true }));
  else {
    await docker(['version', '--format', '{{.Server.Version}}'], { capture: true, timeoutMs: 30_000 });
    daemonAvailable = true;
    containerUser = await dockerConfigurationUser({ configFile }, (_command, args, options) => docker(args, options));
    if(requireNonDefaultUid)assert.notEqual(Number(containerUser.split(':')[0]),1000,'This run must exercise a deployment UID other than the image node user');
    console.info('[container] Building the repository Dockerfile (local tag only)');
    await docker(['build', '--tag', image, '--file', 'Dockerfile', '.'], { timeoutMs: 15 * 60_000 });
    for (const name of [volume, modelsVolume]) await docker(['volume', 'create', '--label', `dev.mote.fixture=${runId}`, name], { capture: true });
    const mainConfiguration = await readFile(configFile, 'utf8');
    let base = await startContainer();
    await assertVendorHome(true);
    assert.equal((await request(base, '/api/health', { token: null })).json().ok, true);
    const page = await request(base, '/', { token: null });
    assert.match(page.response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(page.text, /<div id="root"><\/div>/, 'Built web UI must be served from the runtime image');
    await request(base, '/api/notes', { status: 401, token: null });
    await request(base, '/api/notes', { status: 401, token: 'synthetic-wrong-token-only' });
    await request(base, '/api/notes', { method: 'POST', body: note, status: 401, token: null });
    console.info('[container] Healthy runtime, bundled web UI and 401 authentication checks passed');
    const created = (await request(base, '/api/notes', { method: 'POST', status: 201, body: note })).json();
    assert.equal(created.id, note.id); assert.equal(created.duplicate, false);
    await assertSavedNote(base); await assertDuplicate(base);
    console.info('[container] Synthetic note create/read and duplicate ACK checks passed');
    await docker(['restart', '--time', '10', container], { capture: true });
    await waitForHealth(); base = await baseUrl();
    await assertVendorHome();
    await assertSavedNote(base); await assertDuplicate(base);
    console.info('[container] Same-container restart preserved the note and idempotency key');
    // Recreating with the same named /data volume also rules out accidental storage in the writable container layer.
    await docker(['rm', '--force', container], { capture: true });
    base = await startContainer();
    await assertVendorHome();
    await assertSavedNote(base); await assertDuplicate(base);
    await request(base, '/api/notes', { status: 401, token: null });
    assert.equal(await readFile(configFile, 'utf8'), mainConfiguration, 'Restart and replacement share the same unchanged main configuration');
    console.info('[container] Replacement container recovered the named volumes and shared YAML');
    await assertPortableBackupExcludesVendorHome();
    console.info('[container] All real Docker checks passed');
  }
} catch (error) {
  console.error(`[container] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  if (daemonAvailable) {
    await docker(['logs', '--tail', '160', container], { cleanup: true, timeoutMs: 15_000 }).catch(() => undefined);
    await docker(['inspect', '--format', '{{json .State}}', container], { cleanup: true, timeoutMs: 15_000 }).catch(() => undefined);
  }
  process.exitCode = 1;
} finally {
  if (daemonAvailable) {
    // Exact UUID names only: never prune unrelated containers, volumes, images or build caches.
    for (const name of [container, storageInitializer, backupContainer]) await docker(['rm', '--force', name], { capture: true, cleanup: true, timeoutMs: 30_000 }).catch(() => undefined);
    for (const name of [volume, modelsVolume]) await docker(['volume', 'rm', name], { capture: true, cleanup: true, timeoutMs: 30_000 }).catch(() => undefined);
    await docker(['image', 'rm', image], { capture: true, cleanup: true, timeoutMs: 30_000 }).catch(() => undefined);
  }
  await rm(configurationDirectory, { recursive: true, force: true });
}
