import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {Configurations} from '../src/scope/configuration.js';
import {UserContextAuthority} from '../src/scope/context.js';
import {defaultModelSettings} from '../src/model-settings.js';
import type {ConfigDomainRegistration} from '../src/config-service.js';

async function fixture(t:TestContext,domain:ConfigDomainRegistration){
  const directory=mkdtempSync(join(tmpdir(),'mote-m04-effective-snapshot-'));
  const db=new DatabaseSync(join(directory,'synthetic.sqlite'));
  const authority=new UserContextAuthority('synthetic-deployment',{
    verify:async()=>({deploymentId:'synthetic-deployment',userId:'synthetic-user',credentialId:'synthetic-session',authorizationEpoch:0,administrator:false}),
    isCurrent:()=>true,
  });
  const manager=await Configurations.open({directory,db,authority});
  t.after(async()=>{await manager.close();db.close();rmSync(directory,{recursive:true,force:true});});
  manager.registerDomain(domain.id,()=>domain);
  const service=manager.forUser(await authority.authenticate('synthetic-token'));
  await service.replace('models',{
    profiles:[{id:'synthetic-personal',name:'Synthetic personal model',settings:{
      ...defaultModelSettings(),provider:'custom',protocol:'openai-completions',reasoningEffort:'auto',
      baseUrl:'https://synthetic.invalid/v1',model:'synthetic-model',apiKey:'synthetic-key',
    }}],
    selections:{chat:{kind:'personal',id:'synthetic-personal'}},
  },0);
  const snapshot=async(operationId:string)=>manager.withModel(await service.lease('chat',operationId),async(_settings,configuration)=>configuration[domain.id]);
  return {service,snapshot};
}

test('model leases pin effective values for restart domains and restart-only fields',async t=>{
  for(const restartRequired of [true,false])await t.test(restartRequired?'restart domain':'restart field',async t=>{
    const {service,snapshot}=await fixture(t,{
      id:'syntheticExtension',schema:z.object({limit:z.number(),label:z.string()}).strict(),
      defaultValue:{limit:1,label:'synthetic-old'},restartRequired,
      fields:[{path:'limit',effect:'restart'},{path:'label',effect:'next-request'}],resolve:raw=>raw,
    });
    await service.replace('syntheticExtension',{limit:99,label:'synthetic-new'},1);
    const domain=(await service.view()).domains.find(value=>value.id==='syntheticExtension')!;
    assert.deepEqual(domain.saved,{limit:99,label:'synthetic-new'});
    assert.deepEqual(domain.effective,{limit:1,label:'synthetic-new'});
    assert.deepEqual(await snapshot('synthetic-restart-operation'),domain.effective);
  });
});

test('a failed configuration apply cannot enter a newly admitted model snapshot',async t=>{
  const {service,snapshot}=await fixture(t,{
    id:'syntheticExtension',schema:z.object({limit:z.number()}).strict(),defaultValue:{limit:1},
    resolve:raw=>raw,prepare:(next:unknown)=>({
      apply:()=>{if((next as {limit:number}).limit===99)throw Error('synthetic-apply-failure');},
      rollback:()=>{},
    }),
  });
  await assert.rejects(service.replace('syntheticExtension',{limit:99},1),{code:'config_apply_failed'});
  const domain=(await service.view()).domains.find(value=>value.id==='syntheticExtension')!;
  assert.deepEqual(domain.saved,{limit:99});assert.deepEqual(domain.effective,{limit:1});
  assert.deepEqual(await snapshot('synthetic-after-failed-apply'),domain.effective);
});
