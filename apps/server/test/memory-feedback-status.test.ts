import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {DelegationRuntime} from '../src/delegation-runtime.js';
import {memoryFeedbackBatchId} from '../src/memory-feedback.js';
import {registerMemoryFeedbackStatus} from '../src/memory-feedback-status.js';
import type {MemoryPipeline,MemoryBatch} from '../src/memory-pipeline.js';

test('each feedback group publishes its own completed subtree before another group finishes',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-feedback-group-status-')),store=new Store(directory,{contentEncryptionEnabled:true,dataKey:'ab'.repeat(32)}),engine=new ExecutionEngine(store),runtime=new DelegationRuntime(store,engine,{autoPump:false}),batches:MemoryBatch[]=[];
 const pipeline={feedbackAllowed:()=>true,get:()=>({id:'generated-job',status:'running',batches})} as unknown as MemoryPipeline,unregister=registerMemoryFeedbackStatus({runtime,pipeline});
 t.after(async()=>{await unregister();await runtime.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 runtime.register({id:'memory.feedback-group',version:'1',proposal:true,description:'Generated group',execute:async()=>({value:null})});runtime.registerCoordinator({id:'coordinator',awaitExternal:true,execute:async({controls})=>{await controls.execute('delegation_submit',{units:['first','second'].map(id=>({id,capabilityId:'memory.feedback-group',title:'Generated group',goal:'Inspect this generated target',input:{}}))});return 'Validated plan';}});
 runtime.start({id:'group-work',profileId:'coordinator',goal:'Generated goal',input:{jobId:'generated-job'},allowedCapabilities:['memory.feedback-group']});const planned=await runtime.waitForPlan('group-work'),first=planned.units[0],second=planned.units[1];
 const batch=(id:string,status:MemoryBatch['status'],memoryIds:string[]=[]):MemoryBatch=>({id,index:0,status,evidenceRanges:[],attempts:1,memoryIds});
 batches.push({...batch(memoryFeedbackBatchId(first.id),'completed'),supersededBy:['generated-first-leaf']},batch('generated-first-leaf','pending'),batch(memoryFeedbackBatchId(second.id),'pending'));
 const steps=planned.units.map(unit=>{const stepId=engine.enqueue('group-work','memory.feedback-status',{jobId:'generated-job',workId:planned.id,unitId:unit.id});runtime.linkExternalUnit(planned.id,unit.id,stepId);return stepId;});await runtime.tick();assert.equal(runtime.artifactMetadata(planned.id).length,0,'a superseded parent checkpoint is not its subtree completion');
 batches[1].status='completed';batches[1].memoryIds=['generated-first-memory'];engine.retry(steps[0]);await engine.drain([steps[0]]);await runtime.tick();assert.equal(runtime.get(planned.id).status,'waiting');assert.equal(runtime.unit(first.id).status,'succeeded');assert.equal(runtime.unit(second.id).status,'waiting');
 const product=runtime.journal.artifact<{value:{batchIds:string[];memoryIds:string[]}}>(runtime.unit(first.id).artifactId!);assert.deepEqual(product.value.batchIds,['generated-first-leaf']);assert.deepEqual(product.value.memoryIds,['generated-first-memory']);assert.equal(runtime.artifactMetadata(planned.id).length,1);
 batches[2].status='completed';batches[2].memoryIds=['generated-second-memory'];engine.retry(steps[1]);await engine.drain([steps[1]]);await runtime.tick();assert.equal(runtime.get(planned.id).status,'succeeded');assert.equal(runtime.artifactMetadata(planned.id).length,2);
});

test('a feedback stop is blocked for missing context and never fabricates a product artifact',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-feedback-stop-status-')),store=new Store(directory),engine=new ExecutionEngine(store),runtime=new DelegationRuntime(store,engine,{autoPump:false});
 const pipeline={feedbackAllowed:()=>true,get:()=>{throw Error('A stop reads no product or original');}} as unknown as MemoryPipeline,unregister=registerMemoryFeedbackStatus({runtime,pipeline});t.after(async()=>{await unregister();await runtime.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 runtime.register({id:'memory.feedback-stop',version:'1',proposal:true,description:'Generated stop',execute:async()=>({value:null})});runtime.registerCoordinator({id:'coordinator',awaitExternal:true,execute:async({controls})=>{await controls.execute('delegation_submit',{units:[{id:'stop',capabilityId:'memory.feedback-stop',title:'Missing context',goal:'Wait for an authorized background',input:{reason:'Generated background unavailable'}}]});return 'Input remains missing';}});
 runtime.start({id:'stop-work',profileId:'coordinator',goal:'Generated goal',input:{jobId:'generated-job'},allowedCapabilities:['memory.feedback-stop']});const planned=await runtime.waitForPlan('stop-work'),unit=planned.units[0],stepId=engine.enqueue('stop-work','memory.feedback-status',{jobId:'generated-job',workId:planned.id,unitId:unit.id,stop:true});runtime.linkExternalUnit(planned.id,unit.id,stepId);await engine.drain([stepId]);await runtime.tick();assert.equal(runtime.unit(unit.id).status,'blocked');assert.equal(runtime.unit(unit.id).error,'memory_context_required');assert.equal(runtime.get(planned.id).status,'failed');assert.equal(runtime.artifactMetadata(planned.id).length,0);
});
