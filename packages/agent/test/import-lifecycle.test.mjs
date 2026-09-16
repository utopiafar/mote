import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {DeepSeekHarness,RequestTimeoutError} from '@deepseek-ai/dsh-sdk-client';
import {createImportAgent} from '../dist/import-agent.js';
import {AgentTimeoutError,AgentResponseError,AgentProviderError} from '../dist/index.js';

const options={model:'synthetic-model',apiKey:'synthetic-test-key',baseUrl:'http://127.0.0.1:9/v1'};
const input={workspace:process.cwd(),inputPaths:[],instruction:'Generated lifecycle fixture',helperPath:'generated-only',manifestSchema:{}};
const marker='SYNTHETIC_PRIVATE_STDERR_OR_PROVIDER_TEXT';

test('import cleanup preserves typed primary errors and sanitizes cleanup-only failures',async t=>{
  const invalid=new AgentResponseError('Synthetic invalid import manifest');
  let outcome=new RequestTimeoutError(marker),cleaned=0;
  t.mock.method(DeepSeekHarness.prototype,'run',async()=>{
    if(outcome)throw outcome;
    return {events:[],finalResponse:JSON.stringify({summary:'Generated preview'})};
  });
  t.mock.method(DeepSeekHarness.prototype,'close',async()=>{await delay(5);cleaned++;throw Error(marker);});
  const agent=createImportAgent(options);t.after(()=>agent.close());
  await assert.rejects(agent.prepare(input),error=>error instanceof AgentTimeoutError&&!String(error).includes(marker));
  assert.equal(cleaned,1);
  outcome=invalid;await assert.rejects(agent.prepare(input),error=>error===invalid);
  assert.equal(cleaned,2);
  outcome=undefined;await assert.rejects(agent.prepare(input),error=>error instanceof AgentProviderError&&!String(error).includes(marker));
  assert.equal(cleaned,3);
});

test('import close drains preparation that has not created its Harness yet',async t=>{
  let called=false,settled=false;
  t.mock.method(DeepSeekHarness.prototype,'run',async()=>{called=true;throw Error('Unexpected runtime start');});
  const agent=createImportAgent(options);t.after(()=>agent.close());
  const preparation=agent.prepare(input).then(()=>{settled=true;},error=>{settled=true;assert.ok(error instanceof AgentProviderError);});
  await agent.close();
  assert.equal(settled,true,'close must await the pending setup and temporary-file cleanup');
  assert.equal(called,false,'a closed import runtime must not start its Harness');
  await preparation;
});

test('import repairs final formatting once in the same session and isolates observer failures',async t=>{
  const calls=[],events=[];let alwaysInvalid=false;
  t.mock.method(DeepSeekHarness.prototype,'run',async function(prompt,runOptions){
    calls.push({prompt:JSON.parse(prompt),sessionId:runOptions.sessionId});
    runOptions.onNotification?.({method:'session.event',params:{event:{type:'step/end',data:{turn:1,step:calls.length}}}});
    return {events:[],finalResponse:alwaysInvalid||calls.length===1?'Analysis is finished.':JSON.stringify({summary:'Generated preview',recordsPath:'records.jsonl'})};
  });
  t.mock.method(DeepSeekHarness.prototype,'close',async()=>{});
  const agent=createImportAgent(options);t.after(()=>agent.close());
  const result=await agent.prepare(input,notification=>{events.push(notification);throw Error('Synthetic observer failed');});
  assert.equal(result.recordsPath,'records.jsonl');assert.equal(calls.length,2);assert.equal(calls[0].sessionId,calls[1].sessionId);assert.equal(events.length,2);
  assert.equal(calls[0].prompt.requiredSkill,'document-import');assert.match(calls[1].prompt.instruction,/Do not repeat analysis/);assert.ok(!('observer'in calls[0].prompt));
  alwaysInvalid=true;await assert.rejects(agent.prepare(input),error=>error instanceof AgentResponseError);assert.equal(calls.length,4,'Only one formatting correction is allowed per preparation');
});

test('import formatting correction shares the initial total deadline without restarting it',async t=>{
  const realSetTimeout=globalThis.setTimeout;let deadlines=0,calls=0,closed=0;
  t.mock.method(globalThis,'setTimeout',(callback,milliseconds,...args)=>{
    if(milliseconds===300000){deadlines++;return realSetTimeout(callback,40,...args);}
    return realSetTimeout(callback,milliseconds,...args);
  });
  t.mock.method(DeepSeekHarness.prototype,'run',async()=>{calls++;if(calls===1){await delay(15);return {events:[],finalResponse:'Generated non-JSON preview'};}return new Promise(()=>{});});
  t.mock.method(DeepSeekHarness.prototype,'close',async()=>{closed++;});
  const agent=createImportAgent(options);t.after(()=>agent.close());
  await assert.rejects(agent.prepare(input),error=>error instanceof AgentTimeoutError);
  assert.equal(calls,2);assert.equal(deadlines,1,'A repair must not install another total timeout');assert.equal(closed,1);
});

test('optional import launch hook receives the isolated root and only forwards its executable to the SDK',async t=>{
  let launched;
  t.mock.method(DeepSeekHarness.prototype,'run',async function(prompt){
    assert.equal(this.client.options.dshBin,launched.runtimeRoot+'/generated-launch.mjs');
    assert.equal(this.client.options.extraEnvironment,undefined);
    assert.equal(JSON.parse(prompt).runtimeRoot,undefined);
    return {events:[],finalResponse:JSON.stringify({summary:'Generated launch fixture'})};
  });
  t.mock.method(DeepSeekHarness.prototype,'close',async()=>{});
  const agent=createImportAgent(options,async paths=>{launched=paths;return {dshBin:paths.runtimeRoot+'/generated-launch.mjs',extraEnvironment:{IGNORED:'generated'}};});t.after(()=>agent.close());
  await agent.prepare(input);assert.equal(launched.workspace,input.workspace);assert.match(launched.runtimeRoot,/mote-import-agent-/);
});

test('import usage includes the formatting repair and stays outside model input',async t=>{
  let turn=0;const usage=[];
  t.mock.method(DeepSeekHarness.prototype,'run',async function(prompt,runOptions){
    const parsed=JSON.parse(prompt);assert.equal(parsed.onUsage,undefined);assert.equal(parsed.observer,undefined);
    turn++;
    const emit=(type,data)=>runOptions.onNotification({method:'session.event',params:{sessionId:runOptions.sessionId,event:{type,data:{turn,step:1,...data}}}});
    emit('step/start',{});emit('assistant/message',{usage:{inputTokens:10,cacheReadTokens:5,cacheWriteTokens:0,outputTokens:2,totalTokens:17}});
    return {events:[],finalResponse:turn===1?'Generated invalid JSON':JSON.stringify({summary:'Generated repair'})};
  });
  t.mock.method(DeepSeekHarness.prototype,'close',async()=>{});
  const agent=createImportAgent(options);t.after(()=>agent.close());
  const result=await agent.prepare(input,()=>{throw Error('Observer failure');},v=>{usage.push(v);throw Error('Usage observer failure');});
  assert.equal(result.summary,'Generated repair');
  assert.deepEqual(usage.at(-1),{requests:2,reportedRequests:2,inputTokens:30,outputTokens:4,totalTokens:34,cacheReadTokens:10,cacheWriteTokens:0});
});
