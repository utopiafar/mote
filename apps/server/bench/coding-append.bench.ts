/** Generated fixtures only. Run: node --import tsx apps/server/bench/coding-append.bench.ts
 * MOTE_CODING_SEED_COUNT=500 selects a smaller fixture. This measures one
 * complete source receive and publish, not a synthetic MaterialStore call. */
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readdirSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {sourceItemSchema} from '@mote/shared';
import {Store} from '../src/store.js';
import {MaterialStore} from '../src/materials.js';
import {SourceStore} from '../src/sources.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {SourceRecipeExecutor} from '../src/source-recipe-executor.js';
import {SourceArchiveRawReader} from '../src/source-archive-reader.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';
import {archiveHash} from '../src/source-archive.js';

const seedCount=Number(process.env.MOTE_CODING_SEED_COUNT??1_000);
const appendCount=Number(process.env.MOTE_CODING_APPEND_COUNT??100);
if(!Number.isSafeInteger(seedCount)||seedCount<1||!Number.isSafeInteger(appendCount)||appendCount<1||appendCount>500)throw Error('Invalid fixture size');
const sourceId='generated-coding',sessionId='generated-session',batchSize=500;
const generated=(i:number)=>sourceItemSchema.parse({externalId:`event-${i}`,revision:'1',observedAt:'2026-09-24T01:00:00.000Z',
  kind:'message',layer:'original',text:`Generated Coding event ${i}. ${'x'.repeat(200)}`,
  document:{contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-project',sessionId,eventId:`event-${i}`,role:'user',part:0,parts:1}}});
const memory=()=>{const {rss,heapUsed,external,arrayBuffers}=process.memoryUsage();return {rss,heapUsed,external,arrayBuffers};};
const count=(store:Store,table:string)=>Number((store.db.prepare(`SELECT count(*) n FROM ${table}`).get() as {n:number}).n);
const payloadBytes=(store:Store)=>Number((store.db.prepare('SELECT coalesce(sum(length(text)),0) n FROM material_block_payloads').get() as {n:number}).n);
// FTS is contentless: SELECT text returns NULL. Its shadow segment bytes and
// the material's text length expose physical growth and logical reindex input.
const ftsDataBytes=(store:Store)=>Number((store.db.prepare('SELECT coalesce(sum(length(block)),0) n FROM material_fts_blocks_data').get() as {n:number}).n);
const dbstat=(store:Store)=>{
  try{return Object.fromEntries((store.db.prepare("SELECT name,sum(pgsize) bytes FROM dbstat WHERE name LIKE 'material_%' GROUP BY name").all() as {name:string;bytes:number}[]).map(row=>[row.name,row.bytes]));}
  catch{return null;}
};
const state=(store:Store)=>({revisions:count(store,'material_revisions'),blocks:count(store,'material_block_versions'),
  payloads:count(store,'material_block_payloads'),payloadBytes:payloadBytes(store),members:count(store,'material_members'),
  evidence:count(store,'material_evidence'),ftsRows:count(store,'material_fts_blocks'),ftsDataBytes:ftsDataBytes(store),dbstat:dbstat(store)});

// A generated seed interrupted during a costly first build can be reused to
// measure the fixed reader without repeating all intake. Never use real data.
const reusedDirectory=process.env.MOTE_CODING_REUSE_DIR;
const directory=reusedDirectory??mkdtempSync(join(tmpdir(),'mote-coding-append-'));
if(reusedDirectory&&!existsSync(join(directory,'mote.sqlite')))throw Error('Missing generated benchmark database');
const store=new Store(directory),materials=new MaterialStore(store),runtime=new SourcePipelineRuntime(store,materials,[codingSourcePlugin]);
try{
  await runtime.ready;
  const sources=new SourceStore(store,runtime);
  let seedReceiveMs:number|null=null;
  if(reusedDirectory){
    assert.equal(Number(store.db.prepare('SELECT count(*) n FROM source_archive_heads WHERE source_id=?').get(sourceId)!.n),seedCount);
    // Explicitly repin the generated pending work after a benchmark-code
    // change or an interrupted process. This is a fixture-only restart path.
    runtime.configure(sourceId,runtime.options(sourceId));
  }else{
    sources.register({id:sourceId,name:'Generated Coding',kind:'coding-agent',deviceId:'generated-device',platform:'macos'});
    const seedStart=performance.now();
    for(let first=0;first<seedCount;first+=batchSize){
      const items=Array.from({length:Math.min(batchSize,seedCount-first)},(_,i)=>generated(first+i));
      await sources.upsertBatch(sourceId,items);
    }
    seedReceiveMs=performance.now()-seedStart;
  }
  const seedTickStart=performance.now();
  await runtime.tick();const seedTickMs=performance.now()-seedTickStart;
  const old=materials.list().items[0];assert.ok(old);assert.equal(old.blockCount>0,true);
  const before=state(store),memoryBefore=memory();
  const archiveDir=join(directory,'source-archive',archiveHash(sourceId));
  const rawBefore=new Map(readdirSync(archiveDir).map(name=>[name,statSync(join(archiveDir,name),{bigint:true})]));
  store.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();

  const profile={pageCalls:0,readCalls:0,rawPageMs:0,rawReadMs:0,rawBytes:0,
    snapshotMs:0,organizeMs:0,publishMs:0,ftsMs:0,ftsCalls:0,
    archiveReadCalls:0,archiveReadBytes:0,archiveWriteCalls:0,archiveWriteBytes:0};
  const originalPage=SourceArchiveRawReader.prototype.page,originalRead=SourceArchiveRawReader.prototype.read;
  const originalSnapshot=SourceRecipeExecutor.prototype.snapshot,originalOrganize=SourceRecipeExecutor.prototype.organize;
  const originalPublish=MaterialStore.prototype.publish,originalSearchable=MaterialStore.prototype.setSearchable;
  const originalReadFile=store.contentEncryption.read.bind(store.contentEncryption),originalWrite=store.contentEncryption.write.bind(store.contentEncryption);
  SourceArchiveRawReader.prototype.page=async function(request){const start=performance.now();try{return await originalPage.call(this,request);}finally{profile.pageCalls++;profile.rawPageMs+=performance.now()-start;}};
  SourceArchiveRawReader.prototype.read=async function(ref,request){const start=performance.now();try{const result=await originalRead.call(this,ref,request);if(result.status==='available')profile.rawBytes+=result.bytes.length;return result;}finally{profile.readCalls++;profile.rawReadMs+=performance.now()-start;}};
  SourceRecipeExecutor.prototype.snapshot=async function(...args){const start=performance.now();try{return await originalSnapshot.apply(this,args);}finally{profile.snapshotMs+=performance.now()-start;}};
  SourceRecipeExecutor.prototype.organize=function(...args){const start=performance.now();try{return originalOrganize.apply(this,args);}finally{profile.organizeMs+=performance.now()-start;}};
  MaterialStore.prototype.publish=function(...args){const start=performance.now();try{return originalPublish.apply(this,args);}finally{profile.publishMs+=performance.now()-start;}};
  MaterialStore.prototype.setSearchable=function(...args){const start=performance.now();try{return originalSearchable.apply(this,args);}finally{profile.ftsCalls++;profile.ftsMs+=performance.now()-start;}};
  store.contentEncryption.read=path=>{const bytes=originalReadFile(path);if(path.startsWith(archiveDir)){profile.archiveReadCalls++;profile.archiveReadBytes+=bytes.length;}return bytes;};
  store.contentEncryption.write=(path,bytes)=>{if(path.startsWith(archiveDir)){profile.archiveWriteCalls++;profile.archiveWriteBytes+=bytes.length;}originalWrite(path,bytes);};
  let appendReceiveMs=0,appendTickMs=0,memoryAfterReceive:ReturnType<typeof memory>,memoryAfterTick:ReturnType<typeof memory>;
  try{
    const appendStart=performance.now();
    await sources.upsertBatch(sourceId,Array.from({length:appendCount},(_,i)=>generated(seedCount+i)));
    appendReceiveMs=performance.now()-appendStart;memoryAfterReceive=memory();
    const tickStart=performance.now();await runtime.tick();appendTickMs=performance.now()-tickStart;memoryAfterTick=memory();
  }finally{
    SourceArchiveRawReader.prototype.page=originalPage;SourceArchiveRawReader.prototype.read=originalRead;
    SourceRecipeExecutor.prototype.snapshot=originalSnapshot;SourceRecipeExecutor.prototype.organize=originalOrganize;
    MaterialStore.prototype.publish=originalPublish;MaterialStore.prototype.setSearchable=originalSearchable;
    store.contentEncryption.read=originalReadFile;store.contentEncryption.write=originalWrite;
  }
  const latest=materials.list().items[0];assert.ok(latest);assert.notEqual(latest.revision,old.revision);
  assert.equal(materials.list({query:`event ${seedCount+appendCount-1}`}).items.length,1);
  const after=state(store),rawAdded=readdirSync(archiveDir).filter(name=>!rawBefore.has(name));
  const changedOldRaw=[...rawBefore].filter(([name,prior])=>{
    const now=statSync(join(archiveDir,name),{bigint:true});return now.size!==prior.size||now.mtimeNs!==prior.mtimeNs;
  });
  const oldBlocks=store.db.prepare(`SELECT idx,payload_hash FROM material_block_versions WHERE material_id=? AND from_sequence<=?
    AND (until_sequence IS NULL OR until_sequence>?)`).all(old.id,old.sequence,old.sequence) as {idx:number;payload_hash:string}[];
  const sameIndexPayloads=Number((store.db.prepare(`SELECT count(*) n FROM material_block_versions
    WHERE material_id=? AND from_sequence<=? AND (until_sequence IS NULL OR until_sequence>?)
      AND from_sequence<=? AND (until_sequence IS NULL OR until_sequence>?)`).get(old.id,old.sequence,old.sequence,latest.sequence,latest.sequence) as {n:number}).n);
  const newFtsInput=Number((store.db.prepare(`SELECT coalesce(sum(length(p.text)),0) n FROM material_block_versions b
    JOIN material_block_payloads p ON p.hash=b.payload_hash WHERE b.material_id=? AND b.from_revision=?`).get(latest.id,latest.revision) as {n:number}).n);
  const delta=Object.fromEntries((['revisions','blocks','payloads','payloadBytes','members','evidence','ftsRows','ftsDataBytes'] as const).map(key=>[key,after[key]-before[key]]));
  assert.equal(changedOldRaw.length,0);assert.equal(profile.archiveWriteCalls,1);assert.equal(rawAdded.length,1);
  assert.equal(profile.pageCalls,Math.ceil(appendCount/100));assert.equal(profile.readCalls,appendCount);
  assert.ok(delta.blocks>0&&delta.blocks<latest.blockCount);assert.equal(delta.members,latest.memberCount);assert.equal(delta.evidence,delta.blocks);
  assert.equal(after.ftsRows,before.ftsRows+delta.blocks);
  const walPath=join(directory,'mote.sqlite-wal');
  console.log(JSON.stringify({fixture:{seedCount,appendCount,batchSize,generatedOnly:true,resumedSeed:Boolean(reusedDirectory)},
    timingMs:{seedReceive:seedReceiveMs,seedPublish:seedTickMs,appendReceive:appendReceiveMs,appendTick:appendTickMs,
      readerSnapshot:profile.snapshotMs,rawPageCalls:profile.pageCalls,rawPageCumulative:profile.rawPageMs,
      rawReadCalls:profile.readCalls,rawReadCumulative:profile.rawReadMs,organize:profile.organizeMs,
      publishIncludingFts:profile.publishMs,fts:profile.ftsMs},
    memoryBytes:{before:memoryBefore,afterReceive:memoryAfterReceive!,afterTick:memoryAfterTick!,processPeakRssKiB:process.resourceUsage().maxRSS},
    reads:{rawBytesDelivered:profile.rawBytes,archiveFileReadCalls:profile.archiveReadCalls,
      archiveFileReadBytes:profile.archiveReadBytes,logicalEvents:seedCount+appendCount},
    writes:{archiveCalls:profile.archiveWriteCalls,archiveBytes:profile.archiveWriteBytes,oldRawFilesChanged:changedOldRaw.length,
      newRawFiles:rawAdded.length,sqliteWalBytes:existsSync(walPath)?statSync(walPath).size:0,
      materialRowsAdded:delta,ftsReplaceCalls:profile.ftsCalls,ftsLogicalInputCharacters:newFtsInput,oldBlockCount:oldBlocks.length,
      oldBlockPayloadsReusedAtSameIndex:sameIndexPayloads,newBlockCount:latest.blockCount,
      oldBlockPayloadRowsRewritten:0},
    before,after},null,2));
}finally{await runtime.close();store.close();if(!reusedDirectory)rmSync(directory,{recursive:true,force:true});}
