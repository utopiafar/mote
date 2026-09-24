import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
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

test('CLI removes pre-v2 original spools after outbox reset and preserves v2 spools',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-cli-v2-spool-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const statePath=join(directory,'outbox.json'),spool=statePath+'.atime.json.originals';
  await writeFile(statePath,JSON.stringify({version:2,known:{},pendingRealtime:[],pendingHistory:[]}));
  await mkdir(spool,{recursive:true});await writeFile(join(spool,'generated.bin'),'Generated old staged bytes');
  assert.deepEqual(await initializeCliIngressState(statePath,new SourceSync(statePath)),{reset:true});
  assert.equal(existsSync(spool),false);
  await mkdir(spool,{recursive:true});await writeFile(join(spool,'generated.bin'),'Generated current staged bytes');
  assert.deepEqual(await initializeCliIngressState(statePath,new SourceSync(statePath)),{reset:false});
  assert.equal(existsSync(join(spool,'generated.bin')),true);
});

test('import-files dry run scans a generated file without contacting a node',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'mote-cli-v2-dry-run-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file=join(directory,'generated.txt');await writeFile(file,'Generated CLI source text.');
  const script=fileURLToPath(new URL('./import-files.ts',import.meta.url));
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',script,'--root',file,'--dry-run'],{cwd:fileURLToPath(new URL('../',import.meta.url))});
  assert.match(stdout,/Would send 1 changed UTF-8 text files/);
});
