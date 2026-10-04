import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FILE_PART_BYTES,type FileRevision} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {FileEvidenceRequests} from '../src/file-evidence.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
import {TRANSCRIPT_OUTPUT} from '../src/file-recipes.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {CaptureRawReader} from '../src/capture-raw-reader.js';
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'mote-snapshot-fixture-')),store=new Store(dir,{maxStorageBytes:100*1024*1024}),sources=new SourceStore(store),files=new FileStore(store,sources);sources.register({id:'fixture',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'macos',retention:'snapshot'});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {store,sources,files};}
async function upload(files:FileStore,bytes:Buffer,allowRead=false,mimeType='text/plain'){
 const hash=sha256(bytes),m:FileRevision={sourceId:'fixture',previousRevision:null,sizeBytes:bytes.length,sha256:hash,relativePath:'generated.txt',item:{externalId:'generated-file',revision:hash,observedAt:'2026-10-01T00:00:00Z',title:'Generated',kind:'file',layer:'snapshot',text:'',mimeType,deleted:false,document:{fileIndex:{version:1,fileId:'generated-file',contentVersion:hash,mode:'index',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,maxIndexCharacters:8000,allowRead}}}};
 const s=files.begin(m,()=>{});for(let part=0;part<Math.ceil(bytes.length/FILE_PART_BYTES);part++)files.part(s.uploadId,part,bytes.subarray(part*FILE_PART_BYTES,(part+1)*FILE_PART_BYTES),()=>{});return files.commit(s.uploadId,()=>{});
}
test('central snapshot extraction ignores legacy client caps, removes raw bytes, and never grants original access',async t=>{
 const {files,store}=fixture(t),bytes=Buffer.from('Generated '+'x'.repeat(10000)),ack=await upload(files,bytes),processing=new FileProcessing(files);t.after(()=>processing.close());
 assert.equal(files.detail(ack.id).hasOriginal,false);assert.throws(()=>[...files.bytes(ack.id)],{statusCode:404});assert.deepEqual(Buffer.concat([...files.processingBytes(ack.id)]),bytes);
 await processing.tick();assert.equal(files.detail(ack.id).job.state,'succeeded');assert.equal(files.chunks(ack.id).map(c=>c.ocrText).join(''),bytes.toString());assert.equal(files.detail(ack.id).item.document?.fileIndex?.coverage,'full');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_text').get()!.n,0);assert.throws(()=>[...files.processingBytes(ack.id)],{statusCode:410});assert.throws(()=>store.assets.get(sha256(bytes)),{statusCode:404});
});
test('explicit allowRead permits central text ranges and revision/source fences revoke the grant',async t=>{
 const {files,store,sources}=fixture(t),text='Generated '+'x'.repeat(9000)+'TAIL EVIDENCE',ack=await upload(files,Buffer.from(text),true),processing=new FileProcessing(files);t.after(()=>processing.close());await processing.tick();const requests=new FileEvidenceRequests(sources);
 assert.equal(files.search({query:'TAIL'}).length,1);const full=store.assets.read(String(store.db.prepare('SELECT object_hash FROM file_snapshot_text WHERE capture_id=?').get(ack.id)!.object_hash)).toString();const result:any=await requests.read(ack.id,full.indexOf('TAIL'),13);assert.equal(result.status,'ready');assert.equal(result.record.ocrText,'TAIL EVIDENCE');assert.throws(()=>[...files.bytes(ack.id)],{statusCode:404});sources.update('fixture',{enabled:false});await assert.rejects(requests.read(ack.id,0,10),{statusCode:409});files.sweep();assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_text').get()!.n,0);
});
test('generated audio is interpreted by the central provider, and cancellation destroys transient input',async t=>{
 const {files,store}=fixture(t),ack=await upload(files,Buffer.from('generated audio bytes'),false,'audio/wav');let calls=0;const processing=new FileProcessing(files,{transcribe:async()=>{calls++;return {durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Generated central transcript'}]};}});t.after(()=>processing.close());await processing.runtime.ready;processing.update({revision:processing.view().revision,settings:{...processing.view().settings,audioProcessor:'audio.http'},policy:fixtureFilePolicy({...processing.view().settings,audioProcessor:'audio.http'},processing.runtime.registry)});await processing.tick();assert.equal(calls,1);assert.equal(files.chunks(ack.id)[0].ocrText,'Generated central transcript');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);
});
test('cancelled snapshot input is removed and never interpreted after cancellation',async t=>{
 const {files,store}=fixture(t),bytes=Buffer.from('Generated cancelled input'),ack=await upload(files,bytes),processing=new FileProcessing(files);t.after(()=>processing.close());processing.cancel(ack.id);await processing.tick();assert.equal(files.detail(ack.id).job.state,'cancelled');assert.equal(files.chunks(ack.id).length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);assert.throws(()=>store.assets.get(sha256(bytes)),{statusCode:404});
});
test('source revocation while central interpretation is in flight cannot publish or retain temporary input',async t=>{
 const {files,store,sources}=fixture(t),bytes=Buffer.from('Generated revocation audio'),ack=await upload(files,bytes,true,'audio/wav');let release!:(value:any)=>void,started!:()=>void;const begun=new Promise<void>(resolve=>started=resolve);const processing=new FileProcessing(files,{transcribe:async()=>{started();return new Promise(resolve=>release=resolve);}});t.after(()=>processing.close());await processing.runtime.ready;processing.update({revision:processing.view().revision,settings:{...processing.view().settings,audioProcessor:'audio.http'},policy:fixtureFilePolicy({...processing.view().settings,audioProcessor:'audio.http'},processing.runtime.registry)});const running=processing.tick();await begun;sources.update('fixture',{enabled:false});release({durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Must never publish'}]});await running;files.sweep();assert.equal(files.chunks(ack.id).length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_text').get()!.n,0);assert.throws(()=>store.assets.get(sha256(bytes)),{statusCode:404});
});

test('snapshot runs the actual custom recipe and its output stage before destroying transient bytes',async t=>{
 const {files,store}=fixture(t),ack=await upload(files,Buffer.from('Generated raw custom text'),true),processing=new FileProcessing(files);t.after(()=>processing.close());await processing.runtime.ready;
 const calls:string[]=[],recipe={id:'generated.snapshot-recipe',version:'1'};
 processing.runtime.registry.register({id:'generated.snapshot-text',name:'Generated custom extraction',version:'1',stage:'extract',mediaTypes:['text/'],allowSummary:false,recipe,async process(input){calls.push('extract');const chunks:Buffer[]=[];for await(const chunk of input.readOriginal())chunks.push(chunk);return {durationMs:0,segments:[{startMs:0,endMs:0,text:Buffer.concat(chunks).toString()}]};}});
 processing.runtime.recipes.registerStage({id:'generated.snapshot-transform',version:'3',async run(context){calls.push('transform');const raw=context.readArtifact(context.dependencies.extract) as any;return context.transform(TRANSCRIPT_OUTPUT,async()=>({...raw.transcript,segments:raw.transcript.segments.map((segment:any)=>({...segment,text:segment.text+' GENERATED_STAGE_OUTPUT'}))}));}});
 processing.runtime.recipes.registerRecipe({...recipe,steps:[{name:'extract',stage:{id:'mote.extract',version:'1'},dependsOn:[]},{name:'transform',stage:{id:'generated.snapshot-transform',version:'3'},dependsOn:['extract']}],output:'transform'});
 const settings={...processing.view().settings,typeProfiles:{'text/plain':'generated.snapshot-text'}};processing.update({revision:processing.view().revision,settings,policy:fixtureFilePolicy(settings,processing.runtime.registry)});
 await processing.tick();assert.deepEqual(calls,['extract','transform']);assert.equal(files.detail(ack.id).job.state,'succeeded');assert.match(files.chunks(ack.id)[0].ocrText,/GENERATED_STAGE_OUTPUT/);
 const receipt=processing.explain(ack.id).snapshots[0] as any;assert.equal(receipt.recipe.id,recipe.id);assert.deepEqual(receipt.stagePins.map((pin:any)=>pin.id),['mote.extract','generated.snapshot-transform']);
 assert.deepEqual(store.db.prepare('SELECT step,state FROM file_steps WHERE capture_id=? ORDER BY rowid').all(ack.id).map(row=>[row.step,row.state]),[['extract','succeeded'],['transform','succeeded']]);
 const full=store.assets.read(String(store.db.prepare('SELECT object_hash FROM file_snapshot_text WHERE capture_id=?').get(ack.id)!.object_hash)).toString();assert.match(full,/GENERATED_STAGE_OUTPUT/);assert.equal(store.db.prepare('SELECT 1 FROM file_snapshot_inputs WHERE capture_id=?').get(ack.id),undefined);assert.throws(()=>[...files.bytes(ack.id)],{statusCode:404});
 const materials=new MaterialStore(store),organizers=new MaterialOrganizerRuntime(store,materials);try{while(await organizers.tick(100));const material=materials.get(materialId('fixture','generated-file'))!;assert.equal(material.retention.original,'unavailable');assert.equal(materials.input(material.ref,['extracted-text'])?.ready,true);assert.match(materials.read(material.ref).text,/GENERATED_STAGE_OUTPUT/);}finally{await organizers.close();}
});

test('snapshot dialogue executes diarization, alignment and semantic turns with truthful stage pins',async t=>{
 const {files,store}=fixture(t),ack=await upload(files,Buffer.from('Generated dialogue bytes'),false,'audio/wav');let asr=0,diarize=0,turns=0;
 const processing=new FileProcessing(files,{transcribe:async()=>{asr++;return {durationMs:2000,segments:[{startMs:0,endMs:1000,text:'Generated speaker one'},{startMs:1000,endMs:2000,text:'Generated speaker two'}]};}},undefined,{analyze:async records=>{turns++;return {answer:JSON.stringify({groups:[[0],[1]]}),citations:records.map(record=>({id:record.id}))};}});t.after(()=>processing.close());await processing.runtime.ready;
 processing.runtime.registry.register({id:'generated.snapshot-diarize',name:'Generated diarization',version:'1',stage:'diarize',localOnly:true,mediaTypes:['audio/'],async process(){diarize++;return {durationMs:2000,engine:'generated',expectedSpeakers:2,observedSpeakers:2,overlapDetection:'unknown',segments:[{startMs:0,endMs:1000,speaker:'SPEAKER_0'},{startMs:1000,endMs:2000,speaker:'SPEAKER_1'}],samples:[]};}});
 const settings={...processing.view().settings,audioProcessor:'audio.local-dialogue',diarizationProcessor:'generated.snapshot-diarize',speakerCount:2,semanticTurns:true,localModelName:'generated-fixture'};processing.update({revision:processing.view().revision,settings,policy:fixtureFilePolicy(settings,processing.runtime.registry)});
 await processing.tick();assert.equal(files.detail(ack.id).job.state,'succeeded',JSON.stringify(files.detail(ack.id).job));assert.deepEqual([asr,diarize,turns],[1,1,1]);assert.deepEqual(files.chunks(ack.id).map(chunk=>chunk.fileEvidence?.speaker),['SPEAKER_0','SPEAKER_1']);
 const receipt=processing.explain(ack.id).snapshots[0] as any;assert.deepEqual(receipt.stagePins.map((pin:any)=>pin.name),['extract','diarize','align','turns']);assert.equal(store.db.prepare('SELECT 1 FROM file_snapshot_inputs WHERE capture_id=?').get(ack.id),undefined);assert.equal(files.detail(ack.id).hasOriginal,false);
});

test('restart repairs legacy snapshot receipt rewrites while preserving source checksums and readable formal Material',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-snapshot-legacy-upgrade-'));let store=new Store(directory);
 try{
  let sources=new SourceStore(store),files=new FileStore(store,sources);sources.register({id:'fixture',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'macos',retention:'snapshot'});
  const ack=await upload(files,Buffer.from('GENERATED_SNAPSHOT_UPGRADE'),true),processing=new FileProcessing(files);try{await processing.tick();}finally{await processing.close();}
  const derived=files.detail(ack.id).item.document!.fileIndex!;store.db.prepare("UPDATE captures SET json=json_set(json,'$.provenance.document.fileIndex',json(?)) WHERE id=?").run(JSON.stringify(derived),ack.id);store.db.exec('DELETE FROM file_snapshot_index');store.close();store=new Store(directory);sources=new SourceStore(store);files=new FileStore(store,sources);
  const raw=JSON.parse(String(store.db.prepare('SELECT json FROM captures WHERE id=?').get(ack.id)!.json));assert.equal(raw.provenance.document.fileIndex.status,'pending');assert.equal(files.detail(ack.id).item.document?.fileIndex?.status,'ready');
  const reader=new CaptureRawReader(store,{mayReadSource:()=>true,mayReadGroup:()=>true,mayListKind:()=>true});assert.ok(reader.snapshotForItem('fixture','generated-file'));
  const materials=new MaterialStore(store),organizers=new MaterialOrganizerRuntime(store,materials);try{while(await organizers.tick(100));assert.match(materials.read(materials.get(materialId('fixture','generated-file'))!.ref).text,/GENERATED_SNAPSHOT_UPGRADE/);}finally{await organizers.close();}
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);assert.equal(files.detail(ack.id).hasOriginal,false);
 }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
