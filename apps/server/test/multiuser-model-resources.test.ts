import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse,stringify} from 'yaml';
import {DEPLOYMENT_MODEL_PROFILE_ID,type ModelSettings} from '@mote/shared/models';
import {ConfigService,type ConfigDocument} from '../src/config-service.js';
import {defaultModelSettings,modelDomainSchema,modelSettingsSchema} from '../src/model-settings.js';
import {ModelResources,removeCredentials,userModelFields,type UserModelConfiguration,type ResourceGenerationStore,type ResourceGenerationState,type ResourceGenerationRecord} from '../src/scope/model-resources.js';

const settings=(apiKey='synthetic-personal-key'):ModelSettings=>({
  ...defaultModelSettings(),provider:'custom',protocol:'openai-completions',
  baseUrl:'http://127.0.0.1:1/v1',model:'synthetic-model',apiKey,
  headers:{'x-fixture-credential':'synthetic-header-credential'},
  extraBody:{temperature:0.1,fixtureCredential:'synthetic-body-credential'},
});
const personal=(apiKey='synthetic-personal-key'):UserModelConfiguration=>({
  profiles:[{id:'same-id',name:'Synthetic personal profile',settings:settings(apiKey)}],
  selections:{chat:{kind:'personal',id:'same-id'}},
});
async function fixture(t:TestContext,configuredShared=true){
  const directory=await mkdtemp(join(tmpdir(),'mote-scoped-model-resources-'));
  const instance=new ConfigService({path:join(directory,'instance.yaml'),watch:false,initialDocument:{version:1,revision:0,models:{
    deployment:configuredShared?settings('synthetic-shared-key'):defaultModelSettings(),
    profiles:[{id:'disabled',name:'Unconfigured shared model',settings:defaultModelSettings()}],
  }}});
  const services=[instance];
  instance.register({id:'models',schema:modelDomainSchema,defaultValue:{}});
  t.after(async()=>{await Promise.all(services.map(service=>service.close()));await rm(directory,{recursive:true,force:true});});
  await instance.initialize();
  const resources=new ModelResources(instance);
  t.after(()=>resources.close());
  return {instance,resources,directory,services};
}
function generationStore(){
  const rows=new Map<string,ResourceGenerationState>(),writes:ResourceGenerationRecord[]=[];
  const store:ResourceGenerationStore={
    load:()=>[...rows].map(([id,state])=>({id,...structuredClone(state)})),
    save:(id,state)=>{rows.set(id,structuredClone(state));writes.push({id,...structuredClone(state)});},
  };
  return {store,rows,writes};
}

test('shared models expose only fixed references; missing or retired selections do not fall back',async t=>{
  const {instance,resources}=await fixture(t),schema=resources.schema();
  assert.deepEqual(schema.parse({}),{profiles:[],selections:{}});
  const shared=resources.listShared();
  assert.equal(shared.length,1);
  assert.deepEqual(Object.keys(shared[0]!).sort(),['id','model','name','provider','readOnly']);
  assert.equal(shared[0]!.id,DEPLOYMENT_MODEL_PROFILE_ID);
  assert.equal(shared[0]!.readOnly,true);
  for(const credential of ['synthetic-shared-key','synthetic-header-credential','synthetic-body-credential'])assert.ok(!JSON.stringify(shared).includes(credential));
  const configuration=schema.parse({selections:{chat:{kind:'shared',id:DEPLOYMENT_MODEL_PROFILE_ID}}});
  const resolved=resources.resolve(configuration,'chat');
  assert.equal(resolved.settings.apiKey,'synthetic-shared-key');
  resolved.settings.apiKey='changed-only-in-the-returned-copy';
  assert.equal(resources.resolve(configuration,'chat').settings.apiKey,'synthetic-shared-key');
  for(const override of [{baseUrl:'https://attacker.invalid'},{settings:settings('untrusted')},{model:'another-model'},{kind:'personal',id:DEPLOYMENT_MODEL_PROFILE_ID}]){
    assert.equal(schema.safeParse({selections:{chat:{kind:'shared',id:DEPLOYMENT_MODEL_PROFILE_ID,...override}}}).success,false);
  }
  assert.equal(schema.safeParse({deployment:settings('untrusted')}).success,false);
  assert.throws(()=>resources.resolve(schema.parse({}),'chat'),{code:'scope_unavailable'});
  assert.throws(()=>resources.resolve(schema.parse({selections:{chat:{kind:'shared',id:'missing'}}}),'chat'),{code:'scope_unavailable'});
  await instance.update('models',{deployment:{model:''}},instance.revision);
  assert.deepEqual(resources.listShared(),[]);
  assert.throws(()=>resources.resolve(configuration,'chat'),{code:'scope_unavailable'});
});

test('empty instance model defaults are not offered as usable shared resources',async t=>{
  const {resources}=await fixture(t,false);
  assert.deepEqual(resources.listShared(),[]);
  assert.throws(()=>resources.resolve({profiles:[],selections:{chat:{kind:'shared',id:DEPLOYMENT_MODEL_PROFILE_ID}}},'chat'),{code:'scope_unavailable'});
});

test('shared generations fence withdrawal and republication even when credentials and endpoint are unchanged',async t=>{
  const {instance,resources}=await fixture(t),id=DEPLOYMENT_MODEL_PROFILE_ID;
  // initialize() has no notification; the first lookup establishes generation 1.
  assert.equal(resources.generation(id),1);assert.equal(resources.generation('never-published'),0);
  const initial=instance.current<{deployment:ModelSettings}>('models').deployment;
  await instance.update('models',{deployment:{model:''}},instance.revision);
  assert.equal(resources.generation(id),2);assert.deepEqual(resources.listShared(),[]);
  await instance.update('models',{deployment:initial},instance.revision);
  assert.equal(resources.generation(id),3);
  await instance.update('models',{deployment:{apiKey:'synthetic-replaced-shared-key'}},instance.revision);
  assert.equal(resources.generation(id),4);
  await instance.update('models',{profiles:[{id:'new-shared',name:'Synthetic published resource',settings:settings('synthetic-new-resource-key')}]},instance.revision);
  assert.equal(resources.generation('new-shared'),1);assert.equal(resources.generation(id),4);
  await instance.update('models',{profiles:[{id:'new-shared',name:'Renamed resource',settings:settings('synthetic-new-resource-key')}]},instance.revision);
  assert.equal(resources.generation('new-shared'),1);
  // Failed validation emits an instance status change while retaining the last
  // effective resource; it must neither revoke it nor leak the invalid value.
  await assert.rejects(instance.update('models',{deployment:{baseUrl:'http://invalid-remote.invalid'}},instance.revision),{code:'config_invalid'});
  assert.equal(resources.generation(id),4);
});

test('reconstructed resource catalogs load persisted generations without exposing or rewriting connection credentials',async t=>{
  const {instance}=await fixture(t),persistence=generationStore(),id=DEPLOYMENT_MODEL_PROFILE_ID;
  const first=new ModelResources(instance,persistence.store);
  assert.equal(first.generation(id),1);assert.equal(persistence.writes.length,1);
  const row=persistence.rows.get(id)!;assert.match(row.fingerprint!,/^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(persistence.writes).includes('synthetic-shared-key'));
  first.close();const second=new ModelResources(instance,persistence.store);t.after(()=>second.close());
  assert.equal(second.generation(id),1);assert.equal(persistence.writes.length,1);
  await instance.update('models',{deployment:{apiKey:'synthetic-persisted-rotation'}},instance.revision);
  assert.equal(persistence.rows.get(id)!.generation,2);
  assert.equal(second.generation(id),2);assert.equal(persistence.writes.length,2);
});

test('withdrawn shared models retain their durable generation across instance restart and identical republication',async t=>{
  const {instance,services}=await fixture(t),persistence=generationStore(),id=DEPLOYMENT_MODEL_PROFILE_ID;
  const first=new ModelResources(instance,persistence.store),initial=instance.current<{deployment:ModelSettings}>('models').deployment;
  const originalGeneration=first.generation(id);
  await instance.update('models',{deployment:{model:''}},instance.revision);
  assert.deepEqual(persistence.rows.get(id),{generation:2});
  first.close();await instance.close();
  const restarted=new ConfigService({path:instance.path,watch:false});services.push(restarted);
  restarted.register({id:'models',schema:modelDomainSchema,defaultValue:{}});await restarted.initialize();
  const second=new ModelResources(restarted,persistence.store);t.after(()=>second.close());
  assert.equal(second.generation(id),2);assert.deepEqual(second.listShared(),[]);
  await restarted.update('models',{deployment:initial},restarted.revision);
  assert.equal(second.generation(id),3);assert.notEqual(second.generation(id),originalGeneration);
  second.close();const third=new ModelResources(restarted,persistence.store);t.after(()=>third.close());
  assert.equal(third.generation(id),3);assert.notEqual(third.generation(id),originalGeneration);
});

test('uncertain instance revisions durably invalidate every known resource before reconciliation',async t=>{
  const {instance}=await fixture(t),persistence=generationStore(),id=DEPLOYMENT_MODEL_PROFILE_ID;
  const first=new ModelResources(instance,persistence.store);assert.equal(first.generation(id),1);
  await instance.update('models',{profiles:[{id:'retired',name:'Retired fixture',settings:settings('synthetic-retired-key')}]},instance.revision);
  assert.equal(first.generation('retired'),1);
  await instance.update('models',{profiles:[]},instance.revision);
  assert.deepEqual(persistence.rows.get('retired'),{generation:2});
  const fingerprint=persistence.rows.get(id)!.fingerprint;first.close();
  const restarted=new ModelResources(instance,persistence.store);t.after(()=>restarted.close());
  restarted.invalidateGenerations();
  assert.deepEqual(persistence.rows.get(id),{generation:2,fingerprint});
  assert.deepEqual(persistence.rows.get('retired'),{generation:3});
  assert.equal(restarted.generation(id),2);assert.equal(restarted.generation('retired'),3);
});

test('generation-store failures are value-free and latch all resource reads closed until host reconstruction',async t=>{
  const {instance}=await fixture(t),persistence=generationStore(),id=DEPLOYMENT_MODEL_PROFILE_ID;
  let fail=false;
  const store:ResourceGenerationStore={load:()=>persistence.store.load(),save:(key,state)=>{if(fail)throw Error('synthetic-storage-credential');persistence.store.save(key,state);}};
  const resources=new ModelResources(instance,store);t.after(()=>resources.close());
  assert.equal(resources.generation(id),1);const previous=structuredClone(persistence.rows.get(id));fail=true;
  await instance.update('models',{deployment:{apiKey:'synthetic-after-failed-generation'}},instance.revision);
  assert.deepEqual(persistence.rows.get(id),previous);
  fail=false;
  for(const read of [()=>resources.generation(id),()=>resources.listShared(),()=>resources.schema(),()=>resources.resolve({profiles:[],selections:{chat:{kind:'shared',id}}},'chat'),()=>resources.invalidateGenerations()]){
    assert.throws(read,error=>Boolean(error&&typeof error==='object'&&'code' in error&&error.code==='config_unavailable'&&!String(error).includes('synthetic-storage-credential')));
  }
  resources.close();const recovered=new ModelResources(instance,store);t.after(()=>recovered.close());
  recovered.invalidateGenerations();assert.equal(recovered.generation(id),3);
  assert.throws(()=>new ModelResources(instance,{load:()=>{throw Error('synthetic-load-credential');},save:()=>{}}),{code:'config_unavailable'});
  assert.throws(()=>new ModelResources(instance,{load:()=>[{id,generation:0}],save:()=>{}}),{code:'config_unavailable'});
  assert.throws(()=>new ModelResources(instance,{load:()=>[{id,generation:1},{id,generation:1}],save:()=>{}}),{code:'config_unavailable'});
});

test('personal profile identity and credentials stay within each passed configuration',async t=>{
  const {resources}=await fixture(t),schema=resources.schema();
  const a=schema.parse(personal('synthetic-A-key')),b=schema.parse(personal('synthetic-B-key'));
  assert.equal(resources.resolve(a,'chat').settings.apiKey,'synthetic-A-key');
  assert.equal(resources.resolve(b,'chat').settings.apiKey,'synthetic-B-key');
  const leased=resources.resolve(a,'chat');leased.settings.headers['x-fixture-credential']='changed-copy';
  assert.equal(resources.resolve(a,'chat').settings.headers['x-fixture-credential'],'synthetic-header-credential');
  assert.equal(schema.safeParse({...a,profiles:[...a.profiles,...a.profiles]}).success,false);
  assert.equal(schema.safeParse({profiles:[],selections:{chat:{kind:'personal',id:'same-id'}}}).success,false);
  assert.equal(schema.safeParse({...a,selections:{chat:{kind:'personal',id:'same-id',userId:'other-account'}}}).success,false);
});

test('personal models cannot resolve instance environment credentials or use the host Codex login',async t=>{
  const {resources}=await fixture(t),schema=resources.schema(),configuration=personal();
  const changes:Partial<ModelSettings>[]=[
    {apiKey:'${MOTE_SYNTHETIC_INSTANCE_SECRET}'},
    {headers:{authorization:'${MOTE_SYNTHETIC_INSTANCE_SECRET}'}},
    {extraBody:{nested:{credential:'${MOTE_SYNTHETIC_INSTANCE_SECRET}'}}},
    {extraBody:{'${MOTE_SYNTHETIC_INSTANCE_SECRET}':'value'}},
    {protocol:'codex-app-server',baseUrl:'',apiKey:'',headers:{},extraBody:{},serviceTier:'default',modelRequestTimeoutMs:null},
  ];
  for(const change of changes){
    const value={...configuration,profiles:[{...configuration.profiles[0]!,settings:{...settings(),...change}}]};
    assert.equal(schema.safeParse(value).success,false);
    assert.throws(()=>resources.resolve(value,'chat'),error=>Boolean(error&&typeof error==='object'&&'code' in error&&error.code==='config_invalid'&&!String(error).includes('synthetic-personal-key')));
  }
});

test('personal settings retain the established transport and protected-input validation',async t=>{
  const {resources}=await fixture(t),schema=resources.schema();
  for(const change of [
    {baseUrl:'http://remote.invalid/v1'},
    {baseUrl:'https://user:password@provider.invalid/v1'},
    {headers:{host:'attacker.invalid'}},
    {extraBody:{nested:{model:'replacement'}}},
    {extraBody:{base_url:'https://attacker.invalid'}},
    {maxTokens:128_001},
    {protocol:'invented-protocol'},
  ]){
    assert.equal(schema.safeParse({profiles:[{id:'fixture',name:'Fixture',settings:{...settings(),...change}}]}).success,false);
  }
});

test('registered providers reuse model settings validation and registration disposal cannot remove a newer plugin',async t=>{
  const {resources}=await fixture(t),schema=resources.schema();
  const value={profiles:[{id:'plugin',name:'Synthetic plugin',settings:{...settings(),provider:'fixture-provider'}}]};
  assert.equal(schema.safeParse(value).success,false);
  const unregister=resources.registerProvider('fixture-provider',candidate=>{
    candidate.headers['x-fixture-credential']='validator-private-copy';
    return candidate.model==='synthetic-model';
  });
  const parsed=schema.parse(value);
  assert.equal(parsed.profiles[0]!.settings.provider,'fixture-provider');
  assert.equal(parsed.profiles[0]!.settings.headers['x-fixture-credential'],'synthetic-header-credential');
  assert.equal(schema.safeParse({profiles:[{...value.profiles[0]!,settings:{...value.profiles[0]!.settings,model:'disallowed'}}]}).success,false);
  assert.equal(schema.safeParse({profiles:[{...value.profiles[0]!,settings:{...value.profiles[0]!.settings,extraBody:{model:'replacement'}}}]}).success,false);
  assert.throws(()=>resources.registerProvider('custom'),{code:'config_invalid'});
  assert.throws(()=>resources.registerProvider('fixture-provider'),{code:'config_invalid'});
  unregister();assert.equal(schema.safeParse(value).success,false);
  const unregisterNew=resources.registerProvider('fixture-provider');
  unregister();assert.equal(schema.safeParse(value).success,true);
  unregisterNew();assert.equal(schema.safeParse(value).success,false);
});

test('registered provider declarations use the same instance shared schema and are disposed on host close',async t=>{
  const {instance,resources}=await fixture(t),id='fixture-shared-provider';
  const pluginSettings={...settings('synthetic-plugin-shared-key'),provider:id};
  assert.equal(modelSettingsSchema.safeParse(pluginSettings).success,false);
  const unregister=resources.registerProvider(id,candidate=>candidate.model==='synthetic-model');
  await instance.update('models',{profiles:[{id:'shared-plugin',name:'Synthetic shared plugin',settings:pluginSettings}]},instance.revision);
  assert.equal(resources.listShared().find(profile=>profile.id==='shared-plugin')!.provider,id);
  const configuration={profiles:[],selections:{chat:{kind:'shared' as const,id:'shared-plugin'}}};
  assert.equal(resources.resolve(configuration,'chat').settings.apiKey,'synthetic-plugin-shared-key');
  assert.equal(resources.generation('shared-plugin'),1);
  await assert.rejects(instance.update('models',{profiles:[{id:'shared-plugin',name:'Synthetic shared plugin',settings:{...pluginSettings,model:'disallowed'}}]},instance.revision),{code:'config_invalid'});
  unregister();assert.equal(resources.generation('shared-plugin'),2);
  assert.throws(()=>resources.resolve(configuration,'chat'),{code:'scope_unavailable'});
  const unregisterAgain=resources.registerProvider(id);
  assert.equal(resources.generation('shared-plugin'),3);
  resources.close();resources.close();unregisterAgain();
  assert.equal(modelSettingsSchema.safeParse(pluginSettings).success,false);
  assert.throws(()=>resources.registerProvider('after-close'),{code:'config_unavailable'});
});

test('personal exports remove all credential-bearing fields without modifying the effective configuration',async t=>{
  const {resources}=await fixture(t),configuration=resources.schema().parse(personal());
  const exported=removeCredentials(configuration);
  assert.equal(exported.profiles[0]!.settings.apiKey,'');
  assert.deepEqual(exported.profiles[0]!.settings.headers,{});
  assert.deepEqual(exported.profiles[0]!.settings.extraBody,{});
  assert.deepEqual(exported.selections,configuration.selections);
  assert.equal(configuration.profiles[0]!.settings.apiKey,'synthetic-personal-key');
  assert.equal(configuration.profiles[0]!.settings.headers['x-fixture-credential'],'synthetic-header-credential');
  for(const secret of ['synthetic-personal-key','synthetic-header-credential','synthetic-body-credential'])assert.ok(!JSON.stringify(exported).includes(secret));
  assert.throws(()=>resources.resolve(exported,'chat'),{code:'scope_unavailable'});
});

test('file and page edits use the same personal schema, redaction and revision without reading host environment secrets',async t=>{
  const {resources,directory,services}=await fixture(t);
  const previous=process.env.MOTE_SYNTHETIC_INSTANCE_SECRET;
  process.env.MOTE_SYNTHETIC_INSTANCE_SECRET='synthetic-instance-env-credential';
  t.after(()=>{if(previous===undefined)delete process.env.MOTE_SYNTHETIC_INSTANCE_SECRET;else process.env.MOTE_SYNTHETIC_INSTANCE_SECRET=previous;});
  const service=new ConfigService({path:join(directory,'personal.yaml'),initialDocument:{version:1,revision:0},watch:false});services.push(service);
  service.register({id:'models',schema:resources.schema(),defaultValue:{profiles:[],selections:{}},fields:userModelFields,resolve:raw=>raw});
  await service.initialize();await service.replace('models',personal(),0);
  const view=service.view(),publicSettings=((view.domains[0]!.effective as {profiles:{settings:Record<string,unknown>}[]}).profiles[0]!.settings);
  assert.equal(publicSettings.apiKey,true);assert.equal(publicSettings.headers,true);assert.equal(publicSettings.extraBody,true);
  for(const secret of ['synthetic-personal-key','synthetic-header-credential','synthetic-body-credential','synthetic-instance-env-credential'])assert.ok(!JSON.stringify(view).includes(secret));
  const bytes=await readFile(service.path,'utf8'),invalid=personal('${MOTE_SYNTHETIC_INSTANCE_SECRET}');
  await assert.rejects(service.replace('models',invalid,service.revision),{code:'config_invalid'});
  assert.equal(await readFile(service.path,'utf8'),bytes);
  const document=parse(bytes) as ConfigDocument;document.models=invalid;await writeFile(service.path,stringify(document));
  await assert.rejects(service.reload(),{code:'config_invalid'});
  assert.equal(service.current<UserModelConfiguration>('models').profiles[0]!.settings.apiKey,'synthetic-personal-key');
  assert.equal(service.revision,1);
  document.models=personal('synthetic-file-key');await writeFile(service.path,stringify(document));await service.reload();
  assert.equal(service.revision,2);assert.equal(service.current<UserModelConfiguration>('models').profiles[0]!.settings.apiKey,'synthetic-file-key');
  await assert.rejects(service.replace('models',personal('synthetic-stale-page-key'),1),{code:'config_conflict'});
});
