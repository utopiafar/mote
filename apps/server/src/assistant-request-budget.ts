import {assembleHostContext,estimateSerializedTokens,originalEvidenceReceipt,type ContextRecord,type QueryInput} from '@mote/agent';
import {StoreError} from './evidence-store.js';

export type AssistantRequestCapacity={contextWindow:number;maxOutputTokens:number;draftTokens:number;language?:QueryInput['language']};
type Original={id:string;offset:number;quote:string};

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
