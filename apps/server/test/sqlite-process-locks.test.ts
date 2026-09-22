import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {Store} from '../src/store.js';
import {privateSqliteFile} from '../src/private-storage.js';

test('private database validation and a second Store preserve the live cross-process WAL locks',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-sqlite-locks-')),store=new Store(directory);let second:Store|undefined;
 t.after(()=>{second?.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const contender=()=>spawnSync(process.execPath,['--input-type=module','-e',`
 import {DatabaseSync} from 'node:sqlite';
 const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=0');
 try{db.exec('BEGIN IMMEDIATE');process.stdout.write('acquired');db.exec('ROLLBACK');}
 catch(error){if(error.errcode!==5)throw error;process.stdout.write('locked');}finally{db.close();}
 `,join(directory,'mote.sqlite')],{encoding:'utf8',timeout:5000});
 // The second connection itself is legal; validating it must not close a raw
 // descriptor to the shared-memory inode already managed by SQLite.
 second=new Store(directory);
 store.db.exec('BEGIN IMMEDIATE');
 try{for(const suffix of ['','-wal','-shm','-journal'])privateSqliteFile(join(directory,'mote.sqlite'+suffix),suffix==='');const result=contender();assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'locked');}
 finally{store.db.exec('ROLLBACK');}
 assert.equal(contender().stdout,'acquired');assert.equal(store.db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
});
