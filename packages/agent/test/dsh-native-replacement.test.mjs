import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Context} from '@deepseek-ai/cordis';
import {DeepSeekHarness} from '@deepseek-ai/dsh-sdk-client';
import {NativeDshGenerationRegistry} from '../dist/runtime/dsh/native-lifecycle.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/dsh-native-probe/', import.meta.url));

function extension(name, version, tool, events) {
  return {
    package: {
      id: name,
      descriptor: {id: name, version, replacement: 'hot'},
      plugin: {inject: ['tools'], apply(ctx) {
        events.push(`${name}-loaded`);
        ctx.effect(() => () => events.push(`${name}-disposed`));
        const dispose = ctx.tools.register({name: tool, description: `${name} generated tool`});
        ctx.effect(() => () => dispose());
      }},
    },
    hook: {event: 'agr02/extension', descriptor: {id: name, version, replacement: 'hot'},
      listener: payload => events.push(`${name}-hook:${payload.agent.id}`)},
  };
}

test('hot replacement keeps the old generation for in-flight runs and rolls back a failed candidate', async t => {
  const root = new Context(), events = [], tools = new Map(), guards = [];
  root.provide('tools', {
    register(definition) {
      if (tools.has(definition.name)) throw new Error(`tool "${definition.name}" is already registered`);
      tools.set(definition.name, definition);
      return () => { if (tools.get(definition.name) === definition) tools.delete(definition.name); };
    },
    schemas() { return [...tools.values()]; },
    guard(guard) { guards.push(guard); return () => { const index = guards.indexOf(guard); if (index >= 0) guards.splice(index, 1); }; },
  });
  const ctx = root;
  const registry = new NativeDshGenerationRegistry(ctx, {onDisposeError: error => events.push(`dispose-error:${error}`)});
  t.after(async () => { await registry.close(); await root.fiber.dispose(); });

  const foundation = {id: 'foundation', descriptor: {id: 'foundation', version: '1', replacement: 'restart'},
    plugin: {apply(ctx) {
      events.push('foundation-loaded');
      ctx.effect(() => () => events.push('foundation-disposed'));
    }}};
  const a = extension('extension-a', '1', 'agr02_tool_a', events);
  const initial = await registry.replace({packages: [foundation, a.package], hooks: [a.hook]});
  assert.equal(initial.state, 'ready');
  assert.equal(initial.generation, 1);
  assert.equal(events.filter(event => event === 'foundation-loaded').length, 1);
  const runA = registry.beginRun('run-a');

  const failed = extension('extension-failed', '1', 'agr02_tool_a', events);
  const rolledBack = await registry.replace({packages: [foundation, failed.package], hooks: [failed.hook]});
  assert.equal(rolledBack.state, 'failed');
  assert.equal(rolledBack.generation, 1);
  assert.ok(events.includes('extension-failed-loaded') && events.includes('extension-failed-disposed'), events.join(','));
  assert.equal(tools.has('agr02_tool_a'), true, 'the failed candidate removed the active tool');
  assert.equal(events.includes('extension-a-disposed'), false, 'a stale candidate disposer removed generation A');
  ctx.emit('agr02/extension', {agent: {id: 'run-a'}});
  assert.equal(events.filter(event => event === 'extension-a-hook:run-a').length, 1);
  assert.equal(events.some(event => event.startsWith('extension-failed-hook:')), false);

  const b = extension('extension-b', '2', 'agr02_tool_b', events);
  const replaced = await registry.replace({packages: [foundation, b.package], hooks: [b.hook]});
  assert.equal(replaced.state, 'ready');
  assert.ok(replaced.generation > initial.generation);
  assert.equal(events.filter(event => event === 'foundation-loaded').length, 1, 'the unchanged foundation was reloaded');
  assert.equal(events.includes('foundation-disposed'), false, 'a hot replacement disposed the foundation');
  const runB = registry.beginRun('run-b');
  assert.equal(tools.has('agr02_tool_a'), true, 'the in-flight run lost its old tool');
  assert.equal(tools.has('agr02_tool_b'), true, 'the new generation did not prepare its tool');
  assert.equal(guards.length, 1, 'the registry did not install its generation tool guard');
  assert.equal(guards[0]({name: 'agr02_tool_a', agent: {id: 'run-a'}}), undefined);
  assert.equal(guards[0]({name: 'agr02_tool_b', agent: {id: 'run-b'}}), undefined);
  assert.match(guards[0]({name: 'agr02_tool_b', agent: {id: 'run-a'}}), /another native generation/);
  assert.match(guards[0]({name: 'agr02_tool_a', agent: {id: 'run-b'}}), /another native generation/);

  ctx.emit('agr02/extension', {agent: {id: 'run-a'}});
  ctx.emit('agr02/extension', {agent: {id: 'run-b'}});
  assert.equal(events.filter(event => event === 'extension-a-hook:run-a').length, 2, 'run A observed generation B');
  assert.equal(events.filter(event => event === 'extension-b-hook:run-b').length, 1);
  assert.equal(events.some(event => event === 'extension-b-hook:run-a'), false, 'run A mixed generations');
  assert.equal(events.some(event => event === 'extension-a-hook:run-b'), false, 'run B mixed generations');

  await runA.release();
  assert.equal(events.includes('extension-a-disposed'), true);
  assert.equal(tools.has('agr02_tool_a'), false);
  assert.equal(tools.has('agr02_tool_b'), true, 'disposing A removed B resources');

  await runB.release();
  assert.equal(events.includes('extension-b-disposed'), false, 'the active generation was disposed by a stale run');
  await registry.close();
  assert.equal(events.includes('extension-b-disposed'), true);
  assert.equal(events.includes('foundation-disposed'), true);
  assert.equal(guards.length, 0, 'the registry guard survived shutdown');
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
          type: 'input_json_delta', partial_json: JSON.stringify({value: 'replacement-probe'}),
        }});
        sse(res, {type: 'content_block_stop', index: 0});
        sse(res, {type: 'message_delta', delta: {stop_reason: 'tool_use'}});
      } else {
        sse(res, {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}});
        sse(res, {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'replacement factory result observed'}});
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
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function readTrace(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('restart-required factory replacement becomes effective only in a fresh DSH process', {timeout: 120_000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mote-dsh-replacement-'));
  const workspace = join(root, 'workspace');
  const model = await startFixtureModel();
  const harnesses = [];
  await mkdir(workspace, {recursive: true});
  t.after(async () => {
    for (const harness of harnesses.reverse()) await harness.close().catch(() => {});
    await model.close();
    await rm(root, {recursive: true, force: true});
  });

  const run = async (name, mode) => {
    const tracePath = join(root, `${name}.trace.jsonl`);
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
        models: [{id: 'probe-model', name: 'probe-model', contextWindow: 128000, maxTokens: 1024, inputModalities: ['text']}],
      }},
      {insert: [
        {id: 'replacement-control', name: pathToFileURL(join(fixtureRoot, 'replacement.mjs')).href},
      ]},
    ], null, 2), {mode: 0o600});
    const harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      patches: [patchPath],
      dshHome: join(root, 'home'),
      cwd: workspace,
      processCwd: workspace,
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
        PROBE_REPLACEMENT: mode,
      },
    });
    harnesses.push(harness);
    try {
      await harness.start();
      const result = await harness.run('run the replacement probe', {sessionId: `probe-${name}`});
      await harness.close();
      return {result, trace: await readTrace(tracePath)};
    } catch (error) {
      const stderr = harness.client.stderrTail?.join('\n') ?? '';
      if (stderr) error.message += `\nDSH stderr:\n${stderr}`;
      throw error;
    }
  };

  const before = await run('before-restart', 'attempt-b');
  const beforeEvents = before.trace.map(entry => entry.event);
  assert.equal(before.trace.find(entry => entry.event === 'replacement-initial')?.state, 'ready');
  assert.equal(before.trace.find(entry => entry.event === 'replacement-attempt')?.state, 'restart-required');
  assert.equal(before.trace.find(entry => entry.event === 'replacement-attempt')?.restartRequired, true);
  assert.ok(beforeEvents.includes('factory-a-create'), `the running factory was replaced without a restart: ${beforeEvents.join(',')}`);
  assert.ok(!beforeEvents.includes('factory-b-create'), 'factory B loaded before restart');
  assert.ok(beforeEvents.includes('native-tool'), 'the live generation stopped serving its tool');

  const after = await run('after-restart', 'b');
  const afterEvents = after.trace.map(entry => entry.event);
  assert.equal(after.trace.find(entry => entry.event === 'replacement-initial')?.state, 'ready');
  assert.ok(afterEvents.includes('factory-b-create'), `factory B was not used after restart: ${afterEvents.join(',')}`);
  assert.ok(!afterEvents.includes('factory-a-create'), 'factory A served the restarted process');
  assert.ok(afterEvents.includes('native-tool'));
  assert.match(after.result.finalResponse, /replacement factory result observed/);
});
