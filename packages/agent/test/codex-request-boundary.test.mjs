import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {zstdDecompressSync} from 'node:zlib';
import {createAgent, AgentProviderError} from '../dist/index.js';
import {estimateSerializedTokens} from '../dist/models/context-budget.js';

const privateDetail = 'GENERATED_PRIVATE_PROVIDER_DETAIL';
const record = {id: '274f8026-73c2-5566-9528-b7aa5fb14de6', capturedAt: '2026-01-01T00:00:00Z', appName: 'Generated fixture', ocrText: 'Generated evidence.'};

async function profile(t) {
  const root = await mkdtemp(join(tmpdir(), 'mote-codex-request-boundary-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(join(root, 'auth.json'), JSON.stringify({OPENAI_API_KEY: 'synthetic-unused-key'}), {mode: 0o600});
  return root;
}

async function messages(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}

function contextReader(onRead) {
  return {
    search: async () => [], evidence: async () => [], devices: async () => [], activity: async () => ({}),
    timeline: async () => {onRead(); return {items: [record], nextCursor: null};},
  };
}

test('Codex context rejection after tool delivery fails without replaying the turn or exposing provider text', async t => {
  for (const mode of ['terminal', 'notification', 'text-only']) await t.test(mode, async t => {
    const root = await profile(t), executable = join(root, 'generated-codex'), transcript = join(root, 'rpc.jsonl');
    await writeFile(executable, `#!${process.execPath}
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({input: process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  appendFileSync(${JSON.stringify(transcript)}, JSON.stringify(m) + '\\n');
  if (m.method === 'initialize') send({id: m.id, result: {}});
  else if (m.method === 'account/read') send({id: m.id, result: {account: {type: 'apiKey'}}});
  else if (m.method === 'thread/start') send({id: m.id, result: {thread: {id: 'generated-thread'}, model: m.params.model, approvalPolicy: 'never', sandbox: {type: 'readOnly'}}});
  else if (m.method === 'turn/start') {
    send({id: m.id, result: {turn: {id: 'generated-turn'}}});
    send({id: 900, method: 'item/tool/call', params: {threadId: 'generated-thread', turnId: 'generated-turn', tool: 'timeline', namespace: null, arguments: {}}});
  } else if (m.id === 900) {
    if (m.result?.success !== true || !JSON.parse(m.result.contentItems[0].text).data.length) process.exit(2);
    const error = {message: ${JSON.stringify(privateDetail + ' context window exceeded')}, ...(${JSON.stringify(mode)} === 'text-only' ? {} : {codexErrorInfo: 'contextWindowExceeded'})};
    if (${JSON.stringify(mode)} === 'notification') send({method: 'error', params: {threadId: 'generated-thread', turnId: 'generated-turn', willRetry: false, error}});
    send({method: 'turn/completed', params: {threadId: 'generated-thread', turn: {id: 'generated-turn', status: 'failed', ...(${JSON.stringify(mode)} === 'notification' ? {} : {error})}}});
  }
});
`, {mode: 0o700});
    let reads = 0, authorizations = 0;
    const events = [];
    const agent = createAgent({reader: contextReader(() => reads++), protocol: 'codex-app-server', model: 'fixture',
      codex: {executable, home: root}, agentTimeoutMs: 5000, contextWindow: 32000, maxTokens: 512,
      authorizeModelRequest: () => {authorizations++;}});
    t.after(() => agent.close());
    await assert.rejects(agent.query({question: 'Read the generated timeline.', hostToolSelection: ['timeline'], onTrace: event => events.push(event)}), error => {
      assert.ok(error instanceof AgentProviderError);
      assert.equal(error.details.code, mode === 'text-only' ? 'provider_failed' : 'processing_limit');
      assert.equal(error.diagnostic.code, mode === 'text-only' ? 'unknown' : 'contextWindowExceeded');
      assert.ok(!JSON.stringify({message: error.message, diagnostic: error.diagnostic, events}).includes(privateDetail));
      return true;
    });
    const rpc = await messages(transcript);
    assert.equal(reads, 1);
    assert.equal(authorizations, 1);
    assert.equal(rpc.filter(message => message.method === 'thread/start').length, 1);
    assert.equal(rpc.filter(message => message.method === 'turn/start').length, 1);
    assert.equal(rpc.filter(message => message.id === 900 && message.result?.success).length, 1);
    assert.ok(!rpc.some(message => message.method === 'thread/compact/start'));
  });
});

// This is a protocol-boundary check, not proof of per-request budget enforcement.
// The installed CLI's actual serialized requests are visible to the loopback
// provider fixture; the production adapter receives turn/item notifications.
test('installed Codex keeps an unclassified upstream rejection terminal after its internal tool continuation', {skip: !process.env.MOTE_TEST_CODEX_BIN, timeout: 30000}, async t => {
  const root = await profile(t), transcript = join(root, 'rpc.jsonl'), notifications = join(root, 'events.jsonl');
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let raw = Buffer.concat(chunks);
    if (request.headers['content-encoding'] === 'zstd') raw = zstdDecompressSync(raw);
    requests.push(JSON.parse(raw.toString()));
    if (requests.length > 1) {
      response.writeHead(400, {'content-type': 'application/json'});
      response.end(JSON.stringify({error: {type: 'invalid_request_error', code: 'context_length_exceeded', message: privateDetail}}));
      return;
    }
    const item = {id: 'generated-call', type: 'function_call', call_id: 'generated-call', name: 'timeline', arguments: '{}', status: 'completed'};
    response.writeHead(200, {'content-type': 'text/event-stream'});
    for (const event of [
      {type: 'response.created', response: {id: 'generated-response', status: 'in_progress'}},
      {type: 'response.output_item.added', output_index: 0, item},
      {type: 'response.output_item.done', output_index: 0, item},
      {type: 'response.completed', response: {id: 'generated-response', status: 'completed', output: [item], usage: {input_tokens: 1, output_tokens: 1, total_tokens: 2}}},
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const provider = {name: 'Generated request boundary', base_url: `http://127.0.0.1:${server.address().port}/v1`, wire_api: 'responses', requires_openai_auth: false};
  const toml = '{' + Object.entries(provider).map(([key, value]) => key + '=' + JSON.stringify(value)).join(',') + '}';
  const executable = join(root, 'codex-wrapper');
  await writeFile(executable, `#!${process.execPath}
import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const child = spawn(${JSON.stringify(process.env.MOTE_TEST_CODEX_BIN)}, [...process.argv.slice(2), '-c', 'model_provider="generated_boundary"', '-c', ${JSON.stringify('model_providers.generated_boundary=' + toml)}], {env: {...process.env, NO_PROXY: '*'}});
process.stdin.on('data', chunk => {appendFileSync(${JSON.stringify(transcript)}, chunk); child.stdin.write(chunk);});
process.stdin.on('end', () => child.stdin.end());
child.stdout.on('data', chunk => {appendFileSync(${JSON.stringify(notifications)}, chunk); process.stdout.write(chunk);});
child.stderr.resume();
child.on('exit', code => process.exit(code ?? 1));
process.on('SIGTERM', () => child.kill('SIGTERM'));
`, {mode: 0o700});
  let reads = 0, authorizations = 0;
  const events = [];
  const agent = createAgent({reader: contextReader(() => reads++), protocol: 'codex-app-server', model: 'gpt-5.4',
    codex: {executable, home: root}, agentTimeoutMs: 20000, contextWindow: 32000, maxTokens: 512,
    authorizeModelRequest: () => {authorizations++;}});
  t.after(() => agent.close());
  await assert.rejects(agent.query({question: 'Read the generated timeline.', hostToolSelection: ['timeline'], onTrace: event => events.push(event)}), error => {
    assert.ok(error instanceof AgentProviderError);
    // This CLI reports the provider's HTTP error as `other`. Its message is
    // untrusted free text at the Host boundary, even though the fixture knows
    // it came from a structured HTTP context_length_exceeded response.
    assert.equal(error.details.code, 'provider_failed');
    assert.equal(error.diagnostic.code, 'unknown');
    assert.ok(!JSON.stringify({message: error.message, diagnostic: error.diagnostic, events}).includes(privateDetail));
    return true;
  });
  const rpc = await messages(transcript), observed = await messages(notifications);
  assert.equal(reads, 1);
  assert.equal(authorizations, 1, 'Host authorization covers the whole App Server turn');
  assert.equal(rpc.filter(message => message.method === 'turn/start').length, 1);
  assert.equal(requests.length, 2, 'the CLI sent the tool continuation without another Host turn');
  const result = requests[1].input.find(item => item.type === 'function_call_output' && item.call_id === 'generated-call');
  assert.ok(result, 'the real serialized follow-up contains the delivered tool result');
  assert.ok(JSON.stringify(result).includes(record.id));
  assert.ok(observed.some(message => message.method === 'error' && message.params.error.codexErrorInfo === 'other' && message.params.willRetry === false));
  assert.ok(observed.some(message => message.method === 'turn/completed' && message.params.turn.status === 'failed'));
  const instructions = events.find(event => event.type === 'instructions.assembled').payload;
  const context = events.find(event => event.type === 'context.assembled').payload;
  t.diagnostic(JSON.stringify({upstreamRequests: requests.length, hostTurnStarts: rpc.filter(message => message.method === 'turn/start').length,
    hostAuthorizations: authorizations, hostInputEstimate: estimateSerializedTokens({system: instructions.system, tools: instructions.tools, prompt: context.prompt}),
    serializedRequestEstimates: requests.map(body => estimateSerializedTokens(body)),
    note: 'Fixture wire observations; no per-request pre-send budget callback exists in the adapter.'}));
});
