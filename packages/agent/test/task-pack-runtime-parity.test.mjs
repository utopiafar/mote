import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  TASK_DESCRIPTOR_API_VERSION,
  TASK_OUTPUT_SCHEMA,
  TaskRegistry,
  createAgent,
  prepareTaskContext,
} from '../dist/index.js';
import {assembleHostContext} from '../dist/host/run-session.js';
import {startBridge} from '../dist/bridge.js';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.ts';

const record = {
  id: '7b4e3cf4-6a2d-4c8f-9a10-5d6e7f8091a2',
  capturedAt: '2026-02-03T04:05:06Z',
  appName: 'Generated parity note',
  ocrText: 'Generated original evidence consumed by both runtimes.',
};
const unretrieved = '11111111-1111-4111-8111-111111111111';
const reader = {
  search: async () => [record],
  timeline: async () => ({items: [record], nextCursor: null}),
  evidence: async ({ids}) => ids.includes(record.id) ? [record] : [],
  activity: async () => ({}),
  devices: async () => [],
};

const acceptedCandidate = JSON.stringify({answer: `Generated parity answer [${record.id}]`, citationIds: [record.id]});
const unretrievedCandidate = JSON.stringify({answer: 'Generated unretrieved parity answer', citationIds: [unretrieved]});

/** One generated pack, one Host selection and one explicit procedure. Its
 * procedure default response mode and task version must survive both runtimes. */
const pack = {
  tasks: [{
    apiVersion: TASK_DESCRIPTOR_API_VERSION,
    id: 'generated-parity-task',
    version: '7.4.2',
    profile: {output: 'answer', retrieval: 'evidence'},
    outputSchema: TASK_OUTPUT_SCHEMA,
    select: () => false,
  }],
  skills: [{
    apiVersion: TASK_DESCRIPTOR_API_VERSION,
    id: 'generated-parity-procedure',
    name: 'generated-parity-procedure',
    version: '3.8.1',
    description: 'Generated parity procedure',
    content: 'Apply only the generated Host-selected parity procedure.',
    responseMode: 'personal-insight',
  }],
};

const text = value => typeof value === 'string' ? value
  : Array.isArray(value) ? value.map(part => typeof part === 'string' ? part : part?.text ?? '').join('\n')
  : '';
const lastUserText = body => text([...(body.messages ?? [])].reverse().find(message => message.role === 'user')?.content);

function observe() {
  const traces = [], hostEvents = [], validated = [];
  return {
    traces, hostEvents, validated,
    hooks: {
      onTrace: event => traces.push(event),
      onHostRunEvent: event => hostEvents.push(event),
      validateOutput: answer => { validated.push({answer: answer.answer, citations: answer.citations.map(citation => citation.id)}); },
    },
  };
}

function readyTools(observation) {
  const events = observation.hostEvents.filter(({event}) => event.type === 'tools.ready');
  assert.equal(events.length, 1, 'each runtime reports its exact loaded tool set once');
  return events[0].event.tools;
}

function assertSameOutputRules(runtime, observation) {
  const failed = observation.traces.filter(event => event.type === 'validation.failed');
  assert.deepEqual(failed.map(event => event.payload?.reason), ['unretrieved_citation'], `${runtime} rejects an unretrieved citation through the Host parser`);
  const accepted = observation.traces.filter(event => event.type === 'validation.completed');
  assert.equal(accepted.length, 1, `${runtime} accepts the repaired candidate once`);
  assert.equal(accepted[0].status, 'accepted');
  assert.deepEqual(observation.validated.map(answer => answer.citations), [[record.id]], `${runtime} hands only the repaired answer to the Host validator`);
}

/** Real DSH child, generated loopback Messages fixture and real runtime patch. */
async function runDsh(query) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    const answer = requests.length === 1 ? unretrievedCandidate : acceptedCandidate;
    writeMessagesResponse(response, {stage: requests.length - 1, model: 'generated-model', text: answer});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = createAgent({
    reader, protocol: 'deepseek', model: 'generated-model', apiKey: 'generated-key',
    baseUrl: `http://127.0.0.1:${server.address().port}`, maxTokens: 1024, agentTimeoutMs: 20000,
  });
  try {
    const observation = observe();
    const answer = await agent.query({...query, ...observation.hooks});
    return {
      answer, requests, observation,
      system: text(requests[0].system),
      prompt: lastUserText(requests[0]),
      repairPrompt: lastUserText(requests[1]),
    };
  } finally {
    try { await agent.close(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}

async function readJsonLines(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}

/** Real Codex App Server child speaking the newline-delimited protocol. */
async function runCodex(t, query) {
  const root = await mkdtemp(join(tmpdir(), 'mote-parity-codex-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const executable = join(root, 'generated-codex'), rpcPath = join(root, 'rpc.ndjson');
  await writeFile(join(root, 'auth.json'), JSON.stringify({OPENAI_API_KEY: 'generated-unused-key'}), {mode: 0o600});
  await writeFile(executable, `#!${process.execPath}
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let turns=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);appendFileSync(${JSON.stringify(rpcPath)},JSON.stringify(message)+'\\n');
 if(message.method==='initialize')send({id:message.id,result:{}});
 else if(message.method==='account/read')send({id:message.id,result:{account:{type:'apiKey'}}});
 else if(message.method==='thread/start')send({id:message.id,result:{thread:{id:'parity-thread',model:message.params.model},model:message.params.model,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(message.method==='turn/start'){
  turns++;
  send({id:message.id,result:{turn:{id:'parity-turn-'+turns}}});
  const answer=turns===1?${JSON.stringify(unretrievedCandidate)}:${JSON.stringify(acceptedCandidate)};
  send({method:'item/completed',params:{threadId:'parity-thread',item:{id:'parity-message-'+turns,type:'agentMessage',text:answer}}});
  send({method:'turn/completed',params:{threadId:'parity-thread',turn:{status:'completed'}}});
 }
});
`, {mode: 0o700});
  const agent = createAgent({
    reader, protocol: 'codex-app-server', model: 'generated-model',
    codex: {executable, home: root}, maxTokens: 1024, agentTimeoutMs: 20000,
  });
  try {
    const observation = observe();
    const answer = await agent.query({...query, ...observation.hooks});
    const rpc = await readJsonLines(rpcPath);
    const started = rpc.find(message => message.method === 'thread/start');
    const turns = rpc.filter(message => message.method === 'turn/start');
    return {
      answer, observation, turns,
      system: started.params.baseInstructions,
      dynamicTools: started.params.dynamicTools,
      prompt: turns[0].params.input[0].text,
      repairPrompt: turns[1].params.input[0].text,
    };
  } finally {
    await agent.close();
  }
}

test('one task pack and QueryInput assemble identical DSH and Codex inputs and share Host output rules', {timeout: 30000}, async t => {
  const registry = new TaskRegistry(), dispose = registry.register(pack);
  t.after(() => dispose());
  const query = {
    question: 'Generated parity question',
    language: 'ja',
    contextTime: record.capturedAt,
    evidenceIds: [record.id],
    skill: 'generated-parity-procedure',
    taskSelection: {id: 'generated-parity-task', version: '7.4.2'},
    taskRegistry: registry,
  };
  const prepared = prepareTaskContext(query);
  assert.equal(prepared.id, 'generated-parity-task');
  assert.equal(prepared.version, '7.4.2');
  assert.equal(prepared.language, 'ja');
  assert.equal(prepared.responseMode, 'personal-insight');
  assert.deepEqual(prepared.profile, {output: 'answer', retrieval: 'evidence'});
  assert.equal(prepared.skill?.id, 'generated-parity-procedure');
  assert.equal(prepared.skill?.version, '3.8.1');

  const reference = await startBridge(reader, query);
  let expected;
  try { expected = assembleHostContext(query, reference.seedEvidence, 1024); }
  finally { await reference.close(); }
  const expectedEnvelope = JSON.parse(expected.prompt);

  const dsh = await runDsh(query), codex = await runCodex(t, query);
  for (const [runtime, observed] of [['DSH', dsh], ['Codex', codex]]) {
    const envelope = JSON.parse(observed.prompt);
    assert.deepEqual(envelope, expectedEnvelope, `${runtime} receives the exact Host-assembled context envelope`);
    assert.equal(envelope.language, 'ja', `${runtime} language`);
    assert.equal(envelope.responseMode, 'personal-insight', `${runtime} response mode`);
    assert.deepEqual(envelope.taskProfile, {output: 'answer', retrieval: 'evidence'}, `${runtime} evidence scope`);
    assert.equal(envelope.taskId, 'generated-parity-task', `${runtime} task identity`);
    assert.equal(envelope.taskVersion, '7.4.2', `${runtime} task version`);
    assert.equal(envelope.requiredSkill, 'generated-parity-procedure', `${runtime} procedure identity`);
    assert.equal(envelope.procedure, pack.skills[0].content, `${runtime} procedure content`);
    assert.deepEqual(envelope.untrustedEvidence.map(item => item.id), [record.id], `${runtime} evidence IDs`);
    assert.match(envelope.disclosurePolicy, /Use only host-authorized original evidence/, `${runtime} disclosure policy`);
    const instructions = observed.observation.traces.filter(event => event.type === 'instructions.assembled');
    const context = observed.observation.traces.filter(event => event.type === 'context.assembled');
    assert.equal(instructions.length, 1); assert.equal(instructions[0].payload.system, expected.system);
    assert.equal(context.length, 1); assert.equal(context[0].payload.prompt, expected.prompt);
  }
  const dshRepair = JSON.parse(dsh.repairPrompt);
  assert.deepEqual(dshRepair, JSON.parse(codex.repairPrompt), 'repair guidance is runtime-independent');
  assert.equal(dshRepair.responseMode, 'personal-insight');
  assert.match(dshRepair.validationError, /not retrieved in this run/);

  assert.ok(dsh.system.includes(expected.system), 'the real DSH child receives the Host system policy');
  assert.equal(codex.system, expected.system, 'the real Codex App Server receives the exact Host system policy');
  const dshTools = readyTools(dsh.observation), codexTools = readyTools(codex.observation);
  assert.deepEqual(dshTools, codexTools, 'both runtimes load exactly the same versioned Host tools');
  assert.deepEqual(dshTools.map(tool => tool.name).sort(), ['evidence', 'skill']);
  assert.deepEqual(codex.dynamicTools.map(tool => tool.name).sort(), ['evidence', 'skill']);
  assert.ok(!codex.dynamicTools.some(tool => ['search_context', 'timeline', 'material_catalog', 'material_read'].includes(tool.name)), 'evidence scope admits no archive discovery tool');

  assert.equal(dsh.requests.length, 2, 'DSH runs one initial and one repaired turn');
  assert.equal(codex.turns.length, 2, 'Codex runs one initial and one repaired turn in the same thread');
  assertSameOutputRules('DSH', dsh.observation);
  assertSameOutputRules('Codex', codex.observation);
  assert.equal(dsh.answer.answer, `Generated parity answer [${record.id}]`);
  assert.equal(codex.answer.answer, dsh.answer.answer);
  assert.deepEqual(codex.answer.citations, dsh.answer.citations);
  assert.deepEqual(codex.answer.evidenceReadRanges, dsh.answer.evidenceReadRanges);
  assert.deepEqual(codex.answer.evidenceDependencies, dsh.answer.evidenceDependencies);
  assert.deepEqual(codex.answer.sourceContextDependencies, dsh.answer.sourceContextDependencies);
});
