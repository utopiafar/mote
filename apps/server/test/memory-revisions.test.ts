import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {memoryProfile} from '../src/memory-profiles.js';
import {withinEvidenceScope} from '../src/evidence-reader.js';
import {MemoryStore} from '../src/memory.js';
import type {Memory} from '../src/memory-schema.js';
async function fixture(t:TestContext){const dir=mkdtempSync(join(tmpdir(),'mote-memory-revisions-')),store=new Store(dir),sources=new SourceStore(store),memories=new MemoryStore(store);sources.register({id:'generated',name:'Generated changes',kind:'custom',deviceId:'generated',platform:'import'});t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});const ids=[];for(const [i,text] of ['In January I explicitly prefer afternoon meetings.','From February I explicitly prefer morning meetings.','Correction: this preference concerns only the generated project.'].entries())ids.push((await sources.upsert('generated',{externalId:String(i),revision:'1',observedAt:`2026-0${i+1}-01T00:00:00Z`,kind:'message',layer:'original',text})).id);return {store,memories,ids};}
function save(f:Awaited<ReturnType<typeof fixture>>,ids:string[],extra:Record<string,unknown>={}){return f.memories.extract({answer:JSON.stringify({memories:[{title:'Generated scoped preference',statement:`Generated source statement ${ids.map(id=>`[${id}]`).join(' ')}`,uncertainty:'Fixture only',evidenceIds:ids,evidence:ids.map(id=>({id,quote:f.store.evidence([id])[0].ocrText})),...extra}]}),citations:ids.map(id=>({id,capturedAt:f.store.evidence([id])[0].capturedAt,appName:'Generated',excerpt:''})),trace:[],runId:randomUUID()},'fixture').items[0];}
const relation=(m:Memory,kind='supersedes')=>({kind,memoryId:m.id,fingerprint:m.fingerprint,version:m.version??1});
test('automatic supersession remains a proposal; explicit version-bound publication preserves current and historical values',async t=>{
 const f=await fixture(t),first=f.memories.publish(save(f,[f.ids[0]],{validFrom:'2026-01-01T00:00:00Z'}).id);const next=save(f,f.ids.slice(0,2),{validFrom:'2026-02-01T00:00:00Z',relations:[relation(first)]});assert.equal(f.memories.get(first.id).supersededBy,undefined);assert.throws(()=>f.memories.publish(next.id),{statusCode:409});assert.throws(()=>f.memories.publish(next.id,99),{statusCode:409});f.memories.publish(next.id,next.version);assert.equal(f.memories.get(first.id).supersededBy,next.id);assert.equal(f.memories.page({status:'published',asOf:'2026-01-15T00:00:00Z'}).items[0].id,first.id);assert.deepEqual(f.memories.page({status:'published',asOf:'2026-02-15T00:00:00Z'}).items.map(m=>m.id),[next.id]);assert.equal(f.memories.page({status:'published',includeHistory:true}).items.length,2);assert.ok(f.memories.text(first.id).includes(f.ids[0]));
});
test('contradictions keep both statements and stale relation versions cannot overwrite a later confirmation',async t=>{
 const f=await fixture(t),first=save(f,[f.ids[0]]),next=save(f,f.ids.slice(0,2),{relations:[relation(first,'contradicts')]});f.memories.publish(first.id);assert.throws(()=>f.memories.publish(next.id,next.version),{statusCode:409});const contradiction=save(f,f.ids.slice(0,2),{title:'A versioned contradiction',relations:[relation(f.memories.get(first.id),'contradicts')]});f.memories.publish(contradiction.id,contradiction.version);assert.equal(f.memories.get(first.id).supersededBy,undefined);assert.equal(f.memories.page({status:'published'}).items.length,2);
});
test('relationships need retrieved target proof and explicit valid intervals hide expired memories without deleting history',async t=>{
 const f=await fixture(t),first=f.memories.publish(save(f,[f.ids[0]]).id);assert.throws(()=>save(f,[f.ids[1]],{relations:[relation(first)]}),{code:'scope'});const timed=save(f,[f.ids[2]],{validFrom:'2026-03-01T00:00:00Z',validUntil:'2026-04-01T00:00:00Z'});f.memories.publish(timed.id);assert.equal(f.memories.page({id:timed.id,asOf:'2026-03-10T00:00:00Z'}).items.length,1);assert.equal(f.memories.page({id:timed.id,asOf:'2026-04-01T00:00:00Z'}).items.length,0);assert.equal(f.memories.page({id:timed.id,includeHistory:true}).items.length,1);
});

test('owner correction is atomic, independently attributed original evidence; stale review cannot overwrite it',async t=>{
 const f=await fixture(t),old=f.memories.publish(save(f,[f.ids[0]]).id),proposal=save(f,f.ids.slice(0,2),{relations:[relation(old)]});
 const corrected=await f.memories.correct(old.id,{version:old.version,title:'Owner correction',statement:'My preference concerns the generated project only.',validFrom:'2026-02-01T08:00:00+08:00'});
 assert.equal(corrected.status,'published');assert.equal(corrected.admission?.attribution,'user');assert.equal(corrected.model,'owner');assert.equal(corrected.evidenceIds.length,1);
 const note=f.store.evidence(corrected.evidenceIds)[0];assert.equal(note.source,'note');assert.equal(note.provenance,undefined);assert.equal(note.ocrText,'My preference concerns the generated project only.');assert.equal(f.memories.get(old.id).supersededBy,corrected.id);
 await assert.rejects(f.memories.correct(old.id,{version:old.version,title:'Late correction',statement:'Must not overwrite.'}),{statusCode:409});assert.throws(()=>f.memories.publish(proposal.id,proposal.version),{statusCode:409});
 const notes=Number(f.store.db.prepare("SELECT count(*) n FROM captures WHERE json_extract(json,'$.source')='note'").get()!.n);assert.equal(notes,1);
 assert.deepEqual(f.memories.page({status:'published',asOf:'2026-02-01T00:00:00Z'}).items.map(m=>m.id),[corrected.id]);
 assert.deepEqual(f.memories.page({status:'published',asOf:'2026-01-31T23:59:59Z'}).items.map(m=>m.id),[old.id]);
 await assert.rejects(f.memories.correct(corrected.id,{version:corrected.version,title:'Bad validity',statement:'Cannot save expired range.',validUntil:'2000-01-01T00:00:00Z'}),{statusCode:400});
 f.store.delete(f.ids[0]);assert.equal(f.memories.get(corrected.id).statement.includes(note.id),true);
});
test('coding correction retains owner attribution and exact project/session scope through extraction and retrieval',async t=>{
 const f=await fixture(t),sources=new SourceStore(f.store);sources.register({id:'code',name:'Generated coding',kind:'coding-agent',deviceId:'generated',platform:'macos'});
 const ack=await sources.upsert('code',{externalId:'code',revision:'1',observedAt:'2026-01-01T00:00:00Z',kind:'message',layer:'original',text:'For project-a use explicit transactions.',document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'s1',projectKey:'project-a',eventId:'e1',role:'user',part:0,parts:1}}});
 const result={answer:JSON.stringify({memories:[{title:'Project transaction policy',statement:`Explicit transaction policy [${ack.id}]`,uncertainty:'project-a only',evidenceIds:[ack.id],evidence:[{id:ack.id,quote:'For project-a use explicit transactions.'}],coding:{kind:'decision',scope:'project',applicability:'project-a',validation:'observed'}}]}),citations:[{id:ack.id,capturedAt:'2026-01-01T00:00:00Z',appName:'Fixture',excerpt:''}],trace:[],runId:'coding-fixture'};
 const old=f.memories.extract(result,'fixture',{profile:'coding'}).items[0],corrected=await f.memories.correct(old.id,{version:old.version,title:'Corrected transaction policy',statement:'In project-a transactions apply only to batch writes.'});
 assert.deepEqual(corrected.scopeRefs,old.scopeRefs);assert.equal(corrected.coding?.validation,'user_confirmed');const note=f.store.evidence(corrected.evidenceIds)[0];assert.equal(memoryProfile(note).id,'coding');assert.equal(withinEvidenceScope(note,{projectKey:'project-a',sessionId:'s1'}),true);assert.equal(withinEvidenceScope(note,{projectKey:'project-b'}),false);
 const draft=JSON.parse(result.answer).memories[0];draft.statement=`Explicit correction [${note.id}]`;draft.evidenceIds=[note.id];draft.evidence=[{id:note.id,quote:note.ocrText}];const candidate=f.memories.extract({...result,answer:JSON.stringify({memories:[draft]}),citations:[{id:note.id,capturedAt:note.capturedAt,appName:'Fixture',excerpt:''}]},'fixture',{profile:'coding'}).items[0];assert.deepEqual(candidate.scopeRefs,old.scopeRefs);assert.equal(candidate.status,'proposed');assert.equal(f.memories.get(corrected.id).supersededBy,undefined);const other=await sources.upsert('code',{externalId:'other',revision:'1',observedAt:'2026-01-02T00:00:00Z',kind:'message',layer:'original',text:'Project-b also has a different policy.',document:{contentRole:'transcript',coding:{version:1,provider:'codex',sessionId:'b1',projectKey:'project-b',eventId:'b',role:'user',part:0,parts:1}}});draft.evidenceIds.push(other.id);draft.evidence.push({id:other.id,quote:'Project-b also has a different policy.'});draft.relations=[relation(corrected)];assert.throws(()=>f.memories.extract({...result,answer:JSON.stringify({memories:[draft]}),citations:[note,f.store.evidence([other.id])[0]].map(r=>({id:r.id,capturedAt:r.capturedAt,appName:'Fixture',excerpt:''}))},'fixture',{profile:'coding'}),{code:'scope'});
});

test('concurrent owner corrections bind one version and roll back the losing note',async t=>{
 const f=await fixture(t),old=save(f,[f.ids[0]]),input={version:old.version,title:'Concurrent owner correction',statement:'Only one explicit replacement may win.'};
 const results=await Promise.allSettled([f.memories.correct(old.id,input),f.memories.correct(old.id,input)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.statusCode===409).length,1);assert.equal(Number(f.store.db.prepare("SELECT count(*) n FROM captures WHERE json_extract(json,'$.source')='note'").get()!.n),1);assert.equal(f.memories.list().length,1);
});

test('validation works on a read-only database and a cached claim cannot commit after evidence deletion',async t=>{
 const f=await fixture(t),id=f.ids[0],record=f.store.evidence([id])[0];
 const result={answer:JSON.stringify({memories:[{title:'Generated preference',statement:`Generated preference [${id}]`,uncertainty:'Fixture',evidenceIds:[id],evidence:[{id,quote:record.ocrText}]}]}),citations:[{id,capturedAt:record.capturedAt,appName:'Generated',excerpt:record.ocrText}],trace:[],runId:randomUUID()};
 f.store.db.exec('PRAGMA query_only=ON');try{assert.doesNotThrow(()=>f.memories.extract(result,'fixture',{validateOnly:true}));}finally{f.store.db.exec('PRAGMA query_only=OFF');}
 assert.equal(f.memories.list().length,0);f.store.delete(id);assert.throws(()=>f.memories.extract(result,'fixture'));assert.equal(f.memories.list().length,0);
});
