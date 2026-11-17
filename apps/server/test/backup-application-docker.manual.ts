// Explicit Docker-only check; excluded from the default *.test.ts suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdir,readFile,realpath,rm,writeFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {serializeConfigDocument,readConfigDocument} from '@mote/shared/config-file';
import {applicationFixture} from './fixtures/backup-application.js';
import {cli,command,freePort,note,request} from '../../../scripts/profile-fixtures.mjs';
import {loadProfile,profilePaths,repository,profileContentKey} from '../../../scripts/profile-lib.mjs';

const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
test('Docker-only CLI carries a real sealed APP archive through stopped volume backup, empty restore and owner HTTP bytes',{timeout:120000},async t=>{
 const core=process.env.MOTE_BACKUP_TEST_CORE_IMAGE,tooling=process.env.MOTE_BACKUP_TEST_CLI_IMAGE;assert.ok(core&&tooling,'Explicit prebuilt core and current deploy-cli images are required');
 const f=await applicationFixture(t);assert.equal((await f.interact('GENERATED-DOCKER-BACKUP-APP')).status,'completed');
 const original=Buffer.from('Generated Docker original bytes \u{1f9ea}'),sourceId='generated.backup-binary';
 assert.equal((await f.api({method:'POST',url:'/api/sources',headers:f.headers,payload:{id:sourceId,name:'Generated Docker backup original',kind:'local-files',deviceId:'generated-backup-device',platform:'macos',retention:'archive'}})).statusCode,200);
 const begun=await f.node.app.inject({method:'POST',url:'/api/file-sync/v1/uploads',headers:{...f.headers,'x-mote-ingress-version':'2'},payload:{sourceId,previousRevision:null,relativePath:'generated.bin',sizeBytes:original.length,sha256:digest(original),item:{externalId:'generated-backup-original',revision:'1',observedAt:new Date().toISOString(),title:'Generated original',kind:'file',layer:'original',text:'',mimeType:'application/octet-stream'}}});assert.equal(begun.statusCode,200,begun.body);
 const upload=begun.json().uploadId;
 assert.equal((await f.node.app.inject({method:'PUT',url:'/api/file-sync/v1/uploads/'+upload+'/parts/0',headers:{...f.headers,'x-mote-ingress-version':'2','content-type':'application/octet-stream'},payload:original})).statusCode,200);
 const committed=await f.node.app.inject({method:'POST',url:'/api/file-sync/v1/uploads/'+upload+'/commit',headers:{...f.headers,'x-mote-ingress-version':'2'},payload:{}});assert.equal(committed.statusCode,200,committed.body);const fileId=committed.json().id;
 const saved=note();assert.equal((await f.api({method:'POST',url:'/api/notes',headers:f.headers,payload:saved})).statusCode,201);
 const controls=f.controlRows().map(row=>({...row}));await f.node.app.close();const native=await loadProfile(f.paths),snapshot=join(f.root,'native-snapshot');await cli(native.home,native.profile,'backup',['--out',snapshot]);
 const home=join(await realpath(f.root),'docker-home');await mkdir(home,{mode:0o700});const staged=join(home,'native-snapshot');await cp(snapshot,staged,{recursive:true});
 const binaryPath=join(f.root,'docker-only-bin');await mkdir(binaryPath,{mode:0o700});
 const docker=await command('/usr/bin/which',['docker']);assert.equal(docker.code,0,docker.stderr);
 const {symlink}=await import('node:fs/promises');await symlink(docker.stdout.trim(),join(binaryPath,'docker'));
 for(const name of ['dirname','id','uname','stat','mkdir']){const selected=await command('/usr/bin/which',[name]);assert.equal(selected.code,0,selected.stderr);await symlink(selected.stdout.trim(),join(binaryPath,name));}
 const env={MOTE_DEPLOY_CLI_IMAGE:tooling,PATH:binaryPath,LC_ALL:'C'};
 const dc=async(profile:string,action:string,args:string[]=[])=>{const result=await command('/bin/sh',[join(repository,'scripts/mote-docker'),action,'--profile',profile,'--home',home,...args],{env,timeoutMs:60000});assert.equal(result.code,0,action+': '+result.stderr);return result;};
 const owned:Array<{profile:string;volume:string;project:string}>=[];
 f.addCleanup(async()=>{for(const p of owned.reverse()){await dc(p.profile,'compose',['--','down','--volumes','--remove-orphans']);const check=await command('docker',['volume','inspect',p.volume]);assert.notEqual(check.code,0,'only the generated named volume is removed');}});
 for(const profile of ['o3-backup-a','o3-backup-b']){
  await dc(profile,'init',['--runtime','docker','--image',core!,'--port',String(await freePort())]);let p=await loadProfile(profilePaths(profile,home));owned.push({profile,volume:p.meta.volume,project:p.project});
  const document=readConfigDocument(p.configFile).savedDocument;document.storage.dataKey=native.env.MOTE_DATA_KEY;document.diagnostics.level='silent';await writeFile(p.configFile,serializeConfigDocument(document),{mode:0o600});p=await loadProfile(profilePaths(profile,home));
  await dc(profile,'restore',['--from',profile.endsWith('a')?staged:join(home,'docker-snapshot')]);await dc(profile,'start');
  assert.deepEqual(await request(p,'/api/files/'+fileId+'/content',{binary:true}),original);assert.equal((await request(p,'/api/notes/'+saved.id)).ocrText,saved.text);
  const materials=await request(p,'/api/library/catalog');assert.ok(JSON.stringify(materials).includes('report.txt')||JSON.stringify(materials).includes('Generated application'));
  assert.equal(f.requests.length,1,'ordinary Docker startup does not replay a prior APP interaction');await dc(profile,'stop');
  if(profile.endsWith('a')){
   // A separately retained local key is not part of the backup format.
   const keyFile=join(home,'separate-original-key');await writeFile(keyFile,native.env.MOTE_DATA_KEY+'\n',{mode:0o600});await chmod(keyFile,0o600);
   const id=await command('docker',['ps','-aq','--no-trunc','--filter','label=com.docker.compose.project='+p.project,'--filter','label=com.docker.compose.service=mote']);assert.equal(id.code,0,id.stderr);assert.match(id.stdout.trim(),/^[a-f0-9]{64}$/);
   const copy=await command('docker',['cp',keyFile,id.stdout.trim()+':/data/content-key']);assert.equal(copy.code,0,copy.stderr);
   document.storage.dataKey='';await writeFile(p.configFile,serializeConfigDocument(document));p=await loadProfile(profilePaths(profile,home));assert.equal(await profileContentKey(p),native.env.MOTE_DATA_KEY);
   await dc(profile,'backup',['--out',join(home,'docker-snapshot')]);const archive=JSON.parse(await readFile(join(home,'docker-snapshot/backup-manifest.json'),'utf8'));assert.equal(Object.hasOwn(archive.checksums,'content-key'),false);assert.ok(Object.keys(archive.checksums).some(path=>path.startsWith('native-applications/')&&path.endsWith('/manifest.aes')));
   const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(join(home,'docker-snapshot/mote.sqlite'),{readOnly:true});try{assert.deepEqual(db.prepare("SELECT key,json,revision FROM plugin_instance_state WHERE key LIKE 'dsh-app/%/control'").all().map(row=>({...row})),controls);}finally{db.close();}
   await rm(keyFile);
  }
 }
});
