import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import sharp from 'sharp';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId,type MaterialDraft} from '../src/materials.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {ServerDiagnostics} from '../src/diagnostics.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {formatArtifactRef} from '@mote/shared';
import {SourceItemRecipeCatalog} from '../src/source-item-recipe.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';

test('query discovery uses published screen views while selected originals remain expandable',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-exposure-'));
  const store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  const image=await sharp({create:{width:2,height:2,channels:3,background:'#ffccaa'}}).png().toBuffer();
  const screenIds=[randomUUID(),randomUUID(),randomUUID()];
  for(const [index,id] of screenIds.entries())await store.ingest({id,deviceId:'generated-device',deviceName:'Generated device',platform:'macos',source:'screen',
    capturedAt:`2026-09-20T01:0${index}:00.000Z`,durationMs:5000,appId:'generated.app',appName:'Generated App',ocrText:'EXPOSURE_ANCHOR generated screen '+index,
    imageMime:'image/png',imageBase64:image.toString('base64')});
  const noteId=randomUUID();await store.ingest({id:noteId,deviceId:'generated-device',deviceName:'Generated device',platform:'import',source:'note',
    capturedAt:'2026-09-20T00:00:00.000Z',durationMs:0,ocrText:'EXPOSURE_ANCHOR authored note'});
  const draft:MaterialDraft={id:materialId('screen:generated','group'),kind:'mote.screen-segment',schemaVersion:1,title:'Generated screen view',
    origin:{sourceId:'screen:generated',externalId:'group',deviceId:'generated-device',firstAt:'2026-09-20T01:00:00.000Z',lastAt:'2026-09-20T01:02:00.000Z'},
    blocks:[{id:'summary',kind:'text',format:'plain',text:'Available OCR from a generated screen sample',memberIds:['screen-0']}],
    members:screenIds.map((id,index)=>({id:`screen-${index}`,kind:'capture' as const,ref:`capture:${id}`})),
    coverage:{state:'pending',reason:'ocr_pending'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
  const material=materials.publish(draft),reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials);
  materials.setSearchable(material.id,true);
  let runContext:object|undefined={};const firstRun=runContext,queryContext=new AsyncLocalStorage<object>();
  const agent=reader.agent({diagnostics,allowQueryImages:()=>true,currentGrantContext:()=>queryContext.getStore()??runContext});
  const legacyMemoryId=randomUUID();
  store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(legacyMemoryId,'2026-09-20T03:00:00.000Z',JSON.stringify({id:legacyMemoryId,title:'Generated raw screenshot memory',statement:'SCREEN_MEMORY_ANCHOR',uncertainty:'',status:'published',createdAt:'2026-09-20T03:00:00.000Z',evidenceIds:[screenIds[0]],evidence:[{id:screenIds[0],capturedAt:'2026-09-20T01:00:00.000Z'}]}));
  store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(legacyMemoryId,screenIds[0]);
  assert.deepEqual((await agent.search({query:'EXPOSURE_ANCHOR',limit:5})).map(record=>record.id),[noteId]);
  assert.deepEqual((await agent.search({query:'Available OCR'})).map(record=>record.id),[materials.evidenceIds(material.ref)[0]],
    'processed screen Material text is discoverable without exposing a raw screenshot');
  const timeline=await agent.timeline({limit:1});assert.ok(!Array.isArray(timeline));
  assert.deepEqual(timeline.items.map(record=>record.id),[noteId]);
  assert.equal(timeline.nextCursor,null);
  assert.equal((await agent.memories!({id:legacyMemoryId})).items.length,0);
  assert.equal((await agent.catalog!({path:'/context/memory'})).entries.some((entry:any)=>entry.id===legacyMemoryId),false);
  const catalog=await agent.materialCatalog!({});assert.deepEqual(catalog.items.map(item=>item.ref),[material.ref]);
  assert.equal((catalog.items[0] as any).coverage.state,'pending');
  assert.deepEqual(await agent.evidence({ids:[screenIds[0]]}),[],'a known screen UUID is not an original disclosure grant');
  await assert.rejects(agent.readImage!({id:screenIds[0]}),/Image not found/);
  const read=await agent.materialRead!({ref:material.ref});assert.deepEqual(read.originalRefs,[screenIds[0]]);
  assert.equal((await agent.evidence({ids:read.originalRefs}))[0].id,screenIds[0]);
  assert.equal((await agent.readImage!({id:screenIds[0]})).mimeType,'image/png');
  assert.deepEqual(await agent.evidence({ids:[screenIds[1]]}),[],'a material only grants originals in the expanded span');
  runContext={};
  assert.deepEqual(await agent.evidence({ids:[screenIds[0]]}),[],'another query instance cannot reuse the grant');
  await assert.rejects(agent.readImage!({id:screenIds[0]}),/Image not found/);
  runContext=undefined;
  assert.deepEqual(await agent.evidence({ids:[screenIds[0]]}),[],'missing trusted query context fails closed');
  runContext=firstRun;
  const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
  const {parseAnswer}=await import('@mote/agent');
  runContext=undefined;
  await queryContext.run(firstRun!,async()=>{
    const bridge=await startBridge(agent,{question:'Generated fixture',deviceId:'generated-device'},12);t.after(()=>bridge.close());
    const call=async(tool:string,args:unknown)=>fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token},body:JSON.stringify(args)});
    assert.equal((await call('evidence',{ids:[screenIds[0]]})).status,400,'an undiscovered raw screenshot is not an Agent expansion grant');
    const discovered=await (await call('material_catalog',{})).json();
    const page=await (await call('material_read',{ref:discovered.data.items[0].ref})).json();
    assert.deepEqual(page.data.originalRefs,[screenIds[0]]);
    assert.equal((await call('evidence',{ids:[screenIds[0]]})).status,200,'bridge callbacks retain the trusted query context');
    const answer=parseAnswer(JSON.stringify({answer:`Generated screen content [${screenIds[0]}]`,citationIds:[screenIds[0]]}),bridge.records);
    assert.equal(answer.citations[0].id,screenIds[0]);
  });
  runContext=firstRun;
  const segment=store.archive.save('generated-screen-segment','generated-screen-segment','1',
    {kind:'segment',text:'Generated segment',metadata:{complete:true,citations:[screenIds[2]]}},
    [{id:screenIds[1],fingerprint:store.archive.fingerprint(screenIds[1])!}],'fixture','1','fixture');
  const segmentRef=formatArtifactRef(segment.id,segment.revision);
  assert.ok((await agent.segments!({})).items.some(item=>item.ref===segmentRef));
  assert.deepEqual(await agent.evidence({ids:[screenIds[1]]}),[],'a segment listing does not grant its raw members');
  assert.deepEqual((await agent.segments!({id:segmentRef})).items[0]?.members,[screenIds[1]]);
  assert.equal((await agent.evidence({ids:[screenIds[1]]}))[0].id,screenIds[1],'an exact expanded segment grants its member');
  assert.deepEqual(await agent.evidence({ids:[screenIds[2]]}),[],'freeform segment citations do not grant originals');
  store.archive.save(segment.id,segment.id,'2',{kind:'segment',text:'New segment revision',metadata:{complete:true}},
    [{id:screenIds[1],fingerprint:store.archive.fingerprint(screenIds[1])!}],'fixture','1','fixture');
  assert.deepEqual(await agent.evidence({ids:[screenIds[1]]}),[],'segment revision invalidates its grant');
  materials.retire(material.id,{expectedRevision:material.revision});
  assert.deepEqual(await agent.evidence({ids:[screenIds[0]]}),[],'material retirement revokes its original grant');
  await assert.rejects(agent.readImage!({id:screenIds[0]}),/Image not found/);
  assert.equal(reader.evidence([screenIds[0]]).length,1,'owner archive reads retain the original');
});

test('trusted rules are explicit over source, operation, phase and representation',async t=>{
  const policy=new EvidenceExposurePolicy();
  assert.equal(policy.allows({sourceKind:'screen',representation:'capture',operation:'discover',phase:'pending'}),false);
  assert.equal(policy.allows({sourceKind:'screen',representation:'capture',operation:'expand',phase:'pending'}),false);
  assert.equal(policy.allows({sourceKind:'screen',representation:'capture',operation:'expand',phase:'pending'},undefined,true),true);
  assert.equal(policy.allows({sourceKind:'screen',representation:'image',operation:'expand',phase:'pending'}),false);
  assert.equal(policy.allows({sourceKind:'screen',representation:'material',operation:'discover',phase:'pending'}),true);
  assert.equal(policy.allows({sourceKind:'screen',representation:'material',operation:'memory',phase:'pending'}),false);
  assert.equal(policy.allows({sourceKind:'screen',representation:'material',operation:'memory',phase:'complete'}),true);
  assert.equal(policy.allows({sourceKind:'coding-agent',representation:'capture',operation:'expand',phase:'complete'}),false);
  assert.equal(policy.allows({sourceKind:'coding-agent',representation:'material',operation:'discover',phase:'partial'}),true);
  assert.equal(policy.allows({sourceKind:'upload',representation:'image',operation:'expand',phase:'pending'}),true);
  const custom=new EvidenceExposurePolicy([{sourceKind:'screen',representation:'capture',operation:'discover',allow:true}]);
  assert.equal(custom.allows({sourceKind:'screen',representation:'capture',operation:'discover',phase:'pending'}),true);
  const routes=[
    {audience:'query',operation:'ask',phase:'pending',readProjection:'material'},
    {audience:'query',operation:'ask',phase:'partial',readProjection:'material'},
    {audience:'query',operation:'ask',phase:'ready',readProjection:'material'},
    {audience:'memory',operation:'derive',phase:'ready',readProjection:'material'},
    {audience:'query',operation:'ask',phase:'raw',readProjection:'metadata'},
  ];
  assert.equal(policy.allows({sourceKind:'coding-agent',representation:'material',operation:'discover',phase:'pending'},routes),true);
  assert.equal(policy.allows({sourceKind:'coding-agent',representation:'material',operation:'expand',phase:'partial'},routes),true);
  assert.equal(policy.allows({sourceKind:'coding-agent',representation:'material',operation:'memory',phase:'partial'},routes),false);
  assert.equal(policy.allows({sourceKind:'coding-agent',representation:'material',operation:'memory',phase:'complete'},routes),true);
  assert.equal(policy.allows({sourceKind:'coding-agent',representation:'capture',operation:'expand',phase:'complete'},routes),false);

  const directory=mkdtempSync(join(tmpdir(),'mote-exposure-coding-'));
  const store=new Store(directory),sources=new SourceStore(store),diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated-coding',name:'Generated Coding',kind:'coding-agent',deviceId:'generated-device',platform:'import'});
  await sources.upsert('generated-coding',{externalId:'event-1',revision:'1',observedAt:'2026-09-20T02:00:00.000Z',title:'Generated event',
    text:'CODING_RAW_ANCHOR',kind:'message',layer:'original',document:{coding:{version:1,provider:'codex',projectKey:'generated-project',sessionId:'generated-session',eventId:'event-1',role:'user',part:0,parts:1}}});
  const id=sources.getItem('generated-coding','event-1')!.captureId;
  const reader=new EvidenceReader(store,sources),agent=reader.agent({diagnostics});
  const legacyMemoryId=randomUUID();
  store.db.prepare('INSERT INTO memories(id,created_at,json) VALUES(?,?,?)').run(legacyMemoryId,'2026-09-20T03:00:00.000Z',JSON.stringify({id:legacyMemoryId,title:'Generated raw Coding memory',statement:'CODING_MEMORY_ANCHOR',uncertainty:'',status:'published',createdAt:'2026-09-20T03:00:00.000Z',evidenceIds:[id],evidence:[{id,capturedAt:'2026-09-20T02:00:00.000Z'}]}));
  store.db.prepare('INSERT INTO memory_dependencies(memory_id,evidence_id) VALUES(?,?)').run(legacyMemoryId,id);
  assert.equal((await agent.search({query:'CODING_RAW_ANCHOR'})).length,0);
  assert.equal((await agent.evidence({ids:[id]})).length,0);
  assert.deepEqual((await agent.sourceItems!({sourceId:'generated-coding'})).items,[]);
  assert.equal((await agent.memories!({id:legacyMemoryId})).items.length,0);
  assert.equal((await agent.catalog!({path:'/context/memory'})).entries.some((entry:any)=>entry.id===legacyMemoryId),false);
  assert.equal(reader.evidence([id]).length,1,'the original remains in the owner archive');
});

test('ordinary recipe routes keep pending query material visible and require a named Memory grant',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-ordinary-exposure-'));
  const store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store),recipes=new SourceItemRecipeCatalog(store,'1');
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'fixture-ordinary-exposure',name:'Generated source',kind:'custom',deviceId:'fixture-device',platform:'import',retention:'archive'});
  const received=await sources.upsert('fixture-ordinary-exposure',{externalId:'doc-1',revision:'v1',observedAt:'2026-09-20T00:00:00.000Z',
    text:'GENERATED_ORDINARY_EXPOSURE',kind:'message',layer:'original'});
  const material=materials.publish({id:materialId('fixture-ordinary-exposure','doc-1'),kind:'mote.message',schemaVersion:1,title:'Generated partial material',
    origin:{sourceId:'fixture-ordinary-exposure',externalId:'doc-1',deviceId:'fixture-device'},
    blocks:[{id:'body',kind:'text',format:'plain',text:'Generated partial body',memberIds:[received.id]}],
    members:[{id:received.id,kind:'capture',ref:`capture:${received.id}`}],coverage:{state:'partial',reason:'artifact_pending'},
    fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  let memory=false,ready=false;
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials,undefined,recipes,()=>ready);
  const agent=reader.agent({diagnostics,currentOperation:()=>memory?'memory':'query'});
  assert.deepEqual((await agent.search({query:'GENERATED_ORDINARY_EXPOSURE'})).map(item=>item.id),[materials.evidenceIds(material.ref)[0]]);
  assert.deepEqual((await agent.materialCatalog!({})).items.map(item=>item.ref),[material.ref]);
  assert.match((await agent.materialRead!({ref:material.ref})).text,/Generated partial body/);
  memory=true;
  assert.deepEqual((await agent.materialCatalog!({})).items,[],'a route alone never grants partial Memory');
  ready=true;
  assert.deepEqual((await agent.materialCatalog!({})).items.map(item=>item.ref),[material.ref]);
  recipes.registry.uninstallComponent('mote.source-item-exposure');
  memory=false;
  assert.deepEqual((await agent.materialCatalog!({})).items,[],'a missing declared component fails closed');
});

test('a replaced Material revision revokes prior query refs and synthetic anchors',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-material-query-revocation-'));
  const store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store),recipes=new SourceItemRecipeCatalog(store,'1');
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'revision-source',name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});
  const raw=await sources.upsert('revision-source',{externalId:'document',revision:'1',observedAt:'2026-09-20T00:00:00.000Z',
    text:'Generated original',kind:'message',layer:'original'});
  const draft=(text:string)=>({id:materialId('revision-source','document'),kind:'mote.message',schemaVersion:1,title:'Generated material',
    origin:{sourceId:'revision-source',externalId:'document',deviceId:'generated-device'},
    blocks:[{id:'body',kind:'text' as const,format:'plain',text,memberIds:[raw.id]}],
    members:[{id:raw.id,kind:'capture',ref:`capture:${raw.id}`}],coverage:{state:'complete' as const},
    fidelity:{state:'derived' as const},retention:{original:'retained' as const,policy:'keep' as const}});
  const old=materials.publish(draft('Generated superseded disclosure')),reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials,undefined,recipes);
  const agent=reader.agent({diagnostics}),oldAnchor=materials.evidenceIds(old.ref)[0];
  assert.match((await agent.materialRead!({ref:old.ref})).text,/superseded disclosure/);
  assert.deepEqual((await agent.evidence({ids:[oldAnchor]})).map(row=>row.id),[oldAnchor]);
  const current=materials.publish(draft('Generated corrected disclosure'),{expectedRevision:old.revision});
  assert.notEqual(current.ref,old.ref);
  await assert.rejects(agent.materialRead!({ref:old.ref}),/Material not found/);
  assert.deepEqual(await agent.evidence({ids:[oldAnchor]}),[]);
  assert.match((await agent.materialRead!({ref:current.ref})).text,/corrected disclosure/);
  assert.deepEqual((await agent.evidence({ids:[materials.evidenceIds(current.ref)[0]]})).map(row=>row.id),[materials.evidenceIds(current.ref)[0]]);
  assert.match(materials.read(old.ref).text,/superseded disclosure/,'owner history remains available');
});

test('Coding append retains an active prefix anchor under the current Material scope',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-coding-prefix-scope-'));
  const store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'prefix-coding',name:'Generated Coding',kind:'coding-agent',deviceId:'coding-device',platform:'import'});
  const id=materialId('prefix-coding','session'),member={id:'archive-member',kind:'archive',ref:'archive:prefix-coding/session'};
  const base={id,kind:'mote.coding-session',schemaVersion:1,title:'Generated session',
    origin:{sourceId:'prefix-coding',externalId:'session',deviceId:'coding-device',firstAt:'2026-09-20T00:00:00.000Z',
      lastAt:'2026-09-20T00:00:00.000Z',provider:'codex',projectKey:'generated-project',sessionId:'session'},
    members:[member],coverage:{state:'partial' as const},fidelity:{state:'derived' as const},retention:{original:'retained' as const,policy:'keep' as const}};
  const old=materials.publish({...base,blocks:[{id:'section-0',kind:'text',format:'markdown-fragment',text:'Generated active prefix',memberIds:[member.id]},
    {id:'section-1',kind:'text',format:'markdown-fragment',text:'Generated old tail',memberIds:[member.id]}]},
    {codingSnapshot:{checkpoint:'checkpoint-1',appendEpoch:1,headCount:1}});
  const prefix=materials.evidenceIds(old.ref)[0];
  const current=materials.publish({...base,mode:'append',baseRevision:old.revision,reuseBlocks:1,
    origin:{...base.origin,lastAt:'2026-09-20T00:02:00.000Z'},
    blocks:[{id:'section-1',kind:'text',format:'markdown-fragment',text:'Generated new tail',memberIds:[member.id]}]},
    {expectedRevision:old.revision,codingSnapshot:{checkpoint:'checkpoint-2',appendEpoch:1,headCount:2}});
  assert.ok(materials.evidenceIds(current.ref).includes(prefix));
  const agent=new EvidenceReader(store,sources,undefined,undefined,undefined,materials).agent({diagnostics});
  await assert.rejects(agent.materialRead!({ref:old.ref}),/Material not found/);
  const active=await agent.evidence({ids:[prefix]});assert.equal(active.length,1);
  assert.ok(active[0].provenance?.uri?.startsWith(current.ref),'active prefix must resolve against the current Material head');
  assert.deepEqual(await agent.evidence({ids:[prefix],before:'2026-09-20T00:01:00.000Z'}),[],
    'an old prefix cannot bypass the current session time range');
  assert.match((await agent.materialRead!({ref:current.ref})).text,/Generated active prefix/);
  const page=await agent.materialRead!({ref:current.ref,offset:0,length:10});
  assert.deepEqual(page.originalRefs,[prefix],'the current prefix page must cite its active original anchor');
});

test('a source tombstone revokes model access to prior raw revisions',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-tombstone-exposure-'));
  const store=new Store(directory),sources=new SourceStore(store);
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated-source',name:'Generated source',kind:'custom',deviceId:'generated-device',platform:'import'});
  const old=await sources.upsert('generated-source',{externalId:'item-1',revision:'1',observedAt:'2026-09-20T00:00:00.000Z',
    text:'Generated private body',kind:'message',layer:'original'});
  const reader=new EvidenceReader(store,sources),agent=reader.agent({diagnostics});
  assert.equal((await agent.evidence({ids:[old.id]})).length,1);
  await sources.upsert('generated-source',{externalId:'item-1',revision:'2',observedAt:'2026-09-20T01:00:00.000Z',
    text:'',kind:'message',layer:'original',deleted:true});
  assert.deepEqual(await agent.evidence({ids:[old.id]}),[]);
  assert.equal((await agent.search({query:'Generated private body'})).length,0);
  assert.equal(reader.evidence([old.id]).length,1,'owner history remains available');
});

test('synthetic Material evidence obeys named Memory readiness without blocking unrelated raw captures',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-material-anchor-exposure-'));
  const store=new Store(directory),sources=new SourceStore(store),materials=new MaterialStore(store);
  const recipes=new SourceItemRecipeCatalog(store,'1'),memoryWork=new MaterialMemoryWork(store,materials);
  const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'fixture-anchor-source',name:'Generated source',kind:'custom',deviceId:'fixture-device',platform:'import',retention:'archive'});
  const receipt=await sources.upsert('fixture-anchor-source',{externalId:'doc-1',revision:'v1',observedAt:'2026-09-20T00:00:00.000Z',
    text:'Generated source body',kind:'message',layer:'original'});
  const rawId=randomUUID();await store.ingest({id:rawId,deviceId:'fixture-device',deviceName:'Generated device',platform:'import',source:'note',
    capturedAt:'2026-09-20T00:00:00.000Z',durationMs:0,ocrText:'Generated unrelated raw note'});
  const base:MaterialDraft={id:materialId('fixture-anchor-source','doc-1'),kind:'mote.message',schemaVersion:1,title:'Generated material',
    origin:{sourceId:'fixture-anchor-source',externalId:'doc-1',deviceId:'fixture-device'},
    blocks:[{id:'body',kind:'text',format:'plain',text:'Generated material body',memberIds:[receipt.id]}],
    members:[{id:receipt.id,kind:'capture',ref:`capture:${receipt.id}`}],coverage:{state:'partial',reason:'artifact_pending'},
    artifacts:[{key:'source-body',state:'pending'}],fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}};
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials,undefined,recipes,
    ref=>memoryWork.readyForMemory(ref));
  const agent=reader.agent({diagnostics,currentOperation:()=> 'memory'});
  let material=materials.publish(base);memoryWork.observe(material.id,['source-body']);
  let anchor=materials.evidenceIds(material.ref)[0];assert.ok(anchor);
  assert.deepEqual(await agent.evidence({ids:[anchor]}),[],'pending named artifact blocks synthetic evidence');
  assert.equal((await agent.evidence({ids:[rawId]})).length,1,'unrelated raw evidence keeps its existing Memory path');
  material=materials.publish({...base,artifacts:[{key:'source-body',state:'failed',reason:'generated failure'}]},
    {expectedRevision:material.revision});memoryWork.observe(material.id,['source-body']);
  anchor=materials.evidenceIds(material.ref)[0];assert.ok(anchor);
  assert.deepEqual(await agent.evidence({ids:[anchor]}),[],'failed named artifact blocks synthetic evidence');
  material=materials.publish({...base,artifacts:[{key:'source-body',state:'ready'}]},
    {expectedRevision:material.revision});memoryWork.observe(material.id,['source-body']);
  anchor=materials.evidenceIds(material.ref)[0];assert.ok(anchor);
  assert.equal((await agent.evidence({ids:[anchor]})).length,1,'ready named artifact permits partial synthetic evidence');
});

test('installed Coding recipe routes query partial materials and gate Memory until complete',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-exposure-recipe-'));
  const store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);
  await runtime.ready;
  const sources=new SourceStore(store,runtime),diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
  t.after(async()=>{await runtime.close();await diagnostics.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated-coding-recipe',name:'Generated Coding',kind:'coding-agent',deviceId:'generated-device',platform:'import'});
  const event=(part:number)=>({externalId:`generated-event-${part}`,revision:'1',observedAt:`2026-09-20T02:00:0${part}.000Z`,kind:'message',layer:'snapshot',text:`GENERATED_CODING_PART_${part}`,
    document:{contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-project',sessionId:'generated-session',eventId:'generated-event',role:'user',part,parts:2}}});
  await sources.upsert('generated-coding-recipe',event(0));await runtime.tick();
  const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials,runtime);
  let memory=false;
  const agent=reader.agent({diagnostics,currentOperation:()=>memory?'memory':'query'});
  const partial=materials.list().items[0]!;
  assert.equal(partial.coverage.state,'partial');
  assert.equal(partial.artifacts?.find(item=>item.key==='conversation')?.state,'pending');
  assert.deepEqual((await agent.materialCatalog!({})).items.map(item=>item.ref),[partial.ref]);
  assert.ok((await agent.search({query:'GENERATED_CODING_PART_0'})).some(row=>row.provenance?.uri?.startsWith(partial.ref)),
    'the aggregated Coding session is searchable without a SourceStore capture head');
  assert.ok((await agent.materialRead!({ref:partial.ref})).spans.length);
  assert.equal(reader.materialAllowedForMemory(partial.ref),false);
  memory=true;
  assert.equal((await agent.materialCatalog!({})).items.length,0);
  await assert.rejects(agent.materialRead!({ref:partial.ref}),/Material not found/);
  memory=false;
  runtime.recipes.registry.uninstallComponent('mote.coding-exposure');
  assert.equal((await agent.materialCatalog!({})).items.length,0,'uninstalled recipe component fails closed');
  runtime.recipes.registry.installComponent({id:'mote.coding-exposure',version:'2',kind:'exposure'});
  await sources.upsert('generated-coding-recipe',event(1));await runtime.tick();
  const complete=materials.list().items[0]!;
  assert.equal(complete.coverage.state,'complete');
  assert.equal(complete.artifacts?.find(item=>item.key==='conversation')?.state,'ready');
  assert.equal(reader.materialAllowedForMemory(complete.ref),true);
  memory=true;
  assert.deepEqual((await agent.materialCatalog!({})).items.map(item=>item.ref),[complete.ref]);
});
