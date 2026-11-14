import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FILE_PART_BYTES,sourceItemSchema,type FileRevision} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {FileEvidence} from '../src/file-evidence.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';
import {TRANSCRIPT_OUTPUT} from '../src/file-recipes.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {CaptureRawReader} from '../src/capture-raw-reader.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {Indexer} from '../src/indexer.js';
import {browseSourceCatalog} from '../src/source-catalog.js';
import {fileViewSchema} from '@mote/shared';
import {serveGeneratedFunasr} from './fixtures/funasr.js';
function fixture(t:any){const dir=mkdtempSync(join(tmpdir(),'mote-snapshot-fixture-')),store=new Store(dir,{maxStorageBytes:100*1024*1024}),sources=new SourceStore(store),files=new FileStore(store,sources);const cleanup:Array<()=>Promise<void>>=[];sources.register({id:'fixture',name:'Generated',kind:'local-files',deviceId:'fixture',platform:'macos',retention:'snapshot'});t.after(async()=>{for(const close of cleanup.reverse())await close();store.close();rmSync(dir,{recursive:true,force:true});});return {store,sources,files,cleanup};}
async function upload(files:FileStore,bytes:Buffer,allowRead=false,mimeType='text/plain'){
 const hash=sha256(bytes),m:FileRevision={sourceId:'fixture',previousRevision:null,sizeBytes:bytes.length,sha256:hash,relativePath:'generated.txt',item:{externalId:'generated-file',revision:hash,observedAt:'2026-10-01T00:00:00Z',title:'Generated',kind:'file',layer:'snapshot',text:'',mimeType,deleted:false,document:{fileIndex:{version:1,fileId:'generated-file',contentVersion:hash,mode:'index',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,maxIndexCharacters:8000,allowRead}}}};
 const s=files.begin(m,()=>{});for(let part=0;part<Math.ceil(bytes.length/FILE_PART_BYTES);part++)files.part(s.uploadId,part,bytes.subarray(part*FILE_PART_BYTES,(part+1)*FILE_PART_BYTES),()=>{});return files.commit(s.uploadId,()=>{});
}
test('late snapshot extraction updates the file view and directory and remains searchable without embeddings',async t=>{
 const {files,store,sources,cleanup}=fixture(t),text='Generated first paragraph.\n\nGenerated final searchable tail.',ack=await upload(files,Buffer.from(text),true);
 const processing=new FileProcessing(files),indexer=new Indexer(store,{embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''},undefined,files);cleanup.push(()=>processing.close(),()=>indexer.close());
 const before=fileViewSchema.parse(files.fileView(ack.id));assert.equal(before.coverage.extraction.status,'pending');
 assert.equal(browseSourceCatalog(store.db,'fixture',{parent:''}).items[0].coverage,'catalog');
 await processing.tick();
 const after=fileViewSchema.parse(files.fileView(ack.id));assert.equal(after.coverage.extraction.status,'ready');assert.notEqual(after.coverage.semantic.status,'ready');
 assert.equal(after.coverage.embedding.status,'unsupported');assert.match(after.coverage.embedding.reason??'',/lexical/i);
 assert.equal(after.hasOriginal,false);assert.equal(after.canOpenOriginal,false);
 assert.equal(browseSourceCatalog(store.db,'fixture',{parent:''}).items[0].coverage,'full');
 assert.equal(store.assets.read(String(store.db.prepare('SELECT object_hash FROM file_snapshot_text WHERE capture_id=?').get(ack.id)!.object_hash)).toString(),text);
 const found=await indexer.search({query:'searchable tail'});assert.ok(found.some(row=>row.ocrText.includes('searchable tail')));assert.equal(found.retrieval.mode,'lexical');assert.equal(found.retrieval.degraded,true);assert.equal(found.retrieval.reason,'embedding_not_configured');
 const result:any=await new FileEvidence(sources).read(ack.id,text.indexOf('searchable'),15);assert.equal(result.status,'ready');assert.equal(result.record.ocrText,'searchable tail');
});
test('embedding coverage counts current extracted chunks and identifies failures independently of extraction',async t=>{
 const {files,store,cleanup}=fixture(t),ack=await upload(files,Buffer.from('Generated '.repeat(500)+'tail'),true),processing=new FileProcessing(files);
 const indexer=new Indexer(store,{embeddingModel:'generated-embedding',embeddingBaseUrl:'http://127.0.0.1:1',embeddingApiKey:''},undefined,files);cleanup.push(()=>processing.close(),()=>indexer.close());
 await processing.tick();const chunks=files.chunks(ack.id);assert.equal(chunks.length,2);
 assert.deepEqual(files.fileView(ack.id).coverage.embedding,{status:'pending',completed:0,total:2});
 files.indexed(chunks[0].id,[0.5,0.5],'generated-embedding');assert.equal(files.fileView(ack.id).coverage.embedding.status,'partial');assert.equal(files.fileView(ack.id).coverage.embedding.completed,1);assert.equal(files.fileView(ack.id).coverage.embedding.total,2);
 files.indexFailed(chunks[1].id);assert.match(files.fileView(ack.id).coverage.embedding.reason??'',/could not be embedded/);
 files.indexed(chunks[1].id,[0.5,0.5],'generated-embedding');assert.deepEqual(files.fileView(ack.id).coverage.embedding,{status:'ready',completed:2,total:2});
 assert.equal(files.fileView(ack.id).coverage.extraction.status,'ready');assert.notEqual(files.fileView(ack.id).coverage.semantic.status,'ready');
});
test('a processor using the shared partial coverage contract cannot make Material or the directory claim full text',async t=>{
 const {files,store,cleanup}=fixture(t),ack=await upload(files,Buffer.from('Generated source bytes'),true),processing=new FileProcessing(files);cleanup.push(()=>processing.close());await processing.runtime.ready;
 processing.runtime.registry.register({id:'generated.partial-text',name:'Generated partial text',version:'1',stage:'extract',mediaTypes:['text/'],allowSummary:false,async process(){return {durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated available page',documentLocation:{pageNumber:1,offset:0,length:24}}],extraction:{status:'partial',completed:1,total:2,reason:'Generated second page unavailable'}};}});
 const settings={...processing.view().settings,typeProfiles:{'text/plain':'generated.partial-text'}};processing.update({revision:processing.view().revision,settings,policy:fixtureFilePolicy(settings,processing.runtime.registry)});await processing.tick();
 assert.deepEqual(files.fileView(ack.id).coverage.extraction,{status:'partial',completed:1,total:2,reason:'Generated second page unavailable'});
 assert.equal(files.detail(ack.id).item.document.fileIndex.coverage,'lightweight');assert.equal(browseSourceCatalog(store.db,'fixture',{parent:''}).items[0].coverage,'lightweight');
 const materials=new MaterialStore(store),organizers=new MaterialOrganizerRuntime(store,materials);try{while(await organizers.tick(100));const material=materials.get(materialId('fixture','generated-file'))!;assert.equal(material.coverage.state,'partial');assert.match(materials.read(material.ref).text,/Generated available page/);}finally{await organizers.close();}
});
test('central snapshot extraction ignores legacy client caps, removes raw bytes, and never grants original access',async t=>{
 const {files,store,cleanup}=fixture(t),bytes=Buffer.from('Generated '+'x'.repeat(10000)),ack=await upload(files,bytes),processing=new FileProcessing(files);cleanup.push(()=>processing.close());
 assert.equal(files.detail(ack.id).hasOriginal,false);assert.throws(()=>[...files.bytes(ack.id)],{statusCode:404});assert.deepEqual(Buffer.concat([...files.processingBytes(ack.id)]),bytes);
 await processing.tick();assert.equal(files.detail(ack.id).job.state,'succeeded');assert.equal(files.chunks(ack.id).map(c=>c.ocrText).join(''),bytes.toString());assert.equal(files.detail(ack.id).item.document?.fileIndex?.coverage,'full');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_text').get()!.n,0);assert.throws(()=>[...files.processingBytes(ack.id)],{statusCode:410});assert.throws(()=>store.assets.get(sha256(bytes)),{statusCode:404});
});
test('explicit allowRead permits central text ranges and revision/source fences revoke the grant',async t=>{
 const {files,store,sources,cleanup}=fixture(t),text='Generated '+'x'.repeat(9000)+'TAIL EVIDENCE',ack=await upload(files,Buffer.from(text),true),processing=new FileProcessing(files);cleanup.push(()=>processing.close());await processing.tick();const requests=new FileEvidence(sources);
 // allowRead=true has the same empty parent SourceItem DTO; the metadata projection validates and readability stays a separate axis.
 const readableEvidence=store.evidence([ack.id])[0],readableProvenance=readableEvidence.provenance!;
 assert.equal(readableEvidence.ocrText,'');assert.equal(readableProvenance.document?.fileIndex?.allowRead,true);
 assert.doesNotThrow(()=>sourceItemSchema.parse({externalId:readableProvenance.externalId,revision:readableProvenance.revision,observedAt:readableEvidence.capturedAt,title:readableEvidence.windowTitle,text:'',kind:'file',layer:'snapshot',mimeType:readableProvenance.mimeType,deleted:false,document:readableProvenance.document}));
 assert.throws(()=>[...files.bytes(ack.id)],{statusCode:404},'raw snapshot bytes stay released');
 assert.equal(files.search({query:'TAIL'}).length,1);const full=store.assets.read(String(store.db.prepare('SELECT object_hash FROM file_snapshot_text WHERE capture_id=?').get(ack.id)!.object_hash)).toString();const result:any=await requests.read(ack.id,full.indexOf('TAIL'),13);assert.equal(result.status,'ready');assert.equal(result.record.ocrText,'TAIL EVIDENCE');assert.throws(()=>[...files.bytes(ack.id)],{statusCode:404});sources.update('fixture',{enabled:false});await assert.rejects(requests.read(ack.id,0,10),{statusCode:409});files.sweep();assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_text').get()!.n,0);
});
test('generated audio is interpreted by the central provider, and cancellation destroys transient input',async t=>{
 const {files,store,cleanup}=fixture(t),ack=await upload(files,Buffer.from('generated audio bytes'),false,'audio/wav');let calls=0;const processing=new FileProcessing(files,{transcribe:async()=>{calls++;return {durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Generated central transcript'}]};}});cleanup.push(()=>processing.close());await processing.runtime.ready;processing.update({revision:processing.view().revision,settings:{...processing.view().settings,audioProcessor:'audio.http'},policy:fixtureFilePolicy({...processing.view().settings,audioProcessor:'audio.http'},processing.runtime.registry)});await processing.tick();assert.equal(calls,1);assert.equal(files.chunks(ack.id)[0].ocrText,'Generated central transcript');assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);
});
test('cancelled snapshot input is removed and never interpreted after cancellation',async t=>{
 const {files,store,cleanup}=fixture(t),bytes=Buffer.from('Generated cancelled input'),ack=await upload(files,bytes),processing=new FileProcessing(files);cleanup.push(()=>processing.close());processing.cancel(ack.id);await processing.tick();assert.equal(files.detail(ack.id).job.state,'cancelled');assert.equal(files.chunks(ack.id).length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);assert.throws(()=>store.assets.get(sha256(bytes)),{statusCode:404});
});
test('source revocation while central interpretation is in flight cannot publish or retain temporary input',async t=>{
 const {files,store,sources,cleanup}=fixture(t),bytes=Buffer.from('Generated revocation audio'),ack=await upload(files,bytes,true,'audio/wav');let release!:(value:any)=>void,started!:()=>void;const begun=new Promise<void>(resolve=>started=resolve);const processing=new FileProcessing(files,{transcribe:async()=>{started();return new Promise(resolve=>release=resolve);}});cleanup.push(()=>processing.close());await processing.runtime.ready;processing.update({revision:processing.view().revision,settings:{...processing.view().settings,audioProcessor:'audio.http'},policy:fixtureFilePolicy({...processing.view().settings,audioProcessor:'audio.http'},processing.runtime.registry)});const running=processing.tick();await begun;sources.update('fixture',{enabled:false});release({durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Must never publish'}]});await running;files.sweep();assert.equal(files.chunks(ack.id).length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_inputs').get()!.n,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM file_snapshot_text').get()!.n,0);assert.throws(()=>store.assets.get(sha256(bytes)),{statusCode:404});
});

test('snapshot runs the actual custom recipe and its output stage before destroying transient bytes',async t=>{
 const {files,store,cleanup}=fixture(t),ack=await upload(files,Buffer.from('Generated raw custom text'),true),processing=new FileProcessing(files);cleanup.push(()=>processing.close());await processing.runtime.ready;
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
 const {files,store,cleanup}=fixture(t),audio=Buffer.from('Generated dialogue bytes'),ack=await upload(files,audio,false,'audio/wav');let asr=0,diarize=0,turns=0;
 const native=await serveGeneratedFunasr(t,{audio,durationMs:2000,segments:[{startMs:0,endMs:1000,text:'Generated speaker one',speaker:0},{startMs:1000,endMs:2000,text:'Generated speaker two',speaker:1}],speakers:{mode:'exact',count:2}},()=>asr++);
 const processing=new FileProcessing(files,undefined,undefined,{analyze:async records=>{turns++;return {answer:JSON.stringify({groups:[[0],[1]]}),citations:records.map(record=>({id:record.id}))};}});cleanup.push(()=>processing.close());await processing.runtime.ready;
 processing.runtime.registry.register({id:'generated.snapshot-diarize',name:'Generated diarization',version:'1',stage:'diarize',localOnly:true,mediaTypes:['audio/'],async process(input){diarize++;assert.deepEqual(input.recognition,native.recognition.checkpoint);return native.diarization;}});
 const settings={...processing.view().settings,audioProcessor:'audio.local-dialogue',diarizationProcessor:'generated.snapshot-diarize',localEndpoint:native.endpoint,localWorkerApiKey:native.token,speakerCount:2,semanticTurns:true};
 const policy=fixtureFilePolicy(settings,processing.runtime.registry);policy.profiles.find(profile=>profile.processorId==='audio.local-dialogue')!.parameters.deduplicate=false;
 processing.update({revision:processing.view().revision,settings,policy});
 await processing.tick();assert.equal(files.detail(ack.id).job.state,'succeeded',JSON.stringify(files.detail(ack.id).job));assert.deepEqual([asr,diarize,turns],[1,1,1]);assert.deepEqual(files.chunks(ack.id).map(chunk=>chunk.fileEvidence?.speaker),['SPEAKER_0','SPEAKER_1']);
 const receipt=processing.explain(ack.id).snapshots[0] as any;assert.deepEqual(receipt.stagePins.map((pin:any)=>pin.name),['extract','diarize','align','turns']);assert.equal(store.db.prepare('SELECT 1 FROM file_snapshot_inputs WHERE capture_id=?').get(ack.id),undefined);assert.equal(files.detail(ack.id).hasOriginal,false);
});

test('processed snapshot metadata validates without granting any access to its text',async t=>{
 const {files,store,sources,cleanup}=fixture(t),text='Generated '+'x'.repeat(632),ack=await upload(files,Buffer.from(text),false);
 const processing=new FileProcessing(files);cleanup.push(()=>processing.close());await processing.tick();
 const evidence=store.evidence([ack.id])[0],provenance=evidence.provenance!,index=provenance.document?.fileIndex!;
 assert.equal(index.allowRead,false);assert.equal(index.status,'ready');assert.ok(index.length>0);assert.equal(evidence.ocrText,'');
 const projection={externalId:provenance.externalId,revision:provenance.revision,observedAt:evidence.capturedAt,title:evidence.windowTitle,text:'',kind:'file',layer:'snapshot',mimeType:provenance.mimeType,deleted:false,document:provenance.document};
 assert.doesNotThrow(()=>sourceItemSchema.parse(projection),'processed snapshot metadata projection must validate');
 // allowRead=true has the same empty parent DTO; readability is a separate axis.
 assert.doesNotThrow(()=>sourceItemSchema.parse({...projection,document:{...provenance.document,fileIndex:{...index,allowRead:true}}}),'allowRead=true empty parent metadata also validates');
 // Every other consistency rule survives.
 assert.throws(()=>sourceItemSchema.parse({...projection,text:'Generated text'}),'carried text keeps the length rule');
 assert.throws(()=>sourceItemSchema.parse({...projection,layer:'original'}),'other layers keep the length rule');
 assert.throws(()=>sourceItemSchema.parse({...projection,document:{...provenance.document,fileIndex:{...index,offset:1}}}),'out-of-bounds offsets stay rejected');
 assert.throws(()=>sourceItemSchema.parse({...projection,document:{...provenance.document,fileIndex:{...index,mode:'catalog',allowRead:true}}}),'catalog keeps its no-read/no-text rule');

 // The metadata projection grants no original read or byte access.
 const requests=new FileEvidence(sources);await assert.rejects(requests.read(ack.id,0,10),{statusCode:409});
 assert.throws(()=>[...files.bytes(ack.id)],{statusCode:404});
});

test('source-item cards surface the processed body block instead of the transport metadata projection',async t=>{
 const {files,store,sources,cleanup}=fixture(t),body='Generated snapshot body '+'y'.repeat(600),ack=await upload(files,Buffer.from(body),false);
 const processing=new FileProcessing(files);cleanup.push(()=>processing.close());await processing.tick();
 assert.equal(files.detail(ack.id).job.state,'succeeded');
 const materials=new MaterialStore(store),organizers=new MaterialOrganizerRuntime(store,materials);
 try{
  while(await organizers.tick(100));
  const material=materials.get(materialId('fixture','generated-file'))!;
  const anchors=materials.evidenceIds(material.ref),chunk=anchors.at(-1)!;
  assert.match(materials.evidence([chunk])[0]!.ocrText,/Generated snapshot body/);
  const agent=new EvidenceReader(store,sources,undefined,undefined,undefined,materials).agent({diagnostics:{measure:async(_source:string,_operation:string,run:()=>Promise<unknown>)=>run()} as never});
  const page=await agent.sourceItems!({sourceId:'fixture'}) as {items:{id:string;ocrText:string;provenance?:{uri?:string}}[]};
  const card=page.items.find(item=>item.provenance?.uri?.split('#')[0]===material.ref)!;
  assert.ok(card,'the processed snapshot keeps its source-item card');
  assert.equal(card.id,chunk,'the card id is the body anchor, not the metadata projection');
  assert.equal(card.ocrText,materials.evidence([chunk])[0]!.ocrText);
  assert.match(card.ocrText,/Generated snapshot body/);
  assert.doesNotMatch(card.ocrText,/"captureId"/,'the transport metadata manifest is not the item body');
  // Explicit anchor order is unchanged: the organizer still writes the metadata projection first.
  assert.equal(materials.evidence(materials.cardEvidenceIds(material.ref).slice(0,1))[0]!.id,chunk,'card anchor order prefers the body block');
  const expanded=await agent.evidence!({ids:[card.id]}) as {id:string;ocrText:string}[];
  assert.equal(expanded[0]!.id,chunk);assert.match(expanded[0]!.ocrText,/Generated snapshot body/);
  // The transport metadata stays explicitly addressable; only the automatic card anchor moved.
  const metadata=await agent.evidence!({ids:[anchors[0]!]}) as {id:string;ocrText:string}[];
  assert.equal(metadata[0]!.id,anchors[0]);assert.match(metadata[0]!.ocrText,/"captureId"/);
  // A Material without a body block keeps the metadata projection as its card anchor.
  const metadataOnly=materials.publish({id:materialId('fixture','metadata-only'),kind:'mote.file',schemaVersion:1,title:'Metadata only',
   origin:{sourceId:'fixture',externalId:'metadata-only',deviceId:'fixture'},
   blocks:[{id:'source-metadata',kind:'text',format:'json',text:'{"captureId":"generated"}',memberIds:[ack.id]}],
   members:[{id:ack.id,kind:'capture',ref:`capture:${ack.id}`}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'unavailable',policy:'keep'}});
  assert.deepEqual(materials.cardEvidenceIds(metadataOnly.ref),materials.evidenceIds(metadataOnly.ref));
  assert.equal(materials.evidence(materials.cardEvidenceIds(metadataOnly.ref))[0]!.ocrText,'{"captureId":"generated"}');
 }finally{await organizers.close();}
});
