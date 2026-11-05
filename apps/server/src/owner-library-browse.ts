import {createHash} from 'node:crypto';
import type {StatementSync} from 'node:sqlite';
import {z} from 'zod';
import {formatEvidenceRef,sourceContentTime,libraryMaterialTypes,type CapturePreview,type LibraryMaterialType} from '@mote/shared';
import {moteText} from './i18n.js';
import {StoreError,type Store} from './store.js';
import {storedCaptureLibraryVersion} from './capture-library-version.js';
import type {EvidenceReader} from './evidence-reader.js';
import type {MaterialStore,MaterialRecord} from './materials.js';
import type {FastifyInstance} from 'fastify';

const querySchema=z.object({query:z.string().min(1).max(500).optional(),sourceId:z.string().min(1).max(128).optional(),kind:z.string().min(1).max(128).optional(),type:z.enum(libraryMaterialTypes).optional(),origin:z.literal('notes').optional(),deviceId:z.string().min(1).max(128).optional(),after:z.string().datetime({offset:true}).optional(),before:z.string().datetime({offset:true}).optional(),limit:z.coerce.number().int().min(1).max(100).default(24),cursor:z.string().max(8192).optional()}).strict().refine(value=>!value.origin||!value.sourceId&&!value.kind,{message:'Note origin cannot be combined with a material source or kind'});
type Query=z.infer<typeof querySchema>;
const positionSchema=z.object({material:z.string().optional(),notes:z.string().optional(),materialDone:z.boolean(),notesDone:z.boolean()}).strict();
type Position=z.infer<typeof positionSchema>;
export type OwnerBrowseEntry={entryType:'material';ref:string;contentAt:string;material:MaterialRecord}|{entryType:'capture';ref:string;contentAt:string;revision:string;capture:CapturePreview};
const materialTime=(value:MaterialRecord)=>new Date(value.origin.lastAt??value.origin.firstAt??value.updatedAt).toISOString();
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');

/** A read projection of existing owner entities. It never publishes notes or
 * changes the Material-only catalog used by native clients and model tools. */
export class OwnerLibraryBrowse {
 private representedStatement?:StatementSync;
 private facets?:{generation:string;ownerIdentity:string;registryRevision:number;sourceNames:string;value:Pick<ReturnType<MaterialStore['catalog']['list']>,'types'|'sources'|'sourcesTruncated'>};
 constructor(private materials:MaterialStore,private reader:Pick<EvidenceReader,'archivedEvidence'>){}
 private get store():Store{return this.materials.store;}
 private generation(){return this.materials.catalog.generation()+':'+String(this.store.db.prepare('SELECT COALESCE(MAX(seq),0) version FROM changes').get()!.version);}
 private represented(record:{id:string;provenance?:{revision?:string}},query:Query,version:string){
  if(query.origin)return false;
  // Only an exact, full singleton note replacement can suppress its original.
  // Missing version pins, grouped materials and derived summaries never do.
  const statement=this.representedStatement??=this.store.db.prepare(`SELECT h.id FROM material_heads h JOIN material_revisions r ON r.material_id=h.id AND r.revision=h.revision
    JOIN material_members m ON m.material_id=h.id AND m.revision=h.revision
    WHERE h.kind='mote.note' AND h.retired=0 AND h.sequence>=h.min_visible_sequence AND r.member_count=1
      AND m.kind='capture' AND m.ref=? AND m.source_revision IS NOT NULL
      AND (m.source_revision=? OR m.source_revision=?)
      AND json_extract(r.manifest,'$.coverage.state')='complete' AND json_extract(r.manifest,'$.fidelity.state')='lossless'
      AND json_extract(r.manifest,'$.retention.original')='retained'`);
  const rows=statement.all(formatEvidenceRef('capture',record.id),version,record.provenance?.revision??'');
  return rows.some(row=>this.materials.list({...query,cursor:undefined,id:String(row.id),type:'note',limit:1,order:'source'}).items.length>0);
 }
 private possibleReplacements(ids:string[],query:Query){
  if(query.origin||!ids.length)return new Set<string>();
  const rows=this.store.db.prepare(`SELECT DISTINCT m.ref FROM material_heads h JOIN material_revisions r ON r.material_id=h.id AND r.revision=h.revision
   JOIN material_members m ON m.material_id=h.id AND m.revision=h.revision
   WHERE h.kind='mote.note' AND h.retired=0 AND h.sequence>=h.min_visible_sequence AND r.member_count=1
    AND m.kind='capture' AND m.ref IN (${ids.map(()=>'?').join(',')}) AND m.source_revision IS NOT NULL
    AND json_extract(r.manifest,'$.coverage.state')='complete' AND json_extract(r.manifest,'$.fidelity.state')='lossless'
    AND json_extract(r.manifest,'$.retention.original')='retained'`).all(...ids.map(id=>formatEvidenceRef('capture',id)));
  return new Set(rows.map(row=>String(row.ref)));
 }
 private currentFacets(generation:string,ownerIdentity:string){
  // Head generation covers counts and visibility, but not source labels or
  // runtime renderer registration. Read these live before reusing metadata.
  const sourceNames=JSON.stringify(this.store.db.prepare("SELECT id,json_extract(json,'$.name') name FROM source_connections ORDER BY id").all()),registryRevision=this.materials.catalog.registry.revision,cached=this.facets;
  if(cached&&cached.generation===generation&&cached.ownerIdentity===ownerIdentity&&cached.registryRevision===registryRevision&&cached.sourceNames===sourceNames)return structuredClone(cached.value);
  const {types,sources,sourcesTruncated}=this.materials.catalog.list({limit:1},ownerIdentity),value={types,sources,sourcesTruncated};
  this.facets={generation,ownerIdentity,registryRevision,sourceNames,value};return structuredClone(value);
 }
 list(query:Query,ownerIdentity:string){
  const {cursor,...filter}=query,generation=this.generation(),scope=createHash('sha256').update(JSON.stringify(['owner-browse',ownerIdentity,filter,this.materials.catalog.registry.revision])).digest('hex');
  let position:Position={materialDone:Boolean(query.origin),notesDone:Boolean(query.sourceId||query.kind||query.type&&query.type!=='note')};
  if(cursor){const sealed=this.materials.catalog.openPosition(cursor);if(sealed.scope!==scope||sealed.generation!==generation)throw new StoreError('Library cursor changed; restart browsing',409);try{position=positionSchema.parse(JSON.parse(sealed.inner));}catch{throw new StoreError('Invalid library cursor',400);}}
  const count=query.limit+1;
  const materialPage=position.materialDone?{items:[],nextCursor:null}:this.materials.list({...filter,cursor:position.material,limit:Math.min(100,count),order:'source'});
  const materialEntries=materialPage.items.map(material=>({entryType:'material' as const,ref:material.ref,contentAt:materialTime(material),material}));
  const notes:{entry:Extract<OwnerBrowseEntry,{entryType:'capture'}>;cursor:string}[]=[];let noteCursor=position.notes,notesExhausted=position.notesDone;
  while(!notesExhausted&&notes.length<count){
   // Reuse the same original visibility, literal search and content time as
   // existing owner capture browsing. No direct weaker captures SQL path.
   const page=this.store.searchPage({source:'note',collection:'content',query:query.query,deviceId:query.deviceId,after:query.after,before:query.before,limit:100,cursor:noteCursor,includeTotal:false});
   const possible=this.possibleReplacements(page.items.map(candidate=>candidate.id),query);
   for(const candidate of page.items){
    const nextCursor=encode({t:new Date(sourceContentTime(candidate)).toISOString(),id:candidate.id});
    const record=this.reader.archivedEvidence([formatEvidenceRef('capture',candidate.id)],{deviceId:query.deviceId,after:query.after,before:query.before})[0];
    const revision=record&&storedCaptureLibraryVersion(this.store,record.id);
    if(record&&revision&&(!possible.has(formatEvidenceRef('capture',record.id))||!this.represented(record,query,revision)))notes.push({entry:{entryType:'capture',ref:formatEvidenceRef('capture',record.id),contentAt:new Date(sourceContentTime(record)).toISOString(),revision,capture:this.store.preview(record)},cursor:nextCursor});
    noteCursor=nextCursor;if(notes.length===count)break;
   }
   if(notes.length===count)break;
   notesExhausted=!page.nextCursor;noteCursor=page.nextCursor??noteCursor;
  }
  const items:OwnerBrowseEntry[]=[...materialEntries,...notes.map(value=>value.entry)].sort((a,b)=>b.contentAt.localeCompare(a.contentAt)||b.ref.localeCompare(a.ref)).slice(0,query.limit);
  const usedMaterials=items.filter(value=>value.entryType==='material'),usedNotes=items.filter(value=>value.entryType==='capture');
  const lastMaterial=usedMaterials.at(-1),lastNote=usedNotes.at(-1);
  const next:Position={...position,
   ...(lastMaterial?.entryType==='material'?{material:encode({u:materialTime(lastMaterial.material),id:lastMaterial.material.id})}:{}),
   ...(lastNote?{notes:notes.find(value=>value.entry.ref===lastNote.ref)!.cursor}:{}),
   materialDone:position.materialDone||!materialPage.nextCursor&&usedMaterials.length===materialEntries.length,
   notesDone:position.notesDone||notesExhausted&&usedNotes.length===notes.length};
  const more=materialEntries.length>usedMaterials.length||notes.length>usedNotes.length||!next.materialDone||!next.notesDone;
  const catalog=this.currentFacets(generation,ownerIdentity);
  return {schemaVersion:1 as const,revision:generation,types:catalog.types,sources:catalog.sources,sourcesTruncated:catalog.sourcesTruncated,noteOrigin:{origin:'notes' as const,label:moteText('记录')},items,nextCursor:more?this.materials.catalog.sealPosition({scope,generation,inner:JSON.stringify(next)}):null};
 }
}
/** Mounted behind the same default-deny owner route hook as Material browsing. */
export function registerOwnerLibraryBrowse(app:FastifyInstance,materials:MaterialStore,reader:Pick<EvidenceReader,'archivedEvidence'>){const browse=new OwnerLibraryBrowse(materials,reader);app.get('/api/library/browse',async req=>browse.list(querySchema.parse(req.query),String(req.headers.authorization??'')));}
