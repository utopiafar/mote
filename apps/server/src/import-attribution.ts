import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {AttributionContext} from '@mote/shared';
import {StoreError,type Store} from './store.js';
import {encodeMemoryPrivate,decodeMemoryPrivate} from './memory-private-storage.js';

const declarationSchema=z.object({id:z.string().uuid(),version:z.number().int().positive(),sourceId:z.string().min(1).max(128),instruction:z.string().max(12000)}).strict();
type Declaration=z.infer<typeof declarationSchema>;
export type ImportDeclaration=NonNullable<AttributionContext['importDeclarations']>[number];
const fingerprint=(value:Declaration)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const portableImportAttributionSchema=z.object({
  declarations:z.array(declarationSchema.extend({fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict()),
  captures:z.array(z.object({captureId:z.string().uuid(),id:z.string().uuid(),version:z.number().int().positive()}).strict()),
}).strict();
export type PortableImportAttribution=z.infer<typeof portableImportAttributionSchema>;

/** Host-only metadata. Neither source manifests nor operation progress links
 * can create a declaration. Text outlives deleted import history while its
 * original capture remains archived. */
export class ImportAttributionStore {
  constructor(private readonly store:Store){
    store.db.exec(`CREATE TABLE IF NOT EXISTS import_owner_declarations(
      id TEXT NOT NULL,version INTEGER NOT NULL,source_id TEXT NOT NULL,fingerprint TEXT NOT NULL,json TEXT NOT NULL,
      PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS capture_import_declarations(
      capture_id TEXT PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,id TEXT NOT NULL,version INTEGER NOT NULL,
      FOREIGN KEY(id,version) REFERENCES import_owner_declarations(id,version));
      CREATE INDEX IF NOT EXISTS capture_import_declarations_parent ON capture_import_declarations(id,version);
      CREATE TRIGGER IF NOT EXISTS capture_import_declaration_removed AFTER DELETE ON capture_import_declarations BEGIN
        DELETE FROM import_owner_declarations WHERE id=old.id AND version=old.version AND NOT EXISTS
          (SELECT 1 FROM capture_import_declarations c WHERE c.id=old.id AND c.version=old.version);
      END;`);
    if(store.contentEncryption.enabled){
      const own=!store.db.isTransaction;if(own)store.db.exec('BEGIN IMMEDIATE');
      try{
        for(const row of store.db.prepare("SELECT id,version,json FROM import_owner_declarations WHERE json LIKE 'json:%'").all()){
          const json=encodeMemoryPrivate(store,decodeMemoryPrivate(store,String(row.json)));
          store.reserveMetadata(Math.max(0,Buffer.byteLength(json)-Buffer.byteLength(String(row.json))));
          store.db.prepare('UPDATE import_owner_declarations SET json=? WHERE id=? AND version=?').run(json,row.id,row.version);
        }
        if(own)store.db.exec('COMMIT');
      }catch(error){if(own&&store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
    }
  }
  /** Called after validating the frozen manifest and before the first receipt. */
  freeze(input:Declaration):Omit<ImportDeclaration,'captureIds'>|undefined {
    const value=declarationSchema.parse(input);if(!value.instruction.trim())return undefined;
    const pin={id:value.id,version:value.version,fingerprint:fingerprint(value)};
    const prior=this.store.db.prepare('SELECT fingerprint FROM import_owner_declarations WHERE id=? AND version=?').get(pin.id,pin.version);
    if(prior){if(prior.fingerprint!==pin.fingerprint)throw new StoreError('Frozen import declaration changed',409);return pin;}
    const json=encodeMemoryPrivate(this.store,{instruction:value.instruction});
    this.store.reserveMetadata(Buffer.byteLength(json)+512);
    this.store.db.prepare('INSERT INTO import_owner_declarations VALUES(?,?,?,?,?)').run(pin.id,pin.version,value.sourceId,pin.fingerprint,json);
    return pin;
  }
  /** Only the new-capture commit calls this; duplicate imports cannot replace
   * an earlier capture's context or create another Memory grant. */
  bind(captureId:string,pin:Omit<ImportDeclaration,'captureIds'>|undefined){
    if(!pin)return;
    const declaration=this.store.db.prepare('SELECT source_id,fingerprint FROM import_owner_declarations WHERE id=? AND version=?').get(pin.id,pin.version);
    const capture=this.store.evidence([captureId])[0];
    if(!declaration||declaration.fingerprint!==pin.fingerprint||capture?.provenance?.sourceId!==declaration.source_id)throw new StoreError('Import declaration capture scope changed',409);
    const prior=this.store.db.prepare('SELECT id,version FROM capture_import_declarations WHERE capture_id=?').get(captureId);
    if(prior){if(prior.id!==pin.id||prior.version!==pin.version)throw new StoreError('Original capture already has an import declaration',409);return;}
    this.store.reserveMetadata(256);
    this.store.db.prepare('INSERT INTO capture_import_declarations VALUES(?,?,?)').run(captureId,pin.id,pin.version);
  }
  /** File excerpts/chunks retain the declaration of their exact original. */
  identities(captureIds:string[]):ImportDeclaration[]{
    if(!captureIds.length)return [];
    const rows=this.store.db.prepare(`WITH RECURSIVE declaration_originals(id) AS (
      SELECT value FROM json_each(?) UNION SELECT l.parent_id FROM file_evidence_links l JOIN declaration_originals o ON l.capture_id=o.id)
      SELECT DISTINCT c.capture_id,d.id,d.version,d.fingerprint FROM declaration_originals o
      JOIN capture_import_declarations c ON c.capture_id=o.id
      JOIN import_owner_declarations d ON d.id=c.id AND d.version=c.version
      ORDER BY d.id,d.version,c.capture_id`).all(JSON.stringify(captureIds));
    const values=new Map<string,ImportDeclaration>();
    for(const row of rows){const key=JSON.stringify([row.id,row.version]);let value=values.get(key);if(!value){value={id:String(row.id),version:Number(row.version),fingerprint:String(row.fingerprint),captureIds:[]};values.set(key,value);}value.captureIds.push(String(row.capture_id));}
    return [...values.values()];
  }
  open(values:ImportDeclaration[]):NonNullable<AttributionContext['importStatements']>{
    return values.flatMap(value=>{
      const row=this.store.db.prepare('SELECT * FROM import_owner_declarations WHERE id=? AND version=?').get(value.id,value.version);
      if(!row||row.fingerprint!==value.fingerprint)return [];
      const captureIds=value.captureIds.filter(captureId=>Boolean(this.store.db.prepare('SELECT 1 FROM capture_import_declarations WHERE capture_id=? AND id=? AND version=?').get(captureId,value.id,value.version)));
      if(!captureIds.length)return [];
      const {instruction}=this.original(row);
      return [{id:value.id,version:value.version,instruction,captureIds}];
    });
  }
  private original(row:Record<string,unknown>):Declaration {
    const {instruction}=decodeMemoryPrivate<{instruction:string}>(this.store,String(row.json));
    const value=declarationSchema.parse({id:String(row.id),version:Number(row.version),sourceId:String(row.source_id),instruction});
    if(fingerprint(value)!==row.fingerprint)throw new StoreError('Stored import declaration changed',409);
    return value;
  }
  export():PortableImportAttribution {
    const captures=this.store.db.prepare('SELECT capture_id captureId,id,version FROM capture_import_declarations ORDER BY capture_id').all() as PortableImportAttribution['captures'];
    const declarations=this.store.db.prepare(`SELECT d.* FROM import_owner_declarations d WHERE EXISTS
      (SELECT 1 FROM capture_import_declarations c WHERE c.id=d.id AND c.version=d.version) ORDER BY d.id,d.version`).all().map(row=>({...this.original(row),fingerprint:String(row.fingerprint)}));
    return {declarations,captures};
  }
  pruneUnbound(id:string){this.store.db.prepare(`DELETE FROM import_owner_declarations WHERE id=? AND NOT EXISTS
    (SELECT 1 FROM capture_import_declarations c WHERE c.id=import_owner_declarations.id AND c.version=import_owner_declarations.version)`).run(id);}
  restore(raw:PortableImportAttribution){
    const value=portableImportAttributionSchema.parse(raw),pins=new Map<string,Omit<ImportDeclaration,'captureIds'>>();
    const referenced=new Set(value.captures.map(capture=>JSON.stringify([capture.id,capture.version])));
    if(value.declarations.some(declaration=>!referenced.has(JSON.stringify([declaration.id,declaration.version]))))
      throw new StoreError('Portable import declaration is missing its original capture scope');
    const captures=new Set<string>();
    for(const declaration of value.declarations){const {fingerprint:expected,...input}=declaration,key=JSON.stringify([input.id,input.version]);if(pins.has(key)||fingerprint(input)!==expected)throw new StoreError('Invalid portable import declaration');const pin=this.freeze(input);if(!pin)throw new StoreError('Empty portable import declaration');pins.set(key,pin);}
    for(const capture of value.captures){const pin=pins.get(JSON.stringify([capture.id,capture.version]));if(captures.has(capture.captureId)||!pin)throw new StoreError('Invalid portable import declaration scope');captures.add(capture.captureId);this.bind(capture.captureId,pin);}
  }
}
