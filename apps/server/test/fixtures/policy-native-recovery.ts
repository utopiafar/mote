// Opt-in generated-data acceptance. Uses the compiled runtime and existing local
// images. Only this run's labelled volumes/containers are stopped or removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {buildApp} from '../../dist/app.js';
import {defaultModelSettings} from '../../dist/model-settings.js';
import {EXECUTION_POLICIES} from '../../dist/execution-policy.js';
import {ManagedHindsightRuntime,hindsightModelFingerprint,hindsightDigest} from '../../dist/hindsight-runtime.js';
import {HindsightEngine} from '../../dist/hindsight-engine.js';
import {memoryBodyDigest,memoryProviderRecordSchema} from '../../dist/memory-provider-contract.js';
import {generatedHindsightRelease} from './scoped-memory-release.js';
import {backupScopedInstance,restoreScopedInstance} from '../../../../scripts/scoped-backup.mjs';
import {initialize,profilePaths,loadProfile,restoreProfile,backupProfile,dockerConfigurationUser} from '../../../../scripts/profile-lib.mjs';
import {HINDSIGHT_BACKUP_IMAGE} from '../../../../scripts/hindsight-backup.mjs';

const image=process.env.MOTE_CONTAINER_VALIDATION_IMAGE;
const digest=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const password='Generated-policy-native-recovery-only',protocol={'x-mote-protocol-version':'2','x-mote-ingress-version':'3'};
const policy={version:1,services:[],profiles:[{id:'text',name:'Generated text',processorId:'text.utf8',parameters:{},diarizationProcessor:'audio.diarize',summarize:false},{id:'archive',name:'Generated original',processorId:'archive',parameters:{},diarizationProcessor:'audio.diarize',summarize:false}],rules:[{type:'text/*',profileId:'text'},{type:'*/*',profileId:'archive'}]};
function sql<T>(directory:string,work:(db:DatabaseSync)=>T){const db=new DatabaseSync(join(directory,'mote.sqlite'));try{db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');return work(db);}finally{db.close();}}
function plans(directory:string){return sql(directory,db=>Object.fromEntries(['mp_file_plans','mp_file_policy_bindings','mp_file_controls'].map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY user_id,'+(table==='mp_file_plans'?'id':'original_id')).all()])));}

test('compiled personal plans survive one native/Hindsight/Docker archive without restoring execution authority',{skip:!image,timeout:600000},async t=>{
 const runId='mote-policy-native-'+randomUUID(),root=realpathSync(mkdtempSync(join(tmpdir(),runId+'-'))),source=join(root,'source');
 const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:240000,maxBuffer:16*1024*1024,stdio:['ignore','pipe','pipe']}).trim();
 const central=new Set<string>(),volumes=new Map<string,string>(),nativeIds=new Set<string>(),managed:any[]=[];
 let app:any,helper=0,modelCalls=0,passed=false;
 const progress=(phase:string)=>writeFileSync('/tmp/mote-policy-archive-joint-progress.json',JSON.stringify({runId,phase,at:new Date().toISOString(),passed,central:[...central],nativeIds:[...nativeIds],volumes:[...volumes.keys()]}));
 const execute=async(command:string,args:string[])=>{assert.equal(command,'docker');return docker(args[0]==='run'?['run','--name',runId+'-helper-'+(++helper),'--label','dev.mote.fixture='+runId,...args.slice(1)]:args);};
 t.after(async()=>{
  await app?.app.close();for(const runtime of managed)await runtime.close();
  for(const name of central){const state=JSON.parse(docker(['inspect',name]))[0];assert.equal(state.Config.Labels['dev.mote.fixture'],runId);if(state.State.Running)docker(['stop','--time','20',name]);docker(['rm',name]);}
  for(const id of nativeIds){const name='mote-hindsight-'+id;const found=docker(['ps','--all','--filter','name=^'+name+'$','--format','{{.Names}}']);if(found){const state=JSON.parse(docker(['inspect',name]))[0];assert.equal(state.Config.Labels['mote.runtime.identity'],id);assert.ok(state.Mounts.some((m:any)=>m.Name===name+'-data'));if(state.State.Running)docker(['stop','--time','30',name]);docker(['rm',name]);}}
  for(const [volume,owner] of volumes){const state=JSON.parse(docker(['volume','inspect',volume]))[0];assert.ok(state.Labels?.['dev.mote.fixture']===runId||state.Labels?.['dev.mote.profile']===owner||state.Labels?.['mote.runtime.identity']===owner);docker(['volume','rm',volume]);}
  rmSync(root,{recursive:true,force:true});progress('cleaned');
 });
 const imageId=docker(['image','inspect',image!,'--format','{{.Id}}']);assert.equal(docker(['image','inspect',image!,'--format','{{index .Config.Labels "dev.mote.runtime-source"}}']),'2699d1f7eeeb12390c2b87229c11c32dc731d9ee');
 docker(['image','inspect',HINDSIGHT_BACKUP_IMAGE]); // No image pull or installation.
 const release=generatedHindsightRelease();
 app=await buildApp({dataDir:source},{pluginReleaseTransport:release.transport});
 const request=async(token:string|undefined,url:string,method='GET',payload?:unknown)=>{const r=await app.app.inject({url,method,headers:{...protocol,...(token?{authorization:'Bearer '+token}:{})},...(payload===undefined?{}:{payload})});return {status:r.statusCode,json:r.json()};};
 const checked=async(...args:Parameters<typeof request>)=>{const r=await request(...args);assert.equal(r.status,200,JSON.stringify(r.json));return r.json;};
 const login=(name:string)=>checked(undefined,'/api/auth/login','POST',{username:name,password,mode:'client'});
 await app.accounts.initialize('generated-admin',password);let admin=await login('generated-admin');
 const users:any[]=[];for(const label of ['a','b']){const user=await checked(admin.token,'/api/admin/accounts','POST',{username:'generated-'+label,password});users.push({...user,...await login('generated-'+label)});}
 const change=async(token:string,domain:string,value:any)=>checked(token,'/api/configuration/'+domain,'PUT',{revision:(await checked(token,'/api/configuration')).revision,value});
 const wait=async(work:()=>Promise<boolean>|boolean,message:string)=>{const end=Date.now()+20000;while(!await work()){assert.ok(Date.now()<end,message);await delay(10);}};
 const files:any[]=[];for(const [index,user] of users.entries()){
  const view=await checked(user.token,'/api/file-processing');await checked(user.token,'/api/file-processing','PUT',{revision:view.revision,settings:{...view.settings,automatic:true,understandingEnabled:false},policy});
  await checked(user.token,'/api/ingress/sources','POST',{id:'same-source',name:'Generated source',kind:'local-files',deviceId:'same-device',platform:'import',retention:'archive'});
  const bytes=Buffer.from('GENERATED_COMPILED_PLAN_'+index),hash=digest(bytes.toString()),opened=await checked(user.token,'/api/ingress/sources/same-source/uploads','POST',{batchId:'same-batch',revision:{sourceId:'same-source',item:{externalId:'same-file',revision:'same-revision',observedAt:'2026-01-01T00:00:00Z',title:'Generated text',text:'',kind:'file',layer:'original',mimeType:'text/plain'},sizeBytes:bytes.length,sha256:hash,relativePath:'generated.txt'}});
  await checked(user.token,'/api/ingress/uploads/'+opened.id+'/parts/0','PUT',{bytes:bytes.toString('base64'),checksum:hash});const receipt=await checked(user.token,'/api/ingress/uploads/'+opened.id+'/commit','POST',{});files.push(receipt.captures[0]);await wait(async()=>(await checked(user.token,'/api/files/'+receipt.captures[0].id)).processing.indexed,'Generated text did not finish');
 }
 assert.equal(files[0].id,files[1].id);const deploymentId=app.deploymentId;
 app.execution.register({kind:'generated.policy-native-unknown',pool:'generated-policy-native',concurrency:()=>1,policy:EXECUTION_POLICIES.deterministic,parseInput:(v:any)=>v,portableInput:(v:any)=>v,execute:async(run:any)=>{run.external.begin('generated-unacknowledged-write');return null;}});
 const unknownTask=(await checked(users[0].token,'/api/tasks','POST',{kind:'generated.policy-native-unknown',operationId:'generated-unknown',input:{generated:true}})).id;
 await wait(()=>sql(source,db=>!!db.prepare("SELECT task_id FROM user_tasks WHERE task_id=? AND external_state IN ('issued','unknown')").get(unknownTask)),'Generated external issuance missing');
 await app.app.close();app=undefined;
 const initial=join(root,'initial');await backupScopedInstance({source,out:initial});
 const makeProfile=async(name:string,archive:string)=>{const paths=profilePaths(name,join(root,'profiles'));await initialize(paths,{runtime:'docker',image});let p=await loadProfile(paths);docker(['volume','create','--label','dev.mote.fixture='+runId,p.meta.volume]);volumes.set(p.meta.volume,p.project);const restored=await restoreProfile(p,archive,{execute});assert.ok(restored.volume);volumes.set(restored.volume,p.project);p=await loadProfile(paths);const nativePaths=JSON.parse(readFileSync(join(archive,'backup-manifest.json'),'utf8')).native;if(nativePaths.length){const descriptors=JSON.parse(docker(['run','--rm','--pull','never','--network','none','--read-only','--mount','type=volume,source='+p.meta.volume+',target=/data,readonly','--entrypoint','node',image!,'-e',"const fs=require('node:fs');console.log(JSON.stringify("+JSON.stringify(nativePaths)+".map(p=>JSON.parse(fs.readFileSync('/data/'+p+'/runtime/runtime-descriptor.json','utf8')))));"]));for(const descriptor of descriptors){nativeIds.add(descriptor.identity);volumes.set('mote-hindsight-'+descriptor.identity+'-data',descriptor.identity);}}return p;};
 const startCentral=async(p:any,suffix:string)=>{const name=runId+'-'+suffix,user=await dockerConfigurationUser(p,execute);docker(['run','--pull','never','--detach','--name',name,'--label','dev.mote.fixture='+runId,'--network','none','--security-opt','no-new-privileges:true','--cap-drop','ALL','--user',user,'--mount','type=volume,source='+p.meta.volume+',target=/data','--mount','type=bind,source='+p.directory+',target=/config','--env','MOTE_CONFIG_FILE=/config/mote.yaml',image!]);central.add(name);docker(['exec',name,'node','-e',"(async()=>{for(let i=0;i<150;i++){try{if((await fetch('http://127.0.0.1:"+p.port+"/api/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,200));}process.exit(1);})();"]);return name;};
 const remote=(p:any,name:string,url:string,token?:string,method='GET',payload?:any)=>JSON.parse(docker(['exec',name,'node','-e',"(async()=>{const r=await fetch('http://127.0.0.1:"+p.port+"'+"
  +JSON.stringify(url)+",{method:"+JSON.stringify(method)+",headers:"+JSON.stringify({...protocol,...(payload===undefined?{}:{'content-type':'application/json'}),...(token?{authorization:'Bearer '+token}:{})})+",body:"+JSON.stringify(payload===undefined?undefined:JSON.stringify(payload))+"});console.log(JSON.stringify({status:r.status,json:await r.json()}));})().catch(e=>{console.error(e);process.exit(1)});"]));
 const ok=(p:any,name:string,url:string,token?:string,method='GET',payload?:any)=>{const r=remote(p,name,url,token,method,payload);assert.equal(r.status,200,JSON.stringify(r));return r.json;};
 const remoteLogin=(p:any,name:string,username:string)=>ok(p,name,'/api/auth/login',undefined,'POST',{username,password,mode:'client'});
 progress('compiled-personal-start');const p=await makeProfile('personal',initial),first=await startCentral(p,'personal');
 for(const user of users)assert.equal(remote(p,first,'/api/auth/self',user.token).status,401);
 const a=remoteLogin(p,first,'generated-a'),b=remoteLogin(p,first,'generated-b');
 const exportId=randomUUID();ok(p,first,'/api/portable/exports',a.token,'POST',{operationId:exportId});
 await wait(()=>ok(p,first,'/api/portable/exports/'+exportId,a.token).state==='completed','Compiled personal export did not finish');
 const saved=ok(p,first,'/api/portable/exports/'+exportId+'/content',a.token),planSection=saved.domains.find((d:any)=>d.domain==='processing').payload.policyPlans;
 assert.equal(planSection.plans.length,1);assert.equal(planSection.bindings.length,1);assert.ok(!JSON.stringify(planSection).includes(users[1].userId));
 const view=ok(p,first,'/api/file-processing',a.token),newPolicy={...policy,profiles:policy.profiles.map(profile=>({...profile,diarizationProcessor:'audio.diarize-wespeaker'}))};
 ok(p,first,'/api/file-processing',a.token,'PUT',{revision:view.revision,settings:view.settings,policy:newPolicy});
 const selected=ok(p,first,'/api/file-processing',a.token),preview=ok(p,first,'/api/file-processing/preview',a.token,'POST',{revision:selected.revision});ok(p,first,'/api/file-processing/reprocess',a.token,'POST',{token:preview.token});
 await wait(()=>ok(p,first,'/api/files/'+files[0].id,a.token).job?.state==='succeeded','Compiled current plan reprocess did not finish');
 const inspect=()=>JSON.parse(docker(['exec',first,'node','-e',"const d=new(require('node:sqlite').DatabaseSync)('/data/mote.sqlite');console.log(JSON.stringify({plans:d.prepare('SELECT * FROM mp_file_plans ORDER BY user_id,id').all(),bindings:d.prepare('SELECT * FROM mp_file_policy_bindings ORDER BY user_id,original_id').all(),controls:d.prepare('SELECT * FROM mp_file_controls ORDER BY user_id,original_id').all(),authority:d.prepare('SELECT task_id,user_id,grant_id,input FROM user_tasks ORDER BY task_id').all(),calls:d.prepare('SELECT * FROM task_external_calls ORDER BY issuance_id').all(),confirmations:d.prepare('SELECT * FROM task_external_retry_confirmations ORDER BY confirmation_id').all()}));"]));
 const current=inspect(),currentSettings=ok(p,first,'/api/file-processing',a.token);assert.ok(current.plans.length>2);
 const mergeId=randomUUID();ok(p,first,'/api/portable/imports',a.token,'POST',{operationId:mergeId,archive:saved});
 await wait(()=>ok(p,first,'/api/portable/imports/'+mergeId,a.token).state!=='working','Compiled personal merge did not finish');assert.equal(ok(p,first,'/api/portable/imports/'+mergeId,a.token).state,'completed');
 assert.deepEqual(inspect(),current);assert.deepEqual(ok(p,first,'/api/file-processing',a.token),currentSettings);
 // A second real merge reconstructs absent immutable history and gives it a
 // fresh control without changing B or replaying a surviving old task/grant.
 const removed=remote(p,first,'/api/captures/'+files[0].id,a.token,'DELETE');assert.equal(removed.status,200,JSON.stringify(removed));
 const missing=inspect();assert.ok(!missing.bindings.some((row:any)=>row.user_id===a.userId));
 const recoveryId=randomUUID();ok(p,first,'/api/portable/imports',a.token,'POST',{operationId:recoveryId,archive:saved});
 await wait(()=>ok(p,first,'/api/portable/imports/'+recoveryId,a.token).state!=='working','Compiled missing plan merge did not finish');assert.equal(ok(p,first,'/api/portable/imports/'+recoveryId,a.token).state,'completed');
 const recovered=inspect();assert.equal(recovered.bindings.find((row:any)=>row.user_id===a.userId).plan_id,planSection.bindings[0].plan_id);assert.ok(recovered.controls.find((row:any)=>row.user_id===a.userId).generation>0);assert.deepEqual(recovered.authority,missing.authority);assert.deepEqual(recovered.calls,missing.calls);assert.deepEqual(recovered.confirmations,missing.confirmations);
 assert.equal(ok(p,first,'/api/files/'+files[1].id,b.token).processing.indexed,true);
 docker(['stop','--time','20',first]);assert.equal(JSON.parse(docker(['inspect',first]))[0].State.ExitCode,0);
 progress('compiled-personal-passed');const personalReadback=join(root,'personal-readback'),combinedSource=join(root,'combined-source');await backupProfile(p,personalReadback,{execute});await restoreScopedInstance({from:personalReadback,target:combinedSource,deploymentId});
 // Historical native bodies are generated directly in actual migrated host/PG
 // schemas, as in the original Container native runner. No semantic retain,
 // inference, fake runtime, imported grant or capability-probe success is used.
 app=await buildApp({dataDir:combinedSource},{pluginReleaseTransport:release.transport});admin=await login('generated-admin');
 const resolved=await checked(admin.token,'/api/plugins/resolve','POST',{repository:release.repository,tag:release.tag}),catalog=await checked(admin.token,'/api/admin/plugins'),installed=await checked(admin.token,'/api/plugins/install','POST',{previewId:resolved.id,expectedRevision:catalog.revision,operationId:randomUUID()});
 const packageId=installed.packages.find((pkg:any)=>pkg.version===release.manifest.version).id;
 await wait(()=>app.plugins.catalog.view().packages.find((pkg:any)=>pkg.id===packageId)?.state==='installed','Generated native package not installed');
 const native:any[]=[];
 for(const [index,original] of users.entries()){
  const user=await login(index?'generated-b':'generated-a'),settings={...defaultModelSettings(),provider:'custom',protocol:'openai-completions',model:'generated-no-inference',baseUrl:'http://127.0.0.1:1/v1',apiKey:'GENERATED_NATIVE_FIXTURE_ONLY',allowUnauthenticatedLocal:true};
  await change(user.token,'models',{profiles:[{id:'native-history',name:'Generated native history',settings}],selections:{memory:{kind:'personal',id:'native-history'}}});
  let plugins=await checked(user.token,'/api/plugins');await checked(user.token,'/api/plugin-instances','POST',{expectedRevision:plugins.revision,instance:{id:'same-native-instance',packageId,name:'Generated native history',configuration:{modelProfileId:'personal:native-history'},desired:false,grants:{capabilities:['engine'],sourceIds:['same-source'],history:true}}});
  await checked(user.token,'/api/plugin-instances/same-native-instance/check','POST',{});plugins=await checked(user.token,'/api/plugins');await checked(user.token,'/api/plugin-instances/same-native-instance/enable','POST',{expectedRevision:plugins.revision});
  const context=await app.authority.authenticate(user.token),snapshot=await app.plugins.forUser(context).admit('same-native-instance','history',1),binding={kind:'plugin',revision:1,instanceId:'same-native-instance',snapshotId:snapshot.id};
  await app.memory.providers.provision(context,binding);
  const descriptor=await app.plugins.domainProvider(context,snapshot.id,['engine']),directory=join(descriptor.directory,'memory-'+digest(descriptor.namespace)),identity=digest(randomUUID()).slice(0,24);
  const record=memoryProviderRecordSchema.parse({namespace:descriptor.namespace,key:{memoryId:'01010101-0101-4101-8101-010101010101',version:1,fingerprint:digest('generated-native-'+index)},memory:{id:'01010101-0101-4101-8101-010101010101',version:1,fingerprint:digest('generated-native-'+index),domain:'personal',tier:'episode',kind:'episodic',admission:{layer:'memory',reason:'Generated native recovery',scope:'Generated owner '+index,attribution:'observed'},title:'Generated native '+index,statement:'GENERATED_NATIVE_OWNER_'+index,uncertainty:'Synthetic recovery only',evidenceIds:[files[index].id],evidence:[],createdAt:'2026-01-01T00:00:00Z',status:'published',model:'generated',runId:'generated-native-history'}});
  native.push({userId:original.userId,binding,settings,directory,path:relative(combinedSource,directory),identity,record,entry:{namespace:record.namespace,key:record.key,bank:'mote-canonical-'+digest([record.namespace,record.key]).slice(0,40),digest:digest(record),state:'applied'}});
 }
 await app.app.close();app=undefined;
 const nativeEnv=(token:string)=>({HINDSIGHT_ENABLE_CP:'false',HINDSIGHT_API_SKIP_LLM_VERIFICATION:'true',HINDSIGHT_API_LLM_PROVIDER:'openai',HINDSIGHT_API_LLM_MODEL:'generated-no-inference',HINDSIGHT_API_LLM_API_KEY:'generated-no-model',HINDSIGHT_API_LLM_BASE_URL:'http://127.0.0.1:1/v1',HINDSIGHT_API_WORKER_ENABLED:'false',HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION:'false',HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU:'true',HINDSIGHT_API_RERANKER_LOCAL_FORCE_CPU:'true',HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HINDSIGHT_API_TENANT_EXTENSION:'hindsight_api.extensions.builtin.tenant:ApiKeyTenantExtension',HINDSIGHT_API_TENANT_API_KEY:token});
 const nativeShell=(identity:string,token:string)=>{const name='mote-hindsight-'+identity,volume=name+'-data';nativeIds.add(identity);volumes.set(volume,identity);docker(['run','--pull','never','--detach','--name',name,'--label','mote.runtime.identity='+identity,'--label','dev.mote.fixture='+runId,'--network','none',...Object.entries(nativeEnv(token)).flatMap(([key,value])=>['--env',key+'='+value]),'--volume',volume+':/home/hindsight/.pg0',HINDSIGHT_BACKUP_IMAGE]);docker(['exec',name,'python3','-c',"import time,json,urllib.request\nfor i in range(150):\n try:\n  r=json.load(urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8888/health',headers={'Authorization':'Bearer "+token+"'}),timeout=1))\n  if r['status']=='healthy': break\n except Exception: pass\n time.sleep(1)\nelse: raise RuntimeError('Generated native API not healthy')"]);return name;};
 for(const item of native){
  progress('seed-native-'+item.userId);mkdirSync(join(item.directory,'runtime'),{recursive:true,mode:0o700});mkdirSync(join(item.directory,'provider'),{recursive:true,mode:0o700});
  const token=randomUUID()+randomUUID(),volume='mote-hindsight-'+item.identity+'-data';docker(['volume','create','--label','mote.runtime.identity='+item.identity,'--label','dev.mote.fixture='+runId,volume]);volumes.set(volume,item.identity);item.oldToken=token;
  writeFileSync(join(item.directory,'runtime/runtime-descriptor.json'),JSON.stringify({version:1,identity:item.identity,image:HINDSIGHT_BACKUP_IMAGE,modelFingerprint:hindsightModelFingerprint(item.settings),instanceFingerprint:hindsightDigest(item.binding.instanceId)}),{mode:0o600});
  writeFileSync(join(item.directory,'provider/provider-control.json'),JSON.stringify({version:1,entries:[item.entry],projections:[],prepared:[],operations:[{opId:'generated-native-unknown',kind:'put',inputDigest:'3'.repeat(64)}]}),{mode:0o600});
  const name=nativeShell(item.identity,token),python=["import asyncio,asyncpg,json,urllib.request","from hindsight_api.pg0 import EmbeddedPostgres","record=json.loads("+JSON.stringify(JSON.stringify(item.record))+");entry=json.loads("+JSON.stringify(JSON.stringify(item.entry))+")","async def main():"," pg=EmbeddedPostgres();conn=await asyncpg.connect(await pg.get_uri())"," try:","  req=urllib.request.Request('http://127.0.0.1:8888/v1/default/banks/'+entry['bank'],data=json.dumps({'name':'Generated recovery'}).encode(),headers={'Authorization':'Bearer "+token+"','Content-Type':'application/json'},method='PUT');urllib.request.urlopen(req).read()","  metadata={'mote_record':json.dumps(record,separators=(',',':'),ensure_ascii=False),'mote_digest':entry['digest']}","  await conn.execute('INSERT INTO public.memory_units(bank_id,text,metadata) VALUES($1,$2,$3::jsonb)',entry['bank'],record['memory']['statement'],json.dumps(metadata))"," finally: await conn.close()","asyncio.run(main())"].join('\n');
  docker(['exec',name,'python3','-c',python]);docker(['stop','--time','30',name]);assert.equal(JSON.parse(docker(['inspect',name]))[0].State.ExitCode,0);
  sql(combinedSource,db=>{const m=item.record.memory,body=memoryBodyDigest(m),binding=JSON.stringify(item.binding);db.prepare('INSERT INTO mm_records VALUES(?,?,?,?,?,?,?,?)').run(item.userId,m.id,m.version,m.fingerprint,body,binding,JSON.stringify(m),m.createdAt);db.prepare('INSERT INTO mm_versions VALUES(?,?,?,?,?)').run(item.userId,m.id,m.version,m.fingerprint,JSON.stringify(m));db.prepare('INSERT INTO mm_version_bindings VALUES(?,?,?,?,?)').run(item.userId,m.id,m.version,binding,body);});
 }
 const expectedPlans=plans(combinedSource),unknownBefore=sql(combinedSource,db=>db.prepare('SELECT task_id,external_state,external_key,external_issuance FROM user_tasks WHERE task_id=?').get(unknownTask));
 progress('combined-snapshot');const combined=join(root,'combined');await backupScopedInstance({source:combinedSource,out:combined});const manifest=JSON.parse(readFileSync(join(combined,'backup-manifest.json'),'utf8'));assert.equal(manifest.native.length,2);
 const verifyNative=async(directory:string)=>{for(const item of native){const descriptor=JSON.parse(readFileSync(join(directory,item.path,'runtime/runtime-descriptor.json'),'utf8'));nativeIds.add(descriptor.identity);volumes.set('mote-hindsight-'+descriptor.identity+'-data',descriptor.identity);}for(const item of native){const base=join(directory,item.path),descriptor=JSON.parse(readFileSync(join(base,'runtime/runtime-descriptor.json'),'utf8'));assert.notEqual(descriptor.identity,item.identity);assert.equal(existsSync(join(base,'runtime/runtime-credentials.json')),false);const token=randomUUID()+randomUUID(),name=nativeShell(descriptor.identity,token);docker(['stop','--time','30',name]);const runtime=new ManagedHindsightRuntime({directory:join(base,'runtime'),instanceId:item.binding.instanceId,settings:item.settings,assertModelAuthority:()=>{modelCalls++;throw Error('Recovery prohibits model calls');}});managed.push(runtime);const service=await runtime.service();assert.equal((await fetch(service.baseUrl+'/v1/default/banks',{headers:{Authorization:'Bearer '+item.oldToken}})).status,401);const engine=new HindsightEngine({directory:join(base,'provider'),runtime});assert.deepEqual(await engine.read({namespace:item.record.namespace,key:item.record.key}),item.record.memory);assert.equal(await engine.read({namespace:{...item.record.namespace,ownerId:item.userId===users[0].userId?users[1].userId:users[0].userId},key:item.record.key}),null);const control=JSON.parse(readFileSync(join(base,'provider/provider-control.json'),'utf8'));assert.ok(control.operations.some((op:any)=>op.opId==='generated-native-unknown'&&!op.receipt));await engine.close();assert.equal(JSON.parse(docker(['inspect',name]))[0].State.ExitCode,0);}};
 progress('native-combined-restore');const nativeTarget=join(root,'native-restored');await restoreScopedInstance({from:combined,target:nativeTarget,deploymentId});await verifyNative(nativeTarget);assert.deepEqual(plans(nativeTarget),expectedPlans);
 progress('docker-combined-restore');const jointProfile=await makeProfile('joint',combined),joint=await startCentral(jointProfile,'joint');
 for(const original of [a,b,...users])assert.equal(remote(jointProfile,joint,'/api/auth/self',original.token).status,401);
 for(const [index,user] of users.entries()){const fresh=remoteLogin(jointProfile,joint,index?'generated-b':'generated-a');assert.equal(fresh.userId,user.userId);const file=ok(jointProfile,joint,'/api/files/'+files[index].id,fresh.token);assert.equal(file.processing.indexed,true);assert.equal(ok(jointProfile,joint,'/api/file-processing',fresh.token).settings.automatic,false);}
 docker(['stop','--time','20',joint]);assert.equal(JSON.parse(docker(['inspect',joint]))[0].State.ExitCode,0);
 // Read the fresh native descriptors from only this restored owned volume,
 // creating no service; then verify the real combined stopped readback.
 const descriptors=JSON.parse(docker(['run','--rm','--pull','never','--network','none','--read-only','--mount','type=volume,source='+jointProfile.meta.volume+',target=/data,readonly','--entrypoint','node',image!,'-e',"const fs=require('node:fs');console.log(JSON.stringify("+JSON.stringify(native.map(item=>item.path))+".map(p=>JSON.parse(fs.readFileSync('/data/'+p+'/runtime/runtime-descriptor.json','utf8')))));"]));
 for(const descriptor of descriptors){nativeIds.add(descriptor.identity);volumes.set('mote-hindsight-'+descriptor.identity+'-data',descriptor.identity);}
 const final=join(root,'joint-readback');await backupProfile(jointProfile,final,{execute});assert.deepEqual(plans(final),expectedPlans);assert.deepEqual(sql(final,db=>db.prepare('SELECT task_id,external_state,external_key,external_issuance FROM user_tasks WHERE task_id=?').get(unknownTask)),unknownBefore);sql(final,db=>{assert.equal(db.prepare('SELECT count(*) n FROM task_authorizations WHERE revoked=0').get()!.n,0);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);});
 // The Docker readback is an archive. Reopen its native storage through the
 // same native restore API, never by adopting an old descriptor/credential.
 progress('docker-combined-native-readback');const finalTarget=join(root,'joint-readback-restored');await restoreScopedInstance({from:final,target:finalTarget,deploymentId});await verifyNative(finalTarget);assert.deepEqual(plans(finalTarget),expectedPlans);assert.equal(modelCalls,0);
 passed=true;progress('passed');console.log(JSON.stringify({result:'PASS',runId,image,imageId,runtimeCandidate:'2699d1f7eeeb12390c2b87229c11c32dc731d9ee',sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runnerSha256:digest(readFileSync(new URL(import.meta.url),'utf8')),compiledPersonalExport:true,compiledCurrentBindingAndControlsWin:true,compiledMissingPlanRestore:true,nativeProvidersInOneArchive:manifest.native.length,nativeAndDockerStoppedRoundtrip:true,managedCanonicalReads:4,ownersIsolated:true,unknownFactsPreserved:true,oldGrantsRevived:0,oldTokensRejected:true,externalModelCalls:modelCalls,syntheticOnly:true}));
});
