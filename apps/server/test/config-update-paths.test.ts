import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse} from 'yaml';
import {z} from 'zod';
import {PluginHost} from '@mote/plugin-host';
import {serviceContract} from '@mote/plugin-api/contracts';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import type {RegisteredConfigurationDomain} from '../src/plugins/configuration-platform.js';

const token='generated-update-paths-owner-token';
const inactive={configured:false,query:async()=>{throw Error('No model in generated configuration fixture');},close:async()=>{}};
const config=(dataDir:string):ConfigurationPlatformOptions=>({path:(dataDir)+'/mote.yaml',privateCredential:{token:token,tokenPath:'generated'},initialDocument:{version:1,revision:0,storage:{dataDir:dataDir,maxExportBytes:1000000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}}}});

test('real Host registered raw update paths drive owner HTTP, YAML, only-domain publication and rollback without running unknown input',{timeout:120000},async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-config-paths-')),node=await buildApp(config(root),{backgroundWorker:false,agent:inactive}),host=new PluginHost({kind:'central',id:'generated-config-paths-host'});
 let restarted:typeof node|undefined;
 t.after(async()=>{await host.close();await restarted?.app.close();await node.app.close();await rm(root,{recursive:true,force:true});});
 const origin=await node.app.listen({host:'127.0.0.1',port:0});
 const request=async(id:string,value:unknown,revision:number,owner=token)=>{const response=await fetch(origin+'/api/configuration/'+id,{method:'PUT',headers:{authorization:'Bearer '+owner,'content-type':'application/json'},body:JSON.stringify({revision,value})});return {status:response.status,body:await response.text()};};
 type Raw={enabled:boolean;cold:string;label:string;fail:boolean};type Value={active:boolean;cold:number;display:string;fail:boolean};
 const contract=serviceContract<RegisteredConfigurationDomain<Raw,Value>>('generated.configuration.paths','1'),declaration={id:'generated-config-paths',apiVersion:'1'},identity={host:host.identity,packageId:'generated.configuration.paths',installationId:'generated-install',instanceId:'generated-config',activationId:'first'};
 let preprocess=0,rawValidation=0,resolved=0,applied:Value|undefined;const prepared:Value[]=[],published:Value[]=[],otherEvents:unknown[]=[],events:unknown[]=[];
 const schema=z.preprocess(input=>{preprocess++;const raw=input as Raw;return {active:raw.enabled,cold:Number(raw.cold),display:raw.label,fail:raw.fail};},z.object({active:z.boolean(),cold:z.number().int().min(1),display:z.string(),fail:z.boolean()}));
 const rawInputSchema=z.object({enabled:z.preprocess(value=>{rawValidation++;return value;},z.boolean()),cold:z.string(),label:z.string().transform(()=> 'validation output must not persist'),fail:z.boolean()});
 const register=(target:typeof node)=>target.configurationPlatform.registerDomain({id:'paths',schema,rawInputSchema,updatePaths:['enabled','cold','label','fail'],defaultValue:{enabled:false,cold:'1',label:'original',fail:false},fields:[{path:'cold',effect:'restart'}],resolve(input){resolved++;return input;},prepare(next,previous){prepared.push(structuredClone(next));return {apply(){if(next.fail)throw Error('generated-private-apply-failure');},publish(){applied=structuredClone(next);published.push(structuredClone(next));},rollback(){applied=structuredClone(previous);}};}});
 await host.install({identity,contributions:[declaration],factory:context=>({async prepare(){
  const domain=await register(node);
  context.provide(declaration.id,contract,domain);
 },start(){},quiesce(){},stop(){},dispose(){}})});
 const lease=await host.acquire(contract,{provider:{scope:identity,contributionId:declaration.id},service:contract,revision:0});
 lease.value.subscribe(value=>events.push(value));
 const other=await node.configurationPlatform.registerDomain({id:'otherPaths',schema:z.object({enabled:z.boolean()}),updatePaths:['enabled'],defaultValue:{enabled:false}});other.subscribe(value=>otherEvents.push(value));node.configurationPlatform.execution.subscribe(value=>otherEvents.push(value));node.configurationPlatform.diagnostics.subscribe(value=>otherEvents.push(value));
 prepared.length=0;published.length=0;const initial=node.configService.revision;
 const saved=await request('plugin.paths',{enabled:true,label:'edited'},initial);assert.equal(saved.status,200,saved.body);assert.deepEqual(lease.value.snapshot(),{revision:initial+1,value:{active:true,cold:1,display:'edited',fail:false}});assert.equal(prepared.length,1);assert.equal(published.length,1);assert.equal(events.length,1);assert.deepEqual(otherEvents,[]);assert.equal(applied!.active,true);
 const path=join(root,'mote.yaml'),document=parse(await readFile(path,'utf8'));assert.deepEqual(document.plugins.configuration.paths,{enabled:true,cold:'1',label:'edited',fail:false});assert.equal('active' in document.plugins.configuration.paths,false);
 const bytes=await readFile(path),counts={preprocess,rawValidation,resolved};
 const invalid=await request('plugin.paths',{enabled:false,typo:{hidden:true}},initial+1);assert.equal(invalid.status,400,invalid.body);assert.deepEqual({preprocess,rawValidation,resolved},counts,'unknown paths fail before raw validation, resolution and preprocessing');assert.deepEqual(await readFile(path),bytes);assert.equal(events.length,1);assert.deepEqual(otherEvents,[]);
 const unauthorized=await request('plugin.paths',{enabled:false},initial+1,'generated-wrong-owner');assert.equal(unauthorized.status,401,unauthorized.body);assert.deepEqual(await readFile(path),bytes);
 const failed=await request('plugin.paths',{fail:true},initial+1);assert.equal(failed.status,503,failed.body);assert.doesNotMatch(failed.body,/generated-private-apply-failure/);assert.equal(parse(await readFile(path,'utf8')).plugins.configuration.paths.fail,true,'existing apply failure retains its saved candidate without making it effective');assert.equal(node.configService.revision,initial+2);assert.equal(node.configService.view().domains.find(domain=>domain.id==='plugin.paths')!.status,'invalid');assert.equal(applied!.active,true);assert.equal(applied!.fail,false);assert.equal(events.length,1);assert.deepEqual(otherEvents,[]);
 const cold=await request('plugin.paths',{fail:false,cold:'7'},initial+2);assert.equal(cold.status,200,cold.body);assert.equal(lease.value.snapshot().value.cold,1);assert.equal(parse(await readFile(path,'utf8')).plugins.configuration.paths.cold,'7');
 const hot=await request('plugin.paths',{label:'hot after pending restart'},initial+3);assert.equal(hot.status,200,hot.body);assert.equal(lease.value.snapshot().value.cold,1);assert.equal(lease.value.snapshot().value.display,'hot after pending restart');assert.deepEqual(parse(await readFile(path,'utf8')).plugins.configuration.paths,{enabled:true,cold:'7',label:'hot after pending restart',fail:false});assert.deepEqual(otherEvents,[]);
 await host.close();assert.equal(lease.signal.aborted,true);await node.app.close();
 restarted=await buildApp(config(root),{backgroundWorker:false,agent:inactive});const reloaded=await register(restarted);
 assert.deepEqual(reloaded.snapshot(),{revision:initial+4,value:{active:true,cold:7,display:'hot after pending restart',fail:false}});
 const read=await restarted.app.inject({url:'/api/configuration',headers:{authorization:'Bearer '+token}});assert.equal(read.statusCode,200,read.body);assert.equal(read.json().domains.find((domain:any)=>domain.id==='plugin.paths').effective.cold,7);
});

async function platformFixture(t:import('node:test').TestContext){
 const {createConfigurationPlatform}=await import('../src/plugins/configuration-platform.js'),root=await mkdtemp(join(tmpdir(),'mote-config-input-paths-')),path=join(root,'mote.yaml'),platform=createConfigurationPlatform({path,initialDocument:{version:1,revision:0,server:{token}},watch:false});
 t.after(async()=>{await platform.close();await rm(root,{recursive:true,force:true});});await platform.prepare();return {platform,path};
}

test('registered branch paths use the raw candidate and never merge another union arm into its accepted inputs',async t=>{
 const {platform,path}=await platformFixture(t);let parsed=0;
 const schema=z.preprocess(input=>{parsed++;return input;},z.discriminatedUnion('kind',[
  z.object({kind:z.literal('local'),folder:z.object({label:z.string()})}),
  z.object({kind:z.literal('remote'),endpoint:z.string().url()}),
 ]).transform(value=>value.kind==='local'?{label:value.folder.label}:{label:value.endpoint}));
 const domain=await platform.registerDomain({id:'branchPaths',schema,defaultValue:{kind:'local',folder:{label:'initial'}},updatePaths:input=>{
  const kind=(input as {kind?:unknown})?.kind;return kind==='local'?['kind','folder.label']:kind==='remote'?['kind','endpoint']:[];
 }});
 await domain.update({folder:{label:'updated'}},0);const before=await readFile(path),count=parsed;
 for(const patch of [{endpoint:'https://generated.invalid'},{folder:{label:'valid',typo:true}},{kind:'missing'}]){
  await assert.rejects(domain.update(patch as never,1),{code:'config_invalid'});assert.equal(parsed,count);assert.deepEqual(await readFile(path),before);
 }
 // Complete replacement is the existing operation for removing old-branch keys.
 await platform.configService.replace('plugin.branchPaths',{kind:'remote',endpoint:'https://generated.invalid'},1);
 assert.deepEqual(domain.snapshot(),{revision:2,value:{label:'https://generated.invalid'}});assert.deepEqual(parse(await readFile(path,'utf8')).plugins.configuration.branchPaths,{kind:'remote',endpoint:'https://generated.invalid'});
 const remote=await readFile(path),after=parsed;await assert.rejects(domain.update({folder:{label:'other arm'}} as never,2),{code:'config_invalid'});assert.equal(parsed,after);assert.deepEqual(await readFile(path),remote);
 await assert.rejects(domain.update({endpoint:'not a URL'},2),{code:'config_invalid'});assert.deepEqual(await readFile(path),remote,'path membership never substitutes for the actual value schema');
});

test('explicit wildcard paths retain arrays, records, tuples and pipeline validation while unknown nested members never parse',async t=>{
 const {platform,path}=await platformFixture(t);let parsed=0;
 const rows=z.array(z.object({name:z.string(),enabled:z.boolean()})),byId=z.record(z.object({limit:z.number().int().min(1)})),pair=z.tuple([z.string(),z.object({count:z.number().int()})]),options=z.record(z.unknown());
 const schema=z.preprocess(input=>{parsed++;return input;},z.intersection(z.object({rows,byId,pair,options}),z.object({label:z.string()})).pipe(z.object({rows,byId,pair,options,label:z.string()}).transform(value=>({...value,active:value.rows.filter(row=>row.enabled).length}))));
 const paths=['rows.*.name','rows.*.enabled','byId.*.limit','pair.0','pair.1.count','label','options.*'];
 const domain=await platform.registerDomain({id:'collectionPaths',schema,updatePaths:paths,defaultValue:{rows:[],byId:{},pair:['first',{count:0}],label:'initial',options:{}}});
 paths.push('typo');
 await domain.update({rows:[{name:'row',enabled:true}],byId:{'key.with.dots':{limit:2}},pair:['second',{count:3}],options:{arbitrary:{nested:[1,{value:true}]}}},0);
 assert.equal(domain.snapshot().value.active,1);const raw=parse(await readFile(path,'utf8')).plugins.configuration.collectionPaths;assert.equal('active' in raw,false);assert.equal(raw.byId['key.with.dots'].limit,2);
 const before=await readFile(path),count=parsed;
 for(const patch of [{typo:true},{rows:[{name:'row',enabled:true,typo:true}]},{byId:{'key.with.dots':{limit:3,typo:true}}},{pair:['x',{count:1,typo:true}]}]){
  await assert.rejects(domain.update(patch as never,1),{code:'config_invalid'});assert.equal(parsed,count);assert.deepEqual(await readFile(path),before);
 }
 const array=Object.assign([{name:'row',enabled:true}],{hidden:{name:'not an array index',enabled:true}});await assert.rejects(domain.update({rows:array},1),{code:'config_invalid'});assert.equal(parsed,count);
 const notAnIndex=Object.assign([{name:'row',enabled:true}],{'4294967295':{name:'outside array indices',enabled:true}});await assert.rejects(domain.update({rows:notAnIndex},1),{code:'config_invalid'});assert.equal(parsed,count);
 await assert.rejects(domain.update({byId:{value:{limit:0}}},1),{code:'config_invalid'});assert.deepEqual(await readFile(path),before);
});

test('unknown paths in any registered domain fence an entire edit or file reload before other preprocessors run',async t=>{
 const {platform,path}=await platformFixture(t);let first=0,second=0;
 const a=await platform.registerDomain({id:'firstPaths',schema:z.preprocess(input=>{first++;return input;},z.object({enabled:z.boolean()})),updatePaths:['enabled'],defaultValue:{enabled:false}});
 await platform.registerDomain({id:'secondPaths',schema:z.preprocess(input=>{second++;return input;},z.object({enabled:z.boolean()})),updatePaths:['enabled'],defaultValue:{enabled:false}});
 await a.update({enabled:true},0);const before=await readFile(path,'utf8'),counts={first,second};
 await assert.rejects(platform.configService.updateMany({'plugin.firstPaths':{enabled:false},'plugin.secondPaths':{typo:true}},1),{code:'config_invalid'});assert.deepEqual({first,second},counts);assert.equal(await readFile(path,'utf8'),before);
 const {stringify}=await import('yaml'),{writeFile}=await import('node:fs/promises'),raw=parse(before);raw.plugins.configuration.firstPaths.enabled=false;raw.plugins.configuration.secondPaths.typo=true;const changed=stringify(raw);await writeFile(path,changed);
 await assert.rejects(platform.configService.reload(),{code:'config_invalid'});assert.deepEqual({first,second},counts);assert.equal(a.snapshot().value.enabled,true);assert.equal(await readFile(path,'utf8'),changed,'rejected owner file input is preserved');
});

test('missing and malformed registered path declarations fail before preparing or parsing any default',async t=>{
 const {platform,path}=await platformFixture(t);let parsed=0,prepared=0;
 const schema=z.preprocess(input=>{parsed++;return input;},z.object({enabled:z.boolean()})),before=await readFile(path);
 for(const [index,updatePaths]of [undefined,[''],['enabled..hidden'],['__proto__.enabled'],()=>['constructor'],()=>null].entries()){
  await assert.rejects(platform.registerDomain({id:'badPaths'+index,schema,updatePaths,defaultValue:{enabled:false},prepare(){prepared++;return {apply(){}};}} as never),{code:'config_invalid'});
  assert.equal(parsed,0);assert.equal(prepared,0);assert.deepEqual(await readFile(path),before);
 }
});
