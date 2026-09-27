import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {MemoryStrategies} from '../src/memory-strategies.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';

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

test('recipe requirement changes need a new identity and cannot substitute for an old pin',()=>{
  const strategies=new MemoryStrategies(),recipe={id:'fixture.required',version:'1',extract:{id:'mote.context-extraction',version:'3.4.0'},review:{id:'mote.personal-review',version:'2'},requires:['source-body']};
  assert.throws(()=>strategies.registerRecipe({...recipe,requires:['source-body','source-body']}),/Duplicate/);
  const stop=strategies.registerRecipe(recipe),pin=strategies.resolve(recipe).binding;assert.deepEqual(pin.requires,['source-body']);stop();
  assert.throws(()=>strategies.registerRecipe({...recipe,requires:['extracted-text']}),/new version/);
  strategies.registerRecipe({...recipe,version:'2',requires:['extracted-text']});assert.throws(()=>strategies.resolvePinned(pin),/not installed/);
});

test('a manual composition retains default dependencies without blocking an independent body recipe',async t=>{
  const {store,materials,draft}=fixture(t),strategies=new MemoryStrategies(),recipe={id:'fixture.body',version:'1',extract:{id:'mote.context-extraction',version:'3.4.0'},review:{id:'mote.personal-review',version:'2'},requires:['body']};
  strategies.registerRecipe(recipe);
  const initial={...draft,blocks:[draft.blocks[0]],coverage:{state:'complete' as const},artifacts:[{key:'body',state:'ready' as const,blockIds:['body']},{key:'summary',state:'ready' as const,blockIds:[]}]};
  const first=materials.publish(initial),body=materials.input(first.ref,['body'])!;
  const memories=new MemoryStore(store,ids=>materials.evidence(ids),id=>materials.isCurrentEvidence(id));
  const calls:string[][]=[];
  const pipeline=new MemoryPipeline({store,memories,strategies,configured:()=>true,model:()=> 'fixture',
    materialInput:(ref,required)=>materials.input(ref,required),materialAllowedForMemory:(ref,_profile,required)=>Boolean(materials.input(ref,required??['material'])?.ready),
    query:async input=>{calls.push((input.processingMaterialInputs??[]).flatMap(pin=>pin.required));return {answer:'{"memories":[]}',citations:[],trace:[],runId:'generated-independent-body'};},review:async(_input,result)=>result});
  try{
    const job=pipeline.create({evidenceIds:body.evidenceIds,recipes:[{id:recipe.id,version:recipe.version},{id:'mote.personal-memory',version:'2'}]});
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
