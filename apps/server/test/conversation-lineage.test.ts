import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {Conversations} from '../src/conversations.js';
import {WorkingMemory} from '../src/working-memory.js';
import {defaultLifecycleSettings} from '../src/memory-lifecycle.js';
import {MemoryStore} from '../src/memory.js';
import {installEvidenceDependencies} from '../src/evidence-dependencies.js';
import type {EvidenceDependencies,QueryResult} from '@mote/shared';
import {QueryRuns} from '../src/query-runs.js';
import {resolveDependencies} from '../src/conversation-lineage.js';

const answer=(ids?:string[]):QueryResult=>({answer:'Generated derived answer',citations:[],trace:[],runId:randomUUID(),...(ids?{evidenceDependencies:{version:1,complete:true,ids} as EvidenceDependencies}:{})});
test('lightweight stores recursively resolve derived ancestors and stop at cycles',t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-lineage-fallback-')),store=new Store(directory);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const ids=[randomUUID(),randomUUID(),randomUUID()];
 assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='evidence_dependency_edges'").get(),undefined);
 const insert=store.db.prepare('INSERT INTO file_evidence_links(parent_id,capture_id) VALUES(?,?)');
 insert.run(ids[1],ids[0]);insert.run(ids[2],ids[1]);insert.run(ids[0],ids[2]);
 assert.deepEqual(new Set(resolveDependencies(store,{version:1,complete:true,ids:[ids[0]]})!.ids),new Set(ids));
});
for(const operation of ['delete','prune','revise'] as const)test(`${operation} invalidates uncited reads and summaries in A while independent B survives`,async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-lineage-')),store=new Store(directory),conversations=new Conversations(store),working=new WorkingMemory(store,conversations);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const ids=[randomUUID(),randomUUID()];
 for(const [index,id] of ids.entries())await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',appId:'fixture',appName:'Fixture',capturedAt:`2026-09-${index?'20':'01'}T10:00:00Z`,durationMs:0,ocrText:'Synthetic original '+index,privacy:{excluded:false,redacted:false,mode:'none'}});
 const a=conversations.append(undefined,{question:'Question A'},answer([ids[0]])),b=conversations.append(undefined,{question:'Question B'},answer([ids[1]]));
 const legacy=conversations.append(undefined,{question:'Legacy question'},answer());
 const a2=conversations.append(conversations.get(a.conversationId),{question:'Follow-up A'},answer(conversations.context(conversations.get(a.conversationId)).evidenceDependencies!.ids));
 for(const id of [a.conversationId,b.conversationId,legacy.conversationId])await working.compact(id,{...defaultLifecycleSettings,recentTurns:0},async()=>answer());
 const beforeB=conversations.get(b.conversationId),summaryB=working.get(beforeB);
 assert.ok(summaryB?.evidenceDependencies?.ids.includes(ids[1]));
 if(operation==='delete')store.delete(ids[0]);else if(operation==='prune')store.prune('2026-09-10T00:00:00Z');else store.invalidateMemoryEvidence(ids[0]);
 const updatedA=conversations.get(a.conversationId),updatedB=conversations.get(b.conversationId);
 assert.ok(updatedA.turns.every(turn=>turn.evidenceDeleted));assert.equal(updatedA.turns[1].id,a2.turnId);assert.equal(working.get(updatedA),undefined);
 assert.equal(conversations.get(legacy.conversationId).turns[0].evidenceDeleted,true);
 assert.deepEqual(updatedB,beforeB);assert.deepEqual(working.get(updatedB),summaryB);
});

test('a disclosed memory resolves all original ancestors before deletion cascades erase its lineage',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-lineage-derived-')),store=new Store(directory),memories=new MemoryStore(store),conversations=new Conversations(store);installEvidenceDependencies(store);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID();await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',appId:'fixture',appName:'Fixture',capturedAt:'2026-09-01T10:00:00Z',durationMs:0,ocrText:'Synthetic useful decision.',privacy:{excluded:false,redacted:false,mode:'none'}});
 const memory=memories.extract({answer:JSON.stringify({memories:[{title:'Decision',statement:`Decision [${id}]`,uncertainty:'Fixture',evidenceIds:[id],evidence:[{id,quote:'Synthetic useful decision.'}]}]}),citations:[{id,capturedAt:'2026-09-01T10:00:00Z',appName:'Fixture',excerpt:''}],trace:[],runId:'fixture'},'fixture').items[0];
 const saved=conversations.append(undefined,{question:'Read memory overview without citing the original'},answer([memory.id]));
 assert.ok(conversations.get(saved.conversationId).turns[0].result!.evidenceDependencies!.ids.includes(id));
 store.delete(id);assert.equal(conversations.get(saved.conversationId).turns[0].evidenceDeleted,true);
});

test('completed query progress uses the saved turn lineage and preserves an unrelated run',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-lineage-progress-')),store=new Store(directory),conversations=new Conversations(store),runs=new QueryRuns(store);
 t.after(async()=>{await runs.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const ids=[randomUUID(),randomUUID()],runIds=[randomUUID(),randomUUID()];
 for(const [index,id] of ids.entries()){
  await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',appId:'fixture',appName:'Fixture',capturedAt:'2026-09-01T10:00:00Z',durationMs:0,ocrText:'Synthetic '+index,privacy:{excluded:false,redacted:false,mode:'none'}});
  await runs.perform(runIds[index],{question:'Synthetic'},async observe=>{observe({stage:'model',message:'Generated progress '+index});return ()=>conversations.append(undefined,{question:'Synthetic'},answer([id]));});
 }
 store.delete(ids[0]);
 assert.ok(runs.get(runIds[0]).events.every(event=>event.message===undefined));
 assert.ok(runs.get(runIds[1]).events.some(event=>event.message==='Generated progress 1'));
});
