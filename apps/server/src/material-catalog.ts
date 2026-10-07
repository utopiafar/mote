import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {LibraryTypeDescriptor,LibrarySourceFacet} from '@mote/shared';
import type {Context} from '@deepseek-ai/cordis';
import {z} from 'zod';
import type {MaterialStore} from './materials.js';
import {StoreError} from './store.js';

const anchor=z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:/-]+$/).refine(value=>!value.includes('://')&&!value.startsWith('/'),'Presentation anchors cannot be URLs or paths');
const descriptor=z.object({id:anchor,kind:anchor,schemaVersion:z.number().int().positive(),label:z.string().min(1).max(120),card:anchor.optional(),detail:anchor.optional(),panels:z.array(anchor).max(16).optional(),actions:z.array(anchor).max(16).optional()}).strict();
/** Owned by materials. A missing renderer never removes stored history. */
export class MaterialCatalogRegistry {
  private entries=new Map<string,LibraryTypeDescriptor>();
  revision=0;
  register(raw:LibraryTypeDescriptor){
    const value=descriptor.parse(raw);
    if(this.entries.size>=256||[...this.entries.values()].some(v=>v.id===value.id||v.kind===value.kind&&v.schemaVersion===value.schemaVersion))throw Error('Duplicate material catalog type');
    this.entries.set(value.id,value);this.revision++;
    return ()=>{if(this.entries.get(value.id)===value){this.entries.delete(value.id);this.revision++;}};
  }
  describe(){return {schemaVersion:1 as const,revision:this.revision,types:[...this.entries.values()].map(v=>structuredClone(v))};}
}
declare module '@deepseek-ai/cordis' {interface Context {moteMaterialCatalog:MaterialCatalogRegistry;}}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type CatalogQuery={sourceId?:string;kind?:string;deviceId?:string;after?:string;before?:string;query?:string;limit?:number;cursor?:string};
/** Rebuildable owner projection over the existing Material authority, never another content store. */
export class MaterialCatalog {
  readonly registry=new MaterialCatalogRegistry();
  private secret=randomBytes(32);
  constructor(private materials:MaterialStore){}
  private initialized=false;
  private generation(){
    const db=this.materials.store.db;
    if(!this.initialized){
      db.exec(`CREATE TABLE IF NOT EXISTS material_catalog_generation(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
        INSERT OR IGNORE INTO material_catalog_generation VALUES(1,0);
        CREATE INDEX IF NOT EXISTS material_catalog_order ON material_heads(retired,COALESCE(last_at,first_at,updated_at) DESC,id DESC);
        CREATE TRIGGER IF NOT EXISTS material_catalog_insert AFTER INSERT ON material_heads BEGIN UPDATE material_catalog_generation SET version=version+1; END;
        CREATE TRIGGER IF NOT EXISTS material_catalog_update AFTER UPDATE ON material_heads BEGIN UPDATE material_catalog_generation SET version=version+1; END;
        CREATE TRIGGER IF NOT EXISTS material_catalog_delete AFTER DELETE ON material_heads BEGIN UPDATE material_catalog_generation SET version=version+1; END;`);
      this.initialized=true;
    }
    return String(db.prepare('SELECT version FROM material_catalog_generation WHERE id=1').get()!.version);
  }
  private seal(value:unknown){const payload=Buffer.from(JSON.stringify(value)).toString('base64url');return payload+'.'+createHmac('sha256',this.secret).update(payload).digest('base64url');}
  private open(cursor:string):{scope:string;generation:string;inner:string}{
    try{const [payload,signature,...extra]=cursor.split('.');if(extra.length||!payload||!signature)throw Error();
      const expected=createHmac('sha256',this.secret).update(payload).digest(),actual=Buffer.from(signature,'base64url');
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();
      return z.object({scope:z.string(),generation:z.string(),inner:z.string()}).strict().parse(JSON.parse(Buffer.from(payload,'base64url').toString()));
    }catch{throw new StoreError('Invalid library cursor',400);}
  }
  list(args:CatalogQuery,ownerIdentity:string){
    const {cursor,...filter}=args,generation=this.generation();
    const scope=hash([ownerIdentity,{sourceId:filter.sourceId??null,kind:filter.kind??null,deviceId:filter.deviceId??null,after:filter.after??null,before:filter.before??null,query:filter.query??null,limit:filter.limit??24},this.registry.revision]);
    const position=cursor?this.open(cursor):undefined;
    if(position&&(position.scope!==scope||position.generation!==generation))throw new StoreError('Library cursor changed; restart browsing',409);
    const page=this.materials.list({...filter,limit:filter.limit??24,cursor:position?.inner,order:'source'});
    // Metadata-only facets are bounded. Archived plugin labels fall back to stable source IDs.
    const sources=this.materials.store.db.prepare(`SELECT h.source_id id,COUNT(*) count,json_extract(s.json,'$.name') label FROM material_heads h LEFT JOIN source_connections s ON s.id=h.source_id WHERE h.retired=0 AND h.sequence>=h.min_visible_sequence GROUP BY h.source_id ORDER BY h.source_id LIMIT 201`).all();
    const facets:LibrarySourceFacet[]=sources.slice(0,200).map(s=>({id:String(s.id),label:String(s.label??s.id).slice(0,120),count:Number(s.count)}));
    return {...this.registry.describe(),items:page.items,sources:facets,sourcesTruncated:sources.length>200,nextCursor:page.nextCursor?this.seal({scope,generation,inner:page.nextCursor}):null};
  }
}
