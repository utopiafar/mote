import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {QueryResult} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore} from '../src/materials.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {reviewMemory} from '../src/memory-review.js';
import {contextIndex} from '../src/context-index.js';
import {codingProjectContext} from '../src/coding-project.js';

async function fixture(t:TestContext){
  const dir=mkdtempSync(join(tmpdir(),'mote-personal-routing-')),store=new Store(dir),materials=new MaterialStore(store);
  const runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  const sources=new SourceStore(store,runtime);
  sources.register({id:'generated',name:'Generated agent conversations',kind:'coding-agent',deviceId:'fixture',platform:'macos'});
  const memories=new MemoryStore(store,ids=>[...store.evidence(ids),...materials.evidence(ids)],id=>store.isCurrentEvidence(id)||materials.isCurrentEvidence(id));
  t.after(async()=>{await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});
  async function add(text:string,sessionId='s1',workspace=false,eventId=sessionId,extra:Record<string,unknown>={},at='2026-01-02T08:00:00Z'){
    await sources.upsert('generated',{externalId:eventId,revision:'1',observedAt:at,kind:'message',layer:'snapshot',text,
      document:{contentRole:'transcript',coding:{version:1,provider:'kimi',sessionId,projectKey:workspace?'aster':sha256('kimi:'+sessionId),
        ...(workspace?{projectName:'Aster',cwd:'/generated/aster',repositoryKey:'a'.repeat(64),branch:'main'}:{}),eventId,role:'user',part:0,parts:1,...extra}}});
    await runtime.tick();const material=materials.list().items.find(item=>item.origin.sessionId===sessionId)!;
    return {material,id:materials.evidenceIds(material.ref)[0]};
  }
  return {store,materials,runtime,sources,memories,add};
}
function result(id:string,quote:string,layer:'memory'|'observation'='memory',extra:Record<string,unknown>={}):QueryResult {
  return {answer:JSON.stringify({memories:[{domain:'personal',title:layer==='memory'?'A dated owner experience':'A delegated task',statement:`${quote} [${id}]`,uncertainty:'Generated source; preserve speaker and time',
    admission:{layer,reason:layer==='memory'?'Remember the owner’s first-person experience':'Find the task and its artifact on demand',scope:'This generated episode only',attribution:'user'},
    evidenceIds:[id],evidence:[{id,quote}],...extra}]}),citations:[{id,capturedAt:'2026-01-02T08:00:00Z',appName:'Generated',excerpt:quote}],trace:[],runId:'generated'};
}

test('agent transcript can yield a task breadcrumb and personal memory without forcing coding domain',async t=>{
  const f=await fixture(t),quote='Please transcribe the generated Harbor interview. I feel drained after today’s meetings.';
  const {id,material}=await f.add(quote);
  assert.equal(material.origin.projectIdentity,'session');
  const draft=result(id,quote,'observation'),personal=result(id,'I feel drained after today’s meetings.');
  const mixed={...draft,answer:JSON.stringify({memories:[...JSON.parse(draft.answer).memories,...JSON.parse(personal.answer).memories]})};
  let reviews=0;
  const pipeline=new MemoryPipeline({store:f.store,memories:f.memories,model:()=> 'fixture',configured:()=>true,requireAdmission:true,
    materialAllowedForMemory:ref=>f.materials.get(ref)?.coverage.state==='complete',query:async()=>mixed,review:async(input,draft)=>reviewMemory(input,draft,async()=>{reviews++;return mixed;})});
  t.after(()=>pipeline.close());
  const job=await pipeline.run(pipeline.create({evidenceIds:[id]}).id);
  assert.equal(job.status,'completed');assert.equal(reviews,1);
  const selected=f.memories.list({layer:'memory',level:'detail'}),breadcrumbs=f.memories.list({layer:'observation',level:'detail'});
  assert.equal(selected.length,1);assert.equal(breadcrumbs.length,1);
  assert.equal(selected[0].domain,'personal');assert.equal(selected[0].coding,undefined);
  assert.equal(selected[0].scopeRefs?.[0].projectIdentity,'session');
  assert.equal(breadcrumbs[0].evidence?.[0].uri,material.ref+'#section-0');
  assert.equal(f.materials.read(material.ref).text.includes(quote),true,'original remains readable on demand');
  const index=contextIndex(f.store,f.memories,f.sources,{path:'/context/memory'});
  assert.deepEqual((index.entries as {id:string}[]).map(item=>item.id),[selected[0].id],'task breadcrumb is not a default memory card');
  assert.throws(()=>f.memories.extract(result(id,quote,'observation',{relatedMemoryIds:[breadcrumbs[0].id]}),'fixture',
    {profile:'personal',requireAdmission:true,tier:'consolidated',relatedMemoryIds:[breadcrumbs[0].id]}),/Consolidation/);
});

test('distinct occurrences of the same personal expression retain evidence and survive owner correction',async t=>{
  const f=await fixture(t),quote='I feel drained after today’s meetings.';
  const first=await f.add(quote,'day-one',true),second=await f.add(quote,'day-two',true,'day-two',{},'2026-01-03T08:00:00Z');
  const a=f.memories.extract(result(first.id,quote),'fixture',{profile:'coding',requireAdmission:true}).items[0];
  const b=f.memories.extract(result(second.id,quote),'fixture',{profile:'coding',requireAdmission:true}).items[0];
  assert.notEqual(a.id,b.id);assert.notDeepEqual(a.evidenceIds,b.evidenceIds);
  assert.notEqual(a.evidence?.[0].recordedAt,b.evidence?.[0].recordedAt);
  assert.equal(a.scopeRefs?.[0].projectName,'Aster');assert.equal(a.scopeRefs?.[0].repositoryKey,'a'.repeat(64));
  const correction=await f.memories.correct(a.id,{version:1,title:'Owner clarification',statement:'Only the planning meetings felt draining.',uncertainty:'One dated experience'});
  assert.equal(correction.domain,'personal');assert.deepEqual(correction.scopeRefs,a.scopeRefs);
  const revised=f.memories.extract(result(correction.evidenceIds[0],'Only the planning meetings felt draining.'),'fixture',{profile:'personal',requireAdmission:true}).items[0];
  assert.deepEqual(revised.scopeRefs,a.scopeRefs,'personal correction retains source-project provenance');
});

test('project identity crosses Material and evidence; unknown sessions cannot mint project-scoped coding claims',async t=>{
  const f=await fixture(t),quote='Aster uses a transaction so partial writes roll back.';
  const known=await f.add(quote,'known',true),unknown=await f.add(quote,'unknown');
  const coding={kind:'decision',scope:'project',applicability:'Aster transaction writes',validation:'unverified'};
  const a=f.memories.extract(result(known.id,quote,'memory',{domain:'coding',coding}),'fixture',{profile:'coding'}).items[0];
  assert.equal(a.domain,'coding');assert.equal(a.scopeRefs?.[0].projectIdentity,'workspace');
  assert.equal(f.materials.evidence([known.id])[0].provenance?.document?.coding?.cwd,'/generated/aster');
  assert.throws(()=>f.memories.extract(result(unknown.id,quote,'memory',{domain:'coding',coding}),'fixture',{profile:'coding'}),/requires session scope/);
  assert.equal(f.memories.extract(result(unknown.id,quote,'memory',{domain:'coding',coding:{...coding,scope:'session'}}),'fixture',{profile:'coding'}).items[0].coding?.scope,'session');
  assert.throws(()=>f.memories.extract(result(known.id,quote,'memory',{domain:'personal',coding}),'fixture',{profile:'coding'}),/personal claims must omit coding/);
});

test('conflicting source workspace metadata is explicit, never resolved by a model or first-event wins',()=>{
  const base={provider:'codex',sessionId:'s',projectKey:'project',cwd:'/generated/one',projectName:'One'};
  const context=codingProjectContext([base,{...base,cwd:'/generated/two',projectName:'Two'}]);
  assert.equal(context.projectIdentity,'unknown');assert.equal(context.projectName,undefined);assert.equal(context.cwd,undefined);
  const branches=codingProjectContext([{...base,branch:'main'},{...base,branch:'feature'}]);
  assert.equal(branches.projectIdentity,'workspace');assert.equal(branches.branch,undefined,'changing branches does not change the workspace');
});

test('append retains workspace metadata, while a conflicting workspace rebuild invalidates old evidence',async t=>{
  const f=await fixture(t);
  const first=await f.add('Generated context. '.repeat(800),'append',true,'first');
  const appended=await f.add('An additional owner expression.','append',true,'second');
  assert.equal(appended.material.origin.projectName,'Aster');
  assert.equal(f.materials.isCurrentEvidence(first.id),true,'unchanged prefix remains valid after append');
  const changed=await f.add('Conflicting metadata.','append',true,'third',{cwd:'/generated/other',projectName:'Other'});
  assert.equal(changed.material.origin.projectIdentity,'unknown');
  assert.equal(changed.material.origin.projectName,undefined);
  assert.equal(f.materials.isCurrentEvidence(first.id),false,'old workspace evidence cannot survive attribution changes');
});
