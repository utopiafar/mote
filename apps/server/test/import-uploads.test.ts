import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {ImportUploads} from '../src/import-uploads.js';
import {ImportStore} from '../src/imports.js';
import {SourceStore} from '../src/sources.js';

test('binary imports recover acknowledged parts, detect mismatched replay and import 480 archived originals',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-binary-imports-'));let store=new Store(directory),files=new ArchivedFileStore(store),uploads=new ImportUploads(store,files);
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const id=randomUUID(),body=Buffer.alloc(4*1024*1024+9,65),manifest={id,name:'generated-large.bin',sizeBytes:body.length};
 const start=uploads.begin(manifest);uploads.part(id,0,body.subarray(0,start.partBytes));
 await assert.rejects(uploads.commit(id),/incomplete/);
 store.close();store=new Store(directory);files=new ArchivedFileStore(store);uploads=new ImportUploads(store,files);
 assert.equal(uploads.begin(manifest).parts.length,1);uploads.part(id,0,body.subarray(0,start.partBytes));
 assert.throws(()=>uploads.part(id,0,Buffer.alloc(start.partBytes,66)),/conflicts/);
 uploads.part(id,1,body.subarray(start.partBytes));const large=await uploads.commit(id);assert.deepEqual(files.read(large.id),body);assert.equal((await uploads.commit(id)).id,large.id);
 assert.equal(uploads.begin(manifest).fileId,large.id);assert.throws(()=>uploads.begin({...manifest,name:'different.bin'}),/conflict/);
 const originals:string[]=[];
 for(let i=0;i<480;i++){
  const bytes=Buffer.from('Generated '+new Date(Date.UTC(2026,2,1)+i*12*3600000).toISOString()+' note '+i),upload=uploads.begin({name:i+'.txt',sizeBytes:bytes.length});
  uploads.part(upload.id,0,bytes);originals.push((await uploads.commit(upload.id)).id);
 }
 const imports=new ImportStore(store,files,new SourceStore(store)),job=await imports.create({name:'Eight months of generated notes',archivedFileIds:originals,processing:'automatic'});
 assert.equal(job.files.length,480);assert.equal(job.archive.files,480);assert.equal(job.status,'queued');assert.equal(store.db.prepare('SELECT count(*) n FROM import_upload_parts').get()!.n,0);
 const completed=await imports.prepare(job.id);assert.equal(completed.status,'completed');assert.equal(completed.progress.imported,480);assert.equal(store.list({limit:1}).totalCount,480);
 const jobAgain=imports.get(job.id);assert.deepEqual(jobAgain.files.map(f=>f.id),originals);
});

test('expired uploads reclaim abandoned originals while preserving import jobs, active uploads and capture references',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-upload-expiry-')),store=new Store(directory),files=new ArchivedFileStore(store),uploads=new ImportUploads(store,files),imports=new ImportStore(store,files,new SourceStore(store));t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const add=async(name:string)=>{const bytes=Buffer.from(name),u=uploads.begin({name,sizeBytes:bytes.length});uploads.part(u.id,0,bytes);return {u,file:await uploads.commit(u.id)};};
 const abandoned=await add('abandoned.txt'),retained=await add('retained.txt'),shared=await add('shared.txt');
 await imports.create({archivedFileIds:[retained.file.id],name:'Retained original',processing:'automatic'});
 store.db.prepare('UPDATE import_uploads SET expires=0 WHERE id<>?').run(shared.u.id);
 const again=await add('shared.txt');assert.equal(again.file.id,shared.file.id);
 uploads.begin({name:'cleanup.txt',sizeBytes:0});
 assert.throws(()=>files.get(abandoned.file.id),/not found/);assert.equal(files.get(retained.file.id).id,retained.file.id);assert.equal(files.get(again.file.id).id,again.file.id);
});

test('large browser commit cancellation keeps resumable parts and duplicate replays reuse the original',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-import-cancel-')),store=new Store(directory),files=new ArchivedFileStore(store),uploads=new ImportUploads(store,files);t.after(async()=>{await uploads.close();store.close();await rm(directory,{recursive:true,force:true});});
 const body=Buffer.alloc(8*1024*1024,83),start=uploads.begin({name:'generated-large.bin',sizeBytes:body.length});
 for(let part=0;part<2;part++)uploads.part(start.id,part,body.subarray(part*start.partBytes,(part+1)*start.partBytes));
 const controller=new AbortController(),pending=uploads.commit(start.id,controller.signal);await new Promise<void>(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,{name:'AbortError'});
 assert.equal(uploads.begin({id:start.id,name:'generated-large.bin',sizeBytes:body.length}).parts.length,2);assert.equal(store.db.prepare('SELECT count(*) n FROM archived_files').get()!.n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM asset_pins').get()!.n,0);
 const [first,second]=await Promise.all([uploads.commit(start.id),uploads.commit(start.id)]);assert.equal(first.id,second.id);assert.deepEqual(files.read(first.id),body);
});
