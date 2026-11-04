import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {agentRuntimeReadiness,agentRuntimeStatusReceiptSchema} from '@mote/shared/agent-runtime-status';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ModelAgentFactory} from '../src/model-agent.js';
import {parseAgentRuntimeStatus} from '../../web/src/agent-runtime-status.js';
import {readAgentRuntimeStatus} from '../../desktop/src/agent-runtime-status.js';
import {ApiError} from '../../web/src/api.js';
import {ConnectionError} from '../../desktop/src/connection.js';

const owner='generated-runtime-status-owner';
const secret='generated-runtime-status-secret-do-not-echo';
const config=(dataDir:string):Config=>({dataDir,token:owner,tokenPath:'fixture-only',host:'127.0.0.1',port:0,
  maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
  model:'generated-runtime-model',modelBaseUrl:'https://fixture.invalid/v1',apiKey:secret,modelProvider:'custom',
  modelProtocol:'openai-completions',modelReasoningEffort:'auto',allowUnauthenticatedLocal:false,embeddingModel:'',
  embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:true});
const factory:ModelAgentFactory=async settings=>({configured:true,
  query:async()=>({answer:settings.model,citations:[],trace:[],runId:'generated-runtime-status-run'}),
  close:async()=>{}});

test('real configuration/status HTTP feeds the Web and Mac production parsers; a bad revision rejects while the selected settings stay readable',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-runtime-status-'));
  const node=await buildApp(config(directory),{backgroundWorker:false,createModelAgent:factory});
  t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
  const origin=await node.app.listen({host:'127.0.0.1',port:0});
  const response=await fetch(origin+'/api/agent-runtime-settings',{headers:{authorization:'Bearer '+owner}});
  assert.equal(response.status,200);
  const body:unknown=await response.json();
  const serialized=JSON.stringify(body);
  assert.equal(serialized.includes(secret),false,'credentials never enter the status receipt');
  assert.equal(serialized.includes('packagePath'),false);
  assert.equal(serialized.includes('executable'),false);

  const shared=agentRuntimeStatusReceiptSchema.parse(body);
  assert.equal(shared.saved.settings.model,'generated-runtime-model');
  assert.equal(shared.features.chat.model,'generated-runtime-model');
  assert.equal(shared.features.chat.configured,true);
  assert.equal(shared.configuration.domain?.status,'applied');
  assert.equal(agentRuntimeReadiness(shared),'ready');
  const selected=shared.saved.profiles.find(profile=>profile.id===shared.features.chat.profileId);
  assert.equal(selected?.name,shared.saved.profiles[0].name,'the current selection stays readable from the same receipt');

  const web=parseAgentRuntimeStatus(body);
  assert.deepEqual(web,shared);
  const mac=await readAgentRuntimeStatus({serverUrl:origin,token:owner});
  assert.deepEqual(mac,shared);

  const bad={...(body as Record<string,unknown>),revision:-1};
  assert.equal(agentRuntimeStatusReceiptSchema.safeParse(bad).success,false);
  assert.throws(()=>parseAgentRuntimeStatus(bad),error=>error instanceof ApiError&&error.code==='invalid_response');
  await assert.rejects(readAgentRuntimeStatus({serverUrl:origin,token:owner},async()=>Response.json(bad)),error=>error instanceof ConnectionError&&error.code==='INVALID_RESPONSE');
  assert.equal(shared.saved.settings.model,'generated-runtime-model','the rejected revision does not erase the current selected settings');
  assert.equal(web.features.chat.profileId,shared.features.chat.profileId);
});

test('real unconfigured HTTP output stays readable without faking ready',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-runtime-unconfigured-'));
  const node=await buildApp({...config(directory),model:'',modelBaseUrl:'',apiKey:''},{backgroundWorker:false});
  t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
  const origin=await node.app.listen({host:'127.0.0.1',port:0});
  const response=await fetch(origin+'/api/agent-runtime-settings',{headers:{authorization:'Bearer '+owner}});
  assert.equal(response.status,200);
  const body:unknown=await response.json();
  const shared=agentRuntimeStatusReceiptSchema.parse(body);
  assert.equal(agentRuntimeReadiness(shared),'unconfigured');
  assert.equal(shared.features.chat.configured,false);
  assert.equal(shared.saved.profiles.some(profile=>profile.id===shared.features.chat.profileId),true,'the default selection stays readable');
  assert.deepEqual(parseAgentRuntimeStatus(body),shared);
  assert.deepEqual(await readAgentRuntimeStatus({serverUrl:origin,token:owner}),shared);
});
