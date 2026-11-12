import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {formatArtifactRef,type QueryResult} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft,type MaterialReadPage} from '../src/materials.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {MemoryStore} from '../src/memory.js';
import {UsageLedger} from '../src/usage.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {conversationUnderstandingProcessor} from '../src/conversation-understanding.js';
import {semanticProcessor} from '../src/semantic-extraction.js';
import {AssistantUnderstandingReader} from '../src/assistant-understanding.js';

const model={owner:'models' as const,fingerprint:'a'.repeat(64),revision:1,profileId:'fixture',provider:'openai',model:'generated',configured:true};
const pieces=['Generated owner 2001-01-01T10:00:00Z requests a written plan.\n','Generated middle section remains unread.\n','Generated assistant reports checks passed, but device checks are pending.\n'];
const recordedAt='2001-01-01T10:00:00Z';
const scope={kind:'all' as const};
function result(id:string,answer:unknown):QueryResult{return {answer:JSON.stringify(answer),citations:[{id,capturedAt:recordedAt,appName:'Generated',excerpt:''}],trace:[],runId:'generated-understanding'};}

async function fixture(t:TestContext,coverage:MaterialDraft['coverage']={state:'complete'}){
  const directory=mkdtempSync(join(tmpdir(),'mote-assistant-understanding-'));
  const store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  const runtime=new ProcessingRuntime(store,[],{},Date.now,undefined,materials);
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials);
  const adapter=new AssistantUnderstandingReader(store,materials,reader);
  const memories=new MemoryStore(store,ids=>[...store.evidence(ids),...materials.evidence(ids)],id=>store.isCurrentEvidence(id)||materials.isCurrentEvidence(id));
  t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated-a',kind:'custom',name:'Generated A',deviceId:'device-a',platform:'import'});
  sources.register({id:'generated-b',kind:'custom',name:'Generated B',deviceId:'device-b',platform:'import'});
  const a=await sources.upsert('generated-a',{externalId:'session',revision:'1',observedAt:recordedAt,kind:'message',layer:'original',text:'Generated source membership'});
  const b=await sources.upsert('generated-b',{externalId:'private',revision:'1',observedAt:recordedAt,kind:'message',layer:'original',text:'PRIVATE_GENERATED_OTHER_SOURCE'});
  const body=pieces.join('');
  const draft:MaterialDraft={id:materialId('generated-a','session'),kind:'mote.coding-session',schemaVersion:6,title:'Generated session',
    origin:{sourceId:'generated-a',externalId:'session',deviceId:'device-a',provider:'codex',projectKey:'generated-project',projectIdentity:'workspace',sessionId:'generated-session',firstAt:recordedAt,lastAt:recordedAt},
    blocks:[{id:'section-0',kind:'text',format:'markdown-fragment',text:body,memberIds:['source']}],
    members:[{id:'source',kind:'capture',ref:'capture:'+a.id}],coverage,artifacts:[{key:'conversation',state:'ready'}],
    fidelity:{state:'derived',limitations:['metadata_projected','tools_excluded']},retention:{original:'retained',policy:'keep'}};
  const material=materials.publish(draft),anchor=materials.evidenceIds(material.ref)[0];
  const resolveEvidence=(page:MaterialReadPage)=>{
    const ranges=page.spans.map(span=>({id:span.evidenceId!,offset:span.evidenceOffset!,length:span.pageRange.end-span.pageRange.start}));
    return {records:materials.evidence([...new Set(ranges.map(range=>range.id))]),ranges};
  };
  runtime.registry.register(conversationUnderstandingProcessor({memories,usage:new UsageLedger(store),resolveEvidence,selection:()=>model,query:async input=>{
    const range=input.evidenceRanges![0],quote=body.slice(range.offset,range.offset+range.length),isAssistant=range.offset>=pieces[0].length+pieces[1].length;
    const evidence=[{id:anchor,quote,offset:range.offset}],claim={statement:isAssistant?'Assistant reports checks passed, with device checks pending':'Owner requests a written plan',actor:isAssistant?'assistant':'user',status:isAssistant?'reported_outcome':'request',basis:isAssistant?'assistant_reported':'direct_expression',sourceTime:range.offset===0?recordedAt:null,uncertainty:isAssistant?'Assistant report only':'Generated request',evidence};
    return result(anchor,{summary:isAssistant?'Generated report':'Generated request',evidence,workRecords:[{title:'Generated work',requirements:isAssistant?[]:[claim],constraints:[],decisions:[],results:isAssistant?[claim]:[],validation:[],openItems:[],artifactRefs:[]}],events:[claim],memoryCandidates:[],actionCues:[]});
  }}));
  async function produce(offset:number,length:number){
    const job=runtime.enqueue([{name:'understand',processor:'mote.coding-conversation-understanding',materialInputs:[{ref:material.ref,offset,length}],
      config:{modelFingerprint:model.fingerprint,processingMaterialInputs:[{materialId:material.id,required:['conversation'],fingerprint:'c'.repeat(64),evidenceIds:[anchor]}]}}]).understand;
    await runtime.tick();assert.equal(runtime.engine.get(job)?.state,'succeeded');
    const row=store.db.prepare('SELECT json FROM processing_jobs WHERE id=?').get(job)!;
    const ids=JSON.parse(String(row.json)).outputs as string[];assert.equal(ids.length,1);
    const artifact=store.archive.get(ids[0])!;return {artifact,ref:formatArtifactRef(artifact.id,artifact.revision)};
  }
  return {store,sources,materials,runtime,reader,adapter,memories,a,b,body,draft,material,anchor,produce};
}

test('real persisted conversation products retain original role, reported status and exact sources with no Memory candidates',async t=>{
  const f=await fixture(t);const first=await f.produce(0,pieces[0].length),tailOffset=pieces[0].length+pieces[1].length,tail=await f.produce(tailOffset,pieces[2].length);
  const view=f.adapter.read({ref:f.material.ref,scope});
  assert.equal(view.coverage.extraction.status,'ready');assert.equal(view.coverage.semantic.status,'partial');
  assert.deepEqual(view.coverage.semanticRanges.map(item=>[item.offset,item.length,item.total]),[[0,pieces[0].length,f.body.length],[tailOffset,pieces[2].length,f.body.length]]);
  assert.equal(view.products.length,2);assert.ok(view.products.every(product=>product.memoryCandidates.length===0));
  const firstRead=view.products.find(product=>product.ref===first.ref)!,tailRead=view.products.find(product=>product.ref===tail.ref)!;
  assert.equal(firstRead.events[0].actor,'user');assert.equal(firstRead.events[0].status,'request');assert.equal(firstRead.events[0].sourceTime,recordedAt);
  assert.equal(tailRead.workRecords[0].results[0].actor,'assistant');assert.equal(tailRead.workRecords[0].results[0].basis,'assistant_reported');
  assert.equal(tailRead.workRecords[0].results[0].status,'reported_outcome');assert.equal(tailRead.events[0].sourceTime,null);
  assert.deepEqual(tailRead.sourceEvidence.map(source=>[source.id,source.offset,source.quote]),[[f.anchor,tailOffset,pieces[2]]]);
  assert.equal(f.adapter.readOriginal({ref:f.material.ref,scope,id:f.anchor,offset:pieces[0].length,length:pieces[1].length}).quote,pieces[1]);
  assert.equal(f.memories.list().length,0);
  await f.produce(pieces[0].length,pieces[1].length);
  const complete=f.adapter.read({ref:f.material.ref,scope});assert.equal(complete.coverage.semantic.status,'ready');
  assert.equal(complete.coverage.semanticRanges.length,3);
  const page=f.adapter.read({ref:f.material.ref,scope,limit:1});assert.equal(page.products.length,1);assert.ok(page.nextCursor);assert.equal(page.coverage.semantic.status,'partial');
  const next=f.adapter.read({ref:f.material.ref,scope,limit:1,cursor:page.nextCursor!});assert.notEqual(next.products[0].ref,page.products[0].ref);assert.equal(next.coverage.semantic.status,'partial');
});

test('pending and partial extraction are independent of semantic coverage, and a late body is readable only at its new revision',async t=>{
  const f=await fixture(t);
  const pending=f.materials.publish({...f.draft,blocks:[],coverage:{state:'pending',reason:'processing_pending'},artifacts:[{key:'conversation',state:'pending'}]},{expectedRevision:f.material.revision});
  const before=f.adapter.read({ref:pending.ref,scope});assert.equal(before.coverage.extraction.status,'pending');assert.equal(before.coverage.semantic.status,'pending');assert.deepEqual(before.products,[]);
  const partial=f.materials.publish({...f.draft,coverage:{state:'partial',reason:'missing_page'}},{expectedRevision:pending.revision});
  const partialRead=f.adapter.read({ref:partial.ref,scope});assert.equal(partialRead.coverage.extraction.status,'partial');assert.equal(partialRead.coverage.extraction.reason,'missing_page');assert.equal(partialRead.coverage.semantic.status,'pending');
  const ready=f.materials.publish({...f.draft,title:'Generated completed session'},{expectedRevision:partial.revision});const id=f.materials.evidenceIds(ready.ref)[0];
  assert.throws(()=>f.adapter.read({ref:pending.ref,scope}),{statusCode:404});
  assert.equal(f.adapter.read({ref:ready.ref,scope}).coverage.extraction.status,'ready');
  assert.equal(f.adapter.readOriginal({ref:ready.ref,scope,id,offset:0,length:pieces[0].length}).quote,pieces[0]);
});

test('understanding all available text does not fill a missing source page, and reference materials never become original proof',async t=>{
  const f=await fixture(t,{state:'partial',reason:'missing_page'});await f.produce(0,f.body.length);
  const view=f.adapter.read({ref:f.material.ref,scope});
  assert.equal(view.coverage.extraction.status,'partial');assert.equal(view.coverage.extraction.reason,'missing_page');
  assert.equal(view.coverage.semantic.status,'ready');assert.equal(view.coverage.semantic.reason,'available_material_text_only');
  const reference=f.materials.publish({...f.draft,id:materialId('generated-a','reference'),kind:'mote.file',
    origin:{sourceId:'generated-a',externalId:'reference',deviceId:'device-a',firstAt:recordedAt,lastAt:recordedAt},
    blocks:[{id:'metadata',kind:'text',format:'plain',text:'Generated path metadata',memberIds:['source']}],
    coverage:{state:'complete'},artifacts:[{key:'source-body',state:'unavailable',reason:'original_body_not_collected'}],
    fidelity:{state:'derived',limitations:['original_body_not_collected']}});
  assert.equal(f.adapter.read({ref:reference.ref,scope}).coverage.extraction.status,'unsupported');
  assert.throws(()=>f.adapter.readOriginal({ref:reference.ref,scope,id:f.materials.evidenceIds(reference.ref)[0],offset:0,length:5}),{statusCode:404});
  const metadataOnly=f.materials.publish({...f.draft,id:materialId('generated-a','metadata-only'),kind:'mote.file',
    origin:{sourceId:'generated-a',externalId:'metadata-only',deviceId:'device-a',firstAt:recordedAt,lastAt:recordedAt},
    blocks:[{id:'source-metadata',kind:'text',format:'json',text:'Generated path metadata',memberIds:['source']}],
    coverage:{state:'pending',reason:'processing_pending'},artifacts:[{key:'source-body',state:'unavailable',blockIds:[]},{key:'extracted-text',state:'pending',blockIds:[]}],
    fidelity:{state:'derived'}});
  assert.equal(f.adapter.read({ref:metadataOnly.ref,scope}).coverage.extraction.status,'pending');
  assert.throws(()=>f.adapter.readOriginal({ref:metadataOnly.ref,scope,id:f.materials.evidenceIds(metadataOnly.ref)[0],offset:0,length:5}),{statusCode:404});
  const unavailableConversation=f.materials.publish({...f.draft,id:materialId('generated-a','unavailable-conversation'),
    origin:{...f.draft.origin,externalId:'unavailable-conversation'},coverage:{state:'partial',reason:'original_body_not_collected'},
    artifacts:[{key:'conversation',state:'unavailable',reason:'original_body_not_collected'}]});
  assert.equal(f.adapter.read({ref:unavailableConversation.ref,scope}).coverage.extraction.status,'unsupported');
  assert.throws(()=>f.adapter.readOriginal({ref:unavailableConversation.ref,scope,id:f.materials.evidenceIds(unavailableConversation.ref)[0],offset:0,length:5}),{statusCode:404});
});

test('attribution context pins accompany inputs so downstream consumers can recheck corrections',async t=>{
  const f=await fixture(t);f.sources.updateContext('generated-a',{expectedVersion:0,description:'Generated source context'});
  const material=f.materials.publish({...f.draft,id:materialId('generated-a','context'),origin:{...f.draft.origin,externalId:'context'}});
  const view=f.adapter.read({ref:material.ref,scope}),pin=f.sources.contexts.identity('generated-a');
  assert.deepEqual(view.sourceContextDependencies,[pin]);
  const id=f.materials.evidenceIds(material.ref)[0],original=f.adapter.readOriginal({ref:material.ref,scope,id,offset:0,length:5});
  assert.deepEqual(original.sourceContextDependencies,[pin]);assert.ok(original.disclosureDependencies.ids.includes(f.a.id));
});

test('source, evidence, time and current authorization restrict products and original re-reads',async t=>{
  const f=await fixture(t),product=await f.produce(0,pieces[0].length);
  const selected={kind:'selection' as const,sourceIds:['generated-a'],evidenceIds:[f.a.id]};
  assert.equal(f.adapter.read({ref:f.material.ref,scope:selected}).products.length,1);
  assert.equal(f.adapter.readProduct({ref:f.material.ref,scope:selected,artifactRef:product.ref})?.events.length,1);
  for(const denied of [
    {kind:'selection' as const,sourceIds:[]},
    {kind:'selection' as const,sourceIds:['generated-b']},
    {kind:'selection' as const,evidenceIds:[]},
    {kind:'selection' as const,sourceIds:['generated-a'],evidenceIds:[f.b.id]},
    {kind:'all' as const,deviceId:'device-b'},
    {kind:'all' as const,after:'2001-01-02T00:00:00Z'},
  ]){
    assert.throws(()=>f.adapter.read({ref:f.material.ref,scope:denied}),{statusCode:404});
    assert.throws(()=>f.adapter.readProduct({ref:f.material.ref,scope:denied,artifactRef:product.ref}),{statusCode:404});
  }
  assert.throws(()=>f.adapter.readOriginal({ref:f.material.ref,scope,id:f.b.id,offset:0,length:1}),{statusCode:404});
  const blocked=new AssistantUnderstandingReader(f.store,f.materials,f.reader,new EvidenceExposurePolicy([{sourceId:'generated-a',representation:'material',allow:false}]));
  assert.throws(()=>blocked.read({ref:f.material.ref,scope}),{statusCode:404});
  f.store.delete(f.a.id);
  assert.throws(()=>f.adapter.read({ref:f.material.ref,scope}),{statusCode:404});
  assert.throws(()=>f.adapter.readOriginal({ref:f.material.ref,scope,id:f.anchor,offset:0,length:1}),{statusCode:404});
});

test('a newer source revision prevents reusing an old Material before its replacement arrives',async t=>{
  const f=await fixture(t);await f.produce(0,pieces[0].length);
  await f.sources.upsert('generated-a',{externalId:'session',revision:'2',observedAt:recordedAt,kind:'message',layer:'original',text:'Generated updated source'});
  assert.throws(()=>f.adapter.read({ref:f.material.ref,scope}),{statusCode:404});
  assert.throws(()=>f.adapter.readOriginal({ref:f.material.ref,scope,id:f.anchor,offset:0,length:1}),{statusCode:404});
});

test('malformed, wrong-version, out-of-lineage and out-of-range references are rejected',async t=>{
  const f=await fixture(t),product=await f.produce(0,pieces[0].length);
  assert.throws(()=>f.adapter.readProduct({ref:f.material.ref,scope,artifactRef:formatArtifactRef(product.artifact.id,'wrong')}),{statusCode:404});
  assert.throws(()=>f.adapter.readProduct({ref:f.material.ref,scope,artifactRef:'not-an-artifact'}),{statusCode:404});
  assert.throws(()=>f.adapter.readOriginal({ref:f.material.ref,scope,id:f.anchor,offset:f.body.length-1,length:2}),{statusCode:416});
  const saved=f.store.db.prepare('SELECT json FROM context_artifacts WHERE id=?').get(product.artifact.id)!;
  const data=JSON.parse(String(saved.json));data.metadata.events[0].evidence[0].offset=pieces[0].length;
  f.store.db.prepare('UPDATE context_artifacts SET json=? WHERE id=?').run(JSON.stringify(data),product.artifact.id);
  assert.throws(()=>f.adapter.readProduct({ref:f.material.ref,scope,artifactRef:product.ref}),{statusCode:409});
  const forged=JSON.parse(String(saved.json));forged.metadata.events[0].evidence[0].id=f.b.id;
  f.store.db.prepare('UPDATE context_artifacts SET json=? WHERE id=?').run(JSON.stringify(forged),product.artifact.id);
  assert.throws(()=>f.adapter.read({ref:f.material.ref,scope}),{statusCode:409});
  const incorrectCoverage=JSON.parse(String(saved.json));incorrectCoverage.metadata.coverage.ranges[0].length++;
  f.store.db.prepare('UPDATE context_artifacts SET json=? WHERE id=?').run(JSON.stringify(incorrectCoverage),product.artifact.id);
  assert.throws(()=>f.adapter.readProduct({ref:f.material.ref,scope,artifactRef:product.ref}),{statusCode:409});
});

test('the real segment-understanding producer is readable without mistaking citations for complete semantic coverage',async t=>{
  const f=await fixture(t),text='Generated ordinary source text with an event.';
  const source=await f.sources.upsert('generated-a',{externalId:'note',revision:'1',observedAt:recordedAt,kind:'message',layer:'original',text});
  const material=f.materials.publish({id:materialId('generated-a','note'),kind:'mote.message',schemaVersion:1,title:'Generated note',origin:{sourceId:'generated-a',externalId:'note',deviceId:'device-a',firstAt:recordedAt,lastAt:recordedAt},
    blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['source']}],members:[{id:'source',kind:'capture',ref:'capture:'+source.id}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  f.store.archive.aggregate();const segment=f.store.archive.page({kind:'segment'}).items.find(item=>item.members.includes(source.id))!;
  const proof=[{id:source.id,quote:text}],output={summary:'Generated source summary',evidence:proof,events:[{statement:'Generated event',uncertainty:'Only this source',evidence:proof}],memoryCandidates:[],actionCues:[]};
  f.runtime.registry.register(semanticProcessor({store:f.store,memories:f.memories,records:ids=>f.store.evidence(ids),selection:()=>model,usage:new UsageLedger(f.store),query:async()=>result(source.id,output)}));
  const job=f.runtime.enqueue([{name:'segment',processor:'mote.segment-understanding',artifactInputs:[{id:segment.id,revision:segment.revision}],config:{artifactId:segment.id,modelFingerprint:model.fingerprint}}]).segment;
  await f.runtime.tick();assert.equal(f.runtime.engine.get(job)?.state,'succeeded');
  const view=f.adapter.read({ref:material.ref,scope});assert.equal(view.products.length,1);assert.equal(view.products[0].events[0].statement,'Generated event');
  assert.deepEqual(view.products[0].memoryCandidates,[]);assert.equal(view.products[0].sourceEvidence[0].quote,text);
  assert.equal(view.coverage.extraction.status,'ready');assert.equal(view.coverage.semantic.status,'partial');assert.deepEqual(view.coverage.semanticRanges,[]);
});

test('a mixed-source interpretation retains uncited dependencies and cannot disclose them in a narrower scope',async t=>{
  const f=await fixture(t),members=[f.a.id,f.b.id],parentId='d'.repeat(64);
  f.sources.updateContext('generated-b',{expectedVersion:0,description:'Generated uncited context'});
  const parent=f.store.archive.save(parentId,parentId,parentId,{kind:'segment',text:'Generated mixed source segment',metadata:{complete:true}},
    members.map(id=>({id,fingerprint:f.store.archive.fingerprint(id)!})),'mote.exact-segment','1','generated',members);
  const proof=[{id:f.a.id,quote:'Generated source membership'}];
  f.runtime.registry.register(semanticProcessor({store:f.store,memories:f.memories,records:ids=>f.store.evidence(ids),selection:()=>model,usage:new UsageLedger(f.store),query:async()=>result(f.a.id,
    {summary:'PRIVATE_GENERATED_OTHER_SOURCE was read as context',evidence:proof,events:[{statement:'Generated event',uncertainty:'Generated only',evidence:proof}],memoryCandidates:[],actionCues:[]})}));
  const job=f.runtime.enqueue([{name:'mixed',processor:'mote.segment-understanding',artifactInputs:[{id:parent.id,revision:parent.revision}],config:{artifactId:parent.id,modelFingerprint:model.fingerprint}}]).mixed;
  await f.runtime.tick();assert.equal(f.runtime.engine.get(job)?.state,'succeeded');
  const full=f.adapter.read({ref:f.material.ref,scope});assert.equal(full.products.length,1);
  assert.ok(full.disclosureDependencies.ids.includes(f.b.id));assert.ok(full.products[0].disclosureDependencies.ids.includes(f.b.id));
  assert.deepEqual(full.products[0].sourceContextDependencies,[f.sources.contexts.identity('generated-b')]);
  assert.deepEqual(full.products[0].sourceEvidence.map(source=>source.id),[f.a.id],'uncited context is a dependency, not supporting proof');
  const restricted={kind:'selection' as const,sourceIds:['generated-a']},narrow=f.adapter.read({ref:f.material.ref,scope:restricted});
  assert.deepEqual(narrow.products,[]);assert.equal(narrow.nextCursor,null);assert.ok(!JSON.stringify(narrow).includes('PRIVATE_GENERATED_OTHER_SOURCE'));
  assert.deepEqual(narrow.sourceContextDependencies,[]);
  assert.throws(()=>f.adapter.readProduct({ref:f.material.ref,scope:restricted,artifactRef:full.products[0].ref}),{statusCode:404});
  assert.deepEqual(f.adapter.read({ref:f.material.ref,scope:{kind:'selection',evidenceIds:[f.a.id]}}).products,[]);
  f.store.delete(f.b.id);assert.equal(f.adapter.read({ref:f.material.ref,scope}).products.length,0);
});
