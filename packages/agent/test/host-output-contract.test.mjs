import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createHostRunSession, settleHostCleanup, assembleHostContext} from '../dist/host/run-session.js';
import {createHostOutputProvider} from '../dist/host/output.js';
import {ActiveExecutionBudget} from '../dist/active-budget.js';
import {AgentResponseError, AgentTimeoutError} from '../dist/types.js';
import {RuntimeContractError} from '../dist/runtime/contracts.js';
import {startBridge} from '../dist/bridge.js';
import {catalogRequest} from './catalog-request.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const unread = '22222222-2222-4222-8222-222222222222';
const record = {id, capturedAt: '2026-11-01T00:00:00Z', appName: 'Generated notes', ocrText: 'READ_ONLY\nUNREAD_SECRET_TAIL', provenance: {sourceId: 'generated-source', revision: 'v1'}};
const reader = {search: async () => [record], timeline: async () => ({items: [record], nextCursor: null}), evidence: async ({ids}) => ids.includes(id) ? [record] : [], activity: async () => ({}), devices: async () => []};
const empty = () => ({records: new Map(), deliveredRanges: [], imageReadReceipts: [], sourceContextDependencies: [], evidenceDependencies: {version: 1, complete: true, ids: []}, trace: [], deliveredCharacters: 0});
const metrics = {unit: 'utf16_characters', system: 0, tools: 0, question: 0, conversation: 0, task: 0, evidence: 0, prompt: 0, outputTokenReserve: 100, toolResults: 0};
const tools = [{name: 'generated_read', version: '1', fingerprint: 'a'.repeat(64), description: 'Generated read', inputSchema: {type: 'object'}}];
const outcome = (text = JSON.stringify({answer: 'Generated answer', citationIds: []})) => ({terminal: {kind: 'completed'}, candidate: {text}});
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function fixture(overrides = {}) {
  const calls = [], events = [], cleanupErrors = [], scope = new AbortController(), disposers = [];
  let active = true, port;
  const scopeIdentity = {packageId: 'generated', installationId: 'install', instanceId: 'instance', host: {kind: 'central', id: 'fixture'}, activationId: 'active'};
  const binding = service => ({service: {id: service, apiVersion: '1'}, provider: {scope: scopeIdentity, contributionId: service}, revision: 1});
  const lease = (service, value) => {
    let live = true;
    return {binding: binding(service), value, signal: scope.signal, assertCurrent() { if (!live) throw new Error('released lease'); }, release() { if (live) { live = false; calls.push(`release:${service}`); } }};
  };
  const modelSelection = {modelId: 'generated', modelRevision: 1, profileId: 'model-profile', profileRevision: 1, transport: 'fixture'};
  const provider = {capabilities: {}, async prepare(_profile, _model, host) {
    calls.push('prepare'); port = host;
    if (overrides.prepare) return overrides.prepare(host, calls);
    if (overrides.ready !== false) host.emit({type: 'tools.ready', tools: overrides.loadedTools ?? tools}, null);
    return {
      async run(request) { calls.push('run'); return host.runModel(request.attempt, () => overrides.run?.(request, host) ?? Promise.resolve(outcome())); },
      async repair(request) { calls.push('repair'); return host.runModel(request.attempt, () => overrides.repair?.(request, host) ?? Promise.resolve(outcome())); },
      async cancel() { calls.push('cancel'); },
      async close() { calls.push('runtime.close'); await overrides.runtimeClose?.(); },
    };
  }};
  const runtime = lease('mote.agent.runtime', provider);
  const input = {question: 'Generated question', ...overrides.input};
  const deps = {
    scope: {identity: scopeIdentity, signal: scope.signal, assertCurrent() { if (!active) throw new Error('revoked grant'); }, defer(dispose) { disposers.push(dispose); }},
    identity: {runId: 'generated-run', runtime: {id: 'fixture', revision: 1, profileId: 'runtime-profile', profileRevision: 1, assemblyFingerprint: 'a'.repeat(64)}, model: modelSelection},
    input, profile: {binding: runtime.binding, runtimeId: 'fixture', profileId: 'runtime-profile', profileRevision: 1, assemblyFingerprint: 'a'.repeat(64), taskKind: 'query', configuration: {}},
    runtime, model: {...lease('generated.model', {}), selection: modelSelection}, output: lease('mote.agent.host-output', overrides.output ?? createHostOutputProvider()),
    tools: {definitions: tools, bindings: [], assertCurrent() {}},
    budget: {activeTimeoutMs: null, ...overrides.budget}, activeBudget: overrides.activeBudget ?? new ActiveExecutionBudget(null),
    commitFence: {assertCurrent() { if (!active) throw new Error('revoked grant'); }},
  };
  const assembly = {
    prompt: 'Generated assembled prompt', contextUsage: metrics, evidence: overrides.evidence ?? empty,
    async readTool(call, signal) { return overrides.readTool ? overrides.readTool(call, signal) : {payload: {text: 'Generated payload'}, confirm() { calls.push('confirm'); }}; },
    async close() { calls.push('bridge.close'); await overrides.close?.(); },
    observe(event) { events.push(event); }, cleanupFailed(errors) { cleanupErrors.push(...errors); },
    ...(overrides.admit ? {admit: overrides.admit} : {}),
  };
  return {deps, calls, events, cleanupErrors, assembly, disposers, get port() { return port; }, revoke() { active = false; }, stop() { scope.abort(); }, create: () => createHostRunSession(deps, assembly)};
}

for (const engine of ['dsh-fixture', 'codex-fixture']) test(`${engine}: real bridge selected ranges feed the same Host output and cannot be widened by candidate JSON`, async () => {
  const input = {question: 'Generated selected question', evidenceIds: [id], evidenceRanges: [{id, offset: 0, length: 9}]};
  const bridge = await startBridge(reader, input);
  try {
    const assembled = assembleHostContext(input, bridge.seedEvidence);
    assert.match(assembled.prompt, /READ_ONLY/); assert.doesNotMatch(assembled.prompt, /UNREAD_SECRET/);
    let validated;
    const f = fixture({input: {...input, validateOutput(answer) { validated = answer; answer.evidenceReadRanges.push({id: unread, offset: 0, length: 100}); }},
      evidence: () => bridge, run: async () => outcome(JSON.stringify({answer: `Generated claim [${id}]`, citationIds: [id], imageReadReceipts: [{id: unread}], evidenceReadRanges: [{id: unread, offset: 0, length: 100}], runId: engine})),
    });
    const session = await f.create(), result = await session.execute();
    assert.equal(result.runId, 'generated-run'); assert.match(result.citations[0].excerpt, /^READ_ONLY/); assert.doesNotMatch(result.citations[0].excerpt, /UNREAD_SECRET/);
    assert.deepEqual(result.evidenceReadRanges, [{id, offset: 0, length: 9}]); assert.deepEqual(result.imageReadReceipts, bridge.imageReadReceipts);
    assert.deepEqual(result.evidenceDependencies, bridge.evidenceDependencies); assert.deepEqual(result.sourceContextDependencies, bridge.sourceContextDependencies);
    assert.notEqual(validated, result); assert.equal(f.events.filter(e => e.event.type === 'run.terminal').length, 1);
    assert.equal(f.events.at(-1).event.terminal.kind, 'completed'); assert.ok(f.calls.indexOf('runtime.close') < f.calls.indexOf('release:mote.agent.runtime'));
    await session.close();
  } finally { await bridge.close(); }
});

test('real bridge image ACK and attribution disclosures alone determine both fixture runtimes receipts and dependencies', async () => {
  const imageId = '33333333-3333-4333-8333-333333333333';
  // Generated one-pixel PNG; no personal image or external decoder/provider.
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6akAAAAASUVORK5CYII=', 'base64');
  const digest = data => createHash('sha256').update(data).digest('hex'), hash = digest(bytes);
  const pin = {sourceId: 'generated:source', version: 1, fingerprint: 'c'.repeat(64)};
  const ref = `source-context:${Buffer.from(pin.sourceId).toString('base64url')}@1#${pin.fingerprint}`;
  const sourceReader = {...reader,
    sources: async () => ({items: [{id: pin.sourceId, name: 'Generated source', sourceContextRef: ref}], nextCursor: null}),
    sourceContext: async () => ({attributionContext: {version: 1, ownerRelation: 'unknown', basis: 'default', sourceContextDeclarations: [pin], sourceContextStatements: [{sourceId: pin.sourceId, version: 1, description: 'Generated owner statement'}]}}),
    readImage: async () => ({mimeType: 'image/png', data: bytes.toString('base64'), imageView: {
      original: {sha256: hash, width: 1, height: 1, mimeType: 'image/png', orientation: 1, pages: 1}, coordinateSpace: 'encoded-raster-pixels-v1', region: null, transform: 'original-bytes@1',
      viewId: digest(JSON.stringify([hash, 'encoded-raster-pixels-v1', null, 'original-bytes@1'])), output: {sha256: hash, width: 1, height: 1, mimeType: 'image/png', sizeBytes: bytes.length},
    }}),
  };
  const bridge = await startBridge(sourceReader, {question: 'Generated image and attribution', directImages: [{id: imageId, name: 'Generated pixel', mimeType: 'image/png', hash, sizeBytes: bytes.length}]});
  try {
    assert.equal((await catalogRequest(bridge, 'sources', {})).status, 200);
    assert.equal((await catalogRequest(bridge, 'attribution_context', {sourceContextRef: ref})).status, 200);
    assert.equal(bridge.records.size, 0); assert.deepEqual(bridge.sourceContextDependencies, [pin]);
    const response = await catalogRequest(bridge, 'read_image', {id: imageId}), image = await response.json(); assert.equal(response.status, 200);
    assert.equal(bridge.records.has(imageId), false); assert.deepEqual(bridge.imageReadReceipts, []);
    bridge.imageDelivery(image.imageDelivery, true);
    assert.equal(bridge.records.has(imageId), true); assert.equal(bridge.imageReadReceipts.length, 1);
    for (const engine of ['dsh-fixture', 'codex-fixture']) {
      const f = fixture({evidence: () => bridge, run: async () => outcome(JSON.stringify({answer: `Generated view [${imageId}]`, citationIds: [imageId], trace: [{tool: engine}], sourceContextDependencies: [{...pin, version: 99}]}))});
      const result = await (await f.create()).execute();
      assert.deepEqual(result.imageReadReceipts, bridge.imageReadReceipts); assert.deepEqual(result.sourceContextDependencies, [pin]);
      assert.deepEqual(result.evidenceDependencies, bridge.evidenceDependencies); assert.deepEqual(result.trace, bridge.trace);
      assert.equal(result.citations[0].id, imageId); assert.ok(!JSON.stringify(result).includes(image.image.data));
    }
  } finally { await bridge.close(); }
});

test('Host snapshot retains private wrapper display coordinates and decodes only delivered original spans', async () => {
  const raw = JSON.stringify({captureId: id, capturedAt: record.capturedAt, appName: record.appName, source: 'message', text: '已读😀\nUNREAD_SECRET_TAIL'});
  const wrapped = {...record, ocrText: raw, evidencePresentation: 'source-record-json-v1'};
  const offset = raw.indexOf('已读'), length = raw.indexOf('UNREAD_SECRET') - offset;
  const input = {question: 'Generated excerpt', evidenceIds: [id], evidenceRanges: [{id, offset, length}]};
  const bridge = await startBridge({...reader, evidence: async () => [wrapped]}, input);
  try {
    const f = fixture({evidence: () => bridge, run: async () => outcome(JSON.stringify({answer: `Generated [${id}]`, citationIds: [id]}))});
    const answer = await (await f.create()).execute();
    assert.equal(answer.citations[0].excerpt, '已读😀\n …');
    assert.doesNotMatch(answer.citations[0].excerpt, /UNREAD|\\n|"source"/);
  } finally { await bridge.close(); }
});

test('unread/truncated citations and malformed JSON remain model-authored repairs with an exact three-correction limit', async () => {
  for (const [text, reason] of [['{', 'invalid_json'], [JSON.stringify({answer: `[${unread}]`, citationIds: [unread]}), 'unretrieved_citation']]) {
    const f = fixture({run: async () => outcome(text), repair: async request => { assert.equal(request.validation.reason, reason); return outcome(text); }});
    const s = await f.create(); await assert.rejects(s.execute(), error => error instanceof AgentResponseError && error.reason === reason);
    assert.equal(s.repairs, 3); assert.equal(f.calls.filter(c => c === 'repair').length, 3); assert.equal(f.events.at(-1).event.terminal.kind, 'rejected');
  }
  const ledger = empty(); ledger.records.set(id, record);
  const f = fixture({evidence: () => ledger, run: async () => outcome(JSON.stringify({answer: '[11111111]', citationIds: [id]})), repair: async request => { assert.equal(request.validation.reason, 'truncated_citation'); return outcome(); }});
  await (await f.create()).execute(); assert.equal(f.calls.filter(c => c === 'repair').length, 1);
});

test('output_limit is rejected even with valid JSON, then requests a shorter complete model response', async () => {
  const f = fixture({run: async () => ({...outcome(), terminal: {kind: 'output_limit'}}), repair: async request => {
    const prompt = JSON.parse(request.prompt); assert.equal(request.validation.reason, 'output_limit'); assert.match(prompt.recovery, /shorter/); return outcome();
  }});
  const s = await f.create(); await s.execute(); assert.equal(s.repairs, 1);
});

test('Memory coverage identities are restored before the real Host domain validator', async () => {
  const key = 'd'.repeat(64); let validations = 0;
  const f = fixture({input: {taskContext: {memoryWork: {members: [{key}], contextMembers: [], authorizedMembers: []}}, validateOutput(answer) {
    validations++; assert.equal(JSON.parse(answer.answer).coverage[0].key, key);
  }}, run: async () => outcome(JSON.stringify({answer: JSON.stringify({coverage: [{key: 'member_0'}]}), citationIds: []}))});
  const result = await (await f.create()).execute(); assert.equal(validations, 1); assert.equal(JSON.parse(result.answer).coverage[0].key, key);
});

test('pure output policy preserves trusted rejection observations without passing a control channel', async () => {
  const events = []; let checks = 0;
  const f = fixture({input: {onTrace: event => events.push(event), hostControlChannel: {execute() { throw Error('not an output port'); }}, validateOutput: () => ++checks === 1 ? {code: 'generated_coverage', feedback: 'Generated correction'} : undefined}});
  const original = f.deps.output.value;
  f.deps.output.value = {evaluate(input) { assert.equal('hostControlChannel' in input.policy, false); assert.equal('onTrace' in input.policy, false); return original.evaluate(input); }};
  await (await f.create()).execute();
  const rejected = events.filter(event => event.type === 'validation.host_rejected');
  assert.equal(rejected.length, 1); assert.deepEqual(rejected[0].payload, {code: 'generated_coverage', feedback: 'Generated correction'});
});

test('all corrections share one active budget while admission queue time remains excluded', async () => {
  let now = 0, corrections = 0;
  const f = fixture({activeBudget: new ActiveExecutionBudget(20, () => now),
    admit: async task => { now += 1000; return task(); },
    run: async () => { now += 15; return outcome('{'); }, repair: async () => { corrections++; now += 5; return outcome('{'); },
  });
  await assert.rejects((await f.create()).execute(), AgentTimeoutError); assert.equal(corrections, 1);
});

test('an independent outer deadline still rejects with active budget disabled', async () => {
  const f = fixture({budget: {deadline: Date.now() - 1}});
  await assert.rejects(f.create(), AgentTimeoutError); assert.equal(f.calls.includes('prepare'), false);
  assert.equal(f.calls.filter(c => c.startsWith('release:')).length, 3);
});

test('missing output, mismatched readiness, unverified tools and typed tool failures cannot produce a repaired success', async () => {
  const missing = fixture(); missing.deps.output.assertCurrent = () => { throw new Error('output unavailable'); };
  await assert.rejects(missing.create(), /output unavailable/); assert.equal(missing.calls.includes('prepare'), false);
  const mismatch = fixture({loadedTools: [{...tools[0], fingerprint: 'b'.repeat(64)}]});
  await assert.rejects(mismatch.create(), {reason: 'tools_unverified'});
  for (const overrides of [{ready: false}, {run: async () => ({terminal: {kind: 'failed', reason: 'tool_failure'}})}]) {
    const f = fixture(overrides); await assert.rejects((await f.create()).execute(), AgentResponseError); assert.equal(f.calls.includes('repair'), false);
  }
});

test('runtime cannot forge terminal events or readiness after preparation', async () => {
  const f = fixture({run: async (request, port) => {
    assert.throws(() => port.emit({type: 'run.terminal', terminal: {kind: 'completed'}}, request.attempt), RuntimeContractError);
    assert.throws(() => port.emit({type: 'tools.ready', tools}, null), RuntimeContractError);
    assert.throws(() => port.emit({type: 'tools.ready', tools}, request.attempt), RuntimeContractError);
    return outcome();
  }}); await (await f.create()).execute();
});

test('Host terminal preserves provider failure, processing limit and typed cancellation independently of cleanup cancellation', async () => {
  for (const terminal of [{kind: 'failed', reason: 'provider_error'}, {kind: 'failed', reason: 'processing_limit'}, {kind: 'cancelled', cause: 'revoked'}, {kind: 'yielded'}]) {
    const f = fixture({run: async () => ({terminal})});
    await assert.rejects((await f.create()).execute(), error => {
      if (terminal.reason === 'processing_limit') assert.equal(error.details.code, 'processing_limit');
      return true;
    });
    assert.equal(f.events.at(-1).event.terminal.kind, terminal.kind);
    if (terminal.kind === 'cancelled') assert.equal(f.events.at(-1).event.terminal.cause, 'revoked');
    assert.equal(f.calls.includes('repair'), false);
  }
});

test('an initial-attempt callback arriving during repair is rejected before read and disclosure', async () => {
  let initial, reads = 0, sends = 0;
  const f = fixture({readTool: async () => { reads++; return {payload: {text: 'secret'}, confirm() {}}; },
    run: async request => { initial = request.attempt; return outcome('{'); },
    repair: async (request, port) => {
      await assert.rejects(port.tools.deliver(initial, {callId: 'old', name: tools[0].name, arguments: {}}, async () => { sends++; }), RuntimeContractError);
      return outcome();
    },
  }); await (await f.create()).execute(); assert.equal(reads, 0); assert.equal(sends, 0);
});

for (const stage of ['read', 'sender']) test(`late initial ${stage} completion cannot disclose or confirm into a repair attempt`, async () => {
  const entered = deferred(), release = deferred(); let late, sends = 0, confirms = 0;
  const f = fixture({readTool: async () => { if (stage === 'read') { entered.resolve(); await release.promise; } return {payload: {text: 'secret'}, confirm() { confirms++; }}; },
    run: async (request, port) => {
      late = port.tools.deliver(request.attempt, {callId: 'old', name: tools[0].name, arguments: {}}, async () => { sends++; entered.resolve(); if (stage === 'sender') await release.promise; });
      void late.catch(() => {}); await entered.promise; return outcome('{');
    }, repair: async () => { release.resolve(); await assert.rejects(late, RuntimeContractError); return outcome(); },
  }); await (await f.create()).execute(); assert.equal(confirms, 0); assert.equal(sends, stage === 'read' ? 0 : 1);
});

test('revocation while the domain validator awaits fences a valid candidate and awaits cleanup', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({input: {validateOutput: async () => { entered.resolve(); await release.promise; }}}), session = await f.create();
  const execution = session.execute(); await entered.promise; f.revoke(); release.resolve();
  await assert.rejects(execution, /revoked grant/); assert.ok(f.calls.includes('runtime.close')); assert.ok(f.calls.includes('bridge.close'));
  assert.notEqual(f.events.at(-1).event.terminal.kind, 'completed');
});

test('a revoke during awaited cleanup is rechecked before successful output can escape', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({runtimeClose: async () => { entered.resolve(); await release.promise; }}), session = await f.create();
  const execution = session.execute(); await entered.promise; f.revoke(); release.resolve(); await assert.rejects(execution, /revoked grant/);
});

test('cleanup is fully awaited, preserves primary response errors and exposes secondary failures', async () => {
  const primary = fixture({run: async () => ({terminal: {kind: 'failed', reason: 'tool_failure'}}), runtimeClose: async () => { throw new Error('runtime cleanup'); }, close: async () => { throw new Error('bridge cleanup'); }});
  await assert.rejects((await primary.create()).execute(), {reason: 'tool_failure'});
  assert.equal(primary.cleanupErrors.length, 2); assert.equal(primary.calls.filter(c => c.startsWith('release:')).length, 3);
  const success = fixture({runtimeClose: async () => { throw new Error('runtime cleanup'); }});
  await assert.rejects((await success.create()).execute(), /runtime cleanup/); assert.equal(success.events.at(-1).event.terminal.kind, 'failed');
  const calls = []; await assert.rejects(settleHostCleanup([() => { calls.push(1); throw Error('one'); }, () => { calls.push(2); throw Error('two'); }], false), AggregateError); assert.deepEqual(calls, [1, 2]);
});

test('scope shutdown during runtime preparation waits for the acquired handle and releases each lease once', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({prepare: async (_port, calls) => { entered.resolve(); await release.promise; return {async run() { return outcome(); }, async repair() { return outcome(); }, async cancel() { calls.push('late.cancel'); }, async close() { calls.push('late.close'); }}; }});
  const creating = f.create(); void creating.catch(() => {}); await entered.promise;
  let closed = false; f.stop(); const closing = f.disposers[0]().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(f.calls.some(c => c.startsWith('release:')), false);
  release.resolve(); await assert.rejects(creating); await closing;
  assert.ok(f.calls.includes('late.close')); assert.equal(f.calls.filter(c => c.startsWith('release:')).length, 3);
});

test('close waits for the runtime invocation as well as the handle cleanup and never publishes its late answer', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({run: async () => { entered.resolve(); await release.promise; return outcome(); }}), session = await f.create();
  const execution = session.execute(); void execution.catch(() => {}); await entered.promise;
  let closed = false; const closing = session.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release.resolve(); await closing; await assert.rejects(execution);
  assert.notEqual(f.events.at(-1).event.terminal.kind, 'completed'); assert.equal(f.calls.filter(c => c.startsWith('release:')).length, 3);
});

test('active timeout drains the underlying model work before releasing Host resources', async () => {
  const model = deferred(), cleaning = deferred();
  const f = fixture({activeBudget: new ActiveExecutionBudget(10), run: async () => { await model.promise; return outcome(); }, runtimeClose: async () => { cleaning.resolve(); }});
  const s = await f.create(); let settled = false;
  const execution = s.execute().finally(() => { settled = true; }); void execution.catch(() => {});
  await cleaning.promise; assert.equal(settled, false); assert.equal(f.calls.some(c => c.startsWith('release:')), false);
  model.resolve(); await assert.rejects(execution, AgentTimeoutError);
  assert.equal(f.events.at(-1).event.terminal.cause, 'deadline_exceeded'); assert.equal(f.calls.filter(c => c.startsWith('release:')).length, 3);
});

test('close also drains a Host domain validator and fences its late acceptance', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({input: {validateOutput: async () => { entered.resolve(); await release.promise; }}}), session = await f.create();
  const execution = session.execute(); void execution.catch(() => {}); await entered.promise;
  let closed = false; const closing = session.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  release.resolve(); await assert.rejects(execution); await closing;
  assert.equal(f.events.at(-1).event.terminal.kind, 'cancelled');
});
