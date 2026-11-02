import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {runtimeProfileSchema, runtimeSettingsSchema} from '@mote/shared/agent-runtimes';
import {publicRunSelection, resolveRunSelection} from '@mote/agent/runtime/profile';
import {resolveFeatureRunSelection, validateAgentRuntimeSettings} from '../../../apps/server/src/agent-runtime-settings.ts';

const features = ['chat', 'memory', 'insight', 'import', 'file'];
const instance = id => ({packageId: id, installationId: `generated-install-${id}`, instanceId: 'primary'});
const binding = id => ({service: {id: 'mote.agent.runtime', apiVersion: '1'}, revision: 3,
  provider: {scope: {...instance(id), host: {kind: 'central', id: 'generated-host'}, activationId: 'activation-a'}, contributionId: 'runtime'}});
const reference = value => ({service: value.service, revision: value.revision,
  provider: {instance: (({packageId, installationId, instanceId}) => ({packageId, installationId, instanceId}))(value.provider.scope), contributionId: value.provider.contributionId}});
function provider(id, transport = 'openai-responses') {
  return {id, binding: binding(id), availability: {state: 'active'}, capabilities: {
    modelTransports: [transport], taskKinds: ['query', 'import'], tools: true, images: true, importWorkspace: true,
    hostDelegation: true, recovery: 'none', replacement: 'restart',
  }};
}
function profile(value) {
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
  const runtime = provider('generated.dsh');
  const configuration = {schemaVersion: 1, revision: 10, profiles: [profile(runtime)],
    assignments: Object.fromEntries(features.map(feature => [feature, `profile-${runtime.id}`]))};
  const context = {models: [model()], modelDefaults: Object.fromEntries(features.map(feature => [feature, 'generated-http'])),
    providers: [runtime], installedModules: [], requirements: Object.fromEntries(features.map(feature => [feature,
      {taskKind: feature === 'import' ? 'import' : 'query', capabilities: feature === 'import' ? ['tools', 'importWorkspace'] : ['tools']}]))};
  return {configuration, context};
}
const select = ({configuration, context}, feature = 'chat') => resolveFeatureRunSelection(configuration, feature, context);
const code = expected => error => error?.code === expected && error.message === expected;

test('explicit runtime/model choices accept supported HTTP and App Server pairs and reject both cross-pairs', () => {
  const f = fixture(), http = select(f);
  assert.equal(http.runtime.runtimeId, 'generated.dsh');
  assert.equal(http.receipt.modelProfileId, 'generated-http');
  assert.equal(http.modelSelection.profileRevision, 7);
  const codex = provider('generated.codex', 'codex-app-server');
  f.context.providers.push(codex); f.configuration.profiles.push(profile(codex)); f.context.models.push(model('generated-login', 'codex-app-server'));
  f.configuration.assignments.chat = `profile-${codex.id}`;
  assert.throws(() => select(f), code('incompatible_runtime_model'));
  f.context.modelDefaults.chat = 'generated-login';
  assert.equal(select(f).runtime.runtimeId, 'generated.codex');
  f.configuration.assignments.chat = 'profile-generated.dsh';
  assert.throws(() => select(f), code('incompatible_runtime_model'));
});

test('a third runtime is selected from its binding/capabilities without a protocol-to-engine branch', () => {
  const f = fixture(), first = select(f), alternate = provider('generated.alternate');
  f.context.providers.push(alternate); f.configuration.profiles.push(profile(alternate));
  f.configuration.assignments.chat = `profile-${alternate.id}`;
  const second = select(f);
  assert.equal(second.runtime.runtimeId, alternate.id);
  assert.equal(second.modelFingerprint, first.modelFingerprint);
  assert.notEqual(second.runtimeFingerprint, first.runtimeFingerprint);
  f.context.defaultModels = {chat: 'generated-other-model'};
  f.context.modelVariants = [{profileId: 'generated-http', profileRevision: 7, modelId: 'generated-other-model',
    modelRevision: 3, capabilities: {tools: true, images: true}}];
  const third = select(f);
  assert.equal(third.runtimeFingerprint, second.runtimeFingerprint);
  assert.notEqual(third.modelFingerprint, second.modelFingerprint);
});

test('shared-profile model overrides use exact effective tools/images facts and model revision', () => {
  const f = fixture();
  f.context.defaultModels = Object.fromEntries(features.map(feature => [feature, 'generated-vision']));
  f.context.defaultModels.chat = 'generated-text';
  f.context.modelVariants = [
    {profileId: 'generated-http', profileRevision: 7, modelId: 'generated-text', modelRevision: 11, capabilities: {tools: false, images: false}},
    {profileId: 'generated-http', profileRevision: 7, modelId: 'generated-vision', modelRevision: 12, capabilities: {tools: true, images: true}},
  ];
  f.context.requirements.chat.capabilities = ['images'];
  f.context.requirements.insight.capabilities = ['images'];
  assert.throws(() => validateAgentRuntimeSettings(f.configuration, f.context), code('runtime_capability_missing'));
  assert.throws(() => select(f), code('runtime_capability_missing'));
  const vision = select(f, 'insight');
  assert.equal(vision.receipt.modelRevision, 12);
  assert.equal(vision.modelSelection.modelRevision, 12);
  assert.equal(vision.model.profile.id, 'generated-http');
  assert.equal(vision.model.profile.settings.model, 'generated-vision');
  f.context.requirements.chat.capabilities = ['hostDelegation'];
  assert.equal(validateAgentRuntimeSettings(f.configuration, f.context).profiles.length, 1);
  assert.equal(select(f).modelSelection.modelRevision, 11);
  f.context.requirements.chat.capabilities = ['tools'];
  assert.throws(() => validateAgentRuntimeSettings(f.configuration, f.context), code('runtime_capability_missing'));
  assert.throws(() => select(f), code('runtime_capability_missing'));
  f.context.defaultModels.chat = 'generated-vision';
  f.context.requirements.chat.capabilities = ['tools', 'images'];
  f.context.models[0].capabilities = {tools: false, images: false};
  assert.equal(validateAgentRuntimeSettings(f.configuration, f.context).profiles.length, 1);
  assert.equal(select(f).model.capabilities.images, true);
  assert.equal(select(f).model.capabilities.tools, true);
  assert.equal(f.context.models[0].profile.settings.model, 'generated-model', 'base profile remains unchanged');
});

test('missing, ambiguous or stale effective-model facts never fall back to the base model', () => {
  const f = fixture(); f.context.defaultModels = {chat: 'generated-override'};
  for (const resolve of [() => select(f), () => validateAgentRuntimeSettings(f.configuration, f.context)]) {
    assert.throws(resolve, code('model_capabilities_unavailable'));
  }
  const facts = {profileId: 'generated-http', profileRevision: 7, modelId: 'generated-override', modelRevision: 13, capabilities: {tools: true, images: true}};
  f.context.modelVariants = [{...facts, profileRevision: 6}];
  assert.throws(() => select(f), code('model_capabilities_unavailable'));
  assert.throws(() => validateAgentRuntimeSettings(f.configuration, f.context), code('model_capabilities_unavailable'));
  f.context.modelVariants = [facts, structuredClone(facts)];
  assert.throws(() => select(f), code('runtime_settings_invalid'));
  assert.throws(() => validateAgentRuntimeSettings(f.configuration, f.context), code('runtime_settings_invalid'));
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
  f.context.providers.push(codex); f.configuration.profiles.push(profile(codex));
  assert.equal(validateAgentRuntimeSettings(JSON.parse(JSON.stringify(f.configuration)), f.context).profiles.length, 2);
  codex.availability = {state: 'unavailable', reason: 'dependency_unavailable'};
  assert.equal(validateAgentRuntimeSettings(f.configuration, f.context).profiles.length, 2);
  f.configuration.assignments.chat = `profile-${codex.id}`;
  f.context.models.push(model('generated-login', 'codex-app-server')); f.context.modelDefaults.chat = 'generated-login';
  assert.equal(validateAgentRuntimeSettings(f.configuration, f.context).profiles.length, 2);
  assert.throws(() => select(f), code('runtime_provider_unavailable'));
});

test('runtime configuration can be saved before a model ID is configured, while a new run is blocked', () => {
  const f = fixture(); f.context.models[0].profile.settings.model = '';
  assert.equal(validateAgentRuntimeSettings(f.configuration, f.context).profiles.length, 1);
  assert.throws(() => select(f), code('model_not_configured'));
});

test('missing/ambiguous bindings, model references and native artifact changes fail explicitly', () => {
  const f = fixture();
  f.context.providers = []; assert.throws(() => select(f), code('runtime_provider_missing'));
  f.context.providers = [provider('generated.dsh'), provider('generated.dsh')];
  assert.throws(() => select(f), code('runtime_binding_stale'));
  f.context.providers.pop(); f.context.modelDefaults.chat = 'missing';
  assert.throws(() => select(f), code('model_profile_missing'));
  f.context.modelDefaults.chat = 'generated-http';
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
    assert.throws(() => validateAgentRuntimeSettings(f.configuration, f.context), error => code('runtime_settings_invalid')(error) && !error.message.includes(privateValue));
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
  f.context.launches = {'profile-generated.dsh': {executable: '/generated/operator/runtime', home: '/generated/operator/private-home'}};
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
import {publicRunSelection, type RuntimeProfileConfiguration} from '@mote/agent/runtime/profile';
import {resolveFeatureRunSelection} from '${join(root, 'apps/server/src/agent-runtime-settings.js')}';
declare const selected: ReturnType<typeof resolveFeatureRunSelection>;
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
