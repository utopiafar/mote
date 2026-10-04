import {z} from 'zod';
import {MaterialStore,materialId,materialManifestSchema} from './materials.js';
import {StoreError,sha256,type Store} from './store.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().regex(/^mat_[a-f0-9]{64}$/),uuid=z.string().uuid();
const text=z.string(),integer=z.number().int().nonnegative(),flag=z.number().int().min(0).max(1),at=z.string().datetime({offset:true});
const nullable=<T extends z.ZodTypeAny>(schema:T)=>schema.nullable();
const block={material_id:id,idx:integer,block_id:text,kind:z.enum(['text','asset']),format:nullable(text),payload_hash:hash,
  asset_hash:nullable(hash),mime_type:nullable(text),member_ids:text,locator:nullable(text),start_offset:integer,end_offset:integer,anchor_id:nullable(uuid)};
const schemas={
  heads:z.object({id,source_id:text,external_id:text,kind:text,revision:hash,sequence:integer,retired:flag,device_id:nullable(text),
    first_at:nullable(at),last_at:nullable(at),created_at:at,updated_at:at,min_visible_sequence:integer}).strict(),
  revisions:z.object({material_id:id,revision:hash,sequence:integer,manifest:text,created_at:at,text_length:integer,block_count:integer,member_count:integer,asset_count:integer,draft_hash:nullable(hash)}).strict(),
  blocks:z.object({...block,revision:hash,identity_hash:nullable(hash)}).strict(),
  blockVersions:z.object({...block,from_revision:hash,from_sequence:integer,until_sequence:nullable(integer)}).strict(),
  members:z.object({material_id:id,revision:hash,idx:integer,id:text,kind:text,ref:text,source_revision:nullable(text),locator:nullable(text)}).strict(),
  payloads:z.object({hash,text}).strict(),
  evidence:z.object({id:uuid,material_id:id,revision:hash,block_id:text,invalidated:flag}).strict(),
  contexts:z.object({anchor_id:uuid,json:text}).strict(),
  dependencies:z.object({anchor_id:uuid,evidence_id:uuid}).strict(),
  codingSnapshots:z.object({material_id:id,revision:hash,archive_checkpoint:nullable(text),append_epoch:nullable(integer),head_count:nullable(integer)}).strict(),
  indexing:z.object({material_id:id,enabled:flag}).strict(),
};
const tables={heads:'material_heads',revisions:'material_revisions',blocks:'material_blocks',blockVersions:'material_block_versions',members:'material_members',
  payloads:'material_block_payloads',evidence:'material_evidence',contexts:'material_evidence_context',dependencies:'material_evidence_dependencies',
  codingSnapshots:'material_coding_snapshots',indexing:'material_index_requests'} as const;
const keys={heads:['id'],revisions:['material_id','revision'],blocks:['material_id','revision','idx'],blockVersions:['material_id','from_revision','idx'],
  members:['material_id','revision','idx'],payloads:['hash'],evidence:['id'],contexts:['anchor_id'],dependencies:['anchor_id','evidence_id'],
  codingSnapshots:['material_id','revision'],indexing:['material_id']} as const;
const sectionSchema=z.object({version:z.literal(1),...Object.fromEntries(Object.entries(schemas).map(([key,schema])=>[key,z.array(schema).max(400000)])),
  assets:z.array(z.object({hash,bytes:integer,dataBase64:z.string()}).strict()).max(20000),checksum:hash}).strict();
type Name=keyof typeof schemas;
type Portable=Record<Name,Record<string,string|number|null>[]> & {version:1;assets:{hash:string;bytes:number;dataBase64:string}[];checksum:string};
const names=Object.keys(schemas) as Name[];
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
const digest=(value:unknown)=>sha256(JSON.stringify(canonical(value)));
const revisionKey=(row:Record<string,unknown>)=>JSON.stringify([row.material_id,row.revision]);
function groupRows(rows:Portable[Name],key:(row:Portable[Name][number])=>string){
  const groups=new Map<string,Portable[Name]>();for(const row of rows){const value=key(row),group=groups.get(value)??[];group.push(row);groups.set(value,group);}return groups;
}

export function portableMaterialEstimate(store:Store){
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='material_heads'").get())return 0;
  const payload=Number(store.db.prepare('SELECT coalesce(sum(length(CAST(text AS BLOB))),0) n FROM material_block_payloads').get()!.n);
  const assets=Number(store.db.prepare(`SELECT coalesce(sum(a.bytes),0) n FROM assets a WHERE a.hash IN
    (SELECT asset_hash FROM material_blocks UNION SELECT asset_hash FROM material_block_versions)`).get()!.n);
  return payload+Math.ceil(assets*4/3);
}
export function exportPortableMaterials(store:Store):Portable|undefined{
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='material_heads'").get())return undefined;
  const body={version:1} as Omit<Portable,'checksum'>;
  for(const name of names){const columns=Object.keys(schemas[name].shape);body[name]=store.db.prepare(`SELECT ${columns.join(',')} FROM ${tables[name]} ORDER BY ${keys[name].join(',')}`).all() as Portable[Name];}
  const assets=store.db.prepare('SELECT DISTINCT asset_hash hash FROM material_blocks WHERE asset_hash IS NOT NULL UNION SELECT DISTINCT asset_hash hash FROM material_block_versions WHERE asset_hash IS NOT NULL').all();
  body.assets=assets.map(row=>{const bytes=store.assets.read(String(row.hash));return {hash:String(row.hash),bytes:bytes.length,dataBase64:bytes.toString('base64')};});
  return {...body,checksum:digest(body)};
}

/** Preflight structural and byte integrity before any archive mutation. SQL
 * projections are fixed by the host; an archive cannot name tables or columns. */
export function preparePortableMaterials(raw:unknown):Portable|undefined{
  if(raw===undefined)return undefined; // Earlier v2 archives had no formal materials.
  const parsed=sectionSchema.parse(raw) as unknown as Portable,{checksum,...body}=parsed;
  if(digest(body)!==checksum)throw new StoreError('Material archive checksum mismatch');
  for(const name of names){const seen=new Set<string>();for(const row of parsed[name]){const key=JSON.stringify(keys[name].map(key=>row[key]));if(seen.has(key))throw new StoreError('Duplicate material archive identity');seen.add(key);}}
  if(new Set(parsed.assets.map(asset=>asset.hash)).size!==parsed.assets.length)throw new StoreError('Duplicate material asset identity');
  for(const asset of parsed.assets){const bytes=Buffer.from(asset.dataBase64,'base64');if(bytes.length!==asset.bytes||sha256(bytes)!==asset.hash)throw new StoreError('Material asset checksum mismatch');}
  for(const payload of parsed.payloads)if(sha256(String(payload.text))!==payload.hash)throw new StoreError('Material payload checksum mismatch');
  return parsed;
}

/** Restores immutable proof before Memory and rebuilds only the search
 * projection. Runs inside EvidenceStore's all-or-nothing import transaction. */
export function restorePortableMaterials(store:Store,portable:Portable|undefined){
  if(!portable)return undefined;
  const materials=new MaterialStore(store),db=store.db;
  const heads=new Map(portable.heads.map(row=>[row.id,row])),revisions=new Map(portable.revisions.map(row=>[revisionKey(row),row]));
  const revisionSequences=new Set(portable.revisions.map(row=>JSON.stringify([row.material_id,row.sequence])));
  if(revisionSequences.size!==portable.revisions.length)throw new StoreError('Material archive contains duplicate history sequences');
  const payloads=new Map(portable.payloads.map(row=>[row.hash,String(row.text)])),anchors=new Map(portable.evidence.map(row=>[row.id,row]));
  const dependencies=new Map<string,string[]>();for(const row of portable.dependencies){const old=dependencies.get(String(row.anchor_id))??[];old.push(String(row.evidence_id));dependencies.set(String(row.anchor_id),old);}
  const allBlocks=[...portable.blocks,...portable.blockVersions];
  const membersByRevision=groupRows(portable.members,revisionKey),blocksByRevision=groupRows(portable.blocks,revisionKey),versionsByMaterial=groupRows(portable.blockVersions,row=>String(row.material_id));
  const blocksByAnchor=groupRows(allBlocks.filter(row=>row.anchor_id!==null),row=>String(row.anchor_id)),evidenceByMaterial=groupRows(portable.evidence,row=>String(row.material_id));
  const codingRevisions=new Set(portable.codingSnapshots.map(revisionKey)),assetHashes=new Set(portable.assets.map(asset=>asset.hash)),indexingByMaterial=new Map(portable.indexing.map(row=>[row.material_id,row]));
  for(const head of portable.heads){
    if(head.id!==materialId(String(head.source_id),String(head.external_id))||!revisions.has(JSON.stringify([head.id,head.revision])))throw new StoreError('Material head identity or revision mismatch');
    const current=revisions.get(JSON.stringify([head.id,head.revision]))!;if(current.sequence!==head.sequence)throw new StoreError('Material head sequence mismatch');
  }
  for(const revision of portable.revisions){
    const head=heads.get(revision.material_id);if(!head)throw new StoreError('Material revision has no head');
    const manifest=JSON.parse(String(revision.manifest));
    if(manifest.retired===true){if(manifest.id!==head.id||revision.block_count!==0||revision.member_count!==0)throw new StoreError('Invalid retired material revision');continue;}
    const normalized=materialManifestSchema.parse(manifest);
    if(normalized.id!==head.id||normalized.origin.sourceId!==head.source_id||normalized.origin.externalId!==head.external_id)throw new StoreError('Material revision source identity mismatch');
    const members=(membersByRevision.get(revisionKey(revision))??[]).sort((a,b)=>Number(a.idx)-Number(b.idx));
    if(members.length!==revision.member_count||members.some((row,i)=>row.idx!==i))throw new StoreError('Material member layout mismatch');
    for(const member of members){if(member.kind==='capture'&&(member.ref!=='capture:'+member.id||!store.evidence([String(member.id)]).length))throw new StoreError('Material archive is missing its original capture');}
    const coding=codingRevisions.has(revisionKey(revision));
    const blocks=(coding?(versionsByMaterial.get(String(revision.material_id))??[]).filter(row=>Number(row.from_sequence)<=Number(revision.sequence)&&(row.until_sequence===null||Number(row.until_sequence)>Number(revision.sequence))):(blocksByRevision.get(revisionKey(revision))??[])).sort((a,b)=>Number(a.idx)-Number(b.idx));
    let offset=0,assetCount=0;
    for(const [i,block] of blocks.entries()){
      const value=payloads.get(block.payload_hash);if(value===undefined||block.idx!==i||block.start_offset!==offset)throw new StoreError('Material block layout or payload mismatch');
      const memberIds=z.array(z.string()).parse(JSON.parse(String(block.member_ids)));
      if(memberIds.some(id=>!members.some(row=>row.id===id)))throw new StoreError('Material block has an unknown original member');
      if(block.locator!==null)z.record(z.unknown()).parse(JSON.parse(String(block.locator)));
      const end=offset+value.length+(block.format==='markdown-fragment'?0:1);if(block.end_offset!==end)throw new StoreError('Material block text range mismatch');offset=end;
      if(block.kind==='asset'){
        assetCount++;if(!block.asset_hash||!block.mime_type||value!==`[asset ${block.block_id} ${block.mime_type} ${block.asset_hash}]`||!assetHashes.has(String(block.asset_hash)))throw new StoreError('Material original asset is missing');
      }else if(block.asset_hash!==null||block.mime_type!==null)throw new StoreError('Text block has unexpected asset metadata');
      if(block.anchor_id!==null){
        const anchor=anchors.get(block.anchor_id);if(!anchor||anchor.material_id!==block.material_id||anchor.block_id!==block.block_id||!revisions.has(revisionKey(anchor)))throw new StoreError('Material block is missing its evidence anchor');
        const originalIds=new Set(members.filter(row=>memberIds.includes(String(row.id))).map(row=>String(row.id)));
        const inputs=dependencies.get(String(anchor.id));if(!inputs?.length||inputs.some(input=>!originalIds.has(input)||!store.evidence([input]).length))throw new StoreError('Material anchor has missing or unrelated input lineage');
      }
    }
    if(blocks.length!==revision.block_count||assetCount!==revision.asset_count||offset!==revision.text_length)throw new StoreError('Material revision coverage mismatch');
    if(normalized.artifacts?.some(a=>a.blockIds?.some(id=>!blocks.some(row=>row.block_id===id))))throw new StoreError('Material artifact references missing blocks');
  }
  for(const block of allBlocks)if(!heads.has(block.material_id)||!revisions.has(JSON.stringify([block.material_id,block.revision??block.from_revision])))throw new StoreError('Material block has no revision');
  for(const version of portable.blockVersions){
    const revision=revisions.get(JSON.stringify([version.material_id,version.from_revision]))!;
    if(version.from_sequence!==revision.sequence||!codingRevisions.has(revisionKey(revision))||
      (version.until_sequence!==null&&(Number(version.until_sequence)<=Number(version.from_sequence)||!revisionSequences.has(JSON.stringify([version.material_id,version.until_sequence])))))throw new StoreError('Material block history interval mismatch');
  }
  for(const anchor of portable.evidence){
    const blocks=blocksByAnchor.get(String(anchor.id))??[],original=blocks.find(row=>row.material_id===anchor.material_id&&row.block_id===anchor.block_id&&(row.revision??row.from_revision)===anchor.revision);
    if(!original)throw new StoreError('Material evidence anchor has no block');
    // An unchanged block may reuse its immutable quote anchor after moving in
    // the layout. Its textual proof and original membership must stay exact.
    const proof=(row:Portable[Name][number])=>digest(Object.fromEntries(['kind','format','payload_hash','asset_hash','mime_type','member_ids','locator'].map(key=>[key,row[key]])));
    if(blocks.some(row=>proof(row)!==proof(original)))throw new StoreError('Material evidence anchor refers to divergent block proof');
  }
  for(const row of portable.dependencies)if(!anchors.has(row.anchor_id))throw new StoreError('Material dependency has no anchor');
  for(const row of portable.contexts){if(!anchors.has(row.anchor_id))throw new StoreError('Material context has no anchor');z.object({observedAt:at,document:z.object({recordedAt:at.optional(),occurredAt:at.optional(),timeBasis:z.enum(['recorded','occurred','unknown']),contentRole:z.enum(['authored','transcript','summary','reference','other'])}).strict()}).strict().parse(JSON.parse(String(row.json)));}
  for(const row of portable.codingSnapshots)if(!revisions.has(revisionKey(row)))throw new StoreError('Coding material snapshot has no revision');
  for(const row of portable.indexing)if(!heads.has(row.material_id))throw new StoreError('Material search projection has no head');

  store.reserveMetadata(Buffer.byteLength(JSON.stringify(portable)));
  for(const asset of portable.assets)store.assets.putParts([Buffer.from(asset.dataBase64,'base64')],asset.bytes,asset.hash).release();
  // Reject divergent immutable histories instead of overwriting destination proof.
  for(const name of names.filter(name=>!['heads','indexing'].includes(name))){
    const columns=Object.keys(schemas[name].shape),where=keys[name].map(key=>key+'=?').join(' AND ');
    for(const row of portable[name]){
      const prior=db.prepare(`SELECT ${columns.join(',')} FROM ${tables[name]} WHERE ${where}`).get(...keys[name].map(key=>row[key]));
      const immutable=(value:Record<string,unknown>)=>Object.fromEntries(Object.entries(value).filter(([key])=>!(name==='evidence'&&key==='invalidated')&&!(name==='blockVersions'&&key==='until_sequence')));
      if(prior&&digest(immutable(prior))!==digest(immutable(row)))throw new StoreError('Material archive conflicts with an immutable destination version',409);
      if(name==='blockVersions'&&prior?.until_sequence!==null&&row.until_sequence!==null&&prior&&prior.until_sequence!==row.until_sequence)throw new StoreError('Material archive contains divergent block histories',409);
      if(name==='revisions'){const sequence=db.prepare('SELECT revision FROM material_revisions WHERE material_id=? AND sequence=?').get(row.material_id,row.sequence);if(sequence&&sequence.revision!==row.revision)throw new StoreError('Material archive contains divergent revision histories',409);}
    }
  }
  const insertedHeads=new Set<string>();
  for(const head of portable.heads){const prior=db.prepare('SELECT * FROM material_heads WHERE id=?').get(head.id);if(prior&&(prior.source_id!==head.source_id||prior.external_id!==head.external_id))throw new StoreError('Material archive source identity conflict',409);if(!prior){insertedHeads.add(String(head.id));const columns=Object.keys(schemas.heads.shape);db.prepare(`INSERT INTO material_heads(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(key=>head[key]));}}
  for(const name of ['revisions','payloads','members','evidence','contexts','dependencies','blocks','blockVersions','codingSnapshots'] as Name[]){const columns=Object.keys(schemas[name].shape);const insert=db.prepare(`INSERT OR IGNORE INTO ${tables[name]}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);for(const row of portable[name])insert.run(...columns.map(key=>row[key]));}
  for(const head of portable.heads){
    const prior=db.prepare('SELECT sequence,revision FROM material_heads WHERE id=?').get(head.id)!;
    if(Number(head.sequence)>Number(prior.sequence)){
      const incomingBlocks=codingRevisions.has(JSON.stringify([head.id,head.revision]))?(versionsByMaterial.get(String(head.id))??[]).filter(row=>Number(row.from_sequence)<=Number(head.sequence)&&(row.until_sequence===null||Number(row.until_sequence)>Number(head.sequence))):(blocksByRevision.get(JSON.stringify([head.id,head.revision]))??[]);
      const retained=new Set(incomingBlocks.map(row=>row.anchor_id));for(const anchor of materials.evidenceIds(String(head.id)))if(!retained.has(anchor))store.invalidateMemoryEvidence(anchor);
      const columns=Object.keys(schemas.heads.shape).filter(key=>key!=='id');db.prepare(`UPDATE material_heads SET ${columns.map(key=>key+'=?').join(',')} WHERE id=?`).run(...columns.map(key=>head[key]),head.id);
    }
    for(const row of versionsByMaterial.get(String(head.id))??[])if(row.until_sequence!==null)db.prepare('UPDATE material_block_versions SET until_sequence=? WHERE material_id=? AND from_revision=? AND idx=? AND until_sequence IS NULL').run(row.until_sequence,row.material_id,row.from_revision,row.idx);
    // Imported source pointers may already have been superseded at destination.
    for(const anchor of evidenceByMaterial.get(String(head.id))??[])if(!db.prepare('SELECT invalidated FROM material_evidence WHERE id=?').get(anchor.id)?.invalidated&&(anchor.invalidated===1||(dependencies.get(String(anchor.id))??[]).some(input=>!store.isCurrentEvidence(input))))store.invalidateMemoryEvidence(String(anchor.id));
    const current=db.prepare('SELECT retired FROM material_heads WHERE id=?').get(head.id)!,indexing=indexingByMaterial.get(head.id);
    const enabled=insertedHeads.has(String(head.id))?indexing?.enabled:db.prepare('SELECT enabled FROM material_index_requests WHERE material_id=?').get(head.id)?.enabled;
    materials.setSearchable(String(head.id),Boolean(enabled)&&current.retired===0);
  }
  return materials;
}
