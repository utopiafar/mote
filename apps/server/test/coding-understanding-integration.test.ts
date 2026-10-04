import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ContextReader,QueryInput} from '@mote/agent';
import type {QueryResult,SourceItem} from '@mote/shared';
import {buildApp} from '../src/app.js';
import type {Config} from '../src/config.js';

// All conversation content and model results below are generated local fixtures.
type Node=Awaited<ReturnType<typeof buildApp>>;
const recordedAt='2001-01-01T10:00:00Z',contextTime='2001-01-02T00:00:00Z';
const owner='Generated owner: In this workspace I prefer concise written decisions.';
const report='Generated assistant: Automatic tests passed; physical-device checks remain unknown. PR #123 is ready.';
const toolSecret='PRIVATE_GENERATED_TOOL_BODY';
const token='generated-coding-understanding-owner-token';
const config=(dataDir:string):Config=>({dataDir,token,tokenPath:'fixture',host:'127.0.0.1',port:0,maxStorageBytes:30_000_000,maxExportBytes:1_000_000,retentionDays:0,insightIntervalHours:0,allowedOrigins:[],model:'generated-stub',modelBaseUrl:'',apiKey:'',allowUnauthenticatedLocal:false,embeddingModel:'',embeddingBaseUrl:'',embeddingApiKey:'',diagnosticsEnabled:false});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>resolve=done);return {promise,resolve};};
function event(id:string,role:string,text:string):SourceItem{return {externalId:id,revision:'1',observedAt:recordedAt,kind:'message',layer:'original',text,
 document:{recordedAt,timeBasis:'recorded',contentRole:'transcript',coding:{version:1,provider:'codex',projectKey:'generated-project',projectName:'Generated project',projectIdentity:'workspace',sessionId:'generated-session',eventId:id,role,attribution:role==='user'?'human':role==='assistant'?'agent':'unknown',part:0,parts:1}}};}
async function appFixture(t:TestContext,query:(input:QueryInput,reader:ContextReader)=>Promise<QueryResult>,automatic=false){
 const directory=mkdtempSync(join(tmpdir(),'mote-coding-understanding-e2e-'));
 const node=await buildApp(config(directory),{backgroundWorker:false,createModelAgent:async(_settings,reader)=>({configured:true,close:async()=>{},query:input=>query(input,reader)})});
 t.after(async()=>{await node.app.close();rmSync(directory,{recursive:true,force:true});});
 const settings=node.lifecycle.settings();node.lifecycle.configure({...settings,extraction:{...settings.extraction,enabled:automatic},consolidation:{...settings.consolidation,enabled:false},insights:{...settings.insights,enabled:false},working:{...settings.working,enabled:false}});
 node.sources.register({id:'coding',kind:'coding-agent',name:'Generated coding',deviceId:'fixture',platform:'macos'});
 node.sourcePipelines.configure('coding',{settleSeconds:0,memory:true});await node.app.ready();
 return node;
}
async function receive(node:Node){
 await node.sources.upsertBatch('coding',[event('owner','user',owner),event('call','tool_call',toolSecret),event('result','tool_result',toolSecret),event('assistant','assistant',report)]);
 await node.sourcePipelines.tick();
 const material=node.materials.list({kind:'mote.coding-session'}).items[0];assert.ok(material);
 const page=node.materials.read(material.ref,{length:12000});assert.ok(page.text.includes(owner));assert.ok(page.text.includes(report));assert.ok(!page.text.includes(toolSecret));
 return {material,page,ids:node.materials.evidenceIds(material.ref)};
}
function response(id:string,text:string,output:unknown):QueryResult{return {answer:JSON.stringify(output),citations:[{id,capturedAt:recordedAt,appName:'Generated fixture',excerpt:text}],trace:[],runId:randomUUID()};}
function products(id:string,memory:boolean){
 const proof=[{id,quote:owner}],user={statement:'Owner prefers concise written decisions in the generated workspace',actor:'user',status:'decision',basis:'direct_expression',sourceTime:null,uncertainty:'Workspace only',evidence:proof};
 const assistant={statement:'Assistant reports automatic tests passed; device validation remains unknown',actor:'assistant',status:'reported_outcome',basis:'assistant_reported',sourceTime:null,uncertainty:'Assistant report only',evidence:[{id,quote:report}]};
 return {summary:'Generated scoped decision and assistant report; device validation unknown',evidence:proof,
  workRecords:[{title:'Generated workspace decisions',requirements:[],constraints:[],decisions:[user],results:[assistant],validation:[],openItems:[],artifactRefs:[]}],events:[user],
  memoryCandidates:memory?[{domain:'personal',title:'Generated workspace decisions',statement:`In the generated workspace the owner prefers concise written decisions [${id}]`,uncertainty:'Scoped to this workspace',admission:{layer:'memory',reason:'Explicit preference for future work in this workspace',scope:'Generated workspace only',attribution:'user'},evidenceIds:[id],evidence:proof}]:[],actionCues:[]};
}
function isUnderstanding(input:QueryInput){return input.traceContext?.agentId==='coding-conversation-understanding'||input.question.includes('FINAL UNIFIED RESPONSE CONTRACT:\nInterpret every supplied part');}
async function supplied(input:QueryInput,reader:ContextReader){
 assert.equal(input.responseMode,'memory-extraction');assert.ok(input.processingMaterialInputs?.length,'named material authorization must reach the model reader');
 assert.ok(input.evidenceIds?.length);assert.ok(input.evidenceRanges?.length);
 const records=await reader.evidence({ids:input.evidenceIds!});assert.equal(records.length,input.evidenceIds!.length,'material input admission must permit exactly the supplied originals');
 assert.ok(records.every(record=>!record.ocrText.includes(toolSecret)));return records;
}
function manualJob(node:Node,ids:string[]){return node.memoryPipeline.create({evidenceIds:ids,recipes:[{id:'mote.personal-memory',version:'2'}],contextTime,timeZone:'Asia/Shanghai',batchCharacters:12000});}

test('clean Coding material runs one authorized understanding and reuses its candidates for independent review',{timeout:15000},async t=>{
 let understanding=0,review=0,extraction=0;const calls:QueryInput[]=[];
 const node=await appFixture(t,async(input,reader)=>{
  calls.push(input);const records=await supplied(input,reader),id=records[0].id;
  if(isUnderstanding(input)){understanding++;return response(id,owner,products(id,true));}
  if(input.traceContext?.phase==='review'){
   review++;assert.ok(input.taskContext?.untrustedMemoryDraft);assert.equal(input.contextTime,contextTime);
   assert.ok(String(JSON.stringify(input.taskContext.untrustedMemoryDraft)).includes('concise written decisions'));
   return response(id,owner,input.taskContext.untrustedMemoryDraft);
  }
  extraction++;throw Error('Candidate reuse must avoid a second extraction model call');
 });
 const fixture=await receive(node),job=await node.memoryPipeline.run(manualJob(node,fixture.ids).id);
 assert.equal(job.status,'completed');assert.equal(job.memoryIds.length,1);assert.equal(understanding,1);assert.equal(review,1);assert.equal(extraction,0);
 const card=node.memories.get(job.memoryIds[0]);assert.equal(card.status,'published');assert.equal(card.reviewReceipt?.decision,'independent');assert.equal(card.reviewReceipt?.contextTime,contextTime);
 const artifact=node.store.archive.page({kind:'semantic'}).items[0];assert.ok(artifact);const full=node.store.archive.get(artifact.id)!;
 assert.equal(full.processor,'mote.coding-conversation-understanding');assert.equal(full.metadata.materialRef,fixture.material.ref);assert.ok(full.text.includes('device validation remains unknown'));
 assert.deepEqual(full.metadata.evidenceRanges,job.batches[0].evidenceRanges);assert.ok((full.metadata.memoryCandidates as unknown[]).length);
 assert.equal(calls.filter(input=>isUnderstanding(input)).length,1);assert.ok(calls.filter(isUnderstanding).every(input=>input.executionLane==='background'));
});

test('empty Coding candidates still publish work/events and skip extraction and independent review calls',{timeout:15000},async t=>{
 let calls=0;const node=await appFixture(t,async(input,reader)=>{calls++;assert.ok(isUnderstanding(input),'empty candidates require no downstream model query');const originals=await supplied(input,reader);return response(originals[0].id,owner,products(originals[0].id,false));});
 const fixture=await receive(node),job=await node.memoryPipeline.run(manualJob(node,fixture.ids).id);
 assert.equal(job.status,'completed');assert.equal(job.memoryIds.length,0);assert.equal(calls,1);const artifacts=node.store.archive.page({kind:'semantic'}).items;
 assert.equal(artifacts.length,1);const artifact=node.store.archive.get(artifacts[0].id)!;assert.deepEqual(artifact.metadata.memoryCandidates,[]);assert.ok((artifact.metadata.workRecords as unknown[]).length);assert.ok((artifact.metadata.events as unknown[]).length);
});

test('revoking the parent Memory grant during understanding prevents semantic and memory commits',{timeout:15000},async t=>{
 const started=deferred(),release=deferred();let calls=0;
 t.after(()=>release.resolve());
 const node=await appFixture(t,async(input,reader)=>{calls++;assert.ok(isUnderstanding(input));const originals=await supplied(input,reader);started.resolve();await release.promise;return response(originals[0].id,owner,products(originals[0].id,true));});
 const fixture=await receive(node),created=manualJob(node,fixture.ids),running=node.memoryPipeline.run(created.id);
 await started.promise;node.memoryPipeline.cancel(created.id);release.resolve();const job=await running;
 assert.equal(job.status,'cancelled');await node.workflows.tick();
 assert.equal(node.store.archive.page({kind:'semantic'}).items.length,0);assert.equal(node.memories.list().length,0);assert.equal(calls,1);
 const children=node.store.db.prepare("SELECT json FROM processing_jobs WHERE json_extract(json,'$.processor')='mote.coding-conversation-understanding'").all();
 assert.ok(children.length);assert.ok(children.every(row=>{const child=JSON.parse(String(row.json));return child.parentGrant&&child.outputs.length===0;}));
});

test('tool-only append advances private archive without renewing automatic understanding',{timeout:15000},async t=>{
 let calls=0;const node=await appFixture(t,async(input,reader)=>{calls++;assert.ok(isUnderstanding(input));const originals=await supplied(input,reader);return response(originals[0].id,owner,products(originals[0].id,false));},true);
 const fixture=await receive(node);assert.equal(node.materialMemoryWork.drain(node.memoryPipeline,true),1);
 await new Promise<void>(resolve=>setImmediate(resolve));const row=node.store.db.prepare('SELECT job_id FROM material_memory_requests WHERE material_id=?').get(fixture.material.id)!;
 assert.ok(row.job_id);const job=await node.memoryPipeline.run(String(row.job_id));assert.equal(job.status,'completed');assert.equal(calls,1);
 const before=node.materials.codingBase(fixture.material.id)!;
 await node.sources.upsert('coding',event('late-tool','tool_result',toolSecret+'LATE'));await node.sourcePipelines.tick();
 const after=node.materials.codingBase(fixture.material.id)!;assert.equal(after.record.ref,before.record.ref);assert.ok(after.headCount>before.headCount);assert.notEqual(after.archiveCheckpoint,before.archiveCheckpoint);
 assert.equal(node.materialMemoryWork.drain(node.memoryPipeline,true),0);await node.lifecycle.tick();assert.equal(calls,1);assert.equal(node.store.archive.page({kind:'semantic'}).items.length,1);
});

test('long Coding conversations cover every original character through bounded interpretations without tail-only truncation',{timeout:30000},async t=>{
 const covered:{id:string;offset:number;length:number}[]=[];let calls=0,overviewCalls=0;
 const node=await appFixture(t,async(input,reader)=>{
  if(input.question.startsWith('Build a running overview')){overviewCalls++;await supplied(input,reader);return {answer:JSON.stringify({summary:'Generated full-session overview: concise written decisions remain an early constraint; final correction: device checks are still unknown.'}),citations:[],trace:[],runId:randomUUID()};}
  calls++;assert.ok(isUnderstanding(input),'empty per-range candidates must be reused');assert.ok(overviewCalls>1,'all pages must be covered before any per-range candidate');assert.match(input.taskContext?.previousSummary??'',/early constraint.*final correction/);const originals=await supplied(input,reader),range=input.evidenceRanges![0];
  assert.ok(input.evidenceRanges!.reduce((sum,item)=>sum+item.length,0)<=12000);
  covered.push(...input.evidenceRanges!);const record=originals.find(item=>item.id===range.id)!,quote=record.ocrText.slice(range.offset,range.offset+Math.min(range.length,180));
  return response(range.id,quote,{summary:'Generated bounded conversation range; later outcome unknown',evidence:[{id:range.id,quote,offset:range.offset}],workRecords:[],events:[],memoryCandidates:[],actionCues:[]});
 });
 const long=owner+'\n'+('Generated bounded passage with Unicode 😀.\n').repeat(400)+'\nGenerated final correction: device checks are still unknown.';
 await node.sources.upsertBatch('coding',[event('long-owner','user',long),event('tool','tool_result',toolSecret)]);await node.sourcePipelines.tick();
 const material=node.materials.list({kind:'mote.coding-session'}).items[0],ids=node.materials.evidenceIds(material.ref),originals=node.materials.evidence(ids);
 const job=await node.memoryPipeline.run(manualJob(node,ids).id);assert.equal(job.status,'completed');assert.equal(job.memoryIds.length,0);assert.ok(job.totalBatches>1);assert.equal(calls,job.totalBatches);
 for(const original of originals){
  const ranges=covered.filter(range=>range.id===original.id).sort((a,b)=>a.offset-b.offset);let cursor=0;
  for(const range of ranges){assert.equal(range.offset,cursor);cursor+=range.length;}
  assert.equal(cursor,original.ocrText.length,'the beginning, middle and final correction all receive model coverage');
 }
 assert.equal(covered.reduce((sum,range)=>sum+range.length,0),material.textLength);
 assert.equal(node.store.archive.page({kind:'semantic'}).items.length,calls);
});
