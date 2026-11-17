import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,rename,cp,symlink,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {initializeFixture,cli,request,note,capture,updateEnvironment} from './profile-fixtures.mjs';
import {repository,profilePaths,loadProfile,atomicJson,nativeIdentity,prepareBackupRestore} from './profile-lib.mjs';
import {configureBackupSchedule,runDueBackup} from './backup-schedule.mjs';

const json=result=>JSON.parse(result.stdout.trim().split('\n').at(-1));
const schedule=(p,action,args=[],options={})=>cli(p.home,p.profile,'backup-schedule',[action,...args],options);
const state=async p=>JSON.parse(await readFile(p.metaFile,'utf8'));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t,{running=false}={}){
 const root=await mkdtemp(join(tmpdir(),'mote-backup-schedule-')),p=await initializeFixture(join(root,'profiles'),'generated');
 t.after(async()=>{try{await cli(p.home,p.profile,'stop');}finally{await rm(root,{recursive:true,force:true});}});
 await cli(p.home,p.profile,'start');const saved=note(),picture=capture();await request(p,'/api/notes',{method:'POST',body:saved,status:201});await request(p,'/api/captures',{method:'POST',body:picture,status:201});
 if(!running)await cli(p.home,p.profile,'stop');return {root,p,saved,picture};
}
async function assertStopped(p){assert.equal((await nativeIdentity(p)).running,false);}
async function awaitLine(child,text){
 let output='';await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(Error('Phase wait timed out: '+output)),15000);child.stdout.on('data',part=>{output+=part;if(output.includes(text)){clearTimeout(timer);done();}});child.once('exit',code=>{clearTimeout(timer);reject(Error('Phase process exited '+code+': '+output));});});
}

test('SCHEDULE: actual CLI is disabled until explicit configure; running intent, exact copy and offline restore-check complete', {timeout:120000},async t=>{
 const {p,saved}=await fixture(t,{running:true});const before=await nativeIdentity(p);
 assert.equal(json(await schedule(p,'status')).policy.enabled,false);assert.deepEqual(json(await schedule(p,'run-due')),{due:false,reason:'disabled'});
 const configured=json(await schedule(p,'configure',['--enable','--interval-hours','24','--keep-count','2','--keep-days','0']));assert.equal(configured.runnerStarted,false);assert.equal(configured.servicesInstalled,false);
 assert.equal((await nativeIdentity(p)).record.marker,before.record.marker);
 const result=json(await schedule(p,'run-due'));assert.equal(result.due,true);assert.equal(result.originalRunning,true);assert.equal((await nativeIdentity(p)).running,true);assert.notEqual((await nativeIdentity(p)).record.marker,before.record.marker);
 assert.equal((await request(p,'/api/notes/'+saved.id)).ocrText,saved.text);
 const manifest=JSON.parse(await readFile(join(result.backup,'backup-manifest.json'),'utf8'));
 const restore=json(await schedule(p,'restore-check'));assert.equal(restore.processesStarted,0);assert.equal(restore.temporaryRemoved,true);assert.equal(restore.database,'ok');assert.equal(restore.checksumsSha256,sha(JSON.stringify(Object.entries(manifest.checksums).sort())));
 const target=await initializeFixture(join(p.home,'restored-profiles'),'restored',{dataKey:p.env.MOTE_DATA_KEY});
 await cli(target.home,target.profile,'restore',['--from',result.backup]);assert.notEqual(target.env.MOTE_TOKEN,p.env.MOTE_TOKEN);await assertStopped(target);
 const restored=new DatabaseSync(join(target.dataDir,'mote.sqlite'),{readOnly:true});try{assert.equal(restored.prepare('SELECT json_extract(json,\'$.ocrText\') body FROM captures WHERE id=?').get(saved.id).body,saved.text);}finally{restored.close();}
 const {stage}=await prepareBackupRestore(result.backup,join(p.directory,'generated'),{dataKey:p.env.MOTE_DATA_KEY});
 try{const db=new DatabaseSync(join(stage,'mote.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT json_extract(json,\'$.ocrText\') body FROM captures WHERE id=?').get(saved.id).body,saved.text);}finally{db.close();}}finally{await rm(stage,{recursive:true,force:true});}
 assert.equal(json(await schedule(p,'run-due')).due,false);assert.equal((await state(p)).backupSchedule.completed.length,1);
 assert.equal((await readdir(p.directory)).some(n=>n.startsWith('.restore-check-')),false);
 const raw=await readFile(p.metaFile,'utf8');assert.equal(raw.includes(p.env.MOTE_TOKEN),false);assert.equal(raw.includes(p.env.MOTE_DATA_KEY),false);
});

test('SCHEDULE: failure before copying preserves inputs and running intent; next actual CLI run retries the saved slot', {timeout:120000},async t=>{
 const {p,saved}=await fixture(t,{running:true});await configureBackupSchedule(p,{enabled:true});let obstruction;
 await assert.rejects(runDueBackup(p,{onStage:async event=>{if(event.phase==='copying'){const pending=(await state(p)).backupSchedule.pending;obstruction=join(p.directory,'backups/scheduled','scheduled-'+pending.attempt,'snapshot');await writeFile(obstruction,'GENERATED_UNMANAGED_OBSTRUCTION');}}}));
 assert.equal((await nativeIdentity(p)).running,true);assert.equal((await request(p,'/api/notes/'+saved.id)).ocrText,saved.text);
 assert.ok((await state(p)).backupSchedule.pending);assert.equal(await readFile(obstruction,'utf8'),'GENERATED_UNMANAGED_OBSTRUCTION');
 const retried=json(await schedule(p,'run-due'));assert.equal(retried.due,true);assert.equal((await state(p)).backupSchedule.completed.length,1);assert.equal((await state(p)).backupSchedule.pending,undefined);assert.equal(await readFile(obstruction,'utf8'),'GENERATED_UNMANAGED_OBSTRUCTION');
 await configureBackupSchedule(p,{enabled:true});let manual;
 await assert.rejects(runDueBackup(p,{onStage:async event=>{if(event.phase==='copying'){const run=(await state(p)).backupSchedule.pending;manual=join(p.directory,'backups/scheduled','scheduled-'+run.attempt,'MANUAL_INPUT');await writeFile(manual,'GENERATED_UNMANAGED_EXTRA_FILE');}}}),/unmanaged input/);
 assert.equal((await nativeIdentity(p)).running,true);assert.ok((await state(p)).backupSchedule.pending);
 const cleanRetry=json(await schedule(p,'run-due'));assert.equal(cleanRetry.due,true);assert.equal((await state(p)).backupSchedule.pending,undefined);assert.equal((await state(p)).backupSchedule.completed.length,2);assert.equal(await readFile(manual,'utf8'),'GENERATED_UNMANAGED_EXTRA_FILE');
});

test('SCHEDULE: actual restart failure cannot advance away from recovery; retry reuses its verified backup and original release', {timeout:120000},async t=>{
 const {p,root,saved}=await fixture(t);const release=join(root,'original-release'),entry=join(release,'apps/server/dist/index.js');await mkdir(join(release,'apps/server/dist'),{recursive:true});
 await writeFile(join(release,'package.json'),'{"type":"module"}');await cp(join(repository,'apps/server/dist/deployment-contract.json'),join(release,'apps/server/dist/deployment-contract.json'));
 await writeFile(entry,'import '+JSON.stringify(pathToFileURL(join(repository,'apps/server/dist/index.js')).href)+';\n');
 await atomicJson(p.metaFile,{...await state(p),release});let current=await loadProfile(p);await cli(p.home,p.profile,'start');await configureBackupSchedule(p,{enabled:true});
 await assert.rejects(runDueBackup(p,{onStage:async e=>{if(e.phase==='verified')await rename(entry,entry+'.held');}}));
 const failed=await state(p);assert.equal(failed.backupSchedule.completed.length,1);assert.ok(failed.backupSchedule.pending.intent.running);assert.equal(failed.backupSchedule.pending.intent.release,release);await assertStopped(current);
 const dueAt=failed.backupSchedule.pending.dueAt;await rename(entry+'.held',entry);
 failed.release=repository;failed.backupSchedule.nextAt=new Date(Date.now()+7*86400000).toISOString();await atomicJson(p.metaFile,failed);
 const result=json(await schedule(p,'run-due'));assert.equal(result.reused,true);assert.equal(result.due,true);assert.equal((await state(p)).backupSchedule.completed.length,1);assert.equal((await state(p)).backupSchedule.completed[0].dueAt,dueAt);
 assert.equal((await nativeIdentity(current)).record.release,release);assert.equal((await state(p)).release,repository);assert.equal((await request(current,'/api/notes/'+saved.id)).ocrText,saved.text);
});

test('SCHEDULE: real lifecycle contention and killed owner retain recovery without creating two completed backups', {timeout:120000},async t=>{
 const {p}=await fixture(t,{running:true});await configureBackupSchedule(p,{enabled:true});
 const script=`import{runDueBackup}from${JSON.stringify(pathToFileURL(join(repository,'scripts/backup-schedule.mjs')).href)};await runDueBackup(${JSON.stringify(profilePaths(p.profile,p.home))},{onStage:async e=>{if(e.phase==='copying'){console.log('GENERATED_COPY_HOLD');await new Promise(()=>{setInterval(()=>{},1000);});}}});`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});t.after(()=>child.kill('SIGKILL'));
 await awaitLine(child,'GENERATED_COPY_HOLD');assert.equal((await nativeIdentity(p)).running,false);
 assert.match((await schedule(p,'run-due',[],{fail:true})).stderr,/Another profile command/);
 const exited=new Promise(done=>child.once('exit',done));child.kill('SIGKILL');await exited;
 const result=json(await schedule(p,'run-due'));assert.equal(result.due,true);assert.equal((await nativeIdentity(p)).running,true);assert.equal((await state(p)).backupSchedule.completed.length,1);
 assert.equal(json(await schedule(p,'run-due')).due,false);
});

test('SCHEDULE: stopped intent, late due, retention ownership, corruption and links preserve unrelated inputs', {timeout:120000},async t=>{
 const {p}=await fixture(t);let clock=new Date('2026-11-01T00:00:00.000Z');await configureBackupSchedule(p,{enabled:true,intervalHours:24,keepCount:1,keepDays:0},{clock:()=>clock});
 const first=await runDueBackup(p,{clock:()=>clock});await assertStopped(p);
 const root=join(p.directory,'backups/scheduled'),firstRoot=join(first.backup,'..');await writeFile(join(firstRoot,'MANUAL_INPUT'),'generated manual input');
 const manual=join(root,'manual-backup');await mkdir(manual);await writeFile(join(manual,'keep'),'generated manual');
 clock=new Date('2026-11-05T00:00:00.000Z');const second=await runDueBackup(p,{clock:()=>clock});assert.equal((await state(p)).backupSchedule.completed.length,2);assert.equal(second.retention.skipped.length,1);assert.equal(await readFile(join(firstRoot,'MANUAL_INPUT'),'utf8'),'generated manual input');
 const secondRoot=join(second.backup,'..');await writeFile(join(second.backup,'mote.sqlite'),'GENERATED_CORRUPTION');
 const outside=join(p.directory,'generated-link-target');await writeFile(outside,'generated target');await symlink(outside,join(secondRoot,'unsafe-link'));
 clock=new Date('2026-11-15T00:00:00.000Z');const third=await runDueBackup(p,{clock:()=>clock});assert.equal(third.retention.skipped.length,2);assert.equal((await state(p)).backupSchedule.completed.length,3);await assertStopped(p);
 assert.equal(await readFile(outside,'utf8'),'generated target');assert.equal(await readFile(join(manual,'keep'),'utf8'),'generated manual');assert.equal(await readFile(join(second.backup,'mote.sqlite'),'utf8'),'GENERATED_CORRUPTION');
 const meta=await state(p),before=meta.backupSchedule.completed.length;await rm(join(firstRoot,'MANUAL_INPUT'));clock=new Date('2026-11-16T00:00:00.000Z');
 const fourth=await runDueBackup(p,{clock:()=>clock});assert.equal(fourth.retention.removed.length,2);assert.equal((await state(p)).backupSchedule.completed.length,before-1);assert.equal((await state(p)).backupSchedule.completed.some(r=>r.name===secondRoot.split('/').at(-1)),true);
 assert.equal(new Date(fourth.nextAt).getTime(),clock.getTime()+86400000);await assertStopped(p);
 await configureBackupSchedule(p,{keepDays:7},{clock:()=>clock});
 const fifth=await runDueBackup(p,{clock:()=>clock});assert.equal(fifth.retention.removed.length,0);assert.equal(fifth.retention.retained,2);
 clock=new Date('2026-11-24T00:00:00.000Z');const sixth=await runDueBackup(p,{clock:()=>clock});assert.equal(sixth.retention.removed.length,2);assert.equal(sixth.retention.retained,1);assert.equal(await readFile(join(second.backup,'mote.sqlite'),'utf8'),'GENERATED_CORRUPTION');await assertStopped(p);
 assert.match((await schedule(p,'configure',['--keep-count','0'],{fail:true})).stderr,/integer >= 1/);
});

test('SCHEDULE: restore-check rejects corrupt input and FK-invalid copied data without starting Central', {timeout:120000},async t=>{
 const {p}=await fixture(t);await schedule(p,'configure',['--enable']);const {backup}=json(await schedule(p,'run-due'));
 const broken=join(p.directory,'backups','generated-invalid');await cp(backup,broken,{recursive:true});await writeFile(join(broken,'mote.sqlite'),'generated bad bytes');
 assert.match((await schedule(p,'restore-check',['--from',broken],{fail:true})).stderr,/checksum mismatch/);await assertStopped(p);
 await rm(broken,{recursive:true});await cp(backup,broken,{recursive:true});const db=new DatabaseSync(join(broken,'mote.sqlite'));try{db.exec('PRAGMA foreign_keys=OFF;CREATE TABLE generated_parent(id PRIMARY KEY);CREATE TABLE generated_child(id REFERENCES generated_parent(id));INSERT INTO generated_child VALUES(1)');}finally{db.close();}
 const manifest=JSON.parse(await readFile(join(broken,'backup-manifest.json'),'utf8'));manifest.checksums['mote.sqlite']=sha(await readFile(join(broken,'mote.sqlite')));await writeFile(join(broken,'backup-manifest.json'),JSON.stringify(manifest));
 assert.match((await schedule(p,'restore-check',['--from',broken],{fail:true})).stderr,/integrity or foreign-key/);await assertStopped(p);assert.equal((await readdir(p.directory)).some(n=>n.startsWith('.restore-check-')),false);
});

test('SCHEDULE: explicit disabled foreground watch exits safely; unsafe directories and original key permissions fail closed', {timeout:120000},async t=>{
 let {p,root}=await fixture(t);await schedule(p,'configure',['--interval-hours','12']);assert.equal(json(await schedule(p,'status')).policy.enabled,false);
 const watch=spawn(process.execPath,[join(repository,'scripts/mote.mjs'),'backup-schedule','watch','--home',p.home,'--profile',p.profile,'--poll-seconds','1'],{stdio:['ignore','pipe','pipe']});t.after(()=>watch.kill('SIGKILL'));
 await awaitLine(watch,'disabled');const exit=new Promise(done=>watch.once('exit',done));watch.kill('SIGINT');assert.equal(await exit,0);await assertStopped(p);
 const outside=join(root,'generated-outside');await mkdir(outside);const scheduled=join(p.directory,'backups/scheduled');await symlink(outside,scheduled);const before=await readFile(p.metaFile,'utf8');
 assert.match((await schedule(p,'configure',['--enable'],{fail:true})).stderr,/links or aliases/);assert.equal(await readFile(p.metaFile,'utf8'),before);assert.deepEqual(await readdir(outside),[]);await rm(scheduled);
 const originalKey=p.env.MOTE_DATA_KEY;await writeFile(join(p.dataDir,'content-key'),originalKey,{mode:0o644});p=await updateEnvironment(p,{MOTE_DATA_KEY:''});await schedule(p,'configure',['--enable']);
 await chmod(join(p.dataDir,'content-key'),0o644);
 assert.match((await schedule(p,'run-due',[],{fail:true})).stderr,/private owned regular file/);await assertStopped(p);assert.ok((await state(p)).backupSchedule.pending);
 await chmod(join(p.dataDir,'content-key'),0o600);const recovered=json(await schedule(p,'run-due'));assert.equal(recovered.originalRunning,false);await assertStopped(p);
 assert.match((await schedule(p,'watch',['--poll-seconds','9007199254740991'],{fail:true})).stderr,/timer range/);
});
