import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialOrganizerRuntime,type MaterialOrganizer} from '../src/material-organizers.js';

function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-material-organizers-'));
  const store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources),materials=new MaterialStore(store);
  const organizers=new MaterialOrganizerRuntime(store,materials),archived=new ArchivedFileStore(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,sources,files,materials,organizers,archived,directory};
}
const at=(seconds:number)=>new Date(Date.parse('2026-09-20T00:00:00.000Z')+seconds*1000).toISOString();

test('source items gain scoped formal revisions, retire on tombstone and return after a new revision',async t=>{
  const {store,sources,materials,organizers}=fixture(t);
  sources.register({id:'fixture-source',name:'Generated source',kind:'custom',deviceId:'fixture-device',platform:'import',retention:'archive'});
  const item={externalId:'doc-1',revision:'v1',observedAt:at(0),title:'Generated document',text:'Generated body',kind:'message' as const,layer:'original' as const};
  await sources.upsert('fixture-source',item);
  assert.equal(await organizers.tick(),1);
  const id=materialId('fixture-source',item.externalId),first=materials.get(id)!;
  assert.equal(first.origin.deviceId,'fixture-device');
  assert.equal(first.origin.firstAt,at(0));
  assert.equal(materials.list({deviceId:'fixture-device',after:at(0),before:at(1)}).items[0]?.id,id);
  assert.match(materials.read(first.ref).text,/Generated body/);
  assert.equal(await organizers.tick(),0);
  assert.equal(materials.get(id)?.revision,first.revision);
  await sources.upsert('fixture-source',{...item,revision:'v2',observedAt:at(1),title:'',text:'',deleted:true});
  await organizers.tick(20);
  assert.equal(materials.get(id),undefined);
  assert.equal(store.db.prepare('SELECT retired FROM material_heads WHERE id=?').get(id)?.retired,1);
  await sources.upsert('fixture-source',{...item,revision:'v3',observedAt:at(2),text:'Generated restored body'});
  await organizers.tick(20);
  assert.match(materials.read(id).text,/Generated restored body/);
  assert.equal(materials.get(id)?.origin.firstAt,at(2));
});

test('real FileStore original stays pinned while processing and late attachment changes rebuild its material',async t=>{
  const {store,sources,files,materials,organizers,archived}=fixture(t);
  sources.register({id:'fixture-files',name:'Generated files',kind:'local-files',deviceId:'fixture-phone',platform:'android',retention:'archive'});
  const bytes=Buffer.from('Generated audio bytes'),hash=sha256(bytes);
  const input={sourceId:'fixture-files',previousRevision:null,item:{externalId:'audio-1',revision:'v1',observedAt:at(0),title:'Generated recording',text:'',kind:'file' as const,layer:'original' as const,mimeType:'audio/wav'},relativePath:'recordings/generated.wav',sizeBytes:bytes.length,sha256:hash};
  const upload=files.begin(input,()=>{});files.part(upload.uploadId,0,bytes,()=>{});
  const receipt=await files.commit(upload.uploadId,()=>{});
  await organizers.tick(20);
  const id=materialId('fixture-files','audio-1'),pending=materials.get(id)!;
  assert.equal(pending.coverage.state,'pending');assert.equal(pending.assetCount,1);
  assert.equal(pending.retention.original,'retained');
  assert.equal(materials.read(id).spans.at(-1)?.asset?.hash,hash);

  const artifactId=randomUUID(),chunkId=randomUUID();
  store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifactId,receipt.id,'transcript',at(1),'fixture',JSON.stringify({complete:true,coverage:'full'}));
  store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(chunkId,artifactId,receipt.id,0,1000,'Generated transcript segment','{}');
  store.db.prepare("UPDATE file_jobs SET state='succeeded' WHERE capture_id=?").run(receipt.id);
  await organizers.tick(20);
  assert.equal(materials.get(id)?.coverage.state,'complete');
  assert.match(materials.read(id).text,/Generated transcript segment/);
  const attachment=archived.put({name:'generated.txt',bytes:Buffer.from('Generated attached original')});
  archived.attach(receipt.id,[attachment.id]);
  await organizers.tick(20);
  const attached=materials.get(id)!;assert.equal(attached.assetCount,2);
  assert.ok(materials.read(id).spans.some(span=>span.asset?.hash===attachment.hash));
  assert.ok(materials.read(id).spans.some(span=>span.asset?.hash===hash));
  const correctedId=randomUUID();
  store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(correctedId,receipt.id,'dialogue',at(2),'fixture',JSON.stringify({complete:true,coverage:'full'}));
  store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),correctedId,receipt.id,0,1000,'Generated dialogue correction','{}');
  await organizers.tick(20);
  const latest=materials.read(id).text;
  assert.match(latest,/Generated dialogue correction/);
  assert.doesNotMatch(latest,/Generated transcript segment/);
});

test('coding session keeps the newest 2000 complete JSON events and declares older coverage partial',async t=>{
  const {sources,materials,organizers}=fixture(t);
  sources.register({id:'fixture-coding',name:'Generated coding',kind:'coding-agent',deviceId:'fixture-code-device',platform:'import',retention:'archive'});
  const ids:string[]=[];
  for(let base=0;base<2001;base+=500){
    const batch=Array.from({length:Math.min(500,2001-base)},(_,position)=>{
      const i=base+position;return {externalId:`event-${i}`,revision:'v1',observedAt:at(i),title:`Event ${i}`,text:`Generated event ${i}`,kind:'message' as const,layer:'original' as const,
        document:{coding:{version:1 as const,provider:'codex' as const,sessionId:'fixture-session',projectKey:'fixture-project',eventId:`event-${i}`,role:'assistant' as const,part:0,parts:1}}};
    });
    const receipts=await sources.upsertBatch('fixture-coding',batch);ids.push(...receipts.receipts.map(r=>r.id));
  }
  await organizers.tick(1);
  const externalId=JSON.stringify(['codex','fixture-project','fixture-session']),record=materials.get(materialId('fixture-coding',externalId))!;
  assert.equal(record.coverage.state,'partial');
  assert.equal(record.memberCount,2000);
  assert.equal(record.origin.provider,'codex');assert.equal(record.origin.projectKey,'fixture-project');assert.equal(record.origin.sessionId,'fixture-session');
  assert.equal(materials.members(record.ref,{limit:1}).items[0]?.id,ids[1]);
  assert.equal(materials.members(record.ref,{offset:1999,limit:1}).items[0]?.id,ids[2000]);
  assert.equal(record.origin.deviceId,'fixture-code-device');
});

test('screen group and state interval observe capture changes, then clear deleted evidence',async t=>{
  const {store,materials,organizers}=fixture(t);
  const png=await sharp({create:{width:8,height:8,channels:3,background:'#335577'}}).png().toBuffer();
  const screen={id:randomUUID(),deviceId:'fixture-screen',deviceName:'Generated device',platform:'macos',source:'screen',capturedAt:at(0),durationMs:1000,ocrText:'Generated screen',imageMime:'image/png',imageBase64:png.toString('base64')};
  await store.ingest(screen);
  await organizers.tick(20);
  const segment=materials.list({kind:'mote.screen-segment'}).items[0]!;
  assert.equal(segment.origin.deviceId,'fixture-screen');assert.equal(segment.assetCount,1);
  assert.equal(segment.origin.firstAt,at(0));
  const activity={id:randomUUID(),deviceId:'fixture-screen',deviceName:'Generated device',platform:'macos',source:'activity',appId:'fixture.app',appName:'Generated app',capturedAt:at(5),durationMs:1000,
    privacy:{excluded:false,redacted:false,mode:'none',collection:'activity'},stateSeries:{version:1,samples:[{at:at(5),durationMs:1000}]}};
  await store.ingest(activity);await organizers.tick(20);
  const state=materials.list({kind:'mote.state-series'}).items[0]!;
  assert.equal(state.origin.firstAt,at(5));assert.equal(state.origin.lastAt,at(5));
  await store.ingest({...activity,stateSeries:{version:1,samples:[{at:at(5),durationMs:1000},{at:at(65),durationMs:1000}]}});
  await organizers.tick(20);
  assert.notEqual(materials.get(state.id)?.revision,state.revision);
  assert.equal(materials.get(state.id)?.origin.lastAt,at(65));
  store.delete(screen.id);await organizers.tick(20);
  assert.equal(materials.get(segment.id),undefined);
});

test('failed organizer publish does not advance mapping or change cursor; restart retries once',async t=>{
  const {store,materials}=fixture(t),id=randomUUID();
  const custom:MaterialOrganizer={id:'fixture.probe',version:'1',select:r=>r.id===id?{captureId:r.id}:undefined,
    identity:g=>materialId('fixture-probe',g.captureId),build:()=>{throw Error('generated organizer failure');}};
  const runtime=new MaterialOrganizerRuntime(store,materials,[custom]);
  await store.ingest({id,deviceId:'fixture-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:at(0),durationMs:0,ocrText:'Generated note'});
  await assert.rejects(runtime.tick(),/generated organizer failure/);
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='material-organizer-cursor'").get(),undefined);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM material_organizer_inputs').get()!.n,0);
  const succeeding:MaterialOrganizer={...custom,build:()=>undefined};
  const restarted=new MaterialOrganizerRuntime(store,materials,[succeeding]);
  assert.ok(await restarted.tick()>0);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM material_organizer_inputs WHERE organizer_id='fixture.probe'").get()!.n,1);
});

test('failed replacement with a different identity rolls back retirement and cursor',async t=>{
  const {store,materials,organizers}=fixture(t),captureId=randomUUID();
  await store.ingest({id:captureId,deviceId:'fixture-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:at(0),durationMs:0,ocrText:'Generated retained note'});
  await organizers.tick();
  const previous=materials.list({kind:'mote.note'}).items[0]!;
  const cursor=organizers.status().cursor;
  const replacementId=materialId('fixture-replacement',captureId);
  const plugin:MaterialOrganizer={id:'fixture.exclusive-replacement',version:'1',exclusive:true,
    select:r=>r.id===captureId?{captureId:r.id}:undefined,identity:()=>replacementId,
    build:()=>({id:replacementId,kind:'fixture.replacement',schemaVersion:1,title:'Generated replacement',
      origin:{sourceId:'fixture-replacement',externalId:captureId,deviceId:'fixture-device'},
      blocks:[{id:'missing',kind:'asset',hash:'0'.repeat(64),mimeType:'application/octet-stream',memberIds:[captureId]}],
      members:[{id:captureId,kind:'capture',ref:`capture:${captureId}`}],coverage:{state:'complete'},
      fidelity:{state:'derived'},retention:{original:'unavailable',policy:'keep'}}),
  };
  organizers.registry.register(plugin);
  await assert.rejects(organizers.tick(),/unavailable/i);
  assert.equal(materials.get(previous.ref)?.revision,previous.revision);
  assert.equal(materials.get(previous.id)?.revision,previous.revision);
  assert.equal(materials.get(replacementId),undefined);
  assert.equal(organizers.status().cursor,cursor);
});

test('new higher priority organizer backfills old captures and replaces the fallback head',async t=>{
  const {store,sources,materials,organizers}=fixture(t);
  sources.register({id:'fixture-extensible',name:'Generated source',kind:'custom',deviceId:'fixture-device',platform:'import',retention:'archive'});
  await sources.upsert('fixture-extensible',{externalId:'doc-1',revision:'v1',observedAt:at(0),title:'Generated document',text:'Generated body',kind:'message',layer:'original'});
  await organizers.tick();
  const id=materialId('fixture-extensible','doc-1'),fallback=materials.get(id)!;
  assert.equal(fallback.kind,'mote.message');
  assert.equal(organizers.status().pendingChanges,0);
  const plugin:MaterialOrganizer={id:'fixture.document',version:'1',slot:'source-item',priority:10,
    select:r=>r.provenance?.sourceId==='fixture-extensible'?{externalId:r.provenance.externalId,sourceId:r.provenance.sourceId}:undefined,
    identity:g=>materialId(g.sourceId,g.externalId),
    build(_store,g){
      const head=_store.db.prepare('SELECT capture_id FROM source_heads WHERE source_id=? AND external_id=? AND deleted=0').get(g.sourceId,g.externalId) as {capture_id:string}|undefined;
      if(!head)return;
      return {id:materialId(g.sourceId,g.externalId),kind:'fixture.document',schemaVersion:1,title:'Generated plugin document',
        origin:{sourceId:g.sourceId,externalId:g.externalId,deviceId:'fixture-device',firstAt:at(0),lastAt:at(0)},
        blocks:[{id:'text',kind:'text',format:'plain',text:'Generated plugin body',memberIds:[head.capture_id]}],
        members:[{id:head.capture_id,kind:'capture',ref:`capture:${head.capture_id}`}],coverage:{state:'complete'},
        fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
    }};
  const failing:MaterialOrganizer={...plugin,build(_store,g){
    const draft=plugin.build(_store,g)!;
    return {...draft,blocks:[{id:'missing-original',kind:'asset',hash:'0'.repeat(64),mimeType:'application/octet-stream',memberIds:[]}]};
  }};
  const unregister=organizers.registry.register(failing);
  await assert.rejects(organizers.tick(),/unavailable|not found|missing/i);
  assert.equal(materials.get(id)?.revision,fallback.revision);
  assert.match(materials.read(fallback.ref).text,/Generated body/);
  assert.equal(organizers.status().backfills.find(row=>row.id===plugin.id)?.complete,false);
  unregister();
  organizers.registry.register(plugin);
  assert.equal(organizers.status().backfills.find(row=>row.id===plugin.id)?.complete,false);
  assert.equal(await organizers.tick(),1);
  const replacement=materials.get(id)!;
  assert.equal(replacement.kind,'fixture.document');
  assert.match(materials.read(id).text,/Generated plugin body/);
  assert.equal(materials.get(fallback.ref)?.kind,'mote.message');
  assert.match(materials.read(fallback.ref).text,/Generated body/);
  assert.equal(materials.list({sourceId:'fixture-extensible'}).items.length,1);
  assert.equal(organizers.status().backfills.find(row=>row.id===plugin.id)?.complete,true);
  assert.equal(await organizers.tick(),0);
  assert.equal(materials.get(id)?.revision,replacement.revision);
  assert.equal(store.db.prepare('SELECT organizer_id FROM material_organizer_inputs LIMIT 1').get()?.organizer_id,plugin.id);
});

test('paged backfill replaces a multi-member coding group before all old mappings are rescanned',async t=>{
  const {store,sources,materials,organizers}=fixture(t);
  sources.register({id:'fixture-session-source',name:'Generated coding',kind:'coding-agent',deviceId:'fixture-device',platform:'import',retention:'archive'});
  for(let i=0;i<2;i++)await sources.upsert('fixture-session-source',{
    externalId:`event-${i}`,revision:'v1',observedAt:at(i),title:`Generated ${i}`,text:`Generated body ${i}`,kind:'message',layer:'original',
    document:{coding:{version:1,provider:'codex',sessionId:'session-1',projectKey:'project-1',eventId:`event-${i}`,role:'assistant',part:0,parts:1}},
  });
  while(await organizers.tick(100)>0){}
  const externalId=JSON.stringify(['codex','project-1','session-1']),id=materialId('fixture-session-source',externalId);
  assert.equal(materials.get(id)?.kind,'mote.coding-session');
  const plugin:MaterialOrganizer={id:'fixture.coding-session',version:'2',slot:'coding-session',priority:10,
    select:r=>{const coding=r.provenance?.document?.coding;return coding&&r.provenance?.sourceId==='fixture-session-source'?{
      sourceId:r.provenance.sourceId,provider:coding.provider,projectKey:coding.projectKey,sessionId:coding.sessionId}:undefined;},
    identity:g=>materialId(g.sourceId,JSON.stringify([g.provider,g.projectKey,g.sessionId])),
    build(_store,g){
      const first=_store.db.prepare("SELECT capture_id FROM source_heads WHERE source_id=? AND deleted=0 ORDER BY external_id LIMIT 1").get(g.sourceId) as {capture_id:string}|undefined;
      if(!first)return;
      const sourceExternalId=JSON.stringify([g.provider,g.projectKey,g.sessionId]);
      return {id:materialId(g.sourceId,sourceExternalId),kind:'fixture.coding-session',schemaVersion:1,title:'Generated plugin session',
        origin:{sourceId:g.sourceId,externalId:sourceExternalId,deviceId:'fixture-device',firstAt:at(0),lastAt:at(1),provider:g.provider,projectKey:g.projectKey,sessionId:g.sessionId},
        blocks:[{id:'text',kind:'text',format:'plain',text:'Generated plugin session body',memberIds:[first.capture_id]}],
        members:[{id:first.capture_id,kind:'capture',ref:`capture:${first.capture_id}`}],coverage:{state:'complete'},
        fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
    }};
  organizers.registry.register(plugin);
  assert.equal(await organizers.tick(1),1);
  assert.equal(materials.get(id)?.kind,'fixture.coding-session');
  assert.equal(organizers.status().backfills.find(row=>row.id===plugin.id)?.complete,false);
  const restarted=new MaterialOrganizerRuntime(store,materials,[plugin]);
  assert.equal(restarted.status().backfills.find(row=>row.id===plugin.id)?.cursorRowid,1);
  assert.equal(await restarted.tick(1),1);
  await restarted.tick(1);
  assert.equal(restarted.status().backfills.find(row=>row.id===plugin.id)?.complete,true);
  assert.equal(materials.list({sourceId:'fixture-session-source'}).items.length,1);
  assert.equal(materials.get(id)?.kind,'fixture.coding-session');
});
