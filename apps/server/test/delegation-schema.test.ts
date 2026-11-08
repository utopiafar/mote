import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {DelegationRuntime} from '../src/delegation-runtime.js';
import {SourceStore} from '../src/sources.js';
import {restoreProfile} from '../../../scripts/profile-lib.mjs';

const table = 'delegation_source_context_dependencies';

test('an old-epoch vault holding the retired delegation schema is refused without rewriting data', t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-delegation-schema-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const db = new DatabaseSync(join(directory, 'mote.sqlite'));
  db.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE delegation_works(id TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE ${table}(work_id TEXT NOT NULL REFERENCES delegation_works(id) ON DELETE CASCADE,
      unit_id TEXT NOT NULL,source_id TEXT NOT NULL,version INTEGER NOT NULL,fingerprint TEXT NOT NULL,
      PRIMARY KEY(work_id,unit_id,source_id,version,fingerprint));`);
  db.prepare("INSERT INTO settings VALUES('backend_epoch','6')").run();
  db.prepare('INSERT INTO delegation_works VALUES(?,?)').run('generated-work', '{"goal":"Preserve generated work"}');
  db.prepare(`INSERT INTO ${table} VALUES(?,?,?,?,?)`).run('generated-work', '', 'generated-source', 7, 'a'.repeat(64));
  db.close();
  const path = join(directory, 'mote.sqlite'), before = readFileSync(path), entries = readdirSync(directory).sort();
  assert.throws(() => new Store(directory), error => {
    assert.equal((error as Error & {statusCode?: number}).statusCode, 409);
    assert.match((error as Error).message, /Backend epoch 7 requires a new empty data directory/);
    return true;
  });
  assert.deepEqual(readFileSync(path), before, 'the refused vault keeps its exact bytes and retired rows');
  assert.deepEqual(readdirSync(directory).sort(), entries);
});

test('fresh and repeated current delegation initialization retain kind-qualified source versions across current backup restore', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mote-delegation-current-')));
  const directory = join(root, 'source'), restoredDirectory = join(root, 'restored'), snapshot = join(root, 'snapshot');
  const stores: Store[] = [], engines: ExecutionEngine[] = [], runtimes: DelegationRuntime[] = [];
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    for (const engine of engines) await engine.close();
    for (const store of stores) store.close();
    rmSync(root, {recursive: true, force: true});
  });
  const store = new Store(directory); stores.push(store);
  const sources = new SourceStore(store);
  sources.register({id: 'generated-source', name: 'Generated source', kind: 'custom', deviceId: 'generated-device', platform: 'import'});
  const first = sources.updateContext('generated-source', {expectedVersion: 0, description: 'Generated first business description'});
  const second = sources.updateContext('generated-source', {expectedVersion: 1, description: 'Generated current business description'});
  const engine = new ExecutionEngine(store); engines.push(engine);
  const runtime = new DelegationRuntime(store, engine, {autoPump: false}); runtimes.push(runtime);
  const columns = store.db.prepare(`PRAGMA table_info(${table})`).all();
  assert.deepEqual(columns.filter(column => Number(column.pk)).sort((a, b) => Number(a.pk) - Number(b.pk)).map(column => column.name), ['work_id', 'unit_id', 'kind', 'source_id', 'version', 'fingerprint']);
  runtime.registerCoordinator({id: 'generated', execute: async () => 'Generated completed work'});
  runtime.start({id: 'generated-work', profileId: 'generated', goal: 'Generated current work', input: {}, allowedCapabilities: []});
  const pins = [{sourceId: first.sourceId, version: first.version, fingerprint: first.fingerprint!}, {sourceId: second.sourceId, version: second.version, fingerprint: second.fingerprint!}, sources.contexts.metadataIdentity('generated-source')];
  runtime.recordSourceContextDependencies('generated-work', pins);
  runtime.recordSourceContextDependencies('generated-work', pins);
  const dependencies = runtime.sourceContextDependencies('generated-work');
  assert.equal(dependencies.length, 3, 'business revisions and metadata pins remain distinct; repeated acknowledgement is idempotent');
  await runtime.close();
  const repeated = new DelegationRuntime(store, engine, {autoPump: false}); runtimes.push(repeated);
  assert.deepEqual(repeated.sourceContextDependencies('generated-work'), dependencies);
  assert.deepEqual(store.db.prepare(`PRAGMA table_info(${table})`).all(), columns);
  await repeated.close();
  await engine.close();
  const backupScript = fileURLToPath(new URL('../../../scripts/backup.ts', import.meta.url));
  execFileSync(process.execPath, [backupScript, '--data', directory, '--out', snapshot], {stdio: 'pipe'});
  await restoreProfile({meta: {runtime: 'native'}, dataDir: restoredDirectory, processFile: join(root, 'missing-process')}, snapshot);
  const restored = new Store(restoredDirectory); stores.push(restored);
  const restoredEngine = new ExecutionEngine(restored); engines.push(restoredEngine);
  const restoredRuntime = new DelegationRuntime(restored, restoredEngine, {autoPump: false}); runtimes.push(restoredRuntime);
  assert.deepEqual(restoredRuntime.sourceContextDependencies('generated-work'), dependencies);
  const restoredSources = new SourceStore(restored);
  assert.deepEqual(restoredSources.contexts.current('generated-source'), second);
  assert.equal(restoredSources.contexts.getAtVersion('generated-source', first.version, first.fingerprint)?.description, first.description);
  assert.equal(restored.db.prepare('PRAGMA user_version').get()!.user_version, 7);
  assert.equal(restored.db.prepare("SELECT value FROM settings WHERE key='backend_epoch'").get()!.value, '7');
});
