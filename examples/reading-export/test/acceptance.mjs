/** [M] clean-host acceptance for the second-level reading export package.
 *
 * Starts the real public SDK host with generated private state files, installs
 * the actual EXT01 reading review package as the provider, exports generated
 * plan data, closes the page session, removes the provider, restarts the host
 * and reads the same generic material from the same archive without a source
 * binding. The generated plan and archive are the only data used. */
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {packageManifestSchema} from '@mote/plugin-sdk';
import {planComposition, PluginHost} from '@mote/plugin-sdk/node';
import {createPlugin as createReviewPlugin, readingReviewContribution} from '../../reading-review/plugin.mjs';
import {readingReviewPort} from '../../reading-review/port.mjs';
import {createPlugin as createExportPlugin} from '../plugin.mjs';
import {readingExportPort, readingPlanPort} from '../port.mjs';
import {createCustomPageSession} from '../web/bridge.mjs';
import {createFixtureStateStore} from './fixture-state.mjs';

const repository = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const report = {status: 'running', fixtureOnly: true, liveModel: false, physicalDevice: false, checks: [], failure: undefined};
const directory = mkdtempSync(join(tmpdir(), 'mote-reading-export-acceptance-'));
const stateDirectory = join(directory, 'state');
mkdirSync(stateDirectory, {recursive: true, mode: 0o700});
const hostIdentity = {kind: 'central', id: 'generated-reading-export-acceptance-host'};
let running;

function stateFor(scope) {
  return createFixtureStateStore({file: join(stateDirectory, `${scope.instanceId}.json`)});
}

function identity(instanceId, packageId) {
  return {
    host: hostIdentity,
    packageId,
    installationId: `generated-${instanceId}-installation`,
    instanceId,
    activationId: randomUUID(),
  };
}

function bindingFor(handle, contributionId, service) {
  return {
    service: {id: service.id, apiVersion: service.apiVersion},
    provider: {scope: handle.identity, contributionId},
    revision: 0,
  };
}

async function waitFor(check, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw Error(message);
    await delay(10);
  }
}

try {
  const reviewManifest = packageManifestSchema.parse(JSON.parse(readFileSync(join(repository, 'examples/reading-review/mote-plugin.json'), 'utf8')));
  const exportManifest = packageManifestSchema.parse(JSON.parse(readFileSync(join(repository, 'examples/reading-export/mote-plugin.json'), 'utf8')));
  const plan = planComposition({revision: 1, host: 'central', packages: [reviewManifest, exportManifest]});
  assert.equal(plan.ok, true, JSON.stringify(plan.failures));
  assert.ok(plan.plan.bindings.some(binding => binding.service.id === readingPlanPort.id
    && binding.provider.packageId === 'example.reading-review'));
  report.checks.push('composition resolves the exact public reading plan dependency before activation');

  const host = new PluginHost(hostIdentity, undefined, undefined, {stateFor});
  running = host;
  const reviewHandle = await host.install({
    identity: identity('acceptance-review', 'example.reading-review'),
    contributions: [{id: readingReviewContribution.id, apiVersion: '1'}],
    factory: createReviewPlugin,
  });
  const reviewBinding = bindingFor(reviewHandle, readingReviewContribution.id, readingPlanPort);
  const reviewLease = await host.acquire(readingReviewPort, reviewBinding);
  assert.equal((await reviewLease.value.selectStrategy('spaced')).strategy, 'spaced');
  const added = await reviewLease.value.addCard({prompt: 'Generated acceptance prompt', answer: 'Generated acceptance answer'});
  const reviewed = await reviewLease.value.review({cardId: added.cards[0].id, rating: 'good'});
  assert.equal(reviewed.rounds[0].intervalDays, 3);
  report.checks.push('EXT01 provider creates a generated plan through its own public port');

  let mismatchStarted = 0;
  const mismatchBinding = {...reviewBinding, service: {...reviewBinding.service, apiVersion: '2'}};
  await assert.rejects(host.install({
    identity: identity('acceptance-export-mismatch', 'example.reading-export'),
    contributions: [{id: 'reading-export.archive', apiVersion: '1'}],
    optional: [mismatchBinding],
    factory: context => {
      const lifecycle = createExportPlugin(context, {binding: mismatchBinding});
      return {...lifecycle, start() { mismatchStarted++; return lifecycle.start(); }};
    },
  }), error => error.name === 'ReadingExportDependencyError'
    && /example\.reading-review\.plan@1/.test(error.message)
    && /@2/.test(error.message));
  assert.equal(mismatchStarted, 0, 'an incompatible domain API must fail before activate');
  report.checks.push('[U] mismatched domain API fails in prepare, names the dependency and never starts');

  const exportHandle = await host.install({
    identity: identity('acceptance-export', 'example.reading-export'),
    contributions: [{id: 'reading-export.archive', apiVersion: '1'}],
    optional: [reviewBinding],
    factory: context => createExportPlugin(context, {binding: reviewBinding, intervalMs: 10}),
  });
  const exportLease = await host.acquire(readingExportPort, bindingFor(exportHandle, 'reading-export.archive', readingExportPort));
  await waitFor(async () => (await exportLease.value.list()).materials.length >= 1, 'no material was published');
  const firstArchive = await exportLease.value.list();
  const materialId = firstArchive.materials.at(-1).id;
  const material = await exportLease.value.read(materialId);
  assert.equal(material.source.strategy.id, 'spaced');
  assert.equal(material.cards[0].intervalDays, 3);
  assert.match(material.content.text, /Generated acceptance prompt/);
  assert.match(material.content.text, /Algorithm: Spaced \(spaced\)/);
  report.checks.push('background export publishes the source strategy, due date and interval verbatim');

  const page = createCustomPageSession(exportLease.value);
  assert.equal((await page.invoke('materials')).materials.length, 1);
  page.close();
  const beforePageClose = (await exportLease.value.list()).materials.length;
  await reviewLease.value.review({cardId: added.cards[0].id, rating: 'good'});
  await waitFor(async () => (await exportLease.value.list()).materials.length > beforePageClose,
    'closing the page stopped the background export');
  report.checks.push('disabling the page session does not stop the background export contribution');

  await reviewHandle.close();
  assert.equal(exportHandle.signal.aborted, false);
  await waitFor(async () => (await exportLease.value.summary()).source.state === 'unavailable',
    'the removed provider was not reported as unavailable');
  const afterRemoval = await exportLease.value.list();
  assert.equal(afterRemoval.materials.length, beforePageClose + 1);
  assert.deepEqual((await exportLease.value.read(materialId)).content, material.content);
  await assert.rejects(exportLease.value.exportNow(), error => error.code === 'reading_export_source_unavailable');
  assert.equal((await exportLease.value.list()).materials.length, afterRemoval.materials.length);
  report.checks.push('[M] removing the strategy provider keeps the published generic material readable and exports fail closed');
  await exportLease.release();
  await exportHandle.close();
  await reviewLease.release().catch(() => {});
  await host.close();
  running = undefined;

  const restarted = new PluginHost(hostIdentity, undefined, undefined, {stateFor});
  running = restarted;
  const archiveOnly = await restarted.install({
    identity: identity('acceptance-export', 'example.reading-export'),
    contributions: [{id: 'reading-export.archive', apiVersion: '1'}],
    factory: context => createExportPlugin(context, {background: false}),
  });
  const archiveLease = await restarted.acquire(readingExportPort, bindingFor(archiveOnly, 'reading-export.archive', readingExportPort));
  const resumed = await archiveLease.value.list();
  assert.ok(resumed.materials.some(entry => entry.id === materialId));
  assert.deepEqual((await archiveLease.value.read(materialId)).content, material.content);
  assert.equal((await archiveLease.value.summary()).source.state, 'unavailable');
  await assert.rejects(archiveLease.value.exportNow(), error => error.code === 'reading_export_source_unavailable');
  assert.equal((await archiveLease.value.list()).materials.length, resumed.materials.length);
  report.checks.push('[M] restart without the source binding serves the same archive without switching algorithms');
  await archiveLease.release();
  await archiveOnly.close();
  await restarted.close();
  running = undefined;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  if (running) await running.close().catch(error => {
    report.failure ??= `cleanup: ${error instanceof Error ? error.message : String(error)}`;
    process.exitCode = 1;
  });
  rmSync(directory, {recursive: true, force: true});
  console.log(JSON.stringify(report, null, 2));
}
