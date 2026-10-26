import {authorizeFixtureModels,withFixtureOwnerModelWork} from './fixtures/model-authorization.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {ExecutionEngine} from '../src/execution-engine.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {memoryEvidenceFingerprint} from '../src/memory.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import type {QueryInput} from '@mote/agent';
import {startBridge} from '../../../packages/agent/dist/bridge.js';
import {ServerDiagnostics} from '../src/diagnostics.js';

test('batch Memory guards reuse formal metadata while preserving exact originals and fresh revocation',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-read-batch-')),store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store),reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials),engine=new ExecutionEngine(store);
 engine.tick=async()=>{};
 const pipeline=new MemoryPipeline({store,memories:reader.memories,executor:engine,configured:()=>false,model:()=> 'disabled',query:async()=>{throw Error('No models in this generated guard fixture');}});
 t.after(async()=>{await pipeline.close();await engine.close();store.close();rmSync(directory,{recursive:true,force:true});});
 sources.register({id:'generated-batch-source',name:'Generated source',kind:'custom',deviceId:'generated',platform:'import'});
 const publish=async(key:string,count:number)=>{
  const text=Array.from({length:count},(_,index)=>'Generated '+key+' paragraph '+index+' with exact original text.');
  const original=await sources.upsert('generated-batch-source',{externalId:key,revision:'1',kind:'message',layer:'original',observedAt:'2026-10-13T00:00:00Z',text:text.join('\n')});
  const material=materials.publish({id:materialId('generated-batch-source',key),kind:'mote.note',schemaVersion:1,title:'Generated '+key,origin:{sourceId:'generated-batch-source',externalId:key,deviceId:'generated'},members:[{id:original.id,kind:'capture',ref:'capture:'+original.id}],blocks:text.map((value,index)=>({id:'paragraph-'+index,kind:'text',format:'plain',text:value,memberIds:[original.id]})),coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
  return {original,material,ids:materials.evidenceIds(material.ref)};
 };
 const first=await publish('first',40),second=await publish('second',80),ids=[...first.ids,...second.ids];
 const individual=ids.flatMap(id=>reader.memories.readEvidence([id]));let materialReads=0;
 const get=materials.get.bind(materials);materials.get=(ref)=>{materialReads++;return get(ref);};
 const batch=reader.memories.readEvidence(ids);assert.deepEqual(batch,individual);assert.equal(materialReads,4,'two body revisions and two current attribution contexts are parsed once each');
 const assertCurrentParity=(selected:string[])=>assert.deepEqual([...materials['currentEvidenceIds'](selected)].sort(),[...new Set(selected)].filter(id=>materials.isCurrentEvidence(id)).sort());
 assertCurrentParity([...ids,randomUUID()]);
 assert.deepEqual(reader.memories.readCurrentEvidence(ids),individual);
 let inputs=[materials.input(first.material.ref,['material'])!,materials.input(second.material.ref,['material'])!],fingerprints=Object.fromEntries(batch.map(record=>[record.id,memoryEvidenceFingerprint(record)]));
 const agent=reader.agent({diagnostics:new ServerDiagnostics({directory:join(directory,'logs'),enabled:false}),currentOperation:()=> 'memory',currentMaterialInputs:()=>inputs,currentProcessingEvidence:()=>fingerprints});
 const arguments_={ids};
 assert.equal((await agent.evidence(arguments_)).length,120,'the complete native ID batch keeps canonical Memory authority');
 const bridge=await startBridge(agent,{question:'Generated exact authorized read',evidenceIds:ids,evidenceRanges:batch.map(record=>({id:record.id,offset:0,length:record.ocrText.length}))});
 try{const response=await fetch(bridge.url+'/evidence',{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify({ids:['capture:'+ids.at(-1)]})});assert.equal(response.status,200,'the real bridge normalizes an authorized reference alias');}finally{await bridge.close();}
 assert.equal((await agent.evidence({...arguments_,deviceId:'different-generated-device'})).length,0);
 fingerprints={...fingerprints,[ids[0]]:'0'.repeat(64)};assert.equal((await agent.evidence({ids:[ids[0]]})).length,0,'a changed fingerprint is rejected on the next tool call');
 fingerprints=Object.fromEntries(batch.map(record=>[record.id,memoryEvidenceFingerprint(record)]));
 const frozenInputs=inputs;inputs=inputs.map(pin=>({...pin,fingerprint:'0'.repeat(64)}));assert.equal((await agent.evidence(arguments_)).length,0,'input selection pins are independently revalidated');inputs=frozenInputs;
 const chunks=batch.map(record=>({id:record.id,offset:0,length:record.ocrText.length,fingerprint:memoryEvidenceFingerprint(record),key:record.id}));
 let canonicalReads=0;const read=reader.memories.readEvidence.bind(reader.memories);reader.memories.readEvidence=ids=>{canonicalReads++;return read(ids);};
 assert.equal(pipeline['validMany'](chunks),true);assert.equal(canonicalReads,1,'current resolver and fingerprint checks share one canonical batch');
 const changed=materials.declareContext(first.material.id,first.material.revision,{id:randomUUID(),question:'Who narrated these generated paragraphs?',answer:'The owner described these synthetic paragraphs.'});
 assertCurrentParity(ids);
 assert.equal(pipeline['validMany'](chunks),false,'a new owner declaration is freshly observed by the next guard');
 assert.equal(reader.memories.readCurrentEvidence(first.ids).length,0,'old inactive anchors are still rejected');
 assert.equal((await agent.evidence({ids:first.ids})).length,0,'old processing pins cannot borrow fresh owner attribution');
 const currentIds=materials.evidenceIds(changed.ref),current=reader.memories.readCurrentEvidence(currentIds);assert.equal(current.length,40);assert.ok(current.every(record=>record.attributionContext?.ownerStatements?.[0].answer.includes('synthetic paragraphs')));
 store.delete(second.original.id);assert.equal(reader.memories.readCurrentEvidence(second.ids).length,0,'source deletion cannot reuse a previous call cache');
 assertCurrentParity([...ids,...currentIds]);
 assert.equal((await agent.evidence({ids:second.ids})).length,0);
 materials.retire(changed.id,{expectedRevision:changed.revision});assert.equal(reader.memories.readCurrentEvidence(currentIds).length,0);
 assertCurrentParity([...ids,...currentIds]);
 assert.equal(materials.evidence(currentIds).length,0);assert.equal(materials.evidence(currentIds,true).length,40,'owner archive proof access remains separate from model visibility');
});

test('bulk Formal input validation preserves appended Coding prefixes and rejects invalidated or hidden anchors',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-current-batch-')),store=new Store(directory),materials=new MaterialStore(store);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const firstBlock={id:'section-0',kind:'text' as const,format:'markdown-fragment',text:'Generated first statement',memberIds:['raw']};
 const draft:MaterialDraft={id:materialId('generated-coding','session'),kind:'mote.coding-session',schemaVersion:1,title:'Generated Coding session',origin:{sourceId:'generated-coding',externalId:'session'},members:[{id:'raw',kind:'archive',ref:'archive:generated'}],blocks:[firstBlock],artifacts:[{key:'conversation',state:'ready',blockIds:['section-0']}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
 const first=materials.publish(draft,{codingSnapshot:{checkpoint:'first',appendEpoch:1,headCount:1}}),firstIds=materials.evidenceIds(first.ref);
 const next=materials.publish({...draft,mode:'append',baseRevision:first.revision,reuseBlocks:1,blocks:[{...firstBlock,id:'section-1',text:'Generated second statement'}],artifacts:[{key:'conversation',state:'ready',blockIds:['section-0','section-1']}]},{expectedRevision:first.revision,codingSnapshot:{checkpoint:'next',appendEpoch:1,headCount:2}});
 const ids=materials.evidenceIds(next.ref),parity=()=>assert.deepEqual([...materials['currentEvidenceIds']([...firstIds,...ids,randomUUID()])].sort(),[...new Set([...firstIds,...ids])].filter(id=>materials.isCurrentEvidence(id)).sort());
 assert.equal(ids[0],firstIds[0]);assert.equal(materials.evidence([ids[0]])[0].provenance!.revision,first.revision,'an active appended prefix keeps its immutable original revision');
 parity();assert.equal(materials.input(next.ref,['conversation'])!.ready,true);assert.equal(materials.input(first.ref,['conversation']),undefined);
 store.invalidateMemoryEvidence(firstIds[0]);parity();assert.equal(materials.input(next.ref,['conversation'])!.ready,false);assert.equal(materials['currentEvidenceIds'](ids).has(ids[0]),false);
 // The resolver applies the current head's visibility fence independently of
 // the anchor's immutable origin revision and active interval membership.
 store.db.prepare('UPDATE material_heads SET min_visible_sequence=sequence+1 WHERE id=?').run(next.id);parity();assert.equal(materials['currentEvidenceIds'](ids).size,0);assert.equal(materials.input(next.ref,['conversation']),undefined);
 store.db.prepare('UPDATE material_heads SET min_visible_sequence=sequence WHERE id=?').run(next.id);materials.retire(next.id,{expectedRevision:next.revision});parity();assert.equal(materials['currentEvidenceIds'](ids).size,0);
});

// Functional allowance covers startup and all three complete extraction/review
// journeys under CPU contention, not a product latency target. Real 30s leases,
// 4097 context grants, exact coverage and single attempts remain unchanged.
test('three actual Memory jobs prepare large context grants through the bridge without losing their execution lease',{timeout:240000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-memory-large-bridge-'));
 const config:Config={dataDir:directory,token:'generated-large-memory-owner',tokenPath:'generated',host:'127.0.0.1',port:0,maxStorageBytes:60_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false,memoryConcurrency:3};
 const calls:QueryInput[]=[];
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:async input=>{
  calls.push(input);assert.ok(input.processingMaterialInputs?.length);assert.equal(Object.keys(input.processingEvidence!).length,4097);
  const bridge=await startBridge(reader,input);try{
   const work=input.taskContext!.memoryWork as {members:{key:string;id:string}[]};assert.equal(work.members.length,80);assert.equal(bridge.seedEvidence.length,80);
   assert.equal(new Set(bridge.seedEvidence.map(record=>record.id)).size,80);assert.equal(bridge.deliveredRanges.length,80,'the unread context catalog never becomes initial evidence');
   input.signal!.throwIfAborted();return {runId:randomUUID(),answer:JSON.stringify({memories:[],coverage:work.members.map(member=>({key:member.key,state:'no_candidates',candidateIndexes:[]}))}),citations:[],trace:[],evidenceReadRanges:bridge.deliveredRanges,evidenceDependencies:bridge.evidenceDependencies};
  }finally{await bridge.close();}
 }})});await node.app.ready();await authorizeFixtureModels(node);
 // An admitted fragment must not synchronously resolve the complete original
 // catalog again: slow metadata here can starve the real lease renewal timer.
 const triggers=node.modelAuthorizationHost.evidenceTriggers.bind(node.modelAuthorizationHost);
 t.mock.method(node.modelAuthorizationHost,'evidenceTriggers',(ids:readonly string[])=>{
  assert.ok(!node.modelAuthorization.currentId||ids.length!==4097,'admitted Memory must reuse its authority instead of reparsing all original triggers');
  return triggers(ids);
 });
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 // Use the product organizer lifecycle for this declared generated source
 // shape. Settling intake before granting work excludes revision drift from
 // the concurrent preparation/lease regression.
 node.materialOrganizer.registry.register({id:'generated.paragraphs',version:'1',slot:'source-item',priority:100,exclusive:true,
  select:record=>record.provenance?.sourceId==='generated-large-source'?{sourceId:record.provenance.sourceId,externalId:record.provenance.externalId}:undefined,
  identity:group=>materialId(group.sourceId,group.externalId),build:(reader,group)=>{const record=reader.sourceHead();if(!record)return;
   const paragraphs=record.ocrText.split('\n');return {id:materialId(group.sourceId,group.externalId),kind:'mote.note',schemaVersion:1,title:'Generated large original',origin:{sourceId:group.sourceId,externalId:group.externalId,deviceId:record.deviceId},members:[{id:record.id,kind:'capture',ref:'capture:'+record.id}],blocks:paragraphs.map((text,index)=>({id:'paragraph-'+index,kind:'text',format:'plain',text,memberIds:[record.id]})),artifacts:[{key:'source-body',state:'ready',blockIds:paragraphs.map((_,index)=>'paragraph-'+index)}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
  }});
 node.sources.register({id:'generated-large-source',name:'Generated large originals',kind:'custom',deviceId:'generated',platform:'import'});
 const texts=Array.from({length:4097},(_,index)=>'Generated fact '+index+'.');
 const original=await node.sources.upsert('generated-large-source',{externalId:'large',revision:'1',kind:'message',layer:'original',observedAt:'2026-10-13T00:00:00Z',text:texts.join('\n')});
 while(await node.materialOrganizer.tick()){}
 const material=node.materials.get(materialId('generated-large-source','large'))!;assert.ok(material);assert.equal(material.memberCount,1);assert.equal(node.materials.members(material.ref).items[0].ref,'capture:'+original.id);
 assert.equal(node.materialOrganizer.status().pendingSteps,0);
 const transitions:{kind:string;state:string;attempts:number;error?:string}[]=[],project=node.executor.project.bind(node.executor);
 node.executor.project=id=>{const step=node.executor.get(id);if(step?.kind==='memory.batch')transitions.push({kind:step.kind,state:step.state,attempts:step.attempts,error:step.error});return project(id);};
 const ids=node.materials.input(material.ref,['source-body'])!.evidenceIds;
 const jobs=await Promise.all(Array.from({length:3},(_,index)=>withFixtureOwnerModelWork(node,async()=>node.memoryPipeline.create({evidenceIds:ids,evidenceRanges:ids.slice(index*80,index*80+80).map((id,offset)=>({id,offset:0,length:texts[index*80+offset].length})),contextEvidenceRanges:ids.map((id,offset)=>({id,offset:0,length:texts[offset].length})),recipes:[{id:'mote.personal-memory',version:'5'}]}))));
 const done=await Promise.all(jobs.map(job=>withFixtureOwnerModelWork(node,()=>node.memoryPipeline.run(job.id))));
 assert.equal(node.materials.get(material.id)!.ref,material.ref,'no organizer revision drift occurred after admission');
 assert.ok(done.every(job=>job.status==='completed'),JSON.stringify(done.map(job=>({status:job.status,error:job.errorCode,batches:job.batches.map(batch=>({status:batch.status,error:batch.errorCode}))}))));assert.equal(calls.length,6,'each exact job extracts and independently reviews once; transitions='+JSON.stringify(transitions));
 for(const job of done){assert.equal(job.totalBatches,1);assert.equal(job.batches[0].attempts,1);assert.equal(job.batches[0].coverage!.length,80);}
 assert.equal(node.store.db.prepare("SELECT count(*) n FROM execution_steps WHERE operation_id IN (SELECT 'memory:'||value FROM json_each(?)) AND error='interrupted'").get(JSON.stringify(jobs.map(job=>job.id)))!.n,0);
 assert.equal(transitions.some(step=>step.error==='interrupted'),false,'historical interruptions cannot disappear behind the final projection: '+JSON.stringify(transitions));
});
