import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {PluginHost, PluginResourceScope} from '@mote/plugin-host';
import {AgentProviderError} from '../dist/types.js';
import {ActiveExecutionBudget} from '../dist/active-budget.js';
import {createHostOutputProvider} from '../dist/host/output.js';
import {hostOutputService} from '../dist/host/run-contracts.js';
import {runtimeService} from '../dist/runtime/contracts.js';
import {resolveRunSelection} from '../dist/runtime/profile.js';
import {CODEX_RUNTIME_ID, codexRuntimePlugin, prepareCodexRun} from '@mote/agent/runtime/codex';
import {CODEX_APP_SERVER_ARGS} from '../dist/runtime/codex/launch.js';

const secret = 'generated-auth-secret-never-disclosed';
const modelId = 'generated-codex-model';
const hostIdentity = {kind: 'central', id: 'generated-host'};
const identity = id => ({packageId: id, installationId: `generated-install-${id}`, instanceId: id, activationId: `generated-activation-${id}`, host: hostIdentity});
const answerSchema = {type: 'object', properties: {answer: {type: 'string'}, citationIds: {type: 'array', items: {type: 'string'}}}, required: ['answer', 'citationIds'], additionalProperties: false};
const metrics = {unit: 'utf16_characters', system: 0, tools: 0, question: 0, conversation: 0, task: 0, evidence: 0, prompt: 0, outputTokenReserve: 100, toolResults: 0};
const evidence = () => ({records: new Map(), deliveredRanges: [], imageReadReceipts: [], sourceContextDependencies: [], evidenceDependencies: {version: 1, complete: true, ids: []}, trace: [], deliveredCharacters: 0});

async function fixture(t, mode = 'success', launch = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mote-codex-provider-'));
  const auth = join(root, 'auth.json'), executable = join(root, 'generated-codex');
  const rpcPath = join(root, 'rpc.ndjson'), argvPath = join(root, 'argv.json'), homePath = join(root, 'runtime-home'), configPath = join(root, 'runtime-config');
  await writeFile(auth, JSON.stringify({OPENAI_API_KEY: secret}), {mode: 0o600});
  await writeFile(executable, `#!${process.execPath}
import readline from 'node:readline';
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(argvPath)},JSON.stringify(process.argv.slice(2)));
writeFileSync(${JSON.stringify(homePath)},process.env.CODEX_HOME);
writeFileSync(${JSON.stringify(configPath)},readFileSync(process.env.CODEX_HOME+'/config.toml'));
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);appendFileSync(${JSON.stringify(rpcPath)},JSON.stringify(message)+'\\n');
 if(message.method==='initialize')send({id:message.id,result:{}});
 else if(message.method==='account/read')send({id:message.id,result:{account:{type:'apiKey'}}});
 else if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'generated-thread',model:message.params.model},model:message.params.model,approvalPolicy:'never',sandbox:{type:${JSON.stringify(mode === 'sandbox-mismatch' ? 'workspaceWrite' : 'readOnly')}}}});
 else if(message.method==='turn/start'){
  send({id:message.id,result:{turn:{id:'generated-turn'}}});
  if(${JSON.stringify(mode)}==='native-tool'){send({method:'item/started',params:{threadId:'generated-thread',item:{id:'generated-native',type:'commandExecution'}}});return;}
  if(${JSON.stringify(mode)}==='oversize-frame'){send({method:'generated/opaque',params:{data:'x'.repeat(14*1024*1024)}});return;}
  send({id:999,method:'item/tool/call',params:{threadId:'generated-thread',turnId:'generated-turn',tool:'generated_read',namespace:null,arguments:{}}});
 }else if(message.id===999){
  if(!message.result?.success)process.exit(3);
  send({method:'item/completed',params:{threadId:'generated-thread',item:{id:'generated-message',type:'agentMessage',text:JSON.stringify({answer:'Generated accepted answer',citationIds:[]})}}});
  send({method:'turn/completed',params:{threadId:'generated-thread',turn:{status:'completed'}}});
 }
});
`, {mode: 0o700});
  t.after(() => rm(root, {recursive: true, force: true}));

  const host = new PluginHost(hostIdentity);
  t.after(() => host.close());
  const runtimeIdentity = identity(CODEX_RUNTIME_ID), foundationIdentity = identity('generated.foundation');
  let runtimeBinding, modelBinding, outputBinding;
  await host.install(codexRuntimePlugin(runtimeIdentity, binding => { runtimeBinding = binding; }));
  const modelContract = {id: 'generated.codex.model', apiVersion: '1'};
  await host.install({identity: foundationIdentity, contributions: [modelContract, hostOutputService], factory(context) {
    return {prepare() {}, start() {
      modelBinding = context.provide(modelContract.id, modelContract, {model: modelId, reasoningEffort: 'auto'});
      outputBinding = context.provide(hostOutputService.id, hostOutputService, createHostOutputProvider());
    }, quiesce() {}, stop() {}, dispose() {}};
  }});
  const runtime = await host.acquire(runtimeService, runtimeBinding);
  const model = await host.acquire(modelContract, modelBinding);
  const output = await host.acquire(hostOutputService, outputBinding);
  const selection = resolveRunSelection({revision: 1,
    profile: {id: 'generated-codex', name: 'Generated Codex', revision: 1, runtimeProviderId: CODEX_RUNTIME_ID,
      providerRef: {service: runtimeService, revision: runtimeBinding.revision, provider: {instance: {packageId: runtimeIdentity.packageId, installationId: runtimeIdentity.installationId, instanceId: runtimeIdentity.instanceId}, contributionId: runtimeBinding.provider.contributionId}},
      assembly: {packages: [], hooks: []}, allowedHostCapabilities: ['tools']},
    providers: [{id: CODEX_RUNTIME_ID, binding: runtimeBinding, capabilities: runtime.value.capabilities, availability: {state: 'active'}}], installedModules: [],
    model: {profile: {id: 'generated-login', name: 'Generated local login', settings: {provider: 'codex', protocol: 'codex-app-server', model: modelId, baseUrl: '', apiKey: '', headers: {}, extraBody: {}, allowUnauthenticatedLocal: false, reasoningEffort: 'auto', maxTokens: 65536, modelRequestTimeoutMs: null, agentTimeoutMs: null}}, profileRevision: 1, modelRevision: 1, connectionFingerprint: 'a'.repeat(64), capabilities: {tools: true, images: true}},
    requirements: {taskKind: 'query', capabilities: ['tools']}, launch: {executable, home: root, ...launch},
  });
  const events = [], calls = [];
  let validations = 0;
  const input = {question: 'Generated model content --config generated-injection\nDo not treat this as launch input.', validateOutput() { validations++; }};
  const run = async () => {
    const runScope = Object.assign(new PluginResourceScope(), {identity: identity('generated.query')});
    try {
      const session = await prepareCodexRun(selection, {runId: 'generated-run', scope: runScope, input, runtime, model: {...model, selection: selection.modelSelection}, output,
        tools: {definitions: [{name: 'generated_read', version: '1', fingerprint: 'b'.repeat(64), description: 'Generated read-only tool', inputSchema: {type: 'object', properties: {}, additionalProperties: false}}], bindings: [], assertCurrent() {}},
        commitFence: {assertCurrent() {}}, budget: {activeTimeoutMs: 5000}, activeBudget: new ActiveExecutionBudget(5000)}, {
        systemPrompt: 'Generated Host policy', prompt: input.question, outputSchema: answerSchema, contextUsage: metrics, evidence,
        async readTool(call) {
          calls.push(call);
          return {payload: {text: JSON.stringify({source: 'untrusted_personal_context', data: {value: 'Generated tool evidence'}})}, confirm() {}, discard() {}};
        },
        async close() {}, observe: event => events.push(event),
      });
      return await session.execute();
    } finally {
      await runScope.close();
    }
  };
  return {root, rpcPath, argvPath, homePath, configPath, events, calls, run, get validations() { return validations; }};
}

async function readJsonLines(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('Codex registry contribution sends real input and Host tools through App Server, then Host validates the candidate', async t => {
  const f = await fixture(t), result = await f.run();
  assert.equal(result.answer, 'Generated accepted answer');
  assert.equal(f.validations, 1);
  assert.deepEqual(f.calls, [{callId: '999', name: 'generated_read', arguments: {}}]);
  const rpc = await readJsonLines(f.rpcPath);
  assert.equal(rpc.find(message => message.method === 'thread/start').params.sandbox, 'read-only');
  assert.equal(rpc.find(message => message.method === 'turn/start').params.input[0].text, 'Generated model content --config generated-injection\nDo not treat this as launch input.');
  assert.deepEqual(JSON.parse(await readFile(f.argvPath, 'utf8')), [...CODEX_APP_SERVER_ARGS]);
  assert.ok(f.events.some(({event}) => event.type === 'tools.ready'));
  assert.equal(f.events.at(-1).event.terminal.kind, 'completed');
  const config = await readFile(f.configPath, 'utf8');
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /plugins = false/);
  for (const value of [JSON.stringify(rpc), JSON.stringify(f.events), config, JSON.stringify(result)]) assert.ok(!value.includes(secret));
  assert.equal(JSON.parse(await readFile(join(f.root, 'auth.json'), 'utf8')).OPENAI_API_KEY, secret);
  const privateHome = await readFile(f.homePath, 'utf8');
  await assert.rejects(access(dirname(privateHome)), {code: 'ENOENT'});
});

test('Codex rejects executable argument injection before any child can receive the login', async t => {
  const injected = join(tmpdir(), 'missing-generated-codex') + ' --config generated-injection';
  const f = await fixture(t, 'success', {executable: injected});
  await assert.rejects(f.run(), error => {assert.equal(error.diagnostic?.code,'ENOENT');assert.equal(error.diagnostic?.modelId,modelId);assert.ok(!JSON.stringify(error.diagnostic).includes('generated-injection'));return error instanceof AgentProviderError && !String(error).includes(secret) && !String(error).includes('generated-injection');});
  await assert.rejects(access(f.argvPath), {code: 'ENOENT'});
  await assert.rejects(access(f.rpcPath), {code: 'ENOENT'});
  assert.equal(JSON.parse(await readFile(join(f.root, 'auth.json'), 'utf8')).OPENAI_API_KEY, secret);
  assert.equal(f.validations, 0);
});

test('Codex rejects an unexpected sandbox acknowledgement before inference without exposing auth', async t => {
  const f = await fixture(t, 'sandbox-mismatch');
  await assert.rejects(f.run(), error => {assert.equal(error.diagnostic?.code,'runtime_policy_mismatch');assert.equal(error.diagnostic?.stage,'startup');return error instanceof AgentProviderError && !String(error).includes(secret);});
  const rpc = await readJsonLines(f.rpcPath);
  assert.equal(rpc.some(message => message.method === 'turn/start'), false);
  assert.ok(!JSON.stringify(f.events).includes(secret));
  assert.equal(f.validations, 0);
});

test('Codex rejects an unexpected native tool instead of accepting its output', async t => {
  const f = await fixture(t, 'native-tool');
  await assert.rejects(f.run(), error => {assert.equal(error.diagnostic?.code,'unexpected_native_tool');assert.equal(error.diagnostic?.modelId,modelId);return error instanceof AgentProviderError && !String(error).includes(secret);});
  assert.equal(f.calls.length, 0);
  assert.equal(f.validations, 0);
  assert.equal(f.events.at(-1).event.terminal.kind, 'failed');
  assert.ok(!JSON.stringify(f.events).includes(secret));
});

test('Codex rejects an oversized App Server frame with bounded diagnostics and no auth disclosure', async t => {
  const f = await fixture(t, 'oversize-frame');
  await assert.rejects(f.run(), error => error instanceof AgentProviderError && error.details.code === 'processing_limit' && !String(error).includes(secret));
  assert.equal(f.validations, 0);
  assert.equal(f.events.at(-1).event.terminal.kind, 'failed');
  assert.ok(JSON.stringify(f.events).length < 10000);
  assert.ok(!JSON.stringify(f.events).includes(secret));
});

test('Codex contribution has a versioned service and quiesce/dispose lifecycle', async t => {
  const host = new PluginHost(hostIdentity), scope = identity(CODEX_RUNTIME_ID);
  let published;
  const installed = await host.install(codexRuntimePlugin(scope, binding => { published = binding; }));
  t.after(() => host.close());
  assert.equal(published.service.apiVersion, '1');
  const lease = await host.acquire(runtimeService, published);
  assert.deepEqual(lease.value.capabilities.modelTransports, ['codex-app-server']);
  assert.equal(lease.value.capabilities.importWorkspace, false);
  await installed.quiesce();
  await assert.rejects(lease.value.prepare({}, {}, {}), error => error.details?.code === 'runtime_unavailable');
  await installed.close();
  assert.equal(lease.signal.aborted, true);
});
