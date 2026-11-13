import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgent, AgentResponseError} from '../dist/index.js';
import {codexContextTools} from '../dist/runtime/codex/tools.js';

const record = {
  id: '9f1c3a52-8b57-4f4e-a4de-2d9a7f0b6c11',
  capturedAt: '2026-01-01T00:00:00Z',
  appName: 'Generated contract fixture',
  ocrText: 'Generated evidence consumed by the Codex App Server contract.',
};
const reader = {
  search: async () => [record],
  timeline: async () => ({items: [record], nextCursor: null}),
  evidence: async ({ids}) => ids.includes(record.id) ? [record] : [],
  devices: async () => [],
  activity: async () => ({}),
};

/** A real child speaking the App Server protocol. It validates the Host dynamic
 * schema and reacts to the structured tool error, rather than only echoing RPC. */
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mote-codex-contract-'));
  const auth = join(root, 'auth.json'), executable = join(root, 'generated-codex'), rpcPath = join(root, 'rpc.ndjson');
  await writeFile(auth, JSON.stringify({OPENAI_API_KEY: 'generated-contract-key'}), {mode: 0o600});
  await writeFile(executable, `#!${process.execPath}
// Protocol fixture only; native budget behavior is exercised with the real dependency.
if(process.argv[2]==='--mote-context-budget-version'){process.stdout.write('mote-context-budget-v1\\n');process.exit(0);}
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const rpc=message=>appendFileSync(${JSON.stringify(rpcPath)},JSON.stringify(message)+'\\n');
const recordId=${JSON.stringify(record.id)};
let turns=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);rpc(m);
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start'){
  const tools=m.params.dynamicTools;
  if(!Array.isArray(tools)||!tools.some(tool=>tool.name==='timeline')||!tools.some(tool=>tool.name==='skill'))process.exit(2);
  const timeline=tools.find(tool=>tool.name==='timeline');
  if(!timeline.inputSchema||timeline.inputSchema.additionalProperties!==false||timeline.inputSchema.properties?.limit?.type!=='integer')process.exit(3);
  send({id:m.id,result:{thread:{id:'contract-thread',model:m.params.model},model:m.params.model,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 }else if(m.method==='turn/start'){
  turns++;
  send({id:m.id,result:{turn:{id:'contract-turn-'+turns}}});
  if(turns===1)send({id:999,method:'item/tool/call',params:{threadId:'contract-thread',turnId:'contract-turn-1',tool:'timeline',namespace:null,arguments:{limit:0}}});
  else send({method:'item/completed',params:{threadId:'contract-thread',item:{id:'contract-message-'+turns,type:'agentMessage',text:JSON.stringify({answer:'Generated repaired answer ['+recordId+']',citationIds:[recordId]})}}});
  if(turns>1)send({method:'turn/completed',params:{threadId:'contract-thread',turn:{status:'completed'}}});
 }else if(m.id===999){
  const text=m.result?.contentItems?.[0]?.text??'';
  let issue;try{issue=JSON.parse(text).toolError;}catch{}
  if(m.result?.success!==false||issue?.code!=='invalid_tool_arguments'||issue?.recovery!=='correct_arguments')process.exit(4);
  send({id:1000,method:'item/tool/call',params:{threadId:'contract-thread',turnId:'contract-turn-1',tool:'timeline',namespace:null,arguments:{limit:2}}});
 }else if(m.id===1000){
  if(m.result?.success!==true)process.exit(5);
  const body=JSON.parse(m.result.contentItems[0].text);
  if(body.data?.[0]?.id!==recordId)process.exit(6);
  send({method:'item/completed',params:{threadId:'contract-thread',item:{id:'contract-message-1',type:'agentMessage',text:JSON.stringify({answer:'Generated contract answer ['+recordId+']',citationIds:[recordId]})}}});
  send({method:'turn/completed',params:{threadId:'contract-thread',turn:{status:'completed'}}});
 }
});
`, {mode: 0o700});
  t.after(() => rm(root, {recursive: true, force: true}));
  return {root, executable, rpcPath};
}

async function messages(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
}

test('the App Server fixture consumes the dynamic Host schema and returns structured tool errors before corrected arguments', async t => {
  const f = await fixture(t), question = 'Generated contract question';
  const agent = createAgent({reader, protocol: 'codex-app-server', model: 'generated-contract-model', codex: {executable: f.executable, home: f.root}, agentTimeoutMs: 5000});
  t.after(() => agent.close());
  const answer = await agent.query({question});
  assert.equal(answer.answer, `Generated contract answer [${record.id}]`);
  assert.deepEqual(answer.citations.map(citation => citation.id), [record.id]);
  assert.deepEqual(answer.trace.map(row => row.tool), ['timeline']);

  const rpc = await messages(f.rpcPath), started = rpc.find(message => message.method === 'thread/start');
  assert.ok(started, 'the real fixture process initialized a thread');
  const dynamic = started.params.dynamicTools.filter(tool => tool.name !== 'skill');
  for (const name of ['evidence', 'timeline', 'search_context']) assert.ok(dynamic.some(tool => tool.name === name), `missing ${name}`);
  for (const tool of dynamic) assert.deepEqual(tool, codexContextTools.find(expected => expected.name === tool.name), tool.name);
  const skill = started.params.dynamicTools.find(tool => tool.name === 'skill');
  assert.deepEqual(Object.keys(skill).sort(), ['description', 'inputSchema', 'name', 'type']);
  assert.deepEqual(skill.inputSchema.required, ['name']);
  assert.ok(skill.inputSchema.properties.name.enum.length > 0);

  const invalid = rpc.find(message => message.id === 999).result;
  assert.equal(invalid.success, false);
  assert.deepEqual(JSON.parse(invalid.contentItems[0].text), {toolError: {code: 'invalid_tool_arguments', message: 'limit must be a positive integer', recovery: 'correct_arguments', details: {}}});
  const corrected = rpc.find(message => message.id === 1000).result;
  assert.equal(corrected.success, true);
  assert.equal(JSON.parse(corrected.contentItems[0].text).data[0].id, record.id);
  assert.equal(rpc.filter(message => message.method === 'thread/start').length, 1);
  assert.equal(rpc.filter(message => message.method === 'turn/start').length, 1);
});

test('the same Host output rules reject an unretrieved Codex citation and repair it inside one thread', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mote-codex-citation-'));
  const auth = join(root, 'auth.json'), executable = join(root, 'generated-codex'), rpcPath = join(root, 'rpc.ndjson');
  await writeFile(auth, '{}', {mode: 0o600});
  await writeFile(executable, `#!${process.execPath}
// Protocol fixture only; native budget behavior is exercised with the real dependency.
if(process.argv[2]==='--mote-context-budget-version'){process.stdout.write('mote-context-budget-v1\\n');process.exit(0);}
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
let turns=0;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(${JSON.stringify(rpcPath)},JSON.stringify(m)+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'citation-thread',model:m.params.model},model:m.params.model,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  turns++;
  send({id:m.id,result:{turn:{id:'citation-turn-'+turns}}});
  if(turns===1)send({id:999,method:'item/tool/call',params:{threadId:'citation-thread',turnId:'citation-turn-1',tool:'timeline',namespace:null,arguments:{}}});
  else send({method:'item/completed',params:{threadId:'citation-thread',item:{id:'citation-message',type:'agentMessage',text:JSON.stringify({answer:'Generated repaired answer [${record.id}]',citationIds:['${record.id}']})}}});
  if(turns>1)send({method:'turn/completed',params:{threadId:'citation-thread',turn:{status:'completed'}}});
 }else if(m.id===999){
  if(m.result?.success!==true)process.exit(2);
  send({method:'item/completed',params:{threadId:'citation-thread',item:{id:'citation-message',type:'agentMessage',text:JSON.stringify({answer:'Generated unretrieved answer [11111111-1111-4111-8111-111111111111]',citationIds:['11111111-1111-4111-8111-111111111111']})}}});
  send({method:'turn/completed',params:{threadId:'citation-thread',turn:{status:'completed'}}});
 }
});
`, {mode: 0o700});
  t.after(() => rm(root, {recursive: true, force: true}));
  const events = [], agent = createAgent({reader, protocol: 'codex-app-server', model: 'generated-citation-model', codex: {executable, home: root}, agentTimeoutMs: 5000});
  t.after(() => agent.close());
  const answer = await agent.query({question: 'Generated citation contract', onTrace: event => events.push(event)});
  assert.deepEqual(answer.citations.map(citation => citation.id), [record.id]);
  assert.equal(answer.answer, `Generated repaired answer [${record.id}]`);
  const rpc = await messages(rpcPath), turns = rpc.filter(message => message.method === 'turn/start');
  assert.equal(turns.length, 2);
  assert.equal(rpc.filter(message => message.method === 'thread/start').length, 1);
  assert.match(turns[1].params.input[0].text, /not retrieved in this run/);
  assert.ok(events.some(event => event.type === 'validation.failed' && event.payload?.reason === 'unretrieved_citation'));
});

test('an unretrieved Codex citation remains rejected after the bounded Host repairs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mote-codex-citation-bounded-'));
  const auth = join(root, 'auth.json'), executable = join(root, 'generated-codex'), rpcPath = join(root, 'rpc.ndjson');
  await writeFile(auth, '{}', {mode: 0o600});
  await writeFile(executable, `#!${process.execPath}
// Protocol fixture only; native budget behavior is exercised with the real dependency.
if(process.argv[2]==='--mote-context-budget-version'){process.stdout.write('mote-context-budget-v1\\n');process.exit(0);}
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(${JSON.stringify(rpcPath)},JSON.stringify(m)+'\\n');
 if(m.method==='initialize')send({id:m.id,result:{}});
 else if(m.method==='account/read')send({id:m.id,result:{account:{type:'apiKey'}}});
 else if(m.method==='thread/start')send({id:m.id,result:{thread:{id:'citation-thread',model:m.params.model},model:m.params.model,approvalPolicy:'never',sandbox:{type:'readOnly'}}});
 else if(m.method==='turn/start'){
  const text=JSON.stringify({answer:'Generated unretrieved answer',citationIds:['11111111-1111-4111-8111-111111111111']});
  send({id:m.id,result:{turn:{id:'citation-turn'}}});
  send({method:'item/completed',params:{threadId:'citation-thread',item:{id:'citation-message',type:'agentMessage',text}}});
  send({method:'turn/completed',params:{threadId:'citation-thread',turn:{status:'completed'}}});
 }
});
`, {mode: 0o700});
  t.after(() => rm(root, {recursive: true, force: true}));
  const agent = createAgent({reader, protocol: 'codex-app-server', model: 'generated-citation-model', codex: {executable, home: root}, agentTimeoutMs: 5000});
  t.after(() => agent.close());
  await assert.rejects(agent.query({question: 'Generated bounded citation contract'}), error => error instanceof AgentResponseError && error.reason === 'unretrieved_citation');
  const rpc = await messages(rpcPath);
  assert.equal(rpc.filter(message => message.method === 'turn/start').length, 4);
});
