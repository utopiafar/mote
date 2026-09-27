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
async function reviewed(f:Fixture,result:QueryResult,decision={sameConclusion:true,newSupportEvidenceIds:[] as string[]},options:{authorize?:(ids:string[])=>void;signal?:AbortSignal;onDeletion?:(input:QueryInput)=>Promise<void>|void}={}){
 let comparisons=0;
 const input:QueryInput={question:'Extract generated memory',signal:options.signal,skill:'memory-extraction',responseMode:'memory-extraction',evidenceIds:result.citations.map(c=>c.id)};
 const answer=await reviewMemory(input,result,async query=>{
   if(query.question.startsWith('Host Memory deletion review.')){comparisons++;await options.onDeletion?.(query);return {...result,answer:JSON.stringify(decision)};}
   return {...result};
 },{deletions:f.memories.deletions,authorizeDeletionEvidence:options.authorize});
 return {result:answer,receipt:memoryReviewReceipt(answer)!,comparisons};
}
async function save(f:Fixture,result:QueryResult){const r=await reviewed(f,result);return f.memories.extract(r.result,'fixture',{requireAdmission:true,reviewReceipt:r.receipt}).items;}

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
 assert.throws(()=>f.memories.extract(reviewedReplacement.result,'fixture',{reviewReceipt:reviewedReplacement.receipt}),{statusCode:409});
 assert.equal(f.memories.get(old.id).supersededBy,corrected.id);assert.equal(f.memories.page({includeHistory:true}).items.length,2);
});

test('deletion survives restart and rejects a paraphrase from duplicated originals and another strategy version',async t=>{
 const f=await fixture(t),text='I tried a pottery workshop once.',id=await f.add(text),[old]=await save(f,output(f,[id],'Pottery is a lasting hobby'));
 f.memories.delete(old.id);assert.equal(f.store.evidence([id]).length,1);f.restart();
 const duplicate=await f.add(text),paraphrase=output(f,[duplicate],'The user has an enduring enthusiasm for ceramics');
 const check=await reviewed(f,paraphrase);assert.equal(check.comparisons,1);assert.deepEqual(JSON.parse(check.result.answer).memories,[]);
 assert.equal(f.memories.extract(check.result,'fixture',{reviewReceipt:check.receipt,skillVersion:'entirely-different-strategy@9'}).items.length,0);assert.equal(f.memories.list().length,0);
});

test('new evidence must support reconsideration; unrelated new citations do not remove the deletion constraint',async t=>{
 const f=await fixture(t),id=await f.add('I tried pottery once.'),[old]=await save(f,output(f,[id],'Pottery is a lasting hobby'));f.memories.delete(old.id);
 const unrelated=await f.add('The generated sky was cloudy.','2026-02-01T00:00:00Z'),candidate=output(f,[id,unrelated],'Pottery remains my lasting hobby');
 const denied=await reviewed(f,candidate);assert.equal(JSON.parse(denied.result.answer).memories.length,0);
 const fresh=await f.add('I have now joined a weekly pottery club because this is my long-term hobby.','2026-03-01T00:00:00Z');
 const allowed=await reviewed(f,output(f,[id,fresh],'Pottery has become an ongoing hobby'),{sameConclusion:true,newSupportEvidenceIds:[fresh]});
 assert.equal(f.memories.extract(allowed.result,'fixture',{reviewReceipt:allowed.receipt}).items[0].status,'published');
 await assert.rejects(reviewed(f,candidate,{sameConclusion:true,newSupportEvidenceIds:[id]}),{statusCode:502});
});

test('an independent later expression is new evidence and unrelated private deletions never enter its review',async t=>{
 const f=await fixture(t),text='I enjoy pottery.',id=await f.add(text),[old]=await save(f,output(f,[id]));f.memories.delete(old.id);
 const later=await f.add(text,'2026-02-01T00:00:00Z');
 const result=await reviewed(f,output(f,[later]),undefined,{authorize:()=>assert.fail('Unrelated private deletion must not be disclosed')});
 assert.equal(result.comparisons,0);assert.equal(f.memories.extract(result.result,'fixture',{reviewReceipt:result.receipt}).items.length,1);
 await assert.rejects(reviewed(f,output(f,[id]),undefined,{authorize:()=>{throw Object.assign(new Error('local-only'),{statusCode:403});}}),{statusCode:403});
});

test('a cached or in-flight verdict cannot commit after a new deletion, and cancellation issues no receipt',async t=>{
 const f=await fixture(t),id=await f.add('Generated preference'),draft=output(f,[id]),[old]=await save(f,draft);
 const prior=await reviewed(f,{...draft,answer:draft.answer.replace('Generated personal conclusion','Different wording')});f.memories.delete(old.id);
 assert.throws(()=>f.memories.extract(prior.result,'fixture',{reviewReceipt:prior.receipt}),{statusCode:409});
 const abort=new AbortController();await assert.rejects(reviewed(f,draft,undefined,{signal:abort.signal,onDeletion:()=>abort.abort()}),{name:'AbortError'});assert.equal(f.memories.list().length,0);
});

test('deletion invalidates dependent consolidation cards and raw retention removes private deletion payloads',async t=>{
 const f=await fixture(t),id=await f.add('Generated owner statement'),[old]=await save(f,output(f,[id]));
 const parent=output(f,[id],'Synthesis with an explicitly new relationship',{relatedMemoryIds:[old.id]});const reviewedParent=await reviewed(f,parent);
 const derived=f.memories.extract(reviewedParent.result,'fixture',{tier:'consolidated',relatedMemoryIds:[old.id],requireAdmission:true,reviewReceipt:reviewedParent.receipt}).items[0];
 f.memories.delete(old.id);assert.equal(f.memories.get(derived.id).staleReason,'memory_deleted');assert.equal(f.memories.list().length,0);
 assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM memory_deletions').get()!.n),1);
 f.store.prune('2027-01-01T00:00:00Z');assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM memory_deletions').get()!.n),0);assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM memory_deletion_dependencies').get()!.n),0);
});

test('legacy migration uses exact reviewed proof; fresh review activates a duplicate draft and reopens its checkpoint',async t=>{
 const f=await fixture(t),id=await f.add('Legacy generated statement'),draft=output(f,[id]);
 const pending=f.memories.extract(draft,'fixture').items[0];f.store.db.prepare('INSERT INTO memory_checkpoints VALUES(?,?,?)').run('legacy-key',id,new Date().toISOString());f.restart();
 assert.equal(f.memories.get(pending.id).status,'proposed');assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM memory_checkpoints').get()!.n),0);
 const [active]=await save(f,draft);assert.equal(active.id,pending.id);assert.equal(active.status,'published');
 const id2=await f.add('Reviewed legacy generated statement','2026-02-01T00:00:00Z'),draft2=output(f,[id2]),legacy=f.memories.extract(draft2,'fixture',{reviewReceipt:{policy:'bounded-exact-review@1',decision:'independent',draftRunId:'legacy',reviewRunId:'legacy-review',checkedAt:new Date().toISOString()}}).items[0];
 assert.equal(legacy.status,'proposed');f.restart();assert.equal(f.memories.get(legacy.id).status,'published');
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

test('portable archives retain deletion intent, reject identity tampering atomically, and accept old archives',async t=>{
 const f=await fixture(t),id=await f.add('Generated temporary interest'),[old]=await save(f,output(f,[id]));f.memories.delete(old.id);
 const archive=f.store.exportArchive(2_000_000),restored=await fixture(t);await restored.store.importArchive(archive);
 const checked=await reviewed(restored,output(restored,[id],'Paraphrased generated interest'));assert.equal(checked.comparisons,1);assert.equal(JSON.parse(checked.result.answer).memories.length,0);
 await restored.store.importArchive(archive);assert.equal(Number(restored.store.db.prepare('SELECT count(*) n FROM memory_deletions').get()!.n),1);
 const bad=structuredClone(archive);bad.memoryDeletions[0].originKeys=['event:'+sha256('tampered')];const target=await fixture(t);
 await assert.rejects(target.store.importArchive(bad),/identity mismatch/);assert.equal(target.store.evidence([id]).length,0);assert.equal(Number(target.store.db.prepare('SELECT count(*) n FROM memory_deletions').get()!.n),0);
 const legacy={...archive,memoryDeletions:undefined};await target.store.importArchive(legacy);assert.equal(target.store.evidence([id]).length,1);
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
 const draft=output(target,[id],'Generated synthesis',{relatedMemoryIds:[old.id]}),check=await reviewed(target,draft),child=target.memories.extract(check.result,'fixture',{tier:'consolidated',requireAdmission:true,relatedMemoryIds:[old.id],reviewReceipt:check.receipt}).items[0];
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
 const sources=new SourceStore(f.store,runtime);sources.register({id:'coding',name:'Generated coding',kind:'coding-agent',deviceId:'fixture',platform:'macos'});runtime.configure('coding',{memory:false,settleSeconds:0});
 await sources.upsert('coding',{externalId:'event-1',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'snapshot',text:'Generated owner preference: use written decisions for batch tasks.',document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'fixture-session',projectKey:'fixture-project',eventId:'000001',role:'user',part:0,parts:1}}});await runtime.tick();
 const material=materials.list().items[0],memories=new MemoryStore(f.store,ids=>[...f.store.evidence(ids),...materials.evidence(ids)],id=>materials.isCurrentEvidence(id)||f.store.isCurrentEvidence(id)),ids=materials.evidenceIds(material.id),records=memories.readEvidence(ids);
 const draft={answer:JSON.stringify({memories:[{title:'Generated private policy',statement:'Generated private preference '+ids.map(id=>'['+id+']').join(' '),uncertainty:'Generated only',evidenceIds:ids,evidence:records.map(r=>({id:r.id,quote:r.ocrText}))}]}),citations:records.map(r=>({id:r.id,capturedAt:r.capturedAt,appName:'Generated',excerpt:''})),trace:[],runId:randomUUID()};
 const memory=memories.extract(draft,'fixture').items[0];memories.delete(memory.id);assert.equal(memories.deletions.export().length,1);assert.ok(memories.deletions.export()[0].dependencies.every(id=>ids.includes(id)));
 runtime.configure('coding',{memory:false,settleSeconds:0});await runtime.tick();assert.equal(memories.deletions.export().length,1,'Rebuilding unchanged archive material must preserve the owner rule');
 const result=runtime.forget('coding');assert.equal(result.erased,true);assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM material_evidence').get()!.n),0);assert.deepEqual(memories.deletions.export(),[]);
});

test('explicit source forgetting erases mixed-source owner rules before removing their dependencies',async t=>{
 const f=await fixture(t),materials=new MaterialStore(f.store),runtime=new SourcePipelineRuntime(f.store,materials,[codingSourcePlugin]);await runtime.ready;t.after(()=>runtime.close());
 const sources=new SourceStore(f.store,runtime);
 for(const sourceId of ['coding-a','coding-b']){
  sources.register({id:sourceId,name:'Generated '+sourceId,kind:'coding-agent',deviceId:'fixture',platform:'macos'});runtime.configure(sourceId,{memory:false,settleSeconds:0});
  await sources.upsert(sourceId,{externalId:'event-1',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'snapshot',text:'Generated private preference from '+sourceId,document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:sourceId,projectKey:'fixture-project',eventId:'000001',role:'user',part:0,parts:1}}});
 }
 await runtime.tick();
 const memories=new MemoryStore(f.store,ids=>[...f.store.evidence(ids),...materials.evidence(ids)],id=>materials.isCurrentEvidence(id)||f.store.isCurrentEvidence(id)),b=materials.list().items.find(m=>m.origin.sourceId==='coding-b')!,bIds=materials.evidenceIds(b.id),allIds=materials.list().items.flatMap(m=>materials.evidenceIds(m.id));
 const make=(ids:string[],statement:string):QueryResult=>({answer:JSON.stringify({memories:[{title:'Generated owner rule',statement,uncertainty:'Generated only',evidenceIds:ids,evidence:memories.readEvidence(ids).map(r=>({id:r.id,quote:r.ocrText}))}]}),citations:memories.readEvidence(ids).map(r=>({id:r.id,capturedAt:r.capturedAt,appName:'Generated',excerpt:''})),trace:[],runId:randomUUID()});
 const saved=([[allIds,'Generated A PRIVATE conclusion combined with B'],[bIds,'Generated independent B conclusion']] as const).map(([ids,statement])=>memories.extract(make([...ids],statement),'fixture').items[0]);for(const memory of saved)memories.delete(memory.id);
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
  const runtime=new SourcePipelineRuntime(target.store,new MaterialStore(target.store),[codingSourcePlugin]);await runtime.ready;t.after(()=>runtime.close());runtime.configure('coding-a',{pipelineId:'mote.coding',memory:false,settleSeconds:0});
  assert.equal(runtime.forget('coding-a').erased,true);assert.deepEqual(target.memories.deletions.export(),[]);assert.equal(target.store.evidence([b]).length,1);
  await target.memories.deletions.review({question:'Generated'},output(target,[b]),async()=>assert.fail('Forgotten A text must not enter subsequent B review'));
 }
});

test('legacy source lineage records only recoverable identities and imported complete lineage cannot omit current sources',async t=>{
 const f=await fixture(t),sources=new SourceStore(f.store);sources.register({id:'expired-source',name:'Generated expired source',kind:'custom',deviceId:'fixture',platform:'import'});
 const expired=(await sources.upsert('expired-source',{externalId:'expired',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text:'Generated expired private evidence.'})).id,id=await f.add('Generated legacy rule evidence','2026-03-01T00:00:00Z'),[memory]=await save(f,output(f,[expired,id]));f.memories.delete(memory.id);f.store.prune('2026-02-01T00:00:00Z');
 const archive=f.store.exportArchive(2_000_000),legacyArchive=structuredClone(archive);for(const value of legacyArchive.memoryDeletions){Reflect.deleteProperty(value,'derivationSourceIds');Reflect.deleteProperty(value,'sourceLineageComplete');}
 f.store.db.prepare("UPDATE memory_deletions SET json=json_remove(json,'$.derivationSourceIds','$.sourceLineageComplete')").run();
 f.restart();const [migrated]=f.memories.deletions.export();assert.deepEqual(migrated.derivationSourceIds,['generated']);assert.equal(migrated.sourceLineageComplete,false);
 const restored=await fixture(t);await restored.store.importArchive(legacyArchive);assert.deepEqual(restored.memories.deletions.export(),[migrated]);
 const bad=structuredClone(archive);bad.memoryDeletions[0].derivationSourceIds=[];const rejected=await fixture(t);await assert.rejects(rejected.store.importArchive(bad),/source lineage mismatch/);assert.equal(rejected.store.evidence([id]).length,0);
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

test('pre-ledger deletion tables migrate their dependency identities and backfill existing payload accounting',async t=>{
 const f=await fixture(t),id=await f.add('Generated historical accounting evidence'),[memory]=await save(f,output(f,[id]));f.memories.delete(memory.id);const expected=f.store.logicalBytes(),intent=f.memories.deletions.export()[0];
 for(const table of ['memory_deletions','memory_deletion_dependencies']){
  for(const action of ['insert','delete','update'])f.store.db.exec(`DROP TRIGGER ledger_${table}_${action}`);
  f.store.db.prepare('DELETE FROM storage_ledger WHERE name=?').run(table);
 }
 f.store.db.exec('DROP TABLE memory_deletion_dependencies;CREATE TABLE memory_deletion_dependencies(deletion_id TEXT NOT NULL REFERENCES memory_deletions(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(deletion_id,evidence_id))');f.store.db.prepare('INSERT INTO memory_deletion_dependencies VALUES(?,?)').run(intent.id,id);
 f.restart({},store=>assert.doesNotThrow(()=>store.logicalBytes(),'Ledger may run before Memory dependency migration'));
 assert.equal(f.store.logicalBytes(),expected);assert.deepEqual(f.memories.deletions.export(),[intent]);assert.notEqual(f.store.db.prepare('SELECT origin_keys FROM memory_deletion_dependencies').get()!.origin_keys,'[]');
 f.store.delete(id);assert.equal(f.store.db.prepare("SELECT sum(bytes) n FROM storage_ledger WHERE name IN ('memory_deletions','memory_deletion_dependencies')").get()!.n,0);
});
