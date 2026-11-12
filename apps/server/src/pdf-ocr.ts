import {ProviderFailure,transcriptSchema} from '@mote/shared';
import type {DecodedDocument} from '@mote/shared/document-decoder';
import {ZodError} from 'zod';
import {decodeOriginal,pdfLibrary,pdfOptions} from './document-decoder.js';
import {isLoopback,requestLocalJson} from './local-http.js';
import {StoreError} from './store.js';

/** The existing local OCR worker accepts one image at a time. Two rendered
 * pages may be prepared in parallel, but successful pages are never re-read. */
const PAGE_CONCURRENCY=2;
const PAGE_ATTEMPTS=3;
const RETRY_BASE_MS=150;
const MAX_RETRY_WAIT_MS=5000;
const PAGE_TIMEOUT_MS=120000;
const RENDER_SCALE=2;
const MAX_RENDER_SIDE=12000;
const MAX_RENDER_PIXELS=40_000_000;
const MAX_REQUEST_BYTES=8*1024*1024;
const MAX_PAGE_TEXT=100000;

export type DocumentOcrSettings={endpoint?:string;apiKey?:string};
type RenderedPage={bytes:Buffer;mimeType:'image/png'|'image/jpeg'};
type PageOutcome={pageNumber:number;text:string;error?:string};

function pageList(pages:number[]){const sorted=[...pages].sort((a,b)=>a-b);return sorted.length<=100?sorted.join(', '):sorted.slice(0,100).join(', ')+', …';}

/** A missing capability is a reportable extraction gap, not a reason to
 * pretend that a scanned page has been read. */
function unavailableReason(settings:DocumentOcrSettings){
 if(!settings.endpoint)return 'the document OCR service is not configured';
 if(!isLoopback(settings.endpoint))return 'the document OCR endpoint is not a loopback service';
}

function abortError(signal:AbortSignal){return signal.reason instanceof Error?signal.reason:new DOMException('Aborted','AbortError');}

function isAbortError(error:unknown){return error instanceof DOMException?error.name==='AbortError':error instanceof Error&&error.name==='AbortError';}

function failureInfo(error:unknown){
 if(error instanceof ProviderFailure)return {retry:error.details.category==='transient',retryAfterMs:error.details.retryAfterMs,reason:error.details.code};
 if(error instanceof StoreError)return {retry:[408,425,429,500,502,503,504].includes(error.statusCode),reason:error.statusCode===502?'invalid_ocr_response':`ocr_http_${error.statusCode}`};
 if(error instanceof ZodError||error instanceof SyntaxError)return {retry:false,reason:'invalid_ocr_output'};
 if(error instanceof Error&&typeof (error as NodeJS.ErrnoException).code==='string')return {retry:true,reason:(error as NodeJS.ErrnoException).code!};
 return {retry:true,reason:'ocr_unavailable'};
}

function wait(ms:number,signal?:AbortSignal){
 return new Promise<void>((resolve,reject)=>{
  if(signal?.aborted){reject(abortError(signal));return;}
  const timer=setTimeout(done,ms);timer.unref();
  function done(){signal?.removeEventListener('abort',abort);resolve();}
  function abort(){clearTimeout(timer);reject(abortError(signal!));}
  signal?.addEventListener('abort',abort,{once:true});
 });
}

async function pool<T>(items:T[],limit:number,run:(item:T)=>Promise<void>,signal?:AbortSignal){
 let next=0;
 const worker=async()=>{for(;;){signal?.throwIfAborted();const index=next++;if(index>=items.length)return;await run(items[index]!);}};
 const workers=Array.from({length:Math.min(limit,items.length)},worker);
 try{await Promise.all(workers);}
 catch(error){await Promise.allSettled(workers);throw error;}
}

async function renderPage(page:any,createCanvas:(width:number,height:number)=>any,signal:AbortSignal):Promise<RenderedPage>{
 signal.throwIfAborted();
 const base=page.getViewport({scale:1});
 if(!(base.width>0&&base.height>0))throw new StoreError('PDF page has no renderable size',422);
 const maximum=Math.min(MAX_RENDER_SIDE/Math.max(base.width,base.height),Math.sqrt(MAX_RENDER_PIXELS/(base.width*base.height)),4);
 if(!(maximum>=0.1))throw new StoreError('PDF page is too large to render for OCR',413);
 const viewport=page.getViewport({scale:Math.min(RENDER_SCALE,maximum)});
 const canvas=createCanvas(Math.max(1,Math.ceil(viewport.width)),Math.max(1,Math.ceil(viewport.height)));
 try{
  const context=canvas.getContext('2d');
  context.fillStyle='#ffffff';context.fillRect(0,0,canvas.width,canvas.height);
  await page.render({canvasContext:context,viewport}).promise;
  signal.throwIfAborted();
  const png=canvas.toBuffer('image/png') as Buffer;
  if(png.length<=MAX_REQUEST_BYTES)return {bytes:png,mimeType:'image/png'};
  const jpeg=canvas.toBuffer('image/jpeg',90) as Buffer;
  if(jpeg.length<=MAX_REQUEST_BYTES)return {bytes:jpeg,mimeType:'image/jpeg'};
  throw new StoreError('Rendered PDF page exceeds the OCR request limit',413);
 }finally{
  try{canvas.width=0;canvas.height=0;}catch{/* Native canvas can retain its final allocation; the document is still released below. */}
 }
}

async function ocrPage(pageNumber:number,image:RenderedPage,settings:DocumentOcrSettings,signal:AbortSignal){
 for(let attempt=1;attempt<=PAGE_ATTEMPTS;attempt++){
  const timeout=AbortSignal.timeout(PAGE_TIMEOUT_MS),requestSignal=AbortSignal.any([signal,timeout]);
  try{
   const headers:Record<string,string>={'Content-Type':image.mimeType,'Content-Length':String(image.bytes.length),'X-Mote-Document-Page':String(pageNumber),...(settings.apiKey?{Authorization:`Bearer ${settings.apiKey}`}:{})};
   const value=await requestLocalJson(settings.endpoint!,{method:'POST',headers,body:(async function*(){yield image.bytes;})(),signal:requestSignal,limit:4*1024*1024,requireOfflineExecution:false});
   const transcript=transcriptSchema.parse(value),text=transcript.segments.map(segment=>segment.text).join('\n').trim();
   if(transcript.durationMs!==0)throw new StoreError('Document OCR output cannot have audio duration',422);
   if(text.length>MAX_PAGE_TEXT)throw new StoreError('Document OCR output exceeds the text limit',413);
   return {pageNumber,text};
  }catch(error){
   if(signal.aborted)throw abortError(signal);
   if(timeout.aborted){if(attempt===PAGE_ATTEMPTS)return {pageNumber,text:'',error:'ocr_timeout'};continue;}
   if(isAbortError(error)){if(attempt===PAGE_ATTEMPTS)return {pageNumber,text:'',error:'ocr_timeout'};continue;}
   const failure=failureInfo(error);
   if(!failure.retry||attempt===PAGE_ATTEMPTS)return {pageNumber,text:'',error:failure.reason};
   await wait(Math.min(failure.retryAfterMs??RETRY_BASE_MS*attempt,MAX_RETRY_WAIT_MS),signal);
  }
 }
 return {pageNumber,text:'',error:'ocr_unavailable'};
}

function merge(decoded:DecodedDocument,scanned:number[],outcomes:PageOutcome[]):DecodedDocument{
 const byPage=new Map(outcomes.map(outcome=>[outcome.pageNumber,outcome])),pages=(decoded.pages??[]).map(page=>{
  const outcome=byPage.get(page.pageNumber);return outcome?.text?{...page,text:outcome.text}:page;
 });
 const read=outcomes.filter(outcome=>!outcome.error&&outcome.text),empty=outcomes.filter(outcome=>!outcome.error&&!outcome.text),failed=outcomes.filter(outcome=>outcome.error);
 const warnings=decoded.warnings.filter(warning=>!warning.startsWith('Pages without a text layer:')&&!warning.startsWith('No text layer was found.'));
 if(read.length)warnings.push(`Pages ${pageList(read.map(outcome=>outcome.pageNumber))} were read with OCR; recognized text is uncorrected and may contain errors.`);
 if(empty.length)warnings.push(`OCR found no text on page(s) ${pageList(empty.map(outcome=>outcome.pageNumber))}; those pages may be blank or unreadable.`);
 const missing=scanned.filter(pageNumber=>!byPage.has(pageNumber));
 if(missing.length)warnings.push(`Pages ${pageList(missing)} have no text layer and were not OCR'd.`);
 if(failed.length)warnings.push(`OCR failed for page(s) ${pageList(failed.map(outcome=>outcome.pageNumber))} (${[...new Set(failed.map(outcome=>outcome.error))].join(', ')}); those pages remain unread.`);
 const text=pages.map(page=>page.text).join('\n'),ready=Boolean(text.trim()),coverage=!ready?'none':failed.length||missing.length||empty.length?'partial':'full';
 return {...decoded,text,pages,status:ready?'ready':'unsupported',coverage,warnings,parser:read.length?'pdfjs+ocr':'pdfjs'};
}

/** PDF text-layer extraction plus the existing loopback OCR worker for pages
 * without a text layer. Rendering and OCR stay page-scoped: a failed page can
 * be retried while successful pages are not sent again in the same run. */
export async function decodePdfWithOcr(bytes:Buffer,settings:DocumentOcrSettings={},signal?:AbortSignal):Promise<DecodedDocument>{
 const activeSignal=signal??new AbortController().signal;
 const decoded=await decodeOriginal(bytes,'application/pdf');
 const scanned=(decoded.pages??[]).filter(page=>!page.text.trim()).map(page=>page.pageNumber);
 if(!scanned.length)return decoded;
 const reason=unavailableReason(settings);
 if(reason){
  const warnings=decoded.warnings.filter(warning=>!warning.startsWith('Pages without a text layer:')&&!warning.startsWith('No text layer was found.'));
  warnings.push(`Pages ${pageList(scanned)} have no text layer and were not OCR'd because ${reason}; image text may be missing.`);
  return {...decoded,warnings};
 }
 let createCanvas:(width:number,height:number)=>any;
 try{({createCanvas}=await import('@napi-rs/canvas'));}
 catch{
  const warnings=decoded.warnings.filter(warning=>!warning.startsWith('Pages without a text layer:')&&!warning.startsWith('No text layer was found.'));
  warnings.push(`Pages ${pageList(scanned)} have no text layer and were not OCR'd because PDF page rendering is unavailable; image text may be missing.`);
  return {...decoded,warnings};
 }
 let pdfDocument:any;
 try{
  activeSignal.throwIfAborted();
  const pdf=await pdfLibrary(),documentProxy=await pdf.getDocument({data:new Uint8Array(bytes),useWorkerFetch:false,isEvalSupported:false,disableFontFace:true,useSystemFonts:false,...pdfOptions}).promise;
  pdfDocument=documentProxy;
  const outcomes:PageOutcome[]=[];
  await pool(scanned,PAGE_CONCURRENCY,async pageNumber=>{
   activeSignal.throwIfAborted();
   if(pageNumber<1||pageNumber>documentProxy.numPages)throw new StoreError('Decoded PDF page is missing during rendering',422);
   try{
    const page=await documentProxy.getPage(pageNumber);
    try{const image=await renderPage(page,createCanvas,activeSignal);outcomes.push(await ocrPage(pageNumber,image,settings,activeSignal));}
    finally{page.cleanup();}
   }catch(error){
    if(activeSignal.aborted)throw abortError(activeSignal);
    outcomes.push({pageNumber,text:'',error:error instanceof StoreError&&error.statusCode===413?'page_too_large':'page_render_failed'});
   }
  },activeSignal);
  return merge(decoded,scanned,outcomes);
 }catch(error){
  if(activeSignal.aborted)throw abortError(activeSignal);
  const details=error instanceof Error?`${error.name}: ${error.message}`:String(error);
  const warnings=decoded.warnings.filter(warning=>!warning.startsWith('Pages without a text layer:')&&!warning.startsWith('No text layer was found.'));
  warnings.push(`Pages ${pageList(scanned)} have no text layer and OCR could not run (${details.slice(0,300)}); image text may be missing.`);
  return {...decoded,warnings};
 }finally{try{await pdfDocument?.destroy();}catch{/* The document proxy is already unusable after a render failure. */}}
}
