import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {zipSync} from 'fflate';
import {packPlugin} from '../../../scripts/plugin-pack.mjs';
import {releaseCompatibilityFailures, validatePackage} from '../../../scripts/plugin-validate.mjs';
import {GitHubPluginReleases, pluginManifestSchema, validatePluginArchive} from '../src/plugin-release.js';
import type {PluginManifest} from '../src/plugin-release.js';

const manifest = {
  schemaVersion: 1, id: 'generated.pack', name: 'Generated pack', version: '1.0.0', trust: 'official',
  runtime: 'worker', entry: 'main.mjs', archive: {asset: 'plugin.zip', sha256: '0'.repeat(64)},
  contributions: [{id: 'generated.pack.page', version: '1', surface: 'page', runtime: 'host', entry: 'page.html'}],
  capabilities: [], configuration: [], dependencies: [], access: ['generated fixture only'],
} satisfies PluginManifest;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mote-plugin-pack-'));
  const payload = join(directory, 'payload'), out = join(directory, 'out');
  mkdirSync(payload);
  writeFileSync(join(payload, 'main.mjs'), 'export function createMemoryProvider(){ throw Error("not executed by pack"); }\n');
  writeFileSync(join(payload, 'page.html'), '<p>generated</p>\n');
  writeFileSync(join(directory, 'mote-plugin.json'), JSON.stringify(manifest));
  return {directory, payload, out};
}

test('pack produces a deterministic external manifest and ZIP payload without a manifest self-reference', async t => {
  const f = fixture();
  t.after(() => rmSync(f.directory, {recursive: true, force: true}));
  const first = await packPlugin({manifestPath: join(f.directory, 'mote-plugin.json'), payload: f.payload, out: f.out, manifestSchema: pluginManifestSchema, validateArchive: validatePluginArchive});
  const secondOut = join(f.directory, 'out2');
  const second = await packPlugin({manifestPath: join(f.directory, 'mote-plugin.json'), payload: f.payload, out: secondOut, manifestSchema: pluginManifestSchema, validateArchive: validatePluginArchive});
  assert.equal(first.digest, second.digest);
  assert.deepEqual(readFileSync(first.zipPath), readFileSync(second.zipPath));
  assert.ok(first.entries.includes('main.mjs') && first.entries.includes('page.html'));
  assert.ok(!first.entries.includes('mote-plugin.json'));
  assert.equal(first.manifest.archive.sha256, first.digest);
  assert.doesNotThrow(() => validatePluginArchive(readFileSync(first.zipPath), first.manifest));
});

test('ZIP bytes are independent of the packing timezone and the consumer budget is enforced', async t => {
  const f = fixture();
  t.after(() => rmSync(f.directory, {recursive: true, force: true}));
  const child = join(f.directory, 'pack-child.mjs');
  const packUrl = pathToFileURL(new URL('../../../scripts/plugin-pack.mjs', import.meta.url).pathname).href;
  const releaseUrl = pathToFileURL(new URL('../src/plugin-release.ts', import.meta.url).pathname).href;
  writeFileSync(child, `import {packPlugin} from ${JSON.stringify(packUrl)};\nimport {pluginManifestSchema, validatePluginArchive} from ${JSON.stringify(releaseUrl)};\nconst result=await packPlugin({manifestPath:process.argv[2],payload:process.argv[3],out:process.argv[4],manifestSchema:pluginManifestSchema,validateArchive:validatePluginArchive});\nconsole.log(result.digest);\n`);
  const digests = ['America/Los_Angeles', 'UTC'].map((tz, index) => execFileSync(process.execPath, ['--import', 'tsx', child, join(f.directory, 'mote-plugin.json'), f.payload, join(f.directory, 'tz-' + index)], {env: {...process.env, TZ: tz}, encoding: 'utf8'}).trim());
  assert.equal(digests[0], digests[1]);
  writeFileSync(join(f.payload, 'oversized.mjs'), '');
  truncateSync(join(f.payload, 'oversized.mjs'), 65 * 1024 * 1024);
  await assert.rejects(packPlugin({manifestPath: join(f.directory, 'mote-plugin.json'), payload: f.payload, out: join(f.directory, 'budget-out'), manifestSchema: pluginManifestSchema, validateArchive: validatePluginArchive}), /resource budget/);
});

test('pack rejects an output symlink resolving into the payload', async t => {
  const f = fixture();
  t.after(() => rmSync(f.directory, {recursive: true, force: true}));
  mkdirSync(join(f.payload, 'release'));
  const outside = join(f.directory, 'outside');
  symlinkSync(f.payload, outside);
  await assert.rejects(packPlugin({manifestPath: join(f.directory, 'mote-plugin.json'), payload: f.payload, out: outside, manifestSchema: pluginManifestSchema, validateArchive: validatePluginArchive}), /outside the payload/);
});

test('validatePackage accepts matching bytes and rejects a tampered ZIP', async t => {
  const f = fixture();
  t.after(() => rmSync(f.directory, {recursive: true, force: true}));
  const packed = await packPlugin({manifestPath: join(f.directory, 'mote-plugin.json'), payload: f.payload, out: f.out, manifestSchema: pluginManifestSchema, validateArchive: validatePluginArchive});
  const contract = {pluginManifestSchema, validatePluginArchive};
  assert.equal((await validatePackage({manifestPath: packed.manifestPath, zipPath: packed.zipPath, releaseContract: contract})).ok, true);
  const tampered = join(f.directory, 'tampered.zip');
  writeFileSync(tampered, Buffer.concat([readFileSync(packed.zipPath), Buffer.from([0])]));
  const result = await validatePackage({manifestPath: packed.manifestPath, zipPath: tampered, releaseContract: contract});
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(failure => failure.code === 'digest_mismatch'));
});

test('pack rejects an output tree inside the payload and an invalid calendar declaration', async t => {
  const f = fixture();
  t.after(() => rmSync(f.directory, {recursive: true, force: true}));
  await assert.rejects(packPlugin({manifestPath: join(f.directory, 'mote-plugin.json'), payload: f.payload, out: join(f.payload, 'dist'), manifestSchema: pluginManifestSchema, validateArchive: validatePluginArchive}), /outside the payload/);
  writeFileSync(join(f.directory, 'bad.json'), JSON.stringify({...manifest, capabilities: ['calendar.manage']}));
  await assert.rejects(packPlugin({manifestPath: join(f.directory, 'bad.json'), payload: f.payload, out: join(f.directory, 'bad-out'), manifestSchema: pluginManifestSchema, validateArchive: validatePluginArchive}));
});

test('archive validation rejects traversal, missing entries and tampered payloads', async t => {
  const f = fixture();
  t.after(() => rmSync(f.directory, {recursive: true, force: true}));
  const packed = await packPlugin({manifestPath: join(f.directory, 'mote-plugin.json'), payload: f.payload, out: f.out, manifestSchema: pluginManifestSchema, validateArchive: validatePluginArchive});
  const zip = readFileSync(packed.zipPath);
  const tampered = Buffer.from(zip); tampered[tampered.length - 1] ^= 1;
  assert.notEqual(createHash('sha256').update(tampered).digest('hex'), packed.digest);
  assert.throws(() => validatePluginArchive(zipSync({'../escape.mjs': new Uint8Array([0])}), packed.manifest));
  assert.throws(() => validatePluginArchive(zipSync({'other.mjs': new Uint8Array([0])}), packed.manifest));
});

test('validation rejects a generic service runtime before the release consumer would fail', () => {
  assert.deepEqual(releaseCompatibilityFailures(manifest), []);
  assert.deepEqual(releaseCompatibilityFailures({...manifest, runtime: 'service'}).map(failure => failure.code), ['unsupported_runtime']);
});

test('a packed release is accepted by the real GitHubPluginReleases resolve/install/verify consumer', async t => {
  const f = fixture();
  t.after(() => rmSync(f.directory, {recursive: true, force: true}));
  const packed = await packPlugin({manifestPath: join(f.directory, 'mote-plugin.json'), payload: f.payload, out: f.out, manifestSchema: pluginManifestSchema, validateArchive: validatePluginArchive});
  const zip = readFileSync(packed.zipPath), manifestBytes = readFileSync(packed.manifestPath);
  const base = 'https://github.com/generated/pack/releases/download/v1/';
  const commit = 'a'.repeat(40);
  const releases = new GitHubPluginReleases(join(f.directory, 'packages'), async url => {
    if (url === 'https://api.github.com/repos/generated/pack/releases/tags/v1') return {bytes: new TextEncoder().encode(JSON.stringify({tag_name: 'v1', draft: false, assets: [{name: 'mote-plugin.json', browser_download_url: base + 'mote-plugin.json'}, {name: 'plugin.zip', browser_download_url: base + 'plugin.zip'}]}))};
    if (url === 'https://api.github.com/repos/generated/pack/commits/v1') return {bytes: new TextEncoder().encode(JSON.stringify({sha: commit}))};
    if (url === base + 'mote-plugin.json') return {bytes: manifestBytes};
    if (url === base + 'plugin.zip') return {bytes: zip};
    throw Error('Unexpected generated release URL');
  });
  const release = await releases.resolve({repository: 'generated/pack', tag: 'v1'});
  assert.equal(release.preview.source.digest, packed.digest);
  const installed = await releases.install(release);
  releases.verifyInstalled(installed, packed.digest, release.manifest);
  assert.equal(readFileSync(join(installed, 'main.mjs'), 'utf8').includes('createMemoryProvider'), true);
});
