import test from 'node:test';
import assert from 'node:assert/strict';
import {runtimeSettingsDraft} from '../src/RuntimeSettings.js';
import {executionSettingsSchema,diagnosticsSettingsSchema} from '../../server/src/execution-settings.js';

test('execution settings remain writable when the read response contains provider and queue telemetry',()=>{
 const response={interactiveConcurrency:2,agentConcurrency:8,llmConcurrency:4,memoryConcurrency:3,queues:{agents:{active:0,waiting:0,limit:8}},modelQuotaUnit:'harness_session',providers:[{provider:'generated',active:0}]};
 assert.equal(executionSettingsSchema.safeParse(response).success,false);
 const draft=runtimeSettingsDraft(response);
 assert.ok('agentConcurrency' in draft);
 draft.interactiveConcurrency=1;draft.agentConcurrency=1;draft.llmConcurrency=1;draft.memoryConcurrency=1;
 assert.deepEqual(executionSettingsSchema.parse(draft),{interactiveConcurrency:1,agentConcurrency:1,llmConcurrency:1,memoryConcurrency:1});
 assert.equal(response.agentConcurrency,8);
});

test('diagnostic settings keep explicit false values without forwarding read-only data',()=>{
 const response={enabled:true,debug:false,traceEnabled:false,level:'info',coverage:{events:3}};
 assert.deepEqual(diagnosticsSettingsSchema.parse(runtimeSettingsDraft(response)),{enabled:true,debug:false,traceEnabled:false,level:'info'});
});
