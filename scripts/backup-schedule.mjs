import {lstat,mkdir,readdir,readFile,realpath,rm,mkdtemp,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,resolve,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as sleep} from 'node:timers/promises';
import {loadProfile,withProfileLock,atomicJson,assertDeploymentCompatible,nativeIdentity,execute,dockerContainer,backupProfile,verifiedBackup,prepareBackupRestore,profileContentKey,health} from './profile-lib.mjs';
import {startProfile,stopProfile} from './update-deploy.mjs';

const hour=3600000,day=24*hour,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,hash=/^[a-f0-9]{64}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
const integer=(value,min,label)=>{if(!Number.isSafeInteger(value)||value<min)throw Error(label+' must be an integer >= '+min);return value;};
const stamp=value=>{const n=Date.parse(value);if(!Number.isSafeInteger(n)||new Date(n).toISOString()!==value)throw Error('Invalid schedule timestamp');return n;};
const now=clock=>{const value=clock();stamp(value.toISOString());return value;};
const slotFor=(generation,dueAt)=>digest(JSON.stringify([generation,dueAt]));
const nameFor=id=>'scheduled-'+id;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
async function sum(path){const h=createHash('sha256');for await(const part of createReadStream(path))h.update(part);return h.digest('hex');}
async function ordinaryFile(path){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||await realpath(path)!==path)throw Error('Scheduled backup files cannot be links or special files');return info;}
async function ordinaryDirectory(path){const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path)throw Error('Scheduled backup directories cannot be links or aliases');return info;}
async function roots(p,{create=false}={}){
 const profile=await realpath(p.directory);if((await lstat(p.directory)).isSymbolicLink())throw Error('Profile directory cannot be a link');
 const backups=join(profile,'backups'),scheduled=join(backups,'scheduled');
 for(const path of [backups,scheduled]){
  if(create)try{await mkdir(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  try{await ordinaryDirectory(path);}catch(error){if(!create&&error.code==='ENOENT')return {profile};throw error;}
 }
 return {profile,scheduled};
}
function validateRecord(value){
 if(!value||!uuid.test(value.id)||value.name!==nameFor(value.id)||!uuid.test(value.generation)||!hash.test(value.slot)||!hash.test(value.receiptSha256))throw Error('Invalid completed scheduled backup identity');
 stamp(value.completedAt);stamp(value.dueAt);if(slotFor(value.generation,value.dueAt)!==value.slot)throw Error('Invalid scheduled backup slot');
}
export function backupSchedulePolicy(p){
 const value=p.meta.backupSchedule;
 if(value===undefined)return {version:1,enabled:false,intervalHours:24,keepCount:7,keepDays:30,completed:[]};
 if(!value||value.version!==1||typeof value.enabled!=='boolean'||!uuid.test(value.generation)||!Array.isArray(value.completed))throw Error('Invalid backup schedule policy');
 integer(value.intervalHours,1,'Backup interval hours');integer(value.keepCount,1,'Retained backup count');integer(value.keepDays,0,'Retention days');
 if(!Number.isSafeInteger(value.intervalHours*hour)||!Number.isSafeInteger(value.keepDays*day))throw Error('Backup schedule interval is too large');
 stamp(value.nextAt);
 if(!Number.isFinite(new Date(stamp(value.nextAt)+value.intervalHours*hour).getTime()))throw Error('Backup interval exceeds the supported date range');
 value.completed.forEach(validateRecord);
 if(new Set(value.completed.map(v=>v.slot)).size!==value.completed.length)throw Error('Duplicate completed backup slot');
 if(value.pending){
  const run=value.pending;if(!uuid.test(run.id)||!uuid.test(run.generation)||!hash.test(run.slot)||slotFor(run.generation,run.dueAt)!==run.slot||!hash.test(run.storage)||typeof run.intent?.running!=='boolean'||!['native','docker'].includes(run.intent.runtime))throw Error('Invalid pending scheduled backup intent');
  stamp(run.dueAt);stamp(run.startedAt);
  if(run.intent.runtime==='native'?!isAbsolute(run.intent.release??''):!/^sha256:[a-f0-9]{64}$/.test(run.intent.image??''))throw Error('Invalid original deployment identity');
  if(run.attempt&&!uuid.test(run.attempt))throw Error('Invalid backup attempt identity');
 }
 return structuredClone(value);
}
async function persist(p,policy){
 p.meta={...p.meta,backupSchedule:policy};await atomicJson(p.metaFile,p.meta);
 const directory=await open(await realpath(p.directory),'r');try{await directory.sync();}finally{await directory.close();}
}
export async function configureBackupSchedule(paths,changes,{clock=()=>new Date()}={}){
 return withProfileLock(paths,async()=>{
  const p=await loadProfile(paths),prior=backupSchedulePolicy(p);
  if(prior.pending)throw Error('A scheduled backup still owns a recovery intent; run backup-schedule run-due before configuring');
  if(Object.keys(changes).some(k=>!['enabled','intervalHours','keepCount','keepDays'].includes(k)))throw Error('Unknown backup policy setting');
  const policy={...prior,...changes,generation:randomUUID(),nextAt:now(clock).toISOString()};backupSchedulePolicy({...p,meta:{...p.meta,backupSchedule:policy}});
  await roots(p);await persist(p,policy);return {policy,runnerStarted:false,servicesInstalled:false};
 });
}
const storageIdentity=p=>digest(JSON.stringify([p.project,p.meta.runtime,p.meta.runtime==='docker'?p.meta.volume:resolve(p.dataDir),resolve(p.configFile)]));
async function intent(p){
 if(p.meta.runtime==='native'){
  const state=await nativeIdentity(p);if(state.running&&!state.managed)throw Error('The recorded process is not managed; no backup stop was attempted');
  return {runtime:'native',running:state.running,release:resolve(state.running?state.record.release:p.meta.release)};
 }
 const id=await dockerContainer(p),running=await execute('docker',['inspect','--format','{{.State.Running}}',id],{capture:true})==='true';
 const image=await execute('docker',['inspect','--format','{{.Image}}',id],{capture:true});return {runtime:'docker',running,image};
}
const deployment=(p,original)=>({...p,meta:{...p.meta,...(original.runtime==='docker'?{image:original.image}:{release:original.release})}});
async function currentIntent(p,run){
 if(storageIdentity(p)!==run.storage||p.meta.runtime!==run.intent.runtime)throw Error('Profile storage changed while a scheduled backup recovery was pending');
 const current=await intent(p);
 if(current.running&&(!run.intent.running||(current.runtime==='docker'?current.image!==run.intent.image:current.release!==run.intent.release)))throw Error('Another deployment is running; the saved backup intent was preserved');
 return current;
}
async function restoreIntent(p,run){
 const current=await currentIntent(p,run);if(!run.intent.running)return;
 const original=deployment(p,run.intent);
 if(current.running&&await health(original))return;
 if(current.running)await stopProfile(original);
 await startProfile(original);
 if(!await health(original))throw Error('The original deployment did not become healthy; its recovery intent was preserved');
}
async function assertNoOrphanCopy(p,run){
 if(process.env.MOTE_DEPLOY_DOCKER_CLI==='1')return; // A live CLI container still owns the existing lifecycle lock.
 const processes=await execute('ps',['-eo','args='],{capture:true});
 if(new RegExp('(?:^|\\s)--mote-backup-instance='+run.id+'(?:\\s|$)','m').test(processes))throw Error('The previous backup copy is still running; retry after it exits. Original running intent remains saved');
}
function owner(p,run,id){return {kind:'mote.scheduled-backup',version:1,project:p.project,job:run.id,id,generation:run.generation,slot:run.slot,dueAt:run.dueAt};}
async function attemptRoot(p,run,root){
 if(run.attempt){
  const directory=join(root,nameFor(run.attempt));await ordinaryDirectory(directory);await ordinaryFile(join(directory,'owner.json'));
  if(!same(await readJsonFile(join(directory,'owner.json')),owner(p,run,run.attempt)))throw Error('Pending backup ownership changed; no artifact was removed');
  return directory;
 }
}
async function readJsonFile(path){return JSON.parse(await readFile(path,'utf8'));}
function databaseIntegrity(directory){
 const db=new DatabaseSync(join(directory,'mote.sqlite'),{readOnly:true});
 try{const rows=db.prepare('PRAGMA integrity_check').all();if(rows.length!==1||Object.values(rows[0])[0]!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Backup database integrity or foreign-key check failed');}finally{db.close();}
}
async function artifactTree(directory,checked,{receipt=true}={}){
 const files=new Set(['owner.json',...(receipt?['receipt.json']:[]),'snapshot/backup-manifest.json',...checked.names.map(name=>'snapshot/'+name)]),directories=new Set(['snapshot']);
 for(const file of files){const parts=file.split('/');parts.pop();while(parts.length){directories.add(parts.join('/'));parts.pop();}}
 async function walk(path,prefix=''){
  for(const name of await readdir(path)){
   const relative=prefix+name,child=join(path,name),entry=await lstat(child);
   if(entry.isSymbolicLink())throw Error('Scheduled backup contains a link; it was preserved');
   if(entry.isDirectory()&&directories.has(relative)){await ordinaryDirectory(child);await walk(child,relative+'/');}
   else if(entry.isFile()&&files.has(relative))await ordinaryFile(child);
   else throw Error('Scheduled backup contains unmanaged input; it was preserved');
  }
 }
 await walk(directory);
}
async function newAttempt(p,policy,run,root){
 const id=randomUUID(),directory=join(root,nameFor(id));await mkdir(directory,{mode:0o700});await atomicJson(join(directory,'owner.json'),owner(p,run,id));
 run.attempt=id;await persist(p,policy);return directory;
}
async function completedArtifact(p,root,record,dataKey){
 validateRecord(record);await ordinaryDirectory(root);const directory=join(root,record.name),identity=await ordinaryDirectory(directory);
 for(const name of ['owner.json','receipt.json'])await ordinaryFile(join(directory,name));
 const receipt=await readJsonFile(join(directory,'receipt.json')),owned=await readJsonFile(join(directory,'owner.json'));
 if(await sum(join(directory,'receipt.json'))!==record.receiptSha256||!same(receipt.owner,owned)||owned.kind!=='mote.scheduled-backup'||owned.version!==1||!uuid.test(owned.job)||owned.project!==p.project||owned.id!==record.id||owned.generation!==record.generation||owned.slot!==record.slot||owned.dueAt!==record.dueAt||receipt.completedAt!==record.completedAt||!hash.test(receipt.manifestSha256))throw Error('Scheduled backup receipt identity changed');
 const snapshot=join(directory,'snapshot');await ordinaryDirectory(snapshot);await ordinaryFile(join(snapshot,'backup-manifest.json'));
 if(await sum(join(snapshot,'backup-manifest.json'))!==receipt.manifestSha256)throw Error('Scheduled backup manifest identity changed');
 const checked=await verifiedBackup(snapshot,{dataKey});databaseIntegrity(snapshot);await artifactTree(directory,checked);return {directory,snapshot,identity,record};
}
async function registerCompletion(p,policy,run,directory,dataKey,clock){
 const existing=policy.completed.find(v=>v.slot===run.slot);
 if(existing)return completedArtifact(p,join(directory,'..'),existing,dataKey);
 const snapshot=join(directory,'snapshot');await ordinaryDirectory(snapshot);const checked=await verifiedBackup(snapshot,{dataKey});databaseIntegrity(snapshot);
 let hasReceipt=false;try{await lstat(join(directory,'receipt.json'));hasReceipt=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 await artifactTree(directory,checked,{receipt:hasReceipt});
 const receipt={owner:owner(p,run,run.attempt),completedAt:now(clock).toISOString(),manifestSha256:await sum(join(snapshot,'backup-manifest.json'))};
 const path=join(directory,'receipt.json');
 try{await ordinaryFile(path);const saved=await readJsonFile(path);if(!same(saved.owner,receipt.owner)||saved.manifestSha256!==receipt.manifestSha256)throw Error('Completed backup receipt changed');receipt.completedAt=saved.completedAt;stamp(receipt.completedAt);}
 catch(error){if(error.code!=='ENOENT')throw error;await atomicJson(path,receipt);}
 const record={id:run.attempt,name:nameFor(run.attempt),generation:run.generation,slot:run.slot,dueAt:run.dueAt,completedAt:receipt.completedAt,receiptSha256:await sum(path)};
 policy.completed.push(record);await persist(p,policy);return completedArtifact(p,join(directory,'..'),record,dataKey);
}
async function retention(p,policy,root,dataKey,clock){
 const valid=[],skipped=[],removed=[];
 for(const record of policy.completed)try{valid.push(await completedArtifact(p,root,record,dataKey));}catch{skipped.push(record.name);}
 valid.sort((a,b)=>stamp(b.record.completedAt)-stamp(a.record.completedAt)||b.record.name.localeCompare(a.record.name));
 const latest=valid[0],threshold=now(clock).getTime()-policy.keepDays*day;
 for(const candidate of valid.slice(policy.keepCount)){
  if(stamp(candidate.record.completedAt)>=threshold)continue;
  // Revalidate both the survivor and exact candidate immediately before unlink.
  await completedArtifact(p,root,candidate.record,dataKey);const survivor=await completedArtifact(p,root,latest.record,dataKey);await ordinaryDirectory(root);
  const present=await ordinaryDirectory(candidate.directory);if(present.dev!==candidate.identity.dev||present.ino!==candidate.identity.ino)throw Error('Retention candidate changed; no deletion was attempted');
  const retained=await ordinaryDirectory(survivor.directory);if(retained.dev!==survivor.identity.dev||retained.ino!==survivor.identity.ino)throw Error('The retained backup changed; no deletion was attempted');
  await rm(candidate.directory,{recursive:true});policy.completed=policy.completed.filter(r=>r.id!==candidate.record.id);await persist(p,policy);removed.push(candidate.record.name);
 }
 return {removed,skipped,retained:valid.length-removed.length};
}
export async function runDueBackup(paths,{clock=()=>new Date(),signal,onStage=()=>{}}={}){
 return withProfileLock(paths,async()=>{
  const p=await loadProfile(paths),policy=backupSchedulePolicy(p);let run=policy.pending;
  if(!run){
   if(!policy.enabled)return {due:false,reason:'disabled'};
   if(now(clock).getTime()<stamp(policy.nextAt))return {due:false,nextAt:policy.nextAt};
   if(signal?.aborted)return {due:false,reason:'interrupted'};
   const original=await intent(p);await assertDeploymentCompatible(deployment(p,original));
   run={id:randomUUID(),generation:policy.generation,dueAt:policy.nextAt,slot:slotFor(policy.generation,policy.nextAt),startedAt:now(clock).toISOString(),storage:storageIdentity(p),intent:original};
   policy.pending=run;await persist(p,policy);
  }
  await assertNoOrphanCopy(p,run);await currentIntent(p,run);await assertDeploymentCompatible(deployment(p,run.intent));
  const {scheduled:root}=await roots(p,{create:true});let artifact,error,reused=false;
  try{
   const dataKey=await profileContentKey(p),completed=policy.completed.find(v=>v.slot===run.slot);
   if(completed){artifact=await completedArtifact(p,root,completed,dataKey);reused=true;}
   else{
    let directory=await attemptRoot(p,run,root),valid=false;
    if(directory)try{
     const checked=await verifiedBackup(join(directory,'snapshot'),{dataKey});databaseIntegrity(join(directory,'snapshot'));
     let receipt=false;try{await lstat(join(directory,'receipt.json'));receipt=true;}catch(error){if(error.code!=='ENOENT')throw error;}
     await artifactTree(directory,checked,{receipt});
     if(receipt){const saved=await readJsonFile(join(directory,'receipt.json'));stamp(saved.completedAt);if(!same(saved.owner,owner(p,run,run.attempt))||saved.manifestSha256!==await sum(join(directory,'snapshot','backup-manifest.json')))throw Error('Pending backup receipt changed');}
     valid=true;
    }catch{}
    if(!valid){
     await onStage({phase:'stopping',job:run.id});if(signal?.aborted)throw Error('Scheduled backup interrupted; original running intent was preserved');
     if((await currentIntent(p,run)).running)await stopProfile(deployment(p,run.intent));
     if(signal?.aborted)throw Error('Scheduled backup interrupted before copying');
     directory=await newAttempt(p,policy,run,root);await onStage({phase:'copying',job:run.id});
     await backupProfile(deployment(p,run.intent),join(directory,'snapshot'),{instance:run.id});
    }else reused=true;
    artifact=await registerCompletion(p,policy,run,directory,dataKey,clock);
   }
   await onStage({phase:'verified',job:run.id});
  }catch(failure){error=failure;}
  finally{try{await onStage({phase:'restoring',job:run.id});await restoreIntent(p,run);}catch(failure){error=error?new AggregateError([error,failure],'Backup failed and the original deployment could not be restored; run-due will retry its saved intent'):failure;}}
  if(error)throw error;
  const kept=await retention(p,policy,root,await profileContentKey(p),clock);
  const completedAt=now(clock).getTime();policy.nextAt=new Date(completedAt+policy.intervalHours*hour).toISOString();delete policy.pending;
  await persist(p,policy);
  return {due:true,backup:artifact.snapshot,reused,nextAt:policy.nextAt,originalRunning:run.intent.running,retention:kept};
 });
}
export async function checkBackupRestore(paths,{from}={}){
 return withProfileLock(paths,async()=>{
  const p=await loadProfile(paths),policy=backupSchedulePolicy(p),dataKey=await profileContentKey(p);
  // A deleted/still-uncreated Docker service is not needed for an offline
  // restore rehearsal. Existing services still pin their actual image.
  const containers=p.meta.runtime==='docker'?(await execute('docker',['ps','--all','--quiet','--no-trunc','--filter','label=com.docker.compose.project='+p.project,'--filter','label=com.docker.compose.service=mote'],{capture:true})).split(/\s+/).filter(Boolean):undefined;
  if(containers&&containers.length>1)throw Error('Cannot identify one profile deployment');
  await assertDeploymentCompatible(containers?.length===0?p:deployment(p,await intent(p)));
  let source=from;
  if(!source){
   const {scheduled}=await roots(p);const valid=[];
   if(scheduled)for(const record of policy.completed)try{valid.push(await completedArtifact(p,scheduled,record,dataKey));}catch{}
   valid.sort((a,b)=>stamp(b.record.completedAt)-stamp(a.record.completedAt));source=valid[0]?.snapshot;
   if(!source)throw Error('No verified completed scheduled backup is available');
  }
  const {profile}=await roots(p),temporary=await mkdtemp(join(profile,'.restore-check-'));
  try{
   const {stage,checked}=await prepareBackupRestore(source,temporary,{dataKey});
   // The shared copy already verifies every selected byte. Reuse the formal
   // verifier on that copied producer output, including sealed APP integrity.
   await atomicJson(join(stage,'backup-manifest.json'),await readJsonFile(join(checked.directory,'backup-manifest.json')));
   await verifiedBackup(stage,{dataKey});
   databaseIntegrity(stage);
   return {verified:true,backup:checked.directory,files:checked.names.length,checksumsSha256:digest(JSON.stringify(Object.entries(checked.checksums).sort())),database:'ok',temporaryRemoved:true,processesStarted:0};
  }finally{await rm(temporary,{recursive:true,force:true});}
 });
}
export async function watchBackupSchedule(paths,{signal,pollSeconds=30,onResult=()=>{},...options}={}){
 integer(pollSeconds,1,'Poll seconds');
 if(!Number.isSafeInteger(pollSeconds*1000)||pollSeconds*1000>2147483647)throw Error('Poll seconds exceed the supported timer range');
 while(!signal?.aborted){try{onResult(await runDueBackup(paths,{...options,signal}));}catch(error){onResult({error:error.message});}
  try{await sleep(pollSeconds*1000,undefined,{signal});}catch(error){if(error.name==='AbortError')return;throw error;}
 }
}
export async function runBackupSchedule(paths,action,values,print){
 if(!['configure','status','run-due','watch','restore-check'].includes(action))throw Error('backup-schedule requires configure|status|run-due|watch|restore-check');
 const allowed=new Set(['profile','home',...(action==='configure'?['enable','disable','interval-hours','keep-count','keep-days']:action==='watch'?['poll-seconds']:action==='restore-check'?['from']:[])]);
 if(Object.keys(values).some(key=>!allowed.has(key)))throw Error('Unsupported option for backup-schedule '+action);
 if(action==='status'){print({profile:paths.profile,policy:backupSchedulePolicy(await loadProfile(paths))});return;}
 if(action==='configure'){
  if(values.enable&&values.disable)throw Error('Choose --enable or --disable');
  const changes={};if(values.enable||values.disable)changes.enabled=Boolean(values.enable);
  for(const [key,flag]of [['intervalHours','interval-hours'],['keepCount','keep-count'],['keepDays','keep-days']])if(values[flag]!==undefined)changes[key]=Number(values[flag]);
  if(!Object.keys(changes).length)throw Error('Configure needs --enable|--disable or an explicit policy value');print(await configureBackupSchedule(paths,changes));return;
 }
 if(action==='restore-check'){print(await checkBackupRestore(paths,{from:values.from}));return;}
 const controller=new AbortController(),abort=()=>controller.abort();process.once('SIGINT',abort);process.once('SIGTERM',abort);
 try{
  const onStage=stage=>print({profile:paths.profile,...stage});
  if(action==='run-due')print(await runDueBackup(paths,{signal:controller.signal,onStage}));
  else await watchBackupSchedule(paths,{signal:controller.signal,pollSeconds:values['poll-seconds']===undefined?30:Number(values['poll-seconds']),onResult:print,onStage});
 }finally{process.off('SIGINT',abort);process.off('SIGTERM',abort);}
}
