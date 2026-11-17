import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProviderFailure} from '@mote/shared';
import {AgentProviderError} from '@mote/agent';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryProviderError} from '../src/memory-provider-contract.js';
import {retainFailureContext} from '../src/execution-failures.js';
import {fixtureMemoryPipeline} from './fixtures/memory-result.js';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';

const empty=()=>({answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()});
async function fixture(t:any){const directory=mkdtempSync(join(tmpdir(),'mote-recovery-policy-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});const record=await sources.upsert('generated',{externalId:'a',revision:'1',text:'Generated original that must retain its exact scope.',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original'});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return {directory,store,memories,record};}
test('typed temporary transport failure resumes the same range automatically within shared recovery',async t=>{
 const f=await fixture(t),inputs:any[]=[];
 const pipeline=fixtureMemoryPipeline({...f,models:{configured:()=>true,model:()=> 'fixture'},phases:{query:async input=>{inputs.push(input);if(inputs.length===1)throw new ProviderFailure({category:'transient',code:'provider_unavailable',retryAfterMs:0});return empty();}}});t.after(()=>pipeline.close());
 const job=pipeline.create({evidenceIds:[f.record.id]}),done=await pipeline.run(job.id);assert.equal(done.status,'completed');assert.equal(inputs.length,2);assert.equal(done.totalBatches,1);assert.deepEqual(inputs[0].evidenceRanges,inputs[1].evidenceRanges);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,1);
});
test('temporary failure stops at the shared three attempts without recursive scope changes',async t=>{
 const f=await fixture(t);let calls=0;
 const pipeline=fixtureMemoryPipeline({...f,models:{configured:()=>true,model:()=> 'fixture'},phases:{query:async()=>{calls++;throw new ProviderFailure({category:'transient',code:'provider_network',retryAfterMs:0});}}});t.after(()=>pipeline.close());
 const done=await pipeline.run(pipeline.create({evidenceIds:[f.record.id]}).id);assert.equal(done.status,'failed');assert.equal(calls,3);assert.equal(done.totalBatches,1);assert.equal(done.batches[0].attempts,3);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
});
for(const [label,error,expected] of [['unknown generic model failure',new AgentProviderError(),'provider_failed'],['real provider context limit',new ProviderFailure({category:'permanent',code:'processing_limit'}),'processing_limit'],['unknown external write',new MemoryProviderError('unknown_result','Generated unknown receipt'),'memory_provider_unknown_result']] as const)test(`${label} is not automatically replayed`,async t=>{
 const f=await fixture(t);let calls=0;
 const pipeline=fixtureMemoryPipeline({...f,models:{configured:()=>true,model:()=> 'fixture'},phases:{query:async()=>{calls++;throw error;}}});t.after(()=>pipeline.close());
 const done=await pipeline.run(pipeline.create({evidenceIds:[f.record.id]}).id);assert.equal(done.status,'failed');assert.equal(calls,1);assert.equal(done.batches[0].errorCode,expected);assert.equal(done.totalBatches,1);assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
});
test('a known temporary review failure reuses the valid draft during automatic recovery',async t=>{
 const f=await fixture(t);let extracts=0,reviews=0;
 const pipeline=fixtureMemoryPipeline({...f,models:{configured:()=>true,model:()=> 'fixture'},phases:{query:async()=>{extracts++;return empty();},review:async(_input,draft)=>{reviews++;if(reviews===1)throw new ProviderFailure({category:'transient',code:'provider_network',retryAfterMs:0});return draft;}}});t.after(()=>pipeline.close());
 const done=await pipeline.run(pipeline.create({evidenceIds:[f.record.id]}).id);assert.equal(done.status,'completed');assert.equal(extracts,1);assert.equal(reviews,2);assert.equal(done.totalBatches,1);
});
for(const phase of ['extract','review'] as const)test(`a terminal generic ${phase} failure retains its trusted not-started fact without replay`,async t=>{
 const f=await fixture(t),runId=randomUUID();let extracts=0,reviews=0;
 const fail=()=>{throw retainFailureContext(new AgentProviderError({category:'transient',code:'provider_failed',executionStarted:false},{source:'runtime',stage:'startup',code:'service_tier_mismatch'}),{runId,phase,causeCode:'service_tier_mismatch'});};
 const pipeline=fixtureMemoryPipeline({...f,models:{configured:()=>true,model:()=> 'fixture'},phases:{query:async()=>{extracts++;if(phase==='extract')fail();return empty();},review:async()=>{reviews++;return fail();}}});t.after(()=>pipeline.close());
 const job=pipeline.create({evidenceIds:[f.record.id]}),done=await pipeline.run(job.id);
 assert.equal(done.status,'failed');assert.equal(done.batches[0].errorCode,'provider_failed');assert.equal(extracts,1);assert.equal(reviews,phase==='review'?1:0);
 const receipt=f.store.db.prepare("SELECT f.json FROM execution_failures f JOIN execution_steps e ON e.id=f.step_id WHERE e.operation_id=? AND e.kind LIKE 'memory.phase.%' AND json_extract(e.input,'$.phase')=?").get('memory:'+job.id,phase);
 assert.ok(receipt);const failure=JSON.parse(String(receipt.json));assert.equal(failure.executionStarted,false);assert.equal(failure.runId,runId);assert.equal(failure.causeCode,'service_tier_mismatch');assert.equal(failure.category,'permanent');assert.equal(failure.attempt,1);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n,0);
});
test('HTTP retry rejects cancelled work during admission instead of swallowing rejection behind 202',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-retry-http-'));const config:ConfigurationPlatformOptions={path:(dir)+'/mote.yaml',privateCredential:{token:'generated-retry-owner-token',tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:dir,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'fixture',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false}}};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>empty()}});t.after(async()=>{await node.app.close();rmSync(dir,{recursive:true,force:true});});
 node.sources.register({id:'generated',name:'Generated',kind:'custom',deviceId:'generated',platform:'import'});const record=await node.sources.upsert('generated',{externalId:'a',revision:'1',text:'Generated original.',observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original'});
 await node.materialOrganizer.tick();const material=node.materials.list({sourceId:'generated'}).items[0];const job=node.memoryPipeline.create({evidenceIds:node.materials.evidenceIds(material.ref)});node.memoryPipeline.cancel(job.id);
 const response=await node.app.inject({method:'POST',url:'/api/memory-jobs/'+job.id+'/retry',headers:{authorization:'Bearer '+config.privateCredential!.token}});assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error,'conflict');assert.equal(node.memoryPipeline.get(job.id).status,'cancelled');
});
