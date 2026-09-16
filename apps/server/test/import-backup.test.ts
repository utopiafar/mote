import {test} from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,linkSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {FILE_PART_BYTES} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {FileStore} from '../src/files.js';
import {SourceStore} from '../src/sources.js';
import {ImportStore,type ImportPreparation} from '../src/imports.js';
import {restoreProfile,verifiedBackup} from '../../../scripts/profile-lib.mjs';

const backupScript=fileURLToPath(new URL('../../../scripts/backup.ts',import.meta.url));
const takeBackup=(source:string,snapshot:string)=>execFileSync(process.execPath,[backupScript,'--data',source,'--out',snapshot],{stdio:'pipe'});

test('restored import rebases all paths and replays a partial import without losing new evidence IDs',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mote-import-backup-'))),originalDirectory=join(root,'original'),snapshot=join(root,'snapshot'),target=join(root,'restored');
 const original=new Store(originalDirectory,{dataKey:'ab'.repeat(32)}),files=new ArchivedFileStore(original),sources=new SourceStore(original);
 let restored:Store|undefined;t.after(()=>{original.close();restored?.close();rmSync(root,{recursive:true,force:true});});
 const parser=async({workspace,inputPaths}:ImportPreparation)=>{const rows=['first','second'].map(id=>({item:{externalId:id,revision:'v1',observedAt:'2026-09-15T12:00:00Z',title:id,text:'Synthetic preserved text '+id,kind:'file',layer:'original'},evidencePaths:inputPaths}));writeFileSync(join(workspace,'records.jsonl'),rows.map(row=>JSON.stringify(row)).join('\n'));return {summary:'Two synthetic records'};};
 const imports=new ImportStore(original,files,sources,{prepare:parser}),job=await imports.create({files:[{name:'original.txt',dataBase64:Buffer.from('synthetic source').toString('base64')}]});await imports.prepare(job.id);
 const attach=files.attach.bind(files);let fail=true;files.attach=(id,ids)=>{if(fail&&original.evidence([id])[0].provenance?.externalId==='second'){fail=false;throw Error('Synthetic interruption');}attach(id,ids);};
 const partial=await imports.confirm(job.id);assert.equal(partial.progress.processed,1);const oldWorkspace=join(originalDirectory,'imports',job.id);writeFileSync(join(oldWorkspace,'generated-secret-script.mjs'),'synthetic original marker');
 const completed=await imports.create({files:[{name:'completed.txt',dataBase64:Buffer.from('another synthetic source').toString('base64')}]});await imports.prepare(completed.id);await imports.confirm(completed.id);
 execFileSync(process.execPath,[fileURLToPath(new URL('../../../scripts/backup.ts',import.meta.url)),'--data',originalDirectory,'--out',snapshot]);
 await restoreProfile({meta:{runtime:'native'},dataDir:target,processFile:join(root,'missing-process.json')},snapshot);
 restored=new Store(target,{dataKey:'ab'.repeat(32)});const resumedIds:string[][]=[];
 const resumed=new ImportStore(restored,new ArchivedFileStore(restored),new SourceStore(restored),{prepare:async input=>{assert.ok(input.workspace.startsWith(target+'/imports/'));assert.ok(input.inputPaths.every(path=>path.startsWith(target+'/imports/')));assert.equal(readFileSync(input.inputPaths[0],'utf8'),'synthetic source');return parser(input);},onImported:async ids=>{resumedIds.push(ids);return {memoryJobId:'resumed-memory'};}});
 const restoredJob=resumed.get(job.id);assert.equal(restoredJob.status,'queued');assert.equal(restoredJob.processingStatus,'archived');assert.equal(restoredJob.progress.processed,0);assert.deepEqual(restoredJob.captureIds,partial.captureIds);await assert.rejects(resumed.confirm(job.id),{statusCode:409});
 assert.equal(resumed.get(completed.id).status,'completed');assert.equal((await resumed.confirm(completed.id)).status,'completed');assert.deepEqual(resumedIds,[]);
 assert.equal((await resumed.retry(job.id)).status,'awaiting_confirmation');const finished=await resumed.confirm(job.id);assert.equal(finished.status,'completed');assert.equal(finished.progress.duplicates,1);assert.equal(finished.progress.imported,1);assert.equal(finished.captureIds.length,2);assert.deepEqual(resumedIds,[finished.captureIds]);assert.equal(restored.list().items.length,4);
 resumed.delete(job.id);assert.equal(readFileSync(join(oldWorkspace,'generated-secret-script.mjs'),'utf8'),'synthetic original marker');
});

for(const mode of ['plain','encrypted','mixed','legacy'] as const)test(`${mode} backup restores imported originals and multipart client files through their original readers`,async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mote-mixed-backup-'))),source=join(root,'source'),snapshot=join(root,'snapshot'),target=join(root,'target'),key='cd'.repeat(32);
 const original=new Store(source,{dataKey:key,contentEncryptionEnabled:mode!=='plain'}),sources=new SourceStore(original),archived=new ArchivedFileStore(original),files=new FileStore(original,sources);let restored:Store|undefined;
 t.after(()=>{original.close();restored?.close();rmSync(root,{recursive:true,force:true});});
 const imported=await new ImportStore(original,archived,sources).create({files:[{name:'generated.txt',dataBase64:Buffer.from('Synthetic imported original').toString('base64')}]});
 sources.register({id:'backup-phone',name:'Synthetic backup phone',kind:'local-files',deviceId:'phone',platform:'android',retention:'archive'});
 const bytes=Buffer.alloc(FILE_PART_BYTES+37,9),revision={sourceId:'backup-phone',previousRevision:null,item:{externalId:'generated://backup/file',revision:'v1',observedAt:'2026-09-16T00:00:00Z',title:'Synthetic multipart file',kind:'file',layer:'original',text:'',mimeType:'application/octet-stream',deleted:false},relativePath:'generated/file.bin',sizeBytes:bytes.length,sha256:sha256(bytes)};
 const session=files.begin(revision,()=>{});for(let part=0;part<2;part++)files.part(session.uploadId,part,bytes.subarray(part*FILE_PART_BYTES,(part+1)*FILE_PART_BYTES),()=>{});const ack=await files.commit(session.uploadId,()=>{});
 const suffix=mode==='plain'?'.plain':'.aes',partBase=join(files.objects,sha256(bytes));
 if(mode==='plain')assert.deepEqual(readFileSync(join(partBase,'0'+suffix)),bytes.subarray(0,FILE_PART_BYTES));
 else assert.notDeepEqual(readFileSync(join(partBase,'0'+suffix)),bytes.subarray(0,FILE_PART_BYTES));
 const legacy=mode==='legacy'||mode==='mixed';
 if(legacy){
   // Old vaults used unsuffixed AES-GCM originals/parts and one vault-wide key identity.
   original.db.prepare('UPDATE settings SET value=? WHERE key=?').run(sha256(Buffer.from(key,'hex')),'encryption');
   renameSync(join(archived.directory,imported.files[0].hash+'.aes'),join(archived.directory,imported.files[0].hash));
   if(mode==='legacy')for(let part=0;part<2;part++)renameSync(join(partBase,part+'.aes'),join(partBase,String(part)));
 }
 let plainOriginal:ReturnType<ArchivedFileStore['put']>|undefined;
 if(mode==='mixed'){
   original.contentEncryption.setEnabled(false);
   // One committed object can contain both formats after an interrupted bulk decryption.
   original.contentEncryption.decrypt(join(partBase,'0'),part=>assert.deepEqual(part,bytes.subarray(0,FILE_PART_BYTES)));
   plainOriginal=archived.put({name:'new-plain.txt',bytes:Buffer.from('Generated plaintext after opt-out')});
   // Reader precedence is explicit: a selected plaintext copy wins over an older copy.
   writeFileSync(join(partBase,'0.aes'),original.contentEncryption.seal(bytes.subarray(0,FILE_PART_BYTES)));
 }
 original.db.prepare("UPDATE file_jobs SET state='running',summary_state='running',attempts=2,available_at=12345,local_only=1 WHERE capture_id=?").run(ack.id);
 takeBackup(source,snapshot);
 const manifest=JSON.parse(readFileSync(join(snapshot,'backup-manifest.json'),'utf8'));
 const selectedPartSuffix=mode==='legacy'?'':mode==='mixed'?'.plain':suffix;
 assert.ok(Object.hasOwn(manifest.checksums,`files/objects/${sha256(bytes)}/0${selectedPartSuffix}`));
 assert.ok(Object.hasOwn(manifest.checksums,`files/${imported.files[0].hash}${legacy?'':suffix}`));
 if(mode==='mixed'){
   assert.ok(Object.hasOwn(manifest.checksums,`files/objects/${sha256(bytes)}/1.aes`));
   assert.equal(Object.hasOwn(manifest.checksums,`files/objects/${sha256(bytes)}/0.aes`),false);
 }
 assert.match(manifest.note,/content-key/);assert.match(manifest.note,/MOTE_DATA_KEY/);
 // Backups preserve the selected stored bytes, never decode/re-encode or need the key.
 for(const path of Object.keys(manifest.checksums).filter(path=>path.startsWith('files/')))assert.deepEqual(readFileSync(join(snapshot,path)),readFileSync(join(source,path)));
 await restoreProfile({meta:{runtime:'native'},dataDir:target,processFile:join(root,'none')},snapshot);
 restored=new Store(target,{dataKey:key});const restoredSources=new SourceStore(restored),restoredArchived=new ArchivedFileStore(restored),restoredFiles=new FileStore(restored,restoredSources),restoredImports=new ImportStore(restored,restoredArchived,restoredSources);
 assert.equal(restoredArchived.read(imported.files[0].id).toString('utf8'),'Synthetic imported original');assert.equal(restoredImports.get(imported.id).status,'queued');
 if(plainOriginal)assert.equal(restoredArchived.read(plainOriginal.id).toString(),'Generated plaintext after opt-out');
 assert.deepEqual(Buffer.concat([...restoredFiles.bytes(ack.id)]),bytes);assert.deepEqual(Buffer.concat([...restoredFiles.bytes(ack.id,FILE_PART_BYTES-3,FILE_PART_BYTES+3)]),bytes.subarray(FILE_PART_BYTES-3,FILE_PART_BYTES+4));
 const job=restoredFiles.detail(ack.id).job;assert.equal(job.state,'waiting');assert.equal(job.summary_state,'waiting');assert.equal(job.attempts,2);assert.equal(job.local_only,1);
 assert.equal(restored.db.prepare('SELECT available_at FROM file_jobs WHERE capture_id=?').get(ack.id)!.available_at,12345);assert.equal(restored.db.prepare('SELECT COUNT(*) n FROM file_uploads').get()!.n,0);
 assert.equal(restoredFiles.detail(ack.id).hasOriginal,true);assert.equal(restoredSources.history('backup-phone',revision.item.externalId).length,1);
});

test('a generated content-key stays separate from backups and restores encrypted originals after explicit key recovery',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mote-backup-content-key-'))),source=join(root,'source'),snapshot=join(root,'snapshot'),target=join(root,'restored');
 const original=new Store(source,{contentEncryptionEnabled:true}),archived=new ArchivedFileStore(original);let restored:Store|undefined;
 t.after(()=>{original.close();restored?.close();rmSync(root,{recursive:true,force:true});});
 const file=archived.put({name:'generated.txt',bytes:Buffer.from('Generated encrypted original with a local key')});
 original.contentEncryption.setEnabled(false);takeBackup(source,snapshot);
 const manifest=JSON.parse(readFileSync(join(snapshot,'backup-manifest.json'),'utf8'));
 assert.equal(existsSync(join(snapshot,'content-key')),false);assert.equal(Object.hasOwn(manifest.checksums,'content-key'),false);
 await restoreProfile({meta:{runtime:'native'},dataDir:target,processFile:join(root,'none')},snapshot);
 assert.throws(()=>new Store(target),/key mismatch/);
 copyFileSync(join(source,'content-key'),join(target,'content-key'));
 restored=new Store(target);assert.equal(restored.contentEncryption.enabled,false);
 assert.equal(new ArchivedFileStore(restored).read(file.id).toString(),'Generated encrypted original with a local key');
});

test('format-aware backups reject unsafe preferred variants and remove incomplete destinations',t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mote-backup-links-'))),source=join(root,'source'),outside=join(root,'outside');
 const store=new Store(source,{dataKey:'ed'.repeat(32),contentEncryptionEnabled:true}),archived=new ArchivedFileStore(store);
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 const file=archived.put({name:'generated.txt',bytes:Buffer.from('Generated stored content')}),preferred=join(archived.directory,file.hash+'.plain');
 writeFileSync(outside,'Generated unrelated content');
 for(const kind of ['symlink','dangling','hardlink','directory']){
   const snapshot=join(root,'snapshot-'+kind);
   if(kind==='symlink')symlinkSync(outside,preferred);
   else if(kind==='dangling')symlinkSync(join(root,'missing'),preferred);
   else if(kind==='hardlink')linkSync(outside,preferred);
   else mkdirSync(preferred);
   assert.throws(()=>takeBackup(source,snapshot),/Backup source links and special files are not allowed/);
   assert.equal(existsSync(snapshot),false);rmSync(preferred,{recursive:true,force:true});
 }
 assert.equal(readFileSync(outside,'utf8'),'Generated unrelated content');
});

test('restore format allowlist rejects traversal, credentials, unsupported suffixes and linked files',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'mote-backup-manifest-'))),hash='ab'.repeat(32),database=Buffer.from('Generated manifest validation fixture');
 t.after(()=>rmSync(root,{recursive:true,force:true}));writeFileSync(join(root,'mote.sqlite'),database);
 for(const name of [`files/${hash}.plain/../content-key`,`files/${hash}.aes.tmp`,`blobs/${hash}.plain`,`files/objects/${hash}/128.aes`,`files/objects/${hash}/00.plain`,'content-key']){
   writeFileSync(join(root,'backup-manifest.json'),JSON.stringify({version:1,checksums:{'mote.sqlite':sha256(database),[name]:sha256(database)}}));
   await assert.rejects(verifiedBackup(root),/Unsafe backup manifest entry/);
 }
 const file=`files/${hash}.plain`;mkdirSync(join(root,'files'));
 const outside=join(root,'original');writeFileSync(outside,database);linkSync(outside,join(root,file));
 writeFileSync(join(root,'backup-manifest.json'),JSON.stringify({version:1,checksums:{'mote.sqlite':sha256(database),[file]:sha256(database)}}));
 await assert.rejects(verifiedBackup(root),/Backup links are not allowed/);
});
