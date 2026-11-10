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
import {Operations} from '../src/operations.js';
import {linkOperationParent} from '../src/operation-projection.js';
import {MaterialMemoryWork} from '../src/material-memory-work.js';

function fixture(t:TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-material-organizers-'));
  const store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources),materials=new MaterialStore(store);
  const organizers=new MaterialOrganizerRuntime(store,materials),archived=new ArchivedFileStore(store);
  const cleanup:Array<()=>Promise<void>>=[];t.after(async()=>{for(const close of cleanup.reverse())await close();await organizers.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,sources,files,materials,organizers,archived,directory,cleanup};
}
const at=(seconds:number)=>new Date(Date.parse('2026-09-20T00:00:00.000Z')+seconds*1000).toISOString();

test('retained uploaded recording moves from pending through blocked to pending again without losing its original or anchors',async t=>{
  const {store,sources,files,materials,organizers}=fixture(t);
  sources.register({id:'fixture-readiness',name:'Generated audio source',kind:'local-files',deviceId:'fixture-device',platform:'import',retention:'archive'});
  sources.updateContext('fixture-readiness',{expectedVersion:0,description:'Generated owner recording declaration. Preserve other speakers.'});
  const bytes=Buffer.from('Generated retained recording');
  const upload=files.begin({sourceId:'fixture-readiness',previousRevision:null,item:{externalId:'recording',revision:'v1',observedAt:at(0),title:'Generated recording',text:'',kind:'file',layer:'original',mimeType:'audio/wav'},relativePath:'generated.wav',sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
  files.part(upload.uploadId,0,bytes,()=>{});const receipt=await files.commit(upload.uploadId,()=>{});
  await organizers.tick(20);const id=materialId('fixture-readiness','recording'),pending=materials.get(id)!,anchors=materials.evidenceIds(id);
  assert.equal(pending.coverage.state,'pending');
  assert.equal(pending.attributionContext?.sourceContextStatements?.[0]?.description,'Generated owner recording declaration. Preserve other speakers.');
  store.db.prepare("UPDATE file_jobs SET state='blocked',error='processor_still_running' WHERE capture_id=?").run(receipt.id);
  await organizers.tick(20);const blocked=materials.get(id)!;assert.equal(blocked.coverage.state,'partial');
  store.db.prepare("UPDATE file_jobs SET state='waiting',error=NULL WHERE capture_id=?").run(receipt.id);
  await organizers.tick(20);const resumed=materials.get(id)!;
  assert.equal(resumed.coverage.state,'pending');assert.equal(resumed.artifacts?.find(a=>a.key==='extracted-text')?.state,'pending');
  assert.notEqual(resumed.revision,pending.revision);assert.equal(resumed.sequence,blocked.sequence+1);
  assert.equal(materials.get(blocked.ref)?.coverage.state,'partial');assert.deepEqual(materials.evidenceIds(id),anchors);
  assert.ok(materials.read(id).spans.some(span=>span.asset?.hash===sha256(bytes)));assert.equal(organizers.status().pendingSteps,0);
  assert.deepEqual(resumed.attributionContext?.sourceContextDeclarations,pending.attributionContext?.sourceContextDeclarations);
  const revision=resumed.revision;assert.equal(await organizers.tick(20),0);assert.equal(materials.get(id)?.revision,revision);
});

test('formal evidence preserves declared source role and three distinct times without interpreting body metadata',async t=>{
  const {sources,materials,organizers}=fixture(t);
  sources.register({id:'fixture-provenance',name:'Generated source',kind:'custom',deviceId:'fixture-device',platform:'import',retention:'archive'});
  const document={recordedAt:at(-86_400),occurredAt:at(-172_800),timeBasis:'occurred' as const,contentRole:'authored' as const};
  const text=JSON.stringify({documentTime:{recordedAt:at(999),contentRole:'transcript'},text:'Generated authored diary, with quoted metadata.'});
  await sources.upsert('fixture-provenance',{externalId:'authored',revision:'1',kind:'message',layer:'original',observedAt:at(0),document,text});
  await sources.upsert('fixture-provenance',{externalId:'unknown',revision:'1',kind:'message',layer:'original',observedAt:at(1),text});
  await organizers.tick(20);
  const authored=materials.evidence(materials.evidenceIds(materialId('fixture-provenance','authored')))[0]!;
  assert.deepEqual(authored.provenance?.document,document);
  assert.equal(authored.capturedAt,at(0));
  assert.equal(authored.ocrText,text,'the captured body remains literal evidence; JSON inside prose is never decoded');
  const unknown=materials.evidence(materials.evidenceIds(materialId('fixture-provenance','unknown')))[0]!;
  assert.equal(unknown.capturedAt,at(1));
  assert.deepEqual(unknown.provenance?.document,{timeBasis:'unknown',contentRole:'other'});
  assert.equal(unknown.provenance?.document?.recordedAt,undefined,'an import timestamp is not an original recording date');
});

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
  assert.equal(materials.list({query:'Generated body'}).items[0]?.id,id,'published ordinary materials join material search');
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

test('ordinary source-item work pins a declared recipe and fails closed without its raw reader',async t=>{
  const {sources,materials,organizers,store}=fixture(t);
  sources.register({id:'fixture-recipe',name:'Generated source',kind:'custom',deviceId:'fixture-device',platform:'import',retention:'archive'});
  await sources.upsert('fixture-recipe',{externalId:'doc-1',revision:'v1',observedAt:at(0),text:'Generated declared recipe body',kind:'message',layer:'original'});
  organizers.sourceItemRecipes.registry.uninstallComponent('mote.capture-raw-reader');
  await assert.rejects(organizers.tick(),/recipe|component/i);
  assert.equal(organizers.status().cursor,0,'failed recipe resolution cannot advance discovery');
  assert.equal(materials.list().items.length,0);
  organizers.sourceItemRecipes.registry.installComponent({id:'mote.capture-raw-reader',version:'1',kind:'raw-reader'});
  await organizers.tick();
  const input=JSON.parse(String(store.db.prepare("SELECT input FROM execution_steps WHERE kind='material.organizer' AND json_extract(input,'$.organizerId')='mote.source-item'").get()?.input));
  const pin=organizers.sourceItemRecipes.resolveForSourceId('fixture-recipe');
  assert.equal(input.recipe.recipeId,pin.recipeId);
  assert.equal(input.recipe.configFingerprint,pin.configFingerprint);
  assert.match(materials.read(materialId('fixture-recipe','doc-1')).text,/Generated declared recipe body/);
});

test('ordinary material revisions and retirement update the fenced Memory request',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-material-memory-organizer-'));
  const store=new Store(directory),materials=new MaterialStore(store),memoryWork=new MaterialMemoryWork(store,materials);
  const sources=new SourceStore(store,undefined,memoryWork.inputs);
  const organizers=new MaterialOrganizerRuntime(store,materials,[],undefined,memoryWork);
  t.after(async()=>{await organizers.close();store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'fixture-memory-source',name:'Generated source',kind:'custom',deviceId:'fixture-device',platform:'import',retention:'archive'});
  const item={externalId:'doc-1',revision:'v1',observedAt:at(0),text:'Generated body',kind:'message' as const,layer:'original' as const};
  await sources.upsert('fixture-memory-source',item);
  await organizers.tick();
  const id=materialId('fixture-memory-source','doc-1'),first=materials.get(id)!;
  const request=()=>store.db.prepare('SELECT revision,required_json,job_id FROM material_memory_requests WHERE material_id=?').get(id) as
    {revision:string;required_json:string;job_id:string|null}|undefined;
  assert.equal(request()?.revision,first.revision);
  assert.deepEqual(JSON.parse(request()!.required_json),['source-body']);
  store.db.prepare('UPDATE material_memory_requests SET job_id=? WHERE material_id=?').run('generated-old-job',id);
  await sources.upsert('fixture-memory-source',{...item,revision:'v2',observedAt:at(1),text:'Generated revised body'});
  await organizers.tick();
  const second=materials.get(id)!;
  assert.notEqual(second.revision,first.revision);
  assert.equal(request()?.revision,second.revision);
  assert.equal(request()?.job_id,null);
  assert.equal(store.db.prepare('SELECT job_id FROM material_memory_revocations WHERE job_id=?').get('generated-old-job')?.job_id,'generated-old-job');
  await sources.upsert('fixture-memory-source',{...item,revision:'v3',observedAt:at(2),deleted:true,text:''});
  await organizers.tick();
  assert.equal(materials.get(id),undefined);
  assert.equal(request(),undefined);
});

test('installing organizers over an existing source archive backfills readable materials without authorizing model work',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-existing-source-memory-'));
  const store=new Store(directory),materials=new MaterialStore(store),work=new MaterialMemoryWork(store,materials),sources=new SourceStore(store,undefined,work.inputs);
  sources.register({id:'fixture-existing',name:'Generated archive',kind:'custom',deviceId:'fixture',platform:'import',retention:'archive'});
  await sources.upsert('fixture-existing',{externalId:'old',revision:'1',observedAt:at(0),text:'Generated existing original',kind:'message',layer:'original'});
  const organizers=new MaterialOrganizerRuntime(store,materials,[],undefined,work);
  t.after(async()=>{await organizers.close();store.close();rmSync(directory,{recursive:true,force:true});});
  for(let i=0;i<8;i++)await organizers.tick();
  const old=materials.get(materialId('fixture-existing','old'))!;assert.ok(old);
  assert.equal(work.readyForMemory(old.ref),true);assert.equal(materials.list({query:'existing original'}).items[0]?.id,old.id);
  let calls=0;const runner={create:()=>{calls++;return {id:'fixture'};},get:()=>({status:'completed'}),run:async()=>{},cancel:()=>{}};
  assert.equal(work.drain(runner,true),0);assert.equal(calls,0);
  await sources.upsert('fixture-existing',{externalId:'new',revision:'1',observedAt:at(1),text:'Generated new original',kind:'message',layer:'original'});
  await organizers.tick();work.drain(runner,true);assert.equal(calls,1);
});

test('real FileStore original stays pinned while processing and late attachment changes rebuild its material',async t=>{
  const {store,sources,files,materials,organizers,archived}=fixture(t);
  sources.register({id:'fixture-files',name:'Generated files',kind:'local-files',deviceId:'fixture-phone',platform:'android',retention:'archive'});
  const bytes=Buffer.from('Generated audio bytes'),hash=sha256(bytes);
  const input={sourceId:'fixture-files',previousRevision:null,item:{externalId:'audio-1',revision:'v1',observedAt:at(0),document:{recordedAt:at(-86_400),timeBasis:'recorded' as const,contentRole:'other' as const},title:'Generated recording',text:'',kind:'file' as const,layer:'original' as const,mimeType:'audio/wav'},relativePath:'recordings/generated.wav',sizeBytes:bytes.length,sha256:hash};
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
  const transcript=materials.evidence(materials.evidenceIds(id)).find(record=>record.ocrText==='Generated transcript segment')!;
  assert.equal(transcript.capturedAt,at(0));
  assert.deepEqual(transcript.provenance?.document,{recordedAt:at(-86_400),timeBasis:'recorded',contentRole:'transcript'});
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
  const corrected=materials.evidence(materials.evidenceIds(id)).find(record=>record.ocrText==='Generated dialogue correction')!;
  assert.equal(corrected.provenance?.document?.contentRole,'transcript');
  assert.equal(corrected.provenance?.document?.recordedAt,at(-86_400));
});

test('provider transcripts beyond the old segment cap remain complete and losslessly blocked',async t=>{
  const {store,sources,files,materials,organizers}=fixture(t);
  sources.register({id:'fixture-long-transcript',name:'Generated long transcript',kind:'local-files',deviceId:'fixture-device',platform:'import',retention:'archive'});
  const bytes=Buffer.from('Generated transcript original'),hash=sha256(bytes);
  const upload=files.begin({sourceId:'fixture-long-transcript',previousRevision:null,item:{externalId:'long-recording',revision:'v1',observedAt:at(0),title:'Generated long recording',text:'',kind:'file',layer:'original',mimeType:'audio/wav'},relativePath:'generated-long.wav',sizeBytes:bytes.length,sha256:hash},()=>{});
  files.part(upload.uploadId,0,bytes,()=>{});const receipt=await files.commit(upload.uploadId,()=>{});
  await organizers.tick(20);
  const artifactId=randomUUID();
  store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifactId,receipt.id,'transcript',at(1),'fixture',JSON.stringify({complete:true,coverage:'full',providerSupplied:true}));
  store.db.exec('BEGIN IMMEDIATE');
  try{
    const insert=store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)');
    for(let index=0;index<19992;index++)insert.run(randomUUID(),artifactId,receipt.id,index*1000,index*1000+1000,index===19991?'Generated final transcript segment':`Generated transcript segment ${index}`,'{}');
    store.db.exec('COMMIT');
  }catch(error){if(store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
  // Each fixture chunk is one insert and therefore one change. Collapse that
  // construction backlog to the job completion change this test exercises.
  store.db.prepare("UPDATE settings SET value=CAST((SELECT max(seq) FROM changes) AS TEXT) WHERE key='material-organizer-cursor'").run();
  store.db.prepare("UPDATE file_jobs SET state='succeeded' WHERE capture_id=?").run(receipt.id);
  await organizers.tick(20);
  const material=materials.get(materialId('fixture-long-transcript','long-recording'))!;
  assert.ok(material);assert.equal(material.coverage.state,'complete');
  assert.ok(material.blockCount>19991,'every transcript segment is published rather than dropped at the old limit');
  assert.match(materials.block(material.ref,material.blockCount-2)!.block.text,/Generated final transcript segment/);
  assert.ok(!material.fidelity.limitations?.includes('recording_segment_limit'));
});

test('notes keep every attachment beyond the old 2000-row attachment projection',async t=>{
  const {store,materials,organizers}=fixture(t);
  const captureId=randomUUID(),createdAt=at(0);
  await store.ingest({id:captureId,deviceId:'fixture-device',deviceName:'Generated device',platform:'import',source:'note',capturedAt:createdAt,durationMs:0,ocrText:'Generated note with many attachments'});
  const asset=store.assets.put(Buffer.from('G')),hash=asset.hash,now=new Date().toISOString();
  store.db.prepare('INSERT OR IGNORE INTO file_blobs(hash,bytes) VALUES(?,?)').run(hash,1);
  store.db.exec('BEGIN IMMEDIATE');
  try{
    for(let index=0;index<2001;index++){
      const id=randomUUID(),value={id,hash,name:`generated-${index}.txt`,relativePath:`generated/${index}.txt`,mimeType:'text/plain',sizeBytes:1,createdAt:now};
      store.db.prepare('INSERT INTO archived_files(id,hash,json) VALUES(?,?,?)').run(id,hash,JSON.stringify(value));
      store.db.prepare('INSERT INTO capture_files(capture_id,file_id) VALUES(?,?)').run(captureId,id);
    }
    store.db.exec('COMMIT');
  }catch(error){if(store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
  // Attachment triggers record one change per fixture row; skip that construction
  // backlog and treat the completed note as the next observed change.
  store.db.prepare("UPDATE settings SET value=CAST((SELECT max(seq) FROM changes) AS TEXT) WHERE key='material-organizer-cursor'").run();
  store.db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'upsert',?)").run(captureId,new Date().toISOString());
  await organizers.tick(20);
  const material=materials.list({kind:'mote.note'}).items[0]!;
  assert.ok(material);assert.equal(material.assetCount,2001);
  assert.ok(!material.fidelity.limitations?.includes('attachment_limit'));
  assert.equal(materials.members(material.ref,{limit:1}).items.length,1);
  asset.release();
});

test('coding session keeps every complete JSON event without an old newest-2000 truncation',async t=>{
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
  while(organizers.status().pendingChanges>0)await organizers.tick(500);
  const externalId=JSON.stringify(['codex','fixture-project','fixture-session']),record=materials.get(materialId('fixture-coding',externalId))!;
  assert.equal(record.coverage.state,'complete');
  assert.equal(record.memberCount,2001);
  assert.equal(record.origin.provider,'codex');assert.equal(record.origin.projectKey,'fixture-project');assert.equal(record.origin.sessionId,'fixture-session');
  assert.equal(materials.members(record.ref,{limit:1}).items[0]?.id,ids[0]);
  assert.equal(materials.members(record.ref,{offset:2000,limit:1}).items[0]?.id,ids[2000]);
  assert.equal(record.origin.deviceId,'fixture-code-device');
});

test('screen group and state interval observe capture changes, then clear deleted evidence',async t=>{
  const {store,materials,organizers}=fixture(t);
  const png=await sharp({create:{width:8,height:8,channels:3,background:'#335577'}}).png().toBuffer();
  const screen={id:randomUUID(),deviceId:'fixture-screen',deviceName:'Generated device',platform:'macos',source:'screen',capturedAt:at(0),durationMs:1000,ocrText:'Generated screen',imageMime:'image/png',imageBase64:png.toString('base64')};
  await store.ingest(screen);
  await organizers.tick(20);
  const segment=materials.list({kind:'mote.screen-segment'}).items[0]!;
  assert.equal(segment.origin.deviceId,'fixture-screen');assert.equal(segment.assetCount,0);
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

test('high-frequency screen material compresses OCR and exposes only three selected frame refs',async t=>{
  const {store,materials,organizers}=fixture(t);
  const png=await sharp({create:{width:8,height:8,channels:3,background:'#335577'}}).png().toBuffer();
  const ids:string[]=[];
  for(let index=0;index<40;index++){
    const id=randomUUID();ids.push(id);
    await store.ingest({id,deviceId:'fixture-screen',deviceName:'Generated device',platform:'macos',source:'screen',appId:'fixture.app',appName:'Generated App',
      capturedAt:at(index*5),durationMs:5000,ocrText:index<10?'Generated repeated OCR':'Generated changed OCR',imageMime:'image/png',imageBase64:png.toString('base64')});
  }
  await organizers.tick(100);
  const segment=materials.list({kind:'mote.screen-segment'}).items[0]!;
  assert.equal(materials.list({kind:'mote.screen-segment'}).items.length,1);
  assert.equal(segment.memberCount,40,'all originals remain traceable in the material');
  assert.equal(segment.assetCount,0,'query material pages never embed per-screenshot image assets');
  const page=materials.read(segment.ref,{length:12000});
  const exposed=[...new Set(page.spans.flatMap(span=>span.memberIds))];
  assert.deepEqual(exposed,[ids[0],ids[19],ids[39]]);
  assert.match(page.text,/"sampleCount":40/);
  assert.match(page.text,/"distinctOcrCount":2/);
  assert.equal((page.text.match(/Generated repeated OCR/g)??[]).length,2,'a repeated OCR state appears once in the distinct list and once as a keyframe');
  assert.ok(!page.text.includes(ids[17]),'unsampled capture IDs are absent from the Agent-facing text');
});

test('a partially discovered change backlog cannot publish an older group checkpoint',async t=>{
  const {sources,materials,organizers}=fixture(t);
  sources.register({id:'fixture-backlog',name:'Generated Coding',kind:'coding-agent',deviceId:'fixture-device',platform:'import',retention:'archive'});
  const event=(part:number)=>({externalId:`event-${part}`,revision:'v1',observedAt:at(part),text:`Generated part ${part}`,kind:'message' as const,layer:'original' as const,
    document:{coding:{version:1 as const,provider:'codex' as const,projectKey:'fixture-project',sessionId:'fixture-session',eventId:`event-${part}`,role:'assistant' as const,part:0,parts:1}}});
  await sources.upsert('fixture-backlog',event(0));await sources.upsert('fixture-backlog',event(1));
  const id=materialId('fixture-backlog',JSON.stringify(['codex','fixture-project','fixture-session']));
  assert.equal(await organizers.tick(1),1);
  assert.equal(materials.get(id),undefined,'the first change cannot publish while a related second change remains undiscovered');
  assert.equal(await organizers.tick(1),1);
  assert.equal(materials.get(id)?.memberCount,2);
});

test('a source deletion during build revokes the old worker before publication',async t=>{
  const {store,materials,organizers}=fixture(t),captureId=randomUUID(),materialKey=materialId('fixture-revoked',captureId);
  let deleted=false;
  organizers.registry.register({id:'fixture.revoked',version:'1',exclusive:true,
    select:r=>r.id===captureId?{captureId:r.id}:undefined,identity:()=>materialKey,
    build(reader){const record=reader.capture();if(!record)return;
      if(!deleted){deleted=true;store.delete(captureId);}
      return {id:materialKey,kind:'fixture.revoked',schemaVersion:1,title:'Generated old input',
        origin:{sourceId:'fixture-revoked',externalId:captureId,deviceId:record.deviceId},
        blocks:[{id:'body',kind:'text',format:'plain',text:record.ocrText,memberIds:[captureId]}],
        members:[{id:captureId,kind:'capture',ref:`capture:${captureId}`}],coverage:{state:'complete'},
        fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};},
  });
  await store.ingest({id:captureId,deviceId:'fixture-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:at(0),durationMs:0,ocrText:'Generated original'});
  await organizers.tick();
  assert.equal(materials.get(materialKey),undefined);
  assert.equal(store.db.prepare("SELECT state FROM execution_steps WHERE kind='material.organizer' AND json_extract(input,'$.organizerId')='fixture.revoked'").get()?.state,'stale');
  await organizers.tick();
  assert.equal(materials.get(materialKey),undefined);
});

test('failed organizer stays terminal across restart until explicitly retried',async t=>{
  const {store,materials,cleanup}=fixture(t),id=randomUUID();
  const custom:MaterialOrganizer={id:'fixture.probe',version:'1',select:r=>r.id===id?{captureId:r.id}:undefined,
    identity:g=>materialId('fixture-probe',g.captureId),build:()=>{throw Error('generated organizer failure');}};
  const runtime=new MaterialOrganizerRuntime(store,materials,[custom]);cleanup.push(()=>runtime.close());
  await store.ingest({id,deviceId:'fixture-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:at(0),durationMs:0,ocrText:'Generated note'});
  await assert.rejects(runtime.tick(),/generated organizer failure/);
  assert.equal(runtime.status().cursor,1,'the cursor records durable discovery even when execution fails');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM material_organizer_inputs WHERE organizer_id='fixture.probe'").get()!.n,1);
  assert.equal(runtime.status().pendingSteps,0);assert.equal(runtime.status().failedSteps,1);
  const failed=store.db.prepare("SELECT id,attempts FROM execution_steps WHERE kind='material.organizer' AND state='failed'").get()!;
  await runtime.close();
  const succeeding:MaterialOrganizer={...custom,build:()=>undefined};
  const restarted=new MaterialOrganizerRuntime(store,materials,[succeeding]);
  cleanup.push(()=>restarted.close());
  assert.equal(await restarted.tick(),0,'startup cannot replay a deterministic failure');
  assert.equal(restarted.status().failedSteps,1);
  assert.equal(store.db.prepare('SELECT attempts FROM execution_steps WHERE id=?').get(failed.id)!.attempts,failed.attempts);
  restarted.executor.retry(String(failed.id),true);
  assert.equal(await restarted.tick(),0,'explicit retry consumes the persisted step without rediscovering the capture');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM material_organizer_inputs WHERE organizer_id='fixture.probe'").get()!.n,1);
  assert.equal(restarted.status().pendingSteps,0);
  assert.equal(restarted.status().failedSteps,0);
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
  assert.equal(materials.list({query:'Generated retained note'}).items[0]?.id,previous.id,'failed replacement keeps the old searchable head');
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
    build(reader,g){
      const head=reader.sourceHead();if(!head)return;
      return {id:materialId(g.sourceId,g.externalId),kind:'fixture.document',schemaVersion:1,title:'Generated plugin document',
        origin:{sourceId:g.sourceId,externalId:g.externalId,deviceId:'fixture-device',firstAt:at(0),lastAt:at(0)},
        blocks:[{id:'text',kind:'text',format:'plain',text:'Generated plugin body',memberIds:[head.id]}],
        members:[{id:head.id,kind:'capture',ref:`capture:${head.id}`}],coverage:{state:'complete'},
        fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
    }};
  const failing:MaterialOrganizer={...plugin,build(reader,g){
    const draft=plugin.build(reader,g)!;
    return {...draft,blocks:[{id:'missing-original',kind:'asset',hash:'0'.repeat(64),mimeType:'application/octet-stream',memberIds:[]}]};
  }};
  const unregister=organizers.registry.register(failing);
  await assert.rejects(organizers.tick(),/unavailable|not found|missing/i);
  assert.equal(materials.get(id)?.revision,fallback.revision);
  assert.match(materials.read(fallback.ref).text,/Generated body/);
  assert.equal(organizers.status().backfills.find(row=>row.id===plugin.id)?.complete,true,'the scan completed, while its execution remains failed');
  assert.equal(organizers.status().pendingSteps,0);assert.ok(organizers.status().failedSteps>0);
  unregister();
  organizers.registry.register(plugin);
  assert.equal(organizers.status().failedSteps,1,'registering the same component version cannot replay a terminal failure');
  const failed=store.db.prepare("SELECT id FROM execution_steps WHERE kind='material.organizer' AND state='failed' AND json_extract(input,'$.organizerId')=?").get(plugin.id)!;
  organizers.executor.retry(String(failed.id),true);
  assert.equal(await organizers.tick(),0,'the corrected pinned component retries its durable step');
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

test('organizer plugins build from a bounded group reader without a Store handle',async t=>{
  const {store,sources,materials,organizers}=fixture(t);
  sources.register({id:'fixture-reader',name:'Generated source',kind:'custom',deviceId:'fixture-device',platform:'import',retention:'archive'});
  const first=await sources.upsert('fixture-reader',{externalId:'allowed',revision:'v1',observedAt:at(0),text:'Generated allowed evidence',kind:'message',layer:'original'});
  const other=await sources.upsert('fixture-reader',{externalId:'other',revision:'v1',observedAt:at(1),text:'Generated other evidence',kind:'message',layer:'original'});
  let builds=0;
  organizers.registry.register({id:'fixture.scoped-reader',version:'1',slot:'source-item',priority:10,
    select:r=>r.provenance?.sourceId==='fixture-reader'&&r.provenance.externalId==='allowed'?{sourceId:r.provenance.sourceId,externalId:r.provenance.externalId}:undefined,
    identity:g=>materialId(g.sourceId,g.externalId),
    build(reader,g){
      builds++;
      assert.deepEqual(Object.keys(reader).sort(),['capture','codingSession','file','mediaIntervals','screenGroup','uiPageGroup','sourceHead'].sort());
      assert.equal(Object.isFrozen(reader),true);
      assert.equal('db' in reader,false);
      assert.equal('store' in reader,false);
      assert.equal('ingest' in reader,false);
      assert.equal(reader.capture(),undefined);
      assert.deepEqual(reader.codingSession(),{records:[]});
      assert.deepEqual(reader.screenGroup(),{records:[]});
      assert.deepEqual(reader.uiPageGroup(),{records:[]});
      assert.equal(reader.file(other.id),undefined);
      const record=reader.sourceHead();assert.equal(record?.id,first.id);
      assert.equal(reader.file(other.id),undefined);
      assert.deepEqual(reader.file(first.id)?.attachments,[]);
      return {id:materialId(g.sourceId,g.externalId),kind:'fixture.scoped-reader',schemaVersion:1,title:'Generated scoped material',
        origin:{sourceId:g.sourceId,externalId:g.externalId,deviceId:record!.deviceId},
        blocks:[{id:'body',kind:'text',format:'plain',text:record!.ocrText??'',memberIds:[record!.id]}],
        members:[{id:record!.id,kind:'capture',ref:`capture:${record!.id}`}],coverage:{state:'complete'},
        fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
    },
  });
  await organizers.tick(20);
  assert.ok(builds>0);
  assert.match(materials.read(materialId('fixture-reader','allowed')).text,/Generated allowed evidence/);
  assert.equal(store.evidence([other.id])[0]?.id,other.id);
});

test('paged backfill replaces a multi-member coding group before all old mappings are rescanned',async t=>{
  const {store,sources,materials,organizers,cleanup}=fixture(t);
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
    build(reader,g){
      const first=reader.codingSession().records[0];
      if(!first)return;
      const sourceExternalId=JSON.stringify([g.provider,g.projectKey,g.sessionId]);
      return {id:materialId(g.sourceId,sourceExternalId),kind:'fixture.coding-session',schemaVersion:1,title:'Generated plugin session',
        origin:{sourceId:g.sourceId,externalId:sourceExternalId,deviceId:'fixture-device',firstAt:at(0),lastAt:at(1),provider:g.provider,projectKey:g.projectKey,sessionId:g.sessionId},
        blocks:[{id:'text',kind:'text',format:'plain',text:'Generated plugin session body',memberIds:[first.id]}],
        members:[{id:first.id,kind:'capture',ref:`capture:${first.id}`}],coverage:{state:'complete'},
        fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}};
    }};
  organizers.registry.register(plugin);
  assert.equal(await organizers.tick(1),1);
  assert.equal(materials.get(id)?.kind,'fixture.coding-session');
  assert.equal(organizers.status().backfills.find(row=>row.id===plugin.id)?.complete,false);
  const restarted=new MaterialOrganizerRuntime(store,materials,[plugin]);cleanup.push(()=>restarted.close());
  assert.equal(restarted.status().backfills.find(row=>row.id===plugin.id)?.cursorRowid,1);
  assert.equal(await restarted.tick(1),1);
  await restarted.tick(1);
  assert.equal(restarted.status().backfills.find(row=>row.id===plugin.id)?.complete,true);
  assert.equal(materials.list({sourceId:'fixture-session-source'}).items.length,1);
  assert.equal(materials.get(id)?.kind,'fixture.coding-session');
});


test('organizer status excludes historical failures and counts current failures separately through source revisions',async t=>{
 const {store,sources,materials,cleanup}=fixture(t);let fail=true;
 const runtime=new MaterialOrganizerRuntime(store,materials,[{id:'fixture.status-count',version:'1',slot:'source-item',priority:100,exclusive:true,
  select:r=>r.provenance?.sourceId==='fixture-status'?{sourceId:'fixture-status',externalId:r.provenance.externalId}:undefined,
  identity:g=>materialId(g.sourceId,g.externalId),build:()=>{if(fail)throw Error('Generated failure');return undefined;}}]);
 cleanup.push(()=>runtime.close());
 sources.register({id:'fixture-status',kind:'custom',name:'Generated source',deviceId:'fixture-device',platform:'import'});
 const item={externalId:'generated',revision:'1',kind:'message',layer:'original',observedAt:at(0),text:'Generated v1'};
 await sources.upsert('fixture-status',item);await assert.rejects(runtime.tick(),/Generated failure/);
 assert.equal(runtime.status().pendingSteps,0);assert.equal(runtime.status().failedSteps,1);
 const old=store.db.prepare("SELECT id,operation_id FROM execution_steps WHERE kind='material.organizer' AND state='failed'").get()!;
 linkOperationParent(store,'workflow:fixture-parent',String(old.operation_id));
 assert.equal(runtime.status().failedSteps,1,'parent membership does not multiply a step');
 runtime.executor.retry(String(old.id),false);assert.equal(runtime.status().pendingSteps,1);assert.equal(runtime.status().failedSteps,0);
 await runtime.tick();assert.equal(runtime.status().pendingSteps,0);assert.equal(runtime.status().failedSteps,1);
 fail=false;await sources.upsert('fixture-status',{...item,revision:'2',text:'Generated v2'});
 assert.equal(runtime.status().failedSteps,1,'a saved source update alone must not hide failure before a replacement exists');
 await runtime.tick();assert.equal(runtime.status().pendingSteps,0);assert.equal(runtime.status().failedSteps,0);
 const detail=new Operations(store).detail(String(old.operation_id));assert.equal(detail.operation.state,'succeeded');
 assert.equal(detail.steps.find(step=>step.id===old.id)?.current,false);assert.equal(detail.steps.find(step=>step.id===old.id)?.state,'failed');
 fail=true;await sources.upsert('fixture-status',{...item,revision:'3',text:'Generated v3'});await assert.rejects(runtime.tick(),/Generated failure/);
 assert.equal(runtime.status().failedSteps,1);assert.equal(runtime.status().pendingSteps,0);
 await runtime.close();
 const restarted=new MaterialOrganizerRuntime(store,materials);cleanup.push(()=>restarted.close());
 assert.equal(restarted.status().failedSteps,1,'a missing plugin must not silently remove the current failure');
});
