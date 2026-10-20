import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gitBlob, validateCatalog, readCatalog, auditLock, verifySourceFiles, environmentProblems} from '../dsh-compatibility/audit.mjs';

function fixture() {
  const archive = {version: '0.2.0-rc.2', resolved: 'https://registry.npmjs.org/@deepseek-ai/example/-/example-0.2.0-rc.2.tgz', integrity: 'sha512-YWJjZA=='};
  const bytes = Buffer.from(JSON.stringify({packages: {'node_modules/@deepseek-ai/dsh': {version: '0.2.0-rc.2'}, 'node_modules/@deepseek-ai/example': archive}}));
  return {bytes, catalog: {schemaVersion: 1, moteCommit: 'a'.repeat(40), lockfileGitBlob: gitBlob(bytes), dshVersion: '0.2.0-rc.2',
    samples: [{id: 'example', package: '@deepseek-ai/example', origin: 'upstream', category: 'tool', track: 'target', scenario: 'Generated metadata only', source: {type: 'npm-lock', ...archive}}]}};
}

test('frozen real sample inventory contains twelve candidates and two community sources', async () => {
  const value = await readCatalog();
  assert.equal(value.samples.length, 12);
  assert.equal(value.samples.filter(sample => sample.origin === 'community').length, 2);
  assert.equal(value.marketSource.snapshotDigest, null);
});
test('Git blob digest uses byte length rather than UTF-16 length', () => {
  assert.equal(gitBlob(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.notEqual(gitBlob(Buffer.from('中文🌱')), gitBlob(Buffer.from('中文')));
});
test('metadata matching never reports installed or runtime-compatible plugins', () => {
  const {catalog, bytes} = fixture(); const report = auditLock(catalog, bytes);
  assert.equal(report.samples[0].metadata, 'lock_matched');
  assert.equal(report.samples[0].archiveBytesVerified, false);
  assert.deepEqual(Object.values(report.samples[0].stages), Array(4).fill('not_run'));
  assert.equal(report.summary.compatibilityRate, null);
  assert.equal(report.summary.runtimeExecuted, 0);
});
test('changed lock bytes require a new frozen dataset', () => {
  const {catalog, bytes} = fixture(); assert.throws(() => auditLock(catalog, Buffer.concat([bytes, Buffer.from('\n')])), /lockfile changed/);
});
for (const field of ['version', 'resolved', 'integrity']) test(`changed ${field} cannot reuse an archive pin`, () => {
  const {catalog, bytes} = fixture();
  if (field === 'version') {const lock = JSON.parse(bytes); lock.packages['node_modules/@deepseek-ai/example'].version = '0.1.0'; const changed = Buffer.from(JSON.stringify(lock)); catalog.lockfileGitBlob = gitBlob(changed); assert.throws(() => auditLock(catalog, changed), /pin mismatch/);}
  else {catalog.samples[0].source[field] = field === 'integrity' ? 'sha512-YWJjZQ==' : 'https://registry.npmjs.org/changed.tgz'; assert.throws(() => auditLock(catalog, bytes), /pin mismatch/);}
});
test('duplicate sample IDs are rejected', () => {const {catalog} = fixture(); catalog.samples.push(structuredClone(catalog.samples[0])); assert.throws(() => validateCatalog(catalog), /duplicate/);});
test('unknown source types are rejected rather than converted to npm', () => {const {catalog} = fixture(); catalog.samples[0].source.type = 'shell'; assert.throws(() => validateCatalog(catalog), /Unknown sample source/);});
test('origin is explicitly declared; package scope does not grant official identity', () => {const {catalog, bytes} = fixture(); catalog.samples[0].origin = 'community'; assert.equal(auditLock(catalog, bytes).samples[0].origin, 'community');});
for (const url of ['http://registry.npmjs.org/a.tgz', 'https://user:secret@registry.npmjs.org/a.tgz', 'https://example.invalid/a.tgz', 'https://registry.npmjs.org/a.tgz#other']) test(`reject unsafe archive source ${new URL(url).protocol} ${new URL(url).hostname} ${url.includes('#')}`, () => {const {catalog} = fixture(); catalog.samples[0].source.resolved = url; assert.throws(() => validateCatalog(catalog), /Invalid npm archive/);});
for (const path of ['../main.js', '/main.js', 'lib/../main.js', 'lib\\main.js']) test(`reject escaping pinned file ${path}`, () => {
  const {catalog} = fixture(); catalog.samples[0].source = {type: 'git', repository: 'example/plugin', commit: 'b'.repeat(40), manifestGitBlob: 'c'.repeat(40), files: {'package.json': 'c'.repeat(40), [path]: 'd'.repeat(40)}};
  assert.throws(() => validateCatalog(catalog), /Invalid pinned file/);
});
test('source-byte validation rejects mutation and symlink replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mote-compat-generated-'));
  try {
    await mkdir(join(root, 'plugin')); const directory = join(root, 'plugin'); const data = Buffer.from('{"name":"generated"}\n');
    await writeFile(join(directory, 'package.json'), data);
    const sample = {id: 'generated', source: {type: 'git', files: {'package.json': gitBlob(data)}}};
    assert.deepEqual(await verifySourceFiles(directory, sample), {'package.json': gitBlob(data)});
    await writeFile(join(directory, 'package.json'), '{}'); await assert.rejects(verifySourceFiles(directory, sample), /byte mismatch/);
    await rm(join(directory, 'package.json')); await writeFile(join(root, 'other.json'), data); await symlink(join(root, 'other.json'), join(directory, 'package.json'));
    await assert.rejects(verifySourceFiles(directory, sample), /non-symlink/);
  } finally {await rm(root, {recursive: true, force: true});}
});
test('Node 22 and missing dependencies are explicit blockers', () => {
  const result = environmentProblems('v22.16.0', () => {throw Error('missing');});
  assert.equal(result.length, 5); assert.ok(result.includes('node_24_required'));
});
test('environment readiness only checks prerequisites', () => {
  assert.deepEqual(environmentProblems('v24.19.0', () => '/generated/resolved-entry.js'), []);
});
