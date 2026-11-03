import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostRunSession} from '../dist/host/run-session.js';
import {createHostOutputProvider} from '../dist/host/output.js';
import {ActiveExecutionBudget} from '../dist/active-budget.js';
import {AgentTimeoutError} from '../dist/types.js';
import {createHostRunEventBarrier, createHostRunLifecycle} from '../dist/host/run-lifecycle.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
const tools = [{name: 'generated_read', version: '1', fingerprint: 'a'.repeat(64), description: 'Generated read', inputSchema: {type: 'object'}}];
const metrics = {unit: 'utf16_characters', system: 0, tools: 0, question: 0, conversation: 0, task: 0, evidence: 0, prompt: 0, outputTokenReserve: 100, toolResults: 0};
const empty = () => ({records: new Map(), deliveredRanges: [], imageReadReceipts: [], sourceContextDependencies: [], evidenceDependencies: {version: 1, complete: true, ids: []}, trace: [], deliveredCharacters: 0});
const outcome = () => ({terminal: {kind: 'completed'}, candidate: {text: JSON.stringify({answer: 'Generated late answer', citationIds: []})}});

function fixture(overrides = {}) {
  const calls = [], events = [], cleanupErrors = [], scope = new AbortController(), input = new AbortController(), disposers = [], leaseControllers = new Map();
  let active = true, port, attempt;
  const scopeIdentity = {packageId: 'generated', installationId: 'install', instanceId: 'instance', host: {kind: 'central', id: 'fixture'}, activationId: 'active'};
  const binding = service => ({service: {id: service, apiVersion: '1'}, provider: {scope: scopeIdentity, contributionId: service}, revision: 1});
  const lease = (service, value) => {
    let live = true; const provider = new AbortController(), released = new AbortController(); leaseControllers.set(service, provider);
    return {binding: binding(service), value, signal: AbortSignal.any([scope.signal, provider.signal, released.signal]), assertCurrent() { if (!live || provider.signal.aborted) throw new Error('released/revoked lease'); }, release() { if (live) { live = false; calls.push(`release:${service}`); released.abort(); } return Promise.resolve(); }};
  };
  const modelSelection = {modelId: 'generated', modelRevision: 1, profileId: 'model-profile', profileRevision: 1, transport: 'fixture'};
  const provider = {capabilities: {}, async prepare(_profile, _model, host) {
    calls.push('prepare'); port = host;
    if (overrides.ready !== false) host.emit({type: 'tools.ready', tools}, null);
    return {
      async run(request) {
        calls.push('run'); attempt = request.attempt; overrides.onRun?.(request, host);
        return host.runModel(request.attempt, () => overrides.run ? overrides.run(request, host) : Promise.resolve(outcome()));
      },
      async repair() { calls.push('repair'); return outcome(); },
      async cancel() { calls.push('cancel'); await overrides.cancel?.(); },
      async close() { calls.push('runtime.close'); await overrides.runtimeClose?.(); },
    };
  }};
  const runtime = lease('mote.agent.runtime', provider);
  const queryInput = {question: 'Generated lifecycle question', signal: input.signal, ...overrides.input};
  const deps = {
    scope: {identity: scopeIdentity, signal: scope.signal, assertCurrent() { if (!active) throw new Error('revoked grant'); }, defer(dispose) { disposers.push(dispose); }},
    identity: {runId: 'generated-run', runtime: {id: 'fixture', revision: 1, profileId: 'runtime-profile', profileRevision: 1, assemblyFingerprint: 'a'.repeat(64)}, model: modelSelection},
    input: queryInput, profile: {binding: runtime.binding, runtimeId: 'fixture', profileId: 'runtime-profile', profileRevision: 1, assemblyFingerprint: 'a'.repeat(64), taskKind: 'query', configuration: {}},
    runtime, model: {...lease('generated.model', {}), selection: modelSelection}, output: lease('mote.agent.host-output', createHostOutputProvider()),
    tools: {definitions: tools, bindings: [], assertCurrent() {}},
    budget: {activeTimeoutMs: null, ...overrides.budget}, activeBudget: overrides.activeBudget ?? new ActiveExecutionBudget(null),
    commitFence: {assertCurrent() { if (!active) throw new Error('revoked grant'); }},
  };
  const assembly = {
    systemPrompt: 'Generated Host system policy', prompt: 'Generated assembled prompt', contextUsage: metrics, evidence: empty,
    async readTool() { calls.push('read'); return overrides.readTool ? overrides.readTool() : {payload: {text: 'Generated payload'}, confirm() { calls.push('confirm'); }, discard() { calls.push('discard'); }}; },
    async close() { calls.push('bridge.close'); await overrides.close?.(); },
    observe(event) { events.push(event); }, cleanupFailed(errors) { cleanupErrors.push(...errors); },
    ...(overrides.admit ? {admit: overrides.admit} : {}),
  };
  return {deps, calls, events, cleanupErrors, assembly, disposers, input, scope, get port() { return port; }, get attempt() { return attempt; }, stop(reason) { scope.abort(reason); }, revokeLease(service) { leaseControllers.get(service).abort({kind: 'revoked'}); }, create: () => createHostRunSession(deps, assembly)};
}

test('the lifecycle barrier releases once, keeps the first cause and drops later commits', () => {
  const lifecycle = createHostRunLifecycle();
  let commits = 0;
  assert.equal(lifecycle.phase, 'prepare');
  assert.equal(lifecycle.eventsOpen, true);
  assert.equal(lifecycle.commitEvent(() => ++commits), 1);
  assert.deepEqual(lifecycle.cancel({kind: 'cancelled'}), {kind: 'cancelled'});
  assert.equal(lifecycle.eventsOpen, false);
  assert.deepEqual(lifecycle.cancel({kind: 'deadline_exceeded'}), {kind: 'cancelled'}, 'a later point cannot replace the first classification');
  assert.equal(lifecycle.commitEvent(() => ++commits), undefined);
  assert.equal(commits, 1);
  lifecycle.setPhase('closing'); assert.equal(lifecycle.phase, 'closing');
  lifecycle.releaseEvents(); assert.equal(lifecycle.eventsOpen, false);
  const barrier = createHostRunEventBarrier();
  assert.equal(barrier.released, false); barrier.release(); assert.equal(barrier.released, true);
  assert.deepEqual(barrier.commit(() => 'late'), {committed: false});
});

for (const point of ['input', 'scope', 'lease', 'deadline', 'cancel', 'close']) {
  test(`controlled ${point} cancellation releases the Host barrier before late tool, terminal and usage events`, {timeout: 5000}, async () => {
    const entered = deferred(), release = deferred();
    let reads = 0, sends = 0, confirms = 0, discards = 0, validations = 0, lateResults = [];
    const f = fixture({run: async () => { entered.resolve(); await release.promise; return outcome(); },
      readTool: () => { reads++; return {payload: {text: 'Generated late payload'}, confirm() { confirms++; }, discard() { discards++; }}; },
      input: {validateOutput() { validations++; }},
      ...(point === 'deadline' ? {budget: {deadline: Date.now() + 25}} : {}),
    });
    const session = await f.create();
    const execution = session.execute();
    await entered.promise;
    const reason = new DOMException('Generated first cancellation', 'AbortError');
    if (point === 'input') f.input.abort(reason);
    else if (point === 'scope') f.stop(reason);
    else if (point === 'lease') f.revokeLease('mote.agent.runtime');
    else if (point === 'cancel') await session.cancel({kind: 'cancelled'});
    else if (point === 'close') await new Promise(resolve => setImmediate(resolve));
    if (point === 'close') void session.close().catch(() => {});
    if (point === 'deadline') await new Promise(resolve => f.port.signal.addEventListener('abort', resolve, {once: true}));
    else await new Promise(resolve => setImmediate(resolve));

    const late = async (name, invoke) => {
      try { await invoke(); lateResults.push(`${name}:committed`); }
      catch (error) { lateResults.push(`${name}:${error.constructor.name}`); }
    };
    await late('usage', () => f.port.emit({type: 'usage', usage: {requests: 1, reportedRequests: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15}}, f.attempt));
    await late('progress', () => f.port.emit({type: 'progress', progress: {stage: 'model'}}, f.attempt));
    await late('tool', () => f.port.tools.deliver(f.attempt, {callId: 'generated-late', name: tools[0].name, arguments: {}}, async () => { sends++; }));
    await late('ready', () => f.port.emit({type: 'tools.ready', tools}, null));

    release.resolve();
    const rejection = await execution.then(() => undefined, error => error);
    assert.ok(rejection, 'a cancelled run cannot return a product answer');
    if (point === 'close') await session.close();

    assert.equal(validations, 0, 'no product output was committed');
    assert.equal(reads, 0, 'no late tool read started');
    assert.equal(sends, 0, 'no late tool payload was sent');
    assert.equal(confirms, 0, 'no late delivery receipt was confirmed');
    assert.equal(discards, 0, 'no staged delivery existed');
    assert.equal(lateResults.length, 4);
    assert.equal(lateResults.every(result => !result.endsWith(':committed')), true, 'no late event was committed');
    assert.equal(f.events.some(event => event.event.type === 'attempt.terminal'), false, 'a late runtime terminal was not observed');
    assert.equal(f.events.some(event => event.event.type === 'usage' || event.event.type === 'progress'), false, 'late samples were not observed');
    const terminals = f.events.filter(event => event.event.type === 'run.terminal');
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].event.terminal.kind, 'cancelled');
    if (point === 'lease') assert.equal(terminals[0].event.terminal.cause, 'revoked');
    else if (point === 'deadline') assert.equal(terminals[0].event.terminal.cause, 'deadline_exceeded');
    if (point === 'input' || point === 'scope') assert.equal(rejection, reason, 'the original cancellation reason remains the thrown error');
    if (point === 'deadline') assert.ok(rejection instanceof AgentTimeoutError);
    assert.ok(f.calls.includes('runtime.close')); assert.ok(f.calls.includes('bridge.close'));
    assert.equal(f.calls.filter(call => call.startsWith('release:')).length, 3);
    assert.equal(f.cleanupErrors.length, 0);
  });
}

test('a pending admission is released on cancellation and a late runModel cannot acquire another slot', {timeout: 5000}, async () => {
  const queued = deferred(), startedRun = deferred();
  let admissions = 0, slots = 0, started = 0;
  const f = fixture({
    onRun() { startedRun.resolve(); },
    admit: async (task, signal) => {
      admissions++; slots++;
      try {
        await Promise.race([queued.promise, new Promise((_resolve, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), {once: true});
        })]);
        signal.throwIfAborted();
        started++;
        return await task();
      } finally { slots--; }
    },
    run: async (request, host) => {
      try { return await host.runModel(request.attempt, async () => outcome()); }
      catch { return {terminal: {kind: 'cancelled', cause: 'cancelled'}}; }
    },
  });
  const session = await f.create();
  const execution = session.execute();
  await startedRun.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admissions, 1); assert.equal(slots, 1);
  const reason = new DOMException('Generated admission cancellation', 'AbortError');
  f.input.abort(reason);
  queued.resolve();
  const rejection = await execution.then(() => undefined, error => error);
  assert.equal(rejection, reason);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(slots, 0, 'the cancelled admission slot was released');
  assert.equal(started, 0, 'queued work did not start after cancellation');
  await assert.rejects(f.port.runModel(f.attempt, async () => outcome()));
  assert.equal(admissions, 1, 'a late model request cannot acquire another admission slot');
  assert.ok(f.calls.includes('runtime.close')); assert.ok(f.calls.includes('bridge.close'));
  await session.close();
});

test('the first error classification survives later cancellation and cleanup failure', {timeout: 5000}, async () => {
  const entered = deferred(), release = deferred(), first = Error('Generated first classification');
  const f = fixture({budget: {deadline: Date.now() + 30}, runtimeClose: async () => { throw Error('Generated secondary cleanup'); },
    run: async () => { entered.resolve(); await release.promise; return outcome(); }});
  const session = await f.create();
  const execution = session.execute();
  await entered.promise;
  f.input.abort(first);
  await new Promise(resolve => setImmediate(resolve));
  await session.cancel({kind: 'revoked'});
  await new Promise(resolve => setTimeout(resolve, 40));
  release.resolve();
  const rejection = await execution.then(() => undefined, error => error);
  assert.equal(rejection, first, 'the first thrown error is preserved');
  const terminal = f.events.find(event => event.event.type === 'run.terminal');
  assert.deepEqual(terminal.event.terminal, {kind: 'cancelled', cause: 'cancelled'});
  assert.equal(f.cleanupErrors.length, 1);
  assert.match(f.cleanupErrors[0].message, /Generated secondary cleanup/);
});
