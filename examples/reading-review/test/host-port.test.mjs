import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PluginHost} from '@mote/plugin-sdk/node';
import {createPlugin, readingReviewContribution, sdkVersion} from '../plugin.mjs';
import {readingReviewPort} from '../port.mjs';
import {createFixtureStateStore} from './fixture-state.mjs';

const hostIdentity = {kind: 'central', id: 'generated-reading-review-host'};
const identity = activationId => ({
  host: hostIdentity,
  packageId: 'example.reading-review',
  installationId: 'generated-reading-review-installation',
  instanceId: 'generated-reading-review-instance',
  activationId,
});

async function install(host, activationId) {
  const scope = identity(activationId);
  await host.install({
    identity: scope,
    contributions: [{id: readingReviewContribution.id, apiVersion: readingReviewPort.apiVersion}],
    factory: createPlugin,
  });
  const binding = {
    service: {id: readingReviewPort.id, apiVersion: readingReviewPort.apiVersion},
    provider: {scope, contributionId: readingReviewContribution.id},
    revision: 0,
  };
  const lease = await host.acquire(readingReviewPort, binding);
  return {scope, binding, lease};
}

test('the public SDK host installs the package and serves its own typed port from ctx.state', async () => {
  const state = createFixtureStateStore();
  const firstHost = new PluginHost(hostIdentity, undefined, undefined, {stateFor: () => state});
  const first = await install(firstHost, randomUUID());
  assert.equal(sdkVersion, '0.1.0');
  assert.equal(first.lease.binding.service.id, 'example.reading-review.plan');
  const initial = await first.lease.value.state();
  assert.equal(initial.strategy, null);
  const selected = await first.lease.value.selectStrategy('spaced');
  assert.equal(selected.strategy, 'spaced');
  const added = await first.lease.value.addCard({prompt: 'Generated prompt', answer: 'Generated answer'});
  const reviewed = await first.lease.value.review({cardId: added.cards[0].id, rating: 'good'});
  assert.equal(reviewed.historyCount, 1);
  assert.equal(first.lease.value.summary().reviews, 1);
  await first.lease.release();
  await firstHost.close();

  const secondHost = new PluginHost(hostIdentity, undefined, undefined, {stateFor: () => state});
  const second = await install(secondHost, randomUUID());
  const resumed = await second.lease.value.state();
  assert.equal(resumed.strategy, 'spaced');
  assert.equal(resumed.cards[0].id, added.cards[0].id);
  assert.equal(resumed.rounds[0].id, reviewed.rounds[0].id);
  assert.equal(resumed.stateRevision, reviewed.stateRevision);
  await second.lease.release();
  await secondHost.close();
});

test('a host without a persistent state provider fails closed instead of using process memory', async () => {
  const host = new PluginHost(hostIdentity);
  try {
    await assert.rejects(host.install({
      identity: identity(randomUUID()),
      contributions: [{id: readingReviewContribution.id, apiVersion: readingReviewPort.apiVersion}],
      factory: createPlugin,
    }), error => error?.code === 'dependency_unavailable');
  } finally {
    await host.close();
  }
});
