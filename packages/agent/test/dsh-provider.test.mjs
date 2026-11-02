import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {compileNativeDshProfile, createRuntimePatch, DSH_RUNTIME_ID} from '../dist/runtime/dsh/profile-compiler.js';
import {createDshHostChannel} from '../dist/runtime/dsh/context-plugin.js';

const scope = {packageId: 'generated.runtime', installationId: 'generated-install', instanceId: 'generated-instance', activationId: 'generated-active', host: {kind: 'central', id: 'generated-host'}};
const reference = exportName => ({contribution: {instance: {packageId: scope.packageId, installationId: scope.installationId, instanceId: scope.instanceId}, contributionId: 'native'}, revision: 1, artifactDigest: 'a'.repeat(64), exportName});
const profile = () => ({binding: {service: {id: 'mote.agent.runtime', apiVersion: '1'}, provider: {scope, contributionId: DSH_RUNTIME_ID}, revision: 1}, runtimeId: DSH_RUNTIME_ID, profileId: 'generated-profile', profileRevision: 1, assemblyFingerprint: 'b'.repeat(64), taskKind: 'query', configuration: {assembly: {packages: [], hooks: []}, allowedHostCapabilities: ['tools', 'images'], launch: {}}});
const packageRoot = fileURLToPath(new URL('./fixtures/dsh-native-probe', import.meta.url));
const installed = (ref, extra = {}) => ({reference: ref, packageRoot, packageName: '@mote/dsh-native-probe', packageVersion: '0.0.0', subpath: '.', grantedCapabilities: ['tools', 'hooks', 'factory', 'agents'], ...extra});

test('DSH compiler resolves exact installed public native refs and keeps package-level grants', async () => {
  const p = profile(), ref = reference('root'); p.configuration.assembly.packages = [ref];
  const entries = await compileNativeDshProfile(p, [installed(ref)]);
  assert.equal(entries.length, 1); assert.match(entries[0].specifier, /dsh-native-probe\/index\.mjs$/);
  await assert.rejects(compileNativeDshProfile(p, [installed(ref, {grantedCapabilities: ['tools']})]), {code: 'dsh_module_unavailable'});
});

test('DSH compiler rejects duplicate references, missing dependencies, unknown artifacts and secret-bearing runtime config before startup', async () => {
  const ref = reference('root');
  const duplicate = profile(); duplicate.configuration.assembly.packages = [ref]; duplicate.configuration.assembly.hooks = [ref];
  await assert.rejects(compileNativeDshProfile(duplicate, [installed(ref)]), {code: 'dsh_profile_invalid'});
  const p = profile(); p.configuration.assembly.packages = [ref];
  await assert.rejects(compileNativeDshProfile(p, []), {code: 'dsh_module_unavailable'});
  await assert.rejects(compileNativeDshProfile(p, [installed(ref, {requires: [reference('missing')]})]), {code: 'dsh_dependency_missing'});
  for (const mutate of [p => { p.configuration.apiKey = 'generated-private-key'; }, p => { p.configuration.assembly.packages = [{...ref, packagePath: '/generated/private/source.mjs'}]; }, p => { p.configuration.launch.secret = 'generated-private-key'; }]) {
    const value = profile(); mutate(value);
    await assert.rejects(compileNativeDshProfile(value, []), error => {
      assert.equal(error.code, 'dsh_profile_invalid'); assert.doesNotMatch(error.message, /generated-private|private\/source/); return true;
    });
  }
});

test('DSH compiler emits static loader entries and privacy defaults without source rewriting', () => {
  const patch = JSON.parse(createRuntimePatch('/generated/public/context.mjs', 'generated-model', 'http://127.0.0.1:1/v1', 'off', 1024));
  assert.ok(patch.some(entry => entry.id === 'session-log-deepseek' && entry.disabled === true));
  assert.ok(patch.some(entry => entry.id === 'plugin-package-inventory-deepseek' && entry.disabled === true));
  assert.ok(patch.some(entry => entry.id === 'sdk-jsonrpc-server' && entry.inject.includes('moteReady')));
  assert.equal(patch.flatMap(entry => entry.insert ?? []).find(entry => entry.id === 'mote-context').name, '/generated/public/context.mjs');
});

const definition = {name: 'generated_read', version: '1', fingerprint: 'c'.repeat(64), description: 'Generated read', inputSchema: {type: 'object', properties: {}, additionalProperties: false}};
async function channelFixture(t) {
  const events = [], calls = [], controller = new AbortController(); let delivered = false;
  const host = {identity: {runId: 'generated-run'}, signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted(); }, emit(event, attempt) { events.push({event, attempt}); }, tools: {definitions: [definition], async deliver(attempt, call, sender) { calls.push({attempt, call}); await sender({text: '{"generated":true}'}); delivered = true; }}};
  const channel = await createDshHostChannel(host), close = channel.close; let closing = false;
  channel.close = () => { closing = true; return close(); }; t.after(() => { if (!closing) return channel.close(); });
  const send = (path, body, token = channel.configuration.token) => fetch(channel.configuration.url + path, {method: 'POST', headers: {authorization: 'Bearer ' + token, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  return {channel, host, events, calls, controller, send, get delivered() { return delivered; }};
}

test('private DSH channel authenticates and checks the actual loaded schema set before readiness', async t => {
  const f = await channelFixture(t), schema = {name: definition.name, description: definition.description, parameters: definition.inputSchema};
  assert.equal((await f.send('/ready', {tools: [schema]}, 'wrong')).status, 403); assert.equal(f.events.length, 0);
  assert.equal((await f.send('/ready', {tools: [schema]})).status, 200); assert.deepEqual(f.events[0], {event: {type: 'tools.ready', tools: [{name: definition.name, version: definition.version, fingerprint: definition.fingerprint}]}, attempt: null});
});

test('private DSH channel rejects an extra write tool or changed schema rather than reporting tools ready', async t => {
  for (const tools of [[{name: 'write_file', description: 'Generated forbidden write', parameters: definition.inputSchema}], [{name: definition.name, description: definition.description, parameters: {type: 'object'}}]]) {
    const f = await channelFixture(t); void f.channel.failure.catch(() => {});
    assert.equal((await f.send('/ready', {tools})).status, 400); await assert.rejects(f.channel.failure, {reason: 'tools_unverified'}); assert.equal(f.events.length, 0);
  }
});

test('private DSH transport binds the native turn/call identity and confirms only the separate sender ACK', async t => {
  const f = await channelFixture(t), attempt = {id: 'host-initial', index: 0};
  f.channel.bindCall(1, 'native-call', definition.name, attempt);
  const response = await f.send('/call', {sessionId: 'generated-run', turn: 1, callId: 'native-call', name: definition.name, arguments: {}});
  const frame = await response.json(); assert.equal(response.status, 200); assert.deepEqual(f.calls[0].attempt, attempt);
  assert.equal(f.delivered, false, 'HTTP body receipt is not the separate delivery ACK');
  assert.equal((await f.send('/ack', {id: frame.id, delivered: true})).status, 200);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.delivered, true);
});

test('channel shutdown with a lost sender ACK refuses successful cleanup and never confirms a delivery', async t => {
  const f = await channelFixture(t); void f.channel.failure.catch(() => {});
  f.channel.bindCall(1, 'native-call', definition.name, {id: 'host-initial', index: 0});
  const response = await f.send('/call', {sessionId: 'generated-run', turn: 1, callId: 'native-call', name: definition.name, arguments: {}}); await response.json();
  assert.equal(f.delivered, false); await assert.rejects(f.channel.close(), {reason: 'tool_failure'}); assert.equal(f.delivered, false);
});

test('child ACK response waits for Host post-sender eligibility and cannot report a stale delivery as accepted', async t => {
  const f = await channelFixture(t); void f.channel.failure.catch(() => {});
  f.host.tools.deliver = async (_attempt, _call, sender) => { await sender({text: 'Generated payload'}); throw Error('Generated stale attempt after sender'); };
  f.channel.bindCall(1, 'native-call', definition.name, {id: 'host-initial', index: 0});
  const response = await f.send('/call', {sessionId: 'generated-run', turn: 1, callId: 'native-call', name: definition.name, arguments: {}}), frame = await response.json();
  assert.equal((await f.send('/ack', {id: frame.id, delivered: true})).status, 400);
  await assert.rejects(f.channel.failure, {reason: 'tool_failure'}); assert.equal(f.delivered, false);
});
