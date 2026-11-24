import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {ConfigurationPlatformOptions} from '../src/config.js';
import {createModelEvidenceAuthority} from '../src/model-evidence-authority.js';
import {resolveDependencies} from '../src/conversation-lineage.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {assertMemoryImageGrants} from '../src/memory-image-grants.js';
import {SourceContextStore} from '../src/source-context.js';
import {openingMemoryLead} from '../src/opening-memory.js';

const cfg=(dataDir:string):ConfigurationPlatformOptions=>({path:(dataDir)+'/mote.yaml',privateCredential:{token:'generated-model-authority-owner',tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:dataDir,maxExportBytes:1_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{level:'silent'}}});
async function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-authority-usecase-')),node=await buildApp(cfg(directory),{backgroundWorker:false});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const resolveLineage=t.mock.fn((value:Parameters<typeof resolveDependencies>[1])=>resolveDependencies(node.store,value));
 const authority=createModelEvidenceAuthority({resolveLineage,assertImageGrants:(inputs,images)=>assertMemoryImageGrants(node.store,inputs,images),reader:node.featureServices.evidenceReader,conversations:node.conversations,sourceContexts:new SourceContextStore(node.store),authorization:node.modelAuthorization,host:node.modelAuthorizationHost,readEvidence:ids=>node.memories.readEvidence(ids)});
 const add=async()=>{const id=randomUUID();await node.store.ingest({id,deviceId:'generated',deviceName:'Generated fixture',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated authority corpus '+id});return id;};
 const publish=async(id:string)=>{
  const original=node.memories.readEvidence([id])[0];
  const result=fixtureMemoryResult(node.memories,{answer:JSON.stringify({memories:[{title:'Generated scoped Memory',statement:'Generated derived claim ['+id+']',uncertainty:'Generated only',evidenceIds:[id]}]}),citations:[{id,capturedAt:original.capturedAt,appName:original.appName,excerpt:original.ocrText}],trace:[],runId:randomUUID()});
  const draft=node.memories.extract(result,'generated').items[0];
  const response=await node.app.inject({method:'POST',url:'/api/memories/'+draft.id+'/publish',headers:{authorization:'Bearer generated-model-authority-owner'},payload:{version:draft.version}});
  assert.equal(response.statusCode,200,response.body);
  return node.memories.get(draft.id);
 };
 return {node,authority,add,publish,resolveLineage};
}

test('model authority rejects a stale exact selection and incomplete retained context using real lineage',async t=>{
 const {node,authority,add}=await fixture(t),id=await add();
 const input:QueryInput={question:'Generated exact selection',executionLane:'interactive',evidenceIds:[id]};
 const records=authority.selectedQueryEvidence(input);assert.equal(records.length,1);assert.equal(records[0].id,id);authority.assert(input);
 assert.throws(()=>authority.assert({question:'Generated retained summary',taskContext:{previousSummary:'Generated summary from an earlier run'},contextEvidenceDependencies:{version:1,complete:false,ids:[id]}}),{code:'context_lineage_incomplete'});
 node.store.delete(id);assert.throws(()=>authority.assert(input),{code:'context_evidence_restricted'});
});

test('an admitted manual disclosure resolves current lineage once at each authority check',async t=>{
 const {node,authority,add,resolveLineage}=await fixture(t),id=await add();
 const input:QueryInput={question:'Generated current evidence',contextEvidenceDependencies:{version:1,complete:true,ids:[id]}};
 await node.modelAuthorizationHost.manual('generated-lineage-check',node.featureServices.availableModelConnections(),async()=>{
  authority.assert(input);
  assert.equal(resolveLineage.mock.callCount(),1,'manual disclosure has no automatic source exclusions to resolve');
  node.store.delete(id);
  assert.throws(()=>authority.assert(input),{code:'context_evidence_restricted'});
  assert.equal(resolveLineage.mock.callCount(),2,'a fresh check still sees evidence withdrawal');
 });
});

test('async authority rechecks permissions after yielding between dependency pages',async t=>{
 const {node,authority,add,publish}=await fixture(t),ids:string[]=[];for(let index=0;index<257;index++)ids.push(await add());
 const checking=authority.assertAsync({question:'Generated paged authority check',contextEvidenceDependencies:{version:1,complete:true,ids}});
 node.store.delete(ids.at(-1)!);await assert.rejects(checking,{code:'context_evidence_restricted'});
 const originalId=ids[0],memory=await publish(originalId);node.store.delete(originalId);
 const retained:QueryInput={question:'Generated paged retained claim',contextEvidenceDependencies:{version:1,complete:true,ids:[...ids.slice(0,-1),memory.id]}};
 await authority.assertAsync(retained);authority.assert(retained);
 assert.ok(node.featureServices.evidenceReader.contextDependencyGroups(retained.contextEvidenceDependencies!.ids).some(group=>group.includes(memory.id)&&group.includes(originalId)),'a 256-member yield must not separate a released original from its one authorized card');

});

for(const change of ['original deletion','source pause','source reference'] as const)test(`PF2F ${change} preserves only eligible owner-chat Memory leads at the model boundary`,async t=>{
 const {node,authority,publish}=await fixture(t),sourceId='generated-memory-lead-source';
 node.sources.register({id:sourceId,name:'Generated Memory lead source',kind:'custom',deviceId:'generated',platform:'import'});
 const original=await node.sources.upsert(sourceId,{externalId:'generated-item',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated model lead original'});
 const memory=await publish(original.id),lead=openingMemoryLead(memory);assert.ok(lead);
 const operationId='query:'+randomUUID();
 const input:QueryInput={question:'Generated question prepared with a Memory lead',executionLane:'interactive',traceContext:{operationId},openingMemories:[lead],contextEvidenceDependencies:{version:1,complete:true,ids:[memory.id,original.id]}};
 authority.assert(input);await authority.assertAsync(input);
 if(change==='original deletion')assert.deepEqual(node.store.delete(original.id),{deleted:1});
 else node.sources.update(sourceId,change==='source pause'?{enabled:false}:{retention:'reference'});
 const reader=node.featureServices.evidenceReader;
 assert.equal(reader.currentMemoryLeadsAllowed(input.openingMemories!),false);
 assert.throws(()=>authority.assert(input),{code:'context_evidence_restricted'});
 await assert.rejects(authority.assertAsync(input),{code:'context_evidence_restricted'});
 await node.modelAuthorizationHost.manual('owner-'+operationId,node.featureServices.availableModelConnections(),async()=>{
  if(change!=='original deletion'){
   authority.assert(input);await authority.assertAsync(input);
   const scoped={...input,sourceIds:[sourceId]};
   assert.throws(()=>authority.assert(scoped),{code:'context_evidence_restricted'});
   await assert.rejects(authority.assertAsync(scoped),{code:'context_evidence_restricted'});
   assert.deepEqual(node.store.delete(original.id),{deleted:1});
  }
  assert.throws(()=>authority.assert(input),{code:'context_evidence_restricted'});
  await assert.rejects(authority.assertAsync(input),{code:'context_evidence_restricted'});
 });
});

test('original-only model preparation yields before reading a withdrawn exact selection',async t=>{
 const {node,authority,add}=await fixture(t),id=await add();
 const input:QueryInput={question:'Generated original-only selection',executionLane:'interactive',evidenceIds:[id]};
 assert.equal(authority.selectedQueryEvidence(input).length,1);
 let transactionDuring:boolean|undefined;
 const withdrawn=new Promise<void>(resolve=>setImmediate(()=>{transactionDuring=node.store.db.isTransaction;node.store.delete(id);resolve();}));
 await assert.rejects(authority.assertAsync(input),{code:'context_evidence_restricted'}).finally(()=>withdrawn);
 assert.equal(transactionDuring,false,'preparation must yield outside a SQLite transaction');
});

test('a source-list model grant rejects another source and rechecks withdrawal before the next disclosure',async t=>{
 const {node,authority}=await fixture(t),ids:string[]=[];
 for(const sourceId of ['generated-selected','generated-hidden']){
  node.sources.register({id:sourceId,name:sourceId,kind:'custom',deviceId:'generated-device',platform:'import'});
  ids.push((await node.sources.upsert(sourceId,{externalId:'item',revision:'1',observedAt:'2026-10-01T00:00:00Z',kind:'message',layer:'original',text:'Generated authority source original'})).id);
 }
 const grant={sourceIds:['generated-selected']},input={question:'Generated source disclosure',...grant,contextEvidenceDependencies:{version:1 as const,complete:true,ids:[ids[0]]}};
 authority.assert(input);await authority.assertAsync(input);
 assert.throws(()=>authority.assert({...input,contextEvidenceDependencies:{version:1,complete:true,ids:[ids[1]]}}),{code:'context_evidence_restricted'});
 const withdrawn=await node.app.inject({method:'PATCH',url:'/api/sources/generated-selected',headers:{authorization:'Bearer generated-model-authority-owner'},payload:{enabled:false}});assert.equal(withdrawn.statusCode,200,withdrawn.body);
 assert.deepEqual(authority.selectedQuerySources(['generated-selected','generated-missing']),[]);
 assert.throws(()=>authority.assert(input),{code:'context_evidence_restricted'});await assert.rejects(authority.assertAsync(input),{code:'context_evidence_restricted'});
});
