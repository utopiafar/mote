import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContextToolError} from '@mote/agent';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {parameterSchemaSpecToJsonSchema} from '@deepseek-ai/dsh-tools';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {DelegationRuntime,DELEGATION_CONTROL_DEFINITIONS} from '../src/delegation-runtime.js';

const proposal=(id='one')=>({id,capabilityId:'generated.package',title:'Generated branch',goal:'Inspect generated input',input:{members:[id]}});
function fixture(t:any){
 const directory=mkdtempSync(join(tmpdir(),'mote-proposal-lifecycle-')),store=new Store(directory);
 let engine=new ExecutionEngine(store),runtime=new DelegationRuntime(store,engine,{autoPump:false});
 const register=()=>runtime.register({id:'generated.package',version:'1',proposal:true,description:'Generated external proposal',execute:async()=>{throw Error('Product owns this execution');}});
 register();t.after(async()=>{await runtime.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 return {store,get runtime(){return runtime;},get engine(){return engine;},async restart(){await runtime.close();await engine.close();engine=new ExecutionEngine(store);runtime=new DelegationRuntime(store,engine,{autoPump:false});register();}};
}
async function finishPlanning(f:ReturnType<typeof fixture>,id:string){for(let n=0;n<30;n++){await f.runtime.tick();if(f.runtime.get(id).planningComplete||['stale','cancelled','failed'].includes(f.runtime.get(id).status))return;await new Promise(resolve=>setImmediate(resolve));}throw Error('Generated planning did not finish');}
function legacyWait(f:ReturnType<typeof fixture>,id:string){
 f.store.db.prepare("UPDATE delegation_works SET json=json_set(json_remove(json,'$.planningComplete','$.plannedUnitIds'),'$.status','waiting','$.wait',json(?)) WHERE id=?").run(JSON.stringify({unitIds:[id+':unit:one'],mode:'any'}),id);
}

test('proposal yield is rejected before durable wait; the model can finish normally with the same handles',async t=>{
 const f=fixture(t);
 f.runtime.registerCoordinator({id:'generated.plan',awaitExternal:true,execute:async({controls})=>{
  assert.equal(controls.phase,'proposal');await controls.execute('delegation_submit',{units:[proposal()]});
  await assert.rejects(controls.execute('delegation_yield',{mode:'any'}),(error:unknown)=>error instanceof ContextToolError&&error.code==='proposal_not_executable'&&error.recovery==='correct_arguments');
  assert.equal(f.runtime.get('generated-plan').wait,undefined);return 'Complete plan';
 }});
 f.runtime.start({id:'generated-plan',profileId:'generated.plan',goal:'Generated goal',input:{},allowedCapabilities:['generated.package']});await finishPlanning(f,'generated-plan');
 assert.equal(f.runtime.get('generated-plan').planningComplete,true);assert.equal(f.runtime.get('generated-plan').units.length,1);
});

for(const valid of [true,false])test(`restart repairs an old proposal wait with ${valid?'fresh authority and reused handles':'revoked authority and no model call'}`,async t=>{
 const f=fixture(t);let calls=0,allowed=true;
 const profile={id:'generated.plan',awaitExternal:true,validate:()=>allowed,execute:async({work,controls}:any)=>{calls++;if(!work.units.length)await controls.execute('delegation_submit',{units:[proposal()]});else assert.equal(work.units[0].id,work.id+':unit:one');return 'Complete generated plan';}};
 f.runtime.registerCoordinator(profile);f.runtime.start({id:'legacy-plan',profileId:profile.id,goal:'Generated goal',input:{},allowedCapabilities:['generated.package']});await finishPlanning(f,'legacy-plan');legacyWait(f,'legacy-plan');
 await f.restart();allowed=valid;f.runtime.registerCoordinator(profile);await finishPlanning(f,'legacy-plan');
 const work=f.runtime.get('legacy-plan');assert.equal(work.units.length,1);assert.equal(work.wait,undefined);assert.equal(calls,valid?2:1);assert.equal(work.planningComplete??false,valid);
 if(valid){assert.equal(work.revision,2);assert.equal(work.status,'waiting');await f.runtime.tick();assert.equal(calls,2,'repeated ticks must not rerun a recovered fragment');}
 else {assert.equal(work.status,'stale');assert.equal(work.units[0].status,'stale');assert.equal(work.error,'input_changed');}
});

test('a cancelled pre-upgrade plan never resumes or grants its proposals',async t=>{
 const f=fixture(t);let calls=0;
 f.runtime.registerCoordinator({id:'generated.plan',awaitExternal:true,execute:async({controls})=>{calls++;await controls.execute('delegation_submit',{units:[proposal()]});return 'Generated';}});
 f.runtime.start({id:'cancelled-plan',profileId:'generated.plan',goal:'Generated',input:{},allowedCapabilities:['generated.package']});await finishPlanning(f,'cancelled-plan');legacyWait(f,'cancelled-plan');f.runtime.cancel('cancelled-plan');await f.runtime.tick();assert.equal(calls,1);assert.equal(f.runtime.get('cancelled-plan').status,'cancelled');
});

test('disabled automatic admission holds historical recovery until the existing setting is enabled',async t=>{
 const f=fixture(t);let enabled=false,calls=0;
 f.runtime.registerCoordinator({id:'generated.plan',awaitExternal:true,recoveryAllowed:()=>enabled,execute:async({work,controls})=>{calls++;if(!work.units.length)await controls.execute('delegation_submit',{units:[proposal()]});return 'Generated';}});
 f.runtime.start({id:'disabled-plan',profileId:'generated.plan',goal:'Generated',input:{},allowedCapabilities:['generated.package']});await finishPlanning(f,'disabled-plan');legacyWait(f,'disabled-plan');
 await f.runtime.tick();assert.equal(calls,1);assert.equal(f.runtime.get('disabled-plan').revision,1);assert.ok(f.runtime.get('disabled-plan').wait);
 enabled=true;await finishPlanning(f,'disabled-plan');assert.equal(calls,2);assert.equal(f.runtime.get('disabled-plan').planningComplete,true);
});

test('proposal planners can still yield for independently scheduled inspections',async t=>{
 const f=fixture(t);f.runtime.register({id:'generated.inspect',version:'1',description:'Generated inspection',execute:async()=>({value:'Generated sample'})});
 f.runtime.registerCoordinator({id:'generated.plan',awaitExternal:true,execute:async()=>null});
 f.runtime.start({id:'inspect-plan',profileId:'generated.plan',goal:'Generated',input:{},allowedCapabilities:['generated.package','generated.inspect']});
 const controls=f.runtime.controlChannel('inspect-plan');await controls.execute('delegation_submit',{units:[{...proposal('sample'),capabilityId:'generated.inspect'},proposal()]});
 const receipt=await controls.execute('delegation_yield',{unitIds:['inspect-plan:unit:sample']});assert.equal(receipt.yield,true);assert.deepEqual(f.runtime.get('inspect-plan').wait?.unitIds,['inspect-plan:unit:sample']);
});

test('declared bounds compile for both adapters and invalid arguments survive the real HTTP bridge with corrective errors',async t=>{
 const f=fixture(t);let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);f.runtime.registerCoordinator({id:'generated.plan',execute:async()=>{await held;return null;}});
 f.runtime.start({id:'argument-plan',profileId:'generated.plan',goal:'Generated',input:{},allowedCapabilities:['generated.package']});
 const controls=f.runtime.controlChannel('argument-plan');
 try{
 for(const definition of DELEGATION_CONTROL_DEFINITIONS)assert.doesNotThrow(()=>parameterSchemaSpecToJsonSchema(definition.fields as any));
 assert.match(DELEGATION_CONTROL_DEFINITIONS.find(tool=>tool.name==='delegation_submit')!.description,/1–8/);
 const bridge=await startBridge({search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async()=>[],activity:async()=>({}),devices:async()=>[]},{question:'Generated input',hostRetrieval:'none',hostControlChannel:controls},24);t.after(()=>bridge.close());
 const call=async(tool:string,body:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
 for(const [tool,body,message] of [['delegation_submit',{units:Array.from({length:25},(_,i)=>proposal('p'+i))},/1–8/],['delegation_results',{limit:100},/1–30/],['delegation_submit',{units:[{id:'missing',capabilityId:'generated.package',title:'Generated',input:{}}]},/goal/]] as const){
  const response=await call(tool,body);assert.equal(response.status,400);assert.equal(response.body.toolError.code,'invalid_delegation_arguments');assert.equal(response.body.toolError.recovery,'correct_arguments');assert.match(response.body.toolError.message,message);
 }
 assert.equal((await call('delegation_submit',{units:[proposal()]})).status,200);assert.equal((await call('delegation_results',{limit:30})).status,200);
 }finally{release();await finishPlanning(f,'argument-plan');}
});
