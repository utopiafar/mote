import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const directory=mkdtempSync(join(tmpdir(),'mote-execution-compat-'));
try {
  const database=new DatabaseSync(join(directory,'mote.sqlite'));
  database.exec('CREATE TABLE memory_jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE query_runs(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
  database.prepare('INSERT INTO memory_jobs VALUES (?,?)').run('job-1',JSON.stringify({status:'waiting_for_model',attempts:2,errorCode:'model_unconfigured'}));
  database.prepare('INSERT INTO query_runs VALUES (?,?)').run('run-1',JSON.stringify({status:'interrupted'}));
  database.close();

  const run=(...args)=>execFileSync('node',['scripts/migrate-execution-state.mjs','--data-dir',directory,...args],{encoding:'utf8'});
  assert.match(run('--dry-run'),/"changed":2/);
  assert.match(run(),/"changed":2/);
  assert.match(run('--dry-run'),/"changed":0/);
  assert.ok(readdirSync(directory).some(name=>name.includes('execution-compat')));

  const migrated=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});
  const job=JSON.parse(migrated.prepare('SELECT json FROM memory_jobs').get().json);
  const query=JSON.parse(migrated.prepare('SELECT json FROM query_runs').get().json);
  assert.equal(job.execution.status,'waiting');
  assert.equal(job.execution.waiting.reason,'provider_unavailable');
  assert.equal(query.execution.status,'queued');
  migrated.close();
  console.log('execution compatibility fixture passed');
} finally {
  rmSync(directory,{recursive:true,force:true});
}
