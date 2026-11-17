import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'yaml';
import {z} from 'zod';
import {ConfigService,type ConfigDomainReference} from '../src/config-service.js';
import {activityConfigDomain} from '../src/config.js';

async function fixture(t:TestContext){
  const directory=await mkdtemp(join(tmpdir(),'mote-config-domain-reference-'));
  const service=new ConfigService({path:join(directory,'mote.yaml'),initialDocument:{version:1,revision:0},watch:false});
  t.after(async()=>{await service.close();await rm(directory,{recursive:true,force:true});});
  return service;
}

// Checked with the Server's existing compiler options; this function is not executed.
function inferredTypes(service:ConfigService){
  const value=service.current(activityConfigDomain);
  const enabled:boolean=value.enabled,profile:string|null=value.modelProfileId;
  // @ts-expect-error The registered schema owns the output type.
  const wrong:string=value.enabled;
  // @ts-expect-error A caller cannot choose an unrelated output type for a reference.
  service.current<{enabled:string}>(activityConfigDomain);
  service.setHandler(activityConfigDomain,(next,previous)=>{
    const nextEnabled:boolean=next.enabled,previousProfile:string|null=previous.modelProfileId;
    // @ts-expect-error This domain has no deployment or model credential fields.
    next.apiKey;
    return {apply(){void nextEnabled;void previousProfile;}};
  });
  // @ts-expect-error The handler must consume the registered output, not a caller-supplied shape.
  service.setHandler(activityConfigDomain,(_next:{enabled:string})=>({apply(){}}));
  void enabled;void profile;void wrong;
}
void inferredTypes;

test('registered references read detached schema output without reparsing and reject forged reads or handlers',async t=>{
  const service=await fixture(t);let parses=0,published=2;
  const schema=z.object({raw:z.string()}).strict().transform(({raw})=>{parses++;return {limit:Number(raw)};});
  const reference=Object.freeze({id:'generated',schema}) satisfies ConfigDomainReference<typeof schema>;
  service.register({...reference,defaultValue:{raw:'2'}});await service.initialize();
  const before=parses,snapshot=service.current(reference);assert.deepEqual(snapshot,{limit:2});
  snapshot.limit=999;assert.deepEqual(service.current(reference),{limit:2});assert.equal(parses,before);
  service.setHandler(reference,(next,previous)=>({apply(){},publish(){published=next.limit;},rollback(){published=previous.limit;}}));
  for(const forged of [{id:'missing',schema},{id:'generated',schema:z.object({limit:z.number()})},null,{}]){
    assert.throws(()=>service.current(forged as never),{code:'config_invalid'});
    assert.throws(()=>service.setHandler(forged as never,()=>({apply(){throw Error('A forged handler ran');}})),{code:'config_invalid'});
  }
  assert.equal(parses,before,'invalid references never resolve or parse their supplied schema');
  await service.update('generated',{raw:'3'},0);assert.equal(published,3);assert.deepEqual(service.current(reference),{limit:3});
  assert.deepEqual(parse(await readFile(service.path,'utf8')).generated,{raw:'3'},'the reference never persists parsed output');
});

test('reference handlers remain domain-local and cold fields stay saved until restart',async t=>{
  const service=await fixture(t),reference=Object.freeze({id:'generated',schema:z.object({hot:z.number(),cold:z.number()}).strict()});
  const other=Object.freeze({id:'other',schema:z.object({enabled:z.boolean()}).strict()});
  const registration={...reference,defaultValue:{hot:0,cold:0},fields:[{path:'cold',effect:'restart' as const}]};
  service.register(registration);service.register({...other,defaultValue:{enabled:false}});await service.initialize();
  const prepared={generated:0,other:0};
  service.setHandler(reference,()=>{prepared.generated++;return {apply(){}};});
  service.setHandler(other,()=>{prepared.other++;return {apply(){}};});
  await service.update('generated',{cold:1},0);assert.deepEqual(service.current(reference),{hot:0,cold:0});assert.deepEqual(prepared,{generated:0,other:0});
  await service.update('other',{enabled:true},1);assert.deepEqual(prepared,{generated:0,other:1});
  await service.update('generated',{hot:2},2);assert.deepEqual(service.current(reference),{hot:2,cold:0});assert.deepEqual(prepared,{generated:1,other:1});
  assert.deepEqual(parse(await readFile(service.path,'utf8')).generated,{hot:2,cold:1});
  await service.close();
  const restarted=new ConfigService({path:service.path,watch:false});
  try{
    restarted.register(registration);restarted.register({...other,defaultValue:{enabled:false}});await restarted.initialize();
    assert.deepEqual(restarted.current(reference),{hot:2,cold:1});
  }finally{await restarted.close();}
});

test('typed reads keep the old effective output across held apply and failed saved candidates',async t=>{
  const service=await fixture(t),first=Object.freeze({id:'first',schema:z.object({count:z.number()}).strict()}),other=Object.freeze({id:'other',schema:z.object({count:z.number()}).strict()});
  service.register({...first,defaultValue:{count:0}});service.register({...other,defaultValue:{count:0}});await service.initialize();
  let active=0,release!:()=>void,entered!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),applying=new Promise<void>(resolve=>{entered=resolve;});
  service.setHandler(first,(next,previous)=>({apply(){},publish(){active=next.count;},rollback(){active=previous.count;}}));
  service.setHandler(other,()=>({async apply(){entered();await held;throw Error('Generated resource failure');},rollback(){}}));
  const saving=service.updateMany({first:{count:1},other:{count:1}},0);
  try{await applying;assert.equal(active,0);assert.deepEqual(service.current(first),{count:0});assert.deepEqual(service.current(other),{count:0});}
  finally{release();}
  await assert.rejects(saving,{code:'config_apply_failed'});
  assert.equal(active,0);assert.deepEqual(service.current(first),{count:0});assert.deepEqual(service.saved('first'),{count:1});
  const failed=service.view().domains.find(domain=>domain.id==='first')!;
  assert.equal(failed.status,'invalid');assert.equal(failed.error,'config_apply_failed');
  assert.equal(service.view().lastError?.code,'config_apply_failed');
  await service.update('other',{count:0},1);
  assert.equal(active,1);assert.deepEqual(service.current(first),{count:1});assert.deepEqual(service.current(other),{count:0});
});
