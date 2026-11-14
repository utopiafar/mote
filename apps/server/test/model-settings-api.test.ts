import {readAgentCredential} from './login-fixture.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSettingsView, ModelSettingsInput } from '@mote/shared/models';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import type { ModelAgentFactory } from '../src/model-agent.js';
import { testModelConnection } from '../src/model-agent.js';
import {appCleanup} from './fixtures/app-cleanup.js';

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
  const cleanup=appCleanup(t,directory);
  const cfg = config(directory), node = cleanup.own(await buildApp(cfg, { createModelAgent: factory }));
  return { ...node, cfg, directory, cleanup };
}

test('owner model saves apply to new queries while an existing query retains its original runtime', async t => {
  let started!: () => void, finish!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  const closed: string[] = [];
  const { app, cfg, cleanup } = await fixture(t, async settings => ({ configured: true,
    query: async args => { if (args.question === 'hold fixture') { started(); await held; } return answer(settings.model); },
    close: async () => { closed.push(settings.model); },
  }));
  cleanup.beforeClose(finish);
  const first = await app.inject({ url: '/api/model-settings', headers }), view = first.json<ModelSettingsView>();
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(view.source, 'file'); assert.ok(view.profiles.every(profile => profile.source === 'file'), 'model profiles are backed by the shared configuration file');
  const pending = app.inject({ method: 'POST', url: '/api/query', headers, payload: { question: 'hold fixture' } });
  await began;
  const saved = await app.inject({ method: 'PUT', url: '/api/model-settings', headers, payload: {
    revision: view.revision, settings: { ...input(view), model: 'next-fixture', maxTokens: 65536, modelRequestTimeoutMs: 300000, agentTimeoutMs: 600000,
      apiKey: 'synthetic-new-key', headers: { 'x-fixture-secret': 'synthetic-header-key' }, extraBody: { vendor_options: { token: 'synthetic-body-key' } } },
  } });
  assert.equal(saved.statusCode, 200, saved.body); assert.deepEqual(closed, []);
  assert.equal((await app.inject({ method: 'POST', url: '/api/query', headers, payload: { question: 'next fixture' } })).json().answer, 'next-fixture');
  const status = (await app.inject({ url: '/api/status', headers })).json();
  assert.equal(status.agent.model, 'next-fixture'); assert.equal(status.agent.protocol, 'openai-completions'); assert.equal(status.agent.maxTokens, 65536);
  const current = (await app.inject({ url: '/api/configuration', headers })).json();
  const fields = current.groups.flatMap((group: any) => group.fields);
  assert.equal(fields.find((field: any) => field.key === 'model').value, 'original-fixture','the configuration field describes the deployment profile saved in YAML');
  const modelDomain=current.domains.find((domain:any)=>domain.id==='models');assert.equal(modelDomain.effective.defaults.chat,'primary');assert.equal(modelDomain.effective.profiles.find((profile:any)=>profile.id==='primary').settings.model,'next-fixture');
  assert.equal(fields.find((field: any) => field.key === 'model').restartRequired, false);
  assert.equal(fields.find((field: any) => field.key === 'model').source, 'config-file');
  assert.equal(cfg.model, 'original-fixture', 'Hot settings must not mutate the caller configuration snapshot');
  finish(); const completed=(await pending).json();assert.equal(completed.answer, 'original-fixture');assert.equal(completed.configuration.model,'original-fixture');assert.ok(completed.configuration.fingerprint);assert.equal(completed.configuration.owner,'models');
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(closed, ['original-fixture']);
  for (const route of ['/api/model-settings', '/api/configuration', '/api/status', '/api/support-bundle', '/api/export']) {
    const response = await app.inject({ url: route, headers }); assert.equal(response.statusCode, 200);
    for (const secret of ['synthetic-new-key', 'synthetic-header-key', 'synthetic-body-key']) assert.equal(response.body.includes(secret), false, route);
  }
});

test('model settings enforce owner authorization, optimistic revisions, explicit credential reuse and reset persistence', async t => {
  const factory: ModelAgentFactory = async settings => ({ configured: true, query: async () => answer(settings.model), close: async () => {} });
  const { app, cfg, connections, cleanup } = await fixture(t, factory);
  const invitation = await app.inject({ method: 'POST', url: '/api/connections/invitations', headers, payload: { serverUrl: 'https://synthetic.invalid', label: 'Fixture phone' } });
  const redeemed = await app.inject({ method: 'POST', url: '/api/connections/redeem', payload: { code: invitation.json().invitation.code, deviceId: 'fixture-phone', deviceName: 'Fixture phone', platform: 'android' } });
  assert.equal(redeemed.statusCode, 200);
  const restricted=await readAgentCredential(connections);
  for (const method of ['GET', 'PUT', 'DELETE', 'POST'] as const) {
    const url = '/api/model-settings' + (method === 'POST' ? '/test' : '');
    assert.equal((await app.inject({ method, url })).statusCode, 401);
    assert.equal((await app.inject({ method, url, headers: { authorization: `Bearer ${restricted.token}` } })).statusCode, 403);
  }
  let view = (await app.inject({ url: '/api/model-settings', headers })).json<ModelSettingsView>();
  const payload = { revision: view.revision, settings: { ...input(view), provider: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'fixture-new' } };
  let response = await app.inject({ method: 'PUT', url: '/api/model-settings', headers, payload });
  assert.equal(response.statusCode, 409); assert.equal(response.json().error, 'model_settings_credential_reuse');
  response = await app.inject({ method: 'PUT', url: '/api/model-settings', headers, payload: { ...payload, allowCredentialReuse: true } });
  assert.equal(response.statusCode, 200, response.body); view = response.json();
  assert.equal((await app.inject({ method: 'PUT', url: '/api/model-settings', headers, payload: { ...payload, allowCredentialReuse: true } })).statusCode, 409);
  await app.close();
  const restarted = cleanup.own(await buildApp(cfg, { createModelAgent: factory }));
  assert.equal((await restarted.app.inject({ url: '/api/status', headers })).json().agent.model, 'fixture-new');
  response = await restarted.app.inject({ method: 'DELETE', url: '/api/model-settings', headers, payload: { revision: view.revision } });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().source, 'file');
  assert.equal((await restarted.app.inject({ url: '/api/status', headers })).json().agent.model, 'original-fixture');
});

test('draft probe uses only generated records and neither persists nor exposes provider errors', async t => {
  const seen: string[] = [];
  const { app } = await fixture(t, async (settings, reader) => ({ configured: true,
    query: async () => {
      const records = await reader.search({}); seen.push(...records.map(record => record.ocrText));
      assert.equal(records.length, 1); assert.equal(records[0].id, '7a8f56d1-45de-47b7-90bb-5e84d411c3d6');
      assert.equal((await reader.evidence({ ids: [records[0].id] })).length, 1);
      return { ...answer('fixture connection'), citations: [{ id: records[0].id, appName: records[0].appName, capturedAt: records[0].capturedAt, excerpt: records[0].ocrText }], trace: [{ tool: 'evidence', arguments: { ids: [records[0].id] }, count: 1 }] };
    }, close: async () => {},
  }));
  const note = { id: '11111111-2222-4333-8444-555555555555', deviceId: 'fixture', deviceName: 'Fixture', platform: 'import', client: 'web', capturedAt: '2026-01-01T00:00:00Z', text: 'Synthetic archive sentinel: must never be sent by connection test.' };
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
  const settings = { provider: 'custom', protocol: 'openai-completions' as const, baseUrl: 'https://example.invalid/v1', model: 'synthetic', reasoningEffort: 'auto' as const, maxTokens: 8192, modelRequestTimeoutMs: 120000, agentTimeoutMs: 120000, allowUnauthenticatedLocal: false, apiKey: 'synthetic', headers: {}, extraBody: {} };
  let closed = 0;
  const failed = await testModelConnection(settings, async received => {
    assert.equal(received.modelRequestTimeoutMs, 30000); assert.equal(received.agentTimeoutMs, 30000);
    return { configured: true, query: async () => { throw new Error('synthetic-sensitive-provider-response'); }, close: async () => { closed++; } };
  });
  assert.equal(failed.code, 'provider_error'); assert.equal(JSON.stringify(failed).includes('sensitive'), false); assert.equal(closed, 1);
  const unsupported = await testModelConnection(settings, async () => ({ configured: true, query: async () => answer('fixture without tools'), close: async () => {} }));
  assert.equal(unsupported.code, 'invalid_response');
});

test('profile deletion and edits retain scalar and composite YAML credential references',async t=>{
 const {readFile,writeFile}=await import('node:fs/promises'),{parse,stringify}=await import('yaml');
 const variable='MOTE_SYNTHETIC_CONFIG_REFERENCE',previous=process.env[variable];process.env[variable]='synthetic-reference-value-never-materialize';
 t.after(()=>{if(previous===undefined)delete process.env[variable];else process.env[variable]=previous;});
 const node=await fixture(t,async settings=>({configured:true,query:async()=>answer(settings.model),close:async()=>{}})),path=join(node.directory,'mote.yaml'),doc=parse(await readFile(path,'utf8'));
 const referenced={...node.modelSettings.current(),apiKey:'${MOTE_SYNTHETIC_CONFIG_REFERENCE}',headers:{Authorization:'Bearer ${MOTE_SYNTHETIC_CONFIG_REFERENCE}'},extraBody:{vendor_options:{credential:'${MOTE_SYNTHETIC_CONFIG_REFERENCE}'}}};
 doc.models.deployment=structuredClone(referenced);doc.models.profiles=[{id:'first',name:'First fixture',settings:structuredClone(referenced)},{id:'second',name:'Second fixture',settings:structuredClone(referenced)}];
 await writeFile(path,stringify(doc));await node.configService.reload();
 let view=node.modelSettings.view();const removed=await node.app.inject({method:'DELETE',url:'/api/model-settings/profiles/first',headers,payload:{revision:view.revision}});assert.equal(removed.statusCode,200,removed.body);view=removed.json();
 const {apiKey:_key,headers:_headers,extraBody:_body,...parameters}=node.modelSettings.select('chat','second').settings;
 const renamed=await node.app.inject({method:'PUT',url:'/api/model-settings/profiles/second',headers,payload:{revision:view.revision,name:'Renamed fixture',settings:parameters}});assert.equal(renamed.statusCode,200,renamed.body);
 const disk=await readFile(path,'utf8');assert.equal(disk.includes(process.env[variable]!),false);const saved=parse(disk);assert.equal(saved.models.profiles[0].id,'second');assert.equal(saved.models.profiles[0].settings.apiKey,'${MOTE_SYNTHETIC_CONFIG_REFERENCE}');assert.equal(saved.models.profiles[0].settings.headers.Authorization,'Bearer ${MOTE_SYNTHETIC_CONFIG_REFERENCE}');assert.equal(saved.models.profiles[0].settings.extraBody.vendor_options.credential,'${MOTE_SYNTHETIC_CONFIG_REFERENCE}');
 assert.equal(renamed.body.includes(process.env[variable]!),false);
});

test('the normal file watcher reloads models while old requests keep their generation and invalid edits keep the last valid model',async t=>{
 const {readFile,writeFile}=await import('node:fs/promises'),{parse,stringify}=await import('yaml');
 let release!:()=>void,started!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;}),closed:string[]=[];
 const node=await fixture(t,async settings=>({configured:true,query:async input=>{if(input.question==='hold file generation'){started();await held;}return answer(settings.model);},close:async()=>{closed.push(settings.model);}}));
 node.cleanup.beforeClose(release);
 const pending=node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'hold file generation'}});await began;
 const path=join(node.directory,'mote.yaml'),doc=parse(await readFile(path,'utf8'));doc.models.deployment.model='file-hot-model';await writeFile(path,stringify(doc));
 const waitFor=async(check:()=>boolean)=>{const until=Date.now()+5000;while(!check()){if(Date.now()>until)throw Error('Fixture configuration watcher did not settle');await new Promise(resolve=>setTimeout(resolve,20));}};
 await waitFor(()=>node.modelSettings.current().model==='file-hot-model');assert.equal((await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'new file generation'}})).json().answer,'file-hot-model');assert.equal(closed.includes('original-fixture'),false);
 const committed=await readFile(path,'utf8');await writeFile(path,committed);await new Promise(resolve=>setTimeout(resolve,350));assert.equal(node.modelSettings.view().revision,1,'identical self and external writes do not rebuild resources or advance revision');
 await writeFile(path,'version: 1\nrevision: 1\nmodels: [invalid]\n');await waitFor(()=>node.configService.view().lastError!==null);assert.equal(node.modelSettings.current().model,'file-hot-model');
 release();assert.equal((await pending).json().answer,'original-fixture');await new Promise(resolve=>setImmediate(resolve));assert.equal(closed.includes('original-fixture'),true);
});
