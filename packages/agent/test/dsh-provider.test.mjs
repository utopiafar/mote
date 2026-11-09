import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {compileNativeDshProfile, createRuntimePatch, DSH_RUNTIME_ID} from '../dist/runtime/dsh/profile-compiler.js';
import {createDshHostChannel, contextToolPayload} from '../dist/runtime/dsh/context-plugin.js';
import {createDshRuntimeProvider, dshRuntimePlugin} from '@mote/agent/runtime/dsh';
import {createDshModelAdapter} from '../dist/models/dsh-adapter.js';
import {PluginHost} from '@mote/plugin-host';
import {runtimeService} from '../dist/runtime/contracts.js';
import {PluginResourceScope} from '@mote/plugin-host';
import {mkdtemp, writeFile, readFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.ts';
import {prepareDshRun} from '@mote/agent/runtime/dsh';
import {resolveRunSelection} from '../dist/runtime/profile.js';
import {createHostOutputProvider} from '../dist/host/output.js';
import {hostOutputService} from '../dist/host/run-contracts.js';
import {assembleHostContext} from '../dist/host/run-session.js';
import {ActiveExecutionBudget} from '../dist/active-budget.js';
import {startBridge} from '../dist/bridge.js';
import {contextToolDefinitions, pinContextTools} from '../dist/tool-contributions.js';
import {taskTools} from '../dist/task-context.js';
import {parameterSchemaSpecToJsonSchema} from '@deepseek-ai/dsh-tools';
import {AgentYieldError} from '../dist/host-controls.js';
import {SYSTEM_PROMPT} from '../dist/instructions.js';
import {createAgent, AgentResponseError} from '@mote/agent';
import {ProviderFailure, IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS} from '@mote/shared';
import {ContextToolError} from '../dist/tool-errors.js';

const manualJourneys = process.env.MOTE_TEST_DSH_JOURNEYS === '1';

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
  const attachments = patch.flatMap(entry => entry.insert ?? []).find(entry => entry.id === 'mote-attachments');
  assert.equal(attachments.config.maxImageBytes, IMAGE_MAX_BYTES);
  assert.equal(attachments.config.maxImagePixels, IMAGE_MAX_PIXELS);
  assert.equal(attachments.config.maxImageDimension, IMAGE_MAX_PIXELS, 'long originals admitted by Mote must not fail attachment preparation before read_image');
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
  f.channel.bindCall(1, 'native-call', definition.name, attempt, {});
  const response = await f.send('/call', {sessionId: 'generated-run', turn: 1, callId: 'native-call', name: definition.name, arguments: {}});
  const frame = await response.json(); assert.equal(response.status, 200); assert.deepEqual(f.calls[0].attempt, attempt);
  assert.equal(f.delivered, false, 'HTTP body receipt is not the separate delivery ACK');
  assert.equal((await f.send('/ack', {id: frame.id, ...frame.receipt, delivered: true})).status, 200);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.delivered, true);
});

test('channel shutdown with a lost sender ACK refuses successful cleanup and never confirms a delivery', async t => {
  const f = await channelFixture(t); void f.channel.failure.catch(() => {});
  f.channel.bindCall(1, 'native-call', definition.name, {id: 'host-initial', index: 0}, {});
  const response = await f.send('/call', {sessionId: 'generated-run', turn: 1, callId: 'native-call', name: definition.name, arguments: {}}); await response.json();
  assert.equal(f.delivered, false); await assert.rejects(f.channel.close(), {reason: 'tool_failure'}); assert.equal(f.delivered, false);
});

test('child ACK response waits for Host post-sender eligibility and cannot report a stale delivery as accepted', async t => {
  const f = await channelFixture(t); void f.channel.failure.catch(() => {});
  f.host.tools.deliver = async (_attempt, _call, sender) => { await sender({text: 'Generated payload'}); throw Error('Generated stale attempt after sender'); };
  f.channel.bindCall(1, 'native-call', definition.name, {id: 'host-initial', index: 0}, {});
  const response = await f.send('/call', {sessionId: 'generated-run', turn: 1, callId: 'native-call', name: definition.name, arguments: {}}), frame = await response.json();
  assert.equal((await f.send('/ack', {id: frame.id, ...frame.receipt, delivered: true})).status, 400);
  await assert.rejects(f.channel.failure, {reason: 'tool_failure'}); assert.equal(f.delivered, false);
});

test('a correctable tool-result preparation rejection reaches the model without ending the DSH run', async t => {
  const f = await channelFixture(t); let failed = false; void f.channel.failure.catch(() => { failed = true; });
  f.channel.bindCall(1, 'native-call', definition.name, {id: 'host-initial', index: 0}, {});
  const response = await f.send('/call', {sessionId: 'generated-run', turn: 1, callId: 'native-call', name: definition.name, arguments: {}});
  const frame = await response.json();
  const ack = await f.send('/ack', {id: frame.id, ...frame.receipt, delivered: false});
  const body = await ack.json();
  assert.equal(ack.status, 400);
  assert.equal(body.toolError.code, 'tool_delivery_failed');
  assert.equal(body.toolError.recovery, 'correct_arguments');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed, false, 'a model-correctable preparation rejection must not poison the channel');
});

test('runtime delivery receipt is bound to the run, fixed attempt, native call and exact payload and is one-shot', async t => {
  const f = await channelFixture(t), attempt = {id: 'host-initial', index: 0};
  f.channel.bindCall(1, 'native-call', definition.name, attempt, {});
  const response = await f.send('/call', {sessionId: 'generated-run', turn: 1, callId: 'native-call', name: definition.name, arguments: {}}), frame = await response.json();
  assert.equal(frame.receipt.runId, 'generated-run'); assert.equal(frame.receipt.attemptId, attempt.id); assert.equal(frame.receipt.callId, 'native-call');
  for (const changed of [{runId: 'other-run'}, {attemptId: 'host-repair'}, {callId: 'other-call'}, {payloadFingerprint: '0'.repeat(64)}]) {
    assert.equal((await f.send('/ack', {id: frame.id, ...frame.receipt, ...changed, delivered: true})).status, 400); assert.equal(f.delivered, false);
  }
  assert.equal((await f.send('/ack', {id: frame.id, ...frame.receipt, delivered: true})).status, 200);
  assert.equal((await f.send('/ack', {id: frame.id, ...frame.receipt, delivered: true})).status, 400); assert.equal(f.calls.length, 1);
  assert.equal((await f.send('/call', {sessionId: 'generated-run', turn: 1, callId: 'native-call', name: definition.name, arguments: {}})).status, 400);
  assert.equal(f.calls.length, 1, 'a replay cannot stage a second read under the same native call');
});

test('private native calls cannot replace the typed model tool arguments', async t => {
  const f = await channelFixture(t);
  f.channel.bindCall(1, 'native-call', definition.name, {id: 'host-initial', index: 0}, {ids: ['generated-id']});
  assert.equal((await f.send('/call', {sessionId: 'generated-run', turn: 1, callId: 'native-call', name: definition.name, arguments: {ids: ['different-id']}})).status, 400);
  assert.equal(f.calls.length, 0);
});

test('official DSH plugin publishes through the real Host without an observer and quiesces admissions', async t => {
  const host = new PluginHost(scope.host); t.after(() => host.close());
  const installed = await host.install(dshRuntimePlugin(scope));
  const binding = {service: runtimeService, provider: {scope, contributionId: runtimeService.id}, revision: 0};
  const lease = await host.acquire(runtimeService, binding);
  assert.ok(lease.value.capabilities.modelTransports.includes('deepseek')); assert.equal(lease.value.capabilities.replacement, 'restart');
  await installed.quiesce(); lease.assertCurrent();
  await assert.rejects(lease.value.prepare({}, {}, {}), error => error.details?.code === 'runtime_unavailable');
  await installed.close(); assert.equal(lease.signal.aborted, true); await lease.release();
});

test('an unconfigured DSH model fails before private resources or a subprocess are created', async t => {
  let resources = 0; const provider = createDshRuntimeProvider({resourceObserver() { resources++; }}); t.after(() => provider.close());
  const model = {value: {model: 'generated-model', apiKey: ''}, assertCurrent() {}};
  await assert.rejects(provider.prepare(profile(), model, {assertCurrent() {}, systemPrompt: 'Generated Host policy'}), {name: 'AgentNotConfiguredError'});
  assert.equal(resources, 0);
});

test('DSH revalidates the exact model lease after every asynchronous send authorization', async t => {
  let current = true, authorizations = 0, leaseChecks = 0;
  const revoked = new ProviderFailure({category: 'blocked', code: 'model_lease_revoked', executionStarted: false});
  const model = {value: {model: 'generated-model', protocol: 'deepseek', apiKey: 'generated-key', baseUrl: 'http://127.0.0.1:9', async authorizeModelRequest() {
    authorizations++;
    await new Promise(resolve => setImmediate(resolve));
    if (authorizations === 2) current = false;
  }}, assertCurrent() { leaseChecks++; if (!current) throw revoked; }};
  const adapter = createDshModelAdapter(model, {assertCurrent() {}});
  t.after(() => adapter.dispose());
  assert.deepEqual(adapter.descriptor, {id: 'mote.model.dsh', version: '1'});
  const observer = await adapter.start();
  const authorize = () => fetch(observer.configuration.authorizationUrl, {method: 'POST', headers: {Authorization: 'Bearer ' + observer.configuration.token, 'Content-Type': 'application/json'}, body: '{}'});
  assert.equal((await authorize()).status, 200);
  const failure = assert.rejects(observer.failure, error => error.details?.code === 'model_lease_revoked');
  assert.equal((await authorize()).status, 409);
  await failure;
  assert.equal(authorizations, 2);
  assert.ok(leaseChecks >= 5, 'the lease is checked before and after each authorization');
});

test('the transport helper module exposes the actual import runtime consumer boundary', async () => {
  const transport = await import('../dist/models/http-transport.js');
  const bounded = transport.boundedModelFetch(async () => new Response('Generated import transport'), 'mote-no-context-bridge', 64);
  assert.equal(await (await bounded('http://127.0.0.1/generated', {method: 'POST'})).text(), 'Generated import transport');
  assert.equal(typeof transport.modelFailureReporter, 'function'); assert.equal(typeof transport.modelRequestAuthorization, 'function');
});

test('public initialization keeps caller cancellation when close also stops its internal scope', async () => {
  const reader = {search: async () => [], timeline: async () => ({items: [], nextCursor: null}), evidence: async () => [], activity: async () => ({}), devices: async () => []};
  const agent = createAgent({reader, protocol: 'deepseek', model: 'generated', apiKey: 'generated-key', baseUrl: 'http://127.0.0.1:9'});
  const controller = new AbortController(), reason = new DOMException('Generated caller cancellation', 'AbortError');
  const query = agent.query({question: 'Generated cancelled setup', signal: controller.signal}); controller.abort(reason);
  const closing = agent.close();
  await assert.rejects(query, error => error === reason); await closing;
});

test('public close at the Host assembly boundary does not expose an internal lease error', async () => {
  const reader = {search: async () => [], timeline: async () => ({items: [], nextCursor: null}), evidence: async () => [], activity: async () => ({}), devices: async () => []};
  const agent = createAgent({reader, protocol: 'deepseek', model: 'generated', apiKey: 'generated-key', baseUrl: 'http://127.0.0.1:9'});
  let closing;
  const query = agent.query({question: 'Generated shutdown at Host assembly', onTrace(event) { if (event.type === 'instructions.assembled') closing = agent.close(); }});
  await assert.rejects(query, /Agent is closed/); assert.ok(closing); await closing;
});

test('mandatory Host tool stops reject the actual channel failure path', {timeout: 1500}, async t => {
  for (const denied of [new AgentResponseError('Generated image policy denial', 'image_disclosure_disabled'), new ContextToolError('evidence_changed', 'Generated revoked source', 'stop')]) {
    const f = await channelFixture(t); void f.channel.failure.catch(() => {});
    f.channel.bindCall(1, 'native-call', definition.name, {id: 'host-initial', index: 0}, {});
    f.host.tools.deliver = async () => { throw denied; };
    assert.equal((await f.send('/call', {sessionId: 'generated-run', turn: 1, callId: 'native-call', name: definition.name, arguments: {}})).status, 400);
    await assert.rejects(f.channel.failure, error => error === denied); assert.equal(f.delivered, false);
  }
});

test('a Host delegation yield crosses the real parent channel as a typed stopping cause', async t => {
  const f = await channelFixture(t), yielded = new AgentYieldError(); void f.channel.failure.catch(() => {});
  f.channel.bindCall(1, 'native-call', definition.name, {id: 'host-initial', index: 0}, {});
  f.host.tools.deliver = async () => { throw yielded; };
  assert.equal((await f.send('/call', {sessionId: 'generated-run', turn: 1, callId: 'native-call', name: definition.name, arguments: {}})).status, 400);
  await assert.rejects(f.channel.failure, error => error === yielded); assert.equal(f.delivered, false);
});

test('Host image payload keeps private preparation tokens and pixels out of model text', () => {
  const payload = contextToolPayload({id: 'generated-image', image: {mimeType: 'image/png', data: 'generated-base64'}, imageDelivery: 'private-preparation-token', imageView: {delivery: 'pending'}, imageBudget: {remaining: 1}});
  assert.deepEqual(payload.images, [{mimeType: 'image/png', data: 'generated-base64'}]);
  assert.deepEqual(JSON.parse(payload.text), {id: 'generated-image', imageView: {delivery: 'prepared'}, imageBudget: {remaining: 1}});
  assert.doesNotMatch(payload.text, /generated-base64|private-preparation-token|imageDelivery/);
  assert.throws(() => contextToolPayload({image: {mimeType: 'image/png', data: 'generated-base64'}}), {reason: 'tools_unverified'});
});

// Real A05-style journey fixture: real SDK child, generated data and loopback only.
// Individual cases opt into manual selection when they need a complete model journey.
async function selectedJourney(t, mode = 'success', options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mote-a05-journey-')), tracePath = join(root, 'child.jsonl');
  t.after(() => rm(root, {recursive: true, force: true}));
  const nativeRoot = join(root, 'native');
  const {mkdir} = await import('node:fs/promises'); await mkdir(nativeRoot);
  await writeFile(join(nativeRoot, 'package.json'), JSON.stringify({name: '@mote/a05-generated', version: '0.0.0', type: 'module', exports: {'.': './index.mjs'}, dsh: {native: {capabilities: ['tools']}}}));
  await writeFile(join(nativeRoot, 'index.mjs'), `import {appendFileSync} from 'node:fs';
export const inject=['tools'];
const trace=event=>appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({event,pid:process.pid,home:process.env.HOME})+'\\n');
export function apply(ctx){trace('loaded');ctx.effect(()=>()=>trace('disposed'));
${mode === 'extra_write' ? "ctx.tools.register({name:'write_file',description:'Generated forbidden write',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{},render:()=>[]},execute:async()=>({})});" : ''}}
`);
  const requests = [], events = [], resources = [];
  const record = {id: '22222222-2222-4222-8222-222222222222', capturedAt: '2026-11-01T10:00:00.000Z', appName: 'Generated notes', ocrText: 'The generated observatory review finished on Sunday.'};
  let reads = 0, validations = 0;
  const reader = {search: async () => { reads++; return [record]; }, timeline: async () => ({items: [record], nextCursor: null}), evidence: async () => { reads++; return [record]; }, activity: async () => ({captures: 0}), devices: async () => []};
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part; requests.push(JSON.parse(raw));
    await options.beforeResponse?.(requests.length);
    writeMessagesResponse(res, {stage: requests.length - 1, model: 'generated', ...(requests.length === 1 ? {tool: {name: 'search_context', args: {query: 'generated observatory'}}} : {}), text: JSON.stringify({answer: `The generated observatory review finished on Sunday. [${record.id}]`, citationIds: [record.id]}), reasoning: true});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const model = {model: 'generated', protocol: 'deepseek', apiKey: 'generated-key', baseUrl: `http://127.0.0.1:${server.address().port}`, maxTokens: 1024, requestTimeoutMs: 10000};
  const nativeRef = reference('root'), module = {...installed(nativeRef), packageRoot: nativeRoot, packageName: '@mote/a05-generated', grantedCapabilities: ['tools']};
  const hostIdentity = {kind: 'central', id: randomUUID()}, runtimeIdentity = {...scope, host: hostIdentity, activationId: randomUUID()}, foundationIdentity = {...runtimeIdentity, packageId: 'generated.foundation', activationId: randomUUID()};
  const host = new PluginHost(hostIdentity); t.after(() => host.close());
  let runtimeBinding, modelBinding, outputBinding;
  await host.install(dshRuntimePlugin(runtimeIdentity, {installedModules: [module], resourceObserver: event => resources.push(event)}, binding => { runtimeBinding = binding; }));
  const modelContract = {id: 'generated.model', apiVersion: '1'};
  await host.install({identity: foundationIdentity, contributions: [modelContract, hostOutputService], factory(ctx) { return {prepare() {}, start() { modelBinding = ctx.provide(modelContract.id, modelContract, model); outputBinding = ctx.provide(hostOutputService.id, hostOutputService, createHostOutputProvider()); }, quiesce() {}, stop() {}, dispose() {}}; }});
  const runtime = await host.acquire(runtimeService, runtimeBinding), modelLease = await host.acquire(modelContract, modelBinding), output = await host.acquire(hostOutputService, outputBinding);
  const selection = resolveRunSelection({revision: 1, profile: {id: 'generated-dsh', name: 'Generated DSH', revision: 1, runtimeProviderId: DSH_RUNTIME_ID, providerRef: {service: runtimeService, revision: runtimeBinding.revision, provider: {instance: {packageId: runtimeIdentity.packageId, installationId: runtimeIdentity.installationId, instanceId: runtimeIdentity.instanceId}, contributionId: runtimeBinding.provider.contributionId}}, assembly: {packages: [nativeRef], hooks: []}, allowedHostCapabilities: ['tools', 'images', 'hostDelegation']}, providers: [{id: DSH_RUNTIME_ID, binding: runtimeBinding, capabilities: runtime.value.capabilities, availability: {state: 'active'}}], installedModules: [nativeRef], model: {profile: {id: 'generated-model', name: 'Generated model', settings: {...model, provider: 'custom', reasoningEffort: 'off', headers: {}, extraBody: {}, allowUnauthenticatedLocal: true, agentTimeoutMs: null, modelRequestTimeoutMs: 10000}}, profileRevision: 1, modelRevision: 1, connectionFingerprint: 'd'.repeat(64), capabilities: {tools: true, images: false}}, requirements: {taskKind: 'query', capabilities: ['tools']}});
  const input = pinContextTools({question: 'Summarize the generated observatory review', skill: 'memory-extraction', ...(options.signal ? {signal: options.signal} : {}), validateOutput(answer) { validations++; assert.equal(answer.citations[0].id, record.id); }}, reader);
  const bridge = await startBridge(reader, input); let bridgeClosing;
  const closeBridge = () => bridgeClosing ??= bridge.close(); t.after(closeBridge);
  const definitions = contextToolDefinitions(input).filter(([name]) => taskTools(input).includes(name)).map(([name, description, fields]) => ({name, description, inputSchema: {...parameterSchemaSpecToJsonSchema(fields), additionalProperties: false}, version: '1', fingerprint: input.contextCapabilitySnapshot.find(tool => tool.name === name)?.fingerprint ?? 'e'.repeat(64)}));
  const context = assembleHostContext(input, bridge.seedEvidence, 1024);
  const runScope = Object.assign(new PluginResourceScope(), {identity: {...foundationIdentity, activationId: randomUUID()}}); t.after(() => runScope.close());
  const assembly = {systemPrompt: context.system, prompt: context.prompt, contextUsage: {...context.metrics, toolResults: 0}, maxTokens: 1024, evidence: () => bridge,
    async readTool(call, signal) {
      const staged = await bridge.prepareDelivery(call.name, call.arguments, signal);
      try { return {payload: contextToolPayload(staged.value), confirm: staged.confirm, discard: staged.discard}; }
      catch (error) { staged.discard(); throw error; }
    }, close: closeBridge, observe: event => events.push(event)};
  return {root, tracePath, resources, requests, record, context, bridge, input, events, model, nativeRoot, nativeRef, module, selection, runtime, modelLease, output, runScope, assembly, get reads() { return reads; }, get validations() { return validations; },
    prepare: () => prepareDshRun(selection, {runId: randomUUID(), scope: runScope, input, runtime, model: {...modelLease, selection: selection.modelSelection}, output, tools: {definitions, bindings: [], assertCurrent() {}}, commitFence: {assertCurrent() {}}, budget: {activeTimeoutMs: 15000}, activeBudget: new ActiveExecutionBudget(15000)}, assembly),
  };
}

test('selected A05 journey: generated original reaches the real DSH child and only Host validates the cited candidate', {skip: !manualJourneys, timeout: 30000}, async t => {
  const f = await selectedJourney(t), session = await f.prepare();
  const patch = JSON.parse(await readFile(join(f.resources[0].root, 'runtime.patch.json'), 'utf8'));
  assert.notEqual(f.context.system, SYSTEM_PROMPT);
  assert.equal(patch.find(entry => entry.id === 'system-prompt').config.personaPrefix, f.context.system);
  let result;
  try { result = await session.execute(); }
  catch (error) { t.diagnostic(JSON.stringify({reads: f.reads, requests: f.requests.length, toolResults: f.requests.flatMap(request => request.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result') : []))})); throw error; }
  assert.equal(f.reads, 1); assert.equal(f.validations, 1); assert.equal(result.citations[0].id, f.record.id); assert.equal(result.trace.length, 1);
  assert.equal(f.requests.length, 2); assert.ok(f.requests[1].messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result' && JSON.stringify(block).includes(f.record.ocrText))));
  const system = f.requests[0].system;
  assert.ok((typeof system === 'string' ? system : system.map(block => block.text).join('\n')).includes(f.context.system), 'the exact Host Memory system policy reaches the model');
  assert.equal(f.events.filter(({event}) => event.type === 'tools.ready').length, 1);
  assert.equal(f.events.at(-1).event.terminal.kind, 'completed');
  assert.deepEqual(f.resources.map(event => event.type), ['created', 'closed']);
  const childEvents = (await readFile(f.tracePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(childEvents.map(event => event.event), ['loaded', 'disposed']); assert.notEqual(childEvents[0].pid, process.pid);
  assert.equal(childEvents[0].home, join(f.resources[0].root, 'home'));
  assert.throws(() => process.kill(childEvents[0].pid, 0), {code: 'ESRCH'});
  await assert.rejects(access(f.resources[0].root), {code: 'ENOENT'});
});

test('selected A05 journey: cancellation releases the Host barrier and closes the real DSH child before a late model response', {timeout: 30000}, async t => {
  const controller = new AbortController(), reason = new DOMException('Generated DSH cancellation', 'AbortError');
  let requestSeen, releaseResponse;
  const seen = new Promise(resolve => { requestSeen = resolve; }), held = new Promise(resolve => { releaseResponse = resolve; });
  const f = await selectedJourney(t, 'success', {signal: controller.signal, async beforeResponse(count) {
    if (count === 1) { requestSeen(); await held; }
  }});
  const session = await f.prepare(), execution = session.execute().then(() => undefined, error => error);
  try {
    await seen;
    controller.abort(reason);
    const rejected = await execution;
    assert.equal(rejected, reason);
    const late = {id: 'generated-late-attempt', index: 0};
    assert.throws(() => session.port.emit({type: 'usage', usage: {requests: 1, reportedRequests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15}}, late));
    assert.throws(() => session.port.emit({type: 'progress', progress: {stage: 'model'}}, late));
    await assert.rejects(session.port.tools.deliver(late, {callId: 'generated-late', name: 'search_context', arguments: {query: 'generated late'}}, async () => { throw Error('Late DSH tool delivery must not send'); }));
    releaseResponse();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.validations, 0, 'the cancelled DSH run committed no product answer');
    assert.equal(f.events.filter(({event}) => event.type === 'attempt.terminal').length, 0, 'no late runtime terminal was observed');
    assert.deepEqual(f.events.at(-1).event.terminal, {kind: 'cancelled', cause: 'cancelled'});
    assert.deepEqual(f.resources.map(event => event.type), ['created', 'closed']);
    const child = JSON.parse((await readFile(f.tracePath, 'utf8')).trim().split('\n')[0]);
    assert.notEqual(child.pid, process.pid);
    assert.throws(() => process.kill(child.pid, 0), {code: 'ESRCH'}, 'the DSH child process exited');
    await assert.rejects(access(f.resources[0].root), {code: 'ENOENT'});
  } finally {
    releaseResponse();
    try { await session.close(); }
    catch (error) { if (error !== reason) throw error; }
  }
});

test('selected A05 journey: an actual native write schema blocks Provider prepare before model traffic', {skip: !manualJourneys, timeout: 15000}, async t => {
  const f = await selectedJourney(t, 'extra_write');
  await assert.rejects(f.prepare(), {reason: 'tools_unverified'});
  assert.equal(f.requests.length, 0); assert.equal(f.reads, 0); assert.equal(f.validations, 0);
  assert.equal(f.events.some(({event}) => event.type === 'tools.ready'), false);
  assert.deepEqual(f.resources.map(event => event.type), ['created', 'closed']); await assert.rejects(access(f.resources[0].root), {code: 'ENOENT'});
  const child = JSON.parse((await readFile(f.tracePath, 'utf8')).trim().split('\n')[0]);
  assert.equal(child.event, 'loaded'); assert.notEqual(child.pid, process.pid);
  assert.equal(child.home, join(f.resources[0].root, 'home'));
  assert.throws(() => process.kill(child.pid, 0), {code: 'ESRCH'});
});

test('selected A05 journey: a missing context plugin prevents child readiness and leaves no process or private profile', {skip: !manualJourneys, timeout: 15000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mote-a05-no-host-')); t.after(() => rm(root, {recursive: true, force: true}));
  const patch = join(root, 'runtime.patch.json'), witness = join(root, 'witness.mjs'), tracePath = join(root, 'child.jsonl');
  await writeFile(witness, `import {appendFileSync} from 'node:fs'; export function apply(){appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({pid:process.pid,home:process.env.HOME})+'\\n');}`);
  const entries = JSON.parse(createRuntimePatch(fileURLToPath(new URL('../dist/plugin.mjs', import.meta.url)), 'generated-model', undefined, undefined, 1024, {}, 'Generated Host policy', [{id: 'generated-lifecycle-witness', specifier: pathToFileURL(witness).href}]));
  for (const entry of entries) if (entry.insert) entry.insert = entry.insert.filter(plugin => plugin.id !== 'mote-context');
  assert.ok(entries.find(entry => entry.id === 'sdk-jsonrpc-server').inject.includes('moteReady'));
  await writeFile(patch, JSON.stringify(entries));
  const harness = new DeepSeekHarness({profile: 'sdk-minimal', patches: [patch], dshHome: join(root, 'home'), cwd: root, processCwd: root, model: 'generated-model', initializeTimeoutMs: 3000, env: {PATH: process.env.PATH, HOME: join(root, 'home'), DEEPSEEK_API_KEY: 'generated-key', MOTE_HOST_RUN: ''}});
  t.after(() => harness.close());
  await assert.rejects(harness.start()); await harness.close();
  const child = JSON.parse((await readFile(tracePath, 'utf8')).trim().split('\n')[0]);
  assert.notEqual(child.pid, process.pid); assert.equal(child.home, join(root, 'home'));
  assert.throws(() => process.kill(child.pid, 0), {code: 'ESRCH'});
  await rm(root, {recursive: true, force: true}); await assert.rejects(access(root), {code: 'ENOENT'});
});

async function publicFixture(t, options = {}) {
  const record = {id: '66666666-6666-4666-8666-666666666666', capturedAt: '2026-11-01T00:00:00Z', appName: 'Generated source', ocrText: 'Generated authorized original text.'};
  const requests = []; let imageReads = 0, validations = 0;
  const reader = {search: async () => [record], timeline: async () => ({items: [record], nextCursor: null}), evidence: async () => [record], activity: async () => ({}), devices: async () => [], readImage: async () => { imageReads++; throw new ContextToolError('image_disclosure_disabled', 'Generated image policy is off.', 'stop'); }};
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; requests.push(JSON.parse(body));
    const step = requests.length - 1, tool = step === 0 ? {name: 'search_context', args: {query: 'generated'}} : step === 1 ? {name: 'evidence', args: {ids: [record.id]}} : step === 2 ? {name: 'read_image', args: {id: record.id}} : undefined;
    writeMessagesResponse(res, {stage: step, model: 'generated', tool, text: JSON.stringify({answer: `Generated supported text [${record.id}]`, citationIds: [record.id]}), reasoning: true});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = createAgent({reader, protocol: 'deepseek', model: 'generated', apiKey: 'generated-key', baseUrl: `http://127.0.0.1:${server.address().port}`, agentTimeoutMs: 10000, ...options});
  t.after(async () => { try { await agent.close(); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
  return {agent, requests, get imageReads() { return imageReads; }, get validations() { return validations; }, input: {question: 'Generated image policy regression', validateOutput() { validations++; }}};
}

test('selected A05 journey: public createAgent preserves an image policy stop instead of accepting later text', {skip: !manualJourneys, timeout: 15000}, async t => {
  const f = await publicFixture(t);
  await assert.rejects(f.agent.query(f.input), error => error instanceof AgentResponseError && error.reason === 'image_disclosure_disabled');
  assert.equal(f.imageReads, 1); assert.equal(f.validations, 0); assert.equal(f.requests.length, 3, 'the stopped run must not make another outbound model request');
});

test('selected A05 journey: public admission and outbound authorization retain exact provider recovery facts', {skip: !manualJourneys, timeout: 15000}, async t => {
  for (const boundary of ['admission', 'authorization']) {
    const details = boundary === 'admission' ? {category: 'transient', code: 'rate_limited', retryAfterMs: 23000, executionStarted: false, admissionWaiting: true} : {category: 'blocked', code: 'context_evidence_restricted', executionStarted: false};
    const failure = new ProviderFailure(details);
    const f = await publicFixture(t, boundary === 'admission' ? {runModel: async () => { throw failure; }} : {authorizeModelRequest: async () => { throw failure; }});
    await assert.rejects(f.agent.query(f.input), error => { assert.ok(error instanceof ProviderFailure); assert.deepEqual(error.details, details); return true; });
    assert.equal(f.requests.length, 0); assert.equal(f.validations, 0); await f.agent.close();
  }
});
