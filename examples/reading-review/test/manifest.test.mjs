import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packageManifestSchema} from '@mote/plugin-sdk';
import {unzipSync} from 'fflate';
import {readingReviewPort} from '../port.mjs';
import {customPage} from '../source.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));

test('the release Manifest and payload describe this package and its SDK port', () => {
  const manifest = packageManifestSchema.parse(JSON.parse(readFileSync(join(root, 'mote-plugin.json'), 'utf8')));
  assert.equal(manifest.id, 'example.reading-review');
  assert.equal(manifest.trust, 'external');
  const port = manifest.contributions.find(contribution => contribution.id === 'reading-review.port');
  assert.deepEqual(port.provides, [{kind: 'service', id: readingReviewPort.id, apiVersion: readingReviewPort.apiVersion, cardinality: 'single'}]);
  const page = manifest.contributions.find(contribution => contribution.id === 'reading-review.page');
  assert.equal(page.surface, 'page');
  assert.equal(page.runtime, 'host');
  assert.equal(page.entry, customPage.entry);

  const archive = readFileSync(join(root, 'archive', manifest.archive.asset));
  assert.equal(createHash('sha256').update(archive).digest('hex'), manifest.archive.sha256, 'run npm run pack after changing runtime files');
  const entries = unzipSync(new Uint8Array(archive));
  const names = Object.keys(entries);
  for (const file of [manifest.entry, page.entry, 'web/bridge.mjs']) assert.ok(names.includes(file), file);
  assert.equal(names.some(file => file.startsWith('test/') || file.startsWith('scripts/')), false, 'payload excludes development checks');
  for (const [file, bytes] of Object.entries(entries))
    assert.equal(Buffer.compare(bytes, readFileSync(join(root, file))), 0, file + ' is stale; run npm run pack');
});
