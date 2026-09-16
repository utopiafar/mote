import test from 'node:test';
import assert from 'node:assert/strict';
import {observeHarness,usageSample} from '../dist/usage.js';
test('provider usage preserves unknown cache buckets and never adds reasoning twice',()=>{
  assert.deepEqual(usageSample({inputTokens:10,outputTokens:20,cacheReadTokens:70,cacheWriteTokens:0,reasoningTokens:15,totalTokens:100}),{inputTokens:80,outputTokens:20,totalTokens:100,cacheReadTokens:70,cacheWriteTokens:0,reasoningTokens:15});
  assert.equal(usageSample({inputTokens:10,outputTokens:5}),undefined);
  assert.equal(usageSample({inputTokens:10,outputTokens:5,totalTokens:15}).cacheReadTokens,undefined);
  assert.equal(usageSample({inputTokens:10,outputTokens:5,totalTokens:8}),undefined);
  assert.equal(usageSample({inputTokens:10,outputTokens:5,cacheReadTokens:1,cacheWriteTokens:0,totalTokens:15}),undefined);
});
test('Harness accounting replaces samples, adds retries and repair turns, and ignores other sessions',()=>{
  const values=[],progress=[];const observe=observeHarness({question:'fixture',onUsage:u=>values.push(u),onProgress:e=>progress.push(e)},'fixture');
  const emit=(type,data,sessionId='fixture')=>observe({method:'session.event',params:{sessionId,event:{type,data}}});
  const usage={inputTokens:10,outputTokens:5,cacheReadTokens:20,cacheWriteTokens:0,totalTokens:35};
  emit('step/start',{turn:0,step:0});emit('assistant/attempt',{turn:0,step:0,stream:[{type:'chunk',chunk:{type:'usage',usage}}]});
  emit('assistant/message',{turn:0,step:0,usage});assert.equal(values.at(-1).totalTokens,35);
  emit('llm/retry-started',{turn:0,step:0});emit('assistant/message',{turn:0,step:0,usage});
  emit('step/start',{turn:1,step:0});emit('assistant/message',{turn:1,step:0,usage});
  emit('step/start',{turn:9,step:0},'foreign');
  assert.equal(values.at(-1).totalTokens,105);assert.equal(values.at(-1).requests,3);assert.equal(values.at(-1).reportedRequests,3);
  emit('step/start',{turn:1,step:1});assert.equal(values.at(-1).requests,4);assert.equal(values.at(-1).reportedRequests,3);
  assert.equal(progress.length,4);assert.ok(!JSON.stringify(values).includes('fixture'));
});
