import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,rm,symlink,readdir,realpath,link} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {serializeConfigDocument,readConfigDocument} from '@mote/shared/config-file';
import {initialize,profilePaths,loadProfile,withProfileLock,backupProfile,restoreProfile,verifiedBackup} from '../../../scripts/profile-lib.mjs';
import {cli,freePort,note} from '../../../scripts/profile-fixtures.mjs';
import {buildApp} from '../src/app.js';
import {configurationFromFile} from '../src/config.js';
import {applicationFixture,waitFor} from './fixtures/backup-application.js';
import {writeMessagesResponse} from '../../../scripts/fixtures/messages-provider.js';
import {pluginMemoryBackup} from '../../../scripts/plugin-memory-backup.mjs';

async function restoredFixture(f:Awaited<ReturnType<typeof applicationFixture>>,backup:string,{assembly=false,key}:{assembly?:boolean;key?:string}={}){
 const source=await loadProfile(f.paths),paths=profilePaths('test',join(f.root,'restore-'+randomUUID()));await initialize(paths,{runtime:'native',port:String(await freePort())});
 const document=readConfigDocument(paths.configFile).savedDocument;document.storage.dataKey=key??source.env.MOTE_DATA_KEY;document.diagnostics.level='silent';
 if(assembly){document.models=source.document.models;document.dsh=source.document.dsh;}
 await writeFile(paths.configFile,serializeConfigDocument(document));const p=await loadProfile(paths);await withProfileLock(paths,()=>restoreProfile(p,backup));
 const node=await buildApp(configurationFromFile(paths.configFile),{backgroundWorker:false});f.addCleanup(()=>node.app.close());return {node,paths,p};
}
test('profile backup restores sealed original APP history, accepted state, original bytes and published Materials before an explicit owner resume',{timeout:120000},async t=>{
 const f=await applicationFixture(t);const first=await f.interact('GENERATED-BACKUP-APP-FIRST');assert.equal(first.status,'completed',JSON.stringify(first));assert.equal(f.requests.length,1);
 const saved=note();const savedResponse=await f.api({method:'POST',url:'/api/notes',headers:f.headers,payload:saved});assert.equal(savedResponse.statusCode,201,savedResponse.body);
 const original=Buffer.from('Generated backup original bytes'),fileId=await f.node.archivedFiles.put({name:'generated-original.txt',mimeType:'text/plain',bytes:original});
 const builds=f.node.store.db.prepare('SELECT json FROM plugin_build_instances ORDER BY rowid').all();
 const before=f.controlRows().map(row=>({...row}));assert.ok(before.length);const generation=JSON.parse(String(before[0].json));assert.ok(generation.accepted);await f.node.app.close();
 const p=await loadProfile(f.paths);await cli(p.home,p.profile,'start');assert.equal(f.requests.length,1,'startup does not run an APP interaction');await cli(p.home,p.profile,'stop');
 const backup=join(f.root,'archive');await cli(p.home,p.profile,'backup',['--out',backup]);
 // Installed original artifacts are a generic plugin backup input even when
 // no Memory plan has ever created its optional binding table.
 const generic=new DatabaseSync(':memory:');try{generic.exec('CREATE TABLE plugin_build_instances(json TEXT NOT NULL)');for(const row of builds)generic.prepare('INSERT INTO plugin_build_instances(json) VALUES(?)').run(row.json);const copied=await pluginMemoryBackup(await realpath(p.dataDir),generic);assert.ok(copied.paths.some(path=>path.endsWith('/factory.mjs')));}finally{generic.close();}
 const checked=await verifiedBackup(backup,{dataKey:p.env.MOTE_DATA_KEY});assert.ok(checked.names.some(name=>name.startsWith('native-applications/')&&name.endsWith('manifest.aes')));assert.equal(checked.names.some(name=>name.endsWith('content-key')),false);
 const targetPaths=profilePaths('test',join(f.root,'restored-profiles'));await initialize(targetPaths,{runtime:'native',port:String(await freePort())});
 const document=readConfigDocument(targetPaths.configFile).savedDocument;document.storage.dataKey=p.env.MOTE_DATA_KEY;await writeFile(targetPaths.configFile,serializeConfigDocument(document));let target=await loadProfile(targetPaths);
 await withProfileLock(targetPaths,()=>restoreProfile(target,backup));
 let restored=await buildApp(configurationFromFile(targetPaths.configFile),{backgroundWorker:false});f.addCleanup(async()=>{await restored.app.close();});
 assert.equal(f.requests.length,1,'restoration and startup do not run old APP input');
 assert.deepEqual(restored.archivedFiles.read(fileId.id),original);assert.deepEqual(restored.store.db.prepare("SELECT key,json,revision FROM plugin_instance_state WHERE key LIKE 'dsh-app/%/control'").all().map(row=>({...row})),before);
 const savedRead=await restored.app.inject({url:'/api/notes/'+saved.id,headers:{authorization:'Bearer '+target.env.MOTE_TOKEN}});assert.equal(savedRead.statusCode,200,savedRead.body);assert.equal(savedRead.json().ocrText,saved.text);
 assert.ok(restored.materials.list({}).items.some(value=>value.origin.sourceId.startsWith('dsh-app:')));
 // A new owner explicitly restores model/APP configuration; backup itself does
 // not import a token, model key or native capability grant into the new YAML.
 assert.equal(readConfigDocument(targetPaths.configFile).savedDocument.dsh?.profiles?.length??0,0);
 const explicit=readConfigDocument(targetPaths.configFile).savedDocument;explicit.models=p.document.models;explicit.dsh=p.document.dsh;await restored.app.close();await writeFile(targetPaths.configFile,serializeConfigDocument(explicit));restored=await buildApp(configurationFromFile(targetPaths.configFile),{backgroundWorker:false});
 const response=await restored.app.inject({method:'POST',url:'/api/conversations/messages',headers:{authorization:'Bearer '+target.env.MOTE_TOKEN},payload:{conversationId:f.conversationId,clientRequestId:randomUUID(),question:'GENERATED-BACKUP-APP-EXPLICIT-RESUME',modelProfileId:f.modelProfileId,scope:{kind:'all'}}});assert.equal(response.statusCode,202,response.body);
 let final:any;await waitFor(async()=>{final=(await restored.app.inject({url:'/api/conversations/'+f.conversationId+'/messages/'+response.json().id,headers:{authorization:'Bearer '+target.env.MOTE_TOKEN}})).json();return ['completed','failed','cancelled'].includes(final.status);},'restored explicit APP interaction');assert.equal(final.status,'completed',JSON.stringify(final));assert.equal(f.requests.length,2);assert.match(JSON.stringify(f.requests[1]),/GENERATED-BACKUP-APP-FIRST/);
});

test('backup source stays byte-identical while only copied APP writer leases are removed before checksums',{timeout:120000},async t=>{
 const f=await applicationFixture(t);assert.equal((await f.interact('GENERATED-APP-WRITER-SNAPSHOT')).status,'completed');
 const holder=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await new Promise<void>((resolve,reject)=>{holder.once('spawn',resolve);holder.once('error',reject);});
 f.addCleanup(async()=>{if(holder.exitCode===null){holder.kill('SIGTERM');await new Promise(resolve=>holder.once('exit',resolve));}});
 const row=f.controlRows()[0],control=JSON.parse(String(row.json));const stale={...control,writer:{pid:holder.pid!,token:randomUUID()}},json=JSON.stringify(stale);
 // A deliberately stale process marker is the fault. Its accepted generation,
 // SDK history, artifacts and receipts were produced by the actual APP above.
 f.node.store.db.prepare('UPDATE plugin_instance_state SET json=?,bytes=? WHERE key=?').run(json,Buffer.byteLength(json),row.key);await f.node.app.close();
 const source=await loadProfile(f.paths),dbPath=join(source.dataDir,'mote.sqlite'),bytesBefore=await readFile(dbPath),backup=join(f.root,'writer-archive');
 await cli(source.home,source.profile,'backup',['--out',backup]);assert.deepEqual(await readFile(dbPath),bytesBefore,'the original SQLite file must not be modified');
 const snapshot=new DatabaseSync(join(backup,'mote.sqlite'),{readOnly:true}),original=new DatabaseSync(dbPath,{readOnly:true});
 try{
  const records=(db:DatabaseSync)=>db.prepare('SELECT * FROM plugin_instance_state ORDER BY package_id,installation_id,instance_id,key').all();
  const sourceRows=records(original),copiedRows=records(snapshot);assert.equal(sourceRows.length,copiedRows.length);
  for(let index=0;index<sourceRows.length;index++){
   const expected={...sourceRows[index]};if(expected.key===row.key){expected.json=JSON.stringify(control);expected.bytes=Buffer.byteLength(String(expected.json));}
   assert.deepEqual({...copiedRows[index]},expected,'all receipt/scope and other state rows retain their exact fields');
  }
  for(const table of ['source_versions','source_heads','material_heads','material_revisions','material_blocks'])assert.deepEqual(snapshot.prepare('SELECT * FROM '+table).all(),original.prepare('SELECT * FROM '+table).all(),table+' is unchanged');
 }finally{snapshot.close();original.close();}
 assert.doesNotThrow(()=>process.kill(holder.pid!,0),'the foreign PID remains alive; snapshot cannot depend on a stale PID probe');
 const restored=await restoredFixture(f,backup,{assembly:true});
 const response=await restored.node.app.inject({method:'POST',url:'/api/conversations/messages',headers:{authorization:'Bearer '+restored.p.env.MOTE_TOKEN},payload:{conversationId:f.conversationId,clientRequestId:randomUUID(),question:'GENERATED-NEW-HOST-CAN-RESUME',modelProfileId:f.modelProfileId,scope:{kind:'all'}}});assert.equal(response.statusCode,202,response.body);
 let result:any;await waitFor(async()=>{result=(await restored.node.app.inject({url:'/api/conversations/'+f.conversationId+'/messages/'+response.json().id,headers:{authorization:'Bearer '+restored.p.env.MOTE_TOKEN}})).json();return ['completed','failed','cancelled'].includes(result.status);},'new host APP after stale writer projection');assert.equal(result.status,'completed',JSON.stringify(result));assert.equal(f.requests.length,2);
});

test('cancelled and disabled APP pending bytes survive backup while restore never starts or grants the old interaction',{timeout:120000},async t=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const f=await applicationFixture(t,{respond:async(_,response,index)=>{if(index===1){entered.resolve();await release.promise;}writeMessagesResponse(response,{stage:1,model:'generated-native-model',text:JSON.stringify({answer:'Generated pending answer',citationIds:[]})});}});f.addCleanup(()=>release.resolve());
 const message=await f.enqueue('GENERATED-BACKUP-PENDING');await entered.promise;
 assert.equal((await f.api({method:'POST',url:'/api/conversations/'+f.conversationId+'/messages/'+message.id+'/cancel',headers:f.headers})).statusCode,200);release.resolve();assert.equal((await f.settled(message)).status,'cancelled');
 assert.equal((await f.action('disable')).statusCode,200);
 const source=await loadProfile(f.paths);await waitFor(async()=>{try{return !(await readdir(join(source.dataDir,'native-applications',JSON.parse(String(f.controlRows()[0].json)).identity))).includes('working');}catch{return false;}},'sealed cancelled input');
 const control=JSON.parse(String(f.controlRows()[0].json));assert.ok(control.pending);assert.equal(control.accepted,undefined);await f.node.app.close();
 const backup=join(f.root,'pending-archive');await cli(source.home,source.profile,'backup',['--out',backup]);const checked=await verifiedBackup(backup,{dataKey:source.env.MOTE_DATA_KEY});assert.ok(checked.names.some(path=>path.includes('/'+control.pending+'/manifest.aes')));
 const restored=await restoredFixture(f,backup,{assembly:true});assert.equal(f.requests.length,1,'restoration/start does not reexecute a cancelled APP');assert.equal(restored.node.pluginCenter.instanceView(f.instanceId).desired,false);
 const response=await restored.node.app.inject({method:'POST',url:'/api/conversations/messages',headers:{authorization:'Bearer '+restored.p.env.MOTE_TOKEN},payload:{conversationId:f.conversationId,clientRequestId:randomUUID(),question:'GENERATED-RESTORE-DOES-NOT-ADD-GRANT',modelProfileId:f.modelProfileId,scope:{kind:'all'}}});assert.equal(response.statusCode,202,response.body);
 let result:any;await waitFor(async()=>{result=(await restored.node.app.inject({url:'/api/conversations/'+f.conversationId+'/messages/'+response.json().id,headers:{authorization:'Bearer '+restored.p.env.MOTE_TOKEN}})).json();return ['completed','failed','cancelled'].includes(result.status);},'disabled restored APP');assert.equal(result.status,'failed',JSON.stringify(result));assert.equal(f.requests.length,1);assert.equal(restored.node.sources.listSources().filter(source=>source.id.startsWith('dsh-app:')).length,0);
});

test('APP backup refuses unsealed, unknown, linked or damaged input and a profile lock conflict preserves source bytes',{timeout:120000},async t=>{
 const f=await applicationFixture(t);assert.equal((await f.interact('GENERATED-APP-NEGATIVE-BOUNDARIES')).status,'completed');const row=f.controlRows()[0],control=JSON.parse(String(row.json));await f.node.app.close();
 const p=await loadProfile(f.paths),source=await realpath(p.dataDir),dbPath=join(source,'mote.sqlite'),base=join(source,'native-applications',control.identity),generation=join(base,'generations',control.accepted),good=join(f.root,'complete-archive');
 await cli(p.home,p.profile,'backup',['--out',good]);const sourceBytes=await readFile(dbPath);
 await withProfileLock(f.paths,async()=>{
  const lock=await readFile(join(p.directory,'lifecycle.lock'));
  for(const [action,args]of [['backup',['--out',join(f.root,'locked-backup')]],['restore',['--from',good]],['upgrade',['--release',p.meta.release]]] as const){const denied=await cli(p.home,p.profile,action,[...args],{fail:true});assert.match(denied.stderr,/Another profile command is running/);assert.deepEqual(await readFile(join(p.directory,'lifecycle.lock')),lock);}
 });
 await assert.rejects(()=>backupProfile(p,join(f.root,'no-lock')),/exited 1/);assert.deepEqual(await readFile(dbPath),sourceBytes);assert.equal((await readdir(f.root)).includes('no-lock'),false);
 const working=join(base,'working');await mkdir(working,{mode:0o700});await writeFile(join(working,'unsealed'),'GENERATED-UNSEALED-INPUT',{mode:0o600});
 const unsealed=await cli(p.home,p.profile,'backup',['--out',join(f.root,'unsealed-archive')],{fail:true});assert.match(unsealed.stderr,/Native application/);assert.equal(await readFile(join(working,'unsealed'),'utf8'),'GENERATED-UNSEALED-INPUT');await rm(working,{recursive:true});
 const payload=join(generation,'0.aes'),alias=join(f.root,'payload-hardlink');await link(payload,alias);
 const linked=await cli(p.home,p.profile,'backup',['--out',join(f.root,'linked-archive')],{fail:true});assert.match(linked.stderr,/Native application/);await rm(alias);
 const raw=await readFile(payload);await writeFile(payload,Buffer.from(raw.map((value,index)=>index===raw.length-1?value^1:value)));
 await cli(p.home,p.profile,'backup',['--out',join(f.root,'damaged-archive')],{fail:true});assert.deepEqual(await readFile(payload),Buffer.from(raw.map((value,index)=>index===raw.length-1?value^1:value)),'failed backup never repairs or discards source input');await writeFile(payload,raw);
 const db=new DatabaseSync(dbPath);try{const json=JSON.stringify({...control,version:2});db.prepare('UPDATE plugin_instance_state SET json=?,bytes=? WHERE key=?').run(json,Buffer.byteLength(json),row.key);}finally{db.close();}
 const malformed=await cli(p.home,p.profile,'backup',['--out',join(f.root,'unknown-archive')],{fail:true});assert.match(malformed.stderr,/Native application/);
 const unchanged=new DatabaseSync(dbPath,{readOnly:true});try{assert.equal(JSON.parse(String(unchanged.prepare('SELECT json FROM plugin_instance_state WHERE key=?').get(row.key)!.json)).version,2);}finally{unchanged.close();}
 for(const name of ['unsealed-archive','linked-archive','damaged-archive','unknown-archive','locked-backup'])assert.equal((await readdir(f.root)).includes(name),false,name+' incomplete output is cleaned only inside its exclusively created root');
});

test('APP archive restore checks original key, immutable paths, completeness and target contract before touching its destination',{timeout:120000},async t=>{
 const f=await applicationFixture(t);assert.equal((await f.interact('GENERATED-APP-RESTORE-REFUSALS')).status,'completed');await f.node.app.close();const source=await loadProfile(f.paths),backup=join(f.root,'restore-source');await cli(source.home,source.profile,'backup',['--out',backup]);
 await assert.rejects(()=>verifiedBackup(backup),/Native application/);await assert.rejects(()=>verifiedBackup(backup,{dataKey:'61'.repeat(32)}),/Native application/);
 const checked=await verifiedBackup(backup,{dataKey:source.env.MOTE_DATA_KEY}),manifestPath=join(backup,'backup-manifest.json'),manifestBytes=await readFile(manifestPath),privatePath=checked.names.find(name=>/^native-applications\/.+\/0\.aes$/.test(name))!,privateBytes=await readFile(join(backup,privatePath));
 assert.ok(privatePath);const manifest=JSON.parse(manifestBytes.toString());delete manifest.checksums[privatePath];await rm(join(backup,privatePath));await writeFile(manifestPath,JSON.stringify(manifest));
 await assert.rejects(()=>verifiedBackup(backup,{dataKey:source.env.MOTE_DATA_KEY}),/Native application/,'omitting both ciphertext and checksum cannot hide a required generation file');await writeFile(join(backup,privatePath),privateBytes,{mode:0o600});await writeFile(manifestPath,manifestBytes);
 const external=join(f.root,'external-manifest');await writeFile(external,manifestBytes);await rm(manifestPath);await symlink(external,manifestPath);await assert.rejects(()=>verifiedBackup(backup,{dataKey:source.env.MOTE_DATA_KEY}),/manifest links/);assert.deepEqual(await readFile(external),manifestBytes);await rm(manifestPath);await writeFile(manifestPath,manifestBytes,{mode:0o600});
 const targetPaths=profilePaths('test',join(f.root,'refused-target'));await initialize(targetPaths,{runtime:'native',port:String(await freePort())});let target=await loadProfile(targetPaths),config=readConfigDocument(target.configFile).savedDocument;config.storage.dataKey='61'.repeat(32);await writeFile(target.configFile,serializeConfigDocument(config));target=await loadProfile(targetPaths);
 await assert.rejects(()=>withProfileLock(targetPaths,()=>restoreProfile(target,backup)),/Native application/);assert.deepEqual(await readdir(target.dataDir),[]);
 const release=join(f.root,'incompatible-release');await mkdir(join(release,'apps/server/dist'),{recursive:true});await writeFile(join(release,'apps/server/dist/deployment-contract.json'),JSON.stringify({kind:'mote.deployment',version:2,serverVersion:'generated'}));
 await assert.rejects(()=>withProfileLock(targetPaths,()=>restoreProfile({...target,meta:{...target.meta,release}},backup)),/expected mote.deployment version 1, received 2/);assert.deepEqual(await readdir(target.dataDir),[]);assert.equal((await readdir(target.directory)).some(name=>name.startsWith('.mote-restore-')),false);
 assert.doesNotMatch(manifestBytes.toString(),new RegExp(source.env.MOTE_DATA_KEY));assert.doesNotMatch(manifestBytes.toString(),new RegExp(source.env.MOTE_TOKEN));assert.equal(f.requests.length,1);
});


test('a withdrawn APP exposure stays unreadable after an actual backup and explicit owner SDK resume',{timeout:120000},async t=>{
 const f=await applicationFixture(t),sourceId='generated.backup-private-parent',text='GENERATED-BACKUP-PRIVATE-PARENT-CONTENT';
 assert.equal((await f.api({method:'POST',url:'/api/sources',headers:f.headers,payload:{id:sourceId,name:'Generated backup private input',kind:'custom',deviceId:'generated-input-device',platform:'import',retention:'archive'}})).statusCode,200);
 const parent=await f.api({method:'PUT',url:'/api/sources/'+sourceId+'/items',headers:f.headers,payload:{externalId:'private-parent',revision:'1',observedAt:new Date().toISOString(),title:'Generated private input',text,kind:'file',layer:'original'}});assert.equal(parent.statusCode,200,parent.body);
 const first=await f.interact('GENERATED-BACKUP-READS-PARENT',{scope:{kind:'selection',evidenceIds:[parent.json().id]}});assert.equal(first.status,'completed',JSON.stringify(first));assert.match(JSON.stringify(f.requests[0]),new RegExp(text));
 await f.node.materialOrganizer.tick(20);const productSource=f.node.sources.listSources().find(source=>source.id.startsWith('dsh-app:'))!,report=f.node.materials.list({sourceId:productSource.id}).items.find(material=>material.origin.externalId==='report.txt')!;assert.ok(report);
 const withdrawal=await f.api({method:'PUT',url:'/api/sources/'+sourceId+'/items',headers:f.headers,payload:{externalId:'private-parent',revision:'2',observedAt:new Date().toISOString(),title:'Generated withdrawn input',text:'',kind:'file',layer:'original',deleted:true}});assert.equal(withdrawal.statusCode,200,withdrawal.body);
 assert.equal((await f.api({url:'/api/materials/'+report.id+'/read',headers:f.headers})).statusCode,409);
 const controls=f.controlRows().map(row=>({...row}));await f.node.app.close();const source=await loadProfile(f.paths),backup=join(f.root,'withdrawn-archive');await cli(source.home,source.profile,'backup',['--out',backup]);
 const restored=await restoredFixture(f,backup,{assembly:true}),headers={authorization:'Bearer '+restored.p.env.MOTE_TOKEN};assert.equal(f.requests.length,1);
 assert.equal((await restored.node.app.inject({url:'/api/materials/'+report.id+'/read',headers})).statusCode,409);
 assert.deepEqual(restored.node.store.db.prepare("SELECT key,json,revision FROM plugin_instance_state WHERE key LIKE 'dsh-app/%/control'").all().map(row=>({...row})),controls);
 const response=await restored.node.app.inject({method:'POST',url:'/api/conversations/messages',headers,payload:{conversationId:f.conversationId,clientRequestId:randomUUID(),question:'GENERATED-RESTORE-CANNOT-DECRYPT-WITHDRAWN-SDK',modelProfileId:f.modelProfileId,scope:{kind:'all'}}});assert.equal(response.statusCode,202,response.body);
 let result:any;await waitFor(async()=>{result=(await restored.node.app.inject({url:'/api/conversations/'+f.conversationId+'/messages/'+response.json().id,headers})).json();return ['completed','failed','cancelled'].includes(result.status);},'restored withdrawn SDK exposure');assert.equal(result.status,'failed',JSON.stringify(result));assert.equal(f.requests.length,1,'revoked exposure fails before a model/SDK request');
});
