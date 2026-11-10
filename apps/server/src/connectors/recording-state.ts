import type {Store} from '../store.js';
import type {ArchivedFileStore} from '../archived-files.js';
import type {RecordingMetadata} from './recordings.js';

export function initializeRecordingMedia(store:Pick<Store,'db'>){
 store.db.exec('CREATE TABLE IF NOT EXISTS recording_media(source_id TEXT NOT NULL,external_id TEXT NOT NULL,file_id TEXT NOT NULL REFERENCES archived_files(id) ON DELETE CASCADE,PRIMARY KEY(source_id,external_id))');
}
/** Durable recording receipts and explicit source/file read projections. Callers
 * retain the existing execution-grant transaction around publication methods. */
export function recordingState(store:Pick<Store,'db'|'isCurrentEvidence'>,archives:Pick<ArchivedFileStore,'attach'>){
 const {db}=store,isCurrentEvidence=store.isCurrentEvidence.bind(store);
 db.exec(`CREATE TABLE IF NOT EXISTS recording_media(source_id TEXT NOT NULL,external_id TEXT NOT NULL,file_id TEXT NOT NULL REFERENCES archived_files(id) ON DELETE CASCADE,PRIMARY KEY(source_id,external_id)); CREATE TABLE IF NOT EXISTS recording_exports(source_id TEXT NOT NULL,external_id TEXT NOT NULL,file_id TEXT NOT NULL REFERENCES archived_files(id) ON DELETE CASCADE,metadata TEXT NOT NULL,observed_at TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('empty','unsupported')),PRIMARY KEY(source_id,external_id)); CREATE TABLE IF NOT EXISTS recording_cursors(source_id TEXT PRIMARY KEY,epoch TEXT NOT NULL,scanned_until TEXT NOT NULL,full_at INTEGER NOT NULL);`);
 return {
  pipelineConfigured:(sourceId:string)=>Boolean(db.prepare('SELECT 1 FROM source_pipeline_config WHERE source_id=?').get(sourceId)),
  memoryRecipeConfigured:(sourceId:string)=>Boolean(db.prepare('SELECT 1 FROM memory_recipe_settings WHERE source_id=?').get(sourceId)),
  forgotten:(sourceId:string,id:string)=>Boolean(db.prepare('SELECT 1 FROM file_forgotten WHERE source_id=? AND external_id=?').get(sourceId,id)),
  cursor:(sourceId:string,epoch:string)=>db.prepare('SELECT * FROM recording_cursors WHERE source_id=? AND epoch=?').get(sourceId,epoch) as {scanned_until:string;full_at:number}|undefined,
  advanceCursor:(sourceId:string,epoch:string,scannedUntil:string,fullAt:number)=>{db.prepare('INSERT INTO recording_cursors VALUES(?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET epoch=excluded.epoch,scanned_until=excluded.scanned_until,full_at=CASE WHEN excluded.full_at>0 THEN excluded.full_at ELSE recording_cursors.full_at END').run(sourceId,epoch,scannedUntil,fullAt);},
  media:(sourceId:string,id:string)=>{const row=db.prepare('SELECT file_id FROM recording_media WHERE source_id=? AND external_id=?').get(sourceId,id);return row?String(row.file_id):undefined;},
  exportReceipt:(sourceId:string,id:string,fileId:string,metadata:RecordingMetadata,observedAt:string,state:'empty'|'unsupported')=>{db.prepare(`INSERT INTO recording_exports VALUES(?,?,?,?,?,'${state}') ON CONFLICT(source_id,external_id) DO UPDATE SET file_id=excluded.file_id,metadata=excluded.metadata,observed_at=excluded.observed_at,state=excluded.state`).run(sourceId,id,fileId,JSON.stringify(metadata),observedAt);},
  dropExport:(sourceId:string,id:string)=>{db.prepare('DELETE FROM recording_exports WHERE source_id=? AND external_id=?').run(sourceId,id);},
  publishMedia:(sourceId:string,id:string,fileId:string)=>{
   db.prepare('INSERT OR REPLACE INTO recording_media VALUES(?,?,?)').run(sourceId,id,fileId);
   const head=db.prepare('SELECT capture_id FROM file_heads WHERE source_id=? AND external_id=?').get(sourceId,id);
   if(head&&isCurrentEvidence(String(head.capture_id))){archives.attach(String(head.capture_id),[fileId]);db.prepare("INSERT INTO changes(id,operation,changed_at) VALUES(?,'upsert',?)").run(String(head.capture_id),new Date().toISOString());}
  },
  counts:(sourceId:string)=>({transcripts:Number(db.prepare('SELECT count(*) n FROM file_heads WHERE source_id=?').get(sourceId)!.n),audio:Number(db.prepare('SELECT count(*) n FROM recording_media WHERE source_id=?').get(sourceId)!.n),empty:Number(db.prepare("SELECT count(*) n FROM recording_exports WHERE source_id=? AND state='empty'").get(sourceId)!.n)}),
  transcripts:(sourceId:string)=>db.prepare('SELECT h.external_id,h.capture_id,m.file_id FROM file_heads h LEFT JOIN recording_media m ON m.source_id=h.source_id AND m.external_id=h.external_id JOIN captures c ON c.id=h.capture_id WHERE h.source_id=? ORDER BY c.received_at DESC LIMIT 30').all(sourceId) as {external_id:string;capture_id:string;file_id:string|null}[],
  exports:(sourceId:string)=>db.prepare('SELECT e.*,m.file_id AS audio_id FROM recording_exports e LEFT JOIN recording_media m ON m.source_id=e.source_id AND m.external_id=e.external_id WHERE e.source_id=? ORDER BY e.observed_at DESC LIMIT 30').all(sourceId) as {external_id:string;file_id:string;metadata:string;observed_at:string;state:'empty'|'unsupported';audio_id:string|null}[],
 };
}
export type RecordingState=ReturnType<typeof recordingState>;

/** Recording-specific projections of execution receipts. This adapter never
 * changes leases, attempts or retry state; ExecutionEngine remains the writer. */
export function recordingWorkReadModel(store:Pick<Store,'db'>){
 const {db}=store;
 return {
  mediaAttempt:(kind:string,epoch:string,account:string,version:string,id:string)=>{const row=db.prepare("SELECT id FROM execution_steps WHERE kind=? AND json_extract(input,'$.epoch')=? AND json_extract(input,'$.account')=? AND json_extract(input,'$.providerVersion')=? AND json_extract(input,'$.id')=? LIMIT 1").get(kind,epoch,account,version,id);return row?String(row.id):undefined;},
  transcriptAttempt:(kind:string,epoch:string,id:string)=>{const row=db.prepare("SELECT id FROM execution_steps WHERE kind=? AND state IN ('waiting','running','failed','blocked') AND json_extract(input,'$.epoch')=? AND json_extract(input,'$.id')=? LIMIT 1").get(kind,epoch,id);return row?String(row.id):undefined;},
  activeDiscovery:(kind:string,epoch:string)=>Number(db.prepare("SELECT count(*) n FROM execution_steps WHERE kind=? AND state IN ('waiting','running','blocked') AND json_extract(input,'$.epoch')=?").get(kind,epoch)!.n),
  failedDiscoveries:(kind:string,epoch:string)=>(db.prepare("SELECT id FROM execution_steps WHERE kind=? AND state='failed' AND json_extract(input,'$.epoch')=?").all(kind,epoch) as {id:string}[]).map(row=>row.id),
  dueSteps:(kinds:string[],now:number)=>(db.prepare("SELECT id FROM execution_steps WHERE kind IN (SELECT value FROM json_each(?)) AND state IN ('waiting','running') AND available_at<=? LIMIT 100").all(JSON.stringify(kinds),now) as {id:string}[]).map(row=>row.id),
  hasPage:(operationId:string,kind:string,start:string,cursor:string)=>Boolean(db.prepare("SELECT 1 FROM execution_steps WHERE operation_id=? AND kind=? AND json_extract(input,'$.start')=? AND json_extract(input,'$.cursor')=?").get(operationId,kind,start,cursor)),
  remainingDiscovery:(operationId:string,kind:string,id:string)=>Number(db.prepare("SELECT count(*) n FROM execution_steps WHERE operation_id=? AND kind=? AND id!=? AND state!='succeeded'").get(operationId,kind,id)!.n),
  steps:(kinds:string[],epoch:string,args:{cursor?:number;limit:number;problemsFirst?:boolean})=>{
   const clauses=["kind IN (SELECT value FROM json_each(?))","json_extract(input,'$.epoch')=?"],values:(string|number)[]=[JSON.stringify(kinds),epoch];
   if(args.cursor!==undefined){clauses.push('rowid<?');values.push(args.cursor);}
   return db.prepare(`SELECT rowid,id FROM execution_steps WHERE ${clauses.join(' AND ')} ORDER BY ${args.problemsFirst?"state IN ('failed','blocked') DESC,":''}rowid DESC LIMIT ?`).all(...values,args.limit+1) as {rowid:number;id:string}[];
  },
  count:(kinds:string[],states:string[],epoch:string)=>Number(db.prepare("SELECT count(*) n FROM execution_steps WHERE kind IN (SELECT value FROM json_each(?)) AND state IN (SELECT value FROM json_each(?)) AND json_extract(input,'$.epoch')=?").get(JSON.stringify(kinds),JSON.stringify(states),epoch)!.n),
  retryableSteps:(kinds:string[],epoch:string)=>(db.prepare("SELECT id FROM execution_steps WHERE kind IN (SELECT value FROM json_each(?)) AND state IN ('failed','blocked') AND json_extract(input,'$.epoch')=?").all(JSON.stringify(kinds),epoch) as {id:string}[]).map(row=>row.id),
 };
}
export type RecordingWorkReadModel=ReturnType<typeof recordingWorkReadModel>;
