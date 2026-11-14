import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {lstat,mkdtemp,mkdir,open,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {SourceSync} from '../apps/desktop/src/source-sync.js';
import type {SourceDefinition,ScannedItem} from '../apps/desktop/src/source-types.js';
import {initializeCliIngressState} from './cli-ingress-state.js';

process.env.MOTE_URL='http://127.0.0.1:47832';
process.env.MOTE_TOKEN='generated-cli-token';
const {apiClient}=await import('./client.js');

test('CLI sends ingress v2 and requires a durable receipt for generated captures',async t=>{
  const original=globalThis.fetch,id=randomUUID(),capture={id,source:'screen',deviceId:'generated-device'};
  t.after(()=>{globalThis.fetch=original;});
  const ack={id,duplicate:false,receipt:{version:2,id,kind:'capture',state:'received',duplicate:false}};
  let received:unknown=ack;
  globalThis.fetch=async (_url,init)=>{
    assert.equal(new Headers(init?.headers).get('X-Mote-Ingress-Version'),'2');
    assert.equal(init?.method,'POST');
    return Response.json(received,{status:201});
  };
  const client=apiClient();
  assert.deepEqual(await client('/api/captures',capture,'POST'),ack);
  received={id,duplicate:false};
  await assert.rejects(client('/api/captures',capture,'POST'),/Invalid v2 ingress receipt/);
  received={...ack,receipt:{...ack.receipt,id:randomUUID()}};
  await assert.rejects(client('/api/captures',capture,'POST'),/Invalid v2 ingress receipt/);
});

test('CLI SourceSync keeps a generated file revision pending until its v2 receipt validates',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-cli-v2-receipt-')),original=globalThis.fetch;
  t.after(async()=>{globalThis.fetch=original;await rm(directory,{recursive:true,force:true});});
  const source:SourceDefinition={id:'generated-cli-source',deviceId:'generated-device',name:'Generated files',kind:'local-files',platform:'import',retention:'snapshot',enabled:true};
  const item:ScannedItem={externalId:'file:generated',title:'Generated.txt',text:'Synthetic evidence only.',kind:'file',layer:'snapshot',deleted:false};
  const engine=new SourceSync(join(directory,'outbox.json'));
  await initializeCliIngressState(join(directory,'outbox.json'),engine);
  await engine.stage({items:[item],seen:[item.externalId],skipped:0,complete:true},false);
  const client=apiClient();let valid=false,headerChecks=0;
  globalThis.fetch=async (url,init)=>{
    assert.equal(new Headers(init?.headers).get('X-Mote-Ingress-Version'),'2');headerChecks++;
    const path=new URL(String(url)).pathname;
    if(path==='/api/sources')return Response.json(source);
    assert.equal(path,'/api/sources/generated-cli-source/items');
    const sent=JSON.parse(String(init?.body)) as {externalId:string;revision:string};
    const id=randomUUID(),ack={id,sourceId:source.id,externalId:sent.externalId,revision:sent.revision,duplicate:false};
    return Response.json({...ack,receipt:valid?{version:2,id,kind:'source-item',state:'received',duplicate:false,sourceId:source.id,externalId:sent.externalId,revision:sent.revision}:undefined});
  };
  await assert.rejects(engine.flush(source,client),/确认不匹配/);
  assert.equal(engine.status().pending,1);
  valid=true;
  assert.equal(await engine.flush(source,client),'ready');
  assert.equal(engine.status().pending,0);
  assert.ok(headerChecks>=4);
});

test('CLI rejects old outboxes without deleting generated state or private original spools',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-cli-strict-spool-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const statePath=join(directory,'outbox.json'),spool=statePath+'.atime.json.originals',old=JSON.stringify({version:2,known:{},pendingRealtime:[],pendingHistory:[]});
  await writeFile(statePath,old);await mkdir(spool,{recursive:true});await writeFile(join(spool,'generated.bin'),'Generated staged bytes');
  await assert.rejects(initializeCliIngressState(statePath,new SourceSync(statePath)),/Unsupported desktop storage format/);
  assert.equal(existsSync(join(spool,'generated.bin')),true);
  assert.equal(await (await import('node:fs/promises')).readFile(statePath,'utf8'),old);
  const freshPath=join(directory,'fresh.json');await initializeCliIngressState(freshPath,new SourceSync(freshPath));
  await initializeCliIngressState(freshPath,new SourceSync(freshPath));
});

test('import-files dry run scans a generated file without contacting a node',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-cli-v2-dry-run-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'generated.txt');await writeFile(file,'Generated CLI source text.');
  const script=fileURLToPath(new URL('./import-files.ts',import.meta.url));
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',script,'--root',file,'--dry-run'],{cwd:fileURLToPath(new URL('../',import.meta.url))});
  assert.match(stdout,/Would send 1 changed files/);
});

test('import-files archive preview counts all seven eligible audio files across the 16 MiB shard boundary',async t=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'mote-cli-audio-preview-')));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const selected=join(directory,'selected'),profile=join(directory,'profile'),temporary=join(directory,'temporary');
  for(const path of [selected,profile,temporary])await mkdir(path,{mode:0o700});
  const MiB=1024*1024,sizes=[1024,16*MiB,16*MiB+1,17*MiB,18*MiB,19*MiB,20*MiB,512*MiB+1];
  for(const [index,size] of sizes.entries()){
    const handle=await open(join(selected,`generated-${index}.m4a`),'wx',0o600);
    try{await handle.truncate(size);}finally{await handle.close();}
  }
  const configFile=join(profile,'mote.yaml');
  await writeFile(configFile,'version: 1\nrevision: 0\nserver:\n  profile: test\n  host: 127.0.0.1\n  port: 9\n  token: generated-preview-only\n',{mode:0o600});
  const env={...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('MOTE_'))),MOTE_CONFIG_FILE:configFile,TMPDIR:temporary,TSX_DISABLE_CACHE:'1'};
  const script=fileURLToPath(new URL('./import-files.ts',import.meta.url));
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',script,'--root',selected,'--retention','archive','--dry-run'],{env,cwd:fileURLToPath(new URL('../',import.meta.url))});
  assert.match(stdout,/Would send 7 changed files; skipped 1; deletion scan not applied\./);
  assert.deepEqual(await readdir(profile),['mote.yaml'],'preview must not create a durable outbox or access markers in the selected profile');
  assert.deepEqual(await readdir(temporary),[],'preview must clean its temporary original spools');
  assert.equal((await readdir(selected)).length,8);

  const watcher=spawn(process.execPath,['--import','tsx',script,'--root',join(selected,'generated-2.m4a'),'--retention','archive','--dry-run','--watch'],{env,cwd:fileURLToPath(new URL('../',import.meta.url)),stdio:['ignore','pipe','pipe']});
  const exited=once(watcher,'close');
  try{
    let output='',errors='';watcher.stderr.on('data',part=>{errors+=part.toString();});
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Watch preview did not finish its first scan: '+errors)),10_000);
      watcher.stdout.on('data',part=>{output+=part.toString();if(/Would send 1 changed files; skipped 0; deletion scan not applied\./.test(output)){clearTimeout(timer);resolve();}});
      watcher.once('close',()=>{clearTimeout(timer);reject(Error('Watch preview exited before its first scan: '+errors));});
    });
    const directories=await readdir(temporary);assert.equal(directories.length,1);
    const preview=join(temporary,directories[0]!);assert.equal((await lstat(preview)).mode&0o777,0o700);
    assert.deepEqual(await readdir(join(preview,'access.json.originals')),[],'watch preview must release original bytes before waiting');
    watcher.kill('SIGTERM');assert.equal((await exited)[0],0);
    assert.deepEqual(await readdir(temporary),[],'SIGTERM must clean the remaining preview markers');
    assert.deepEqual(await readdir(profile),['mote.yaml']);
  }finally{watcher.kill('SIGKILL');await exited;}
});
