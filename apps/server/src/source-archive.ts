import {z} from 'zod';
import {existsSync,lstatSync,readdirSync,rmSync} from 'node:fs';
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
type VersionRow={version_key:string;content_hash:string;batch_hash:string;batch_index:number;observed_at:string;group_hash:string};
export type ArchiveHead={versionKey:string;observedAt:string};
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema=z.object({versions:z.record(hashSchema,z.object({hash:hashSchema,batch:hashSchema,index:z.number().int().min(0).max(499),observedAt:z.string().datetime({offset:true}),group:z.string().max(4096)}).strict()),heads:z.record(hashSchema,hashSchema),pendingGroups:z.array(z.string().max(4096))}).strict();
const batchFile=/^([a-f0-9]{64})(?:\.plain|\.aes)?$/;

/** Immutable raw batches stay in private files. Their lookup index is transactional
 * SQLite metadata: an interrupted receive leaves only an unreferenced batch file.
 * Existing file manifests are imported once, then never rewritten. */
export class SourceArchive {
  constructor(private store:Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS source_archive_sizes(source_id TEXT PRIMARY KEY,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS source_archive_indexed_sources(source_id TEXT PRIMARY KEY REFERENCES source_archive_sizes(source_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS source_archive_groups(source_id TEXT NOT NULL,group_hash TEXT NOT NULL,group_key TEXT NOT NULL,checkpoint TEXT NOT NULL,
        append_epoch INTEGER NOT NULL DEFAULT 0,head_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(source_id,group_hash),FOREIGN KEY(source_id) REFERENCES source_archive_indexed_sources(source_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS source_archive_versions(source_id TEXT NOT NULL,version_key TEXT NOT NULL,content_hash TEXT NOT NULL,
        batch_hash TEXT NOT NULL,batch_index INTEGER NOT NULL,observed_at TEXT NOT NULL,group_hash TEXT NOT NULL,
        PRIMARY KEY(source_id,version_key),FOREIGN KEY(source_id) REFERENCES source_archive_indexed_sources(source_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS source_archive_heads(id INTEGER PRIMARY KEY,source_id TEXT NOT NULL,external_key TEXT NOT NULL,
        version_key TEXT NOT NULL,group_hash TEXT NOT NULL,observed_at TEXT NOT NULL,content_hash TEXT NOT NULL,
        UNIQUE(source_id,external_key),FOREIGN KEY(source_id) REFERENCES source_archive_indexed_sources(source_id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS source_archive_heads_group ON source_archive_heads(source_id,group_hash,id);
      CREATE TABLE IF NOT EXISTS source_archive_batches(source_id TEXT NOT NULL,batch_hash TEXT NOT NULL,bytes INTEGER NOT NULL,
        PRIMARY KEY(source_id,batch_hash),FOREIGN KEY(source_id) REFERENCES source_archive_indexed_sources(source_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS source_archive_recovery_groups(source_id TEXT NOT NULL,group_hash TEXT NOT NULL,
        PRIMARY KEY(source_id,group_hash),FOREIGN KEY(source_id) REFERENCES source_archive_indexed_sources(source_id) ON DELETE CASCADE);`);
    const groupColumns=new Set((store.db.prepare('PRAGMA table_info(source_archive_groups)').all() as {name:string}[]).map(row=>row.name));
    if(!groupColumns.has('append_epoch'))
      store.db.exec('ALTER TABLE source_archive_groups ADD COLUMN append_epoch INTEGER NOT NULL DEFAULT 0');
    if(!groupColumns.has('head_count')){
      const own=!store.db.isTransaction;if(own)store.db.exec('BEGIN IMMEDIATE');
      try{
        store.db.exec('ALTER TABLE source_archive_groups ADD COLUMN head_count INTEGER NOT NULL DEFAULT 0');
        store.db.exec(`UPDATE source_archive_groups SET head_count=(SELECT count(*) FROM source_archive_heads h
          WHERE h.source_id=source_archive_groups.source_id AND h.group_hash=source_archive_groups.group_hash)`);
        if(own)store.db.exec('COMMIT');
      }catch(error){if(own&&store.db.isTransaction)store.db.exec('ROLLBACK');throw error;}
    }
    privateDirectory(join(store.directory,'source-archive'));
  }
  private directory(sourceId:string){const path=join(this.store.directory,'source-archive',archiveHash(sourceId));privateDirectory(path);return path;}
  private manifestPath(sourceId:string){return join(this.store.directory,'source-archive',archiveHash(sourceId),'manifest');}
  private key(item:Pick<SourceItem,'externalId'|'revision'>){return archiveHash([item.externalId,item.revision]);}
  private emptyCheckpoint(sourceId:string,group:string){return archiveHash([sourceId,group,[]]);}
  private groupHash(group:string){return archiveHash(group);}
  private physicalFiles(directory:string){
    let bytes=0;const batches=new Map<string,number>();
    for(const name of readdirSync(directory)){
      const info=lstatSync(join(directory,name));if(!info.isFile())continue;
      bytes+=info.size;const match=batchFile.exec(name);
      if(match)batches.set(match[1],(batches.get(match[1])??0)+info.size);
    }
    return {bytes,batches};
  }
  private batchBytes(directory:string,batch:string){
    let bytes=0;for(const suffix of ['', '.plain','.aes']){
      const path=join(directory,batch+suffix);if(existsSync(path)){const info=lstatSync(path);if(info.isFile())bytes+=info.size;}
    }return bytes;
  }
  /** Imports a legacy manifest under the same writer lock as receive. A migrated
   * group starts with its old checkpoint, so already queued work stays valid. */
  private ensureIndexed(sourceId:string,create=false){
    const db=this.store.db;
    if(db.prepare('SELECT 1 FROM source_archive_indexed_sources WHERE source_id=?').get(sourceId))return;
    const path=this.manifestPath(sourceId);
    if(!create&&!this.store.contentEncryption.exists(path))return;
    const own=!db.isTransaction;if(own)db.exec('BEGIN IMMEDIATE');
    try{
      if(db.prepare('SELECT 1 FROM source_archive_indexed_sources WHERE source_id=?').get(sourceId)){if(own)db.exec('COMMIT');return;}
      const legacy=this.store.contentEncryption.exists(path)?manifestSchema.parse(JSON.parse(this.store.contentEncryption.read(path).toString())):undefined;
      if(!create&&!legacy){if(own)db.exec('COMMIT');return;}
      const physical=this.physicalFiles(this.directory(sourceId));
      db.prepare('INSERT INTO source_archive_sizes VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET bytes=excluded.bytes').run(sourceId,physical.bytes);
      db.prepare('INSERT INTO source_archive_indexed_sources VALUES(?)').run(sourceId);
      const insertBatch=db.prepare('INSERT INTO source_archive_batches VALUES(?,?,?)');
      for(const [batch,bytes] of physical.batches)insertBatch.run(sourceId,batch,bytes);
      if(legacy){
        const grouped=new Map<string,[string,string][]>();
        for(const entry of Object.values(legacy.versions))if(!grouped.has(entry.group))grouped.set(entry.group,[]);
        for(const versionKey of Object.values(legacy.heads)){
          const entry=legacy.versions[versionKey];if(!entry)throw new StoreError('Archive head has no version',500);
          grouped.get(entry.group)!.push([versionKey,entry.hash]);
        }
        for(const group of legacy.pendingGroups)if(!grouped.has(group))grouped.set(group,[]);
        const insertGroup=db.prepare('INSERT INTO source_archive_groups(source_id,group_hash,group_key,checkpoint,head_count) VALUES(?,?,?,?,?)');
        for(const [group,heads] of grouped)insertGroup.run(sourceId,this.groupHash(group),group,archiveHash([sourceId,group,heads]),heads.length);
        const insertVersion=db.prepare('INSERT INTO source_archive_versions VALUES(?,?,?,?,?,?,?)');
        for(const [versionKey,entry] of Object.entries(legacy.versions))insertVersion.run(sourceId,versionKey,entry.hash,entry.batch,entry.index,entry.observedAt,this.groupHash(entry.group));
        const insertHead=db.prepare('INSERT INTO source_archive_heads(source_id,external_key,version_key,group_hash,observed_at,content_hash) VALUES(?,?,?,?,?,?)');
        for(const [externalKey,versionKey] of Object.entries(legacy.heads)){
          const entry=legacy.versions[versionKey];if(!entry)throw new StoreError('Archive head has no version',500);
          insertHead.run(sourceId,externalKey,versionKey,this.groupHash(entry.group),entry.observedAt,entry.hash);
        }
        const insertRecovery=db.prepare('INSERT OR IGNORE INTO source_archive_recovery_groups VALUES(?,?)');
        for(const group of legacy.pendingGroups)insertRecovery.run(sourceId,this.groupHash(group));
      }
      if(own)db.exec('COMMIT');
    }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  private ensureGroup(sourceId:string,group:string){
    if(!group||group.length>4096)throw new StoreError('Invalid archive group',400);
    const hash=this.groupHash(group),db=this.store.db;
    db.prepare('INSERT OR IGNORE INTO source_archive_groups(source_id,group_hash,group_key,checkpoint) VALUES(?,?,?,?)').run(sourceId,hash,group,this.emptyCheckpoint(sourceId,group));
    const saved=db.prepare('SELECT group_key FROM source_archive_groups WHERE source_id=? AND group_hash=?').get(sourceId,hash) as {group_key:string};
    if(saved.group_key!==group)throw new StoreError('Archive group identity collision',409);
    return hash;
  }
  private indexedCheckpoint(sourceId:string,group:string){
    const row=this.store.db.prepare('SELECT checkpoint FROM source_archive_groups WHERE source_id=? AND group_hash=?').get(sourceId,this.groupHash(group)) as {checkpoint:string}|undefined;
    return row?.checkpoint??this.emptyCheckpoint(sourceId,group);
  }
  private item(sourceId:string,row:VersionRow,cache?:Map<string,SourceItem[]>):SourceItem {
    let items=cache?.get(row.batch_hash);
    if(!items)items=JSON.parse(this.store.contentEncryption.read(join(this.directory(sourceId),row.batch_hash)).toString()) as SourceItem[];
    if(cache){cache.delete(row.batch_hash);cache.set(row.batch_hash,items);
      if(cache.size>8)cache.delete(cache.keys().next().value!);}
    const item=items[row.batch_index];
    if(!item||this.key(item)!==row.version_key)throw new StoreError('Archive version payload does not match index',500);
    const {observedAt:_,...body}=item;
    if(archiveHash(body)!==row.content_hash)throw new StoreError('Archive version checksum mismatch',500);
    return item;
  }
  hasSource(sourceId:string):boolean {return Boolean(this.store.db.prepare('SELECT 1 FROM source_archive_sizes WHERE source_id=?').get(sourceId));}
  /** A version key addresses the first accepted immutable revision, not a moving head. */
  versionInfo(sourceId:string,versionKey:string):{group:string;observedAt:string}|undefined {
    if(!hashSchema.safeParse(versionKey).success)return;
    this.ensureIndexed(sourceId);
    const row=this.store.db.prepare(`SELECT g.group_key,v.observed_at FROM source_archive_versions v
      JOIN source_archive_groups g ON g.source_id=v.source_id AND g.group_hash=v.group_hash WHERE v.source_id=? AND v.version_key=?`).get(sourceId,versionKey) as {group_key:string;observed_at:string}|undefined;
    return row?{group:row.group_key,observedAt:row.observed_at}:undefined;
  }
  readVersion(sourceId:string,versionKey:string,cache?:Map<string,SourceItem[]>):SourceItem|undefined {
    if(!hashSchema.safeParse(versionKey).success)return;
    this.ensureIndexed(sourceId);
    const row=this.store.db.prepare('SELECT * FROM source_archive_versions WHERE source_id=? AND version_key=?').get(sourceId,versionKey) as VersionRow|undefined;
    return row?this.item(sourceId,row,cache):undefined;
  }
  /** Ordered current references are metadata only; this API returns one bounded page. */
  currentHeadsPage(sourceId:string,group:string,offset:number,limit:number,afterId?:number):{heads:ArchiveHead[];total:number;checkpoint:string;appendEpoch:number;lastId:number|null} {
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100||
      afterId!==undefined&&(!Number.isSafeInteger(afterId)||afterId<0))throw new StoreError('Invalid archive head page');
    this.ensureIndexed(sourceId);const db=this.store.db,groupHash=this.groupHash(group),own=!db.isTransaction;
    if(own)db.exec('BEGIN');
    try{
      const state=db.prepare('SELECT checkpoint,append_epoch,head_count FROM source_archive_groups WHERE source_id=? AND group_hash=?').get(sourceId,groupHash) as
        {checkpoint:string;append_epoch:number;head_count:number}|undefined;
      const rows=afterId!==undefined||offset===0?
        db.prepare('SELECT id,version_key,observed_at FROM source_archive_heads WHERE source_id=? AND group_hash=? AND id>? ORDER BY id LIMIT ?')
          .all(sourceId,groupHash,afterId??0,limit) as {id:number;version_key:string;observed_at:string}[]:
        db.prepare('SELECT id,version_key,observed_at FROM source_archive_heads WHERE source_id=? AND group_hash=? ORDER BY id LIMIT ? OFFSET ?')
          .all(sourceId,groupHash,limit,offset) as {id:number;version_key:string;observed_at:string}[];
      if(own)db.exec('COMMIT');return {heads:rows.map(row=>({versionKey:row.version_key,observedAt:row.observed_at})),
        total:state?.head_count??0,checkpoint:state?.checkpoint??this.emptyCheckpoint(sourceId,group),appendEpoch:state?.append_epoch??0,
        lastId:rows.at(-1)?.id??null};
    }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  groupCheckpoint(sourceId:string,group:string):string {this.ensureIndexed(sourceId);return this.indexedCheckpoint(sourceId,group);}
  currentSnapshot(sourceId:string,group:string):{items:SourceItem[];checkpoint:string} {
    this.ensureIndexed(sourceId);const db=this.store.db,own=!db.isTransaction;
    if(own)db.exec('BEGIN');
    let rows:VersionRow[],checkpoint:string;
    try{
      rows=db.prepare(`SELECT v.version_key,v.content_hash,v.batch_hash,v.batch_index,v.observed_at,v.group_hash FROM source_archive_heads h
        JOIN source_archive_versions v ON v.source_id=h.source_id AND v.version_key=h.version_key
        WHERE h.source_id=? AND h.group_hash=? ORDER BY h.id`).all(sourceId,this.groupHash(group)) as VersionRow[];
      checkpoint=this.indexedCheckpoint(sourceId,group);if(own)db.exec('COMMIT');
    }catch(error){if(own&&db.isTransaction)db.exec('ROLLBACK');throw error;}
    const cache=new Map<string,SourceItem[]>();
    return {items:rows.map(row=>this.item(sourceId,row,cache)),checkpoint};
  }
  receive(sourceId:string,items:SourceItem[],groups:string[]){
    const db=this.store.db;if(!db.isTransaction)throw Error('Archive receive requires host transaction');
    if(items.length!==groups.length)throw new StoreError('Archive groups do not match items',400);
    this.ensureIndexed(sourceId,true);
    const touched=new Set<string>();
    for(const row of db.prepare(`SELECT g.group_key FROM source_archive_recovery_groups r JOIN source_archive_groups g
      ON g.source_id=r.source_id AND g.group_hash=r.group_hash WHERE r.source_id=?`).all(sourceId) as {group_key:string}[])touched.add(row.group_key);
    const knownGroups=new Map<string,string>(),groupNames=new Map<string,string>();
    const versionLookup=db.prepare('SELECT content_hash FROM source_archive_versions WHERE source_id=? AND version_key=?');
    const versions=items.map((item,index)=>{
      const group=groups[index],groupHash=knownGroups.get(group)??this.ensureGroup(sourceId,group),versionKey=this.key(item),{observedAt:_,...body}=item,contentHash=archiveHash(body);
      knownGroups.set(group,groupHash);groupNames.set(groupHash,group);
      const existing=versionLookup.get(sourceId,versionKey) as {content_hash:string}|undefined;
      if(existing&&existing.content_hash!==contentHash)throw new StoreError('Revision already has different content',409);
      touched.add(group);
      return {item,index,group,groupHash,versionKey,contentHash,duplicate:Boolean(existing)};
    });
    const bytes=Buffer.from(JSON.stringify(items)),hasNew=versions.some(version=>!version.duplicate);
    this.store.reserveMetadata(hasNew?bytes.length+items.length*512:0);
    const directory=this.directory(sourceId),batch=archiveHash(items);
    if(hasNew){
      this.store.contentEncryption.write(join(directory,batch),bytes);
      const size=this.batchBytes(directory,batch);
      const previous=db.prepare('SELECT bytes FROM source_archive_batches WHERE source_id=? AND batch_hash=?').get(sourceId,batch) as {bytes:number}|undefined;
      db.prepare('INSERT INTO source_archive_batches VALUES(?,?,?) ON CONFLICT(source_id,batch_hash) DO UPDATE SET bytes=excluded.bytes').run(sourceId,batch,size);
      db.prepare('UPDATE source_archive_sizes SET bytes=bytes+? WHERE source_id=?').run(size-(previous?.bytes??0),sourceId);
    }
    const changes=new Map<string,string[][]>(),rewritten=new Set<string>(),countDeltas=new Map<string,number>();
    const changed=(group:string,event:string[])=>{const list=changes.get(group)??[];list.push(event);changes.set(group,list);};
    const changeCount=(group:string,delta:number)=>countDeltas.set(group,(countDeltas.get(group)??0)+delta);
    const insertVersion=db.prepare('INSERT INTO source_archive_versions VALUES(?,?,?,?,?,?,?)');
    const head=db.prepare('SELECT version_key,group_hash,observed_at FROM source_archive_heads WHERE source_id=? AND external_key=?');
    const groupName=db.prepare('SELECT group_key FROM source_archive_groups WHERE source_id=? AND group_hash=?');
    const nameOf=(hash:string)=>{let name=groupNames.get(hash);if(!name){name=(groupName.get(sourceId,hash) as {group_key:string}|undefined)?.group_key;if(!name)throw new StoreError('Archive head has no group',500);groupNames.set(hash,name);}return name;};
    const writeHead=db.prepare(`INSERT INTO source_archive_heads(source_id,external_key,version_key,group_hash,observed_at,content_hash) VALUES(?,?,?,?,?,?)
      ON CONFLICT(source_id,external_key) DO UPDATE SET version_key=excluded.version_key,group_hash=excluded.group_hash,
        observed_at=excluded.observed_at,content_hash=excluded.content_hash`);
    for(const version of versions){
      const {item,index,group,groupHash,versionKey,contentHash,duplicate}=version;
      const externalKey=archiveHash(item.externalId);
      const prior=head.get(sourceId,externalKey) as {version_key:string;group_hash:string;observed_at:string}|undefined;
      if(prior)touched.add(nameOf(prior.group_hash));
      if(duplicate)continue;
      insertVersion.run(sourceId,versionKey,contentHash,batch,index,item.observedAt,groupHash);
      if(prior&&Date.parse(item.observedAt)<Date.parse(prior.observed_at))continue;
      if(prior){rewritten.add(nameOf(prior.group_hash));if(prior.group_hash!==groupHash){
        rewritten.add(group);changed(nameOf(prior.group_hash),['remove',externalKey,prior.version_key]);
        changeCount(nameOf(prior.group_hash),-1);changeCount(group,1);
      }}else{changeCount(group,1);if(item.deleted)rewritten.add(group);}
      changed(group,['upsert',externalKey,versionKey,contentHash]);
      writeHead.run(sourceId,externalKey,versionKey,groupHash,item.observedAt,contentHash);
    }
    const updateGroup=db.prepare('UPDATE source_archive_groups SET checkpoint=?,append_epoch=append_epoch+?,head_count=head_count+? WHERE source_id=? AND group_hash=?');
    for(const [group,events] of changes){
      const prior=this.indexedCheckpoint(sourceId,group);
      updateGroup.run(archiveHash([prior,events]),Number(rewritten.has(group)),countDeltas.get(group)??0,sourceId,this.groupHash(group));
    }
    db.prepare('DELETE FROM source_archive_recovery_groups WHERE source_id=?').run(sourceId);
    const groupCheckpoints=Object.fromEntries([...touched].map(group=>[group,this.indexedCheckpoint(sourceId,group)]));
    return {checkpoint:archiveHash([sourceId,batch,groupCheckpoints]),groups:[...touched],groupCheckpoints,
      receipts:versions.map(({item,duplicate})=>({id:sourceReceiptId(sourceId,item),sourceId,externalId:item.externalId,revision:item.revision,duplicate}))};
  }
  /** The index and receipt are committed together. No file journal ACK is needed. */
  forget(sourceId:string){rmSync(this.directory(sourceId),{recursive:true});this.store.db.prepare('DELETE FROM source_archive_sizes WHERE source_id=?').run(sourceId);}
  current(sourceId:string,group:string):SourceItem[]{return this.currentSnapshot(sourceId,group).items;}
}
