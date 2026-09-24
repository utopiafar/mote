import {z} from 'zod';
import {readdirSync,statSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {privateDirectory} from './private-storage.js';
import type {SourceItem} from '@mote/shared';
import {StoreError,type Store} from './store.js';

export const archiveHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sourceReceiptId=(sourceId:string,item:Pick<SourceItem,'externalId'|'revision'>)=>{
  const h=archiveHash([sourceId,item.externalId,item.revision]);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
};
type Entry={hash:string;batch:string;index:number;observedAt:string;group:string};
type Manifest={versions:Record<string,Entry>;heads:Record<string,string>;pendingGroups:string[]};
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema=z.object({versions:z.record(hashSchema,z.object({hash:hashSchema,batch:hashSchema,index:z.number().int().min(0).max(499),observedAt:z.string().datetime({offset:true}),group:z.string().max(4096)}).strict()),heads:z.record(hashSchema,hashSchema),pendingGroups:z.array(z.string().max(4096))}).strict();
/** Raw transport records and their lookup manifest live only in private files.
 * The caller holds the SQLite writer lock across manifest update and receipt commit.
 * Durable files precede ACK; orphan batches are harmless after interrupted commits. */
export class SourceArchive {
  constructor(private store:Store) {store.db.exec('CREATE TABLE IF NOT EXISTS source_archive_sizes(source_id TEXT PRIMARY KEY,bytes INTEGER NOT NULL)');privateDirectory(join(store.directory,'source-archive'));}
  private directory(sourceId:string){const path=join(this.store.directory,'source-archive',archiveHash(sourceId));privateDirectory(path);return path;}
  private manifest(sourceId:string):Manifest {const path=join(this.directory(sourceId),'manifest');return this.store.contentEncryption.exists(path)?manifestSchema.parse(JSON.parse(this.store.contentEncryption.read(path).toString())):{versions:{},heads:{},pendingGroups:[]};}
  private key(item:Pick<SourceItem,'externalId'|'revision'>){return archiveHash([item.externalId,item.revision]);}
  receive(sourceId:string,items:SourceItem[],groups:string[]){
    if(!this.store.db.isTransaction)throw Error('Archive receive requires host transaction');
    const manifest=this.manifest(sourceId),directory=this.directory(sourceId),batch=archiveHash(items);
    const touched=new Set([...manifest.pendingGroups,...groups]);for(const item of items){const prior=manifest.heads[archiveHash(item.externalId)];if(prior)touched.add(manifest.versions[prior].group);}
    const duplicates=items.map(item=>{
      const {observedAt:_,...body}=item,entry=manifest.versions[this.key(item)];
      if(entry&&entry.hash!==archiveHash(body))throw new StoreError('Revision already has different content',409);
      return Boolean(entry);
    });
    const bytes=Buffer.from(JSON.stringify(items));
    // Include the manifest growth as well as new bytes in quota admission.
    this.store.reserveMetadata(duplicates.every(Boolean)?0:bytes.length+items.length*512);
    if(duplicates.some(value=>!value))this.store.contentEncryption.write(join(directory,batch),bytes);
    for(const [index,item] of items.entries()){
      if(duplicates[index])continue;
      const key=this.key(item),{observedAt:_,...body}=item;
      if(!manifest.versions[key])manifest.versions[key]={hash:archiveHash(body),batch,index,observedAt:item.observedAt,group:groups[index]};
      const external=archiveHash(item.externalId),prior=manifest.heads[external];
      if(!prior||Date.parse(item.observedAt)>=Date.parse(manifest.versions[prior].observedAt))manifest.heads[external]=key;
    }
    manifest.pendingGroups=[...touched];
    this.store.contentEncryption.write(join(directory,'manifest'),Buffer.from(JSON.stringify(manifest)));
    const size=readdirSync(directory).reduce((n,name)=>n+statSync(join(directory,name)).size,0);
    this.store.db.prepare('INSERT INTO source_archive_sizes VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET bytes=excluded.bytes').run(sourceId,size);
    return {checkpoint:archiveHash(manifest),groups:[...touched],receipts:items.map((item,index)=>({id:sourceReceiptId(sourceId,item),sourceId,externalId:item.externalId,revision:item.revision,duplicate:duplicates[index]}))};
  }
  /** Clear the file journal only after SQL work is committed. A separate writer
   * lock and checkpoint comparison prevent clearing another receiver's work. */
  acknowledge(sourceId:string,checkpoint:string){
    const db=this.store.db;
    try{db.exec('BEGIN IMMEDIATE');const manifest=this.manifest(sourceId);if(archiveHash(manifest)===checkpoint){manifest.pendingGroups=[];this.store.contentEncryption.write(join(this.directory(sourceId),'manifest'),Buffer.from(JSON.stringify(manifest)));}db.exec('COMMIT');}
    catch{if(db.isTransaction)db.exec('ROLLBACK');/* Retaining the journal only repeats idempotent organization. */}
  }
  forget(sourceId:string){rmSync(this.directory(sourceId),{recursive:true});this.store.db.prepare('DELETE FROM source_archive_sizes WHERE source_id=?').run(sourceId);}
  current(sourceId:string,group:string):SourceItem[]{
    const manifest=this.manifest(sourceId),cache=new Map<string,SourceItem[]>();
    return Object.values(manifest.heads).flatMap(key=>{
      const entry=manifest.versions[key];if(entry.group!==group)return [];
      let items=cache.get(entry.batch);if(!items){items=JSON.parse(this.store.contentEncryption.read(join(this.directory(sourceId),entry.batch)).toString()) as SourceItem[];cache.set(entry.batch,items);}
      return [items[entry.index]];
    });
  }
}
