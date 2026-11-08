import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {runtimeProfileSchema, runtimeSettingsSchema} from '@mote/shared/agent-runtimes';
import {publicRunSelection, resolveRunSelection, resolveRuntimeProfileReference, validateRuntimeModelPair} from '@mote/agent/runtime/profile';

const features = ['chat', 'memory', 'insight', 'import', 'file'];
const instance = id => ({packageId: id, installationId: `generated-install-${id}`, instanceId: 'primary'});
const binding = id => ({service: {id: 'mote.agent.runtime', apiVersion: '1'}, revision: 3,
  provider: {scope: {...instance(id), host: {kind: 'central', id: 'generated-host'}, activationId: 'activation-a'}, contributionId: 'runtime'}});
const reference = value => ({service: value.service, revision: value.revision,
  provider: {instance: (({packageId, installationId, instanceId}) => ({packageId, installationId, instanceId}))(value.provider.scope), contributionId: value.provider.contributionId}});
function provider(id, transport = 'openai-responses') {
  return {id, binding: binding(id), availability: {state: 'active'}, capabilities: {
    modelTransports: [transport], taskKinds: ['query', 'import'], tools: true, images: true, importWorkspace: true,
    hostDelegation: true, nativeDelegation: false, recovery: 'none', replacement: 'restart',
  }};
}
function runtimeProfile(value) {
  return {id: `profile-${value.id}`, name: 'Generated runtime', revision: 4, runtimeProviderId: value.id,
    providerRef: reference(value.binding), assembly: {packages: [], hooks: []},
    allowedHostCapabilities: ['tools', 'images', 'importWorkspace', 'hostDelegation']};
}
function model(id = 'generated-http', protocol = 'openai-responses') {
  return {profile: {id, name: 'Generated model', settings: {
    provider: protocol === 'codex-app-server' ? 'codex' : 'custom', protocol, model: 'generated-model',
    baseUrl: protocol === 'codex-app-server' ? '' : 'http://127.0.0.1:54321/v1',
    apiKey: protocol === 'codex-app-server' ? '' : 'generated-private-key', headers: {}, extraBody: {},
    reasoningEffort: 'auto', maxTokens: 65536, modelRequestTimeoutMs: protocol === 'codex-app-server' ? null : 300000,
    agentTimeoutMs: null, allowUnauthenticatedLocal: false, ...(protocol === 'codex-app-server' ? {serviceTier: 'default'} : {}),
  }}, profileRevision: 7, modelRevision: 2, connectionFingerprint: 'a'.repeat(64), capabilities: {tools: true, images: true}};
}
function fixture() {
  const runtime = provider('generated.dsh'), profile = runtimeProfile(runtime), selectedModel = model();
  const configuration = {schemaVersion: 1, revision: 10, profiles: [profile],
    assignments: Object.fromEntries(features.map(feature => [feature, `profile-${runtime.id}`]))};
  const requirements = Object.fromEntries(features.map(feature => [feature,
    {taskKind: feature === 'import' ? 'import' : 'query', capabilities: feature === 'import' ? ['tools', 'importWorkspace'] : ['tools']}]));
  const context = {models: [selectedModel], modelDefaults: Object.fromEntries(features.map(feature => [feature, 'generated-http'])),
    providers: [runtime], installedModules: [], requirements};
  const selection = {revision: configuration.revision, profile, model: selectedModel,
    providers: context.providers, installedModules: context.installedModules};
  return {configuration, context, selection};
}
// Current-run selection receives the already resolved runtime profile and exact
// effective model facts. Feature assignment and model-default lookup belong to
// configuration, not to resolveRunSelection.
const select = (f, feature = 'chat') => resolveRunSelection({...f.selection, requirements: f.context.requirements[feature]});
const code = expected => error => error?.code === expected && error.message === expected;

test('explicit runtime/model choices accept supported HTTP and App Server pairs and reject both cross-pairs', () => {
  const f = fixture(), http = select(f);
  assert.equal(http.runtime.runtimeId, 'generated.dsh');
  assert.equal(http.receipt.modelProfileId, 'generated-http');
  assert.equal(http.modelSelection.profileRevision, 7);
  const codex = provider('generated.codex', 'codex-app-server');
  f.context.providers.push(codex); f.configuration.profiles.push(runtimeProfile(codex)); f.context.models.push(model('generated-login', 'codex-app-server'));
  f.selection.profile = f.configuration.profiles.at(-1);
  assert.throws(() => select(f), code('incompatible_runtime_model'));
  f.selection.model = f.context.models.at(-1);
  assert.equal(select(f).runtime.runtimeId, 'generated.codex');
  f.selection.profile = f.configuration.profiles[0];
  assert.throws(() => select(f), code('incompatible_runtime_model'));
});

test('a third runtime is selected from its binding/capabilities without a protocol-to-engine branch', () => {
  const f = fixture(), first = select(f), alternate = provider('generated.alternate');
  f.context.providers.push(alternate); f.configuration.profiles.push(runtimeProfile(alternate));
  f.selection.profile = f.configuration.profiles.at(-1);
  const second = select(f);
  assert.equal(second.runtime.runtimeId, alternate.id);
  assert.equal(second.modelFingerprint, first.modelFingerprint);
  assert.notEqual(second.runtimeFingerprint, first.runtimeFingerprint);
  const base = f.selection.model;
  f.selection.model = {...base, profile: {...base.profile, settings: {...base.profile.settings, model: 'generated-other-model'}}, modelRevision: 3};
  const third = select(f);
  assert.equal(third.runtimeFingerprint, second.runtimeFingerprint);
  assert.notEqual(third.modelFingerprint, second.modelFingerprint);
});

test('shared-profile model overrides use exact effective tools/images facts and model revision', () => {
  const f = fixture();
  const base = f.selection.model;
  const text = {...base, profile: {...base.profile, settings: {...base.profile.settings, model: 'generated-text'}}, modelRevision: 11, capabilities: {tools: false, images: false}};
  const vision = {...text, profile: {...base.profile, settings: {...base.profile.settings, model: 'generated-vision'}}, modelRevision: 12, capabilities: {tools: true, images: true}};
  f.context.requirements.chat.capabilities = ['images'];
  f.context.requirements.insight.capabilities = ['images'];
  f.selection.model = text;
  assert.throws(() => validateRuntimeModelPair({...f.selection, requirements: f.context.requirements.chat}), code('runtime_capability_missing'));
  assert.throws(() => select(f), code('runtime_capability_missing'));
  f.selection.model = vision;
  const selected = select(f, 'insight');
  assert.equal(selected.receipt.modelRevision, 12);
  assert.equal(selected.modelSelection.modelRevision, 12);
  assert.equal(selected.model.profile.id, 'generated-http');
  assert.equal(selected.model.profile.settings.model, 'generated-vision');
  f.context.requirements.chat.capabilities = ['hostDelegation'];
  f.selection.model = text;
  assert.doesNotThrow(() => validateRuntimeModelPair({...f.selection, requirements: f.context.requirements.chat}));
  assert.equal(select(f).modelSelection.modelRevision, 11);
  f.context.requirements.chat.capabilities = ['tools'];
  assert.throws(() => validateRuntimeModelPair({...f.selection, requirements: f.context.requirements.chat}), code('runtime_capability_missing'));
  assert.throws(() => select(f), code('runtime_capability_missing'));
  f.context.requirements.chat.capabilities = ['tools', 'images'];
  f.context.models[0].capabilities = {tools: false, images: false};
  f.selection.model = vision;
  assert.equal(select(f).model.capabilities.images, true);
  assert.equal(select(f).model.capabilities.tools, true);
  assert.equal(f.context.models[0].profile.settings.model, 'generated-model', 'the supplied base model/profile remains unchanged');
});

test('effective-model selection uses exactly the supplied facts and never falls back to the base model', () => {
  const f = fixture(), base = f.selection.model;
  const effective = {...base, profile: {...base.profile, settings: {...base.profile.settings, model: 'generated-override'}}, modelRevision: 13, capabilities: {tools: false, images: false}};
  f.selection.model = effective;
  f.context.requirements.chat.capabilities = [];
  const selected = select(f);
  assert.equal(selected.receipt.modelId, 'generated-override');
  assert.equal(selected.receipt.modelRevision, 13);
  assert.equal(selected.model.capabilities.tools, false);
  assert.equal(selected.model.capabilities.images, false);
  assert.equal(f.context.models[0].profile.settings.model, 'generated-model');
  assert.equal(f.context.models[0].modelRevision, 2);
});

test('exact persistent identities survive host recreation, reject reinstall/stale versions, and ignore registration order', () => {
  const f = fixture(), original = select(f), sibling = structuredClone(f.context.providers[0]);
  sibling.binding.provider.scope.instanceId = 'sibling';
  f.context.providers.unshift(sibling);
  assert.equal(select(f).runtime.binding.provider.scope.instanceId, 'primary');
  f.context.providers.reverse();
  assert.equal(select(f).runtime.binding.provider.scope.instanceId, 'primary');
  const chosen = f.context.providers.find(value => value.binding.provider.scope.instanceId === 'primary');
  chosen.binding.provider.scope.activationId = 'activation-b'; chosen.binding.provider.scope.host.id = 'recreated-host';
  const restarted = select(f);
  assert.equal(restarted.runtime.binding.provider.scope.activationId, 'activation-b');
  assert.equal(restarted.receipt.assemblyFingerprint, original.receipt.assemblyFingerprint);
  assert.equal(restarted.runtimeFingerprint, original.runtimeFingerprint);
  chosen.binding.provider.scope.installationId = 'reinstalled';
  assert.throws(() => select(f), code('runtime_binding_stale'));
  chosen.binding.provider.scope.installationId = instance('generated.dsh').installationId;
  f.configuration.profiles[0].providerRef.revision++;
  assert.throws(() => select(f), code('runtime_binding_stale'));
});

test('reference validation covers unused profiles without implicitly pairing them to the first model', () => {
  const f = fixture(), codex = provider('generated.unused-codex', 'codex-app-server');
  f.context.providers.push(codex); f.configuration.profiles.push(runtimeProfile(codex));
  const validate = () => resolveRuntimeProfileReference({profile: f.configuration.profiles.at(-1), providers: f.context.providers,
    installedModules: f.context.installedModules, requireAvailable: false});
  assert.equal(validate().profile.id, `profile-${codex.id}`);
  codex.availability = {state: 'unavailable', reason: 'dependency_unavailable'};
  assert.equal(validate().profile.id, `profile-${codex.id}`);
  f.selection.profile = f.configuration.profiles.at(-1);
  f.context.models.push(model('generated-login', 'codex-app-server')); f.selection.model = f.context.models.at(-1);
  assert.throws(() => select(f), code('runtime_provider_unavailable'));
});

test('runtime configuration can be saved before a model ID is configured, while a new run is blocked', () => {
  const f = fixture(); f.context.models[0].profile.settings.model = '';
  assert.doesNotThrow(() => validateRuntimeModelPair({...f.selection, requirements: f.context.requirements.chat}));
  assert.throws(() => select(f), code('model_not_configured'));
});

test('missing/ambiguous bindings and native artifact changes fail explicitly', () => {
  const f = fixture();
  f.context.providers.length = 0; assert.throws(() => select(f), code('runtime_provider_missing'));
  f.context.providers.push(provider('generated.dsh'), provider('generated.dsh'));
  assert.throws(() => select(f), code('runtime_binding_stale'));
  f.context.providers.pop();
  const native = {contribution: {instance: instance('generated.native'), contributionId: 'native-hook'}, revision: 2, artifactDigest: 'b'.repeat(64), exportName: 'apply'};
  f.configuration.profiles[0].assembly.hooks.push(native);
  assert.throws(() => select(f), code('runtime_module_unavailable'));
  f.context.installedModules.push(structuredClone(native));
  assert.equal(select(f).runtime.configuration.assembly.hooks.length, 1);
  f.context.installedModules[0].artifactDigest = 'c'.repeat(64);
  assert.throws(() => select(f), code('runtime_module_unavailable'));
  f.configuration.profiles[0].providerRef.service.apiVersion = '2';
  assert.throws(() => select(f), code('runtime_binding_stale'));
});

test('tools/images/import/task-control capabilities are structural requirements, not authority grants', () => {
  for (const capability of ['tools', 'images', 'importWorkspace', 'hostDelegation']) {
    const f = fixture(); f.context.requirements.chat.capabilities = [capability];
    f.context.providers[0].capabilities[capability] = false;
    assert.throws(() => select(f), code('runtime_capability_missing'));
    f.context.providers[0].capabilities[capability] = true;
    f.configuration.profiles[0].allowedHostCapabilities = [];
    assert.throws(() => select(f), code('runtime_capability_denied'));
  }
  for (const capability of ['tools', 'images']) {
    const f = fixture(); f.context.requirements.chat.capabilities = [capability]; f.context.models[0].capabilities[capability] = false;
    assert.throws(() => select(f), code('runtime_capability_missing'));
  }
  for (const capability of ['importWorkspace', 'hostDelegation']) {
    const f = fixture(); f.context.requirements.chat.capabilities = [capability]; f.context.models[0].capabilities.tools = false;
    f.context.models[0].capabilities.images = false;
    assert.equal(select(f).runtime.runtimeId, 'generated.dsh', 'Host-only requirements do not imply model tools/images');
    f.context.requirements.chat.capabilities = [capability, 'tools'];
    assert.throws(() => select(f), code('runtime_capability_missing'));
  }
  const invalid = fixture(); invalid.context.models[0].modelRevision = -1;
  assert.throws(() => select(invalid), code('runtime_settings_invalid'));
});

test('public configuration rejects launch/secret/path injection and invalid current-format references', () => {
  for (const key of ['executable', 'home', 'apiKey', 'secret', 'packagePath', 'configuration']) {
    const f = fixture(), privateValue = 'generated-private-do-not-echo';
    f.configuration.profiles[0][key] = privateValue;
    assert.equal(runtimeProfileSchema.safeParse(f.configuration.profiles[0]).success, false);
    assert.throws(() => select(f), error => code('runtime_settings_invalid')(error) && !error.message.includes(privateValue));
  }
  const f = fixture(); f.configuration.assignments.chat = 'missing';
  assert.equal(runtimeSettingsSchema.safeParse(f.configuration).success, false);
  f.configuration.assignments.chat = 'profile-generated.dsh'; f.configuration.profiles.push(structuredClone(f.configuration.profiles[0]));
  assert.equal(runtimeSettingsSchema.safeParse(f.configuration).success, false);
  const unsupported = fixture(); unsupported.configuration.schemaVersion = 2;
  assert.equal(runtimeSettingsSchema.safeParse(unsupported.configuration).success, false);
  const native = {contribution: {instance: instance('generated.native'), contributionId: 'native'}, revision: 1, artifactDigest: 'b'.repeat(64), exportName: '/tmp/arbitrary.mjs'};
  f.configuration.profiles.pop(); f.configuration.profiles[0].assembly.packages.push(native);
  assert.equal(runtimeSettingsSchema.safeParse(f.configuration).success, false);
});

test('secret/login/launch changes alter only internal identity and public receipt remains strictly projected', () => {
  const f = fixture(), first = select(f), safe = publicRunSelection(first);
  f.context.models[0].profile.settings.apiKey = 'generated-rotated-key';
  f.context.models[0].profile.settings.headers = {'X-Private': 'generated-secret-header'};
  f.context.models[0].profile.settings.extraBody = {privateParameter: 'generated-secret-body'};
  f.context.models[0].connectionFingerprint = 'd'.repeat(64);
  const changedModel = select(f);
  assert.notEqual(changedModel.modelFingerprint, first.modelFingerprint);
  assert.equal(changedModel.runtimeFingerprint, first.runtimeFingerprint);
  assert.deepEqual(publicRunSelection(changedModel), safe);
  f.selection.launch = {executable: '/generated/operator/runtime', home: '/generated/operator/private-home'};
  const changedLaunch = select(f);
  assert.notEqual(changedLaunch.runtimeFingerprint, changedModel.runtimeFingerprint);
  assert.equal(changedLaunch.modelFingerprint, changedModel.modelFingerprint);
  assert.deepEqual(publicRunSelection(changedLaunch), safe);
  const json = JSON.stringify(publicRunSelection(changedLaunch));
  for (const value of ['generated-rotated-key', 'secret-header', 'secret-body', '/generated/operator', 'runtimeFingerprint', 'modelFingerprint']) assert.ok(!json.includes(value));
  assert.equal(first.model.profile.settings.apiKey, 'generated-private-key');
  assert.throws(() => { first.model.profile.settings.apiKey = 'late mutation'; }, TypeError);
  assert.notEqual(changedLaunch.fingerprint, first.fingerprint);
});

test('actual A02 declarations feed the A01 RuntimeProvider consumer without public/private type leakage', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'mote-runtime-profile-types-'));
  try {
    await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
    const fixture = join(directory, 'consumer.mts');
    await writeFile(fixture, `
import type {RuntimeProvider, ModelLease, HostRunPort, RuntimeCapabilities as ProviderCapabilities} from '${join(root, 'packages/agent/dist/runtime/contracts.js')}';
import type {ServiceLease} from '@mote/plugin-api/contracts';
import type {RuntimeProfile, RuntimeCapabilities} from '@mote/shared/agent-runtimes';
import {publicRunSelection, resolveRunSelection, type RuntimeProfileConfiguration} from '@mote/agent/runtime/profile';
declare const selected: ReturnType<typeof resolveRunSelection>;
declare const provider: RuntimeProvider<RuntimeProfileConfiguration>;
declare const modelLease: ServiceLease<unknown>;
const model: ModelLease = {...modelLease, selection: selected.modelSelection};
declare const port: HostRunPort;
provider.prepare(selected.runtime, model, port);
declare const capabilities: ProviderCapabilities;
const declared: RuntimeCapabilities = capabilities;
declare const profile: RuntimeProfile;
// @ts-expect-error public profiles cannot carry launch paths
const injected: RuntimeProfile = {...profile, executable: '/arbitrary'};
const receipt = publicRunSelection(selected);
// @ts-expect-error private configuration identity is not a public field
receipt.modelFingerprint;
// @ts-expect-error model credentials are not in a public receipt
receipt.settings;
void declared; void injected;
`);
    const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
    const result = spawnSync(process.execPath, [compiler, '--noEmit', '--strict', '--skipLibCheck', '--pretty', 'false', '--types', 'node', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', fixture], {cwd: root, encoding: 'utf8', timeout: 60000});
    assert.ifError(result.error); assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
