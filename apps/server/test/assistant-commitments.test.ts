import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {QueryResult,QueryScope} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';
import {AssistantCommitments,type CommitmentProposal} from '../src/assistant-commitments.js';
import {AssistantMatters} from '../src/assistant-matters.js';
import {AssistantUnderstandingReader} from '../src/assistant-understanding.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {ProcessingRuntime} from '../src/processing-runtime.js';
import {semanticProcessor} from '../src/semantic-extraction.js';
import {Store,StoreError} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {EvidenceReader} from '../src/evidence-reader.js';
import {TodoStore} from '../src/todos.js';
import {UsageLedger} from '../src/usage.js';
import {fixtureMemoryResult} from './fixtures/memory-result.js';

const all:QueryScope={kind:'all'};
const at='2026-10-01T10:00:00Z';
const headers={authorization:'Bearer generated-commitment-owner'};
const conflict=(error:unknown)=>error instanceof StoreError&&error.statusCode===409;
const missing=(error:unknown)=>error instanceof StoreError&&error.statusCode===404;

async function fixture(t:TestContext){
 const dataDir=mkdtempSync(join(tmpdir(),'mote-commitments-'));
 const config:Config={dataDir,token:'generated-commitment-owner',tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30000000,maxExportBytes:1000000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',logLevel:'silent'};
 const node=await buildApp(config,{backgroundWorker:false,agent:{configured:false,query:async()=>{throw Error('Unexpected model call');},close:async()=>{}}});
 await node.app.ready();t.after(async()=>{await node.app.close();rmSync(dataDir,{recursive:true,force:true});});
 let now='2026-10-01T12:00:00Z';
 const commitments=new AssistantCommitments(node.store,node.featureServices.evidenceReader,()=>now);
 const capture=async(body:string)=>{
  const id=randomUUID(),response=await node.app.inject({method:'POST',url:'/api/notes',headers,payload:{id,deviceId:'generated-device',deviceName:'Generated',platform:'import',capturedAt:at,text:body}});
  assert.equal(response.statusCode,201,response.body);return {id,body};
 };
 const memory=(source:{id:string;body:string})=>{
  const result:QueryResult={answer:JSON.stringify({memories:[{title:'Alex',statement:`Alex: ${source.body} [${source.id}]`,uncertainty:'Generated identity',evidenceIds:[source.id]}]}),
   citations:[{id:source.id,capturedAt:at,appName:'Generated',excerpt:source.body}],trace:[],runId:randomUUID()};
  const draft=node.memories.extract(fixtureMemoryResult(node.memories,result),'generated').items[0]!;
  return node.memories.publish(draft.id,draft.version);
 };
 const proposal=(commitmentId:string,source:{id:string;body:string},kind:CommitmentProposal['kind'],changes:CommitmentProposal['changes'],summary=source.body):CommitmentProposal=>({
  commitmentId,eventId:randomUUID(),kind,occurredAt:null,summary,changes,evidence:[{id:source.id,quote:source.body,offset:0}],evidenceDependencies:{version:1,complete:true,ids:[source.id]},
 });
 return {node,commitments,capture,memory,proposal,setNow:(value:string)=>{now=value;}};
}

test('same-name people retain separate Memory identities, vague deadlines stay unknown, and a Todo or clock is not fulfillment',async t=>{
 const f=await fixture(t),a=await f.capture('Generated Alex from the studio makes a commitment.'),b=await f.capture('Generated Alex from the hiking group makes a commitment.');
 const personA=f.memory(a),personB=f.memory(b);assert.notEqual(personA.id,personB.id);
 const matters=new AssistantMatters(f.node.store),matter=matters.command({type:'create',requestId:randomUUID(),goal:'Generated shared matter',scope:all},{currentEvidence:()=>[],currentTask:()=>undefined});
 const todos=new TodoStore(f.node.store),todo=todos.create({title:'Generated reminder',evidenceIds:[a.id]});
 todos.update(todo.id,{version:todo.version,status:'completed'});
 const first=f.proposal(randomUUID(),a,'commitment',{title:'Send the plan',status:'confirmed',deadline:{text:'sometime soon',at:null},matterId:matter.id,personMemoryId:personA.id,todoId:todo.id});
 const second=f.proposal(randomUUID(),b,'commitment',{title:'Send the plan',status:'pending_confirmation',personMemoryId:personB.id});
 const one=f.commitments.publish(first,undefined,all,()=>{}),two=f.commitments.publish(second,undefined,all,()=>{});
 assert.notEqual(one.id,two.id);assert.equal(one.personMemoryId,personA.id);assert.equal(two.personMemoryId,personB.id);
 assert.equal(one.dueState,'unknown');assert.equal(one.deadline?.at,null);assert.equal(one.todoId,todo.id);assert.equal(one.matterId,matter.id);
 assert.deepEqual(f.commitments.page({scope:all,personMemoryId:personA.id}).items.map(item=>item.id),[one.id]);
 assert.deepEqual(f.commitments.page({scope:all,matterId:matter.id}).items.map(item=>item.id),[one.id]);
 f.setNow('2027-10-01T12:00:00Z');assert.equal(f.commitments.get(one.id,all).status,'confirmed');assert.equal(f.commitments.get(one.id,all).dueState,'unknown');
 const reminder=await f.capture('Generated reminder says completed but is only a reminder.');
 const reminded=f.commitments.publish(f.proposal(one.id,reminder,'reminder',{}),one.revision,all,()=>{});
 assert.equal(reminded.status,'confirmed');
 assert.throws(()=>f.commitments.publish(f.proposal(one.id,reminder,'reminder',{status:'completed'}),reminded.revision,all,()=>{}));
 assert.equal(f.commitments.get(one.id,all).status,'confirmed');
 assert.ok(f.node.featureServices.assistantCommitments,'the service is available to downstream host consumers');
});

test('owner corrections target a particular assertion; cancellation and later fulfillment require their own evidence',async t=>{
 const f=await fixture(t),original=await f.capture('Generated promised plan with a vague time.'),correction=await f.capture('Generated owner says the deadline is Friday.'),progress=await f.capture('Generated proof the plan was delivered.'),cancel=await f.capture('Generated owner explicitly cancels the second agreement.');
 const initial=f.proposal(randomUUID(),original,'commitment',{title:'Generated plan',status:'confirmed',deadline:{text:'soon',at:null}});
 const created=f.commitments.publish(initial,undefined,all,()=>{});
 const owner={commitmentId:created.id,eventId:randomUUID(),targetEventId:initial.eventId,occurredAt:null,summary:correction.body,
  changes:{deadline:{text:'Friday',at:'2026-10-02T10:00:00Z'}},evidence:[{id:correction.id,quote:correction.body,offset:0}],evidenceDependencies:{version:1 as const,complete:true,ids:[correction.id]}};
 const corrected=f.commitments.correct(owner,created.revision,all,()=>{});
 assert.equal(corrected.deadline?.text,'Friday');assert.equal(corrected.dueState,'upcoming');
 assert.ok(corrected.timeline.at(-1)!.evidenceDependencies.ids.includes(original.id),'the correction carries its target lineage');
 assert.ok(corrected.evidenceDependencies.ids.includes(correction.id));
 assert.throws(()=>f.commitments.publish(f.proposal(created.id,progress,'progress',{status:'completed'}),created.revision,all,()=>{}),conflict,'a late result cannot overwrite an owner correction');
 assert.throws(()=>f.commitments.publish(f.proposal(created.id,progress,'progress',{deadline:{text:'soon',at:null}}),corrected.revision,all,()=>{}),conflict,
  'a proposal cannot change a corrected field without reading the correction and its lineage');
 f.setNow('2026-10-03T12:00:00Z');assert.equal(f.commitments.get(created.id,all).dueState,'overdue');assert.equal(f.commitments.get(created.id,all).status,'confirmed');
 const fulfilled=f.commitments.publish(f.proposal(created.id,progress,'progress',{status:'completed'}),corrected.revision,all,()=>{});
 assert.equal(fulfilled.status,'completed');assert.equal(fulfilled.dueState,'closed');assert.equal(fulfilled.deadline?.text,'Friday');
 const second=f.proposal(randomUUID(),original,'commitment',{title:'Generated other agreement'}),other=f.commitments.publish(second,undefined,all,()=>{});
 const cancelled=f.commitments.publish(f.proposal(other.id,cancel,'status',{status:'cancelled'}),other.revision,all,()=>{});
 assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.timeline.at(-1)?.summary,cancel.body);
 assert.throws(()=>f.commitments.correct({...owner,eventId:randomUUID(),targetEventId:randomUUID()},fulfilled.revision,all,()=>{}),conflict);

 const response=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+progress.id,headers});assert.equal(response.statusCode,200,response.body);
 const after=f.commitments.get(created.id,all);assert.equal(after.status,'confirmed');assert.equal(after.dueState,'overdue');assert.equal(after.deadline?.text,'Friday');
 assert.deepEqual(after.timeline.map(item=>item.eventId),[initial.eventId,owner.eventId]);
 assert.equal(f.commitments.get(other.id,all).status,'cancelled','unrelated timeline remains intact');
 assert.equal(f.node.store.db.prepare('SELECT private_json FROM assistant_commitment_events WHERE event_id=?').get(fulfilled.timeline.at(-1)!.eventId)!.private_json,null);
 assert.throws(()=>f.commitments.publish(f.proposal(created.id,original,'progress',{status:'completed'}),fulfilled.revision,all,()=>{}),conflict,'evidence retirement changes the revision');
 const deleted=await f.node.app.inject({method:'DELETE',url:'/api/captures/'+correction.id,headers});assert.equal(deleted.statusCode,200,deleted.body);
 const restored=f.commitments.get(created.id,all);assert.equal(restored.deadline?.text,'soon');assert.equal(restored.deadline?.at,null);assert.equal(restored.dueState,'unknown');
});

test('scope and current evidence gate every event, quotation, and cursor without leaking hidden timeline text',async t=>{
 const f=await fixture(t);
 f.node.sources.register({id:'generated-a',kind:'custom',name:'Generated A',deviceId:'device-a',platform:'import'});
 f.node.sources.register({id:'generated-b',kind:'custom',name:'Generated B',deviceId:'device-b',platform:'import'});
 const a=await f.node.sources.upsert('generated-a',{externalId:'a',revision:'1',observedAt:at,kind:'message',layer:'original',text:'GENERATED_ALLOWED_A'});
 const b=await f.node.sources.upsert('generated-b',{externalId:'b',revision:'1',observedAt:at,kind:'message',layer:'original',text:'GENERATED_HIDDEN_B'});
 const first=f.proposal(randomUUID(),{id:a.id,body:'GENERATED_ALLOWED_A'},'commitment',{title:'Generated scoped commitment'});
 const created=f.commitments.publish(first,undefined,all,()=>{});
 assert.throws(()=>f.commitments.publish({...f.proposal(created.id,{id:a.id,body:'GENERATED_ALLOWED_A'},'progress',{}),evidence:[{id:a.id,quote:'forged',offset:0}]},created.revision,all,()=>{}),conflict);
 const updated=f.commitments.publish(f.proposal(created.id,{id:b.id,body:'GENERATED_HIDDEN_B'},'progress',{}),created.revision,all,()=>{});
 const narrow={kind:'selection' as const,sourceIds:['generated-a']};
 assert.throws(()=>f.commitments.get(created.id,narrow),missing);
 assert.deepEqual(f.commitments.page({scope:narrow}).items,[]);
 assert.deepEqual(f.commitments.page({scope:{kind:'selection',sourceIds:[]}}).items,[]);
 assert.deepEqual(f.commitments.page({scope:{kind:'selection',evidenceIds:[]}}).items,[]);
 assert.throws(()=>f.commitments.publish(f.proposal(created.id,{id:b.id,body:'GENERATED_HIDDEN_B'},'progress',{}),updated.revision,narrow,()=>{}),missing);
 await f.node.sources.upsert('generated-b',{externalId:'b',revision:'2',observedAt:'2026-10-02T10:00:00Z',kind:'message',layer:'original',text:'GENERATED_REPLACEMENT_B'});
 const now=f.commitments.get(created.id,narrow);assert.equal(now.timeline.length,1);assert.doesNotMatch(JSON.stringify(now),/GENERATED_HIDDEN_B/);
 assert.throws(()=>f.commitments.publish(f.proposal(created.id,{id:b.id,body:'GENERATED_HIDDEN_B'},'progress',{}),now.revision,all,()=>{}),conflict);
 const another=f.proposal(randomUUID(),{id:a.id,body:'GENERATED_ALLOWED_A'},'commitment',{title:'Generated another'});f.commitments.publish(another,undefined,all,()=>{});
 const page=f.commitments.page({scope:all,limit:1});assert.ok(page.nextCursor);assert.equal(f.commitments.page({scope:all,limit:1,cursor:page.nextCursor!}).items.length,1);
 assert.throws(()=>f.commitments.page({scope:narrow,limit:1,cursor:page.nextCursor!}));
});

test('a newer owner correction outranks a proposal that was published before it',async t=>{
 const f=await fixture(t),original=await f.capture('Generated agreement with a vague deadline.'),later=await f.capture('Generated later agreement moves the deadline to Monday.'),correction=await f.capture('Generated owner corrects the original deadline to Friday.');
 const initial=f.proposal(randomUUID(),original,'commitment',{title:'Generated agreement',deadline:{text:'soon',at:null}}),created=f.commitments.publish(initial,undefined,all,()=>{});
 const newer={...f.proposal(created.id,later,'progress',{deadline:{text:'Monday',at:null}}),evidenceDependencies:{version:1 as const,complete:true,ids:[original.id,later.id]}};
 const updated=f.commitments.publish(newer,created.revision,all,()=>{});assert.equal(updated.deadline?.text,'Monday');
 const corrected=f.commitments.correct({commitmentId:created.id,eventId:randomUUID(),targetEventId:initial.eventId,occurredAt:null,summary:correction.body,
  changes:{deadline:{text:'Friday',at:null}},evidence:[{id:correction.id,quote:correction.body,offset:0}],evidenceDependencies:{version:1,complete:true,ids:[correction.id]}},updated.revision,all,()=>{});
 assert.equal(corrected.deadline?.text,'Friday','the newest owner correction must not be overridden by an earlier proposal');
});

test('a later proposal can use a correction and new evidence, and retires with the correction it read',async t=>{
 const f=await fixture(t),original=await f.capture('Generated agreement mentions a vague deadline.'),correction=await f.capture('Generated owner corrects the deadline to Friday.'),later=await f.capture('Generated later agreement moves the deadline to Monday.');
 const initial=f.proposal(randomUUID(),original,'commitment',{title:'Generated agreement',deadline:{text:'soon',at:null}}),created=f.commitments.publish(initial,undefined,all,()=>{});
 const corrected=f.commitments.correct({commitmentId:created.id,eventId:randomUUID(),targetEventId:initial.eventId,occurredAt:null,summary:correction.body,
  changes:{deadline:{text:'Friday',at:null}},evidence:[{id:correction.id,quote:correction.body,offset:0}],evidenceDependencies:{version:1,complete:true,ids:[correction.id]}},created.revision,all,()=>{});
 const newer={...f.proposal(created.id,later,'progress',{deadline:{text:'Monday',at:null}}),evidenceDependencies:{version:1 as const,complete:true,ids:[original.id,correction.id,later.id]}};
 const updated=f.commitments.publish(newer,corrected.revision,all,()=>{});assert.equal(updated.deadline?.text,'Monday');
 assert.ok(updated.timeline.at(-1)!.evidenceDependencies.ids.includes(correction.id));
 f.node.store.delete(correction.id);
 const after=f.commitments.get(created.id,all);assert.equal(after.deadline?.text,'soon');assert.equal(after.timeline.length,1);
 assert.equal(f.node.store.db.prepare('SELECT private_json FROM assistant_commitment_events WHERE event_id=?').get(newer.eventId)!.private_json,null);
});

test('the real Memory correction invalidates only the linked same-name person',async t=>{
 const f=await fixture(t),a=await f.capture('Generated Alex works at the studio.'),b=await f.capture('Generated Alex belongs to the hiking group.');
 const personA=f.memory(a),personB=f.memory(b),first=f.proposal(randomUUID(),a,'commitment',{title:'Generated studio promise',personMemoryId:personA.id}),second=f.proposal(randomUUID(),b,'commitment',{title:'Generated hiking promise',personMemoryId:personB.id});
 f.commitments.publish(first,undefined,all,()=>{});f.commitments.publish(second,undefined,all,()=>{});
 const result=await f.node.app.inject({method:'POST',url:`/api/memories/${personA.id}/correct`,headers,payload:{version:personA.version,title:'Alex',statement:'Generated owner correction for the studio person.'}});
 assert.equal(result.statusCode,200,result.body);
 assert.throws(()=>f.commitments.get(first.commitmentId,all),missing);
 assert.equal(f.commitments.get(second.commitmentId,all).personMemoryId,personB.id);
 assert.deepEqual(f.commitments.page({scope:all,personMemoryId:personB.id}).items.map(item=>item.id),[second.commitmentId]);
});

test('a proposal based on a correction retains the target source-context dependency',async t=>{
 const f=await fixture(t),first=await f.capture('Generated original agreement.'),note=await f.capture('Generated owner correction.'),newer=await f.capture('Generated later date.');
 f.node.sources.register({id:'generated-context',kind:'custom',name:'Generated context',deviceId:'device-c',platform:'import'});
 f.node.sources.updateContext('generated-context',{expectedVersion:0,description:'Generated attribution'});
 const pin=f.node.sources.contexts.identity('generated-context')!;
 const initial={...f.proposal(randomUUID(),first,'commitment',{title:'Generated agreement',deadline:{text:'soon',at:null}}),sourceContextDependencies:[pin]};
 const created=f.commitments.publish(initial,undefined,all,()=>{});
 const corrected=f.commitments.correct({commitmentId:created.id,eventId:randomUUID(),targetEventId:initial.eventId,occurredAt:null,summary:note.body,
  changes:{deadline:{text:'Friday',at:null}},evidence:[{id:note.id,quote:note.body,offset:0}],evidenceDependencies:{version:1,complete:true,ids:[note.id]}},created.revision,all,()=>{});
 assert.deepEqual(corrected.sourceContextDependencies,[pin]);
 const next={...f.proposal(created.id,newer,'progress',{deadline:{text:'Monday',at:null}}),evidenceDependencies:{version:1 as const,complete:true,ids:[first.id,note.id,newer.id]}};
 assert.throws(()=>f.commitments.publish(next,corrected.revision,all,()=>{}),conflict);
 const saved=f.commitments.publish({...next,sourceContextDependencies:[pin]},corrected.revision,all,()=>{});assert.equal(saved.deadline?.text,'Monday');
 f.node.sources.updateContext('generated-context',{expectedVersion:pin.version,description:'Generated corrected attribution'});
 assert.throws(()=>f.commitments.get(created.id,all),missing);
 assert.equal(f.node.store.db.prepare('SELECT stale FROM assistant_commitment_events WHERE event_id=?').get(next.eventId)!.stale,1);
});

test('uncited source context and a Todo changed during publication cannot escape the current scope',async t=>{
 const f=await fixture(t);
 f.node.sources.register({id:'generated-a',kind:'custom',name:'Generated A',deviceId:'device-a',platform:'import'});
 f.node.sources.register({id:'generated-b',kind:'custom',name:'Generated B',deviceId:'device-b',platform:'import'});
 const a=await f.node.sources.upsert('generated-a',{externalId:'a',revision:'1',observedAt:at,kind:'message',layer:'original',text:'Generated scoped proof'});
 const b=await f.node.sources.upsert('generated-b',{externalId:'b',revision:'1',observedAt:at,kind:'message',layer:'original',text:'Generated other proof'});
 f.node.sources.updateContext('generated-b',{expectedVersion:0,description:'Generated private context'});
 const pin=f.node.sources.contexts.identity('generated-b')!,proposal={...f.proposal(randomUUID(),{id:a.id,body:'Generated scoped proof'},'commitment',{title:'Generated contextual commitment'}),sourceContextDependencies:[pin]};
 assert.throws(()=>f.commitments.publish(proposal,undefined,{kind:'selection',sourceIds:['generated-a']},()=>{}),conflict);
 assert.throws(()=>f.commitments.publish(proposal,undefined,{kind:'all',deviceId:'device-a'},()=>{}),conflict);
 f.commitments.publish(proposal,undefined,all,()=>{});
 assert.throws(()=>f.commitments.get(proposal.commitmentId,{kind:'all',deviceId:'device-a'}),missing);
 f.node.sources.updateContext('generated-b',{expectedVersion:pin.version,description:'Generated revised context'});
 assert.throws(()=>f.commitments.get(proposal.commitmentId,all),missing);

 const todos=new TodoStore(f.node.store),todo=todos.create({title:'Generated linked task',evidenceIds:[a.id]});
 const pending=f.proposal(randomUUID(),{id:a.id,body:'Generated scoped proof'},'commitment',{title:'Generated late link',todoId:todo.id});
 assert.throws(()=>f.commitments.publish(pending,undefined,all,()=>{todos.update(todo.id,{version:todo.version,evidenceIds:[b.id]});}),conflict);
 assert.deepEqual(todos.get(todo.id).evidenceIds,[a.id],'failed publication rolls back an interleaved update in its transaction');
 assert.throws(()=>f.commitments.get(pending.commitmentId,all),missing);
 f.node.store.db.prepare('DELETE FROM source_connections WHERE id=?').run('generated-b');
 assert.equal(f.node.store.db.prepare('SELECT private_json FROM assistant_commitment_events WHERE event_id=?').get(proposal.eventId)!.private_json,null);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_commitment_evidence WHERE event_id=?').get(proposal.eventId)!.n,0);
 assert.equal(f.node.store.db.prepare('SELECT count(*) n FROM assistant_commitment_context WHERE event_id=?').get(proposal.eventId)!.n,0);
});

test('encrypted timeline survives restart and a maintenance-only writer erases just the deleted evidence',async t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'mote-commitment-private-'))),key='43'.repeat(32);
 let store=new Store(dir,{dataKey:key,contentEncryptionEnabled:true});
 t.after(()=>{try{store.close();}catch{}rmSync(dir,{recursive:true,force:true});});
 const source=async(body:string)=>{const id=randomUUID();await store.ingest({id,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:at,durationMs:0,ocrText:body});return {id,body};};
 const first=await source('GENERATED_PRIVATE_INITIAL'),second=await source('GENERATED_PRIVATE_PROGRESS');
 let reader=new EvidenceReader(store,new SourceStore(store)),service=new AssistantCommitments(store,reader);
 const initial:CommitmentProposal={commitmentId:randomUUID(),eventId:randomUUID(),kind:'commitment',occurredAt:null,summary:first.body,changes:{title:'GENERATED_PRIVATE_TITLE',status:'confirmed'},evidence:[{id:first.id,offset:0,quote:first.body}],evidenceDependencies:{version:1,complete:true,ids:[first.id]}};
 const created=service.publish(initial,undefined,all,()=>{});assert.equal(service.publish(structuredClone(initial),undefined,all,()=>{}).id,created.id);
 assert.throws(()=>service.publish({...initial,summary:'Different replay'},undefined,all,()=>{}),conflict);
 const progress:CommitmentProposal={...initial,eventId:randomUUID(),kind:'progress',summary:second.body,changes:{status:'completed'},evidence:[{id:second.id,offset:0,quote:second.body}],evidenceDependencies:{version:1,complete:true,ids:[second.id]}};
 service.publish(progress,created.revision,all,()=>{});
 const raw=String(store.db.prepare('SELECT private_json FROM assistant_commitment_events WHERE event_id=?').get(initial.eventId)!.private_json);
 assert.ok(raw.startsWith('aes:'));assert.doesNotMatch(raw,/GENERATED_PRIVATE_TITLE/);
 store.close();store=new Store(dir,{dataKey:key,maintenance:true});reader=new EvidenceReader(store,new SourceStore(store));service=new AssistantCommitments(store,reader);
 assert.equal(service.get(created.id,all).status,'completed');
 store.delete(second.id);
 assert.equal(service.get(created.id,all).status,'confirmed');
 assert.equal(store.db.prepare('SELECT private_json FROM assistant_commitment_events WHERE event_id=?').get(progress.eventId)!.private_json,null);
 assert.throws(()=>service.publish(progress,2,all,()=>{}),conflict,'a retired event ID cannot restore deleted text');
 assert.ok(store.db.prepare('SELECT private_json FROM assistant_commitment_events WHERE event_id=?').get(initial.eventId)!.private_json);
});

test('a signed page cursor continues after its anchor evidence is deleted',async t=>{
 const f=await fixture(t),older=await f.capture('Generated older evidence'),newer=await f.capture('Generated newer evidence');
 const first=f.proposal(randomUUID(),older,'commitment',{title:'Generated older'}),second=f.proposal(randomUUID(),newer,'commitment',{title:'Generated newer'});
 f.commitments.publish(first,undefined,all,()=>{});f.commitments.publish(second,undefined,all,()=>{});
 const page=f.commitments.page({scope:all,limit:1});assert.equal(page.items[0].id,second.commitmentId);assert.ok(page.nextCursor);
 await f.node.app.inject({method:'DELETE',url:'/api/captures/'+newer.id,headers});
 assert.deepEqual(f.commitments.page({scope:all,limit:1,cursor:page.nextCursor!}).items.map(item=>item.id),[first.commitmentId]);
});

test('a failed retirement rolls back both original deletion and timeline cleanup',async t=>{
 const f=await fixture(t),proof=await f.capture('Generated evidence for rollback.');
 const initial=f.proposal(randomUUID(),proof,'commitment',{title:'Generated rollback commitment'}),saved=f.commitments.publish(initial,undefined,all,()=>{});
 f.node.store.db.exec("CREATE TEMP TRIGGER generated_commitment_cleanup_failure BEFORE UPDATE OF stale ON assistant_commitment_events BEGIN SELECT RAISE(ABORT,'generated commitment cleanup failure'); END");
 assert.throws(()=>f.node.store.delete(proof.id),/generated commitment cleanup failure/);
 assert.equal(f.node.store.evidence([proof.id]).length,1);assert.deepEqual(f.commitments.get(saved.id,all),saved);
 f.node.store.db.exec('DROP TRIGGER generated_commitment_cleanup_failure');f.node.store.delete(proof.id);
 assert.throws(()=>f.commitments.get(saved.id,all),missing);
});

test('quota failure leaves no partial commitment or evidence rows',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-commitment-quota-'));let store=new Store(dir);
 const id=randomUUID(),body='Generated quota evidence';await store.ingest({id,deviceId:'generated-device',deviceName:'Generated',platform:'import',source:'note',capturedAt:at,durationMs:0,ocrText:body});
 new EvidenceReader(store,new SourceStore(store));const budget=store.logicalBytes()+1000;store.close();store=new Store(dir,{maxStorageBytes:budget});
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const service=new AssistantCommitments(store,new EvidenceReader(store,new SourceStore(store))),commitmentId=randomUUID(),eventId=randomUUID();
 const input:CommitmentProposal={commitmentId,eventId,kind:'commitment',occurredAt:null,summary:'Generated content '.repeat(300),changes:{title:'Generated quota'},evidence:[{id,quote:body,offset:0}],evidenceDependencies:{version:1,complete:true,ids:[id]}};
 store.db.exec('BEGIN IMMEDIATE');assert.throws(()=>service.publish(input,undefined,all,()=>{}),{statusCode:507});assert.equal(store.db.isTransaction,true);store.db.exec('COMMIT');
 assert.equal(store.db.prepare('SELECT count(*) n FROM assistant_commitments WHERE id=?').get(commitmentId)!.n,0);
 assert.equal(store.db.prepare('SELECT count(*) n FROM assistant_commitment_events WHERE event_id=?').get(eventId)!.n,0);
 assert.equal(store.db.prepare('SELECT count(*) n FROM assistant_commitment_evidence WHERE event_id=?').get(eventId)!.n,0);
});

test('the actual stored semantic producer and A5 reader provide original proof and full lineage to the commitment consumer',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'mote-commitment-understanding-')),store=new Store(dir),sources=new SourceStore(store),materials=new MaterialStore(store);
 const reader=new EvidenceReader(store,sources,undefined,undefined,undefined,materials),adapter=new AssistantUnderstandingReader(store,materials,reader);
 const runtime=new ProcessingRuntime(store,[],{},Date.now,undefined,materials),commitments=new AssistantCommitments(store,reader);
 t.after(async()=>{await runtime.close();store.close();rmSync(dir,{recursive:true,force:true});});
 sources.register({id:'generated-a',kind:'custom',name:'Generated A',deviceId:'device-a',platform:'import'});
 const body='Generated Alex will share the plan when ready.';
 const original=await sources.upsert('generated-a',{externalId:'note',revision:'1',observedAt:at,kind:'message',layer:'original',text:body});
 const material=materials.publish({id:materialId('generated-a','note'),kind:'mote.message',schemaVersion:1,title:'Generated note',origin:{sourceId:'generated-a',externalId:'note',deviceId:'device-a',firstAt:at,lastAt:at},
  blocks:[{id:'body',kind:'text',format:'plain',text:body,memberIds:['source']}],members:[{id:'source',kind:'capture',ref:'capture:'+original.id}],coverage:{state:'complete'},fidelity:{state:'derived'},retention:{original:'retained',policy:'keep'}});
 store.archive.aggregate();const segment=store.archive.page({kind:'segment'}).items.find(item=>item.members.includes(original.id))!;
 const proof=[{id:original.id,quote:body}],answer={summary:'Generated commitment',evidence:proof,events:[{statement:'Alex will share the plan',uncertainty:'No precise deadline',evidence:proof}],memoryCandidates:[],actionCues:[]};
 const model={owner:'models' as const,fingerprint:'a'.repeat(64),revision:1,profileId:'fixture',provider:'openai',model:'generated',configured:true};
 runtime.registry.register(semanticProcessor({store,memories:reader.memories,records:ids=>store.evidence(ids),selection:()=>model,usage:new UsageLedger(store),query:async()=>({answer:JSON.stringify(answer),citations:[{id:original.id,capturedAt:at,appName:'Generated',excerpt:body}],trace:[],runId:randomUUID()})}));
 const job=runtime.enqueue([{name:'segment',processor:'mote.segment-understanding',artifactInputs:[{id:segment.id,revision:segment.revision}],config:{artifactId:segment.id,modelFingerprint:model.fingerprint}}]).segment;
 await runtime.tick();assert.equal(runtime.engine.get(job)?.state,'succeeded');
 const read=adapter.read({ref:material.ref,scope:all}),product=read.products[0]!;assert.equal(product.events.length,1);assert.deepEqual(product.memoryCandidates,[]);
 const proposed:CommitmentProposal={commitmentId:randomUUID(),eventId:randomUUID(),kind:'commitment',occurredAt:null,summary:product.events[0].statement,
  changes:{title:'Share the plan',deadline:{text:'when ready',at:null}},evidence:product.events[0].evidence.map(value=>({...value,offset:value.offset!})),
  evidenceDependencies:product.disclosureDependencies,sourceContextDependencies:product.sourceContextDependencies};
 const saved=commitments.publish(proposed,undefined,all,()=>{});
 assert.equal(saved.status,'pending_confirmation');assert.equal(saved.dueState,'unknown');assert.equal(saved.timeline[0].evidence[0].quote,body);
 assert.ok(saved.timeline[0].evidenceDependencies.ids.includes(original.id));
 store.delete(original.id);assert.throws(()=>commitments.get(saved.id,all),missing);
});
