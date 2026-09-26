import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sourceItemSchema} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceArchive} from '../src/source-archive.js';
import {MAX_RAW_PAGE_ITEMS,MAX_RAW_READ_BYTES,SourceArchiveRawReader,sourceArchiveCollectionRef,sourceArchiveRawRef} from '../src/source-archive-reader.js';

const item=(externalId:string,revision='1',text='Generated source content.',observedAt='2026-09-24T01:00:00.000Z')=>sourceItemSchema.parse({externalId,revision,observedAt,kind:'message',layer:'original',text});
function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-raw-reader-')),store=new Store(directory),archive=new SourceArchive(store);
  const access={mayReadSource:(id:string)=>id==='generated-source',mayReadGroup:(_id:string,group:string)=>group==='session-a'};
  const reader=new SourceArchiveRawReader(store,archive,access);
  const receive=(items:ReturnType<typeof item>[],groups:string[])=>{
    store.db.exec('BEGIN IMMEDIATE');
    try{const result=archive.receive('generated-source',items,groups);store.db.exec('COMMIT');return result;}
    catch(error){if(store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
  };
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,archive,reader,receive};
}

test('raw refs pin an immutable revision; ranged reads and current pages stay bounded',async t=>{
  const {reader,receive}=fixture(t);
  const first=item('event-1','1','Generated event text '.repeat(4000));
  receive([first,item('event-2')],['session-a','session-a']);
  const collectionRef=sourceArchiveCollectionRef('generated-source','session-a');
  const page1=await reader.page({collectionRef,limit:1});assert.equal(page1.status,'available');if(page1.status!=='available')return;
  assert.equal(page1.items.length,1);assert.ok(page1.nextCursor);
  const page2=await reader.page({collectionRef,limit:1,cursor:page1.nextCursor!});assert.equal(page2.status,'available');if(page2.status!=='available')return;
  assert.equal(page2.items.length,1);assert.equal(page2.nextCursor,null);assert.equal(page1.total,2);
  const ref=sourceArchiveRawRef('generated-source','event-1','1');assert.equal(page1.items[0].ref,ref);
  const pieces:Uint8Array[]=[];let offset=0;
  while(true){
    const result=await reader.read(ref,{offset,length:4096});assert.equal(result.status,'available');if(result.status!=='available')return;
    assert.ok(result.bytes.length<=4096);assert.equal(result.bytes.buffer.byteLength,result.bytes.length);assert.equal(result.offset,offset);pieces.push(result.bytes);
    if(result.nextOffset===null)break;offset=result.nextOffset;
  }
  assert.deepEqual(JSON.parse(Buffer.concat(pieces).toString()),first);
  receive([item('event-1','2','Generated replacement.', '2026-09-24T02:00:00.000Z')],['session-a']);
  assert.equal((await reader.page({collectionRef,limit:1,cursor:page1.nextCursor!})).status,'stale_cursor');
  const old=await reader.read(ref,{offset:0,length:MAX_RAW_READ_BYTES});assert.equal(old.status,'available');
  if(old.status==='available')assert.match(Buffer.from(old.bytes).toString(),/"revision":"1"/);
  const current=await reader.page({collectionRef});assert.equal(current.status,'available');
  if(current.status==='available')assert.equal(current.items[0].ref,sourceArchiveRawRef('generated-source','event-1','2'));
});

test('large current groups advance by keyset while seek and older offset cursors remain valid',async t=>{
  const {archive,reader,receive}=fixture(t);
  receive(Array.from({length:251},(_,i)=>item(`event-${i}`)),Array(251).fill('session-a'));
  const original=archive.currentHeadsPage.bind(archive),afterIds:(number|undefined)[]=[];
  archive.currentHeadsPage=(...args)=>{afterIds.push(args[4]);return original(...args);};
  const collectionRef=sourceArchiveCollectionRef('generated-source','session-a');
  const first=await reader.page({collectionRef,limit:100});assert.equal(first.status,'available');if(first.status!=='available')return;
  const second=await reader.page({collectionRef,limit:100,cursor:first.nextCursor!});assert.equal(second.status,'available');if(second.status!=='available')return;
  const third=await reader.page({collectionRef,limit:100,cursor:second.nextCursor!});assert.equal(third.status,'available');if(third.status!=='available')return;
  assert.equal(first.total,251);assert.equal(second.total,251);assert.equal(third.total,251);
  assert.deepEqual([first.items.length,second.items.length,third.items.length],[100,100,51]);
  assert.equal(third.nextCursor,null);
  assert.equal(afterIds[0],undefined);assert.ok(afterIds[1]!>0);assert.ok(afterIds[2]!>afterIds[1]!);
  const seek=await reader.page({collectionRef,limit:100,seek:{offset:200,appendEpoch:0}});
  assert.equal(seek.status,'available');if(seek.status==='available')assert.deepEqual(seek.items,third.items);
  const oldCursor=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString()) as Record<string,unknown>;
  delete oldCursor.lastId;
  const legacy=await reader.page({collectionRef,limit:100,cursor:Buffer.from(JSON.stringify(oldCursor)).toString('base64url')});
  assert.equal(legacy.status,'available');if(legacy.status==='available')assert.deepEqual(legacy.items,second.items);
  receive([item('event-0','2','Moved','2026-09-24T02:00:00.000Z')],['session-b']);
  assert.equal(archive.currentHeadsPage('generated-source','session-a',0,1).total,250);
  assert.equal(archive.currentHeadsPage('generated-source','session-b',0,1).total,1);
  assert.equal((await reader.page({collectionRef,limit:100,cursor:first.nextCursor!})).status,'stale_cursor');
});

test('absence, erasure, authorization, ranges and page limits have explicit states',async t=>{
  const {store,archive,reader,receive}=fixture(t);
  receive([item('event-1'),item('private-event')],['session-a','session-b']);
  const ref=sourceArchiveRawRef('generated-source','event-1','1');
  const privateRef=sourceArchiveRawRef('generated-source','private-event','1');
  assert.equal((await reader.read(privateRef,{offset:0,length:100})).status,'unavailable');
  assert.equal((await reader.page({collectionRef:sourceArchiveCollectionRef('generated-source','session-b')})).status,'unavailable');
  assert.equal((await reader.read(sourceArchiveRawRef('generated-source','absent','1'),{offset:0,length:100})).status,'missing');
  assert.equal((await reader.read('raw:v1:invalid',{offset:0,length:100})).status,'missing');
  assert.deepEqual(await reader.read(ref,{offset:0,length:MAX_RAW_READ_BYTES+1}),{status:'limit_exceeded',maxBytes:MAX_RAW_READ_BYTES});
  assert.equal((await reader.read(ref,{offset:-1,length:10})).status,'invalid_range');
  assert.equal((await reader.read(ref,{offset:1_000_000,length:10})).status,'invalid_range');
  assert.deepEqual(await reader.page({collectionRef:sourceArchiveCollectionRef('generated-source','session-a'),limit:MAX_RAW_PAGE_ITEMS+1}),{status:'limit_exceeded',maxItems:MAX_RAW_PAGE_ITEMS});
  assert.equal((await reader.page({collectionRef:sourceArchiveCollectionRef('generated-source','session-a'),cursor:'broken'})).status,'invalid_cursor');
  const denied=new SourceArchiveRawReader(store,archive,{mayReadSource:()=>false,mayReadGroup:()=>true});
  assert.equal((await denied.read(ref,{offset:0,length:100})).status,'unavailable');
  archive.forget('generated-source');
  assert.equal((await reader.read(ref,{offset:0,length:100})).status,'unavailable');
});

test('group checkpoints track ordered heads and movement, but ignore journal acknowledgment',t=>{
  const {archive,receive}=fixture(t);
  const first=receive([item('event-1')],['session-a']);
  assert.equal(first.groupCheckpoints['session-a'],archive.groupCheckpoint('generated-source','session-a'));
  const snapshot=archive.currentSnapshot('generated-source','session-a');
  assert.deepEqual(snapshot.items,[item('event-1')]);assert.equal(snapshot.checkpoint,first.groupCheckpoints['session-a']);
  const moved=receive([item('event-1','2','Generated moved event.','2026-09-24T02:00:00.000Z')],['session-b']);
  assert.notEqual(moved.groupCheckpoints['session-a'],snapshot.checkpoint);
  assert.equal(archive.currentSnapshot('generated-source','session-a').items.length,0);
  assert.equal(archive.currentSnapshot('generated-source','session-b').items.length,1);
});
