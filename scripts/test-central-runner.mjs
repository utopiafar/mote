// Generated supervisor fixtures: bounded noisy output, real child exit/signal and disk failure.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,stat,rm,mkdir,open,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {command} from './profile-fixtures.mjs';
import {repository} from './profile-lib.mjs';
import {serializeConfigDocument} from '../packages/shared/src/config-file.ts';
const directory=await mkdtemp(join(tmpdir(),'mote-central-runner-fixture-')),runner=join(repository,'scripts/central-runner.mjs'),MiB=1024*1024;
const names=async folder=>(await readdir(folder)).filter(name=>/^supervisor\.(error|warn|info|debug|trace)\./.test(name));
const rows=async folder=>(await Promise.all((await names(folder)).map(name=>readFile(join(folder,name),'utf8')))).join('').trim().split('\n').filter(Boolean).map(JSON.parse).sort((a,b)=>a.seq-b.seq);
async function fixture(name,diagnostics={}){const folder=join(directory,name);await mkdir(folder);const config=join(folder,'mote.yaml');await writeFile(config,serializeConfigDocument({version:1,revision:0,diagnostics}),{mode:0o600});return {folder,env:{MOTE_CONFIG_FILE:config}};}
const launch=(entry,folder)=>[runner,entry,join(folder,'central.log'),`--mote-instance=${randomUUID()}`];
const wait=async(check,label)=>{const end=Date.now()+10000;while(!await check()){assert.ok(Date.now()<end,label);await new Promise(resolve=>setTimeout(resolve,20));}};
try{
 const noisy=join(directory,'noisy.mjs');await writeFile(noisy,"process.stdout.write('synthetic-private-body\\n'.repeat(60000));process.stderr.write('synthetic-private-token'.repeat(100000));");
 const f=await fixture('noise',{debug:true,maxBytes:Math.floor(.1*MiB),maxTotalBytes:2*MiB,retention:{debug:{days:2,maxBytes:Math.floor(.3*MiB)}}});
 for(let i=0;i<2;i++)assert.equal((await command(process.execPath,launch(noisy,f.folder),{env:f.env})).code,0);
 for(const name of await names(f.folder)){const path=join(f.folder,name),s=await stat(path);assert.ok(s.size<=Math.floor(.1*MiB));assert.equal(s.mode&0o777,0o600);assert.ok(!(await readFile(path,'utf8')).includes('synthetic-private'));}
 assert.ok((await names(f.folder)).some(name=>name.includes('.debug.')));assert.ok((await names(f.folder)).some(name=>name.includes('.info.')));
 const once=join(directory,'once.mjs');await writeFile(once,"console.log('{\"event\":\"server.listening\",\"port\":12345}');");
 const expanded=await fixture('expanded',{maxBytes:100*MiB,maxTotalBytes:512*MiB,retention:{info:{days:7,maxBytes:300*MiB}}}),at=Date.now();
 // Keep the original 300 MiB sparse boundary and all per-file/total assertions.
 for(let index=0;index<3;index++){const file=await open(join(expanded.folder,`supervisor.info.${at-index}.${at-index}.${randomUUID()}.ndjson`),'w',0o600);try{await file.truncate(100*MiB);}finally{await file.close();}}
 assert.equal((await command(process.execPath,launch(once,expanded.folder),{env:expanded.env})).code,0);
 const sizes=await Promise.all((await names(expanded.folder)).map(async name=>(await stat(join(expanded.folder,name))).size));assert.ok(sizes.every(size=>size<=100*MiB));assert.ok(sizes.reduce((a,b)=>a+b,0)<=300*MiB);
 const custom=await fixture('smaller',{maxBytes:2*MiB}),oldPath=join(custom.folder,`supervisor.info.${at}.${at}.${randomUUID()}.ndjson`),old=await open(oldPath,'w');await old.truncate(3*MiB);await old.close();
 assert.equal((await command(process.execPath,launch(once,custom.folder),{env:custom.env})).code,0);assert.equal((await stat(oldPath)).size,3*MiB,'a smaller segment size must never truncate old logs');
 const invalid=await fixture('invalid',{maxBytes:101*MiB});assert.notEqual((await command(process.execPath,launch(once,invalid.folder),{env:invalid.env})).code,0);
 const tail=join(directory,'tail.mjs');await writeFile(tail,`process.stdout.write('synthetic-private-body\\n');process.stdout.write('{"event":"server.');setTimeout(()=>{process.stdout.write('listening","port":12345,"tokenConfigured":true,"secret":"synthetic-private-token"}');process.exitCode=7;},10);`);
 const tailFixture=await fixture('tail',{debug:true});assert.equal((await command(process.execPath,launch(tail,tailFixture.folder),{env:tailFixture.env})).code,7);const events=await rows(tailFixture.folder);assert.ok(events.some(e=>e.event==='process.output_suppressed'&&e.bytes===22));assert.ok(events.some(e=>e.event==='server.listening'&&e.port===12345&&e.tokenConfigured));assert.ok(events.some(e=>e.event==='process.exited'&&e.exitCode===7&&e.level==='error'));assert.ok(!JSON.stringify(events).includes('synthetic-private'));
 const shutdown=join(directory,'shutdown.mjs');await writeFile(shutdown,`process.on('SIGTERM',()=>{process.stdout.write('{"event":"server.stopped","secret":"synthetic-private-token"}');process.exit(0);});console.log('{"event":"server.listening","port":12345}');setInterval(()=>console.log('{"event":"server.listening","port":12345}'),50);`);
 for(const failDisk of [false,true]){
  const s=await fixture(failDisk?'disk-failure':'shutdown');const child=spawn(process.execPath,launch(shutdown,s.folder),{cwd:repository,env:{...process.env,...s.env},stdio:'ignore'}),closed=new Promise(resolve=>child.once('close',resolve));
  try{await wait(async()=>{try{return (await rows(s.folder)).some(e=>e.event==='server.listening');}catch{return false;}},'Supervisor must flush while the child is active');
   if(failDisk){await rename(s.folder,s.folder+'-saved');await writeFile(s.folder,'Generated blocked log directory');}else child.kill('SIGTERM');
   const code=await Promise.race([closed,new Promise(resolve=>{const timer=setTimeout(()=>resolve('timeout'),10000);timer.unref();})]);assert.equal(code,failDisk?1:0,'A disk failure must stop the running child');
   if(!failDisk)assert.ok((await rows(s.folder)).some(e=>e.event==='server.stopped'));
  }finally{if(child.exitCode===null)child.kill('SIGKILL');}
 }
 console.info(JSON.stringify({status:'passed',noisyRestarts:2,stdoutLinesPerRestart:60000,stderrBytesPerRestart:Buffer.byteLength('synthetic-private-token')*100000,generatedBoundaryMiB:300,separateLevels:true,privateContentSuppressed:true,childExitCodePreserved:true,signalFlush:true,diskFailureStopsChild:true}));
}finally{await rm(directory,{recursive:true,force:true});}
