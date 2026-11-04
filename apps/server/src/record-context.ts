import {createHash} from 'node:crypto';
import type {AttributionContext,CaptureInput} from '@mote/shared';
import {z} from 'zod';
import {StoreError,type Store} from './store.js';
import {encodeMemoryPrivate,decodeMemoryPrivate} from './plugins/memory-private-storage.js';
import {recordContextDeclarationSchema as declarationSchema,portableRecordContextSchema,type PortableRecordContext} from './record-context-contract.js';
export {portableRecordContextSchema,type PortableRecordContext} from './record-context-contract.js';

type Declaration=z.infer<typeof declarationSchema>;
type Pin=NonNullable<AttributionContext['recordContextDeclarations']>[number];
const fingerprint=(value:Declaration)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Transport prose is removed before canonical evidence, search or heartbeat storage. */
export function withoutOwnerDescription(input:CaptureInput):CaptureInput {
  if(input.metadata?.ownerDescription===undefined)return input;
  const {ownerDescription:_,...metadata}=input.metadata;
  return {...input,metadata};
}

/** Host-owned private declarations. They are immutable, and live exactly as long
 * as their original capture. No source prose or derived output can create one. */
export class RecordContextStore {
  constructor(private readonly store:Store){
    store.db.exec(`CREATE TABLE IF NOT EXISTS record_context_declarations(
      capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
      version INTEGER NOT NULL CHECK(version=1),capture_fingerprint TEXT NOT NULL,
      fingerprint TEXT NOT NULL,json TEXT NOT NULL);`);
    if(store.contentEncryption.enabled){
      const own=!store.db.isTransaction;if(own)store.db.exec('BEGIN IMMEDIATE');
      try{
        for(const row of store.db.prepare("SELECT capture_id,json FROM record_context_declarations WHERE json LIKE 'json:%'").all()){
          const json=encodeMemoryPrivate(store,decodeMemoryPrivate(store,String(row.json)));
          store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(String(row.json))));
          store.db.prepare('UPDATE record_context_declarations SET json=? WHERE capture_id=?').run(json,row.capture_id);
        }
        if(own)store.db.exec('COMMIT');
      }catch(error){if(own&&store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
    }
  }
  /** Called in the receive transaction, including every duplicate receipt.
   * Absent and empty are equivalent; nonempty prose is preserved byte-for-byte. */
  bind(captureId:string,description:string|undefined,duplicate:boolean){
    const capture=this.store.db.prepare('SELECT fingerprint FROM captures WHERE id=?').get(captureId);
    if(!capture)throw new StoreError('Record description has no original capture',409);
    const previous=this.store.db.prepare('SELECT * FROM record_context_declarations WHERE capture_id=?').get(captureId);
    const text=description??'';
    if(previous){
      if(this.original(previous).description!==text)throw new StoreError('Record description changed; submit a new event identity',409);
      return;
    }
    if(!text)return;
    if(duplicate)throw new StoreError('Record description cannot be added to an existing event',409);
    this.insert(declarationSchema.parse({captureId,version:1,captureFingerprint:String(capture.fingerprint),description:text}));
  }
  private insert(value:Declaration){
    const json=encodeMemoryPrivate(this.store,{description:value.description});
    this.store.reserveMetadata(Buffer.byteLength(json)+Buffer.byteLength(value.captureId)+256);
    this.store.db.prepare('INSERT INTO record_context_declarations VALUES(?,?,?,?,?)').run(value.captureId,value.version,value.captureFingerprint,fingerprint(value),json);
  }
  /** Only exact parent links inherit context, never another capture sharing a file. */
  identities(captureIds:string[]):Pin[]{
    if(!captureIds.length)return [];
    return this.store.db.prepare(`WITH RECURSIVE originals(id) AS (
      SELECT value FROM json_each(?) UNION SELECT l.parent_id FROM file_evidence_links l JOIN originals o ON l.capture_id=o.id)
      SELECT DISTINCT d.capture_id captureId,d.version,d.fingerprint FROM originals o
      JOIN record_context_declarations d ON d.capture_id=o.id
      JOIN captures c ON c.id=d.capture_id AND c.fingerprint=d.capture_fingerprint
      ORDER BY d.capture_id`).all(JSON.stringify(captureIds)) as Pin[];
  }
  open(pins:Pin[]):NonNullable<AttributionContext['recordContextStatements']>{
    return pins.flatMap(pin=>{
      const row=this.store.db.prepare('SELECT d.* FROM record_context_declarations d JOIN captures c ON c.id=d.capture_id AND c.fingerprint=d.capture_fingerprint WHERE d.capture_id=? AND d.version=? AND d.fingerprint=?').get(pin.captureId,pin.version,pin.fingerprint);
      if(!row)return [];
      const value=this.original(row);
      return [{captureId:value.captureId,version:value.version,description:value.description}];
    });
  }
  private original(row:Record<string,unknown>):Declaration {
    const {description}=decodeMemoryPrivate<{description:string}>(this.store,String(row.json));
    const value=declarationSchema.parse({captureId:String(row.capture_id),version:Number(row.version),captureFingerprint:String(row.capture_fingerprint),description});
    if(fingerprint(value)!==row.fingerprint)throw new StoreError('Stored record description changed',409);
    return value;
  }
  export():PortableRecordContext {
    return {declarations:this.store.db.prepare('SELECT d.* FROM record_context_declarations d JOIN captures c ON c.id=d.capture_id AND c.fingerprint=d.capture_fingerprint ORDER BY d.capture_id').all().map(row=>({...this.original(row),fingerprint:String(row.fingerprint)}))};
  }
  restore(raw:PortableRecordContext){
    const value=portableRecordContextSchema.parse(raw),seen=new Set<string>();
    for(const row of value.declarations){
      const {fingerprint:expected,...declaration}=row;
      const capture=this.store.db.prepare('SELECT fingerprint FROM captures WHERE id=?').get(declaration.captureId);
      if(seen.has(declaration.captureId)||!capture||capture.fingerprint!==declaration.captureFingerprint||fingerprint(declaration)!==expected)throw new StoreError('Invalid portable record description or original scope');
      seen.add(declaration.captureId);
      const previous=this.store.db.prepare('SELECT * FROM record_context_declarations WHERE capture_id=?').get(declaration.captureId);
      if(previous){if(fingerprint(this.original(previous))!==expected)throw new StoreError('Portable record description conflicts with destination',409);}
      else this.insert(declaration);
    }
  }
}
