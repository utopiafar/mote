import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ModelSettings} from '@mote/shared/models';
import {Store} from '../src/store.js';
import {MemoryAdapters} from '../src/memory-adapters.js';
import {HindsightEngine} from '../src/hindsight-engine.js';
import {ModelSettingsError,type ModelSettingsStore} from '../src/model-settings.js';
import type {PluginCenter} from '../src/plugin-center.js';

// Generated registry/profile transport only: constructing the actual adapter
// must preserve the missing-profile distinction without starting Docker/models.
const settings:ModelSettings={provider:'openai',protocol:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',model:'generated-retained-model',reasoningEffort:'medium',serviceTier:'default',maxTokens:1000,modelRequestTimeoutMs:null,agentTimeoutMs:1000,allowUnauthenticatedLocal:true,apiKey:'',headers:{},extraBody:{}};
for(const scenario of ['retained-missing','new-missing','retained-unavailable','retained-untyped-missing'])test('retained Hindsight reader profile resolution: '+scenario,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-hindsight-retained-')),store=new Store(join(directory,'vault')),id='generated-hindsight',identity='generated-fixed-configuration';let modelRequests=0;
 const plugins={store,instanceView:()=>({id,packageId:'generated-package',configuration:{modelProfileId:'deleted-generated-profile'}}),packageForInstance:()=>({directory:join(directory,'package'),hostAdapter:'mote.hindsight@1',view:{id:'generated-package',state:'installed',source:{digest:'a'.repeat(64)}}}),configurationIdentity:()=>identity,releases:{directory:join(directory,'packages'),verifyInstalled:()=>{}}} as unknown as PluginCenter;
 const error=scenario==='retained-unavailable'?new ModelSettingsError('model_settings_unavailable'):scenario==='retained-untyped-missing'?Object.assign(new Error('Generated foreign error'),{code:'model_profile_missing'}):new ModelSettingsError('model_profile_missing');
 const models={select:()=>{throw error;}} as unknown as ModelSettingsStore,adapters=new MemoryAdapters(join(directory,'instances'),plugins,models,{onRequestStarted:()=>modelRequests++});
 try{
  if(scenario!=='new-missing')store.db.prepare('INSERT INTO memory_provider_model_snapshots VALUES(?,?)').run(id+':'+identity,JSON.stringify(settings));
  if(scenario==='retained-missing'){
   assert.ok(adapters.provider(id) instanceof HindsightEngine,'only an exact missing approved profile may preserve its existing frozen literal reader');
   assert.throws(()=>adapters.engine(id),candidate=>candidate===error,'semantic work cannot use another profile or deployment default');
  }else assert.throws(()=>adapters.provider(id),candidate=>candidate===error);
  assert.equal(modelRequests,0);
 }finally{await adapters.close();store.close();await rm(directory,{recursive:true,force:true});}
});
