import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {Store} from '../src/store.js';
import {Conversations} from '../src/conversations.js';
import {EvidenceExposurePolicy} from '../src/evidence-exposure.js';
import {materialId} from '../src/materials.js';
import {withFixtureOwnerModelWork} from './fixtures/model-authorization.js';

const token='generated-retirement-owner',headers={authorization:`Bearer ${token}`};
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:50_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'});
async function fixture(t:import('node:test').TestContext){
 const dir=await mkdtemp(join(tmpdir(),'mote-retired-authority-')),seen:QueryInput[]=[];let outputIds:string[]=[];
 const node=await buildApp(config(dir),{backgroundWorker:false,agent:{configured:true,close:async()=>{},query:async input=>{seen.push(input);return {answer:'GENERATED SAVED ANSWER',citations:outputIds.map(id=>({id,capturedAt:'2026-10-01T00:00:00Z',appName:'Generated source',excerpt:'GENERATED SAVED EXCERPT'})),trace:[{tool:'evidence',arguments:{ids:outputIds,offset:0,length:20,query:'GENERATED PRIVATE TOOL QUERY',ownerDescription:'GENERATED PRIVATE TOOL DECLARATION'},count:outputIds.length}],runId:randomUUID(),evidenceDependencies:{version:1 as const,complete:true,ids:outputIds}};}}});
 t.after(async()=>{await node.app.close();await rm(dir,{recursive:true,force:true});});
 const add=async()=>{const id=randomUUID();await node.store.ingest({id,deviceId:'generated',deviceName:'Generated',platform:'import',source:'note',capturedAt:'2026-10-01T00:00:00Z',durationMs:0,ocrText:'GENERATED ORIGINAL BODY'});return id;};
 const query=(payload:Record<string,unknown>)=>node.app.inject({method:'POST',url:'/api/query',headers,payload});
 return {node,seen,add,query,ids:(ids:string[])=>{outputIds=ids;}};
}

test('strict selected history preserves its scope after partial and complete ordinary deletion without fresh discovery',async t=>{
 const {node,seen,add,query,ids}=await fixture(t),a=await add(),b=await add();ids([a,b]);
 const first=await query({question:'Generated selected question',evidenceIds:[a,b]});assert.equal(first.statusCode,200,first.body);const conversationId=first.json().conversationId;
 node.store.delete(a);ids([b]);
 const partial=await query({question:'Continue with the old selection',conversationId});assert.equal(partial.statusCode,200,partial.body);
 assert.deepEqual(seen.at(-1)!.evidenceIds,[b]);assert.deepEqual(seen.at(-1)!.historicalSelection,{evidenceIds:[a,b]});assert.match(JSON.stringify(seen.at(-1)!.conversation),/GENERATED SAVED ANSWER/);
 assert.deepEqual(node.conversations.get(conversationId).scope.evidenceIds,[a,b]);
 node.store.delete(b);ids([]);
 const complete=await query({question:'Explain the saved answer without originals',conversationId});assert.equal(complete.statusCode,200,complete.body);
 const input=seen.at(-1)!;assert.deepEqual(input.evidenceIds,[]);assert.equal(input.hostRetrieval,'none');assert.deepEqual(input.openingMemories,[]);assert.deepEqual(input.historicalSelection,{evidenceIds:[a,b]});
 assert.deepEqual(node.conversations.get(conversationId).scope.evidenceIds,[a,b]);
 for(const id of [a,b])assert.equal((await node.app.inject({url:`/api/conversations/${conversationId}/references/${id}`,headers})).json().available,false);
 const count=seen.length,missing=randomUUID();
 const unknown=await query({question:'Unknown identity is not retirement proof',conversationId,evidenceIds:[a,b,missing]});assert.equal(unknown.statusCode,409,unknown.body);assert.equal(seen.length,count);
 const outside=await query({question:'Another conversation cannot borrow the receipt',evidenceIds:[a]});assert.equal(outside.statusCode,409,outside.body);assert.equal(seen.length,count);
 node.store.invalidateConversationAnswers([b],true);
 const forgotten=await query({question:'Explicit forget is not ordinary retirement',conversationId});assert.equal(forgotten.statusCode,409,forgotten.body);assert.equal(seen.length,count);
 const expanded=await query({question:'Owner explicitly clears the scope',conversationId,evidenceIds:null});assert.equal(expanded.statusCode,200,expanded.body);assert.equal(seen.at(-1)!.evidenceIds,undefined);assert.doesNotMatch(JSON.stringify(seen.at(-1)!.conversation),/GENERATED SAVED ANSWER/);
});

test('ordinary receipts are transactional, exact to turn and run, body-free, and survive SQLite backup',async t=>{
 const {node,add,query,ids}=await fixture(t),id=await add();ids([id]);
 const first=await query({question:'Generated receipt question'});assert.equal(first.statusCode,200,first.body);const conversationId=first.json().conversationId,db=node.store.db,conversations=node.conversations;
 const before=conversations.get(conversationId);db.exec("CREATE TRIGGER generated_delete_failure BEFORE DELETE ON captures BEGIN SELECT RAISE(ABORT,'generated deletion rollback'); END");
 assert.throws(()=>node.store.delete(id),/generated deletion rollback/);assert.deepEqual(conversations.get(conversationId),before);assert.equal(db.prepare('SELECT count(*) n FROM conversation_retired_roots').get()!.n,0);
 db.exec('DROP TRIGGER generated_delete_failure');node.store.delete(id);node.store.delete(id);
 assert.equal(db.prepare('SELECT count(*) n FROM conversation_retired_roots').get()!.n,1);assert.equal(db.prepare('SELECT count(*) n FROM conversation_retired_turn_roots').get()!.n,1);
 const saved=conversations.get(conversationId),snapshot=conversations.historyContext(saved);assert.deepEqual([...conversations.assertHistoryContext(snapshot)],[id]);
 assert.match(JSON.stringify(saved),/GENERATED SAVED ANSWER.*GENERATED SAVED EXCERPT/);assert.doesNotMatch(JSON.stringify(saved),/GENERATED PRIVATE TOOL/);
 assert.deepEqual(saved.turns[0].result!.trace,[{tool:'evidence',arguments:{ids:[id],offset:0,length:20},count:1}]);
 assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM conversation_retired_roots').all()),/GENERATED ORIGINAL BODY|GENERATED SAVED|GENERATED PRIVATE/);
 assert.throws(()=>conversations.assertHistoryContext({...snapshot,revision:snapshot.revision+1}),/Conversation changed/);
 assert.throws(()=>conversations.assertHistoryContext({...snapshot,turns:[{...snapshot.turns[0],runId:randomUUID()}]}),/lineage changed/);
 assert.throws(()=>conversations.assertHistoryContext({...snapshot,evidenceDependencies:{version:1,complete:true,ids:[]}}),/lineage changed/);
 const dir=await mkdtemp(join(tmpdir(),'mote-retirement-backup-'));t.after(()=>rm(dir,{recursive:true,force:true}));db.prepare('VACUUM INTO ?').run(join(dir,'mote.sqlite'));
 const restored=new Store(dir);try{const restoredConversations=new Conversations(restored);assert.deepEqual([...restoredConversations.assertHistoryContext(snapshot)],[id]);assert.equal(restoredConversations.referenceAvailability(conversationId,id).available,false);assert.equal(restored.evidence([id]).length,0);restoredConversations.delete(conversationId);assert.equal(restored.db.prepare('SELECT count(*) n FROM conversation_retired_roots').get()!.n,0);}finally{restored.close();}
});

test('mixed ordinary, missing, revoked and explicitly forgotten roots never become a partial history permission',async t=>{
 const {node,add,query,ids,seen}=await fixture(t),a=await add(),b=await add();ids([a,b]);
 const first=await query({question:'Generated mixed history'});assert.equal(first.statusCode,200,first.body);const conversationId=first.json().conversationId,conversations=node.conversations;
 node.store.delete(a);const current=conversations.get(conversationId),snapshot=conversations.historyContext(current),proofs=conversations.assertHistoryContext(snapshot),reader=node.featureServices.evidenceReader;
 assert.equal(reader.contextDependenciesAllowed(snapshot.evidenceDependencies.ids,undefined,true,proofs),true);
 assert.equal(reader.contextDependenciesAllowed(snapshot.evidenceDependencies.ids,new EvidenceExposurePolicy([{sourceKind:'note',allow:false}]),true,proofs),false,'current exposure restriction applies to the stored identity scope');
 assert.equal(reader.contextDependenciesAllowed([...snapshot.evidenceDependencies.ids,randomUUID()],undefined,true,proofs),false,'one valid ordinary root never excuses an unknown root');
 node.store.db.prepare('DELETE FROM captures WHERE id=?').run(b);
 const count=seen.length;await assert.rejects(withFixtureOwnerModelWork(node,()=>node.featureServices.queryAgent({question:'Missing is not an ordinary receipt',conversation:conversations.context(current)})),/context|permitted|restricted/i);assert.equal(seen.length,count);
 node.store.invalidateConversationAnswers([b],true);assert.ok(conversations.get(conversationId).turns[0].evidenceDeleted);assert.doesNotMatch(JSON.stringify(conversations.context(conversations.get(conversationId))),/GENERATED SAVED/);
});

test('retained source identity cannot bypass a later source exposure revocation at model entry',async t=>{
 const {node,query,ids,seen}=await fixture(t),sourceId='generated-retired-source';
 node.sources.register({id:sourceId,name:'Generated source',kind:'custom',deviceId:'generated',platform:'import'});
 const original=await node.sources.upsert(sourceId,{externalId:'generated-source-original',revision:'1',observedAt:'2026-10-01T00:00:00Z',text:'Generated source body',kind:'message',layer:'snapshot'});await node.materialOrganizer.tick();ids([original.id]);
 const first=await query({question:'Generated source question'});assert.equal(first.statusCode,200,first.body);const conversationId=first.json().conversationId;
 node.store.delete(original.id);ids([]);const follow=await query({question:'Continue ordinary history',conversationId});assert.equal(follow.statusCode,200,follow.body);
 node.materialOrganizer.sourceItemRecipes.registry.uninstallComponent('mote.source-item-exposure');
 const count=seen.length,blocked=await query({question:'No retired grant can override revoked source exposure',conversationId});assert.equal(blocked.statusCode,409,blocked.body);assert.equal(seen.length,count);
});

for(const removal of ['physical','tombstone'] as const)test(`a ${removal} deletion retains its exact formal citation when the organizer subsequently retires the material`,async t=>{
 const {node,query,ids}=await fixture(t),sourceId='generated-formal-deletion',externalId='generated-formal-original';
 node.sources.register({id:sourceId,name:'Generated formal source',kind:'custom',deviceId:'generated',platform:'import'});
 const original=await node.sources.upsert(sourceId,{externalId,revision:'1',observedAt:'2026-10-01T00:00:00Z',text:'Generated original formal text',kind:'message',layer:'snapshot'});await node.materialOrganizer.tick();
 const material=node.materials.get(materialId(sourceId,externalId))!,anchors=node.materials.evidenceIds(material.ref);assert.ok(anchors.length);ids([original.id,...anchors]);
 const first=await query({question:'Generated formal citation question'});assert.equal(first.statusCode,200,first.body);const conversationId=first.json().conversationId;
 if(removal==='physical')node.store.delete(original.id);else await node.sources.upsert(sourceId,{externalId,revision:'2',observedAt:'2026-10-02T00:00:00Z',text:'',deleted:true,kind:'message',layer:'snapshot'});
 await node.materialOrganizer.tick();ids([]);
 const saved=node.conversations.get(conversationId);assert.equal(saved.turns[0].evidenceDeleted,undefined);assert.equal(saved.turns[0].evidenceUnavailable,true);
 for(const id of anchors)assert.equal(node.conversations.referenceAvailability(conversationId,id).available,false);
 const next=await query({question:'Continue the saved formal discussion',conversationId});assert.equal(next.statusCode,200,next.body);
 node.materials.forget(material.id);assert.ok(node.conversations.get(conversationId).turns.filter(turn=>turn.result).every(turn=>turn.evidenceDeleted));
});
