import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Indexer } from '../src/indexer.js';

type EmbeddingRequest = { model: string; input: string };
type ProviderCall = { path: string; method: string; authorization?: string; body: EmbeddingRequest };
type ProviderReply = { status?: number; body: unknown };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(
  t: TestContext,
  respond: (call: ProviderCall, response: ServerResponse, request: IncomingMessage) => ProviderReply | Promise<ProviderReply>,
) {
  const calls: ProviderCall[] = [];
  const provider = createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk.toString();
      const call = {
        path: request.url ?? '', method: request.method ?? '', authorization: request.headers.authorization,
        body: JSON.parse(raw) as EmbeddingRequest,
      };
      calls.push(call);
      const reply = await respond(call, response, request);
      if (!response.destroyed) response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.body));
    } catch {
      if (!response.destroyed) response.writeHead(500).end('{"error":"synthetic fixture failed"}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', () => { provider.off('error', reject); resolve(); });
  });
  const directory = mkdtempSync(join(tmpdir(), 'mote-indexer-fixture-'));
  const store = new Store(directory, { embeddingEnabled: true });
  const config = {
    embeddingModel: 'generated-embedding-fixture',
    embeddingBaseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`,
    embeddingApiKey: 'synthetic-provider-token-only',
  };
  const indexer = new Indexer(store, config);
  let storeClosed = false;
  const closeStore = () => { if (!storeClosed) { store.close(); storeClosed = true; } };
  t.after(async () => {
    await indexer.close();
    closeStore();
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, indexer, config, calls, closeStore };
}

function capture(text: string, overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(), deviceId: 'generated-indexer-device', deviceName: 'Synthetic indexer fixture', platform: 'macos',
    capturedAt: '2026-09-12T01:00:00.000Z', durationMs: 15000, appId: 'dev.mote.generated', appName: 'Generated Application',
    ocrText: text, source: 'screen', privacy: { excluded: false, redacted: true, mode: 'local' }, ...overrides,
  };
}

test('local synthetic embedding provider moves pending observations to indexed and preserves original evidence', async t => {
  const { store, indexer, calls, config } = await fixture(t, () => ({ body: { data: [{ embedding: [0.25, 0.5, 0.75] }] } }));
  const event = capture('Generated OCR evidence for an indexing fixture.');
  await store.ingest(event);
  assert.equal(store.evidence([event.id])[0].indexingStatus, 'pending');
  assert.equal(indexer.configured, true);
  await indexer.tick();
  const saved = store.evidence([event.id])[0];
  assert.equal(saved.indexingStatus, 'indexed');
  assert.equal(saved.ocrText, event.ocrText);
  assert.equal(store.pending().length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/v1/embeddings');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].authorization, `Bearer ${config.embeddingApiKey}`);
  assert.deepEqual(calls[0].body, { model: config.embeddingModel, input: `Generated Application\n\n${event.ocrText}` });
  const row = store.db.prepare('SELECT embedding,embedding_model FROM captures WHERE id=?').get(event.id) as { embedding: string; embedding_model: string };
  assert.deepEqual(JSON.parse(row.embedding), [0.25, 0.5, 0.75]);
  assert.equal(row.embedding_model, config.embeddingModel);
});

test('hybrid search embeds the query and invokes both vector and lexical retrieval with the selected scope', async t => {
  // This lookup table is an explicit generated provider fixture, never a production intent classifier.
  const vectors: Record<string, number[]> = {
    'Generated Application\n\nGenerated semantic neighbor.': [1, 0],
    'Generated Application\n\nneedle': [0, 1],
    'needle': [1, 0],
  };
  const { store, indexer, calls, config } = await fixture(t, call => ({ body: { data: [{ embedding: vectors[call.body.input] }] } }));
  const semantic = capture('Generated semantic neighbor.');
  const lexical = capture('needle', { capturedAt: '2026-09-12T01:00:15.000Z' });
  await store.ingest(semantic); await store.ingest(lexical); await indexer.tick();
  const vectorCalls: Parameters<Store['vectorSearch']>[] = [];
  const lexicalCalls: Parameters<Store['search']>[] = [];
  const originalVector = store.vectorSearch.bind(store), originalSearch = store.search.bind(store);
  t.mock.method(store, 'vectorSearch', (...args: Parameters<Store['vectorSearch']>) => { vectorCalls.push(args); return originalVector(...args); });
  t.mock.method(store, 'search', (...args: Parameters<Store['search']>) => { lexicalCalls.push(args); return originalSearch(...args); });
  const scope = { query: 'needle', after: '2026-09-12T00:00:00Z', before: '2026-09-13T00:00:00Z', deviceId: semantic.deviceId, limit: 2 };
  const matches = await indexer.search(scope);
  assert.deepEqual(matches.map(record => record.id), [lexical.id, semantic.id]);
  assert.deepEqual(vectorCalls, [[[1, 0], config.embeddingModel, scope]]);
  assert.deepEqual(lexicalCalls, [[scope]]);
  assert.equal(calls.at(-1)?.body.input, 'needle');
  assert.equal(new Set(matches.map(record => record.id)).size, matches.length);
});

test('provider failure marks evidence failed; explicit retry returns it to pending and recovers without changing event identity', async t => {
  let failing = true;
  const { store, indexer, calls } = await fixture(t, () => failing
    ? { status: 503, body: { error: 'synthetic temporary outage' } }
    : { body: { data: [{ embedding: [1, 0, 0] }] } });
  const event = capture('Generated retry evidence.'); await store.ingest(event);
  await indexer.tick();
  assert.equal(store.evidence([event.id])[0].indexingStatus, 'failed');
  const failed = store.db.prepare('SELECT attempts,index_error FROM captures WHERE id=?').get(event.id) as { attempts: number; index_error: string };
  assert.equal(failed.attempts, 1); assert.match(failed.index_error, /provider_unavailable/);
  await indexer.tick(); assert.equal(calls.length, 1, 'failed rows wait for explicit retry');
  assert.deepEqual(indexer.retry(), { queued: 1 });
  assert.equal(store.evidence([event.id])[0].indexingStatus, 'pending');
  failing = false; await indexer.tick();
  assert.equal(store.evidence([event.id])[0].indexingStatus, 'indexed');
  assert.equal(store.evidence([event.id])[0].ocrText, event.ocrText);
  assert.deepEqual(calls[1].body, calls[0].body);
  assert.equal((store.db.prepare('SELECT index_error FROM captures WHERE id=?').get(event.id) as { index_error: null }).index_error, null);
});

test('malformed provider vectors fail closed instead of storing unusable embeddings', async t => {
  const { store, indexer } = await fixture(t, () => ({ body: { data: [{ embedding: [1, 'not-a-number'] }] } }));
  const event = capture('Generated malformed-vector evidence.'); await store.ingest(event); await indexer.tick();
  const row = store.db.prepare('SELECT index_status,embedding,index_error FROM captures WHERE id=?').get(event.id) as { index_status: string; embedding: null; index_error: string };
  assert.equal(row.index_status, 'failed'); assert.equal(row.embedding, null); assert.match(row.index_error, /embedding_invalid/);
});

test('oversized provider JSON is bounded even when its embedding is valid, and retry can recover',async t=>{
  let oversized=true;
  const {store,indexer,calls}=await fixture(t,()=>({body:{data:[{embedding:[1,0]}],...(oversized?{padding:'x'.repeat(2*1024*1024)}:{})}}));
  const event=capture('Generated bounded-provider-response test');await store.ingest(event);await indexer.tick();
  assert.equal(store.evidence([event.id])[0].indexingStatus,'failed');assert.equal(calls.length,1);
  const row=store.db.prepare('SELECT embedding,index_error FROM captures WHERE id=?').get(event.id) as {embedding:null;index_error:string};
  assert.equal(row.embedding,null);assert.match(row.index_error,/embedding_invalid/);
  oversized=false;indexer.retry();await indexer.tick();assert.equal(store.evidence([event.id])[0].indexingStatus,'indexed');
});

test('close aborts an in-flight embedding, waits for the worker, and allows the database to close without later writes', { timeout: 5000 }, async t => {
  const started = deferred(), release = deferred(), disconnected = deferred();
  const { store, indexer, calls, closeStore } = await fixture(t, async (_call, response) => {
    response.once('close', () => disconnected.resolve());
    started.resolve(); await release.promise;
    return { body: { data: [{ embedding: [1, 0] }] } };
  });
  t.after(() => release.resolve());
  const event = capture('Generated slow-provider evidence.'); await store.ingest(event);
  const writes: string[] = [];
  const originalIndexed = store.indexed.bind(store), originalFailed = store.indexFailed.bind(store);
  t.mock.method(store, 'indexed', (...args: Parameters<Store['indexed']>) => { writes.push('indexed'); return originalIndexed(...args); });
  t.mock.method(store, 'indexFailed', (...args: Parameters<Store['indexFailed']>) => { writes.push('failed'); return originalFailed(...args); });
  const running = indexer.tick();
  assert.equal(indexer.tick(), running, 'concurrent timer ticks share the tracked worker');
  await started.promise;
  await indexer.close();
  await running;
  assert.equal(store.evidence([event.id])[0].indexingStatus, 'pending', 'shutdown does not turn an interrupted job into permanent failure');
  assert.deepEqual(writes, []);
  closeStore();
  release.resolve(); await disconnected.promise;
  await indexer.tick();
  assert.equal(calls.length, 1, 'a closed indexer never starts another provider request');
  assert.deepEqual(writes, [], 'no completion writes occur after closing the database');
});

test('an unconfigured indexer keeps lexical queries available without contacting the provider', async t => {
  const { store, config, calls } = await fixture(t, () => ({ body: { data: [{ embedding: [1] }] } }));
  const event = capture('Generated offline lexical evidence.'); await store.ingest(event);
  const indexer = new Indexer(store, { ...config, embeddingModel: '' });
  t.after(() => indexer.close());
  assert.equal(indexer.configured, false); await indexer.tick();
  const found = await indexer.search({ query: 'offline' });
  assert.deepEqual(found.map(record => record.id), [event.id]); assert.equal(calls.length, 0);
});

test('embedding outage returns scoped lexical evidence and explicit degradation',async t=>{
 const {store,indexer}=await fixture(t,()=>({status:503,body:{error:'generated outage'}}));
 const item=capture('Offline fallback needle');await store.ingest(item);
 const found=await indexer.search({query:'needle',deviceId:item.deviceId});
 assert.equal(found[0].id,item.id);assert.equal(found.retrieval.degraded,true);assert.equal(found.retrieval.reason,'embedding_unavailable');
 const empty=await indexer.search({query:'absent-generated-term'});assert.equal(empty.length,0);assert.equal(empty.retrieval.degraded,true);
});

test('rank fusion admits ordinary records alongside abundant file matches',async t=>{
 const {store,config}=await fixture(t,()=>({body:{data:[{embedding:[1,0]}]}}));
 const note=capture('fusion needle',{id:'11111111-1111-4111-8111-111111111111'});await store.ingest(note);
 const fileRecords=Array.from({length:20},(_,i)=>({...store.evidence([note.id])[0],id:`file-${i}`}));
 const indexer=new Indexer(store,{...config,embeddingModel:''},undefined,{search:()=>fileRecords} as any);t.after(()=>indexer.close());
 const result=await indexer.search({query:'needle',limit:3});
 assert.ok(result.some(r=>r.id===note.id));assert.ok(result.some(r=>r.id.startsWith('file-')));assert.equal(new Set(result.map(r=>r.id)).size,3);
});
