import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ConfigurationField, ServerConfiguration } from '@mote/shared';
import { buildApp, type QueryAgent } from '../src/app.js';
import { serverConfiguration, configurationUrl } from '../src/configuration.js';
import type { Config } from '../src/config.js';

const inactive: QueryAgent = { configured: false, query: async () => { throw Error('No model call belongs in configuration tests'); }, close: async () => {} };
function fixture(directory: string): Config {
  return {
    dataDir: join(directory, 'archive'), token: 'synthetic-configuration-access-token', tokenPath: join(directory, 'private-token'),
    host: '0.0.0.0', port: 47832, profile: 'test', tokenFromEnvironment: true,
    dataKey: randomBytes(32).toString('hex'), maxStorageBytes: 23 * 1024 * 1024, maxExportBytes: 4 * 1024 * 1024,
    retentionDays: 17, insightIntervalHours: 0, allowedOrigins: ['https://app.example.invalid'],
    model: 'synthetic-model-name', modelBaseUrl: 'https://model.example.invalid/v1', apiKey: 'synthetic-agent-private-key',
    modelReasoningEffort: 'high', modelMaxTokens: 4096, allowUnauthenticatedLocal: false,
    embeddingModel: 'synthetic-embedding-name', embeddingBaseUrl: 'https://embedding.example.invalid/v1', embeddingApiKey: 'synthetic-embedding-private-key',
    diagnosticsEnabled: true, diagnosticsDebug: true, logDirectory: join(directory, 'private-logs'), logLevel: 'info', logMaxBytes: 1024 * 1024, logMaxFiles: 2, logMaxEntries: 100,
    configuration: {
      envFile: '/app/deploy/empty.env', baseDir: '/app/deploy', hostConfigFile: join(directory, 'mote.env'), runtime: 'docker',
      publicUrl: 'https://mote.example.invalid', storageKind: 'docker-volume', storageSource: 'synthetic-private-volume-name', storageMount: '/data',
      tunnelEnabled: true, tunnelProvider: 'cloudflare', tunnelProtocol: 'http2',
      sources: { MOTE_PORT: 'environment', MOTE_MODEL: 'env-file', MOTE_TOKEN: 'env-file', MOTE_DATA_DIR: 'environment', MOTE_CONFIG_FILE: 'environment', MOTE_STORAGE_SOURCE: 'environment' },
    },
  };
}
const fields = (response: ServerConfiguration): Map<string, ConfigurationField> => new Map(response.groups.flatMap(group => group.fields).map(field => [field.key, field]));

test('configuration projection is serializable, preserves effective values and separates host paths from container paths', () => {
  const config = fixture('/synthetic-owner-only-directory'), view = serverConfiguration(config), all = fields(view);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
  assert.equal(view.envFile, config.configuration!.hostConfigFile);
  assert.equal(all.get('effectiveEnvFile')!.value, '/app/deploy/empty.env');
  assert.equal(view.baseDir, '/app/deploy'); assert.equal(view.runtime, 'docker'); assert.equal(view.readOnly, true); assert.equal(view.restartRequired, true);
  assert.equal(view.storage.sqlitePath, join(config.dataDir, 'mote.sqlite')); assert.equal(view.storage.blobsDir, join(config.dataDir, 'blobs'));
  assert.equal(view.storage.kind, 'docker-volume'); assert.equal(view.storage.source, 'synthetic-private-volume-name'); assert.equal(view.storage.mountPath, '/data');
  assert.equal(all.get('maxStorageBytes')!.value, 23 * 1024 * 1024); assert.equal(all.get('maxStorageBytes')!.unit, 'bytes'); assert.match(all.get('maxStorageBytes')!.description, /逻辑字节/);
  assert.equal(all.get('retentionDays')!.value, 17); assert.equal(all.get('modelMaxTokens')!.value, 4096);
  assert.equal(all.get('model')!.source, 'env-file'); assert.equal(all.get('listenPort')!.source, 'environment'); assert.equal(all.get('logMaxFiles')!.source, 'default');
  for (const key of ['accessTokenConfigured', 'modelApiKeyConfigured', 'embeddingApiKeyConfigured', 'dataKeyConfigured']) { assert.equal(all.get(key)!.value, true); assert.equal(all.get(key)!.visibility, 'secret-status'); }
  for (const secret of [config.token, config.apiKey, config.embeddingApiKey, config.dataKey!]) assert.ok(!JSON.stringify(view).includes(secret));
  assert.equal(all.get('tunnelConfigured')!.value, true); assert.match(all.get('tunnelConfigured')!.description, /不代表/);
  assert.ok(all.size > 40); assert.equal(all.size, view.groups.reduce((n, group) => n + group.fields.length, 0), 'Field keys must be unique for stable UI rendering');
});

test('URL projections strip credentials, query and fragment even when Config bypasses environment validation', () => {
  const config = fixture('/synthetic-path');
  config.modelBaseUrl = 'https://url-user:url-password@model.example.invalid/v1?api_key=hidden-query#hidden-fragment';
  config.embeddingBaseUrl = 'https://url-user:url-password@embedding.example.invalid/api?token=hidden-query';
  config.configuration!.publicUrl = 'https://url-user:url-password@mote.example.invalid/?token=hidden-query#hidden-fragment';
  config.allowedOrigins = ['https://url-user:url-password@app.example.invalid?token=hidden-query', 'javascript:alert(1)'];
  const view = serverConfiguration(config), all = fields(view), serialized = JSON.stringify(view);
  assert.equal(all.get('modelBaseUrl')!.value, 'https://model.example.invalid/v1');
  assert.equal(all.get('embeddingBaseUrl')!.value, 'https://embedding.example.invalid/api');
  assert.equal(all.get('publicUrl')!.value, 'https://mote.example.invalid/');
  assert.deepEqual(all.get('allowedOrigins')!.value, ['https://app.example.invalid']);
  for (const secret of ['url-user', 'url-password', 'hidden-query', 'hidden-fragment']) assert.ok(!serialized.includes(secret));
  assert.equal(configurationUrl('file:///private/credentials'), null); assert.equal(configurationUrl('not a URL'), null);
});

test('owner configuration is authenticated and read-only; changes on disk await restart and support remains path/secret-free', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-configuration-owner-')), config = fixture(directory);
  const file = config.configuration!.hostConfigFile!; await writeFile(file, 'MOTE_MODEL=synthetic-file-value\n', { mode: 0o600 });
  const { app, diagnostics } = await buildApp(config, { agent: inactive });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${config.token}` };
  assert.equal((await app.inject('/api/configuration')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/configuration', headers: { authorization: 'Bearer incorrect' } })).statusCode, 401);
  const response = await app.inject({ url: '/api/configuration', headers });
  assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(fields(response.json()).get('model')!.value, config.model);
  assert.equal(fields(response.json()).get('logLevel')!.value, 'info');
  assert.equal(fields(response.json()).get('effectiveLogLevel')!.value, diagnostics.snapshot().level);
  assert.equal(diagnostics.snapshot().level, 'debug', 'Explicit debug promotes a non-silent configured level');
  await writeFile(file, 'MOTE_MODEL=synthetic-new-value-for-next-restart\n', { mode: 0o600 });
  assert.equal(fields((await app.inject({ url: '/api/configuration', headers })).json()).get('model')!.value, config.model);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) assert.equal((await app.inject({ method, url: '/api/configuration', headers, payload: { MOTE_DATA_DIR: '/synthetic-unapproved-path', MOTE_DATA_KEY: 'replacement' } })).statusCode, 404);
  assert.equal(await readFile(file, 'utf8'), 'MOTE_MODEL=synthetic-new-value-for-next-restart\n');
  const privateValues = [directory, config.token, config.dataKey!, config.apiKey, config.embeddingApiKey, config.configuration!.storageSource!, config.modelBaseUrl, '/app/deploy/empty.env'];
  for (const route of ['/api/support-bundle', '/api/diagnostics']) {
    const result = await app.inject({ url: route, headers }); assert.equal(result.statusCode, 200);
    for (const value of privateValues) assert.ok(!result.body.includes(value), `${route} must exclude owner configuration`);
  }
  await diagnostics.flush();
  for (const name of await readdir(config.logDirectory!)) {
    const log = await readFile(join(config.logDirectory!, name), 'utf8'); for (const value of privateValues) assert.ok(!log.includes(value));
  }
});

test('unauthenticated requests sharing a tunnel IP cannot consume the authenticated owner rate bucket', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-configuration-rate-')), config = fixture(directory);
  const { app } = await buildApp(config, { agent: inactive });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  let unauthenticated;
  for (let i = 0; i < 182; i++) unauthenticated = await app.inject({ url: '/api/configuration', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.18' } });
  assert.ok([401, 429].includes(unauthenticated!.statusCode));
  // Fastify may reject unauthenticated private routes before its limiter hook. Public health still
  // reaches the limiter and must not let proxy-shared traffic consume the owner's independent quota.
  for (let i = 0; i < 182; i++) unauthenticated = await app.inject({ url: '/api/health', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '203.0.113.18' } });
  assert.equal(unauthenticated!.statusCode, 429);
  const headers = { authorization: `Bearer ${config.token}`, 'x-forwarded-for': '203.0.113.18' };
  assert.equal((await app.inject({ url: '/api/configuration', remoteAddress: '127.0.0.1', headers })).statusCode, 200);
  let query;
  for (let i = 0; i < 11; i++) query = await app.inject({ method: 'POST', url: '/api/query', headers, payload: { question: 'Synthetic rate-limit request; no model is configured.' } });
  assert.equal(query!.statusCode, 429, 'The normal owner query limit remains in effect');
});
