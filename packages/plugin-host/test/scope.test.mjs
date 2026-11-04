import test from 'node:test';
import assert from 'node:assert/strict';
import {Context} from '@deepseek-ai/cordis';
import {PluginHost, PluginEpochs} from '@mote/plugin-host';

const hostId = {kind: 'central', id: 'generated-scope-host'};
const identity = name => ({host: hostId, packageId: 'fixture.scope', installationId: 'fixture-install', instanceId: name, activationId: name + '-activation'});
const lifecycle = {prepare() {}, start() {}, quiesce() {}, stop() {}, dispose() {}};

test('Cordis exporter disposal removes its own sink while a later sibling remains active', async () => {
  const root = new Context(), first = [], second = [];
  const disposeFirst = root.logger.exporter({export: message => { first.push(message.name); }});
  const disposeSecond = root.logger.exporter({export: message => { second.push(message.name); }});
  try {
    root.logger('generated-before').info('Synthetic lifecycle fixture');
    disposeFirst();
    root.logger('generated-after').info('Synthetic lifecycle fixture');
    assert.deepEqual(first, ['generated-before']);
    assert.deepEqual(second, ['generated-before', 'generated-after']);
    disposeSecond();
    root.logger('generated-closed').info('Synthetic lifecycle fixture');
    assert.equal(second.length, 2);
  } finally { await root.fiber.dispose(); }
});

test('shared host context keeps sibling plugin lifecycles independent', async () => {
  const root = new Context(), host = new PluginHost(hostId, root), released = [];
  const first = await host.install({identity: identity('first'), contributions: [{id: 'first', apiVersion: '1'}], factory: context => {
    context.scope.defer(() => { released.push('first'); });
    return lifecycle;
  }});
  const second = await host.install({identity: identity('second'), contributions: [{id: 'second', apiVersion: '1'}], factory: context => {
    context.scope.defer(() => { released.push('second'); });
    return lifecycle;
  }});
  await first.close();
  assert.deepEqual(released, ['first']);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  assert.deepEqual(host.snapshot().contributions.map(item => item.identity.scope.instanceId), ['second']);
  await second.close();
  assert.deepEqual(released, ['first', 'second']);
  assert.deepEqual(host.snapshot().contributions, []);
  await host.close();
  await root.fiber.dispose();
});

test('standalone host owns its root and closes idempotently', async () => {
  const host = new PluginHost(hostId);
  let released = 0;
  await host.install({identity: identity('standalone'), contributions: [], factory: context => {
    context.scope.defer(() => { released++; });
    return lifecycle;
  }});
  await host.close();
  await host.close();
  assert.equal(released, 1);
});

test('a registration epoch becomes stale when its scope closes or the id is reinstalled', async () => {
  const host = new PluginHost(hostId);
  let epochs, active, stopped;
  const handle = await host.install({identity: identity('epochs'), contributions: [], factory: context => {
    epochs = new PluginEpochs(context.scope);
    active = epochs.install('fixture.processor');
    stopped = epochs.install('fixture.consumer');
    context.scope.defer(() => { active(); });
    return lifecycle;
  }});
  const activeEpoch = epochs.get('fixture.processor'), stoppedEpoch = epochs.get('fixture.consumer');
  assert.ok(activeEpoch);
  assert.equal(epochs.matches('fixture.processor', activeEpoch), true);
  stopped();
  assert.equal(epochs.matches('fixture.consumer', stoppedEpoch), false);
  const replacement = epochs.install('fixture.processor');
  assert.equal(epochs.matches('fixture.processor', activeEpoch), false, 'same-version reinstall fences work accepted by the old registration');
  assert.equal(epochs.matches('fixture.processor', epochs.get('fixture.processor')), true);
  replacement();
  await handle.close();
  assert.equal(epochs.matches('fixture.processor', activeEpoch), false, 'a stopped scope invalidates every epoch');
  await host.close();
});
