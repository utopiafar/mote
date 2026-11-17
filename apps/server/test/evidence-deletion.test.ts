import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {FileStore} from '../src/files.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {MemoryStore} from '../src/memory.js';
import {Conversations} from '../src/conversations.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {ExecutionEngine,type ExecutionGrant} from '../src/execution-engine.js';

async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-deletion-command-'));let store=new Store(directory);const closers:Array<()=>unknown|Promise<unknown>>=[];
 const sources=new SourceStore(store),files=new FileStore(store,sources),materials=new MaterialStore(store),conversations=new Conversations(store);
 t.after(async()=>{try{for(const close of closers)await close();}finally{store.close();rmSync(directory,{recursive:true,force:true});}});
 sources.register({id:'generated-files',name:'Generated',kind:'local-files',deviceId:'generated',platform:'android',retention:'archive'});
 async function upload(externalId:string,revision:string,previousRevision:string|null=null){
  const bytes=Buffer.from('Generated original '+externalId+' '+revision),hash=sha256(bytes);
  const begun=files.begin({sourceId:'generated-files',previousRevision,item:{externalId,revision,observedAt:'2026-10-01T00:00:00Z',kind:'file',layer:'original',title:externalId+'.txt',text:'',mimeType:'text/plain'},relativePath:externalId+'.txt',sizeBytes:bytes.length,sha256:hash},()=>{});
  files.part(begun.uploadId,0,bytes,()=>{});const receipt=await files.commit(begun.uploadId,()=>{});return {...receipt,hash};
 }
 const first=await upload('selected','1'),second=await upload('selected','2','1'),other=await upload('unrelated','1');
 const dependents=[first,second,other].map((file,index)=>{
  const text='Generated supported conclusion '+index,published=materials.publish({id:materialId('generated-files','derived-'+index),kind:'mote.note',schemaVersion:1,title:'Generated material '+index,
   origin:{sourceId:'generated-files',externalId:'derived-'+index},members:[{id:file.id,kind:'capture',ref:'capture:'+file.id}],blocks:[{id:'body',kind:'text',format:'plain',text,memberIds:[file.id]}],
   coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
  const anchor=materials.evidenceIds(published.ref)[0]!,record=materials.evidence([anchor])[0]!,memories=new MemoryStore(store,ids=>materials.evidence(ids),id=>materials.isCurrentEvidence(id));
  const result=fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated memory',statement:text+' ['+anchor+']',uncertainty:'Generated fixture',evidenceIds:[anchor],evidence:[{id:anchor,quote:record.ocrText}]}]}),citations:[{id:anchor,capturedAt:record.capturedAt,appName:'Generated',excerpt:record.ocrText}],trace:[],runId:randomUUID()});
  const extracted=memories.extract(result,'fixture').items[0]!,memory=memories.publish(extracted.id,extracted.version);
  const conversation=conversations.append(undefined,{question:'Generated question '+index},{answer:text,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[file.id,anchor]}});
  return {material:published,anchor,memory,conversationId:conversation.conversationId};
 });
 // A SQL failure in the last selected revision occurs after earlier invalidation
 // and deletion statements have already executed in the command.
 const order=store.db.prepare("SELECT capture_id FROM file_versions WHERE source_id='generated-files' AND external_id='selected'").all().map(row=>String(row.capture_id));
 const snapshot=()=>Object.fromEntries(['captures','source_versions','file_versions','file_forgotten','file_uploads','file_upload_scopes','material_heads','material_evidence','material_block_payloads','memories','memory_dependencies','memory_provider_evidence_revocations','conversation_turns','conversation_retired_roots','conversation_retired_turn_roots','changes'].map(table=>[table,store.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));
 return {directory,store,sources,files,materials,conversations,first,second,other,dependents,order,snapshot,beforeClose:(close:()=>unknown|Promise<unknown>)=>closers.push(close),reopen(){store.close();store=new Store(directory);return store;}};
}

test('forgetting all file revisions rolls back its tombstone, descendants and outbox after a tail SQL failure',async t=>{
 const f=await fixture(t),before=f.snapshot(),tail=f.order.at(-1)!;
 f.store.db.exec(`CREATE TEMP TRIGGER generated_delete_tail BEFORE DELETE ON captures WHEN OLD.id='${tail}' BEGIN SELECT RAISE(ABORT,'Generated deletion tail failure'); END`);
 assert.throws(()=>f.files.forget(f.first.id),/Generated deletion tail failure/);
 assert.deepEqual(f.snapshot(),before);assert.equal(f.store.db.isTransaction,false);
 for(const record of [f.first,f.second,f.other])assert.equal(sha256(Buffer.concat([...f.files.bytes(record.id)])),record.hash,'rollback retains each original object');
 f.store.db.exec('DROP TRIGGER generated_delete_tail');
 assert.deepEqual(f.files.forget(f.first.id),{deleted:2});
 for(const dependent of f.dependents.slice(0,2)){
  assert.equal(f.materials.get(dependent.material.ref),undefined);assert.equal(f.materials.isCurrentEvidence(dependent.anchor),false);
  assert.equal(f.store.db.prepare('SELECT 1 FROM memories WHERE id=?').get(dependent.memory.id),undefined);
  assert.equal(f.conversations.get(dependent.conversationId).turns[0].evidenceDeleted,true);
 }
 const untouched=f.dependents[2];assert.ok(f.materials.get(untouched.material.ref));assert.equal(f.materials.isCurrentEvidence(untouched.anchor),true);
 assert.ok(f.store.db.prepare('SELECT 1 FROM memories WHERE id=?').get(untouched.memory.id));assert.equal(f.conversations.get(untouched.conversationId).turns[0].evidenceDeleted,undefined);
 assert.equal(sha256(Buffer.concat([...f.files.bytes(f.other.id)])),f.other.hash,'an unrelated original survives post-commit collection');
 const submitted=f.store.db.prepare("SELECT * FROM memory_provider_evidence_revocations WHERE state='submitted' ORDER BY id").all();assert.ok(submitted.some(row=>row.id===f.dependents[0].anchor));
 assert.throws(()=>f.files.forget(f.first.id),{statusCode:404});
 const restarted=f.reopen();assert.deepEqual(restarted.db.prepare("SELECT * FROM memory_provider_evidence_revocations WHERE state='submitted' ORDER BY id").all(),submitted,'durable external revocations survive without a provider running');
 assert.equal(restarted.db.prepare("SELECT count(*) n FROM file_forgotten WHERE external_id='selected'").get()!.n,1);
});

test('capture deletion HTTP delegates file chunks and captures without changing repeat or missing-file responses',async t=>{
 const f=await fixture(t),{buildApp}=await import('../src/app.js');
 const config={path:(f.directory)+'/mote.yaml',privateCredential:{token:'generated-deletion-owner-token',tokenPath:'fixture'},initialDocument:{version:1,revision:0,storage:{dataDir:f.directory,maxExportBytes:2_000_000},server:{host:'127.0.0.1',port:0,allowedOrigins:[]},execution:{insightIntervalHours:0},models:{deployment:{model:'',apiKey:'',allowUnauthenticatedLocal:false,protocol:'deepseek',reasoningEffort:'high'},embedding:{model:'',baseUrl:'',apiKey:''}},diagnostics:{enabled:false}}};
 const node=await buildApp(config,{store:f.store,backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('No model in generated fixture');},close:async()=>{}}});f.beforeClose(()=>node.app.close());
 const headers={authorization:'Bearer '+config.privateCredential!.token},artifactId=randomUUID(),chunkId=randomUUID();
 f.store.db.prepare('INSERT INTO file_artifacts(id,capture_id,kind,created_at,config_revision,json,current) VALUES(?,?,?,?,?,?,1)').run(artifactId,f.first.id,'text','2026-10-01T00:00:00Z','generated',JSON.stringify({complete:true}));
 f.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,text,metadata) VALUES(?,?,?,?,?)').run(chunkId,artifactId,f.first.id,'Generated unavailable-platform transcript fixture','{}');
 assert.equal((await node.app.inject({method:'DELETE',url:'/api/captures/'+chunkId})).statusCode,401);
 const first=await node.app.inject({method:'DELETE',url:'/api/captures/'+chunkId,headers});assert.equal(first.statusCode,200,first.body);assert.deepEqual(first.json(),{deleted:2});
 assert.deepEqual((await node.app.inject({method:'DELETE',url:'/api/captures/'+chunkId,headers})).json(),{deleted:0});
 for(const dependent of f.dependents.slice(0,2)){const turn=f.conversations.get(dependent.conversationId).turns[0];assert.equal(turn.evidenceDeleted,undefined);assert.equal(turn.evidenceUnavailable,true);assert.match(turn.result!.answer,/Generated supported/);}
 const privacy=await node.app.inject({method:'DELETE',url:'/api/files/'+f.first.id,headers});assert.equal(privacy.statusCode,200,privacy.body);
 for(const dependent of f.dependents.slice(0,2))assert.equal(f.conversations.get(dependent.conversationId).turns[0].evidenceDeleted,true,'owner file deletion keeps its existing dialogue withdrawal after ordinary physical removal');
 assert.equal((await node.app.inject({method:'DELETE',url:'/api/files/'+f.first.id,headers})).statusCode,404);
 const head='/api/file-sync/v1/head?'+new URLSearchParams({sourceId:'generated-files',externalId:'selected'});
 assert.deepEqual((await node.app.inject({url:head,headers})).json(),{revision:'2',forgotten:false});
 for(let attempt=0;attempt<2;attempt++)assert.deepEqual((await node.app.inject({method:'POST',url:'/api/files/'+f.first.id+'/allow-again',headers,payload:{sourceId:'generated-files',externalId:'selected'}})).json(),{allowed:true});
 assert.deepEqual((await node.app.inject({url:head,headers})).json(),{revision:'2',forgotten:false});
 const rawId=randomUUID();await f.store.ingest({id:rawId,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated independent note'});
 assert.deepEqual((await node.app.inject({method:'DELETE',url:'/api/captures/'+rawId,headers})).json(),{deleted:1});
 assert.deepEqual((await node.app.inject({method:'DELETE',url:'/api/captures/'+rawId,headers})).json(),{deleted:0});
 assert.ok(f.files.version(f.other.id));assert.ok(f.materials.get(f.dependents[2].material.ref));
});

test('SQL-only deletion participant rejects calls outside a transaction and cannot reclaim bytes before commit',async t=>{
 const f=await fixture(t);assert.throws(()=>f.store.deleteInTransaction(f.first.id),/requires a transaction/);
 const before=f.snapshot();f.store.db.exec('BEGIN IMMEDIATE');
 assert.deepEqual(f.store.deleteInTransaction(f.first.id),{deleted:1});assert.throws(()=>f.store.collectDeletedEvidence(),/requires a committed transaction/);
 f.store.db.exec('ROLLBACK');assert.deepEqual(f.snapshot(),before);assert.equal(sha256(Buffer.concat([...f.files.bytes(f.first.id)])),f.first.hash);
});

test('post-commit collection failure preserves committed deletion and reports the original cleanup error',async t=>{
 const f=await fixture(t),failure=Error('Generated committed collection failure'),collect=f.store.collectDeletedEvidence.bind(f.store);
 const mocked=t.mock.method(f.store,'collectDeletedEvidence',()=>{assert.equal(f.store.db.isTransaction,false);throw failure;});
 assert.throws(()=>f.files.forget(f.first.id),error=>error===failure);
 assert.equal(f.store.db.isTransaction,false);assert.equal(f.files.captureForEvidence(f.first.id),undefined);assert.equal(f.files.captureForEvidence(f.second.id),undefined);
 assert.equal(f.files.syncHead('generated-files','selected').forgotten,true);assert.ok(f.files.version(f.other.id));
 mocked.mock.restore();collect();assert.deepEqual(f.store.delete(f.first.id),{deleted:0});
});


test('an active publication grant survives deletion rollback but cannot publish after the all-version deletion commits',async t=>{
 const f=await fixture(t),engine=new ExecutionEngine(f.store);let grant:ExecutionGrant|undefined,enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(resolve=>{enter=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});let running:Promise<void>|undefined;
 f.beforeClose(async()=>{release();await engine.close();await running;});
 const output=(id:string)=>materialId('generated-files','late-'+id);
 engine.register({kind:'generated.deletion-publication',pool:'generated.deletion-publication',concurrency:()=>2,
  validate:step=>f.files.captureForEvidence(String(step.input.captureId))===step.input.captureId,
  execute:async(step,_signal,currentGrant)=>{if(step.input.captureId===f.first.id){grant=currentGrant;enter();await held;}return 'Generated held publication';},
  commit:(step,text)=>{const id=String(step.input.captureId);f.materials.publish({id:output(id),kind:'mote.note',schemaVersion:1,title:'Generated late publication',origin:{sourceId:'generated-files',externalId:'late-'+id},members:[{id,kind:'capture',ref:'capture:'+id}],blocks:[{id:'body',kind:'text',format:'plain',text:String(text),memberIds:[id]}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});},
 });
 const id=engine.enqueue('generated-held-deletion','generated.deletion-publication',{captureId:f.first.id});running=engine.drain([id]);await entered;
 const before=f.store.db.prepare('SELECT state,fence,attempts FROM execution_steps WHERE id=?').get(id),tail=f.order.at(-1)!;
 assert.equal(before?.state,'running');assert.ok(before?.fence);assert.equal(before?.attempts,1);grant!.assert();
 f.store.db.exec(`CREATE TEMP TRIGGER generated_grant_delete_tail BEFORE DELETE ON captures WHEN OLD.id='${tail}' BEGIN SELECT RAISE(ABORT,'Generated held deletion tail failure'); END`);
 assert.throws(()=>f.files.forget(f.first.id),/Generated held deletion tail failure/);
 assert.deepEqual(f.store.db.prepare('SELECT state,fence,attempts FROM execution_steps WHERE id=?').get(id),before);grant!.assert();
 assert.ok(f.materials.get(f.dependents[0].material.ref));assert.ok(f.materials.get(f.dependents[1].material.ref));
 f.store.db.exec('DROP TRIGGER generated_grant_delete_tail');assert.deepEqual(f.files.forget(f.first.id),{deleted:2});
 assert.throws(()=>grant!.commit(()=>{throw Error('Revoked grant reached its write callback');}),/input_changed|grant_revoked/);
 const unaffected=engine.enqueue('generated-unaffected-deletion','generated.deletion-publication',{captureId:f.other.id});await engine.drain([unaffected]);
 assert.equal(engine.get(unaffected)?.state,'succeeded');assert.ok(f.materials.get(output(f.other.id)));assert.ok(f.materials.get(f.dependents[2].material.ref));
 release();await running;assert.equal(engine.get(id)?.state,'stale');assert.equal(f.materials.get(output(f.first.id)),undefined);
});
