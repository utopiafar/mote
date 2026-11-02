import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';
import {
  NativeDshAssemblyError,
  planNativeDshAssembly,
  readNativeDshManifest,
} from '../dist/runtime/dsh/native-assembly.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/dsh-native-probe/', import.meta.url)).replace(/\/$/, '');
const grants = ['tools', 'hooks', 'factory', 'agents'];

function assertCode(fn, code) {
  assert.throws(fn, error => error instanceof NativeDshAssemblyError && error.code === code);
}

test('native assembly validates public manifest, entries and factory ownership', async () => {
  const manifest = await readNativeDshManifest(fixtureRoot);
  assert.equal(manifest.name, '@mote/dsh-native-probe');
  assert.deepEqual([...manifest.capabilities].sort(), [...grants].sort());

  const plan = planNativeDshAssembly(fixtureRoot, manifest, [
    {id: 'probe-native', subpath: '.', capabilities: ['tools', 'hooks']},
    {id: 'probe-factory', subpath: './factory-a', factory: true, capabilities: ['factory']},
  ], grants);
  assert.equal(plan.entries.length, 2);
  assert.equal(plan.factory?.id, 'probe-factory');
  assert.match(plan.factory.specifier, /^file:\/\/.*factory-a\.mjs$/);
  assert.equal(plan.entries[0].subpath, '.');

  assertCode(() => planNativeDshAssembly(fixtureRoot, manifest, [
    {id: 'missing', subpath: './missing'},
  ], grants), 'native_entry_missing');

  assertCode(() => planNativeDshAssembly(fixtureRoot, manifest, [
    {id: 'one', subpath: './factory-a', factory: true},
    {id: 'two', subpath: './factory-b', factory: true},
  ], grants), 'native_factory_duplicate');

  assertCode(() => planNativeDshAssembly(fixtureRoot, manifest, [
    {id: 'one', subpath: '.', capabilities: ['tools']},
    {id: 'two', subpath: '.'},
  ], grants), 'native_manifest_invalid');

  const partialGrant = planNativeDshAssembly(fixtureRoot, manifest, [
    {id: 'one', subpath: '.', capabilities: ['tools']},
  ], ['tools']);
  assert.equal(partialGrant.entries.length, 1);

  assertCode(() => planNativeDshAssembly(fixtureRoot, manifest, [
    {id: 'one', subpath: './factory-a', capabilities: ['network']},
  ], grants), 'native_capability_denied');

  const conditionalRoot = await mkdtemp(join(tmpdir(), 'mote-native-conditional-'));
  try {
    await writeFile(join(conditionalRoot, 'index.mjs'), 'export default 1;\n');
    await writeFile(join(conditionalRoot, 'generic.mjs'), 'export default 2;\n');
    await writeFile(join(conditionalRoot, 'esm.mjs'), 'export default 3;\n');
    const writeManifest = async exportsValue => writeFile(join(conditionalRoot, 'package.json'), JSON.stringify({
      name: '@mote/conditional-probe',
      version: '0.0.0',
      type: 'module',
      exports: exportsValue,
    }));
    await writeManifest({import: './index.mjs', default: './index.mjs'});
    const conditionalManifest = await readNativeDshManifest(conditionalRoot);
    const conditionalPlan = planNativeDshAssembly(conditionalRoot, conditionalManifest, [
      {id: 'one', subpath: '.'},
    ], grants);
    assert.equal(conditionalPlan.entries[0].subpath, '.');

    await writeManifest({default: './generic.mjs', import: './esm.mjs'});
    const orderedManifest = await readNativeDshManifest(conditionalRoot);
    const orderedPlan = planNativeDshAssembly(conditionalRoot, orderedManifest, [
      {id: 'one', subpath: '.'},
    ], grants);
    assert.match(orderedPlan.entries[0].specifier, /generic\.mjs$/);

    await writeManifest({import: null, default: './index.mjs'});
    await assert.rejects(
      readNativeDshManifest(conditionalRoot),
      error => error instanceof NativeDshAssemblyError && error.code === 'native_entry_missing',
    );
  } finally {
    await rm(conditionalRoot, {recursive: true, force: true});
  }

  const escaped = {...manifest, exports: {'.': '../escape.mjs'}};
  assertCode(() => planNativeDshAssembly(fixtureRoot, escaped, [
    {id: 'one', subpath: '.'},
  ], grants), 'native_entry_escape');

  const missing = {...manifest, exports: {'.': './missing.mjs'}};
  assertCode(() => planNativeDshAssembly(fixtureRoot, missing, [
    {id: 'one', subpath: '.'},
  ], grants), 'native_entry_missing');

  assertCode(() => planNativeDshAssembly(fixtureRoot, manifest, [
    {id: 'one', subpath: '../factory-a'},
  ], grants), 'native_entry_missing');

  const tempRoot = await mkdtemp(join(tmpdir(), 'mote-native-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'mote-native-outside-'));
  try {
    await writeFile(join(outside, 'outside.mjs'), 'export default 1;\n');
    await symlink(join(outside, 'outside.mjs'), join(tempRoot, 'escape.mjs'));
    const symlinked = {...manifest, exports: {'.': './escape.mjs'}};
    assertCode(() => planNativeDshAssembly(tempRoot, symlinked, [
      {id: 'one', subpath: '.'},
    ], grants), 'native_entry_escape');
  } finally {
    await rm(tempRoot, {recursive: true, force: true});
    await rm(outside, {recursive: true, force: true});
  }
});

function sse(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

/** A scripted local OpenAI-compatible model. It never reaches the network. */
async function startFixtureModel() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!req.url?.endsWith('/messages')) {
        res.writeHead(404).end();
        return;
      }
      const payload = JSON.parse(body);
      requests.push(payload);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      sse(res, {type: 'message_start', message: {id: 'msg_probe', usage: {input_tokens: 1, output_tokens: 0}}});
      const hasToolResult = (payload.messages ?? []).some(message =>
        Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
      if (!hasToolResult) {
        sse(res, {type: 'content_block_start', index: 0, content_block: {
          type: 'tool_use', id: 'call_probe_1', name: 'probe_echo', input: {},
        }});
        sse(res, {type: 'content_block_delta', index: 0, delta: {
          type: 'input_json_delta', partial_json: JSON.stringify({value: 'hello-native'}),
        }});
        sse(res, {type: 'content_block_stop', index: 0});
        sse(res, {type: 'message_delta', delta: {stop_reason: 'tool_use'}});
      } else {
        sse(res, {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}});
        sse(res, {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'native tool result observed'}});
        sse(res, {type: 'content_block_stop', index: 0});
        sse(res, {type: 'message_delta', delta: {stop_reason: 'end_turn'}});
      }
      sse(res, {type: 'message_stop'});
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function readTrace(path) {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function sessionFiles(root) {
  const dir = join(root, 'home', 'sessions');
  if (!existsSync(dir)) return [];
  const found = [];
  const visit = async current => {
    for (const entry of await readdir(current, {withFileTypes: true})) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else found.push(path);
    }
  };
  await visit(dir);
  return found;
}

test('real DSH loader runs the native package, changes request config, and restarts factory A to B', {timeout: 120_000}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mote-dsh-native-probe-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, {recursive: true});
  const model = await startFixtureModel();
  const harnesses = [];
  try {
    const manifest = await readNativeDshManifest(fixtureRoot);
    const plan = planNativeDshAssembly(fixtureRoot, manifest, [
      {id: 'probe-native', subpath: '.', capabilities: ['tools', 'hooks']},
      {id: 'probe-factory', subpath: './factory-a', factory: true, capabilities: ['factory']},
      {id: 'probe-control', subpath: './control', capabilities: ['agents']},
    ], grants);

    const makePatch = async (name, factorySubpath) => {
      const factoryPlan = planNativeDshAssembly(fixtureRoot, manifest, [
        {id: 'probe-native', subpath: '.', capabilities: ['tools', 'hooks']},
        {id: 'probe-factory', subpath: factorySubpath, factory: true, capabilities: ['factory']},
        {id: 'probe-control', subpath: './control', capabilities: ['agents']},
      ], grants);
      const patchPath = join(root, `${name}.patch.json`);
      await writeFile(patchPath, JSON.stringify([
        {id: 'agent-loop', disabled: true},
        {id: 'persistent-bash', disabled: true},
        {id: 'persistent-pwsh', disabled: true},
        {id: 'llm-deepseek', config: {
          thinking: 'disabled',
          maxTokens: 1024,
          streamIdleTimeoutMs: 30000,
          baseURL: `http://127.0.0.1:${model.port}/v1`,
          models: [{
            id: 'probe-model',
            name: 'probe-model',
            contextWindow: 128000,
            maxTokens: 1024,
            inputModalities: ['text', 'image'],
          }],
        }},
        {insert: [
          {id: 'probe-native', name: plan.entries[0].specifier},
          {id: 'probe-factory', name: factoryPlan.factory.specifier},
          {id: 'probe-control', name: plan.entries[2].specifier},
        ]},
      ], null, 2), {mode: 0o600});
      return patchPath;
    };

    const run = async (name, factorySubpath, control, sessionId, resumeId) => {
      const tracePath = join(root, `${name}.trace.jsonl`);
      const dshHome = join(root, 'home');
      const cwd = join(root, 'workspace');
      await mkdir(cwd, {recursive: true});
      const harness = new DeepSeekHarness({
        profile: 'sdk-minimal',
        patches: [await makePatch(name, factorySubpath)],
        dshHome,
        cwd,
        processCwd: cwd,
        provider: 'deepseek-official',
        model: 'probe-model',
        initializeTimeoutMs: 30_000,
        requestTimeoutMs: 30_000,
        env: {
          PATH: process.env.PATH,
          TMPDIR: tmpdir(),
          HOME: root,
          DEEPSEEK_API_KEY: 'probe-unused',
          PROBE_TRACE: tracePath,
          PROBE_CONTROL: control,
          PROBE_RESUME_ID: resumeId ?? '',
          PROBE_PROVIDER: 'deepseek-official',
          PROBE_MODEL: 'probe-model',
        },
      });
      harnesses.push(harness);
      try {
        await harness.start();
        const result = await harness.run('run the native probe', {sessionId});
        await harness.close();
        return {result, tracePath, dshHome, stderr: harness.client.stderrTail?.join('\n') ?? ''};
      } catch (error) {
        const stderr = harness.client.stderrTail?.join('\n') ?? '';
        if (stderr) error.message += `\nDSH stderr:\n${stderr}`;
        throw error;
      }
    };

    const a = await run('factory-a', './factory-a', '1', 'probe-session-a');
    const aTrace = await readTrace(a.tracePath);
    const events = aTrace.map(entry => entry.event);
    const turnEnd = [...a.result.events].reverse().find(event => event.type === 'turn/end');
    const errorEvent = [...a.result.events].reverse().find(event => event.type === 'agent/error');
    assert.equal(turnEnd?.data?.reason?.kind, 'completed',
      `turn did not complete: ${JSON.stringify({
        reason: turnEnd?.data?.reason,
        errorEvent,
        firstRequest: model.requests[0] && {
          keys: Object.keys(model.requests[0]),
          tools: model.requests[0].tools?.map(tool => tool.name),
          temperature: model.requests[0].temperature,
          max_tokens: model.requests[0].max_tokens,
        },
        final: a.result.finalResponse,
        requests: model.requests.length,
        stderr: a.stderr,
      })}`);
    assert.ok(events.includes('factory-a-create'), `factory A create missing: ${events.join(',')}`);

    assert.ok(events.includes('native-loaded'), 'native package did not load through the DSH loader');
    assert.ok(events.includes('native-disposed'), 'native package did not unload with its runtime');
    assert.ok(events.includes('native-tool'), `native tool did not execute: ${events.join(',')}`);
    assert.ok(events.includes('request-hook'), 'native request hook did not run');
    assert.ok(events.includes('turn-stopping-steered'), 'turn-stopping did not steer another step');
    assert.ok(events.includes('factory-a-duplicate-rejected'), 'second factory registration must be rejected');
    assert.ok(events.includes('factory-a-disposed'), 'factory A was not disposed');
    assert.ok(events.includes('setup-rejected'), 'setup failure was not rejected');
    assert.ok(events.includes('commit-rejected'), 'commit failure was not rejected');
    assert.ok(events.includes('owner-rejected'), 'owner unload did not reject unpublished setup');
    assert.equal(aTrace.find(entry => entry.event === 'setup-absent')?.absent, true);
    assert.equal(aTrace.find(entry => entry.event === 'commit-absent')?.absent, true);
    assert.equal(aTrace.find(entry => entry.event === 'owner-absent')?.absent, true);

    assert.ok(model.requests.length >= 3, `turn-stopping did not add a model step: ${model.requests.length} requests`);
    const first = model.requests.find(request => Array.isArray(request.tools) && request.tools.some(tool => tool.name === 'probe_echo'));
    assert.ok(first, 'native tool definition did not reach the model request');
    assert.equal(first.temperature, 0.25, 'agent/request hook temperature was not used by the adapter');
    assert.equal(first.max_tokens, 321, 'agent/request hook maxTokens was not used by the adapter');
    const toolResult = model.requests
      .flatMap(request => request.messages ?? [])
      .flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result');
    assert.ok(toolResult, 'tool result did not reach the model request');
    assert.match(JSON.stringify(toolResult), /hello-native/);
    assert.match(a.result.finalResponse, /native tool result observed/);

    const failedSessions = (await sessionFiles(root)).filter(path =>
      /probe-setup-fail|probe-commit-fail|probe-owner-unload/.test(path));
    assert.deepEqual(failedSessions, [], 'failed candidates left a published session');

    const sessionList = (await sessionFiles(root)).join('\n');
    assert.match(sessionList, /probe-session-a/, 'runtime A session was not persisted for resume');

    const b = await run('factory-b', './factory-b', '2', 'probe-session-b', 'probe-session-a');
    const bTrace = await readTrace(b.tracePath);
    const bEvents = bTrace.map(entry => entry.event);
    assert.ok(bEvents.includes('factory-b-create'), 'factory B was not called after restart');
    assert.ok(bEvents.includes('factory-b-resume'), 'factory B resume was not called for the persisted session');
    assert.ok(bEvents.includes('resume-handle-resumed'), 'runtime B did not resume the persisted session');
    assert.ok(!bEvents.includes('factory-a-create'), 'runtime B must not use factory A');
    assert.ok(bEvents.includes('request-hook') && bEvents.includes('native-tool'), 'runtime B did not load the native package');
    assert.match(b.result.finalResponse, /native tool result observed/);
  } finally {
    for (const harness of harnesses.reverse()) {
      await harness.close().catch(() => {});
    }
    await model.close();
    await rm(root, {recursive: true, force: true});
  }
  assert.equal(existsSync(root), false, 'temporary probe root was not removed');
});
