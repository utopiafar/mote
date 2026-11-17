import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EvidenceStore as Store,sha256} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {ArchivedFileStore} from '../src/archived-files.js';
import {CaptureRawReader,captureCollectionRef,captureRawRef} from '../src/capture-raw-reader.js';
import {FileRawReader,fileOriginalRawRef,sourceFileCollectionRef} from '../src/file-raw-reader.js';
import type {RawReader} from '../src/raw-reader.js';

async function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-raw-cursor-contract-')),store=new Store(directory),sources=new SourceStore(store);
  const files=new FileStore(store,sources),archived=new ArchivedFileStore(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  sources.register({id:'generated-messages',name:'Generated messages',kind:'upload',deviceId:'generated',platform:'import',retention:'archive'});
  sources.register({id:'generated-files',name:'Generated files',kind:'local-files',deviceId:'generated',platform:'import',retention:'archive'});
  const captures:string[]=[],originals:{id:string;hash:string}[]=[];
  for(let index=0;index<3;index++){
    const result=await sources.upsert('generated-messages',{externalId:'message-'+index,revision:'1',observedAt:'2026-09-24T01:00:00.000Z',kind:'message',layer:'original',text:'Generated message '+index});
    captures.push(captureRawRef(result.id));
    const bytes=Buffer.from('Generated original '+index),hash=sha256(bytes);
    const upload=files.begin({sourceId:'generated-files',previousRevision:null,item:{externalId:index+'.bin',revision:'1',observedAt:'2026-09-24T01:00:00.000Z',kind:'file',layer:'original',mimeType:'application/octet-stream'},relativePath:index+'.bin',sizeBytes:bytes.length,sha256:hash},()=>{});
    files.part(upload.uploadId,0,bytes,()=>{});const receipt=await files.commit(upload.uploadId,()=>{});originals.push({id:receipt.id,hash});
  }
  const captureAccess={allowed:true},fileAccess={allowed:true};
  return [
    {name:'capture',reader:new CaptureRawReader(store,{mayReadSource:()=>captureAccess.allowed,mayReadGroup:()=>true,mayListKind:()=>true}),collectionRef:captureCollectionRef('generated-messages','message'),expected:captures,access:captureAccess},
    {name:'file',reader:new FileRawReader(store,files,archived,{mayReadFileVersion:()=>fileAccess.allowed,mayReadArchivedFile:()=>true,mayListSourceFiles:()=>fileAccess.allowed,mayListArchivedFiles:()=>true}),collectionRef:sourceFileCollectionRef('generated-files'),expected:originals.sort((a,b)=>a.id.localeCompare(b.id)).map(item=>fileOriginalRawRef(item.id,item.hash)),access:fileAccess},
  ] satisfies {name:string;reader:RawReader;collectionRef:string;expected:string[];access:{allowed:boolean}}[];
}
const token=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');

for(const name of ['capture','file'])test(`${name} reader preserves scoped cursor bytes, repeated continuation and rejection boundaries`,async t=>{
  const cases=await fixture(t),current=cases.find(item=>item.name===name)!,other=cases.find(item=>item.name!==name)!;
  const {reader,collectionRef,expected,access}=current;
  const first=await reader.page({collectionRef,limit:1});assert.equal(first.status,'available');if(first.status!=='available')return;
  assert.equal(first.total,3);assert.equal(first.items[0].ref,expected[0]);assert.ok(first.nextCursor);
  const decoded=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString());
  assert.deepEqual(decoded,{collectionRef,snapshot:first.snapshot,offset:1});
  assert.equal(first.nextCursor,token({collectionRef,snapshot:first.snapshot,offset:1}),'existing property order and bytes are the continuation contract');
  const second=await reader.page({collectionRef,limit:1,cursor:first.nextCursor!});assert.equal(second.status,'available');if(second.status!=='available')return;
  assert.equal(second.items[0].ref,expected[1]);assert.ok(second.nextCursor);
  assert.deepEqual(await reader.page({collectionRef,limit:1,cursor:first.nextCursor!}),second,'replaying a continuation neither skips nor duplicates an original');
  const third=await reader.page({collectionRef,limit:1,cursor:second.nextCursor!});assert.equal(third.status,'available');if(third.status!=='available')return;
  assert.deepEqual([...first.items,...second.items,...third.items].map(item=>item.ref),expected);assert.equal(third.nextCursor,null);
  assert.deepEqual(await reader.page({collectionRef,limit:1,cursor:token({...decoded,extraHostGrant:'untrusted ignored field'})}),second,'extra keys remain accepted without becoming read authority');
  const atLimit=first.nextCursor!+' '.repeat(12000-first.nextCursor!.length);
  assert.deepEqual(await reader.page({collectionRef,limit:1,cursor:atLimit}),second,'the current decoder accepts 12000 characters');
  assert.equal((await reader.page({collectionRef,cursor:atLimit+' '})).status,'invalid_cursor');
  for(const malformed of ['not-json',token(null),token([]),token({...decoded,collectionRef:7}),token({...decoded,snapshot:'A'.repeat(64)}),token({...decoded,offset:-1}),token({...decoded,offset:1.5}),token({...decoded,offset:Number.MAX_SAFE_INTEGER+1})]){
    assert.equal((await reader.page({collectionRef,cursor:malformed})).status,'invalid_cursor');
  }
  const foreign=await other.reader.page({collectionRef:other.collectionRef,limit:1});assert.equal(foreign.status,'available');if(foreign.status!=='available')return;
  assert.equal((await reader.page({collectionRef,cursor:foreign.nextCursor!})).status,'invalid_cursor');
  assert.equal((await reader.page({collectionRef,cursor:token({...decoded,snapshot:'0'.repeat(64)})})).status,'stale_cursor');
  assert.equal((await reader.page({collectionRef,cursor:token({...decoded,offset:4})})).status,'invalid_cursor');
  access.allowed=false;
  assert.equal((await reader.page({collectionRef,cursor:'not-json'})).status,'unavailable','source authorization still precedes cursor decoding');
  access.allowed=true;assert.deepEqual(await reader.page({collectionRef,limit:1,cursor:first.nextCursor!}),second);
});
