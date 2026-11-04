import {fixtureMemoryPipeline} from './fixtures/memory-result.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {Store} from '../src/store.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {reviewMemory} from '../src/memory-review.js';
import type {MemoryWorkMember} from '../src/memory-work-contract.js';

function fixture(t:import('node:test').TestContext){
  const path=mkdtempSync(join(tmpdir(),'mote-material-input-')),store=new Store(path),materials=new MaterialStore(store);
  t.after(()=>{store.close();rmSync(path,{recursive:true,force:true});});
  const draft:MaterialDraft={id:materialId('fixture-source','record'),kind:'mote.message',schemaVersion:1,title:'Generated record',origin:{sourceId:'fixture-source',externalId:'record'},
    members:[{id:'raw',kind:'archive',ref:'archive:generated'}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated authored context',memberIds:['raw']},{id:'transcript',kind:'text',format:'transcript',text:'Generated transcript',memberIds:['raw']}],
    coverage:{state:'partial'},artifacts:[{key:'body',state:'ready',blockIds:['body']},{key:'transcript',state:'ready',blockIds:['transcript']},{key:'summary',state:'pending',blockIds:[]}],fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
  return {store,materials,draft};
}

test('artifact contracts reject duplicate or missing block references and preserve independent invalidation',t=>{
  const {store,materials,draft}=fixture(t);
  for(const blockIds of [['missing'],['body','body']])assert.throws(()=>materials.publish({...draft,artifacts:[{key:'body',state:'ready',blockIds}]}),/unknown blocks/);
  const first=materials.publish(draft),body=materials.input(first.ref,['body'])!,transcript=materials.input(first.ref,['transcript'])!;
  assert.equal(body.ready,true);assert.equal(transcript.ready,true);assert.equal(materials.input(first.ref,['material'])!.ready,false);
  assert.equal(materials.input(first.ref,['summary'])!.ready,false);assert.equal(materials.input(first.ref,['missing'])!.ready,false);
  store.invalidateMemoryEvidence(transcript.evidenceIds[0]);
  assert.equal(materials.get(first.id)!.coverage.state,'pending');assert.equal(materials.input(first.id,['body'])!.ready,true);
  assert.equal(materials.input(first.id,['transcript'])!.ready,false);
  const rebuilt=materials.publish(draft,{expectedRevision:first.revision});
  assert.notEqual(rebuilt.ref,first.ref);assert.equal(materials.input(rebuilt.ref,['body'])!.fingerprint,body.fingerprint);
  assert.notEqual(materials.input(rebuilt.ref,['transcript'])!.fingerprint,transcript.fingerprint);
  assert.equal(materials.input(first.ref,['body']),undefined,'a caller cannot select an old head');
});

test('append mappings include retained blocks and honor output-only state changes',t=>{
  const {materials,draft}=fixture(t),block={...draft.blocks[0],id:'section-0',kind:'text' as const,format:'markdown-fragment',text:'Generated first section'};
  const initial={...draft,kind:'mote.coding-session',blocks:[block],artifacts:[{key:'conversation',state:'ready' as const,blockIds:['section-0']}]};
  const first=materials.publish(initial,{codingSnapshot:{checkpoint:'first',appendEpoch:1,headCount:1}});
  const added={...block,id:'section-1',text:'Generated second section'},next={...initial,mode:'append' as const,baseRevision:first.revision,reuseBlocks:1,blocks:[added],artifacts:[{key:'conversation',state:'ready' as const,blockIds:['section-0','section-1']}]};
  const options={expectedRevision:first.revision,codingSnapshot:{checkpoint:'next',appendEpoch:1,headCount:2}};
  assert.throws(()=>materials.publish({...next,artifacts:[{key:'conversation',state:'ready',blockIds:['missing']}]},options),/unknown blocks/);
  const second=materials.publish(next,options);assert.equal(materials.input(second.ref,['conversation'])!.evidenceIds.length,2);
  const failed=materials.publish({...next,baseRevision:second.revision,reuseBlocks:2,blocks:[],artifacts:[{key:'conversation',state:'failed',blockIds:['section-0','section-1'],reason:'Generated stage failure'}]},
    {expectedRevision:second.revision,codingSnapshot:{checkpoint:'next',appendEpoch:1,headCount:2}});
  assert.equal(failed.changed,true);assert.equal(materials.input(failed.ref,['conversation'])!.ready,false);
});

test('empty append no-op compares real members and dependency revisions after a full publication',t=>{
  const {materials,draft}=fixture(t),initial={...draft,kind:'mote.coding-session',coverage:{state:'complete' as const},blocks:[{...draft.blocks[0],id:'section-0',kind:'text' as const,format:'markdown-fragment',text:'Generated immutable section'}],artifacts:[{key:'conversation',state:'ready' as const,revision:'input-1',blockIds:['section-0']}]};
  const snapshot={checkpoint:'first',appendEpoch:1,headCount:1},first=materials.publish(initial,{codingSnapshot:snapshot});
  const noContent={...initial,mode:'append' as const,baseRevision:first.revision,reuseBlocks:1,blocks:[]};
  const same=materials.publish(noContent,{expectedRevision:first.revision,codingSnapshot:snapshot});assert.equal(same.changed,false);assert.equal(same.revision,first.revision);
  const members=[{...initial.members[0],revision:'member-2'}],changedMember=materials.publish({...noContent,members},{expectedRevision:first.revision,codingSnapshot:snapshot});
  assert.equal(changedMember.changed,true);assert.notEqual(changedMember.revision,first.revision);assert.deepEqual(materials.members(changedMember.ref).items,members);
  const changedInput=materials.publish({...noContent,baseRevision:changedMember.revision,members,artifacts:[{...initial.artifacts[0],revision:'input-2'}]},{expectedRevision:changedMember.revision,codingSnapshot:snapshot});
  assert.equal(changedInput.changed,true);assert.notEqual(changedInput.revision,changedMember.revision);
});

test('recipe requirement changes need a new identity and cannot substitute for an old pin',()=>{
  const strategies=new MemoryStrategies(),recipe={id:'fixture.required',version:'1',workContract:'range-evaluation@1' as const,extract:{id:'mote.selected-context-extraction',version:'1'},review:{id:'mote.personal-review',version:'5'},requires:['source-body']};
  assert.throws(()=>strategies.registerRecipe({...recipe,requires:['source-body','source-body']}),/Duplicate/);
  const stop=strategies.registerRecipe(recipe),pin=strategies.resolve(recipe).binding;assert.deepEqual(pin.requires,['source-body']);stop();
  assert.throws(()=>strategies.registerRecipe({...recipe,requires:['extracted-text']}),/new version/);
  strategies.registerRecipe({...recipe,version:'2',requires:['extracted-text']});assert.throws(()=>strategies.resolvePinned(pin),/not installed/);
});

test('a manual composition retains default dependencies without blocking an independent body recipe',async t=>{
  const {store,materials,draft}=fixture(t),strategies=new MemoryStrategies(),recipe={id:'fixture.body',version:'1',workContract:'range-evaluation@1' as const,extract:{id:'mote.selected-context-extraction',version:'1'},review:{id:'mote.personal-review',version:'5'},requires:['body']};
  strategies.registerRecipe(recipe);
  const initial={...draft,blocks:[draft.blocks[0]],coverage:{state:'complete' as const},artifacts:[{key:'body',state:'ready' as const,blockIds:['body']},{key:'summary',state:'ready' as const,blockIds:[]}]};
  const first=materials.publish(initial),body=materials.input(first.ref,['body'])!;
  const memories=new MemoryStore(store,ids=>materials.evidence(ids),id=>materials.isCurrentEvidence(id));
  const calls:string[][]=[];
  const pipeline=fixtureMemoryPipeline({store,memories,strategies,admission:{
    materialInput:(ref,required)=>materials.input(ref,required),materialAllowedForMemory:(ref,_profile,required)=>Boolean(materials.input(ref,required??['material'])?.ready)},models:{configured:()=>true,model:()=> 'fixture'},phases:{
    query:async input=>{calls.push((input.processingMaterialInputs??[]).flatMap(pin=>pin.required));return {answer:'{"memories":[]}',citations:[],trace:[],runId:'generated-independent-body'};},review:async(_input,result)=>result}});
  try{
    const job=pipeline.create({evidenceIds:body.evidenceIds,recipes:[{id:recipe.id,version:recipe.version},{id:'mote.personal-memory',version:'5'}]});
    assert.deepEqual(job.materialInputs!.map(pin=>pin.required),[['body'],['material']]);
    const revised=materials.publish({...initial,coverage:{state:'partial'},artifacts:[initial.artifacts[0],{...initial.artifacts[1],state:'failed',reason:'Generated failure'}]},{expectedRevision:first.revision});
    assert.equal(materials.input(revised.ref,['body'])!.fingerprint,body.fingerprint);
    const done=await pipeline.retry(job.id);
    assert.equal(done.status,'failed');
    assert.equal(done.batches.find(batch=>batch.strategy?.recipe.id===recipe.id)?.status,'completed');
    assert.equal(done.batches.find(batch=>batch.strategy?.recipe.id==='mote.personal-memory')?.status,'invalidated');
    assert.deepEqual(calls,[['body']],'only the independently ready recipe may call the model');
    assert.equal(pipeline.get(job.id).memoryIds.length,0);
  }finally{await pipeline.close();}
});

test('body feedback retains its recipe pin when the same originals also belong to an unavailable whole-material recipe',async t=>{
  const {store,materials,draft}=fixture(t),strategies=new MemoryStrategies(),recipe={id:'fixture.body-feedback',version:'1',workContract:'range-evaluation@1' as const,extract:{id:'mote.selected-context-extraction',version:'1'},review:{id:'mote.personal-review',version:'5'},requires:['body']};
  strategies.registerRecipe(recipe);
  const blocks=[{...draft.blocks[0],id:'target',text:'Generated target refers to an earlier body entry. '.padEnd(240,'x')},{...draft.blocks[0],id:'background',text:'Generated earlier body entry resolves the target reference. '.padEnd(240,'x')}];
  const initial={...draft,blocks,coverage:{state:'complete' as const},artifacts:[{key:'body',state:'ready' as const,blockIds:blocks.map(block=>block.id)},{key:'summary',state:'ready' as const,blockIds:[]}]};
  const first=materials.publish(initial),body=materials.input(first.ref,['body'])!,[targetId,backgroundId]=body.evidenceIds;
  const memories=new MemoryStore(store,ids=>materials.evidence(ids),id=>materials.isCurrentEvidence(id)),calls:QueryInput[]=[];
  let feedbackCalls=0;
  const output=(input:QueryInput,runId:string):QueryResult=>{
    calls.push(input);
    assert.deepEqual(input.processingMaterialInputs?.map(pin=>pin.required),[['body']],'an unavailable whole-material requirement cannot attach to body extraction or review');
    assert.equal(input.processingMaterialInputs?.[0].fingerprint,body.fingerprint);
    const work=input.taskContext!.memoryWork as {members:MemoryWorkMember[];contextMembers?:MemoryWorkMember[]};
    assert.equal(work.members.length,1);
    const needs=work.members[0].id===targetId&&!work.contextMembers?.some(member=>member.id===backgroundId);
    return {runId,trace:[],citations:[],answer:JSON.stringify({memories:[],coverage:work.members.map(member=>({key:member.key,state:needs?'needs_context':'no_candidates',candidateIndexes:[],...(needs?{reason:'The generated target needs the separately selected earlier body entry.',contextRefs:[backgroundId]}:{})}))})};
  };
  const pipeline=fixtureMemoryPipeline({store,memories,strategies,batchCharacters:256,admission:{
    materialInput:(ref,required)=>materials.input(ref,required),materialAllowedForMemory:(ref,_profile,required)=>Boolean(materials.input(ref,required??['material'])?.ready)},models:{configured:()=>true,model:()=> 'fixture'},phases:{
    query:async input=>output(input,'generated-body-extract-'+calls.length),review:(input,result,strategy)=>reviewMemory(input,result,async next=>output(next,'generated-body-review-'+calls.length),{strategy})}});
  pipeline.setFeedbackPlanner(async request=>{
    feedbackCalls++;
    assert.equal(request.round,1);assert.equal(request.targets.length,1);assert.equal(request.targets[0].id,targetId);
    assert.equal(request.authorized.length,2,'the shared original identities do not duplicate the compatible body scope');
    assert.equal(pipeline.feedbackAllowed(request),true,'the independent body input remains authorized after summary failure');
    const context=request.authorized.find(member=>member.id===backgroundId)!;assert.ok(context);
    return {workId:'generated-body-feedback',groups:[{id:'generated-body-context-child',goal:'Inspect the unfinished generated target with its earlier body entry',memberKeys:request.targets.map(member=>member.key),contextKeys:[context.key],instruction:'Use only the selected body originals to resolve the generated reference.'}]};
  });
  try{
    const job=pipeline.create({evidenceIds:body.evidenceIds,recipes:[{id:recipe.id,version:recipe.version},{id:'mote.personal-memory',version:'5'}],workPackage:{id:'generated-body-package',goal:'Inspect both generated body originals',instruction:'Preserve each selected recipe and the independent range coverage.'}});
    assert.deepEqual(job.materialInputs!.map(pin=>pin.required),[['body'],['material']]);
    const bodyBackground=job.batches.find(batch=>batch.strategy?.recipe.id===recipe.id&&batch.coverage?.[0].id===backgroundId)!;
    const wholeBackground=job.batches.find(batch=>batch.strategy?.recipe.id==='mote.personal-memory'&&batch.coverage?.[0].id===backgroundId)!;
    assert.equal(bodyBackground.coverage![0].key,wholeBackground.coverage![0].key,'the fixture exercises the shared coverage key that previously selected the other recipe pin');
    const revised=materials.publish({...initial,coverage:{state:'partial'},artifacts:[initial.artifacts[0],{...initial.artifacts[1],state:'failed',reason:'Generated unavailable summary'}]},{expectedRevision:first.revision});
    assert.equal(materials.input(revised.ref,['body'])!.fingerprint,body.fingerprint);
    const done=await pipeline.run(job.id);
    assert.equal(done.status,'failed','the unavailable whole-material recipe remains visible as a failed composition');
    assert.equal(feedbackCalls,1);
    assert.equal(store.db.prepare("SELECT json_extract(json,'$.privateRetired') retired FROM memory_jobs WHERE id=?").get(job.id)!.retired,1,'invalidating the whole-material sibling retires shared package prose');
    assert.ok(done.batches.filter(batch=>batch.strategy?.recipe.id==='mote.personal-memory').every(batch=>batch.status==='invalidated'));
    const parent=done.batches.find(batch=>batch.strategy?.recipe.id===recipe.id&&batch.supersededBy)!;assert.ok(parent);
    const child=done.batches.find(batch=>batch.replanRound===1)!;assert.ok(child);
    assert.deepEqual(parent.supersededBy,[child.id]);assert.equal(child.strategy?.recipe.id,recipe.id);assert.equal(child.status,'completed');
    assert.deepEqual(child.evidenceRanges.map(range=>range.id),[targetId]);assert.deepEqual(child.contextRanges?.map(range=>range.id),[backgroundId]);
    assert.equal(child.coverage?.[0].state,'no_candidates');assert.ok(child.reviewReceipt?.reviewRunId);
    assert.equal(done.batches.find(batch=>batch.id===bodyBackground.id)?.attempts,1,'the already inspected body sibling is used as context without repeating its target coverage');
    assert.equal(calls.length,6,'the two original body batches and the feedback child each receive extraction and independent review');
    assert.equal(calls.filter(input=>input.traceContext?.batchId===child.id).length,2);
    assert.deepEqual(store.db.prepare('SELECT phase FROM memory_phase_outputs WHERE batch_id=? ORDER BY phase').all(child.id).map(row=>row.phase),['extract','review'],'independently authorized body work keeps both complete phase checkpoints');
    assert.equal(memories.list().length,0);
  }finally{await pipeline.close();}
});
