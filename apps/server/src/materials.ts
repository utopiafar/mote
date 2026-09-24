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
  blocks:z.array(blockSchema).max(2000),members:z.array(memberSchema).max(2000),
  coverage:z.object({state:z.enum(['complete','partial','pending']),reason:z.string().max(500).optional()}).strict(),
  fidelity:z.object({state:z.enum(['lossless','derived','summary-only']),limitations:z.array(z.string().max(500)).max(20).optional()}).strict(),
  retention:z.object({original:z.enum(['retained','unavailable']),policy:z.enum(['keep','allow-expiry'])}).strict(),
}).strict();

export type MaterialDraft=z.infer<typeof draftSchema>;
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

type HeadRow={id:string;source_id:string;external_id:string;kind:string;revision:string;sequence:number;retired:number;created_at:string;updated_at:string};
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
      CREATE TABLE IF NOT EXISTS material_heads(
        id TEXT PRIMARY KEY,source_id TEXT NOT NULL,external_id TEXT NOT NULL,kind TEXT NOT NULL,
        revision TEXT NOT NULL,sequence INTEGER NOT NULL,retired INTEGER NOT NULL DEFAULT 0,
        device_id TEXT,first_at TEXT,last_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS material_heads_source ON material_heads(source_id,updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS material_heads_recent ON material_heads(retired,updated_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS material_revisions(
        material_id TEXT NOT NULL REFERENCES material_heads(id) ON DELETE CASCADE,revision TEXT NOT NULL,
        sequence INTEGER NOT NULL,manifest TEXT NOT NULL,created_at TEXT NOT NULL,
        text_length INTEGER NOT NULL,block_count INTEGER NOT NULL,member_count INTEGER NOT NULL,asset_count INTEGER NOT NULL,
        PRIMARY KEY(material_id,revision),UNIQUE(material_id,sequence));
      CREATE TABLE IF NOT EXISTS material_block_payloads(hash TEXT PRIMARY KEY,text TEXT NOT NULL);
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
      CREATE TRIGGER IF NOT EXISTS material_block_payload_delete AFTER DELETE ON material_blocks BEGIN
        DELETE FROM material_block_payloads WHERE hash=old.payload_hash
          AND NOT EXISTS(SELECT 1 FROM material_blocks WHERE payload_hash=old.payload_hash);
      END;
      -- A captures DELETE currently means user/privacy deletion or retention expiry. Physical
      -- fragment compaction must use a separate path and preserve a lightweight source anchor.
      CREATE TRIGGER IF NOT EXISTS material_capture_delete AFTER DELETE ON captures BEGIN
        DELETE FROM material_heads WHERE id IN
          (SELECT material_id FROM material_members WHERE kind='capture' AND (ref=old.id OR ref='capture:'||old.id));
      END;
    `);
  }

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
    const row=this.version(id,revision??head.revision);return row?this.record(head,row):undefined;
  }
  /** Same draft is idempotent. A changed head requires explicit compare-and-swap. */
  publish(raw:MaterialDraft,options:{expectedRevision?:string|null}={}):MaterialRecord & {changed:boolean} {
    const draft=draftSchema.parse(raw),{id}=draft;
    if(id!==materialId(draft.origin.sourceId,draft.origin.externalId))throw new StoreError('Material ID does not match source identity',409);
    if(draft.origin.firstAt&&draft.origin.lastAt&&draft.origin.firstAt>draft.origin.lastAt)throw new StoreError('Invalid material time range');
    if(new Set(draft.blocks.map(block=>block.id)).size!==draft.blocks.length||new Set(draft.members.map(member=>member.id)).size!==draft.members.length)throw new StoreError('Duplicate material block or member ID');
    const memberIds=new Set(draft.members.map(member=>member.id));
    if(draft.blocks.some(block=>block.memberIds.some(id=>!memberIds.has(id))))throw new StoreError('Material block has an unknown member');
    const totalCharacters=draft.blocks.reduce((n,block)=>n+(block.kind==='text'?block.text.length:0),0);
    if(totalCharacters>4_000_000)throw new StoreError('Material text exceeds 4,000,000 characters',413);
    const revision=hash(JSON.stringify(draft));
    const original=this.head(id);
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
        if(!head)db.prepare('INSERT INTO material_heads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,draft.origin.sourceId,draft.origin.externalId,draft.kind,'',0,0,draft.origin.deviceId??null,draft.origin.firstAt??null,draft.origin.lastAt??null,now,now);
        db.prepare('INSERT INTO material_revisions VALUES(?,?,?,?,?,?,?,?,?)').run(id,revision,sequence,manifestJson,now,0,draft.blocks.length,draft.members.length,draft.blocks.filter(b=>b.kind==='asset').length);
        const insertPayload=db.prepare('INSERT OR IGNORE INTO material_block_payloads VALUES(?,?)');
        const insertBlock=db.prepare('INSERT INTO material_blocks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for(const [index,block] of draft.blocks.entries()){
          const display=block.kind==='text'?block.text:`[asset ${block.id} ${block.mimeType} ${block.hash}]`;
          const payloadHash=hash(display);insertPayload.run(payloadHash,display);
          const end=offset+display.length+1;
          insertBlock.run(id,revision,index,block.id,block.kind,block.kind==='text'?block.format:null,payloadHash,
            block.kind==='asset'?block.hash:null,block.kind==='asset'?block.mimeType:null,
            JSON.stringify(block.memberIds),block.locator?JSON.stringify(block.locator):null,offset,end);
          offset=end;if(block.kind==='asset')assetCount++;
        }
        const insertMember=db.prepare('INSERT INTO material_members VALUES(?,?,?,?,?,?,?,?)');
        for(const [index,member] of draft.members.entries())insertMember.run(id,revision,index,member.id,member.kind,member.ref,member.revision??null,member.locator?JSON.stringify(member.locator):null);
        db.prepare('UPDATE material_revisions SET text_length=?,asset_count=? WHERE material_id=? AND revision=?').run(offset,assetCount,id,revision);
        db.prepare('UPDATE material_heads SET revision=?,sequence=?,kind=?,retired=0,device_id=?,first_at=?,last_at=?,updated_at=? WHERE id=?').run(revision,sequence,draft.kind,draft.origin.deviceId??null,draft.origin.firstAt??null,draft.origin.lastAt??null,now,id);
        if(ownTransaction)db.exec('COMMIT');
        return {...this.get(formatMaterialRef(id,revision))!,changed:true};
      }catch(error){if(ownTransaction&&db.isTransaction)db.exec('ROLLBACK');throw error;}
    }finally{for(const release of releases)release();}
  }

  list(args:{sourceId?:string;kind?:string;deviceId?:string;after?:string;before?:string;limit?:number;cursor?:string}={}):MaterialPage {
    const limit=args.limit??30;if(!Number.isInteger(limit)||limit<1||limit>100)throw new StoreError('Invalid material page size');
    const clauses=['h.retired=0'],values:(string|number)[]=[];
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
    const rows=this.store.db.prepare(`SELECT b.block_id,b.kind,b.format,p.text payload,b.asset_hash,b.mime_type,b.member_ids,b.locator,b.start_offset,b.end_offset
      FROM material_blocks b JOIN material_block_payloads p ON p.hash=b.payload_hash
      WHERE b.material_id=? AND b.revision=? AND b.end_offset>? AND b.start_offset<? ORDER BY b.idx LIMIT 65`).all(id,revision!,offset,end) as BlockRow[];
    const selected=rows.slice(0,64),pageEnd=rows.length>64?Math.min(end,selected.at(-1)!.end_offset):end;
    let text='',cursor=offset;const spans:MaterialReadSpan[]=[];
    for(const row of selected){
      const start=Math.max(offset,row.start_offset),stop=Math.min(pageEnd,row.end_offset);
      if(stop<=start)continue;
      const rendered=row.payload+'\n';
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
      const now=new Date().toISOString(),revision=hash(JSON.stringify(['retire',id,head.revision])),sequence=head.sequence+1;
      db.prepare('INSERT INTO material_revisions VALUES(?,?,?,?,?,?,?,?,?)').run(id,revision,sequence,JSON.stringify({id,kind:head.kind,retired:true}),now,0,0,0,0);
      db.prepare('UPDATE material_heads SET revision=?,sequence=?,retired=1,updated_at=? WHERE id=?').run(revision,sequence,now,id);
      if(ownTransaction)db.exec('COMMIT');return {id,revision,retired:true};
    }catch(error){if(ownTransaction&&db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  /** Explicit privacy erasure removes all revisions, payloads unique to them and asset refs. */
  forget(id:string):boolean {parseId(id);const result=this.store.db.prepare('DELETE FROM material_heads WHERE id=?').run(id);return result.changes>0;}
}
