import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {zipSync,strToU8} from 'fflate';
import sharp from 'sharp';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {ServerDiagnostics} from '../src/diagnostics.js';
import {readEvidenceImage} from '../src/evidence-image.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MaterialOrganizerRuntime} from '../src/material-organizers.js';
import {ImportStore} from '../src/imports.js';
import {PythonSourcePackExecutor,pythonImportOutputSchema,pythonImportPreparation} from '../src/python-source-pack-executor.js';

async function fixture(t:import('node:test').TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-evidence-images-')),store=new Store(directory),sources=new SourceStore(store);
 const files=new FileStore(store,sources),archived=new ArchivedFileStore(store),materials=new MaterialStore(store),organizers=new MaterialOrganizerRuntime(store,materials);
 const reader=new EvidenceReader(store,sources,files,undefined,undefined,materials,undefined,organizers.sourceItemRecipes);
 const diagnostics=new ServerDiagnostics({directory:join(directory,'logs'),enabled:false});await diagnostics.init();
 t.after(async()=>{await organizers.close();await diagnostics.close();await files.close();store.close();rmSync(directory,{recursive:true,force:true});});
 sources.register({id:'generated-images',name:'Generated images',kind:'upload',deviceId:'generated-device',platform:'import',retention:'archive'});
 const bytes=await sharp({create:{width:2,height:2,channels:3,background:'#123456'}}).png().toBuffer();
 let enabled=true;
 const agent=reader.agent({diagnostics,allowQueryImages:()=>enabled});
 const upload=async(externalId:string,revision='1',original=bytes)=>{
  const input={sourceId:'generated-images',previousRevision:revision==='1'?null:'1',item:{externalId,revision,kind:'file',layer:'original',text:'',title:'Generated image',mimeType:'image/png',observedAt:'2026-09-27T01:00:00Z'},sha256:sha256(original),sizeBytes:original.length};
  const session=files.begin(input,()=>{});files.part(session.uploadId,0,original,()=>{});return files.commit(session.uploadId,()=>{});
 };
 return {store,sources,files,archived,materials,organizers,reader,agent,diagnostics,bytes,upload,setEnabled:(value:boolean)=>enabled=value};
}

test('query reads exact uploaded image revisions while disclosure, policy and tombstones remain authoritative',async t=>{
 const f=await fixture(t),one=await f.upload('same');
 assert.throws(()=>f.store.image(one.id),/Image not found/,'the screenshot-only reader cannot read a normal uploaded image');
 assert.equal((await f.agent.readImage!({id:one.id})).data,f.bytes.toString('base64'));
 f.setEnabled(false);await assert.rejects(f.agent.readImage!({id:one.id}),/disabled/);f.setEnabled(true);
 const denied=f.reader.agent({diagnostics:f.diagnostics,allowQueryImages:()=>true,exposurePolicy:new EvidenceExposurePolicy([{sourceKind:'upload',representation:'image',allow:false}])});
 await assert.rejects(denied.readImage!({id:one.id}),/Image not found/);
 f.store.db.prepare('UPDATE file_jobs SET local_only=1 WHERE capture_id=?').run(one.id);
 await assert.rejects(f.agent.readImage!({id:one.id}),/Image not found/);
 f.store.db.prepare('UPDATE file_jobs SET local_only=0 WHERE capture_id=?').run(one.id);
 const next=await sharp({create:{width:2,height:2,channels:3,background:'#abcdef'}}).png().toBuffer(),two=await f.upload('same','2',next);
 assert.equal((await f.agent.readImage!({id:one.id})).data,f.bytes.toString('base64'),'a discovered historical version never redirects to the new image');
 assert.equal((await f.agent.readImage!({id:two.id})).data,next.toString('base64'));
 await f.sources.upsert('generated-images',{externalId:'same',revision:'3',observedAt:'2026-09-27T02:00:00Z',kind:'file',layer:'reference',deleted:true});
 await assert.rejects(f.agent.readImage!({id:two.id}),/Image not found/);
 await assert.rejects(f.agent.readImage!({id:one.id}),/Image not found/);
});

test('image attachments require the exact parent declaration and archived link, without exposing other originals',async t=>{
 const f=await fixture(t),image=f.archived.put({name:'generated.png',mimeType:'image/png',bytes:f.bytes}),foreign=f.archived.put({name:'foreign.png',mimeType:'image/png',bytes:f.bytes}),text=f.archived.put({name:'original.md',mimeType:'text/markdown',bytes:Buffer.from('Generated source')});
 const item={externalId:'caption',revision:'1',observedAt:'2026-09-27T01:00:00Z',kind:'message',layer:'original',text:'Generated authored caption',document:{contentRole:'authored',recordedAt:'2026-04-13T13:18:00+08:00',timeBasis:'recorded',attachments:[{id:image.id,name:image.name,mimeType:image.mimeType}]}};
 const parent=await f.sources.upsert('generated-images',item);f.archived.attach(parent.id,[image.id,foreign.id,text.id]);
 assert.equal((await f.agent.readImage!({id:parent.id,attachmentId:image.id})).data,f.bytes.toString('base64'));
 await assert.rejects(f.agent.readImage!({id:parent.id,attachmentId:foreign.id}),/Image not found/);
 await assert.rejects(f.agent.readImage!({id:parent.id,attachmentId:text.id}),/Image not found/);
 await assert.rejects(f.agent.readImage!({id:parent.id,attachmentId:'https://invalid.test/private.png'}),/Image not found/);
 const unlinked=await f.sources.upsert('generated-images',{...item,externalId:'unlinked'});
 await assert.rejects(f.agent.readImage!({id:unlinked.id,attachmentId:image.id}),/Image not found/);
 f.store.db.prepare('DELETE FROM capture_files WHERE capture_id=? AND file_id=?').run(parent.id,image.id);
 await assert.rejects(f.agent.readImage!({id:parent.id,attachmentId:image.id}),/Image not found/);
 f.archived.attach(parent.id,[image.id]);f.store.delete(parent.id);
 await assert.rejects(f.agent.readImage!({id:parent.id,attachmentId:image.id}),/Image not found/);
});

test('archive reads enforce image limits and recheck authorization before returning bytes',async t=>{
 const f=await fixture(t),parent=await f.sources.upsert('generated-images',{externalId:'bounds',revision:'1',observedAt:'2026-09-27T01:00:00Z',kind:'message',layer:'original',text:'Generated bounds',document:{attachments:[]}});
 const attach=async(name:string,mimeType:string,bytes:Buffer)=>{
  const file=f.archived.put({name,mimeType,bytes}),record=f.store.evidence([parent.id])[0];
  // Fixture mutation simulates an imported declaration; production declarations
  // are immutable source revisions, independently covered above.
  record.provenance!.document!.attachments!.push({id:file.id});f.store.db.prepare('UPDATE captures SET json=? WHERE id=?').run(JSON.stringify(record),parent.id);f.archived.attach(parent.id,[file.id]);return file;
 };
 const text=await attach('not-image.txt','text/plain',Buffer.from('Generated'));
 await assert.rejects(f.agent.readImage!({id:parent.id,attachmentId:text.id}),/not a supported image/);
 const fake=await attach('looks-like-image.png','application/octet-stream',Buffer.from('Generated non-image'));
 await assert.rejects(f.agent.readImage!({id:parent.id,attachmentId:fake.id}),/not a supported image/);
 const wrong=await attach('declared-jpeg.jpg','image/jpeg',f.bytes);
 await assert.rejects(f.agent.readImage!({id:parent.id,attachmentId:wrong.id}),/does not match/);
 const large=await attach('large.png','image/png',Buffer.alloc(8*1024*1024+1));
 await assert.rejects(f.agent.readImage!({id:parent.id,attachmentId:large.id}),/size limit/);
 const image=await attach('small.png','image/png',f.bytes);let allowed=true;
 const read=f.store.assets.bytes.bind(f.store.assets);f.store.assets.bytes=function*(...args:Parameters<typeof read>){yield* read(...args);allowed=false;};
 await assert.rejects(readEvidenceImage(f.store,f.files,f.archived,{id:parent.id,attachmentId:image.id},()=>allowed),/Image not found/);
});

test('imported ZIP image is readable through discovered Material evidence with preserved authored context',async t=>{
 const f=await fixture(t),packRoot=resolve(import.meta.dirname,'../../..','plugins/source-packs/memex-markdown');
 const executor=new PythonSourcePackExecutor({id:'memex.markdown',version:'1',packRoot,script:'main.py',scriptSha256:sha256(readFileSync(join(packRoot,'main.py'))),pythonExecutable:'/usr/bin/python3',maxInputFiles:256,config:{timeZoneOffset:'+08:00'},outputSchema:pythonImportOutputSchema},
  (workspace,python,runner)=>({command:python,args:['-I','-B',runner],cwd:workspace,env:{PATH:'/usr/bin:/bin',HOME:workspace,TMPDIR:workspace,PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1'}}));
 const imports=new ImportStore(f.store,f.archived,f.sources,{sourcePacks:new Map([['memex.markdown',{revision:'generated',prepare:pythonImportPreparation(executor)}]])});
 const input=zipSync({'export/2026-04-13.md':strToU8('# 2026-04-13\n\n## 13:18:00\n\nGenerated caption. ![image](assets/photo.png)\n'),'export/assets/photo.png':f.bytes});
 const created=await imports.create({processing:'automatic',sourcePackId:'memex.markdown',files:[{name:'generated.zip',dataBase64:Buffer.from(input).toString('base64')}]}),complete=await imports.prepare(created.id);
 assert.equal(complete.status,'completed',complete.error);const parent=f.store.evidence(complete.captureIds)[0],attachment=parent.provenance!.document!.attachments![0];
 assert.equal(f.archived.get(attachment.id!).mimeType,'application/octet-stream','ZIP metadata has no trusted MIME declaration');
 while(await f.organizers.tick(100));
 const {startBridge}=await import('../../../packages/agent/dist/bridge.js'),scope={question:'Generated image',after:'2026-04-13T00:00:00+08:00',before:'2026-04-14T00:00:00+08:00',deviceId:'mote-import'};
 const bridge=await startBridge(f.agent,scope,12);t.after(()=>bridge.close());
 const call=async(tool:string,args:unknown)=>{const response=await fetch(bridge.url+'/'+tool,{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify(args)});assert.equal(response.status,200,await response.clone().text());return response.json();};
 const page=await call('timeline',{}),id=page.data[0].id;assert.notEqual(id,parent.id,'query discovery prefers formal Material evidence');
 const evidence=await call('evidence',{ids:[id]});assert.deepEqual(evidence.data[0].provenance.document,parent.provenance!.document);assert.equal(evidence.data[0].contentAt,parent.provenance!.document!.recordedAt);
 const image=await call('read_image',{id,attachmentId:attachment.id});assert.equal(image.image.mimeType,'image/png');assert.equal(image.image.data,f.bytes.toString('base64'));assert.equal(image.attachmentId,attachment.id);
 const metadata=await call('read_image',{id,attachmentId:attachment.id,view:'metadata'});assert.equal(metadata.image,undefined);
 const region=await call('read_image',{id,attachmentId:attachment.id,expectedImageSha256:metadata.imageView.original.sha256,region:{x:0,y:0,width:1,height:1}});assert.equal(region.imageView.id,id,'formal source attribution survives raw resolution');assert.equal(region.imageView.original.sha256,sha256(f.bytes));assert.equal(region.imageView.output.width,1);
 const material=f.materials.get(materialId(parent.provenance!.sourceId,parent.provenance!.externalId))!;f.materials.retire(material.id,{expectedRevision:material.revision});
 await assert.rejects(f.agent.readImage!({id,attachmentId:attachment.id}),/Image not found/);
 assert.equal((await f.agent.readImage!({id:parent.id,attachmentId:attachment.id})).data,f.bytes.toString('base64'),'retiring a derived view does not delete the retained original');
});

test('image regions pin original versions while metadata, history and attachment grants remain current',async t=>{
 const f=await fixture(t),one=await f.upload('regions'),region={x:0,y:0,width:1,height:2};
 const meta=await f.agent.readImage!({id:one.id,view:'metadata'});assert.equal(meta.data,undefined);assert.equal(meta.imageView!.original.sha256,sha256(f.bytes));
 const read={id:one.id,expectedImageSha256:sha256(f.bytes),region};
 const cropped=await f.agent.readImage!(read);assert.deepEqual(cropped.imageView!.region,region);assert.equal(cropped.imageView!.output!.width,1);
 f.setEnabled(false);await assert.rejects(f.agent.readImage!({id:one.id,view:'metadata'}),/disabled/);f.setEnabled(true);
 f.store.db.prepare('UPDATE file_jobs SET local_only=1 WHERE capture_id=?').run(one.id);await assert.rejects(f.agent.readImage!(read),/Image not found/);f.store.db.prepare('UPDATE file_jobs SET local_only=0 WHERE capture_id=?').run(one.id);
 const next=await sharp({create:{width:2,height:2,channels:3,background:'#556677'}}).png().toBuffer(),two=await f.upload('regions','2',next);
 assert.equal((await f.agent.readImage!(read)).data,cropped.data,'a retained explicit history version keeps its own pixels');
 await assert.rejects(f.agent.readImage!({...read,id:two.id}),(error:any)=>error.code==='image_version_changed');
 const image=f.archived.put({name:'generated.png',mimeType:'image/png',bytes:f.bytes});
 const parent=await f.sources.upsert('generated-images',{externalId:'region-parent',revision:'1',observedAt:'2026-09-27T01:00:00Z',kind:'message',layer:'original',text:'Generated caption',document:{attachments:[{id:image.id}]}});f.archived.attach(parent.id,[image.id]);
 assert.equal((await f.agent.readImage!({...read,id:parent.id,attachmentId:image.id})).data,cropped.data);
 f.store.db.prepare('DELETE FROM capture_files WHERE capture_id=?').run(parent.id);await assert.rejects(f.agent.readImage!({...read,id:parent.id,attachmentId:image.id}),/Image not found/);
 await f.sources.upsert('generated-images',{externalId:'regions',revision:'3',observedAt:'2026-09-27T02:00:00Z',kind:'file',layer:'reference',deleted:true});await assert.rejects(f.agent.readImage!(read),/Image not found/);
});

test('original identity is rechecked after image processing even if authority still returns true',async t=>{
 const f=await fixture(t),one=await f.upload('pin'),original=f.store.db.prepare('SELECT object_hash FROM file_versions WHERE capture_id=?').get(one.id)!.object_hash;
 let calls=0;
 await assert.rejects(readEvidenceImage(f.store,f.files,f.archived,{id:one.id,view:'metadata'},()=>{
  if(++calls===4)f.store.db.prepare('UPDATE file_versions SET object_hash=? WHERE capture_id=?').run('0'.repeat(64),one.id);
  return true;
 }));
 f.store.db.prepare('UPDATE file_versions SET object_hash=? WHERE capture_id=?').run(original,one.id);assert.ok(calls>=4);
});
