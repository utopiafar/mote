import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Conversations} from '../src/conversations.js';
import {sha256} from '../src/store.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

const token='generated-context-policy-token',headers={authorization:'Bearer '+token};
const reply=(answer='Generated reply'):QueryResult=>({answer,citations:[],trace:[],runId:randomUUID(),evidenceDependencies:{version:1,complete:true,ids:[]}});
async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-derived-context-'));
 const config:Config={dataDir:directory,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:20_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'fixture-remote',modelBaseUrl:'https://synthetic.invalid',apiKey:'fixture',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false};
 let respond:(input:QueryInput)=>Promise<QueryResult>=async input=>reply(input.skill==='working-memory'?'Generated bounded summary':'Generated reply');
 const calls:QueryInput[]=[];
 const node=await buildApp(config,{backgroundWorker:false,createModelAgent:async()=>({configured:true,close:async()=>{},query:async input=>{calls.push(input);return respond(input);}})});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const settings=node.lifecycle.settings();for(const key of ['extraction','consolidation','insights','working'] as const)settings[key].enabled=false;node.lifecycle.configure(settings);
 await node.modelSettings.updateProfile('local',{revision:node.modelSettings.view().revision,name:'Generated local',settings:{...node.modelSettings.current(),provider:'custom',protocol:'openai-completions',model:'fixture-local',baseUrl:'http://127.0.0.1:1234/v1',apiKey:'',allowUnauthenticatedLocal:true}});
 node.sources.register({id:'generated-context-files',name:'Generated files',kind:'local-files',deviceId:'generated',platform:'import',retention:'archive'});
 const bytes=Buffer.from('Generated recording bytes'),upload=node.files.begin({sourceId:'generated-context-files',item:{externalId:'recording',revision:'1',observedAt:'2026-09-27T00:00:00Z',title:'Generated recording',kind:'file',layer:'original',text:'',mimeType:'audio/wav'},sizeBytes:bytes.length,sha256:sha256(bytes)},()=>{});
 node.files.part(upload.uploadId,0,bytes,()=>{});const parent=await node.files.commit(upload.uploadId,()=>{}),chunk=randomUUID(),artifact=randomUUID(),text='GENERATED_CONTEXT original fixture evidence';
 node.store.db.prepare('INSERT INTO file_artifacts VALUES(?,?,?,?,?,?,1)').run(artifact,parent.id,'transcript','2026-09-27T00:00:00Z','fixture',JSON.stringify({complete:true,coverage:'full'}));
 node.store.db.prepare('INSERT INTO file_chunks(id,artifact_id,capture_id,start_ms,end_ms,text,metadata) VALUES(?,?,?,?,?,?,?)').run(chunk,artifact,parent.id,0,1000,text,'{}');
 node.store.db.prepare("UPDATE file_jobs SET state='succeeded' WHERE capture_id=?").run(parent.id);
 const conversations=new Conversations(node.store);
 const save=(answer='GENERATED_CONTEXT prior answer',complete=true)=>conversations.append(undefined,{question:'Generated earlier question'}, {...reply(answer),evidenceDependencies:{version:1,complete,ids:[chunk]}}).conversationId;
 return {node,calls,parent,chunk,text,conversations,save,set respond(value:typeof respond){respond=value;}};
}

test('recording-derived dialogue and working compaction use either configured model',async t=>{
 const f=await fixture(t),id=f.save();
 for(const modelProfileId of ['env:deployment','local']){
  const response=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated followup',conversationId:id,modelProfileId}});
  assert.equal(response.statusCode,200,response.body);assert.match(f.calls.at(-1)!.conversation!.turns[0].answer,/GENERATED_CONTEXT/);
 }
 const longId=f.save('GENERATED_CONTEXT '.repeat(5000)),before=f.calls.length;
 const compact=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated long followup',conversationId:longId}});
 assert.equal(compact.statusCode,200,compact.body);const summaries=f.calls.slice(before).filter(call=>call.skill==='working-memory');
 assert.ok(summaries.length>1,'the actual long-answer span path ran');assert.ok(summaries.every(call=>call.contextEvidenceDependencies?.ids.includes(f.parent.id)));
 assert.ok(f.node.working.get(f.conversations.get(longId))?.evidenceDependencies?.ids.includes(f.parent.id));
});

test('incomplete history fails closed and queued derived dialogue rechecks source revocation',async t=>{
 const f=await fixture(t),legacyId=f.save('Generated unknown-lineage answer',false);
 const legacy=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated legacy followup',conversationId:legacyId}});
 assert.equal(legacy.statusCode,409,legacy.body);assert.equal(legacy.json().error,'context_lineage_incomplete');assert.match(legacy.json().message,/新建对话/);assert.equal(f.calls.length,0);
 const context=f.node.working.context(f.conversations.get(f.save()),f.node.lifecycle.settings());
 const gate=f.node.featureServices.agentGate,limit=gate.snapshot().limit;
 let release!:()=>void,entered!:()=>void,n=0;const held=new Promise<void>(resolve=>release=resolve),full=new Promise<void>(resolve=>entered=resolve);
 const occupying=Array.from({length:limit},()=>gate.run(async()=>{if(++n===limit)entered();await held;}));await full;
 const queued=f.node.agent.query({question:'Generated queued history',conversation:context});
 assert.equal(gate.snapshot().waiting,1);f.node.store.db.prepare('UPDATE source_heads SET deleted=1 WHERE source_id=? AND external_id=?').run('generated-context-files','recording');release();await Promise.all(occupying);
 await assert.rejects(queued,/context_evidence_restricted/);assert.equal(f.calls.length,0,'queued history was never sent after its source was revoked');
});

test('opening-memory originals enter saved answer lineage and fence even when the model emits zero citations',async t=>{
 const f=await fixture(t);
 const original=f.node.memories.readEvidence([f.chunk])[0];
 f.node.memories.extract(fixtureMemoryResult(f.node.memories,{...reply(JSON.stringify({memories:[{title:'Generated memory',statement:`Generated decision [${f.chunk}]`,uncertainty:'Generated fixture',evidenceIds:[f.chunk]}]})),citations:[{id:f.chunk,capturedAt:original.capturedAt,appName:original.appName,excerpt:f.text}]}),'fixture');
 const first=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated decision'}});assert.equal(first.statusCode,200,first.body);
 assert.ok(f.calls[0].openingMemories?.length);assert.equal(first.json().citations.length,0);assert.equal(first.json().evidenceDependencies.complete,true);assert.ok(first.json().evidenceDependencies.ids.includes(f.parent.id));
 const saved=f.conversations.get(first.json().conversationId);assert.ok(saved.turns[0].result!.evidenceDependencies?.ids.includes(f.chunk));
 // An unrelated deletion is permitted because this answer has complete lineage.
 const unrelated=randomUUID();await f.node.store.ingest({id:unrelated,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-09-27T00:00:00Z',durationMs:0,ocrText:'Generated unrelated evidence'});
 f.respond=async()=>{f.node.store.delete(unrelated);return reply();};
 const safe=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated unrelated deletion'}});assert.equal(safe.statusCode,200,safe.body);
 f.respond=async()=>{f.node.store.delete(f.parent.id);return reply('Generated answer using removed opening lead');};
 const denied=await f.node.app.inject({method:'POST',url:'/api/query',headers,payload:{question:'Generated removal overlap'}});assert.equal(denied.statusCode,409,denied.body);
 const failed=f.conversations.list().items.find(item=>item.title==='Generated removal overlap')!;
 const removed=f.conversations.get(failed.id);assert.ok(removed.turns.every(turn=>!turn.result),'answer derived from removed lead cannot commit');
});
