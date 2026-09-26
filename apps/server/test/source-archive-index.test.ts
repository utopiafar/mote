import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readdirSync,rmSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sourceItemSchema,type SourceItem} from '@mote/shared';
import {Store} from '../src/store.js';
import {SourceArchive,archiveHash} from '../src/source-archive.js';

const sourceId='generated-source',group='generated-session';
const item=(n:number,revision='1',session=group)=>sourceItemSchema.parse({externalId:'event-'+n,revision,
  observedAt:'2026-09-24T01:00:00.000Z',kind:'message',layer:'original',text:`Generated evidence ${n}. ${'x'.repeat(120)}`,
  document:{contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-project',sessionId:session,eventId:String(n),role:'user',part:0,parts:1}}});
function fixture(t:import('node:test').TestContext){
  const directory=mkdtempSync(join(tmpdir(),'mote-source-index-')),store=new Store(directory),archive=new SourceArchive(store);
  const receive=(items:SourceItem[],groups=items.map(()=>group))=>{
    store.db.exec('BEGIN IMMEDIATE');
    try{const result=archive.receive(sourceId,items,groups);store.db.exec('COMMIT');return result;}
    catch(error){if(store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
  };
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,store,archive,receive};
}

test('append changes only a new immutable batch and indexed rows',t=>{
  const {directory,store,archive,receive}=fixture(t);
  for(let start=0;start<1000;start+=100)receive(Array.from({length:100},(_,i)=>item(start+i)));
  const parent=join(directory,'source-archive',archiveHash(sourceId));
  const before=new Map(readdirSync(parent).map(name=>[name,statSync(join(parent,name),{bigint:true})]));
  const bytesBefore=Number(store.db.prepare('SELECT bytes FROM source_archive_sizes WHERE source_id=?').get(sourceId)!.bytes);
  const checkpoint=archive.groupCheckpoint(sourceId,group);
  receive(Array.from({length:100},(_,i)=>item(1000+i)));
  const after=readdirSync(parent),added=after.filter(name=>!before.has(name));
  assert.equal(added.length,1);assert.match(added[0],/^[a-f0-9]{64}\.plain$/);
  for(const [name,prior] of before){const current=statSync(join(parent,name),{bigint:true});assert.equal(current.size,prior.size,name);assert.equal(current.mtimeNs,prior.mtimeNs,name);}
  assert.ok(!after.some(name=>name.startsWith('manifest')));
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM source_archive_versions').get()!.n),1100);
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM source_archive_heads').get()!.n),1100);
  assert.equal(archive.currentHeadsPage(sourceId,group,1095,10).total,1100);
  assert.notEqual(archive.groupCheckpoint(sourceId,group),checkpoint);
  assert.deepEqual(archive.readVersion(sourceId,archiveHash(['event-0','1'])),item(0));
  assert.deepEqual(archive.readVersion(sourceId,archiveHash(['event-1099','1'])),item(1099));
  const bytesAfter=Number(store.db.prepare('SELECT bytes FROM source_archive_sizes WHERE source_id=?').get(sourceId)!.bytes);
  assert.equal(bytesAfter-bytesBefore,Number(statSync(join(parent,added[0])).size));
});

test('rolled-back index writes leave orphan batch files unreferenced',t=>{
  const {store,archive,receive}=fixture(t);
  receive([item(1)]);const before=archive.groupCheckpoint(sourceId,group);
  store.db.exec('BEGIN IMMEDIATE');archive.receive(sourceId,[item(2)],[group]);store.db.exec('ROLLBACK');
  assert.equal(archive.currentHeadsPage(sourceId,group,0,10).total,1);
  assert.equal(archive.readVersion(sourceId,archiveHash(['event-2','1'])),undefined);
  assert.equal(archive.groupCheckpoint(sourceId,group),before);
  assert.equal(receive([item(2)]).receipts[0].duplicate,false);
  assert.equal(archive.currentHeadsPage(sourceId,group,0,10).total,2);
});

test('legacy file manifest imports once with stable checkpoint and recovery groups',t=>{
  const {directory,store,archive,receive}=fixture(t),first=item(1);
  const key=archiveHash([first.externalId,first.revision]),external=archiveHash(first.externalId),batch=archiveHash([first]);
  const {observedAt:_,...body}=first,contentHash=archiveHash(body);
  const manifest={versions:{[key]:{hash:contentHash,batch,index:0,observedAt:first.observedAt,group}},heads:{[external]:key},pendingGroups:['generated-empty']};
  const parent=join(directory,'source-archive',archiveHash(sourceId));mkdirSync(parent,{recursive:true,mode:0o700});
  store.contentEncryption.write(join(parent,batch),Buffer.from(JSON.stringify([first])));
  store.contentEncryption.write(join(parent,'manifest'),Buffer.from(JSON.stringify(manifest)));
  const manifestPath=join(parent,'manifest.plain'),manifestMtime=statSync(manifestPath,{bigint:true}).mtimeNs;
  const physical=readdirSync(parent).reduce((n,name)=>n+statSync(join(parent,name)).size,0);
  store.db.prepare('INSERT INTO source_archive_sizes VALUES(?,?)').run(sourceId,physical);
  const oldCheckpoint=archiveHash([sourceId,group,[[key,contentHash]]]);
  assert.equal(archive.groupCheckpoint(sourceId,group),oldCheckpoint);
  assert.deepEqual(archive.currentSnapshot(sourceId,group).items,[first]);
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) n FROM source_archive_versions').get()!.n),1);
  const next=receive([item(2)]);
  assert.ok(next.groups.includes('generated-empty'));
  assert.equal(statSync(manifestPath,{bigint:true}).mtimeNs,manifestMtime);
  assert.equal(archive.currentHeadsPage(sourceId,group,0,10).total,2);
});
