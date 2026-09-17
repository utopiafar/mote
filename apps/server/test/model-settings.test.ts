import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSettings, ModelSettingsInput } from '@mote/shared/models';
import { ModelSettingsError, ModelSettingsStore, type ModelSettingsStoreOptions } from '../src/model-settings.js';

const environment: ModelSettings = {
  provider: 'custom', protocol: 'openai-completions', baseUrl: 'https://fixture.example.invalid/v1',
  model: 'synthetic-tool-model', reasoningEffort: 'auto', maxTokens: 8192, modelRequestTimeoutMs: 120_000, agentTimeoutMs: 120_000,
  allowUnauthenticatedLocal: false, apiKey: 'synthetic-private-api-key',
  headers: { 'X-Synthetic-Authorization': 'synthetic-private-header' },
  extraBody: { vendor_options: { credential: 'synthetic-private-parameter' } },
};
function input(settings: ModelSettings = environment): ModelSettingsInput {
  const { apiKey: _key, headers: _headers, extraBody: _extra, ...parameters } = settings;
  return structuredClone(parameters);
}
const errorCode = (code: ModelSettingsError['code']) => (error: unknown) => {
  assert.ok(error instanceof ModelSettingsError); assert.equal(error.code, code);
  assert.ok(!error.message.includes('synthetic-private')); return true;
};
async function fixture(t: TestContext, overrides: Partial<ModelSettingsStoreOptions> = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'mote-model-settings-fixture-'));
  const prepared: ModelSettings[] = [], activated: ModelSettings[] = [], disposed: ModelSettings[] = [];
  const probes: ModelSettings[] = [];
  const options: ModelSettingsStoreOptions = {
    directory, environment,
    prepare: async settings => {
      prepared.push(settings);
      return { activate: () => { activated.push(settings); }, dispose: async () => { disposed.push(settings); } };
    },
    probe: async settings => { probes.push(settings); return { ok: true, code: 'ok', message: 'synthetic-private-provider-message', durationMs: 12.5 }; },
    ...overrides,
  };
  const store = new ModelSettingsStore(options);
  t.after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, path: join(directory, 'model-settings.json'), store, options, prepared, activated, disposed, probes };
}

test('environment view hides all secrets and returns detached snapshots without persisting defaults', async t => {
  const f = await fixture(t), view = await f.store.initialize();
  assert.equal(view.source, 'environment'); assert.equal(view.revision, 0); assert.equal(view.version, 1);
  assert.equal(view.settings.apiKeyConfigured, true); assert.equal(view.settings.headersConfigured, true); assert.equal(view.settings.extraBodyConfigured, true);
  const serialized = JSON.stringify(view);
  for (const secret of ['synthetic-private-api-key', 'synthetic-private-header', 'synthetic-private-parameter', 'vendor_options', 'X-Synthetic-Authorization']) assert.ok(!serialized.includes(secret));
  for (const field of ['apiKey', 'headers', 'extraBody']) assert.ok(!Object.hasOwn(view.settings, field));
  view.settings.model = 'changed-copy';
  const current = f.store.current(); current.headers['X-Synthetic-Authorization'] = 'changed-copy';
  (current.extraBody.vendor_options as Record<string, unknown>).credential = 'changed-copy';
  assert.deepEqual(f.store.current(), environment);
  assert.equal((await f.store.initialize()).settings.model, environment.model); assert.equal(f.activated.length, 1);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('blank custom or Azure startup configuration is allowed, but a selected model requires a base URL', async t => {
  for (const provider of ['custom', 'azure-openai']) {
    const f = await fixture(t, { environment: { ...environment, provider, baseUrl: '', model: '', apiKey: '', headers: {}, extraBody: {} } });
    const view = await f.store.initialize();
    assert.equal(view.settings.baseUrl, ''); assert.equal(view.settings.model, '');
    await assert.rejects(f.store.update({ revision: 0, settings: { ...input(f.store.current()), model: 'synthetic-deployment-name' } }), errorCode('model_settings_invalid'));
    await assert.rejects(f.store.test({ revision: 0, settings: { ...input(f.store.current()), model: 'synthetic-deployment-name' } }), errorCode('model_settings_invalid'));
  }
});

test('saved configuration is private, survives restart and takes precedence over changed environment', async t => {
  const f = await fixture(t); await f.store.initialize();
  const view = await f.store.update({ revision: 0, settings: { ...input(), model: 'synthetic-new-model' } });
  assert.equal(view.source, 'saved'); assert.equal(view.revision, 1); assert.equal(f.activated.length, 2);
  assert.equal((await fs.stat(f.path)).mode & 0o777, 0o600);
  assert.equal(f.disposed.length, 0, 'Old active runtimes remain owned by the query coordinator');
  const saved = JSON.parse(await fs.readFile(f.path, 'utf8'));
  assert.equal(saved.version, 1); assert.equal(saved.revision, 1); assert.equal(saved.settings.apiKey, environment.apiKey);
  const restart = new ModelSettingsStore({ ...f.options, environment: { ...environment, model: 'changed-environment', apiKey: 'changed-environment-key' } });
  t.after(() => restart.close());
  const restartedView=await restart.initialize();
  assert.deepEqual(restartedView.settings,view.settings);
  assert.deepEqual(restartedView.profiles?.find(p=>p.id==='default'),view.profiles?.find(p=>p.id==='default'));
  assert.equal(restartedView.profiles?.find(p=>p.readOnly)?.settings.model,'changed-environment');
  assert.equal(restart.current().apiKey, environment.apiKey);
  await f.store.close(); assert.equal(f.disposed.length, 0, 'Store close does not cancel active requests');
});

test('reset persists a monotonic tombstone and uses current startup environment after restart', async t => {
  const f = await fixture(t); await f.store.initialize();
  await f.store.update({ revision: 0, settings: { ...input(), model: 'saved-synthetic-model', apiKey: 'saved-synthetic-key' } });
  const reset = await f.store.reset({ revision: 1 });
  assert.equal(reset.revision, 2); assert.equal(reset.source, 'environment'); assert.deepEqual(f.store.current(), environment);
  assert.deepEqual(JSON.parse(await fs.readFile(f.path, 'utf8')), { version: 1, revision: 2, settings: null });
  const restart = new ModelSettingsStore({ ...f.options, environment: { ...environment, model: 'new-environment-model' } });
  t.after(() => restart.close()); await restart.initialize();
  assert.equal(restart.view().revision, 2); assert.equal(restart.current().model, 'new-environment-model');
  await assert.rejects(restart.update({ revision: 0, settings: input() }), errorCode('model_settings_conflict'));
  await assert.rejects(restart.reset({ revision: 1 }), errorCode('model_settings_conflict'));
  assert.equal((await restart.reset({ revision: 2 })).revision, 3);
});

test('concurrent writes with the same revision prepare and activate exactly one candidate', async t => {
  const f = await fixture(t); await f.store.initialize();
  const results = await Promise.allSettled([
    f.store.update({ revision: 0, settings: { ...input(), model: 'first-synthetic-model' } }),
    f.store.update({ revision: 0, settings: { ...input(), model: 'second-synthetic-model' } }),
  ]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  errorCode('model_settings_conflict')((results[1] as PromiseRejectedResult).reason);
  assert.equal(f.prepared.length, 2); assert.equal(f.activated.length, 2); assert.equal(f.store.view().revision, 1);
  assert.equal(JSON.parse(await fs.readFile(f.path, 'utf8')).settings.model, 'first-synthetic-model');
});

test('provider, protocol and exact endpoint changes require confirmation for each retained secret class', async t => {
  const f = await fixture(t); await f.store.initialize();
  for (const change of [{ provider: 'deepseek' }, { protocol: 'anthropic-messages' }, { baseUrl: 'https://other.example.invalid/v1' }, { baseUrl: environment.baseUrl + '/' }]) {
    const body = { revision: 0, settings: { ...input(), ...change } };
    await assert.rejects(f.store.update(body), errorCode('model_settings_credential_reuse'));
    await assert.rejects(f.store.test(body), errorCode('model_settings_credential_reuse'));
  }
  for (const cleared of [{ apiKey: null, headers: null }, { apiKey: null, extraBody: null }, { headers: null, extraBody: null }]) {
    await assert.rejects(f.store.update({ revision: 0, settings: { ...input(), baseUrl: 'https://other.example.invalid/v1', ...cleared } }), errorCode('model_settings_credential_reuse'));
  }
  await assert.rejects(f.store.update({ revision: 0, settings: { ...input(), provider: 'deepseek', apiKey: 'new-synthetic-key' } }), errorCode('model_settings_credential_reuse'));
  assert.equal(f.probes.length, 0); assert.equal(f.prepared.length, 1);
  await f.store.update({ revision: 0, allowCredentialReuse: true, settings: { ...input(), baseUrl: 'https://other.example.invalid/v1' } });
  assert.equal(f.store.current().apiKey, environment.apiKey); assert.deepEqual(f.store.current().extraBody, environment.extraBody);
});

test('explicit null clears secrets and supplied replacements need no credential reuse confirmation', async t => {
  const f = await fixture(t); await f.store.initialize();
  const view = await f.store.update({ revision: 0, settings: { ...input(), provider: 'deepseek', apiKey: null, headers: null, extraBody: null } });
  assert.equal(view.settings.apiKeyConfigured, false); assert.equal(view.settings.headersConfigured, false); assert.equal(view.settings.extraBodyConfigured, false);
  assert.deepEqual(f.store.current(), { ...environment, provider: 'deepseek', apiKey: '', headers: {}, extraBody: {} });
  const replacement = { ...input(), baseUrl: 'https://replacement.example.invalid/v1', apiKey: 'replacement-synthetic-key', headers: { 'X-Synthetic-Key': 'replacement-synthetic-header' }, extraBody: { temperature: 0.2 } };
  await f.store.update({ revision: 1, settings: replacement });
  assert.deepEqual(f.store.current(), replacement);
});

test('test merges same-address drafts and returns fixed safe results without persisting or activating', async t => {
  const f = await fixture(t); await f.store.initialize();
  const result = await f.store.test({ revision: 0, settings: { ...input(), model: 'synthetic-draft-model' } });
  assert.deepEqual(result, { ok: true, code: 'ok', message: '模型连接及工具调用测试通过。', durationMs: 13 });
  assert.equal(f.probes[0].model, 'synthetic-draft-model'); assert.equal(f.probes[0].apiKey, environment.apiKey);
  assert.equal(f.store.view().revision, 0); assert.equal(f.store.view().source, 'environment'); assert.deepEqual(await fs.readdir(f.directory), []);
  assert.equal(f.activated.length, 1);
  await f.store.test({ revision: 0, allowCredentialReuse: true, settings: { ...input(), baseUrl: 'https://other.example.invalid/v1' } });
  assert.equal(f.probes[1].apiKey, environment.apiKey);
  await assert.rejects(f.store.test({ revision: 1, settings: input() }), errorCode('model_settings_conflict'));
});

test('probe exceptions and invalid provider results never expose callback messages or raw values', async t => {
  let fail = true;
  const f = await fixture(t, { probe: async () => {
    if (fail) throw new Error('synthetic-private-provider-message');
    return { ok: true, code: 'provider_error', message: 'synthetic-private-provider-message', durationMs: 2 };
  } });
  await f.store.initialize();
  let result = await f.store.test({ revision: 0, settings: input() });
  assert.equal(result.code, 'provider_error'); assert.ok(!JSON.stringify(result).includes('synthetic-private'));
  fail = false; result = await f.store.test({ revision: 0, settings: input() });
  assert.equal(result.code, 'invalid_response'); assert.ok(!JSON.stringify(result).includes('synthetic-private'));
});

test('strict schemas and runtime validation reject unsafe advanced parameters before prepare or probe', async t => {
  const f = await fixture(t); await f.store.initialize();
  const invalidSettings = [
    { provider: 'unregistered-provider' }, { baseUrl: '' },
    { unknown: 'synthetic-private-value' }, { protocol: 'unsupported' }, { apiKey: 'synthetic-private\nkey' },
    { baseUrl: 'https://user:synthetic-private-password@fixture.example.invalid/v1' },
    { baseUrl: 'https://fixture.example.invalid/v1?key=synthetic-private-query' },
    { headers: { Host: 'synthetic-private-header' } }, { headers: { Authorization: 'synthetic-private\r\nheader' } },
    { headers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-Fixture-${i}`, 'value'])) },
    { extraBody: { tools: [] } }, { extraBody: { options: { tool_choice: 'required' } } },
    { extraBody: JSON.parse('{"__proto__":{"synthetic":"private"}}') },
    { extraBody: { nested: undefined } }, { extraBody: { temperature: NaN } }, { extraBody: [] },
    { modelRequestTimeoutMs: 4999 }, { modelRequestTimeoutMs: 600001 }, { agentTimeoutMs: 4999 }, { agentTimeoutMs: 3600001 }, { maxTokens: 128001 }, { maxTokens: 0 },
    { model: null }, { allowUnauthenticatedLocal: 'true' },
  ];
  for (const change of invalidSettings) {
    const body = { revision: 0, settings: { ...input(), ...change } };
    await assert.rejects(f.store.update(body), errorCode('model_settings_invalid'));
    await assert.rejects(f.store.test(body), errorCode('model_settings_invalid'));
  }
  for (const body of [{ revision: 0, settings: input(), unknown: true }, { revision: 0.1, settings: input() }, { settings: input() }, { revision: 0, settings: input(), allowCredentialReuse: 'true' }]) {
    await assert.rejects(f.store.update(body), errorCode('model_settings_invalid'));
  }
  await assert.rejects(f.store.reset({ revision: 0, unknown: true }), errorCode('model_settings_invalid'));
  assert.equal(f.prepared.length, 1); assert.equal(f.probes.length, 0); assert.equal(f.store.view().revision, 0);
});

test('Codex settings make the model request timeout inapplicable and allow an unset Agent deadline', async t => {
  const codex: ModelSettings = { ...environment, provider: 'codex', protocol: 'codex-app-server', baseUrl: '', model: 'fixture-codex', apiKey: '', headers: {}, extraBody: {}, modelRequestTimeoutMs: null, agentTimeoutMs: null };
  const f = await fixture(t, { environment: codex });
  const view = await f.store.initialize();
  assert.equal(view.settings.modelRequestTimeoutMs, null); assert.equal(view.settings.agentTimeoutMs, null);
  await assert.rejects(f.store.update({ revision: 0, settings: { ...input(f.store.current()), modelRequestTimeoutMs: 600000 } }), errorCode('model_settings_invalid'));
  const saved = await f.store.update({ revision: 0, settings: { ...input(f.store.current()), agentTimeoutMs: 3600000 } });
  assert.equal(saved.settings.modelRequestTimeoutMs, null); assert.equal(saved.settings.agentTimeoutMs, 3600000);
});

test('legacy saved timeout settings migrate to separate request and Agent deadlines', async t => {
  const f = await fixture(t);
  const { modelRequestTimeoutMs: _request, agentTimeoutMs: _agent, ...legacy } = environment;
  await fs.writeFile(f.path, JSON.stringify({ version: 1, revision: 7, settings: { ...legacy, timeoutMs: 240000 } }));
  const view = await f.store.initialize();
  assert.equal(view.revision, 7); assert.equal(view.settings.modelRequestTimeoutMs, 240000); assert.equal(view.settings.agentTimeoutMs, 240000);
  const saved = await f.store.update({ revision: 7, settings: { ...input(f.store.current()), model: 'migrated-model' } });
  assert.equal(saved.settings.model, 'migrated-model');
});

test('invalid saved files fail startup instead of falling back to environment or revealing file values', async t => {
  const f = await fixture(t);
  for (const body of ['{synthetic-private-invalid-json', JSON.stringify({ version: 2, revision: 4, settings: environment }), JSON.stringify({ version: 1, revision: 4, settings: { ...environment, extraBody: { messages: ['synthetic-private'] } } }), ' '.repeat(512 * 1024 + 1)]) {
    await fs.writeFile(f.path, body);
    await assert.rejects(f.store.initialize(), errorCode('model_settings_unavailable'));
    assert.equal(f.prepared.length, 0);
  }
  await fs.writeFile(f.path, JSON.stringify({ version: 1, revision: 4, settings: null }));
  assert.equal((await f.store.initialize()).revision, 4);
});

test('failed rename retains old state, disposes candidate, removes temporary file and permits retry', async t => {
  let fail = true;
  const f = await fixture(t, { fileSystem: { rename: async (...args) => { if (fail) throw new Error('synthetic-private-filesystem-error'); await fs.rename(...args); } } });
  await f.store.initialize();
  const body = { revision: 0, settings: { ...input(), model: 'pending-synthetic-model' } };
  await assert.rejects(f.store.update(body), errorCode('model_settings_save_failed'));
  assert.deepEqual(f.store.current(), environment); assert.equal(f.activated.length, 1); assert.equal(f.disposed.length, 1);
  assert.deepEqual(await fs.readdir(f.directory), []);
  fail = false; assert.equal((await f.store.update(body)).revision, 1);
});

test('failed runtime preparation leaves existing configuration and file untouched', async t => {
  const f = await fixture(t); await f.store.initialize();
  f.options.prepare = async () => { throw new Error('synthetic-private-initialization-error'); };
  await assert.rejects(f.store.update({ revision: 0, settings: input() }), errorCode('model_settings_prepare_failed'));
  assert.equal(f.store.view().revision, 0); assert.deepEqual(await fs.readdir(f.directory), []);
});

test('post-rename directory sync failure adopts confirmed new disk state without disposing active candidate', async t => {
  let fail = true, directory = '';
  const f = await fixture(t, { fileSystem: { open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[0] === directory && fail) handle.sync = async () => { throw new Error('synthetic-private-sync-error'); };
    return handle;
  } } });
  directory = f.directory; await f.store.initialize();
  await assert.rejects(f.store.update({ revision: 0, settings: { ...input(), model: 'committed-synthetic-model' } }), errorCode('model_settings_commit_uncertain'));
  assert.equal(f.store.view().revision, 1); assert.equal(f.store.current().model, 'committed-synthetic-model');
  assert.equal(f.activated.length, 2); assert.equal(f.disposed.length, 0);
  assert.equal(JSON.parse(await fs.readFile(f.path, 'utf8')).settings.model, f.store.current().model);
  await assert.rejects(f.store.update({ revision: 0, settings: input() }), errorCode('model_settings_conflict'));
  fail = false; assert.equal((await f.store.update({ revision: 1, settings: input() })).revision, 2);
});

test('rename acknowledgement failure reads back authority rather than overwriting a committed file', async t => {
  const f = await fixture(t, { fileSystem: { rename: async (...args) => { await fs.rename(...args); throw new Error('synthetic-private-rename-ack-error'); } } });
  await f.store.initialize();
  await assert.rejects(f.store.update({ revision: 0, settings: { ...input(), model: 'committed-after-rename' } }), errorCode('model_settings_commit_uncertain'));
  assert.equal(f.store.current().model, 'committed-after-rename'); assert.equal(f.store.view().revision, 1);
  assert.equal(f.disposed.length, 0);
});

test('unreadable authority after rename blocks changes and preserves the file for startup recovery', async t => {
  let fail = false, directory = '', path = '';
  const f = await fixture(t, { fileSystem: { open: async (...args) => {
    if (args[0] === path && fail) throw new Error('synthetic-private-readback-error');
    const handle = await fs.open(...args);
    if (args[0] === directory && fail) handle.sync = async () => { throw new Error('synthetic-private-sync-error'); };
    return handle;
  } } });
  directory = f.directory; path = f.path; await f.store.initialize();
  await f.store.update({ revision: 0, settings: input() });
  fail = true;
  await assert.rejects(f.store.update({ revision: 1, settings: { ...input(), model: 'recovered-synthetic-model' } }), errorCode('model_settings_commit_uncertain'));
  assert.throws(() => f.store.view(), errorCode('model_settings_unavailable'));
  await assert.rejects(f.store.reset({ revision: 1 }), errorCode('model_settings_unavailable'));
  assert.equal(f.disposed.length, 1); assert.equal(f.activated.length, 2);
  assert.equal(JSON.parse(await fs.readFile(f.path, 'utf8')).revision, 2);
  const restart = new ModelSettingsStore({ ...f.options, fileSystem: undefined }); t.after(() => restart.close());
  assert.equal((await restart.initialize()).revision, 2); assert.equal(restart.current().model, 'recovered-synthetic-model');
});

test('reset write failure keeps saved credentials and revision rather than prematurely applying environment', async t => {
  let fail = false;
  const f = await fixture(t, { fileSystem: { rename: async (...args) => { if (fail) throw new Error('synthetic-private-write-error'); await fs.rename(...args); } } });
  await f.store.initialize();
  await f.store.update({ revision: 0, settings: { ...input(), apiKey: 'saved-synthetic-secret' } });
  fail = true; await assert.rejects(f.store.reset({ revision: 1 }), errorCode('model_settings_save_failed'));
  assert.equal(f.store.view().revision, 1); assert.equal(f.store.view().source, 'saved'); assert.equal(f.store.current().apiKey, 'saved-synthetic-secret');
  assert.equal(JSON.parse(await fs.readFile(f.path, 'utf8')).settings.apiKey, 'saved-synthetic-secret');
  assert.equal(f.disposed.length, 1); assert.equal(f.disposed[0].apiKey, environment.apiKey);
});

test('close drains accepted changes while rejecting new transactions without retiring active runtimes', async t => {
  const f = await fixture(t); await f.store.initialize();
  const update = f.store.update({ revision: 0, settings: input() });
  const close = f.store.close();
  await assert.rejects(f.store.reset({ revision: 1 }), errorCode('model_settings_unavailable'));
  assert.equal((await update).revision, 1); await close;
  assert.throws(() => f.store.current(), errorCode('model_settings_unavailable'));
  assert.equal(f.disposed.length, 0);
});
