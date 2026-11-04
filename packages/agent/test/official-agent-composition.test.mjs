import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_OFFICIAL_RUNTIME,
  DSH_OFFICIAL_RUNTIME,
  OFFICIAL_AGENT_COMPOSITION_VERSION,
  OFFICIAL_AGENT_CONTRIBUTIONS,
  OfficialCompositionUnavailableError,
  createImportAgent,
  createOfficialAgent,
  resolveOfficialAgentComposition,
} from '../dist/index.js';

const ids = OFFICIAL_AGENT_CONTRIBUTIONS.map(contribution => contribution.id);
const reader = {
  search: async () => [], timeline: async () => ({items: [], nextCursor: null}), evidence: async () => [],
  activity: async () => ({}), devices: async () => [],
};

test('the official composition declares the complete base dependency graph', () => {
  assert.equal(OFFICIAL_AGENT_COMPOSITION_VERSION, '1.0.0');
  assert.equal(new Set(ids).size, ids.length, 'contribution ids must be unique');
  const declared = new Set(ids);
  for (const contribution of OFFICIAL_AGENT_CONTRIBUTIONS) {
    assert.ok(contribution.version, `${contribution.id} has no version`);
    for (const dependency of contribution.requires) {
      assert.ok(declared.has(dependency), `${contribution.id} requires an undeclared dependency: ${dependency}`);
    }
  }
  // Exact-cycle detection: a dependency chain may not return to its origin.
  const visit = (id, chain) => {
    assert.ok(!chain.includes(id), `official dependency cycle: ${[...chain, id].join(' -> ')}`);
    const contribution = OFFICIAL_AGENT_CONTRIBUTIONS.find(value => value.id === id);
    for (const dependency of contribution?.requires ?? []) visit(dependency, [...chain, id]);
  };
  for (const id of ids) visit(id, []);

  const resolved = resolveOfficialAgentComposition();
  assert.equal(resolved.available, true);
  assert.deepEqual(resolved.contributions.map(contribution => contribution.id), ids);
  assert.deepEqual(resolved.runtimes.map(runtime => runtime.id), ['mote.runtime.dsh', 'mote.runtime.codex']);
  assert.deepEqual(new Set(resolved.runtimes.flatMap(runtime => runtime.capabilities.modelTransports)),
    new Set(['deepseek', 'openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'codex-app-server']));
  assert.equal(DSH_OFFICIAL_RUNTIME.capabilities.hostDelegation, true);
  assert.equal(CODEX_OFFICIAL_RUNTIME.capabilities.nativeDelegation, false);

  for (const id of ['host.output', 'host.usage', 'host.privacy', 'model.adapters', 'runtime.dsh', 'runtime.codex',
    'tools.official', 'tasks.official', 'skills.official', 'import.capabilities', 'host.delegation']) {
    assert.ok(ids.includes(id), `missing official base contribution: ${id}`);
  }
});

test('removing any one base contribution reports unavailable without falling back', () => {
  for (const removed of ids) {
    const available = ids.filter(id => id !== removed);
    const resolution = resolveOfficialAgentComposition({available});
    assert.equal(resolution.available, false, `${removed} must not resolve as available`);
    assert.equal(resolution.code, 'official_composition_unavailable');
    assert.ok(resolution.missing.includes(removed), `${removed} must be named as the missing dependency`);
    assert.equal('contributions' in resolution, false);
    assert.equal('runtimes' in resolution, false);

    // Exercise the real public creation entry, not only the pure resolver.
    assert.throws(
      () => createOfficialAgent({reader, protocol: 'deepseek', model: 'generated-model', apiKey: 'generated-key', baseUrl: 'http://127.0.0.1:9/v1'}, {available}),
      error => error instanceof OfficialCompositionUnavailableError &&
        error.code === 'official_composition_unavailable' && error.missing.includes(removed),
      `${removed} removal must fail the real composition instead of selecting a built-in path`,
    );
    if (removed === 'import.capabilities') {
      assert.throws(
        () => createImportAgent({model: 'generated-model', apiKey: 'generated-key'}, undefined, {available}),
        error => error instanceof OfficialCompositionUnavailableError && error.missing.includes(removed),
        'the official import facade must not fall back to a private capability registry',
      );
    }
  }
});

test('an unknown or incomplete selection is unavailable', () => {
  const unknown = resolveOfficialAgentComposition({available: [...ids, 'runtime.legacy']});
  assert.equal(unknown.available, false);
  assert.ok(unknown.missing.includes('runtime.legacy'));

  const missingRequirement = resolveOfficialAgentComposition({available: ids.filter(id => id !== 'tasks.official' && id !== 'runtime.dsh')});
  assert.equal(missingRequirement.available, false);
  assert.ok(missingRequirement.missing.includes('tasks.official'));
});

test('runtime selection follows declared model transports rather than a protocol branch', () => {
  const dshOnly = ids.filter(id => id !== 'runtime.codex');
  assert.throws(() => createOfficialAgent({reader, protocol: 'openai-completions', model: 'generated', apiKey: 'generated', baseUrl: 'http://127.0.0.1:9/v1'}, {available: dshOnly}),
    error => error instanceof OfficialCompositionUnavailableError && error.missing.includes('runtime.codex'),
    'the complete official composition is required even when the current transport matches one runtime');

  const codex = createOfficialAgent({reader, protocol: 'codex-app-server'});
  assert.equal(codex.configured, false);
  return codex.close();
});
