import test from 'node:test';
import assert from 'node:assert/strict';
import {modelConnection,modelRuntimeEntries} from '../dist/model-runtime.js';

test('explicit endpoints are preserved and only an omitted endpoint selects the current preset',()=>{
 assert.equal(modelConnection({protocol:'deepseek'}).baseUrl,'https://api.deepseek.com/anthropic');
 for(const baseUrl of ['https://custom.invalid/v1','https://api.deepseek.com/v1','https://api.deepseek.com'])assert.equal(modelConnection({protocol:'deepseek',baseUrl}).baseUrl,baseUrl);
});

test('native DeepSeek declares vision and bounded output for every supported reasoning setting',()=>{
  for(const reasoningEffort of ['auto','off','low','high','max']){
    const [{config}]=modelRuntimeEntries({protocol:'deepseek',model:'fixture-model',reasoningEffort,maxTokens:1234,requestTimeoutMs:5000});
    assert.equal(config.thinking,['auto','off'].includes(reasoningEffort)?'disabled':'enabled');
    assert.equal(config.reasoningEffort,reasoningEffort==='auto'?undefined:reasoningEffort);
    assert.equal(config.maxTokens,1234);assert.equal(config.models[0].maxTokens,1234);
    assert.deepEqual(config.models[0].inputModalities,['text','image']);
  }
});
