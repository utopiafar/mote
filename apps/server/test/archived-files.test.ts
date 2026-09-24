import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {SourceStore} from '../src/sources.js';

test('generic originals preserve bytes, names and MIME with content-addressed deduplication',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-files-')),store=new Store(directory),files=new ArchivedFileStore(store);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const bytes=Buffer.from([0,1,255,50]),first=files.put({name:'fixture/附件.bin',bytes,mimeType:'application/x-fixture'});
  assert.deepEqual(files.read(first.id),bytes);assert.equal(first.name,'附件.bin');
  assert.equal(files.put({name:'fixture/附件.bin',bytes,mimeType:'application/x-fixture'}).id,first.id);
  assert.notEqual(files.put({name:'copy.bin',bytes}).id,first.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM file_blobs').get()?.n,1);
  assert.throws(()=>files.put({name:'../escape',bytes}),/traverse/);assert.throws(()=>files.put({name:'/escape',bytes}),/Invalid/);
});
test('revoked archive authorization leaves no asset or original row',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-files-fence-')),store=new Store(directory),files=new ArchivedFileStore(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const bytes=Buffer.from('Generated ZIP expansion child');let checks=0;
  assert.throws(()=>files.putParts({name:'archive.contents/child.txt'},[bytes],bytes.length,()=>{
    if(++checks===4)throw Error('generated grant revoked');
  }),/grant revoked/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM assets').get()?.n,0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM archived_files').get()?.n,0);
  assert.deepEqual(readdirSync(store.assets.directory),[]);
});
test('originals honor vault blob encryption and detect corrupted content',t=>{
  const directory=mkdtempSync(join(tmpdir(),'mote-files-')),store=new Store(directory,{dataKey:'ab'.repeat(32),contentEncryptionEnabled:true}),files=new ArchivedFileStore(store);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const bytes=Buffer.from('synthetic original'),file=files.put({name:'fixture.bin',bytes});
  assert.deepEqual(files.read(file.id),bytes);assert.notDeepEqual(readFileSync(join(store.assets.directory,file.hash,'0.aes')),bytes);
});
test('portable archive restores original bytes, stable file IDs and attachment relations',async t=>{
 const originDirectory=mkdtempSync(join(tmpdir(),'mote-file-origin-')),restoreDirectory=mkdtempSync(join(tmpdir(),'mote-file-restore-'));
 const origin=new Store(originDirectory,{dataKey:'ab'.repeat(32),contentEncryptionEnabled:true}),restored=new Store(restoreDirectory,{dataKey:'cd'.repeat(32),contentEncryptionEnabled:true});t.after(()=>{origin.close();restored.close();rmSync(originDirectory,{recursive:true,force:true});rmSync(restoreDirectory,{recursive:true,force:true});});
 const files=new ArchivedFileStore(origin),sources=new SourceStore(origin),file=files.put({name:'synthetic.docx',bytes:Buffer.from('synthetic original bytes'),mimeType:'application/x-fixture'}),attachment=files.put({name:'synthetic.bin',bytes:Buffer.from([0,255,8])});
 sources.register({id:'portable-files',name:'Synthetic archive',kind:'upload',deviceId:'synthetic',platform:'import',retention:'archive'});
 const capture=await sources.upsert('portable-files',{externalId:'entry',revision:'v1',observedAt:'2026-09-15T12:00:00Z',kind:'file',layer:'original',text:'Synthetic authored text',document:{fileId:file.id,timeBasis:'unknown',contentRole:'authored',attachments:[{id:attachment.id,name:attachment.name}]}});files.attach(capture.id,[file.id,attachment.id]);
 const archive=origin.exportArchive(100000);assert.equal(archive.files.length,2);assert.equal('import_jobs'in archive,false);assert.equal('settings'in archive,false);
 await restored.importArchive(archive);const restoredFiles=new ArchivedFileStore(restored);assert.deepEqual(restoredFiles.get(file.id),file);assert.equal(restoredFiles.read(file.id).toString(),'synthetic original bytes');assert.deepEqual(restoredFiles.read(attachment.id),Buffer.from([0,255,8]));assert.equal(restoredFiles.listForCapture(capture.id).length,2);
 assert.equal(restored.evidence([capture.id])[0].provenance?.document?.fileId,file.id);assert.notDeepEqual(readFileSync(join(restored.assets.directory,file.hash,'0.aes')),restoredFiles.read(file.id));
 assert.equal((await restored.importArchive(archive)).duplicates,1);
});
test('portable file preflight, quota and late rollback leave no partial originals',async t=>{
 const originDirectory=mkdtempSync(join(tmpdir(),'mote-file-origin-')),restoreDirectory=mkdtempSync(join(tmpdir(),'mote-file-restore-')),quotaDirectory=mkdtempSync(join(tmpdir(),'mote-file-quota-'));
 const origin=new Store(originDirectory),restored=new Store(restoreDirectory),quota=new Store(quotaDirectory,{maxStorageBytes:100});t.after(()=>{origin.close();restored.close();quota.close();for(const path of [originDirectory,restoreDirectory,quotaDirectory])rmSync(path,{recursive:true,force:true});});
 const file=new ArchivedFileStore(origin).put({name:'fixture.bin',bytes:Buffer.from('synthetic original')});const archive=origin.exportArchive(10000);
 await assert.rejects(restored.importArchive({...archive,files:[{...archive.files[0],dataBase64:Buffer.from('corrupt').toString('base64')}]}),/checksum/);assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM archived_files').get()?.n,0);
 await assert.rejects(restored.importArchive({...archive,sourceHeads:[{capture_id:'missing'}]}),/source pointer/);assert.equal(restored.db.prepare('SELECT COUNT(*) AS n FROM archived_files').get()?.n,0);assert.deepEqual(readdirSync(restored.assets.directory),[]);
 await assert.rejects(quota.importArchive(archive),{statusCode:507});assert.deepEqual(readdirSync(quota.assets.directory),[]);assert.throws(()=>origin.exportArchive(20),{statusCode:413});assert.equal(new ArchivedFileStore(origin).read(file.id).toString(),'synthetic original');
});
