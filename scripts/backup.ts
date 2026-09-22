import { DatabaseSync, backup } from 'node:sqlite';
import { constants, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, rm, realpath, lstat, chmod } from 'node:fs/promises';
import { resolve, join, relative, dirname, basename, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const usage = 'Stop the central node first. Usage: npm run backup -- --data ./data --out /absolute/new-backup-directory';
if (args.includes('--help')) { console.info(usage + '\nBacks up SQLite, referenced image/file originals, processing layers and checksums. Plaintext, encrypted and legacy content keep their stored formats. Import scripts/workspaces and tokens/keys are excluded; unfinished imports must be analyzed again after restore. Preserve MOTE_DATA_KEY or the vault content-key file separately when encryption has been used.'); process.exit(0); }
function argument(name: string, fallback?: string) {
  const index = args.indexOf(name);
  if (index < 0 && fallback !== undefined) return fallback;
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(usage);
  return args[index + 1];
}
const source = await realpath(resolve(argument('--data', 'data')));
const requestedOut = resolve(argument('--out'));
function outsideVault(path: string) {
  const delta = relative(source, path);
  if (!(delta === '..' || delta.startsWith('..' + sep) || isAbsolute(delta))) throw new Error('Backup destination must be outside the active vault');
}
outsideVault(requestedOut);
try {
  const pid = Number((await readFile(join(source, 'server.pid'), 'utf8')).trim());
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid vault server.pid; inspect it before backing up');
  try { process.kill(pid, 0); throw new Error('The central node is still running. Stop it before copying a consistent database + blob backup.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
} catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
// Resolve aliases before checking containment. Exclusively create the output root so an
// existing directory/symlink is never reused or removed by failure cleanup.
async function canonicalParent(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A dangling alias is not a missing directory that we can safely create.
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Backup parent links must resolve to an existing directory'); }
    catch (entryError) { if ((entryError as NodeJS.ErrnoException).code !== 'ENOENT') throw entryError; }
    return join(await canonicalParent(dirname(path)), basename(path));
  }
}
const out = join(await canonicalParent(dirname(requestedOut)), basename(requestedOut));
outsideVault(out);
await mkdir(dirname(out), { recursive: true, mode: 0o700 });
outsideVault(join(await realpath(dirname(out)), basename(out)));
await mkdir(out, { mode: 0o700 });
const checksums: Record<string, string> = {};
async function sum(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function ordinarySource(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || await realpath(path) !== path) throw new Error('Backup source links and special files are not allowed');
}
async function selectedContentPath(base: string): Promise<string> {
  // Match the mixed-format reader without opening or decrypting content. A present
  // unsafe preferred variant is an error, never permission to follow a fallback.
  for (const suffix of ['.plain', '.aes', '']) {
    const path = base + suffix;
    try { await lstat(join(source, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    await ordinarySource(join(source, path));
    return path;
  }
  throw Object.assign(new Error(`ENOENT: referenced content is missing: ${base}`), { code: 'ENOENT' });
}
try {
  await mkdir(join(out, 'blobs'), { mode: 0o700 });
  await ordinarySource(join(source, 'mote.sqlite'));
  const db = new DatabaseSync(join(source, 'mote.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT hash FROM blobs').all() as { hash: unknown }[];
    const fileRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='file_blobs'").get()
      ? db.prepare('SELECT hash FROM file_blobs').all() as { hash: unknown }[] : [];
    const fileObjects = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_objects'").get()
      ? db.prepare('SELECT hash,parts FROM file_objects').all() as {hash:unknown;parts:unknown}[] : [];
    const assets=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assets'").get()?db.prepare('SELECT hash,parts,format FROM assets WHERE hash IN (SELECT hash FROM asset_references)').all() as {hash:string;parts:number;format:string}[]:[];
    const unified=new Set(assets.map(asset=>asset.hash)),paths:string[]=[];
    for(const asset of assets){
      if(!/^[a-f0-9]{64}$/.test(asset.hash)||!Number.isSafeInteger(asset.parts)||asset.parts<0||asset.parts>128)throw new Error('Invalid asset metadata');
      if(asset.format==='chunks')for(let part=0;part<asset.parts;part++)paths.push(await selectedContentPath(`files/objects/${asset.hash}/${part}`));
      else if(asset.format==='image-legacy')paths.push('blobs/'+asset.hash);
      else if(asset.format==='archive-legacy')paths.push(await selectedContentPath('files/'+asset.hash));
      else throw new Error('Invalid asset format');
    }
    // Restored databases are data, never authority to read arbitrary vault files.
    for (const { hash } of rows) {
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid blob hash in backup source');
      if(!unified.has(hash))paths.push('blobs/'+hash);
    }
    for (const { hash } of fileRows) {
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid file hash in backup source');
      if(!unified.has(hash))paths.push(await selectedContentPath('files/'+hash));
    }
    for(const object of fileObjects){
      if(typeof object.hash!=='string'||!/^[a-f0-9]{64}$/.test(object.hash)||typeof object.parts!=='number'||!Number.isSafeInteger(object.parts)||object.parts<0||object.parts>128)throw new Error('Invalid file object in backup source');
      if(unified.has(object.hash))continue;
      for(let part=0;part<object.parts;part++)paths.push(await selectedContentPath(`files/objects/${object.hash}/${part}`));
    }
    for(const path of paths)await ordinarySource(join(source,path));
    await backup(db, join(out, 'mote.sqlite'));
    await chmod(join(out, 'mote.sqlite'), 0o600);
    // Workspaces contain generated programs, not authoritative evidence. Reconstruct inputs
    // from archived originals and obtain a fresh reviewed manifest after restoration.
    const snapshot = new DatabaseSync(join(out, 'mote.sqlite'));
    try {
      snapshot.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
      const hasTable=(name:string)=>!!snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      try{
        // Upload staging is excluded. Clients open new sessions from their own durable queues.
        if(hasTable('file_uploads'))snapshot.exec('DELETE FROM file_uploads');
        if(hasTable('asset_pins'))snapshot.exec('DELETE FROM asset_pins');
        if(hasTable('assets'))snapshot.exec('DELETE FROM assets WHERE hash NOT IN (SELECT hash FROM asset_references)');
        if(hasTable('file_parts'))snapshot.exec('DELETE FROM file_parts');
        if(hasTable('file_jobs'))snapshot.exec("UPDATE file_jobs SET state='waiting' WHERE state='running'; UPDATE file_jobs SET summary_state='waiting' WHERE summary_state='running'");
        if(hasTable('file_steps'))snapshot.exec("UPDATE file_steps SET state='waiting' WHERE state='running'");
        // A lease belongs to the original running host, never to the restored vault.
        // Keep attempts/deadlines and completed steps; domain recovery decides whether
        // interrupted work can resume. Interactive model calls are never replayed.
        if(hasTable('execution_steps'))snapshot.exec("UPDATE execution_steps SET lease_until=0,fence=NULL WHERE state='running'");
        if(hasTable('run_execution_owners'))snapshot.exec('DELETE FROM run_execution_owners');
        if(hasTable('import_jobs')){
          const jobs = snapshot.prepare('SELECT id,json FROM import_jobs').all() as {id:string;json:string}[];
          for (const row of jobs) {
            const job=JSON.parse(row.json);
            delete job.workspace;delete job.inputs;
            if(job.status!=='completed'){
              delete job.manifestHash;
              job.status=job.blockedArchive?'failed':'queued';job.processingStatus=job.blockedArchive?'blocked':'archived';job.failurePhase='prepare';
              job.progress={total:0,processed:0,imported:0,duplicates:0};delete job.preview;delete job.dispositions;
              if(!job.blockedArchive)job.error='Restored backup: original files are retained. Analyze this import again and review a new preview before continuing.';
            }
            snapshot.prepare('UPDATE import_jobs SET json=? WHERE id=?').run(JSON.stringify(job),row.id);
          }
        }
        snapshot.exec('COMMIT');
      }catch(error){snapshot.exec('ROLLBACK');throw error;}
    }finally{snapshot.close();}
    for(const path of paths){
      await mkdir(dirname(join(out,path)),{recursive:true,mode:0o700});
      await copyFile(join(source,path),join(out,path),constants.COPYFILE_EXCL);
      await chmod(join(out,path),0o600);checksums[path]=await sum(join(out,path));
    }
  } finally { db.close(); }
  checksums['mote.sqlite'] = await sum(join(out, 'mote.sqlite'));
  await writeFile(join(out, 'backup-manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), checksums, note: 'Referenced image and file originals are included in their selected stored formats; checksums retain explicit .plain, .aes or legacy filenames. Import workspaces/scripts, tokens and encryption keys are excluded. Unfinished imports require a fresh analysis and preview after restore. Preserve MOTE_DATA_KEY or the vault content-key file separately when encryption has been used, including after disabling new encrypted writes.' }, null, 2), { mode: 0o600, flag: 'wx' });
  console.info(`Consistent vault backup written to ${out}. Restore into an empty data directory; separately restore the original MOTE_DATA_KEY or content-key when encryption has been used.`);
} catch (error) { await rm(out, { recursive: true, force: true }); throw error; }
