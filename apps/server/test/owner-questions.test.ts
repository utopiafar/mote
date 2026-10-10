import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';
import {Store} from '../src/store.js';
import {SourceStore} from '../src/sources.js';
import {MaterialStore,materialId} from '../src/materials.js';
import {OwnerQuestions} from '../src/owner-questions.js';
import {register} from '../src/features/owner-questions.js';
import type {OwnerQuestionCreate,OwnerQuestionProvider,OwnerQuestionReply} from '../src/owner-question-contract.js';

async function fixture(t:import('node:test').TestContext,encrypted=false){
 const directory=mkdtempSync(join(tmpdir(),'mote-owner-questions-')),store=new Store(directory,encrypted?{dataKey:'ab'.repeat(32),contentEncryptionEnabled:true}:{}),sources=new SourceStore(store);
 sources.register({id:'generated',name:'Generated source',kind:'custom',deviceId:'fixture',platform:'import'});
 const id=(await sources.upsert('generated',{externalId:'one',revision:'1',observedAt:'2026-09-01T00:00:00Z',text:'Generated original without person identifiers.',kind:'file',layer:'original'})).id;
 const questions=new OwnerQuestions(store);t.after(()=>{store.close();rmSync(directory,{force:true,recursive:true});});
 const provider:OwnerQuestionProvider={id:'fixture.questions',version:'1',installationEpoch:'installation-one',validate:()=>true,answer:(_record,reply)=>reply.action==='unknown'?{kind:'closed',outcome:'Attribution remains unknown.'}:{kind:'followup',prompt:'Please clarify the identity in this generated original.'}};
 const input:OwnerQuestionCreate={key:'generated-current-range',operationId:'fixture:work',workId:'work-one',title:'Generated question',prompt:'Which generated speaker is you?',evidence:[{id,quote:'Generated original',offset:0}],choices:[{id:'first',label:'First speaker',answer:'The first speaker in this original is me.'}],dependencyIds:[id],context:{fixture:'Private provider context'}};
 return {directory,store,id,questions,provider,input};
}
const answer=(revision:number,extras:Partial<OwnerQuestionReply>={}):OwnerQuestionReply=>({requestId:randomUUID(),expectedRevision:revision,action:'answer',answer:'  Exact owner answer.  ',...extras});

test('structural identity survives restart and never guesses from prose or returns private provider context',async t=>{
 const {store,questions,provider,input}=await fixture(t,true);questions.register(provider);
 const first=questions.create(provider,input),again=questions.create(provider,{...input,title:'Different model wording',prompt:'Reworded prompt'});
 assert.equal(first.id,again.id);assert.equal(first.revision,1);assert.equal(first.messages.length,1);assert.equal(questions.page().items.length,1);assert(!('context' in first));assert(!('installationEpoch' in first));
 const stored=String(store.db.prepare('SELECT json FROM owner_questions WHERE id=?').get(first.id)!.json);assert.match(stored,/aes:/);assert.doesNotMatch(stored,/Generated question|Which generated|Private provider context/);
 const restarted=new OwnerQuestions(store);restarted.register(provider);assert.equal(restarted.get(first.id).prompt,first.prompt);assert.equal(restarted.create(provider,input).id,first.id);
 assert.notEqual(restarted.create(provider,{...input,key:'another-exact-range'}).id,first.id);
});

test('owner HTTP lifecycle keeps one question through defer, unknown, clarification and authored choice',async t=>{
 const {questions,provider,input}=await fixture(t);const seen:OwnerQuestionReply[]=[];let effects=0;
 provider.answer=(_record,reply)=>{seen.push(reply);return reply.action==='unknown'?{kind:'closed',outcome:'Unknown retained.'}:reply.choiceId?{kind:'continued',continuationId:'fixture:continuation',outcome:'Scope-specific work queued.'}:{kind:'followup',prompt:'Which exact speaker is you?',choices:input.choices};};
 provider.commit=()=>{effects++;};questions.register(provider);let current=questions.create(provider,input);
 const app=Fastify();t.after(()=>app.close());app.setErrorHandler((error,_request,reply)=>reply.code(error.name==='ZodError'?400:(error as {statusCode?:number}).statusCode??500).send({error:error.message}));register(app,{ownerQuestions:questions,credential:req=>req.headers.authorization==='Bearer collector'});
 for(const url of ['/api/owner-questions','/api/owner-questions/'+current.id])assert.equal((await app.inject({url,headers:{authorization:'Bearer collector'}})).statusCode,403);
 const replyUrl='/api/owner-questions/'+current.id+'/reply';assert.equal((await app.inject({url:replyUrl,method:'POST',headers:{authorization:'Bearer collector'},payload:{}})).statusCode,403);
 const deferred=await app.inject({url:replyUrl,method:'POST',payload:{requestId:randomUUID(),expectedRevision:current.revision,action:'defer'}});assert.equal(deferred.statusCode,200);current=deferred.json();assert.equal(current.state,'deferred');assert.equal(current.messages.at(-1)?.role,'user');assert.equal(current.messages.at(-1)?.text,'稍后再说');assert.equal(seen.length,0);
 const closed=await app.inject({url:replyUrl,method:'POST',payload:{requestId:randomUUID(),expectedRevision:current.revision,action:'unknown'}});assert.equal(closed.statusCode,200);current=closed.json();assert.equal(current.state,'closed');assert.equal(current.messages.at(-1)?.text,'我也不知道，结束这次追问');assert.equal(questions.page({state:['open','deferred']}).items.length,0);
 const followup=await app.inject({url:replyUrl,method:'POST',payload:answer(current.revision)});assert.equal(followup.statusCode,200);current=followup.json();assert.equal(current.state,'open');assert.equal(current.messages.at(-2)?.text,'  Exact owner answer.  ');assert.equal(current.messages.at(-1)?.text,'Which exact speaker is you?');assert.equal(questions.page().items.length,1,'follow-up remains the same durable question');
 const continued=await app.inject({url:replyUrl,method:'POST',payload:{requestId:randomUUID(),expectedRevision:current.revision,action:'answer',choiceId:'first'}});assert.equal(continued.statusCode,200);current=continued.json();assert.equal(current.state,'answered');assert.equal(current.continuationId,'fixture:continuation');assert.equal(seen.at(-1)?.answer,input.choices![0].answer);assert.equal(effects,3);
 assert.equal((await app.inject({url:'/api/owner-questions?state=open,deferred'})).json().items.length,0);
 assert.equal((await app.inject({url:replyUrl,method:'POST',payload:answer(current.revision)})).statusCode,409,'continued work cannot be spawned twice through a fresh request');
 assert.equal((await app.inject({url:replyUrl,method:'POST',payload:{...answer(current.revision),choiceId:'first'}})).statusCode,400);
});

test('identical replies share preparation and transactional effects, and durable receipts prevent replay after restart',async t=>{
 const {store,questions,provider,input}=await fixture(t);let calls=0,effects=0,release!:()=>void;
 const ready=new Promise<void>(resolve=>{release=resolve;});provider.answer=async()=>{calls++;await ready;return {kind:'continued',continuationId:'fixture:once'};};provider.commit=()=>{effects++;};questions.register(provider);const question=questions.create(provider,input),reply=answer(question.revision);
 const one=questions.reply(question.id,reply),two=questions.reply(question.id,reply);assert.equal(calls,1);
 await assert.rejects(questions.reply(question.id,{...reply,answer:'Changed request payload'}),/reused/);
 release();assert.equal((await one).continuationId,'fixture:once');assert.equal((await two).revision,2);assert.equal(effects,1);
 const restarted=new OwnerQuestions(store);restarted.register(provider);assert.equal((await restarted.reply(question.id,reply)).revision,2);assert.equal(calls,1);assert.equal(effects,1);
 await assert.rejects(restarted.reply(question.id,{...reply,answer:'Changed request payload'}),/reused/);
});

test('provider uninstall does not resume work and a different installation epoch retires the old question',async t=>{
 const {questions,provider,input}=await fixture(t);const dispose=questions.register(provider),question=questions.create(provider,input);dispose();
 assert.equal(questions.get(question.id).state,'open');await assert.rejects(questions.reply(question.id,answer(1)),/unavailable/);
 questions.register({...provider,installationEpoch:'replacement-installation'});const retired=questions.get(question.id);assert.equal(retired.state,'obsolete');assert.equal(retired.messages.length,0);assert.equal(retired.prompt,'');await assert.rejects(questions.reply(question.id,answer(retired.revision)),/obsolete/);
 assert.notEqual(questions.create(provider,input).id,question.id,'new installation has independent durable question identity');
});

test('dependency deletion immediately scrubs private prose and fences an in-flight reply',async t=>{
 const {store,id,questions,provider,input}=await fixture(t,true);let release!:()=>void,effects=0;
 const pending=new Promise<void>(resolve=>{release=resolve;});provider.answer=async()=>{await pending;return {kind:'continued',continuationId:'must-not-run'};};provider.commit=()=>{effects++;};questions.register(provider);const question=questions.create(provider,input),reply=questions.reply(question.id,answer(1));
 store.delete(id);const raw=String(store.db.prepare('SELECT json FROM owner_questions WHERE id=?').get(question.id)!.json);assert.doesNotMatch(raw,/aes:|Generated question|Private provider context/);assert.equal(JSON.parse(raw).state,'obsolete');
 release();await assert.rejects(reply,/changed/);assert.equal(effects,0);assert.equal(questions.get(question.id).evidence.length,0);
});

test('changed provider validation fences prepared answers',async t=>{
 const {questions,provider,input}=await fixture(t);let valid=true,release!:()=>void,effects=0;
 provider.validate=()=>valid;provider.answer=async()=>{await new Promise<void>(resolve=>{release=resolve;});return {kind:'continued',continuationId:'must-not-run'};};provider.commit=()=>{effects++;};questions.register(provider);const question=questions.create(provider,input),reply=questions.reply(question.id,answer(1));
 valid=false;release();await assert.rejects(reply,/changed/);assert.equal(questions.get(question.id).state,'obsolete');assert.equal(effects,0);
});

test('a concurrent defer revision prevents a previously prepared continuation from committing',async t=>{
 const {questions,provider,input}=await fixture(t);let release!:()=>void,effects=0;
 provider.answer=async()=>{await new Promise<void>(resolve=>{release=resolve;});return {kind:'continued',continuationId:'stale-preparation'};};provider.commit=()=>{effects++;};questions.register(provider);const question=questions.create(provider,input),pending=questions.reply(question.id,answer(1));
 const deferred=await questions.reply(question.id,{requestId:randomUUID(),expectedRevision:1,action:'defer'});assert.equal(deferred.revision,2);release();await assert.rejects(pending,/changed/);assert.equal(effects,0);assert.equal(questions.get(question.id).state,'deferred');
});

test('a provider effect cannot restore personal prose after it deletes the original dependency',async t=>{
 const {store,id,questions,provider,input}=await fixture(t,true);provider.answer=()=>({kind:'continued',continuationId:'invalidated-effect'});provider.commit=()=>{store.db.prepare('DELETE FROM captures WHERE id=?').run(id);};questions.register(provider);const question=questions.create(provider,input);
 await assert.rejects(questions.reply(question.id,answer(1)),/evidence changed/);assert.equal(questions.get(question.id).state,'open','failed effect and retirement are rolled back together');assert.equal(store.evidence([id]).length,1);assert.equal(store.db.prepare('SELECT count(*) n FROM owner_question_replies').get()!.n,0);
});

test('a real vault close and reopen preserves the reply receipt without another provider effect',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-owner-question-reopen-'));let store=new Store(directory),effects=0;
 t.after(()=>{store.close();rmSync(directory,{force:true,recursive:true});});
 const provider:OwnerQuestionProvider={id:'fixture.restart',version:'1',installationEpoch:'restart-install',validate:()=>true,answer:()=>({kind:'continued',continuationId:'restart:once'}),commit:()=>{effects++;}};
 let questions=new OwnerQuestions(store);questions.register(provider);const question=questions.create(provider,{key:'current',operationId:'restart:work',workId:'restart-work',title:'Generated restart question',prompt:'Confirm this generated value.',choices:[],evidence:[],dependencyIds:[]}),reply=answer(1);
 assert.equal((await questions.reply(question.id,reply)).state,'answered');store.close();store=new Store(directory);questions=new OwnerQuestions(store);questions.register(provider);assert.equal((await questions.reply(question.id,reply)).continuationId,'restart:once');assert.equal(effects,1);
});

test('provider continuation writes and receipts roll back together on a host quota/commit failure',async t=>{
 const {store,questions,provider,input}=await fixture(t);store.db.exec('CREATE TABLE generated_effects(id TEXT PRIMARY KEY)');
 provider.answer=()=>({kind:'continued',continuationId:'generated-effect',data:{interpretation:'Generated ephemeral interpretation'}});provider.commit=()=>{store.db.prepare('INSERT INTO generated_effects VALUES(?)').run('once');throw Error('Generated provider effect failure');};questions.register(provider);const question=questions.create(provider,input),reply=answer(1);
 await assert.rejects(questions.reply(question.id,reply),/Generated provider effect failure/);assert.equal(store.db.prepare('SELECT count(*) n FROM generated_effects').get()!.n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM owner_question_replies').get()!.n,0);assert.equal(questions.get(question.id).revision,1);
 provider.commit=(_record,_reply,prepared)=>{assert.deepEqual(prepared.data,{interpretation:'Generated ephemeral interpretation'});store.db.prepare('INSERT INTO generated_effects VALUES(?)').run('once');};const continued=await questions.reply(question.id,reply);assert.equal(continued.state,'answered');assert(!('data' in continued));assert.doesNotMatch(String(store.db.prepare('SELECT json FROM owner_questions WHERE id=?').get(question.id)!.json),/Generated ephemeral interpretation/);assert.equal(store.db.prepare('SELECT count(*) n FROM generated_effects').get()!.n,1);
});

test('server filters scope and state before stable cursor pagination',async t=>{
 const {questions,provider,input}=await fixture(t);questions.register(provider);for(let index=0;index<9;index++)questions.create(provider,{...input,key:'range-'+index,workId:index%2?'other-work':'selected-work',materialId:index%2?'other-material':'selected-material'});
 const ids:string[]=[];let cursor:string|undefined;do{const page=questions.page({workId:'selected-work',materialId:'selected-material',state:['open','deferred'],limit:2,cursor});ids.push(...page.items.map(question=>question.id));cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(ids.length,5);assert.equal(new Set(ids).size,5);assert.equal(questions.page({workId:'missing-work'}).items.length,0);assert.throws(()=>questions.page({cursor:'invalid'}),/cursor/);
});

test('lazy validation skips retired first candidates without hiding a later pending question',async t=>{
 const {store,questions,provider,input}=await fixture(t);const invalid=new Set<string>();provider.validate=record=>!invalid.has(record.question.id);questions.register(provider);
 const older=questions.create(provider,{...input,key:'older-valid'}),newer=questions.create(provider,{...input,key:'newer-invalid'});
 store.db.prepare("UPDATE owner_questions SET updated_at='2026-09-01T00:00:00Z' WHERE id=?").run(older.id);store.db.prepare("UPDATE owner_questions SET updated_at='2026-09-02T00:00:00Z' WHERE id=?").run(newer.id);invalid.add(newer.id);
 const page=questions.page({operationId:input.operationId,state:['open','deferred'],limit:1});assert.equal(page.items.length,1);assert.equal(page.items[0].id,older.id);assert.equal(page.nextCursor,null);assert.equal(questions.get(newer.id).state,'obsolete');
});

test('aggregated operation ID filters apply on the server before cursor pagination',async t=>{
 const {questions,provider,input}=await fixture(t);questions.register(provider);
 for(let index=0;index<9;index++)questions.create(provider,{...input,key:'operation-range-'+index,operationId:['first-op','second-op','unrelated-op'][index%3]});
 const app=Fastify();t.after(()=>app.close());app.setErrorHandler((error,_request,reply)=>reply.code(error.name==='ZodError'?400:(error as {statusCode?:number}).statusCode??500).send({error:error.message}));register(app,{ownerQuestions:questions,credential:()=>false});
 const ids:string[]=[];let cursor:string|undefined;do{const query=new URLSearchParams({operationIds:JSON.stringify(['first-op','second-op']),state:'open,deferred',limit:'2',...(cursor?{cursor}:{})});const response=await app.inject({url:'/api/owner-questions?'+query});assert.equal(response.statusCode,200);const page=response.json();assert.ok(page.items.every((question:{operationId:string})=>['first-op','second-op'].includes(question.operationId)));ids.push(...page.items.map((question:{id:string})=>question.id));cursor=page.nextCursor??undefined;}while(cursor);
 assert.equal(ids.length,6);assert.equal(new Set(ids).size,6);assert.equal((await app.inject({url:'/api/owner-questions?operationIds=invalid-json'})).statusCode,400);
});

test('provider effects must leave a valid current record before the host commits personal prose',async t=>{
 const {store,questions,provider,input}=await fixture(t);store.db.exec('CREATE TABLE generated_validated_effects(id TEXT PRIMARY KEY)');provider.validate=record=>!(record.context as {invalid?:boolean}).invalid;provider.answer=()=>({kind:'continued',continuationId:'invalid-record'});provider.commit=record=>{record.context={invalid:true};store.db.prepare('INSERT INTO generated_validated_effects VALUES(?)').run('rollback');};questions.register(provider);const question=questions.create(provider,input);
 await assert.rejects(questions.reply(question.id,answer(1)),/continuation failed current validation/);assert.equal(questions.get(question.id).revision,1);assert.equal(store.db.prepare('SELECT count(*) n FROM generated_validated_effects').get()!.n,0);assert.equal(store.db.prepare('SELECT count(*) n FROM owner_question_replies').get()!.n,0);
});

test('enabling private content encryption seals existing plaintext question envelopes at startup',async t=>{
 const {store,questions,provider,input}=await fixture(t);questions.register(provider);const question=questions.create(provider,input);assert.match(String(store.db.prepare('SELECT json FROM owner_questions WHERE id=?').get(question.id)!.json),/json:/);
 store.contentEncryption.setEnabled(true);const restarted=new OwnerQuestions(store);restarted.register(provider);const raw=String(store.db.prepare('SELECT json FROM owner_questions WHERE id=?').get(question.id)!.json);assert.match(raw,/aes:/);assert.doesNotMatch(raw,/Which generated|Private provider context/);assert.equal(restarted.get(question.id).prompt,input.prompt);
});

test('question payloads, dependencies, reply receipts and material declarations join the transactional storage ledger',async t=>{
 const {store,id,questions,provider,input}=await fixture(t,true);questions.register(provider);const question=questions.create(provider,input);await questions.reply(question.id,answer(1));
 const materials=new MaterialStore(store),material=materials.publish({id:materialId('generated','ledger'),kind:'mote.file',schemaVersion:1,title:'Generated ledger material',origin:{sourceId:'generated',externalId:'ledger'},members:[{id:'original',kind:'capture',ref:'capture:'+id}],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated original without person identifiers.',memberIds:['original']}],coverage:{state:'complete'},artifacts:[{key:'body',state:'ready'}],fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 materials.declareContext(material.id,material.revision,{id:question.id,question:'Generated source question',answer:'Generated owner declaration'});store.logicalBytes();
 for(const table of ['owner_questions','owner_question_dependencies','owner_question_replies','material_owner_declarations'])assert.ok(Number(store.db.prepare('SELECT bytes FROM storage_ledger WHERE name=?').get(table)!.bytes)>0,table);
 const before=Number(store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='owner_questions'").get()!.bytes);store.delete(id);assert.ok(Number(store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='owner_questions'").get()!.bytes)<before,'private retirement updates ledger immediately');assert.equal(Number(store.db.prepare("SELECT bytes FROM storage_ledger WHERE name='material_owner_declarations'").get()!.bytes),0,'forgotten material declaration is accounted on cascade');
});

test('material declarations migrate to encryption at startup without changing attribution identity, and material forgetting scrubs anchorless questions',async t=>{
 const {store,questions,provider,input}=await fixture(t);const materials=new MaterialStore(store),material=materials.publish({id:materialId('generated','private-declaration'),kind:'mote.file',schemaVersion:1,title:'Generated private material',origin:{sourceId:'generated',externalId:'private-declaration'},members:[],blocks:[{id:'body',kind:'text',format:'plain',text:'Generated unanchored original.',memberIds:[]}],coverage:{state:'complete'},artifacts:[{key:'body',state:'ready'}],fidelity:{state:'lossless'},retention:{original:'retained',policy:'keep'}});
 const id=randomUUID(),updated=materials.declareContext(material.id,material.revision,{id,question:'Generated private declaration question',answer:'Generated private owner declaration'}),prior=String(store.db.prepare('SELECT json FROM material_owner_declarations').get()!.json);assert.match(prior,/json:/);
 store.contentEncryption.setEnabled(true);const restarted=new MaterialStore(store),raw=String(store.db.prepare('SELECT json FROM material_owner_declarations').get()!.json);assert.match(raw,/aes:/);assert.doesNotMatch(raw,/Generated private declaration question|Generated private owner declaration/);assert.equal(restarted.get(material.id)!.revision,updated.revision);assert.equal(restarted.get(material.id)!.attributionContext?.ownerStatements?.[0].answer,'Generated private owner declaration');
 const host=new OwnerQuestions(store);host.register(provider);const question=host.create(provider,{...input,materialId:material.id,materialRef:updated.ref,dependencyIds:[]});restarted.forget(material.id);const forgotten=String(store.db.prepare('SELECT json FROM owner_questions WHERE id=?').get(question.id)!.json);assert.doesNotMatch(forgotten,/aes:|json:/);assert.equal(host.get(question.id).state,'obsolete');assert.equal(store.db.prepare('SELECT count(*) n FROM material_owner_declarations').get()!.n,0);
});
