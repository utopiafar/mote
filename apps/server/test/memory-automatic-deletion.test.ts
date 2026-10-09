import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {Store,sha256} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore} from '../src/memory.js';
import {reviewMemory,memoryReviewReceipt} from '../src/memory-review.js';
import {MemoryReviewCache} from '../src/memory-review-cache.js';
import {MemoryDeletions} from '../src/memory-deletions.js';
import {MaterialStore} from '../src/materials.js';
import {SourcePipelineRuntime} from '../src/source-pipelines.js';
import {codingSourcePlugin} from '../src/coding-source-plugin.js';

async function fixture(t:TestContext){
 const directory=mkdtempSync(join(tmpdir(),'mote-automatic-memory-'));let store=new Store(directory),memories=new MemoryStore(store),sources=new SourceStore(store);
 sources.register({id:'generated',name:'Generated fixtures',kind:'custom',deviceId:'fixture',platform:'import'});
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 return {get store(){return store;},get memories(){return memories;},async add(text:string,date='2026-01-01T00:00:00Z',externalId=randomUUID()){return (await sources.upsert('generated',{externalId,revision:'1',observedAt:date,kind:'message',layer:'original',text})).id;},restart(options:{maxStorageBytes?:number}={},beforeMemoryStore?:(store:Store)=>void){store.close();store=new Store(directory,options);beforeMemoryStore?.(store);memories=new MemoryStore(store);sources=new SourceStore(store);}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function output(f:Fixture,ids:string[],statement='Generated personal conclusion',extra:Record<string,unknown>={}):QueryResult{return {answer:JSON.stringify({memories:[{title:'Generated Memory',statement:statement+' '+ids.map(id=>`[${id}]`).join(' '),uncertainty:'Generated fixture, no real personal data.',evidenceIds:ids,evidence:ids.map(id=>({id,quote:f.store.evidence([id])[0].ocrText})),admission:{layer:'memory',scope:'fixture',reason:'Explicit owner statement in generated evidence',attribution:'user'},...extra}]}),runId:randomUUID(),trace:[],citations:ids.map(id=>({id,capturedAt:f.store.evidence([id])[0].capturedAt,appName:'Generated fixture',excerpt:''}))};}
async function reviewed(f:Fixture,result:QueryResult,decision={sameConclusion:true,newSupportEvidenceIds:[] as string[]},options:{authorize?:(ids:string[])=>void;signal?:AbortSignal;onDeletion?:(input:QueryInput)=>Promise<void>|void;skill?:QueryInput['skill']}={}){
 let comparisons=0;
 const input:QueryInput={question:'Extract generated memory',signal:options.signal,skill:options.skill??'memory-extraction',responseMode:'memory-extraction',evidenceIds:result.citations.map(c=>c.id)};
 const answer=await reviewMemory(input,result,async query=>{
   if(query.question.startsWith('Host Memory deletion review.')){comparisons++;await options.onDeletion?.(query);return {...result,answer:JSON.stringify(decision)};}
   return {...result};
 },{deletions:f.memories.deletions,authorizeDeletionEvidence:options.authorize});
 return {result:answer,receipt:memoryReviewReceipt(answer)!,comparisons};
}
async function save(f:Fixture,result:QueryResult){const r=await reviewed(f,result);return f.memories.extract(fixtureMemoryResult(f.memories,r.result),'fixture',{requireAdmission:true,reviewReceipt:r.receipt}).items;}

test('reviewed memories and supersession become active atomically, preserving time-scoped history',async t=>{
 const f=await fixture(t),oldId=await f.add('I currently prefer afternoon meetings.'),newId=await f.add('From February I prefer morning meetings.','2026-02-01T00:00:00Z');
 const [old]=await save(f,output(f,[oldId],'Afternoon preference',{validFrom:'2026-01-01T00:00:00Z'}));assert.equal(old.status,'published');
 const [next]=await save(f,output(f,[oldId,newId],'Morning preference',{validFrom:'2026-02-01T00:00:00Z',relations:[{kind:'supersedes',memoryId:old.id,version:old.version,fingerprint:old.fingerprint}]}));
 assert.equal(next.status,'published');assert.equal(f.memories.get(old.id).supersededBy,next.id);
 assert.deepEqual(f.memories.page({asOf:'2026-01-15T00:00:00Z'}).items.map(m=>m.id),[old.id]);assert.deepEqual(f.memories.page({asOf:'2026-02-15T00:00:00Z'}).items.map(m=>m.id),[next.id]);assert.equal(f.memories.page({includeHistory:true}).items.length,2);
});

test('a relation loses its version race to an owner correction without partial automatic writes',async t=>{
 const f=await fixture(t),id=await f.add('Generated scoped preference.'),[old]=await save(f,output(f,[id]));
 const reviewedReplacement=await reviewed(f,output(f,[id],'Generated replacement',{relations:[{kind:'supersedes',memoryId:old.id,version:old.version,fingerprint:old.fingerprint}]}));
 const corrected=await f.memories.correct(old.id,{version:old.version,title:'Owner correction',statement:'This preference concerns only one project.'});
 assert.throws(()=>f.memories.extract(fixtureMemoryResult(f.memories,reviewedReplacement.result),'fixture',{reviewReceipt:reviewedReplacement.receipt}),{statusCode:409});
 assert.equal(f.memories.get(old.id).supersededBy,corrected.id);assert.equal(f.memories.page({includeHistory:true}).items.length,2);
});

test('deleting an unpublished supersession proposal does not require an unestablished ancestor edge',async t=>{
 const f=await fixture(t),id=await f.add('Generated original for a proposal.'),[old]=await save(f,output(f,[id]));
 const proposal=f.memories.extract(fixtureMemoryResult(f.memories,output(f,[id],'Generated draft replacement',{relations:[{kind:'supersedes',memoryId:old.id,version:old.version,fingerprint:old.fingerprint}]})),'fixture').items[0];
 const stale=f.memories.extract(fixtureMemoryResult(f.memories,output(f,[id],'Another generated draft',{relations:[{kind:'supersedes',memoryId:old.id,version:old.version,fingerprint:old.fingerprint}]})),'fixture').items[0];
 f.store.db.prepare("UPDATE memories SET json=json_set(json,'$.status','stale') WHERE id=?").run(stale.id);
 assert.equal(proposal.status,'proposed');assert.equal(f.memories.get(old.id).supersededBy,undefined);
 assert.equal(f.memories.delete(proposal.id).deleted,1);
 assert.equal(f.memories.get(old.id).supersededBy,undefined);
 assert.ok(f.memories.deletions.export()[0].dependencies.includes(id));
 assert.equal(f.memories.delete(stale.id).deleted,1,'an invalidated proposal also has no established supersession edge');
});

test('archive restore distinguishes a corrected unpublished proposal from an established supersession',async t=>{
 const source=await fixture(t),id=await source.add('Generated archive proposal original.'),[old]=await save(source,output(source,[id]));
 const proposal=source.memories.extract(fixtureMemoryResult(source.memories,output(source,[id],'Generated unpublished proposal',{relations:[{kind:'supersedes',memoryId:old.id,version:old.version,fingerprint:old.fingerprint}]})),'fixture').items[0];
 const corrected=await source.memories.correct(proposal.id,{version:proposal.version,title:'Owner correction of draft',statement:'Generated owner correction of an unpublished proposal.'});
 assert.equal(source.memories.get(proposal.id).version,2);
 assert.equal(source.memories.get(old.id).supersededBy,undefined,'the proposed relation was never applied');
 const restored=await fixture(t);await restored.store.importArchive(source.store.exportArchive(2_000_000));
 assert.equal(restored.memories.get(proposal.id).status,'stale');
 assert.equal(restored.memories.get(proposal.id).staleReason,'restored_archive');
 assert.equal(restored.memories.delete(corrected.id).deleted,1);
 assert.ok(restored.memories.deletions.export()[0].dependencies.includes(id));
 assert.equal(restored.memories.get(old.id).supersededBy,undefined);

 const actual=await fixture(t),firstId=await actual.add('Generated published archive original.'),[first]=await save(actual,output(actual,[firstId]));
 const [published]=await save(actual,output(actual,[firstId],'Published replacement',{relations:[{kind:'supersedes',memoryId:first.id,version:first.version,fingerprint:first.fingerprint}]}));
 const next=await actual.memories.correct(published.id,{version:published.version,title:'Owner correction of published',statement:'Generated correction of published replacement.'});
 const corrupted=await fixture(t);await corrupted.store.importArchive(actual.store.exportArchive(2_000_000));
 assert.equal(corrupted.memories.get(published.id).version,3);
 corrupted.store.db.prepare("UPDATE memories SET json=json_remove(json,'$.supersededBy') WHERE id=?").run(first.id);
 assert.throws(()=>corrupted.memories.delete(next.id),{statusCode:409},'a published relation missing its reverse edge fails closed after restore');
 assert.equal(corrupted.memories.deletions.export().length,0);
 assert.equal(corrupted.memories.get(next.id).status,'stale');
});

test('deletion survives restart and rejects a paraphrase from duplicated originals and another strategy version',async t=>{
 const f=await fixture(t),text='I tried a pottery workshop once.',id=await f.add(text),[old]=await save(f,output(f,[id],'Pottery is a lasting hobby'));
 f.memories.delete(old.id);assert.equal(f.store.evidence([id]).length,1);f.restart();
 const duplicate=await f.add(text),paraphrase=output(f,[duplicate],'The user has an enduring enthusiasm for ceramics');
 const check=await reviewed(f,paraphrase);assert.equal(check.comparisons,1);assert.deepEqual(JSON.parse(check.result.answer).memories,[]);
 assert.equal(f.memories.extract(fixtureMemoryResult(f.memories,check.result),'fixture',{reviewReceipt:check.receipt,skillVersion:'entirely-different-strategy@9'}).items.length,0);assert.equal(f.memories.list().length,0);
});

test('deleting a twice-corrected Memory routes every superseded original through bounded semantic review',async t=>{
 const f=await fixture(t),text='Generated owner wanted an Android quick-recording entry for a sample project.',originalId=await f.add(text),[original]=await save(f,output(f,[originalId],'Generated quick-recording plan'));
 const unrelatedId=await f.add('Generated unrelated preference for a different sample.'),[unrelated]=await save(f,output(f,[unrelatedId],'Unrelated generated preference'));
 const first=await f.memories.correct(original.id,{version:original.version,title:'First owner correction',statement:'Generated correction: it was a tentative idea, not a completed feature.'});
 const current=await f.memories.correct(first.id,{version:first.version,title:'Second owner correction',statement:'Generated correction: retain the tentative scope for this sample project only.'});
 // Later metadata revisions do not erase the content fingerprint pinned by
 // the supersession relation or make an explicit deletion impossible.
 f.store.db.prepare("UPDATE memories SET json=json_set(json,'$.version',4) WHERE id=?").run(first.id);
 f.memories.delete(current.id);
 const deletion=f.memories.deletions.export()[0],expected=[originalId,first.evidenceIds[0],current.evidenceIds[0]].sort();
 assert.deepEqual([...deletion.dependencies].sort(),expected);
 assert.equal(f.store.evidence([originalId]).length,1,'deletion retains the original');
 assert.equal(f.memories.get(unrelated.id).status,'published','unrelated Memory remains');
 assert.equal(f.memories.get(original.id).supersededBy,first.id,'historical Memory is not resurrected');
 f.restart();
 const replay=await f.add(text),candidate=output(f,[replay],'A lasting Android quick-recording preference');let authorized:string[][]=[];
 let judged=false;
 await assert.rejects(reviewed(f,candidate,undefined,{authorize:()=>{throw Error('Generated source authorization denied');},onDeletion:()=>{judged=true;}}),/Generated source authorization denied/);
 assert.equal(judged,false,'authorization precedes the semantic model call');
 const blocked=await reviewed(f,candidate,undefined,{authorize:ids=>authorized.push(ids),skill:'coding-memory'});
 assert.equal(blocked.comparisons,1,'reimported old event reaches the model deletion verdict');
 assert.deepEqual(authorized.map(ids=>[...ids].sort()),[expected]);
 assert.deepEqual(JSON.parse(blocked.result.answer).memories,[]);
 assert.equal(f.memories.extract(fixtureMemoryResult(f.memories,blocked.result),'fixture',{reviewReceipt:blocked.receipt,skillVersion:'changed-recipe@9'}).items.length,0);
 const distinct=await reviewed(f,output(f,[replay],'A different generated conclusion'),{sameConclusion:false,newSupportEvidenceIds:[]});
 assert.equal(distinct.comparisons,1);assert.equal(JSON.parse(distinct.result.answer).memories.length,1,'sharing evidence does not blanket-suppress a distinct conclusion');
 const fresh=await f.add('Generated later owner confirms using the quick entry every day.','2026-02-01T00:00:00Z');
 const reconsidered=await reviewed(f,output(f,[replay,fresh],'Generated quick-recording preference with new support'),{sameConclusion:true,newSupportEvidenceIds:[fresh]});
 assert.equal(reconsidered.comparisons,1);assert.equal(f.memories.extract(fixtureMemoryResult(f.memories,reconsidered.result),'fixture',{reviewReceipt:reconsidered.receipt}).items[0].status,'published');
});

test('missing or mismatched supersession ancestors do not leave a partial deletion intent',async t=>{
 const f=await fixture(t),id=await f.add('Generated correction lineage original.'),[old]=await save(f,output(f,[id]));
 const current=await f.memories.correct(old.id,{version:old.version,title:'Generated correction',statement:'Generated correction note.'});
 const unchanged=f.store.db.prepare('SELECT json FROM memories WHERE id=?').get(current.id)!.json;
 f.store.db.prepare("UPDATE memories SET json=json_set(json,'$.relations[0].fingerprint',?) WHERE id=?").run('0'.repeat(64),current.id);
 assert.throws(()=>f.memories.delete(current.id),{statusCode:409});
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_deletions').get()!.n,0);
 assert.ok(f.store.db.prepare('SELECT id FROM memories WHERE id=?').get(current.id));
 f.store.db.prepare('UPDATE memories SET json=? WHERE id=?').run(unchanged,current.id);
 f.store.db.prepare('DELETE FROM memories WHERE id=?').run(old.id);
 assert.throws(()=>f.memories.delete(current.id),{statusCode:409});
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_deletions').get()!.n,0);
 assert.ok(f.store.db.prepare('SELECT id FROM memories WHERE id=?').get(current.id));
});

test('a cyclic stored supersession lineage fails closed before changing deletion state',async t=>{
 const f=await fixture(t),id=await f.add('Generated original for a malformed cycle.'),[old]=await save(f,output(f,[id]));
 const first=await f.memories.correct(old.id,{version:old.version,title:'First correction',statement:'Generated first correction.'});
 const current=await f.memories.correct(first.id,{version:first.version,title:'Second correction',statement:'Generated second correction.'});
 // Simulate a corrupt persisted graph whose pins and reverse pointers look
 // individually valid. A traversal still must stop at the repeated node.
 const firstStored=f.memories.get(first.id),currentStored=f.memories.get(current.id);
 firstStored.relations=[{kind:'supersedes',memoryId:current.id,fingerprint:current.fingerprint,version:current.version}];
 firstStored.correction={memoryId:current.id,fingerprint:current.fingerprint,noteId:first.evidenceIds[0]};
 currentStored.version=(currentStored.version??1)+1;currentStored.supersededBy=first.id;
 f.store.db.prepare('UPDATE memories SET json=? WHERE id=?').run(JSON.stringify(firstStored),first.id);
 f.store.db.prepare('UPDATE memories SET json=? WHERE id=?').run(JSON.stringify(currentStored),current.id);
 assert.throws(()=>f.memories.delete(current.id),{statusCode:409});
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_deletions').get()!.n,0);
 assert.ok(f.store.db.prepare('SELECT id FROM memories WHERE id=?').get(current.id));
});

test('new evidence must support reconsideration; unrelated new citations do not remove the deletion constraint',async t=>{
 const f=await fixture(t),id=await f.add('I tried pottery once.'),[old]=await save(f,output(f,[id],'Pottery is a lasting hobby'));f.memories.delete(old.id);
 const unrelated=await f.add('The generated sky was cloudy.','2026-02-01T00:00:00Z'),candidate=output(f,[id,unrelated],'Pottery remains my lasting hobby');
 const denied=await reviewed(f,candidate);assert.equal(JSON.parse(denied.result.answer).memories.length,0);
 const fresh=await f.add('I have now joined a weekly pottery club because this is my long-term hobby.','2026-03-01T00:00:00Z');
 const allowed=await reviewed(f,output(f,[id,fresh],'Pottery has become an ongoing hobby'),{sameConclusion:true,newSupportEvidenceIds:[fresh]});
 assert.equal(f.memories.extract(fixtureMemoryResult(f.memories,allowed.result),'fixture',{reviewReceipt:allowed.receipt}).items[0].status,'published');
 await assert.rejects(reviewed(f,candidate,{sameConclusion:true,newSupportEvidenceIds:[id]}),{statusCode:502});
});

test('an independent later expression is new evidence and unrelated private deletions never enter its review',async t=>{
 const f=await fixture(t),text='I enjoy pottery.',id=await f.add(text),[old]=await save(f,output(f,[id]));f.memories.delete(old.id);
 const later=await f.add(text,'2026-02-01T00:00:00Z');
 const result=await reviewed(f,output(f,[later]),undefined,{authorize:()=>assert.fail('Unrelated private deletion must not be disclosed')});
 assert.equal(result.comparisons,0);assert.equal(f.memories.extract(fixtureMemoryResult(f.memories,result.result),'fixture',{reviewReceipt:result.receipt}).items.length,1);
 await assert.rejects(reviewed(f,output(f,[id]),undefined,{authorize:()=>{throw Object.assign(new Error('evidence-revoked'),{statusCode:403});}}),{statusCode:403});
});

test('a cached or in-flight verdict cannot commit after a new deletion, and cancellation issues no receipt',async t=>{
 const f=await fixture(t),id=await f.add('Generated preference'),draft=output(f,[id]),[old]=await save(f,draft);
 const prior=await reviewed(f,{...draft,answer:draft.answer.replace('Generated personal conclusion','Different wording')});f.memories.delete(old.id);
 assert.throws(()=>f.memories.extract(fixtureMemoryResult(f.memories,prior.result),'fixture',{reviewReceipt:prior.receipt}),{statusCode:409});
 const abort=new AbortController();await assert.rejects(reviewed(f,draft,undefined,{signal:abort.signal,onDeletion:()=>abort.abort()}),{name:'AbortError'});assert.equal(f.memories.list().length,0);
});

test('deletion invalidates dependent consolidation cards and raw retention removes private deletion payloads',async t=>{
 const f=await fixture(t),id=await f.add('Generated owner statement'),[old]=await save(f,output(f,[id]));
 const parent=output(f,[id],'Synthesis with an explicitly new relationship',{relatedMemoryIds:[old.id]});const reviewedParent=await reviewed(f,parent);
 const derived=f.memories.extract(fixtureMemoryResult(f.memories,reviewedParent.result),'fixture',{tier:'consolidated',relatedMemoryIds:[old.id],requireAdmission:true,reviewReceipt:reviewedParent.receipt}).items[0];
 f.memories.delete(old.id);assert.equal(f.memories.get(derived.id).staleReason,'memory_deleted');assert.equal(f.memories.list().length,0);
 assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM memory_deletions').get()!.n),1);
 f.store.prune('2027-01-01T00:00:00Z');assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM memory_deletions').get()!.n),0);assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM memory_deletion_dependencies').get()!.n),0);
});

test('reopening never publishes proposed drafts or removes checkpoints; explicit fresh review activates them',async t=>{
 const f=await fixture(t),id=await f.add('Legacy generated statement'),draft=output(f,[id]);
 const pending=f.memories.extract(fixtureMemoryResult(f.memories,draft),'fixture').items[0];f.store.db.prepare('INSERT INTO memory_checkpoints VALUES(?,?,?)').run('legacy-key',id,new Date().toISOString());f.restart();
 assert.equal(f.memories.get(pending.id).status,'proposed');assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n),1);
 const [active]=await save(f,draft);assert.equal(active.id,pending.id);assert.equal(active.status,'published');
 const id2=await f.add('Reviewed legacy generated statement','2026-02-01T00:00:00Z'),draft2=output(f,[id2]),legacy=f.memories.extract(fixtureMemoryResult(f.memories,draft2),'fixture',{reviewReceipt:{policy:'bounded-exact-review@1',decision:'independent',draftRunId:'legacy',reviewRunId:'legacy-review',checkedAt:new Date().toISOString()}}).items[0];
 assert.equal(legacy.status,'proposed');f.restart();assert.equal(f.memories.get(legacy.id).status,'proposed');
});

test('changing a source revision with only unrelated appended text does not make its old proof new',async t=>{
 const f=await fixture(t),external='stable-document',id=await f.add('I tried pottery once.','2026-01-01T00:00:00Z',external),[old]=await save(f,output(f,[id],'Pottery is a lasting hobby'));f.memories.delete(old.id);
 const sources=new SourceStore(f.store),changed=(await sources.upsert('generated',{externalId:external,revision:'2',observedAt:'2026-02-01T00:00:00Z',kind:'message',layer:'original',text:'I tried pottery once. The generated sky is cloudy.'})).id;
 const draft=output(f,[changed],'Pottery is a lasting hobby',{evidence:[{id:changed,quote:'I tried pottery once.'}]});
 const denied=await reviewed(f,draft);assert.equal(denied.comparisons,1);assert.equal(JSON.parse(denied.result.answer).memories.length,0);
 await assert.rejects(reviewed(f,draft,{sameConclusion:true,newSupportEvidenceIds:[changed]}),{statusCode:502});
});

test('deletion invalidates a bounded review cache and a simultaneous second deletion fences the semantic verdict',async t=>{
 const f=await fixture(t),id=await f.add('Generated interest'),draft=output(f,[id]),[old]=await save(f,draft);
 const cache=new MemoryReviewCache(),input:QueryInput={question:'Generated extraction',contextTime:'2026-01-01T00:00:00Z',skill:'memory-extraction',evidenceIds:[id],evidenceRanges:[{id,offset:0,length:18}],validateOutput:()=>undefined};let reviews=0,comparisons=0;
 const query=async(request:QueryInput)=>{if(request.question.startsWith('Host Memory deletion review.')){comparisons++;return {...draft,answer:JSON.stringify({sameConclusion:true,newSupportEvidenceIds:[]})};}reviews++;return {...draft};};
 const options={cache,snapshot:()=> 'fixed-original',deletions:f.memories.deletions};await reviewMemory(input,draft,query,options);await reviewMemory(input,draft,query,options);assert.equal(reviews,1);
 f.memories.delete(old.id);const checked=await reviewMemory(input,draft,query,options);assert.equal(reviews,2);assert.equal(comparisons,1);assert.equal(JSON.parse(checked.answer).memories.length,0);
 const unrelated=await f.add('A genuinely independent new record.','2026-03-01T00:00:00Z'),[second]=await save(f,output(f,[unrelated]));
 await assert.rejects(reviewed(f,draft,undefined,{onDeletion:()=>{f.memories.delete(second.id);}}),{statusCode:409});
});

test('portable archives retain deletion intent, reject identity tampering atomically, and reject incomplete archives',async t=>{
 const f=await fixture(t),id=await f.add('Generated temporary interest'),[old]=await save(f,output(f,[id]));f.memories.delete(old.id);
 const archive=f.store.exportArchive(2_000_000),restored=await fixture(t);await restored.store.importArchive(archive);
 const checked=await reviewed(restored,output(restored,[id],'Paraphrased generated interest'));assert.equal(checked.comparisons,1);assert.equal(JSON.parse(checked.result.answer).memories.length,0);
 await restored.store.importArchive(archive);assert.equal(Number(restored.store.db.prepare('SELECT count(*) n FROM memory_deletions').get()!.n),1);
 const bad=structuredClone(archive);bad.memoryDeletions[0].originKeys=['event:'+sha256('tampered')];const target=await fixture(t);
 await assert.rejects(target.store.importArchive(bad),/identity mismatch/);assert.equal(target.store.evidence([id]).length,0);assert.equal(Number(target.store.db.prepare('SELECT count(*) n FROM memory_deletions').get()!.n),0);
 const legacy={...archive,version:1,memoryDeletions:undefined};await assert.rejects(target.store.importArchive(legacy));assert.equal(target.store.evidence([id]).length,0);
});


test('the complete deletion comparison has a deadline even when a model ignores cancellation',async t=>{
 const f=await fixture(t),id=await f.add('Generated bounded review'),draft=output(f,[id]),[old]=await save(f,draft);f.memories.delete(old.id);
 const guard=new MemoryDeletions(f.store,ids=>f.store.evidence(ids),20);let signal:AbortSignal|undefined;
 await assert.rejects(guard.review({question:'Generated'},draft,async input=>{signal=input.signal;return new Promise(()=>{});}),{name:'AgentTimeoutError'});
 assert.equal(signal?.aborted,true);assert.equal(f.memories.list().length,0);
});


test('portable merge applies owner deletion to an existing active card and its consolidation',async t=>{
 const f=await fixture(t),id=await f.add('Generated merge evidence'),[old]=await save(f,output(f,[id])),baseline=f.store.exportArchive(2_000_000),target=await fixture(t);
 await target.store.importArchive(baseline);target.store.db.prepare('UPDATE memories SET json=? WHERE id=?').run(JSON.stringify(old),old.id);
 const draft=output(target,[id],'Generated synthesis',{relatedMemoryIds:[old.id]}),check=await reviewed(target,draft),child=target.memories.extract(fixtureMemoryResult(target.memories,check.result),'fixture',{tier:'consolidated',requireAdmission:true,relatedMemoryIds:[old.id],reviewReceipt:check.receipt}).items[0];
 f.memories.delete(old.id);await target.store.importArchive(f.store.exportArchive(2_000_000));assert.throws(()=>target.memories.get(old.id),{statusCode:404});assert.equal(target.memories.get(child.id).staleReason,'memory_deleted');assert.equal(target.memories.list().length,0);
});

test('partial original retention keeps the independent owner rule for remaining evidence and drops proof text',async t=>{
 const f=await fixture(t),a=await f.add('Generated source A old proof.'),b=await f.add('Generated source B old proof.','2026-03-01T00:00:00Z'),[old]=await save(f,output(f,[a,b],'Generated conclusion explicitly deleted by owner'));
 f.memories.delete(old.id);f.store.prune('2026-02-01T00:00:00Z');const [intent]=f.memories.deletions.export();assert.deepEqual(intent.dependencies,[b]);assert.deepEqual(intent.originalTexts,[]);assert.equal(intent.statement,old.statement);
 const checked=await reviewed(f,output(f,[b],'Same generated conclusion in other wording'));assert.equal(checked.comparisons,1);assert.equal(JSON.parse(checked.result.answer).memories.length,0);
 const restored=await fixture(t);await restored.store.importArchive(f.store.exportArchive(2_000_000));assert.deepEqual(restored.memories.deletions.export(),[intent]);
 f.store.delete(b);assert.deepEqual(f.memories.deletions.export(),[]);
});

test('forgetting a Coding archive removes private deletion intent even without capture roots',async t=>{
 const f=await fixture(t),materials=new MaterialStore(f.store),runtime=new SourcePipelineRuntime(f.store,materials,[codingSourcePlugin]);await runtime.ready;t.after(()=>runtime.close());
 const sources=new SourceStore(f.store,runtime);sources.register({id:'coding',name:'Generated coding',kind:'coding-agent',deviceId:'fixture',platform:'macos'});runtime.configure('coding',{settleSeconds:0});
 await sources.upsert('coding',{externalId:'event-1',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'snapshot',text:'Generated owner preference: use written decisions for batch tasks.',document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'fixture-session',projectKey:'fixture-project',eventId:'000001',role:'user',part:0,parts:1}}});await runtime.tick();
 const material=materials.list().items[0],memories=new MemoryStore(f.store,ids=>[...f.store.evidence(ids),...materials.evidence(ids)],id=>materials.isCurrentEvidence(id)||f.store.isCurrentEvidence(id)),ids=materials.evidenceIds(material.id),records=memories.readEvidence(ids);
 const draft={answer:JSON.stringify({memories:[{title:'Generated private policy',statement:'Generated private preference '+ids.map(id=>'['+id+']').join(' '),uncertainty:'Generated only',evidenceIds:ids,evidence:records.map(r=>({id:r.id,quote:r.ocrText}))}]}),citations:records.map(r=>({id:r.id,capturedAt:r.capturedAt,appName:'Generated',excerpt:''})),trace:[],runId:randomUUID()};
 const memory=memories.extract(fixtureMemoryResult(memories,draft),'fixture').items[0];memories.delete(memory.id);assert.equal(memories.deletions.export().length,1);assert.ok(memories.deletions.export()[0].dependencies.every(id=>ids.includes(id)));
 runtime.configure('coding',{settleSeconds:0});await runtime.tick();assert.equal(memories.deletions.export().length,1,'Rebuilding unchanged archive material must preserve the owner rule');
 const result=runtime.forget('coding');assert.equal(result.erased,true);assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM material_evidence').get()!.n),0);assert.deepEqual(memories.deletions.export(),[]);
});

test('explicit source forgetting erases mixed-source owner rules before removing their dependencies',async t=>{
 const f=await fixture(t),materials=new MaterialStore(f.store),runtime=new SourcePipelineRuntime(f.store,materials,[codingSourcePlugin]);await runtime.ready;t.after(()=>runtime.close());
 const sources=new SourceStore(f.store,runtime);
 for(const sourceId of ['coding-a','coding-b']){
  sources.register({id:sourceId,name:'Generated '+sourceId,kind:'coding-agent',deviceId:'fixture',platform:'macos'});runtime.configure(sourceId,{settleSeconds:0});
  await sources.upsert(sourceId,{externalId:'event-1',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'snapshot',text:'Generated private preference from '+sourceId,document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:sourceId,projectKey:'fixture-project',eventId:'000001',role:'user',part:0,parts:1}}});
 }
 await runtime.tick();
 const memories=new MemoryStore(f.store,ids=>[...f.store.evidence(ids),...materials.evidence(ids)],id=>materials.isCurrentEvidence(id)||f.store.isCurrentEvidence(id)),b=materials.list().items.find(m=>m.origin.sourceId==='coding-b')!,bIds=materials.evidenceIds(b.id),allIds=materials.list().items.flatMap(m=>materials.evidenceIds(m.id));
 const make=(ids:string[],statement:string):QueryResult=>({answer:JSON.stringify({memories:[{title:'Generated owner rule',statement,uncertainty:'Generated only',evidenceIds:ids,evidence:memories.readEvidence(ids).map(r=>({id:r.id,quote:r.ocrText}))}]}),citations:memories.readEvidence(ids).map(r=>({id:r.id,capturedAt:r.capturedAt,appName:'Generated',excerpt:''})),trace:[],runId:randomUUID()});
 const saved=([[allIds,'Generated A PRIVATE conclusion combined with B'],[bIds,'Generated independent B conclusion']] as const).map(([ids,statement])=>memories.extract(fixtureMemoryResult(memories,make([...ids],statement)),'fixture').items[0]);for(const memory of saved)memories.delete(memory.id);
 assert.equal(memories.deletions.export().length,2);
 assert.deepEqual(runtime.forget('coding-a'),{erased:true,sourcePaused:true});
 const [remaining]=memories.deletions.export();assert.equal(memories.deletions.export().length,1);assert.equal(remaining.statement,'Generated independent B conclusion');assert.deepEqual(remaining.dependencies,bIds);assert.equal(materials.list().items.length,1);
 await memories.deletions.review({question:'Generated fixture',evidenceIds:bIds},make(bIds,'Generated independent new B conclusion'),async input=>{assert.ok(!JSON.stringify(input.taskContext).includes('A PRIVATE'));return {...make(bIds,''),answer:JSON.stringify({sameConclusion:false,newSupportEvidenceIds:[]})};});
});

test('source lineage survives prune, restart and portable restore before explicit source forgetting',async t=>{
 const f=await fixture(t),sources=new SourceStore(f.store);
 for(const id of ['coding-a','coding-b'])sources.register({id,name:'Generated '+id,kind:'coding-agent',deviceId:'fixture',platform:'macos'});
 // Retained record-backed originals from before this source adopted its archive
 // pipeline exercise the actual Store.prune path, not a mock dependency delete.
 const a=(await sources.upsert('coding-a',{externalId:'a',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text:'Generated A private source detail.'})).id,b=(await sources.upsert('coding-b',{externalId:'b',revision:'1',observedAt:'2026-03-01T00:00:00Z',kind:'message',layer:'original',text:'Generated B evidence.'})).id;
 const [memory]=await save(f,output(f,[a,b],'Generated A PRIVATE mixed-source conclusion'));f.memories.delete(memory.id);f.store.prune('2026-02-01T00:00:00Z');f.restart();
 const [intent]=f.memories.deletions.export();assert.deepEqual(intent.dependencies,[b]);assert.deepEqual(intent.originalTexts,[]);assert.deepEqual(intent.derivationSourceIds,['coding-a','coding-b']);assert.equal(intent.sourceLineageComplete,true);assert.equal(f.store.evidence([a]).length,0);
 const restored=await fixture(t);await restored.store.importArchive(f.store.exportArchive(2_000_000));assert.deepEqual(restored.memories.deletions.export(),[intent]);
 for(const target of [f,restored]){
  const runtime=new SourcePipelineRuntime(target.store,new MaterialStore(target.store),[codingSourcePlugin]);await runtime.ready;t.after(()=>runtime.close());runtime.configure('coding-a',{pipelineId:'mote.coding',settleSeconds:0});
  assert.equal(runtime.forget('coding-a').erased,true);assert.deepEqual(target.memories.deletions.export(),[]);assert.equal(target.store.evidence([b]).length,1);
  await target.memories.deletions.review({question:'Generated'},output(target,[b]),async()=>assert.fail('Forgotten A text must not enter subsequent B review'));
 }
});

test('incomplete lineage archives are refused atomically and current lineage cannot omit its sources',async t=>{
 const f=await fixture(t),id=await f.add('Generated rule evidence'),[memory]=await save(f,output(f,[id]));f.memories.delete(memory.id);
 const archive=f.store.exportArchive(2_000_000),missing=structuredClone(archive);Reflect.deleteProperty(missing.memoryDeletions[0],'derivationSourceIds');Reflect.deleteProperty(missing.memoryDeletions[0],'sourceLineageComplete');
 const rejected=await fixture(t);await assert.rejects(rejected.store.importArchive(missing));assert.equal(rejected.store.evidence([id]).length,0);
 const bad=structuredClone(archive);bad.memoryDeletions[0].derivationSourceIds=[];await assert.rejects(rejected.store.importArchive(bad),/source lineage mismatch/);assert.equal(rejected.store.evidence([id]).length,0);
});

test('deletion rules and provenance dependencies consume exact quota and release it when originals are removed',async t=>{
 const f=await fixture(t),id=await f.add('Generated quota evidence 中文'),[memory]=await save(f,output(f,[id])),before=f.store.logicalBytes(),memoryBytes=Buffer.byteLength(String(f.store.db.prepare('SELECT json FROM memories WHERE id=?').get(memory.id)!.json));
 f.memories.delete(memory.id);
 const intent=f.memories.deletions.export()[0],jsonBytes=Buffer.byteLength(JSON.stringify(intent)),rows=f.store.db.prepare('SELECT * FROM memory_deletion_dependencies').all(),dependencyBytes=rows.reduce((total,row)=>total+['deletion_id','evidence_id','origin_keys','lineage_keys'].reduce((n,key)=>n+Buffer.byteLength(String(row[key])),0)+128,0),ruleBytes=jsonBytes+dependencyBytes;
 assert.equal(f.store.logicalBytes(),before-memoryBytes+ruleBytes);
 assert.equal(f.store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='memory_deletions'").get()!.bytes,jsonBytes);
 assert.equal(f.store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='memory_deletion_dependencies'").get()!.bytes,dependencyBytes);
 const persisted=f.store.logicalBytes(),second={...intent,id:randomUUID()};f.restart({maxStorageBytes:persisted+ruleBytes-1});
 assert.equal(f.store.stats().logicalBytes,persisted);assert.throws(()=>f.memories.deletions.restore([second]),{statusCode:507});assert.equal(f.memories.deletions.export().length,1);
 f.restart({maxStorageBytes:persisted+ruleBytes});f.memories.deletions.restore([second]);assert.equal(f.store.logicalBytes(),persisted+ruleBytes);f.memories.deletions.restore([second]);assert.equal(f.store.logicalBytes(),persisted+ruleBytes,'Idempotent restore requires no extra capacity');assert.throws(()=>f.store.reserveMetadata(1),{statusCode:507});
 f.store.delete(id);assert.deepEqual(f.memories.deletions.export(),[]);assert.equal(f.store.db.prepare("SELECT sum(bytes) n FROM storage_ledger WHERE name IN ('memory_deletions','memory_deletion_dependencies')").get()!.n,0);f.store.reserveMetadata(ruleBytes*2);
});

test('current deletion ledgers reopen with exact accounting and dependency identities',async t=>{
 const f=await fixture(t),id=await f.add('Generated accounting evidence'),[memory]=await save(f,output(f,[id]));f.memories.delete(memory.id);const expected=f.store.logicalBytes(),intent=f.memories.deletions.export()[0];
 f.restart();assert.equal(f.store.logicalBytes(),expected);assert.deepEqual(f.memories.deletions.export(),[intent]);assert.notEqual(f.store.db.prepare('SELECT origin_keys FROM memory_deletion_dependencies').get()!.origin_keys,'[]');
 f.store.delete(id);assert.equal(f.store.db.prepare("SELECT sum(bytes) n FROM storage_ledger WHERE name IN ('memory_deletions','memory_deletion_dependencies')").get()!.n,0);
});
