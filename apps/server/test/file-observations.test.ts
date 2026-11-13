import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FILE_PART_BYTES,type FileRevision} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {FileProcessing} from '../src/file-processing.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {FileObservationReader} from '../src/file-observations.js';
import {fixtureFilePolicy} from './fixtures/file-policy.js';

const all={kind:'all' as const};
function fixture(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),'mote-observation-')),store=new Store(dir,{maxStorageBytes:30_000_000}),sources=new SourceStore(store),files=new FileStore(store,sources),processing=new FileProcessing(files);
 for(const [id,retention] of [['snapshot','snapshot'],['archive','archive'],['reference','reference'],['other','archive']] as const)
  sources.register({id,name:'Generated '+id,kind:'local-files',deviceId:id,platform:'macos',retention});
 const evidence=new EvidenceReader(store,sources,files),reader=new FileObservationReader(evidence);
 t.after(async()=>{await processing.close();await files.close();store.close();rmSync(dir,{recursive:true,force:true});});
 return {store,sources,files,processing,evidence,reader};
}
function manifest(sourceId:string,externalId:string,revision:string,previousRevision:string|null,bytes:Buffer,layer:'snapshot'|'original'|'reference'='snapshot'):FileRevision {
 const hash=sha256(bytes);
 return {sourceId,previousRevision,relativePath:externalId+'.txt',sizeBytes:bytes.length,...(layer==='reference'?{}:{sha256:hash}),
  item:{externalId,revision,observedAt:'2026-10-01T10:00:00.000Z',modifiedAt:'2001-02-03T00:00:00.000Z',title:'Generated '+externalId,kind:'file',layer,text:'',mimeType:'text/plain',deleted:false,
   document:{timeBasis:'unknown',contentRole:'other',...(layer==='snapshot'?{fileIndex:{version:1,fileId:externalId,contentVersion:hash,mode:'index',coverage:'none',parser:'central-pending',status:'pending',totalCharacters:0,offset:0,length:0,allowRead:true}}:{})}}};
}
async function upload(files:FileStore,input:FileRevision,bytes:Buffer){
 const upload=files.begin(input,()=>{});if(upload.ack)return upload.ack;
 for(let part=0;part<Math.ceil(bytes.length/FILE_PART_BYTES);part++)files.part(upload.uploadId,part,bytes.subarray(part*FILE_PART_BYTES,(part+1)*FILE_PART_BYTES),()=>{});
 return files.commit(upload.uploadId,()=>{});
}

test('an old file is observed, not created; mtime edits and same-content copies do not imply an author or shared identity',async t=>{
 const f=fixture(t),bytes=Buffer.from('Generated historical body'),first=await upload(f.files,manifest('snapshot','old','one',null,bytes),bytes);
 const discovery=f.reader.read({captureId:first.id,scope:all});
 assert.deepEqual(discovery.changes,['discovered']);assert.equal(discovery.current.observedAt,'2026-10-01T10:00:00.000Z');
 assert.equal(discovery.current.modifiedAt,'2001-02-03T00:00:00.000Z');assert.equal(discovery.current.document?.timeBasis,'unknown');assert.deepEqual(discovery.activities,[]);
 assert.equal(discovery.current.relativePath,'old.txt');assert.equal(discovery.current.document?.fileIndex?.contentVersion,sha256(bytes));
 assert.equal(discovery.current.coverage.extraction.status,'pending');assert.equal(discovery.comparison.status,'unavailable');
 const copy=await upload(f.files,manifest('snapshot','copy','one',null,bytes),bytes),copyObservation=f.reader.read({captureId:copy.id,scope:all});
 assert.notEqual(copyObservation.current.captureId,discovery.current.captureId);assert.equal(copyObservation.externalId,'copy');assert.deepEqual(copyObservation.changes,['discovered']);
 const remoteCopy=await upload(f.files,manifest('other','old','one',null,bytes,'original'),bytes),other=f.reader.read({captureId:remoteCopy.id,scope:{kind:'selection',sourceIds:['other']}});
 assert.equal(other.sourceId,'other');assert.notEqual(other.current.captureId,discovery.current.captureId);assert.deepEqual(other.changes,['discovered']);
 const updated=manifest('snapshot','old','two','one',bytes);updated.item.modifiedAt='2026-09-30T00:00:00.000Z';
 const second=await upload(f.files,updated,bytes),observation=f.reader.read({captureId:second.id,scope:all});
 assert.deepEqual(observation.changes,['metadata_changed']);assert.equal(observation.previous?.revision,'one');assert.equal(observation.current.revision,'two');
 assert.deepEqual(observation.activities,[]);assert.equal(observation.comparison.status,'unavailable');
});

test('late extraction is readable through the same current version with F8 citation coordinates',async t=>{
 const f=fixture(t),text='Generated first paragraph.\n\nGenerated final evidence.',ack=await upload(f.files,manifest('snapshot','late','one',null,Buffer.from(text)),Buffer.from(text));
 assert.equal(f.reader.readBody({captureId:ack.id,scope:all}).status,'unavailable');
 await f.processing.tick();
 const changesBefore=Number(f.store.db.prepare('SELECT total_changes() n').get()!.n);
 const observed=f.reader.read({captureId:ack.id,scope:all}),body=f.reader.readBody({captureId:ack.id,scope:all});
 assert.equal(Number(f.store.db.prepare('SELECT total_changes() n').get()!.n),changesBefore,'observations and body rereads do not write evidence or progress');
 assert.equal(observed.current.revision,'one');assert.equal(observed.current.coverage.extraction.status,'ready');assert.notEqual(observed.current.coverage.semantic.status,'ready');
 assert.equal(observed.current.document?.fileIndex?.coverage,'full');
 assert.equal(body.status,'available');assert.equal(body.items.map(item=>item.text).join(''),text);
 const evidence=body.items[0] as {fileEvidence:{revision:string;captureId:string;documentLocation:{offset:number;length:number}}};
 assert.equal(evidence.fileEvidence.captureId,ack.id);assert.equal(evidence.fileEvidence.revision,'one');assert.equal(evidence.fileEvidence.documentLocation.offset,0);assert.equal(evidence.fileEvidence.documentLocation.length,text.length);
});

test('changing a processed source to reference does not reread its retained body',async t=>{
 const f=fixture(t),bytes=Buffer.from('Generated previously processed text'),first=await upload(f.files,manifest('archive','mode','one',null,bytes,'original'),bytes);await f.processing.tick();
 assert.equal(f.reader.readBody({captureId:first.id,scope:all}).status,'available');
 f.sources.update('archive',{retention:'reference'});
 let bodyReads=0;const original=f.files.chunks.bind(f.files),readAsset=f.store.assets.read.bind(f.store.assets);
 f.files.chunks=(...args)=>{bodyReads++;return original(...args);};f.store.assets.read=hash=>{bodyReads++;return readAsset(hash);};
 const observation=f.reader.read({captureId:first.id,scope:all});assert.equal(observation.current.coverage.extraction.status,'unsupported');
 assert.equal(observation.current.document?.fileIndex,undefined);assert.equal(f.reader.readBody({captureId:first.id,scope:all}).status,'unavailable');assert.equal(bodyReads,0);
});

test('differences require both fully readable versions; unavailable previous body and partial coverage never prove a whole-document omission',async t=>{
 const f=fixture(t),old=Buffer.from('Generated first version'),first=await upload(f.files,manifest('snapshot','pending','one',null,old),old);
 const replacement=Buffer.from('Generated changed version'),second=await upload(f.files,manifest('snapshot','pending','two','one',replacement),replacement);
 await f.processing.tick();
 let observation=f.reader.read({captureId:second.id,scope:all});
 assert.ok(observation.changes.includes('content_changed'));assert.equal(observation.comparison.status,'unavailable');assert.equal(observation.previous?.revision,'one');
 assert.throws(()=>f.reader.readBody({captureId:first.id,scope:all}),{statusCode:404});
 const before=Buffer.from('Generated alpha 🐱 tail'),a=await upload(f.files,manifest('archive','readable','one',null,before,'original'),before);await f.processing.tick();
 const after=Buffer.from('Generated beta 🐶 tail'),b=await upload(f.files,manifest('archive','readable','two','one',after,'original'),after);await f.processing.tick();
 observation=f.reader.read({captureId:b.id,scope:all});
 assert.ok(observation.changes.includes('content_changed'));assert.deepEqual(observation.comparison,{status:'available',result:'changed',before:{offset:10,length:8,excerpt:'alpha 🐱',truncated:false},after:{offset:10,length:7,excerpt:'beta 🐶',truncated:false}});
 assert.equal(observation.previous?.revision,'one');assert.ok(observation.disclosureDependencies.ids.includes(a.id));
});

test('reference retention never reads bodies and a missing origin only exposes its versioned tombstone',async t=>{
 const f=fixture(t),bytes=Buffer.from('do not read'),first=await f.files.revision(manifest('reference','ref','one',null,bytes,'reference'),()=>{});
 let bodyReads=0;const original=f.files.chunks.bind(f.files);f.files.chunks=(...args)=>{bodyReads++;return original(...args);};
 const before=f.reader.read({captureId:first.id,scope:all});assert.equal(before.current.coverage.extraction.status,'unsupported');assert.equal(f.reader.readBody({captureId:first.id,scope:all}).status,'unavailable');
 const m=manifest('reference','ref','two','one',bytes,'reference');m.item.modifiedAt='2026-09-01T00:00:00.000Z';
 const second=await f.files.revision(m,()=>{}),changed=f.reader.read({captureId:second.id,scope:all});assert.deepEqual(changed.changes,['metadata_changed']);assert.equal(changed.comparison.status,'unavailable');
 const tombstone=manifest('reference','ref','gone','two',bytes,'reference');tombstone.item.deleted=true;
 const removed=await f.files.revision(tombstone,()=>{}),missing=f.reader.read({captureId:removed.id,scope:all});
 assert.deepEqual(missing.changes,['origin_missing']);assert.deepEqual(missing.previous,{revision:'two'});assert.equal(missing.current.revision,'gone');assert.equal(f.reader.readBody({captureId:removed.id,scope:all}).status,'unavailable');assert.equal(bodyReads,0);
 const currentOnly=f.reader.read({captureId:removed.id,scope:{kind:'selection',evidenceIds:[removed.id]}});assert.equal(currentOnly.previous,null);
 assert.deepEqual(f.reader.read({captureId:removed.id,scope:{kind:'selection',evidenceIds:[second.id,removed.id]}}).previous,{revision:'two'});
});

test('an archived original remains retained when its origin goes missing, without exposing its retired body',async t=>{
 const f=fixture(t),bytes=Buffer.from('Generated archived body'),first=await upload(f.files,manifest('archive','removed','one',null,bytes,'original'),bytes);await f.processing.tick();
 const tombstone=manifest('archive','removed','gone','one',bytes,'original');tombstone.item.deleted=true;delete tombstone.sha256;
 const removed=await f.files.revision(tombstone,()=>{}),observation=f.reader.read({captureId:removed.id,scope:all});
 assert.deepEqual(observation.changes,['origin_missing']);assert.deepEqual(observation.previous,{revision:'one'});
 assert.deepEqual(observation.current.coverage.extraction,{status:'unsupported',reason:'deletion_revision_has_no_body'});
 assert.equal(f.reader.readBody({captureId:removed.id,scope:all}).status,'unavailable');assert.throws(()=>f.reader.readBody({captureId:first.id,scope:all}),{statusCode:404});
 assert.deepEqual(Buffer.concat([...f.files.bytes(first.id)]),bytes,'the existing owner archive survives the origin disappearance');
});

test('partial F8 extraction exposes only available cited chunks and cannot produce a whole-body difference',async t=>{
 const f=fixture(t),firstBytes=Buffer.from('Generated complete first document'),first=await upload(f.files,manifest('snapshot','partial','one',null,firstBytes),firstBytes);await f.processing.tick();
 await f.processing.runtime.ready;
 f.processing.runtime.registry.register({id:'generated.partial-observation',name:'Generated partial extraction',version:'1',stage:'extract',mediaTypes:['text/'],allowSummary:false,
  async process(){return {durationMs:0,segments:[{startMs:0,endMs:0,text:'Generated available page',documentLocation:{pageNumber:1,offset:0,length:24}}],extraction:{status:'partial',completed:1,total:2,reason:'Generated second page unavailable'}};}});
 const settings={...f.processing.view().settings,typeProfiles:{'text/plain':'generated.partial-observation'}};
 f.processing.update({revision:f.processing.view().revision,settings,policy:fixtureFilePolicy(settings,f.processing.runtime.registry)});
 const next=Buffer.from('Generated changed document'),second=await upload(f.files,manifest('snapshot','partial','two','one',next),next);await f.processing.tick();
 const observation=f.reader.read({captureId:second.id,scope:all}),body=f.reader.readBody({captureId:second.id,scope:all});
 assert.deepEqual(observation.current.coverage.extraction,{status:'partial',completed:1,total:2,reason:'Generated second page unavailable'});
 assert.deepEqual(observation.comparison,{status:'unavailable',reason:'body_unavailable'});
 assert.equal(body.status,'available');assert.equal(body.items[0].text,'Generated available page');
 assert.equal((body.items[0] as {fileEvidence:{documentLocation:{pageNumber:number}}}).fileEvidence.documentLocation.pageNumber,1);
 assert.equal(observation.previous?.revision,'one');assert.ok(observation.disclosureDependencies.ids.includes(first.id));
});

test('scope, current version, exposure policy and forgetting are rechecked for every observation and body read',async t=>{
 const f=fixture(t),text=Buffer.from('Generated authorized body'),one=await upload(f.files,manifest('archive','scope','one',null,text,'original'),text);await f.processing.tick();
 for(const scope of [{kind:'selection' as const,sourceIds:[]},{kind:'selection' as const,sourceIds:['other']},{kind:'selection' as const,evidenceIds:[]},{kind:'all' as const,deviceId:'other'}, {kind:'all' as const,after:'2026-11-01T00:00:00.000Z'}]){
  assert.throws(()=>f.reader.read({captureId:one.id,scope}),{statusCode:404});assert.throws(()=>f.reader.readBody({captureId:one.id,scope}),{statusCode:404});
 }
 const blocked=new FileObservationReader(f.evidence,new EvidenceExposurePolicy([{sourceId:'archive',representation:'capture',allow:false}]));assert.throws(()=>blocked.read({captureId:one.id,scope:all}),{statusCode:404});
 const updated=Buffer.from('Generated second authorized body'),next=manifest('archive','scope','two','one',updated,'original');next.item.observedAt='2026-10-02T10:00:00.000Z';
 const two=await upload(f.files,next,updated);await f.processing.tick();
 assert.throws(()=>f.reader.read({captureId:one.id,scope:all}),{statusCode:404});
 const metadataReads:string[]=[],readMetadata=f.store.evidenceMetadata.bind(f.store);
 f.store.evidenceMetadata=ids=>{metadataReads.push(...ids);return readMetadata(ids);};
 const onlyCurrent=f.reader.read({captureId:two.id,scope:{kind:'selection',evidenceIds:[two.id]}});f.store.evidenceMetadata=readMetadata;
 assert.equal(onlyCurrent.previous,null);assert.equal(onlyCurrent.comparison.status,'unavailable');assert.deepEqual(onlyCurrent.changes,[]);assert.ok(!metadataReads.includes(one.id));
 const both=f.reader.read({captureId:two.id,scope:{kind:'selection',evidenceIds:[one.id,two.id]}});assert.equal(both.comparison.status,'available');
 const newerOnly=f.reader.read({captureId:two.id,scope:{kind:'all',after:'2026-10-02T00:00:00.000Z'}});
 assert.equal(newerOnly.previous,null);assert.equal(newerOnly.comparison.status,'unavailable');assert.deepEqual(newerOnly.changes,[],'a time-excluded predecessor cannot disclose its title or differences');
 f.sources.update('archive',{enabled:false});assert.throws(()=>f.reader.read({captureId:two.id,scope:all}),{statusCode:404});f.sources.update('archive',{enabled:true});
 f.files.forget(two.id);assert.throws(()=>f.reader.read({captureId:two.id,scope:all}),{statusCode:404});assert.throws(()=>f.reader.readBody({captureId:two.id,scope:all}),{statusCode:404});
});
