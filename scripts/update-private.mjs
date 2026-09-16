import { mkdir, lstat, readdir, readFile, writeFile, copyFile, rm, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { compose, dockerContainer, execute } from './profile-lib.mjs';

async function privateCopy(source, destination, budget = { entries: 0, files: 0, bytes: 0 }) {
  if (++budget.entries > 1000) throw Error('Connector state entry count exceeds the rollback limit');
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) throw Error('Connector credential links are not allowed during rollback');
  if (metadata.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    for (const name of await readdir(source)) await privateCopy(join(source, name), join(destination, name), budget);
  } else {
    if (!metadata.isFile() || ++budget.files > 100 || (budget.bytes += metadata.size) > 8 * 1024 * 1024) throw Error('Connector state exceeds the private rollback limit');
    await copyFile(source, destination);
    const handle = await open(destination, 'r+');
    try { await handle.chmod(0o600); await handle.sync(); } finally { await handle.close(); }
  }
}
async function privateKeyCopy(source, destination) {
  let metadata;
  try { metadata = await lstat(source); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 128) throw Error('Content key must be an ordinary private file during rollback');
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const current = await input.stat();
    if (!current.isFile() || current.nlink !== 1 || current.size > 128 || current.ino !== metadata.ino || current.dev !== metadata.dev) throw Error('Content key changed during rollback');
    bytes = await input.readFile();
  } finally { await input.close(); }
  if (!/^[a-f0-9]{64}\s*$/i.test(bytes.toString('utf8'))) throw Error('Invalid private content key during rollback');
  const output = await open(destination, 'wx', 0o600);
  try { await output.writeFile(bytes); await output.sync(); }
  finally { await output.close(); }
  return true;
}
// Probe only file metadata, never print key bytes into a process capture or log.
const contentKeyExists = "const fs=require('node:fs');let present=false;try{const info=fs.lstatSync('/data/content-key');if(!info.isFile()||info.nlink!==1||info.size>128)throw Error('Content key must be an ordinary private file during rollback');present=true;}catch(e){if(e.code!=='ENOENT')throw e;}process.stdout.write('\\nMOTE_CONTENT_KEY_EXISTS:'+(present?'yes':'no')+'\\n');";
const readConnections = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/mote.sqlite',{readOnly:true});try{const exists=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_connections'").get();process.stdout.write('\\nMOTE_CONNECTIONS:'+JSON.stringify(exists?db.prepare('SELECT id,json FROM source_connections').all():[])+'\\n');}finally{db.close();}`;
const applyConnections = `const fs=require('node:fs');const {DatabaseSync}=require('node:sqlite');const path='/data/connectors/.mote-rollback-connections.json';const rows=JSON.parse(fs.readFileSync(path,'utf8'));const db=new DatabaseSync('/data/mote.sqlite');try{db.exec('CREATE TABLE IF NOT EXISTS source_connections(id TEXT PRIMARY KEY,json TEXT NOT NULL);BEGIN IMMEDIATE');try{const put=db.prepare('INSERT INTO source_connections(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json');for(const row of rows)put.run(row.id,row.json);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}}finally{db.close();fs.unlinkSync(path);}`;
function marked(output, marker) { const lines = output.split(/\r?\n/).filter(line => line.startsWith(marker)); if (lines.length !== 1) throw Error('Private connector probe did not return one result'); return lines[0].slice(marker.length); }

/** Private rollback handoff, deliberately separate from portable backups and never printed. */
export async function preserveConnectorState(p) {
  const directory = join(p.directory, 'backups', `.connectors-${randomUUID()}`); await mkdir(directory, { mode: 0o700 });
  const connectors = join(directory, 'connectors');
  try {
    let rows;
    if (p.meta.runtime === 'docker') {
      const container = await dockerContainer(p);
      const keyExists = marked(await compose(p, ['run', '--rm', '--no-deps', 'mote', 'node', '-e', contentKeyExists], { capture: true }), 'MOTE_CONTENT_KEY_EXISTS:');
      if (keyExists === 'yes') {
        const importedKey = join(directory, 'imported-content-key');
        await execute('docker', ['cp', `${container}:/data/content-key`, importedKey], { capture: true });
        await privateKeyCopy(importedKey, join(directory, 'content-key')); await rm(importedKey);
      } else if (keyExists !== 'no') throw Error('Content key state probe failed');
      const exists = marked(await compose(p, ['run', '--rm', '--no-deps', 'mote', 'node', '-e', "process.stdout.write('\\nMOTE_CONNECTOR_EXISTS:'+(require('node:fs').existsSync('/data/connectors')?'yes':'no')+'\\n')"], { capture: true }), 'MOTE_CONNECTOR_EXISTS:');
      if (exists === 'yes') {
        const imported = join(directory, 'imported');
        await execute('docker', ['cp', `${container}:/data/connectors`, imported], { capture: true });
        await privateCopy(imported, connectors); await rm(imported, { recursive: true, force: true });
      } else if (exists === 'no') await mkdir(connectors, { mode: 0o700 });
      else throw Error('Connector state probe failed');
      rows = JSON.parse(marked(await compose(p, ['run', '--rm', '--no-deps', 'mote', 'node', '--disable-warning=ExperimentalWarning', '-e', readConnections], { capture: true }), 'MOTE_CONNECTIONS:'));
    } else {
      await privateKeyCopy(join(p.dataDir, 'content-key'), join(directory, 'content-key'));
      const path = join(p.dataDir, 'connectors');
      try { await lstat(path); await privateCopy(path, connectors); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await mkdir(connectors, { mode: 0o700 }); }
      const db = new DatabaseSync(join(p.dataDir, 'mote.sqlite'), { readOnly: true });
      try { rows = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_connections'").get() ? db.prepare('SELECT id,json FROM source_connections').all() : []; }
      finally { db.close(); }
    }
    if (!Array.isArray(rows) || rows.length > 500 || JSON.stringify(rows).length > 2 * 1024 * 1024) throw Error('Connection metadata exceeds the rollback limit');
    await writeFile(join(connectors, '.mote-rollback-connections.json'), JSON.stringify(rows), { flag: 'wx', mode: 0o600 });
    // The archive goes backwards but authorization/selection stays current. A newer sync token must
    // not skip events absent from the restored archive; rebuild the bounded selected calendars.
    const google = join(connectors, 'google-calendar.json');
    try { const saved = JSON.parse(await readFile(google, 'utf8')); saved.checkpoints = {}; await writeFile(google, JSON.stringify(saved), { mode: 0o600 }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return directory;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
export async function restoreConnectorState(p, directory) {
  const source = join(directory, 'connectors');
  if (p.meta.runtime === 'docker') {
    const container = await dockerContainer(p);
    const key = join(directory, 'content-key'), checkedKey = join(directory, 'restored-content-key');
    if (await privateKeyCopy(key, checkedKey)) {
      await execute('docker', ['cp', checkedKey, `${container}:/data/content-key`], { capture: true });
      await compose(p, ['run', '--rm', '--no-deps', '--user', '0:0', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', 'mote', 'chown', 'node:node', '/data/content-key'], { capture: true });
    }
    await execute('docker', ['cp', source, `${container}:/data/connectors`], { capture: true });
    await compose(p, ['run', '--rm', '--no-deps', '--user', '0:0', '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', 'mote', 'chown', '-R', 'node:node', '/data/connectors'], { capture: true });
    await compose(p, ['run', '--rm', '--no-deps', 'mote', 'node', '-e', applyConnections], { capture: true });
  } else {
    await privateKeyCopy(join(directory, 'content-key'), join(p.dataDir, 'content-key'));
    const target = join(p.dataDir, 'connectors'); await privateCopy(source, target);
    const metadata = join(target, '.mote-rollback-connections.json'), rows = JSON.parse(await readFile(metadata, 'utf8'));
    const db = new DatabaseSync(join(p.dataDir, 'mote.sqlite'));
    try {
      db.exec('CREATE TABLE IF NOT EXISTS source_connections(id TEXT PRIMARY KEY,json TEXT NOT NULL);BEGIN IMMEDIATE');
      try { const put = db.prepare('INSERT INTO source_connections(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json'); for (const row of rows) put.run(row.id, row.json); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); await rm(metadata, { force: true }); }
  }
}
