import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AgentYieldError,originalEvidenceReceipt,parseAnswer,type QueryInput} from '@mote/agent';
import {ProviderFailure,type QueryResult} from '@mote/shared';
import {buildApp,type QueryAgent} from '../src/app.js';
import type {ModelAgentFactory} from '../src/model-agent.js';
import type {Config} from '../src/config.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {startBridge} from '../../../packages/agent/dist/bridge.js';

const token='generated-delegation-app-owner',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxExportBytes:1_000_000,insightIntervalHours:0,allowedOrigins:[],model:'generated-fixture',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',agentConcurrency:1,llmConcurrency:1,agentTimeoutMs:30000});
const scope={deviceId:'generated-selected-device',after:'2026-09-20T00:00:00Z',before:'2026-09-21T00:00:00Z',timeZone:'Asia/Shanghai'};
const original={id:'00000000-0000-4000-8000-000000000101',deviceId:scope.deviceId,deviceName:'Generated fixture',platform:'import',source:'note' as const,capturedAt:'2026-09-20T01:00:00Z',durationMs:0,ocrText:'Generated original: the sample project chose a local archive.'};
const plain=(answer='Generated answer'):QueryResult=>({answer,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}});
async function until<T>(read:()=>T|undefined,describe?:()=>unknown):Promise<T>{for(let attempt=0;attempt<240;attempt++){const value=read();if(value!==undefined)return value;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Generated fixture did not settle'+(describe?': '+JSON.stringify(describe()):''));}

function snapshot(node:Awaited<ReturnType<typeof buildApp>>,id:string){
 const run=node.queryRuns.get(id),work=node.delegation.get('query:'+id);
 return {run:{status:run.status,error:run.error,execution:run.execution},work:{status:work.status,revision:work.revision,units:work.units.map(unit=>({status:unit.status,attempts:unit.attempts,error:unit.error}))},pool:node.executor.poolSnapshot('delegated-agents'),gate:node.featureServices.agentGate.snapshot(),steps:node.store.db.prepare('SELECT e.id,e.state,e.error,a.work_id FROM execution_steps e LEFT JOIN background_model_step_authority a ON a.step_id=e.id WHERE e.operation_id=?').all('query:'+id)};
}

// Semantic choices are generated; owner intake, the model tool bridge, private
// research products, shared execution and final conversation writes are real.
async function researchFixture(t:TestContext,mode:'parallel'|'restart'|'cancel'|'revoke'){
 const directory=mkdtempSync(join(tmpdir(),'mote-research-consumer-')),sourceId='generated-research-source',concurrency=mode==='restart'?1:2,clientRequestId=randomUUID();
 const cfg:Config={...config(directory),dataKey:'65'.repeat(32),contentEncryptionEnabled:true,diagnosticsEnabled:false,interactiveConcurrency:concurrency,agentConcurrency:concurrency,llmConcurrency:concurrency};
 const questions=['Inspect the generated decision','Inspect the generated constraint','Inspect the generated outcome'],texts=['Generated decision: keep the prototype archive local.','Generated constraint: retain the agreed project boundary.','Generated outcome: the prototype passed its scoped review.'];
 const originals:{id:string;text:string}[]=[],gates=questions.map(()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};});
 let node:Awaited<ReturnType<typeof buildApp>>,id='',conversationId='',generation=0,fragments=0,active=0,maxActive=0;
 const calls=[0,0,0],started:{index:number;generation:number;signal:AbortSignal}[]=[],errors:string[]=[];
 const build=()=>{const currentGeneration=++generation;return buildApp(cfg,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{
  active++;maxActive=Math.max(maxActive,active);
  const bridge=await startBridge(node.featureServices.archiveReader,input,16);
  const tool=async(name:string,args:Record<string,unknown>)=>{const response=await fetch(bridge.url+'/'+name,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;};
  try{
   if(input.question==='Generated independent query after research cancellation')return plain('Generated independent answer');
   if(input.hostControlChannel){
    fragments++;const work=input.taskContext!.delegation as {units:{id:string;status:string;artifactId?:string}[]};
    if(!work.units.length){
     const available=await tool('delegation_capabilities',{});assert.ok(available.data.capabilities.some((entry:{id:string})=>entry.id==='context.research'));
     const submitted=await tool('delegation_submit',{units:questions.map((question,index)=>({id:'point-'+index,capabilityId:'context.research',title:question,goal:question,input:{question},scope:{evidenceIds:[originals[index].id]}}))});
     assert.equal(submitted.data.units.length,3);
     await tool('delegation_yield',{mode:'all',workspaceJson:JSON.stringify({unresolved:questions,workerIds:submitted.data.units.map((unit:{id:string})=>unit.id)})});throw new AgentYieldError();
    }
    assert.equal(work.units.length,3);assert.ok(work.units.every(unit=>unit.status==='succeeded'));
    assert.throws(()=>parseAnswer(JSON.stringify({answer:'Generated unsupported shortcut',citationIds:originals.map(record=>record.id)}),bridge.records),/not retrieved/,'private handles do not grant original citations');
    for(const [index,unit] of work.units.entries()){
     const opened=await tool('delegation_read',{artifactId:unit.artifactId,evidenceIds:[originals[index].id]});
     assert.equal(opened.evidence.length,1);assert.equal(opened.evidence[0].id,originals[index].id);assert.equal(opened.evidence[0].ocrText,originals[index].text);
     assert.deepEqual(opened.evidence[0].textRange,{start:0,end:originals[index].text.length,total:originals[index].text.length,nextOffset:null});
    }
    return {...parseAnswer(JSON.stringify({answer:'Generated combined research answer '+originals.map(record=>'['+record.id+']').join(' '),citationIds:originals.map(record=>record.id)}),bridge.records),trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
   }
   const index=questions.indexOf(input.question);assert.ok(index>=0);calls[index]++;
   assert.deepEqual(input.evidenceIds,[originals[index].id]);assert.equal(input.deviceId,scope.deviceId);assert.equal(input.after,scope.after);assert.equal(input.before,scope.before);assert.equal(input.timeZone,scope.timeZone);
   assert.equal(input.conversation,undefined);assert.equal(input.taskContext,undefined);assert.equal(input.openingMemories,undefined);assert.equal(input.directImages,undefined);
   const opened=await tool('evidence',{ids:[originals[index].id]});assert.equal(opened.data.length,1);assert.equal(opened.data[0].ocrText,originals[index].text);
   started.push({index,generation:currentGeneration,signal:input.signal!});
   if(mode==='restart'&&currentGeneration===1){
    await new Promise<void>((resolve,reject)=>{const abort=()=>{input.signal!.removeEventListener('abort',abort);reject(input.signal!.reason);};input.signal!.addEventListener('abort',abort,{once:true});gates[index].promise.then(()=>{input.signal!.removeEventListener('abort',abort);resolve();});if(input.signal!.aborted)abort();});
   }else if(mode!=='restart')await gates[index].promise;
   return {...parseAnswer(JSON.stringify({answer:`Generated worker ${index} inspected the original [${originals[index].id}]`,citationIds:[originals[index].id]}),bridge.records),trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies,sourceContextDependencies:bridge.sourceContextDependencies};
  }catch(error){if(!(error instanceof AgentYieldError)&&!input.signal?.aborted)errors.push(error instanceof Error?error.stack??error.message:String(error));throw error;}
  finally{await bridge.close();active--;}
 }}});};
 node=await build();
 t.after(async()=>{for(const gate of gates)gate.release();await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const registered=await node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id:sourceId,name:'Generated research originals',kind:'custom',deviceId:scope.deviceId,platform:'import',retention:'archive'}});assert.equal(registered.statusCode,200,registered.body);
 for(const [index,text] of texts.entries()){
  const uploaded=await node.app.inject({method:'PUT',url:'/api/sources/'+sourceId+'/items',headers,payload:{externalId:'point-'+index,revision:'1',observedAt:original.capturedAt,kind:'message',layer:'original',text}});assert.equal(uploaded.statusCode,200,uploaded.body);originals.push({id:uploaded.json().id,text});
 }
 const main=await node.app.inject({url:'/api/conversations/main',headers});assert.equal(main.statusCode,200,main.body);conversationId=main.json().id;
 const request={conversationId,clientRequestId,question:'Research the generated decision, constraint and outcome',scope:{kind:'selection',sourceIds:[sourceId],...scope}};
 return {get id(){return id;},conversationId,sourceId,originals,calls,started,errors,gates,get node(){return node;},get fragments(){return fragments;},get maxActive(){return maxActive;},
  describe:()=>({...snapshot(node,id),calls,started:started.map(({index,generation})=>({index,generation})),errors}),
  async admit(){const response=await node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:request});assert.equal(response.statusCode,202,response.body);id=response.json().id;await until(()=>node.store.db.prepare('SELECT 1 FROM query_runs WHERE id=?').get(id),this.describe);return response.json();},
  async restart(){await node.app.close();node=await build();},
  async completed(){return until(()=>{const run=node.queryRuns.get(id);return run.status==='completed'?run:undefined;},this.describe);},
 };
}

for(const restart of [false,true])test(`owner HTTP research ${restart?'resumes an interrupted worker while retaining a completed private product':'runs multiple model-selected questions within the actual two-slot limit'}`,async t=>{
 const f=await researchFixture(t,restart?'restart':'parallel');await f.admit();
 if(restart){
  await until(()=>f.started.some(call=>call.index===0)?true:undefined,f.describe);f.gates[0].release();
  await until(()=>f.started.some(call=>call.index===1)?true:undefined,f.describe);assert.deepEqual(f.calls,[1,1,0]);
  const first=f.node.delegation.get('query:'+f.id).units[0];assert.equal(first.status,'succeeded');const product=f.node.store.db.prepare('SELECT * FROM delegation_artifacts WHERE unit_id=?').get(first.id);assert.ok(product);
  await f.restart();const run=await f.completed();assert.equal(run.status,'completed');assert.deepEqual(f.calls,[1,2,1]);assert.deepEqual(f.node.store.db.prepare('SELECT * FROM delegation_artifacts WHERE unit_id=?').get(first.id),product,'the completed encrypted product is reused byte for byte');
 }else{
  await until(()=>f.started.length===2?true:undefined,f.describe);assert.deepEqual(f.calls,[1,1,0]);assert.equal(f.node.delegation.get('query:'+f.id).units[2].status,'waiting');for(const gate of f.gates)gate.release();await f.completed();assert.deepEqual(f.calls,[1,1,1]);
 }
 assert.equal(f.maxActive,restart?1:2);assert.equal(f.fragments,2);assert.deepEqual(f.errors,[]);
 const work=f.node.delegation.get('query:'+f.id),run=f.node.queryRuns.get(f.id);assert.equal(work.status,'succeeded');assert.equal(work.units.length,3);assert.ok(work.units.every(unit=>unit.status==='succeeded'&&unit.attempts===1));assert.equal(f.node.delegation.artifactMetadata(work.id).length,3);
 assert.equal(work.events.filter(event=>event.type==='branch.completed').length,3);for(const unit of work.units)assert.equal(f.node.modelAuthorization.stepAuthority(unit.stepId),'owner-query:'+f.id);
 const saved=(await f.node.app.inject({url:'/api/conversations/'+run.conversationId,headers})).json();assert.equal(saved.turnCount,1);const result=saved.turns[0].result;
 assert.deepEqual(new Set(result.citations.map((citation:{id:string})=>citation.id)),new Set(f.originals.map(record=>record.id)));for(const record of f.originals)assert.equal(result.citations.find((citation:{id:string})=>citation.id===record.id).excerpt,record.text);
 assert.equal(result.originalEvidenceDependencies.complete,true);assert.deepEqual(new Set(result.originalEvidenceDependencies.ids),new Set(f.originals.map(record=>record.id)));
 const members=f.node.store.db.prepare('SELECT * FROM execution_operation_steps WHERE operation_id=? ORDER BY step_id').all(work.operationId);await f.admit();for(let replay=0;replay<3;replay++)await f.node.delegation.tick();assert.deepEqual(f.node.store.db.prepare('SELECT * FROM execution_operation_steps WHERE operation_id=? ORDER BY step_id').all(work.operationId),members);assert.equal(f.node.conversations.get(run.conversationId!).turns.length,1);
});

for(const revoke of [false,true])test(`owner HTTP ${revoke?'source read withdrawal':'research cancellation'} fences two active workers, queued research and late products across restart`,async t=>{
 const f=await researchFixture(t,revoke?'revoke':'cancel');await f.admit();await until(()=>f.started.length===2?true:undefined,f.describe);assert.deepEqual(f.calls,[1,1,0]);
 const action=await f.node.app.inject({method:revoke?'PATCH':'POST',url:revoke?'/api/sources/'+f.sourceId:'/api/conversations/'+f.conversationId+'/messages/'+f.id+'/cancel',headers,payload:revoke?{enabled:false}:{}});assert.equal(action.statusCode,200,action.body);
 if(!revoke){assert.equal(action.json().status,'cancelled');assert.ok(f.started.every(call=>call.signal.aborted));}
 for(const gate of f.gates)gate.release();
 const run=await until(()=>{const current=f.node.queryRuns.get(f.id);return current.status!=='running'?current:undefined;},f.describe);assert.equal(run.status,revoke?'failed':'cancelled');
 await until(()=>f.node.featureServices.agentGate.snapshot().active===0?true:undefined,f.describe);await f.node.delegation.tick();assert.deepEqual(f.calls,[1,1,0]);assert.equal(f.fragments,1);
 const work=f.node.delegation.get('query:'+f.id);assert.ok(work.units.every(unit=>['cancelled','failed','stale'].includes(unit.status)));if(!revoke)assert.ok(work.units.every(unit=>unit.status==='cancelled'));assert.equal(f.node.delegation.artifactMetadata(work.id).length,0);assert.equal(f.node.delegation.result(work.id),undefined);
 const saved=(await f.node.app.inject({url:'/api/conversations/'+f.conversationId,headers})).json(),message=saved.turns.find((turn:{id:string})=>turn.id===f.id);assert.ok(message);assert.equal(message.status,revoke?'failed':'cancelled');assert.equal(message.result,undefined);assert.ok(!JSON.stringify(saved).includes('Generated worker'));
 const progress=(await f.node.app.inject({url:'/api/operations/'+encodeURIComponent(work.operationId)+'?limit=100',headers})).json();assert.equal(progress.operation.state,revoke?'failed':'cancelled');if(!revoke)assert.equal(progress.operation.counts.cancelled,3);
 for(const record of f.originals)assert.equal((await f.node.app.inject({url:'/api/captures/'+record.id,headers})).statusCode,200,'owner archive remains available after cancellation or read withdrawal');
 await f.restart();await f.admit();for(let replay=0;replay<3;replay++)await f.node.delegation.tick();assert.equal(f.node.queryRuns.get(f.id).status,run.status);assert.deepEqual(f.calls,[1,1,0]);assert.equal(f.node.delegation.artifactMetadata(work.id).length,0);
 if(!revoke){const next=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated independent query after research cancellation'}});assert.equal(next.statusCode,200,next.body);assert.equal(next.json().answer,'Generated independent answer');assert.equal(f.node.queryRuns.get(f.id).status,'cancelled');}
});


for(const restart of [false,true])test(`full app delegation ${restart?'resumes after restart without repeating a successful child':'yields its only slot and saves an answer citing the original receipt'}`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-delegated-query-app-')),id=randomUUID();
 let node:Awaited<ReturnType<typeof buildApp>>,childCalls=0,active=0,maxActive=0,coordinatorCalls=0,heldResume=false,readCalls=0,initialFingerprint:string|undefined,standingId:string,ordinaryId:string;
 const observed:QueryInput[]=[],order:string[]=[],queryPins:{profileId?:string;model?:string}[]=[];
 const fixtureFactory=(holdResume:boolean):ModelAgentFactory=>async(settings,_reader,_host,identity)=>{
  const agent=fixtureAgent(holdResume),profileId=identity?.id;
  return {...agent,query:async input=>{queryPins.push({profileId,model:settings.model});return agent.query(input);}};
 };
 const fixtureAgent=(holdResume:boolean):QueryAgent=>({configured:true,close:async()=>{},query:async input=>{
  active++;maxActive=Math.max(maxActive,active);observed.push(input);
  try{
   if(!input.hostControlChannel){
    // Finish the child after the parent's yielded fragment has really committed.
   await until(()=>node.delegation.get('query:'+id).status==='waiting'&&node.executor.get('query:'+id+':coordinator:1')?.state==='succeeded'?true:undefined,()=>snapshot(node,id));
    childCalls++;order.push('child');assert.equal(input.question,'Inspect the generated original');assert.equal(input.deviceId,scope.deviceId);assert.equal(input.after,scope.after);assert.equal(input.before,scope.before);
    assert.equal(input.conversation,undefined);assert.equal(input.taskContext,undefined);assert.equal(input.openingMemories,undefined);assert.equal(input.directImages,undefined);
    const records=await node.featureServices.archiveReader.evidence({ids:[original.id],deviceId:input.deviceId,after:input.after,before:input.before});assert.equal(records.length,1);
    const receipt=originalEvidenceReceipt(records[0],0,original.ocrText.length);input.onEvidence?.([receipt]);
    return {...parseAnswer(JSON.stringify({answer:`Generated child found the local archive choice [${original.id}]`,citationIds:[original.id]}),new Map([[receipt.id,receipt]])),trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[original.id]}};
   }
   coordinatorCalls++;order.push('coordinator');const controls=input.hostControlChannel,delegation=input.taskContext!.delegation as {revision:number;units:{id:string;status:string;artifactId?:string}[]};
   assert.ok(input.openingMemories?.some(memory=>memory.id===standingId&&memory.contextPriority==='standing'),'standing context survives parent workspace continuation and restart');
   if(!delegation.units.length){
    assert.ok(input.openingMemories?.some(memory=>memory.id===ordinaryId),'ordinary context is available in the initial fragment');
    const submitted=await controls.execute('delegation_submit',{units:[{id:'original',capabilityId:'context.research',title:'Check the generated original',goal:'Read the scoped source',input:{question:'Inspect the generated original'},scope:{deviceId:scope.deviceId,after:scope.after,before:scope.before}}]});
    assert.equal((submitted.data as {units:unknown[]}).units.length,1);assert.equal(childCalls,0,'submission must immediately return a handle without waiting for the child');
    const yielded=await controls.execute('delegation_yield',{mode:'all',message:'Wait for the generated original check',workspaceJson:JSON.stringify({unresolved:['Check the generated local archive choice'],workerIds:[`query:${id}:unit:original`],searches:[{tool:'material_catalog',query:'local archive'}]})});assert.equal(yielded.yield,true);throw new AgentYieldError();
   }
   assert.equal(delegation.units[0].status,'succeeded');assert.ok(delegation.units[0].artifactId);
   assert.deepEqual(input.openingMemories?.map(memory=>memory.id),[standingId],'workspace continuation retains explicit standing context without replaying ordinary samples');
   const workspace=input.taskContext!.queryWorkspace as {revision:number;unresolved:string[];supported:unknown[];citationAuthority:boolean};assert.equal(workspace.citationAuthority,false);assert.equal(workspace.unresolved[0],'Check the generated local archive choice');
   if(holdResume){await controls.execute('delegation_workspace',{workspaceJson:JSON.stringify({unresolved:workspace.unresolved,supported:[{statement:'Generated child inspected the local archive choice',evidenceIds:[original.id]}],inspected:[{id:original.id,start:0,end:original.ocrText.length}],workerIds:[delegation.units[0].id]})});heldResume=true;await new Promise<void>(resolve=>input.signal!.addEventListener('abort',()=>resolve(),{once:true}));throw input.signal!.reason;}
   const bridge=await startBridge(node.featureServices.archiveReader,input,12);
   try{
   assert.throws(()=>parseAnswer(JSON.stringify({answer:'Historical workspace claim',citationIds:[original.id]}),bridge.records),/not retrieved/,'restored workspace/child IDs do not seed a fresh ledger');
   const response=await fetch(bridge.url+'/delegation_read',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({artifactId:delegation.units[0].artifactId,evidenceIds:[original.id]})});assert.equal(response.status,200);const wire=await response.json() as {data:{text:string};evidence:import('@mote/agent').ContextRecord[]};
   const result={data:wire.data,evidence:wire.evidence};readCalls++;
   assert.equal(result.evidence?.length,1);assert.equal(result.evidence![0].ocrText,original.ocrText);assert.deepEqual(result.evidence![0].textRange,{start:0,end:original.ocrText.length,total:original.ocrText.length,nextOffset:null});
   assert.match((result.data as {text:string}).text,/Generated child found/);
   input.onEvidence?.(result.evidence!);
   if(restart){assert.equal(workspace.revision,2);assert.equal(workspace.supported.length,1);}
   return {...parseAnswer(JSON.stringify({answer:`Generated final answer grounded in the original [${original.id}]`,citationIds:[original.id]}),bridge.records),trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies};
   }finally{await bridge.close();}
  }finally{active--;}
 }});
 node=await buildApp(config(directory),{createModelAgent:fixtureFactory(restart),backgroundWorker:false});
 const pinnedProfile=node.modelSettings.select('chat').id,pinnedModel=node.modelSettings.select('chat').settings.model;
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 await node.store.ingest(original);
 const generated=fixtureMemoryResult(node.memories,{...plain(),answer:JSON.stringify({memories:[
  {title:'Generated standing boundary',statement:`Generated project boundary [${original.id}]`,uncertainty:'Generated project only',contextPriority:'standing',evidenceIds:[original.id]},
  {title:'Generated optional context',statement:`Generated optional project detail [${original.id}]`,uncertainty:'Generated optional context',evidenceIds:[original.id]},
 ]}),citations:[{id:original.id,capturedAt:original.capturedAt,appName:'Generated',excerpt:''}]});
 const memories=node.memories.extract(generated,'generated').items.map(memory=>node.memories.publish(memory.id,memory.version));
 standingId=memories[0].id;ordinaryId=memories[1].id;
 // Admit through owner HTTP, then pump from an ordinary worker context.
 // A timer must not accidentally borrow the HTTP caller's model authority.
 const scheduled=t.mock.method(node.executor,'tick',async()=>{});
 const accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Research the generated project choice',...scope}}});scheduled.mock.restore();assert.equal(accepted.statusCode,202,accepted.body);
 void node.executor.tick();
 if(restart){
  await until(()=>heldResume?true:undefined);assert.equal(childCalls,1);assert.equal(node.delegation.artifactMetadata('query:'+id).length,1);
  const pinned=node.delegation.journal.payload<{prepared?:{modelProfileId?:string;modelOverride?:string};configurationFingerprint?:string}>('query:'+id);assert.equal(pinned.prepared?.modelProfileId,pinnedProfile);assert.equal(pinned.prepared?.modelOverride,pinnedModel);assert.match(pinned.configurationFingerprint??'',/^[a-f0-9]{64}$/);initialFingerprint=pinned.configurationFingerprint;
  await node.app.close();node=await buildApp(config(directory),{createModelAgent:fixtureFactory(false),backgroundWorker:false});
  const restored=node.delegation.journal.payload<{prepared?:{modelProfileId?:string;modelOverride?:string};configurationFingerprint?:string}>('query:'+id);assert.equal(restored.prepared?.modelProfileId,pinnedProfile);assert.equal(restored.prepared?.modelOverride,pinnedModel);assert.equal(restored.configurationFingerprint,initialFingerprint,'the restart rehydrates the accepted model pin');
 }
 const run=await until(()=>{const receipt=node.queryRuns.get(id);return receipt.status==='completed'?receipt:undefined;},()=>snapshot(node,id));
 assert.equal(childCalls,1);assert.equal(maxActive,1);assert.equal(readCalls,1);assert.equal(coordinatorCalls,restart?3:2);assert.deepEqual(order.slice(0,3),['coordinator','child','coordinator']);
 assert.ok(queryPins.length>=2&&queryPins.every(pin=>pin.profileId===pinnedProfile&&pin.model===pinnedModel),'every parent and child fragment keeps the accepted runtime and model pin '+JSON.stringify({pinnedProfile,pinnedModel,queryPins}));
 if(restart)assert.equal(node.delegation.journal.payload<{configurationFingerprint?:string}>('query:'+id).configurationFingerprint,initialFingerprint);
 const conversation=(await node.app.inject({url:'/api/conversations/'+run.conversationId,headers})).json();assert.equal(conversation.turnCount,1);assert.equal(conversation.turns[0].result.citations[0].id,original.id);assert.equal(conversation.turns[0].result.citations[0].excerpt,original.ocrText);
 const work=node.delegation.get('query:'+id);assert.equal(work.status,'succeeded');assert.equal(work.units.length,1);assert.equal(work.units[0].attempts,1);assert.equal(work.events.filter(event=>event.type==='branch.completed').length,1);
 assert.ok(!JSON.stringify(run).includes('Generated child inspected'));assert.ok(!JSON.stringify(run).includes('Check the generated local archive choice'));
 const activity=(await node.app.inject({url:'/api/work-activity/'+encodeURIComponent('query:'+id),headers})).json();assert.equal(activity.state,'completed');assert.equal(activity.branches[0].state,'completed');assert.ok(activity.artifacts.some((artifact:{kind:string})=>artifact.kind==='answer'));assert.ok(activity.events.some((event:{type:string})=>event.type==='branch.completed'));
 assert.equal(observed.filter(input=>!input.hostControlChannel).length,1);
});

test('a retryable provider attempt never writes a failed conversation before the successful answer',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-query-attempt-history-'));let calls=0;
 const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>{calls++;if(calls===1)throw new ProviderFailure({category:'transient',code:'provider_unavailable',retryAfterMs:1});return plain();}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),response=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated retryable question'}}});assert.equal(response.statusCode,202,response.body);
 const receipt=await until(()=>{const run=node.queryRuns.get(id);return run.status==='completed'?run:undefined;});assert.equal(calls,2);
 const conversation=(await node.app.inject({url:'/api/conversations/'+receipt.conversationId,headers})).json();assert.equal(conversation.turnCount,1);assert.equal(conversation.status,'completed');assert.equal(node.store.db.prepare('SELECT count(*) n FROM conversation_turns').get()!.n,1);
});

test('durable query metadata omits model-authored progress prose while retaining execution fields',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-query-private-progress-')),secret='Generated private detail in a model progress update';
 const node=await buildApp(config(directory),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{input.onProgress?.({stage:'model',message:secret,step:2});input.onProgress?.({stage:'tool',tool:'evidence',phase:'completed',count:1});return plain();}}});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID(),accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:{id,input:{question:'Generated progress privacy question'}}});assert.equal(accepted.statusCode,202,accepted.body);
 const run=await until(()=>{const receipt=node.queryRuns.get(id);return receipt.status==='completed'?receipt:undefined;});
 const raw=String(node.store.db.prepare('SELECT json FROM query_runs WHERE id=?').get(id)!.json);assert.ok(!raw.includes(secret));assert.ok(run.events.every(event=>event.message===undefined));assert.ok(run.events.some(event=>event.stage==='model'&&event.step===2));assert.ok(run.events.some(event=>event.tool==='evidence'&&event.phase==='completed'&&event.count===1));
});

test('real Coding HTTP intake and durable query can deliver citable material originals and finish without a worker',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-direct-material-query-'));let node:Awaited<ReturnType<typeof buildApp>>,calls=0;
 const agent:QueryAgent={configured:true,close:async()=>{},query:async input=>{
  calls++;const bridge=await startBridge(node.featureServices.archiveReader,input,16);
  const call=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});assert.equal(response.status,200);return response.json();};
  try{
   const catalog=await call('material_catalog',{query:'Generated local archive choice'}),ref=catalog.data.items[0].ref;
   const page=await call('material_read',{ref,length:4000});assert.ok(page.data.sourceEvidence.length>0);
   const delivered=page.data.sourceEvidence.find((record:{ocrText:string})=>record.ocrText.includes('Generated local archive choice'));assert.ok(delivered);
   assert.equal(bridge.records.has(delivered.id),true);assert.equal(bridge.trace.some(row=>row.tool==='evidence'),false,'one material read already delivered the exact formal original');
   return {...parseAnswer(JSON.stringify({answer:`Generated project chose a local archive [${delivered.id}]`,citationIds:[delivered.id]}),bridge.records),trace:bridge.trace,runId:randomUUID(),evidenceDependencies:bridge.evidenceDependencies};
  }finally{await bridge.close();}
 }};
 node=await buildApp(config(directory),{agent,backgroundWorker:false});t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const source='generated-coding-direct';assert.equal((await node.app.inject({method:'POST',url:'/api/sources',headers,payload:{id:source,name:'Generated Coding',kind:'coding-agent',deviceId:scope.deviceId,platform:'macos'}})).statusCode,200);
 const upload=await node.app.inject({method:'PUT',url:`/api/sources/${source}/items`,headers,payload:{externalId:'event-one',revision:'1',observedAt:original.capturedAt,kind:'message',layer:'snapshot',text:'Generated local archive choice: use SQLite for the sample project.',document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'generated-session',projectKey:'generated-project',eventId:'000001',role:'user',attribution:'human',part:0,parts:1}}}});assert.equal(upload.statusCode,200,upload.body);
 await node.sourcePipelines.tick();
 const id=randomUUID(),request={id,input:{question:'Why did the generated project choose the local archive?',...scope}},accepted=await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:request});assert.equal(accepted.statusCode,202,accepted.body);
 const run=await until(()=>{const receipt=node.queryRuns.get(id);return receipt.status==='completed'?receipt:undefined;});assert.equal(calls,1);assert.equal(node.delegation.get('query:'+id).units.length,0);
 const saved=(await node.app.inject({url:'/api/conversations/'+run.conversationId,headers})).json();assert.match(saved.turns[0].result.citations[0].excerpt,/Generated local archive choice/);assert.equal(saved.turns[0].result.trace.some((row:{tool:string})=>row.tool==='evidence'),false);
 assert.equal((await node.app.inject({method:'POST',url:'/api/query-runs',headers,payload:request})).json().status,'completed');assert.equal(calls,1,'same durable HTTP ID is idempotent');
});
