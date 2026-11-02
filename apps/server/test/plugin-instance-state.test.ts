import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {backup} from 'node:sqlite';
import {PluginHost} from '@mote/plugin-host';
import {StateError, stateLimits, type ScopeIdentity, type StateLimits, type StateStore} from '@mote/plugin-api';
import {Store} from '../src/store.js';
import {createInstanceState} from '../src/plugins/instance-state.js';

const lifecycle = () => ({prepare() {}, start() {}, quiesce() {}, stop() {}, dispose() {}});
const hostIdentity = {kind: 'central' as const, id: 'generated-state-host'};
const identity = (instanceId: string, activationId = randomUUID()): ScopeIdentity => ({
  host: hostIdentity, packageId: 'generated.reading', installationId: 'generated-installation', instanceId, activationId,
});

function fixture(t: {after: (work: () => unknown) => void}, options: {maxStorageBytes?: number} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-instance-state-'));
  const store = new Store(directory, options);
  const host = new PluginHost(hostIdentity);
  t.after(() => { try { store.close(); } finally { rmSync(directory, {recursive: true, force: true}); } });
  t.after(async () => { await host.close().catch(() => {}); });
  return {directory, store, host};
}

async function install(host: PluginHost, store: Store, instanceId: string, activationId = randomUUID(), limits?: StateLimits) {
  let state!: StateStore;
  const handle = await host.install({
    identity: identity(instanceId, activationId), contributions: [],
    factory: context => { state = createInstanceState(store, context.scope, limits); return lifecycle(); },
  });
  return {handle, state};
}

test('state is instance-scoped, activation is not persistent, and disable retains state', async t => {
  const {host, store} = fixture(t);
  const a = await install(host, store, 'instance-a'), b = await install(host, store, 'instance-b');
  await a.state.compareAndSet('review', null, {step: 1});
  await b.state.compareAndSet('review', null, {step: 2});
  assert.deepEqual((await a.state.get('review'))?.value, {step: 1});
  assert.deepEqual((await b.state.get('review'))?.value, {step: 2});

  await a.handle.close('disabled');
  const resumed = await install(host, store, 'instance-a', randomUUID());
  assert.deepEqual((await resumed.state.get('review'))?.value, {step: 1});
  assert.equal((await resumed.state.compareAndSet('review', 1, {step: 3})).revision, 2);
  assert.deepEqual((await b.state.get('review'))?.value, {step: 2});
});

test('compare-and-set admits exactly one writer, keeps revisions, and checkpoints only committed state', async t => {
  const {host, store} = fixture(t);
  const a = await install(host, store, 'instance-a');
  await a.state.compareAndSet('review', null, {value: 1});
  const before = await a.state.checkpoint();
  const results = await Promise.allSettled([
    a.state.compareAndSet('review', 1, {value: 2}),
    a.state.compareAndSet('review', 1, {value: 3}),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const conflict = results.find(result => result.status === 'rejected');
  assert.equal((conflict as PromiseRejectedResult).reason instanceof StateError, true);
  assert.equal((conflict as PromiseRejectedResult).reason.code, 'conflict');
  const current = await a.state.get('review');
  assert.equal(current?.revision, 2);
  const after = await a.state.checkpoint();
  assert.notEqual(before.digest, after.digest);
  assert.equal(after.records, 1);
  assert.ok(after.bytes > 0);
  assert.equal(await a.state.get('missing'), undefined);
  await assert.rejects(a.state.compareAndSet('missing', 1, {value: 1}), (error: StateError) => error.code === 'not_found');
  await assert.rejects(a.state.compareAndSet('review', 0, {value: 1}), (error: StateError) => error.code === 'conflict');
  await assert.rejects(a.state.list('', 0), (error: StateError) => error.code === 'invalid_limit');
  assert.equal((await a.state.list('rev', 1)).length, 1);
});

test('keys, values and namespace accounting are bounded without partial writes', async t => {
  const {host, store} = fixture(t);
  const a = await install(host, store, 'instance-a');
  await assert.rejects(a.state.compareAndSet('k'.repeat(stateLimits.keyBytes + 1), null, 1), (error: StateError) => error.code === 'invalid_key');
  await assert.rejects(a.state.compareAndSet('bad\0key', null, 1), (error: StateError) => error.code === 'invalid_key');
  await assert.rejects(a.state.compareAndSet('large', null, 'x'.repeat(stateLimits.valueBytes)), (error: StateError) => error.code === 'value_too_large');

  const before = store.stats().logicalBytes;
  await a.state.compareAndSet('metered', null, 'x'.repeat(1024));
  const afterWrite = store.stats().logicalBytes;
  assert.ok(afterWrite >= before + 1024);
  await a.state.compareAndSet('metered', 1, 'x'.repeat(2048));
  assert.ok(store.stats().logicalBytes > afterWrite);

  for (let index = 0; index < 17; index++) {
    const key = 'bulk-' + index;
    if (index < 16) await a.state.compareAndSet(key, null, 'x'.repeat(65000));
    else await assert.rejects(a.state.compareAndSet(key, null, 'x'.repeat(65000)), (error: StateError) => error.code === 'namespace_limit');
  }
  assert.equal(await a.state.get('bulk-16'), undefined);
  assert.equal((await a.state.checkpoint()).records, 17);

  const strict = await install(host, store, 'instance-strict', randomUUID(), {...stateLimits, valueBytes: 8});
  await assert.rejects(strict.state.compareAndSet('k', null, '12345678'), (error: StateError) => error.code === 'value_too_large');
});

test('the existing metadata budget rejects an oversized state write and rolls it back', async t => {
  const {host, store} = fixture(t, {maxStorageBytes: 2048});
  const a = await install(host, store, 'instance-a');
  await assert.rejects(a.state.compareAndSet('large', null, 'x'.repeat(4096)), (error: StateError) => error.code === 'limit_exceeded');
  assert.equal(await a.state.get('large'), undefined);
  assert.equal((await a.state.checkpoint()).records, 0);
  await a.state.compareAndSet('small', null, 'ok');
  assert.equal((await a.state.get('small'))?.value, 'ok');
});

test('the global reservation includes the full ledger row cost at the boundary', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'mote-instance-state-boundary-'));
  const probe = new Store(directory), base = probe.logicalBytes();
  probe.close();
  const key = 'boundary', value = 'x'.repeat(4000), scope = identity('instance-a');
  const fixed = Buffer.byteLength(scope.packageId) + Buffer.byteLength(scope.installationId) +
    Buffer.byteLength(scope.instanceId) + 24 + 32;
  const max = base + Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value)) + fixed - 1;
  const store = new Store(directory, {maxStorageBytes: max}), host = new PluginHost(hostIdentity);
  t.after(async () => { await host.close().catch(() => {}); store.close(); rmSync(directory, {recursive: true, force: true}); });
  const a = await install(host, store, 'instance-a');
  await assert.rejects(a.state.compareAndSet(key, null, value), (error: StateError) => error.code === 'limit_exceeded');
  assert.equal(await a.state.get(key), undefined);
  assert.equal((await a.state.checkpoint()).records, 0);
});

test('restart and the existing whole-database backup retain current-format state', async t => {
  const {directory, host, store} = fixture(t);
  const a = await install(host, store, 'instance-a');
  await a.state.compareAndSet('review', null, {step: 1});
  const checkpoint = await a.state.checkpoint();
  await a.handle.close('disabled');
  await host.close();
  store.close();

  const reopened = new Store(directory), reopenedHost = new PluginHost(hostIdentity);
  t.after(async () => { await reopenedHost.close().catch(() => {}); reopened.close(); });
  const resumed = await install(reopenedHost, reopened, 'instance-a');
  assert.deepEqual((await resumed.state.get('review'))?.value, {step: 1});
  assert.equal((await resumed.state.checkpoint()).digest, checkpoint.digest);

  const backupDirectory = mkdtempSync(join(tmpdir(), 'mote-instance-state-backup-'));
  const restoreDirectory = mkdtempSync(join(tmpdir(), 'mote-instance-state-restore-'));
  t.after(() => { rmSync(backupDirectory, {recursive: true, force: true}); rmSync(restoreDirectory, {recursive: true, force: true}); });
  await backup(reopened.db, join(backupDirectory, 'mote.sqlite'));
  await resumed.handle.close('disabled');
  await reopenedHost.close();
  reopened.close();
  copyFileSync(join(backupDirectory, 'mote.sqlite'), join(restoreDirectory, 'mote.sqlite'));

  const restored = new Store(restoreDirectory), restoredHost = new PluginHost(hostIdentity);
  t.after(async () => { await restoredHost.close().catch(() => {}); restored.close(); });
  const restoredState = await install(restoredHost, restored, 'instance-a');
  assert.deepEqual((await restoredState.state.get('review'))?.value, {step: 1});
  assert.equal((await restoredState.state.checkpoint()).digest, checkpoint.digest);
});

test('quiesce rejects new admissions, stop rejects the old scope, and state is absent from host snapshots', async t => {
  const {host, store} = fixture(t);
  const a = await install(host, store, 'instance-a');
  await a.state.compareAndSet('secret', null, 'private-value');
  assert.equal(JSON.stringify(host.snapshot()).includes('private-value'), false);
  assert.equal(JSON.stringify(host.snapshot()).includes('secret'), false);

  const pending = a.state.compareAndSet('late', null, 1);
  await a.handle.quiesce();
  await assert.rejects(pending, (error: StateError) => error.code === 'quiesced');
  await assert.rejects(a.state.get('secret'), (error: StateError) => error.code === 'quiesced');
  await a.handle.close('disabled');
  await assert.rejects(a.state.get('secret'), (error: StateError) => error.code === 'stale_scope');
});
