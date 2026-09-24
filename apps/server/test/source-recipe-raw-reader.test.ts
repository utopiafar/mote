import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.js';
import {MaterialStore} from '../src/materials.js';
import {SourceStore} from '../src/sources.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {SourceArchiveRawReader,sourceArchiveCollectionRef,sourceArchiveRawRef} from '../src/source-archive-reader.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {MAX_RAW_READ_BYTES} from '../src/raw-reader.js';

const event=(id:string,text:string,session='fixture-session')=>({externalId:id,revision:'1',observedAt:'2026-09-24T01:00:00.000Z',kind:'message',layer:'snapshot',text,
  document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:session,projectKey:'fixture-project',eventId:id,role:'user',part:0,parts:1}}});
const group=(session:string)=>JSON.stringify(['codex','fixture-project',session]);
async function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-recipe-raw-')),store=new Store(directory),materials=new MaterialStore(store);
  const runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);await runtime.ready;
  const sources=new SourceStore(store,runtime);sources.register({id:'coding',name:'Generated Coding',kind:'coding-agent',deviceId:'fixture-device',platform:'macos'});
  t.after(async()=>{await runtime.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,materials,runtime,sources};
}

test('production Coding recipe pages refs and reads bounded chunks instead of the archive snapshot shortcut',async t=>{
  const {materials,runtime,sources}=await fixture(t);
  await sources.upsertBatch('coding',Array.from({length:102},(_,i)=>event(String(i),i===0?'x'.repeat(90_000):`Generated event ${i}`)));
  const originalPage=SourceArchiveRawReader.prototype.page,originalRead=SourceArchiveRawReader.prototype.read,
    originalSnapshot=runtime.archive.currentSnapshot;
  let pages=0,reads=0;
  SourceArchiveRawReader.prototype.page=async function(request){pages++;assert.ok((request.limit??0)<=100);return originalPage.call(this,request);};
  SourceArchiveRawReader.prototype.read=async function(ref,request){reads++;assert.ok(request.length<=MAX_RAW_READ_BYTES);return originalRead.call(this,ref,request);};
  runtime.archive.currentSnapshot=()=>{throw Error('Production recipe bypassed RawReader');};
  try{await runtime.tick();}finally{SourceArchiveRawReader.prototype.page=originalPage;SourceArchiveRawReader.prototype.read=originalRead;runtime.archive.currentSnapshot=originalSnapshot;}
  assert.ok(pages>=2);assert.ok(reads>=103);
  const material=materials.list().items[0];assert.ok(material);assert.ok(material.textLength>90_000);
  assert.equal(materials.list({query:'Generated event 101'}).items.length,1);
});

test('production scoped reader refuses another existing Coding group through page and read',async t=>{
  const {materials,runtime,sources}=await fixture(t);
  await sources.upsertBatch('coding',[event('a','Generated A','session-a'),event('b','Generated B','session-b')]);
  const refs=[sourceArchiveCollectionRef('coding',group('session-a')),sourceArchiveCollectionRef('coding',group('session-b'))];
  const raw=[sourceArchiveRawRef('coding','a','1'),sourceArchiveRawRef('coding','b','1')];
  const originalPage=SourceArchiveRawReader.prototype.page,originalRead=SourceArchiveRawReader.prototype.read;
  let deniedPages=0,deniedReads=0;
  SourceArchiveRawReader.prototype.page=async function(request){
    const active=refs.indexOf(request.collectionRef),wrong=1-active;
    assert.ok(active>=0);
    assert.equal((await originalPage.call(this,{collectionRef:refs[wrong],limit:1})).status,'unavailable');deniedPages++;
    assert.equal((await originalRead.call(this,raw[wrong],{offset:0,length:64})).status,'unavailable');deniedReads++;
    return originalPage.call(this,request);
  };
  try{await runtime.tick();}finally{SourceArchiveRawReader.prototype.page=originalPage;SourceArchiveRawReader.prototype.read=originalRead;}
  assert.ok(deniedPages>=2);assert.ok(deniedReads>=2);assert.equal(materials.list().items.length,2);
});

test('pausing a Coding source between raw chunks preserves accepted publication',async t=>{
  const {materials,runtime,sources}=await fixture(t);
  await sources.upsert('coding',event('large','x'.repeat(90_000)));
  const originalRead=SourceArchiveRawReader.prototype.read;let reads=0;
  SourceArchiveRawReader.prototype.read=async function(ref,request){
    const result=await originalRead.call(this,ref,request);reads++;
    if(reads===1){assert.equal(result.status,'available');sources.update('coding',{enabled:false});}
    else assert.equal(result.status,'available');
    return result;
  };
  try{await runtime.tick();}finally{SourceArchiveRawReader.prototype.read=originalRead;}
  assert.ok(reads>=2);assert.equal(materials.list().items.length,1);
  await assert.rejects(sources.upsert('coding',event('next','New input')),/paused/i);
});

test('new Coding revision during raw consumption invalidates the old execution',async t=>{
  const {materials,runtime,sources}=await fixture(t);
  await sources.upsert('coding',event('large','x'.repeat(90_000)));
  const originalRead=SourceArchiveRawReader.prototype.read;let changed=false;
  SourceArchiveRawReader.prototype.read=async function(ref,request){
    const result=await originalRead.call(this,ref,request);
    if(!changed){changed=true;await sources.upsert('coding',{...event('large','Generated replacement revision'),revision:'2',observedAt:'2026-09-24T02:00:00.000Z'});}
    return result;
  };
  try{await runtime.tick();}finally{SourceArchiveRawReader.prototype.read=originalRead;}
  assert.ok(changed);assert.equal(materials.list().items.length,0);
  await runtime.tick();
  assert.equal(materials.list({query:'Generated replacement revision'}).items.length,1);
});
