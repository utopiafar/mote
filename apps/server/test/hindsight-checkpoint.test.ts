import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryResult} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPublication} from '../src/plugins/memory-publication.js';
import {MemoryPhaseOutputs} from '../src/memory-phase-outputs.js';
import {MemoryAutomation} from '../src/memory-automation.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {EXECUTION_POLICIES} from '../src/execution-policy.js';
import {reviewMemory} from '../src/memory-review.js';
import type {MemoryBindings} from '../src/memory-bindings.js';
import {type MemoryEngineDraftPin} from '../src/memory-native-stage-contract.js';
import {fixtureMemoryPipeline, fixtureMemoryResult} from './fixtures/memory-result.js';
import {memoryBodyDigest, type MemoryProvider, type MemoryProviderWrite} from '../src/memory-provider-contract.js';

// Generated semantic transport and provider only. This exercises real host
// Store/ExecutionEngine/MemoryPipeline/MemoryPublication ordering, not native
// Hindsight quality, Docker, network, or an actual model.
async function fixture(t: TestContext, sharedEngine=false) {
  const directory = mkdtempSync(join(tmpdir(), 'mote-native-checkpoint-'));
  const providerPath = join(directory, 'generated-provider.json');
  writeFileSync(providerPath, '{}', {mode: 0o600});
  const namespace = {ownerId: 'generated-owner', instanceId: 'generated-engine', bindingRevision: 1};
  const providerPin = {instanceId: namespace.instanceId, configurationIdentity: 'generated-fixed-configuration', namespace};
  const control = {failCleanup: true, failPublication: false, failReview: false, holdNative: false, holdCleanup: false};
  let nativeCalls = 0, reviewCalls = 0, modelCalls = 0;
  const cleanupPins: MemoryEngineDraftPin[] = [];
  let entered!: () => void, release!: () => void, nativeSignal:AbortSignal|undefined, cleanupEntered!:()=>void, releaseCleanup!:()=>void;
  const started = new Promise<void>(resolve => {entered = resolve;});
  const cleanupStarted=new Promise<void>(resolve=>cleanupEntered=resolve),heldCleanup=new Promise<void>(resolve=>releaseCleanup=resolve);
  let store!: Store, memories!: MemoryStore, publication!: MemoryPublication;
  let pipeline!: ReturnType<typeof fixtureMemoryPipeline>;
  let originalId = '';
  const binding = {revision: 1, generation: 1, namespace, activePlan: {id: 'generated-engine', mode: 'engine'}};
  const provider = {
    async put(input: MemoryProviderWrite) {
      if (control.failPublication) throw new Error('Generated canonical transport failure');
      const records = JSON.parse(readFileSync(providerPath, 'utf8'));
      records[JSON.stringify(input.key)] = input.memory;
      writeFileSync(providerPath, JSON.stringify(records), {mode: 0o600});
      return {opId: input.opId, namespace, key: input.key, payloadDigest: memoryBodyDigest(input.memory), state: 'applied', eraseVerified: false, recordedAt: new Date().toISOString()};
    },
    async read(input: {key: unknown}) {return JSON.parse(readFileSync(providerPath, 'utf8'))[JSON.stringify(input.key)] ?? null;},
  } as MemoryProvider;
  // A fixed generated binding facade replaces plugin discovery only. Publication,
  // receipts, reviewed output persistence and fenced host commits are real.
  const bindings = {binding: () => structuredClone(binding), provider: () => provider, plugins: {references: () => []}, assertNewManualWork: () => {}} as unknown as MemoryBindings;
  function open() {
    store = new Store(join(directory, 'vault')); memories = new MemoryStore(store);
    // The facade bypasses MemoryBindings construction, so install its durable
    // control schema too. Publication retirement and revocation reconciliation
    // read the binding/receipt tables even when the semantic transport is fake.
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_plan_binding(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_provider_receipts(id TEXT PRIMARY KEY,json TEXT NOT NULL);`);
    store.db.prepare('INSERT OR IGNORE INTO memory_plan_binding VALUES(1,?)').run(JSON.stringify(binding));
    publication = new MemoryPublication(store, memories, bindings);
    pipeline = fixtureMemoryPipeline({store, memories, publication,executor:sharedEngine?new ExecutionEngine(store):undefined,
      nativeStages:{prepare: async (_input, context) => {
        nativeSignal=_input.signal;
        context.provider = structuredClone(providerPin);
        nativeCalls++;
        if (control.holdNative) {entered(); await new Promise<void>(resolve => {release = resolve;});}
        context.assertAuthority?.();
        // Native proposals are intentionally not admitted or quoted by the host
        // contract. Only independent review supplies canonical exact evidence.
        return {answer: JSON.stringify({memories: [{title: 'Generated native proposal', statement: 'Unreviewed native proposal', evidenceIds: [originalId]}]}), citations: [], trace: [], runId: context.opId};
      },
      settle: async pin => {
        cleanupPins.push(structuredClone(pin));
        if(control.holdCleanup){cleanupEntered();await heldCleanup;}
        if (control.failCleanup) throw new Error('Generated transient native cleanup failure');
      }},models:{ model: () => 'generated-model', configured: () => true},phases:{
      query: async () => {modelCalls++; throw new Error('Built-in generation must not run for a native draft');},
      review: async (input, draft, _strategy, origin) => {
        assert.equal(origin, 'native-engine', 'host keeps native origin through the fixture wrapper and cached retry');
        return reviewMemory(input, draft, async reviewInput => {
        assert.equal(reviewInput.traceContext?.phase, 'review');
        reviewCalls++; assert.match(draft.answer, /Unreviewed native proposal/);
        if (control.failReview) throw new Error('Generated independent review failure');
        const evidence = memories.readEvidence([originalId])[0];
        const reviewed: QueryResult = {answer: JSON.stringify({memories: [{title: 'Generated reviewed memory', statement: `The generated owner uses a silver telescope [${originalId}]`, uncertainty: 'Generated fixture only', evidenceIds: [originalId]}]}), citations: [{id: originalId, capturedAt: evidence.capturedAt, appName: evidence.appName, excerpt: evidence.ocrText}], trace: [], runId: randomUUID()};
        return fixtureMemoryResult(memories, reviewed);
        }, {draftOrigin: origin});
      }}});
  }
  open();
  const sources = new SourceStore(store);
  sources.register({id: 'generated', name: 'Generated originals', kind: 'custom', deviceId: 'generated-device', platform: 'import'});
  originalId = (await sources.upsert('generated', {externalId: 'one', revision: '1', observedAt: '2026-10-01T00:00:00Z', kind: 'message', layer: 'original', text: 'I use a silver telescope on the generated east terrace.'})).id;
  t.after(async () => {release?.();releaseCleanup(); await pipeline.close();if(sharedEngine)await pipeline.engine.close(); await publication.close(); store.close(); rmSync(directory, {recursive: true, force: true});});
  return {control, started,cleanupStarted,releaseCleanup,get nativeSignal(){return nativeSignal;}, release: () => release(), namespace, providerPin, cleanupPins,
    get pipeline() {return pipeline;}, get publication() {return publication;}, get store() {return store;}, get memories() {return memories;},
    calls: () => ({nativeCalls, reviewCalls, modelCalls}),
    create: () => pipeline.create({evidenceIds: [originalId]}),
    phaseCheckpoints(batchId:string) {const outputs=new MemoryPhaseOutputs(store,pipeline.engine);return store.db.prepare('SELECT step_id,phase,input_hash,output_hash FROM memory_phase_outputs WHERE batch_id=? ORDER BY phase').all(batchId).map(row=>({...row,state:pipeline.engine.get(String(row.step_id))!.state,output:outputs.read<any>(String(row.step_id),String(row.input_hash))}));},
    async restart() {await pipeline.close();if(sharedEngine)await pipeline.engine.close(); await publication.close(); store.close(); open();},
    async finishCleanup() {
      const deadline = Date.now() + 7000;
      while (store.db.prepare("SELECT 1 FROM memory_engine_stage_cleanups WHERE state='pending'").get() && Date.now() < deadline) {
        for (const row of store.db.prepare("SELECT id FROM execution_steps WHERE kind='memory.engine-stage-cleanup' AND state IN ('waiting','failed','blocked','cancelled','stale')").all()) {
          try {pipeline.engine.retry(String(row.id));} catch (error) {assert.equal((error as {statusCode?: number}).statusCode, 409, 'only a still-settling active cleanup may defer retry');}
        }
        await pipeline.engine.tick(); await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(store.db.prepare("SELECT count(*) n FROM memory_engine_stage_cleanups WHERE state='pending'").get()!.n, 0);

    },
  };
}

test('reviewed native checkpoint survives publication failure and restart; cleanup retries exact pin without regeneration', async t => {
  const f = await fixture(t); f.control.failPublication = true;
  const job = f.create(), failed = await f.pipeline.run(job.id);
  assert.equal(failed.status, 'failed'); assert.deepEqual(f.calls(), {nativeCalls: 1, reviewCalls: 1, modelCalls: 0});
  const retained=f.phaseCheckpoints(job.batches[0].id);
  assert.deepEqual(retained.map(row=>[row.phase,row.state]),[['extract','succeeded'],['review','succeeded']],'both complete private phase outputs precede canonical publication');
  assert.equal(retained[0].output.draftOrigin,'native-engine');assert.deepEqual(retained[0].output.nativeDraft.context.provider,f.providerPin);
  assert.deepEqual(retained[0].output.engineDrafts[0].provider,f.providerPin);
  assert.match(retained[1].output.result.answer,/Generated reviewed memory/);assert.ok(retained[1].output.result.runId);
  assert.equal(retained[1].output.reviewReceipt.decision,'independent');assert.equal(retained[1].output.reviewReceipt.reviewRunId,retained[1].output.result.runId);
  assert.equal(f.memories.list().length, 0, 'failed canonical transport cannot publish a control record');
  assert.ok(f.store.db.prepare("SELECT 1 FROM memory_engine_stage_cleanups WHERE state='pending'").get());
  const persisted = f.store.db.prepare('SELECT json FROM memory_engine_stage_cleanups').all().map(row => JSON.parse(String(row.json)));
  assert.ok(persisted.length); for (const pin of persisted) {assert.deepEqual(pin.provider, f.providerPin); assert.equal('assertAuthority' in pin, false);}
  await f.restart();assert.deepEqual(f.phaseCheckpoints(job.batches[0].id),retained,'restart preserves exact private results, receipts and hashes'); f.control.failCleanup = false; f.control.failPublication = false;
  await f.finishCleanup();
  const completed = await f.pipeline.retry(job.id); assert.equal(completed.status, 'completed');
  assert.equal(f.memories.list().length, 1); assert.deepEqual(f.calls(), {nativeCalls: 1, reviewCalls: 1, modelCalls: 0});
  assert.ok(f.cleanupPins.every(pin => pin.provider?.configurationIdentity === 'generated-fixed-configuration'));
  assert.equal(f.store.db.prepare("SELECT state FROM memory_publications WHERE id=?").get(job.batches[0].id)?.state, 'committed');
});

test('pending native cleanup permits reviewed canonical publication but retains migration and uninstall references', async t => {
  const f = await fixture(t), job = f.create();
  const completed = await f.pipeline.run(job.id); assert.equal(completed.status, 'completed');
  const body = JSON.stringify(f.memories.get(completed.memoryIds[0]));
  assert.ok(f.publication.pending() > 0, 'cutover tail includes unconfirmed native staging cleanup');
  assert.ok(f.publication.bindings.plugins.references(f.namespace.instanceId).some(reason => reason.includes('Unresolved')));
  assert.deepEqual(f.calls(), {nativeCalls: 1, reviewCalls: 1, modelCalls: 0});
  await f.restart(); f.control.failCleanup = false; await f.finishCleanup();
  assert.equal(JSON.stringify(f.memories.get(completed.memoryIds[0])), body);
  assert.equal(f.publication.pending(), 0);
  assert.deepEqual(f.calls(), {nativeCalls: 1, reviewCalls: 1, modelCalls: 0});
});

test('review retry from a cached native proposal skips built-in pre-review admission and does not prepare twice', async t => {
  const f = await fixture(t); f.control.failReview = true;
  const job = f.create(); assert.equal((await f.pipeline.run(job.id)).status, 'failed');
  assert.deepEqual(f.calls(), {nativeCalls: 1, reviewCalls: 1, modelCalls: 0});
  await f.restart(); f.control.failReview = false; f.control.failCleanup = false;
  const completed = await f.pipeline.retry(job.id); assert.equal(completed.status, 'completed');
  assert.deepEqual(f.calls(), {nativeCalls: 1, reviewCalls: 2, modelCalls: 0});
  assert.equal(f.memories.list().length, 1); await f.finishCleanup();
});

test('native queued work checks its current host grant after cancellation and retains exact cleanup authority', async t => {
  const f = await fixture(t); f.control.holdNative = true;
  const job = f.create(), run = f.pipeline.run(job.id);
  await f.started;
  const pin = f.store.db.prepare('SELECT json FROM memory_engine_stage_drafts').get(); assert.ok(pin, 'provider authority is durably pinned before awaiting native transport');
  f.pipeline.cancel(job.id); f.release(); await run;
  assert.equal(f.pipeline.get(job.id).status, 'cancelled'); assert.deepEqual(f.calls(), {nativeCalls: 1, reviewCalls: 0, modelCalls: 0});
  assert.equal(f.memories.list().length, 0);
  await f.restart(); f.control.failCleanup = false; await f.finishCleanup();
  assert.ok(f.cleanupPins.length); assert.ok(f.cleanupPins.every(cleanup => cleanup.provider?.instanceId === f.namespace.instanceId));
  assert.deepEqual(f.calls(), {nativeCalls: 1, reviewCalls: 0, modelCalls: 0});
});

for (const state of ['failed', 'stale', 'cancelled', 'blocked']) test(`restart replays ${state} native cleanup without regenerating an approved canonical result`, async t => {
  const f = await fixture(t), job = f.create();
  const completed = await f.pipeline.run(job.id); assert.equal(completed.status, 'completed');
  const canonical = JSON.stringify(f.memories.get(completed.memoryIds[0]));
  const rows = f.store.db.prepare("SELECT id FROM execution_steps WHERE kind='memory.engine-stage-cleanup'").all(); assert.ok(rows.length);
  await f.pipeline.engine.drain(rows.map(row => String(row.id)));
  for (const row of rows) {
    assert.equal(f.pipeline.engine.isActiveStep(String(row.id)), false);
    // Persist the historical terminal transport state, including an exhausted
    // retry window. Restart must admit cleanup alone, never semantic generation.
    f.store.db.prepare('UPDATE execution_steps SET state=?,error=?,recovery_deadline=?,available_at=?,fence=NULL WHERE id=?').run(state, 'generated_cleanup_failure', Date.now() - 1000, Date.now() + 60000, row.id);
  }
  f.control.failCleanup = false; await f.restart();
  const deadline = Date.now() + 2000;
  while (f.store.db.prepare("SELECT 1 FROM memory_engine_stage_cleanups WHERE state='pending'").get() && Date.now() < deadline) {
    await f.pipeline.engine.tick(); await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM memory_engine_stage_cleanups WHERE state='pending'").get()!.n, 0);
  assert.equal(JSON.stringify(f.memories.get(completed.memoryIds[0])), canonical);
  assert.deepEqual(f.calls(), {nativeCalls: 1, reviewCalls: 1, modelCalls: 0});
});


test('native stop cleanup wakes only after commit and a tail SQL failure leaves its stage pinned', async t => {
  const f = await fixture(t); f.control.holdNative = true;
  const job = f.create(), run = f.pipeline.run(job.id); await f.started;
  const control = new MemoryAutomation(f.store), engine = f.pipeline.engine, db = f.store.db;
  control.onStop = () => engine.deferLocalEffects(() => {f.pipeline.cancel(job.id, {cause: 'authority'});});
  const command = {operationId: randomUUID(), expectedRevision: control.state().revision};
  const before = db.prepare('SELECT * FROM memory_engine_stage_drafts').all(); assert.equal(before.length, 1);
  let wakes = 0; const tick = engine.tick.bind(engine);
  engine.tick = () => {wakes++; return tick();};
  db.exec("CREATE TEMP TRIGGER generated_native_stop_tail BEFORE INSERT ON memory_control_commands BEGIN SELECT RAISE(ABORT,'Generated native stop tail failure'); END");
  assert.throws(() => control.command('stop', command), /Generated native stop tail failure/);
  assert.equal(wakes, 0, 'native stage cancellation cannot wake executor recovery inside the rollback transaction');
  assert.deepEqual(db.prepare('SELECT * FROM memory_engine_stage_drafts').all(), before);
  assert.equal(db.prepare('SELECT count(*) n FROM memory_engine_stage_cleanups').get()!.n, 0);
  assert.equal(f.pipeline.get(job.id).status, 'running'); assert.equal(f.cleanupPins.length, 0);
  db.exec('DROP TRIGGER generated_native_stop_tail'); f.control.failCleanup = false;
  control.command('stop', command); assert.ok(wakes > 0); assert.equal(f.pipeline.get(job.id).status, 'cancelled');
  f.release(); await run; await f.finishCleanup();
  assert.ok(f.cleanupPins.length); assert.equal(f.memories.list().length, 0);
  assert.deepEqual(f.calls(), {nativeCalls: 1, reviewCalls: 0, modelCalls: 0});
});


for(const boundary of ['prepare','settle'] as const)test(`closing Memory waits for actual native ${boundary} exit while unrelated shared execution continues`,async t=>{
  const f=await fixture(t,true);f.control.failCleanup=false;
  if(boundary==='prepare')f.control.holdNative=true;else f.control.holdCleanup=true;
  const job=f.create(),run=f.pipeline.run(job.id);
  await (boundary==='prepare'?f.started:f.cleanupStarted);
  let closed=false;
  const closing=f.pipeline.close();assert.equal(f.pipeline.close(),closing,'repeated close shares completion');
  void closing.then(()=>closed=true);
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(closed,false,'logical cancellation cannot retire a still-running provider operation');
  assert.equal(f.pipeline.engine.closed,false);assert.equal(f.nativeSignal!.aborted,true);
  await assert.rejects(f.pipeline.nativeStages.prepare({question:'Generated post-close preparation'},{phase:'extract',opId:'generated-after-close',evidenceIds:[]}),error=>error instanceof Error&&(error as {statusCode?:number}).statusCode===503);
  const engine=f.pipeline.engine;
  engine.register({kind:'generated-independent',pool:'generated-independent',concurrency:()=>1,policy:EXECUTION_POLICIES.control,validate:()=>true,execute:async()=>null,commit:()=>{}});
  const independent=engine.enqueue('generated-independent','generated-independent',{});await engine.drain([independent]);
  assert.equal(engine.get(independent)!.state,'succeeded');assert.equal(closed,false);
  if(boundary==='prepare')f.release();else f.releaseCleanup();
  await closing;await run;assert.equal(closed,true);assert.equal(f.memories.list().length,0);
  assert.deepEqual(f.calls(),{nativeCalls:1,reviewCalls:boundary==='prepare'?0:1,modelCalls:0});
  if(boundary==='prepare')assert.ok(f.store.db.prepare("SELECT 1 FROM memory_engine_stage_cleanups WHERE state='pending'").get(),'unconfirmed cleanup remains durable for the next runtime');
});

test('native stage retirement waits for the actual queued cleanup after its executor task is interrupted',async t=>{
  const f=await fixture(t,true),job=f.create(),completed=await f.pipeline.run(job.id);
  assert.equal(completed.status,'completed');const body=JSON.stringify(f.memories.get(completed.memoryIds[0]));
  const engine=f.pipeline.engine,ids=f.store.db.prepare("SELECT id FROM execution_steps WHERE kind='memory.engine-stage-cleanup'").all().map(row=>String(row.id));
  assert.ok(ids.length);await engine.drain(ids);
  f.control.failCleanup=false;f.control.holdCleanup=true;
  for(const id of ids)engine.retry(id);
  const cleanup=engine.drain(ids);await f.cleanupStarted;
  let closed=false;const closing=f.pipeline.close();void closing.then(()=>closed=true);
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(closed,false,'handler unregister has interrupted the logical task, but its adapter is still running');
  for(let turn=0;turn<100&&ids.some(id=>engine.isActiveStep(id));turn++)await new Promise<void>(resolve=>setImmediate(resolve));
  assert.ok(ids.every(id=>!engine.isActiveStep(id)));
  engine.register({kind:'generated-independent-cleanup',pool:'generated-independent-cleanup',concurrency:()=>1,policy:EXECUTION_POLICIES.control,validate:()=>true,execute:async()=>null,commit:()=>{}});
  const independent=engine.enqueue('generated-independent-cleanup','generated-independent-cleanup',{});await engine.drain([independent]);assert.equal(engine.get(independent)!.state,'succeeded');
  f.releaseCleanup();await cleanup;await closing;assert.equal(closed,true);
  assert.equal(JSON.stringify(f.memories.get(completed.memoryIds[0])),body);
  assert.deepEqual(f.calls(),{nativeCalls:1,reviewCalls:1,modelCalls:0});
  assert.ok(f.store.db.prepare("SELECT 1 FROM memory_engine_stage_cleanups WHERE state='pending'").get(),'an interrupted acknowledgement retains the exact cleanup intent');
});
