import {assembleHostContext,estimateSerializedTokens,originalEvidenceReceipt,resolveModelCapabilities,type AgentOptions,type ContextRecord,type QueryInput} from '@mote/agent';
import {ProviderFailure} from '@mote/shared';

export type MemoryRequestCapacity={contextWindow:number;maxOutputTokens:number;draftTokens:number};

const framingReserve=(contextWindow:number)=>Math.ceil(contextWindow/10);

/** HTTP extraction drafts share the review input allowance with the originals.
 * The transport still measures the actual draft, provider framing and every continuation. */
export function httpMemoryRequestCapacity(settings:Pick<AgentOptions,'contextWindow'|'maxTokens'>):MemoryRequestCapacity {
 const {contextWindow,maxOutputTokens}=resolveModelCapabilities(settings);
 const inputAllowance=Math.max(0,contextWindow-maxOutputTokens-framingReserve(contextWindow));
 const draftTokens=Math.min(maxOutputTokens,Math.floor(inputAllowance/2));
 return {contextWindow,maxOutputTokens,draftTokens};
}

/** A planning estimate, not a tokenizer or permission to clip originals. Use
 * the actual shared envelope/projection, including JSON escaping, tools and
 * output schema. Leave 10% of the full window for native framing, tool replies,
 * repair and reasoning continuations; the physical send gate remains final. */
export function memoryRequestUsage(input:QueryInput,originals:readonly ContextRecord[],capacity:MemoryRequestCapacity,draftTokens=0){
 return memoryRequestSizer(originals,capacity)(input,draftTokens);
}

/** One planning pass can measure several exact requests over the same original
 * snapshot. Reuse only their range projections, including validated metadata
 * and display times; every envelope is still assembled and measured in full.
 * Actual dispatch creates a fresh pass after current-authority validation. */
export function memoryRequestSizer(originals:readonly ContextRecord[],capacity:MemoryRequestCapacity){
 const records=new Map(originals.map(record=>[record.id,record]));
 const receipts=new Map<string,ContextRecord>();
 return (input:QueryInput,draftTokens=0)=>{
  const seeds=(input.evidenceRanges??[]).flatMap(range=>{const record=records.get(range.id);if(!record)return [];const key=JSON.stringify([range.id,range.offset,range.length,input.timeZone]);let receipt=receipts.get(key);if(!receipt){receipt=originalEvidenceReceipt(record,range.offset,range.length,input.timeZone);receipts.set(key,receipt);}return [receipt];});
  const {system,tools,prompt,outputSchema}=assembleHostContext(input,seeds,capacity.draftTokens);
  const inputTokens=estimateSerializedTokens({system,tools,prompt,outputSchema}).tokens,bufferTokens=framingReserve(capacity.contextWindow);
  const totalTokens=inputTokens+capacity.maxOutputTokens+draftTokens+bufferTokens;
  return {inputTokens,outputTokens:capacity.maxOutputTokens,draftTokens,bufferTokens,totalTokens,fits:totalTokens<=capacity.contextWindow};
 };
}

/** Guard the actual extraction/review request too: an unexpectedly large draft
 * or extra original pages must fail explicitly before provider dispatch. */
export function assertMemoryRequestFits(input:QueryInput,originals:readonly ContextRecord[],capacity:MemoryRequestCapacity){
 if(!memoryRequestUsage(input,originals,capacity).fits)throw new ProviderFailure({category:'permanent',code:'processing_limit',executionStarted:false});
}
