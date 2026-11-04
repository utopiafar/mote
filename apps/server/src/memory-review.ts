import {extractionSeedScopeValid,type QueryInput} from '@mote/agent';
import type {QueryResult} from '@mote/shared';
import {MemoryOutputValidationError,MEMORY_ADMISSION_PROMPT} from './memory.js';
import {StoreError,sha256} from './store.js';
import type {MemoryReviewReceipt} from './memory-schema.js';
import type {MemoryDeletions} from './memory-deletions.js';
import type {MemoryReviewCache} from './memory-review-cache.js';
import {defaultMemoryReviewStrategy} from './memory-review-policy.js';
import {memoryReviewStrategySchema,memoryStrategyPin,memoryCandidateOutputContract,type MemoryWorkContract,type MemoryReviewStrategy} from './memory-strategy-contract.js';
import {validationFeedback,type MemoryOutputValidationCode} from './memory-validation.js';
import {memoryReadRanges} from './memory-read-context.js';
import {MEMORY_VISUAL_EVIDENCE_CONTRACT,memoryImageReadReceipts,imageViewCovers} from './memory-image-proof.js';

const receipts=new WeakMap<QueryResult,MemoryReviewReceipt>();
export function memoryReviewReceipt(result:QueryResult){return receipts.get(result);}
/** Set only by the host that invoked the native engine, never by captured content. */
export type MemoryDraftOrigin='mote'|'native-engine';
type ReviewOptions={draftOrigin?:MemoryDraftOrigin;deletions?:MemoryDeletions;authorizeDeletionEvidence?:(ids:string[])=>void;cache?:MemoryReviewCache;snapshot?:()=>string;strategy?:MemoryReviewStrategy;taskInstructions?:string};

/** A separate read-only model pass. The host still validates exact evidence after review. */
export async function reviewMemory(input:QueryInput&{memoryReviewQuestion?:string;memoryReviewRepair?:string},draft:QueryResult,query:(input:QueryInput)=>Promise<QueryResult>,options?:ReviewOptions):Promise<QueryResult> {
  input.signal?.throwIfAborted();
  let contextPagesRequired=false;
  // Re-disclose extraction's actual original reads to the independent reviewer;
  // the broader grant remains available for its own autonomous inspection.
  if(input.evidenceReadRanges){
    const ranges=memoryReadRanges(draft,input.evidenceRanges??[],input.evidenceReadRanges);
    const ids=[...new Set([...(input.evidenceIds??[]),...ranges.map(range=>range.id)])];
    if(extractionSeedScopeValid(ids,ranges))input={...input,evidenceIds:ids,evidenceRanges:ranges};
    else contextPagesRequired=true;
  }
  const strategy=options?.strategy?memoryReviewStrategySchema.parse(options.strategy):undefined;
  let value: {memories:unknown[]};
  try{value=JSON.parse(draft.answer);if(!Array.isArray(value.memories))throw Error();}catch{throw new MemoryOutputValidationError('json','Invalid memory draft');}
  let draftImages:ReturnType<typeof memoryImageReadReceipts>;
  try{draftImages=memoryImageReadReceipts(draft);}catch{throw new MemoryOutputValidationError('image_evidence','Invalid extraction image delivery proof');}
  const deletionSnapshot=options?.deletions?.snapshot();
  const finish=async(result:QueryResult)=>{const reviewed=options?.deletions?await options.deletions.review(input,result,query,options.authorizeDeletionEvidence):result;if(deletionSnapshot!==options?.deletions?.snapshot())throw new StoreError('Memory deletion policy changed during review',409);return reviewed;};
  const receipt=(result:QueryResult,decision:MemoryReviewReceipt['decision'],inputHash?:string,model=result.usage?.model)=>{
    receipts.set(result,{deletionSnapshot,resultHash:sha256(result.answer),strategy:memoryStrategyPin(strategy??defaultMemoryReviewStrategy),policy:'bounded-exact-review@1',decision,draftRunId:draft.runId,reviewRunId:decision==='empty'?undefined:result.runId,checkedAt:new Date().toISOString(),contextTime:input.contextTime,inputHash,model});return result;
  };
  const workPackage=Boolean(input.taskContext?.memoryWork),contract=(input.taskContext?.memoryWork as {workContract?:MemoryWorkContract}|undefined)?.workContract;
  const native=options?.draftOrigin==='native-engine';
  if(!value.memories.length&&!workPackage&&!native)return receipt(await finish({...draft}),'empty');
  // Only fixed, bounded extraction tools may reuse a verdict. Consolidation and
  // open retrieval can see changing context outside the supplied originals.
  const bounded=options?.cache&&options.snapshot&&input.validateOutput&&input.contextTime&&input.evidenceIds?.length&&input.evidenceRanges?.length&&['memory-extraction','coding-memory','memory-strategy'].includes(input.skill??'');
  const snapshot=bounded?options!.snapshot!():undefined;
  const {signal,validateOutput,onProgress,onTrace,onUsage,traceContext,...semanticInput}=input;
  const key=bounded?sha256(JSON.stringify(['bounded-exact-review@1',native?'native-engine':'mote',strategy??defaultMemoryReviewStrategy,options?.taskInstructions,semanticInput,value,draft.citations,snapshot,deletionSnapshot,...(contextPagesRequired?['review-context-pages-required@1']:[])])):undefined;
  const validate=async(result:QueryResult)=>{
    signal?.throwIfAborted();
    if(snapshot!==undefined&&options!.snapshot!()!==snapshot)throw new StoreError('Memory review inputs changed',409);
    const failure=await validateOutput?.({...result,trace:[]});
    if(failure)throw new MemoryOutputValidationError(Object.hasOwn(validationFeedback,failure.code)?failure.code as MemoryOutputValidationCode:'schema','Memory review failed host validation',{workContract:contract});
    // Kept visual proof must be independently disclosed. A review may discard
    // a proposal or replace it with separately supported text; metadata alone
    // cannot certify pixels it still relies on.
    if(draftImages.length||input.processingImages?.length||result.imageReadReceipts?.length){
    let reviewedImages:ReturnType<typeof memoryImageReadReceipts>,reviewed:{memories:{evidence?:{id:string;image?:{originalSha256:string;viewId:string}}[]}[]};
    try{reviewedImages=memoryImageReadReceipts(result);reviewed=JSON.parse(result.answer);if(!Array.isArray(reviewed.memories))throw Error();}catch{throw new MemoryOutputValidationError('image_evidence','Invalid review image delivery proof');}
    const currentViews:typeof reviewedImages=[];
    for(const candidate of reviewed.memories)for(const span of candidate.evidence??[])if(span.image){
      const current=reviewedImages.find(receipt=>receipt.id===span.id&&receipt.imageView.original.sha256===span.image!.originalSha256&&receipt.imageView.viewId===span.image!.viewId);
      if(!current)throw new MemoryOutputValidationError('image_evidence','Independent review did not receive the original-image pixels it cites');
      currentViews.push(current);
    }
    // Wording, order and candidate splits/merges cannot establish proof identity.
    // Match still-cited original groups; each cited draft view needs one covering
    // current view, allowing separate crops without stitching partial coverage.
    const prior=(value.memories as {evidence?:{id:string;image?:{originalSha256:string;viewId:string}}[]}[]).flatMap(proposal=>proposal.evidence??[]);
    for(const proof of prior)if(proof.image){
      const current=currentViews.filter(receipt=>receipt.id===proof.id&&receipt.imageView.original.sha256===proof.image!.originalSha256);
      if(!current.length)continue;
      const relied=draftImages.find(receipt=>receipt.id===proof.id&&receipt.imageView.original.sha256===proof.image!.originalSha256&&receipt.imageView.viewId===proof.image!.viewId);
      if(relied&&!current.some(receipt=>imageViewCovers(receipt.imageView,relied.imageView)))throw new MemoryOutputValidationError('image_evidence','Independent review did not inspect the retained visual proof',{problem:'review_image_coverage'});
    }
    }
    signal?.throwIfAborted();
    if(snapshot!==undefined&&options!.snapshot!()!==snapshot)throw new StoreError('Memory review inputs changed',409);
  };
  {
    // Native facts are unreviewed proposals with an upstream schema. The
    // independent model must inspect originals and produce Mote's contract;
    // every reviewed output (including reuse) receives full host validation.
    if(!native)await validate(draft);
    const cached=key?options!.cache!.get(key):undefined;
    if(cached){await validate(cached.result);return receipt(await finish(cached.result),'reused',key,cached.model);}
  }
  // Keep one authoritative policy and the complete task without duplicating it.
  const task=input.memoryReviewQuestion??input.question,taskQuestion=task.startsWith(MEMORY_ADMISSION_PROMPT)?task.slice(MEMORY_ADMISSION_PROMPT.length):task;
  const repair=input.memoryReviewRepair;
  const question=(strategy?strategy.policy+'\n'+memoryCandidateOutputContract(contract)+(options?.taskInstructions?'\n'+options.taskInstructions:''):
    MEMORY_ADMISSION_PROMPT+'\n'+taskQuestion+'\n'+defaultMemoryReviewStrategy.policy.slice(MEMORY_ADMISSION_PROMPT.length+1))+(workPackage?'\nIndependently inspect every listed target range in full and verify each member coverage decision, including all no_candidates entries. Verify the quality and usefulness of the selected set; deliberate selection is permitted and is not incomplete evaluation. Do not infer completeness from candidate count. Explicit unread/truncated or unassessed target ranges require incomplete with a concrete reason. Apply the batch-local coverage contract in taskContext.memoryWork. The overall package goal does not authorize other ranges or require this call to complete the whole original. Verify owner questions and their exact source quotes as well as independently supported candidates in the same range. A named participant or conversational role does not establish owner identity, and diarization labels may mix speakers. Use needs_context only for specific useful additional authorized evidence; use needs_owner_input with a concrete minimal question when a meaningful result requires an owner fact unavailable from the evidence. Preserve completed uncertainty or useful observed context when no question is needed. Consult supplied prior inspection outcomes and never recommend unchanged reading to infer a missing owner association. An empty candidate array still requires this independent review.':'')+(repair?'\nHost review repair: '+repair:'');
  const contextReading=contextPagesRequired?'\nThe extractor\'s additional original page ranges do not form a valid initial evidence scope for this review. This review starts with the original target seeds and retains the same context read grant. Use context_evidence to read the necessary original pages before retaining claims that rely on them. Quoted text in the untrusted draft and the extractor\'s reading do not establish that this reviewer read those originals. Only originals actually delivered in this review support its citations; additional context does not add targets or complete other coverage. If necessary context cannot be inspected, preserve the specific uncertainty or omit unsupported claims without inventing absence.':'';
  const reviewed=await query({...input,traceContext:{...traceContext,phase:'review'},taskContext:{turns:[],...input.taskContext,untrustedMemoryDraft:draftImages.length?{...value,imageViews:draftImages}:value},question:question+contextReading+(draftImages.length||input.processingImages?.length?'\n'+MEMORY_VISUAL_EVIDENCE_CONTRACT:'')});
  await validate(reviewed);
  if(key)options!.cache!.put(key,reviewed);
  return receipt(await finish(reviewed),'independent',key);
}
