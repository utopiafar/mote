import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';
import {MemoryStore} from '../src/memory.js';
import {MemoryPipeline} from '../src/memory-pipeline.js';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

const sourceId='generated-memory-source',externalId='generated-item';
const body='Generated source item body with a project decision.';
const empty=()=>({answer:'{"memories":[]}',citations:[],trace:[],runId:randomUUID()});

async function fixture(t:TestContext,query:()=>Promise<ReturnType<typeof empty>>=async()=>empty()){
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-material-gate-'));
  const store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  const work=new MaterialMemoryWork(store,materials);
  sources.register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});
  const raw=(await sources.upsert(sourceId,{externalId,revision:'1',observedAt:'2026-09-20T00:00:00Z',kind:'message',layer:'original',text:body})).id;
  const memories=new MemoryStore(store,ids=>[...store.evidence(ids),...materials.evidence(ids)],id=>materials.isCurrentEvidence(id)||store.isCurrentEvidence(id));
  const pipeline=new MemoryPipeline({store,memories,configured:()=>true,model:()=> 'fixture',query,
    materialAllowedForMemory:ref=>work.readyForMemory(ref)});
  t.after(async()=>{await pipeline.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const id=materialId(sourceId,externalId);
  const publish=(text:string,extracted:'pending'|'failed'|'ready')=>{
    const prior=materials.get(id);
    const draft:MaterialDraft={id,kind:'mote.message',schemaVersion:1,title:'Generated item',
      origin:{sourceId,externalId,deviceId:'generated-device'},
      blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:['original']}],
      members:[{id:'original',kind:'capture',ref:`capture:${raw}`}],
      coverage:{state:extracted==='ready'?'complete':'partial',reason:extracted==='ready'?undefined:'processing_pending'},
      artifacts:[{key:'source-body',state:'ready'},{key:'extracted-text',state:extracted}],
      fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
    return materials.publish(draft,{expectedRevision:prior?.revision??null});
  };
  return {store,sources,materials,work,memories,pipeline,raw,publish};
}

test('ordinary raw artifact and manual raw job cannot bypass pending or failed named dependencies',async t=>{
  const f=await fixture(t),pending=f.publish(body,'pending');
  f.work.observe(pending.id,['extracted-text']);
  f.store.archive.aggregate();
  const segment=f.store.archive.page().items.find(item=>item.kind==='segment')!;
  assert.deepEqual(f.pipeline.legacyArtifactIds([segment.id]),[]);
  assert.equal(f.work.readyForMemory(pending.ref),false);
  assert.throws(()=>f.pipeline.create({evidenceIds:[f.raw]}),{statusCode:409});
  assert.throws(()=>f.pipeline.create({evidenceIds:f.materials.evidenceIds(pending.ref)}),{statusCode:409});
  const failed=f.publish(body+' Failed extraction.','failed');f.work.observe(failed.id,['extracted-text']);
  assert.equal(f.work.readyForMemory(failed.ref),false);
  assert.throws(()=>f.pipeline.create({evidenceIds:f.materials.evidenceIds(failed.ref)}),{statusCode:409});
});

test('a ready named source body admits partial Material anchor, then supersession prevents commit and retry',async t=>{
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>entered=resolve),held=new Promise<void>(resolve=>release=resolve);
  const f=await fixture(t,async()=>{entered();await held;return empty();});
  const partial=f.publish(body,'pending');f.work.observe(partial.id,['source-body']);
  assert.equal(f.work.readyForMemory(partial.ref),true);
  const anchor=f.materials.evidenceIds(partial.ref)[0];assert.ok(anchor);
  const job=f.pipeline.create({evidenceIds:[anchor]});
  assert.equal(job.materialRefs?.[anchor],partial.ref);
  const running=f.pipeline.run(job.id);await started;
  const next=f.publish(body+' New revision.','ready');f.work.observe(next.id,['source-body']);
  assert.equal(f.work.readyForMemory(partial.ref),false);
  release();const finished=await running;
  assert.equal(finished.status,'failed');assert.equal(finished.batches[0].status,'invalidated');
  assert.equal(f.memories.list({includeStale:true}).length,0);
  await assert.rejects(f.pipeline.retry(job.id),{statusCode:409});
  const currentAnchor=f.materials.evidenceIds(next.ref)[0];
  const fresh=f.pipeline.create({evidenceIds:[currentAnchor]});
  assert.equal((await f.pipeline.run(fresh.id)).status,'completed');
});

test('production manual Memory routes reject raw source items and raw model citations',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-memory-route-gate-'));
  const config:Config={dataDir:directory,token:'generated-memory-gate-token',tokenPath:'fixture',host:'127.0.0.1',port:0,
    maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],
    model:'fixture',modelBaseUrl:'https://synthetic.invalid',apiKey:'synthetic',allowUnauthenticatedLocal:false,
    embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''};
  let raw='';
  const node=await buildApp(config,{createModelAgent:async()=>({configured:true,close:async()=>{},query:async()=>({
    answer:JSON.stringify({memories:[{title:'Generated decision',statement:`Generated decision [${raw}]`,
      uncertainty:'Fixture only',admission:{layer:'memory',reason:'Generated decision',scope:'Fixture',attribution:'user'},
      evidenceIds:[raw],evidence:[{id:raw,quote:body}]}]}),
    citations:[{id:raw,capturedAt:'2026-09-20T00:00:00Z',appName:'Generated',excerpt:body}],trace:[],runId:randomUUID()})})});
  t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
  node.sources.register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});
  raw=(await node.sources.upsert(sourceId,{externalId,revision:'1',observedAt:'2026-09-20T00:00:00Z',kind:'message',layer:'original',text:body})).id;
  await node.materialOrganizer.tick();
  const headers={authorization:`Bearer ${config.token}`};
  const manual=await node.app.inject({method:'POST',url:'/api/memory-jobs',headers,payload:{evidenceIds:[raw]}});
  assert.equal(manual.statusCode,409,manual.body);
  const direct=await node.app.inject({method:'POST',url:'/api/memories/extract',headers,payload:{}});
  assert.equal(direct.statusCode,409,direct.body);
  assert.equal(node.memories.list({includeStale:true}).length,0);
});
