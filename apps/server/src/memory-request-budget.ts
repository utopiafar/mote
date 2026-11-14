import {assembleHostContext,estimateSerializedTokens,originalEvidenceReceipt,type ContextRecord,type QueryInput} from '@mote/agent';
import {ProviderFailure} from '@mote/shared';

export type MemoryRequestCapacity={contextWindow:number;maxOutputTokens:number;draftTokens:number};

/** A planning estimate, not a tokenizer or permission to clip originals. Use
 * the actual shared envelope/projection, including JSON escaping, tools and
 * output schema. Leave 10% of the full window for native framing, tool replies,
 * repair and reasoning continuations; the physical send gate remains final. */
export function memoryRequestUsage(input:QueryInput,originals:readonly ContextRecord[],capacity:MemoryRequestCapacity,draftTokens=0){
 const records=new Map(originals.map(record=>[record.id,record]));
 const seeds=(input.evidenceRanges??[]).flatMap(range=>{const record=records.get(range.id);return record?[originalEvidenceReceipt(record,range.offset,range.length,input.timeZone)]:[];});
 const {system,tools,prompt,outputSchema}=assembleHostContext(input,seeds,capacity.draftTokens);
 const inputTokens=estimateSerializedTokens({system,tools,prompt,outputSchema}).tokens,bufferTokens=Math.ceil(capacity.contextWindow/10);
 const totalTokens=inputTokens+capacity.maxOutputTokens+draftTokens+bufferTokens;
 return {inputTokens,outputTokens:capacity.maxOutputTokens,draftTokens,bufferTokens,totalTokens,fits:totalTokens<=capacity.contextWindow};
}

/** Guard the actual extraction/review request too: an unexpectedly large draft
 * or extra original pages must fail explicitly before provider dispatch. */
export function assertMemoryRequestFits(input:QueryInput,originals:readonly ContextRecord[],capacity:MemoryRequestCapacity){
 if(!memoryRequestUsage(input,originals,capacity).fits)throw new ProviderFailure({category:'permanent',code:'processing_limit',executionStarted:false});
}
