import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import type {QueryAgent} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';

const requestCount = 200;
const latencyLimitMs = 100;
const options = {skip: process.env.MOTE_TIMING_TESTS !== '1'};

async function checkStatusLatency(t: TestContext, busy: boolean) {
  const {buildApp} = await import('../src/app.js');
  const dataDir = await mkdtemp(join(tmpdir(), 'mote-latency-guard-'));
  const token = randomUUID();
  const config: ConfigurationPlatformOptions = {
    path: join(dataDir, 'mote.yaml'),
    privateCredential: {token, tokenPath: 'fixture'},
    initialDocument: {
      version: 1,
      revision: 0,
      storage: {dataDir, maxExportBytes: 1_000_000},
      server: {host: '127.0.0.1', port: 0, allowedOrigins: []},
      execution: {insightIntervalHours: 0},
      models: {
        deployment: {model: '', apiKey: '', allowUnauthenticatedLocal: false, protocol: 'deepseek', reasoningEffort: 'high'},
        embedding: {model: '', baseUrl: '', apiKey: ''},
      },
      diagnostics: {enabled: false},
    },
  };
  const agent: QueryAgent = {
    configured: false,
    async query() { throw new Error('The latency fixture cannot call a model'); },
    async close() {},
  };

  try {
    const {app} = await buildApp(config, {agent, backgroundWorker: false});
    let scheduled: NodeJS.Immediate | undefined;
    try {
      const address = await app.listen({host: '127.0.0.1', port: 0});
      const headers = {authorization: `Bearer ${token}`};
      const input = Buffer.alloc(32 * 1024, 0x61);
      let backgroundJobs = 0;

      // Keep a small generated job queued and yield between jobs so HTTP can run.
      function runJob() {
        createHash('sha256').update(input).digest();
        backgroundJobs++;
        scheduled = setImmediate(runJob);
      }
      if (busy) scheduled = setImmediate(runJob);

      const durations: number[] = [];
      for (let index = 0; index < requestCount; index++) {
        const started = performance.now();
        const response = await fetch(address + '/api/status', {headers, signal: t.signal});
        const body = await response.text();
        durations.push(performance.now() - started);
        assert.equal(response.status, 200, body);
      }
      if (busy) assert.ok(backgroundJobs > 0, 'The background fixture must run during HTTP sampling');

      durations.sort((left, right) => left - right);
      const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
      t.diagnostic(`${durations.length} requests, ${backgroundJobs} background jobs, p95=${p95.toFixed(2)} ms`);
      assert.ok(p95 <= latencyLimitMs, `/api/status p95 ${p95.toFixed(2)} ms exceeds ${latencyLimitMs} ms`);
    } finally {
      if (scheduled) clearImmediate(scheduled);
      await app.close();
    }
  } finally {
    await rm(dataDir, {recursive: true, force: true});
  }
}

test('PF4-01: /api/status stays within 100 ms at p95 with generated background work', options, t => checkStatusLatency(t, true));
test('PF4-02: /api/status stays within 100 ms at p95 while idle', options, t => checkStatusLatency(t, false));
