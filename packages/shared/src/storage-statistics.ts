import {lstat, readdir} from 'node:fs/promises';
import {basename, extname, join, resolve} from 'node:path';
export interface StorageBucket {key:string;bytes:number;files:number}
export interface StorageStatistics {bytes:number;files:number;skipped:number;generatedAt:string;timeZone:'UTC';dateBasis:'modified';days:StorageBucket[];types:StorageBucket[]}
/** Physical bytes of app-owned files, counted once; never follows symlinks or opens content. */
export async function storageStatistics(roots:string[], classify?:(path:string)=>string|undefined):Promise<StorageStatistics> {
  const days=new Map<string,StorageBucket>(),types=new Map<string,StorageBucket>(),seen=new Set<string>();
  const result:StorageStatistics={bytes:0,files:0,skipped:0,generatedAt:new Date().toISOString(),timeZone:'UTC',dateBasis:'modified',days:[],types:[]};
  const add=(map:Map<string,StorageBucket>,key:string,size:number)=>{const row=map.get(key)??{key,bytes:0,files:0};row.bytes+=size;row.files++;map.set(key,row);};
  async function visit(path:string):Promise<void> {
    path=resolve(path);if(seen.has(path))return;seen.add(path);
    try {const info=await lstat(path);if(info.isSymbolicLink()){result.skipped++;return;}
      if(info.isDirectory()){for(const entry of await readdir(path))await visit(join(path,entry));return;}
      if(!info.isFile())return;
      result.bytes+=info.size;result.files++;
      add(days,info.mtime.toISOString().slice(0,10),info.size);
      const name=basename(path);const type=classify?.(path)??(name.includes('.sqlite')?'database':/\.(gguf|onnx|bin)$/.test(name)?'model':/\.(event|enc|json|ndjson)$/.test(name)?'json':name.endsWith('.blob')?'image':extname(name).slice(1)||'other');
      add(types,type,info.size);
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')result.skipped++;}
  }
  for(const root of roots)await visit(root);
  result.days=[...days.values()].sort((a,b)=>a.key.localeCompare(b.key));result.types=[...types.values()].sort((a,b)=>b.bytes-a.bytes||a.key.localeCompare(b.key));return result;
}
