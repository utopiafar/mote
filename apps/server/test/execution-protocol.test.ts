import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {QueryRuns} from '../src/query-runs.js';
import {InsightRuns} from '../src/insight-runs.js';

test('old query and insight rows expose the additive execution projection',()=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-execution-protocol-')),store=new Store(directory);
  try {
    const queries=new QueryRuns(store),insights=new InsightRuns(store);
    store.db.prepare('INSERT INTO query_runs VALUES (?,?,?)').run('legacy-query','legacy-hash',JSON.stringify({id:'legacy-query',status:'waiting_for_model',attempts:2,errorCode:'model_unconfigured',createdAt:'2026-09-19T00:00:00.000Z',updatedAt:'2026-09-19T00:00:00.000Z',events:[]}));
    store.db.prepare('INSERT INTO insight_runs VALUES (?,?,?)').run('legacy-insight','legacy-hash',JSON.stringify({id:'legacy-insight',status:'completed',createdAt:'2026-09-19T00:00:00.000Z',updatedAt:'2026-09-19T00:00:00.000Z',scope:{},events:[]}));
    const query=queries.get('legacy-query'),insight=insights.get('legacy-insight');
    assert.equal(query.status,'waiting_for_model');
    assert.equal(query.execution?.status,'waiting');
    assert.equal(query.execution?.waiting?.reason,'provider_unavailable');
    assert.deepEqual(query.execution?.allowedActions,['continue','cancel']);
    assert.equal(insight.status,'completed');
    assert.equal(insight.execution?.status,'succeeded');
    assert.deepEqual(insight.execution?.allowedActions,[]);
  } finally {
    store.close();rmSync(directory,{recursive:true,force:true});
  }
});

test('current execution receipts retain attempts and provider deadlines; stale running receipts cannot hide restart failure',async()=>{
 const {normalizeRun}=await import('../src/execution.js');
 const value={status:'failed',availableAt:Date.now()+5000,execution:{status:'failed',attempts:3,maxAttempts:4,allowedActions:['retry'],failure:{code:'rate_limited',scope:'provider',recovery:'auto_retry',safeMessage:'Wait for the provider.',retryAfterMs:9999}}};
 const read=normalizeRun(value);assert.equal(read.execution.attempts,3);assert.equal(read.execution.maxAttempts,4);assert.ok(read.execution.failure!.retryAfterMs!<=5000);assert.ok(read.execution.failure!.retryAfterMs!>0);
 const stale=normalizeRun({...value,status:'failed',execution:{status:'running',attempts:1,allowedActions:['cancel']}});assert.equal(stale.execution.status,'failed');
});
