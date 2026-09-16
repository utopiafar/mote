import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, link, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { repository, verifiedBackup, restoreProfile } from './profile-lib.mjs';

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

test('backup includes private file originals, excludes workspaces, and restores checksum-verified files',async()=>fixture(async directory=>{
  const {source}=await vault(directory),out=join(directory,'snapshot'),original=Buffer.from('synthetic encrypted-looking original'),hash=createHash('sha256').update(original).digest('hex');
  await mkdir(join(source,'files'));await writeFile(join(source,'files',hash),original);await writeFile(join(source,'files','unreferenced'),'do not copy');
  await mkdir(join(source,'imports','synthetic'),{recursive:true});await writeFile(join(source,'imports','synthetic','script.mjs'),'throw new Error("synthetic generated script")');
  const job={id:'synthetic',status:'importing',workspace:join(source,'imports','synthetic'),inputs:[{path:join(source,'imports','synthetic','input.txt')}],captureIds:['retained-evidence-id'],progress:{total:2,processed:1,imported:1,duplicates:0},preview:{count:2},manifestHash:'old-manifest'};
  const db=new DatabaseSync(join(source,'mote.sqlite'));db.exec('CREATE TABLE file_blobs(hash TEXT PRIMARY KEY,bytes INTEGER); CREATE TABLE import_jobs(id TEXT PRIMARY KEY,json TEXT)');db.prepare('INSERT INTO file_blobs VALUES(?,?)').run(hash,original.length);db.prepare('INSERT INTO import_jobs VALUES(?,?)').run('synthetic',JSON.stringify(job));db.close();
  await backup(source,out);assert.deepEqual((await readdir(out)).sort(),['backup-manifest.json','blobs','files','mote.sqlite']);assert.deepEqual(await readdir(join(out,'files')),[hash]);
  assert.equal((await stat(join(out,'files'))).mode&0o777,0o700);assert.equal((await stat(join(out,'files',hash))).mode&0o777,0o600);
  const checked=await verifiedBackup(out);assert.ok(checked.names.includes('files/'+hash));
  const snapshot=new DatabaseSync(join(out,'mote.sqlite'),{readOnly:true});const saved=JSON.parse(snapshot.prepare('SELECT json FROM import_jobs').get().json);snapshot.close();
  assert.equal(saved.status,'failed');assert.equal(saved.failurePhase,'prepare');assert.equal(saved.workspace,undefined);assert.equal(saved.inputs,undefined);assert.equal(saved.manifestHash,undefined);assert.equal(saved.preview,undefined);assert.equal(saved.progress.processed,0);assert.deepEqual(saved.captureIds,['retained-evidence-id']);
  const untouched=new DatabaseSync(join(source,'mote.sqlite'),{readOnly:true});assert.equal(JSON.parse(untouched.prepare('SELECT json FROM import_jobs').get().json).status,'importing');untouched.close();
  const target=join(directory,'restored');await restoreProfile({meta:{runtime:'native'},dataDir:target,processFile:join(directory,'absent-process.json')},out);assert.deepEqual(await readFile(join(target,'files',hash)),original);assert.equal((await stat(join(target,'files',hash))).mode&0o777,0o600);
  await writeFile(join(out,'files',hash),'changed');await assert.rejects(verifiedBackup(out),/checksum mismatch/);
}));

test('backup rejects unsafe file-original hashes and links just as it rejects image links',async()=>fixture(async directory=>{
  const {source}=await vault(directory);await mkdir(join(source,'files'));const db=new DatabaseSync(join(source,'mote.sqlite'));db.exec('CREATE TABLE file_blobs(hash TEXT PRIMARY KEY)');db.prepare('INSERT INTO file_blobs VALUES(?)').run('../token');db.close();
  await assert.rejects(backup(source,join(directory,'bad-file-hash')),/Invalid file hash/);
  const hash='a'.repeat(64),again=new DatabaseSync(join(source,'mote.sqlite'));again.exec('DELETE FROM file_blobs');again.prepare('INSERT INTO file_blobs VALUES(?)').run(hash);again.close();
  await writeFile(join(source,'secret'),'synthetic token');await symlink(join(source,'secret'),join(source,'files',hash));await assert.rejects(backup(source,join(directory,'linked-file')),/links and special files/);
}));
