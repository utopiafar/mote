import {fork} from 'node:child_process';
import {createRequire} from 'node:module';
import {StoreError} from './store.js';
export type AssetPreparation={directory:string;staging:string;destinationRoot:string;hash?:string;bytes:number;partBytes:number;parts:{part:number;hash:string;bytes:number}[];encryption:{enabled:boolean;legacyEncrypted:boolean;key?:string}};
export type PreparedAsset={hash:string;checksums:string[];destination?:{dev:number;ino:number;mtimeMs:number}};
let active=0;const queue:(()=>void)[]=[];
/** File bytes, crypto and durable staging run in at most two child processes.
 * No worker opens the vault database or holds a metadata transaction. */
export async function prepareAsset(task:AssetPreparation,signal?:AbortSignal):Promise<PreparedAsset>{
 signal?.throwIfAborted();
 const controller=new AbortController(),deadline=controller.signal,abortParent=()=>controller.abort(signal?.reason);
 const timeout=setTimeout(()=>controller.abort(new DOMException('Asset preparation timed out','TimeoutError')),120000);timeout.unref();
 signal?.addEventListener('abort',abortParent,{once:true});let admitted=false;
 try{
 if(queue.length>=32)throw new StoreError('Asset preparation queue is full',429);
 await new Promise<void>((resolve,reject)=>{const enter=()=>{deadline.removeEventListener('abort',abort);active++;admitted=true;resolve();};const abort=()=>{const index=queue.indexOf(enter);if(index>=0)queue.splice(index,1);reject(deadline.reason);};deadline.addEventListener('abort',abort,{once:true});if(active<2)enter();else queue.push(enter);});
 return await new Promise<PreparedAsset>((resolve,reject)=>{
  const extension=import.meta.url.endsWith('.ts')?'ts':'js';
  const child=fork(new URL(`./asset-worker.${extension}`,import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:extension==='ts'?['--import',createRequire(import.meta.url).resolve('tsx')]:[]});let settled=false;
  const done=(error?:unknown,result?:PreparedAsset)=>{if(settled)return;settled=true;deadline.removeEventListener('abort',abort);if(error&&child.exitCode===null&&child.signalCode===null&&child.pid){child.once('exit',()=>reject(error));child.kill('SIGKILL');}else if(error)reject(error);else resolve(result!);};
  const abort=()=>done(deadline.reason);deadline.addEventListener('abort',abort,{once:true});if(deadline.aborted){abort();return;}
  child.once('error',error=>done(error));child.once('exit',()=>{if(!settled)done(new StoreError('Asset preparation interrupted',503));});
  child.once('message',(message:{ok:boolean;result?:PreparedAsset;code?:string})=>{if(message.ok)done(undefined,message.result);else done(new StoreError(message.code==='ENOSPC'?'Asset storage is full':message.code==='invalid_existing'?'Asset checksum mismatch':message.code==='asset_changed'?'Asset changed during preparation':'File part or checksum verification failed',message.code==='ENOSPC'?507:message.code==='invalid_existing'?500:409));});
  child.send(task,error=>{if(error)done(error);});
 });}finally{clearTimeout(timeout);signal?.removeEventListener('abort',abortParent);if(admitted){active--;queue.shift()?.();}}
}
