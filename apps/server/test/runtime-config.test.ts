import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parse,stringify} from 'yaml';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const token='synthetic-runtime-config-owner-token';
const headers={authorization:`Bearer ${token}`};
const inactive={configured:false,query:async()=>{throw Error('No model access in this fixture');},close:async()=>{}};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture-only',host:'127.0.0.1',port:0,maxStorageBytes:10_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://fixture.invalid/v1',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''});
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('execution API and external YAML edits share admission limits, global conflicts and diagnostics application',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-runtime-config-')),node=await buildApp(config(directory),{agent:inactive,backgroundWorker:false});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 const modelRevision=node.modelSettings.view().revision;
 const initial=(await node.app.inject({url:'/api/execution-settings',headers})).json();
 let releaseFirst!:()=>void,releaseSecond!:()=>void;const first=node.featureServices.agentGate.run(()=>new Promise<void>(resolve=>{releaseFirst=resolve;}));const second=node.featureServices.agentGate.run(()=>new Promise<void>(resolve=>{releaseSecond=resolve;}));
 await turn();
 const saved=await node.app.inject({method:'PUT',url:'/api/execution-settings',headers,payload:{revision:initial.revision,interactiveConcurrency:1,agentConcurrency:1,llmConcurrency:2,memoryConcurrency:1}});
 assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().revision,modelRevision+1);
 assert.deepEqual(node.featureServices.agentGate.snapshot(),{active:2,waiting:0,limit:1},'lowering the limit leaves admitted tasks alive');
 let thirdStarted=false;const third=node.featureServices.agentGate.run(async()=>{thirdStarted=true;});await turn();assert.equal(thirdStarted,false);
 releaseFirst();await first;await turn();assert.equal(thirdStarted,false,'one remaining active task fills the lowered limit');releaseSecond();await second;await third;assert.equal(thirdStarted,true);
 const stale=await node.app.inject({method:'PUT',url:'/api/model-settings',headers,payload:{revision:modelRevision,settings:node.modelSettings.current()}});assert.equal(stale.statusCode,409);assert.equal(stale.json().error,'model_settings_conflict');
 const missing=await node.app.inject({method:'PUT',url:'/api/execution-settings',headers,payload:{interactiveConcurrency:1,agentConcurrency:1,llmConcurrency:1,memoryConcurrency:1}});assert.equal(missing.statusCode,400);
 const path=join(directory,'mote.yaml'),doc=parse(await readFile(path,'utf8'));doc.execution.agentConcurrency=3;doc.execution.memoryConcurrency=2;doc.diagnostics.enabled=true;doc.diagnostics.debug=true;doc.diagnostics.traceEnabled=true;doc.diagnostics.level='debug';
 await writeFile(path,stringify(doc));await node.configService.reload();
 const reloaded=(await node.app.inject({url:'/api/execution-settings',headers})).json();assert.equal(reloaded.agentConcurrency,3);assert.equal(reloaded.queues.agents.limit,3);assert.equal(reloaded.memoryConcurrency,2);assert.equal(reloaded.revision,saved.json().revision+1);
 const diagnostics=(await node.app.inject({url:'/api/diagnostics-settings',headers})).json();assert.equal(diagnostics.enabled,true);assert.equal(diagnostics.debug,true);assert.equal(diagnostics.level,'debug');assert.equal(diagnostics.traceEnabled,true);assert.equal(node.diagnostics.snapshot().enabled,true);assert.equal(node.diagnostics.snapshot().level,'debug');assert.equal(node.diagnostics.snapshot().agentTrace.enabled,true);
 doc.revision=reloaded.revision;doc.execution.agentConcurrency=0;await writeFile(path,stringify(doc));await assert.rejects(node.configService.reload(),{code:'config_invalid'});assert.equal(node.featureServices.agentGate.snapshot().limit,3);assert.equal(node.configService.revision,reloaded.revision);
});

test('YAML trace activation persists its deadline, survives restart and cannot renew through unrelated saves', async t => {
 const now=Date.now(),day=86400000;
 t.mock.timers.enable({apis:['Date'],now});
 const directory=await mkdtemp(join(tmpdir(),'mote-yaml-trace-expiry-'));
 let node=await buildApp({...config(directory),diagnosticsEnabled:false},{agent:inactive,backgroundWorker:false});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 const path=join(directory,'mote.yaml');
 const edit=async(patch:Record<string,unknown>)=>{
  const document=parse(await readFile(path,'utf8'));Object.assign(document.diagnostics,patch);
  await writeFile(path,stringify(document));await node.configService.reload();
 };
 const preferences=async()=>(await node.app.inject({url:'/api/diagnostics-settings',headers})).json();
 await edit({enabled:true,debug:true,traceEnabled:true,level:'warn'});
 const expiresAt=now+day;
 assert.equal((await preferences()).traceEnabled,true);
 assert.equal((await preferences()).traceExpiresAt,expiresAt);
 assert.equal(parse(await readFile(path,'utf8')).diagnostics.traceExpiresAt,expiresAt,'YAML activation persists its bounded deadline before publishing');
 assert.equal(node.diagnostics.snapshot().level,'debug');
 assert.equal(node.diagnostics.snapshot().agentTrace.expiresAt,expiresAt);
 node.diagnostics.agentTrace({type:'fixture.yaml-activation',payload:{prompt:'generated YAML trace'}});await node.diagnostics.flush();
 assert.ok(node.diagnostics.recent().some(event=>(event.trace as Record<string,unknown>|undefined)?.type==='fixture.yaml-activation'));

 t.mock.timers.setTime(now+3600000);
 const execution=(await node.app.inject({url:'/api/execution-settings',headers})).json();
 const saved=await node.app.inject({method:'PUT',url:'/api/execution-settings',headers,payload:{revision:execution.revision,interactiveConcurrency:execution.interactiveConcurrency,agentConcurrency:5,llmConcurrency:execution.llmConcurrency,memoryConcurrency:execution.memoryConcurrency}});
 assert.equal(saved.statusCode,200,saved.body);assert.equal(node.featureServices.agentGate.snapshot().limit,5);
 await edit({debug:false,traceExpiresAt:0});
 assert.equal((await preferences()).traceExpiresAt,expiresAt,'clearing a deadline while tracing stays enabled cannot extend the window');
 assert.equal(node.diagnostics.snapshot().level,'warn');
 await node.app.close();node=await buildApp(config(directory),{agent:inactive,backgroundWorker:false});
 assert.equal((await preferences()).traceEnabled,true);assert.equal(node.diagnostics.snapshot().agentTrace.expiresAt,expiresAt);
 assert.ok(node.diagnostics.recent().some(event=>(event.trace as Record<string,unknown>|undefined)?.type==='fixture.yaml-activation'),'the activated writer persists generated traces across restart');

 t.mock.timers.setTime(expiresAt-1);
 const before=node.diagnostics.snapshot().lastSeq;node.diagnostics.agentTrace({type:'fixture.before-expiry'});
 assert.equal(node.diagnostics.snapshot().lastSeq,before+1);await node.diagnostics.flush();
 t.mock.timers.setTime(expiresAt);
 const expired=node.diagnostics.snapshot().lastSeq;node.diagnostics.agentTrace({type:'fixture.at-expiry'});
 assert.equal(node.diagnostics.snapshot().lastSeq,expired);assert.equal((await preferences()).traceEnabled,false);assert.equal(node.diagnostics.snapshot().agentTrace.enabled,false);
 await edit({debug:true,traceExpiresAt:0});
 assert.equal((await preferences()).traceExpiresAt,expiresAt);assert.equal((await preferences()).traceEnabled,false);
 await node.app.close();node=await buildApp(config(directory),{agent:inactive,backgroundWorker:false});
 assert.equal((await preferences()).traceEnabled,false);assert.equal(node.diagnostics.snapshot().agentTrace.enabled,false);assert.equal(node.diagnostics.snapshot().agentTrace.expiresAt,expiresAt);

 await edit({traceEnabled:false});
 assert.equal(parse(await readFile(path,'utf8')).diagnostics.traceExpiresAt,0);
 await edit({traceEnabled:true});
 assert.equal((await preferences()).traceExpiresAt,expiresAt+day);assert.equal(node.diagnostics.snapshot().agentTrace.enabled,true);
 const disabled=await node.app.inject({method:'PUT',url:'/api/diagnostics-settings',headers,payload:{revision:node.configService.revision,enabled:true,debug:false,traceEnabled:false,level:'info'}});
 assert.equal(disabled.statusCode,200,disabled.body);assert.equal(disabled.json().traceExpiresAt,0);
 const stopped=node.diagnostics.snapshot().lastSeq;node.diagnostics.agentTrace({type:'fixture.after-disable'});
 assert.equal(node.diagnostics.snapshot().lastSeq,stopped);assert.equal(node.diagnostics.snapshot().agentTrace.enabled,false);
});

test('YAML diagnostics validate the trace deadline before applying execution limits or enabling capture', async t => {
 const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
 const directory=await mkdtemp(join(tmpdir(),'mote-yaml-trace-validation-'));
 const node=await buildApp({...config(directory),diagnosticsEnabled:false,agentTraceEnabled:true,agentTraceExpiresAt:0},{agent:inactive,backgroundWorker:false});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 const settings=(await node.app.inject({url:'/api/execution-settings',headers})).json();
 const update=await node.app.inject({method:'PUT',url:'/api/execution-settings',headers,payload:{revision:settings.revision,agentConcurrency:5}});
 assert.equal(update.statusCode,200,update.body);
 assert.equal((await node.app.inject({url:'/api/diagnostics-settings',headers})).json().traceExpiresAt,0,'an unrelated save must not activate a startup trace setting without a deadline');
 const path=join(directory,'mote.yaml'),document=parse(await readFile(path,'utf8'));
 const revision=node.configService.revision,limit=node.featureServices.agentGate.snapshot().limit;
 document.execution.agentConcurrency=1;
 Object.assign(document.diagnostics,{enabled:true,traceEnabled:true,traceExpiresAt:now+2*86400000});
 await writeFile(path,stringify(document));await assert.rejects(node.configService.reload(),{code:'config_invalid'});
 assert.equal(node.configService.revision,revision);assert.equal(node.featureServices.agentGate.snapshot().limit,limit);
 assert.equal(node.diagnostics.snapshot().enabled,false);assert.equal(node.diagnostics.snapshot().agentTrace.enabled,false);
 document.diagnostics.traceExpiresAt=now+60000;
 await writeFile(path,stringify(document));await node.configService.reload();
 assert.equal(node.featureServices.agentGate.snapshot().limit,1);assert.equal(node.diagnostics.snapshot().agentTrace.enabled,true);
 assert.equal(node.diagnostics.snapshot().agentTrace.expiresAt,now+60000,'an explicit shorter deadline is preserved');
 assert.equal(parse(await readFile(path,'utf8')).diagnostics.traceExpiresAt,now+60000);
 t.mock.timers.setTime(now+60000);
 assert.equal((await node.app.inject({url:'/api/diagnostics-settings',headers})).json().traceEnabled,false);
 assert.equal(node.diagnostics.snapshot().agentTrace.enabled,false);
});

test('legacy SQLite execution and diagnostics rows never override YAML and remain preserved',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-runtime-legacy-'));let node=await buildApp(config(directory),{agent:inactive,backgroundWorker:false});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 const rows={execution:JSON.stringify({interactiveConcurrency:8,agentConcurrency:63,llmConcurrency:62,memoryConcurrency:15}),diagnostics:JSON.stringify({enabled:false,debug:true,traceEnabled:true,level:'silent'})};
 node.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('execution-settings',rows.execution);node.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('diagnostics-settings',rows.diagnostics);
 await node.app.close();node=await buildApp(config(directory),{agent:inactive,backgroundWorker:false});
 const execution=(await node.app.inject({url:'/api/execution-settings',headers})).json(),diagnostics=(await node.app.inject({url:'/api/diagnostics-settings',headers})).json();assert.equal(execution.agentConcurrency,8);assert.equal(execution.interactiveConcurrency,2);assert.equal(diagnostics.enabled,true);assert.equal(diagnostics.debug,false);
 assert.equal(node.store.db.prepare("SELECT value FROM settings WHERE key='execution-settings'").get()?.value,rows.execution);assert.equal(node.store.db.prepare("SELECT value FROM settings WHERE key='diagnostics-settings'").get()?.value,rows.diagnostics);
 const saved=await node.app.inject({method:'PUT',url:'/api/diagnostics-settings',headers,payload:{revision:diagnostics.revision,enabled:false,debug:false,traceEnabled:false,level:'info'}});assert.equal(saved.statusCode,200,saved.body);
 assert.equal(node.store.db.prepare("SELECT value FROM settings WHERE key='diagnostics-settings'").get()?.value,rows.diagnostics);assert.equal(parse(await readFile(join(directory,'mote.yaml'),'utf8')).diagnostics.enabled,false);
});

test('a later domain application failure restores the old model generation and keeps its in-flight lease',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-model-rollback-')),closed:string[]=[];
 let release!:()=>void,started!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{started=resolve;});
 const node=await buildApp({...config(directory),model:'original-model'},{backgroundWorker:false,createModelAgent:async settings=>({configured:true,query:async input=>{if(input.question==='hold rollback'){started();await held;}return {answer:settings.model,citations:[],trace:[],runId:'synthetic-rollback-run'};},close:async()=>{closed.push(settings.model);}})});
 t.after(async()=>{release();await node.app.close();await rm(directory,{recursive:true,force:true});});
 const pending=node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'hold rollback'}});await began;
 node.configService.setHandler('connectors',()=>({applyOrder:2000,apply:()=>{},publish:()=>{throw Error('Synthetic publication failure');},rollback:()=>{}}));
 const models=node.configService.saved<{deployment:Record<string,unknown>}>('models'),connectors=node.configService.saved<{syncIntervalMs:number}>('connectors');
 await assert.rejects(node.configService.updateMany({models:{...models,deployment:{...models.deployment,model:'candidate-model'}},connectors:{...connectors,syncIntervalMs:connectors.syncIntervalMs+60000}},node.configService.revision),{code:'config_apply_failed'});
 assert.equal(node.modelSettings.current().model,'original-model');assert.equal(node.configService.view().lastError?.code,'config_apply_failed');assert.equal(closed.includes('original-model'),false);
 assert.equal((await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'new after rollback'}})).json().answer,'original-model');
 release();assert.equal((await pending).json().answer,'original-model');await turn();assert.equal(closed.includes('candidate-model'),true);assert.equal(closed.includes('original-model'),false);
});

test('an asynchronous plugin failure exposes no candidate model, admission limit or diagnostic trace policy',async t=>{
 const {z}=await import('zod'),{stat}=await import('node:fs/promises');
 const directory=await mkdtemp(join(tmpdir(),'mote-runtime-publication-')),closed:string[]=[];
 const node=await buildApp({...config(directory),model:'committed-model',diagnosticsEnabled:false},{backgroundWorker:false,createModelAgent:async settings=>({configured:true,query:async()=>({answer:settings.model,citations:[],trace:[],runId:'synthetic-publication-run'}),close:async()=>{closed.push(settings.model);}})});
 t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 let enter!:()=>void,finish!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),held=new Promise<void>(resolve=>{finish=resolve;});
 await node.configService.registerPlugin({id:'publication-fixture',schema:z.object({reject:z.boolean()}),defaultValue:{reject:false},prepare:next=>({apply:async()=>{if(next.reject){enter();await held;throw Error('Synthetic asynchronous failure');}},rollback:()=>{}})});
 const previous=node.configService.current<Record<string,unknown>>('execution'),models=node.configService.saved<{deployment:Record<string,unknown>}>('models');
 const pending=node.configService.updateMany({models:{...models,deployment:{...models.deployment,model:'unpublished-model'}},execution:{agentConcurrency:1},diagnostics:{enabled:true,debug:true,traceEnabled:true,level:'debug'},'plugin.publication-fixture':{reject:true}},node.configService.revision);
 const failed=assert.rejects(pending,{code:'config_apply_failed'});await entered;
 try{
  assert.equal(node.modelSettings.current().model,'committed-model');assert.equal(node.featureServices.agentGate.snapshot().limit,previous.agentConcurrency);assert.equal(node.diagnostics.snapshot().enabled,false);assert.equal(node.diagnostics.snapshot().agentTrace.enabled,false);
  node.diagnostics.agentTrace({type:'fixture.unpublished',payload:{prompt:'synthetic-speculative-trace'}},{});
  assert.equal((await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'during candidate application'}})).json().answer,'committed-model');
 }finally{finish();}
 await failed;
 assert.equal(node.modelSettings.current().model,'committed-model');assert.equal(node.featureServices.agentGate.snapshot().limit,previous.agentConcurrency);assert.equal(node.diagnostics.recent().some(event=>event.event==='agent.trace'),false);
 assert.equal(closed.includes('unpublished-model'),true,'a prepared, unpublished model candidate is disposed after failure');assert.equal(closed.includes('committed-model'),false);
 await assert.rejects(stat(join(directory,'logs','central.lock')),{code:'ENOENT'});
});
