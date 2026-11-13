import {ProviderFailure} from '@mote/shared';
import type {ImageUnderstanding,ImageUnderstandingSelection} from './image-processing.js';
import {ImageInterpretationError,ImageRegionOutOfBoundsError} from './image-recipes.js';
import {LOCAL_IMAGE_ERRORS,LOCAL_IMAGE_MODEL,LOCAL_IMAGE_PROMPT_VERSION,LOCAL_IMAGE_PROTOCOL,localImageRequestSchema,parseLocalImageResponse} from './local-image-contract.js';
import {modelConnection} from './background-model-authorization.js';
import {mediaModelIdentities} from './media-assets.js';
import {mediaRoleEndpoint,mediaRuntimeSettings,type MediaRuntimeSettings} from './media-configuration.js';
import {requestLocalJson} from './local-http.js';
import {sha256,StoreError} from './store.js';
import type {UsageLedger} from './usage.js';
import type {LocalImageProcessingPort} from './plugins/local-image-processing.js';

export const LOCAL_IMAGE_ADAPTER={id:'mote.local-image-understanding',version:'1'} as const;
export type LocalImageSelection=()=>LocalImageProcessingPort|undefined;
export type LocalImageUnderstandingBinding={selection:LocalImageSelection;media?:Partial<MediaRuntimeSettings>;usage:Pick<UsageLedger,'start'>};

/** Intake-only selection. Availability never selects a different destination.
 * The worker owns relative/display -> encoded integer coordinate conversion;
 * this consumer verifies its current v1 response against the exact host pixels.
 * No model settings, source policy or historical authorization is rewritten. */
export function localImageUnderstanding(options:LocalImageUnderstandingBinding&{configured:ImageUnderstanding;timeoutMs:()=>number}):ImageUnderstanding {
 const media=mediaRuntimeSettings(options.media),endpoint=mediaRoleEndpoint('local-image',media);
 const localSelection=():ImageUnderstandingSelection=>{
  const identity=mediaModelIdentities('local-image').image;
  if(!identity)throw new StoreError('Local image model identity is unavailable',503);
  const receipt={execution:'local',provider:'local',model:identity.id,revision:identity.revision,manifestSha256:identity.manifestSha256,quantization:LOCAL_IMAGE_MODEL.quantization,engine:'mlx',promptVersion:LOCAL_IMAGE_PROMPT_VERSION,adapter:LOCAL_IMAGE_ADAPTER};
  const connection=modelConnection('local-image:'+identity.id,{endpoint,workerToken:media.workerToken,receipt});
  return {configured:true,fingerprint:sha256(JSON.stringify([receipt,connection.fingerprint])),receipt,connection};
 };
 return {
  selection:service=>options.selection()?localSelection():options.configured.selection(service),
  async run(input){
   const port=options.selection();
   if(!port)return options.configured.run(input);
   const selected=localSelection();
   const assertCurrent=()=>{
    input.signal.throwIfAborted();input.assertContextAuthority?.();
    if(options.selection()!==port||localSelection().fingerprint!==selected.fingerprint||input.selectionFingerprint&&input.selectionFingerprint!==selected.fingerprint)throw new StoreError('Image model configuration changed',409);
   };
   assertCurrent();
   let issued=false;
   try{return await port.run(async signal=>{
    const check=()=>{signal.throwIfAborted();assertCurrent();};check();
    // Read only the accepted original via the existing guarded host reader.
    const image=await input.readImage({id:input.record.id,expectedImageSha256:input.original.hash});check();
    const document=input.record.provenance?.document;
    const request=localImageRequestSchema.parse({version:LOCAL_IMAGE_PROTOCOL.version,operationId:input.operationId,captureId:input.record.id,image,ocr:input.ocr,
     context:{capturedAt:input.record.capturedAt,sourceType:input.record.source,sourceId:input.record.provenance?.sourceId,sourceRevision:input.record.provenance?.revision,title:input.record.windowTitle,appName:input.record.appName,attributionContext:input.record.attributionContext,
      document:document?{contentRole:document.contentRole,timeBasis:document.timeBasis,recordedAt:document.recordedAt,occurredAt:document.occurredAt,attachmentOf:document.attachmentOf}:undefined}});
    const bytes=Buffer.from(JSON.stringify(request)),timeoutMs=options.timeoutMs();
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(new DOMException('Local image request timed out','TimeoutError')),timeoutMs);timer.unref();
    const callSignal=AbortSignal.any([signal,timeout.signal]);
    let meter:ReturnType<UsageLedger['start']>|undefined;
    try{
     const raw=await requestLocalJson(endpoint,{method:LOCAL_IMAGE_PROTOCOL.method,headers:{Authorization:`Bearer ${media.workerToken}`,'Content-Type':'application/json','Content-Length':String(bytes.length),'X-Mote-Processing-Timeout-Ms':String(timeoutMs)},
      body:(async function*(){check();yield bytes;})(),signal:callSignal,limit:LOCAL_IMAGE_PROTOCOL.maxResponseBytes,requireOfflineExecution:true,
      onRequest:()=>{check();issued=true;meter=options.usage.start('local',LOCAL_IMAGE_MODEL.id,'image-understanding',{agentId:'image-understanding',moduleId:'images',skillId:null,operationId:input.operationId,jobId:input.record.id});}});
     check();const response=parseLocalImageResponse(raw,request);
     if(response.status==='error'){
      const failure=LOCAL_IMAGE_ERRORS[response.error.code],waiting=['model_missing','busy'].includes(response.error.code),unstarted=waiting||['invalid_request','version_mismatch'].includes(response.error.code);
      if(unstarted){meter?.discard();meter=undefined;}
      // A worker can become unavailable after inference started. Only explicit
      // pre-execution codes prove no model call; permanent input/version errors
      // remain terminal even though they did not start inference.
      throw new ProviderFailure({category:failure.category,code:failure.hostCode,...(unstarted?{executionStarted:false as const}:{}),...(waiting?{admissionWaiting:true as const}:{}),retryAfterMs:response.error.retryAfterMs});
     }
     if(response.model.revision!==selected.receipt.revision)throw new ImageInterpretationError('Local worker used a different model revision');
     const original=request.image.imageView.original;
     if(response.result.regions.some(r=>r.x+r.width>original.width||r.y+r.height>original.height))throw new ImageRegionOutOfBoundsError();
     check();
     // Partial usage stays partial in the model receipt; the current usage
     // ledger needs both token totals and must never fill unknown counts with 0.
     if(response.usage?.inputTokens!==undefined&&response.usage.outputTokens!==undefined)meter?.update({requests:1,reportedRequests:1,inputTokens:response.usage.inputTokens,outputTokens:response.usage.outputTokens,totalTokens:response.usage.inputTokens+response.usage.outputTokens});
     input.onReceipt?.({...selected.receipt,...response.model,model:response.model.id,elapsedMs:response.elapsedMs,...(response.usage?{usage:response.usage}:{})});
     meter?.finish('completed');return response.result;
    }catch(error){
     meter?.finish('failed');
     if(signal.aborted)throw error;
     if(timeout.signal.aborted)throw new ProviderFailure({category:'permanent',code:'provider_timeout'});
     if(error instanceof SyntaxError)throw new ImageInterpretationError('Local worker returned invalid JSON');
     if(error instanceof Error&&['ECONNREFUSED','ECONNRESET','EPIPE'].includes(String((error as NodeJS.ErrnoException).code)))throw new ProviderFailure({category:'blocked',code:'image_worker_unavailable'});
     throw error;
    }finally{clearTimeout(timer);}
   },input.signal);}catch(error){
    if(!issued&&error instanceof ProviderFailure&&['model_missing','image_worker_unavailable'].includes(error.details.code))throw new ProviderFailure({...error.details,executionStarted:false,admissionWaiting:true});
    throw error;
   }
  },
 };
}
