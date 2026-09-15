import { DatabaseSync, backup } from 'node:sqlite';
import { constants, createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, rm, realpath, lstat, chmod } from 'node:fs/promises';
import { resolve, join, relative, dirname, basename, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const usage = 'Stop the central node first. Usage: npm run backup -- --data ./data --out /absolute/new-backup-directory';
if (args.includes('--help')) { console.info(usage + '\nBacks up SQLite, referenced image/file objects, processing layers and checksums. Tokens/keys are excluded; preserve your data key separately.'); process.exit(0); }
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
try {
  await mkdir(join(out, 'blobs'), { mode: 0o700 });
  await ordinarySource(join(source, 'mote.sqlite'));
  const db = new DatabaseSync(join(source, 'mote.sqlite'), { readOnly: true });
  try {
    const rows = db.prepare('SELECT hash FROM blobs').all() as { hash: unknown }[];
    // Restored databases are data, never authority to read arbitrary vault files.
    for (const { hash } of rows) {
      if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid blob hash in backup source');
      await ordinarySource(join(source, 'blobs', hash));
    }
    const fileObjects = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='file_objects'").get()
      ? db.prepare('SELECT hash,parts FROM file_objects').all() as {hash:string;parts:number}[] : [];
    for(const object of fileObjects){
      if(!/^[a-f0-9]{64}$/.test(object.hash)||!Number.isSafeInteger(object.parts)||object.parts<0||object.parts>128)throw new Error('Invalid file object in backup source');
      await mkdir(join(out,'files','objects',object.hash),{recursive:true,mode:0o700});
      for(let part=0;part<object.parts;part++){
        const path=join('files','objects',object.hash,String(part));await ordinarySource(join(source,path));
        await copyFile(join(source,path),join(out,path),constants.COPYFILE_EXCL);await chmod(join(out,path),0o600);checksums[path]=await sum(join(out,path));
      }
    }
    await backup(db, join(out, 'mote.sqlite'));
    await chmod(join(out, 'mote.sqlite'), 0o600);
    for (const row of rows) {
      const hash = row.hash as string;
      await copyFile(join(source, 'blobs', hash), join(out, 'blobs', hash), constants.COPYFILE_EXCL);
      await chmod(join(out, 'blobs', hash), 0o600);
      checksums['blobs/' + hash] = await sum(join(out, 'blobs', hash));
    }
  } finally { db.close(); }
  // Upload staging is deliberately excluded. Restored clients reopen sessions and resume from their encrypted staging.
  const restored = new DatabaseSync(join(out, 'mote.sqlite'));
  try { if(restored.prepare("SELECT 1 FROM sqlite_master WHERE name='file_uploads'").get()) restored.exec("PRAGMA foreign_keys=ON; DELETE FROM file_uploads; UPDATE file_jobs SET state='waiting' WHERE state='running'; UPDATE file_jobs SET summary_state='waiting' WHERE summary_state='running'"); } finally { restored.close(); }
  checksums['mote.sqlite'] = await sum(join(out, 'mote.sqlite'));
  await writeFile(join(out, 'backup-manifest.json'), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), checksums, note: 'Tokens and data encryption keys are intentionally excluded. Preserve MOTE_DATA_KEY separately if enabled.' }, null, 2), { mode: 0o600, flag: 'wx' });
  console.info(`Consistent vault backup written to ${out}. Restore into an empty data directory; keep the same data encryption key.`);
} catch (error) { await rm(out, { recursive: true, force: true }); throw error; }
