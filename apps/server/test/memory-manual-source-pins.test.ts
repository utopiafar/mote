import {fixtureMemoryPipeline} from './fixtures/memory-result.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore} from '../src/materials.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {MemoryPipeline,type MemoryPipelineQuery} from '../src/memory-pipeline.js';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {reviewMemory} from '../src/memory-review.js';

for(const phase of ['queued','running'] as const)test(`manual archive selection rejects a new original before organization while ${phase}`,{timeout:10000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-manual-source-pin-')),store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);
 let pipeline:MemoryPipeline|undefined,release!:()=>void,entered!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 t.after(async()=>{release();await pipeline?.close();await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
 await runtime.ready;const sources=new SourceStore(store,runtime),reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials,runtime),strategies=new MemoryStrategies();
 const recipe={id:'fixture.coding-input',version:'1'};strategies.registerRecipe({...recipe,requires:['conversation'],extract:{id:'mote.context-extraction',version:'3.4.0'},review:{id:'mote.coding-review',version:'2'}});
 sources.register({id:'generated-coding',name:'Generated Coding',kind:'coding-agent',deviceId:'fixture',platform:'macos'});
 const event=(index:number)=>({externalId:'event-'+index,revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'snapshot',text:'Generated observation '+index,document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'fixture-session',projectKey:'fixture-project',eventId:String(index),role:'user',part:0,parts:1}}});
 await sources.upsert('generated-coding',event(1));await runtime.tick();const material=materials.list().items[0],calls:MemoryPipelineQuery[]=[];
 const query=async(input:MemoryPipelineQuery)=>{calls.push(input);entered();if(phase==='running')await held;return {answer:'{"memories":[]}',citations:[],trace:[],runId:'fixture'};};
 pipeline=fixtureMemoryPipeline({store,memories:reader.memories,strategies,configured:()=>true,model:()=> 'fixture',query,review:(input,result)=>reviewMemory(input,result,query),materialInput:(ref,required)=>materials.input(ref,required),materialAllowedForMemory:(ref,_profile,required)=>reader.materialAllowedForMemory(ref,undefined,required),materialPlanAllowed:id=>reader.materialPlanAllowed(id),materialSourceCurrent:(pin,id)=>reader.materialSourceCurrent(pin,id)});
 const selected=reader.memoryPlanSelection({},[strategies.resolve(recipe).binding]);assert.equal(selected.manualPlans[0].sourcePin.kind,'archive-group');
 const job=pipeline.create({recipes:[recipe],evidenceIds:selected.evidenceIds,manualPlans:selected.manualPlans});
 if(phase==='queued')pipeline.pause(job.id);else {void pipeline.run(job.id);await started;}
 await sources.upsert('generated-coding',event(2));
 assert.equal(materials.get(material.id)!.ref,material.ref,'organizer has not updated the Material');
 assert.equal(materials.input(material.ref,['conversation'])!.ready,true,'old derived input remains readable');
 assert.equal(reader.materialSourceCurrent(selected.manualPlans[0].sourcePin,material.id),false,'original archive group changed');
 if(phase==='queued')pipeline.resume(job.id);else release();
 const result=await pipeline.run(job.id);assert.equal(result.status,'failed');assert.equal(result.batches[0].status,'invalidated');assert.equal(result.batches[0].errorCode,'evidence_changed');assert.equal(calls.length,phase==='queued'?0:1);
 assert.equal(store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0,'stale result cannot publish a completed checkpoint');
});
