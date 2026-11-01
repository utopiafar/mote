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

/** In-memory thumbnail cache keyed by original identity; mirrors the capture-browser thumbnail LRU.
 * Concurrent misses for the same key share one render, and every render holds one of
 * FILE_THUMBNAIL_MAX_CONCURRENT slots for the whole read+decode so in-flight originals stay bounded. */
export function createFileThumbnails(maxConcurrent=FILE_THUMBNAIL_MAX_CONCURRENT){
  const cache=new Map<string,Buffer>(),inflight=new Map<string,Promise<Buffer>>(),queue:(()=>void)[]=[];
  let cachedBytes=0,running=0;
  const acquire=()=>running<maxConcurrent?(running++,Promise.resolve()):new Promise<void>(release=>queue.push(release));
  const release=()=>{const next=queue.shift();if(next)next();else running--;};
  const store=(key:string,bytes:Buffer)=>{
    while(cache.size>=MAX_ITEMS||cachedBytes+bytes.length>MAX_BYTES){
      const oldest=cache.keys().next().value;if(oldest===undefined)break;
      cachedBytes-=cache.get(oldest)!.length;cache.delete(oldest);
    }
    const prior=cache.get(key);if(prior)cachedBytes-=prior.length;
    cache.set(key,bytes);cachedBytes+=bytes.length;
  };
  return {
    async get(key:string,produce:()=>Promise<Buffer>){
      const hit=cache.get(key);
      if(hit){cache.delete(key);cache.set(key,hit);return hit;}
      let pending=inflight.get(key);
      if(!pending){
        pending=(async()=>{
          await acquire();
          try{const bytes=await produce();store(key,bytes);return bytes;}
          finally{inflight.delete(key);release();}
        })();
        inflight.set(key,pending);
      }
      return pending;
    },
    clear(){cache.clear();cachedBytes=0;},
  };
}

export async function renderFileThumbnail(bytes:Buffer,mimeType:string){
  let format:string|undefined;
  try{format=(await sharp(bytes).metadata()).format;}catch{format=undefined;}
  if(DECODED_MIME[format??'']!==mimeType)throw new StoreError('Thumbnail is unavailable',404);
  try{return await sharp(bytes,{limitInputPixels:24_000_000}).rotate().resize({width:480,height:480,fit:'inside',withoutEnlargement:true}).jpeg({quality:72}).toBuffer();}
  catch{throw new StoreError('Thumbnail is unavailable',404);}
}
