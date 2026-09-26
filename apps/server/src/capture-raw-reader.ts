import {createHash} from 'node:crypto';
import {sourceItemSchema,type CaptureRecord,type SourceItem,type SourceItemRecord} from '@mote/shared';
import type {Store} from './store.js';
import {MAX_RAW_PAGE_ITEMS,MAX_RAW_READ_BYTES} from './raw-reader.js';
import type {RawCollectionRef,RawPageRequest,RawPageResult,RawReadRequest,RawReadResult,RawReader,RawRef} from './raw-reader.js';

export const CAPTURE_RAW_READER_VERSION='1';
const mediaType='application/vnd.mote.source-item+json';
const captureRef=/^raw-capture:v1:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const collectionPrefix='raw-capture-collection:v1:';
const sourceKinds=['calendar','file','event','message','metric','memory'] as const;
type SourceKind=SourceItem['kind'];
type CurrentRow={source_id:string;external_id:string;capture_id:string;observed_at:string;revision:string;hash:string;json:string;received_at:string};
type Cursor={collectionRef:string;snapshot:string;offset:number};

export type CaptureRawAccess={
  mayReadSource:(sourceId:string)=>boolean;
  /** A SourceItem's stable organizer group is its external ID within a source. */
  mayReadGroup:(sourceId:string,externalId:string)=>boolean;
  mayListKind:(sourceId:string,kind:SourceKind)=>boolean;
};

/** The capture ID pins one accepted source revision, but reads still require it to be current. */
export function captureRawRef(captureId:string):RawRef {
  if(!captureRef.test(`raw-capture:v1:${captureId}`))throw Error('Invalid capture identity');
  return `raw-capture:v1:${captureId}`;
}

export function captureCollectionRef(sourceId:string,kind:SourceKind):RawCollectionRef {
  if(!sourceId||sourceId.length>128||!sourceKinds.includes(kind))throw Error('Invalid capture collection identity');
  return collectionPrefix+Buffer.from(JSON.stringify([sourceId,kind])).toString('base64url');
}

function parseCollection(ref:string):{sourceId:string;kind:SourceKind}|undefined {
  if(!ref.startsWith(collectionPrefix)||ref.length>500)return;
  try {
    const value=JSON.parse(Buffer.from(ref.slice(collectionPrefix.length),'base64url').toString()) as unknown;
    if(!Array.isArray(value)||value.length!==2||typeof value[0]!=='string'||!value[0]||value[0].length>128||!sourceKinds.includes(value[1] as SourceKind))return;
    return {sourceId:value[0],kind:value[1] as SourceKind};
  }catch{return;}
}

function parseCursor(cursor:string):Cursor|undefined {
  if(cursor.length>12000)return;
  try {
    const value=JSON.parse(Buffer.from(cursor,'base64url').toString()) as Partial<Cursor>;
    if(typeof value.collectionRef!=='string'||typeof value.snapshot!=='string'||!/^[a-f0-9]{64}$/.test(value.snapshot)||!Number.isSafeInteger(value.offset)||value.offset!<0)return;
    return value as Cursor;
  }catch{return;}
}

/** Read-only adapter for SourceStore records in captures/source_heads/source_versions.
 * Policy is mandatory and checked again on every chunk, including after a prior page/ref lookup. */
export class CaptureRawReader implements RawReader {
  constructor(private readonly store:Store,private readonly access:CaptureRawAccess) {}

  private permitted(check:()=>boolean):boolean {try{return check()===true;}catch{return false;}}
  private sourceExists(sourceId:string):boolean {
    return Boolean(this.store.db.prepare('SELECT 1 FROM source_connections WHERE id=?').get(sourceId));
  }
  private currentByItem(sourceId:string,externalId:string):CurrentRow|undefined {
    return this.store.db.prepare(`SELECT h.source_id,h.external_id,h.capture_id,h.observed_at,v.revision,v.hash,c.json,c.received_at
      FROM source_heads h JOIN source_versions v ON v.source_id=h.source_id AND v.external_id=h.external_id AND v.capture_id=h.capture_id
      JOIN captures c ON c.id=h.capture_id
      WHERE h.source_id=? AND h.external_id=? AND h.deleted=0`).get(sourceId,externalId) as CurrentRow|undefined;
  }
  private currentByCapture(captureId:string):CurrentRow|undefined {
    return this.store.db.prepare(`SELECT h.source_id,h.external_id,h.capture_id,h.observed_at,v.revision,v.hash,c.json,c.received_at
      FROM source_heads h JOIN source_versions v ON v.source_id=h.source_id AND v.external_id=h.external_id AND v.capture_id=h.capture_id
      JOIN captures c ON c.id=h.capture_id
      WHERE h.capture_id=? AND h.deleted=0`).get(captureId) as CurrentRow|undefined;
  }
  private authorized(row:CurrentRow):boolean {
    return this.sourceExists(row.source_id)&&this.permitted(()=>this.access.mayReadSource(row.source_id))&&
      this.permitted(()=>this.access.mayReadGroup(row.source_id,row.external_id));
  }
  private record(row:CurrentRow,capture=JSON.parse(row.json) as CaptureRecord):SourceItemRecord|undefined {
    const p=capture.provenance;
    if(!p||p.sourceId!==row.source_id||p.externalId!==row.external_id||p.revision!==row.revision||capture.id!==row.capture_id||p.deleted||Date.parse(capture.capturedAt)!==Date.parse(row.observed_at))return;
    const parsed=sourceItemSchema.safeParse({externalId:p.externalId,revision:p.revision,observedAt:capture.capturedAt,
      modifiedAt:p.modifiedAt,title:capture.windowTitle,text:p.layer==='reference'?'':capture.ocrText,uri:p.uri,kind:capture.source,
      layer:p.layer,calendar:p.calendar,mimeType:p.mimeType,deleted:p.deleted,metadata:p.metadata,document:p.document});
    if(!parsed.success)return;
    const {observedAt:_,...semantic}=parsed.data;
    if(createHash('sha256').update(JSON.stringify(semantic)).digest('hex')!==row.hash)return;
    return {...parsed.data,sourceId:row.source_id,captureId:row.capture_id,receivedAt:row.received_at,current:true};
  }
  /** One authorized typed snapshot for an organizer build; no paging/serialization round trip. */
  snapshotForItem(sourceId:string,externalId:string){
    const row=this.currentByItem(sourceId,externalId);if(!row||!this.authorized(row))return;
    const capture=JSON.parse(row.json) as CaptureRecord,item=this.record(row,capture);
    if(!item||!this.authorized(row))return;
    const evidence=this.store.evidence([row.capture_id])[0];if(!evidence)return;
    return {ref:captureRawRef(row.capture_id),item,capture:evidence};
  }
  currentRefForItem(sourceId:string,externalId:string){
    const row=this.currentByItem(sourceId,externalId);return row&&this.authorized(row)?captureRawRef(row.capture_id):undefined;
  }
  /** Resolve an exact SourceItem group to a revision-pinned ref after checking access. */
  refForItem(sourceId:string,externalId:string):RawRef|undefined {
    if(!sourceId||!externalId||sourceId.length>128||externalId.length>1000||!this.sourceExists(sourceId)||
      !this.permitted(()=>this.access.mayReadSource(sourceId))||!this.permitted(()=>this.access.mayReadGroup(sourceId,externalId)))return;
    const row=this.currentByItem(sourceId,externalId);
    return row&&this.record(row)?captureRawRef(row.capture_id):undefined;
  }
  async read(ref:RawRef,request:RawReadRequest):Promise<RawReadResult> {
    if(!Number.isSafeInteger(request.offset)||request.offset<0||!Number.isSafeInteger(request.length)||request.length<1)return {status:'invalid_range'};
    if(request.length>MAX_RAW_READ_BYTES)return {status:'limit_exceeded',maxBytes:MAX_RAW_READ_BYTES};
    const id=captureRef.exec(ref)?.[1];if(!id)return {status:'missing'};
    const row=this.currentByCapture(id);
    if(!row)return {status:this.store.db.prepare('SELECT 1 FROM source_versions WHERE capture_id=?').get(id)?'unavailable':'missing'};
    if(!this.authorized(row))return {status:'unavailable'};
    const record=this.record(row);if(!record)return {status:'unavailable'};
    const bytes=Buffer.from(JSON.stringify(record)),totalBytes=bytes.length;
    if(request.offset>totalBytes)return {status:'invalid_range',totalBytes};
    const end=Math.min(totalBytes,request.offset+request.length);
    // Recheck after constructing the payload so a concurrent revocation cannot use a cached ref.
    if(this.currentByCapture(id)?.capture_id!==id||!this.authorized(row))return {status:'unavailable'};
    return {status:'available',ref,mediaType,totalBytes,offset:request.offset,
      bytes:Uint8Array.from(bytes.subarray(request.offset,end)),nextOffset:end<totalBytes?end:null};
  }
  async page(request:RawPageRequest):Promise<RawPageResult> {
    const limit=request.limit??50;
    if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_RAW_PAGE_ITEMS)return {status:'limit_exceeded',maxItems:MAX_RAW_PAGE_ITEMS};
    const collection=parseCollection(request.collectionRef);
    if(!collection||!this.sourceExists(collection.sourceId)||!this.permitted(()=>this.access.mayReadSource(collection.sourceId))||
      !this.permitted(()=>this.access.mayListKind(collection.sourceId,collection.kind)))return {status:'unavailable'};
    const cursor=request.cursor?parseCursor(request.cursor):undefined;
    if(request.cursor&&!cursor||cursor&&cursor.collectionRef!==request.collectionRef)return {status:'invalid_cursor'};
    const offset=cursor?.offset??0,items:{ref:RawRef;observedAt:string}[]=[],hash=createHash('sha256').update(request.collectionRef);let total=0;
    const rows=this.store.db.prepare(`SELECT h.source_id,h.external_id,h.capture_id,h.observed_at,v.revision,v.hash,c.json,c.received_at
      FROM source_heads h JOIN source_versions v ON v.source_id=h.source_id AND v.external_id=h.external_id AND v.capture_id=h.capture_id
      JOIN captures c ON c.id=h.capture_id WHERE h.source_id=? AND h.deleted=0 AND json_extract(c.json,'$.source')=? ORDER BY h.external_id`).iterate(collection.sourceId,collection.kind);
    for(const raw of rows){const row=raw as unknown as CurrentRow;
      if(!this.permitted(()=>this.access.mayReadGroup(row.source_id,row.external_id))||!this.record(row))continue;
      hash.update(JSON.stringify([row.external_id,row.capture_id,row.observed_at]));
      if(total>=offset&&items.length<limit)items.push({ref:captureRawRef(row.capture_id),observedAt:row.observed_at});total++;
    }
    if(!this.sourceExists(collection.sourceId)||!this.permitted(()=>this.access.mayReadSource(collection.sourceId))||
      !this.permitted(()=>this.access.mayListKind(collection.sourceId,collection.kind)))return {status:'unavailable'};
    const snapshot=hash.digest('hex');
    if(cursor&&cursor.snapshot!==snapshot)return {status:'stale_cursor'};
    if(offset>total)return {status:'invalid_cursor'};
    const nextOffset=offset+items.length;
    return {status:'available',items,nextCursor:nextOffset<total?Buffer.from(JSON.stringify({collectionRef:request.collectionRef,snapshot,offset:nextOffset})).toString('base64url'):null,snapshot,total};
  }
}
