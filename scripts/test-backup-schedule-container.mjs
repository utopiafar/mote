import assert from 'node:assert/strict';
import {parseArgs} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm,symlink,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {repository,profilePaths,loadProfile,atomicJson} from './profile-lib.mjs';
import {command,freePort,request,note} from './profile-fixtures.mjs';

const {values}=parseArgs({options:{image:{type:'string'},cli:{type:'string'},evidence:{type:'string'}}});assert.ok(values.image&&values.cli,'Supply already built --image and --cli; no implicit builds or pulls');
const selected={};for(const kind of ['image','cli']){const result=await command('docker',['image','inspect','--format','{{.Id}}',values[kind]]);assert.equal(result.code,0,'Select an existing '+kind+' image');selected[kind]=result.stdout.trim();}
values.image=selected.image;values.cli=selected.cli;
const root=await mkdtemp(join(tmpdir(),'mote-schedule-docker-')),home=join(root,'generated profiles'),profile='sched'+randomUUID().slice(0,8),paths=profilePaths(profile,home),holder='mote-schedule-holder-'+randomUUID();let p;
const docker=async(args)=>{const r=await command('docker',args,{timeoutMs:120000});assert.equal(r.code,0,r.stderr);return r.stdout.trim();};
async function inventory(){
 const ids=(await docker(['ps','--all','--quiet','--no-trunc'])).split('\n').filter(Boolean),containers=ids.length?JSON.parse(await docker(['inspect',...ids])).map(v=>({id:v.Id,name:v.Name,running:v.State.Running,startedAt:v.State.StartedAt,finishedAt:v.State.FinishedAt})).sort((a,b)=>a.id.localeCompare(b.id)):[];
 const volumes=(await docker(['volume','ls','--format','{{.Name}}'])).split('\n').filter(Boolean).sort(),networks=(await docker(['network','ls','--no-trunc','--format','{{.ID}} {{.Name}}'])).split('\n').filter(Boolean).sort();
 const aliases=(await docker(['image','ls','--no-trunc','--format','{{.Repository}}:{{.Tag}} {{.ID}}'])).split('\n').filter(Boolean).sort();return {containers,volumes,networks,aliases};
}
const before=await inventory(),evidence={before,core:selected.image,cli:selected.cli,steps:[],scriptHashes:{}};
const json=result=>JSON.parse(result.stdout.trim().split('\n').at(-1));
let cleanupFailure,testFailure;
try{
 const files=['scripts/backup-schedule.mjs','scripts/profile-lib.mjs','scripts/backup.ts','scripts/native-application-backup.mjs','scripts/plugin-memory-backup.mjs','scripts/update-deploy.mjs','scripts/mote.mjs','scripts/mote-options.mjs','scripts/docker-cli-entry.mjs'];
 const probe=`const fs=require('node:fs'),crypto=require('node:crypto');console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(files)}.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex')]))));`;
 const actual=JSON.parse(await docker(['run','--rm','--network','none','--entrypoint','node',values.cli,'-e',probe]));
 for(const file of files){const expected=createHash('sha256').update(await readFile(join(repository,file))).digest('hex');assert.equal(actual[file],expected,file+' must be the current source inside the actual CLI image');evidence.scriptHashes[file]=expected;}
 const bin=join(root,'host-bin');await mkdir(bin);for(const name of ['docker','id','stat','uname','mkdir','dirname']){const found=await command('/bin/sh',['-c','command -v "$1"','fixture',name]);assert.equal(found.code,0);await symlink(found.stdout.trim(),join(bin,name));}
 const context=await docker(['context','show']),env={PATH:bin,LC_ALL:'C',DOCKER_CONTEXT:context,MOTE_DEPLOY_CLI_IMAGE:values.cli};
 const run=async(action,args=[],fail=false)=>{const r=await command(join(repository,'scripts/mote-docker'),[action,'--profile',profile,'--home',home,...args],{env,timeoutMs:120000});if(fail)assert.notEqual(r.code,0);else assert.equal(r.code,0,r.stderr);return r;};
 const schedule=(action,args=[],fail=false)=>run('backup-schedule',[action,...args],fail);
 assert.notEqual((await command('/bin/sh',['-c','command -v node || command -v npm'],{env:{PATH:bin}})).code,0);
 await run('init',['--port',String(await freePort()),'--image',values.image]);p=await loadProfile(paths);
 assert.equal(json(await schedule('status')).policy.enabled,false);assert.equal(json(await schedule('run-due')).reason,'disabled');
 await run('start');const saved=note();await request(p,'/api/notes',{method:'POST',body:saved,status:201});
 const id=async()=>await docker(['ps','--all','--quiet','--no-trunc','--filter','label=com.docker.compose.project='+p.project,'--filter','label=com.docker.compose.service=mote']);
 const originalImage=await docker(['inspect','--format','{{.Image}}',await id()]);assert.equal(originalImage,evidence.core);
 // Select an incompatible tooling image without changing the actual container.
 // A backup must restart the actual original rather than apply that selection.
 await atomicJson(p.metaFile,{...p.meta,image:values.cli});await schedule('configure',['--enable','--keep-count','2','--keep-days','0']);
 const first=json(await schedule('run-due'));assert.equal(first.originalRunning,true);assert.equal(await docker(['inspect','--format','{{.Image}}',await id()]),originalImage);
 assert.equal((await loadProfile(paths)).meta.image,values.cli);assert.equal((await request(p,'/api/notes/'+saved.id)).ocrText,saved.text);
 const checked=json(await schedule('restore-check'));assert.equal(checked.verified,true);assert.equal(checked.database,'ok');assert.equal(checked.processesStarted,0);assert.equal(checked.temporaryRemoved,true);
 assert.equal(json(await schedule('run-due')).due,false);evidence.steps.push('Host without Node → actual new CLI: configure/run-due, original actual image retained, exact note, isolated verified restore');
 await run('stop');await schedule('configure',['--enable']);const stopped=json(await schedule('run-due'));assert.equal(stopped.originalRunning,false);assert.equal(await docker(['inspect','--format','{{.State.Running}}',await id()]),'false');
 assert.equal((await readdir(p.directory)).some(n=>n.startsWith('.restore-check-')),false);evidence.steps.push('Originally stopped Docker profile remains stopped');
  await atomicJson(p.metaFile,{...(await loadProfile(paths)).meta,image:values.image});await docker(['rm',await id()]);
  const offline=json(await schedule('restore-check',['--from',first.backup]));assert.equal(offline.verified,true);assert.equal(offline.processesStarted,0);assert.equal(await id(),'');
  evidence.steps.push('Offline restore rehearsal also works without a Central service container and creates none');
 // The offline check kept the explicitly selected core image and stopped data.
 await run('start');await schedule('configure',['--enable']);
 const socket=JSON.parse(await docker(['context','inspect',context,'--format','{{json .Endpoints.docker.Host}}'])).replace(/^unix:\/\//,''),security=JSON.parse(await docker(['info','--format','{{json .SecurityOptions}}'])),user=security.includes('name=rootless')?'0:0':`${process.getuid()}:${process.getgid()}`;
 const script=`import{profilePaths}from'/app/scripts/profile-lib.mjs';import{runDueBackup}from'/app/scripts/backup-schedule.mjs';await runDueBackup(profilePaths(process.argv[1],process.argv[2]),{onStage:async e=>{if(e.phase==='copying'){console.log('GENERATED_DOCKER_COPY_HOLD');await new Promise(()=>{setInterval(()=>{},1000);});}}});`;
 await docker(['run','--detach','--name',holder,'--network','none','--user',user,'--group-add',String((await stat(socket)).gid),'--group-add','0','--mount',`type=bind,source=${socket},target=/var/run/docker.sock`,'--mount',`type=bind,source=${home},target=${home}`,'--env','DOCKER_HOST=unix:///var/run/docker.sock','--env','MOTE_DEPLOY_DOCKER_CLI=1','--entrypoint','node',values.cli,'--input-type=module','-e',script,profile,home]);
 const deadline=Date.now()+30000;let held=false;while(Date.now()<deadline){const logs=await docker(['logs',holder]);if(logs.includes('GENERATED_DOCKER_COPY_HOLD')){held=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(held,'Actual CLI container holds the persisted stopped intent');
 assert.match((await schedule('run-due',[],true)).stderr,/Another profile command/);await docker(['rm','--force',holder]);
 const resumed=json(await schedule('run-due'));assert.equal(resumed.due,true);assert.equal(resumed.originalRunning,true);assert.equal((await request(p,'/api/notes/'+saved.id)).ocrText,saved.text);
 const completed=(await loadProfile(paths)).meta.backupSchedule.completed;assert.equal(new Set(completed.map(v=>v.slot)).size,completed.length);assert.equal(json(await schedule('run-due')).due,false);evidence.steps.push('Live container lifecycle lock excludes contender; killed CLI resumes its saved intent once');
 console.log('Docker-only SCHEDULE small contract passed; current CLI scripts hash verified; reused core runtime, no new full core build or model.');
}catch(error){
 testFailure=error;evidence.failure={message:error.message,stack:error.stack};
}finally{
 const holderId=await docker(['ps','--all','--quiet','--filter','name=^/'+holder+'$']);if(holderId)await docker(['rm','--force',holder]);
 if(p){
  const down=await command(join(repository,'scripts/mote-docker'),['compose','--profile',profile,'--home',home,'--','down','--remove-orphans'],{env:{MOTE_DEPLOY_CLI_IMAGE:values.cli},timeoutMs:120000});if(down.code!==0)cleanupFailure=Error('Owned Compose cleanup failed');
  const remaining=(await docker(['ps','--all','--quiet','--filter','label=com.docker.compose.project='+p.project])).split('\n').filter(Boolean);if(remaining.length)await docker(['rm','--force',...remaining]);
  for(const volume of [p.meta.volume,p.meta.modelsVolume]){assert.ok(volume.startsWith(p.project+'-'));const exists=await docker(['volume','ls','--quiet','--filter','name=^'+volume+'$']);if(exists)await docker(['volume','rm',volume]);}
  const networks=(await docker(['network','ls','--quiet','--filter','label=com.docker.compose.project='+p.project])).split('\n').filter(Boolean);
  for(const network of networks){const [owned]=JSON.parse(await docker(['network','inspect',network]));assert.equal(owned.Labels['com.docker.compose.project'],p.project);assert.equal(Object.keys(owned.Containers).length,0);await docker(['network','rm',owned.Id]);}
 }
 await rm(root,{recursive:true,force:true});evidence.after=await inventory();evidence.cleanup='All generated profile/container/volume/network resources removed';if(values.evidence)await writeFile(values.evidence,JSON.stringify(evidence,null,2)+'\n');
 try{assert.deepEqual(evidence.after,before,'Preserve all preexisting containers, volumes, networks and image aliases');}catch(error){cleanupFailure=cleanupFailure?new AggregateError([cleanupFailure,error],'Cleanup checks failed'):error;}
}
if(testFailure||cleanupFailure)throw new AggregateError([testFailure,cleanupFailure].filter(Boolean),'Docker SCHEDULE contract or cleanup failed');
