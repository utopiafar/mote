import type {QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {MemoryOutputValidationError,MEMORY_ADMISSION_PROMPT} from './memory.js';
import {StoreError,sha256} from './store.js';
import type {MemoryReviewReceipt} from './memory-schema.js';
import type {MemoryReviewCache} from './memory-review-cache.js';
import {defaultMemoryReviewStrategy} from './memory-review-policy.js';
import {memoryReviewStrategySchema,memoryStrategyPin,MEMORY_CANDIDATE_OUTPUT_CONTRACT,type MemoryReviewStrategy} from './memory-strategy-contract.js';
import {validationFeedback,type MemoryOutputValidationCode} from './memory-validation.js';

const receipts=new WeakMap<QueryResult,MemoryReviewReceipt>();
export function memoryReviewReceipt(result:QueryResult){return receipts.get(result);}
type ReviewOptions={cache?:MemoryReviewCache;snapshot?:()=>string;strategy?:MemoryReviewStrategy;taskInstructions?:string};

/** A separate read-only model pass. The host still validates exact evidence after review. */
export async function reviewMemory(input:QueryInput,draft:QueryResult,query:(input:QueryInput)=>Promise<QueryResult>,options?:ReviewOptions):Promise<QueryResult> {
  input.signal?.throwIfAborted();
  const strategy=options?.strategy?memoryReviewStrategySchema.parse(options.strategy):undefined;
  let value: {memories:unknown[]};
  try{value=JSON.parse(draft.answer);if(!Array.isArray(value.memories))throw Error();}catch{throw new MemoryOutputValidationError('json','Invalid memory draft');}
  const receipt=(result:QueryResult,decision:MemoryReviewReceipt['decision'],inputHash?:string,model=result.usage?.model)=>{
    receipts.set(result,{strategy:memoryStrategyPin(strategy??defaultMemoryReviewStrategy),policy:'bounded-exact-review@1',decision,draftRunId:draft.runId,reviewRunId:decision==='empty'?undefined:result.runId,checkedAt:new Date().toISOString(),contextTime:input.contextTime,inputHash,model});return result;
  };
  if(!value.memories.length)return receipt({...draft},'empty');
  // Only fixed, bounded extraction tools may reuse a verdict. Consolidation and
  // open retrieval can see changing context outside the supplied originals.
  const bounded=options?.cache&&options.snapshot&&input.validateOutput&&input.contextTime&&input.evidenceIds?.length&&input.evidenceRanges?.length&&['memory-extraction','coding-memory','memory-strategy'].includes(input.skill??'');
  const snapshot=bounded?options!.snapshot!():undefined;
  const {signal,validateOutput,onProgress,onTrace,onUsage,traceContext,...semanticInput}=input;
  const key=bounded?sha256(JSON.stringify(['bounded-exact-review@1',strategy??defaultMemoryReviewStrategy,options?.taskInstructions,semanticInput,value,draft.citations,snapshot])):undefined;
  const validate=async(result:QueryResult)=>{
    signal?.throwIfAborted();
    if(snapshot!==undefined&&options!.snapshot!()!==snapshot)throw new StoreError('Memory review inputs changed',409);
    const failure=await validateOutput?.({...result,trace:[]});
    if(failure)throw new MemoryOutputValidationError(Object.hasOwn(validationFeedback,failure.code)?failure.code as MemoryOutputValidationCode:'schema','Memory review failed host validation');
    signal?.throwIfAborted();
    if(snapshot!==undefined&&options!.snapshot!()!==snapshot)throw new StoreError('Memory review inputs changed',409);
  };
  {
    // Revalidate the draft as well as the cached output; exact citations alone
    // do not prove semantic support and never authorize a first-time bypass.
    await validate(draft);
    const cached=key?options!.cache!.get(key):undefined;
    if(cached){await validate(cached.result);return receipt(cached.result,'reused',key,cached.model);}
  }
  // Keep one authoritative policy and the complete task; do not exceed the Agent input limit by duplicating it.
  const taskQuestion=input.question.startsWith(MEMORY_ADMISSION_PROMPT)?input.question.slice(MEMORY_ADMISSION_PROMPT.length):input.question;
  const question=strategy?strategy.policy+'\n'+MEMORY_CANDIDATE_OUTPUT_CONTRACT+(options?.taskInstructions?'\n'+options.taskInstructions:''):
    MEMORY_ADMISSION_PROMPT+'\n'+taskQuestion+'\n'+defaultMemoryReviewStrategy.policy.slice(MEMORY_ADMISSION_PROMPT.length+1);
  const reviewed=await query({...input,traceContext:{...traceContext,phase:'review'},taskContext:{turns:[],...input.taskContext,untrustedMemoryDraft:value},question});
  await validate(reviewed);
  if(key)options!.cache!.put(key,reviewed);
  return receipt(reviewed,'independent',key);
}
