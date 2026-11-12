import test from 'node:test';
import assert from 'node:assert/strict';
import {modelConnection,modelRuntimeEntries,resolveModelCapabilities,CONSERVATIVE_CONTEXT_WINDOW,validateModelOptions} from '../dist/models/provider-registry.js';
import {createRuntimePatch,AgentConfigurationError} from '../dist/index.js';

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
    assert.equal(config.models[0].contextWindow,CONSERVATIVE_CONTEXT_WINDOW);
    assert.notEqual(config.models[0].contextWindow,128_000,'an unlisted model never silently assumes 128k');
  }
});

test('explicit model context capacity is separate from the output limit and reaches the provider adapter',()=>{
  const capability=resolveModelCapabilities({contextWindow:8192,maxTokens:1024});
  assert.deepEqual(capability,{contextWindow:8192,maxOutputTokens:1024,contextWindowSource:'configured'});
  const fallback=resolveModelCapabilities({maxTokens:1024});
  assert.equal(fallback.contextWindow,CONSERVATIVE_CONTEXT_WINDOW);
  assert.equal(fallback.contextWindowSource,'conservative-fallback');
  assert.notEqual(fallback.contextWindow,128_000);

  const deepseek=modelRuntimeEntries({protocol:'deepseek',model:'fixture-model',contextWindow:8192,maxTokens:1024,requestTimeoutMs:5000});
  assert.equal(deepseek[0].config.models[0].contextWindow,8192);
  assert.equal(deepseek[0].config.models[0].maxTokens,1024);
  const compatible=modelRuntimeEntries({protocol:'openai-completions',model:'fixture-model',contextWindow:8192,maxTokens:1024,requestTimeoutMs:5000});
  assert.equal(compatible.flatMap(entry=>entry.insert??[]).find(entry=>entry.id==='mote-llm').config.providers['mote-model'].models[0].contextWindow,8192);

  const patch=JSON.parse(createRuntimePatch('/generated/plugin.mjs','fixture-model','https://synthetic.invalid/v1',undefined,1024,{protocol:'openai-completions',contextWindow:8192}));
  assert.equal(patch.flatMap(entry=>entry.insert??[]).find(entry=>entry.id==='mote-llm').config.providers['mote-model'].models[0].contextWindow,8192);
});

test('invalid capacity configuration is rejected instead of turning maxTokens into an input window',()=>{
  for(const options of [{contextWindow:0,maxTokens:1},{contextWindow:1024,maxTokens:1024},{contextWindow:1024,maxTokens:2048}])assert.throws(()=>resolveModelCapabilities(options),AgentConfigurationError);
  assert.throws(()=>validateModelOptions({protocol:'deepseek',contextWindow:1024,maxTokens:1024}),AgentConfigurationError);
  const largeOutput=resolveModelCapabilities({maxTokens:128_000});
  assert.equal(largeOutput.contextWindowSource,'conservative-fallback');
  assert.ok(largeOutput.contextWindow>largeOutput.maxOutputTokens);
  assert.notEqual(largeOutput.contextWindow,128_000);
  assert.doesNotThrow(()=>validateModelOptions({protocol:'deepseek',maxTokens:128_000}));
  assert.doesNotThrow(()=>validateModelOptions({protocol:'deepseek',contextWindow:131_072,maxTokens:128_000}));
  assert.doesNotThrow(()=>validateModelOptions({protocol:'codex-app-server',maxTokens:128_000}));
});
