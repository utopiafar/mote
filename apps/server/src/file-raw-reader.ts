import {createHash} from 'node:crypto';
import type {RawCollectionRef,RawPageRequest,RawPageResult,RawReadRequest,RawReadResult,RawReader,RawRef} from './raw-reader.js';
import {MAX_RAW_PAGE_ITEMS,MAX_RAW_READ_BYTES} from './raw-reader.js';
import type {FileStore} from './files.js';
import type {ArchivedFileStore} from './archived-files.js';
import type {Store} from './store.js';
import {StoreError} from './store.js';

const versionRef=/^raw-file:v1:([0-9a-f-]{36}):([a-f0-9]{64}|missing)$/;
const archivedRef=/^raw-archive:v1:([0-9a-f-]{36}):([a-f0-9]{64})$/;
const sourceCollectionPrefix='raw-file-collection:v1:source:';
const archivedCollection='raw-file-collection:v1:archived';
const digest=/^[a-f0-9]{64}$/;

/** Capture ID pins the source revision; the hash pins the exact original bytes. */
export function fileOriginalRawRef(captureId:string,objectHash:string|null):RawRef {
  if(!/^[0-9a-f-]{36}$/.test(captureId)||objectHash!==null&&!digest.test(objectHash))throw Error('Invalid file original identity');
  return `raw-file:v1:${captureId}:${objectHash??'missing'}`;
}
/** Archive ID and content hash both survive metadata updates and deduplication. */
export function archivedOriginalRawRef(id:string,hash:string):RawRef {
  if(!/^[0-9a-f-]{36}$/.test(id)||!digest.test(hash))throw Error('Invalid archived original identity');
  return `raw-archive:v1:${id}:${hash}`;
}
export function sourceFileCollectionRef(sourceId:string):RawCollectionRef {
  if(!sourceId||sourceId.length>128)throw Error('Invalid source identity');
  return sourceCollectionPrefix+Buffer.from(sourceId).toString('base64url');
}
export function archivedFileCollectionRef():RawCollectionRef {return archivedCollection;}

export type FileRawAccess={
  mayReadFileVersion:(sourceId:string,captureId:string)=>boolean;
  mayReadArchivedFile:(id:string)=>boolean;
  mayListSourceFiles:(sourceId:string)=>boolean;
  mayListArchivedFiles:()=>boolean;
};
type Cursor={collectionRef:string;snapshot:string;offset:number};
function parseCursor(value:string):Cursor|undefined {
  if(value.length>12000)return;
  try {
    const parsed=JSON.parse(Buffer.from(value,'base64url').toString()) as Partial<Cursor>;
    if(typeof parsed.collectionRef!=='string'||typeof parsed.snapshot!=='string'||!digest.test(parsed.snapshot)||!Number.isSafeInteger(parsed.offset)||parsed.offset!<0)return;
    return parsed as Cursor;
  }catch{return;}
}
function parseCollection(value:string):{kind:'source';sourceId:string}|{kind:'archived'}|undefined {
  if(value===archivedCollection)return {kind:'archived'};
  if(!value.startsWith(sourceCollectionPrefix)||value.length>500)return;
  try {
    const sourceId=Buffer.from(value.slice(sourceCollectionPrefix.length),'base64url').toString();
    return sourceId&&sourceId.length<=128?{kind:'source',sourceId}:undefined;
  }catch{return;}
}
function mediaType(value:unknown):string {
  return typeof value==='string'&&value.length>0&&value.length<=200&&!/[\r\n\u0000]/.test(value)?value:'application/octet-stream';
}
function missing(error:unknown):boolean{return error instanceof StoreError&&error.statusCode===404||(error as NodeJS.ErrnoException)?.code==='ENOENT';}

/** Request-scoped original reader. It returns no path, mutable handle or writer. */
export class FileRawReader implements RawReader {
  constructor(private readonly store:Store,private readonly files:FileStore,private readonly archived:ArchivedFileStore,
    private readonly access:FileRawAccess) {}
  private permitted(check:()=>boolean):boolean {try{return check()===true;}catch{return false;}}

  async read(ref:RawRef,request:RawReadRequest):Promise<RawReadResult> {
    if(!Number.isSafeInteger(request.offset)||request.offset<0||!Number.isSafeInteger(request.length)||request.length<1)return {status:'invalid_range'};
    if(request.length>MAX_RAW_READ_BYTES)return {status:'limit_exceeded',maxBytes:MAX_RAW_READ_BYTES};
    const file=versionRef.exec(ref);
    if(file){
      let version:ReturnType<FileStore['version']>;
      try{version=this.files.version(file[1]);}catch(error){if(missing(error))return {status:'missing'};throw error;}
      if(!this.permitted(()=>this.access.mayReadFileVersion(version.source_id,version.capture_id)))return {status:'unavailable'};
      if(version.object_hash!==file[2])return {status:version.object_hash===null&&file[2]==='missing'?'unavailable':'missing'};
      if(!version.object_hash)return {status:'unavailable'};
      let size:number;
      try{size=this.store.assets.get(version.object_hash).bytes;}catch(error){if(missing(error))return {status:'unavailable'};throw error;}
      const manifest=JSON.parse(version.manifest) as {sizeBytes:number;item:{mimeType?:string}};
      if(size!==manifest.sizeBytes)throw new StoreError('File original size mismatch',500);
      if(request.offset>size)return {status:'invalid_range',totalBytes:size};
      const end=Math.min(size,request.offset+request.length),parts:Buffer[]=[];
      try{if(end>request.offset)for(const part of this.files.bytes(version.capture_id,request.offset,end-1))parts.push(part);}
      catch(error){if(missing(error))return {status:'unavailable'};throw error;}
      let current:ReturnType<FileStore['version']>;
      try{current=this.files.version(version.capture_id);}catch(error){if(missing(error))return {status:'unavailable'};throw error;}
      if(current.object_hash!==version.object_hash||!this.permitted(()=>this.access.mayReadFileVersion(version.source_id,version.capture_id)))return {status:'unavailable'};
      const bytes=Uint8Array.from(Buffer.concat(parts));
      return {status:'available',ref,mediaType:mediaType(manifest.item.mimeType),totalBytes:size,offset:request.offset,bytes,nextOffset:end<size?end:null};
    }
    const imported=archivedRef.exec(ref);
    if(imported){
      let record:ReturnType<ArchivedFileStore['get']>;
      try{record=this.archived.get(imported[1]);}catch(error){if(missing(error))return {status:'missing'};throw error;}
      if(!this.permitted(()=>this.access.mayReadArchivedFile(record.id)))return {status:'unavailable'};
      if(record.hash!==imported[2])return {status:'missing'};
      let size:number;
      try{size=this.store.assets.get(record.hash).bytes;}catch(error){if(missing(error))return {status:'unavailable'};throw error;}
      if(size!==record.sizeBytes)throw new StoreError('Archived original size mismatch',500);
      if(request.offset>size)return {status:'invalid_range',totalBytes:size};
      const end=Math.min(size,request.offset+request.length),parts:Buffer[]=[];
      try{if(end>request.offset)for(const part of this.store.assets.bytes(record.hash,request.offset,end-1)){
        const current=this.archived.get(record.id);if(current.hash!==record.hash)throw new StoreError('Archived original changed',409);
        parts.push(part);
      }}catch(error){if(missing(error))return {status:'unavailable'};throw error;}
      let current:ReturnType<ArchivedFileStore['get']>;
      try{current=this.archived.get(record.id);}catch(error){if(missing(error))return {status:'unavailable'};throw error;}
      if(current.hash!==record.hash||!this.permitted(()=>this.access.mayReadArchivedFile(record.id)))return {status:'unavailable'};
      const bytes=Uint8Array.from(Buffer.concat(parts));
      return {status:'available',ref,mediaType:mediaType(record.mimeType),totalBytes:size,offset:request.offset,bytes,nextOffset:end<size?end:null};
    }
    return {status:'missing'};
  }

  async page(request:RawPageRequest):Promise<RawPageResult> {
    if(request.seek)return {status:'invalid_cursor'};
    const limit=request.limit??50;
    if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_RAW_PAGE_ITEMS)return {status:'limit_exceeded',maxItems:MAX_RAW_PAGE_ITEMS};
    const collection=parseCollection(request.collectionRef);if(!collection)return {status:'unavailable'};
    if(collection.kind==='source'&&!this.permitted(()=>this.access.mayListSourceFiles(collection.sourceId))||collection.kind==='archived'&&!this.permitted(()=>this.access.mayListArchivedFiles()))return {status:'unavailable'};
    const cursor=request.cursor?parseCursor(request.cursor):undefined;
    if(request.cursor&&!cursor||cursor&&cursor.collectionRef!==request.collectionRef)return {status:'invalid_cursor'};
    const offset=cursor?.offset??0,items:{ref:RawRef;observedAt:string}[]=[],hash=createHash('sha256').update(request.collectionRef);let total=0;
    if(collection.kind==='source'){
      const rows=this.store.db.prepare("SELECT capture_id,object_hash,json_extract(manifest,'$.item.observedAt') AS observed_at FROM file_versions WHERE source_id=? AND object_hash IS NOT NULL ORDER BY capture_id").iterate(collection.sourceId);
      for(const row of rows){const id=String(row.capture_id),objectHash=String(row.object_hash);if(!this.permitted(()=>this.access.mayReadFileVersion(collection.sourceId,id)))continue;
        hash.update(JSON.stringify([id,objectHash,row.observed_at]));
        if(total>=offset&&items.length<limit)items.push({ref:fileOriginalRawRef(id,objectHash),observedAt:String(row.observed_at)});total++;
      }
    }else{
      const rows=this.store.db.prepare("SELECT id,hash,json_extract(json,'$.createdAt') AS observed_at FROM archived_files ORDER BY id").iterate();
      for(const row of rows){const id=String(row.id),objectHash=String(row.hash);if(!this.permitted(()=>this.access.mayReadArchivedFile(id)))continue;
        hash.update(JSON.stringify([id,objectHash,row.observed_at]));
        if(total>=offset&&items.length<limit)items.push({ref:archivedOriginalRawRef(id,objectHash),observedAt:String(row.observed_at)});total++;
      }
    }
    const snapshot=hash.digest('hex');
    if(cursor&&cursor.snapshot!==snapshot)return {status:'stale_cursor'};
    if(offset>total)return {status:'invalid_cursor'};
    const nextOffset=offset+items.length;
    return {status:'available',items,nextCursor:nextOffset<total?Buffer.from(JSON.stringify({collectionRef:request.collectionRef,snapshot,offset:nextOffset})).toString('base64url'):null,snapshot,total};
  }
}
