import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {InsightRuns} from '../src/insight-runs.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {createInsightSnapshot,assertInsightSnapshot} from '../src/insight-snapshots.js';
import type {InsightSnapshot} from '@mote/shared';
const scope={after:'2025-02-01T00:00:00.000Z',before:'2025-02-01T00:01:00.000Z',timeZone:'UTC'};
const capture=(deviceId:string,at='2025-02-01T00:00:30.000Z')=>({id:randomUUID(),deviceId,deviceName:'Generated device',platform:'macos',source:'activity',appId:'fixture.app',appName:'Generated activity',capturedAt:at,durationMs:30000,privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'}});
function fixture(t:any){const directory=mkdtempSync(join(tmpdir(),'mote-insight-snapshots-')),store=new Store(directory),executor=new ExecutionEngine(store),runs=new InsightRuns(store,{executor});t.after(async()=>{await executor.close();await runs.close();store.close();rmSync(directory,{recursive:true,force:true});});return {store,runs};}

test('review coverage unions two devices, persists gaps, and versions late data without altering the old report',async t=>{
 const {store,runs}=fixture(t);await store.ingest(capture('generated-desktop'));await store.ingest(capture('generated-phone'));
 const generate=async(id:string)=>runs.perform(id,scope,async(_observe,_signal,snapshot)=>{runs.assertSnapshot(snapshot);const result={runId:randomUUID(),answer:'Generated report version '+snapshot.version,citations:[],trace:[],snapshot};store.saveInsight(result,result.runId);return result;});
 const firstId=randomUUID(),first=await generate(firstId),original=JSON.stringify(runs.detail(firstId));
 const snapshot=runs.get(firstId).snapshot!;assert.equal(snapshot.coverage.measured.observedDurationMs,30000);assert.equal(snapshot.coverage.measured.deviceDurationMs,60000);assert.equal(snapshot.coverage.measured.overlapDurationMs,30000);assert.equal(snapshot.coverage.measured.unobservedDurationMs,30000);assert.ok(snapshot.coverage.limitations.includes('observed_samples_do_not_establish_work_time'));
 await store.ingest(capture('generated-desktop','2025-02-01T00:01:00.000Z'));
 const secondId=randomUUID(),second=await generate(secondId),next=runs.get(secondId).snapshot!;
 assert.equal(next.seriesId,snapshot.seriesId);assert.equal(next.version,2);assert.equal(next.previousRunId,firstId);assert.ok(next.watermark>snapshot.watermark);assert.notEqual(next.scopeFingerprint,snapshot.scopeFingerprint);assert.equal(next.coverage.measured.observedDurationMs,60000);
 assert.notEqual(first.runId,second.runId);assert.equal(JSON.stringify(runs.detail(firstId)),original);assert.equal(store.db.prepare('SELECT count(*) n FROM insights').get()!.n,2);
});

test('scope fingerprint ignores unrelated devices and dates but rejects a late original in the selected window',async t=>{
 const {store,runs}=fixture(t);await store.ingest(capture('selected'));const selected={...scope,deviceId:'selected'};const snapshot=createInsightSnapshot(store,randomUUID(),selected);
 await store.ingest(capture('other'));await store.ingest(capture('selected','2025-02-02T00:00:30.000Z'));assert.doesNotThrow(()=>assertInsightSnapshot(store,snapshot));
 let release!:()=>void,captured!:InsightSnapshot;const id=randomUUID(),pending=runs.perform(id,selected,async(_observe,_signal,receipt)=>{captured=receipt;runs.assertSnapshot(receipt);await new Promise<void>(resolve=>release=resolve);return {runId:randomUUID(),answer:'Must not publish',citations:[],trace:[]};});
 await new Promise(resolve=>setImmediate(resolve));await store.ingest({...capture('selected'),id:randomUUID()});assert.throws(()=>assertInsightSnapshot(store,captured),{statusCode:409});release();await assert.rejects(pending,{statusCode:409});
 assert.equal(runs.get(id).error?.code,'snapshot_changed');assert.equal(runs.get(id).resultRunId,undefined);assert.equal(store.db.prepare('SELECT count(*) n FROM insights').get()!.n,0);
});
