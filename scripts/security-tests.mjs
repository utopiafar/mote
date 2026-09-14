import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, link, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { repository } from './profile-lib.mjs';

const run = promisify(execFile);
async function fixture(action) {
  const directory = await mkdtemp(join(tmpdir(), 'mote-security-fixture-'));
  try { await action(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function vault(directory, hash = createHash('sha256').update('generated blob').digest('hex')) {
  const source = join(directory, 'vault');
  await mkdir(join(source, 'blobs'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(source, 'mote.sqlite'));
  try { db.exec('CREATE TABLE blobs(hash TEXT PRIMARY KEY)'); db.prepare('INSERT INTO blobs VALUES(?)').run(hash); } finally { db.close(); }
  if (/^[a-f0-9]{64}$/.test(hash)) await writeFile(join(source, 'blobs', hash), 'generated blob');
  return { source, hash };
}
const backup = (source, out) => run(process.execPath, [join(repository, 'scripts/backup.ts'), '--data', source, '--out', out], { timeout: 15000 });

test('backup makes private files and preserves only the database and ordinary referenced blobs', async () => fixture(async directory => {
  const { source, hash } = await vault(directory), out = join(directory, 'snapshot');
  await writeFile(join(source, 'access-token'), 'synthetic-owner-token');
  await backup(source, out);
  assert.deepEqual((await readdir(out)).sort(), ['backup-manifest.json', 'blobs', 'mote.sqlite']);
  for (const path of [out, join(out, 'blobs')]) assert.equal((await stat(path)).mode & 0o777, 0o700);
  for (const name of ['mote.sqlite', 'backup-manifest.json', 'blobs/' + hash]) assert.equal((await stat(join(out, name))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(out, 'blobs', hash), 'utf8'), 'generated blob');
}));

test('malicious database blob paths cannot overwrite files outside the snapshot', async () => fixture(async directory => {
  const { source } = await vault(directory, '../../sentinel'), out = join(directory, 'exports', 'snapshot');
  await mkdir(join(directory, 'exports'));
  await writeFile(join(directory, 'sentinel'), 'attacker-directed overwrite');
  await writeFile(join(directory, 'exports', 'sentinel'), 'keep existing file');
  await assert.rejects(backup(source, out), /Invalid blob hash/);
  await assert.rejects(lstat(out), { code: 'ENOENT' });
  assert.equal(await readFile(join(directory, 'exports', 'sentinel'), 'utf8'), 'keep existing file');
}));

test('backup refuses linked blobs and leaves existing output directories untouched', async () => fixture(async directory => {
  const { source, hash } = await vault(directory), out = join(directory, 'snapshot');
  await mkdir(out); await writeFile(join(out, 'sentinel'), 'keep');
  await assert.rejects(backup(source, out));
  assert.equal(await readFile(join(out, 'sentinel'), 'utf8'), 'keep');
  const secret = join(source, 'access-token'); await writeFile(secret, 'synthetic-owner-token');
  await rm(join(source, 'blobs', hash)); await symlink(secret, join(source, 'blobs', hash));
  await assert.rejects(backup(source, join(directory, 'linked-blob')), /links and special files/);
  await rm(join(source, 'blobs', hash)); await link(secret, join(source, 'blobs', hash));
  await assert.rejects(backup(source, join(directory, 'hardlinked-blob')), /links and special files/);
  await symlink(out, join(directory, 'linked-output'));
  await assert.rejects(backup(source, join(directory, 'linked-output')));
  assert.equal(await readFile(join(out, 'sentinel'), 'utf8'), 'keep');
}));

test('backup containment rejects dot-dot names and symlink aliases into the active vault', async () => fixture(async directory => {
  const { source } = await vault(directory);
  await assert.rejects(backup(source, join(source, '..snapshot')), /outside the active vault/);
  await assert.rejects(backup(source, join(source, '..\\snapshot')), /outside the active vault/);
  await symlink(source, join(directory, 'alias'));
  await assert.rejects(backup(source, join(directory, 'alias', 'snapshot')), /outside the active vault/);
  await assert.rejects(backup(source, join(directory, 'alias', 'new-parent', 'snapshot')), /outside the active vault/);
  assert.deepEqual((await readdir(source)).sort(), ['blobs', 'mote.sqlite']);
}));
