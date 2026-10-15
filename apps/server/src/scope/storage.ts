import {DatabaseSync} from 'node:sqlite';
import {copyFileSync,existsSync,lstatSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {privateDirectory,privateSqliteFile} from '../private-storage.js';
import {SCOPE_BASELINE,SCOPE_FORMAT,ScopeError,validScopeId} from './baseline.js';

/** Inspect a disposable snapshot. Opening even a read-only WAL database in situ
 * can create sidecars; rejection must leave the entire original directory alone.
 * Startup/restore require a stopped vault; changing files are rejected. */
export function assertScopeStorage(directory:string){
  if(!existsSync(directory))return;
  const info=lstatSync(directory);
  if(!info.isDirectory()||info.isSymbolicLink())throw new ScopeError('unsupported_vault',409);
  const names=readdirSync(directory);if(!names.length)return;
  const path=join(directory,'mote.sqlite');if(!existsSync(path))throw new ScopeError('unsupported_vault',409);
  const scratch=mkdtempSync(join(tmpdir(),'mote-scope-preflight-'));
  let db:DatabaseSync|undefined;
  try{
    for(const suffix of ['','-wal','-shm','-journal']){
      const source=path+suffix;if(!existsSync(source))continue;
      const before=lstatSync(source);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw Error();
      copyFileSync(source,join(scratch,'mote.sqlite'+suffix));
      const after=lstatSync(source);if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error();
    }
    db=new DatabaseSync(join(scratch,'mote.sqlite'));
    const row=db.prepare('SELECT epoch,format,deployment_id FROM scope_meta WHERE singleton=1').get();
    if(!row||row.epoch!==SCOPE_BASELINE.storageEpoch||row.format!==SCOPE_FORMAT||!validScopeId(row.deployment_id))throw Error();
    if(db.prepare('PRAGMA user_version').get()?.user_version!==SCOPE_BASELINE.storageEpoch)throw Error();
  }catch{throw new ScopeError('unsupported_vault',409);}
  finally{db?.close();rmSync(scratch,{recursive:true,force:true});}
}

export function openScopeStorage(directory:string){
  assertScopeStorage(directory);
  privateDirectory(directory);const path=join(directory,'mote.sqlite');privateSqliteFile(path,true);
  for(const suffix of ['-wal','-shm','-journal'])privateSqliteFile(path+suffix);
  const db=new DatabaseSync(path);
  try{
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS scope_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),epoch INTEGER NOT NULL,format TEXT NOT NULL,deployment_id TEXT NOT NULL);
      PRAGMA user_version=5;`);
    db.prepare('INSERT OR IGNORE INTO scope_meta VALUES(1,?,?,?)').run(SCOPE_BASELINE.storageEpoch,SCOPE_FORMAT,randomUUID());
    const deploymentId=String(db.prepare('SELECT deployment_id FROM scope_meta WHERE singleton=1').get()!.deployment_id);
    return {deploymentId,db,close:()=>db.close()};
  }catch(error){db.close();throw error;}
}
