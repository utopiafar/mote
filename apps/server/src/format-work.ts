import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {fork} from 'node:child_process';
import {createRequire} from 'node:module';
import type {ManifestTask} from './import-manifest-worker.js';
import type {Transcript,ArchivedFile} from '@mote/shared';
import {StoreError} from './store.js';
export type FormatTask=ManifestTask|{kind:'document';path:string;mimeType:string}|{kind:'text';path:string;maxBytes:number;chunkCharacters:number}|{kind:'zip';path:string;output:string;maxFiles:number;maxBytes:number}|{kind:'plain';inputs:{file:ArchivedFile;path:string}[];createdAt:string;manifest:string};
type Results={document:Transcript;manifest:ReturnType<typeof import('./import-manifest-worker.js').validateImportManifest>;text:{durationMs:number;segments:{startMs:number;endMs:number;text:string}[]};zip:{files:{name:string;path:string;bytes:number}[];bytes:number};plain:{count:number;warnings:string[];samples:{title:string;text:string;kind:string;attachmentCount:number}[];hash:string}};
let active=0;const queue:(()=>void)[]=[];
/** CPU work runs outside the HTTP process. Limits include the admission wait. */
export async function formatWork<K extends FormatTask['kind']>(task:Extract<FormatTask,{kind:K}>,signal?:AbortSignal):Promise<Results[K]>{
 const temporary=task.kind==='manifest'?join((task as ManifestTask).workspace,'validated-'+randomUUID()+'.tmp'):undefined;
 const deadline=AbortSignal.any([AbortSignal.timeout(120000),...(signal?[signal]:[])]);deadline.throwIfAborted();if(queue.length>=32)throw new StoreError('Format queue is full',429);
 await new Promise<void>((resolve,reject)=>{const enter=()=>{deadline.removeEventListener('abort',abort);active++;resolve();};const abort=()=>{const index=queue.indexOf(enter);if(index>=0)queue.splice(index,1);reject(deadline.reason);};deadline.addEventListener('abort',abort,{once:true});if(active<2)enter();else queue.push(enter);});
 try{return await new Promise<Results[K]>((resolve,reject)=>{
  const extension=import.meta.url.endsWith('.ts')?'ts':'js',execArgv=extension==='ts'?['--import',createRequire(import.meta.url).resolve('tsx')]:[];
  const child=fork(new URL(`./format-worker.${extension}`,import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv});let settled=false;
  const done=(error?:unknown,result?:Results[K])=>{if(settled)return;settled=true;deadline.removeEventListener('abort',abort);if(error){if(child.exitCode!==null||child.signalCode!==null||!child.pid){reject(error);}else{child.once('exit',()=>reject(error));child.kill('SIGKILL');}}else resolve(result!);};
  const abort=()=>done(deadline.reason);deadline.addEventListener('abort',abort,{once:true});if(deadline.aborted){abort();return;}
  child.once('error',error=>done(error));child.once('exit',()=>{if(!settled)done(new StoreError('Format worker interrupted',503));});
  child.once('message',(message:any)=>message.ok?done(undefined,message.result):done(new StoreError(message.code==='manifest_invalid'&&typeof message.message==='string'?message.message.slice(0,2000):'Format decoding failed: '+String(message.code),message.status===409?409:message.status===413?413:422)));
  child.send(temporary?{...task,temporary}:task,error=>{if(error)done(error);});
 });}finally{if(temporary)await rm(temporary,{force:true});active--;queue.shift()?.();}
}

export async function extractUtf8(body:AsyncIterable<Buffer>,sizeBytes:number,signal:AbortSignal){return extractDocument(body,sizeBytes,'text/plain',signal);}
export async function extractDocument(body:AsyncIterable<Buffer>,sizeBytes:number,mimeType:string,signal:AbortSignal){
 if(sizeBytes>64*1024*1024)throw new StoreError('Text exceeds extraction limit',413);
 const directory=await mkdtemp(join(tmpdir(),'mote-text-decode-')),path=join(directory,'original');
 try{
  let count=0;async function* bounded(){for await(const part of body){signal.throwIfAborted();count+=part.length;if(count>sizeBytes)throw new StoreError('Text source size changed',409);yield part;}if(count!==sizeBytes)throw new StoreError('Text source size changed',409);}
  await pipeline(Readable.from(bounded()),createWriteStream(path,{flags:'wx',mode:0o600}),{signal});
  return await formatWork({kind:'document',path,mimeType},signal);
 }finally{await rm(directory,{recursive:true,force:true});}
}
