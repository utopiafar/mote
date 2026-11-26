import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelSettings, ModelSettingsInput } from '@mote/shared/models';
import { ModelSettingsError, ModelSettingsStore, modelDomainSchema, defaultModelDomain, type ModelSettingsStoreOptions } from '../src/model-settings.js';

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
import {ConfigService, type ConfigServiceOptions} from '../src/config-service.js';
import {parse,stringify} from 'yaml';
type FixtureOptions=Partial<Omit<ModelSettingsStoreOptions,'configService'>>&{environment?:ModelSettings;fileSystem?:ConfigServiceOptions['fileSystem']};
async function fixture(t: TestContext, overrides: FixtureOptions = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'mote-model-settings-fixture-')),path=join(directory,'mote.yaml');
  const prepared: ModelSettings[] = [], activated: ModelSettings[] = [], disposed: ModelSettings[] = [],probes:ModelSettings[]=[];
  const service=new ConfigService({path,initialDocument:{version:1,revision:0,models:{...defaultModelDomain(),deployment:overrides.environment??environment}},watch:false,fileSystem:overrides.fileSystem});
  service.register({id:'models',schema:modelDomainSchema,defaultValue:defaultModelDomain(),fields:['deployment.apiKey','deployment.headers','deployment.extraBody','profiles.*.settings.apiKey','profiles.*.settings.headers','profiles.*.settings.extraBody'].map(path=>({path,sensitive:true}))});
  const options: ModelSettingsStoreOptions = {
    configService:service,
    prepare: async settings => {prepared.push(settings);return {activate:()=>{activated.push(settings);},dispose:async()=>{disposed.push(settings);}};},
    probe: async settings => {probes.push(settings);return {ok:true,code:'ok',message:'synthetic-private-provider-message',durationMs:12.5};},
    ...(overrides.prepare?{prepare:overrides.prepare}:{}),...(overrides.probe?{probe:overrides.probe}:{}),
  };
  const store = new ModelSettingsStore(options);
  t.after(async()=>{await service.close();await store.close();await fs.rm(directory,{recursive:true,force:true});});
  const restart=async()=>{
    const configService=new ConfigService({path,watch:false});configService.register({id:'models',schema:modelDomainSchema,defaultValue:defaultModelDomain()});
    const next=new ModelSettingsStore({...options,configService});await next.initialize();
    t.after(async()=>{await configService.close();await next.close();});return next;
  };
  return {directory,path,service,store,options,prepared,activated,disposed,probes,restart};
}

test('YAML deployment view hides secrets and returns detached snapshots', async t => {
  const f = await fixture(t), view = await f.store.initialize();
  assert.equal(view.source, 'file'); assert.equal(view.revision, 0); assert.equal(view.version, 1);
  assert.equal(view.settings.apiKeyConfigured, true); assert.equal(view.settings.headersConfigured, true); assert.equal(view.settings.extraBodyConfigured, true);
  const serialized = JSON.stringify(view);
  for (const secret of ['synthetic-private-api-key', 'synthetic-private-header', 'synthetic-private-parameter', 'vendor_options', 'X-Synthetic-Authorization']) assert.ok(!serialized.includes(secret));
  for (const field of ['apiKey', 'headers', 'extraBody']) assert.ok(!Object.hasOwn(view.settings, field));
  view.settings.model = 'changed-copy';
  const current = f.store.current(); current.headers['X-Synthetic-Authorization'] = 'changed-copy';
  (current.extraBody.vendor_options as Record<string, unknown>).credential = 'changed-copy';
  assert.deepEqual(f.store.current(), environment);
  assert.equal((await f.store.initialize()).settings.model, environment.model); assert.equal(f.activated.length, 1);
  assert.deepEqual(await fs.readdir(f.directory), ['mote.yaml']);
});

test('copying model credentials preserves their raw references without expanding literal expressions twice', async t => {
  const names=['MOTE_FIXTURE_COPY_KEY','MOTE_FIXTURE_COPY_LITERAL'], before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  t.after(()=>{for(const name of names){if(before[name]===undefined)delete process.env[name];else process.env[name]=before[name];}});
  process.env.MOTE_FIXTURE_COPY_KEY='synthetic-private-${MOTE_FIXTURE_COPY_LITERAL}-key';
  for(const other of [undefined,'unexpected-replacement']) {
    if(other===undefined)delete process.env.MOTE_FIXTURE_COPY_LITERAL;else process.env.MOTE_FIXTURE_COPY_LITERAL=other;
    const f=await fixture(t,{environment:{...environment,apiKey:'${MOTE_FIXTURE_COPY_KEY}',headers:{Authorization:'Bearer ${MOTE_FIXTURE_COPY_KEY}'},extraBody:{nested:{credential:'${MOTE_FIXTURE_COPY_KEY}'}}}});
    await f.store.initialize();
    await f.store.copyProfile('env:deployment',{revision:0,id:'copied',name:'Copied credentials'});
    await f.store.copyProfile('copied',{revision:1,id:'copied-again',name:'Copied again'});
    await f.store.update({revision:2,settings:{...input(f.store.current()),maxTokens:1000}});
    assert.equal(f.store.current().apiKey,process.env.MOTE_FIXTURE_COPY_KEY);
    assert.equal(f.store.select('chat','copied-again').settings.apiKey,process.env.MOTE_FIXTURE_COPY_KEY);
    assert.equal(f.store.select('chat','copied-again').settings.headers.Authorization,'Bearer '+process.env.MOTE_FIXTURE_COPY_KEY);
    const raw=parse(await fs.readFile(f.path,'utf8'));
    for(const profile of raw.models.profiles){assert.equal(profile.settings.apiKey,'${MOTE_FIXTURE_COPY_KEY}');assert.equal(profile.settings.headers.Authorization,'Bearer ${MOTE_FIXTURE_COPY_KEY}');assert.equal(profile.settings.extraBody.nested.credential,'${MOTE_FIXTURE_COPY_KEY}');}
    assert.ok(!JSON.stringify(f.store.view()).includes('synthetic-private'));
  }
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

test('profile changes persist privately in the sole YAML source and survive restart', async t => {
  const f = await fixture(t); await f.store.initialize();
  const view = await f.store.update({ revision: 0, settings: { ...input(), model: 'synthetic-new-model' } });
  assert.equal(view.source, 'file'); assert.equal(view.revision, 1); assert.equal(f.activated.length, 2);
  assert.equal((await fs.stat(f.path)).mode & 0o777, 0o600);
  assert.equal(f.disposed.length, 0, 'Old active runtimes remain owned by the query coordinator');
  const saved = parse(await fs.readFile(f.path, 'utf8'));
  assert.equal(saved.version, 1); assert.equal(saved.revision, 1); assert.equal(saved.models.profiles.find((profile:any)=>profile.id==='primary').settings.apiKey, environment.apiKey);
  const restart = await f.restart();
  t.after(() => restart.close());
  const restartedView=await restart.initialize();
  assert.deepEqual(restartedView.settings,JSON.parse(JSON.stringify(view.settings)));
  assert.deepEqual(restartedView.profiles?.find(p=>p.id==='primary'),JSON.parse(JSON.stringify(view.profiles?.find(p=>p.id==='primary'))));
  assert.equal(restartedView.profiles?.find(p=>p.readOnly)?.settings.model,environment.model);
  assert.equal(restart.current().apiKey, environment.apiKey);
  await f.store.close(); assert.equal(f.disposed.length, 0, 'Store close does not cancel active requests');
});

test('Codex saves catalog effort levels while HTTP profiles retain their existing choices',async t=>{
  const f=await fixture(t);await f.store.initialize();
  await assert.rejects(f.store.update({revision:0,settings:{...input(),reasoningEffort:'ultra'}}),errorCode('model_settings_invalid'));
  const view=await f.store.update({revision:0,settings:{...input(),provider:'codex',protocol:'codex-app-server',serviceTier:'default',baseUrl:'',model:'fixture',reasoningEffort:'ultra',modelRequestTimeoutMs:null,agentTimeoutMs:null,apiKey:null,headers:null,extraBody:null}});
  assert.equal(view.settings.reasoningEffort,'ultra');
  assert.equal(f.store.current().reasoningEffort,'ultra');
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
  assert.equal(parse(await fs.readFile(f.path, 'utf8')).models.profiles.find((profile:any)=>profile.id==='primary').settings.model, 'first-synthetic-model');
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
  assert.deepEqual(f.store.current(), { ...environment, provider: 'deepseek', contextWindow: undefined, apiKey: '', headers: {}, extraBody: {} });
  const replacement = { ...input(), baseUrl: 'https://replacement.example.invalid/v1', apiKey: 'replacement-synthetic-key', headers: { 'X-Synthetic-Key': 'replacement-synthetic-header' }, extraBody: { temperature: 0.2 } };
  await f.store.update({ revision: 1, settings: replacement });
  assert.deepEqual(f.store.current(), {...replacement,contextWindow:undefined});
});

test('test merges same-address drafts and returns fixed safe results without persisting or activating', async t => {
  const f = await fixture(t); await f.store.initialize();
  const result = await f.store.test({ revision: 0, settings: { ...input(), model: 'synthetic-draft-model' } });
  assert.deepEqual(result, { ok: true, code: 'ok', message: '模型连接及工具调用测试通过。', durationMs: 13 });
  assert.equal(f.probes[0].model, 'synthetic-draft-model'); assert.equal(f.probes[0].apiKey, environment.apiKey);
  assert.equal(f.store.view().revision, 0); assert.equal(f.store.view().source, 'file'); assert.deepEqual(await fs.readdir(f.directory), ['mote.yaml']);
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

test('HTTP model calls retain a transport timeout while the Agent may have no overall deadline',async t=>{
 const f=await fixture(t);await f.store.initialize();
 const saved=await f.store.update({revision:0,settings:{...input(),agentTimeoutMs:null}});
 assert.equal(saved.settings.agentTimeoutMs,null);assert.equal(saved.settings.modelRequestTimeoutMs,environment.modelRequestTimeoutMs);
 assert.equal((await f.restart()).current().agentTimeoutMs,null);
 await assert.rejects(f.store.update({revision:1,settings:{...input(),agentTimeoutMs:null,modelRequestTimeoutMs:null}}),errorCode('model_settings_invalid'));
});

test('Codex settings make the model request timeout inapplicable and allow an unset Agent deadline', async t => {
  const codex: ModelSettings = { ...environment, provider: 'codex', protocol: 'codex-app-server', serviceTier:'default', baseUrl: '', model: 'fixture-codex', apiKey: '', headers: {}, extraBody: {}, modelRequestTimeoutMs: null, agentTimeoutMs: null };
  const f = await fixture(t, { environment: codex });
  const view = await f.store.initialize();
  assert.equal(view.settings.modelRequestTimeoutMs, null); assert.equal(view.settings.agentTimeoutMs, null);
  await assert.rejects(f.store.update({ revision: 0, settings: { ...input(f.store.current()), modelRequestTimeoutMs: 600000 } }), errorCode('model_settings_invalid'));
  const saved = await f.store.update({ revision: 0, settings: { ...input(f.store.current()), agentTimeoutMs: 3600000 } });
  assert.equal(saved.settings.modelRequestTimeoutMs, null); assert.equal(saved.settings.agentTimeoutMs, 3600000);
});

test('failed rename retains old state, disposes candidate, removes temporary file and permits retry', async t => {
  let fail = false;
  const f = await fixture(t, { fileSystem: { rename: async (...args) => { if (fail) throw new Error('synthetic-private-filesystem-error'); await fs.rename(...args); } } });
  await f.store.initialize();fail=true;
  const body = { revision: 0, settings: { ...input(), model: 'pending-synthetic-model' } };
  await assert.rejects(f.store.update(body), errorCode('model_settings_save_failed'));
  assert.deepEqual(f.store.current(), environment); assert.equal(f.activated.length, 1); assert.equal(f.disposed.length, 1);
  assert.deepEqual(await fs.readdir(f.directory), ['mote.yaml']);
  fail = false; assert.equal((await f.store.update(body)).revision, 1);
});

test('failed runtime preparation leaves existing configuration and file untouched', async t => {
  const f = await fixture(t); await f.store.initialize();
  const original=await fs.readFile(f.path,'utf8');f.options.prepare = async () => { throw new Error('synthetic-private-initialization-error'); };
  await assert.rejects(f.store.update({ revision: 0, settings: input() }), errorCode('model_settings_prepare_failed'));
  assert.equal(f.store.view().revision, 0); assert.equal(await fs.readFile(f.path,'utf8'),original);
});

test('post-rename directory sync failure adopts confirmed new disk state without disposing active candidate', async t => {
  let fail = false, directory = '';
  const f = await fixture(t, { fileSystem: { open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[0] === directory && fail) handle.sync = async () => { throw new Error('synthetic-private-sync-error'); };
    return handle;
  } } });
  directory = f.directory; await f.store.initialize();fail=true;
  await assert.rejects(f.store.update({ revision: 0, settings: { ...input(), model: 'committed-synthetic-model' } }), errorCode('model_settings_commit_uncertain'));
  assert.equal(f.store.view().revision, 1); assert.equal(f.store.current().model, 'committed-synthetic-model');
  assert.equal(f.activated.length, 2); assert.equal(f.disposed.length, 0);
  assert.equal(parse(await fs.readFile(f.path, 'utf8')).models.profiles.find((profile:any)=>profile.id==='primary').settings.model, f.store.current().model);
  await assert.rejects(f.store.update({ revision: 0, settings: input() }), errorCode('model_settings_conflict'));
  fail = false; assert.equal((await f.store.update({ revision: 1, settings: input() })).revision, 2);
});

test('rename acknowledgement failure reads back authority rather than overwriting a committed file', async t => {
  let fail=false;const f = await fixture(t, {fileSystem:{rename:async(...args)=>{await fs.rename(...args);if(fail)throw new Error('synthetic-private-rename-ack-error');}}});
  await f.store.initialize();fail=true;
  await assert.rejects(f.store.update({ revision: 0, settings: { ...input(), model: 'committed-after-rename' } }), errorCode('model_settings_commit_uncertain'));
  assert.equal(f.store.current().model, 'committed-after-rename'); assert.equal(f.store.view().revision, 1);
  assert.equal(f.disposed.length, 0);
});

test('reset write failure keeps saved credentials and revision rather than prematurely applying environment', async t => {
  let fail = false;
  const f = await fixture(t, { fileSystem: { rename: async (...args) => { if (fail) throw new Error('synthetic-private-write-error'); await fs.rename(...args); } } });
  await f.store.initialize();
  await f.store.update({ revision: 0, settings: { ...input(), apiKey: 'saved-synthetic-secret' } });
  fail = true; await assert.rejects(f.store.reset({ revision: 1 }), errorCode('model_settings_save_failed'));
  assert.equal(f.store.view().revision, 1); assert.equal(f.store.view().source, 'file'); assert.equal(f.store.current().apiKey, 'saved-synthetic-secret');
  assert.equal(parse(await fs.readFile(f.path, 'utf8')).models.profiles.find((profile:any)=>profile.id==='primary').settings.apiKey, 'saved-synthetic-secret');
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



test('reset restores the deployment saved in YAML without consulting the old JSON file',async t=>{
 const f=await fixture(t);await f.store.initialize();await f.store.update({revision:0,settings:{...input(),model:'saved-synthetic-model'}});
 await fs.writeFile(join(f.directory,'model-settings.json'),JSON.stringify({version:2,revision:999,profiles:[]}));
 const reset=await f.store.reset({revision:1});assert.equal(reset.revision,2);assert.deepEqual(f.store.current(),environment);
 const restarted=await f.restart();assert.equal(restarted.view().revision,2);assert.deepEqual(restarted.current(),environment);
});

test('external YAML updates prepare resources once, preserve the last valid model on failure and deduplicate',async t=>{
 const f=await fixture(t);await f.store.initialize();const original=f.store.current(),doc=parse(await fs.readFile(f.path,'utf8'));
 doc.models.deployment.model='file-edited-model';await fs.writeFile(f.path,stringify(doc));await f.service.reload();
 assert.equal(f.store.current().model,'file-edited-model');assert.equal(f.store.view().revision,1);assert.equal(f.activated.length,2);
 await f.service.reload();assert.equal(f.activated.length,2);
 doc.models.deployment.apiKey='private-invalid\ncredential';await fs.writeFile(f.path,stringify(doc));await assert.rejects(f.service.reload(),{code:'config_invalid'});
 assert.equal(f.store.current().model,'file-edited-model');assert.equal(f.store.view().revision,1);assert.equal(f.activated.length,2);
 assert.equal(JSON.stringify(f.service.view()).includes(original.apiKey),false);
});

test('complete registry replacement clears model overrides and removes advanced credential keys',async t=>{
 const f=await fixture(t);let view=await f.store.initialize();
 view=await f.store.update({revision:view.revision,settings:{...input(),headers:{'X-Remove':'synthetic-profile-header','X-Keep':'retained'},extraBody:{remove:'synthetic-profile-body',keep:0.2}}});
 view=await f.store.updateDefaults({revision:view.revision,defaults:view.defaults,defaultModels:{chat:'temporary-feature-model',memory:'temporary-memory-model'}});
 assert.equal(f.store.current().model,'temporary-feature-model');
 view=await f.store.updateDefaults({revision:view.revision,defaults:view.defaults,defaultModels:{}});
 assert.equal(f.store.current().model,environment.model);assert.deepEqual(view.defaultModels,{});
 view=await f.store.updateProfile('primary',{revision:view.revision,name:'Trim advanced credentials',settings:{...input(),headers:{'X-Keep':'retained'},extraBody:{keep:0.2}}});
 assert.deepEqual(f.store.select('chat','primary').settings.headers,{'X-Keep':'retained'});assert.deepEqual(f.store.select('chat','primary').settings.extraBody,{keep:0.2});
 const disk=await fs.readFile(f.path,'utf8');assert.equal(disk.includes('synthetic-profile-header'),false);assert.equal(disk.includes('synthetic-profile-body'),false);
});

test('Codex speed presets survive YAML restart and probes while HTTP and unknown tiers remain invalid',async t=>{
 const codex:ModelSettings={...environment,provider:'codex',protocol:'codex-app-server',serviceTier:'default',baseUrl:'',apiKey:'',headers:{},extraBody:{},modelRequestTimeoutMs:null,agentTimeoutMs:null};
 const f=await fixture(t,{environment:codex});assert.equal((await f.store.initialize()).settings.serviceTier,'default');
 const fast={...input(codex),serviceTier:'fast'};const view=await f.store.updateProfile('fast',{revision:0,name:'Fast fixture',settings:fast});
 assert.equal(view.profiles?.find(profile=>profile.id==='fast')?.settings.serviceTier,'fast');await f.store.test({revision:view.revision,settings:fast},'fast');assert.equal(f.probes.at(-1)?.serviceTier,'fast');
 const restart=await f.restart();assert.equal(restart.select('memory','fast').settings.serviceTier,'fast');
 const standard=await restart.updateProfile('fast',{revision:view.revision,name:'Standard fixture',settings:{...fast,serviceTier:'default'}});assert.equal(standard.profiles?.find(profile=>profile.id==='fast')?.settings.serviceTier,'default');
 for(const settings of [{...fast,serviceTier:'ultrafast'},{...input(),serviceTier:'fast'},{...input(),serviceTier:'default'}])await assert.rejects(restart.updateProfile('bad',{revision:standard.revision,name:'Invalid fixture',settings}),errorCode('model_settings_invalid'));
});
