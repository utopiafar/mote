import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';
import {loadNativeDshGeneration} from '../dist/runtime/dsh/native-lifecycle.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/dsh-native-probe/', import.meta.url));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

async function lifecycleFixture(t) {
  const root = new Context();
  const events = [];
  let activeFactory;
  const disposeStarted = deferred();
  const allowDispose = deferred();
  const ctx = root.extend({agents: {setFactory(factory) {
    if (activeFactory !== undefined) throw new Error('an agent factory is already registered');
    activeFactory = factory;
    return async () => {
      disposeStarted.resolve();
      await allowDispose.promise;
      activeFactory = undefined;
      events.push('factory-disposed');
    };
  }}});
  t.after(() => root.fiber.dispose());
  return {ctx, events, disposeStarted, allowDispose, get activeFactory() { return activeFactory; }};
}

test('duplicate factory and circular inject reject only the candidate generation', async t => {
  const fixture = await lifecycleFixture(t);
  const {ctx, events} = fixture;
  let oldHookCalls = 0;
  const oldFactory = {name: 'old-generation'};
  const disposeOld = await loadNativeDshGeneration(ctx, {
    packages: [{id: 'old-package', plugin: {apply(packageCtx) {
      events.push('old-loaded');
      packageCtx.effect(() => () => events.push('old-disposed'));
    }}}],
    hooks: [{event: 'agr01-old-hook', listener: () => { oldHookCalls++; }}],
    factory: oldFactory,
  });

  await assert.rejects(loadNativeDshGeneration(ctx, {
    packages: [{id: 'failed-package', plugin: {apply(packageCtx) {
      events.push('candidate-loaded');
      packageCtx.effect(() => () => events.push('candidate-disposed'));
    }}}],
    factory: {name: 'duplicate-candidate'},
  }), /already registered/);
  assert.deepEqual(events, ['old-loaded', 'candidate-loaded', 'candidate-disposed']);
  assert.equal(fixture.activeFactory, oldFactory);
  ctx.emit('agr01-old-hook');
  assert.equal(oldHookCalls, 1);

  let cyclicApplications = 0;
  const cyclic = (name, inject) => ({id: name, provides: [name], plugin: {inject, apply() { cyclicApplications++; }}});
  await assert.rejects(loadNativeDshGeneration(ctx, {
    packages: [cyclic('service-a', ['service-b']), cyclic('service-b', ['service-a'])],
  }), /inject cycle/);
  assert.equal(cyclicApplications, 0, 'a cyclic candidate must fail before registering any package');
  assert.equal(fixture.activeFactory, oldFactory);
  ctx.emit('agr01-old-hook');
  assert.equal(oldHookCalls, 2);

  let settled = false;
  const closing = disposeOld();
  void closing.then(() => { settled = true; });
  await fixture.disposeStarted.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'generation unload returned before async factory disposal');
  fixture.allowDispose.resolve();
  await closing;
  await disposeOld();
  assert.equal(fixture.activeFactory, undefined);
  assert.deepEqual(events, ['old-loaded', 'candidate-loaded', 'candidate-disposed', 'factory-disposed', 'old-disposed']);
});

test('acyclic native packages register provider-first regardless of declaration order', async t => {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const events = [];
  const dispose = await loadNativeDshGeneration(ctx, {packages: [
    {id: 'dependent', provides: ['candidateA'], plugin: {inject: ['candidateB'], apply(packageCtx) {
      assert.equal(packageCtx.candidateB.ready, true);
      events.push('dependent');
    }}},
    {id: 'provider', provides: ['candidateB'], plugin: {apply(packageCtx) {
      packageCtx.provide('candidateB', {ready: true});
      events.push('provider');
    }}},
  ]});
  assert.deepEqual(events, ['provider', 'dependent']);
  await dispose();
});

test('host control through the real DSH loader unregisters the native tool and hook', {timeout: 30_000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mote-dsh-native-lifecycle-'));
  const workspace = join(root, 'workspace');
  const tracePath = join(root, 'trace.jsonl');
  await mkdir(workspace, {recursive: true});
  const patchPath = join(root, 'runtime.patch.json');
  await writeFile(patchPath, JSON.stringify([
    {id: 'persistent-bash', disabled: true},
    {id: 'persistent-pwsh', disabled: true},
    {id: 'llm-deepseek', config: {
      thinking: 'disabled',
      maxTokens: 1024,
      streamIdleTimeoutMs: 30000,
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{
        id: 'probe-model',
        name: 'probe-model',
        contextWindow: 128000,
        maxTokens: 1024,
        inputModalities: ['text'],
      }],
    }},
    {insert: [
      {id: 'agr01-generation', name: pathToFileURL(join(fixtureRoot, 'lifecycle.mjs')).href},
      {id: 'agr01-control', name: pathToFileURL(join(fixtureRoot, 'lifecycle-control.mjs')).href},
    ]},
  ]), {mode: 0o600});
  const harness = new DeepSeekHarness({
    profile: 'sdk-minimal',
    patches: [patchPath],
    dshHome: join(root, 'home'),
    cwd: workspace,
    processCwd: workspace,
    provider: 'deepseek-official',
    model: 'probe-model',
    initializeTimeoutMs: 20_000,
    requestTimeoutMs: 20_000,
    env: {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      HOME: root,
      DEEPSEEK_API_KEY: 'probe-unused',
      PROBE_TRACE: tracePath,
    },
  });
  t.after(async () => {
    await harness.close().catch(() => {});
    await rm(root, {recursive: true, force: true});
  });
  try {
    await harness.start();
    await harness.close();
  } catch (error) {
    const stderr = harness.client.stderrTail?.join('\n') ?? '';
    if (stderr) error.message += `\nDSH stderr:\n${stderr}`;
    throw error;
  }
  const trace = (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const before = trace.findIndex(entry => entry.event === 'control-before');
  const after = trace.findIndex(entry => entry.event === 'control-after');
  const disposed = trace.findIndex(entry => entry.event === 'native-disposed');
  const finished = trace.findIndex(entry => entry.event === 'control-finished');
  assert.equal(trace[before]?.tool, true, `native tool was not registered by the real loader: ${JSON.stringify({trace, stderr: harness.client.stderrTail})}`);
  assert.equal(trace[after]?.tool, false, `loader removal left the native tool registered: ${JSON.stringify({trace, stderr: harness.client.stderrTail})}`);
  assert.ok(before < disposed && disposed < after && after < finished, `unexpected unload order: ${JSON.stringify(trace)}`);
  assert.equal(trace.filter(entry => entry.event === 'lifecycle-hook').length, 1, 'native hook survived loader removal');
});
