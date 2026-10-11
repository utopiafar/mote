import {z} from 'zod';
import {createHash} from 'node:crypto';
import {sourceContextDeclarationSchema,sourceContextSnapshotSchema,sourceContextUpdateSchema,type AttributionContext,type SourceContextDeclaration,type SourceContextSnapshot} from '@mote/shared';
import {StoreError,type Store} from './store.js';
import {encodeMemoryPrivate,decodeMemoryPrivate} from './memory-private-storage.js';

const declarationSchema=sourceContextSnapshotSchema.extend({version:z.number().int().positive(),fingerprint:sourceContextDeclarationSchema.shape.fingerprint,updatedAt:z.string().datetime({offset:true})}).strict();
export const portableSourceContextSchema=z.object({declarations:z.array(declarationSchema)}).strict();
export type PortableSourceContext=z.infer<typeof portableSourceContextSchema>;
const fingerprint=(value:{sourceId:string;version:number;description:string})=>createHash('sha256').update(JSON.stringify({sourceId:value.sourceId,version:value.version,description:value.description})).digest('hex');

/** Owner-only control plane metadata. Collector content cannot write these
 * rows, and a source's public JSON holds only the immutable version pin. */
export class SourceContextStore {
  constructor(private readonly store:Store){
    store.db.exec(`CREATE TABLE IF NOT EXISTS source_context_declarations(
      source_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,fingerprint TEXT NOT NULL,json TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(source_id,version));`);
    if(store.contentEncryption.enabled){
      const own=!store.db.isTransaction;if(own)store.db.exec('BEGIN IMMEDIATE');
      try{
        for(const row of store.db.prepare("SELECT source_id,version,json FROM source_context_declarations WHERE json LIKE 'json:%'").all()){
          const json=encodeMemoryPrivate(store,decodeMemoryPrivate(store,String(row.json)));
          store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(String(row.json))));
          store.db.prepare('UPDATE source_context_declarations SET json=? WHERE source_id=? AND version=?').run(json,row.source_id,row.version);
        }
        if(own)store.db.exec('COMMIT');
      }catch(error){if(own&&store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
    }
  }
  private source(sourceId:string):Record<string,unknown>{
    sourceContextDeclarationSchema.shape.sourceId.parse(sourceId);
    const row=this.store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(sourceId);
    if(!row)throw new StoreError('Source not found',404);return JSON.parse(String(row.json));
  }
  identity(sourceId:string):SourceContextDeclaration|undefined{
    const source=this.source(sourceId);if(!source.sourceContext)return undefined;
    const pin=sourceContextDeclarationSchema.parse({sourceId,...source.sourceContext as object});
    if(!this.getAtVersion(pin.sourceId,pin.version,pin.fingerprint))throw new StoreError('Source context declaration is missing or changed',409);
    return pin;
  }
  current(sourceId:string):SourceContextSnapshot{
    const pin=this.identity(sourceId);return pin?this.getAtVersion(pin.sourceId,pin.version,pin.fingerprint)!:{sourceId,version:0,description:''};
  }
  getAtVersion(sourceId:string,version:number,expectedFingerprint?:string):SourceContextSnapshot|undefined{
    sourceContextDeclarationSchema.shape.sourceId.parse(sourceId);z.number().int().positive().parse(version);
    const row=this.store.db.prepare('SELECT * FROM source_context_declarations WHERE source_id=? AND version=?').get(sourceId,version);
    if(!row||expectedFingerprint!==undefined&&row.fingerprint!==expectedFingerprint)return undefined;
    const {description}=decodeMemoryPrivate<{description:string}>(this.store,String(row.json));
    const value=declarationSchema.parse({sourceId,version,description,fingerprint:String(row.fingerprint),updatedAt:String(row.updated_at)});
    if(fingerprint(value)!==value.fingerprint)throw new StoreError('Stored source context declaration changed',409);
    return value;
  }
  open(pins:SourceContextDeclaration[]):NonNullable<AttributionContext['sourceContextStatements']>{
    return pins.flatMap(pin=>{const value=this.getAtVersion(pin.sourceId,pin.version,pin.fingerprint);return value?[{sourceId:value.sourceId,version:value.version,description:value.description}]:[];});
  }
  /** Caller owns the surrounding transaction and invalidation hook. Repeating
   * an acknowledged value is harmless; a lost response can retry one version. */
  set(sourceId:string,input:z.infer<typeof sourceContextUpdateSchema>):{snapshot:SourceContextSnapshot;changed:boolean}{
    if(!this.store.db.isTransaction)throw new StoreError('Source context writes require a transaction');
    const patch=sourceContextUpdateSchema.parse(input),current=this.current(sourceId);
    if(patch.expectedVersion!==current.version){
      if(patch.expectedVersion===current.version-1&&patch.description===current.description)return {snapshot:current,changed:false};
      throw new StoreError('Source context version changed; refresh and retry',409);
    }
    if(patch.description===current.description)return {snapshot:current,changed:false};
    const value={sourceId,version:current.version+1,description:patch.description,updatedAt:new Date().toISOString()},pin={version:value.version,fingerprint:fingerprint(value)};
    const json=encodeMemoryPrivate(this.store,{description:value.description}),source={...this.source(sourceId),sourceContext:pin,updatedAt:value.updatedAt};
    this.store.reserveMetadata(Buffer.byteLength(json)+Buffer.byteLength(JSON.stringify(source))+512);
    this.store.db.prepare('INSERT INTO source_context_declarations VALUES(?,?,?,?,?)').run(sourceId,value.version,pin.fingerprint,json,value.updatedAt);
    this.store.db.prepare('UPDATE source_connections SET json=? WHERE id=?').run(JSON.stringify(source),sourceId);
    return {snapshot:{...value,fingerprint:pin.fingerprint},changed:true};
  }
  export():PortableSourceContext{
    return {declarations:this.store.db.prepare('SELECT source_id,version FROM source_context_declarations ORDER BY source_id,version').all().map(row=>declarationSchema.parse(this.getAtVersion(String(row.source_id),Number(row.version))!))};
  }
  /** Restore exact history without rewriting a newer local source pointer. */
  restore(raw:PortableSourceContext){
    const value=portableSourceContextSchema.parse(raw),seen=new Set<string>();
    for(const declaration of value.declarations){
      const key=JSON.stringify([declaration.sourceId,declaration.version]);
      if(seen.has(key)||fingerprint(declaration)!==declaration.fingerprint)throw new StoreError('Invalid portable source context declaration');
      seen.add(key);this.source(declaration.sourceId);
      const prior=this.getAtVersion(declaration.sourceId,declaration.version);
      if(prior){if(prior.fingerprint!==declaration.fingerprint||prior.updatedAt!==declaration.updatedAt)throw new StoreError('Portable source context conflicts with an existing declaration',409);continue;}
      const json=encodeMemoryPrivate(this.store,{description:declaration.description});this.store.reserveMetadata(Buffer.byteLength(json)+512);
      this.store.db.prepare('INSERT INTO source_context_declarations VALUES(?,?,?,?,?)').run(declaration.sourceId,declaration.version,declaration.fingerprint,json,declaration.updatedAt);
    }
    for(const row of this.store.db.prepare("SELECT id FROM source_connections WHERE json_type(json,'$.sourceContext')='object'").all())this.identity(String(row.id));
  }
}
