import {fixtureMemoryResult} from './fixtures/memory-result.js';
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
import {resolveDependencies} from '../src/conversation-lineage.js';
import {MaterialStore,materialId} from '../src/materials.js';

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

test('set traversal preserves cross-graph file, Memory and Material ancestors through a cycle',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-lineage-cross-cycle-')),store=new Store(directory),materials=new MaterialStore(store);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const raw=randomUUID(),at='2026-10-01T00:00:00Z';await store.ingest({id:raw,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:at,durationMs:0,ocrText:'Generated cross-source support.'});
 const material=materials.publish({id:materialId('generated-cycle','body'),kind:'mote.note',schemaVersion:1,title:'Generated cycle original',origin:{sourceId:'generated-cycle',externalId:'body',deviceId:'generated'},members:[{id:raw,kind:'capture',ref:'capture:'+raw}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated cross-source support.',memberIds:[raw]}],coverage:{state:'complete'},fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 const anchor=materials.evidenceIds(material.ref)[0],memories=new MemoryStore(store,ids=>[...store.evidence(ids),...materials.evidence(ids)],id=>store.isCurrentEvidence(id)||materials.isCurrentEvidence(id));
 const memory=memories.extract(fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Generated cross-source claim',statement:`Generated support [${anchor}]`,uncertainty:'Generated only',evidenceIds:[anchor],evidence:[{id:anchor,quote:'Generated cross-source support.'}]}]}),citations:[{id:anchor,capturedAt:at,appName:'Generated',excerpt:''}],trace:[],runId:randomUUID()}),'generated').items[0];
 const graph=randomUUID(),file=randomUUID(),artifact='a'.repeat(64);
 store.archive.enableMaterialLineage();
 store.db.exec('CREATE TABLE generated_lineage_edges(parent_id TEXT,child_id TEXT); DROP VIEW evidence_dependency_edges; CREATE VIEW evidence_dependency_edges AS SELECT parent_id,child_id FROM generated_lineage_edges UNION ALL SELECT evidence_id,anchor_id FROM material_evidence_dependencies;');
 for(const [parent,child] of [[file,graph],[artifact,graph],[graph,anchor]])store.db.prepare('INSERT INTO generated_lineage_edges VALUES(?,?)').run(parent,child);
 store.db.prepare('INSERT INTO file_evidence_links(parent_id,capture_id) VALUES(?,?)').run(memory.id,file);
 const current=store.archive.save(artifact,artifact,'generated',{kind:'generated',text:'Generated interpretation',metadata:{}},[],'generated','1','generated',[],[],[{ref:material.ref,offset:0,length:30}]);
 assert.equal(current.id,artifact);
 const resolved=resolveDependencies(store,{version:1,complete:true,ids:[graph]})!;
 assert.deepEqual(new Set(resolved.ids),new Set([graph,file,artifact,memory.id,anchor,raw]));assert.equal(resolved.complete,true);
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
 assert.ok(updatedA.turns.every(turn=>operation==='revise'?turn.evidenceStale&&!turn.evidenceDeleted&&turn.result?.answer==='Generated derived answer':turn.evidenceDeleted));assert.equal(updatedA.turns[1].id,a2.turnId);assert.equal(working.get(updatedA),undefined);
 assert.equal(conversations.get(legacy.conversationId).turns[0][operation==='revise'?'evidenceStale':'evidenceDeleted'],true);
 assert.deepEqual(updatedB,beforeB);assert.deepEqual(working.get(updatedB),summaryB);
});

test('a disclosed memory resolves all original ancestors before deletion cascades erase its lineage',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-lineage-derived-')),store=new Store(directory),memories=new MemoryStore(store),conversations=new Conversations(store);installEvidenceDependencies(store);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const id=randomUUID();await store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',appId:'fixture',appName:'Fixture',capturedAt:'2026-09-01T10:00:00Z',durationMs:0,ocrText:'Synthetic useful decision.',privacy:{excluded:false,redacted:false,mode:'none'}});
 const memory=memories.extract(fixtureMemoryResult(memories,{answer:JSON.stringify({memories:[{title:'Decision',statement:`Decision [${id}]`,uncertainty:'Fixture',evidenceIds:[id],evidence:[{id,quote:'Synthetic useful decision.'}]}]}),citations:[{id,capturedAt:'2026-09-01T10:00:00Z',appName:'Fixture',excerpt:''}],trace:[],runId:'fixture'}),'fixture').items[0];
 const saved=conversations.append(undefined,{question:'Read memory overview without citing the original'},answer([memory.id]));
 assert.ok(conversations.get(saved.conversationId).turns[0].result!.evidenceDependencies!.ids.includes(id));
 store.delete(id);assert.equal(conversations.get(saved.conversationId).turns[0].evidenceDeleted,true);
});
