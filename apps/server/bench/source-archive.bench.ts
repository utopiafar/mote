/** Generated fixtures only. Run: node --import tsx apps/server/bench/source-archive.bench.ts */
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {sourceItemSchema,type SourceItem} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceArchive,archiveHash} from '../src/source-archive.js';

const sourceId='generated-benchmark',group='generated-coding-session',seedCount=Number(process.env.MOTE_ARCHIVE_SEED_COUNT??1_000),appendCount=100,batchSize=500;
if(!Number.isSafeInteger(seedCount)||seedCount<1)throw Error('Invalid generated fixture size');
const generated=(i:number)=>sourceItemSchema.parse({externalId:'event-'+i,revision:'1',observedAt:'2026-09-24T01:00:00.000Z',
  kind:'message',layer:'original',text:`Generated benchmark event ${i}. ${'x'.repeat(200)}`,
  document:{contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-project',sessionId:group,eventId:String(i),role:'user',part:0,parts:1}}});
const directory=mkdtempSync(join(tmpdir(),'mote-source-bench-'));
const store=new Store(directory),archive=new SourceArchive(store);
try{
  const receive=(items:SourceItem[])=>{
    store.db.exec('BEGIN IMMEDIATE');
    try{const receipt=archive.receive(sourceId,items,items.map(()=>group));store.db.exec('COMMIT');archive.acknowledge(sourceId,receipt.checkpoint);}
    catch(error){if(store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
  };
  const fixture=Array.from({length:seedCount+appendCount},(_,i)=>generated(i));
  const started=performance.now();
  for(let start=0;start<seedCount;start+=batchSize)receive(fixture.slice(start,start+batchSize));
  const seedMs=performance.now()-started;
  const archiveDirectory=join(directory,'source-archive',archiveHash(sourceId));
  const oldFiles=new Map(readdirSync(archiveDirectory).map(name=>[name,statSync(join(archiveDirectory,name),{bigint:true})]));
  const sourceBytesBefore=Number(store.db.prepare('SELECT bytes FROM source_archive_sizes WHERE source_id=?').get(sourceId)!.bytes);
  const checkpointBefore=archive.groupCheckpoint(sourceId,group),ledgerBefore=store.ledger.bytes();
  store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  const originalWrite=store.contentEncryption.write.bind(store.contentEncryption);
  const archiveWrites:{path:string;bytes:number}[]=[];
  store.contentEncryption.write=(path,bytes)=>{archiveWrites.push({path,bytes:bytes.length});originalWrite(path,bytes);};
  const appendStarted=performance.now();receive(fixture.slice(seedCount));const appendMs=performance.now()-appendStarted;
  const newFiles=readdirSync(archiveDirectory),added=newFiles.filter(name=>!oldFiles.has(name));
  const changedOldFiles=[...oldFiles].filter(([name,before])=>{
    const after=statSync(join(archiveDirectory,name),{bigint:true});return after.size!==before.size||after.mtimeNs!==before.mtimeNs;
  });
  const sourceBytesAfter=Number(store.db.prepare('SELECT bytes FROM source_archive_sizes WHERE source_id=?').get(sourceId)!.bytes);
  const walPath=join(directory,'mote.sqlite-wal'),walBytes=statSync(walPath).size;
  const versionCount=Number(store.db.prepare('SELECT COUNT(*) n FROM source_archive_versions WHERE source_id=?').get(sourceId)!.n);
  const headCount=Number(store.db.prepare('SELECT COUNT(*) n FROM source_archive_heads WHERE source_id=?').get(sourceId)!.n);
  const checkpointChanged=archive.groupCheckpoint(sourceId,group)!==checkpointBefore;
  const snapshotStarted=performance.now(),snapshot=archive.currentSnapshot(sourceId,group),snapshotMs=performance.now()-snapshotStarted;
  assert.equal(archiveWrites.length,1);assert.equal(added.length,1);assert.equal(changedOldFiles.length,0);
  assert.equal(versionCount,seedCount+appendCount);assert.equal(headCount,seedCount+appendCount);
  assert.equal(snapshot.items.length,seedCount+appendCount);
  assert.equal(sourceBytesAfter-sourceBytesBefore,statSync(join(archiveDirectory,added[0])).size);
  assert.ok(checkpointChanged);
  console.log(JSON.stringify({seedCount,appendCount,batchSize,seedMs:Math.round(seedMs),appendMs:Math.round(appendMs),snapshotMs:Math.round(snapshotMs),
    oldRawBlocks:oldFiles.size,addedRawBlocks:added.length,changedOldRawBlocks:changedOldFiles.length,
    archiveWriteCalls:archiveWrites.length,archiveWriteBytes:archiveWrites.reduce((n,write)=>n+write.bytes,0),
    physicalArchiveByteDelta:sourceBytesAfter-sourceBytesBefore,sqliteWalBytes:walBytes,
    logicalLedgerByteDelta:store.ledger.bytes()-ledgerBefore,versionCount,headCount,checkpointChanged},null,2));
}finally{store.close();rmSync(directory,{recursive:true,force:true});}
