import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProviderFailure} from '@mote/shared';
import {Store} from '../src/store.js';
import {QueryRuns} from '../src/query-runs.js';
import {InsightRuns} from '../src/insight-runs.js';

test('retired query and insight receipts without canonical execution steps are refused unchanged',()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-execution-protocol-')),store=new Store(directory);
 try {
  const queries=new QueryRuns(store),insights=new InsightRuns(store),at='2026-09-19T00:00:00.000Z';
  const query=JSON.stringify({id:'retired-query',status:'waiting_for_model',attempts:2,errorCode:'model_unconfigured',createdAt:at,updatedAt:at,events:[]});
  const insight=JSON.stringify({id:'retired-insight',status:'completed',createdAt:at,updatedAt:at,scope:{},events:[]});
  store.db.prepare('INSERT INTO query_runs VALUES (?,?,?)').run('retired-query','retired-hash',query);
  store.db.prepare('INSERT INTO insight_runs VALUES (?,?,?)').run('retired-insight','retired-hash',insight);
  assert.throws(()=>queries.get('retired-query'),/canonical execution step/);
  assert.throws(()=>insights.get('retired-insight'),/canonical execution step/);
  assert.throws(()=>new QueryRuns(store),/canonical execution step/);
  assert.throws(()=>new InsightRuns(store),/canonical execution step/);
  assert.equal(store.db.prepare('SELECT json FROM query_runs WHERE id=?').get('retired-query')!.json,query);
  assert.equal(store.db.prepare('SELECT json FROM insight_runs WHERE id=?').get('retired-insight')!.json,insight);
 } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});

test('current canonical execution preserves provider deadlines and overrides a stale receipt',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-execution-current-')),store=new Store(directory);
 try {
  const queries=new QueryRuns(store),id=randomUUID();
  queries.start(id,{question:'Generated provider fixture'},async()=>{throw new ProviderFailure({category:'transient',code:'rate_limited',retryAfterMs:5000});});
  await queries.close();
  store.db.prepare('UPDATE execution_steps SET attempts=3 WHERE id=?').run(`query:${id}`);
  store.db.prepare("UPDATE query_runs SET json=json_set(json,'$.status','running','$.execution.status','running','$.execution.attempts',1) WHERE id=?").run(id);
  const restored=new QueryRuns(store),read=restored.get(id);
  assert.equal(read.status,'failed');assert.equal(read.execution!.status,'failed');assert.equal(read.execution!.attempts,3);
  assert.ok(read.execution!.failure!.retryAfterMs!<=5000);assert.ok(read.execution!.failure!.retryAfterMs!>0);
  assert.ok(read.execution!.allowedActions.includes('retry'));await restored.close();
 } finally {store.close();rmSync(directory,{recursive:true,force:true});}
});
