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
import {parse,stringify} from 'yaml';

const inactive: QueryAgent = { configured: false, query: async () => { throw Error('No model call belongs in configuration tests'); }, close: async () => {} };
function fixture(directory: string): Config {
  return {
    dataDir: join(directory, 'archive'), token: 'synthetic-configuration-access-token', tokenPath: join(directory, 'private-token'),
    host: '0.0.0.0', port: 47832, profile: 'test', tokenFromEnvironment: true,
    dataKey: randomBytes(32).toString('hex'), maxStorageBytes: 23 * 1024 * 1024, maxExportBytes: 4 * 1024 * 1024,
    retentionDays: 17, insightIntervalHours: 0, allowedOrigins: ['https://app.example.invalid'],
    model: 'synthetic-model-name', modelBaseUrl: 'https://model.example.invalid/v1', apiKey: 'synthetic-agent-private-key',
    modelReasoningEffort: 'high', modelMaxTokens: 4096, modelRequestTimeoutMs: 300000, agentTimeoutMs: 300000, allowUnauthenticatedLocal: false,
    embeddingModel: 'synthetic-embedding-name', embeddingBaseUrl: 'https://embedding.example.invalid/v1', embeddingApiKey: 'synthetic-embedding-private-key',
    diagnosticsEnabled: true, diagnosticsDebug: true, logDirectory: join(directory, 'private-logs'), logLevel: 'info', logMaxBytes: 1024 * 1024, logMaxTotalBytes:512*1024*1024, logMaxEntries: 100,
    configuration: {
      baseDir: '/app/deploy', hostConfigFile: join(directory, 'mote.env'), runtime: 'docker',
      publicUrl: 'https://mote.example.invalid', storageKind: 'docker-volume', storageSource: 'synthetic-private-volume-name', storageMount: '/data',
      tunnelEnabled: true, tunnelProvider: 'cloudflare', tunnelProtocol: 'http2',
      sources: { MOTE_PORT: 'default', MOTE_MODEL: 'config-file', MOTE_TOKEN: 'config-file', MOTE_DATA_DIR: 'config-file', MOTE_CONFIG_FILE: 'config-file', MOTE_STORAGE_SOURCE: 'config-file' },
    },
  };
}
const fields = (response: ServerConfiguration): Map<string, ConfigurationField> => new Map(response.groups.flatMap(group => group.fields).map(field => [field.key, field]));

test('configuration projection is serializable, preserves effective values and separates host paths from container paths', () => {
  const config = fixture('/synthetic-owner-only-directory'), view = serverConfiguration(config), all = fields(view);
  assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
  assert.equal(view.envFile, config.configuration!.hostConfigFile);
  assert.equal(all.has('effectiveEnvFile'), false, 'The obsolete environment-file projection must be removed');
  assert.equal(view.baseDir, '/app/deploy'); assert.equal(view.runtime, 'docker'); assert.equal(view.readOnly, true); assert.equal(view.restartRequired, true);
  assert.equal(view.storage.sqlitePath, join(config.dataDir, 'mote.sqlite')); assert.equal(view.storage.assetDir, join(config.dataDir, 'files', 'objects'));
  assert.equal(view.storage.kind, 'docker-volume'); assert.equal(view.storage.source, 'synthetic-private-volume-name'); assert.equal(view.storage.mountPath, '/data');
  assert.equal(all.get('maxStorageBytes')!.value, 23 * 1024 * 1024); assert.equal(all.get('maxStorageBytes')!.unit, 'bytes'); assert.match(all.get('maxStorageBytes')!.description, /逻辑字节/);
  assert.equal(all.get('modelRequestTimeoutMs')!.value,300000); assert.equal(all.get('modelRequestTimeoutMs')!.envVar,'MOTE_MODEL_REQUEST_TIMEOUT_MS');
  assert.equal(all.get('agentTimeoutMs')!.value,300000); assert.equal(all.get('agentTimeoutMs')!.envVar,'MOTE_AGENT_TIMEOUT_MS');
  assert.equal(all.get('agentTraceEnabled')!.value, false); assert.equal(all.get('agentTraceEnabled')!.envVar,'MOTE_AGENT_TRACE_ENABLED');
  assert.equal(all.get('retentionDays')!.value, 17); assert.equal(all.get('modelMaxTokens')!.value, 4096);
  const allowedSources = new Set(['config-file', 'default', 'derived']);
  for (const field of all.values()) assert.ok(allowedSources.has(field.source), `${field.key} reports ${field.source}`);
  assert.equal(all.get('model')!.source, 'config-file'); assert.equal(all.get('listenPort')!.source, 'default'); assert.equal(all.get('sqlitePath')!.source, 'derived');
  for (const key of ['accessTokenConfigured', 'modelApiKeyConfigured', 'embeddingApiKeyConfigured', 'dataKeyConfigured']) { assert.equal(all.get(key)!.value, true); assert.equal(all.get(key)!.visibility, 'secret-status'); }
  for (const secret of [config.token, config.apiKey, config.embeddingApiKey, config.dataKey!]) assert.ok(!JSON.stringify(view).includes(secret));
  assert.equal(all.get('tunnelConfigured')!.value, true); assert.match(all.get('tunnelConfigured')!.description, /不代表/);
  assert.ok(all.size > 40); assert.equal(all.size, view.groups.reduce((n, group) => n + group.fields.length, 0), 'Field keys must be unique for stable UI rendering');
});

test('the served configuration view reports only config-file, default and derived sources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-configuration-sources-')), config = fixture(directory);
  const { app } = await buildApp(config, { agent: inactive, backgroundWorker: false });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const response = await app.inject({ url: '/api/configuration', headers: { authorization: `Bearer ${config.token}` } });
  assert.equal(response.statusCode, 200);
  const view = response.json<ServerConfiguration>(), allowed = new Set(['config-file', 'default', 'derived']), seen = new Set<string>();
  for (const field of view.groups.flatMap(group => group.fields)) {
    assert.ok(allowed.has(field.source), `${field.key} reports ${field.source}`);
    seen.add(field.source);
  }
  assert.ok(seen.has('config-file')); assert.ok(seen.has('derived'));
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

test('owner configuration ignores obsolete env files and support remains path/secret-free', async t => {
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
  assert.equal((await app.inject({url:'/api/status',headers})).json().agent.agentTimeoutMs,300000);
  assert.equal(app.initialConfig.requestTimeout,180000,'Model budgets do not extend HTTP request upload limits');
  assert.equal(fields(response.json()).get('logLevel')!.value, 'info');
  assert.equal(fields(response.json()).get('effectiveLogLevel')!.value, diagnostics.snapshot().level);
  assert.equal(diagnostics.snapshot().level, 'debug', 'Explicit debug promotes a non-silent configured level');
  await writeFile(file, 'MOTE_MODEL=synthetic-new-value-for-next-restart\n', { mode: 0o600 });
  assert.equal(fields((await app.inject({ url: '/api/configuration', headers })).json()).get('model')!.value, config.model);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) assert.equal((await app.inject({ method, url: '/api/configuration', headers, payload: { MOTE_DATA_DIR: '/synthetic-unapproved-path', MOTE_DATA_KEY: 'replacement' } })).statusCode, 404);
  assert.equal(await readFile(file, 'utf8'), 'MOTE_MODEL=synthetic-new-value-for-next-restart\n');
  const privateValues = [directory, config.token, config.dataKey!, config.apiKey, config.embeddingApiKey, config.configuration!.storageSource!, config.modelBaseUrl];
  for (const route of ['/api/support-bundle', '/api/diagnostics']) {
    const result = await app.inject({ url: route, headers }); assert.equal(result.statusCode, 200);
    for (const value of privateValues) assert.ok(!result.body.includes(value), `${route} must exclude owner configuration`);
  }
  await diagnostics.flush();
  for (const name of await readdir(config.logDirectory!)) {
    const log = await readFile(join(config.logDirectory!, name), 'utf8'); for (const value of privateValues) assert.ok(!log.includes(value));
  }
});

test('owner configuration uses the shared YAML for API edits, restart state, file reload and revision conflicts',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-configuration-file-')),config=fixture(directory);
  const {app,configService}=await buildApp(config,{agent:inactive,backgroundWorker:false});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.token}`};
  const view=()=>app.inject({url:'/api/configuration',headers});
  const update=(id:string,value:unknown,revision:number)=>app.inject({method:'PUT',url:'/api/configuration/'+id,headers,payload:{value,revision}});
  const initial=(await view()).json<ServerConfiguration>();
  assert.equal(initial.readOnly,false);assert.equal(initial.configFile,configService.path);assert.equal(initial.lastError,null);
  assert.ok(initial.domains!.some(domain=>domain.id==='models'));
  for(const secret of [config.token,config.apiKey,config.embeddingApiKey,config.dataKey!])assert.ok(!JSON.stringify(initial).includes(secret));
  assert.equal((await app.inject({method:'PUT',url:'/api/configuration/server',payload:{revision:initial.revision,value:{port:47833}}})).statusCode,401);
  assert.equal((await app.inject({method:'PUT',url:'/api/configuration/server',headers,payload:{value:{port:47833}}})).statusCode,400);
  const saved=await update('server',{port:47833},initial.revision!);assert.equal(saved.statusCode,200,saved.body);
  const savedView=saved.json<ServerConfiguration>(),port=fields(savedView).get('listenPort')!;
  assert.equal(port.value,47832);assert.equal(port.savedValue,47833);assert.equal(port.effect,'restart');assert.equal(savedView.restartRequired,true);
  assert.equal((await update('execution',{agentConcurrency:2},initial.revision!)).statusCode,409);
  const execution=await update('execution',{agentConcurrency:2},savedView.revision!);assert.equal(execution.statusCode,200,execution.body);
  assert.equal((await app.inject({url:'/api/execution-settings',headers})).json().agentConcurrency,2);
  const raw=parse(await readFile(configService.path,'utf8'));assert.equal(raw.server.port,47833);assert.equal(raw.models.deployment.apiKey,config.apiKey);
  assert.equal((await update('server',{unknownSetting:'generated'},execution.json().revision)).statusCode,400);
  const reuse=await update('models',{embedding:{baseUrl:'https://replacement.example.invalid/v1'}},execution.json().revision);
  assert.equal(reuse.statusCode,409);assert.equal(reuse.json().error,'model_settings_credential_reuse');
  const deploymentReuse=await update('models',{deployment:{baseUrl:'https://replacement.example.invalid/v1'}},execution.json().revision);
  assert.equal(deploymentReuse.statusCode,409);assert.equal(deploymentReuse.json().error,'model_settings_credential_reuse');
  assert.equal((await view()).json().revision,execution.json().revision);
  raw.diagnostics.debug=false;await writeFile(configService.path,stringify(raw),{mode:0o600});await configService.reload();
  const reloaded=(await view()).json<ServerConfiguration>();assert.equal(fields(reloaded).get('diagnosticsDebug')!.value,false);
  assert.ok(reloaded.revision!>execution.json().revision);
  const beforeInvalid=await readFile(configService.path,'utf8');
  await writeFile(configService.path,'version: 1\nrevision: 0\nserver: [generated-invalid-secret\n',{mode:0o600});
  await assert.rejects(configService.reload());
  const invalid=await view();assert.equal(invalid.statusCode,200);assert.equal(invalid.json().lastError.code,'config_invalid');
  assert.equal(fields(invalid.json()).get('diagnosticsDebug')!.value,false);assert.ok(!invalid.body.includes('generated-invalid-secret'));
  await writeFile(configService.path,beforeInvalid,{mode:0o600});await configService.reload();
  assert.equal((await view()).json().lastError,null);
});

test('request bursts preserve authentication and configuration access without a request quota', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mote-configuration-burst-')), config = fixture(directory);
  const { app } = await buildApp(config, { agent: inactive, backgroundWorker: false });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${config.token}` };
  for (let i = 0; i < 200; i++) {
    assert.equal((await app.inject('/api/configuration')).statusCode, 401);
    assert.equal((await app.inject('/api/health')).statusCode, 200);
  }
  assert.equal((await app.inject({ url: '/api/configuration', headers })).statusCode, 200);
  for (let i = 0; i < 12; i++) {
    const response = await app.inject({ method: 'POST', url: '/api/query', headers, payload: { question: 'Generated unconfigured model request.' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'model_not_configured');
  }
});

test('generic model editor requires a credential-reuse decision before sending saved credentials to another endpoint',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-configuration-credentials-')),config=fixture(directory);
  const {app,configService}=await buildApp(config,{agent:inactive,backgroundWorker:false});
  t.after(async()=>{await app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:`Bearer ${config.token}`},value={embedding:{baseUrl:'https://replacement.example.invalid/v1'}};
  const blocked=await app.inject({method:'PUT',url:'/api/configuration/models',headers,payload:{revision:configService.revision,value}});
  assert.equal(blocked.statusCode,409);assert.equal(blocked.json().error,'model_settings_credential_reuse');
  const allowed=await app.inject({method:'PUT',url:'/api/configuration/models',headers,payload:{revision:configService.revision,value,allowCredentialReuse:true}});
  assert.equal(allowed.statusCode,200,allowed.body);assert.equal(allowed.json().restartRequired,true);
  assert.equal(parse(await readFile(configService.path,'utf8')).models.embedding.apiKey,config.embeddingApiKey);
  assert.ok(!allowed.body.includes(config.embeddingApiKey));
});
