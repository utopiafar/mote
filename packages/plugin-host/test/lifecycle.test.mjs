import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer, connect} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {Context} from '@deepseek-ai/cordis';
import {serviceContract, pluginSnapshotSchema} from '@mote/plugin-api/contracts';
import {PluginHost, PluginResourceScope} from '@mote/plugin-host';

const hostId = {kind: 'central', id: 'generated-host-1'};
const identity = name => ({host: hostId, packageId: 'fixture.plugin', installationId: 'fixture-install', instanceId: name, activationId: name + '-activation'});
const lifecycle = (overrides = {}) => ({prepare() {}, start() {}, quiesce() {}, stop() {}, dispose() {}, ...overrides});
const reader = serviceContract('fixture.reader', '1');
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
const hasFailure = (error, target) => error === target || error instanceof AggregateError && error.errors.some(item => hasFailure(item, target));
function roundTrip(port) {
  return new Promise((resolve, reject) => {
    const socket = connect({host: '127.0.0.1', port}); let text = '';
    socket.on('data', bytes => { text += bytes.toString(); }); socket.on('end', () => resolve(text)); socket.on('error', reject);
  });
}
async function networkPlugin(host, name) {
  let binding, server, ticks = 0;
  const firstTick = gate();
  const handle = await host.install({identity: identity(name), contributions: [reader], factory: async context => {
    server = createServer(socket => { context.scope.defer(() => { socket.destroy(); }); socket.end(name); });
    context.scope.defer(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    context.scope.every(1, () => { ticks++; firstTick.resolve(); });
    binding = context.provide(reader.id, reader, Object.freeze({port: server.address().port, name}));
    return lifecycle();
  }});
  await firstTick.promise;
  return {handle, binding, server, ticks: () => ticks};
}

test('the host injects instance-bound state and fails closed without a provider', async t => {
  const observed = [], host = new PluginHost(hostId, undefined, undefined, {stateFor: scope => ({
    stateIdentity: scope.identity.instanceId, get: async () => undefined, list: async () => [],
    compareAndSet: async () => { throw Error('unused'); }, checkpoint: async () => ({digest: '', bytes: 0, records: 0}),
  })});
  t.after(() => host.close());
  for (const name of ['state-one', 'state-two']) await host.install({identity: identity(name), contributions: [], factory: context => {
    observed.push({instanceId: context.scope.identity.instanceId, stateIdentity: context.state.stateIdentity});
    return lifecycle();
  }});
  assert.deepEqual(observed, [
    {instanceId: 'state-one', stateIdentity: 'state-one'},
    {instanceId: 'state-two', stateIdentity: 'state-two'},
  ]);
  const without = new PluginHost(hostId); t.after(() => without.close());
  await without.install({identity: identity('state-missing'), contributions: [], factory: async context => {
    await assert.rejects(context.state.get('key'), {code: 'dependency_unavailable'});
    return lifecycle();
  }});
});

test('two real plugins own independent listeners/timers and closing one leaves its sibling callable', {timeout: 5000}, async t => {
  const root = new Context(), host = new PluginHost(hostId, root);
  root.provide('fixtureUnrelated', {alive: true});
  t.after(async () => { await host.close(); await root.fiber.dispose(); });
  const a = await networkPlugin(host, 'one'), b = await networkPlugin(host, 'two');
  let consumerLease, consumerClosed = 0;
  await host.install({identity: identity('network-consumer'), contributions: [], requires: [a.binding], factory: async context => {
    consumerLease = await context.services.acquire(reader, a.binding);
    context.scope.defer(() => { consumerClosed++; });
    return lifecycle();
  }});
  assert.equal(await roundTrip(consumerLease.value.port), 'one');
  const leaseA = await host.acquire(reader, a.binding), leaseB = await host.acquire(reader, b.binding);
  assert.equal(await roundTrip(leaseA.value.port), 'one'); assert.equal(await roundTrip(leaseB.value.port), 'two');
  await a.handle.close(); const stopped = a.ticks();
  assert.equal(a.server.listening, false); assert.equal(leaseA.signal.aborted, true);
  assert.equal(consumerLease.signal.aborted, true); assert.equal(consumerClosed, 1);
  assert.throws(() => leaseA.assertCurrent(), {code: 'dependency_unavailable'});
  assert.equal(await roundTrip(leaseB.value.port), 'two'); assert.equal(a.ticks(), stopped);
  assert.equal(b.server.listening, true); assert.ok(b.ticks() > 0);
  const snapshot = pluginSnapshotSchema.parse(JSON.parse(JSON.stringify(host.snapshot())));
  assert.equal(snapshot.contributions.length, 1); assert.equal(snapshot.contributions[0].identity.scope.instanceId, 'two');
  await leaseA.release(); await leaseB.release();
  await host.close(); assert.equal(root.get('fixtureUnrelated').alive, true);
});

test('optional provider loss revokes its lease while the consumer remains active', async t => {
  const host = new PluginHost(hostId); let binding, optionalLease, consumerSignal;
  t.after(() => host.close());
  const provider = await host.install({identity: identity('optional-provider'), contributions: [reader], factory: context => {
    binding = context.provide(reader.id, reader, {read() { return 'generated'; }}); return lifecycle();
  }});
  await host.install({identity: identity('optional-consumer'), contributions: [], optional: [binding], factory: async context => {
    consumerSignal = context.scope.signal; optionalLease = await context.services.acquire(reader, binding); return lifecycle();
  }});
  assert.equal(optionalLease.value.read(), 'generated'); await provider.close();
  assert.equal(optionalLease.signal.aborted, true); assert.equal(consumerSignal.aborted, false);
  assert.throws(() => optionalLease.value.read(), {code: 'dependency_unavailable'});
});

test('install pins the admitted factory instead of reading a mutated definition during async startup', async t => {
  const host = new PluginHost(hostId); let selected = '';
  t.after(() => host.close());
  const definition = {identity: identity('pinned-factory'), contributions: [], factory() { selected = 'admitted'; return lifecycle(); }};
  const installing = host.install(definition);
  definition.factory = () => { selected = 'mutated'; return lifecycle(); };
  await installing; assert.equal(selected, 'admitted');
});

test('partially initialized provider closes its actual listener and preserves the primary failure', {timeout: 5000}, async t => {
  const host = new PluginHost(hostId), failure = Error('generated prepare failure'); let server;
  t.after(() => host.close());
  await assert.rejects(host.install({identity: identity('partial'), contributions: [reader], factory: async context => {
    server = createServer();
    context.scope.defer(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context.provide(reader.id, reader, {read() { return 'must-not-publish'; }});
    return lifecycle({prepare() { throw failure; }});
  }}), error => hasFailure(error, failure));
  assert.equal(server.listening, false); assert.equal(host.snapshot().contributions.length, 0);
});

test('stop fences an uncooperative late call and stops real required consumers without affecting siblings', {timeout: 5000}, async t => {
  const host = new PluginHost(hostId), entered = gate(), held = gate(); let binding, consumerSignal, committed = 0, consumerClosed = 0;
  t.after(async () => { held.resolve(); await host.close(); });
  const provider = await host.install({identity: identity('writer'), contributions: [reader], factory: context => {
    binding = context.provide(reader.id, reader, {async write() { entered.resolve(); await held.promise; context.scope.assertCurrent(); committed++; return 'late'; }});
    return lifecycle();
  }});
  await host.install({identity: identity('consumer'), contributions: [], requires: [binding], factory: context => {
    consumerSignal = context.scope.signal; context.scope.defer(() => { consumerClosed++; }); return lifecycle();
  }});
  const lease = await host.acquire(reader, binding), cached = lease.value.write;
  const late = cached(); const rejected = assert.rejects(late, error => error.code === 'stale_scope');
  await entered.promise; const closing = provider.close('revoked');
  assert.equal(provider.signal.aborted, true); assert.equal(consumerSignal.aborted, true);
  assert.throws(() => cached(), {code: 'stale_scope'});
  held.resolve(); await rejected; await closing;
  assert.equal(committed, 0); assert.equal(consumerClosed, 1);
  await lease.release();
});

test('quiesce rejects new acquisitions while an accepted fixed lease can drain, release only invalidates itself', async t => {
  const host = new PluginHost(hostId); let binding, calls = 0, closes = 0;
  t.after(() => host.close());
  const provider = await host.install({identity: identity('pin'), contributions: [reader], factory: context => {
    binding = context.provide(reader.id, reader, Object.freeze({read() { return ++calls; }}), 4);
    return lifecycle({dispose() { closes++; }});
  }});
  const first = await host.acquire(reader, binding), second = await host.acquire(reader, binding), cached = first.value.read;
  await provider.quiesce();
  assert.equal(first.signal.aborted, false); first.assertCurrent(); assert.equal(first.value.read(), 1);
  await assert.rejects(host.acquire(reader, binding), {code: 'dependency_unavailable'});
  const releasing = first.release(); assert.equal(first.release(), releasing); await releasing;
  assert.throws(() => cached(), {code: 'stale_scope'}); assert.equal(second.value.read(), 2); assert.equal(closes, 0);
  await second.release(); await provider.close(); assert.equal(closes, 1);
});

test('exact API and provider revision are checked and undeclared dependencies cannot be acquired', async t => {
  const host = new PluginHost(hostId); let binding;
  t.after(() => host.close());
  await host.install({identity: identity('exact'), contributions: [reader], factory: context => {
    binding = context.provide(reader.id, reader, {read() {}}, 2); return lifecycle();
  }});
  await assert.rejects(host.acquire(serviceContract(reader.id, '2'), binding), {code: 'api_incompatible'});
  await assert.rejects(host.acquire(reader, {...binding, revision: 3}), {code: 'conflict'});
  await assert.rejects(host.install({identity: identity('undeclared'), contributions: [], factory: async context => {
    await context.services.acquire(reader, binding); return lifecycle();
  }}), error => error.code === 'permission_denied');
});

test('host close joins in-flight factory setup, reclaims late registered resources and cannot publish after stop', {timeout: 5000}, async () => {
  const host = new PluginHost(hostId), entered = gate(), held = gate(); let disposed = 0, signal;
  const installing = host.install({identity: identity('held-setup'), contributions: [reader], factory: async context => {
    signal = context.scope.signal; entered.resolve(); await held.promise;
    context.scope.defer(() => { disposed++; }); context.provide(reader.id, reader, {read() {}}); return lifecycle();
  }});
  const rejected = assert.rejects(installing, error => error.code === 'stale_scope');
  await entered.promise; const closing = host.close(); assert.equal(host.close(), closing); assert.equal(signal.aborted, true);
  held.resolve(); await rejected; await closing;
  assert.equal(disposed, 1); assert.equal(host.snapshot().contributions.length, 0);
});

test('resource close is reentrant/idempotent, preserves cleanup errors, and retires after accepted work', async () => {
  const scope = new PluginResourceScope(), held = gate(), events = []; let reentrant;
  scope.signal.addEventListener('abort', () => { reentrant = scope.close(); });
  const work = scope.run(async () => { events.push('running'); await held.promise; scope.defer(() => { events.push('late-resource'); }); events.push('settled'); });
  await Promise.resolve();
  const first = Error('generated first'), second = Error('generated second');
  scope.defer(() => { events.push('first'); throw first; }); scope.defer(() => { events.push('second'); throw second; });
  scope.retire(() => { events.push('retired'); });
  const closing = scope.close(); assert.equal(reentrant, closing); assert.equal(scope.close(), closing);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, ['running']);
  held.resolve(); await work;
  await assert.rejects(closing, error => error instanceof AggregateError && error.errors.length === 2 && hasFailure(error, first) && hasFailure(error, second));
  assert.deepEqual(events, ['running', 'settled', 'late-resource', 'second', 'first', 'retired']);
});

test('provider API mismatch rolls back without advertising an unusable active version', async t => {
  const host = new PluginHost(hostId); let binding;
  t.after(() => host.close());
  await assert.rejects(host.install({identity: identity('versioned'), contributions: [reader], factory: context => {
    context.provide(reader.id, serviceContract(reader.id, '2'), {read() { return 'wrong'; }}); return lifecycle();
  }}), {code: 'api_incompatible'});
  assert.deepEqual(host.snapshot().contributions, []);
  await host.install({identity: identity('versioned'), contributions: [reader], factory: context => {
    binding = context.provide(reader.id, reader, {read() { return 'exact'; }}); return lifecycle();
  }});
  const lease = await host.acquire(reader, binding);
  assert.equal(lease.value.read(), 'exact'); assert.equal(host.snapshot().contributions[0].apiVersion, binding.service.apiVersion);
});

test('a forged contribution identity cannot acquire another contribution in the same provider scope', async t => {
  const host = new PluginHost(hostId); let binding, factoryRan = false;
  t.after(() => host.close());
  await host.install({identity: identity('identity-boundary'), contributions: [reader, {id: 'fixture.other', apiVersion: '1'}], factory: context => {
    binding = context.provide(reader.id, reader, {read() { return 'exact-provider'; }}); return lifecycle();
  }});
  const forged = {...binding, provider: {...binding.provider, contributionId: 'fixture.other'}};
  await assert.rejects(host.acquire(reader, forged), {code: 'dependency_unavailable'});
  await assert.rejects(host.install({identity: identity('forged-consumer'), contributions: [], requires: [forged], factory() {
    factoryRan = true; return lifecycle();
  }}), {code: 'dependency_unavailable'});
  assert.equal(factoryRan, false);
  const exact = await host.acquire(reader, binding); assert.equal(exact.value.read(), 'exact-provider');
});

test('all required consumers are fenced before any slow teardown and release before the provider', {timeout: 5000}, async t => {
  const host = new PluginHost(hostId), held = gate(), entered = gate(), events = []; let binding;
  const scopes = [];
  t.after(async () => { held.resolve(); await host.close(); });
  const provider = await host.install({identity: identity('graph-provider'), contributions: [reader], factory: context => {
    binding = context.provide(reader.id, reader, {read() {}}); return lifecycle({dispose() { events.push('provider'); }});
  }});
  for (const name of ['slow', 'sibling']) await host.install({identity: identity(name), contributions: [], requires: [binding], factory: context => {
    scopes.push(context.scope);
    return lifecycle({async stop() { if (name === 'slow') { entered.resolve(); await held.promise; } }, dispose() { events.push(name); }});
  }});
  const closing = provider.close('revoked');
  for (const scope of scopes) { assert.equal(scope.signal.aborted, true); assert.throws(() => scope.assertCurrent(), {code: 'stale_scope'}); }
  await entered.promise; await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.includes('sibling')); assert.ok(!events.includes('provider'));
  held.resolve(); await closing; assert.equal(events.at(-1), 'provider');
});

test('stop keeps the actual database alive for a held read and disposes only after its late result is fenced', {timeout: 5000}, async t => {
  const host = new PluginHost(hostId), entered = gate(), held = gate(), events = []; let binding;
  t.after(async () => { held.resolve(); await host.close(); });
  const provider = await host.install({identity: identity('database'), contributions: [reader], factory: context => {
    const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (\'generated\')');
    context.scope.defer(() => { db.close(); events.push('db-close'); });
    binding = context.provide(reader.id, reader, {async read() {
      entered.resolve(); await held.promise;
      assert.equal(db.prepare('SELECT value FROM fixture').get().value, 'generated'); events.push('read'); context.scope.assertCurrent();
    }});
    return lifecycle({dispose() { events.push('lifecycle-dispose'); }});
  }});
  const lease = await host.acquire(reader, binding), reading = lease.value.read();
  const rejected = assert.rejects(reading, {code: 'stale_scope'});
  await entered.promise; const closing = provider.close();
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(events, []);
  held.resolve(); await rejected; await closing;
  assert.deepEqual(events, ['read', 'lifecycle-dispose', 'db-close']);
});

for (const reason of ['upgrade', 'restart']) test(`${reason} lets accepted work and dependent quiesce use their fixed pin before revoking`, {timeout: 5000}, async t => {
  const host = new PluginHost(hostId), entered = gate(), held = gate(), quiesced = gate(), events = []; let binding, consumerLease, consumerScope;
  t.after(async () => { held.resolve(); await host.close(); });
  const provider = await host.install({identity: identity('graceful-' + reason), contributions: [reader], factory: context => {
    binding = context.provide(reader.id, reader, {async read() { entered.resolve(); await held.promise; context.scope.assertCurrent(); events.push('accepted'); return 'generated'; }, flush() { context.scope.assertCurrent(); events.push('flush'); }});
    return lifecycle({dispose() { events.push('provider-dispose'); }});
  }});
  await host.install({identity: identity('graceful-consumer-' + reason), contributions: [], requires: [binding], factory: async context => {
    consumerScope = context.scope; consumerLease = await context.services.acquire(reader, binding);
    return lifecycle({quiesce() { consumerLease.value.flush(); quiesced.resolve(); }, stop() { assert.throws(() => consumerLease.assertCurrent(), {code: 'stale_scope'}); }, dispose() { events.push('consumer-dispose'); }});
  }});
  const reading = consumerLease.value.read(); await entered.promise;
  const closing = provider.close(reason); await quiesced.promise;
  assert.equal(provider.signal.aborted, false); assert.equal(consumerScope.signal.aborted, false);
  await assert.rejects(host.acquire(reader, binding), {code: 'dependency_unavailable'});
  assert.deepEqual(events, ['flush']); held.resolve(); assert.equal(await reading, 'generated'); await closing;
  assert.deepEqual(events, ['flush', 'accepted', 'consumer-dispose', 'provider-dispose']);
});

test('host shutdown fences every scope before synchronous abort observers can commit through a sibling', async () => {
  const host = new PluginHost(hostId), scopes = [], observed = [];
  for (const name of ['shutdown-one', 'shutdown-two']) await host.install({identity: identity(name), contributions: [], factory: context => {
    scopes.push(context.scope); return lifecycle();
  }});
  scopes[0].signal.addEventListener('abort', () => {
    for (const scope of scopes) {
      try { scope.assertCurrent(); observed.push(false); } catch (error) { observed.push(error.code === 'stale_scope'); }
    }
  });
  await host.close(); assert.deepEqual(observed, [true, true]);
});

test('a stopping dependent rejects provider quiesce without changing the provider admission or snapshot', {timeout: 5000}, async t => {
  const host = new PluginHost(hostId), entered = gate(), held = gate(); let binding, providerQuiesced = 0;
  t.after(async () => { held.resolve(); await host.close(); });
  const provider = await host.install({identity: identity('quiesce-preflight-provider'), contributions: [reader], factory: context => {
    binding = context.provide(reader.id, reader, {read() { return 'still-active'; }});
    return lifecycle({quiesce() { providerQuiesced++; }});
  }});
  const consumer = await host.install({identity: identity('quiesce-preflight-consumer'), contributions: [], requires: [binding], factory() {
    return lifecycle({async stop() { entered.resolve(); await held.promise; }});
  }});
  const lease = await host.acquire(reader, binding);
  const stopping = consumer.close('disabled'); await entered.promise;
  const before = host.snapshot();
  await assert.rejects(provider.quiesce(), {code: 'stale_scope'});
  assert.deepEqual(host.snapshot(), before); assert.equal(providerQuiesced, 0);
  assert.equal(lease.signal.aborted, false); lease.assertCurrent(); assert.equal(lease.value.read(), 'still-active');
  const fresh = await host.acquire(reader, binding); assert.equal(fresh.value.read(), 'still-active'); await fresh.release();
  held.resolve(); await stopping;
  await provider.quiesce(); assert.equal(providerQuiesced, 1);
  await assert.rejects(host.acquire(reader, binding), {code: 'dependency_unavailable'});
  assert.equal(lease.value.read(), 'still-active'); await lease.release();
});

for (const phase of ['factory', 'prepare', 'start']) test(`disposing the actual Cordis owner cancels ${phase} startup before waiting for cleanup`, {timeout: 5000}, async () => {
  const root = new Context(), host = new PluginHost(hostId, root), entered = gate(); let signal, disposed = 0;
  const installing = host.install({identity: identity('owner-dispose-' + phase), contributions: [], factory: async context => {
    signal = context.scope.signal; context.scope.defer(() => { disposed++; });
    const waitForCancellation = async () => {
      entered.resolve();
      await new Promise(resolve => signal.addEventListener('abort', resolve, {once: true}));
      context.scope.assertCurrent();
    };
    if (phase === 'factory') await waitForCancellation();
    return lifecycle({...(phase === 'prepare' ? {prepare: waitForCancellation} : {}), ...(phase === 'start' ? {start: waitForCancellation} : {})});
  }});
  const rejected = assert.rejects(installing, {code: 'stale_scope'});
  await entered.promise; const closing = root.fiber.dispose();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    await closing; await rejected;
    assert.equal(disposed, 1); assert.deepEqual(host.snapshot().contributions, []);
  } finally {
    // Also reclaim the intentionally deadlocked old implementation on a red run.
    await host.close(); await closing; await rejected;
  }
});

test('self-returned service references stay guarded after release and keep asynchronous work joined during stop', {timeout: 5000}, async t => {
  const host = new PluginHost(hostId), entered = gate(), held = gate(); let binding, reads = 0, disposed = 0;
  t.after(async () => { held.resolve(); await host.close(); });
  const provider = await host.install({identity: identity('self-return'), contributions: [reader], factory: context => {
    context.scope.defer(() => { disposed++; });
    binding = context.provide(reader.id, reader, {
      read() { return ++reads; }, fluent() { return this; }, async fluentAsync() { return this; }, get self() { return this; },
      async heldRead() { entered.resolve(); await held.promise; return 'late'; },
    }); return lifecycle();
  }});
  const lease = await host.acquire(reader, binding);
  const references = [lease.value.valueOf(), lease.value.fluent(), await lease.value.fluentAsync(), lease.value.self];
  await lease.release();
  for (const reference of references) assert.throws(() => reference.read(), {code: 'stale_scope'});
  assert.equal(reads, 0);
  const active = await host.acquire(reader, binding), self = await active.value.fluentAsync();
  assert.equal(self, active.value); assert.equal(self.valueOf(), active.value);
  const reading = self.fluent().heldRead(), rejected = assert.rejects(reading, {code: 'stale_scope'});
  await entered.promise; const closing = provider.close('revoked');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(disposed, 0);
  assert.throws(() => self.read(), {code: 'stale_scope'});
  held.resolve(); await rejected; await closing; assert.equal(disposed, 1);
});
