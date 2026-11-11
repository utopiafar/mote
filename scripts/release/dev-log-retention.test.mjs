import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {DEFAULT_LOG_RETENTION} from '../../apps/server/src/log-retention-config.mjs';
import { parseConfigDocument, serializeConfigDocument } from '../../packages/shared/src/config-file.ts';
import { repository, profilePaths, loadProfile, atomicJson, nativeIdentity, stopNative, assertLogRetentionCompatible, composeOperation, compose, updateProfileConfiguration } from '../profile-lib.mjs';
import { cli, freePort, request } from '../profile-fixtures.mjs';
const MiB = 1024 * 1024;

async function fixture(t, profile = 'dev') {
  const home = await mkdtemp(join(tmpdir(), 'mote-log-retention-fixture-'));
  t.after(async () => {
    // Invalid candidate YAML must not prevent cleanup of generated fixtures.
    const p = await loadProfile(profilePaths(profile, home)).catch(() => undefined);
    if (p) { const current = await nativeIdentity(p); if (current.running && current.managed) await stopNative(p); }
    await rm(home, { recursive: true, force: true });
  });
  await cli(home, profile, 'init', ['--port', String(await freePort())]);
  const p = await loadProfile(profilePaths(profile, home)), release = await releaseFixture(home, 'capable');
  await atomicJson(p.metaFile, { ...p.meta, release });
  return loadProfile(profilePaths(profile, home));
}
async function releaseFixture(home, kind) {
  const release = join(home, `${kind}-release`);
  await mkdir(join(release, 'apps/server/dist'), { recursive: true });
  await writeFile(join(release, 'package.json'), '{"type":"module"}');
  if (kind !== 'env-legacy') await writeFile(join(release, 'apps/server/dist/config-service.js'), '// Generated YAML capability marker\n');
  if(kind==='capable')for(const name of ['log-retention-config.mjs','diagnostic-log-store.mjs'])await writeFile(join(release,'apps/server/dist',name),'// Generated capability marker\n');
  const reader = new URL('packages/shared/src/config-file.ts', 'file://' + repository + '/').href;
  // Exercise actual CLI/supervisor ordering with a generated strict YAML target.
  await writeFile(join(release, 'apps/server/dist/index.js'), `import {createServer} from 'node:http';import {writeFileSync} from 'node:fs';import {resolve,dirname} from 'node:path';import {readConfigDocument} from ${JSON.stringify(reader)};
const document=readConfigDocument(process.env.MOTE_CONFIG_FILE).document,diagnostics=document.diagnostics??{},max=diagnostics.maxBytes??${kind === 'capable' ? '16*1024*1024' : '2*1024*1024'};
if(!Number.isFinite(max)||max<0.1*1024*1024||max>${kind === 'capable' ? 100 : 8}*1024*1024)throw Error('Generated strict capacity parser rejected configuration');
writeFileSync(resolve(dirname(process.env.MOTE_CONFIG_FILE),document.storage.dataDir,'generated-entry-ran'),'Generated entry reached');
const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(req.url==='/api/diagnostics'?{limits:{maxFileBytes:Math.floor(max),maxTotalBytes:diagnostics.maxTotalBytes??2147483648,maxEvents:diagnostics.maxEntries??2000}}:{ok:true}));});
server.listen(document.server.port,'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\n`);
  return release;
}
const configuration = async p => JSON.parse((await cli(p.home, p.profile, 'config')).stdout).diagnostics;
const adopt = async p => JSON.parse((await cli(p.home, p.profile, 'log-retention', ['--defaults'])).stdout);
const otherValues = raw => { const document = parseConfigDocument(raw).savedDocument; delete document.diagnostics.maxBytes; delete document.revision; return document; };

test('fresh YAML profiles resolve DEV defaults without saving an explicit capacity; inspection is read-only', async t => {
  for (const profile of ['dev', 'test', 'prod']) {
    const p = await fixture(t, profile), raw = await readFile(p.configFile);
    assert.equal(Object.hasOwn(p.savedDocument.diagnostics, 'maxBytes'), false);
    assert.deepEqual(await configuration(p), { logMaxMiB:16,logMaxTotalMiB:2048,retention:DEFAULT_LOG_RETENTION, logMaxEntries: 2000, logMaxMiBSource: 'profile-default' });
    assert.deepEqual(await readFile(p.configFile), raw);
    if (profile === 'dev') {
      assert.deepEqual(await adopt(p), { profile, changed: false, before: { maxFileMiB:16,maxTotalMiB:2048 }, after: { maxFileMiB:16,maxTotalMiB:2048 }, restartRequired: true });
    } else assert.match((await cli(p.home, profile, 'log-retention', ['--defaults'], { fail: true })).stderr, /only available for the dev profile/);
    assert.deepEqual(await readFile(p.configFile), raw);
  }
});

test('explicit numeric YAML limits are preserved until adoption, which changes only capacity and revision', async t => {
  for (const maxMiB of [2, 7, 75, 100]) {
    const p = await fixture(t);
    await updateProfileConfiguration(p, document => {
      Object.assign(document.diagnostics, { maxBytes: maxMiB * MiB, maxEntries: 4317 });
      document.models.deployment ??= {}; document.models.deployment.apiKey = 'generated-private-model-key'; document.storage.dataKey = 'a'.repeat(64);
      document.server.publicUrl = 'https://generated-retention.example';
    });
    const raw = await readFile(p.configFile, 'utf8'), metadata = await readFile(p.metaFile);
    await writeFile(join(p.dataDir, 'generated-evidence.txt'), 'Generated archive marker');
    assert.deepEqual(await configuration(p), { logMaxMiB:maxMiB,logMaxTotalMiB:2048,retention:DEFAULT_LOG_RETENTION, logMaxEntries: 4317, logMaxMiBSource: 'explicit' });
    assert.deepEqual(await readFile(p.configFile, 'utf8'), raw);
    await cli(p.home, 'dev', 'log-retention', [], { fail: true }); assert.equal(await readFile(p.configFile, 'utf8'), raw);
    const result = await adopt(p), next = await readFile(p.configFile, 'utf8'), parsed = parseConfigDocument(next).savedDocument;
    assert.deepEqual(result, { profile: 'dev', changed: true, before: { maxFileMiB:maxMiB,maxTotalMiB:2048 }, after: { maxFileMiB:16,maxTotalMiB:2048 }, restartRequired: true });
    assert.equal(Object.hasOwn(parsed.diagnostics, 'maxBytes'), false);
    assert.equal(parsed.revision, parseConfigDocument(raw).savedDocument.revision + 1);
    assert.deepEqual(otherValues(next), otherValues(raw)); assert.deepEqual(await readFile(p.metaFile), metadata);
    assert.equal((await stat(p.configFile)).mode & 0o777, 0o600); assert.deepEqual(await readdir(p.dataDir), ['generated-evidence.txt']);
    assert.ok(!(await readdir(p.directory)).some(name => name === 'process.json' || name === 'lifecycle.lock' || name.endsWith('.tmp')));
    for (const privateValue of [p.directory, p.env.MOTE_TOKEN, 'generated-private-model-key', 'https://generated-retention.example']) assert.ok(!JSON.stringify(result).includes(privateValue));
    assert.equal((await adopt(p)).changed, false); assert.equal(await readFile(p.configFile, 'utf8'), next);
    assert.equal((await configuration(p)).logMaxMiBSource, 'profile-default');
  }
});

test('invalid YAML limits and active lifecycle ownership fail without changing private configuration', async t => {
  for (const capacity of [-1, 101 * MiB, 'auto', null]) {
    const p = await fixture(t), saved = structuredClone(p.savedDocument); saved.diagnostics.maxBytes = capacity;
    const raw = serializeConfigDocument(saved); await writeFile(p.configFile, raw);
    await cli(p.home, 'dev', 'log-retention', ['--defaults'], { fail: true }); assert.equal(await readFile(p.configFile, 'utf8'), raw);
    assert.ok(!(await readdir(p.directory)).some(name => name === 'lifecycle.lock' || name.endsWith('.tmp')));
  }
  const p = await fixture(t), raw = await readFile(p.configFile);
  await writeFile(join(p.directory, 'lifecycle.lock'), String(process.pid), { mode: 0o600 });
  assert.match((await cli(p.home, 'dev', 'log-retention', ['--defaults'], { fail: true })).stderr, /Another profile command is running/);
  assert.deepEqual(await readFile(p.configFile), raw); assert.equal(await readFile(join(p.directory, 'lifecycle.lock'), 'utf8'), String(process.pid));
});

test('older targets reject tiered diagnostics before launch regardless of segment capacity', async t => {
  let p = await fixture(t), release = await releaseFixture(p.home, 'legacy');
  await atomicJson(p.metaFile, { ...p.meta, release }); p = await loadProfile(profilePaths('dev', p.home));
  await writeFile(join(p.dataDir, 'generated-evidence.txt'), 'Generated evidence is untouched');
  for (const maxBytes of [undefined,100*MiB,2*MiB]) {
    await updateProfileConfiguration(p, document => { if (maxBytes === undefined) delete document.diagnostics.maxBytes; else document.diagnostics.maxBytes = maxBytes; });
    const raw = await readFile(p.configFile), meta = await readFile(p.metaFile);
    assert.match((await cli(p.home, 'dev', 'start', [], { fail: true })).stderr, /tiered diagnostic retention/);
    assert.deepEqual(await readFile(p.configFile), raw); assert.deepEqual(await readFile(p.metaFile), meta);
    assert.deepEqual(await readdir(p.dataDir), ['generated-evidence.txt']); assert.ok(!(await readdir(p.directory)).includes('process.json'));
  }
  await updateProfileConfiguration(p, document => { document.diagnostics.maxBytes = 2 * MiB; });
  const raw = await readFile(p.configFile); await cli(p.home, 'dev', 'log-retention', ['--defaults'], { fail: true }); assert.deepEqual(await readFile(p.configFile), raw);
  await cli(p.home,'dev','start',[],{fail:true});
  const envRelease = await releaseFixture(p.home, 'env-legacy'); await atomicJson(p.metaFile, { ...p.meta, release: envRelease });
  assert.match((await cli(p.home, 'dev', 'start', [], { fail: true })).stderr, /YAML configuration/);
  assert.deepEqual(await readFile(p.configFile), raw);
});

test('incompatible upgrade and rollback reject before stopping the process, backing up or restoring', async t => {
  let p = await fixture(t), legacy = await releaseFixture(p.home, 'legacy');
  const snapshot = join(p.home, 'generated-previous-snapshot'); await mkdir(snapshot);
  const database = new DatabaseSync(join(snapshot, 'mote.sqlite'));
  database.exec("CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES ('backend_epoch','7')"); database.close();
  const hash = createHash('sha256').update(await readFile(join(snapshot, 'mote.sqlite'))).digest('hex');
  await atomicJson(join(snapshot, 'backup-manifest.json'), { version: 1, storageEpoch: 7, checksums: { 'mote.sqlite': hash } });
  await atomicJson(p.metaFile, { ...p.meta, previous: { ...p.meta, release: legacy, backup: snapshot } }); p = await loadProfile(profilePaths('dev', p.home));
  await writeFile(join(p.dataDir, 'generated-evidence.txt'), 'Generated current evidence'); await cli(p.home, 'dev', 'start');
  const raw = await readFile(p.configFile), meta = await readFile(p.metaFile), processRecord = await readFile(p.processFile);
  const dataNames = (await readdir(p.dataDir)).sort(), backupNames = await readdir(join(p.directory, 'backups'));
  for (const [action, args] of [['upgrade', ['--release', legacy]], ['rollback', ['--restore-data']]]) {
    assert.match((await cli(p.home, 'dev', action, args, { fail: true })).stderr, /could not be verified to support YAML configuration or this log capacity/);
    assert.deepEqual(await readFile(p.configFile), raw); assert.deepEqual(await readFile(p.metaFile), meta); assert.deepEqual(await readFile(p.processFile), processRecord);
    assert.deepEqual((await readdir(p.dataDir)).sort(), dataNames); assert.deepEqual(await readdir(join(p.directory, 'backups')), backupNames);
    assert.equal(await readFile(join(p.dataDir, 'generated-evidence.txt'), 'utf8'), 'Generated current evidence'); assert.equal((await nativeIdentity(p)).running, true);
    assert.equal((await request(p,'/api/diagnostics')).limits.maxFileBytes,16*MiB);
  }
});

test('Docker capability probes are inert, offline and bounded and always verify YAML support', async () => {
  const p = { profile: 'dev', document: { server: { profile: 'dev' }, diagnostics: {} }, meta: { runtime: 'docker', image: 'generated-capability-image' } }, calls = [];
  await assertLogRetentionCompatible(p, { execute: async (...args) => { calls.push(args); return ''; } });
  const [binary, args, options] = calls[0]; assert.equal(binary, 'docker');
  assert.deepEqual(args.slice(0, 10), ['run', '--rm', '--pull', 'never', '--network', 'none', '--entrypoint', 'node', 'generated-capability-image', '--input-type=module']);
  assert.deepEqual(options, { capture: true, timeoutMs: 15000 });
  assert.ok(!args.slice(0, 9).some(value => ['--volume', '--mount', '-v', '-e', '--env', '--env-file'].includes(value)));
  assert.match(args.at(-1), /config-service.js/); assert.match(args.at(-1), /log-retention-config.mjs/);
  await assert.rejects(assertLogRetentionCompatible(p, { execute: async () => { throw Error('Generated private Docker output'); } }), error => /tiered diagnostic retention/.test(error.message) && !error.message.includes('Generated private Docker output'));
  for (const maxBytes of [2 * MiB, 8 * MiB]) await assertLogRetentionCompatible({ ...p, document: { ...p.document, diagnostics: { maxBytes } } }, { execute: async (_, args) => { assert.match(args.at(-1), /config-service.js/); assert.match(args.at(-1),/diagnostic-log-store.mjs/); } });
});

test('Compose finds subcommands after global options without changing transport arguments', () => {
  for (const [args, operation] of [
    [['up', '--detach'], 'up'], [['--profile', 'up', 'ps'], 'ps'],
    [['--ansi', 'never', '--parallel', '2', '--progress', 'plain', 'up', '--detach'], 'up'],
    [['-p', 'generated-project', '-f', 'generated.yaml', '--project-directory', '/generated', '--env-file', '/generated.env', 'create'], 'create'],
    [['--project-name=generated', '--file=generated.yaml', '--profile=generated', '--parallel=2', '--ansi=never', '--progress=plain', 'restart'], 'restart'],
    [['-pgenerated', '-fgenerated.yaml', '--dry-run', 'run', '--rm', 'mote'], 'run'], [['--compatibility', '--', 'up'], 'up'], [['--help'], undefined],
  ]) { const before = [...args]; assert.equal(composeOperation(args), operation); assert.deepEqual(args, before); }
});

test('Compose global flags cannot bypass target preflight before generated configuration writes', async t => {
  const p = await fixture(t), release = await releaseFixture(p.home, 'legacy'), prospective = { ...p, meta: { ...p.meta, release } };
  const raw = await readFile(p.configFile), meta = await readFile(p.metaFile);
  // Native marker inspection isolates dispatch ordering from a Docker engine.
  for (const operation of ['up', 'create', 'run', 'restart']) {
    await assert.rejects(compose(prospective, ['--ansi', 'never', '--profile=generated', '-pgenerated', operation]), /could not be verified/);
    assert.deepEqual(await readdir(join(p.directory, 'generated')), []); assert.deepEqual(await readFile(p.configFile), raw); assert.deepEqual(await readFile(p.metaFile), meta);
  }
});
