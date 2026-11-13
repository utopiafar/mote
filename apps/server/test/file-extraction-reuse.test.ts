import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {transcriptSchema,type Transcript} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {FileReviews} from '../src/file-reviews.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {fileExportEntries} from '../src/file-export.js';
import {BackgroundModelAuthorization} from '../src/background-model-authorization.js';
import type {ModelProcessingAuthority} from '../src/model-processing-authority.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';

const bytes=Buffer.from('Generated reusable file body.\nLast paragraph.');
const transcript:Transcript={durationMs:0,segments:[{startMs:0,endMs:0,text:bytes.toString(),documentLocation:{paragraphNumber:1,offset:0,length:bytes.length}}]};
async function fixture(t:TestContext,options:{native?:boolean;modelAuthority?:ModelProcessingAuthority}={}){
 const directory=mkdtempSync(join(tmpdir(),'mote-file-extraction-reuse-'));
 let store=new Store(directory),sources=new SourceStore(store),files=new FileStore(store,sources);
 for(const [id,retention] of [['one','archive'],['two','archive'],['snapshot','snapshot']] as const)
  sources.register({id,name:'Generated '+id,kind:'local-files',deviceId:'generated',platform:'import',retention});
 const instances:FileProcessing[]=[];let calls=0;
 const output={id:'fixture.extraction',version:'1'},payload=z.object({text:z.string(),parser:z.literal('generated')}).strict();
 const start=async()=>{
  const processing=new FileProcessing(files,undefined,undefined,{configuration:instances.at(-1)?.configurationSnapshot(),modelAuthority:options.modelAuthority});instances.push(processing);await processing.runtime.ready;
  processing.runtime.outputs.register({...output,kind:'text',parse:value=>payload.parse(value),project:value=>({...transcript,segments:[{...transcript.segments[0],text:payload.parse(value).text}]})});
  processing.runtime.registry.register({id:'fixture.extract',name:'Generated extraction',version:'1',stage:'extract',mediaTypes:['text/'],localOnly:true,reuseByContent:true,output,
   parameters:[{key:'variant',label:'Generated variant',type:'string',default:'a'}],dependencies:{settings:[],parameters:['variant']},
   process:async input=>{calls++;return {text:bytes.toString()+' '+input.parameters?.variant,parser:'generated'};}});
  return processing;
 };
 let processing=await start();
 const settings={...processing.view().settings,enabled:true,summarize:false,typeProfiles:options.native?{}:{'text/*':'fixture.extract'}};
 processing.update({revision:processing.view().revision,settings,policy:fixtureFilePolicy(settings,processing.runtime.registry)});
 const upload=async(sourceId:string,key:string,mimeType='text/plain')=>{
  const snapshot=sourceId==='snapshot',hash=sha256(bytes);
  const upload=files.begin({sourceId,relativePath:key,item:{externalId:key,revision:'1',observedAt:'2026-11-01T00:00:00Z',title:key,uri:'file:///generated/'+key,kind:'file',layer:snapshot?'snapshot':'original',mimeType,text:'',
   ...(snapshot?{document:{fileIndex:{version:1,fileId:key,parser:'central-pending',mode:'index',status:'pending',coverage:'none',allowRead:true,totalCharacters:0,offset:0,length:0,contentVersion:hash}}}:{})},sha256:hash,sizeBytes:bytes.length},()=>{});
  files.part(upload.uploadId,0,bytes,()=>{});return String((await files.commit(upload.uploadId,()=>{})).id);
 };
 t.after(async()=>{for(const instance of instances)await instance.settle();await files.close();store.close();rmSync(directory,{recursive:true,force:true});});
 return {get store(){return store;},get sources(){return sources;},get files(){return files;},upload,output,calls:()=>calls,get processing(){return processing;},async restart(){
  await processing.settle();await files.close();store.close();store=new Store(directory);sources=new SourceStore(store);files=new FileStore(store,sources);processing=await start();
 }};
}

test('native extraction reuses retained snapshot text into independent file and Material origins',async t=>{
 const f=await fixture(t,{native:true}),processor=f.processing.runtime.registry.get('text.utf8'),extract=processor.process;
 let calls=0;processor.process=async input=>{calls++;return extract(input);};
 const first=await f.upload('snapshot','private-first.txt');await f.processing.tick();assert.equal(f.files.fileView(first).canOpenOriginal,false);
 assert.equal(f.store.db.prepare('SELECT 1 FROM file_snapshot_inputs WHERE capture_id=?').get(first),undefined);
 const second=await f.upload('two','independent-second.txt');await f.processing.tick();
 assert.equal(calls,1,'the complete machine extraction survives release of temporary original bytes');
 const a=f.files.chunks(first),b=f.files.chunks(second);assert.equal(a.map(r=>r.ocrText).join(''),b.map(r=>r.ocrText).join(''));
 assert.notEqual(a[0].id,b[0].id);assert.notEqual(a[0].fileEvidence!.artifactId,b[0].fileEvidence!.artifactId);
 assert.equal(b[0].fileEvidence!.captureId,second);assert.equal(b[0].provenance!.sourceId,'two');
 // Stored receipts are internal metadata, never authority to disclose a donor.
 f.store.db.prepare("UPDATE file_artifacts SET json=json_set(json,'$.reuse.captureId',?,'$.reuse.artifactId',?) WHERE id=?").run(first,a[0].fileEvidence!.artifactId,b[0].fileEvidence!.artifactId);
 const materials=new MaterialStore(f.store),organizers=new MaterialOrganizerRuntime(f.store,materials);
 try{
  while(await organizers.tick(100));
  const own=materials.get(materialId('two','independent-second.txt'))!;assert.match(materials.read(own.ref).text,/Last paragraph/);
  f.files.forget(first);await organizers.tick(100);f.files.sweep();
  assert.equal(f.files.chunks(second)[0].id,b[0].id);assert.equal(f.files.isCurrentEvidence(b[0].id),true);
  assert.match(materials.read(own.ref).text,/Last paragraph/);
  const disclosed=JSON.stringify({detail:f.files.detail(second),view:f.files.fileView(second),chunks:f.files.chunks(second),material:materials.read(own.ref),exports:fileExportEntries(f.files,second).map(e=>e.bytes.toString())});
  for(const forbidden of [first,a[0].fileEvidence!.artifactId,'private-first.txt','file:///generated/private-first.txt'])assert.ok(!disclosed.includes(forbidden),'the new origin must not disclose the removed origin '+forbidden);
 }finally{await organizers.close();}
});

test('native output payload reuse preserves processor parameters, version, MIME and privacy boundaries',async t=>{
 const f=await fixture(t),first=await f.upload('one','first.txt');await f.processing.tick();
 const second=await f.upload('two','second.txt');await f.processing.tick();assert.equal(f.calls(),1);
 const artifact=f.files.detail(second).artifacts.find(a=>a.kind==='text')!;
 assert.deepEqual(f.processing.artifact(artifact.id).output.payload,{text:bytes.toString()+' a',parser:'generated'});
 const policy=structuredClone(f.processing.configurationSnapshot().policy);policy.profiles.find(p=>p.processorId==='fixture.extract')!.parameters.variant='b';
 f.processing.update({revision:f.processing.view().revision,settings:f.processing.view().settings,policy});
 const changed=await f.upload('two','different-parameters.txt');await f.processing.tick();assert.equal(f.calls(),2);assert.match(f.files.chunks(changed)[0].ocrText,/ b$/);
 f.processing.runtime.registry.get('fixture.extract').version='2';await f.upload('two','different-version.txt');await f.processing.tick();assert.equal(f.calls(),3);
 await f.upload('two','different-mime.txt','text/markdown');await f.processing.tick();assert.equal(f.calls(),4);
 const masked=await f.upload('two','masked.txt');f.store.db.prepare("UPDATE captures SET json=json_set(json,'$.privacy.mode','masked','$.privacy.redacted',json('true')) WHERE id=?").run(masked);
 await f.processing.tick();assert.equal(f.calls(),5,'a privacy-transformed record cannot inherit an untransformed extraction');
 assert.equal(f.files.chunks(first)[0].ocrText,bytes.toString()+' a');
});

test('cache reuse rechecks target permission and ignores a withdrawn donor',async t=>{
 const f=await fixture(t),first=await f.upload('one','first.txt');await f.processing.tick();assert.equal(f.calls(),1);
 const denied=await f.upload('two','paused-target.txt');f.sources.update('two',{enabled:false});await f.processing.tick();
 assert.equal(f.calls(),1,'a paused target cannot read original bytes or bind a cache entry');
 assert.equal(f.files.chunks(denied).length,0);assert.notEqual(f.files.detail(denied).job?.state,'succeeded');
 f.sources.update('one',{enabled:false});const independent=await f.upload('snapshot','independent.txt');await f.processing.tick();
 assert.equal(f.calls(),2,'the authorized target processes its own bytes when the donor is withdrawn');
 assert.equal(f.files.detail(independent).job?.state,'succeeded');assert.match(f.files.chunks(independent)[0].ocrText,/Last paragraph/);
 assert.equal(f.files.detail(independent).artifacts.find(a=>a.kind==='text')?.reuse,undefined);
 assert.equal(f.files.version(first).source_id,'one');
});

for(const defect of ['invalid JSON','invalid transcript','partial coverage'] as const)test(`${defect} in an extraction cache falls back to the normal processor`,async t=>{
 const f=await fixture(t,{native:true}),processor=f.processing.runtime.registry.get('text.utf8');let calls=0;
 // Explicit byte-only metadata exercises the existing cross-origin cache as
 // well as its builtin opt-in, including when running this test on the old code.
 processor.reuseByContent=true;processor.process=async()=>{calls++;return transcript;};
 const first=await f.upload('one','first.txt');await f.processing.tick();
 if(defect==='invalid JSON')f.store.db.prepare("UPDATE file_artifacts SET json=? WHERE capture_id=?").run('{broken',first);
 else if(defect==='invalid transcript')f.store.db.prepare("UPDATE file_artifacts SET json=json_set(json,'$.transcript.durationMs','invalid') WHERE capture_id=?").run(first);
 else f.store.db.prepare("UPDATE file_artifacts SET json=json_set(json,'$.coverage','partial','$.complete',json('false'),'$.transcript.coverage','partial') WHERE capture_id=?").run(first);
 const second=await f.upload('two','second.txt');await f.processing.tick();
 assert.equal(calls,2);assert.equal(f.files.detail(second).job?.state,'succeeded');assert.match(f.files.chunks(second)[0].ocrText,/Last paragraph/);
});

test('an incompatible native output cache is decoded again and falls back without blocking the file',async t=>{
 const f=await fixture(t),first=await f.upload('one','first.txt');await f.processing.tick();
 f.store.db.prepare("UPDATE file_artifacts SET json=json_set(json,'$.output.payload',json(?)) WHERE capture_id=?").run(JSON.stringify({text:42,parser:'generated'}),first);
 const second=await f.upload('two','second.txt');await f.processing.tick();
 assert.equal(f.calls(),2);assert.equal(f.files.detail(second).job?.state,'succeeded');assert.match(f.files.chunks(second)[0].ocrText,/Last paragraph/);
});

test('human corrections and confirmed speaker identities stay on their own origin',async t=>{
 const f=await fixture(t,{native:true}),processor=f.processing.runtime.registry.get('text.utf8');
 let calls=0;processor.process=async()=>{calls++;return {durationMs:1000,segments:[{startMs:0,endMs:1000,text:'Generated raw speech',speaker:'SPEAKER_0'}]};};
 const first=await f.upload('one','first.txt');await f.processing.tick();const original=f.files.chunks(first)[0],reviews=new FileReviews(f.files,f.processing);
 reviews.nameSpeakers(first,{artifactId:original.fileEvidence!.artifactId,names:{SPEAKER_0:'Generated private person'}});
 reviews.correct(first,{artifactId:original.fileEvidence!.artifactId,chunkId:original.id,originalText:'Generated raw speech',correctedText:'Generated owner correction'});
 const second=await f.upload('two','second.txt');await f.processing.tick();assert.equal(calls,1);
 assert.equal(f.files.chunks(second)[0].ocrText,'[SPEAKER_0] Generated raw speech');assert.equal(f.files.chunks(second)[0].fileEvidence!.speakerAttribution,undefined);
 assert.ok(!JSON.stringify(f.files.detail(second)).includes('Generated private person'));
 assert.ok(!fileExportEntries(f.files,second).some(e=>e.bytes.includes('Generated owner correction')));
});

test('restart never publishes an unfinished extraction as a ready cache entry',async t=>{
 const f=await fixture(t),processor=f.processing.runtime.registry.get('fixture.extract');
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>release=r);
 processor.process=async()=>{enter();await held;return {text:'Generated late private extraction',parser:'generated'};};
 const first=await f.upload('one','interrupted.txt'),running=f.processing.tick();await entered;
 await f.processing.close();release();await running;await f.restart();
 const second=await f.upload('two','after-restart.txt');await f.processing.tick();
 assert.equal(f.files.chunks(second).length,0,'an unresolved issued call cannot become ready after restart');
 assert.notEqual(f.files.detail(second).job?.state,'succeeded');
 assert.equal(f.store.db.prepare("SELECT 1 FROM file_artifacts WHERE capture_id=? AND json LIKE '%Generated late private extraction%'").get(first),undefined);
 f.processing.retry(first,'transcribe',true,true);await f.processing.tick();
 assert.match(f.files.chunks(second)[0].ocrText,/Last paragraph/);assert.equal(f.files.detail(second).job?.state,'succeeded');
});

test('a matching OCR cache cannot grant processing while target authorization is off',async t=>{
 let control!:BackgroundModelAuthorization;
 const authority=(async(request,signal,task)=>{
  const id=control.currentId??'generated-media:'+request.captureId;
  if(!control.currentId)control.automatic(id,['capture:'+request.captureId],'file');
  return control.run(id,async authorizedSignal=>{const check=()=>{authorizedSignal.throwIfAborted();control.assertCurrent(request.connection);};check();const result=await task(authorizedSignal,check);check();return result;},signal);
 }) as ModelProcessingAuthority;
 const f=await fixture(t,{modelAuthority:authority});control=new BackgroundModelAuthorization(f.store,()=>[]);
 const settings={...f.processing.view().settings,imageProcessor:'image.http',imageEndpoint:'http://127.0.0.1:9008/ocr'};
 f.processing.update({revision:f.processing.view().revision,settings,policy:fixtureFilePolicy(settings,f.processing.runtime.registry)});
 let calls=0;f.processing.runtime.registry.get('image.http').process=async()=>{calls++;return transcript;};
 const receive=(id:string)=>{f.store.db.exec('BEGIN IMMEDIATE');control.receive('capture:'+id,{sourceId:f.files.version(id).source_id});f.store.db.exec('COMMIT');};
 control.command({action:'on',revision:0,operationId:randomUUID()});
 const first=await f.upload('one','first.png','image/png');receive(first);await f.processing.tick();assert.equal(calls,1);
 control.command({action:'off',revision:control.view().revision,operationId:randomUUID()});
 const second=await f.upload('two','second.png','image/png');receive(second);await f.processing.tick();
 assert.equal(calls,1);assert.equal(f.files.detail(second).job?.error,'background_model_authorization_required');assert.equal(f.files.chunks(second).length,0);
 control.command({action:'on',revision:control.view().revision,operationId:randomUUID()});
 f.store.db.prepare('UPDATE execution_steps SET available_at=0 WHERE operation_id=?').run('file:'+second);f.store.db.prepare('UPDATE file_jobs SET available_at=0 WHERE capture_id=?').run(second);
 await f.processing.tick();assert.equal(calls,1);assert.equal(f.files.chunks(second)[0].fileEvidence!.captureId,second);
});
