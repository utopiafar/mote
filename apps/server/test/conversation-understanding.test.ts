import {fixtureMemoryResult} from './fixtures/memory-result.js';
import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {Store} from '../src/store.js';
import {MaterialStore,materialId,type MaterialReadPage} from '../src/materials.js';
import {MemoryStore} from '../src/memory.js';
import {UsageLedger} from '../src/usage.js';
import {parseSemanticProducts} from '../src/semantic-extraction.js';
import {conversationUnderstandingProcessor,type ConversationUnderstandingOptions} from '../src/conversation-understanding.js';

const userTime='2099-01-01T10:00:00Z',assistantTime='2099-01-01T10:06:00Z';
const user=`## user · Recorded: ${userTime}\n\nGenerated fixture: Keep the monorepo and release each client independently.\n\n`;
const assistant=`## assistant · Recorded: ${assistantTime}\n\nGenerated fixture: PR #123 is ready; automatic tests passed. Device checks are still pending.\n\n`;
const body=user+assistant+'Generated unselected original remains searchable.';
const config={owner:'models' as const,fingerprint:'a'.repeat(64),revision:1,profileId:'generated',provider:'openai',model:'fixture',configured:true};
async function fixture(t:TestContext){
 const dir=mkdtempSync(join(tmpdir(),'mote-conversation-understanding-')),store=new Store(dir),materials=new MaterialStore(store);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const id='00000000-0000-4000-8000-000000000123';
 await store.ingest({id,deviceId:'fixture',deviceName:'Generated',platform:'import',source:'message',capturedAt:'2026-01-01T00:00:00Z',durationMs:0,ocrText:'Generated source membership'});
 const material=materials.publish({id:materialId('fixture','conversation'),kind:'mote.coding-session',schemaVersion:6,title:'Generated session',
  origin:{sourceId:'fixture',externalId:'conversation',deviceId:'fixture',provider:'codex',projectKey:'generated-project',projectIdentity:'workspace',sessionId:'generated-session'},
  blocks:[{id:'section-0',kind:'text',format:'markdown-fragment',text:body,memberIds:['source']}],members:[{id:'source',kind:'capture',ref:'capture:'+id}],
  coverage:{state:'complete'},artifacts:[{key:'conversation',state:'ready'}],fidelity:{state:'derived',limitations:['metadata_projected','tools_excluded']},retention:{original:'retained',policy:'keep'}});
 const anchor=materials.evidenceIds(material.ref)[0],records=materials.evidence([anchor]);
 // Preserve the host read fields on versions predating the read-span extension.
 const page=(offset=0,length=12000):MaterialReadPage=>{const read=materials.read(material.ref,{offset,length});return {...read,spans:read.spans.map(span=>({...span,evidenceId:anchor,evidenceOffset:offset}))};};
 const memories=new MemoryStore(store,ids=>[...store.evidence(ids),...materials.evidence(ids)],id=>store.isCurrentEvidence(id)||materials.isCurrentEvidence(id));
 const resolveEvidence:ConversationUnderstandingOptions['resolveEvidence']=read=>({records,ranges:[{id:anchor,offset:read.textRange.offset,length:read.text.length}]});
 return {store,materials,memories,anchor,records,page,resolveEvidence};
}
function claim(id:string,quote:string,overrides:Record<string,unknown>={}){
 return {statement:'Generated owner requests independent client releases',actor:'user',status:'request',basis:'direct_expression',sourceTime:userTime,uncertainty:'Generated project only',evidence:[{id,quote}],...overrides};
}
function products(id:string,memory=true){
 return {summary:'Generated monorepo release work; assistant reports tests passed and device checks pending',evidence:[{id,quote:user}],
  workRecords:[{title:'Generated independent releases',requirements:[claim(id,user)],constraints:[],decisions:[],
   results:[claim(id,assistant,{statement:'Assistant reports automatic tests passed',actor:'assistant',status:'reported_outcome',basis:'assistant_reported',sourceTime:assistantTime})],
   validation:[claim(id,assistant,{statement:'Device checks are pending',actor:'assistant',status:'unknown',basis:'assistant_reported',sourceTime:assistantTime})],
   openItems:[],artifactRefs:[claim(id,assistant,{ref:'PR #123',statement:'Assistant reports PR #123 is ready',actor:'assistant',status:'reported_outcome',basis:'assistant_reported',sourceTime:assistantTime})]}],
  events:[claim(id,user,{statement:'Owner requested independent client releases'})],
  memoryCandidates:memory?[{domain:'personal',title:'Generated release requirement',statement:`The owner requested independent client releases in the generated project [${id}]`,uncertainty:'Project only',admission:{layer:'memory',reason:'Explicit project constraint for later work',scope:'Generated project only',attribution:'user'},evidenceIds:[id],evidence:[{id,quote:user}]}]:[],actionCues:[]};
}
function result(id:string,output:unknown):QueryResult{return {answer:JSON.stringify(output),citations:[{id,capturedAt:'2026-01-01T00:00:00Z',appName:'Generated',excerpt:user}],trace:[],runId:'generated-understanding'};}
function processor(f:Awaited<ReturnType<typeof fixture>>,query:(input:QueryInput)=>Promise<QueryResult>,overrides:Partial<ConversationUnderstandingOptions>={}){
 return conversationUnderstandingProcessor({memories:f.memories,usage:new UsageLedger(f.store),resolveEvidence:f.resolveEvidence,selection:()=>config,query,...overrides});
}
function input(page:MaterialReadPage){return {observations:[],materials:[page],artifacts:[],config:{modelFingerprint:config.fingerprint,
 processingMaterialInputs:[{materialId:page.material.id,required:['conversation'],fingerprint:'c'.repeat(64),evidenceIds:page.spans.map(span=>(span as typeof span&{evidenceId:string}).evidenceId)}]},signal:new AbortController().signal};}

test('one restricted interpretation supplies grounded work, source-timed events and uncommitted memory candidates',async t=>{
 const f=await fixture(t);let calls=0;
 const outputs=await processor(f,async query=>{
  calls++;assert.equal(query.executionLane,'background');assert.equal(query.modelOverride,'fixture');assert.deepEqual(query.evidenceIds,[f.anchor]);
  assert.deepEqual(query.evidenceRanges,[{id:f.anchor,offset:0,length:body.length}]);assert.match(query.question,/Assistant claims of tests passing/);
  const response=result(f.anchor,products(f.anchor));assert.equal(await query.validateOutput!(response),undefined);return response;
 }).process(input(f.page()));
 assert.equal(calls,1);assert.equal(f.memories.list().length,0);const metadata=outputs[0].metadata;
 assert.equal(metadata.productsVersion,1);assert.equal(metadata.complete,true);assert.equal((metadata.memoryCandidates as unknown[]).length,1);
 const event=(metadata.events as ReturnType<typeof products>['events'])[0];assert.equal(event.sourceTime,userTime);assert.equal('occurredAt' in event,false);
 const work=(metadata.workRecords as ReturnType<typeof products>['workRecords'])[0];assert.equal(work.results[0].basis,'assistant_reported');assert.equal(work.results[0].status,'reported_outcome');
 assert.deepEqual(metadata.evidenceRanges,[{id:f.anchor,offset:0,length:body.length}]);
 assert.ok((metadata.supportRanges as {length:number}[]).reduce((sum,range)=>sum+range.length,0)<body.length);
 const coverage=metadata.coverage as {scope:string;ranges:{offset:number;length:number}[]};assert.equal(coverage.scope,'bounded-conversation');assert.equal(coverage.ranges[0].length,body.length);
});

test('no candidates is valid and still preserves full bounded input coverage for downstream reuse',async t=>{
 const f=await fixture(t),outputs=await processor(f,async()=>result(f.anchor,products(f.anchor,false))).process(input(f.page()));
 assert.deepEqual(outputs[0].metadata.memoryCandidates,[]);assert.deepEqual(outputs[0].metadata.evidenceRanges,[{id:f.anchor,offset:0,length:body.length}]);assert.equal(f.memories.list().length,0);
});

test('partial pages forbid quotes from the unsupplied beginning, preserve absolute offsets and allow unknown source time',async t=>{
 const f=await fixture(t),page=f.page(user.length,assistant.length),valid=products(f.anchor,false);
 valid.evidence=[{id:f.anchor,quote:assistant}];valid.workRecords=[];
 valid.events=[claim(f.anchor,assistant,{sourceTime:null,actor:'assistant',status:'reported_outcome',basis:'assistant_reported'})] as typeof valid.events;
 const outputs=await processor(f,async()=>result(f.anchor,valid)).process(input(page));
 assert.deepEqual(outputs[0].metadata.evidenceRanges,[{id:f.anchor,offset:user.length,length:assistant.length}]);
 assert.equal((outputs[0].metadata.events as {evidence:{offset:number}[]}[])[0].evidence[0].offset,user.length);
 await assert.rejects(processor(f,async()=>result(f.anchor,products(f.anchor,false))).process(input(page)),{category:'permanent',message:'invalid_model_output'});
});

test('fabricated times, artifact references and uncited or incomplete claims are rejected without publishing memory',async t=>{
 const f=await fixture(t);
 for(const mutate of [
  (value:ReturnType<typeof products>)=>{value.events[0].sourceTime='2099-02-01T10:00:00Z';},
  (value:ReturnType<typeof products>)=>{value.workRecords[0].artifactRefs[0].ref='PR #999';},
  (value:ReturnType<typeof products>)=>{delete (value.events[0] as Partial<typeof value.events[0]>).actor;},
 ]){const value=products(f.anchor);mutate(value);await assert.rejects(processor(f,async()=>result(f.anchor,value)).process(input(f.page())));}
 await assert.rejects(processor(f,async()=>({...result(f.anchor,products(f.anchor)),citations:[]})).process(input(f.page())),{category:'permanent',message:'invalid_model_output'});
 assert.equal(f.memories.list().length,0);
});

test('legacy unfiltered conversation versions and expanded original resolvers cannot enter the model',async t=>{
 const f=await fixture(t),query=async()=>{throw Error('Invalid scope must not query');},legacy=f.page();legacy.material={...legacy.material,schemaVersion:4};
 await assert.rejects(processor(f,query).process(input(legacy)),/rule-cleaned Coding dialogue/);
 await assert.rejects(processor(f,query,{resolveEvidence:page=>({records:f.records,ranges:[{id:f.anchor,offset:0,length:body.length+1}]})}).process(input(f.page())),/expanded/);
 const tampered=f.page();tampered.text='X'+tampered.text.slice(1);await assert.rejects(processor(f,query).process(input(tampered)),/original anchor/);
});

test('model changes and cancellation fence results; usage follows the executing operation',async t=>{
 const f=await fixture(t);let selected={...config};const read=input(f.page());const execution={operationId:'generated-operation',jobId:'generated-job',stepId:'generated-step'};
 await assert.rejects(processor(f,async query=>{assert.equal(query.traceContext?.operationId,execution.operationId);selected={...selected,fingerprint:'b'.repeat(64)};return result(f.anchor,products(f.anchor));},{selection:()=>selected}).process({...read,execution}),{statusCode:409});
 const receipt=JSON.parse(String(f.store.db.prepare('SELECT json FROM model_usage').get()!.json));assert.equal(receipt.status,'failed');assert.equal(receipt.attribution.operationId,execution.operationId);assert.equal(receipt.attribution.jobId,execution.jobId);
 const controller=new AbortController();await assert.rejects(processor(f,async()=>{controller.abort();return result(f.anchor,products(f.anchor));}).process({...read,signal:controller.signal}),{name:'AbortError'});assert.equal(f.memories.list().length,0);
});

test('shared quote resolver uses only authorized positions and rejects cross-window or ambiguous support',async t=>{
 const f=await fixture(t),record={...f.records[0],ocrText:'duplicate | duplicate'},value={summary:'Generated',evidence:[{id:f.anchor,quote:'duplicate'}],events:[],memoryCandidates:[],actionCues:[]};
 const parsed=parseSemanticProducts(JSON.stringify(value),[record],[f.anchor],[{id:f.anchor,offset:12,length:9}]);assert.equal(parsed.evidence[0].offset,12);
 assert.throws(()=>parseSemanticProducts(JSON.stringify(value),[record],[f.anchor]),/uniquely/);
 assert.throws(()=>parseSemanticProducts(JSON.stringify({...value,evidence:[{id:f.anchor,quote:'duplicate',offset:0}]}),[record],[f.anchor],[{id:f.anchor,offset:12,length:9}]),/authorized range/);
});

test('the pinned extraction policy governs only memory candidates and retains its validation profile and receipt',async t=>{
 const f=await fixture(t),policy={prompt:'GENERATED_PINNED_CANDIDATE_POLICY',profile:'personal' as const,fingerprint:'d'.repeat(64)},read=input(f.page());let validations=0;
 const p=processor(f,async request=>{assert.ok(request.question.includes(policy.prompt));assert.ok(!request.question.includes('Review this batch of original agent conversation evidence using coding-memory'));assert.ok(request.question.includes('Each workRecord'));return result(f.anchor,products(f.anchor,false));},
  {memories:{extract:(value,model,options)=>{validations++;assert.equal(options?.profile,'personal');return f.memories.extract(fixtureMemoryResult(f.memories,value),model,options);}}});
 const outputs=await p.process({...read,config:{...read.config,candidatePolicy:policy}});assert.equal(outputs[0].metadata.candidatePolicyFingerprint,policy.fingerprint);assert.ok(validations);
 await assert.rejects(p.process({...read,config:{...read.config,candidatePolicy:{...policy,unexpected:'captured override'}}}));
});
