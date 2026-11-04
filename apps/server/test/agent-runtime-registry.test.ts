import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {ModelSettings,ModelSettingsInput,ModelProfile} from '@mote/shared/models';
import {ConfigService,type ConfigServiceOptions} from '../src/config-service.js';
import {ConcurrencyGate} from '../src/concurrency.js';
import {ModelSettingsError,ModelSettingsStore,defaultModelDomain,modelDomainSchema,type PreparedModelSettings} from '../src/model-settings.js';
import {AgentRuntimeRegistry,type AgentRuntimeRegistryDependencies} from '../src/agent-runtime-registry.js';
import type {ModelAgentFactory} from '../src/model-agent.js';
import type {QueryAgent} from '../src/query-agent.js';

const secret='synthetic-private-api-key';
const environment:ModelSettings={
  provider:'custom',protocol:'openai-completions',baseUrl:'https://fixture.example.invalid/v1',model:'synthetic-base-model',
  reasoningEffort:'auto',maxTokens:8192,modelRequestTimeoutMs:120_000,agentTimeoutMs:120_000,allowUnauthenticatedLocal:false,
  apiKey:secret,headers:{'X-Synthetic-Authorization':'synthetic-private-header'},extraBody:{vendor_options:{credential:secret}},
};
function input(settings:ModelSettings=environment):ModelSettingsInput {
  const {apiKey:_key,headers:_headers,extraBody:_extra,...parameters}=settings;
  return structuredClone(parameters);
}
const reader:ContextReader={
  search:async()=>[],timeline:async()=>({items:[],nextCursor:null,totalCount:0}),evidence:async()=>[],
  activity:async()=>({captures:0}),devices:async()=>[],
};
type FixtureAgent=QueryAgent&{settings:ModelSettings;closes:number};
interface FixtureOptions {fileSystem?:ConfigServiceOptions['fileSystem'];profiles?:ModelProfile[]}
function registry(createModelAgent:ModelAgentFactory){
  const dependencies:AgentRuntimeRegistryDependencies={
    codex:undefined,createModelAgent,
    authorization:{assertCurrent(){}},admission:{check(){},run:async(_settings,task)=>task()},
    runModelFor:()=>async task=>task(),authorizeModelRequest(){},assertPurpose(){},assertEvidence(){},assertEvidenceAsync:async()=>{},pinEvidence:input=>input,
    agentGate:new ConcurrencyGate(1),interactiveGate:new ConcurrencyGate(1),modelContext:new AsyncLocalStorage<QueryInput>(),modelOperation:new AsyncLocalStorage<string>(),
    archiveImagesEnabled:()=>false,retainSnapshot(){},releaseSnapshot(){},agentStarted(){},recordTiming(){},
  };
  return new AgentRuntimeRegistry(dependencies);
}
async function fixture(t:TestContext,options:FixtureOptions={}) {
  const directory=await fs.mkdtemp(join(tmpdir(),'mote-agent-registry-')),path=join(directory,'mote.yaml');
  const created:FixtureAgent[]=[],failModels=new Set<string>();
  const factory:ModelAgentFactory=async settings=>{
    if(failModels.has(settings.model))throw new Error('Synthetic provider rejected credential '+settings.apiKey);
    const agent:FixtureAgent={settings,closes:0,configured:true,
      query:async()=>({answer:settings.model,citations:[],trace:[]}),
      close:async()=>{agent.closes++;},
    };
    created.push(agent);return agent;
  };
  const domain=defaultModelDomain();
  const service=new ConfigService({path,initialDocument:{version:1,revision:0,models:{...domain,deployment:environment,...(options.profiles?{profiles:options.profiles}:{})}},watch:false,fileSystem:options.fileSystem});
  service.register({id:'models',schema:modelDomainSchema,defaultValue:defaultModelDomain()});
  const agent=registry(factory),failures:unknown[]=[];
  const prepare=async(_settings:ModelSettings,profiles:ModelProfile[],defaultProfileId:string):Promise<PreparedModelSettings>=>agent.prepareModels(profiles,reader,{defaultProfileId,activate(){},rollback(){}});
  const store=new ModelSettingsStore({configService:service,prepare,probe:async()=>({ok:true,code:'ok',message:'',durationMs:1})});
  t.after(async()=>{
    await store.close().catch(error=>failures.push(error));
    await agent.close().catch(error=>failures.push(error));
    await service.close().catch(error=>failures.push(error));
    await fs.rm(directory,{recursive:true,force:true});
    assert.deepEqual(failures,[]);
  });
  return {directory,path,service,store,agent,created,failModels};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const receipt=(error:unknown)=>[String(error),(error as Error)?.message,(error as Error)?.stack,JSON.stringify(error)].join('\n');

test('a failed prepare keeps the old runtime usable and releases its partial candidate once',async t=>{
  const f=await fixture(t,{profiles:[{id:'secondary',name:'Secondary fixture',settings:{...environment,model:'synthetic-secondary-model'}}]});
  await f.store.initialize();
  const before=f.created.length,base=f.created[0]!;
  f.failModels.add('synthetic-secondary-model');
  const revision=f.service.revision,error=await f.store.update({revision,settings:{...input(),model:'synthetic-uncommitted-model'}}).then(()=>undefined,reason=>reason);
  assert.ok(error instanceof ModelSettingsError);assert.equal(error.code,'model_settings_prepare_failed');
  assert.ok(!receipt(error).includes(secret));
  await flush();
  const partial=f.created.slice(before);
  assert.equal(partial.length,1,'only the profile prepared before the failure was constructed');
  assert.equal(partial[0]!.closes,1,'the partial candidate is released exactly once');
  assert.equal(base.closes,0,'the committed generation is never retired by a failed prepare');
  assert.equal((await f.agent.query({question:'Generated question'})).answer,environment.model);
  assert.equal(f.service.revision,revision);
});

test('a persist failure after activation keeps the new runtime and releases only the old one',async t=>{
  let fail=false,directory='';
  const f=await fixture(t,{fileSystem:{open:async(...args)=>{
    const handle=await fs.open(...args);
    if(args[0]===directory&&fail)handle.sync=async()=>{throw new Error('Synthetic private directory sync failure');};
    return handle;
  }}});
  directory=f.directory;await f.store.initialize();
  const before=f.created.length,base=f.created[0]!;
  fail=true;
  const error=await f.store.update({revision:f.service.revision,settings:{...input(),model:'synthetic-committed-model'}}).then(()=>undefined,reason=>reason);
  fail=false;
  assert.ok(error instanceof ModelSettingsError);assert.equal(error.code,'model_settings_commit_uncertain');
  assert.ok(!receipt(error).includes(secret));
  await flush();
  const committed=f.created.slice(before);
  assert.deepEqual(committed.map(agent=>agent.settings.model),['synthetic-base-model','synthetic-committed-model'],'the candidate registry holds the deployment and default profiles');
  assert.ok(committed.every(agent=>agent.closes===0),'the activated candidate remains owned by the live configuration');
  assert.equal(base.closes,1,'only the replaced generation retires');
  assert.equal((await f.agent.query({question:'Generated question'})).answer,'synthetic-committed-model');
  assert.equal(f.store.current().model,'synthetic-committed-model');
});

test('a rollback restores the previous composition and releases the candidate once',async t=>{
  const f=await fixture(t);
  f.service.register({id:'execution',schema:z.object({agentConcurrency:z.number().int()}).strict(),defaultValue:{agentConcurrency:1}});
  await f.store.initialize();
  const before=f.created.length,base=f.created[0]!;
  f.service.setHandler('execution',()=>({applyOrder:2000,apply(){},publish(){throw new Error('Synthetic private publish failure '+secret);},rollback(){}}));
  const revision=f.service.revision,error=await f.service.updateMany({models:{deployment:{model:'synthetic-rolled-back-model'}},execution:{agentConcurrency:2}},revision).then(()=>undefined,reason=>reason);
  assert.equal(error.code,'config_apply_failed');assert.ok(!receipt(error).includes(secret));
  await flush();
  const candidate=f.created.slice(before);
  assert.equal(candidate.length,1);
  assert.equal(candidate[0]!.closes,1,'the rolled-back candidate is released exactly once');
  assert.equal(base.closes,0,'the restored generation remains live');
  assert.equal((await f.agent.query({question:'Generated question'})).answer,environment.model);
  assert.equal(f.store.current().model,environment.model);
  assert.equal(f.service.current<{deployment:{model:string}}>('models').deployment.model,environment.model);
});

test('repeated close releases the active generation and every candidate exactly once',async t=>{
  const f=await fixture(t);await f.store.initialize();
  const base=f.created[0]!,pending:FixtureAgent={settings:environment,closes:0,configured:true,
    query:async()=>({answer:'unreachable',citations:[],trace:[]}),close:async()=>{pending.closes++;}};
  const prepared=await f.agent.prepare(pending,()=>{});
  const closing=f.agent.close();
  assert.equal(f.agent.close(),closing,'repeated close returns the same cleanup');
  await Promise.all([closing,f.agent.close()]);
  await prepared.dispose();
  assert.equal(pending.closes,1,'an unactivated candidate created before close is released once');
  assert.equal(base.closes,1,'the active generation is released once across repeated closes');
  assert.equal(f.agent.configured,false);
  await assert.rejects(f.agent.query({question:'Generated closed question'}),/Agent is closed/);
  assert.throws(()=>f.agent.factory(environment,reader,undefined,{kind:'profile',id:'generated'}),{statusCode:503});
});
