import type {QueryResult} from '@mote/shared';
import type {MemoryStore} from '../../src/memory.js';
import {MemoryPipeline,type MemoryPipelineOptions} from '../../src/memory-pipeline.js';
/** Synthetic models choose canonical admission and quote actual generated fixture evidence. */
export function fixtureMemoryResult(memories:MemoryStore,result:QueryResult,ranges?:{id:string;offset:number;length:number}[]):QueryResult {
 let output:any;try{output=JSON.parse(result.answer);}catch{return result;}
 if(!Array.isArray(output.memories))return result;let changed=false;
 const records=new Map(memories.readEvidence(output.memories.flatMap((claim:any)=>claim.evidenceIds??[])).map(record=>[record.id,record]));
 for(const claim of output.memories){
  if(!claim.admission){changed=true;claim.admission={layer:'memory',reason:'Generated model selects durable fixture evidence',scope:'This generated fixture only',attribution:'observed'};}
  if(!claim.evidence){changed=true;claim.evidence=(claim.evidenceIds??[]).flatMap((id:string)=>{const record=records.get(id);if(!record)return [];const range=ranges?.find(range=>range.id===id),offset=range?.offset??0,length=Math.min(range?.length??record.ocrText.length,12000);return [{id,offset,length,quote:record.ocrText.slice(offset,offset+length)}];});}
 }
 return changed?{...result,answer:JSON.stringify(output)}:result;
}
export function fixtureMemoryPipeline(options:MemoryPipelineOptions){
 return new MemoryPipeline({...options,query:async input=>fixtureMemoryResult(options.memories,await options.query(input),input.evidenceRanges),...(options.review?{review:async(input:any,draft:QueryResult,strategy:any)=>fixtureMemoryResult(options.memories,await options.review!(input,draft,strategy),input.evidenceRanges)}:{})});
}
