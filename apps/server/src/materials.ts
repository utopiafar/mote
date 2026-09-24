import type {CaptureRecord} from '@mote/shared';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {StoreError,type Store} from './store.js';

const MATERIAL_PREFIX='mat_';
const materialIdSchema=z.string().regex(/^mat_[a-f0-9]{64}$/);
const revisionSchema=z.string().regex(/^[a-f0-9]{64}$/);
const nameSchema=z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._/-]*$/);
const locatorSchema=z.record(z.unknown()).refine(value=>{
  try{return Buffer.byteLength(JSON.stringify(value))<=4096;}catch{return false;}
},'Locator is too large or not serializable');
const memberSchema=z.object({
  id:z.string().min(1).max(128),kind:nameSchema,ref:z.string().min(1).max(2048),
  revision:z.string().min(1).max(256).optional(),locator:locatorSchema.optional(),
}).strict();
const blockBase={id:z.string().min(1).max(128),memberIds:z.array(z.string().min(1).max(128)).max(32).default([]),locator:locatorSchema.optional()};
const blockSchema=z.discriminatedUnion('kind',[
  z.object({...blockBase,kind:z.literal('text'),format:nameSchema,text:z.string().max(250_000)}).strict(),
  z.object({...blockBase,kind:z.literal('asset'),hash:revisionSchema,mimeType:z.string().min(1).max(200)}).strict(),
]);
const draftSchema=z.object({
  id:materialIdSchema,kind:nameSchema,schemaVersion:z.number().int().min(1).max(1_000_000),
  title:z.string().min(1).max(500),
  origin:z.object({sourceId:z.string().min(1).max(128),externalId:z.string().min(1).max(2048),
    deviceId:z.string().min(1).max(128).optional(),firstAt:z.string().datetime({offset:true}).optional(),
    lastAt:z.string().datetime({offset:true}).optional(),provider:z.string().min(1).max(128).optional(),
    projectKey:z.string().min(1).max(512).optional(),sessionId:z.string().min(1).max(512).optional()}).strict(),
  blocks:z.array(blockSchema),members:z.array(memberSchema),
  coverage:z.object({state:z.enum(['complete','partial','pending']),reason:z.string().max(500).optional()}).strict(),
  /** Named processing outputs let each consumer declare only the dependencies
   * it actually needs. A query may use a partial material while Memory waits. */
  artifacts:z.array(z.object({key:nameSchema,state:z.enum(['ready','pending','failed','unavailable']),revision:z.string().min(1).max(256).optional(),reason:z.string().max(500).optional()}).strict()).max(64).optional(),
  fidelity:z.object({state:z.enum(['lossless','derived','summary-only']),limitations:z.array(z.string().max(500)).max(20).optional()}).strict(),
  retention:z.object({original:z.enum(['retained','unavailable']),policy:z.enum(['keep','allow-expiry'])}).strict(),
}).strict();

export type MaterialDraft=z.infer<typeof draftSchema>;
const appendDraftSchema=draftSchema.omit({blocks:true}).extend({mode:z.literal('append'),baseRevision:revisionSchema,
  reuseBlocks:z.number().int().nonnegative(),blocks:z.array(blockSchema)}).strict();
export type MaterialAppendDraft=z.infer<typeof appendDraftSchema>;
export type CodingAppendBase={record:MaterialRecord;archiveCheckpoint:string;appendEpoch:number;headCount:number;
  lastBlock:{id:string;text:string;format:string|null}|null};
export type CodingArchiveSnapshot={checkpoint:string;appendEpoch:number;headCount:number};
export type MaterialMember=MaterialDraft['members'][number];
export type MaterialBlock=MaterialDraft['blocks'][number];
export type MaterialRecord=Omit<MaterialDraft,'blocks'|'members'> & {
  ref:string;revision:string;sequence:number;createdAt:string;updatedAt:string;
  blockCount:number;memberCount:number;textLength:number;assetCount:number;
};
export type MaterialReadSpan={blockId:string;kind:'text'|'asset';format?:string;
  pageRange:{start:number;end:number};materialRange:{start:number;end:number};
  memberIds:string[];locator?:Record<string,unknown>;asset?:{hash:string;mimeType:string};};
export type MaterialReadPage={material:MaterialRecord;text:string;textRange:{offset:number;total:number;nextOffset:number|null};spans:MaterialReadSpan[]};
export type MaterialPage={items:MaterialRecord[];nextCursor:string|null};
export type MaterialMemberPage={items:MaterialMember[];nextOffset:number|null;total:number};

type HeadRow={id:string;source_id:string;external_id:string;kind:string;revision:string;sequence:number;retired:number;min_visible_sequence:number;created_at:string;updated_at:string};
type RevisionRow={manifest:string;revision:string;sequence:number;version_created_at:string;text_length:number;block_count:number;member_count:number;asset_count:number};
type BlockRow={block_id:string;kind:'text'|'asset';format:string|null;payload:string;asset_hash:string|null;mime_type:string|null;member_ids:string;locator:string|null;start_offset:number;end_offset:number};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const parseId=(id:string)=>materialIdSchema.parse(id);
const parseRevision=(revision:string)=>revisionSchema.parse(revision);
const currentRef=(value:string)=>value.startsWith('material:')?value.slice('material:'.length):value;

/** Stable identity belongs to the upstream logical item, not to a transport batch. */
export function materialId(sourceId:string,externalId:string):string {
  if(!sourceId||!externalId)throw new StoreError('Material source identity is required');
  return MATERIAL_PREFIX+hash(JSON.stringify([sourceId,externalId]));
}
export function formatMaterialRef(id:string,revision:string):string{return `material:${parseId(id)}@${parseRevision(revision)}`;}
export function parseMaterialRef(value:string):{id:string;revision?:string} {
  const raw=currentRef(value),at=raw.indexOf('@');
  if(at<0)return {id:parseId(raw)};
  return {id:parseId(raw.slice(0,at)),revision:parseRevision(raw.slice(at+1))};
}

/** Immutable formal material revisions. All content is evidence, never agent instructions. */
export class MaterialStore {
  constructor(readonly store:Store){
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS material_searchable(material_id TEXT PRIMARY KEY REFERENCES material_heads(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS material_evidence(id TEXT PRIMARY KEY,material_id TEXT NOT NULL,revision TEXT NOT NULL,block_id TEXT NOT NULL,FOREIGN KEY(material_id,revision) REFERENCES material_revisions(material_id,revision) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS material_evidence_parent ON material_evidence(material_id,revision);
      CREATE VIRTUAL TABLE IF NOT EXISTS material_fts USING fts5(material_id UNINDEXED,text,content='',tokenize='trigram',contentless_delete=1);
      CREATE VIRTUAL TABLE IF NOT EXISTS material_fts_blocks USING fts5(text,content='',tokenize='trigram',contentless_delete=1);
      CREATE TABLE IF NOT EXISTS material_heads(
        id TEXT PRIMARY KEY,source_id TEXT NOT NULL,external_id TEXT NOT NULL,kind TEXT NOT NULL,
        revision TEXT NOT NULL,sequence INTEGER NOT NULL,retired INTEGER NOT NULL DEFAULT 0,
        device_id TEXT,first_at TEXT,last_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS material_search_delete BEFORE DELETE ON material_heads BEGIN DELETE FROM material_fts WHERE rowid=old.rowid; END;
      CREATE INDEX IF NOT EXISTS material_heads_source ON material_heads(source_id,updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS material_heads_recent ON material_heads(retired,updated_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS material_revisions(
        material_id TEXT NOT NULL REFERENCES material_heads(id) ON DELETE CASCADE,revision TEXT NOT NULL,
        sequence INTEGER NOT NULL,manifest TEXT NOT NULL,created_at TEXT NOT NULL,
        text_length INTEGER NOT NULL,block_count INTEGER NOT NULL,member_count INTEGER NOT NULL,asset_count INTEGER NOT NULL,
        PRIMARY KEY(material_id,revision),UNIQUE(material_id,sequence));
      CREATE TABLE IF NOT EXISTS material_coding_snapshots(material_id TEXT NOT NULL,revision TEXT NOT NULL,
        archive_checkpoint TEXT,append_epoch INTEGER,head_count INTEGER,
        PRIMARY KEY(material_id,revision),FOREIGN KEY(material_id,revision) REFERENCES material_revisions(material_id,revision) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS material_block_payloads(hash TEXT PRIMARY KEY,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material_block_versions(
        id INTEGER PRIMARY KEY,material_id TEXT NOT NULL REFERENCES material_heads(id) ON DELETE CASCADE,
        from_revision TEXT NOT NULL,from_sequence INTEGER NOT NULL,until_sequence INTEGER,
        idx INTEGER NOT NULL,block_id TEXT NOT NULL,kind TEXT NOT NULL,format TEXT,
        payload_hash TEXT NOT NULL REFERENCES material_block_payloads(hash),asset_hash TEXT,mime_type TEXT,
        member_ids TEXT NOT NULL,locator TEXT,start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,anchor_id TEXT,
        UNIQUE(material_id,from_revision,idx));
      CREATE INDEX IF NOT EXISTS material_block_versions_range ON material_block_versions(material_id,start_offset,from_sequence,until_sequence);
      CREATE INDEX IF NOT EXISTS material_block_versions_index ON material_block_versions(material_id,idx,from_sequence,until_sequence);
      CREATE TABLE IF NOT EXISTS material_blocks(
        material_id TEXT NOT NULL,revision TEXT NOT NULL,idx INTEGER NOT NULL,block_id TEXT NOT NULL,
        kind TEXT NOT NULL,format TEXT,payload_hash TEXT NOT NULL REFERENCES material_block_payloads(hash),
        asset_hash TEXT,mime_type TEXT,member_ids TEXT NOT NULL,locator TEXT,
        start_offset INTEGER NOT NULL,end_offset INTEGER NOT NULL,
        PRIMARY KEY(material_id,revision,idx),UNIQUE(material_id,revision,block_id),
        FOREIGN KEY(material_id,revision) REFERENCES material_revisions(material_id,revision) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS material_blocks_range ON material_blocks(material_id,revision,end_offset);
      CREATE TABLE IF NOT EXISTS material_members(
        material_id TEXT NOT NULL,revision TEXT NOT NULL,idx INTEGER NOT NULL,id TEXT NOT NULL,
        kind TEXT NOT NULL,ref TEXT NOT NULL,source_revision TEXT,locator TEXT,
        PRIMARY KEY(material_id,revision,idx),UNIQUE(material_id,revision,id),
        FOREIGN KEY(material_id,revision) REFERENCES material_revisions(material_id,revision) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS material_members_source ON material_members(kind,ref,material_id);
      CREATE TRIGGER IF NOT EXISTS material_block_asset_insert AFTER INSERT ON material_blocks
        WHEN new.asset_hash IS NOT NULL BEGIN
        INSERT INTO asset_references(owner,hash) VALUES('material:'||new.material_id||':'||new.revision||':'||new.block_id,new.asset_hash);
      END;
      CREATE TRIGGER IF NOT EXISTS material_block_asset_delete AFTER DELETE ON material_blocks
        WHEN old.asset_hash IS NOT NULL BEGIN
        DELETE FROM asset_references WHERE owner='material:'||old.material_id||':'||old.revision||':'||old.block_id;
      END;
      CREATE TRIGGER IF NOT EXISTS material_block_version_delete AFTER DELETE ON material_block_versions BEGIN
        DELETE FROM material_fts_blocks WHERE rowid=old.id;
        DELETE FROM material_block_payloads WHERE hash=old.payload_hash
          AND NOT EXISTS(SELECT 1 FROM material_blocks WHERE payload_hash=old.payload_hash)
          AND NOT EXISTS(SELECT 1 FROM material_block_versions WHERE payload_hash=old.payload_hash);
      END;
      -- A captures DELETE currently means user/privacy deletion or retention expiry. Physical
      -- fragment compaction must use a separate path and preserve a lightweight source anchor.
      CREATE TRIGGER IF NOT EXISTS material_capture_delete AFTER DELETE ON captures BEGIN
        DELETE FROM material_heads WHERE id IN
          (SELECT material_id FROM material_members WHERE kind='capture' AND (ref=old.id OR ref='capture:'||old.id));
      END;
    `);
    const columns=new Set((store.db.prepare('PRAGMA table_info(material_heads)').all() as {name:string}[]).map(row=>row.name));
    if(!columns.has('min_visible_sequence'))store.db.exec('ALTER TABLE material_heads ADD COLUMN min_visible_sequence INTEGER NOT NULL DEFAULT 1');
    const payloadTrigger=store.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='material_block_payload_delete'").get() as {sql:string}|undefined;
    if(!payloadTrigger?.sql.includes('material_block_versions'))store.db.exec(`DROP TRIGGER IF EXISTS material_block_payload_delete;
      CREATE TRIGGER material_block_payload_delete AFTER DELETE ON material_blocks BEGIN
        DELETE FROM material_block_payloads WHERE hash=old.payload_hash
          AND NOT EXISTS(SELECT 1 FROM material_blocks WHERE payload_hash=old.payload_hash)
          AND NOT EXISTS(SELECT 1 FROM material_block_versions WHERE payload_hash=old.payload_hash);
      END;`);
  }

  private codingLayout(id:string,revision:string):boolean {
    return Boolean(this.store.db.prepare('SELECT 1 FROM material_coding_snapshots WHERE material_id=? AND revision=?').get(id,revision));
  }
  private anchor(id:string,revision:string,blockId:string):string {
    const value=hash(JSON.stringify([id,revision,blockId]));
    return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`;
  }
  /** A pinned, host-created base. The archive append epoch is authoritative;
   * no source item can create or edit this checkpoint. */
  codingBase(id:string):CodingAppendBase|undefined {
    const record=this.get(id);if(!record||record.kind!=='mote.coding-session')return;
    const row=this.store.db.prepare('SELECT archive_checkpoint,append_epoch,head_count FROM material_coding_snapshots WHERE material_id=? AND revision=?').get(id,record.revision) as
      {archive_checkpoint:string|null;append_epoch:number|null;head_count:number|null}|undefined;
    if(!row||row.archive_checkpoint===null||row.append_epoch===null||row.head_count===null)return;
    const tail=record.blockCount?this.store.db.prepare(`SELECT b.block_id,b.format,p.text FROM material_block_versions b
      JOIN material_block_payloads p ON p.hash=b.payload_hash WHERE b.material_id=? AND b.idx=?
      AND b.from_sequence<=? AND (b.until_sequence IS NULL OR b.until_sequence>?)`).get(id,record.blockCount-1,record.sequence,record.sequence) as
      {block_id:string;format:string|null;text:string}|undefined:undefined;
    if(record.blockCount&&!tail)return;
    return {record,archiveCheckpoint:row.archive_checkpoint,appendEpoch:row.append_epoch,headCount:row.head_count,
      lastBlock:tail?{id:tail.block_id,text:tail.text,format:tail.format}:null};
  }

  setSearchable(id:string,enabled:boolean){
    const row=this.store.db.prepare('SELECT rowid,revision,sequence FROM material_heads WHERE id=?').get(id) as {rowid:number;revision:string;sequence:number}|undefined;if(!row)return;
    if(this.codingLayout(id,row.revision)){
      if(!enabled){this.store.db.prepare('DELETE FROM material_searchable WHERE material_id=?').run(id);return;}
      this.store.db.prepare('INSERT OR IGNORE INTO material_searchable VALUES(?)').run(id);
      const pending=this.store.db.prepare(`SELECT b.id,p.text FROM material_block_versions b JOIN material_block_payloads p ON p.hash=b.payload_hash
        WHERE b.material_id=? AND b.from_sequence<=? AND (b.until_sequence IS NULL OR b.until_sequence>?)
        AND NOT EXISTS(SELECT 1 FROM material_fts_blocks f WHERE f.rowid=b.id)`).all(id,row.sequence,row.sequence) as {id:number;text:string}[];
      const insert=this.store.db.prepare('INSERT INTO material_fts_blocks(rowid,text) VALUES(?,?)');
      for(const block of pending)insert.run(block.id,block.text);
      return;
    }
    this.store.db.prepare('DELETE FROM material_fts WHERE rowid=?').run(row.rowid);
    if(!enabled){this.store.db.prepare('DELETE FROM material_searchable WHERE material_id=?').run(id);return;}
    this.store.db.prepare('INSERT OR IGNORE INTO material_searchable VALUES(?)').run(id);
    const text=this.store.db.prepare('SELECT p.text,b.format FROM material_blocks b JOIN material_block_payloads p ON p.hash=b.payload_hash WHERE b.material_id=? AND b.revision=? ORDER BY b.idx').all(id,row.revision).map(r=>String(r.text)+(r.format==='markdown-fragment'?'':'\n')).join('');
    this.store.db.prepare('INSERT INTO material_fts(rowid,material_id,text) VALUES(?,?,?)').run(row.rowid,id,text);
  }
  evidenceIds(ref:string){const material=this.get(ref);if(!material)return [];
    if(this.codingLayout(material.id,material.revision))return (this.store.db.prepare(`SELECT anchor_id FROM material_block_versions
      WHERE material_id=? AND from_sequence<=? AND (until_sequence IS NULL OR until_sequence>?) AND anchor_id IS NOT NULL ORDER BY idx`)
      .all(material.id,material.sequence,material.sequence) as {anchor_id:string}[]).map(row=>row.anchor_id);
    return this.store.db.prepare('SELECT id FROM material_evidence WHERE material_id=? AND revision=? ORDER BY rowid').all(material.id,material.revision).map(r=>String(r.id));}
  evidence(ids:string[]):CaptureRecord[]{return ids.flatMap(id=>{
    const anchor=this.store.db.prepare('SELECT * FROM material_evidence WHERE id=?').get(id);if(!anchor)return [];
    const material=this.get(formatMaterialRef(String(anchor.material_id),String(anchor.revision)));if(!material)return [];
    const block=this.codingLayout(material.id,material.revision)?this.store.db.prepare(`SELECT p.text,b.start_offset FROM material_block_versions b
      JOIN material_block_payloads p ON p.hash=b.payload_hash WHERE b.material_id=? AND b.from_revision=? AND b.block_id=? AND b.anchor_id=?`)
      .get(material.id,material.revision,anchor.block_id,id):this.store.db.prepare(`SELECT p.text,b.start_offset FROM material_blocks b JOIN material_block_payloads p ON p.hash=b.payload_hash
      WHERE b.material_id=? AND b.revision=? AND b.block_id=?`).get(material.id,material.revision,anchor.block_id);if(!block)return [];
    const at=material.origin.firstAt??material.createdAt;
    return [{id,deviceId:material.origin.deviceId??material.origin.sourceId,deviceName:'Material',platform:'import',capturedAt:at,receivedAt:material.createdAt,durationMs:0,source:'message',appId:'mote.material',appName:material.title,windowTitle:material.title,ocrText:String(block.text),indexingStatus:'indexed',privacy:{excluded:false,redacted:false,mode:'none'},provenance:{sourceId:material.origin.sourceId,externalId:material.id,revision:material.revision,layer:'snapshot',deleted:false,uri:material.ref+'#'+anchor.block_id,document:{recordedAt:at,timeBasis:'recorded',contentRole:'transcript',...(material.origin.provider&&material.origin.projectKey&&material.origin.sessionId?{coding:{version:1,provider:material.origin.provider,projectKey:material.origin.projectKey,sessionId:material.origin.sessionId,eventId:String(anchor.block_id),role:'transcript',part:0,parts:1}}:{})}}} as CaptureRecord];
  });}
  isCurrentEvidence(id:string){const row=this.store.db.prepare(`SELECT h.source_id,h.sequence,h.min_visible_sequence,h.retired,h.revision,e.revision evidence_revision,
    EXISTS(SELECT 1 FROM material_block_versions b WHERE b.anchor_id=e.id AND b.material_id=h.id AND b.from_sequence<=h.sequence
      AND (b.until_sequence IS NULL OR b.until_sequence>h.sequence)) coding_active
    FROM material_evidence e JOIN material_heads h ON h.id=e.material_id WHERE e.id=?`).get(id) as
    {source_id:string;sequence:number;min_visible_sequence:number;retired:number;revision:string;evidence_revision:string;coding_active:number}|undefined;
    return Boolean(row&&!row.retired&&row.sequence>=row.min_visible_sequence&&
      (row.revision===row.evidence_revision||row.coding_active));}
  private head(id:string):HeadRow|undefined{return this.store.db.prepare('SELECT * FROM material_heads WHERE id=?').get(id) as HeadRow|undefined;}
  private version(id:string,revision:string):RevisionRow|undefined{return this.store.db.prepare('SELECT revision,sequence,manifest,created_at AS version_created_at,text_length,block_count,member_count,asset_count FROM material_revisions WHERE material_id=? AND revision=?').get(id,revision) as RevisionRow|undefined;}
  private record(head:HeadRow,row:RevisionRow):MaterialRecord {
    const manifest=JSON.parse(row.manifest) as Omit<MaterialDraft,'blocks'|'members'>;
    return {...manifest,ref:formatMaterialRef(head.id,row.revision),revision:row.revision,sequence:row.sequence,
      createdAt:head.created_at,updatedAt:row.version_created_at,blockCount:row.block_count,memberCount:row.member_count,
      textLength:row.text_length,assetCount:row.asset_count};
  }
  get(ref:string):MaterialRecord|undefined {
    const {id,revision}=parseMaterialRef(ref),head=this.head(id);
    if(!head||head.retired)return undefined;
    const row=this.version(id,revision??head.revision);return row&&row.sequence>=head.min_visible_sequence?this.record(head,row):undefined;
  }
  /** A source tombstone makes the old head and all of its derived evidence
   * unavailable in the same receive transaction, before reconstruction starts. */
  redactUntilRebuilt(id:string):void {
    const head=this.head(id);if(!head||head.retired)return;
    const evidence=this.evidenceIds(id);
    this.setSearchable(id,false);
    this.store.db.prepare('UPDATE material_heads SET min_visible_sequence=max(min_visible_sequence,sequence+1) WHERE id=?').run(id);
    for(const anchor of evidence)this.store.invalidateMemoryEvidence(anchor,true);
  }
  /** CAS identity used by the host even while a privacy tombstone hides reads. */
  revisionForWrite(id:string):string|null {return this.head(id)?.revision??null;}
  /** Same draft is idempotent. A changed head requires explicit compare-and-swap. */
  publish(raw:MaterialDraft|MaterialAppendDraft,options:{expectedRevision?:string|null;codingSnapshot?:CodingArchiveSnapshot}={}):MaterialRecord & {changed:boolean} {
    if('mode' in raw)return this.publishAppend(raw,options);
    const draft=draftSchema.parse(raw),{id}=draft;
    if(id!==materialId(draft.origin.sourceId,draft.origin.externalId))throw new StoreError('Material ID does not match source identity',409);
    if(draft.origin.firstAt&&draft.origin.lastAt&&draft.origin.firstAt>draft.origin.lastAt)throw new StoreError('Invalid material time range');
    if(new Set(draft.blocks.map(block=>block.id)).size!==draft.blocks.length||new Set(draft.members.map(member=>member.id)).size!==draft.members.length)throw new StoreError('Duplicate material block or member ID');
    if(draft.artifacts&&new Set(draft.artifacts.map(artifact=>artifact.key)).size!==draft.artifacts.length)throw new StoreError('Duplicate material artifact key');
    const memberIds=new Set(draft.members.map(member=>member.id));
    if(draft.blocks.some(block=>block.memberIds.some(id=>!memberIds.has(id))))throw new StoreError('Material block has an unknown member');
    const totalCharacters=draft.blocks.reduce((n,block)=>n+(block.kind==='text'?block.text.length:0),0);
    if(!Number.isSafeInteger(totalCharacters))throw new StoreError('Material text size is invalid',413);
    const original=this.head(id);
    const revision=original&&original.min_visible_sequence>original.sequence?
      hash(JSON.stringify([draft,options.codingSnapshot?.checkpoint??null,original.min_visible_sequence])):hash(JSON.stringify(draft));
    if(original&&!original.retired&&original.revision===revision)return {...this.record(original,this.version(id,revision)!),changed:false};
    const releases:(()=>void)[]=[];
    try{
      for(const assetHash of new Set(draft.blocks.flatMap(block=>block.kind==='asset'?[block.hash]:[]))){
        releases.push(this.store.assets.hold(assetHash));this.store.assets.get(assetHash);
      }
      const db=this.store.db,ownTransaction=!db.isTransaction;
      if(ownTransaction)db.exec('BEGIN IMMEDIATE');
      try{
        const head=this.head(id);
        if(head?.retired)throw new StoreError('Material is retired',410);
        if(head&&head.revision===revision){if(ownTransaction)db.exec('COMMIT');return {...this.record(head,this.version(id,revision)!),changed:false};}
        if(head&&(options.expectedRevision===undefined||options.expectedRevision!==head.revision))throw new StoreError('Material revision changed; refresh and retry',409);
        if(!head&&options.expectedRevision!==undefined&&options.expectedRevision!==null)throw new StoreError('Material does not exist at expected revision',409);
        if(head&&(head.source_id!==draft.origin.sourceId||head.external_id!==draft.origin.externalId))throw new StoreError('Material identity cannot change',409);
        if(this.version(id,revision))throw new StoreError('An older material revision cannot become the current head',409);
        for(const member of draft.members)if(member.kind==='capture'){
          const captureId=member.ref.startsWith('capture:')?member.ref.slice('capture:'.length):member.ref;
          if(!db.prepare('SELECT 1 FROM captures WHERE id=?').get(captureId))throw new StoreError('Material source capture is missing',409);
        }
        const now=new Date().toISOString(),sequence=(head?.sequence??0)+1;
        const {blocks:_,members:__,...manifest}=draft;
        const manifestJson=JSON.stringify(manifest);
        let offset=0,assetCount=0,requiredBytes=Buffer.byteLength(manifestJson)+512;
        for(const member of draft.members)requiredBytes+=Buffer.byteLength(JSON.stringify(member))+128;
        for(const block of draft.blocks){
          const display=block.kind==='text'?block.text:`[asset ${block.id} ${block.mimeType} ${block.hash}]`;
          const payloadHash=hash(display);
          if(!db.prepare('SELECT 1 FROM material_block_payloads WHERE hash=?').get(payloadHash))requiredBytes+=Buffer.byteLength(display);
          requiredBytes+=Buffer.byteLength(JSON.stringify(block.kind==='text'?{id:block.id,format:block.format,memberIds:block.memberIds,locator:block.locator}:{id:block.id,hash:block.hash,mimeType:block.mimeType,memberIds:block.memberIds,locator:block.locator}))+128;
        }
        this.store.reserveMetadata(requiredBytes);
        if(!head)db.prepare(`INSERT INTO material_heads(id,source_id,external_id,kind,revision,sequence,retired,device_id,first_at,last_at,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,draft.origin.sourceId,draft.origin.externalId,draft.kind,'',0,0,draft.origin.deviceId??null,draft.origin.firstAt??null,draft.origin.lastAt??null,now,now);
        db.prepare('INSERT INTO material_revisions VALUES(?,?,?,?,?,?,?,?,?)').run(id,revision,sequence,manifestJson,now,0,draft.blocks.length,draft.members.length,draft.blocks.filter(b=>b.kind==='asset').length);
        const coding=draft.kind==='mote.coding-session';
        if(head&&this.codingLayout(id,head.revision))db.prepare('UPDATE material_block_versions SET until_sequence=? WHERE material_id=? AND until_sequence IS NULL').run(sequence,id);
        if(coding)db.prepare('DELETE FROM material_fts WHERE rowid=(SELECT rowid FROM material_heads WHERE id=?)').run(id);
        if(coding)db.prepare('INSERT INTO material_coding_snapshots VALUES(?,?,?,?,?)').run(id,revision,options.codingSnapshot?.checkpoint??null,
          options.codingSnapshot?.appendEpoch??null,options.codingSnapshot?.headCount??null);
        const searchable=Boolean(db.prepare('SELECT 1 FROM material_searchable WHERE material_id=?').get(id));
        const lineageIds=new Set(draft.members.filter(member=>member.kind==='archive'||member.kind==='capture').map(member=>member.id));
        const insertPayload=db.prepare('INSERT OR IGNORE INTO material_block_payloads VALUES(?,?)');
        const insertBlock=db.prepare('INSERT INTO material_blocks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
        const insertVersion=db.prepare(`INSERT INTO material_block_versions(material_id,from_revision,from_sequence,until_sequence,idx,block_id,kind,format,
          payload_hash,asset_hash,mime_type,member_ids,locator,start_offset,end_offset,anchor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const insertEvidence=db.prepare('INSERT INTO material_evidence VALUES(?,?,?,?)');
        const insertFtsBlock=db.prepare('INSERT INTO material_fts_blocks(rowid,text) VALUES(?,?)');
        for(const [index,block] of draft.blocks.entries()){
          const display=block.kind==='text'?block.text:`[asset ${block.id} ${block.mimeType} ${block.hash}]`;
          const payloadHash=hash(display);insertPayload.run(payloadHash,display);
          const end=offset+display.length+(block.kind==='text'&&block.format==='markdown-fragment'?0:1);
          const anchor=block.kind==='text'&&block.memberIds.some(memberId=>lineageIds.has(memberId))?this.anchor(id,revision,block.id):null;
          if(coding){
            const inserted=insertVersion.run(id,revision,sequence,null,index,block.id,block.kind,block.kind==='text'?block.format:null,payloadHash,
              block.kind==='asset'?block.hash:null,block.kind==='asset'?block.mimeType:null,JSON.stringify(block.memberIds),
              block.locator?JSON.stringify(block.locator):null,offset,end,anchor);
            if(searchable&&block.kind==='text')insertFtsBlock.run(Number(inserted.lastInsertRowid),display);
          }else insertBlock.run(id,revision,index,block.id,block.kind,block.kind==='text'?block.format:null,payloadHash,
            block.kind==='asset'?block.hash:null,block.kind==='asset'?block.mimeType:null,
            JSON.stringify(block.memberIds),block.locator?JSON.stringify(block.locator):null,offset,end);
          if(anchor)insertEvidence.run(anchor,id,revision,block.id);
          offset=end;if(block.kind==='asset')assetCount++;
        }
        const insertMember=db.prepare('INSERT INTO material_members VALUES(?,?,?,?,?,?,?,?)');
        for(const [index,member] of draft.members.entries())insertMember.run(id,revision,index,member.id,member.kind,member.ref,member.revision??null,member.locator?JSON.stringify(member.locator):null);
        db.prepare('UPDATE material_revisions SET text_length=?,asset_count=? WHERE material_id=? AND revision=?').run(offset,assetCount,id,revision);
        for(const anchor of this.evidenceIds(id))this.store.invalidateMemoryEvidence(anchor);
        db.prepare('UPDATE material_heads SET revision=?,sequence=?,kind=?,retired=0,device_id=?,first_at=?,last_at=?,updated_at=? WHERE id=?').run(revision,sequence,draft.kind,draft.origin.deviceId??null,draft.origin.firstAt??null,draft.origin.lastAt??null,now,id);
        if(searchable&&!coding)this.setSearchable(id,true);
        if(ownTransaction)db.exec('COMMIT');
        return {...this.get(formatMaterialRef(id,revision))!,changed:true};
      }catch(error){if(ownTransaction&&db.isTransaction)db.exec('ROLLBACK');throw error;}
    }finally{for(const release of releases)release();}
  }

  /** Coding's append path reuses immutable active prefix blocks and their
   * evidence anchors. Only the mutable tail obtains a new interval and FTS row. */
  private publishAppend(raw:MaterialAppendDraft,options:{expectedRevision?:string|null;codingSnapshot?:CodingArchiveSnapshot}):MaterialRecord & {changed:boolean} {
    const draft=appendDraftSchema.parse(raw),snapshot=options.codingSnapshot;
    if(draft.kind!=='mote.coding-session'||!snapshot||draft.id!==materialId(draft.origin.sourceId,draft.origin.externalId))throw new StoreError('Invalid Coding append',409);
    if(new Set(draft.blocks.map(block=>block.id)).size!==draft.blocks.length||new Set(draft.members.map(member=>member.id)).size!==draft.members.length)
      throw new StoreError('Duplicate material block or member ID');
    if(draft.blocks.some(block=>block.kind!=='text'||block.format!=='markdown-fragment'||block.memberIds.some(id=>!draft.members.some(member=>member.id===id))))
      throw new StoreError('Invalid Coding append block',409);
    const db=this.store.db,ownTransaction=!db.isTransaction;if(ownTransaction)db.exec('BEGIN IMMEDIATE');
    try{
      const head=this.head(draft.id),base=head?this.version(draft.id,head.revision):undefined;
      if(!head||head.retired||!base||head.revision!==draft.baseRevision||options.expectedRevision!==head.revision||
        !this.codingLayout(draft.id,head.revision)||draft.reuseBlocks>base.block_count||draft.reuseBlocks<base.block_count-1)
        throw new StoreError('Coding append base changed',409);
      const prior=this.store.db.prepare('SELECT append_epoch,head_count FROM material_coding_snapshots WHERE material_id=? AND revision=?').get(draft.id,head.revision) as
        {append_epoch:number|null;head_count:number|null}|undefined;
      if(!prior||prior.append_epoch!==snapshot.appendEpoch||prior.head_count===null||snapshot.headCount<prior.head_count)
        throw new StoreError('Coding append archive changed',409);
      if(draft.blocks.length===0&&draft.reuseBlocks===base.block_count){
        db.prepare('UPDATE material_coding_snapshots SET archive_checkpoint=?,head_count=? WHERE material_id=? AND revision=?')
          .run(snapshot.checkpoint,snapshot.headCount,draft.id,head.revision);
        if(ownTransaction)db.exec('COMMIT');return {...this.record(head,base),changed:false};
      }
      if(draft.origin.firstAt&&draft.origin.lastAt&&draft.origin.firstAt>draft.origin.lastAt)throw new StoreError('Invalid material time range');
      const prefix=draft.reuseBlocks?db.prepare(`SELECT end_offset FROM material_block_versions WHERE material_id=? AND idx=?
        AND from_sequence<=? AND (until_sequence IS NULL OR until_sequence>?)`).get(draft.id,draft.reuseBlocks-1,head.sequence,head.sequence) as
        {end_offset:number}|undefined:undefined;
      if(draft.reuseBlocks&&!prefix)throw new StoreError('Coding append prefix missing',409);
      const {mode:_,baseRevision:__,reuseBlocks:___,blocks:____,...manifest}=draft,manifestJson=JSON.stringify(manifest);
      const revision=hash(JSON.stringify(draft)),sequence=head.sequence+1,now=new Date().toISOString();
      if(this.version(draft.id,revision))throw new StoreError('An older material revision cannot become current',409);
      let requiredBytes=Buffer.byteLength(manifestJson)+512;
      for(const member of draft.members)requiredBytes+=Buffer.byteLength(JSON.stringify(member))+128;
      for(const block of draft.blocks){const display=block.kind==='text'?block.text:'';
        if(!db.prepare('SELECT 1 FROM material_block_payloads WHERE hash=?').get(hash(display)))requiredBytes+=Buffer.byteLength(display);
        requiredBytes+=256;
      }
      this.store.reserveMetadata(requiredBytes);
      db.prepare('INSERT INTO material_revisions VALUES(?,?,?,?,?,?,?,?,?)').run(draft.id,revision,sequence,manifestJson,now,0,
        draft.reuseBlocks+draft.blocks.length,draft.members.length,0);
      db.prepare('INSERT INTO material_coding_snapshots VALUES(?,?,?,?,?)').run(draft.id,revision,snapshot.checkpoint,snapshot.appendEpoch,snapshot.headCount);
      const replaced=db.prepare(`SELECT anchor_id FROM material_block_versions WHERE material_id=? AND idx>=? AND until_sequence IS NULL
        AND anchor_id IS NOT NULL`).all(draft.id,draft.reuseBlocks) as {anchor_id:string}[];
      db.prepare('UPDATE material_block_versions SET until_sequence=? WHERE material_id=? AND idx>=? AND until_sequence IS NULL')
        .run(sequence,draft.id,draft.reuseBlocks);
      for(const row of replaced)this.store.invalidateMemoryEvidence(row.anchor_id);
      const searchable=Boolean(db.prepare('SELECT 1 FROM material_searchable WHERE material_id=?').get(draft.id));
      const insertPayload=db.prepare('INSERT OR IGNORE INTO material_block_payloads VALUES(?,?)');
      const insertVersion=db.prepare(`INSERT INTO material_block_versions(material_id,from_revision,from_sequence,until_sequence,idx,block_id,kind,format,
        payload_hash,asset_hash,mime_type,member_ids,locator,start_offset,end_offset,anchor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insertEvidence=db.prepare('INSERT INTO material_evidence VALUES(?,?,?,?)');
      const insertFts=db.prepare('INSERT INTO material_fts_blocks(rowid,text) VALUES(?,?)');
      let offset=prefix?.end_offset??0;
      for(const [i,block] of draft.blocks.entries()){
        const idx=draft.reuseBlocks+i;if(block.id!==`section-${idx}`)throw new StoreError('Coding append block order changed',409);
        const text=(block as Extract<MaterialBlock,{kind:'text'}>).text,payloadHash=hash(text),anchor=this.anchor(draft.id,revision,block.id);
        insertPayload.run(payloadHash,text);
        const end=offset+text.length,inserted=insertVersion.run(draft.id,revision,sequence,null,idx,block.id,'text','markdown-fragment',
          payloadHash,null,null,JSON.stringify(block.memberIds),block.locator?JSON.stringify(block.locator):null,offset,end,anchor);
        insertEvidence.run(anchor,draft.id,revision,block.id);if(searchable)insertFts.run(Number(inserted.lastInsertRowid),text);
        offset=end;
      }
      const insertMember=db.prepare('INSERT INTO material_members VALUES(?,?,?,?,?,?,?,?)');
      for(const [index,member] of draft.members.entries())insertMember.run(draft.id,revision,index,member.id,member.kind,member.ref,member.revision??null,
        member.locator?JSON.stringify(member.locator):null);
      db.prepare('UPDATE material_revisions SET text_length=? WHERE material_id=? AND revision=?').run(offset,draft.id,revision);
      db.prepare('UPDATE material_heads SET revision=?,sequence=?,kind=?,retired=0,device_id=?,first_at=?,last_at=?,updated_at=? WHERE id=?')
        .run(revision,sequence,draft.kind,draft.origin.deviceId??null,draft.origin.firstAt??null,draft.origin.lastAt??null,now,draft.id);
      if(ownTransaction)db.exec('COMMIT');return {...this.get(formatMaterialRef(draft.id,revision))!,changed:true};
    }catch(error){if(ownTransaction&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }

  list(args:{sourceId?:string;kind?:string;deviceId?:string;after?:string;before?:string;limit?:number;cursor?:string;query?:string}={}):MaterialPage {
    const limit=args.limit??30;if(!Number.isInteger(limit)||limit<1||limit>100)throw new StoreError('Invalid material page size');
    const clauses=[`h.retired=0`,`h.sequence>=h.min_visible_sequence`],values:(string|number)[]=[];
    if(args.query){const terms=args.query.trim().split(/\s+/).filter(Boolean);for(const term of terms){
      const codingBoundary=`EXISTS(SELECT 1 FROM material_block_versions left_block
        JOIN material_block_versions right_block ON right_block.material_id=left_block.material_id AND right_block.idx=left_block.idx+1
        JOIN material_block_payloads left_payload ON left_payload.hash=left_block.payload_hash
        JOIN material_block_payloads right_payload ON right_payload.hash=right_block.payload_hash
        WHERE left_block.material_id=h.id AND left_block.from_sequence<=h.sequence
          AND (left_block.until_sequence IS NULL OR left_block.until_sequence>h.sequence)
          AND right_block.from_sequence<=h.sequence AND (right_block.until_sequence IS NULL OR right_block.until_sequence>h.sequence)
          AND instr(substr(left_payload.text,-?)||substr(right_payload.text,1,?),?)>0)`;
      const longCoding=`instr((SELECT group_concat(text,'') FROM (SELECT p.text FROM material_block_versions b
        JOIN material_block_payloads p ON p.hash=b.payload_hash WHERE b.material_id=h.id AND b.from_sequence<=h.sequence
        AND (b.until_sequence IS NULL OR b.until_sequence>h.sequence) ORDER BY b.idx)),?)>0`;
      if([...term].length>=3){
        const match='"'+term.replaceAll('"','""')+'"';
        clauses.push(`EXISTS(SELECT 1 FROM material_searchable s WHERE s.material_id=h.id) AND (
          h.rowid IN (SELECT rowid FROM material_fts WHERE material_fts MATCH ?)
          OR EXISTS(SELECT 1 FROM material_fts_blocks JOIN material_block_versions b ON b.id=material_fts_blocks.rowid
            WHERE material_fts_blocks MATCH ? AND b.material_id=h.id AND b.from_sequence<=h.sequence
            AND (b.until_sequence IS NULL OR b.until_sequence>h.sequence))
          OR ${codingBoundary}${term.length>12000?` OR ${longCoding}`:''})`);
        values.push(match,match,term.length,term.length,term,...(term.length>12000?[term]:[]));
      }else{
        clauses.push(`EXISTS(SELECT 1 FROM material_searchable s WHERE s.material_id=h.id) AND (
          EXISTS(SELECT 1 FROM material_blocks b JOIN material_block_payloads p ON p.hash=b.payload_hash
            WHERE b.material_id=h.id AND b.revision=h.revision AND instr(p.text,?)>0)
          OR EXISTS(SELECT 1 FROM material_block_versions b JOIN material_block_payloads p ON p.hash=b.payload_hash
            WHERE b.material_id=h.id AND b.from_sequence<=h.sequence AND (b.until_sequence IS NULL OR b.until_sequence>h.sequence)
              AND instr(p.text,?)>0)
          OR ${codingBoundary})`);
        values.push(term,term,term.length,term.length,term);
      }
    }}
    for(const [key,column] of [['sourceId','source_id'],['kind','kind'],['deviceId','device_id']] as const)if(args[key]){clauses.push(`h.${column}=?`);values.push(args[key]!);}
    if(args.after){const after=new Date(args.after).toISOString();clauses.push('h.last_at>=?');values.push(after);}
    if(args.before){const before=new Date(args.before).toISOString();clauses.push('h.first_at<?');values.push(before);}
    if(args.cursor){
      let cursor:{u:string;id:string};try{cursor=JSON.parse(Buffer.from(args.cursor,'base64url').toString()) as typeof cursor;if(typeof cursor.u!=='string'||!materialIdSchema.safeParse(cursor.id).success)throw Error();}catch{throw new StoreError('Invalid material cursor');}
      clauses.push('(h.updated_at<? OR (h.updated_at=? AND h.id<?))');values.push(cursor.u,cursor.u,cursor.id);
    }
    const rows=this.store.db.prepare(`SELECT h.*,r.manifest,r.text_length,r.block_count,r.member_count,r.asset_count,r.created_at AS version_created_at FROM material_heads h JOIN material_revisions r ON r.material_id=h.id AND r.revision=h.revision WHERE ${clauses.join(' AND ')} ORDER BY h.updated_at DESC,h.id DESC LIMIT ?`).all(...values,limit+1) as (HeadRow&RevisionRow)[];
    const page=rows.slice(0,limit).map(row=>this.record(row,row));
    const last=rows.length>limit?rows[limit-1]:undefined;
    return {items:page,nextCursor:last?Buffer.from(JSON.stringify({u:last.updated_at,id:last.id})).toString('base64url'):null};
  }

  /** Read a pinned revision through a bounded character window and at most 64 blocks. */
  read(ref:string,args:{offset?:number;length?:number}={}):MaterialReadPage {
    const material=this.get(ref);if(!material)throw new StoreError('Material not found',404);
    const offset=args.offset??0,length=args.length??4000;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>12000)throw new StoreError('Invalid material read range');
    const total=material.textLength;if(offset>total)throw new StoreError('Material read offset exceeds length',416);
    const end=Math.min(total,offset+length),{id,revision}=parseMaterialRef(material.ref);
    const rows=this.codingLayout(id,revision!)?this.store.db.prepare(`SELECT b.block_id,b.kind,b.format,p.text payload,b.asset_hash,b.mime_type,b.member_ids,b.locator,b.start_offset,b.end_offset
      FROM material_block_versions b JOIN material_block_payloads p ON p.hash=b.payload_hash
      WHERE b.material_id=? AND b.from_sequence<=? AND (b.until_sequence IS NULL OR b.until_sequence>?)
        AND b.end_offset>? AND b.start_offset<? ORDER BY b.idx LIMIT 65`).all(id,material.sequence,material.sequence,offset,end) as BlockRow[]:
      this.store.db.prepare(`SELECT b.block_id,b.kind,b.format,p.text payload,b.asset_hash,b.mime_type,b.member_ids,b.locator,b.start_offset,b.end_offset
      FROM material_blocks b JOIN material_block_payloads p ON p.hash=b.payload_hash
      WHERE b.material_id=? AND b.revision=? AND b.end_offset>? AND b.start_offset<? ORDER BY b.idx LIMIT 65`).all(id,revision!,offset,end) as BlockRow[];
    const selected=rows.slice(0,64),pageEnd=rows.length>64?Math.min(end,selected.at(-1)!.end_offset):end;
    let text='',cursor=offset;const spans:MaterialReadSpan[]=[];
    for(const row of selected){
      const start=Math.max(offset,row.start_offset),stop=Math.min(pageEnd,row.end_offset);
      if(stop<=start)continue;
      const rendered=row.payload+(row.format==='markdown-fragment'?'':'\n');
      const slice=rendered.slice(start-row.start_offset,stop-row.start_offset);
      const pageStart=text.length;text+=slice;cursor=stop;
      spans.push({blockId:row.block_id,kind:row.kind,...(row.format?{format:row.format}:{}),
        pageRange:{start:pageStart,end:text.length},materialRange:{start, end:stop},
        memberIds:JSON.parse(row.member_ids) as string[],...(row.locator?{locator:JSON.parse(row.locator) as Record<string,unknown>}:{}) ,
        ...(row.asset_hash?{asset:{hash:row.asset_hash,mimeType:row.mime_type!}}:{})});
    }
    const nextOffset=cursor<total?cursor:null;
    return {material,text,textRange:{offset,total,nextOffset},spans};
  }

  members(ref:string,args:{offset?:number;limit?:number}={}):MaterialMemberPage {
    const material=this.get(ref);if(!material)throw new StoreError('Material not found',404);
    const offset=args.offset??0,limit=args.limit??100;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new StoreError('Invalid member range');
    const {id,revision}=parseMaterialRef(material.ref);
    const rows=this.store.db.prepare('SELECT id,kind,ref,source_revision,locator FROM material_members WHERE material_id=? AND revision=? AND idx>=? ORDER BY idx LIMIT ?').all(id,revision!,offset,limit) as {id:string;kind:string;ref:string;source_revision:string|null;locator:string|null}[];
    return {items:rows.map(row=>({id:row.id,kind:row.kind,ref:row.ref,...(row.source_revision?{revision:row.source_revision}:{}),...(row.locator?{locator:JSON.parse(row.locator)}:{})})),
      nextOffset:offset+rows.length<material.memberCount?offset+rows.length:null,total:material.memberCount};
  }

  retire(id:string,options:{expectedRevision:string}):{id:string;revision:string;retired:true} {
    parseId(id);parseRevision(options.expectedRevision);
    const db=this.store.db,ownTransaction=!db.isTransaction;
    if(ownTransaction)db.exec('BEGIN IMMEDIATE');
    try{
      const head=this.head(id);if(!head)throw new StoreError('Material not found',404);
      if(head.retired){if(ownTransaction)db.exec('COMMIT');return {id,revision:head.revision,retired:true};}
      if(head.revision!==options.expectedRevision)throw new StoreError('Material revision changed; refresh and retry',409);
      this.setSearchable(id,false);for(const anchor of this.evidenceIds(id))this.store.invalidateMemoryEvidence(anchor);
      const now=new Date().toISOString(),revision=hash(JSON.stringify(['retire',id,head.revision])),sequence=head.sequence+1;
      db.prepare('INSERT INTO material_revisions VALUES(?,?,?,?,?,?,?,?,?)').run(id,revision,sequence,JSON.stringify({id,kind:head.kind,retired:true}),now,0,0,0,0);
      db.prepare('UPDATE material_heads SET revision=?,sequence=?,retired=1,updated_at=? WHERE id=?').run(revision,sequence,now,id);
      if(ownTransaction)db.exec('COMMIT');return {id,revision,retired:true};
    }catch(error){if(ownTransaction&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  /** Explicit privacy erasure removes all revisions, payloads unique to them and asset refs. */
  forget(id:string):boolean {parseId(id);this.setSearchable(id,false);for(const anchor of this.store.db.prepare('SELECT id FROM material_evidence WHERE material_id=?').all(id))this.store.invalidateMemoryEvidence(String(anchor.id),true);const result=this.store.db.prepare('DELETE FROM material_heads WHERE id=?').run(id);return result.changes>0;}
}
