import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskRegistry,TASK_DESCRIPTOR_API_VERSION,TASK_OUTPUT_SCHEMA,prepareTaskContext} from '../dist/index.js';
import {assembleHostContext,createHostRunSession} from '../dist/host/run-session.js';
import {createHostOutputProvider} from '../dist/host/output.js';
import {ActiveExecutionBudget} from '../dist/active-budget.js';
import {buildContextEnvelope,taskTools} from '../dist/task-context.js';

const task=(id='generated-task',overrides={})=>({apiVersion:TASK_DESCRIPTOR_API_VERSION,id,version:'1',profile:{output:'answer',retrieval:'archive'},outputSchema:TASK_OUTPUT_SCHEMA,select:()=>true,...overrides});
const skill=(overrides={})=>({apiVersion:TASK_DESCRIPTOR_API_VERSION,id:'generated-skill',name:'generated-skill',version:'3',description:'Generated procedure',content:'Follow only the Host-selected generated procedure.',...overrides});
const input={question:'Generated task',taskSelection:{id:'generated-task',version:'1'}};
function prepare(registry,pack,query=input){
 const dispose=registry.register(pack);
 try{return prepareTaskContext({...query,taskRegistry:registry});}finally{dispose();}
}

test('invalid or duplicate contributions fail preparation instead of falling back to a built-in task',()=>{
 for(const {pack,query,code} of [
  {pack:{tasks:[task(),task()]},code:'duplicate_task'},
  {pack:{tasks:[task('missing-schema',{outputSchema:undefined})]},code:'invalid_task_descriptor'},
  {pack:{tasks:[task(),task('ambiguous-task')],taskSelection:undefined},query:{question:'Generated ambiguous task'},code:'ambiguous_task'},
 ]){
  assert.throws(()=>prepare(new TaskRegistry(),pack,query??input),error=>error?.code===code);
 }
 assert.throws(()=>prepareTaskContext({question:'Generated unknown procedure',skill:'not-installed'}),error=>error?.code==='unknown_skill');
 const registry=new TaskRegistry(),dispose=registry.register({tasks:[task()]});
 for(const taskSelection of [{id:'not-installed',version:'1'},{id:'generated-task',version:'old'},null]){
  assert.throws(()=>prepareTaskContext({question:'Generated invalid selection',taskRegistry:registry,taskSelection}),error=>['unknown_task','task_version_mismatch','invalid_task_selection'].includes(error?.code));
 }
 dispose();
 assert.throws(()=>prepareTaskContext({...input,taskRegistry:registry}),error=>error?.code==='unknown_task');
});

test('a required skill cannot override explicit Host response mode or the selected task scope',()=>{
 const registry=new TaskRegistry();
 registry.register({tasks:[task('bounded-task',{profile:{output:'memory-extraction',retrieval:'none'}})],skills:[skill({responseMode:'memory-extraction'})]});
 const query={question:'Generated bounded task',taskRegistry:registry,taskSelection:{id:'bounded-task',version:'1'},skill:'generated-skill',responseMode:'answer',evidenceIds:['generated-original']};
 const envelope=buildContextEnvelope(query,[]);
 assert.equal(envelope.requiredSkill,'generated-skill');assert.equal(envelope.responseMode,'answer');
 assert.deepEqual(envelope.taskProfile,{output:'memory-extraction',retrieval:'none'});assert.deepEqual(taskTools(query),[]);
 assert.match(envelope.disclosurePolicy,/Archive discovery tools are unavailable/);
});

function hostFixture(engine,query,assembled){
 const requests=[],controller=new AbortController(),scopeIdentity={packageId:'generated',installationId:'generated',instanceId:'generated',activationId:'generated',host:{kind:'central',id:'generated'}};
 const binding=service=>({service:{id:service,apiVersion:'1'},provider:{scope:scopeIdentity,contributionId:service},revision:1});
 const lease=(service,value)=>({binding:binding(service),value,signal:controller.signal,assertCurrent(){controller.signal.throwIfAborted();},async release(){}});
 const model={modelId:'generated-model',modelRevision:1,profileId:'generated-model-profile',profileRevision:1,transport:'generated'};
 const runtime=lease('mote.agent.runtime',{capabilities:{},async prepare(_profile,_model,host){
  host.emit({type:'tools.ready',tools:[]},null);
  return {async run(request){requests.push(request);return {terminal:{kind:'completed'},candidate:{text:JSON.stringify({answer:'Generated answer',citationIds:[]})}};},async repair(request){return this.run(request);},async cancel(){},async close(){}};
 }});
 const profile={binding:runtime.binding,runtimeId:engine,profileId:'generated-runtime-profile',profileRevision:7,assemblyFingerprint:'a'.repeat(64),taskKind:'query',configuration:{}};
 const dependencies={scope:{identity:scopeIdentity,signal:controller.signal,assertCurrent(){controller.signal.throwIfAborted();},defer(){}},identity:{runId:`generated-${engine}`,runtime:{id:engine,revision:1,profileId:profile.profileId,profileRevision:7,assemblyFingerprint:profile.assemblyFingerprint},model},input:query,profile,runtime,model:{...lease('generated.model',{}),selection:model},output:lease('mote.agent.host-output',createHostOutputProvider()),tools:{definitions:[],bindings:[],assertCurrent(){}},budget:{activeTimeoutMs:null},activeBudget:new ActiveExecutionBudget(null),commitFence:{assertCurrent(){}}};
 const evidence={records:new Map(),deliveredRanges:[],imageReadReceipts:[],sourceContextDependencies:[],evidenceDependencies:{version:1,complete:true,ids:[]},trace:[],deliveredCharacters:0};
 return {requests,create:()=>createHostRunSession(dependencies,{systemPrompt:assembled.system,prompt:assembled.prompt,outputSchema:assembled.outputSchema,contextUsage:{...assembled.metrics,toolResults:0},evidence:()=>evidence,async readTool(){throw new Error('No tool expected');},async close(){}})};
}

test('a registered pack reaches DSH and Codex HostRunSession fixtures with identical profile, version and language',async t=>{
 const registry=new TaskRegistry();let disposed=0;
 const dispose=registry.register({tasks:[task('registered-task',{version:'2.4.0',profile:{output:'answer',retrieval:'evidence'}})],skills:[skill()],dispose(){disposed++;}});
 t.after(dispose);
 const query={question:'Generated registered pack',language:'en-US',taskRegistry:registry,taskSelection:{id:'registered-task',version:'2.4.0'},skill:'generated-skill',evidenceIds:['generated-original']};
 const assembled=assembleHostContext(query,[]),envelope=JSON.parse(assembled.prompt);
 assert.equal(envelope.taskId,'registered-task');assert.equal(envelope.taskVersion,'2.4.0');assert.equal(envelope.language,'en-US');
 assert.deepEqual(envelope.taskProfile,{output:'answer',retrieval:'evidence'});assert.equal(envelope.requiredSkill,'generated-skill');
 for(const engine of ['dsh-fixture','codex-fixture']){
  const fixture=hostFixture(engine,query,assembled),session=await fixture.create();
  try{
   const answer=await session.execute();assert.equal(answer.answer,'Generated answer');
   assert.equal(fixture.requests.length,1);assert.equal(fixture.requests[0].prompt,assembled.prompt);assert.deepEqual(fixture.requests[0].outputSchema,TASK_OUTPUT_SCHEMA);
   const received=JSON.parse(fixture.requests[0].prompt);assert.equal(received.taskVersion,envelope.taskVersion);assert.equal(received.language,envelope.language);assert.deepEqual(received.taskProfile,envelope.taskProfile);
  }finally{await session.close();}
 }
 await dispose();await dispose();assert.equal(disposed,1);
});
