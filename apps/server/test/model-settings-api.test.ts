import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSettingsView, ModelSettingsInput } from '@mote/shared/models';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { ModelAgentFactory } from '../src/model-agent.js';
import { testModelConnection } from '../src/model-agent.js';

const owner = 'synthetic-model-settings-owner-token';
const headers = { authorization: `Bearer ${owner}` };
const answer = (model: string) => ({ answer: model, citations: [], trace: [], runId: 'synthetic-run' });
const config = (dataDir: string): Config => ({ dataDir, token: owner, tokenPath: 'fixture-only', host: '127.0.0.1', port: 47832,
  maxStorageBytes: 10_000_000, maxExportBytes: 1_000_000, retentionDays: 0, insightIntervalHours: 0, allowedOrigins: [],
  model: 'original-fixture', modelBaseUrl: 'https://model.example.invalid/v1', apiKey: 'synthetic-original-key',
  modelProvider: 'custom', modelProtocol: 'openai-completions', modelReasoningEffort: 'auto', allowUnauthenticatedLocal: false,
  embeddingModel: '', embeddingBaseUrl: '', embeddingApiKey: '', diagnosticsEnabled: true });
function input(view: ModelSettingsView): ModelSettingsInput {
  const { apiKeyConfigured: _key, headersConfigured: _headers, extraBodyConfigured: _body, ...settings } = view.settings;
  return settings;
}
async function fixture(t: TestContext, factory: ModelAgentFactory) {
  const directory = await mkdtemp(join(tmpdir(), 'mote-model-settings-api-'));
  const cfg = config(directory), node = await buildApp(cfg, { createModelAgent: factory });
  t.after(async () => { await node.app.close(); await rm(directory, { recursive: true, force: true }); });
  return { ...node, cfg, directory };
}

test('owner model saves apply to new queries while an existing query retains its original runtime', async t => {
  let started!: () => void, finish!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  const closed: string[] = [];
  const { app, cfg } = await fixture(t, async settings => ({ configured: true,
    query: async args => { if (args.question === 'hold fixture') { started(); await held; } return answer(settings.model); },
    close: async () => { closed.push(settings.model); },
  }));
  const first = await app.inject({ url: '/api/model-settings', headers }), view = first.json<ModelSettingsView>();
  assert.equal(first.headers['cache-control'], 'no-store');
  const pending = app.inject({ method: 'POST', url: '/api/query', headers, payload: { question: 'hold fixture' } });
  await began;
  const saved = await app.inject({ method: 'PUT', url: '/api/model-settings', headers, payload: {
    revision: view.revision, settings: { ...input(view), model: 'next-fixture', maxTokens: 65536, timeoutMs: 300000,
      apiKey: 'synthetic-new-key', headers: { 'x-fixture-secret': 'synthetic-header-key' }, extraBody: { vendor_options: { token: 'synthetic-body-key' } } },
  } });
  assert.equal(saved.statusCode, 200, saved.body); assert.deepEqual(closed, []);
  assert.equal((await app.inject({ method: 'POST', url: '/api/query', headers, payload: { question: 'next fixture' } })).json().answer, 'next-fixture');
  const status = (await app.inject({ url: '/api/status', headers })).json();
  assert.equal(status.agent.model, 'next-fixture'); assert.equal(status.agent.protocol, 'openai-completions'); assert.equal(status.agent.maxTokens, 65536);
  const current = (await app.inject({ url: '/api/configuration', headers })).json();
  const fields = current.groups.flatMap((group: any) => group.fields);
  assert.equal(fields.find((field: any) => field.key === 'model').value, 'next-fixture');
  assert.equal(fields.find((field: any) => field.key === 'model').restartRequired, false);
  assert.equal(fields.find((field: any) => field.key === 'model').source, 'derived');
  assert.equal(cfg.model, 'original-fixture', 'Hot settings must not mutate the caller configuration snapshot');
  finish(); assert.equal((await pending).json().answer, 'original-fixture');
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(closed, ['original-fixture']);
  for (const route of ['/api/model-settings', '/api/configuration', '/api/status', '/api/support-bundle', '/api/export']) {
    const response = await app.inject({ url: route, headers }); assert.equal(response.statusCode, 200);
    for (const secret of ['synthetic-new-key', 'synthetic-header-key', 'synthetic-body-key']) assert.equal(response.body.includes(secret), false, route);
  }
});

test('model settings enforce owner authorization, optimistic revisions, explicit credential reuse and reset persistence', async t => {
  const factory: ModelAgentFactory = async settings => ({ configured: true, query: async () => answer(settings.model), close: async () => {} });
  const { app, cfg } = await fixture(t, factory);
  const invitation = await app.inject({ method: 'POST', url: '/api/connections/invitations', headers, payload: { serverUrl: 'https://synthetic.invalid', label: 'Fixture phone' } });
  const redeemed = await app.inject({ method: 'POST', url: '/api/connections/redeem', payload: { code: invitation.json().invitation.code, deviceId: 'fixture-phone', deviceName: 'Fixture phone', platform: 'android' } });
  assert.equal(redeemed.statusCode, 200);
  for (const method of ['GET', 'PUT', 'DELETE', 'POST'] as const) {
    const url = '/api/model-settings' + (method === 'POST' ? '/test' : '');
    assert.equal((await app.inject({ method, url })).statusCode, 401);
    assert.equal((await app.inject({ method, url, headers: { authorization: `Bearer ${redeemed.json().token}` } })).statusCode, 403);
  }
  let view = (await app.inject({ url: '/api/model-settings', headers })).json<ModelSettingsView>();
  const payload = { revision: view.revision, settings: { ...input(view), provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'fixture-new' } };
  let response = await app.inject({ method: 'PUT', url: '/api/model-settings', headers, payload });
  assert.equal(response.statusCode, 409); assert.equal(response.json().error, 'model_settings_credential_reuse');
  response = await app.inject({ method: 'PUT', url: '/api/model-settings', headers, payload: { ...payload, allowCredentialReuse: true } });
  assert.equal(response.statusCode, 200, response.body); view = response.json();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/model-settings', headers, payload: { ...payload, allowCredentialReuse: true } })).statusCode, 409);
  await app.close();
  const restarted = await buildApp(cfg, { createModelAgent: factory });
  t.after(() => restarted.app.close());
  assert.equal((await restarted.app.inject({ url: '/api/status', headers })).json().agent.model, 'fixture-new');
  response = await restarted.app.inject({ method: 'DELETE', url: '/api/model-settings', headers, payload: { revision: view.revision } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().source, 'environment');
  assert.equal((await restarted.app.inject({ url: '/api/status', headers })).json().agent.model, 'original-fixture');
});

test('draft probe uses only generated records and neither persists nor exposes provider errors', async t => {
  const seen: string[] = [];
  const { app } = await fixture(t, async (settings, reader) => ({ configured: true,
    query: async () => {
      const records = await reader.search({}); seen.push(...records.map(record => record.ocrText));
      assert.equal(records.length, 1); assert.equal(records[0].id, 'mote-model-connection-test');
      assert.equal((await reader.evidence({ ids: [records[0].id] })).length, 1);
      return { ...answer('fixture connection'), citations: [{ id: records[0].id, appName: records[0].appName, capturedAt: records[0].capturedAt, excerpt: records[0].ocrText }], trace: [{ tool: 'evidence', arguments: { ids: [records[0].id] }, count: 1 }] };
    }, close: async () => {},
  }));
  const note = { id: '11111111-2222-4333-8444-555555555555', deviceId: 'fixture', deviceName: 'Fixture', platform: 'import', capturedAt: '2026-01-01T00:00:00Z', text: 'Synthetic archive sentinel: must never be sent by connection test.' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/notes', headers, payload: note })).statusCode, 201);
  const view = (await app.inject({ url: '/api/model-settings', headers })).json<ModelSettingsView>();
  const response = await app.inject({ method: 'POST', url: '/api/model-settings/test', headers, payload: { revision: view.revision, settings: { ...input(view), model: 'draft-only' } } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().code, 'ok'); assert.equal(seen.length, 1);
  assert.equal(seen[0].includes('archive sentinel'), false);
  assert.deepEqual((await app.inject({ url: '/api/model-settings', headers })).json(), view);
  const bad = await app.inject({ method: 'PUT', url: '/api/model-settings', headers, payload: { revision: view.revision, settings: { ...input(view), headers: { host: 'synthetic-secret-never-echo' } } } });
  assert.equal(bad.statusCode, 400); assert.equal(bad.body.includes('synthetic-secret-never-echo'), false);
});

test('connection probe redacts thrown provider text and requires an actual evidence tool result', async () => {
  const settings = { provider: 'custom', protocol: 'openai-completions' as const, baseUrl: 'https://example.invalid/v1', model: 'synthetic', reasoningEffort: 'auto' as const, maxTokens: 8192, timeoutMs: 120000, allowUnauthenticatedLocal: false, apiKey: 'synthetic', headers: {}, extraBody: {} };
  let closed = 0;
  const failed = await testModelConnection(settings, async received => {
    assert.equal(received.timeoutMs, 30000);
    return { configured: true, query: async () => { throw new Error('synthetic-sensitive-provider-response'); }, close: async () => { closed++; } };
  });
  assert.equal(failed.code, 'provider_error'); assert.equal(JSON.stringify(failed).includes('sensitive'), false); assert.equal(closed, 1);
  const unsupported = await testModelConnection(settings, async () => ({ configured: true, query: async () => answer('fixture without tools'), close: async () => {} }));
  assert.equal(unsupported.code, 'invalid_response');
});
