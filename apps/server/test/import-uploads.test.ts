import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,sha256} from '../src/store.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {ImportUploads} from '../src/import-uploads.js';
import {ImportStore} from '../src/imports.js';
import {SourceStore} from '../src/sources.js';
import {buildApp} from '../src/app.js';
import {configurationFromFile} from '../src/config.js';
import {rejectSqliteWrites} from './fixtures/sqlite-writer.js';

test('binary imports recover acknowledged parts, detect mismatched replay and import 480 archived originals',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-binary-imports-'));let store=new Store(directory),files=new ArchivedFileStore(store),uploads=new ImportUploads(store,files);
 let imports:ImportStore|undefined;t.after(async()=>{await imports?.stop();await uploads.close();store.close();await rm(directory,{recursive:true,force:true});});
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
 imports=new ImportStore(store,files,new SourceStore(store));const job=await imports.create({name:'Eight months of generated notes',archivedFileIds:originals,processing:'automatic'});
 assert.equal(job.files.length,480);assert.equal(job.archive.files,480);assert.equal(job.status,'queued');assert.equal(store.db.prepare('SELECT count(*) n FROM import_upload_parts').get()!.n,0);
 const completed=await imports.prepare(job.id);assert.equal(completed.status,'completed');assert.equal(completed.progress.imported,480);assert.equal(store.list({limit:1}).totalCount,480);
 const jobAgain=imports.get(job.id);assert.deepEqual(jobAgain.files.map(f=>f.id),originals);
});

test('aged completed uploads keep durable archive receipts until import handoff, while explicit import deletion still releases originals',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-upload-expiry-')),store=new Store(directory),files=new ArchivedFileStore(store),uploads=new ImportUploads(store,files),imports=new ImportStore(store,files,new SourceStore(store));t.after(async()=>{await imports.stop();await uploads.close();store.close();await rm(directory,{recursive:true,force:true});});
 const add=async(name:string)=>{const bytes=Buffer.from(name),u=uploads.begin({name,sizeBytes:bytes.length});uploads.part(u.id,0,bytes);return {u,file:await uploads.commit(u.id)};};
 const abandoned=await add('abandoned.txt'),retained=await add('retained.txt'),shared=await add('shared.txt');
 const job=await imports.create({archivedFileIds:[retained.file.id],name:'Retained original',processing:'automatic'});
 store.db.prepare('UPDATE import_uploads SET expires=0 WHERE id<>?').run(shared.u.id);
 const again=await add('shared.txt');assert.equal(again.file.id,shared.file.id);
 uploads.begin({name:'cleanup.txt',sizeBytes:0});
 assert.equal(files.get(abandoned.file.id).id,abandoned.file.id);assert.equal((await uploads.commit(abandoned.u.id)).id,abandoned.file.id);assert.equal(files.get(retained.file.id).id,retained.file.id);assert.equal(files.get(again.file.id).id,again.file.id);
 const handoff={requestId:randomUUID(),archivedFileIds:[abandoned.file.id],name:'Delayed handoff',processing:'automatic' as const},recover=rejectSqliteWrites(store,'import_jobs');
 await assert.rejects(imports.create(handoff),/Generated SQLite write failure/);recover();uploads.begin({name:'after-handoff-failure.txt',sizeBytes:0});assert.deepEqual(files.read(abandoned.file.id),Buffer.from('abandoned.txt'));assert.equal((await uploads.commit(abandoned.u.id)).id,abandoned.file.id);
 const handed=await imports.create(handoff);assert.equal(handed.files[0].id,abandoned.file.id);assert.equal((await imports.create(handoff)).id,handed.id);
 imports.cancel(job.id);assert.deepEqual(files.read(retained.file.id),Buffer.from('retained.txt'),'cancelling processing preserves its archived original');
 imports.delete(job.id);assert.throws(()=>files.get(retained.file.id),/not found/);assert.deepEqual(files.read(handed.files[0].id),Buffer.from('abandoned.txt'));assert.deepEqual(files.read(again.file.id),Buffer.from('shared.txt'));
});

test('owner HTTP manual import preserves aged acknowledged parts through restart, new uploads, resume and durable archive replay',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-import-upload-age-')),file=join(directory,'mote.yaml'),token='generated-import-upload-owner-12345678';
 await writeFile(file,JSON.stringify({version:1,revision:0,server:{profile:'test',token},storage:{dataDir:directory},models:{deployment:{model:''}},diagnostics:{level:'silent'}}),{mode:0o600});
 const boot=()=>buildApp(configurationFromFile(file),{backgroundWorker:false,agent:{configured:false,async query(){throw Error('No model in generated upload lifecycle');},async close(){}}});
 let node=await boot();t.after(async()=>{await node.app.close();await rm(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+token},id=randomUUID(),manifest={id,name:'generated-pending.bin',sizeBytes:4*1024*1024+23},begin=()=>node.app.inject({method:'POST',url:'/api/import-uploads',headers,payload:manifest});
 assert.equal((await node.app.inject({method:'POST',url:'/api/import-uploads',payload:manifest})).statusCode,401);
 const started=await begin();assert.equal(started.statusCode,200,started.body);assert.equal(started.json().partBytes,4*1024*1024);
 const bytes=Buffer.alloc(started.json().partBytes,37),put=await node.app.inject({method:'PUT',url:`/api/import-uploads/${id}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});assert.equal(put.statusCode,200,put.body);assert.deepEqual(put.json(),{part:0,bytes:bytes.length,hash:sha256(bytes)});
 node.store.db.prepare('UPDATE import_uploads SET expires=1 WHERE id=?').run(id);await node.app.close();node=await boot();
 const originalPart=join(directory,'import-uploads',id,'0');assert.deepEqual(node.store.contentEncryption.read(originalPart),bytes);
 const next=await node.app.inject({method:'POST',url:'/api/import-uploads',headers,payload:{name:'generated-other.bin',sizeBytes:1}});assert.equal(next.statusCode,200,next.body);
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM import_upload_parts WHERE upload_id=?').get(id)!.n,1);assert.deepEqual(node.store.contentEncryption.read(originalPart),bytes);assert.deepEqual((await begin()).json().parts,[{part:0,bytes:bytes.length,hash:sha256(bytes)}]);
 const incomplete=await node.app.inject({method:'POST',url:`/api/import-uploads/${id}/commit`,headers});assert.equal(incomplete.statusCode,409,incomplete.body);
 const replay=await node.app.inject({method:'PUT',url:`/api/import-uploads/${id}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});assert.equal(replay.statusCode,200,replay.body);
 const tail=Buffer.alloc(23,85),last=await node.app.inject({method:'PUT',url:`/api/import-uploads/${id}/parts/1`,headers:{...headers,'content-type':'application/octet-stream'},payload:tail});assert.equal(last.statusCode,200,last.body);
 const committed=await node.app.inject({method:'POST',url:`/api/import-uploads/${id}/commit`,headers});assert.equal(committed.statusCode,200,committed.body);const archived=committed.json();assert.equal(archived.sizeBytes,manifest.sizeBytes);
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM import_upload_parts WHERE upload_id=?').get(id)!.n,0);assert.equal(node.store.contentEncryption.exists(originalPart),false);assert.equal(JSON.parse(String(node.store.db.prepare('SELECT json FROM import_uploads WHERE id=?').get(id)!.json)).fileId,archived.id);
 node.store.db.prepare('UPDATE import_uploads SET expires=1 WHERE id=?').run(id);await node.app.close();node=await boot();
 assert.equal((await begin()).json().fileId,archived.id);assert.equal((await node.app.inject({method:'POST',url:`/api/import-uploads/${id}/commit`,headers})).json().id,archived.id);
 const content=await node.app.inject({url:`/api/archived-files/${archived.id}/content`,headers});assert.equal(content.statusCode,200,content.body);assert.deepEqual(content.rawPayload,Buffer.concat([bytes,tail]));
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM archived_files').get()!.n,1);
});

test('a failed upload checkpoint retains acknowledged bytes and replays the same durable archive after restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-import-upload-checkpoint-')),options={dataKey:'43'.repeat(32),contentEncryptionEnabled:true};let store=new Store(directory,options),files=new ArchivedFileStore(store),uploads=new ImportUploads(store,files);
 t.after(async()=>{await uploads.close();store.close();await rm(directory,{recursive:true,force:true});});
 const bytes=Buffer.from('Generated acknowledged input before checkpoint failure'),manifest={id:randomUUID(),name:'generated-checkpoint.txt',sizeBytes:bytes.length},started=uploads.begin(manifest);uploads.part(started.id,0,bytes);
 const recover=rejectSqliteWrites(store,'import_uploads','UPDATE');await assert.rejects(uploads.commit(started.id),/Generated SQLite write failure/);
 const archived=String(store.db.prepare('SELECT id FROM archived_files').get()!.id);assert.deepEqual(files.read(archived),bytes);assert.equal(uploads.begin(manifest).fileId,undefined);assert.equal(uploads.begin(manifest).parts.length,1);assert.deepEqual(store.contentEncryption.read(join(directory,'import-uploads',started.id,'0')),bytes);
 recover();store.db.prepare('UPDATE import_uploads SET expires=1 WHERE id=?').run(started.id);await uploads.close();store.close();store=new Store(directory,options);files=new ArchivedFileStore(store);uploads=new ImportUploads(store,files);
 uploads.begin({name:'generated-next.txt',sizeBytes:0});assert.equal(uploads.begin(manifest).parts.length,1);const saved=await uploads.commit(started.id);assert.equal(saved.id,archived);assert.deepEqual(files.read(saved.id),bytes);assert.equal(store.db.prepare('SELECT count(*) n FROM archived_files').get()!.n,1);assert.equal(store.db.prepare('SELECT count(*) n FROM import_upload_parts WHERE upload_id=?').get(started.id)!.n,0);assert.equal(store.contentEncryption.exists(join(directory,'import-uploads',started.id,'0')),false);assert.equal((await uploads.commit(started.id)).id,saved.id);
});

for(const failure of ['sql','filesystem'] as const)test(`owner HTTP retries ${failure} part cleanup through the real Web receipt consumer without another original upload`,async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-import-cleanup-')),config=join(directory,'mote.yaml'),token='generated-cleanup-retry-owner-12345678';
 await writeFile(config,JSON.stringify({version:1,revision:0,server:{profile:'test',token},storage:{dataDir:directory},models:{deployment:{model:''}},diagnostics:{level:'silent'}}),{mode:0o600});
 const boot=()=>buildApp(configurationFromFile(config),{backgroundWorker:false,agent:{configured:false,async query(){throw Error('No model in generated cleanup lifecycle');},async close(){}}});
 let node=await boot(),partDirectory='';t.after(async()=>{if(partDirectory)await chmod(partDirectory,0o700).catch(error=>{if(error.code!=='ENOENT')throw error;});await node.app.close();await rm(directory,{recursive:true,force:true});});
 const headers={authorization:'Bearer '+token},bytes=Buffer.from('Generated retained archive after '+failure+' cleanup failure'),name='generated-cleanup.bin';
 const started=await node.app.inject({method:'POST',url:'/api/import-uploads',headers,payload:{name,sizeBytes:bytes.length}});assert.equal(started.statusCode,200,started.body);const id=started.json().id;partDirectory=join(directory,'import-uploads',id);
 const put=await node.app.inject({method:'PUT',url:`/api/import-uploads/${id}/parts/0`,headers:{...headers,'content-type':'application/octet-stream'},payload:bytes});assert.equal(put.statusCode,200,put.body);
 if(failure==='sql')node.store.db.exec("CREATE TRIGGER generated_cleanup_failure BEFORE DELETE ON import_upload_parts BEGIN SELECT RAISE(ABORT,'Generated SQLite cleanup failure'); END");else await chmod(partDirectory,0o500);
 const failed=await node.app.inject({method:'POST',url:`/api/import-uploads/${id}/commit`,headers});assert.equal(failed.statusCode,500,failed.body);
 const receipt=JSON.parse(String(node.store.db.prepare('SELECT json FROM import_uploads WHERE id=?').get(id)!.json));assert.ok(receipt.fileId);assert.equal(node.store.db.prepare('SELECT count(*) n FROM import_upload_parts WHERE upload_id=?').get(id)!.n,failure==='sql'?1:0);assert.equal(node.store.contentEncryption.exists(join(partDirectory,'0')),true);
 const archived=await node.app.inject({url:`/api/archived-files/${receipt.fileId}/content`,headers});assert.equal(archived.statusCode,200,archived.body);assert.deepEqual(archived.rawPayload,bytes);
 if(failure==='sql')node.store.db.exec('DROP TRIGGER generated_cleanup_failure');else await chmod(partDirectory,0o700);
 await node.app.close();node=await boot();
 const {uploadImportFiles}=await import('../../web/src/plugins/intake/import-upload-scheduler.js'),original=new File([bytes],name),identities=new WeakMap<File,string>([[original,id]]),completed=new WeakMap<File,string>(),requests:string[]=[];
 t.mock.method(original,'slice',()=>assert.fail('a durable archive receipt must not reread or resend the original'));
 const api={request:async(path:string,init:RequestInit)=>{requests.push(path);assert.equal(init.method,'POST');const response=await node.app.inject({method:'POST',url:path,headers,...(init.body===undefined?{}:{payload:JSON.parse(String(init.body))})});assert.equal(response.statusCode,200,response.body);return response.json();}} as unknown as import('../../web/src/api.js').Api;
 assert.deepEqual(await uploadImportFiles(api,[original],identities,()=>{},undefined,completed),[receipt.fileId]);assert.equal(completed.get(original),receipt.fileId);assert.deepEqual(requests,['/api/import-uploads',`/api/import-uploads/${id}/commit`]);
 assert.equal(node.store.db.prepare('SELECT count(*) n FROM import_upload_parts WHERE upload_id=?').get(id)!.n,0);assert.equal(node.store.contentEncryption.exists(join(partDirectory,'0')),false);assert.equal(node.store.contentEncryption.exists(partDirectory),false);assert.equal(node.store.db.prepare('SELECT count(*) n FROM archived_files').get()!.n,1);
 const replay=await node.app.inject({method:'POST',url:`/api/import-uploads/${id}/commit`,headers});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().id,receipt.fileId);assert.deepEqual((await node.app.inject({url:`/api/archived-files/${receipt.fileId}/content`,headers})).rawPayload,bytes);
 assert.deepEqual(await uploadImportFiles(api,[original],identities,()=>{},undefined,completed),[receipt.fileId]);assert.equal(requests.length,2,'only a successfully completed commit enters the local completed cache');
});

test('large browser commit cancellation keeps resumable parts and duplicate replays reuse the original',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-import-cancel-')),store=new Store(directory),files=new ArchivedFileStore(store),uploads=new ImportUploads(store,files);t.after(async()=>{await uploads.close();store.close();await rm(directory,{recursive:true,force:true});});
 const body=Buffer.alloc(8*1024*1024,83),start=uploads.begin({name:'generated-large.bin',sizeBytes:body.length});
 for(let part=0;part<2;part++)uploads.part(start.id,part,body.subarray(part*start.partBytes,(part+1)*start.partBytes));
 const controller=new AbortController(),pending=uploads.commit(start.id,controller.signal);await new Promise<void>(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,{name:'AbortError'});
 assert.equal(uploads.begin({id:start.id,name:'generated-large.bin',sizeBytes:body.length}).parts.length,2);assert.equal(store.db.prepare('SELECT count(*) n FROM archived_files').get()!.n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM asset_pins').get()!.n,0);
 const [first,second]=await Promise.all([uploads.commit(start.id),uploads.commit(start.id)]);assert.equal(first.id,second.id);assert.deepEqual(files.read(first.id),body);
});

test('retained import jobs do not impose a lifetime admission quota',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'mote-import-admission-')),store=new Store(directory),files=new ArchivedFileStore(store),imports=new ImportStore(store,files,new SourceStore(store));
 t.after(async()=>{await imports.stop();store.close();await rm(directory,{recursive:true,force:true});});
 const original=files.put({name:'generated.txt',bytes:Buffer.from('Generated reusable original')});
 let latest:string|undefined;
 for(let i=0;i<1001;i++)latest=(await imports.create({name:`Generated import ${i}`,archivedFileIds:[original.id],processing:'automatic'})).id;
 assert.equal(store.db.prepare('SELECT count(*) n FROM import_jobs').get()!.n,1001);
 assert.equal(imports.get(latest!).status,'queued');assert.deepEqual(files.read(original.id),Buffer.from('Generated reusable original'));
});
