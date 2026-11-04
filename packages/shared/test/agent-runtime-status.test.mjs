import test from 'node:test';
import assert from 'node:assert/strict';
import {agentRuntimeStatusReceiptSchema,agentRuntimeReadiness,agentRuntimeFeatureState} from '../dist/agent-runtime-status.js';

const settings = (model = 'generated-model') => ({
  provider: 'generated-provider', protocol: 'generated-protocol', baseUrl: 'https://fixture.invalid/v1',
  model, reasoningEffort: 'generated-effort', maxTokens: 4096,
  modelRequestTimeoutMs: 120000, agentTimeoutMs: 120000, allowUnauthenticatedLocal: false,
  apiKeyConfigured: false, headersConfigured: false, extraBodyConfigured: false,
});
const receipt = () => ({
  revision: 3,
  saved: {
    version: 1, revision: 3, source: 'file', settings: settings(),
    profiles: [{id: 'env:deployment', name: '部署配置', settings: settings(), readOnly: true, source: 'file'}],
    defaults: {chat: 'env:deployment', memory: 'env:deployment', insight: 'env:deployment', import: 'env:deployment', file: 'env:deployment'},
    defaultModels: {insight: 'generated-insight-model'},
  },
  features: {
    chat: {profileId: 'env:deployment', provider: 'generated-provider', model: 'generated-model', configured: true},
    memory: {profileId: 'env:deployment', provider: 'generated-provider', model: 'generated-model', configured: true},
    insight: {profileId: 'env:deployment', provider: 'generated-provider', model: 'generated-insight-model', configured: true},
    import: {profileId: 'env:deployment', provider: 'generated-provider', model: 'generated-model', configured: true},
    file: {profileId: 'env:deployment', provider: 'generated-provider', model: 'generated-model', configured: true},
    'transcribe-audio': {profileId: 'env:deployment', provider: 'future-runtime', model: 'generated-model', configured: false},
  },
  runtime: {
    closed: false, configured: true, generation: 2, activeRuns: 1,
    retiringGenerations: 1, releasedGenerations: 1, preparedGenerations: 0, closeErrors: 0,
    preparedAgents: 1, pendingPreparations: 0, pendingCleanupFailures: 0, shuttingDown: false,
  },
  configuration: {
    version: 1, revision: 3, configFile: '/private/tmp/mote-fixture/mote.yaml',
    domains: [{id: 'models', saved: {deployment: {apiKey: true}}, effective: {deployment: {apiKey: true}}, fields: [], status: 'applied'}],
    lastError: null,
    domain: {id: 'models', saved: {deployment: {apiKey: true}}, effective: {deployment: {apiKey: true}}, fields: [], status: 'applied'},
  },
});

test('one serialized receipt accepts unknown capability and runtime provider values for display', () => {
  const parsed = agentRuntimeStatusReceiptSchema.parse(receipt());
  assert.equal(parsed.features['transcribe-audio'].provider, 'future-runtime');
  assert.equal(agentRuntimeFeatureState(parsed, 'transcribe-audio'), 'unconfigured');
  assert.equal(agentRuntimeFeatureState(parsed, 'chat'), 'ready');
  assert.equal(agentRuntimeFeatureState(parsed, 'summarize-later'), 'unknown');
  assert.equal(agentRuntimeReadiness(parsed), 'ready');
});

test('readiness never projects ready without configured, applied state', () => {
  const closed = agentRuntimeStatusReceiptSchema.parse({...receipt(), runtime: {...receipt().runtime, closed: true}});
  assert.equal(agentRuntimeReadiness(closed), 'closed');
  const invalid = agentRuntimeStatusReceiptSchema.parse({...receipt(), configuration: {...receipt().configuration, domain: {...receipt().configuration.domain, status: 'invalid'}}});
  assert.equal(agentRuntimeReadiness(invalid), 'failed');
  const error = agentRuntimeStatusReceiptSchema.parse({...receipt(), configuration: {...receipt().configuration, lastError: {code: 'config_prepare_failed', domain: 'models'}}});
  assert.equal(agentRuntimeReadiness(error), 'failed');
  const restart = agentRuntimeStatusReceiptSchema.parse({...receipt(), configuration: {...receipt().configuration, domain: {...receipt().configuration.domain, status: 'restart-required'}}});
  assert.equal(agentRuntimeReadiness(restart), 'restart-pending');
  const unconfigured = agentRuntimeStatusReceiptSchema.parse({...receipt(), runtime: {...receipt().runtime, configured: false}});
  assert.equal(agentRuntimeReadiness(unconfigured), 'unconfigured');
  const missingDomain = agentRuntimeStatusReceiptSchema.parse({...receipt(), configuration: {...receipt().configuration, domain: undefined, domains: []}});
  assert.equal(agentRuntimeReadiness(missingDomain), 'failed', 'a missing models domain never projects ready');
});

test('secret, launch and path-shaped fields fail closed instead of entering the receipt', () => {
  for (const key of ['apiKey', 'headers', 'extraBody', 'executable', 'home', 'packagePath', 'secret', 'credential']) {
    const injected = receipt();
    injected.saved.settings[key] = 'generated-private-do-not-echo';
    assert.equal(agentRuntimeStatusReceiptSchema.safeParse(injected).success, false, key);
  }
  const pathProfile = receipt();
  pathProfile.features.chat.profileId = '/private/tmp/plugin/generated.mjs';
  assert.equal(agentRuntimeStatusReceiptSchema.safeParse(pathProfile).success, false);
  const launchSelection = receipt();
  launchSelection.features.chat.executable = '/private/tmp/agent';
  assert.equal(agentRuntimeStatusReceiptSchema.safeParse(launchSelection).success, false);
});

test('missing configured state and malformed revisions reject instead of faking ready or accepting a bad revision', () => {
  for (const mutate of [
    value => { delete value.features.chat.configured; },
    value => { value.features.chat.configured = 'yes'; },
    value => { value.revision = -1; },
    value => { value.revision = 1.5; },
    value => { value.revision = '3'; },
    value => { value.runtime.closed = 'no'; },
    value => { value.saved = null; },
    value => { delete value.configuration; },
  ]) {
    const candidate = receipt();
    mutate(candidate);
    assert.equal(agentRuntimeStatusReceiptSchema.safeParse(candidate).success, false);
  }
});
