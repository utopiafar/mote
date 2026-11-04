import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import type {MemoryStore} from '../../src/memory.js';
import {MemoryPipeline,type MemoryPipelineOptions} from '../../src/memory-pipeline.js';
import {memoryReviewReceipt} from '../../src/memory-review.js';
import {sha256} from '../../src/store.js';
import type {MemoryWorkMember} from '../../src/memory-work-contract.js';
/** Synthetic models choose canonical admission and quote actual generated fixture evidence. */
export function fixtureMemoryResult(memories:MemoryStore,result:QueryResult,ranges?:{id:string;offset:number;length:number}[],input?:Pick<QueryInput,'taskContext'>):QueryResult {
 let output:any;try{output=JSON.parse(result.answer);}catch{return result;}
 if(!Array.isArray(output.memories))return result;let changed=false;
 const records=new Map(memories.readEvidence(output.memories.flatMap((claim:any)=>claim.evidenceIds??[])).map(record=>[record.id,record]));
 for(const claim of output.memories){
  if(!claim.admission){changed=true;claim.admission={layer:'memory',reason:'Generated model selects durable fixture evidence',scope:'This generated fixture only',attribution:'observed'};}
  if(!claim.evidence){changed=true;claim.evidence=(claim.evidenceIds??[]).flatMap((id:string)=>{const record=records.get(id);if(!record)return [];const range=ranges?.find(range=>range.id===id),offset=range?.offset??0,length=Math.min(range?.length??record.ocrText.length,12000);return [{id,offset,length,quote:record.ocrText.slice(offset,offset+length)}];});}
 }
 const members=(input?.taskContext?.memoryWork as {members?:MemoryWorkMember[]}|undefined)?.members;
 if(members?.length&&!Array.isArray(output.coverage)){
  changed=true;delete output.capacity;
  output.coverage=members.map(member=>{const candidateIndexes=output.memories.flatMap((claim:any,index:number)=>claim.evidenceIds?.includes(member.id)?[index]:[]);return {key:member.key,state:candidateIndexes.length?'checked':'no_candidates',candidateIndexes};});
 }
 return changed?{...result,answer:JSON.stringify(output)}:result;
}
export function fixtureMemoryPipeline(options:MemoryPipelineOptions){
 // Preserve result identity so a review receipt stays attached; the synthetic
 // reviewer emits final canonical admission/evidence without a real model.
 const decorate=(input:any,result:QueryResult)=>{
  const fixed=fixtureMemoryResult(options.memories,result,input.evidenceRanges,input);
  if(fixed===result)return result;
  const receipt=memoryReviewReceipt(result);if(receipt)receipt.resultHash=sha256(fixed.answer);
  result.answer=fixed.answer;
  return result;
 };
 const reviewedInput=(input:any)=>{
  const validate=input.validateOutput;
  return validate?{...input,validateOutput:async(result:QueryResult)=>validate(fixtureMemoryResult(options.memories,result,input.evidenceRanges,input))}:input;
 };
 const pipeline=new MemoryPipeline({...options,phases:{...options.phases,query:async input=>decorate(input,await options.phases.query(input)),...(options.phases.review?{review:async(input:any,draft:QueryResult,strategy:any,origin)=>decorate(input,await options.phases.review!(reviewedInput(input),draft,strategy,origin))}:{})}});
 if(options.phases.review){const create=pipeline.create.bind(pipeline);pipeline.create=input=>create(input.recipes||input.manualPlans||input.automaticGrant||input.automaticGrants?input:{...input,recipes:[{id:'mote.personal-memory',version:'5'}]});}
  return pipeline;
}
