/** A logical, version-pinned address. Consumers must not parse it or treat it as a file path. */
export type RawRef=string;
/** A logical collection of current refs. Its cursor is invalidated when membership changes. */
export type RawCollectionRef=string;
export const MAX_RAW_READ_BYTES=64*1024;
export const MAX_RAW_PAGE_ITEMS=100;

export type RawReadRequest={offset:number;length:number};
export type RawReadResult=
  |{status:'available';ref:RawRef;mediaType:string;totalBytes:number;offset:number;bytes:Uint8Array;nextOffset:number|null}
  |{status:'missing'|'unavailable'}
  |{status:'invalid_range';totalBytes?:number}
  |{status:'limit_exceeded';maxBytes:number};

/** A seek is valid only while no existing item in that collection has changed
 * since the pinned append epoch. It lets append-only consumers skip old refs. */
export type RawPageRequest={collectionRef:RawCollectionRef;cursor?:string;limit?:number;seek?:{offset:number;appendEpoch:number}};
export type RawPageResult=
  |{status:'available';items:{ref:RawRef;observedAt:string}[];nextCursor:string|null;snapshot:string;total:number;appendEpoch?:number}
  |{status:'unavailable'|'invalid_cursor'|'stale_cursor'}
  |{status:'limit_exceeded';maxItems:number};

/** Construct one reader per authorization context. No write operations are exposed.
 * These refs are host-side evidence addresses, not query-agent tools by default. */
export interface RawReader {
  read(ref:RawRef,request:RawReadRequest):Promise<RawReadResult>;
  page(request:RawPageRequest):Promise<RawPageResult>;
}
