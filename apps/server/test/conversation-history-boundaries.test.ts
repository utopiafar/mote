import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {materialId} from '../src/materials.js';
import {defaultLifecycleSettings} from '../src/memory-lifecycle.js';
import {dingtalkTranscript} from '../src/connectors/dingtalk-recordings.js';
import {Conversations} from '../src/conversations.js';

const token='generated-history-boundary-owner',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:''});

for(const erase of ['retire','forget'] as const)test(`Material revision preserves historical locators and follow-ups; ${erase} applies its distinct retention boundary`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mote-history-material-')),seen:QueryInput[]=[];let ids:string[]=[];
 const agent={configured:true,close:async()=>{},query:async(input:QueryInput)=>{seen.push(input);return {answer:'Generated historical paper-glider proposal.',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids}};}};
 let node=await buildApp(config(dir),{backgroundWorker:false,agent});t.after(async()=>{await node.app.close();await rm(dir,{recursive:true,force:true});});
 const sourceId='generated-material-history';node.sources.register({id:sourceId,name:'Generated material',kind:'custom',deviceId:'generated',platform:'import'});
 const original={id:randomUUID()};await node.store.ingest({id:original.id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated original text.'});
 const draft=(text:string)=>({id:materialId(sourceId,'body'),kind:'mote.message',schemaVersion:1,title:'Generated material',origin:{sourceId,externalId:'body',deviceId:'generated'},members:[{id:original.id,kind:'capture',ref:'capture:'+original.id}],blocks:[{id:'body',kind:'text' as const,format:'plain',text,memberIds:[original.id]}],coverage:{state:'complete' as const},fidelity:{state:'derived' as const},retention:{original:'retained' as const,policy:'keep' as const}});
 const old=node.materials.publish(draft('Generated original text.'));ids=node.materials.evidenceIds(old.ref);
 const initial=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Discuss generated alternatives'}});assert.equal(initial.statusCode,200,initial.body);const conversationId=initial.json().conversationId;
 const saved=(await node.app.inject({url:`/api/conversations/${conversationId}`,headers})).json().turns[0].result;
 const current=node.materials.publish(draft('Generated revised text.'),{expectedRevision:old.revision});
 const history=(await node.app.inject({url:`/api/conversations/${conversationId}`,headers})).json();assert.equal(history.turns[0].evidenceDeleted,undefined);assert.equal(history.turns[0].evidenceStale,true);assert.deepEqual(history.turns[0].result,saved);
 assert.equal(node.materials.isCurrentEvidence(ids[0]),false);assert.deepEqual(await node.featureServices.evidenceReader.agent({diagnostics:node.diagnostics}).evidence({ids}),[],'history never grants a fresh original read');
 ids=[];await node.app.close();node=await buildApp(config(dir),{backgroundWorker:false,agent});
 for(let i=0;i<2;i++){const follow=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId,question:'Explain the earlier proposal '+i}});assert.equal(follow.statusCode,200,follow.body);assert.match(seen.at(-1)!.conversation!.turns[0].answer,/paper-glider/);assert.equal(seen.at(-1)!.conversation!.turns[0].evidenceStale,true);}
 if(erase==='retire')node.materials.retire(current.id,{expectedRevision:current.revision});else node.materials.forget(current.id);
 const erased=(await node.app.inject({url:`/api/conversations/${conversationId}`,headers})).json();assert.equal(erased.turns.length,3);assert.ok(erased.turns.every((turn:any)=>turn.evidenceDeleted));assert.doesNotMatch(JSON.stringify(erased),/paper-glider/);
});

for(const mutation of ['revise','delete'] as const)test(`late compaction cannot restore history after ${mutation}`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mote-history-compaction-'));let ids:string[]=[];
 const reply=(answer:string)=>({answer,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids}});
 const node=await buildApp(config(dir),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>reply('Generated preserved initial proposal.')}});
 t.after(async()=>{await node.app.close();await rm(dir,{recursive:true,force:true});});
 const id=randomUUID();await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated evidence.'});ids=[id];
 const first=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated initial request'}});assert.equal(first.statusCode,200,first.body);const conversationId=first.json().conversationId;
 const pending=node.working.compact(conversationId,{...defaultLifecycleSettings,recentTurns:0},async()=>{
  if(mutation==='delete')node.store.delete(id);else node.store.invalidateMemoryEvidence(id);
  return reply('Generated late summary which must never commit.');
 });
 await assert.rejects(pending,/Conversation changed/);
 const current=node.conversations.get(conversationId);assert.equal(node.working.get(current),undefined);
 if(mutation==='delete'){assert.equal(current.turns[0].evidenceUnavailable,true);assert.equal(current.turns[0].evidenceDeleted,undefined);assert.match(JSON.stringify(current),/preserved initial proposal/);}
 else{assert.equal(current.turns[0].evidenceStale,true);assert.equal(current.turns[0].result!.answer,'Generated preserved initial proposal.');}
});

test('historical permission receipts never exempt newly disclosed restricted result evidence',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mote-history-new-dependency-'));let ids:string[]=[];let calls=0;
 const node=await buildApp(config(dir),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>{calls++;return {answer:'Generated result.',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids}};}}});
 t.after(async()=>{await node.app.close();await rm(dir,{recursive:true,force:true});});
 const original=randomUUID(),restricted=randomUUID();
 for(const id of [original,restricted])await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'Generated independent evidence.'});
 ids=[original];const first=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated initial request'}});assert.equal(first.statusCode,200,first.body);
 node.store.invalidateMemoryEvidence(original);node.store.delete(restricted);ids=[restricted];
 const next=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{conversationId:first.json().conversationId,question:'Generated follow-up'}});assert.equal(next.statusCode,409,next.body);assert.equal(calls,2,'the new result is rejected after model execution');
 const history=node.conversations.get(first.json().conversationId);assert.ok(history.turns.filter(turn=>turn.result).every(turn=>turn.result!.runId===first.json().runId),'restricted new prose never publishes');
});

test('pagination-only recording reimports preserve old answer and original version dependencies',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mote-history-pagination-'));let ids:string[]=[];
 const node=await buildApp(config(dir),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async()=>({answer:'Generated recording proposal.',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids}})}});
 t.after(async()=>{await node.app.close();await rm(dir,{recursive:true,force:true});});
 const sourceId='generated-pagination-history';node.sources.register({id:sourceId,name:'Generated recording',kind:'local-files',deviceId:'generated',platform:'import',retention:'archive'});
 const metadata={externalId:'generated-recording',title:'Generated recording',kind:'file',deleted:false,observedAt:'2026-10-01T00:00:00Z',document:{contentRole:'transcript' as const,timeBasis:'unknown' as const}};
 const transcript=(pages:number)=>dingtalkTranscript({taskUuid:'generated-recording',complete:true,pages,paragraphList:[{paragraph:'Generated complete recording words.'}]},5000);
 const firstExport=transcript(4),nextExport=transcript(2);assert.deepEqual(nextExport.transcript,firstExport.transcript);
 const first=await node.files.transcriptRevision(sourceId,metadata,firstExport.rawText,firstExport.transcript!,()=>{});ids=[first.id,...node.files.chunks(first.id).map(chunk=>chunk.id)];
 const saved=await node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated recording question'}});assert.equal(saved.statusCode,200,saved.body);const conversationId=saved.json().conversationId;
 const before=node.conversations.get(conversationId).turns[0];
 await node.files.transcriptRevision(sourceId,{...metadata,observedAt:'2026-10-02T00:00:00Z'},nextExport.rawText,nextExport.transcript!,()=>{});
 const after=node.conversations.get(conversationId).turns[0];assert.equal(after.evidenceDeleted,undefined);assert.deepEqual(after.result,before.result);assert.ok(after.result!.evidenceDependencies!.ids.includes(first.id),'old locators are not retargeted by a transport-only import');
});

for(const nested of [false,true])test(`legacy history receipt backfill rolls back both the turn and quota metadata on failure (${nested?'nested':'standalone'})`,async t=>{
 const dir=await mkdtemp(join(tmpdir(),'mote-history-backfill-')),node=await buildApp(config(dir),{backgroundWorker:false});
 t.after(async()=>{await node.app.close();await rm(dir,{recursive:true,force:true});});
 const saved=node.conversations.append(undefined,{question:'Generated legacy request'},{answer:'Generated legacy answer.',citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}}),db=node.store.db;
 db.prepare("UPDATE conversation_turns SET json=json_remove(json,'$.historyEvidenceDependencies') WHERE conversation_id=?").run(saved.conversationId);
 db.prepare("UPDATE conversations SET json=json_set(json,'$.bytes',(SELECT sum(length(CAST(json AS BLOB))) FROM conversation_turns WHERE conversation_id=?)) WHERE id=?").run(saved.conversationId,saved.conversationId);
 const before=db.prepare('SELECT json FROM conversation_turns WHERE id=?').get(saved.turnId)!.json;
 db.exec("CREATE TRIGGER generated_backfill_failure BEFORE UPDATE OF json ON conversations BEGIN SELECT RAISE(ABORT,'Generated quota write failure'); END");
 if(nested)db.exec('BEGIN IMMEDIATE');
 assert.throws(()=>new Conversations(node.store),/Generated quota write failure/);
 assert.equal(db.isTransaction,nested,'migration failure preserves the caller transaction boundary');
 assert.equal(db.prepare('SELECT json FROM conversation_turns WHERE id=?').get(saved.turnId)!.json,before,'failed migration cannot commit a receipt without its quota metadata');
 db.exec('DROP TRIGGER generated_backfill_failure');new Conversations(node.store);
 assert.ok(node.conversations.get(saved.conversationId).turns[0].historyEvidenceDependencies);
 assert.equal(db.prepare("SELECT json_extract(json,'$.bytes') n FROM conversations WHERE id=?").get(saved.conversationId)!.n,db.prepare('SELECT sum(length(CAST(json AS BLOB))) n FROM conversation_turns WHERE conversation_id=?').get(saved.conversationId)!.n);
 if(nested)db.exec('COMMIT');
});
