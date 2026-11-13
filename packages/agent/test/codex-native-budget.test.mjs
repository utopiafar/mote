import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createServer as createTlsServer} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {zstdDecompressSync} from 'node:zlib';
import {WebSocketServer} from 'ws';
import {createAgent, AgentNotConfiguredError, AgentProviderError} from '../dist/index.js';
import {createImportAgent} from '../dist/import-agent.js';
import {estimateSerializedTokens} from '../dist/models/context-budget.js';

const native = fileURLToPath(new URL('../native/codex.mjs', import.meta.url));
const record = {id: '274f8026-73c2-5566-9528-b7aa5fb14de6', capturedAt: '2026-01-01T00:00:00Z', appName: 'Generated fixture', ocrText: '证'.repeat(3000)};
// The reserve is a published model ceiling, even though Host maxTokens is 512.
const reserve = 128_000;

async function generatedTls(root) {
  const run = promisify(execFile), ca = join(root, 'fixture-ca.pem'), caKey = join(root, 'fixture-ca.key');
  const key = join(root, 'fixture-server.key'), csr = join(root, 'fixture-server.csr'), cert = join(root, 'fixture-server.pem');
  const config = join(root, 'fixture-tls.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=Generated loopback fixture\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n', {mode: 0o600});
  const opts = {timeout: 5000, maxBuffer: 4096};
  await run('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1', '-keyout', caKey, '-out', ca, '-config', config, '-extensions', 'ca'], opts);
  await run('openssl', ['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', csr, '-config', config], opts);
  await run('openssl', ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '1', '-extfile', config, '-extensions', 'server'], opts);
  return {ca, key: await readFile(key), cert: await readFile(cert)};
}

async function fixture(t, {mode = 'websocket', reject = 0, window = 144_000, model = 'gpt-5.4', repair = false, chatgpt = false, forceCompaction = false, authRetry = false, nativeWindow = 272000, workspace = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mote-codex-native-budget-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const workspacePath = join(root, 'workspace');
  if (workspace) await mkdir(workspacePath);
  const tls = chatgpt ? await generatedTls(root) : undefined;
  const claims = {exp: Math.floor(Date.now() / 1000) + 3600, 'https://api.openai.com/auth': {chatgpt_plan_type: 'plus', chatgpt_user_id: 'generated-user', chatgpt_account_id: 'generated-account'}};
  const jwt = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.generated-signature';
  await writeFile(join(root, 'auth.json'), JSON.stringify(chatgpt ? {auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: {id_token: jwt, access_token: jwt, refresh_token: 'generated-unused-refresh', account_id: 'generated-account'}, last_refresh: new Date().toISOString()}
    : {OPENAI_API_KEY: 'generated-unused-key'}), {mode: 0o600});
  const rpcPath = join(root, 'rpc.jsonl'), stderrPath = join(root, 'stderr.log'), eventPath = join(root, 'events.jsonl');
  const requests = [], contexts = new Map();
  let generations = 0, upgrades = 0, reads = 0, authorizations = 0, authRetries = 0;
  function reply(body, transport, emit) {
    const parent = body.previous_response_id ? contexts.get(body.previous_response_id) : [];
    assert.ok(parent, 'continuation only inherits observed context from this connection');
    const fullInput = [...parent, ...body.input];
    requests.push({body, transport, fullInput});
    if (body.generate !== false) generations++;
    const responseId = `generated-response-${requests.length}`;
    if (body.generate !== false && (body.input.some(item => item.type === 'compaction_trigger') || generations > 1 && generations <= reject + 1)) {
      emit({type: 'response.failed', response: {id: responseId, status: 'failed', error: {type: 'invalid_request_error', code: 'context_length_exceeded', message: 'Generated private context rejection'}}});
      return;
    }
    let output = [];
    if (body.generate !== false) output = generations === 1 ? [
      {id: 'generated-commentary', type: 'message', role: 'assistant', phase: 'commentary', status: 'completed', content: [{type: 'output_text', text: '证'.repeat(1200), annotations: []}]},
      {id: 'generated-call', type: 'function_call', call_id: 'generated-call', name: workspace ? 'exec_command' : 'timeline',
        arguments: workspace ? JSON.stringify({cmd: 'python3 -c "from pathlib import Path; p=Path(\'execution-count.txt\'); p.write_text(p.read_text()+\'executed\\n\' if p.exists() else \'executed\\n\'); print(\'generated workspace output \'*200)"', max_output_tokens: 3000}) : '{}', status: 'completed'},
    ] : [
      {id: `generated-final-${generations}`, type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{type: 'output_text', text: workspace ? JSON.stringify({summary: 'Generated import preview', recordsPath: null, warnings: [], reviewDecision: null}) : repair && generations === 2 ? '证'.repeat(7000) : JSON.stringify({answer: `Generated answer [${record.id}]`, citationIds: [record.id]}), annotations: []}]},
    ];
    contexts.set(responseId, [...fullInput, ...output]);
    emit({type: 'response.created', response: {id: responseId, status: 'in_progress'}});
    output.forEach((item, output_index) => {
      emit({type: 'response.output_item.added', output_index, item});
      emit({type: 'response.output_item.done', output_index, item});
    });
    emit({type: 'response.completed', response: {id: responseId, status: 'completed', output, usage: {input_tokens: forceCompaction ? 250000 : 1, output_tokens: 1, total_tokens: forceCompaction ? 250001 : 2}}});
  }
  const handler = async (request, response) => {
    if (request.url.startsWith('/backend-api/wham/accounts/check')) {
      response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({accounts: [{id: 'generated-account', workspace_backend_origin: origin, account_routing_override: 'NO_CONSTRAINT'}], default_account_id: 'generated-account'}));
      return;
    }
    if (request.url.startsWith('/backend-api/wham/config/bundle')) {response.writeHead(200, {'content-type': 'application/json'}).end('{}'); return;}
    if (request.method === 'GET' && request.url.split('?')[0].endsWith('/models')) {
      response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify({models: [{
        slug: model, display_name: 'Generated model metadata', description: 'Generated fixture',
        model_messages: {instructions_template: 'Generated fixture model instructions.'},
        default_reasoning_level: 'medium', supported_reasoning_levels: [{effort: 'medium', description: 'Generated fixture'}],
        shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 0,
        supports_reasoning_summary_parameter: true, support_verbosity: false,
        truncation_policy: {mode: 'tokens', limit: 10000}, context_window: nativeWindow,
        effective_context_window_percent: 95, experimental_supported_tools: [],
      }]}));
      return;
    }
    if (request.method !== 'POST' || !request.url.endsWith('/responses')) {response.writeHead(404).end(); return;}
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let raw = Buffer.concat(chunks);
    if (request.headers['content-encoding'] === 'zstd') raw = zstdDecompressSync(raw);
    const body = JSON.parse(raw.toString());
    if (authRetry && generations === 1 && authRetries === 0) {
      authRetries++;
      requests.push({body, transport: 'http', fullInput: body.input});
      const renewed = Buffer.from('{"alg":"none"}').toString('base64url') + '.' + Buffer.from(JSON.stringify({...claims, jti: 'generated-renewal'})).toString('base64url') + '.generated-signature';
      await writeFile(join(root, 'auth.json'), JSON.stringify({auth_mode: 'chatgpt', OPENAI_API_KEY: null,
        tokens: {id_token: renewed, access_token: renewed, refresh_token: 'generated-unused-refresh', account_id: 'generated-account'}, last_refresh: new Date().toISOString()}), {mode: 0o600});
      response.writeHead(401, {'content-type': 'application/json'}).end(JSON.stringify({error: {code: 'token_expired', message: 'Generated auth retry'}}));
      return;
    }
    response.writeHead(200, {'content-type': 'text/event-stream'});
    reply(body, 'http', event => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    response.end();
  };
  const server = tls ? createTlsServer({key: tls.key, cert: tls.cert}, handler) : createServer(handler);
  const sockets = new WebSocketServer({noServer: true});
  sockets.on('connection', socket => socket.on('message', raw => reply(JSON.parse(raw.toString()), 'websocket', event => socket.send(JSON.stringify(event)))));
  server.on('upgrade', (request, socket, head) => {
    upgrades++;
    if (mode === 'http-fallback') {socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;}
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    await new Promise(resolve => sockets.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const executable = join(root, 'codex-wrapper');
  const origin = `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
  const overrides = [`openai_base_url=${JSON.stringify(origin + '/v1')}`, `chatgpt_base_url=${JSON.stringify(origin + '/backend-api')}`,
    ...(forceCompaction ? ['model_auto_compact_token_limit=200000'] : [])];
  await writeFile(executable, `#!${process.execPath}
import {spawn} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const args = process.argv.slice(2);
const child = spawn(${JSON.stringify(native)}, args[0] === '--mote-context-budget-version' ? args : [...args, ...${JSON.stringify(overrides)}.flatMap(value => ['-c', value])], {env: {...process.env, NO_PROXY: '*', ...${JSON.stringify(tls ? {CODEX_CA_CERTIFICATE: tls.ca} : {})}}});
process.stdin.on('data', chunk => {appendFileSync(${JSON.stringify(rpcPath)}, chunk); child.stdin.write(chunk);});
process.stdin.on('end', () => child.stdin.end());
child.stdout.on('data', chunk => {if (args[0] !== '--mote-context-budget-version') appendFileSync(${JSON.stringify(eventPath)}, chunk); process.stdout.write(chunk);});
child.stderr.on('data', chunk => appendFileSync(${JSON.stringify(stderrPath)}, chunk));
child.on('exit', code => process.exit(code ?? 1));
process.on('SIGTERM', () => child.kill('SIGTERM'));
`, {mode: 0o700});
  const agent = (workspace ? createImportAgent : createAgent)({protocol: 'codex-app-server', model, contextWindow: window, maxTokens: 512,
    codex: {home: root, executable}, agentTimeoutMs: 20000, authorizeModelRequest: () => {authorizations++;},
    reader: {search: async () => [], evidence: async () => [], devices: async () => [], activity: async () => ({}),
      timeline: async () => {reads++; return {items: [record], nextCursor: null};}},
  });
  t.after(() => agent.close());
  return {agent, requests, workspacePath, async stats() {
    const rpc = (await readFile(rpcPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    const result = {generations, upgrades, reads, authorizations, turns: rpc.filter(m => m.method === 'turn/start').length,
      compacts: rpc.filter(m => m.method === 'thread/compact/start').length, ...(authRetry ? {authRetries} : {})};
    for (const {body, fullInput} of requests) {
      assert.ok(estimateSerializedTokens({...body, input: fullInput}).tokens + reserve <= window, 'every actual effective request fits with the full reasoning/output reserve');
      assert.ok(estimateSerializedTokens(body).tokens + reserve <= window, 'the final incremental payload also fits');
      assert.equal(body.max_output_tokens, undefined, 'the fixture does not rely on an unsupported output cap');
    }
    return result;
  }, async events() {return (await readFile(eventPath, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);},
  async diagnostics() {
    const errors = (await readFile(eventPath, 'utf8').catch(() => '')).trim().split('\n').filter(line => line.startsWith('{')).map(JSON.parse).filter(event => event.error).map(event => event.error.message);
    return ((await readFile(stderrPath, 'utf8').catch(() => '')) + JSON.stringify(errors)).replaceAll(jwt, '[generated credential]').replaceAll('generated-unused-key', '[generated credential]');
  }};
}

for (const mode of ['websocket', 'http-fallback']) {
  test(`native ${mode} prevents oversized tool continuation and sends one disclosed reduction`, {timeout: 30000}, async t => {
    const f = await fixture(t, {mode});
    try {
      const answer = await f.agent.query({question: 'Read the generated timeline.', hostToolSelection: ['timeline']});
      assert.deepEqual(answer.citations.map(c => c.id), [record.id]);
    } catch (error) {t.diagnostic((await f.diagnostics()).slice(-3500)); throw error;}
    const stats = await f.stats();
    assert.deepEqual({...stats, upgrades: 0}, {generations: 2, upgrades: 0, reads: 1, authorizations: 1, turns: 1, compacts: 0});
    const actual = f.requests.filter(r => r.body.generate !== false);
    const result = actual[1].body.input.find(item => item.type === 'function_call_output');
    assert.ok(result, 'the result retains its matching call');
    assert.equal(result.call_id, 'generated-call');
    t.diagnostic(JSON.stringify({estimates: actual.map(r => estimateSerializedTokens({...r.body, input:r.fullInput}).tokens), outputBytes:result.output.length, coverage:JSON.parse(result.output).budgetCoverage}));
    assert.equal(JSON.parse(result.output).budgetCoverage.truncated, true);
    assert.ok(!JSON.stringify(actual[1].body).includes(record.ocrText));
    if (mode === 'websocket') assert.equal(actual[1].body.previous_response_id, undefined, 'reduction invalidates continuation inheritance');
    t.diagnostic(JSON.stringify({mode, window: 144000, outputReserve: reserve, ...stats,
      effectiveEstimates: actual.map(r => estimateSerializedTokens({...r.body, input: r.fullInput}).tokens)}));
  });

  test(`native ${mode} handles a provider context rejection with one model-step recovery`, {timeout: 30000}, async t => {
    const f = await fixture(t, {mode, window: 160_000, reject: 1});
    await f.agent.query({question: 'Read the generated timeline.', hostToolSelection: ['timeline']});
    const stats = await f.stats();
    assert.equal(stats.generations, 3);
    assert.equal(stats.reads, 1);
    assert.equal(stats.turns, 1);
    assert.equal(stats.compacts, 0);
    assert.ok(JSON.stringify(f.requests.at(-1).body).includes('budgetCoverage'));
  });

  test(`native ${mode} stops a second rejection without turn or tool replay`, {timeout: 30000}, async t => {
    const f = await fixture(t, {mode, window: 160_000, reject: 2});
    await assert.rejects(f.agent.query({question: 'Read the generated timeline.', hostToolSelection: ['timeline']}), error =>
      error instanceof AgentProviderError && error.details.code === 'processing_limit');
    const stats = await f.stats();
    assert.equal(stats.generations, 3);
    assert.equal(stats.reads, 1);
    assert.equal(stats.turns, 1);
    assert.equal(stats.compacts, 0);
  });
}

test('native output repair shares the already consumed context recovery', {timeout: 30000}, async t => {
  const f = await fixture(t, {repair: true});
  await assert.rejects(f.agent.query({question: 'Read the generated timeline.', hostToolSelection: ['timeline']}), error =>
    error instanceof AgentProviderError && error.details.code === 'processing_limit');
  const stats = await f.stats();
  assert.equal(stats.generations, 2, 'oversized Host repair is blocked before the next wire send');
  assert.equal(stats.turns, 2, 'Host output repair uses its existing second turn');
  assert.equal(stats.reads, 1);
  assert.equal(stats.compacts, 0);
});

for (const mode of ['websocket', 'http-fallback']) test(`built-in generated ChatGPT auth uses the same native ${mode} budget gate`, {timeout: 30000}, async t => {
  const f = await fixture(t, {mode, chatgpt: true});
  try {await f.agent.query({question: 'Read the generated timeline.', hostToolSelection: ['timeline']});}
  catch (error) {t.diagnostic((await f.diagnostics()).slice(-2000)); throw error;}
  const stats = await f.stats();
  assert.equal(stats.generations, 2);
  assert.equal(stats.reads, 1);
  assert.ok(JSON.stringify(f.requests.at(-1).body).includes('budgetCoverage'));
  t.diagnostic(JSON.stringify({mode, requests: f.requests.length, warmups: f.requests.filter(r => r.body.generate === false).length}));
});

test('native ChatGPT HTTP authentication retry keeps the prior reduction and does not rerun the tool', {timeout: 30000}, async t => {
  const f = await fixture(t, {mode: 'http-fallback', chatgpt: true, authRetry: true});
  try {await f.agent.query({question: 'Read the generated timeline.', hostToolSelection: ['timeline']});}
  catch (error) {t.diagnostic((await f.diagnostics()).slice(-2000)); throw error;}
  const stats = await f.stats();
  assert.equal(stats.authRetries, 1);
  assert.equal(stats.generations, 2);
  assert.equal(stats.reads, 1);
  assert.equal(stats.turns, 1);
  assert.equal(stats.authorizations, 1);
  assert.ok(f.requests.slice(-2).every(r => JSON.stringify(r.body).includes('budgetCoverage')));
});

test('native model capacity constrains a larger owner window before any send', {timeout: 30000}, async t => {
  const f = await fixture(t, {chatgpt: true, window: 400000, nativeWindow: 132000});
  await assert.rejects(f.agent.query({question: 'Read the generated timeline.', hostToolSelection: ['timeline']}), error =>
    error instanceof AgentProviderError && error.details.code === 'processing_limit');
  const stats = await f.stats();
  assert.equal(stats.generations, 0);
  assert.equal(stats.reads, 0);
});

test('the saved per-query model budget reaches the native gate instead of the shared model default', {timeout: 30000}, async t => {
  const f = await fixture(t, {window: 400000});
  await assert.rejects(f.agent.query({question: 'Read the generated timeline.', hostToolSelection: ['timeline'],
    modelBudget: {contextWindow: 132000, maxTokens: 512, historyRatio: 0.5, lowWatermarkRatio: 0.5,
      tokenCounting: 'estimated', contextWindowSource: 'configured'}}), error =>
    error instanceof AgentProviderError && error.details.code === 'processing_limit');
  const stats = await f.stats();
  assert.equal(stats.generations, 0);
  assert.equal(stats.reads, 0);
});

test('native import recovery preserves a real workspace tool result without executing its command again', {timeout: 30000}, async t => {
  const f = await fixture(t, {workspace: true, window: 160000, mode: 'http-fallback', reject: 1});
  try {
    const preview = await f.agent.prepare({workspace: f.workspacePath, inputPaths: [], instruction: 'Generate a preview from the fixture.', helperPath: 'generated', manifestSchema: {}});
    assert.equal(preview.summary, 'Generated import preview');
  } catch (error) {t.diagnostic((await f.diagnostics()).slice(-2500)); throw error;}
  assert.equal(await readFile(join(f.workspacePath, 'execution-count.txt'), 'utf8'), 'executed\n');
  const stats = await f.stats();
  assert.equal(stats.generations, 3);
  assert.equal(stats.turns, 1);
  assert.equal(stats.compacts, 0);
  assert.ok(JSON.stringify(f.requests.at(-1).body).includes('budgetCoverage'));
});

for (const window of [144000, 160000]) test(`native automatic compaction shares the recovery and cannot loop: W=${window}`, {timeout: 30000}, async t => {
  const f = await fixture(t, {forceCompaction: true, window});
  await assert.rejects(f.agent.query({question: 'Read the generated timeline.', hostToolSelection: ['timeline']}), error =>
    error instanceof AgentProviderError && error.details.code === 'processing_limit');
  const stats = await f.stats();
  const events = await f.events();
  assert.ok(events.some(event => event.method === 'item/started' && event.params?.item?.type === 'contextCompaction'), 'the native runtime really entered internal compaction');
  const compactRequests = f.requests.filter(r => r.body.input.some(item => item.type === 'compaction_trigger'));
  assert.equal(compactRequests.length, window === 144000 ? 0 : 1, 'oversized compaction is blocked; a provider rejection never starts another compaction');
  assert.equal(stats.reads, 1);
  assert.equal(stats.turns, 1);
});

for (const model of ['gpt-5.4', 'generated-unknown-model']) test(`native irreducible input or missing output capability fails before send: ${model}`, {timeout: 30000}, async t => {
  const f = await fixture(t, {model});
  await assert.rejects(f.agent.query({question: '证'.repeat(5000), hostToolSelection: ['timeline']}), error =>
    error instanceof AgentProviderError && error.details.code === 'processing_limit');
  const stats = await f.stats();
  assert.equal(stats.generations, 0);
  assert.equal(stats.reads, 0);
  assert.equal(stats.turns, 1);
});

test('production startup rejects an unpatched executable before linking credentials', {timeout: 10000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mote-unpatched-codex-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const executable = join(root, 'unpatched');
  await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write('unpatched');\n`, {mode: 0o700});
  const agent = createAgent({protocol: 'codex-app-server', model: 'gpt-5.4', codex: {home: root, executable}, reader: {}});
  t.after(() => agent.close());
  await assert.rejects(agent.query({question: 'Generated question'}), error =>
    error instanceof AgentProviderError && error.details.code === 'processing_limit' && error.diagnostic.code === 'native_budget_unavailable');
});

test('default production startup selects the bundled native dependency before asking for login', {timeout: 10000}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'mote-bundled-codex-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const override = process.env.MOTE_CODEX_BIN;
  delete process.env.MOTE_CODEX_BIN;
  t.after(() => {if (override !== undefined) process.env.MOTE_CODEX_BIN = override;});
  const agent = createAgent({protocol: 'codex-app-server', model: 'gpt-5.4', codex: {home: root}, reader: {}});
  t.after(() => agent.close());
  // With no auth file the normal login error is reached only after the bundled
  // executable has actually passed its capability probe. No thread is started.
  await assert.rejects(agent.query({question: 'Generated question'}), AgentNotConfiguredError);
});
