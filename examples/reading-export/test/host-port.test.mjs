import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {PluginHost} from '@mote/plugin-sdk/node';
import {createPlugin as createReviewPlugin, readingReviewContribution} from '../../reading-review/plugin.mjs';
import {readingReviewPort} from '../../reading-review/port.mjs';
import {assertReadingPlanBinding, createPlugin as createExportPlugin} from '../plugin.mjs';
import {readingExportPort, readingPlanPort} from '../port.mjs';
import {createCustomPageSession} from '../web/bridge.mjs';
import {createFixtureStateStore} from './fixture-state.mjs';

const hostIdentity = {kind: 'central', id: 'generated-reading-export-host'};
const identity = instanceId => ({
  host: hostIdentity,
  packageId: instanceId.startsWith('review') ? 'example.reading-review' : 'example.reading-export',
  installationId: `generated-${instanceId}-installation`,
  instanceId,
  activationId: randomUUID(),
});

function fixtureHost() {
  const stores = new Map();
  const host = new PluginHost(hostIdentity, undefined, undefined, {
    stateFor: scope => {
      if (!stores.has(scope.instanceId)) stores.set(scope.instanceId, createFixtureStateStore());
      return stores.get(scope.instanceId);
    },
  });
  return {host, stores};
}

async function installReview(host) {
  const handle = await host.install({
    identity: identity('review-instance'),
    contributions: [{id: readingReviewContribution.id, apiVersion: '1'}],
    factory: createReviewPlugin,
  });
  const binding = {
    service: {id: readingPlanPort.id, apiVersion: readingPlanPort.apiVersion},
    provider: {scope: handle.identity, contributionId: readingReviewContribution.id},
    revision: 0,
  };
  const lease = await host.acquire(readingReviewPort, binding);
  return {handle, binding, lease};
}

function exportDefinition(binding, options = {}) {
  let factoryCalls = 0;
  let startCalls = 0;
  return {
    definition: {
      identity: identity(options.instanceId ?? 'export-instance'),
      contributions: [{id: 'reading-export.archive', apiVersion: '1'}],
      ...(binding ? {optional: [binding]} : {}),
      factory: context => {
        factoryCalls++;
        const lifecycle = createExportPlugin(context, {...options, binding});
        return {
          prepare: () => lifecycle.prepare(),
          start() { startCalls++; return lifecycle.start(); },
          quiesce: reason => lifecycle.quiesce(reason),
          stop: reason => lifecycle.stop(reason),
          dispose: () => lifecycle.dispose(),
        };
      },
    },
    calls: () => ({factoryCalls, startCalls}),
  };
}

function exportBinding(handle) {
  return {
    service: {id: readingExportPort.id, apiVersion: readingExportPort.apiVersion},
    provider: {scope: handle.identity, contributionId: 'reading-export.archive'},
    revision: 0,
  };
}

async function waitFor(check, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw Error(message);
    await delay(10);
  }
}

test('the real host exports through the public plan port and keeps the archive after provider removal', {timeout: 15000}, async t => {
  const {host} = fixtureHost();
  t.after(() => host.close());
  const review = await installReview(host);
  const selected = await review.lease.value.selectStrategy('spaced');
  assert.equal(selected.strategy, 'spaced');
  const added = await review.lease.value.addCard({prompt: 'Generated prompt', answer: 'Generated answer'});
  const reviewed = await review.lease.value.review({cardId: added.cards[0].id, rating: 'good'});
  assert.equal(reviewed.rounds[0].intervalDays, 3);

  const exported = exportDefinition(review.binding, {
    intervalMs: 10,
    clock: () => new Date('2026-11-04T08:00:00.000Z'),
  });
  const handle = await host.install(exported.definition);
  assert.equal(exported.calls().startCalls, 1);
  const binding = exportBinding(handle);
  const lease = await host.acquire(readingExportPort, binding);
  await waitFor(async () => (await lease.value.list()).materials.length >= 1, 'the background export did not publish a material');
  const listed = await lease.value.list();
  assert.equal(listed.materials[0].source.strategy.id, 'spaced');
  const material = await lease.value.read(listed.materials[0].id);
  assert.equal(material.cards[0].intervalDays, 3);
  assert.match(material.content.text, /Algorithm: Spaced \(spaced\)/);

  const page = createCustomPageSession(lease.value);
  assert.equal((await page.invoke('materials')).materials.length, 1);
  assert.equal((await page.invoke('read', {id: material.id})).id, material.id);
  page.close();
  await assert.rejects(page.invoke('materials'), /custom page is closed/);

  const before = (await lease.value.list()).materials.length;
  await review.lease.value.review({cardId: added.cards[0].id, rating: 'good'});
  await waitFor(async () => (await lease.value.list()).materials.length > before,
    'closing the page stopped the background export task');
  assert.equal((await lease.value.list()).source.state, 'ready');

  const archiveBeforeRemoval = await lease.value.list();
  await review.handle.close();
  assert.equal(handle.signal.aborted, false, 'the archive consumer must remain active without its source');
  await waitFor(async () => (await lease.value.summary()).source.state === 'unavailable',
    'the revoked source was not reported as unavailable');
  const archiveAfterRemoval = await lease.value.list();
  assert.equal(archiveAfterRemoval.materials.length, archiveBeforeRemoval.materials.length);
  assert.deepEqual((await lease.value.read(material.id)).content, material.content);
  await assert.rejects(lease.value.exportNow(), error => error.code === 'reading_export_source_unavailable');
  assert.equal((await lease.value.list()).materials.length, archiveBeforeRemoval.materials.length);
  await lease.release();
  await handle.close();
});

test('a mismatched domain API version fails in prepare and names the missing dependency', {timeout: 8000}, async t => {
  const {host} = fixtureHost();
  t.after(() => host.close());
  const review = await installReview(host);

  assert.throws(() => assertReadingPlanBinding(undefined), error =>
    error.name === 'ReadingExportDependencyError'
    && error.code === 'reading_export_dependency_unavailable'
    && /example\.reading-review\.plan@1/.test(error.message)
    && /no runtime binding/.test(error.message));

  const badBinding = {...review.binding, service: {...review.binding.service, apiVersion: '2'}};
  const exported = exportDefinition(badBinding, {instanceId: 'export-mismatch', intervalMs: 1000});
  await assert.rejects(host.install(exported.definition), error => {
    assert.equal(error.name, 'ReadingExportDependencyError');
    assert.equal(error.code, 'reading_export_dependency_unavailable');
    assert.match(error.message, /example\.reading-review\.plan@1/);
    assert.match(error.message, /example\.reading-review\.plan@2/);
    assert.deepEqual(error.dependency, {kind: 'service', id: readingPlanPort.id, version: readingPlanPort.apiVersion});
    assert.deepEqual(error.offered, {id: readingPlanPort.id, apiVersion: '2'});
    return true;
  });
  assert.equal(exported.calls().startCalls, 0, 'activation must not start after the dependency check');
  assert.equal(host.snapshot().contributions.some(contribution =>
    contribution.identity.scope.instanceId === 'export-mismatch'), false);
});
