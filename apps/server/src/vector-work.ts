import {fork} from 'node:child_process';
import {createRequire} from 'node:module';
export type VectorQuery={sql:string;values:(string|number)[]};
export type VectorTask={path:string;queries:VectorQuery[];vector:number[];limit:number};
export type VectorScan={candidates:{id:string;embeddingHash:string}[];coverage:{candidateLimit:null;scanned:number;invalid:number;bounded:false;selection:string}};
let active=0;
/** No unbounded queue of expensive searches. Lexical results remain available. */
export function scanVectors(task:VectorTask,signal:AbortSignal):Promise<VectorScan[]>{
 signal.throwIfAborted();if(active>=2)return Promise.reject(new Error('vector_capacity'));
 active++;
 return new Promise<VectorScan[]>((resolve,reject)=>{
  const extension=import.meta.url.endsWith('.ts')?'ts':'js';
  const child=fork(new URL(`./vector-worker.${extension}`,import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:extension==='ts'?['--import',createRequire(import.meta.url).resolve('tsx')]:[]});
  let settled=false;
  const done=(error?:unknown,scans?:VectorScan[])=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);if(error){child.kill('SIGKILL');reject(error);}else resolve(scans!);};
  const abort=()=>done(signal.reason);signal.addEventListener('abort',abort,{once:true});
  child.once('exit',()=>{active--;if(!settled)done(new Error('vector_worker_interrupted'));});
  child.once('error',error=>{if(!child.pid)active--;done(error);});
  child.once('message',(message:{ok:boolean;scans?:VectorScan[]})=>message.ok?done(undefined,message.scans):done(new Error('vector_scan_failed')));
  if(signal.aborted)abort();else child.send(task,error=>{if(error)done(error);});
 });
}
