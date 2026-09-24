import {createHash} from 'node:crypto';
import {sourceContentTime,type CaptureRecord} from '@mote/shared';
import {materialId,MaterialStore,type MaterialDraft} from './materials.js';
import {ArchivedFileStore} from './archived-files.js';
import type {Store} from './store.js';

/** Organizers select declared source shapes, never infer a topic or user intent. */
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
  build(store:Store,group:Record<string,string>):MaterialDraft|undefined;
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
  build(store,g){
    const row=store.db.prepare('SELECT h.capture_id,h.deleted FROM source_heads h WHERE h.source_id=? AND h.external_id=?').get(g.sourceId,g.externalId) as {capture_id:string;deleted:number}|undefined;
    if(!row||row.deleted)return;
    const r=capture(store,row.capture_id);if(!r)return;
    const file=store.db.prepare('SELECT object_hash FROM file_versions WHERE capture_id=?').get(r.id) as {object_hash:string|null}|undefined;
    const attachments=store.db.prepare('SELECT f.id,f.hash,f.json FROM capture_files c JOIN archived_files f ON f.id=c.file_id WHERE c.capture_id=? ORDER BY f.id').all(r.id) as {id:string;hash:string;json:string}[];
    const chunks=store.db.prepare(`SELECT c.id,c.text,c.start_ms,c.end_ms,a.kind,a.json artifact_json FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id
      WHERE c.capture_id=? AND a.current=1 AND a.kind IN ('text','image-text','transcript','dialogue','corrected-dialogue')
      AND NOT EXISTS(SELECT 1 FROM file_artifacts preferred WHERE preferred.capture_id=a.capture_id AND preferred.current=1
        AND ((preferred.kind='corrected-dialogue' AND a.kind!='corrected-dialogue')
          OR (preferred.kind='dialogue' AND a.kind IN ('transcript','text','image-text'))))
      ORDER BY c.start_ms,c.rowid LIMIT 2001`).all(r.id) as {id:string;text:string;start_ms:number|null;end_ms:number|null;kind:string;artifact_json:string}[];
    const job=store.db.prepare('SELECT state,error FROM file_jobs WHERE capture_id=?').get(r.id) as {state:string;error:string|null}|undefined;
    const body=new MaterialBody();body.addMember(r);
    body.text('source-record',captureText(r),r.id,'json');
    for(const c of chunks){
      body.text(`chunk:${c.id}`,c.text,r.id,c.kind==='transcript'||c.kind==='dialogue'||c.kind==='corrected-dialogue'?'transcript':'plain',
        {chunkId:c.id,...(c.start_ms===null?{}:{startMs:c.start_ms,endMs:c.end_ms})});
    }
    if(file?.object_hash)body.asset('original',file.object_hash,r.provenance?.mimeType??'application/octet-stream',r.id);
    for(const attachment of attachments){
      const metadata=JSON.parse(attachment.json) as {mimeType?:string;relativePath?:string};
      body.asset(`attachment:${attachment.id}`,attachment.hash,metadata.mimeType??'application/octet-stream',r.id,
        {fileId:attachment.id,...(metadata.relativePath?{relativePath:metadata.relativePath}:{})});
    }
    const artifact=chunks[0]?JSON.parse(chunks[0].artifact_json) as {complete?:boolean;coverage?:string}:undefined;
    let state:'complete'|'pending'|'partial'='complete',reason:string|undefined;
    if(file?.object_hash){
      if(['waiting','running'].includes(job?.state??'waiting')){state='pending';reason='processing_pending';}
      else if(job?.state==='blocked'||job?.state==='failed'){state='partial';reason=`processing_${job.state}`;}
      else if(job?.state==='succeeded'&&!artifact){state='partial';reason='processed_body_missing';}
      else if(artifact&&(artifact.complete===false||artifact.coverage==='partial')){state='partial';reason='processor_partial';}
    }
    if(r.provenance?.document?.fileIndex&&r.provenance.document.fileIndex.coverage!=='full'){state='partial';reason='source_index_partial';}
    const reference=r.provenance?.layer==='reference'||r.provenance?.layer==='derived';
    const limitations=['metadata_projected',...(reference?['original_body_not_collected']:[]),...(state==='partial'?[reason??'processing_incomplete']:[])];
    const start=r.provenance?.calendar?.start??sourceContentTime(r),end=r.provenance?.calendar?.end??start;
    return {id:materialId(g.sourceId,g.externalId),kind:r.source==='file'?'mote.file':`mote.${r.source}`,schemaVersion:1,
      title:r.windowTitle||r.appName||r.source,origin:origin(g.sourceId,g.externalId,[r],{firstAt:iso(start),lastAt:iso(end)}),
      blocks:body.blocks,members:body.members,coverage:body.coverage(state,reason),fidelity:body.fidelity('derived',limitations),
      retention:{original:!!file?.object_hash||attachments.length>0||!reference?'retained':'unavailable',policy:'keep'}};
  },
};

const codingSession:MaterialOrganizer={
  id:'mote.coding-session',version:'1',slot:'coding-session',
  select:r=>{const c=r.provenance?.document?.coding;return c?{sourceId:r.provenance!.sourceId,provider:c.provider,projectKey:c.projectKey,sessionId:c.sessionId}:undefined;},
  identity:g=>materialId(g.sourceId,codingExternalId(g)),
  build(store,g){
    const rows=store.db.prepare(`SELECT c.id FROM captures c JOIN source_heads h ON h.capture_id=c.id
      WHERE h.source_id=? AND h.deleted=0 AND json_extract(c.json,'$.provenance.document.coding.provider')=?
      AND json_extract(c.json,'$.provenance.document.coding.projectKey')=?
      AND json_extract(c.json,'$.provenance.document.coding.sessionId')=?
      ORDER BY c.captured_at DESC,c.id DESC LIMIT 2001`).all(g.sourceId,g.provider,g.projectKey,g.sessionId) as {id:string}[];
    const records=rows.slice(0,MAX_MEMBERS).map(row=>capture(store,row.id)).filter((r):r is CaptureRecord=>Boolean(r));
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
    if(rows.length>MAX_MEMBERS)body.limitations.add('session_member_limit');
    const byId=new Map(records.map(r=>[r.id,r]));
    const included=body.members.map(m=>byId.get(m.id)!).filter(Boolean);
    return {id:materialId(g.sourceId,externalId),kind:'mote.coding-session',schemaVersion:1,
      title:records[0]?.provenance?.document?.coding?.projectName??g.projectKey,
      origin:origin(g.sourceId,externalId,included,{provider:g.provider,projectKey:g.projectKey,sessionId:g.sessionId}),
      blocks:body.blocks,members:body.members,coverage:body.coverage(),fidelity:body.fidelity('derived',['metadata_projected']),retention:{original:'retained',policy:'keep'}};
  },
};

const screenGroup:MaterialOrganizer={
  id:'mote.screen-segment',version:'1',slot:'screen-segment',
  select:r=>{if(r.source!=='screen'&&r.source!=='ui_page')return;const row=(r as CaptureRecord&{groupKey?:string}).groupKey;return {deviceId:r.deviceId,groupKey:row??''};},
  identity:g=>g.groupKey?materialId(sourceKey('screen',g.deviceId),g.groupKey):undefined,
  build(store,g){
    if(!g.groupKey)return;
    const rows=store.db.prepare(`SELECT o.id FROM context_observations o JOIN captures c ON c.id=o.id WHERE o.group_key=? ORDER BY c.captured_at,o.id LIMIT 1001`).all(g.groupKey) as {id:string}[];
    const records=rows.slice(0,1000).map(row=>capture(store,row.id)).filter((r):r is CaptureRecord=>Boolean(r)&&current(store,r.id));
    if(!records.length)return;
    const sourceId=sourceKey('screen',g.deviceId),externalId=g.groupKey,body=new MaterialBody();
    for(const r of records){
      if(body.full){body.limitations.add('screen_group_limit');break;}
      if(!body.addMember(r))break;
      body.text(`capture:${r.id}`,captureText(r),r.id,'json',{capturedAt:r.capturedAt});
      if(r.blobHash)body.asset(`image:${r.id}`,r.blobHash,r.imageMime??'image/jpeg',r.id,{capturedAt:r.capturedAt});
    }
    if(rows.length>1000)body.limitations.add('screen_group_member_limit');
    const ocrPending=records.some(r=>r.ocr?.status==='pending'),ocrFailed=records.some(r=>r.ocr?.status==='failed');
    return {id:materialId(sourceId,externalId),kind:'mote.screen-segment',schemaVersion:1,title:records.at(-1)?.appName||'Screen',
      origin:origin(sourceId,externalId,records),blocks:body.blocks,members:body.members,
      coverage:body.coverage(ocrFailed?'partial':ocrPending?'pending':'complete',ocrFailed?'ocr_failed':ocrPending?'ocr_pending':undefined),
      fidelity:body.fidelity('derived',['metadata_projected']),retention:{original:'retained',policy:'keep'}};
  },
};

const stateSeries:MaterialOrganizer={
  id:'mote.state-series',version:'1',slot:'state-series',
  select:r=>r.stateSeries||['activity','media','device_event'].includes(r.source)?{deviceId:r.deviceId,captureId:r.id}:undefined,
  identity:g=>materialId(sourceKey('state',g.deviceId),g.captureId),
  build(store,g){
    const r=capture(store,g.captureId);if(!r||!current(store,r.id))return;
    const sourceId=sourceKey('state',r.deviceId),body=new MaterialBody();body.addMember(r);
    body.text('samples',captureText(r),r.id,'json');
    return {id:materialId(sourceId,r.id),kind:'mote.state-series',schemaVersion:1,title:r.appName||r.source,
      origin:origin(sourceId,r.id,[r],{firstAt:iso(r.capturedAt),lastAt:iso(r.stateSeries?.samples.at(-1)?.at??r.capturedAt)}),
      blocks:body.blocks,members:body.members,coverage:body.coverage(),fidelity:body.fidelity('derived',['metadata_projected']),retention:{original:'retained',policy:'keep'}};
  },
};

const authored:MaterialOrganizer={
  id:'mote.authored-record',version:'1',slot:'authored-record',
  select:r=>r.provenance||['screen','ui_page','activity','media','device_event'].includes(r.source)?undefined:{deviceId:r.deviceId,captureId:r.id},
  identity:g=>materialId(sourceKey('authored',g.deviceId),g.captureId),
  build(store,g){
    const r=capture(store,g.captureId);if(!r||!current(store,r.id))return;
    const sourceId=sourceKey('authored',r.deviceId),body=new MaterialBody();body.addMember(r);
    body.text('record',captureText(r),r.id,'json');
    const attachments=store.db.prepare('SELECT f.id,f.hash,f.json FROM capture_files c JOIN archived_files f ON f.id=c.file_id WHERE c.capture_id=? ORDER BY f.id').all(r.id) as {id:string;hash:string;json:string}[];
    for(const attachment of attachments){const data=JSON.parse(attachment.json) as {mimeType?:string;relativePath?:string};body.asset(`attachment:${attachment.id}`,attachment.hash,data.mimeType??'application/octet-stream',r.id,{fileId:attachment.id,...(data.relativePath?{relativePath:data.relativePath}:{})});}
    return {id:materialId(sourceId,r.id),kind:`mote.${r.source}`,schemaVersion:1,title:r.windowTitle||r.appName||r.source,
      origin:origin(sourceId,r.id,[r]),blocks:body.blocks,members:body.members,coverage:body.coverage(),fidelity:body.fidelity('derived',['metadata_projected']),retention:{original:'retained',policy:'keep'}};
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

/** Change cursor advances only after all affected materials are durably published. */
export class MaterialOrganizerRuntime {
  readonly registry:MaterialOrganizerRegistry;
  private running=false;
  constructor(readonly store:Store,readonly materials:MaterialStore,additionalOrganizers:MaterialOrganizer[]=[]){
    // Attachment tables are optional for a bare Store, but late attachments must be observable.
    new ArchivedFileStore(store);
    store.db.exec(`CREATE TABLE IF NOT EXISTS material_organizer_inputs(capture_id TEXT NOT NULL,organizer_id TEXT NOT NULL,group_json TEXT NOT NULL,material_id TEXT,PRIMARY KEY(capture_id,organizer_id));
      CREATE TABLE IF NOT EXISTS material_organizer_backfills(organizer_id TEXT PRIMARY KEY,version TEXT NOT NULL,cursor_rowid INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0);
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
    this.registry=new MaterialOrganizerRegistry(organizer=>{
      // With a fresh global cursor, existing captures are already queued in changes.
      // A later registration needs its own durable scan of older captures.
      const fresh=Number(store.db.prepare("SELECT value FROM settings WHERE key='material-organizer-cursor'").get()?.value??0)===0;
      store.db.prepare(`INSERT INTO material_organizer_backfills(organizer_id,version,cursor_rowid,complete) VALUES(?,?,0,?)
        ON CONFLICT(organizer_id) DO UPDATE SET version=excluded.version,
          cursor_rowid=CASE WHEN version=excluded.version THEN cursor_rowid ELSE 0 END,
          complete=CASE WHEN version=excluded.version THEN complete ELSE excluded.complete END`).run(organizer.id,organizer.version,fresh?1:0);
    });
    for(const organizer of [sourceItem,codingSession,screenGroup,stateSeries,authored])this.registry.register(organizer);
    for(const organizer of additionalOrganizers)this.registry.register(organizer);
  }
  private cursor(){return Number(this.store.db.prepare("SELECT value FROM settings WHERE key='material-organizer-cursor'").get()?.value??0);}
  status(){
    const cursor=this.cursor();
    const pendingChanges=(this.store.db.prepare('SELECT COUNT(*) n FROM changes WHERE seq>?').get(cursor) as {n:number}).n;
    const backfills=this.store.db.prepare('SELECT organizer_id id,version,cursor_rowid cursorRowid,complete FROM material_organizer_backfills ORDER BY organizer_id').all() as {id:string;version:string;cursorRowid:number;complete:number}[];
    return {cursor,pendingChanges,organizers:this.registry.list(),backfills:backfills.map(row=>({...row,complete:Boolean(row.complete)}))};
  }
  async tick(limit=100){
    if(this.running)return 0;this.running=true;
    try{
      const batchSize=Math.max(1,Math.min(limit,500));
      const rows=this.store.db.prepare('SELECT seq,id FROM changes WHERE seq>? ORDER BY seq LIMIT ?').all(this.cursor(),batchSize) as {seq:number;id:string}[];
      const backfill=(this.store.db.prepare('SELECT organizer_id id,version,cursor_rowid cursorRowid FROM material_organizer_backfills WHERE complete=0 ORDER BY organizer_id').all() as {id:string;version:string;cursorRowid:number}[])
        .find(row=>this.registry.get(row.id)?.version===row.version);
      const backfillRows=backfill?this.store.db.prepare('SELECT rowid,id FROM captures WHERE rowid>? ORDER BY rowid LIMIT ?').all(backfill.cursorRowid,batchSize) as {rowid:number;id:string}[]:[];
      const changedIds=[...new Set([...rows.map(row=>row.id),...backfillRows.map(row=>row.id)])];
      const groups=new Map<string,{organizer:MaterialOrganizer;group:Record<string,string>}>();
      const mappings:{captureId:string;selections:{organizer:MaterialOrganizer;group:Record<string,string>}[]}[]=[];
      const retireIds=new Set<string>(),selectedKeys=new Set<string>();
      const selectionCache=new Map<string,{organizer:MaterialOrganizer;group:Record<string,string>}[]>();
      const selectedFor=(captureId:string)=>{
        const cached=selectionCache.get(captureId);if(cached)return cached;
        const record=capture(this.store,captureId);
        const selections=record&&current(this.store,record.id)?this.registry.select(record).map(({organizer,group})=>{
          if(organizer===screenGroup){const g=this.store.db.prepare('SELECT group_key FROM context_observations WHERE id=?').get(record.id) as {group_key:string}|undefined;group.groupKey=g?.group_key??'';}
          return {organizer,group:canonicalGroup(group)};
        }):[];
        selectionCache.set(captureId,selections);return selections;
      };
      for(const captureId of changedIds){
        const previous=this.store.db.prepare('SELECT organizer_id,group_json,material_id FROM material_organizer_inputs WHERE capture_id=?').all(captureId) as {organizer_id:string;group_json:string;material_id:string|null}[];
        for(const p of previous){const organizer=this.registry.get(p.organizer_id);if(organizer){const group=canonicalGroup(JSON.parse(p.group_json) as Record<string,string>);groups.set(digest([organizer.id,group]),{organizer,group});}else if(p.material_id)retireIds.add(p.material_id);}
        const selections=selectedFor(captureId);
        mappings.push({captureId,selections});
        for(const {organizer,group} of selections){const key=digest([organizer.id,group]);selectedKeys.add(key);groups.set(key,{organizer,group});}
      }
      const active:{organizer:MaterialOrganizer;group:Record<string,string>}[]=[];
      for(const [key,{organizer,group}] of groups){
        const otherIds=changedIds.length?this.store.db.prepare(`SELECT capture_id FROM material_organizer_inputs WHERE organizer_id=? AND group_json=? AND capture_id NOT IN (${changedIds.map(()=>'?').join(',')})`).all(organizer.id,JSON.stringify(group),...changedIds) as {capture_id:string}[]:[];
        // Mappings are historical hints. A newly registered high-priority organizer can
        // supersede their current selection before its backfill reaches every member.
        const other=otherIds.some(row=>selectedFor(row.capture_id).some(selection=>selection.organizer.id===organizer.id&&JSON.stringify(selection.group)===JSON.stringify(group)));
        if(selectedKeys.has(key)||other)active.push({organizer,group});
        else{const id=organizer.identity(group);if(id)retireIds.add(id);}
      }
      // Build every replacement before mutating heads. The publications, retirements and
      // cursor belong to one transaction so a failed organizer cannot hide older material.
      const prepared=active.map(({organizer,group})=>({organizer,group,draft:organizer.build(this.store,group)}));
      const publishedIds=new Set<string>();
      for(const {organizer,group,draft} of prepared){
        const id=organizer.identity(group);
        if(draft){
          if(id!==draft.id||publishedIds.has(draft.id))throw Error('Ambiguous material organizer identity');
          publishedIds.add(draft.id);
        }else if(id)retireIds.add(id);
      }
      if(rows.length||backfill){
        const db=this.store.db;db.exec('BEGIN IMMEDIATE');
        try{
          for(const id of retireIds)if(!publishedIds.has(id)){
            const prior=this.materials.get(id);if(prior)this.materials.retire(id,{expectedRevision:prior.revision});
          }
          for(const {draft} of prepared)if(draft){
            const prior=this.materials.get(draft.id);
            // A source may reappear after a logical tombstone. Privacy-erased revisions
            // cannot be revived; a live organizer replacement keeps its pinned history.
            if(!prior&&(db.prepare('SELECT retired FROM material_heads WHERE id=?').get(draft.id) as {retired:number}|undefined)?.retired)this.materials.forget(draft.id);
            this.materials.publish(draft,{expectedRevision:prior?.revision??null});
          }
          for(const {captureId,selections} of mappings){
            db.prepare('DELETE FROM material_organizer_inputs WHERE capture_id=?').run(captureId);
            for(const {organizer,group} of selections)db.prepare('INSERT INTO material_organizer_inputs(capture_id,organizer_id,group_json,material_id) VALUES(?,?,?,?)').run(captureId,organizer.id,JSON.stringify(group),organizer.identity(group)??null);
          }
          if(rows.length)db.prepare("INSERT INTO settings(key,value) VALUES('material-organizer-cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(rows.at(-1)!.seq));
          if(backfill)db.prepare('UPDATE material_organizer_backfills SET cursor_rowid=?,complete=? WHERE organizer_id=? AND version=?').run(
            backfillRows.at(-1)?.rowid??backfill.cursorRowid,backfillRows.length<batchSize?1:0,backfill.id,backfill.version);
          db.exec('COMMIT');
        }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
      }
      return changedIds.length;
    }finally{this.running=false;}
  }
}
