import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ModelSettingsInput,ModelSettingsView} from '@mote/shared/models';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {ModelAgentFactory} from '../src/model-agent.js';
import type {AgentRuntimeSettingsView} from '../src/agent-runtime-settings-routes.js';

const owner='synthetic-agent-runtime-owner';
const headers={authorization:`Bearer ${owner}`};
const answer=(model:string)=>({answer:model,citations:[],trace:[],runId:'synthetic-runtime-run'});
const config=(dataDir:string):Config=>({dataDir,token:owner,tokenPath:'fixture-only',host:'127.0.0.1',port:47832,
  maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
  model:'original-fixture',modelBaseUrl:'https://fixture.invalid/v1',apiKey:'synthetic-original-key',modelProvider:'custom',
  modelProtocol:'openai-completions',modelReasoningEffort:'auto',allowUnauthenticatedLocal:false,embeddingModel:'',
  embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:true});
function input(view:ModelSettingsView):ModelSettingsInput {
  const {apiKeyConfigured:_key,headersConfigured:_headers,extraBodyConfigured:_body,...settings}=view.settings;
  return settings;
}
function barrier(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('control route shows the published generation while an accepted durable query keeps its pinned runtime and model',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-agent-runtime-settings-'));
  let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;}),held=barrier();
  const closed:string[]=[],served:string[]=[];let heldOperationId='';
  const factory:ModelAgentFactory=async settings=>{
    if(settings.model==='rejected-fixture')throw new Error('Synthetic rejected model');
    return {configured:true,
      query:async args=>{served.push(settings.model);if(args.question==='hold fixture'){heldOperationId=args.traceContext!.operationId!;started();await held.promise;}return answer(settings.model);},
      close:async()=>{closed.push(settings.model);}};
  };
  const closes=()=>[...closed];
  const node=await buildApp(config(directory),{backgroundWorker:false,createModelAgent:factory});
  t.after(async()=>{held.release();await node.app.close();await rm(directory,{recursive:true,force:true});});

  const route=async()=>{
    const response=await node.app.inject({url:'/api/agent-runtime-settings',headers});
    assert.equal(response.statusCode,200,response.body);
    return response.json<AgentRuntimeSettingsView>();
  };
  const initialView=(await node.app.inject({url:'/api/model-settings',headers})).json<ModelSettingsView>();
  const initial=await route();
  assert.equal(initial.revision,initialView.revision);
  assert.equal(initial.saved.settings.model,'original-fixture');
  assert.equal(initial.features.chat?.model,'original-fixture');
  assert.equal(initial.features.chat?.configured,true);
  assert.equal(initial.runtime.generation,1);
  assert.equal(initial.runtime.activeRuns,0);
  assert.equal(initial.runtime.retiringGenerations,0);
  assert.equal(initial.runtime.releasedGenerations,0);
  assert.equal(initial.runtime.closeErrors,0);
  assert.equal(initial.configuration.domain?.status,'applied');
  assert.equal(initial.configuration.lastError,null);

  const pending=node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'hold fixture'}});
  await began;
  assert.deepEqual(served,['original-fixture']);
  const heldStatus=await route();
  assert.equal(heldStatus.runtime.activeRuns,1);

  const update=await node.app.inject({method:'PUT',url:'/api/model-settings',headers,payload:{revision:initialView.revision,
    settings:{...input(initialView),model:'next-fixture',apiKey:'synthetic-next-key'}}});
  assert.equal(update.statusCode,200,update.body);
  assert.deepEqual(closes(),[],'the replaced generation must stay alive while its accepted run is leased');
  const during=await route();
  assert.equal(during.runtime.generation,2,'the new generation is published before the old run settles');
  assert.equal(during.runtime.activeRuns,1);
  assert.equal(during.runtime.retiringGenerations,1);
  assert.equal(during.runtime.releasedGenerations,0);
  assert.equal(during.saved.settings.model,'next-fixture');
  assert.equal(during.features.chat?.model,'next-fixture');
  assert.equal(during.revision,initialView.revision+1);
  for(const secret of ['synthetic-original-key','synthetic-next-key'])assert.equal(JSON.stringify(during).includes(secret),false);

  held.release();
  const completed=await pending;
  assert.equal(completed.statusCode,200,completed.body);
  assert.equal(completed.json().answer,'original-fixture','the accepted run kept its fixed model version');
  assert.equal(completed.json().modelSelection.model,'original-fixture');
  assert.equal(completed.json().configuration.revision,initialView.revision,'the durable run kept the serialized configuration revision it admitted');
  const journal=node.featureServices.delegation.journal.payload<{configurationFingerprint:string}>(heldOperationId);
  assert.equal(journal.configurationFingerprint,completed.json().configuration.fingerprint,'the registry consumed the exact receipt serialized by ConfigService preparation');
  await flush();
  assert.deepEqual(closed,['original-fixture'],'the retired generation closes after its last lease is released');

  const after=await route();
  assert.equal(after.runtime.generation,2);
  assert.equal(after.runtime.activeRuns,0);
  assert.equal(after.runtime.retiringGenerations,0);
  assert.equal(after.runtime.releasedGenerations,1);
  assert.equal(after.runtime.closeErrors,0);

  const next=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'next fixture'}});
  assert.equal(next.statusCode,200,next.body);
  assert.equal(next.json().answer,'next-fixture');
  assert.equal(next.json().configuration.revision,initialView.revision+1);

  const beforeFailure=await route();
  const rejected=await node.app.inject({method:'PUT',url:'/api/model-settings',headers,payload:{revision:beforeFailure.revision,
    settings:{...input(initialView),model:'rejected-fixture',apiKey:'synthetic-rejected-key'}}});
  assert.equal(rejected.statusCode,503,rejected.body);
  assert.equal(rejected.json().error,'model_settings_prepare_failed');
  assert.equal(rejected.body.includes('synthetic-rejected-key'),false);
  await flush();
  const failed=await route();
  assert.equal(failed.runtime.generation,beforeFailure.runtime.generation,'a failed prepare must not publish a generation');
  assert.equal(failed.runtime.preparedGenerations,0,'the rejected candidate is released entirely');
  assert.equal(failed.saved.settings.model,'next-fixture');
  assert.deepEqual(failed.configuration.lastError,{code:'config_prepare_failed',domain:'models'});
  assert.deepEqual(closed,['original-fixture','original-fixture'],'the failed update releases only its unactivated deployment candidate');
  assert.equal((await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'after failure'}})).json().answer,'next-fixture');
});
