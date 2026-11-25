import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseAnswer,type QueryInput,type ContextReader} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {EvidenceStore as Store} from '../src/evidence-store.js';
import {SourceStore} from '../src/sources.js';
import {MemoryStore,MemoryOutputValidationError} from '../src/memory.js';
import {reviewMemory,memoryReviewReceipt} from '../src/memory-review.js';
import {MemoryReviewCache} from '../src/memory-review-cache.js';
import {memoryReadRanges} from '../src/memory-read-context.js';

test('all valid extraction receipts become reviewer seeds while unread quote authority remains independent',{timeout:15000},async t=>{
 const directory=mkdtempSync(join(tmpdir(),'mote-generated-review-budget-')),store=new Store(directory),sources=new SourceStore(store),memories=new MemoryStore(store);
 t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const event='I repaired a generated bicycle.',context='This retrospective covers 2024.',text=event+'x'.repeat(40000)+context+'x'.repeat(40000),contextOffset=event.length+40000;
 sources.register({id:'generated-budget',name:'Generated budget diary',kind:'custom',deviceId:'generated',platform:'import'});
 const original=await sources.upsert('generated-budget',{externalId:'entry',revision:'1',observedAt:'2025-02-03T12:45:27Z',kind:'file',layer:'original',text});
 const otherText='y'.repeat(40000),other=await sources.upsert('generated-budget',{externalId:'other-entry',revision:'1',observedAt:'2025-02-03T12:45:28Z',kind:'file',layer:'original',text:otherText});
 const id=original.id,records=memories.readEvidence([id,other.id]),seeds=[{id,offset:0,length:event.length}],grant=[{id,offset:0,length:text.length},{id:other.id,offset:0,length:otherText.length}];
 const reader:ContextReader={search:async()=>[],timeline:async()=>({items:[],nextCursor:null}),evidence:async({ids})=>records.filter(record=>ids.includes(record.id)),activity:async()=>({}),devices:async()=>[]};
 const input:QueryInput={question:'Independently review the generated bicycle event and its retrospective year.',skill:'memory-extraction',responseMode:'memory-extraction',contextTime:'2026-10-01T00:00:00Z',evidenceIds:[id],evidenceRanges:seeds,evidenceReadRanges:grant,validateOutput:result=>{
  try{memories.extract(result,'generated-only',{requireAdmission:true,validateOnly:true,evidenceRanges:memoryReadRanges(result,seeds,grant)});return undefined;}
  catch(error){if(!(error instanceof MemoryOutputValidationError))throw error;return {code:error.code,feedback:error.repairInstruction};}
 }};
 const {startBridge}=await import('../../../packages/agent/dist/bridge.js');
 const extractor=await startBridge(reader,input,24);
 const call=async(bridge:Awaited<ReturnType<typeof startBridge>>,offset:number,length:number,evidenceId=id)=>{
  const response=await fetch(bridge.url+'/context_evidence',{method:'POST',headers:{authorization:'Bearer '+bridge.token,'content-type':'application/json'},body:JSON.stringify({id:evidenceId,offset,length})});
  assert.equal(response.status,200);return response.json();
 };
 let draft:QueryResult;
 try{
  for(let page=0;page<6;page++)await call(extractor,event.length+page*12000,12000);
  for(let page=0;page<3;page++)await call(extractor,page*12000,12000,other.id);
  const answer=JSON.stringify({memories:[{domain:'personal',title:'Generated retrospective repair',statement:`The diary narrator reported repairing a generated bicycle during 2024 [${id}]`,uncertainty:'The exact event day and narrator-to-owner correspondence remain unknown.',admission:{layer:'observation',reason:'A generated reported event with explicit retrospective context',scope:'The generated 2024 retrospective only',attribution:'observed'},evidenceIds:[id],evidence:[{id,quote:event,offset:0},{id,quote:context,offset:contextOffset}]}]});
  draft={...parseAnswer(JSON.stringify({answer,citationIds:[id]}),extractor.records),trace:extractor.trace,runId:'generated-extraction',evidenceReadRanges:extractor.deliveredRanges};
  assert.equal(draft.evidenceReadRanges!.reduce((sum,range)=>sum+range.length,0),108031,'successful requested pages retain every authorized original range');
 }finally{await extractor.close();}
 const cache=new MemoryReviewCache(),options={cache,snapshot:()=> 'generated-frozen-original'},calls:{reads:{id:string;offset:number;length:number}[]}[]=[];
 const query=async(request:QueryInput):Promise<QueryResult>=>{
  assert.deepEqual(request.evidenceIds,[id,other.id]);assert.deepEqual(request.evidenceRanges,memoryReadRanges(draft,seeds,grant),'every valid delivered extraction range is offered as a reviewer seed');assert.deepEqual(request.evidenceReadRanges,grant,'the existing read grant is unchanged');
  const reviewer=await startBridge(reader,request,24);
  try{
   const candidate=JSON.parse(draft.answer);candidate.memories[0].evidenceIds.push(other.id);candidate.memories[0].evidence.push({id:other.id,quote:'y'.repeat(10),offset:39000});
   const parsed=parseAnswer(JSON.stringify({answer:JSON.stringify(candidate),citationIds:[id,other.id]}),reviewer.records),unread={...parsed,trace:[],runId:'generated-unread-review',evidenceReadRanges:reviewer.deliveredRanges};
   const rejected=await request.validateOutput!(unread);assert.equal(rejected?.code,'quote_range','a quote in an authorized but unread tail remains unavailable to the reviewer');
   const page=await call(reviewer,contextOffset,context.length);assert.equal(page.data[0].ocrText,context);
   const result={...parseAnswer(JSON.stringify({answer:draft.answer,citationIds:[id]}),reviewer.records),trace:reviewer.trace,runId:'generated-independent-review',evidenceReadRanges:reviewer.deliveredRanges};
   assert.equal(await request.validateOutput!(result),undefined);calls.push({reads:reviewer.deliveredRanges});return result;
  }finally{await reviewer.close();}
 };
 const reviewed=await reviewMemory(input,draft!,query,options);assert.equal(memoryReviewReceipt(reviewed)?.decision,'independent');assert.equal(calls.length,1);
 assert.deepEqual(reviewed.evidenceReadRanges,memoryReadRanges(draft!,seeds,grant),'the reviewer independently rediscloses every valid extraction receipt');
 assert.deepEqual(reviewed.evidenceReadRanges,draft!.evidenceReadRanges);assert.equal(memories.list().length,0,'both extraction and review fixtures are read-only');
 const reused=await reviewMemory(input,draft!,async()=>{throw Error('An identical exact reviewed verdict should be reusable');},options);assert.equal(memoryReviewReceipt(reused)?.decision,'reused');assert.deepEqual(reused.evidenceReadRanges,reviewed.evidenceReadRanges);
 assert.equal(memories.readEvidence([id])[0].ocrText,text,'budget handling never rewrites generated originals');
});

test('a resumed review keeps on-demand context when prior original pages exceed the request budget',async()=>{
 const target={id:'generated-target',offset:0,length:48},priorPage={id:'generated-context',offset:24,length:48};
 const grant=[target,{id:priorPage.id,offset:0,length:120}];
 const draft:QueryResult={answer:JSON.stringify({memories:[],coverage:[]}),citations:[],trace:[],runId:'generated-extract',evidenceReadRanges:[target,priorPage]};
 let measurements=0,calls=0;
 const result=await reviewMemory({
  question:'Assess the generated target',skill:'memory-strategy',responseMode:'memory-extraction',
  evidenceIds:[target.id],evidenceRanges:[target],evidenceReadRanges:grant,resumeReviewFromExtraction:true,
  taskContext:{turns:[],memoryWork:{workContract:'range-evaluation@1'}},
 },draft,async request=>{
  calls++;
  assert.deepEqual(request.evidenceRanges,[target]);
  assert.deepEqual(request.evidenceReadRanges,grant);
  return {...draft,runId:'generated-review',evidenceReadRanges:[target]};
 },{fitsResumedReview:request=>{
  measurements++;
  assert.deepEqual(request.evidenceRanges,[target,priorPage]);
  return false;
 }});
 assert.equal(measurements,1);
 assert.equal(calls,1);
 assert.equal(memoryReviewReceipt(result)?.decision,'independent');
});
