import type {Readable} from 'node:stream';
import sharp from 'sharp';
import {StoreError} from './store.js';

export const FILE_THUMBNAIL_TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif']);
export const FILE_THUMBNAIL_MAX_ORIGINAL_BYTES=32*1024*1024;
/** Cache misses beyond this many concurrent renders wait for a slot before reading originals. */
export const FILE_THUMBNAIL_MAX_CONCURRENT=4;
const MAX_ITEMS=200,MAX_BYTES=16*1024*1024;
const DECODED_MIME:Record<string,string>={jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif'};

export async function readAll(stream:Readable){const parts:Buffer[]=[];for await(const part of stream)parts.push(part as Buffer);return Buffer.concat(parts);}

type Job={key:string;produce:()=>Promise<Buffer>;live:number;started:boolean;promise:Promise<Buffer>;resolve:(bytes:Buffer)=>void;reject:(error:unknown)=>void};

/** In-memory thumbnail cache keyed by original identity; mirrors the capture-browser thumbnail LRU.
 * Concurrent misses for the same key share one render, and every render holds one of
 * FILE_THUMBNAIL_MAX_CONCURRENT slots for the whole read+decode so in-flight originals stay bounded.
 * A queued job is removed once every requester sharing it has disconnected; a started render
 * always finishes so its result still lands in the cache. */
export function createFileThumbnails(maxConcurrent=FILE_THUMBNAIL_MAX_CONCURRENT){
  const cache=new Map<string,Buffer>(),inflight=new Map<string,Job>(),queue:Job[]=[];
  let cachedBytes=0,running=0;
  const store=(key:string,bytes:Buffer)=>{
    while(cache.size>=MAX_ITEMS||cachedBytes+bytes.length>MAX_BYTES){
      const oldest=cache.keys().next().value;if(oldest===undefined)break;
      cachedBytes-=cache.get(oldest)!.length;cache.delete(oldest);
    }
    const prior=cache.get(key);if(prior)cachedBytes-=prior.length;
    cache.set(key,bytes);cachedBytes+=bytes.length;
  };
  const unavailable=()=>new StoreError('Thumbnail is unavailable',404);
  const admit=(job:Job)=>{
    job.started=true;running++;
    void (async()=>{
      try{const bytes=await job.produce();store(job.key,bytes);job.resolve(bytes);}
      catch(error){job.reject(error);}
      finally{
        if(inflight.get(job.key)===job)inflight.delete(job.key);
        running--;
        const next=queue.shift();if(next)admit(next);
      }
    })();
  };
  return {
    async get(key:string,produce:()=>Promise<Buffer>,signal?:AbortSignal){
      if(signal?.aborted)throw unavailable();
      const hit=cache.get(key);
      if(hit){cache.delete(key);cache.set(key,hit);return hit;}
      let job=inflight.get(key);
      if(!job){
        let resolve!:(bytes:Buffer)=>void,reject!:(error:unknown)=>void;
        const promise=new Promise<Buffer>((res,rej)=>{resolve=res;reject=rej;});
        job={key,produce,live:0,started:false,promise,resolve,reject};
        inflight.set(key,job);queue.push(job);
      }
      const pending=job;pending.live++;
      return new Promise<Buffer>((resolve,reject)=>{
        let counted=true;
        const untrack=()=>{
          if(!counted)return;
          counted=false;pending.live--;signal?.removeEventListener('abort',abort);
          if(!pending.live&&!pending.started){
            const index=queue.indexOf(pending);if(index!==-1)queue.splice(index,1);
            if(inflight.get(key)===pending)inflight.delete(key);
            pending.reject(unavailable());
          }
        };
        const abort=()=>{untrack();reject(unavailable());};
        pending.promise.then(bytes=>{untrack();resolve(bytes);},error=>{untrack();reject(error);});
        signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted)abort();
        // Track the requester before admitting work, including synchronously failing producers.
        if(running<maxConcurrent){const next=queue.shift();if(next)admit(next);}
      });
    },
    clear(){cache.clear();cachedBytes=0;},
  };
}

export async function renderFileThumbnail(bytes:Buffer,mimeType:string){
  let format:string|undefined;
  try{format=(await sharp(bytes).metadata()).format;}catch{format=undefined;}
  if(DECODED_MIME[format??'']!==mimeType)throw new StoreError('Thumbnail is unavailable',404);
  try{return await sharp(bytes,{limitInputPixels:24_000_000}).rotate().flatten({background:'#ffffff'}).resize({width:480,height:480,fit:'inside',withoutEnlargement:true}).jpeg({quality:72}).toBuffer();}
  catch{throw new StoreError('Thumbnail is unavailable',404);}
}
