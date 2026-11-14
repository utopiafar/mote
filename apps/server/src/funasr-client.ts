import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {ProviderFailure} from '@mote/shared';
import {StoreError} from './store.js';
import {isLoopback,requestLocalJson} from './local-http.js';
import {mediaModelIdentities} from './media-assets.js';
import {FUNASR_HTTP,FUNASR_LIMITS,FUNASR_PROTOCOL,funasrIdentitySchema,parseFunasrArchive,parseFunasrRequest,parseFunasrResponse,type FunasrFailure,type FunasrRequest,type FunasrIdentity} from './funasr-contract.js';
import type {ProcessorInput} from './file-processors.js';

/** Only a validated current worker response can prove that an issued call did
 * not start or has terminated. Transport loss never supplies that proof. */
export class FunasrWorkerFailure extends ProviderFailure {
  constructor(readonly response:FunasrFailure){
    super({category:response.status==='waiting'?'transient':response.status==='failed'?'permanent':'blocked',
      code:response.code==='resource_busy'?'rate_limited':response.code,
      ...(response.execution==='not_started'?{executionStarted:false as const}:{}),
      ...(response.retryAfterMs!==null?{retryAfterMs:response.retryAfterMs}:{})});
  }
}
function endpoint(input:ProcessorInput,path:string){
  const url=new URL(input.settings.endpoint);
  if(!isLoopback(url.toString())||url.username||url.password||url.search||url.hash||!['http:','https:'].includes(url.protocol)||!/\/transcribe\/?$/.test(url.pathname))throw new StoreError('FunASR requires a loopback /transcribe endpoint',409);
  url.pathname=url.pathname.replace(/\/transcribe\/?$/,path);return url;
}
const headers=(input:ProcessorInput):Record<string,string>=>input.settings.apiKey?{Authorization:`Bearer ${input.settings.apiKey}`}:{ };

async function identity(input:ProcessorInput):Promise<FunasrIdentity>{
  input.signal.throwIfAborted();input.authorizeModel?.();
  const raw=await requestLocalJson(endpoint(input,'/health'),{headers:headers(input),signal:input.signal,limit:64*1024,requireOfflineExecution:true});
  const health=raw as Record<string,unknown>|null,loaded=funasrIdentitySchema.safeParse(health?.identity);
  if(health?.protocol!==FUNASR_PROTOCOL||health.execution!=='local'||!loaded.success)throw new StoreError('Current FunASR worker identity is unavailable',409);
  // CORE-01 owns the catalog. Never substitute a generated revision or accept
  // the request's identity as proof of which installed models the worker uses.
  if(!isDeepStrictEqual(loaded.data.models,mediaModelIdentities('dialogue')))throw new StoreError('FunASR worker does not match the installed model catalog',409);
  if(health.asr!==true)throw new ProviderFailure({category:'blocked',code:'worker_not_ready',executionStarted:false});
  // This fingerprint describes the worker's inference settings. Host connection
  // settings are already bound by file-step inputs and model authorization;
  // replacing loaded facts with that host digest would falsify provenance.
  return loaded.data;
}

/** One current multipart transport. audio.http retains its independently
 * selected octet-stream interface in HttpTranscriptionProvider. */
export async function runFunasr(input:ProcessorInput,operation:FunasrRequest['operation']){
  const audioSha256=input.file.sha256;
  if(!audioSha256||input.file.sizeBytes>FUNASR_HTTP.audioBytes)throw new StoreError('A bounded original audio digest is required',413);
  let pinned:FunasrIdentity;
  if(operation==='recognize')pinned=await identity(input);
  else {
    if(!input.recognition)throw new StoreError('Persisted FunASR recognition checkpoint is required',409);
    pinned=parseFunasrArchive(input.recognition).identity;
    // A retry retains the archived identity. The worker checks it against its
    // loaded identity before starting inference, then verifies it in the engine.
  }
  const speakers=input.settings.speakerCount!==null?{mode:'exact',count:input.settings.speakerCount}:
    input.settings.speakerMin!==null?{mode:'range',min:input.settings.speakerMin,max:input.settings.speakerMax}:{mode:'unknown'};
  const request=parseFunasrRequest({protocol:FUNASR_PROTOCOL,operation,audioSha256,maxAudioMs:input.maxAudioMs,identity:pinned,
    ...(operation==='diarize'?{checkpoint:input.recognition,speakers}:{})});
  const boundary='mote-funasr-'+randomUUID(),json=Buffer.from(JSON.stringify(request)),
    start=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${FUNASR_HTTP.requestPart}"\r\nContent-Type: application/json\r\n\r\n`),json,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="${FUNASR_HTTP.audioPart}"; filename="audio"\r\nContent-Type: application/octet-stream\r\n\r\n`)]),
    end=Buffer.from(`\r\n--${boundary}--\r\n`);
  const body=(async function*(){yield start;let size=0;for await(const part of input.readOriginal()){
    input.signal.throwIfAborted();input.authorizeModel?.();size+=part.length;
    if(size>input.file.sizeBytes)throw new StoreError('Original audio size changed',409);yield part;
  }if(size!==input.file.sizeBytes)throw new StoreError('Original audio size changed',409);yield end;})();
  const raw=await requestLocalJson(endpoint(input,operation==='recognize'?FUNASR_HTTP.recognize:FUNASR_HTTP.diarize),{
    method:'POST',headers:{...headers(input),'Content-Type':`multipart/form-data; boundary=${boundary}`,'Content-Length':String(start.length+input.file.sizeBytes+end.length),
      'X-Mote-Offline':'1','X-Mote-Max-Audio-Ms':String(input.maxAudioMs),'X-Mote-Processing-Timeout-Ms':String(input.settings.timeoutMs),
      ...(input.request?{'X-Mote-Request-Id':input.request.requestId,'X-Mote-Request-Scope':input.request.requestScope}:{})},body,signal:input.signal,
    limit:FUNASR_LIMITS.wireBytes,requireOfflineExecution:true,onRequest:()=>{input.signal.throwIfAborted();input.authorizeModel?.();input.request?.onRequest();},
    onResponseHeaders:response=>input.request?.onExecutionFacts?.(response['x-mote-receipt-id']===input.request.requestId),
  });
  const response=parseFunasrResponse(raw,request);
  if(response.status!=='succeeded')throw new FunasrWorkerFailure(response);
  return response;
}
