/** Opt-in live acceptance: generated data only, isolated vaults, local Codex App Server.
 * Large-catalog planning uses the production adapter; the small end-to-end flow
 * enters through authenticated loopback HTTP and includes extraction/review. */
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createAgent} from '@mote/agent';
import {Store} from '../apps/server/src/store.js';
import {SourceStore} from '../apps/server/src/sources.js';
import {MaterialStore,materialId} from '../apps/server/src/materials.js';
import {MemoryStore} from '../apps/server/src/memory.js';
import {MaterialMemoryWork} from '../apps/server/src/material-memory-work.js';
import {MemoryPipeline} from '../apps/server/src/memory-pipeline.js';
import {ExecutionEngine} from '../apps/server/src/execution-engine.js';
import {DelegationRuntime} from '../apps/server/src/delegation-runtime.js';
import {SourcePipelineRuntime} from '../apps/server/src/source-pipelines.js';
import {registerMemoryDelegation} from '../apps/server/src/memory-delegation.js';
import {buildApp} from '../apps/server/src/app.js';
import type {Config} from '../apps/server/src/config.js';

assert.equal(process.env.MOTE_PLANNING_CODEX_LIVE,'1','Opt in with MOTE_PLANNING_CODEX_LIVE=1');
const directory=await mkdtemp(join(tmpdir(),'mote-planning-codex-live-')),started=Date.now();
const model=process.env.MOTE_TEST_CODEX_MODEL??'gpt-6.1-sol',reportPath=process.env.MOTE_PLANNING_REPORT??join(tmpdir(),'mote-planning-codex-live.json');
const report:Record<string,any>={status:'running',startedAt:new Date().toISOString(),model,reasoningEffort:'high',personalDataUsed:false,physicalDevicesTested:false,calls:[],scenarios:[]};
const save=()=>writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600});
const progress=(stage:string,data:Record<string,unknown>={})=>console.log(JSON.stringify({stage,...data}));
const traces:{type:string;tool?:string;payload?:any}[]=[];
const agent=createAgent({provider:'codex',protocol:'codex-app-server',model,reasoningEffort:'high',agentTimeoutMs:300000,codex:{executable:process.env.MOTE_CODEX_BIN,home:process.env.MOTE_CODEX_HOME},reader:{search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[]}});
const store=new Store(join(directory,'planning')),sources=new SourceStore(store),materials=new MaterialStore(store),memories=new MemoryStore(store,ids=>[...store.evidence(ids),...materials.evidence(ids)],id=>store.isCurrentEvidence(id)||materials.isCurrentEvidence(id)),engine=new ExecutionEngine(store),work=new MaterialMemoryWork(store,materials),runtime=new DelegationRuntime(store,engine),sourcePipelines=new SourcePipelineRuntime(store,materials,[],undefined,engine,work);
const pipeline=new MemoryPipeline({store,memories,executor:engine,configured:()=>true,model:()=>model,requireAdmission:true,automaticAllowed:job=>work.authorized(job),materialInput:(ref,required)=>materials.input(ref,required),materialRequirements:()=>['material'],materialAllowedForMemory:()=>true,query:async()=>{throw Error('The large-catalog scenario only validates planning; product execution belongs to the HTTP scenario');}});
const adapter=registerMemoryDelegation({runtime,pipeline,work,sourcePipelines,query:async input=>{
 const call={phase:'planning',startedAt:new Date().toISOString(),status:'running',durationMs:0};report.calls.push(call);progress('model-start',{call:report.calls.length,phase:call.phase});
 try{const result=await agent.query({...input,onTrace:event=>{traces.push(event);if(event.type==='tool.started'&&event.tool==='delegation_submit')progress('planner-submission',{units:(event.payload as any)?.arguments?.units?.length});}});call.status='completed';return result;}catch(error){call.status='failed';throw error;}finally{call.durationMs=Date.now()-Date.parse(call.startedAt);await save();}
}});
let node:Awaited<ReturnType<typeof buildApp>>|undefined;
const token=randomBytes(32).toString('hex');
const config:Config={dataKey:undefined,dataDir:join(directory,'http'),token,tokenPath:join(directory,'token'),host:'127.0.0.1',port:0,maxStorageBytes:30000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model,modelProvider:'codex',modelProtocol:'codex-app-server',modelReasoningEffort:'high',agentTimeoutMs:300000,modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent',diagnosticsEnabled:false,codexBin:process.env.MOTE_CODEX_BIN,codexHome:process.env.MOTE_CODEX_HOME,memoryConcurrency:2};
let url='';
async function openHttp(){
 node=await buildApp(config,{backgroundWorker:false});
 const settings=node.lifecycle.settings();settings.extraction.enabled=true;for(const id of ['consolidation','insights','working'] as const)settings[id].enabled=false;node.lifecycle.configure(settings);
 const query=node.agent.query.bind(node.agent);node.agent.query=async input=>{
  assert.ok(report.calls.length<30&&Date.now()-started<20*60000,'Bounded live acceptance');
  const call={phase:input.traceContext?.phase??'query',startedAt:new Date().toISOString(),status:'running',durationMs:0};report.calls.push(call);progress('model-start',{call:report.calls.length,phase:call.phase});
  try{const result=await query(input);call.status='completed';return result;}catch(error){call.status='failed';throw error;}finally{call.durationMs=Date.now()-Date.parse(call.startedAt);await save();}
 };
 url=await node.app.listen({host:'127.0.0.1',port:0});
}
async function request(method:string,path:string,body?:unknown){const response=await fetch(url+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Mote-Ingress-Version':'2'},...(body===undefined?{}:{body:JSON.stringify(body)})});const value=await response.json() as any;assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);return value;}
const timeout=setTimeout(()=>{progress('deadline');void node?.app.close();void agent.close();},20*60000);
try{
 await sourcePipelines.ready;sources.register({id:'generated-catalog',name:'Generated catalog',kind:'custom',deviceId:'generated',platform:'import'});
 for(let index=0;index<64;index++){
  const text=index<8?'Generated reference only. '.repeat(600):'Generated reference '+index+' contains a synthetic specification, not a personal record.';
  const original=await sources.upsert('generated-catalog',{externalId:String(index),revision:'1',text,observedAt:'2026-09-01T00:00:00Z',kind:'file',layer:'original'});
  const material=materials.publish({id:materialId('generated-catalog',String(index)),kind:'mote.file',schemaVersion:1,title:'Generated reference '+index,origin:{sourceId:'generated-catalog',externalId:String(index)},blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:[original.id]}],members:[{id:original.id,kind:'capture',ref:'capture:'+original.id}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
  store.db.exec('BEGIN IMMEDIATE');work.inputs.receive({sourceId:'generated-catalog',inputKey:'generated-'+index});store.db.exec('COMMIT');work.observe(material.id,['material'],{inputKey:'generated-'+index,change:'source'});
 }
 const catalog=work.catalog();assert.equal(catalog.length,64);const proposals=await adapter.plan(catalog),owner=runtime.list()[0];
 const keys=proposals.flatMap(proposal=>proposal.members);assert.equal(keys.length,64);assert.equal(new Set(keys).size,64);assert.deepEqual([...keys].sort(),catalog.map(candidate=>candidate.key).sort());assert.equal(owner.planningComplete,true);assert.equal(owner.wait,undefined);
 const submissions=traces.filter(event=>event.type==='tool.started'&&event.tool==='delegation_submit');assert.ok(submissions.length>=2);assert.ok(submissions.every(event=>event.payload.arguments.units.length<=8));
 report.scenarios.push({name:'64-member-production-planner',members:64,packages:proposals.length,submissionCalls:submissions.length,longMembers:8,coverageComplete:true});progress('large-plan-completed',{packages:proposals.length});
 // Replace the execution host, preserving only durable generated state.
 await adapter.close();await runtime.close();await engine.close();await agent.close();
 const ids=owner.units.map(unit=>unit.id);
 const recoveryEngine=new ExecutionEngine(store),recoveryRuntime=new DelegationRuntime(store,recoveryEngine);
 const recoveryAdapter=registerMemoryDelegation({runtime:recoveryRuntime,pipeline,work,sourcePipelines,query:async()=>{throw Error('A complete durable plan must recover without another model call');}});
 try{await recoveryRuntime.tick();const recovered=await recoveryRuntime.waitForPlan(owner.id,AbortSignal.timeout(30000));assert.equal(recovered.revision,1);assert.equal(recovered.wait,undefined);assert.deepEqual(recovered.units.map(unit=>unit.id),ids);assert.deepEqual(recovered.plannedUnitIds,ids);report.scenarios.push({name:'completed-plan-host-restart',savedPackages:ids.length,reusedHandles:true,planningComplete:true,additionalModelCalls:0});progress('recovery-completed');}
 finally{await recoveryRuntime.close();await recoveryEngine.close();await recoveryAdapter.close();}
 await openHttp();await request('POST','/api/sources',{id:'generated-http',name:'Generated acceptance journal',kind:'custom',deviceId:'generated-http',platform:'import',retention:'archive'});
 await request('PUT','/api/source-pipelines/generated-http',{settleSeconds:0});
 const texts=['For my generated test project I require a signed build receipt before deployment.','For my generated test project I prefer text status updates with an explicit verification result.','A generated reference document lists the fictional widget protocol revision 3.','A generated reference document describes fictional widget colors.'];
 for(const [index,text] of texts.entries())await request('PUT','/api/sources/generated-http/items',{externalId:'generated-'+index,revision:'1',observedAt:'2026-09-01T00:00:00Z',kind:'message',layer:'original',text,document:{contentRole:'authored',recordedAt:'2026-09-01T00:00:00Z',timeBasis:'recorded'}});
 for(let i=0;i<10;i++)if(await node!.materialOrganizer.tick(100)===0)break;
 assert.equal(node!.materialMemoryWork.catalog().length,4);
 const admitted=await node!.sourcePipelines.drainMemory(node!.memoryPipeline,true);assert.ok(admitted>0||node!.memoryPipeline.list().length>0,'Generated originals enter actual product jobs');
 for(;;){await node!.featureServices.delegation.tick();await node!.sourcePipelines.drainMemory(node!.memoryPipeline,true);const jobs=node!.memoryPipeline.list();assert.ok(jobs.every(job=>!['failed','waiting_for_model','cancelled','waiting_for_input'].includes(job.status)),JSON.stringify(jobs.map(job=>({status:job.status,error:job.errorCode}))));if(jobs.length&&jobs.every(job=>job.status==='completed')&&node!.featureServices.delegation.list().every(work=>work.status==='succeeded'))break;assert.ok(Date.now()-started<20*60000);await new Promise(resolve=>setTimeout(resolve,1000));}
 const jobs=node!.memoryPipeline.list().map(job=>node!.memoryPipeline.get(job.id)),jobIds=jobs.map(job=>job.id).sort(),checkpointCount=Number(node!.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n);assert.equal(checkpointCount,4);
 const coverage=jobs.flatMap(job=>job.batches.filter(batch=>!batch.supersededBy).flatMap(batch=>batch.coverage??[]));assert.equal(new Set(coverage.map(member=>member.key)).size,4);assert.ok(jobs.every(job=>job.batches.filter(batch=>!batch.supersededBy).every(batch=>batch.reviewReceipt)));
 const before=report.calls.length;await node!.app.close();node=undefined;await openHttp();await node!.sourcePipelines.drainMemory(node!.memoryPipeline,true);await node!.featureServices.delegation.tick();assert.equal(report.calls.length,before);assert.deepEqual(node!.memoryPipeline.list().map(job=>job.id).sort(),jobIds);assert.equal((await request('GET','/api/operations?state=running')).items.length,0);
 report.scenarios.push({name:'http-source-memory-review-restart',originals:4,jobs:jobs.length,independentlyReviewed:true,checkpointCount,noReplay:true});report.status='passed';progress('accepted',{scenarios:report.scenarios,modelCalls:report.calls.length});
}catch(error){report.status='failed';report.failure=error instanceof Error?error.message:String(error);process.exitCode=1;progress('failed',{failure:report.failure});}
finally{clearTimeout(timeout);report.finishedAt=new Date().toISOString();report.durationMs=Date.now()-started;await save();await node?.app.close();await agent.close();await runtime.close();await engine.close();await adapter.close();await pipeline.close();await sourcePipelines.close();store.close();await rm(directory,{recursive:true,force:true});}
