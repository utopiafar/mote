import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomInt} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {auditLock, readCatalog, verifySourceFiles, environmentProblems, projectRoot} from './audit.mjs';

// Diagnostic only: real SDK/native callback, generated model IO, no Mote archive.
// This result is deliberately separate from market installation and Mote integration.
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
let harness, server, directory, timer;
let receipt = {schemaVersion: 1, scope: 'upstream-sdk-only', status: 'blocked',
  sampleId: 'community-calculator', model: 'scripted-loopback', liveModelCalls: 0,
  marketInstallation: 'not_run', moteJourney: 'not_run', cleanupConfirmed: false};
try {
  if (args.length && (args.length !== 2 || args[0] !== '--plugin-dir')) throw Error('Usage: node scripts/dsh-compatibility/native-smoke.mjs --plugin-dir PATH');
  const catalog = await readCatalog();
  receipt = {...receipt, moteCommit: catalog.moteCommit, dshVersion: catalog.dshVersion, node: process.version};
  const problems = environmentProblems(process.version, name => require.resolve(name));
  if (!args[1]) problems.push('pinned_plugin_directory_required');
  if (problems.length) {
    receipt.problems = problems;
    process.exitCode = 2;
  } else {
    auditLock(catalog, await readFile(join(projectRoot, 'package-lock.json')));
    const sample = catalog.samples.find(item => item.id === receipt.sampleId);
    const pluginRoot = await realpath(resolve(args[1]));
    receipt.verifiedSourceFiles = await verifySourceFiles(pluginRoot, sample);
    const pluginRequire = createRequire(join(pluginRoot, 'package.json'));
    assert.equal(await realpath(pluginRequire.resolve('@deepseek-ai/dsh-tools')),
      await realpath(require.resolve('@deepseek-ai/dsh-tools')), 'Plugin and runtime must use the same dsh-tools implementation');
    // Resolve the installed SDK version without relying on package.json exports.
    for (const name of ['@deepseek-ai/dsh-sdk-client', '@deepseek-ai/dsh', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm-pi-ai']) {
      let path = dirname(require.resolve(name)), found = false;
      while (dirname(path) !== path) {
        try {
          const meta = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
          if (meta.name === name) {assert.equal(meta.version, catalog.dshVersion, `Installed version changed: ${name}`); found = true; break;}
        } catch (error) {if (error.code !== 'ENOENT') throw error;}
        path = dirname(path);
      }
      assert.ok(found, `Installed package identity missing: ${name}`);
    }
    const a = randomInt(10, 90), b = randomInt(10, 90), c = randomInt(1, 20);
    const expression = `${a} * ${b} + ${c}`, expected = a * b + c;
    const requests = [], errors = [], events = [];
    server = createServer(async (req, res) => {
      try {
        assert.equal(req.url, '/chat/completions');
        assert.equal(req.headers.authorization, 'Bearer generated-only');
        const chunks = []; let size = 0;
        for await (const chunk of req) {size += chunk.length; assert.ok(size < 2 * 1024 * 1024); chunks.push(chunk);}
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push(request);
        assert.equal(request.dsh_session_log, undefined);
        assert.equal(request.dsh_plugin_packages, undefined);
        assert.ok(request.tools.some(tool => (tool.function?.name ?? tool.name) === 'calculator'));
        assert.ok(requests.length <= 2, 'Unexpected extra model request');
        const first = requests.length === 1;
        if (!first) {
          const result = request.messages.find(message => message.role === 'tool' && message.tool_call_id === 'compat-call');
          assert.ok(result, 'Native tool result was not delivered');
          const text = typeof result.content === 'string' ? result.content : result.content.map(block => block.text || '').join('');
          assert.equal(Number(text.trim()), expected, 'Incorrect native calculator result');
        }
        const delta = first ? {role: 'assistant', tool_calls: [{index: 0, id: 'compat-call', type: 'function', function: {name: 'calculator', arguments: JSON.stringify({expression})}}]}
          : {role: 'assistant', content: 'NATIVE_COMPAT_OK'};
        res.writeHead(200, {'Content-Type': 'text/event-stream'});
        res.write(`data: ${JSON.stringify({id: 'compat', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{index: 0, delta, finish_reason: null}]})}\n\n`);
        res.end(`data: ${JSON.stringify({id: 'compat', choices: [{index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop'}], usage: {prompt_tokens: 80, completion_tokens: 40, total_tokens: 120}})}\n\ndata: [DONE]\n\n`);
      } catch (error) {errors.push(error.message); if (!res.headersSent) res.writeHead(400); res.end('Generated compatibility fixture failed');}
    });
    await new Promise((done, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', done);});
    directory = await mkdtemp(join(tmpdir(), 'mote-dsh-compat-'));
    await mkdir(join(directory, 'workspace')); await mkdir(join(directory, 'home'));
    const guard = join(directory, 'guard.mjs');
    await writeFile(guard, "export const inject=['tools']; export function apply(ctx){ctx.tools.guard(exec=>exec.name==='calculator'?undefined:'This generated probe permits calculator only');}\n");
    const patch = join(directory, 'probe.patch.json');
    await writeFile(patch, JSON.stringify([
      ...['persistent-bash', 'persistent-pwsh', 'terminal-bash', 'terminal-pwsh', 'pty', 'subprocess', 'mcp-resources', 'session-log-deepseek', 'plugin-package-inventory-deepseek', 'llm-deepseek'].map(id => ({id, disabled: true})),
      {id: 'system-prompt', config: {includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'Use calculator for the generated expression.'}},
      {insert: [
        {id: 'compat-llm', name: pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai')).href, config: {providers: {'compat-fixture': {
          api: 'openai-completions', apiKeyEnv: 'MOTE_COMPAT_FIXTURE_KEY', baseURL: `http://127.0.0.1:${server.address().port}`,
          models: [{id: 'fixture-model', name: 'fixture-model', contextWindow: 128000, maxTokens: 512, input: ['text'], reasoningEfforts: false}],
          transport: 'sse', compat: {supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_completion_tokens'},
        }}}},
        {id: 'compat-calculator', name: join(pluginRoot, 'lib/index.js')},
        {id: 'compat-probe-guard', name: guard},
      ]},
    ]));
    const {DeepSeekHarness} = await import('@deepseek-ai/dsh-sdk-client');
    harness = new DeepSeekHarness({profile: 'sdk-minimal', patches: [patch], dshHome: join(directory, 'home'),
      cwd: join(directory, 'workspace'), processCwd: join(directory, 'workspace'), provider: 'compat-fixture', model: 'fixture-model',
      maxTokens: 512, initializeTimeoutMs: 30000, requestTimeoutMs: 30000,
      env: {PATH: process.env.PATH, HOME: join(directory, 'home'), TMPDIR: directory, MOTE_COMPAT_FIXTURE_KEY: 'generated-only'}});
    const result = await Promise.race([
      harness.run(`Calculate ${expression}`, {onNotification: message => {if (message.method === 'session.event') events.push(message.params?.event?.type);}}),
      new Promise((_, reject) => {timer = setTimeout(() => reject(Error('Native probe deadline exceeded')), 60000);}),
    ]);
    assert.deepEqual(errors, []); assert.equal(requests.length, 2);
    assert.equal(result.finalResponse, 'NATIVE_COMPAT_OK');
    assert.ok(events.includes('tool/call') && events.includes('tool/result'), 'Missing actual SDK tool events');
    receipt = {...receipt, status: 'passed', expression, expected, modelRequests: requests.length, toolEvents: events.filter(type => type?.startsWith('tool/'))};
    process.exitCode = 0;
  }
} catch (error) {
  receipt = {...receipt, status: 'failed', error: error.message};
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try {
    await harness?.close();
    if (server?.listening) {server.closeAllConnections(); await new Promise((done, reject) => server.close(error => error ? reject(error) : done()));}
    if (directory) await rm(directory, {recursive: true, force: true});
    receipt.cleanupConfirmed = true;
  } catch (error) {receipt.status = 'failed'; receipt.cleanupError = error.message; process.exitCode = 1;}
  console.log(JSON.stringify(receipt, null, 2));
}
