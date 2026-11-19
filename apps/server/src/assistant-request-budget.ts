import {assembleHostContext,estimateSerializedTokens,originalEvidenceReceipt,type ContextRecord,type QueryInput} from '@mote/agent';
import {StoreError} from './evidence-store.js';
import {canonicalRecipeJson} from './recipe-contract.js';

export type AssistantRequestCapacity={contextWindow:number;maxOutputTokens:number;draftTokens:number;language?:QueryInput['language']};
type Original={id:string;offset:number;quote:string};

/** A native review can stage its original receipts from the saved Assistant
 * snapshot without copying the same quotes through the batch context. */
export function assistantBatchContext<T extends {originals:readonly Original[]}>(context:T,maxBytes:number,canSeed:()=>boolean){
 const bytes=Buffer.byteLength(JSON.stringify(context));
 if(bytes<=maxBytes||!context.originals.length||!canSeed())return {context,bytes};
 const {originals:_,...withoutQuoteCopies}=context;
 return {context:withoutQuoteCopies,bytes:Buffer.byteLength(JSON.stringify(withoutQuoteCopies))};
}

/** The follow-up snapshot already selects exact originals. Deliver those spans
 * as seeds, retaining every backing original as a complete, paged read grant.
 * The frozen batch keeps the full ID set for authority, citations and erasure.
 * This also applies when the owner retries an older saved batch. */
export function assistantQueryInput(input:QueryInput,originals:readonly Original[],records:readonly ContextRecord[]):QueryInput{
 if(!originals.length)return input;
 const allowed=new Set(input.evidenceIds),byId=new Map(records.map(record=>[record.id,record]));
 if(byId.size!==allowed.size||records.some(record=>!allowed.has(record.id)))throw new StoreError('Assistant evidence is no longer permitted',409);
 const ranges=new Map<string,{id:string;offset:number;length:number}>();
 for(const original of originals){
  const record=byId.get(original.id);
  if(!record||!original.quote.length||record.ocrText.slice(original.offset,original.offset+original.quote.length)!==original.quote)
   throw new StoreError('Assistant quotation is no longer current',409);
  const range={id:original.id,offset:original.offset,length:original.quote.length};ranges.set(JSON.stringify(range),range);
 }
 return {...input,evidenceIds:[...new Set(originals.map(original=>original.id))],evidenceRanges:[...ranges.values()],
  evidenceReadRanges:records.filter(record=>record.ocrText.length).map(record=>({id:record.id,offset:0,length:record.ocrText.length}))};
}

/** The same envelope and original projection as dispatch, including escaping,
 * instructions, tools and output schema. This planning headroom is separate
 * from the native gate, which still checks every complete physical request. */
export function assistantRequestUsage(input:QueryInput,records:readonly ContextRecord[],capacity:AssistantRequestCapacity){
 const byId=new Map(records.map(record=>[record.id,record]));
 const ranges=input.evidenceRanges??input.evidenceIds?.map(id=>({id,offset:0,length:12000}))??[];
 const seeds=ranges.map(range=>{const record=byId.get(range.id);if(!record)throw new StoreError('Assistant evidence is no longer permitted',409);return originalEvidenceReceipt(record,range.offset,range.length,input.timeZone);});
 const {system,tools,prompt,outputSchema}=assembleHostContext({...input,language:input.language??capacity.language??'zh-CN'},seeds,capacity.draftTokens);
 const inputTokens=estimateSerializedTokens({system,tools,prompt,outputSchema}).tokens,bufferTokens=Math.ceil(capacity.contextWindow/10);
 const totalTokens=inputTokens+capacity.maxOutputTokens+bufferTokens;
 return {inputTokens,outputTokens:capacity.maxOutputTokens,bufferTokens,totalTokens,fits:totalTokens<=capacity.contextWindow};
}

export function assistantQueryWithinCapacity(input:QueryInput,originals:readonly Original[],records:readonly ContextRecord[],capacity:AssistantRequestCapacity):QueryInput|undefined {
 const prepared=assistantQueryInput(input,originals,records);
 if(assistantRequestUsage(prepared,records,capacity).fits)return prepared;
 const context=prepared.taskContext,ranges=prepared.evidenceRanges;
 if(!ranges?.length||!context)return;
 const {originals:duplicate,...taskContext}=context as typeof context&{originals?:readonly Original[]};
 if(duplicate!==undefined&&canonicalRecipeJson(duplicate)!==canonicalRecipeJson(originals))return;
 // The host seed already carries each exact span, ID, offset and provenance.
 // Keep its disclosure grants and remove only the second copy of those spans.
 const compact={...prepared,taskContext};
 if(duplicate!==undefined&&assistantRequestUsage(compact,records,capacity).fits)return compact;
 // Large scopes keep each exact grant but omit repeated range field names.
 const packed:QueryInput={...compact,evidenceReadRangeFormat:'tuple'};
 if(assistantRequestUsage(packed,records,capacity).fits)return packed;
 // If the expanded original metadata still exceeds capacity, keep every
 // exact quote in the task and let the model page their full read grants.
 // Use the longest affordable prefix for the initial rich receipts.
 let low=1,high=ranges.length-1,best:QueryInput|undefined;
 while(low<=high){
  const count=Math.floor((low+high)/2),evidenceRanges=ranges.slice(0,count);
  const candidate={...packed,taskContext:{...taskContext,originals},evidenceIds:[...new Set(evidenceRanges.map(range=>range.id))],evidenceRanges};
  if(assistantRequestUsage(candidate,records,capacity).fits){best=candidate;low=count+1;}
  else high=count-1;
 }
 return best;
}
