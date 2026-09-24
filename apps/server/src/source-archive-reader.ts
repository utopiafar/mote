import {archiveHash,SourceArchive} from './source-archive.js';
import type {SourceItem} from '@mote/shared';
import type {Store} from './store.js';
import {MAX_RAW_PAGE_ITEMS,MAX_RAW_READ_BYTES} from './raw-reader.js';
import type {RawCollectionRef,RawPageRequest,RawPageResult,RawReadRequest,RawReadResult,RawReader,RawRef} from './raw-reader.js';

export {MAX_RAW_PAGE_ITEMS,MAX_RAW_READ_BYTES} from './raw-reader.js';
const RAW_MEDIA_TYPE='application/vnd.mote.source-item+json';
const rawRefPattern=/^raw:v1:([a-f0-9]{64}):([a-f0-9]{64})$/;
const collectionPrefix='raw-collection:v1:';

/** Stable across head changes. It identifies the first accepted copy of a revision. */
export function sourceArchiveRawRef(sourceId:string,externalId:string,revision:string):RawRef {
  return `raw:v1:${archiveHash(sourceId)}:${archiveHash([externalId,revision])}`;
}

/** The encoded fields identify a logical group only; they are not storage locators. */
export function sourceArchiveCollectionRef(sourceId:string,group:string):RawCollectionRef {
  if(!sourceId||!group||group.length>4096)throw Error('Invalid raw collection identity');
  return collectionPrefix+Buffer.from(JSON.stringify([sourceId,group])).toString('base64url');
}

function parseCollection(ref:string):{sourceId:string;group:string}|undefined {
  if(!ref.startsWith(collectionPrefix)||ref.length>9000)return;
  try {
    const value=JSON.parse(Buffer.from(ref.slice(collectionPrefix.length),'base64url').toString()) as unknown;
    if(!Array.isArray(value)||value.length!==2||typeof value[0]!=='string'||typeof value[1]!=='string'||!value[0]||!value[1]||value[0].length>128||value[1].length>4096)return;
    return {sourceId:value[0],group:value[1]};
  }catch{return;}
}

type Cursor={collectionRef:string;snapshot:string;offset:number;lastId?:number};
function parseCursor(cursor:string):Cursor|undefined {
  if(cursor.length>12000)return;
  try {
    const value=JSON.parse(Buffer.from(cursor,'base64url').toString()) as Partial<Cursor>;
    if(typeof value.collectionRef!=='string'||typeof value.snapshot!=='string'||!(/^[a-f0-9]{64}$/.test(value.snapshot))||
      !Number.isSafeInteger(value.offset)||value.offset!<0||value.lastId!==undefined&&(!Number.isSafeInteger(value.lastId)||value.lastId<0))return;
    return value as Cursor;
  }catch{return;}
}

export type SourceArchiveRawAccess={
  mayReadSource:(sourceId:string)=>boolean;
  mayReadGroup:(sourceId:string,group:string)=>boolean;
};

/** Archive adapter. A mandatory policy checks source and group before any payload is returned. */
export class SourceArchiveRawReader implements RawReader {
  private readonly batches=new Map<string,SourceItem[]>();
  private lastRead?:{ref:string;bytes:Buffer};
  constructor(private readonly store:Store,private readonly archive:SourceArchive,
    private readonly access:SourceArchiveRawAccess) {}

  private allowedSource(sourceId:string):boolean {
    try{return this.access.mayReadSource(sourceId)===true;}catch{return false;}
  }
  private allowedGroup(sourceId:string,group:string):boolean {
    try{return this.access.mayReadGroup(sourceId,group)===true;}catch{return false;}
  }
  private sourceId(sourceHash:string):string|undefined {
    for(const row of this.store.db.prepare('SELECT source_id FROM source_archive_sizes').all()){
      const candidate=String(row.source_id);if(archiveHash(candidate)===sourceHash)return candidate;
    }
  }
  async read(ref:RawRef,request:RawReadRequest):Promise<RawReadResult> {
    if(!Number.isSafeInteger(request.offset)||request.offset<0||!Number.isSafeInteger(request.length)||request.length<1)return {status:'invalid_range'};
    if(request.length>MAX_RAW_READ_BYTES)return {status:'limit_exceeded',maxBytes:MAX_RAW_READ_BYTES};
    const parsed=rawRefPattern.exec(ref);if(!parsed)return {status:'missing'};
    const sourceId=this.sourceId(parsed[1]);if(!sourceId||!this.allowedSource(sourceId)||!this.archive.hasSource(sourceId))return {status:'unavailable'};
    const info=this.archive.versionInfo(sourceId,parsed[2]);if(!info)return {status:'missing'};
    if(!this.allowedGroup(sourceId,info.group))return {status:'unavailable'};
    let bytes=this.lastRead?.ref===ref?this.lastRead.bytes:undefined;
    if(!bytes){let item;
      try{item=this.archive.readVersion(sourceId,parsed[2],this.batches);}
      catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {status:'unavailable'};throw error;}
      if(!item)return {status:'missing'};
      bytes=Buffer.from(JSON.stringify(item));this.lastRead={ref,bytes};}
    const totalBytes=bytes.length;
    if(request.offset>totalBytes)return {status:'invalid_range',totalBytes};
    const end=Math.min(totalBytes,request.offset+request.length);
    // Copy the view so its ArrayBuffer cannot retain or disclose unread bytes.
    return {status:'available',ref,mediaType:RAW_MEDIA_TYPE,totalBytes,offset:request.offset,
      bytes:Uint8Array.from(bytes.subarray(request.offset,end)),nextOffset:end<totalBytes?end:null};
  }
  async page(request:RawPageRequest):Promise<RawPageResult> {
    const limit=request.limit??50;
    if(!Number.isSafeInteger(limit)||limit<1)return {status:'limit_exceeded',maxItems:MAX_RAW_PAGE_ITEMS};
    if(limit>MAX_RAW_PAGE_ITEMS)return {status:'limit_exceeded',maxItems:MAX_RAW_PAGE_ITEMS};
    const collection=parseCollection(request.collectionRef);
    if(!collection||!this.allowedSource(collection.sourceId)||!this.allowedGroup(collection.sourceId,collection.group)||!this.store.db.prepare('SELECT 1 FROM source_archive_sizes WHERE source_id=?').get(collection.sourceId)||!this.archive.hasSource(collection.sourceId))return {status:'unavailable'};
    if(request.seek&&(!Number.isSafeInteger(request.seek.offset)||request.seek.offset<0||!Number.isSafeInteger(request.seek.appendEpoch)||request.seek.appendEpoch<0||request.cursor))return {status:'invalid_cursor'};
    const cursor=request.cursor?parseCursor(request.cursor):undefined;
    if(request.cursor&&!cursor||cursor&&cursor.collectionRef!==request.collectionRef)return {status:'invalid_cursor'};
    const offset=cursor?.offset??request.seek?.offset??0;
    const {heads,total,checkpoint,appendEpoch,lastId}=this.archive.currentHeadsPage(collection.sourceId,collection.group,offset,limit,cursor?.lastId);
    if(cursor&&cursor.snapshot!==checkpoint)return {status:'stale_cursor'};
    if(request.seek&&request.seek.appendEpoch!==appendEpoch)return {status:'stale_cursor'};
    if(offset>total)return {status:'invalid_cursor'};
    const nextOffset=offset+heads.length;
    if(nextOffset<total&&lastId===null)return {status:'stale_cursor'};
    return {status:'available',items:heads.map(head=>({ref:`raw:v1:${archiveHash(collection.sourceId)}:${head.versionKey}`,observedAt:head.observedAt})),
      nextCursor:nextOffset<total?Buffer.from(JSON.stringify({collectionRef:request.collectionRef,snapshot:checkpoint,offset:nextOffset,lastId})).toString('base64url'):null,
      snapshot:checkpoint,total,appendEpoch};
  }
}
