import test from 'node:test';
import assert from 'node:assert/strict';
import {createDshRuntimeProvider} from '../dist/runtime/dsh/provider.js';
import {createCodexRuntimeProvider} from '../dist/runtime/codex/provider.js';
import {createRuntimePatch, DSH_NATIVE_DELEGATION_PLUGINS} from '../dist/runtime/dsh/profile-compiler.js';
import {CODEX_NATIVE_DELEGATION_FEATURES, codexAppServerConfig} from '../dist/runtime/codex/launch.js';
import {createDshHostChannel} from '../dist/runtime/dsh/context-plugin.js';

const definition = {
  name: 'delegation_submit', version: '1', fingerprint: 'a'.repeat(64),
  description: 'Generated Host delegation control', inputSchema: {type: 'object', properties: {}, additionalProperties: false},
};

function hostFixture() {
  const controller = new AbortController(), events = [];
  return {
    events, controller,
    host: {
      identity: {runId: 'generated-run'}, signal: controller.signal,
      assertCurrent() { controller.signal.throwIfAborted(); },
      emit(event, attempt) { events.push({event, attempt}); },
      tools: {definitions: [definition], async deliver() { throw Error('Generated Host delivery must not run'); }},
    },
  };
}

async function send(channel, path, body) {
  return fetch(channel.configuration.url + path, {
    method: 'POST', headers: {authorization: 'Bearer ' + channel.configuration.token, 'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
}

test('DSH and Codex descriptors disable native delegation and keep only the Host channel', async () => {
  for (const provider of [createDshRuntimeProvider(), createCodexRuntimeProvider()]) {
    try {
      assert.equal(provider.capabilities.nativeDelegation, false);
      assert.equal(provider.capabilities.hostDelegation, true);
    } finally { await provider.close(); }
  }
});

test('DSH runtime policy disables every native subagent and child-workflow producer', () => {
  const patch = JSON.parse(createRuntimePatch('/generated/public/context.mjs', 'generated-model', undefined, undefined, 1024));
  assert.ok(DSH_NATIVE_DELEGATION_PLUGINS.length > 0);
  for (const id of DSH_NATIVE_DELEGATION_PLUGINS) {
    assert.equal(patch.find(entry => entry.id === id)?.disabled, true, id);
    assert.equal(patch.flatMap(entry => entry.insert ?? []).some(entry => entry.id === id), false, id);
  }
  assert.ok(patch.some(entry => entry.insert?.some(item => item.id === 'mote-context')));
});

test('Codex App Server policy keeps native subagent and team features off', () => {
  for (const serviceTier of ['default', 'fast']) {
    const config = codexAppServerConfig({workspace: false, serviceTier});
    for (const key of CODEX_NATIVE_DELEGATION_FEATURES) assert.match(config, new RegExp(`^${key} = false$`, 'm'), key);
    assert.match(config, /^web_search = "disabled"$/m);
    if (serviceTier === 'fast') assert.match(config, /^fast_mode = true$/m);
  }
});

test('a runtime-native subagent request cannot enter the DSH Host tool surface', async t => {
  const rejected = hostFixture();
  const channel = await createDshHostChannel(rejected.host);
  t.after(() => channel.close().catch(() => {}));
  const failure = channel.failure.catch(error => error);
  const native = {name: 'subagent', description: 'Generated native child delegation', parameters: {type: 'object'}};
  const response = await send(channel, '/ready', {tools: [
    {name: definition.name, description: definition.description, parameters: definition.inputSchema},
    native,
  ]});
  assert.equal(response.status, 400);
  assert.equal((await failure).reason, 'tools_unverified');
  assert.deepEqual(rejected.events, []);
});

test('the same DSH surface still exposes the Host delegation channel', async t => {
  const accepted = hostFixture();
  const channel = await createDshHostChannel(accepted.host);
  t.after(() => channel.close().catch(() => {}));
  const response = await send(channel, '/ready', {tools: [{name: definition.name, description: definition.description, parameters: definition.inputSchema}]});
  assert.equal(response.status, 200);
  assert.deepEqual(accepted.events, [{event: {type: 'tools.ready', tools: [{name: definition.name, version: definition.version, fingerprint: definition.fingerprint}]}, attempt: null}]);
});
