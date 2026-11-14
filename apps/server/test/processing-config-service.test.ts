import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {parse,stringify} from 'yaml';
import {z} from 'zod';
import {ConfigService} from '../src/config-service.js';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {FileProcessing} from '../src/file-processing.js';
import {ImageProcessing} from '../src/image-processing.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {workflowConfigurationSchema,defaultWorkflowConfiguration} from '../src/workflow-configuration.js';
import {processingConfigurationSchema,defaultProcessingConfiguration} from '../src/processing-configuration.js';
import {perceptionConfigurationSchema,defaultPerceptionConfiguration} from '../src/perception-configuration.js';

async function fixture(t:any){
  const directory=await mkdtemp(join(tmpdir(),'mote-processing-config-')),path=join(directory,'mote.yaml'),store=new Store(directory);
  const stale='generated legacy configuration is deliberately unreadable';
  await writeFile(join(directory,'file-processing.json'),stale);
  store.db.prepare("INSERT INTO settings VALUES('perception',?)").run(JSON.stringify({enabled:false}));
  store.db.prepare("INSERT INTO settings VALUES('processing-policy',?)").run(JSON.stringify({extract:{enabled:false,concurrency:8}}));
  const service=new ConfigService({path,watch:false,initialDocument:{version:1,revision:0,processing:defaultProcessingConfiguration(),perception:defaultPerceptionConfiguration(),workflows:defaultWorkflowConfiguration()}});
  service.register({id:'processing',schema:processingConfigurationSchema,defaultValue:defaultProcessingConfiguration(),fields:[{path:'settings.apiKey',sensitive:true},{path:'settings.localWorkerApiKey',sensitive:true},{path:'policy.services.*.apiKey',sensitive:true}]});
  service.register({id:'perception',schema:perceptionConfigurationSchema,defaultValue:defaultPerceptionConfiguration()});
  service.register({id:'workflows',schema:workflowConfigurationSchema,defaultValue:defaultWorkflowConfiguration()});
  service.register({id:'plugins',schema:z.object({configuration:z.record(z.unknown())}),defaultValue:{configuration:{}}});
  await service.initialize();
  new ArchivedFileStore(store);
  const engine=new ExecutionEngine(store),files=new FileStore(store,new SourceStore(store)),processing=new FileProcessing(files,undefined,undefined,{configService:service,executor:engine});
  await processing.runtime.ready;
  const images=new ImageProcessing(store,processing,engine,{configService:service});
  const workflows=new ProcessingRuntime(store,[],{},Date.now,engine,undefined,undefined,service);await workflows.ready;
  t.after(async()=>{await service.close();await images.close();await processing.close();await workflows.close();await engine.close();store.close();await rm(directory,{recursive:true,force:true});});
  return {directory,path,store,service,processing,images,workflows,stale};
}

test('processing and image settings share file authority, one revision and atomic coupled saves',async t=>{
  const f=await fixture(t);assert.equal(f.images.settings().enabled,true);
  const view=f.processing.view(),policy=structuredClone(view.policy);policy.services.find(s=>s.id==='asr-local')!.apiKey='generated-service-secret';
  await f.processing.save({revision:view.revision,settings:view.settings,policy});
  assert.equal(f.service.revision,1);assert.ok(!JSON.stringify(f.service.view()).includes('generated-service-secret'));
  const imageView=f.images.view();
  await f.images.save({revision:imageView.revision,settings:{...imageView.settings,enabled:false,ocrEndpoint:'http://127.0.0.1:19210/ocr'}});
  assert.equal(f.service.revision,2);assert.equal(f.images.settings().enabled,false);assert.equal(f.images.settings().ocrEndpoint,'http://127.0.0.1:19210/ocr');
  const disk=parse(await readFile(f.path,'utf8'));
  assert.equal(disk.perception.enabled,false);assert.equal(disk.processing.policy.services.find((s:any)=>s.id==='central-image-ocr').endpoint,'http://127.0.0.1:19210/ocr');
  assert.equal(await readFile(join(f.directory,'file-processing.json'),'utf8'),f.stale);
  assert.equal(JSON.parse(String(f.store.db.prepare("SELECT value FROM settings WHERE key='perception'").get()!.value)).enabled,false);
  assert.equal(JSON.parse(String(f.store.db.prepare("SELECT value FROM settings WHERE key='perception-effective'").get()!.value)).enabled,false);
  await assert.rejects(f.images.save({revision:1,settings:imageView.settings}),{code:'config_conflict'});
});

test('external file changes use plugin validation and invalid policy retains the effective configuration',async t=>{
  const f=await fixture(t),document=parse(await readFile(f.path,'utf8'));
  document.processing.settings.maxAudioMinutes=45;document.perception.concurrency=3;
  await writeFile(f.path,stringify(document));await f.service.reload();
  assert.equal(f.processing.currentSettings().maxAudioMinutes,45);assert.equal(f.images.settings().concurrency,3);assert.equal(f.service.revision,1);
  const invalid=parse(await readFile(f.path,'utf8'));invalid.processing.policy.profiles[0].parameters.unregistered=7;
  await writeFile(f.path,stringify(invalid));await assert.rejects(f.service.reload(),{code:'config_prepare_failed'});
  assert.equal(f.processing.currentSettings().maxAudioMinutes,45);assert.equal(f.service.revision,1);assert.equal(f.service.view().lastError?.domain,'processing');
});

test('unrelated domain revisions permit a fresh processing preview and retain its existing semantic token',async t=>{
  const f=await fixture(t),first=f.processing.preview({revision:f.processing.view().revision,scope:{kind:'all'}});
  await f.service.update('perception',{concurrency:2},f.service.revision);
  const fresh=f.processing.preview({revision:f.processing.view().revision,scope:{kind:'all'}});
  assert.equal(fresh.revision,String(f.service.revision));assert.equal(fresh.count,0);
  assert.deepEqual(f.processing.reprocess({token:first.token}),{queued:0});
});

test('masked processing saves preserve credentials, while explicit clearing replaces the complete private candidate',async t=>{
  const f=await fixture(t),view=f.processing.view(),policy=structuredClone(view.policy);policy.services[0].apiKey='generated-private-service-key';
  await f.processing.save({revision:view.revision,settings:{...view.settings,apiKey:'generated-setting-key',localWorkerApiKey:'generated-local-key'},policy});
  const masked=f.processing.view();await f.processing.save({revision:masked.revision,settings:masked.settings,policy:masked.policy});
  assert.equal(f.processing.configurationSnapshot().settings.apiKey,'generated-setting-key');
  assert.equal(f.processing.configurationSnapshot().policy.services[0].apiKey,'generated-private-service-key');
  const current=f.processing.view(),cleared=structuredClone(current.policy) as any;cleared.services[0].apiKey=null;
  await f.processing.save({revision:current.revision,settings:{...current.settings,apiKey:null,localWorkerApiKey:''},policy:cleared});
  const effective=f.service.current<any>('processing');assert.equal(effective.settings.apiKey,undefined);assert.equal(effective.settings.localWorkerApiKey,undefined);assert.equal(effective.policy.services[0].apiKey,undefined);
  assert.deepEqual(f.processing.configurationSnapshot(),effective);
});

test('private YAML credential deletion does not inherit an old secret or add registry parameter defaults',async t=>{
  const f=await fixture(t),view=f.processing.view(),policy=structuredClone(view.policy);policy.services[0].apiKey='generated-to-remove';
  await f.processing.save({revision:view.revision,settings:view.settings,policy});
  const document=parse(await readFile(f.path,'utf8'));delete document.processing.policy.services[0].apiKey;
  for(const profile of document.processing.policy.profiles)profile.parameters={};
  await writeFile(f.path,stringify(document));await f.service.reload();
  const effective=f.service.current<any>('processing');assert.equal(f.processing.imageConfiguration('', 'image/png').settings.apiKey,undefined);
  assert.deepEqual(f.processing.configurationSnapshot(),effective);assert.ok(effective.policy.profiles.every((profile:any)=>Object.keys(profile.parameters).length===0));
});

test('deleting a private YAML service credential revokes a held image request before a late result can publish',async t=>{
  const f=await fixture(t),view=f.processing.view(),policy=structuredClone(view.policy);policy.services[0].apiKey='generated-issued-key';
  await f.processing.save({revision:view.revision,settings:view.settings,policy});await f.images.save({revision:f.service.revision,settings:{...f.images.settings(),understandingEnabled:false}});
  let begin!:()=>void,release!:(value:unknown)=>void,requestSignal!:AbortSignal;const begun=new Promise<void>(resolve=>begin=resolve),held=new Promise<any>(resolve=>release=resolve);
  f.processing.runtime.registry.get('image.http').process=async input=>{assert.equal(input.settings.apiKey,'generated-issued-key');requestSignal=input.signal;begin();return held;};
  const image=await sharp({create:{width:16,height:16,channels:3,background:'#aabbcc'}}).png().toBuffer(),id=randomUUID();
  await f.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'macos',capturedAt:'2026-10-14T00:00:00Z',durationMs:0,source:'screen',appId:'generated',appName:'Generated',ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:image.toString('base64')});
  const running=f.images.tick();await begun;const document=parse(await readFile(f.path,'utf8'));delete document.processing.policy.services[0].apiKey;
  await writeFile(f.path,stringify(document));await f.service.reload();assert.equal(requestSignal.aborted,true);assert.equal(f.processing.imageConfiguration('', 'image/png').settings.apiKey,undefined);
  release({durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated obsolete credential result'}]});await running;
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_products WHERE capture_id=?').get(id)!.n,0);
});

test('failed cross-domain apply rolls image permission back without cancelling an already authorized OCR job',async t=>{
  const f=await fixture(t);await f.images.save({revision:f.service.revision,settings:{...f.images.settings(),understandingEnabled:false}});
  let begin!:()=>void,release!:(value:unknown)=>void;const begun=new Promise<void>(resolve=>begin=resolve),held=new Promise<any>(resolve=>release=resolve);
  f.processing.runtime.registry.get('image.http').process=async()=>{begin();return held;};
  const image=await sharp({create:{width:16,height:16,channels:3,background:'#aabbcc'}}).png().toBuffer(),id=randomUUID();
  await f.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'macos',capturedAt:'2026-10-14T00:00:00Z',durationMs:0,source:'screen',appId:'generated',appName:'Generated',ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:image.toString('base64')});
  const running=f.images.tick();await begun;
  f.service.setHandler('workflows',()=>({apply(){throw Error('generated later apply failure');},rollback(){}}));
  await assert.rejects(f.service.updateMany({perception:{enabled:false},workflows:{extract:{concurrency:2}}},f.service.revision),{code:'config_apply_failed'});
  assert.equal(f.images.settings().enabled,true);assert.equal(f.store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(id)!.state,'running');
  release({durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated authorized result'}]});await running;
  assert.equal(f.store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(id)!.state,'succeeded');
});

test('async failing plugin application cannot expose speculative file, image or workflow permissions',async t=>{
  const f=await fixture(t),policy=structuredClone(f.processing.view().policy);
  const ocr=policy.services.find(service=>service.id==='central-image-ocr')!;ocr.endpoint='https://generated.example.invalid/ocr';ocr.execution='remote';
  await f.processing.save({revision:f.processing.view().revision,settings:{...f.processing.view().settings,enabled:false},policy});
  await f.images.save({revision:f.service.revision,settings:{...f.images.settings(),understandingEnabled:false,allowExternalProcessing:false}});
  await f.workflows.save({revision:f.service.revision,settings:{...f.workflows.settings(),extract:{concurrency:1,enabled:false}}});
  let enter!:()=>void,finish!:()=>void;const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>finish=resolve);
  await f.service.registerPlugin({id:'fault',schema:z.object({n:z.number()}),defaultValue:{n:0},prepare(next){return {async apply(){if(!next.n)return;enter();await gate;throw Error('generated asynchronous apply failure');},rollback(){}};}});
  let imageCalls=0,workflowCalls=0;
  f.processing.runtime.registry.get('image.http').process=async()=>{imageCalls++;return {durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated image result'}]};};
  f.workflows.registry.register({id:'generated.speculative',version:'1',lane:'extract',async process(){workflowCalls++;return [{kind:'text',text:'Generated workflow result',metadata:{}}];}});
  const image=await sharp({create:{width:16,height:16,channels:3,background:'#aabbcc'}}).png().toBuffer(),id=randomUUID();
  await f.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'macos',capturedAt:'2026-10-14T00:00:00Z',durationMs:0,source:'screen',appId:'generated',appName:'Generated',ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:image.toString('base64')});
  f.workflows.enqueue([{name:'one',processor:'generated.speculative',inputs:[id]}]);
  const pending=f.service.updateMany({processing:{settings:{enabled:true}},perception:{allowExternalProcessing:true},workflows:{extract:{enabled:true}},'plugin.fault':{n:1}},f.service.revision);
  const rejected=assert.rejects(pending,{code:'config_apply_failed'});await entered;
  try{
    assert.equal(f.service.current<any>('processing').settings.enabled,false);assert.equal(f.processing.currentSettings().enabled,false);
    assert.equal(f.service.current<any>('perception').allowExternalProcessing,false);assert.equal(f.images.settings().allowExternalProcessing,false);
    assert.equal(JSON.parse(String(f.store.db.prepare("SELECT value FROM settings WHERE key='perception-effective'").get()!.value)).allowExternalProcessing,false);
    assert.equal(f.service.current<any>('workflows').extract.enabled,false);assert.equal(f.workflows.settings().extract.enabled,false);
    await f.images.tick();await f.workflows.tick();
  }finally{finish();}
  await rejected;assert.equal(imageCalls,0);assert.equal(workflowCalls,0);
  assert.equal(f.processing.currentSettings().enabled,false);assert.equal(f.images.settings().allowExternalProcessing,false);assert.equal(f.workflows.settings().extract.enabled,false);
});

test('workflow file authority ignores SQLite overrides and lowering concurrency preserves in-flight work',async t=>{
  const f=await fixture(t);assert.equal(f.workflows.settings().extract.enabled,true);assert.equal(f.workflows.settings().extract.concurrency,1);
  await f.workflows.save({revision:f.service.revision,settings:{...f.workflows.settings(),extract:{concurrency:2,enabled:true}}});
  assert.equal(parse(await readFile(f.path,'utf8')).workflows.extract.concurrency,2);
  await assert.rejects(f.workflows.save({revision:0,settings:f.workflows.settings()}),{code:'config_conflict'});
  let begin!:()=>void,release!:()=>void;const begun=new Promise<void>(resolve=>begin=resolve),held=new Promise<void>(resolve=>release=resolve);
  f.workflows.registry.register({id:'generated.policy',version:'1',lane:'extract',async process(){begin();await held;return [{kind:'text',text:'Generated workflow output',metadata:{}}];}});
  const id=randomUUID();await f.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'macos',capturedAt:'2026-10-14T00:00:00Z',durationMs:0,source:'screen',appId:'generated',appName:'Generated',ocrText:'Generated workflow evidence',privacy:{excluded:false,redacted:false,mode:'local'}});
  const job=f.workflows.enqueue([{name:'one',processor:'generated.policy',inputs:[id]}]).one,running=f.workflows.tick();await begun;
  await f.service.update('workflows',{extract:{concurrency:1}},f.service.revision);release();await running;
  assert.equal(f.workflows.engine.get(job)?.state,'succeeded');
  assert.equal(JSON.parse(String(f.store.db.prepare("SELECT value FROM settings WHERE key='processing-policy'").get()!.value)).extract.concurrency,8);
});

test('disabling and re-enabling a workflow lane cannot authorize an old in-flight result',async t=>{
  const f=await fixture(t);let begin!:()=>void,release!:()=>void;const begun=new Promise<void>(resolve=>begin=resolve),held=new Promise<void>(resolve=>release=resolve);
  f.workflows.registry.register({id:'generated.revocation',version:'1',lane:'extract',async process(){begin();await held;return [{kind:'text',text:'Generated old lane result',metadata:{}}];}});
  const id=randomUUID();await f.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'macos',capturedAt:'2026-10-14T00:00:00Z',durationMs:0,source:'screen',appId:'generated',appName:'Generated',ocrText:'Generated workflow evidence',privacy:{excluded:false,redacted:false,mode:'local'}});
  const job=f.workflows.enqueue([{name:'one',processor:'generated.revocation',inputs:[id]}]).one,running=f.workflows.tick();await begun;
  await f.service.update('workflows',{extract:{enabled:false}},f.service.revision);await f.service.update('workflows',{extract:{enabled:true}},f.service.revision);release();await running;
  assert.equal(f.workflows.engine.get(job)?.state,'blocked');assert.deepEqual(JSON.parse(String(f.store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(job)!.json)).outputs,[]);
});

test('the real workflow settings HTTP entry point persists YAML and rejects a stale global revision',async t=>{
  const {buildApp}=await import('../src/app.js'),directory=await mkdtemp(join(tmpdir(),'mote-workflow-api-')),token='generated-workflow-owner-token',headers={authorization:`Bearer ${token}`};
  const node=await buildApp({dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://generated.invalid/v1',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false},{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No live model access');},close:async()=>{}}});
  t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
  const read=await node.app.inject({url:'/api/processing',headers});assert.equal(read.statusCode,200);const baseline=read.json(),settings={...baseline.settings,semantic:{concurrency:3,enabled:false}};
  const saved=await node.app.inject({method:'PUT',url:'/api/processing/settings',headers,payload:{revision:baseline.revision,settings}});
  assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().revision,baseline.revision+1);assert.deepEqual(saved.json().settings.semantic,settings.semantic);
  assert.deepEqual(parse(await readFile(node.configService.path,'utf8')).workflows.semantic,settings.semantic);
  const stale=await node.app.inject({method:'PUT',url:'/api/processing/settings',headers,payload:{revision:baseline.revision,settings:baseline.settings}});assert.equal(stale.statusCode,409);
});

test('revoking remote image processing fences a held OCR result and does not grant historical reruns',async t=>{
  const f=await fixture(t),view=f.images.view();
  await f.images.save({revision:view.revision,settings:{...view.settings,allowExternalProcessing:true,understandingEnabled:false,ocrEndpoint:'https://generated.example.invalid/ocr'}});
  let begin!:()=>void,release!:(value:unknown)=>void;
  const begun=new Promise<void>(resolve=>begin=resolve),held=new Promise<any>(resolve=>release=resolve);
  f.processing.runtime.registry.get('image.http').process=async()=>{begin();return held;};
  const image=await sharp({create:{width:16,height:16,channels:3,background:'#aabbcc'}}).png().toBuffer(),id=randomUUID();
  await f.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'macos',capturedAt:'2026-10-14T00:00:00Z',durationMs:0,source:'screen',appId:'generated',appName:'Generated',ocrText:'',ocr:{status:'disabled'},privacy:{excluded:false,redacted:false,mode:'local'},imageMime:'image/png',imageBase64:image.toString('base64')});
  const running=f.images.tick();await begun;
  await f.service.update('perception',{allowExternalProcessing:false},f.service.revision);
  release({durationMs:0,segments:[{startMs:0,endMs:0,text:'A revoked result must not publish'}]});await running;
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_products WHERE capture_id=?').get(id)!.n,0);
  assert.equal(f.store.db.prepare("SELECT state FROM perception_jobs WHERE capture_id=? AND kind='ocr'").get(id)!.state,'cancelled');
  await f.service.update('perception',{allowExternalProcessing:true},f.service.revision);await f.images.tick();
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM image_products WHERE capture_id=?').get(id)!.n,0);
});
