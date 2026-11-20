import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../src/app.js';
import {createBlockingMonitor} from '../src/blocking-monitor.js';
import {ServerDiagnostics} from '../src/diagnostics.js';

function busyFor(durationMs: number) {
  const end = performance.now() + durationMs;
  while (performance.now() < end) {
    // Simulate synchronous work without IO or a model.
  }
}

test('PF0-01 persists one blocking event for 80 ms of synchronous work, with its job label', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-blocking-monitor-'));
  const diagnostics = new ServerDiagnostics({directory});
  t.after(async () => {
    try { await diagnostics.close(); } finally { await rm(directory, {recursive: true, force: true}); }
  });
  await diagnostics.init();

  const monitor = createBlockingMonitor(sample => diagnostics.record('event-loop.blocked', sample, 'warn'));
  try {
    monitor.run('assistant-changes', () => busyFor(80));
    await delay(25);
  } finally {
    monitor.close();
  }
  await diagnostics.flush();

  const files = (await readdir(directory)).filter(name => name.startsWith('central.warn.'));
  assert.equal(files.length, 1);
  const [entry, ...otherEntries] = (await readFile(join(directory, files[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(otherEntries, []);
  assert.equal(entry.event, 'event-loop.blocked');
  assert.equal(entry.stage, 'system');
  assert.ok(entry.durationMs > 50);
  assert.deepEqual(entry.jobLabels, ['assistant-changes']);
});

test('PF0-02 records no block for 30 ms of synchronous work', async () => {
  const samples: unknown[] = [];
  const monitor = createBlockingMonitor(sample => samples.push(sample));
  try {
    monitor.run('assistant-changes', () => busyFor(30));
    await delay(25);
    assert.deepEqual(samples, []);
  } finally {
    monitor.close();
  }
});

test('uses a strict threshold, tracks overlapping runs through failure, and stops on close', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({apis: ['setInterval']});
  const samples: string[][] = [];
  const monitor = createBlockingMonitor(sample => samples.push(sample.jobLabels));
  t.after(monitor.close);
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  assert.equal(monitor.run('source-pipelines', () => first.promise), first.promise);
  assert.equal(monitor.run('source-pipelines', () => second.promise), second.promise);
  first.resolve();
  await first.promise;

  now = 70;
  t.mock.timers.tick(20);
  assert.deepEqual(samples, []);
  now = 150;
  t.mock.timers.tick(20);
  assert.deepEqual(samples, [['source-pipelines']]);

  const failure = new Error('Generated job failure');
  assert.throws(() => monitor.run('processing', () => { throw failure; }), failure);
  second.reject(failure);
  await assert.rejects(second.promise, failure);
  now = 230;
  t.mock.timers.tick(20);
  assert.deepEqual(samples, [['source-pipelines'], []]);

  monitor.close();
  now = 310;
  t.mock.timers.tick(20);
  assert.deepEqual(samples, [['source-pipelines'], []]);
});

test('PF0-04 logs Fastify route templates for matched requests and keeps generated URL and credential data out', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-blocking-routes-'));
  const token = 'generated-blocking-monitor-token';
  const queryValue = 'generated-private-query';
  const rawId = randomUUID();
  const {app, diagnostics} = await buildApp({
    path: join(directory, 'mote.yaml'),
    privateCredential: {token, tokenPath: join(directory, 'fixture-token')},
    initialDocument: {
      version: 1,
      revision: 0,
      storage: {dataDir: directory, maxExportBytes: 1_000_000},
      server: {host: '127.0.0.1', port: 0, allowedOrigins: []},
      execution: {insightIntervalHours: 0},
      models: {
        deployment: {model: '', apiKey: '', allowUnauthenticatedLocal: false, protocol: 'deepseek', reasoningEffort: 'high'},
        embedding: {model: '', baseUrl: '', apiKey: ''},
      },
      diagnostics: {enabled: true, level: 'info'},
    },
  }, {
    backgroundWorker: false,
    agent: {configured: false, query: async () => { throw new Error('Unexpected model call'); }, close: async () => {}},
  });
  t.after(async () => {
    try { await app.close(); } finally { await rm(directory, {recursive: true, force: true}); }
  });

  const headers = {authorization: 'Bearer ' + token};
  const query = new URLSearchParams({scope: JSON.stringify({kind: 'all'})});
  const list = await app.inject({url: '/api/assistant-cards?' + query, headers});
  const detail = await app.inject({url: `/api/assistant-cards/${rawId}?${query}`, headers});
  const missing = await app.inject({url: `/api/${queryValue}?generated=${rawId}`, headers});
  assert.equal(list.statusCode, 200);
  assert.equal(detail.statusCode, 404);
  assert.equal(missing.statusCode, 404);
  await diagnostics.flush();

  const events = diagnostics.recent();
  const templates = [list, detail, missing].map(response => {
    const event = events.find(event => event.event === 'request.completed' && event.requestId === response.headers['x-request-id']);
    assert.ok(event);
    assert.ok(typeof event.durationMs === 'number' && event.durationMs >= 0);
    return event.routeTemplate;
  });
  assert.deepEqual(templates, ['/api/assistant-cards', '/api/assistant-cards/:id', undefined]);
  for (const privateValue of [rawId, token, queryValue]) assert.ok(!JSON.stringify(events).includes(privateValue));
});
