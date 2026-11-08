import type {AgentAnswer} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {MemoryOutputValidationError} from './memory.js';
import {hasMemoryImageProof,memoryImageReadReceipts} from './memory-image-proof.js';

export type MemoryReadRange={id:string;offset:number;length:number};
type ReadResult=QueryResult&Pick<AgentAnswer,'evidenceReadRanges'>;

/** Runtime metadata, never parsed from the model's JSON answer. Only supplied
 * seeds and successfully disclosed original pages acquire quote authority. */
export function memoryReadRanges(result:QueryResult,seeds:readonly MemoryReadRange[],grant?:readonly MemoryReadRange[]):MemoryReadRange[]{
 if(!grant)return seeds.map(range=>({...range})); // No grant: preserve the request's own range order and quote scope exactly.
 const receipt=(result as ReadResult).evidenceReadRanges;
 const ranges=grant&&receipt?[...seeds,...receipt]:seeds,allowed=grant??seeds;
 if(!Array.isArray(ranges)||ranges.some(range=>!range||typeof range.id!=='string'||!Number.isSafeInteger(range.offset)||range.offset<0||!Number.isSafeInteger(range.length)||range.length<1||!allowed.some(scope=>scope.id===range.id&&range.offset>=scope.offset&&range.offset+range.length<=scope.offset+scope.length)))
  throw new MemoryOutputValidationError('scope','Original read receipt exceeded the frozen Memory authorization');
 const unique=new Map(ranges.map(range=>[JSON.stringify([range.id,range.offset,range.length]),{...range}]));
 return mergeMemoryReadRanges([...unique.values()]);
}

/** Lossless union of contiguous ranges, without filling an unread gap. */
export function mergeMemoryReadRanges(ranges:readonly MemoryReadRange[]):MemoryReadRange[]{
 const originals=new Map<string,MemoryReadRange[]>(),merged:MemoryReadRange[]=[];
 for(const range of ranges){const values=originals.get(range.id)??[];values.push({...range});originals.set(range.id,values);}
 for(const values of originals.values())for(const range of values.sort((a,b)=>a.offset-b.offset)){
  const prior=merged.at(-1);if(prior?.id===range.id&&range.offset<=prior.offset+prior.length)prior.length=Math.max(prior.offset+prior.length,range.offset+range.length)-prior.offset;else merged.push(range);
 }
 return merged;
}

/** A context-only read may support a target claim, never create another task's
 * standalone Memory or advance its coverage/checkpoint. */
export function assertMemoryTargetSupport(result:QueryResult,targets:readonly MemoryReadRange[],readText:(id:string)=>string|undefined){
 let value:any;try{value=JSON.parse(result.answer);}catch{return;}
 if(!Array.isArray(value.memories))return;
 let imageReads:ReturnType<typeof memoryImageReadReceipts>;
 try{imageReads=memoryImageReadReceipts(result);}catch{throw new MemoryOutputValidationError('image_evidence','Invalid original-image delivery receipt');}
 for(const [candidateIndex,candidate] of value.memories.entries()){
  if(!Array.isArray(candidate.evidence))continue; // Ordinary schema validation reports this first.
  const supports=targets.some(target=>{const text=readText(target.id);if(typeof text!=='string')return false;
   return candidate.evidence.some((span:any)=>span.id===target.id&&(hasMemoryImageProof(imageReads,span)||typeof span.quote==='string'&&span.quote.length>0&&
    (Number.isSafeInteger(span.offset)?span.offset>=target.offset&&span.offset+span.quote.length<=target.offset+target.length&&text.slice(span.offset,span.offset+span.quote.length)===span.quote:text.slice(target.offset,target.offset+target.length).includes(span.quote))));
  });
  if(!supports)throw new MemoryOutputValidationError('scope','Every Memory requires exact supporting evidence in this batch target; context-only originals cannot create an independent candidate',{candidateIndex,problem:'missing_target_support'});
 }
}

export function retainedMemoryReadReceipt(result:QueryResult){
 const ranges=(result as ReadResult).evidenceReadRanges;
 const imageReadReceipts=memoryImageReadReceipts(result);
 return {...(ranges?{evidenceReadRanges:ranges.map(range=>({...range}))}:{}),...(imageReadReceipts.length?{imageReadReceipts:structuredClone(imageReadReceipts)}:{})};
}
