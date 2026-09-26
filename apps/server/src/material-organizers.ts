import {codingProjectContext} from './coding-project.js';
import {createHash} from 'node:crypto';
import {sourceContentTime,type CaptureRecord,type SourceItemRecord} from '@mote/shared';
import {materialId,MaterialStore,type MaterialDraft} from './materials.js';
import {ArchivedFileStore} from './archived-files.js';
import type {Store} from './store.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';
import {CaptureRawReader,captureRawRef} from './capture-raw-reader.js';
import {MAX_RAW_READ_BYTES} from './raw-reader.js';
import {SourceItemRecipeCatalog,type SourceItemRecipePin} from './source-item-recipe.js';
import type {MaterialMemoryWork} from './material-memory-work.js';

/** Organizers select declared source shapes, never infer a topic or user intent. */
export interface MaterialOrganizerFile {
  objectHash?:string;
  attachments:{id:string;hash:string;mimeType:string;relativePath?:string}[];
  chunks:{id:string;text:string;startMs:number|null;endMs:number|null;kind:string;artifact:{complete?:boolean;coverage?:string}}[];
  job?:{state:string;error:string|null};
  attachmentsTruncated:boolean;
}

/** A build receives only evidence selected by its declared group. It has no SQL or write access. */
export interface MaterialOrganizerReader {
  capture():CaptureRecord|undefined;
  sourceHead():CaptureRecord|undefined;
  codingSession():{records:CaptureRecord[];truncated:boolean};
  screenGroup():{records:CaptureRecord[];truncated:boolean};
  file(captureId:string):MaterialOrganizerFile|undefined;
}

export interface MaterialOrganizer {
  id:string;
  version:string;
  /** Only one matching organizer in a structural slot runs. A trusted plugin may replace a fallback. */
  slot?:string;
  priority?:number;
  /** Suppress matching organizers in other slots when this organizer owns the source shape. */
  exclusive?:boolean;
  select(record:CaptureRecord):Record<string,string>|undefined;
  identity(group:Record<string,string>):string|undefined;
  build(reader:MaterialOrganizerReader,group:Record<string,string>):MaterialDraft|undefined;
}

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const capture=(store:Store,id:string)=>store.evidence([id])[0];
const current=(store:Store,id:string)=>store.isCurrentEvidence(id);
const member=(record:CaptureRecord)=>({id:record.id,kind:'capture' as const,ref:`capture:${record.id}`,revision:record.provenance?.revision});
const iso=(value:string)=>new Date(value).toISOString();
const sourceKey=(prefix:string,deviceId:string)=>`${prefix}:${digest(deviceId)}`;
const canonicalGroup=(group:Record<string,string>):Record<string,string>=>Object.fromEntries(Object.entries(group).sort(([a],[b])=>a.localeCompare(b)));
/** Model-facing material text is an allowlist, not the stored capture JSON. The
 * latter can contain local file URIs, document paths and provider metadata. */
const captureText=(record:CaptureRecord)=>{
  const provenance=record.provenance,document=provenance?.document,coding=document?.coding,fileIndex=document?.fileIndex;
  const media=record.metadata?.media;
  return JSON.stringify({
    captureId:record.id,capturedAt:record.capturedAt,source:record.source,
    ...(record.appName?{appName:record.appName}:{}),
    ...(record.durationMs?{durationMs:record.durationMs}:{}),
    ...(record.ocrText?{text:record.ocrText}:{}),
    ...(record.ocr?{ocrStatus:record.ocr.status}:{}),
    ...(record.stateSeries?{stateSeries:record.stateSeries}:{}),
    ...(record.metadata?.state?{state:record.metadata.state}:{}),
    ...(record.metadata?.deviceEvent?{deviceEvent:record.metadata.deviceEvent}:{}),
    ...(media?{media:{status:media.status,observedAt:media.observedAt,sessions:media.sessions.map(session=>({
      appId:session.appId,appName:session.appName,playbackState:session.playbackState,
      appVisibility:session.appVisibility,playbackType:session.playbackType,
      title:session.title,artist:session.artist,album:session.album,displaySubtitle:session.displaySubtitle,
      durationMs:session.durationMs,positionMs:session.positionMs,playbackSpeed:session.playbackSpeed,
    }))}}:{}),
    ...(provenance?{sourceVersion:{revision:provenance.revision,layer:provenance.layer,
      deleted:provenance.deleted,modifiedAt:provenance.modifiedAt,
      ...(provenance.calendar?{calendar:provenance.calendar}:{})}}:{}),
    ...(document?{documentTime:{recordedAt:document.recordedAt,occurredAt:document.occurredAt,
      timeBasis:document.timeBasis,contentRole:document.contentRole}}:{}),
    ...(fileIndex?{fileIndex:{mode:fileIndex.mode,coverage:fileIndex.coverage,parser:fileIndex.parser,
      status:fileIndex.status,totalCharacters:fileIndex.totalCharacters,offset:fileIndex.offset,length:fileIndex.length}}:{}),
    ...(coding?{coding:{provider:coding.provider,projectKey:coding.projectKey,sessionId:coding.sessionId,
      eventId:coding.eventId,role:coding.role,
      callId:coding.callId,parentSessionId:coding.parentSessionId,part:coding.part,parts:coding.parts}}:{}),
  });
};
const origin=(sourceId:string,externalId:string,records:CaptureRecord[],extra:Partial<MaterialDraft['origin']>={})=>{
  const times=records.map(sourceContentTime).map(iso).sort();
  return {sourceId,externalId,deviceId:records[0]?.deviceId,firstAt:times[0],lastAt:times.at(-1),...extra};
};
const MAX_BLOCKS=2000,MAX_MEMBERS=2000,MAX_BLOCK_TEXT=250_000,MAX_TEXT=4_000_000;

function organizerReader(store:Store,selection:Record<string,string>,pinnedSourceHead?:string):MaterialOrganizerReader {
  const group={...selection},allowed=new Set<string>();
  const permit=(record:CaptureRecord|undefined)=>{
    if(record&&current(store,record.id)){allowed.add(record.id);return record;}
    return undefined;
  };
  const sourceHead=()=>{
    if(!group.sourceId||!group.externalId)return;
    const row=store.db.prepare('SELECT capture_id,deleted FROM source_heads WHERE source_id=? AND external_id=?').get(group.sourceId,group.externalId) as {capture_id:string;deleted:number}|undefined;
    return row&&!row.deleted&&(pinnedSourceHead===undefined||row.capture_id===pinnedSourceHead)?permit(capture(store,row.capture_id)):undefined;
  };
  const codingSession=()=>{
    if(!group.sourceId||!group.provider||!group.projectKey||!group.sessionId)return {records:[],truncated:false};
    const rows=store.db.prepare(`SELECT c.id FROM captures c JOIN source_heads h ON h.capture_id=c.id
      WHERE h.source_id=? AND h.deleted=0 AND json_extract(c.json,'$.provenance.document.coding.provider')=?
      AND json_extract(c.json,'$.provenance.document.coding.projectKey')=?
      AND json_extract(c.json,'$.provenance.document.coding.sessionId')=?
      ORDER BY c.captured_at DESC,c.id DESC LIMIT 2001`).all(group.sourceId,group.provider,group.projectKey,group.sessionId) as {id:string}[];
    return {records:rows.slice(0,MAX_MEMBERS).map(row=>permit(capture(store,row.id))).filter((r):r is CaptureRecord=>Boolean(r)),truncated:rows.length>MAX_MEMBERS};
  };
  const screenGroup=()=>{
    if(!group.groupKey||!group.deviceId)return {records:[],truncated:false};
    const rows=store.db.prepare(`SELECT o.id FROM context_observations o JOIN captures c ON c.id=o.id
      WHERE o.group_key=? AND c.device_id=? ORDER BY c.captured_at,o.id LIMIT 1001`).all(group.groupKey,group.deviceId) as {id:string}[];
    return {records:rows.slice(0,1000).map(row=>permit(capture(store,row.id))).filter((r):r is CaptureRecord=>Boolean(r)),truncated:rows.length>1000};
  };
  const file=(captureId:string):MaterialOrganizerFile|undefined=>{
    if(!allowed.has(captureId))return;
    const original=store.db.prepare('SELECT object_hash FROM file_versions WHERE capture_id=?').get(captureId) as {object_hash:string|null}|undefined;
    const attachmentRows=store.db.prepare('SELECT f.id,f.hash,f.json FROM capture_files c JOIN archived_files f ON f.id=c.file_id WHERE c.capture_id=? ORDER BY f.id LIMIT 2001').all(captureId) as {id:string;hash:string;json:string}[];
    const chunkRows=store.db.prepare(`SELECT c.id,c.text,c.start_ms,c.end_ms,a.kind,a.json artifact_json FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id
      WHERE c.capture_id=? AND a.current=1 AND a.kind IN ('text','image-text','transcript','dialogue','corrected-dialogue')
      AND NOT EXISTS(SELECT 1 FROM file_artifacts preferred WHERE preferred.capture_id=a.capture_id AND preferred.current=1
        AND ((preferred.kind='corrected-dialogue' AND a.kind!='corrected-dialogue')
          OR (preferred.kind='dialogue' AND a.kind IN ('transcript','text','image-text'))))
      ORDER BY c.start_ms,c.rowid LIMIT 2001`).all(captureId) as {id:string;text:string;start_ms:number|null;end_ms:number|null;kind:string;artifact_json:string}[];
    const job=store.db.prepare('SELECT state,error FROM file_jobs WHERE capture_id=?').get(captureId) as {state:string;error:string|null}|undefined;
    return {objectHash:original?.object_hash??undefined,
      attachments:attachmentRows.slice(0,2000).map(row=>{
        const metadata=JSON.parse(row.json) as {mimeType?:string;relativePath?:string};
        return {id:row.id,hash:row.hash,mimeType:metadata.mimeType??'application/octet-stream',...(metadata.relativePath?{relativePath:metadata.relativePath}:{})};
      }),
      chunks:chunkRows.map(row=>({id:row.id,text:row.text,startMs:row.start_ms,endMs:row.end_ms,kind:row.kind,
        artifact:JSON.parse(row.artifact_json) as {complete?:boolean;coverage?:string}})),job,
      attachmentsTruncated:attachmentRows.length>2000};
  };
  return Object.freeze({capture:()=>group.captureId?permit(capture(store,group.captureId)):undefined,sourceHead,codingSession,screenGroup,file});
}

type ReaderCall={method:'capture'|'sourceHead'|'codingSession'|'screenGroup'|'file';captureId?:string;fingerprint:string};
function recordingReader(store:Store,group:Record<string,string>,pinnedSourceHead?:string){
  const base=organizerReader(store,group,pinnedSourceHead),calls:ReaderCall[]=[];
  const record=<T>(method:ReaderCall['method'],value:T,captureId?:string)=>{
    calls.push({method,...(captureId?{captureId}:{}),fingerprint:digest([value])});return value;
  };
  const reader:MaterialOrganizerReader=Object.freeze({
    capture:()=>record('capture',base.capture()),sourceHead:()=>record('sourceHead',base.sourceHead()),
    codingSession:()=>record('codingSession',base.codingSession()),screenGroup:()=>record('screenGroup',base.screenGroup()),
    file:(id:string)=>record('file',base.file(id),id),
  });
  return {reader,calls};
}
function readerStillCurrent(store:Store,group:Record<string,string>,calls:readonly ReaderCall[]){
  const reader=organizerReader(store,group);
  for(const call of calls){
    const value=call.method==='file'?reader.file(call.captureId!):reader[call.method]();
    if(digest([value])!==call.fingerprint)return false;
  }
  return true;
}

/** Structural size accounting; a limit always appears in the material coverage. */
class MaterialBody {
  readonly blocks:MaterialDraft['blocks']=[];
  readonly members:MaterialDraft['members']=[];
  readonly limitations=new Set<string>();
  private characters=0;
  get limited(){return this.limitations.size>0;}
  get full(){return this.blocks.length>=MAX_BLOCKS||this.characters>=MAX_TEXT;}
  addMember(record:CaptureRecord){
    if(this.members.length>=MAX_MEMBERS){this.limitations.add('member_limit');return false;}
    this.members.push(member(record));return true;
  }
  text(id:string,text:string,memberId:string,format:'plain'|'json'|'transcript'='plain',locator?:Record<string,unknown>){
    if(!text)return;
    let position=0,part=0;
    while(position<text.length){
      const room=Math.min(MAX_BLOCK_TEXT,MAX_TEXT-this.characters);
      if(this.blocks.length>=MAX_BLOCKS||room<=0){this.limitations.add(this.blocks.length>=MAX_BLOCKS?'block_limit':'text_limit');return;}
      let end=Math.min(text.length,position+room);
      if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
      if(end===position){this.limitations.add('text_limit');return;}
      const slice=text.slice(position,end);
      this.blocks.push({id:part?`${id}:${part}`:id,kind:'text',format,text:slice,memberIds:[memberId],
        ...(locator||part?{locator:{...locator,textStart:position,textEnd:end}}:{})});
      this.characters+=slice.length;position=end;part++;
    }
  }
  asset(id:string,hash:string,mimeType:string,memberId:string,locator?:Record<string,unknown>){
    if(this.blocks.length>=MAX_BLOCKS){this.limitations.add('block_limit');return;}
    this.blocks.push({id,kind:'asset',hash,mimeType,memberIds:[memberId],...(locator?{locator}:{})});
  }
  coverage(state:'complete'|'pending'|'partial'='complete',reason?:string):MaterialDraft['coverage'] {
    const limit=[...this.limitations][0];
    return limit?{state:'partial',reason:limit}:reason?{state,reason}:{state};
  }
  fidelity(base:'lossless'|'derived'='lossless',limitations:string[]=[]):MaterialDraft['fidelity'] {
    const all=[...limitations,...this.limitations];
    return {state:all.length&&base==='lossless'?'derived':base,...(all.length?{limitations:all}:{})};
  }
}

const codingExternalId=(g:Record<string,string>)=>JSON.stringify([g.provider,g.projectKey,g.sessionId]);

/** A source item keeps its own identity; a coding session is assembled separately. */
const sourceItem:MaterialOrganizer={
  id:'mote.source-item',version:'1',slot:'source-item',
  select:r=>r.provenance&&!r.provenance.document?.coding?{sourceId:r.provenance.sourceId,externalId:r.provenance.externalId}:undefined,
  identity:g=>materialId(g.sourceId,g.externalId),
  build(reader,g){
    const r=reader.sourceHead();if(!r)return;
    const file=reader.file(r.id);if(!file)return;
    const {attachments,chunks,job}=file;
    const body=new MaterialBody();body.addMember(r);
    body.text('source-record',captureText(r),r.id,'json');
    for(const c of chunks){
      body.text(`chunk:${c.id}`,c.text,r.id,c.kind==='transcript'||c.kind==='dialogue'||c.kind==='corrected-dialogue'?'transcript':'plain',
        {chunkId:c.id,...(c.startMs===null?{}:{startMs:c.startMs,endMs:c.endMs})});
    }
    if(file.objectHash)body.asset('original',file.objectHash,r.provenance?.mimeType??'application/octet-stream',r.id);
    for(const attachment of attachments){
      body.asset(`attachment:${attachment.id}`,attachment.hash,attachment.mimeType,r.id,
        {fileId:attachment.id,...(attachment.relativePath?{relativePath:attachment.relativePath}:{})});
    }
    if(file.attachmentsTruncated)body.limitations.add('attachment_limit');
    const artifact=chunks[0]?.artifact;
    let state:'complete'|'pending'|'partial'='complete',reason:string|undefined;
    if(file.objectHash){
      if(['waiting','running'].includes(job?.state??'waiting')){state='pending';reason='processing_pending';}
      else if(job?.state==='blocked'||job?.state==='failed'){state='partial';reason=`processing_${job.state}`;}
      else if(job?.state==='succeeded'&&!artifact){state='partial';reason='processed_body_missing';}
      else if(artifact&&(artifact.complete===false||artifact.coverage==='partial')){state='partial';reason='processor_partial';}
    }
    if(r.provenance?.document?.fileIndex&&r.provenance.document.fileIndex.coverage!=='full'){state='partial';reason='source_index_partial';}
    const reference=r.provenance?.layer==='reference'||r.provenance?.layer==='derived';
    const hasSourceBody=Boolean(r.ocrText?.trim());
    const limitations=['metadata_projected',...(reference?['original_body_not_collected']:[]),...(state==='partial'?[reason??'processing_incomplete']:[])];
    const artifacts:MaterialDraft['artifacts']=[
      {key:'source-body',state:reference||!hasSourceBody?'unavailable':'ready',
        ...(reference?{reason:'original_body_not_collected'}:!hasSourceBody?{reason:'source_body_empty'}:{})},
      ...(file.objectHash?[{key:'original',state:'ready' as const,revision:file.objectHash}]:[]),
      ...(file.objectHash?[{key:'extracted-text',state:['waiting','running'].includes(job?.state??'waiting')?'pending' as const:['blocked','failed'].includes(job?.state??'')?'failed' as const:chunks.length?'ready' as const:'unavailable' as const,...(job?.error?{reason:job.error}:{})}]:[]),
    ];
    const start=r.provenance?.calendar?.start??sourceContentTime(r),end=r.provenance?.calendar?.end??start;
    return {id:materialId(g.sourceId,g.externalId),kind:r.source==='file'?'mote.file':`mote.${r.source}`,schemaVersion:1,
      title:r.windowTitle||r.appName||r.source,origin:origin(g.sourceId,g.externalId,[r],{firstAt:iso(start),lastAt:iso(end)}),
      blocks:body.blocks,members:body.members,coverage:body.coverage(state,reason),artifacts,fidelity:body.fidelity('derived',limitations),
      retention:{original:!!file.objectHash||attachments.length>0||!reference?'retained':'unavailable',policy:'keep'}};
  },
};

const codingSession:MaterialOrganizer={
  id:'mote.coding-session',version:'2',slot:'coding-session',
  select:r=>{const c=r.provenance?.document?.coding;return c?{sourceId:r.provenance!.sourceId,provider:c.provider,projectKey:c.projectKey,sessionId:c.sessionId}:undefined;},
  identity:g=>materialId(g.sourceId,codingExternalId(g)),
  build(reader,g){
    const {records,truncated}=reader.codingSession();
    if(!records.length)return;
    const externalId=codingExternalId(g),body=new MaterialBody();
    // Consume newest first when the session exceeds one bounded revision. Display remains chronological.
    for(const [index,r] of records.entries()){
      if(body.full){body.limitations.add('session_text_limit');break;}
      if(!body.addMember(r))break;
      body.text(`event:${r.id}`,captureText(r),r.id,'json',{newestIndex:index});
    }
    const order=new Map(records.map((r,index)=>[r.id,index]));
    body.blocks.sort((a,b)=>(order.get(b.memberIds[0]!)??0)-(order.get(a.memberIds[0]!)??0));
    body.members.reverse();
    if(truncated)body.limitations.add('session_member_limit');
    const byId=new Map(records.map(r=>[r.id,r]));
    const included=body.members.map(m=>byId.get(m.id)!).filter(Boolean);
    const project=codingProjectContext(included.map(r=>r.provenance!.document!.coding!));
    return {id:materialId(g.sourceId,externalId),kind:'mote.coding-session',schemaVersion:1,
      title:project.projectName??g.sessionId,
      origin:origin(g.sourceId,externalId,included,{provider:g.provider,projectKey:g.projectKey,sessionId:g.sessionId,...project}),
      blocks:body.blocks,members:body.members,coverage:body.coverage(),fidelity:body.fidelity('derived',['metadata_projected']),retention:{original:'retained',policy:'keep'}};
  },
};

const screenGroup:MaterialOrganizer={
  id:'mote.screen-segment',version:'1',slot:'screen-segment',
  select:r=>{if(r.source!=='screen'&&r.source!=='ui_page')return;const row=(r as CaptureRecord&{groupKey?:string}).groupKey;return {deviceId:r.deviceId,groupKey:row??''};},
  identity:g=>g.groupKey?materialId(sourceKey('screen',g.deviceId),g.groupKey):undefined,
  build(reader,g){
    if(!g.groupKey)return;
    const {records,truncated}=reader.screenGroup();
    if(!records.length)return;
    const sourceId=sourceKey('screen',g.deviceId),externalId=g.groupKey,body=new MaterialBody();
    for(const r of records)body.addMember(r);
    if(truncated)body.limitations.add('screen_group_member_limit');
    const frameIndices=[...new Set([0,Math.floor((records.length-1)/2),records.length-1])];
    const durationMs=records.reduce((sum,r)=>sum+Math.max(0,r.durationMs??0),0);
    const applications=new Map<string,{appId:string;appName:string;samples:number;durationMs:number}>();
    const distinctOcr=new Map<string,string>();
    for(const r of records){
      const appId=r.appId??'',appName=r.appName??'',key=JSON.stringify([appId,appName]);
      const item=applications.get(key)??{appId,appName,samples:0,durationMs:0};
      item.samples++;item.durationMs+=Math.max(0,r.durationMs??0);applications.set(key,item);
      const ocr=(r.ocrText??'').trim().replace(/\s+/g,' ');
      if(ocr&&!distinctOcr.has(ocr))distinctOcr.set(ocr,ocr);
    }
    const apps=[...applications.values()].sort((a,b)=>b.durationMs-a.durationMs||a.appId.localeCompare(b.appId));
    body.text('overview',JSON.stringify({sampleCount:records.length,firstAt:sourceContentTime(records[0]!),lastAt:sourceContentTime(records.at(-1)!),
      observedDurationMs:durationMs,applicationCount:apps.length,applications:apps.slice(0,8),distinctOcrCount:distinctOcr.size,
      keyframeCount:frameIndices.length,originalsRetained:true}),records[0]!.id,'json');
    for(const [index,position] of frameIndices.entries()){
      const r=records[position]!;
      body.text(`keyframe:${index}`,JSON.stringify({capturedAt:r.capturedAt,appId:r.appId,appName:r.appName,
        ocrText:(r.ocrText??'').trim().slice(0,800),hasImage:Boolean(r.blobHash)}),r.id,'json',{capturedAt:r.capturedAt});
    }
    body.text('ocr-distinct',JSON.stringify({items:[...distinctOcr.values()].slice(0,12).map(text=>text.slice(0,500)),
      total:distinctOcr.size,truncated:distinctOcr.size>12}),records[0]!.id,'json');
    const ocrPending=records.some(r=>r.ocr?.status==='pending'),ocrFailed=records.some(r=>r.ocr?.status==='failed');
    return {id:materialId(sourceId,externalId),kind:'mote.screen-segment',schemaVersion:1,title:records.at(-1)?.appName||'Screen',
      origin:origin(sourceId,externalId,records),blocks:body.blocks,members:body.members,
      coverage:body.coverage(ocrFailed?'partial':ocrPending?'pending':'complete',ocrFailed?'ocr_failed':ocrPending?'ocr_pending':undefined),
      artifacts:[{key:'screen-observations',state:'ready'},{key:'ocr',state:ocrFailed?'failed':ocrPending?'pending':'ready',...(ocrFailed?{reason:'ocr_failed'}:ocrPending?{reason:'ocr_pending'}:{})}],
      fidelity:body.fidelity('derived',['metadata_projected','screen_samples_compressed']),retention:{original:'retained',policy:'keep'}};
  },
};

const stateSeries:MaterialOrganizer={
  id:'mote.state-series',version:'1',slot:'state-series',
  select:r=>r.stateSeries||['activity','media','device_event'].includes(r.source)?{deviceId:r.deviceId,captureId:r.id}:undefined,
  identity:g=>materialId(sourceKey('state',g.deviceId),g.captureId),
  build(reader,g){
    const r=reader.capture();if(!r)return;
    const sourceId=sourceKey('state',r.deviceId),body=new MaterialBody();body.addMember(r);
    body.text('samples',captureText(r),r.id,'json');
    return {id:materialId(sourceId,r.id),kind:'mote.state-series',schemaVersion:1,title:r.appName||r.source,
      origin:origin(sourceId,r.id,[r],{firstAt:iso(r.capturedAt),lastAt:iso(r.stateSeries?.samples.at(-1)?.at??r.capturedAt)}),
      blocks:body.blocks,members:body.members,coverage:body.coverage(),artifacts:[{key:'state-series',state:'ready'}],fidelity:body.fidelity('derived',['metadata_projected']),retention:{original:'retained',policy:'keep'}};
  },
};

const authored:MaterialOrganizer={
  id:'mote.authored-record',version:'1',slot:'authored-record',
  select:r=>r.provenance||['screen','ui_page','activity','media','device_event'].includes(r.source)?undefined:{deviceId:r.deviceId,captureId:r.id},
  identity:g=>materialId(sourceKey('authored',g.deviceId),g.captureId),
  build(reader,g){
    const r=reader.capture();if(!r)return;
    const sourceId=sourceKey('authored',r.deviceId),body=new MaterialBody();body.addMember(r);
    body.text('record',captureText(r),r.id,'json');
    const file=reader.file(r.id);if(!file)return;
    for(const attachment of file.attachments)body.asset(`attachment:${attachment.id}`,attachment.hash,attachment.mimeType,r.id,{fileId:attachment.id,...(attachment.relativePath?{relativePath:attachment.relativePath}:{})});
    if(file.attachmentsTruncated)body.limitations.add('attachment_limit');
    return {id:materialId(sourceId,r.id),kind:`mote.${r.source}`,schemaVersion:1,title:r.windowTitle||r.appName||r.source,
      origin:origin(sourceId,r.id,[r]),blocks:body.blocks,members:body.members,coverage:body.coverage(),artifacts:[{key:'authored-record',state:'ready'}],fidelity:body.fidelity('derived',['metadata_projected']),retention:{original:'retained',policy:'keep'}};
  },
};

export class MaterialOrganizerRegistry {
  private organizers=new Map<string,MaterialOrganizer>();
  constructor(private readonly onRegister?:(organizer:MaterialOrganizer)=>void){}
  register(organizer:MaterialOrganizer){
    if(!/^[a-z0-9.-]+$/.test(organizer.id)||!organizer.version||this.organizers.has(organizer.id)||
      organizer.slot!==undefined&&!/^[a-z0-9.-]+$/.test(organizer.slot)||
      organizer.priority!==undefined&&(!Number.isSafeInteger(organizer.priority)||Math.abs(organizer.priority)>1000))throw Error('Invalid or duplicate material organizer');
    this.organizers.set(organizer.id,organizer);
    try{this.onRegister?.(organizer);}catch(error){this.organizers.delete(organizer.id);throw error;}
    return ()=>{if(this.organizers.get(organizer.id)===organizer)this.organizers.delete(organizer.id);};
  }
  get(id:string){return this.organizers.get(id);}
  select(record:CaptureRecord){
    const candidates=[...this.organizers.values()].flatMap(organizer=>{const group=organizer.select(record);return group?[{organizer,group:canonicalGroup(group)}]:[]});
    candidates.sort((a,b)=>(b.organizer.priority??0)-(a.organizer.priority??0)||a.organizer.id.localeCompare(b.organizer.id));
    const exclusive=candidates.filter(candidate=>candidate.organizer.exclusive);
    if(exclusive.length){if(exclusive.length>1&&(exclusive[0].organizer.priority??0)===(exclusive[1].organizer.priority??0))throw Error('Ambiguous exclusive material organizers');return [exclusive[0]];}
    const selected=new Map<string,(typeof candidates)[number]>();
    for(const candidate of candidates){
      const slot=candidate.organizer.slot??candidate.organizer.id,prior=selected.get(slot);
      if(prior){if((prior.organizer.priority??0)===(candidate.organizer.priority??0))throw Error(`Ambiguous material organizer slot: ${slot}`);continue;}
      selected.set(slot,candidate);
    }
    return [...selected.values()];
  }
  list(){return [...this.organizers.values()].map(({id,version,slot,priority,exclusive})=>({id,version,slot:slot??id,priority:priority??0,exclusive:Boolean(exclusive)}));}
}

type OrganizerJobInput=Record<string,unknown>&{groupKey:string;organizerId:string;version:string;group:Record<string,string>;materialId:string;generation:number;checkpoint:number;active:boolean;recipe?:SourceItemRecipePin};
type OrganizerResult={draft:MaterialDraft|undefined;calls:ReaderCall[];pinnedSourceHead?:string};
type OrganizerGroupRow={group_key:string;organizer_id:string;version:string;group_json:string;material_id:string;generation:number;checkpoint:number;active:number};
const ORGANIZER_STEP='material.organizer';

/** Cursors discover work; the shared execution engine alone commits materials. */
export class MaterialOrganizerRuntime {
  readonly registry:MaterialOrganizerRegistry;
  readonly executor:ExecutionEngine;
  readonly sourceItemRecipes:SourceItemRecipeCatalog;
  private readonly failures=new Map<string,unknown>();
  private running=false;
  constructor(private readonly store:Store,readonly materials:MaterialStore,additionalOrganizers:MaterialOrganizer[]=[],executor?:ExecutionEngine,private readonly memoryWork?:MaterialMemoryWork){
    new ArchivedFileStore(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS material_organizer_inputs(capture_id TEXT NOT NULL,organizer_id TEXT NOT NULL,group_json TEXT NOT NULL,material_id TEXT,PRIMARY KEY(capture_id,organizer_id));
      CREATE TABLE IF NOT EXISTS material_organizer_backfills(organizer_id TEXT PRIMARY KEY,version TEXT NOT NULL,cursor_rowid INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS material_organizer_groups(group_key TEXT PRIMARY KEY,organizer_id TEXT NOT NULL,version TEXT NOT NULL,group_json TEXT NOT NULL,material_id TEXT NOT NULL,generation INTEGER NOT NULL,checkpoint INTEGER NOT NULL,active INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS material_organizer_group_material ON material_organizer_groups(material_id,active);
      CREATE TRIGGER IF NOT EXISTS material_capture_json_change AFTER UPDATE OF json ON captures WHEN new.json!=old.json BEGIN
        INSERT INTO changes(id,operation,changed_at) VALUES(new.id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS material_attachment_add AFTER INSERT ON capture_files BEGIN
        INSERT INTO changes(id,operation,changed_at) VALUES(new.capture_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS material_attachment_remove AFTER DELETE ON capture_files BEGIN
        INSERT INTO changes(id,operation,changed_at) VALUES(old.capture_id,'supersede',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS material_file_job_change AFTER UPDATE OF state ON file_jobs WHEN new.state!=old.state BEGIN
        INSERT INTO changes(id,operation,changed_at) VALUES(new.capture_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS material_file_artifact_add AFTER INSERT ON file_artifacts BEGIN
        INSERT INTO changes(id,operation,changed_at) VALUES(new.capture_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS material_file_artifact_change AFTER UPDATE OF current,json ON file_artifacts WHEN new.current!=old.current OR new.json!=old.json BEGIN
        INSERT INTO changes(id,operation,changed_at) VALUES(new.capture_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS material_file_chunk_add AFTER INSERT ON file_chunks BEGIN
        INSERT INTO changes(id,operation,changed_at) VALUES(new.capture_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS material_file_chunk_change AFTER UPDATE OF text,start_ms,end_ms,artifact_id,metadata ON file_chunks BEGIN
        INSERT INTO changes(id,operation,changed_at) VALUES(new.capture_id,'upsert',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS material_file_chunk_remove AFTER DELETE ON file_chunks BEGIN
        INSERT INTO changes(id,operation,changed_at) VALUES(old.capture_id,'supersede',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;`);
    if(!(store.db.prepare('PRAGMA table_info(material_organizer_inputs)').all() as {name:string}[]).some(row=>row.name==='material_id'))store.db.exec('ALTER TABLE material_organizer_inputs ADD COLUMN material_id TEXT');
    this.sourceItemRecipes=new SourceItemRecipeCatalog(store,sourceItem.version);
    this.executor=executor??new ExecutionEngine(store);
    this.executor.register({kind:ORGANIZER_STEP,pool:'material-organizer',concurrency:()=>8,
      resourceKeys:step=>[`material:${(step.input as OrganizerJobInput).materialId}`],
      validate:step=>this.valid(step),
      execute:async(step,signal)=>{try{
        signal.throwIfAborted();const input=step.input as OrganizerJobInput;
        if(!input.active)return {draft:undefined,calls:[]} satisfies OrganizerResult;
        const organizer=this.registry.get(input.organizerId);
        if(!organizer||organizer.version!==input.version)throw new ExecutionFailure('stale','organizer_changed');
        const pinnedSourceHead=input.group.sourceId&&input.group.externalId?
          await this.readSourceHead(input.group.sourceId,input.group.externalId,signal):undefined;
        const {reader,calls}=recordingReader(store,input.group,pinnedSourceHead),draft=organizer.build(reader,input.group);
        signal.throwIfAborted();
        if(draft&&draft.id!==input.materialId)throw Error('Ambiguous material organizer identity');
        return {draft,calls,...(pinnedSourceHead?{pinnedSourceHead}:{})} satisfies OrganizerResult;
      }catch(error){this.failures.set(step.id,error);throw error;}},
      commit:(step,result)=>{try{
        const input=step.input as OrganizerJobInput,prepared=result as OrganizerResult;
        if(!this.valid(step)||!readerStillCurrent(store,input.group,prepared.calls))throw new ExecutionFailure('stale','input_changed');
        if(prepared.pinnedSourceHead&&input.group.sourceId&&input.group.externalId){
          const raw=new CaptureRawReader(store,{mayReadSource:id=>id===input.group.sourceId,
            mayReadGroup:(id,external)=>id===input.group.sourceId&&external===input.group.externalId,mayListKind:()=>false});
          if(raw.refForItem(input.group.sourceId,input.group.externalId)!==captureRawRef(prepared.pinnedSourceHead))
            throw new ExecutionFailure('stale','source_head_changed');
        }
        const other=store.db.prepare('SELECT 1 FROM material_organizer_groups WHERE material_id=? AND group_key!=? AND active=1 LIMIT 1').get(input.materialId,input.groupKey);
        if(input.active&&other)throw Error('Ambiguous material organizer identity');
        if(prepared.draft){
          const prior=materials.get(input.materialId);
          if(!prior&&(store.db.prepare('SELECT retired FROM material_heads WHERE id=?').get(input.materialId) as {retired:number}|undefined)?.retired)materials.forget(input.materialId);
          materials.publish(prepared.draft,{expectedRevision:prior?.revision??null});
          materials.setSearchable(input.materialId,true);
          if(input.organizerId===sourceItem.id){
            const required=prepared.draft.artifacts?.some(item=>item.key==='original')?'extracted-text':'source-body';
            const state=prepared.draft.artifacts?.find(item=>item.key===required)?.state;
            if(state==='unavailable'||state==='failed')this.memoryWork?.withdraw(input.materialId);
            else this.memoryWork?.observe(input.materialId,[required]);
          }
        }else if(!other){
          const prior=materials.get(input.materialId);if(prior)materials.retire(input.materialId,{expectedRevision:prior.revision});
          this.memoryWork?.withdraw(input.materialId);
        }
      }catch(error){this.failures.set(step.id,error);throw error;}},
      classify:error=>error instanceof ExecutionFailure?error:new ExecutionFailure('permanent','organizer_failed'),
    });
    this.registry=new MaterialOrganizerRegistry(organizer=>{
      const fresh=this.cursor()===0;
      store.db.prepare(`INSERT INTO material_organizer_backfills(organizer_id,version,cursor_rowid,complete) VALUES(?,?,0,?)
        ON CONFLICT(organizer_id) DO UPDATE SET version=excluded.version,
          cursor_rowid=CASE WHEN version=excluded.version THEN cursor_rowid ELSE 0 END,
          complete=CASE WHEN version=excluded.version THEN complete ELSE excluded.complete END`).run(organizer.id,organizer.version,fresh?1:0);
      this.retryFailed(organizer.id);
    });
    for(const organizer of [sourceItem,codingSession,screenGroup,stateSeries,authored])this.registry.register(organizer);
    for(const organizer of additionalOrganizers)this.registry.register(organizer);
  }
  private cursor(){return Number(this.store.db.prepare("SELECT value FROM settings WHERE key='material-organizer-cursor'").get()?.value??0);}
  private selectedFor(captureId:string){
    const record=capture(this.store,captureId);
    if(!record||!current(this.store,record.id))return [];
    return this.registry.select(record).map(({organizer,group})=>{
      if(organizer===screenGroup){const row=this.store.db.prepare('SELECT group_key FROM context_observations WHERE id=?').get(record.id) as {group_key:string}|undefined;group.groupKey=row?.group_key??'';}
      return {organizer,group:canonicalGroup(group)};
    });
  }
  private async readSourceHead(sourceId:string,externalId:string,signal:AbortSignal){
    const raw=new CaptureRawReader(this.store,{
      mayReadSource:id=>id===sourceId,
      mayReadGroup:(id,external)=>id===sourceId&&external===externalId,
      mayListKind:()=>false,
    });
    const ref=raw.refForItem(sourceId,externalId);
    if(!ref)throw new ExecutionFailure('stale','source_head_unavailable');
    const parts:Buffer[]=[];let offset=0,totalBytes:number|undefined;
    do{
      signal.throwIfAborted();
      const page=await raw.read(ref,{offset,length:MAX_RAW_READ_BYTES});
      if(page.status!=='available'||page.offset!==offset||page.totalBytes>2*1024*1024||
        totalBytes!==undefined&&page.totalBytes!==totalBytes||page.bytes.length===0)throw new ExecutionFailure('stale','source_head_changed');
      parts.push(Buffer.from(page.bytes));offset+=page.bytes.length;totalBytes=page.totalBytes;
      if(page.nextOffset===null)break;
      if(page.nextOffset!==offset)throw new ExecutionFailure('stale','source_head_changed');
    }while(offset<totalBytes);
    let item:SourceItemRecord;
    try{item=JSON.parse(Buffer.concat(parts).toString()) as SourceItemRecord;}catch{throw new ExecutionFailure('stale','source_head_invalid');}
    if(item.sourceId!==sourceId||item.externalId!==externalId||!item.current||ref!==captureRawRef(item.captureId)||
      !this.store.isCurrentEvidence(item.captureId)||capture(this.store,item.captureId)?.provenance?.revision!==item.revision)
      throw new ExecutionFailure('stale','source_head_changed');
    return item.captureId;
  }
  private retryFailed(organizerId:string){
    for(const row of this.store.db.prepare("SELECT id FROM execution_steps WHERE kind=? AND state='failed'").all(ORGANIZER_STEP) as {id:string}[]){
      const step=this.executor.get(row.id),input=step?.input as OrganizerJobInput|undefined;
      if(input?.organizerId===organizerId&&this.valid(step!)){this.failures.delete(row.id);this.executor.retry(row.id);}
    }
  }
  private retryReadyRetirements(){
    const ids:string[]=[];
    for(const row of this.store.db.prepare(`SELECT e.id FROM execution_steps e WHERE e.kind=? AND e.state='blocked' AND e.error='dependency_failed'
      AND NOT EXISTS(SELECT 1 FROM execution_dependencies d JOIN execution_steps parent ON parent.id=d.dependency_id
        WHERE d.step_id=e.id AND parent.state!='succeeded')`).all(ORGANIZER_STEP) as {id:string}[]){
      const step=this.executor.get(row.id),input=step?.input as OrganizerJobInput|undefined;
      if(step&&input&&!input.active&&this.valid(step)){this.failures.delete(row.id);this.executor.retry(row.id);ids.push(row.id);}
    }
    return ids;
  }
  private valid(step:ExecutionStep){
    const input=step.input as OrganizerJobInput,db=this.store.db;
    if(!input||!input.groupKey||!input.materialId||!Number.isSafeInteger(input.generation)||!Number.isSafeInteger(input.checkpoint))return false;
    const row=db.prepare('SELECT * FROM material_organizer_groups WHERE group_key=?').get(input.groupKey) as OrganizerGroupRow|undefined;
    if(!row||row.organizer_id!==input.organizerId||row.version!==input.version||row.group_json!==JSON.stringify(input.group)||
      row.material_id!==input.materialId||row.generation!==input.generation||row.checkpoint!==input.checkpoint||Boolean(row.active)!==input.active)return false;
    const organizer=this.registry.get(input.organizerId);
    if(input.active&&(!organizer||organizer.version!==input.version||organizer.identity(input.group)!==input.materialId))return false;
    if(input.active&&input.organizerId===sourceItem.id){
      if(!input.group.sourceId||!input.recipe)return false;
      try{
        const pin=this.sourceItemRecipes.resolveForSourceId(input.group.sourceId);
        if(pin.recipeId!==input.recipe.recipeId||pin.version!==input.recipe.version||pin.sourceKind!==input.recipe.sourceKind||
          pin.definitionFingerprint!==input.recipe.definitionFingerprint||pin.configFingerprint!==input.recipe.configFingerprint)return false;
      }catch{return false;}
    }
    const mapped=db.prepare('SELECT capture_id FROM material_organizer_inputs WHERE organizer_id=? AND group_json=?').all(input.organizerId,row.group_json) as {capture_id:string}[];
    let selected=0;
    for(const {capture_id:id} of mapped){
      const matches=this.selectedFor(id).some(value=>value.organizer.id===input.organizerId&&JSON.stringify(value.group)===row.group_json);
      if(matches)selected++;else return false;
    }
    if(Boolean(selected)!==input.active)return false;
    // A new capture, tombstone or file artifact may arrive before discovery.
    // Reject only changes that could alter this group; unrelated writes proceed.
    const pending=db.prepare('SELECT DISTINCT id FROM changes WHERE seq>?').all(input.checkpoint) as {id:string}[];
    for(const {id} of pending){
      if(db.prepare('SELECT 1 FROM material_organizer_inputs WHERE capture_id=? AND organizer_id=? AND group_json=?').get(id,input.organizerId,row.group_json))return false;
      if(this.selectedFor(id).some(value=>value.organizer.id===input.organizerId&&JSON.stringify(value.group)===row.group_json))return false;
    }
    return true;
  }
  status(){
    const cursor=this.cursor();
    const pendingChanges=(this.store.db.prepare('SELECT COUNT(*) n FROM changes WHERE seq>?').get(cursor) as {n:number}).n;
    const pendingSteps=(this.store.db.prepare("SELECT COUNT(*) n FROM execution_steps WHERE kind=? AND state IN ('waiting','running','blocked','failed')").get(ORGANIZER_STEP) as {n:number}).n;
    const backfills=this.store.db.prepare('SELECT organizer_id id,version,cursor_rowid cursorRowid,complete FROM material_organizer_backfills ORDER BY organizer_id').all() as {id:string;version:string;cursorRowid:number;complete:number}[];
    return {cursor,pendingChanges,pendingSteps,organizers:this.registry.list(),backfills:backfills.map(row=>({...row,complete:Boolean(row.complete)}))};
  }
  private discover(limit:number){
    const db=this.store.db,batchSize=Math.max(1,Math.min(limit,500)),stepIds:string[]=[];
    db.exec('BEGIN IMMEDIATE');
    try{
      const rows=db.prepare('SELECT seq,id FROM changes WHERE seq>? ORDER BY seq LIMIT ?').all(this.cursor(),batchSize) as {seq:number;id:string}[];
      const backfill=(db.prepare('SELECT organizer_id id,version,cursor_rowid cursorRowid FROM material_organizer_backfills WHERE complete=0 ORDER BY organizer_id').all() as {id:string;version:string;cursorRowid:number}[])
        .find(row=>this.registry.get(row.id)?.version===row.version);
      const backfillRows=backfill?db.prepare('SELECT rowid,id FROM captures WHERE rowid>? ORDER BY rowid LIMIT ?').all(backfill.cursorRowid,batchSize) as {rowid:number;id:string}[]:[];
      const changedIds=[...new Set([...rows.map(row=>row.id),...backfillRows.map(row=>row.id)])];
      const touched=new Map<string,{organizerId:string;group:Record<string,string>;priorMaterialId:string|null}>();
      const replacements=new Map<string,Set<string>>();
      const touch=(organizerId:string,group:Record<string,string>,priorMaterialId:string|null=null)=>{
        const key=digest([organizerId,group]),prior=touched.get(key);
        touched.set(key,{organizerId,group,priorMaterialId:prior?.priorMaterialId??priorMaterialId});
      };
      for(const captureId of changedIds){
        const previous=db.prepare('SELECT organizer_id,group_json,material_id FROM material_organizer_inputs WHERE capture_id=?').all(captureId) as {organizer_id:string;group_json:string;material_id:string|null}[];
        for(const row of previous)touch(row.organizer_id,canonicalGroup(JSON.parse(row.group_json) as Record<string,string>),row.material_id);
        const selections=this.selectedFor(captureId);
        for(const old of previous){
          const oldKey=digest([old.organizer_id,canonicalGroup(JSON.parse(old.group_json) as Record<string,string>)]);
          for(const {organizer,group} of selections){
            const newKey=digest([organizer.id,group]);
            if(newKey===oldKey||!old.material_id||organizer.identity(group)===old.material_id)continue;
            const next=replacements.get(oldKey)??new Set<string>();next.add(newKey);replacements.set(oldKey,next);
          }
        }
        db.prepare('DELETE FROM material_organizer_inputs WHERE capture_id=?').run(captureId);
        for(const {organizer,group} of selections){
          touch(organizer.id,group);
          db.prepare('INSERT INTO material_organizer_inputs(capture_id,organizer_id,group_json,material_id) VALUES(?,?,?,?)').run(captureId,organizer.id,JSON.stringify(group),organizer.identity(group)??null);
        }
      }
      // Pin only the discovered change range. Later rows in this same batch
      // backlog must still invalidate a group before its fenced commit.
      const checkpoint=rows.at(-1)?.seq??this.cursor();
      const prepared:{key:string;input:OrganizerJobInput;id:string}[]=[];
      for(const [key,{organizerId,group,priorMaterialId}] of touched){
        const organizer=this.registry.get(organizerId),prior=db.prepare('SELECT * FROM material_organizer_groups WHERE group_key=?').get(key) as OrganizerGroupRow|undefined;
        const materialId=organizer?.identity(group)??priorMaterialId??prior?.material_id;
        if(!materialId)continue;
        if(priorMaterialId&&priorMaterialId!==materialId&&prior?.version===organizer?.version)throw Error('Material organizer identity changed without a version change');
        const groupJson=JSON.stringify(group),mapped=db.prepare('SELECT capture_id FROM material_organizer_inputs WHERE organizer_id=? AND group_json=?').all(organizerId,groupJson) as {capture_id:string}[];
        const active=Boolean(organizer&&mapped.some(row=>this.selectedFor(row.capture_id).some(value=>value.organizer.id===organizerId&&JSON.stringify(value.group)===groupJson)));
        const version=organizer?.version??prior?.version??'retired',generation=(prior?.generation??0)+1;
        db.prepare(`INSERT INTO material_organizer_groups(group_key,organizer_id,version,group_json,material_id,generation,checkpoint,active) VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(group_key) DO UPDATE SET version=excluded.version,group_json=excluded.group_json,material_id=excluded.material_id,
            generation=excluded.generation,checkpoint=excluded.checkpoint,active=excluded.active`).run(key,organizerId,version,groupJson,materialId,generation,checkpoint,Number(active));
        const recipe=active&&organizerId===sourceItem.id?this.sourceItemRecipes.resolveForSourceId(group.sourceId):undefined;
        const input:OrganizerJobInput={groupKey:key,organizerId,version,group,materialId,generation,checkpoint,active,...(recipe?{recipe}:{})};
        prepared.push({key,input,id:digest([ORGANIZER_STEP,key,generation])});
      }
      const ids=new Map(prepared.map(item=>[item.key,item.id]));
      for(const item of prepared.filter(item=>item.input.active))stepIds.push(this.executor.enqueue(`material-organizer:${item.key}`,ORGANIZER_STEP,item.input,{id:item.id}));
      for(const item of prepared.filter(item=>!item.input.active)){
        const dependencies=[...(replacements.get(item.key)??[])].flatMap(key=>ids.has(key)?[ids.get(key)!]:[]);
        stepIds.push(this.executor.enqueue(`material-organizer:${item.key}`,ORGANIZER_STEP,item.input,{id:item.id,dependencies}));
      }
      if(rows.length)db.prepare("INSERT INTO settings(key,value) VALUES('material-organizer-cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(rows.at(-1)!.seq));
      if(backfill)db.prepare('UPDATE material_organizer_backfills SET cursor_rowid=?,complete=? WHERE organizer_id=? AND version=?').run(
        backfillRows.at(-1)?.rowid??backfill.cursorRowid,backfillRows.length<batchSize?1:0,backfill.id,backfill.version);
      db.exec('COMMIT');return {count:changedIds.length,stepIds};
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  async tick(limit=100){
    if(this.running)return 0;this.running=true;
    try{
      const {count,stepIds}=this.discover(limit);
      const waiting=this.store.db.prepare("SELECT id FROM execution_steps WHERE kind=? AND state='waiting' AND available_at<=?").all(ORGANIZER_STEP,Date.now()) as {id:string}[];
      await this.executor.drain([...new Set([...stepIds,...waiting.map(row=>row.id)])]);
      await this.executor.drain(this.retryReadyRetirements());
      for(const id of stepIds){const failure=this.failures.get(id);if(failure)throw failure;}
      return count;
    }finally{this.running=false;}
  }
}
