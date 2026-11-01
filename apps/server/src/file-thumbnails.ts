import type {Readable} from 'node:stream';
import sharp from 'sharp';
import {StoreError} from './store.js';

export const FILE_THUMBNAIL_TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif']);
export const FILE_THUMBNAIL_MAX_ORIGINAL_BYTES=32*1024*1024;
const MAX_ITEMS=200,MAX_BYTES=16*1024*1024;

export async function readAll(stream:Readable){const parts:Buffer[]=[];for await(const part of stream)parts.push(part as Buffer);return Buffer.concat(parts);}

/** In-memory thumbnail cache keyed by original identity; mirrors the capture-browser thumbnail LRU. */
export function createFileThumbnails(){
  const cache=new Map<string,Buffer>();
  let cachedBytes=0;
  return {
    async get(key:string,produce:()=>Promise<Buffer>){
      const hit=cache.get(key);
      if(hit){cache.delete(key);cache.set(key,hit);return hit;}
      const bytes=await produce();
      while(cache.size>=MAX_ITEMS||cachedBytes+bytes.length>MAX_BYTES){
        const oldest=cache.keys().next().value;if(oldest===undefined)break;
        cachedBytes-=cache.get(oldest)!.length;cache.delete(oldest);
      }
      const prior=cache.get(key);if(prior)cachedBytes-=prior.length;
      cache.set(key,bytes);cachedBytes+=bytes.length;
      return bytes;
    },
    clear(){cache.clear();cachedBytes=0;},
  };
}

export async function renderFileThumbnail(bytes:Buffer){
  try{return await sharp(bytes,{limitInputPixels:24_000_000}).resize({width:480,height:480,fit:'inside',withoutEnlargement:true}).jpeg({quality:72}).toBuffer();}
  catch{throw new StoreError('Thumbnail is unavailable',404);}
}
