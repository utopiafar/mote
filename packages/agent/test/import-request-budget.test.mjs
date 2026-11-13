import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createImportAgent} from '../dist/import-agent.js';
import {AgentProviderError} from '../dist/index.js';
import {estimateSerializedTokens} from '../dist/models/context-budget.js';

const preview = {summary: 'Generated import preview'};
const exceedsBudget = error => error instanceof AgentProviderError && error.details.code === 'processing_limit';

// The real import Harness constructs requests and executes its workspace read
// tool. Only the external model is replaced by this loopback SSE fixture.
async function fixture(t, configuration, reply, authorize = () => {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'mote-import-request-budget-'));
  t.after(() => rm(workspace, {recursive: true, force: true}));
  const requests = [], events = [];
  let authorizations = 0;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const output = reply(requests.length - 1, body);
    if (output === 'overflow') {
      response.writeHead(413, {'content-type': 'application/json'});
      response.end(JSON.stringify({error: {code: 'context_length_exceeded', message: 'Generated overflow'}}));
      return;
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    const tool = typeof output === 'object' && output.tool;
    const delta = tool ? {role: 'assistant', tool_calls: [{index: 0, id: `generated-${requests.length}`, type: 'function', function: {name: tool.name, arguments: JSON.stringify(tool.arguments)}}]} : {role: 'assistant', content: output ?? JSON.stringify(preview)};
    for (const chunk of [
      {choices: [{index: 0, delta, finish_reason: null}]},
      {choices: [{index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop'}]},
    ]) response.write(`data: ${JSON.stringify({id: `generated-${requests.length}`, ...chunk})}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const options = {protocol: 'openai-completions', model: 'generated-import-model', apiKey: 'generated-unused-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 16000, maxTokens: 512, agentTimeoutMs: 15000,
    authorizeModelRequest: () => {authorizations++; return authorize(authorizations);}, ...configuration};
  const agent = createImportAgent(options);
  t.after(() => agent.close());
  return {workspace, requests, events, options, authorizations: () => authorizations,
    prepare: () => agent.prepare({workspace, inputPaths: [], instruction: 'Inspect the generated files and return an import preview.', helperPath: 'generated-unused-helper', manifestSchema: {}}, event => events.push(event))};
}

test('import refuses an irreducible initial request before sending it to the provider', async t => {
  const f = await fixture(t, {contextWindow: 1024, maxTokens: 512}, () => undefined);
  await assert.rejects(f.prepare(), exceedsBudget);
  assert.equal(f.requests.length, 0, 'system instructions, tool schemas, input and output reserve must fit before sending');
  assert.equal(f.authorizations(), 0);
});

test('import checks the complete continuation after a workspace tool read', async t => {
  const f = await fixture(t, {}, stage => stage === 0 ? {tool: {name: 'read', arguments: {file_path: 'generated.txt'}}} : undefined);
  const original = Array(6).fill('汇'.repeat(1500)).join('\n');
  await writeFile(join(f.workspace, 'generated.txt'), original);
  await assert.rejects(f.prepare(), exceedsBudget);
  assert.equal(f.requests.length, 1, 'the unsent large tool result cannot bypass the final request budget');
  assert.ok(f.requests[0].tools.some(tool => tool.function.name === 'read'));
  assert.ok(estimateSerializedTokens(f.requests[0]).tokens + f.options.maxTokens <= f.options.contextWindow);
  assert.ok(JSON.stringify(f.events).includes('End of file'), 'the Harness really completed the workspace read');
  assert.equal(await readFile(join(f.workspace, 'generated.txt'), 'utf8'), original);
  assert.equal(f.authorizations(), 1);
});

test('import bounds provider overflow recovery and rechecks authorization after tool delivery', async t => {
  for (const outcome of ['recovered', 'overflow-again', 'revoked']) await t.test(outcome, async t => {
    const first = 'GENERATED_FIRST_TOOL_CONTENT ' + '汇'.repeat(1500), second = 'GENERATED_SECOND_TOOL_CONTENT';
    const f = await fixture(t, {contextWindow: 24000}, stage => stage < 2 ? {tool: {name: 'read', arguments: {file_path: stage === 0 ? 'first.txt' : 'second.txt'}}} : stage === 2 || outcome === 'overflow-again' ? 'overflow' : undefined,
      attempt => {if (outcome === 'revoked' && attempt === 4) throw new AgentProviderError({category: 'blocked', code: 'context_evidence_restricted'});});
    await writeFile(join(f.workspace, 'first.txt'), first);
    await writeFile(join(f.workspace, 'second.txt'), second);
    if (outcome === 'recovered') assert.deepEqual(await f.prepare(), preview);
    else await assert.rejects(f.prepare(), outcome === 'overflow-again' ? exceedsBudget : error => error.details?.code === 'context_evidence_restricted');
    assert.equal(f.requests.length, outcome === 'revoked' ? 3 : 4, 'at most one retry; revocation stops it before sending');
    assert.equal(f.authorizations(), 4, 'recovery must recheck authorization before sending');
    const rejected = f.requests[2].messages.filter(message => message.role === 'tool');
    assert.equal(rejected.length, 2);
    assert.match(rejected[0].content, /GENERATED_FIRST_TOOL_CONTENT/);
    if (outcome !== 'revoked') {
      const recovered = f.requests[3].messages.filter(message => message.role === 'tool');
      assert.equal(recovered.length, 2);
      assert.match(recovered[0].content, /Previously delivered tool result omitted/);
      assert.deepEqual(recovered[1], rejected[1], 'the new result has not been accepted by the provider and must remain intact');
      assert.ok(recovered[1].content.includes(second));
    }
    for (const body of f.requests) assert.ok(estimateSerializedTokens(body).tokens + f.options.maxTokens <= f.options.contextWindow);
  });
});
