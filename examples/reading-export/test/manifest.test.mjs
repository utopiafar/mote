import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packageManifestSchema} from '@mote/plugin-sdk';
import {planComposition} from '@mote/plugin-sdk/node';
import {unzipSync} from 'fflate';
import {readingExportPort, readingPlanPort} from '../port.mjs';
import {customPageMethods} from '../web/bridge.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const readManifest = name => packageManifestSchema.parse(JSON.parse(readFileSync(join(root, '..', name, 'mote-plugin.json'), 'utf8')));

test('the Manifest declares the exact public plan port and this package port', () => {
  const manifest = readManifest('reading-export');
  assert.equal(manifest.id, 'example.reading-export');
  assert.equal(manifest.trust, 'external');
  assert.equal(manifest.runtime, 'service');
  assert.deepEqual(manifest.dependencies.filter(dependency => dependency.kind === 'service'), [{
    kind: 'service', id: readingPlanPort.id, version: readingPlanPort.apiVersion,
  }]);
  const archive = manifest.contributions.find(contribution => contribution.id === 'reading-export.archive');
  assert.deepEqual(archive.provides, [{kind: 'service', id: readingExportPort.id, apiVersion: readingExportPort.apiVersion, cardinality: 'single'}]);
  assert.equal(archive.requires, undefined, 'the runtime lease stays optional so published materials remain readable');
  const page = manifest.contributions.find(contribution => contribution.id === 'reading-export.page');
  assert.equal(page.surface, 'page');
  assert.equal(page.runtime, 'host');
  assert.equal(page.entry, 'web/index.html');
  assert.deepEqual(page.requires, [{kind: 'contribution', id: 'reading-export.archive', version: '1', required: true}]);
  assert.deepEqual([...customPageMethods], ['materials', 'read', 'export-now']);

  const payload = readFileSync(join(root, 'archive', manifest.archive.asset));
  assert.equal(createHash('sha256').update(payload).digest('hex'), manifest.archive.sha256, 'run npm run pack after changing runtime files');
  const entries = unzipSync(new Uint8Array(payload));
  const names = Object.keys(entries);
  for (const file of [manifest.entry, page.entry, 'domain.mjs', 'port.mjs', 'web/bridge.mjs'])
    assert.ok(names.includes(file), file);
  assert.equal(names.some(file => file.startsWith('test/') || file.startsWith('scripts/')), false, 'payload excludes development checks');
  for (const [file, bytes] of Object.entries(entries))
    assert.equal(Buffer.compare(bytes, readFileSync(join(root, file))), 0, file + ' is stale; run npm run pack');
});

test('composition fails before activation and names the missing plan dependency', () => {
  const manifest = readManifest('reading-export');
  const missing = planComposition({revision: 1, host: 'central', packages: [manifest]});
  assert.equal(missing.ok, false);
  const failure = missing.failures.find(entry => entry.code === 'missing_dependency' && entry.dependency?.id === readingPlanPort.id);
  assert.ok(failure, JSON.stringify(missing.failures));
  assert.deepEqual(failure.dependency, {kind: 'service', id: readingPlanPort.id, version: readingPlanPort.apiVersion});
  assert.equal(failure.packageId, 'example.reading-export');

  const review = readManifest('reading-review');
  const compatible = planComposition({revision: 2, host: 'central', packages: [review, manifest]});
  assert.equal(compatible.ok, true, JSON.stringify(compatible.failures));
  const binding = compatible.plan.bindings.find(entry => entry.service.id === readingPlanPort.id);
  assert.equal(binding.provider.packageId, 'example.reading-review');

  const incompatible = structuredClone(review);
  incompatible.contributions.find(contribution => contribution.id === 'reading-review.port').provides[0].apiVersion = '2';
  const mismatch = planComposition({revision: 3, host: 'central', packages: [incompatible, manifest]});
  assert.equal(mismatch.ok, false);
  const apiFailure = mismatch.failures.find(entry => entry.code === 'api_incompatible' && entry.dependency?.id === readingPlanPort.id);
  assert.ok(apiFailure, JSON.stringify(mismatch.failures));
  assert.deepEqual(apiFailure.dependency, {kind: 'service', id: readingPlanPort.id, version: readingPlanPort.apiVersion});
});
