import {isDeepStrictEqual} from 'node:util';
import {z} from 'zod';
import {fileEvidenceSchema,queryScopeSchema,type CaptureRecord,type DocumentActivity,type EvidenceDependencies,type FileCoverage,type FileRevision,type QueryScope,type SourceDocument,type SourceItem} from '@mote/shared';
import {EvidenceReader,withinEvidenceScope} from './evidence-reader.js';
import {defaultEvidenceExposurePolicy,type EvidenceExposurePolicy} from './evidence-exposure.js';
import {StoreError} from './store.js';

const unavailable=()=>new StoreError('File observation is unavailable in the selected scope',404);
const MAX_COMPARISON_CHARACTERS=250_000;
const MAX_DIFF_EXCERPT=2_000;
type Coverage={extraction:FileCoverage;semantic:FileCoverage;embedding:FileCoverage};
type Version={captureId:string;revision:string;observedAt:string;title:string;modifiedAt?:string;uri?:string;relativePath?:string;
  metadata?:SourceItem['metadata'];document?:Pick<SourceDocument,'fileIndex'|'recordedAt'|'occurredAt'|'timeBasis'|'contentRole'|'path'>;coverage:Coverage};
type Activity={captureId:string;revision:string;activity:DocumentActivity};
type Comparison={status:'unavailable';reason:'no_previous_version'|'previous_unavailable'|'body_unavailable'|'comparison_limit'|'incompatible_coordinates'}|
  {status:'available';result:'same'|'changed';before:{offset:number;length:number;excerpt:string;truncated:boolean};after:{offset:number;length:number;excerpt:string;truncated:boolean}};
export type FileObservation={sourceId:string;externalId:string;current:Version;previous:Version|{revision:string}|null;
  changes:('discovered'|'content_changed'|'metadata_changed'|'origin_missing')[];comparison:Comparison;activities:Activity[];disclosureDependencies:EvidenceDependencies};

type Snapshot={record:CaptureRecord;manifest?:FileRevision;version:Version};
const uuid=z.string().uuid();
function selected(record:CaptureRecord,scope:QueryScope){
  const p=record.provenance;
  return Boolean(p&&!record.privacy.excluded&&withinEvidenceScope(record,scope)&&
    (scope.kind!=='selection'||scope.sourceIds===undefined||scope.sourceIds.includes(p.sourceId))&&
    (scope.evidenceIds===undefined||scope.evidenceIds.includes(record.id)));
}
function metadata(snapshot:Snapshot){
  const p=snapshot.record.provenance!,doc=p.document;
  // Parser progress, content digests and observation timestamps are not source
  // metadata edits. mtime is a metadata field, never an actor or activity.
  const {fileIndex:_,...document}=doc??{};
  return {title:snapshot.record.windowTitle,uri:p.uri,modifiedAt:p.modifiedAt,mimeType:p.mimeType,
    metadata:p.metadata,document,relativePath:snapshot.manifest?.relativePath,sizeBytes:snapshot.manifest?.sizeBytes};
}
function splitPair(value:string,offset:number){return offset>0&&offset<value.length&&/[\uD800-\uDBFF]/.test(value[offset-1])&&/[\uDC00-\uDFFF]/.test(value[offset]);}
function compare(before:string,after:string):Comparison {
  let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
  if(splitPair(before,start)||splitPair(after,start))start--;
  let left=before.length,right=after.length;
  while(left>start&&right>start&&before[left-1]===after[right-1]){left--;right--;}
  if(splitPair(before,left)||splitPair(after,right)){left++;right++;}
  const range=(text:string,end:number)=>{let stop=Math.min(end,start+MAX_DIFF_EXCERPT);if(splitPair(text,stop))stop--;
    return {offset:start,length:end-start,excerpt:text.slice(start,stop),truncated:stop<end};};
  return {status:'available',result:before===after?'same':'changed',before:range(before,left),after:range(after,right)};
}

/** Stateless, read-only projection over existing source versions. The caller
 * supplies the selected current capture (and optional provider activity IDs);
 * it owns discovery, progress and any later publication. */
export class FileObservationReader {
  constructor(private readonly reader:EvidenceReader,private readonly policy:EvidenceExposurePolicy=defaultEvidenceExposurePolicy){}
  private get store(){return this.reader.store;}
  private get files(){return this.reader.files;}
  private capture(id:string){return this.store.evidenceMetadata([id])[0];}
  private source(record:CaptureRecord){try{return this.reader.sources.getSource(record.provenance!.sourceId);}catch{throw unavailable();}}
  private allowed(record:CaptureRecord,scope:QueryScope){
    if(!selected(record,scope)||!this.source(record).enabled)return false;
    return this.reader.contextDependenciesAllowed([record.id],this.policy);
  }
  private current(id:string,scope:QueryScope){
    const record=this.capture(id),p=record?.provenance;
    if(!record||record.source!=='file'||!p||!selected(record,scope)||!this.source(record).enabled)throw unavailable();
    const head=this.store.db.prepare('SELECT capture_id,deleted FROM source_heads WHERE source_id=? AND external_id=?').get(p.sourceId,p.externalId);
    if(!head||head.capture_id!==id||Boolean(head.deleted)!==p.deleted)throw unavailable();
    if(p.deleted){if(!this.reader.fileTombstoneMetadataAllowed(id,scope,this.policy))throw unavailable();}
    else if(!this.store.isCurrentEvidence(id)||(!this.allowed(record,scope)&&!this.reader.fileReferenceObservationAllowed(id,scope,this.policy)))throw unavailable();
    return record;
  }
  private manifest(id:string):FileRevision|undefined {
    const row=this.store.db.prepare('SELECT manifest FROM file_versions WHERE capture_id=?').get(id);
    return row?JSON.parse(String(row.manifest)) as FileRevision:undefined;
  }
  private snapshot(record:CaptureRecord):Snapshot {
    const p=record.provenance!,source=this.source(record),manifest=this.manifest(record.id);
    let coverage:Coverage;
    if(manifest&&this.files&&source.retention!=='reference'&&p.layer!=='reference'&&!p.deleted)coverage=this.files.fileView(record.id).coverage;
    else {
      const reference=source.retention==='reference'||p.layer==='reference',noBody=reference||p.deleted;
      // Metadata reads deliberately erase ocrText. Only the existing Lark
      // inline-body producer guarantees a complete short snapshot; inspect its
      // length without copying that body into the observation projection.
      const inline=!noBody&&source.kind==='lark-docs'&&p.layer==='snapshot'&&p.mimeType==='text/markdown'&&!p.document?.fileIndex&&
        p.document?.contentRole==='other'&&p.document.originalMetadata?.provider==='lark'&&p.document.originalMetadata.documentId===p.externalId&&
        Number(this.store.db.prepare("SELECT length(json_extract(json,'$.ocrText')) n FROM captures WHERE id=?").get(record.id)?.n??0)>0;
      const extraction:FileCoverage=p.deleted?{status:'unsupported',reason:'deletion_revision_has_no_body'}:reference?{status:'unsupported',reason:'original_body_not_collected'}:inline?{status:'ready'}:{status:'pending',reason:'body_coverage_unknown'};
      coverage={extraction,semantic:{status:noBody?'unsupported':'pending'},embedding:{status:noBody?'unsupported':'pending'}};
    }
    const document=p.document&&{recordedAt:p.document.recordedAt,occurredAt:p.document.occurredAt,timeBasis:p.document.timeBasis,contentRole:p.document.contentRole,path:p.document.path,
      ...(source.retention!=='reference'&&p.layer!=='reference'&&!p.deleted&&p.document.fileIndex?{fileIndex:p.document.fileIndex}:{})};
    return {record,manifest,version:{captureId:record.id,revision:p.revision,observedAt:record.capturedAt,title:record.windowTitle,
      ...(p.modifiedAt?{modifiedAt:p.modifiedAt}:{}),...(p.uri?{uri:p.uri}:{}),...(manifest?.relativePath?{relativePath:manifest.relativePath}:{}),
      ...(p.metadata?{metadata:p.metadata}:{}),...(document?{document}:{}),coverage}};
  }
  private activities(current:CaptureRecord,scope:QueryScope,ids:readonly string[]):Activity[]{
    const p=current.provenance!,source=this.source(current),result:Activity[]=[];
    if(source.kind!=='lark-docs')return result;
    for(const id of new Set(ids)){
      if(scope.evidenceIds!==undefined&&!scope.evidenceIds.includes(id))continue;
      const record=this.capture(id),event=record?.provenance?.document?.activity;
      if(!record||record.source!=='event'||record.provenance?.sourceId!==p.sourceId||record.provenance.deleted||
        !event||event.provider!=='lark'||event.documentId!==p.externalId||!this.store.isCurrentEvidence(id)||!this.allowed(record,scope))continue;
      result.push({captureId:id,revision:record.provenance.revision,activity:event});
    }
    return result;
  }
  private fullText(snapshot:Snapshot):{text:string}|{reason:'body_unavailable'|'comparison_limit'|'incompatible_coordinates'} {
    const p=snapshot.record.provenance!,source=this.source(snapshot.record);
    if(source.retention==='reference'||p.layer==='reference'||p.deleted||snapshot.version.coverage.extraction.status!=='ready')return {reason:'body_unavailable'};
    if(!snapshot.manifest){
      const record=this.store.evidence([snapshot.record.id])[0];
      if(!record?.ocrText||source.kind!=='lark-docs'||p.layer!=='snapshot'||p.document?.contentRole==='summary')return {reason:'body_unavailable'};
      return record.ocrText.length>MAX_COMPARISON_CHARACTERS?{reason:'comparison_limit'}:{text:record.ocrText};
    }
    if(!this.files)return {reason:'body_unavailable'};
    let offset=0,text='';
    for(;;){
      const chunks=this.files.chunks(snapshot.record.id,offset,200);
      for(const chunk of chunks){const evidence=fileEvidenceSchema.safeParse(chunk.fileEvidence),location=evidence.success?evidence.data.documentLocation:undefined;
        if(!location||location.pageNumber!==undefined||location.offset!==text.length||location.length!==chunk.ocrText.length)return {reason:'incompatible_coordinates'};
        text+=chunk.ocrText;if(text.length>MAX_COMPARISON_CHARACTERS)return {reason:'comparison_limit'};
      }
      offset+=chunks.length;if(chunks.length<200)break;
    }
    return offset?{text}:{reason:'body_unavailable'};
  }
  read(input:{captureId:string;scope:QueryScope;previousCaptureId?:string;activityIds?:readonly string[]}):FileObservation {
    const scope=queryScopeSchema.parse(input.scope),id=uuid.parse(input.captureId),activityIds=z.array(uuid).max(100).parse(input.activityIds??[]);
    if(input.previousCaptureId!==undefined)uuid.parse(input.previousCaptureId);
    const record=this.current(id,scope),p=record.provenance!,current=this.snapshot(record),db=this.store.db;
    let previousId:string|undefined,previousRevision=current.manifest?.previousRevision??undefined;
    if(previousRevision){
      const row=db.prepare('SELECT capture_id FROM source_versions WHERE source_id=? AND external_id=? AND revision=?').get(p.sourceId,p.externalId,previousRevision);
      previousId=row?String(row.capture_id):undefined;
      if(input.previousCaptureId!==undefined&&input.previousCaptureId!==previousId)throw unavailable();
    }else if(!current.manifest&&input.previousCaptureId){
      // The ordinary source protocol has no predecessor field. Accept only the
      // caller's explicitly selected immediately preceding received revision.
      const row=db.prepare(`SELECT capture_id FROM source_versions WHERE source_id=? AND external_id=? AND rowid<
        (SELECT rowid FROM source_versions WHERE capture_id=?) ORDER BY rowid DESC LIMIT 1`).get(p.sourceId,p.externalId,id);
      if(!row||row.capture_id!==input.previousCaptureId)throw unavailable();
      previousId=input.previousCaptureId;
    }
    const priorRecord=previousId&&(scope.evidenceIds===undefined||scope.evidenceIds.includes(previousId))?this.capture(previousId):undefined;
    const prior=priorRecord&&!p.deleted&&priorRecord.provenance?.sourceId===p.sourceId&&priorRecord.provenance.externalId===p.externalId&&
      !priorRecord.provenance.deleted&&(this.allowed(priorRecord,scope)||this.reader.fileHistoricalObservationAllowed(priorRecord.id,scope,this.policy))?this.snapshot(priorRecord):undefined;
    const first=current.manifest?current.manifest.previousRevision===null:!db.prepare('SELECT 1 FROM source_versions WHERE source_id=? AND external_id=? AND capture_id!=? LIMIT 1').get(p.sourceId,p.externalId,id);
    const changes:FileObservation['changes']=[];
    let comparison:Comparison={status:'unavailable',reason:first?'no_previous_version':'previous_unavailable'};
    if(p.deleted)changes.push('origin_missing');
    else if(first)changes.push('discovered');
    else if(prior){
      if(!isDeepStrictEqual(metadata(prior),metadata(current)))changes.push('metadata_changed');
      if(prior.manifest?.sha256&&current.manifest?.sha256&&prior.manifest.sha256!==current.manifest.sha256)changes.push('content_changed');
      const before=this.fullText(prior),after=this.fullText(current);
      if('text' in before&&'text' in after){comparison=compare(before.text,after.text);
        if(comparison.status==='available'&&comparison.result==='changed'&&!changes.includes('content_changed'))changes.push('content_changed');
      }else comparison={status:'unavailable',reason:'reason' in before?before.reason:(after as {reason:'body_unavailable'|'comparison_limit'|'incompatible_coordinates'}).reason};
    }
    const activities=p.deleted?[]:this.activities(record,scope,activityIds);
    const missingPrior=p.deleted&&previousRevision&&priorRecord&&selected(priorRecord,scope)?priorRecord:undefined;
    const dependencies=[id,...(prior?[prior.record.id]:[]),...(missingPrior?[missingPrior.id]:[]),...activities.map(activity=>activity.captureId)];
    // There are no asynchronous gaps here; each later consumer must recheck the
    // current head and these dependencies before disclosing or publishing them.
    return {sourceId:p.sourceId,externalId:p.externalId,current:current.version,
      previous:prior?.version??(missingPrior?{revision:previousRevision!}:null),changes,comparison,activities,
      disclosureDependencies:{version:1,complete:true,ids:dependencies}};
  }
  /** Read current extracted chunks again after processing completes. Offsets select a
   * bounded page; the reader stores no progress or cursor. */
  readBody(input:{captureId:string;scope:QueryScope;offset?:number;limit?:number}){
    const scope=queryScopeSchema.parse(input.scope),id=uuid.parse(input.captureId),offset=z.number().int().nonnegative().safe().default(0).parse(input.offset),limit=z.number().int().min(1).max(20).default(20).parse(input.limit);
    const record=this.current(id,scope),p=record.provenance!,snapshot=this.snapshot(record),source=this.source(record);
    if(p.deleted||p.layer==='reference'||source.retention==='reference')return {status:'unavailable' as const,coverage:snapshot.version.coverage,items:[]};
    if(snapshot.manifest&&this.files){
      if(!['ready','partial'].includes(snapshot.version.coverage.extraction.status))return {status:'unavailable' as const,coverage:snapshot.version.coverage,items:[]};
      const chunks=this.files.chunks(id,offset,limit+1),items=chunks.slice(0,limit).map(chunk=>({text:chunk.ocrText,fileEvidence:chunk.fileEvidence}));
      return {status:items.length?'available' as const:'unavailable' as const,coverage:snapshot.version.coverage,items,hasMore:chunks.length>limit};
    }
    if(snapshot.version.coverage.extraction.status!=='ready')return {status:'unavailable' as const,coverage:snapshot.version.coverage,items:[]};
    const text=this.store.evidence([id])[0]?.ocrText??'',parts:{text:string;captureId:string;revision:string;documentLocation:{offset:number;length:number}}[]=[];
    for(let start=0;start<text.length;){let end=Math.min(text.length,start+8000);if(splitPair(text,end))end--;
      parts.push({text:text.slice(start,end),captureId:id,revision:p.revision,documentLocation:{offset:start,length:end-start}});start=end;}
    return {status:parts.length?'available' as const:'unavailable' as const,coverage:snapshot.version.coverage,items:parts.slice(offset,offset+limit),hasMore:offset+limit<parts.length};
  }
}
