import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

test('owner stop remains stopping and retains the cutover tail until the cancelled automatic transport actually exits',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-memory-stop-generated-')),owner='generated-owner-'+randomUUID();
  let release!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(resolve=>entered=resolve),transport=new Promise<void>(resolve=>release=resolve);
  const config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'https://generated.invalid',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors'),mcpEnabled:false,mcpWriteEnabled:false}};
  const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,async query(){throw Error('No model belongs in this generated transport fixture');},async close(){}},memoryExtensions:[{id:'extraction',version:'generated-slow-transport',stream:'evidence',async run(_window,_checkpoint,execution){assert.ok(execution);entered();await transport;execution.signal.throwIfAborted();}}]});
  let running:Promise<void>|undefined;
  t.after(async()=>{release();await running?.catch(()=>{});await node.app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+owner},settings=node.lifecycle.settings();
  await node.lifecycle.save({revision:node.configService.revision,settings:{...settings,extraction:{...settings.extraction,minChanges:1}}});
  const received=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:randomUUID(),deviceId:'generated-device',deviceName:'Generated',platform:'import',capturedAt:new Date().toISOString(),text:'Generated observatory transport lifecycle.'}});
  assert.equal(received.statusCode,201,received.body);
  running=node.lifecycle.tick();await ready;
  const initial=(await node.app.inject({method:'GET',url:'/api/memory-spaces/default/binding',headers})).json();
  assert.equal(initial.admission.running,1);
  const stop=await node.app.inject({method:'POST',url:'/api/memory-spaces/default/binding/stop',headers,payload:{operationId:randomUUID(),expectedRevision:initial.revision}});
  assert.equal(stop.statusCode,200);assert.equal(stop.json().admission.state,'stopping');assert.equal(stop.json().admission.running,1);
  assert.ok(node.memoryBindings.pendingTail()>0,'a revoked grant is not proof that its native transport stopped');
  release();await running;
  const settled=(await node.app.inject({method:'GET',url:'/api/memory-spaces/default/binding',headers})).json();
  assert.equal(settled.admission.state,'paused');assert.equal(settled.admission.running,0);assert.equal(node.memoryBindings.pendingTail(),0);
});

for(const localCleanup of [true,false])test(`automatic stop rolls back a tail SQL failure, then ${localCleanup?'aborts only after commit':'fences late review without local cleanup'} and survives restart`,async t=>{
  const {authorizeFixtureModels}=await import('./fixtures/model-authorization.js');
  const {fixtureMemoryWorkResult}=await import('./fixtures/memory-planning.js');
  const directory=await mkdtemp(join(tmpdir(),'mote-memory-stop-atomic-')),owner='generated-owner-'+randomUUID();
  const config:Config={dataDir:directory,token:owner,tokenPath:join(directory,'owner-token'),host:'127.0.0.1',port:0,profile:'test',tokenFromEnvironment:true,maxStorageBytes:30*1024*1024,maxExportBytes:1024*1024,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-model',modelProvider:'custom',modelProtocol:'openai-completions',modelBaseUrl:'https://generated.invalid/v1',apiKey:'generated-only',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',connectors:{directory:join(directory,'connectors'),mcpEnabled:false,mcpWriteEnabled:false}};
  let release!:()=>void,entered!:()=>void,reviewSignal!:AbortSignal,calls=0;
  const ready=new Promise<void>(resolve=>entered=resolve),transport=new Promise<void>(resolve=>release=resolve);
  const abortTransactions:boolean[]=[];
  let node:Awaited<ReturnType<typeof buildApp>>;
  const agent={configured:true,async query(input:import('@mote/agent').QueryInput){
    calls++;
    if(input.traceContext?.phase==='review'){
      reviewSignal=input.signal!;reviewSignal.addEventListener('abort',()=>abortTransactions.push(node.store.db.isTransaction),{once:true});
      entered();await transport;
    }
    return fixtureMemoryWorkResult(input,{answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()});
  },async close(){}};
  node=await buildApp(config,{backgroundWorker:false,agent});await authorizeFixtureModels(node);
  let running:Promise<void>|undefined;
  t.after(async()=>{release();await running?.catch(()=>{});await node.app.close();await rm(directory,{recursive:true,force:true});});
  const headers={authorization:'Bearer '+owner},sourceId=randomUUID(),text='Generated original awaiting an independent Memory review.';
  const received=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id:sourceId,deviceId:'generated-device',deviceName:'Generated',platform:'import',capturedAt:new Date().toISOString(),text}});
  assert.equal(received.statusCode,201,received.body);
  node.sources.register({id:'generated-automatic',name:'Generated automatic intake',kind:'custom',deviceId:'generated-device',platform:'import'});
  await node.sources.upsert('generated-automatic',{externalId:'generated-grant',revision:'1',observedAt:new Date().toISOString(),kind:'message',layer:'original',text:'Generated independently received automatic input.'});
  const artifactId='b'.repeat(64);
  node.store.archive.save(artifactId,artifactId,artifactId,{kind:'semantic',text:'Generated previously completed interpretation',metadata:{complete:true,evidenceRanges:[{id:sourceId,offset:0,length:text.length}]}},[{id:sourceId,fingerprint:node.store.archive.fingerprint(sourceId)!}],'generated','1','generated');
  const settings=node.lifecycle.settings();settings.extraction.minChanges=1;
  for(const id of ['consolidation','insights','working'] as const)settings[id].enabled=false;
  await node.lifecycle.save({revision:node.configService.revision,settings});
  running=node.lifecycle.tick();await ready;
  const window=node.lifecycle.view().extensions.find(extension=>extension.id==='extraction')!.active!;
  const job=node.memoryPipeline.get(window.checkpoint!);assert.equal(job.status,'running');assert.equal(calls,2);
  await node.materialOrganizer.tick(100);await node.sourcePipelines.tick(100);
  const pipeline=node.memoryPipeline;
  await node.sourcePipelines.drainMemory({create:input=>pipeline.create(input),state:id=>pipeline.state(id),cancel:(id,options)=>pipeline.cancel(id,options),run:async()=>{}},true,100);
  await new Promise<void>(resolve=>setImmediate(resolve));
  const automaticJob=node.memoryPipeline.list().find(value=>value.automaticGrants?.length)!;
  assert.ok(automaticJob,'the real Material queue admitted an independently scoped automatic job');
  const db=node.store.db,command={operationId:randomUUID(),expectedRevision:node.memoryAutomation.state().revision};
  const grants=()=>db.prepare('SELECT * FROM memory_input_authorizations ORDER BY rowid').all();
  assert.ok(grants().some(row=>row.authorized===1&&row.revoked_at===null),'the real intake produced durable automatic grants');
  const rows=()=>({jobs:db.prepare('SELECT * FROM memory_jobs ORDER BY rowid').all(),batches:db.prepare('SELECT * FROM memory_batches ORDER BY rowid').all(),outputs:db.prepare('SELECT * FROM memory_phase_outputs ORDER BY step_id').all(),steps:db.prepare('SELECT * FROM execution_steps ORDER BY rowid').all(),lifecycle:db.prepare('SELECT * FROM memory_lifecycle_state ORDER BY id').all(),grants:grants(),control:node.memoryAutomation.state()});
  const before=rows();assert.equal(before.outputs.length,1,'successful extraction is already a real committed phase output');
  const liveSteps=before.steps.filter(step=>step.state==='running');assert.ok(liveSteps.length>=3,'lifecycle, batch and review all hold actual running grants');
  db.exec("CREATE TEMP TRIGGER generated_stop_tail_failure BEFORE INSERT ON memory_control_commands BEGIN SELECT RAISE(ABORT,'Generated stop tail failure'); END");
  const failed=await node.app.inject({method:'POST',url:'/api/memory-spaces/default/binding/stop',headers,payload:command});
  assert.equal(failed.statusCode,500,failed.body);assert.deepEqual(rows(),before,'the final SQL failure rolls back all participant writes and private output deletion');
  assert.equal(reviewSignal.aborted,false);assert.deepEqual(abortTransactions,[]);
  assert.equal(db.prepare('SELECT 1 FROM memory_control_commands WHERE operation_id=?').get(command.operationId),undefined);
  db.exec('DROP TRIGGER generated_stop_tail_failure');
  if(!localCleanup){const stop=node.memoryAutomation.onStop!;node.memoryAutomation.onStop=()=>{stop();};}
  const stopped=await node.app.inject({method:'POST',url:'/api/memory-spaces/default/binding/stop',headers,payload:command});
  assert.equal(stopped.statusCode,200,stopped.body);assert.equal(node.memoryPipeline.get(job.id).status,'cancelled');
  assert.equal(node.memoryPipeline.get(job.id).cancellationCause,'authority');
  assert.equal(node.memoryPipeline.get(automaticJob.id).status,'cancelled','the direct automatic job participates in the same stop transaction');
  assert.equal(reviewSignal.aborted,localCleanup);assert.deepEqual(abortTransactions,localCleanup?[false]:[]);
  for(const step of liveSteps){assert.equal(node.executor.get(String(step.id))!.state,'cancelled');assert.equal(db.prepare('SELECT fence FROM execution_steps WHERE id=?').get(step.id)!.fence,null);}
  assert.equal(db.prepare('SELECT count(*) n FROM memory_phase_outputs').get()!.n,0);
  assert.ok(grants().every(row=>row.authorized!==1||row.revoked_at!==null));
  const revision=node.memoryAutomation.state().revision;
  const repeated=await node.app.inject({method:'POST',url:'/api/memory-spaces/default/binding/stop',headers,payload:command});
  assert.equal(repeated.statusCode,200,repeated.body);assert.equal(node.memoryAutomation.state().revision,revision);assert.equal(calls,2);
  release();
  if(!localCleanup){await node.executor.drain(liveSteps.filter(step=>String(step.kind).startsWith('memory.phase.')).map(step=>String(step.id)));node.memoryPipeline.wake();}
  await running;
  assert.equal(node.memoryPipeline.get(job.id).status,'cancelled');assert.equal(node.memories.list().length,0);
  assert.equal(db.prepare('SELECT count(*) n FROM memory_phase_outputs').get()!.n,0,'the late independent review cannot recreate a checkpoint');
  await node.app.close();node=await buildApp(config,{backgroundWorker:false,agent});
  assert.equal(node.memoryAutomation.accepting(),false);assert.equal(node.memoryPipeline.get(job.id).status,'cancelled');
  await node.lifecycle.tick();assert.equal(calls,2,'restart cannot authorize another attempt');
  const restarted=await node.app.inject({method:'POST',url:'/api/memory-spaces/default/binding/stop',headers,payload:command});
  assert.equal(restarted.statusCode,200,restarted.body);assert.equal(node.memoryAutomation.state().revision,revision);
});
