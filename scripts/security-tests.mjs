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
  try {
    db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT); INSERT INTO settings VALUES('backend_epoch','4'); CREATE TABLE assets(hash TEXT PRIMARY KEY,parts,format TEXT); CREATE TABLE asset_references(owner TEXT PRIMARY KEY,hash TEXT)");
    db.prepare("INSERT INTO assets VALUES(?,1,'chunks')").run(hash);db.prepare('INSERT INTO asset_references VALUES(?,?)').run('generated-original',hash);
  } finally { db.close(); }
  const partPath=join(source,'files','objects',hash,'0.plain');
  if (/^[a-f0-9]{64}$/.test(hash)){await mkdir(join(source,'files','objects',hash),{recursive:true,mode:0o700});await writeFile(partPath,'generated blob');}
  return { source, hash, partPath };
}
async function currentAsset(source,hash,parts,suffixes=parts.map(()=>'.plain')){
  await mkdir(join(source,'files','objects',hash),{recursive:true});
  for(const [index,bytes] of parts.entries())await writeFile(join(source,'files','objects',hash,index+suffixes[index]),bytes);
  const db=new DatabaseSync(join(source,'mote.sqlite'));try{db.prepare("INSERT INTO assets VALUES(?,?,'chunks')").run(hash,parts.length);db.prepare('INSERT INTO asset_references VALUES(?,?)').run('generated-'+hash,hash);}finally{db.close();}
}
const backup = (source, out) => run(process.execPath, [join(repository, 'scripts/backup.ts'), '--data', source, '--out', out], { timeout: 15000 });

test('backup makes private files and preserves only the database and ordinary referenced chunks', async () => fixture(async directory => {
  const { source, hash } = await vault(directory), out = join(directory, 'snapshot');
  await writeFile(join(source, 'access-token'), 'synthetic-owner-token');
  await backup(source, out);
  assert.deepEqual((await readdir(out)).sort(), ['backup-manifest.json', 'blobs', 'files', 'mote.sqlite']);
  for (const path of [out, join(out, 'blobs')]) assert.equal((await stat(path)).mode & 0o777, 0o700);
  for (const name of ['mote.sqlite', 'backup-manifest.json', `files/objects/${hash}/0.plain`]) assert.equal((await stat(join(out, name))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(out, 'files','objects', hash,'0.plain'), 'utf8'), 'generated blob');
}));

test('malicious database blob paths cannot overwrite files outside the snapshot', async () => fixture(async directory => {
  const { source } = await vault(directory, '../../sentinel'), out = join(directory, 'exports', 'snapshot');
  await mkdir(join(directory, 'exports'));
  await writeFile(join(directory, 'sentinel'), 'attacker-directed overwrite');
  await writeFile(join(directory, 'exports', 'sentinel'), 'keep existing file');
  await assert.rejects(backup(source, out), /Invalid asset metadata/);
  await assert.rejects(lstat(out), { code: 'ENOENT' });
  assert.equal(await readFile(join(directory, 'exports', 'sentinel'), 'utf8'), 'keep existing file');
}));

test('backup refuses linked blobs and leaves existing output directories untouched', async () => fixture(async directory => {
  const { source, partPath } = await vault(directory), out = join(directory, 'snapshot');
  await mkdir(out); await writeFile(join(out, 'sentinel'), 'keep');
  await assert.rejects(backup(source, out));
  assert.equal(await readFile(join(out, 'sentinel'), 'utf8'), 'keep');
  const secret = join(source, 'access-token'); await writeFile(secret, 'synthetic-owner-token');
  await rm(partPath); await symlink(secret, partPath);
  await assert.rejects(backup(source, join(directory, 'linked-blob')), /links and special files/);
  await rm(partPath); await link(secret, partPath);
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
  assert.deepEqual((await readdir(source)).sort(), ['blobs', 'files', 'mote.sqlite']);
}));

test('backup includes private file originals, excludes workspaces, and restores checksum-verified files',async()=>fixture(async directory=>{
  const {source}=await vault(directory),out=join(directory,'snapshot'),original=Buffer.from('synthetic encrypted-looking original'),hash=createHash('sha256').update(original).digest('hex');
  await currentAsset(source,hash,[original],['.aes']);await writeFile(join(source,'files','unreferenced'),'do not copy');
  await mkdir(join(source,'imports','synthetic'),{recursive:true});await writeFile(join(source,'imports','synthetic','script.mjs'),'throw new Error("synthetic generated script")');
  const job={id:'synthetic',status:'importing',workspace:join(source,'imports','synthetic'),inputs:[{path:join(source,'imports','synthetic','input.txt')}],captureIds:['retained-evidence-id'],progress:{total:2,processed:1,imported:1,duplicates:0},preview:{count:2},manifestHash:'old-manifest'};
  const db=new DatabaseSync(join(source,'mote.sqlite'));db.exec('CREATE TABLE import_jobs(id TEXT PRIMARY KEY,json TEXT)');db.prepare('INSERT INTO import_jobs VALUES(?,?)').run('synthetic',JSON.stringify(job));db.close();
  const file=`files/objects/${hash}/0.aes`;
  await backup(source,out);assert.deepEqual((await readdir(out)).sort(),['backup-manifest.json','blobs','files','mote.sqlite']);assert.deepEqual(await readdir(join(out,'files')),['objects']);
  assert.equal((await stat(join(out,'files'))).mode&0o777,0o700);assert.equal((await stat(join(out,file))).mode&0o777,0o600);
  const checked=await verifiedBackup(out);assert.ok(checked.names.includes(file));
  const snapshot=new DatabaseSync(join(out,'mote.sqlite'),{readOnly:true});const saved=JSON.parse(snapshot.prepare('SELECT json FROM import_jobs').get().json);snapshot.close();
  assert.equal(saved.status,'queued');assert.equal(saved.processingStatus,'archived');assert.equal(saved.failurePhase,'prepare');assert.equal(saved.workspace,undefined);assert.equal(saved.inputs,undefined);assert.equal(saved.manifestHash,undefined);assert.equal(saved.preview,undefined);assert.equal(saved.progress.processed,0);assert.deepEqual(saved.captureIds,['retained-evidence-id']);
  const untouched=new DatabaseSync(join(source,'mote.sqlite'),{readOnly:true});assert.equal(JSON.parse(untouched.prepare('SELECT json FROM import_jobs').get().json).status,'importing');untouched.close();
  const target=join(directory,'restored');await restoreProfile({meta:{runtime:'native'},dataDir:target,processFile:join(directory,'absent-process.json')},out);assert.deepEqual(await readFile(join(target,file)),original);assert.equal((await stat(join(target,file))).mode&0o777,0o600);
  await writeFile(join(out,file),'changed');await assert.rejects(verifiedBackup(out),/checksum mismatch/);
}));

test('backup rejects unsafe file-original hashes and links just as it rejects image links',async()=>fixture(async directory=>{
  const {source}=await vault(directory),db=new DatabaseSync(join(source,'mote.sqlite'));db.prepare("INSERT INTO assets VALUES(?,1,'chunks')").run('../token');db.prepare('INSERT INTO asset_references VALUES(?,?)').run('malicious','../token');db.close();
  await assert.rejects(backup(source,join(directory,'bad-file-hash')),/Invalid asset metadata/);
  const hash='a'.repeat(64),again=new DatabaseSync(join(source,'mote.sqlite'));again.exec("DELETE FROM assets WHERE hash='../token'; DELETE FROM asset_references WHERE owner='malicious'");again.close();await currentAsset(source,hash,[Buffer.from('generated')]);
  const file=join(source,'files','objects',hash,'0.plain');await rm(file);await writeFile(join(source,'secret'),'synthetic token');await symlink(join(source,'secret'),file);await assert.rejects(backup(source,join(directory,'linked-file')),/links and special files/);
}));

test('backup preserves current plain/encrypted chunks and processing history while recovering only interrupted stages',async()=>fixture(async directory=>{
  const {source}=await vault(directory),out=join(directory,'snapshot'),hash='b'.repeat(64),original=Buffer.from('synthetic sealed import bytes'),parts=[Buffer.from('synthetic sealed part zero'),Buffer.from('synthetic sealed part one')];
  const originalHash=createHash('sha256').update(original).digest('hex');await currentAsset(source,originalHash,[original],['.aes']);await currentAsset(source,hash,parts,['.plain','.aes']);
  await mkdir(join(source,'files','uploads','pending'),{recursive:true});await writeFile(join(source,'files','uploads','pending','0'),'uncommitted staging');
  await writeFile(join(source,'file-processing.json'),'synthetic processing credentials');
  const db=new DatabaseSync(join(source,'mote.sqlite'));
  db.exec(`CREATE TABLE file_uploads(id TEXT PRIMARY KEY);
    CREATE TABLE file_parts(upload_id TEXT REFERENCES file_uploads(id) ON DELETE CASCADE,part INTEGER);
    CREATE TABLE file_jobs(capture_id TEXT PRIMARY KEY,state TEXT,summary_state TEXT,stage TEXT,attempts INTEGER,available_at INTEGER,policy_json TEXT,trace_json TEXT);
    CREATE TABLE file_steps(capture_id TEXT,state TEXT,attempts INTEGER,artifact_id TEXT);
    CREATE TABLE file_usage(day TEXT,audio_ms REAL);
    CREATE TABLE file_artifacts(id TEXT,json TEXT);
    CREATE TABLE file_reviews(id TEXT,json TEXT);`);
  db.exec("INSERT INTO file_uploads VALUES('pending'); INSERT INTO file_parts VALUES('pending',0); INSERT INTO file_usage VALUES('2026-09-16',3456); INSERT INTO file_artifacts VALUES('artifact','{\"preserved\":true}'); INSERT INTO file_reviews VALUES('review','{\"approved\":true}')");
  const job={capture_id:'running',state:'running',summary_state:'running',stage:'align',attempts:3,available_at:12345,policy_json:'{"profile":"generated"}',trace_json:'{"event":"generated"}'};
  const insert=db.prepare('INSERT INTO file_jobs VALUES(?,?,?,?,?,?,?,?)');insert.run(...Object.values(job));insert.run('done','succeeded','succeeded','indexed',2,999,'{}','{}');insert.run('blocked','blocked','blocked','transcribe',1,555,'{}','{}');
  db.exec("INSERT INTO file_steps VALUES('running','running',2,'cached'); INSERT INTO file_steps VALUES('done','succeeded',1,'artifact')");db.close();
  await backup(source,out);const checked=await verifiedBackup(out);
  for(const name of [`files/objects/${originalHash}/0.aes`,`files/objects/${hash}/0.plain`,`files/objects/${hash}/1.aes`])assert.ok(checked.names.includes(name));
  assert.deepEqual((await readdir(join(out,'files'))).sort(),['objects']);
  await assert.rejects(lstat(join(out,'file-processing.json')),{code:'ENOENT'});
  const target=join(directory,'restored'),profile={meta:{runtime:'native'},dataDir:target,processFile:join(directory,'absent-process.json')};await restoreProfile(profile,out);
  assert.deepEqual(await readFile(join(target,'files','objects',originalHash,'0.aes')),original);
  for(const [index,bytes] of parts.entries())assert.deepEqual(await readFile(join(target,'files','objects',hash,index+(index?'.aes':'.plain'))),bytes);
  for(const path of [target,join(target,'files'),join(target,'files','objects'),join(target,'files','objects',hash)])assert.equal((await stat(path)).mode&0o777,0o700);
  for(const name of checked.names)assert.equal((await stat(join(target,name))).mode&0o777,0o600);
  const restored=new DatabaseSync(join(target,'mote.sqlite'),{readOnly:true});
  assert.deepEqual({...restored.prepare("SELECT * FROM file_jobs WHERE capture_id='running'").get()},{...job,state:'waiting',summary_state:'waiting'});
  assert.equal(restored.prepare("SELECT state FROM file_jobs WHERE capture_id='done'").get().state,'succeeded');assert.equal(restored.prepare("SELECT state FROM file_jobs WHERE capture_id='blocked'").get().state,'blocked');
  assert.deepEqual({...restored.prepare("SELECT * FROM file_steps WHERE capture_id='running'").get()},{capture_id:'running',state:'waiting',attempts:2,artifact_id:'cached'});
  for(const table of ['file_uploads','file_parts'])assert.equal(restored.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
  assert.equal(restored.prepare('SELECT audio_ms FROM file_usage').get().audio_ms,3456);assert.equal(restored.prepare('SELECT json FROM file_artifacts').get().json,'{"preserved":true}');assert.equal(restored.prepare('SELECT json FROM file_reviews').get().json,'{"approved":true}');restored.close();
  const untouched=new DatabaseSync(join(source,'mote.sqlite'),{readOnly:true});assert.equal(untouched.prepare("SELECT state FROM file_jobs WHERE capture_id='running'").get().state,'running');assert.equal(untouched.prepare('SELECT COUNT(*) n FROM file_parts').get().n,1);untouched.close();
  await assert.rejects(restoreProfile(profile,out),/empty data directory/);assert.deepEqual(await readFile(join(target,'files','objects',originalHash,'0.aes')),original);
  await writeFile(join(out,'files','objects',hash,'1.aes'),'changed part');await assert.rejects(verifiedBackup(out),/checksum mismatch/);
}));

test('backup rejects invalid part counts, linked parts and missing committed bytes without leaving partial output',async()=>fixture(async directory=>{
  const {source}=await vault(directory),hash='c'.repeat(64);await mkdir(join(source,'files','objects',hash),{recursive:true});
  const db=new DatabaseSync(join(source,'mote.sqlite'));db.prepare('INSERT INTO asset_references VALUES(?,?)').run('invalid-parts',hash);
  for(const [index,parts] of [-1,129,1.5,'invalid',null].entries()){
    db.prepare('DELETE FROM assets WHERE hash=?').run(hash);db.prepare("INSERT INTO assets VALUES(?,?,'chunks')").run(hash,parts);const out=join(directory,'invalid-'+index);
    await assert.rejects(backup(source,out),/Invalid asset metadata/);await assert.rejects(lstat(out),{code:'ENOENT'});
  }
  db.prepare('DELETE FROM assets WHERE hash=?').run(hash);db.prepare("INSERT INTO assets VALUES(?,1,'chunks')").run('../secret');db.prepare('INSERT INTO asset_references VALUES(?,?)').run('bad-hash','../secret');await assert.rejects(backup(source,join(directory,'bad-hash')),/Invalid asset metadata/);
  db.exec("DELETE FROM assets WHERE hash='../secret'; DELETE FROM asset_references WHERE owner='bad-hash'");db.prepare("INSERT INTO assets VALUES(?,1,'chunks')").run(hash);db.close();
  const missing=join(directory,'missing');await assert.rejects(backup(source,missing),/ENOENT/);await assert.rejects(lstat(missing),{code:'ENOENT'});
  await writeFile(join(source,'secret'),'synthetic token');await symlink(join(source,'secret'),join(source,'files','objects',hash,'0.plain'));await assert.rejects(backup(source,join(directory,'linked')),/links and special files/);
  await rm(join(source,'files','objects',hash,'0.plain'));await link(join(source,'secret'),join(source,'files','objects',hash,'0.plain'));await assert.rejects(backup(source,join(directory,'hardlinked')),/links and special files/);
}));

test('restore only accepts canonical bounded file part paths before touching the destination',async()=>fixture(async directory=>{
  const {source}=await vault(directory),out=join(directory,'snapshot'),target=join(directory,'untouched'),hash='d'.repeat(64);await backup(source,out);
  const manifest=JSON.parse(await readFile(join(out,'backup-manifest.json'),'utf8'));await mkdir(target);await writeFile(join(target,'sentinel'),'keep');
  for(const name of [`files/objects/${hash}/128`,`files/objects/${hash}/-1`,`files/objects/${hash}/01`,`files/objects/${hash}/0.0`,`files/objects/${hash}/0/extra`,`files/objects/${hash}/../secret`,`files/uploads/${hash}/0`,`imports/${hash}/script.mjs`]){
    await writeFile(join(out,'backup-manifest.json'),JSON.stringify({...manifest,checksums:{...manifest.checksums,[name]:hash}}));
    await assert.rejects(restoreProfile({meta:{runtime:'native'},dataDir:target,processFile:join(directory,'none')},out),/Unsafe backup manifest entry/);assert.equal(await readFile(join(target,'sentinel'),'utf8'),'keep');
  }
}));
