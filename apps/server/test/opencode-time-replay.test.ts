import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {sourceItemSchema,type SourceItem} from '@mote/shared';
import {builtInSourceAdapters,SourceAdapterRegistry} from '../../desktop/src/source-adapters.js';
import {SourceSync} from '../../desktop/src/source-sync.js';
import {sourceWork} from '../../desktop/src/background.js';
import type {CodingCheckpoint} from '../../desktop/src/coding-agents.js';
import {DEFAULT_SOURCE_OPTIONS,type SourceRequest,type SourceScan} from '../../desktop/src/source-types.js';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceArchive,archiveHash} from '../src/source-archive.js';

test('rescanning OpenCode repairs recorded times under stable event identities without rewriting immutable raw revisions',async t=>{
 const root=await mkdtemp(join(tmpdir(),'mote-opencode-time-replay-')),databasePath=join(root,'opencode.db');
 const at=Date.parse('2026-09-21T14:13:20Z'),session='generated-session',database=new DatabaseSync(databasePath);
 try{
  database.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT NOT NULL,title TEXT,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL);
CREATE TABLE session_message (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,type TEXT NOT NULL,seq INTEGER NOT NULL,time_created INTEGER NOT NULL,time_updated INTEGER NOT NULL,data TEXT NOT NULL);`);
  database.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?)').run(session,null,'/generated/project','Generated session',at,at+9000);
  const message=database.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  message.run('user',session,'user',1,at,at+9000,JSON.stringify({text:'Generated owner request'}));
  message.run('assistant',session,'assistant',2,at+1000,at+9000,JSON.stringify({time:{completed:at+2000},finish:'stop',content:[{type:'text',text:'Generated reply. '.repeat(600)}]}));
  message.run('tools',session,'assistant',3,at+2000,at+9000,JSON.stringify({time:{completed:at+3000},content:[{type:'tool',id:'generated-call',name:'generated',time:{created:at+2100,completed:at+2200},state:{status:'completed',content:[{type:'text',text:'Generated tool output'}]}}]}));
  message.run('system',session,'system',4,at+3000,at+9000,JSON.stringify({text:'Generated host instruction'}));
  message.run('synthetic',session,'synthetic',5,at+4000,at+9000,JSON.stringify({text:'Generated host context'}));
  message.run('running',session,'assistant',6,at+5000,at+9000,JSON.stringify({time:{created:at+5000,completed:null},content:[{type:'text',text:'Generated unfinished reply'}]}));
 }finally{database.close();}
 const store=new Store(join(root,'central')),archive=new SourceArchive(store);
 t.after(async()=>{await sourceWork.close();store.close();await rm(root,{recursive:true,force:true});});
 const source={...DEFAULT_SOURCE_OPTIONS,id:'generated-opencode',name:'Generated OpenCode',kind:'coding-agent',agent:'opencode' as const,path:databasePath,deviceId:'generated-device',platform:'macos' as const,enabled:true};
 const currentAdapter=builtInSourceAdapters().get('coding-agent');
 // Scope replay to this generated OpenCode source using the existing adapter
 // registry/version contract, without rebaselining unrelated new-only sources.
 const adapters=new SourceAdapterRegistry().register({...currentAdapter,version:currentAdapter.version+1}),statePath=join(root,'source.json');
 let engine=new SourceSync(statePath);await engine.initialize();
 const scan=(checkpoint?:ReturnType<SourceSync['checkpoint']>)=>adapters.scan({source,checkpoint,signal:new AbortController().signal,priorityPaths:[],stateDirectory:root,helperPath:'/never-run-helper',scope:{start:'2026-01-01',end:'2026-12-31'}});
 let loseAck=false;
 const request:SourceRequest=async(route,body)=>{
  if(route==='/api/sources')return source;
  assert.ok(route.startsWith(`/api/sources/${source.id}/items`),route);
  const wire=JSON.parse(JSON.stringify(body)),items=(wire.items??[wire]).map((item:unknown)=>sourceItemSchema.parse(item)) as SourceItem[];
  store.db.exec('BEGIN IMMEDIATE');
  let received:ReturnType<SourceArchive['receive']>;
  try{received=archive.receive(source.id,items,items.map(()=>session));store.db.exec('COMMIT');}
  catch(error){store.db.exec('ROLLBACK');throw error;}
  if(loseAck){loseAck=false;throw Error('Generated ACK loss after raw commit');}
  const receipts=received.receipts.map(ack=>({...ack,receipt:{...ack,version:2,kind:'source-item',state:'received'}}));
  return wire.items?{receipts}:receipts[0];
 };
 const initial=await scan();assert.equal(initial.complete,false);assert.equal(initial.items.length,7);assert.equal(initial.skipped,0);
 // Seed exactly the old decoder's missing-time metadata; the real producer
 // supplies the identity, roles, attribution and split parts unchanged.
 const legacy:SourceScan={...initial,items:initial.items.map(item=>item.document!.coding!.role.startsWith('tool_')?item:{...item,document:{...item.document!,timeBasis:'unknown',recordedAt:undefined}})};
 await engine.stage(legacy,false,'2026-10-01T00:00:00Z');await engine.flush(source,request);
 const originals=archive.current(source.id,session);assert.equal(originals.length,7);
 const checkpoint=engine.checkpoint();assert.deepEqual((await scan(checkpoint)).items,[]);
 // The registered adapter upgrade resets only discovery. Source identity,
 // delivered receipts and immutable raw revisions remain in the same state.
 const adapterVersion=adapters.get(source.kind).version;
 await engine.ensureAdapterVersion(adapterVersion);assert.equal(engine.checkpoint(),undefined);
 const correctedAt='2026-10-02T00:00:00Z';
 const replay=await scan(engine.checkpoint());await engine.stage(replay,false,correctedAt);
 const pending=engine.pendingContent();loseAck=true;
 await assert.rejects(engine.flush(source,request),/Generated ACK loss/);
 engine=new SourceSync(statePath);await engine.initialize();
 assert.equal(JSON.stringify(engine.pendingContent()),JSON.stringify(pending));assert.deepEqual(engine.checkpoint(),replay.checkpoint);
 await engine.ensureAdapterVersion(adapterVersion);assert.deepEqual(engine.checkpoint(),replay.checkpoint);
 await engine.flush(source,request);assert.equal(engine.status().pending,0);
 const drained=await scan(engine.checkpoint());assert.deepEqual(drained.items,[]);assert.equal(drained.skipped,0);
 assert.equal(drained.complete,false);assert.deepEqual((drained.checkpoint as CodingCheckpoint).opencode!.sessions[session].incomplete,['running']);
 const repaired=archive.current(source.id,session),oldById=new Map(originals.map(item=>[item.externalId,item]));
 assert.equal(repaired.length,originals.length);
 for(const item of repaired){
  const old=oldById.get(item.externalId)!;assert.ok(old);
  assert.deepEqual(item.document!.coding,old.document!.coding);assert.equal(item.text,old.text);
  assert.equal(item.document!.timeBasis,'recorded');
  const coding=item.document!.coding!,expected=coding.role==='tool_call'?at+2100:coding.role==='tool_result'?at+2200:coding.role==='assistant'?at+1000:item.text==='Generated owner request'?at:item.text==='Generated host instruction'?at+3000:at+4000;
  assert.equal(item.document!.recordedAt,new Date(expected).toISOString());
  if(old.document!.timeBasis==='unknown'){assert.notEqual(item.revision,old.revision);assert.equal(item.observedAt,correctedAt);}
  else assert.equal(item.revision,old.revision);
  assert.deepEqual(archive.readVersion(source.id,archiveHash([old.externalId,old.revision])),old);
 }
 assert.equal(Number(store.db.prepare('SELECT count(*) n FROM source_archive_versions').get()!.n),12);
 const currentCheckpoint=archive.groupCheckpoint(source.id,session);
 await engine.stage(await scan(),false,'2026-10-03T00:00:00Z');await engine.flush(source,request);
 assert.equal(archive.groupCheckpoint(source.id,session),currentCheckpoint);
 assert.equal(Number(store.db.prepare('SELECT count(*) n FROM source_archive_versions').get()!.n),12);
 assert.equal(engine.status().pending,0);
 assert.ok(!JSON.stringify(repaired).includes('Generated unfinished reply'));
});
