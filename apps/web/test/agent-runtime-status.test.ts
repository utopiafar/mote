import test from 'node:test';
import assert from 'node:assert/strict';
import {agentRuntimeFeatureState,agentRuntimeReadiness} from '@mote/shared/agent-runtime-status';
import {ApiError} from '../src/api';
import {parseAgentRuntimeStatus} from '../src/agent-runtime-status';
import {modelView,runtimeReceipt} from './fixtures/model-settings';

test('the Web production parser accepts the shared receipt and keeps unknown runtime and capability values displayable', () => {
 const body=runtimeReceipt(modelView());
 (body.features as Record<string,unknown>)['transcribe-audio']={profileId:'env:deployment',provider:'future-runtime',model:'generated-model',configured:false};
 const parsed=parseAgentRuntimeStatus(body);
 assert.equal(parsed.features.chat.provider,'custom');
 assert.equal(parsed.features['transcribe-audio'].provider,'future-runtime');
 assert.equal(agentRuntimeFeatureState(parsed,'transcribe-audio'),'unconfigured');
 assert.equal(agentRuntimeFeatureState(parsed,'summarize-later'),'unknown');
 assert.equal(agentRuntimeReadiness(parsed),'ready');
});

test('the Web production parser never projects ready without published configured state', () => {
 const body=runtimeReceipt(modelView(),{configured:false});
 const parsed=parseAgentRuntimeStatus(body);
 assert.equal(agentRuntimeReadiness(parsed),'unconfigured');
 const restarting=parseAgentRuntimeStatus(runtimeReceipt(modelView(),{domainStatus:'restart-required'}));
 assert.equal(agentRuntimeReadiness(restarting),'restart-pending');
 const failed=parseAgentRuntimeStatus(runtimeReceipt(modelView(),{domainStatus:'invalid'}));
 assert.equal(agentRuntimeReadiness(failed),'failed');
 const missingDomain=parseAgentRuntimeStatus({...runtimeReceipt(modelView()),configuration:{...runtimeReceipt(modelView()).configuration,domain:undefined,domains:[]}});
 assert.equal(agentRuntimeReadiness(missingDomain),'failed');
});

test('the Web production parser rejects bad revisions and secret- or path-shaped fields', () => {
 for(const mutate of [
  (body:ReturnType<typeof runtimeReceipt>)=>{ (body as {revision:unknown}).revision=-1; },
  (body:ReturnType<typeof runtimeReceipt>)=>{ (body as {revision:unknown}).revision=1.5; },
  (body:ReturnType<typeof runtimeReceipt>)=>{ (body as {revision:unknown}).revision='3'; },
  (body:ReturnType<typeof runtimeReceipt>)=>{ (body.saved.settings as Record<string,unknown>).apiKey='generated-private-do-not-echo'; },
  (body:ReturnType<typeof runtimeReceipt>)=>{ (body.features.chat as Record<string,unknown>).profileId='/private/tmp/plugin/generated.mjs'; },
  (body:ReturnType<typeof runtimeReceipt>)=>{ (body.features.chat as Record<string,unknown>).executable='/private/tmp/agent'; },
  (body:ReturnType<typeof runtimeReceipt>)=>{ delete (body.features.chat as Record<string,unknown>).configured; },
 ]) {
  const body=runtimeReceipt(modelView());mutate(body);
  assert.throws(()=>parseAgentRuntimeStatus(body),error=>error instanceof ApiError&&error.code==='invalid_response');
 }
});
