import type {QueryScope,SourceDocument} from '@mote/shared';
import {decodeMemoryPrivate} from './plugins/memory-private-storage.js';
import {sourceModelIdentity} from './model-authorization-host.js';
import {materialId,type MaterialRecord,type MaterialStore} from './materials.js';
import {BackgroundModelAuthorization} from './background-model-authorization.js';
import {BatchProcessing,type BatchRequest} from './batch-processing.js';
import {TaskRecords,type AssertTaskCurrent} from './task-records.js';
import {retireTaskRecordsSql} from './task-evidence.js';
import {sha256,StoreError,type Store} from './store.js';

type ChangeRow={seq:number;kind:'original'|'material'|'feedback';identity:string;source_id:string|null;object_id:string|null;previous_revision:string|null;at:number};
type WorkRow={key:string;root:string;source_id:string;capture_id:string|null;material_id:string|null;previous_revision:string|null;task_id:string;first_at:number;last_at:number;started_batch:string|null;needs_review:number};
type MaterialState=Pick<MaterialRecord,'ref'|'coverage'>&{artifacts:Pick<NonNullable<MaterialRecord['artifacts']>[number],'key'|'state'|'reason'>[]};
export type AssistantChangeInput={root:string;sourceId:string;captureId?:string;observedAt?:string;sourceRevision?:string;document?:SourceDocument;
  material?:MaterialState;readiness:'pending'|'ready'|'partial';evidenceIds:string[]};
export type AssistantFeedbackInput={cardId:string;feedbackSeq:number;cardRevision:number;scope:QueryScope};

/** Durable input catalog. It contains no source body and cannot itself
 * authorize or send a model request. Task records own private frozen inputs;
 * the existing batch adapter remains the model execution path. */
export class AssistantChangeFeed {
 private readonly tasks:TaskRecords;
 constructor(private readonly store:Store,private readonly materials:MaterialStore,private readonly control:BackgroundModelAuthorization,
  private readonly assertCurrent:AssertTaskCurrent,private readonly now=Date.now,private readonly settleMs=15000,private readonly maximumWaitMs=60000){
  if(!Number.isSafeInteger(settleMs)||settleMs<0||!Number.isSafeInteger(maximumWaitMs)||maximumWaitMs<settleMs)throw Error('Invalid assistant change settling interval');
  this.tasks=new TaskRecords(store);
  const db=store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_change_log(
   seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,identity TEXT NOT NULL,source_id TEXT,object_id TEXT,previous_revision TEXT,at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS assistant_change_state(id INTEGER PRIMARY KEY CHECK(id=1),cursor INTEGER NOT NULL,initial_captures INTEGER NOT NULL,initial_materials INTEGER NOT NULL,
    initial_complete INTEGER NOT NULL,initial_partial INTEGER NOT NULL,initial_pending INTEGER NOT NULL,initial_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS assistant_change_work(
    key TEXT PRIMARY KEY,root TEXT NOT NULL,source_id TEXT NOT NULL,capture_id TEXT,material_id TEXT,previous_revision TEXT,task_id TEXT NOT NULL REFERENCES task_records(id),
    first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,started_batch TEXT,needs_review INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS assistant_change_work_material ON assistant_change_work(material_id);
   CREATE INDEX IF NOT EXISTS assistant_change_work_capture ON assistant_change_work(capture_id);
   CREATE TABLE IF NOT EXISTS assistant_change_feedback_tasks(
    feedback_seq INTEGER PRIMARY KEY REFERENCES assistant_card_feedback(seq) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES task_records(id));
   CREATE TABLE IF NOT EXISTS assistant_change_deferred(
    seq INTEGER PRIMARY KEY REFERENCES assistant_change_log(seq) ON DELETE CASCADE,attempts INTEGER NOT NULL DEFAULT 0);
   CREATE TRIGGER IF NOT EXISTS assistant_change_original AFTER INSERT ON background_model_receipts
    WHEN new.eligible=1 AND (new.identity LIKE 'capture:%' OR new.identity LIKE 'source:%') BEGIN
     INSERT INTO assistant_change_log(kind,identity,source_id,object_id,previous_revision,at)
     VALUES('original',new.identity,new.source_id,
      CASE WHEN new.identity LIKE 'source:%' THEN (SELECT group_hash FROM source_archive_groups WHERE source_id=new.source_id AND checkpoint=json_extract(substr(new.identity,8),'$[1]') LIMIT 1) ELSE NULL END,
      CASE WHEN new.identity LIKE 'source:%' THEN (SELECT h.revision FROM material_heads h JOIN source_archive_groups g ON g.source_id=h.source_id AND g.group_key=h.external_id WHERE g.source_id=new.source_id AND g.checkpoint=json_extract(substr(new.identity,8),'$[1]') LIMIT 1) ELSE NULL END,
      CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_change_archive_supersede AFTER INSERT ON background_model_receipts
    WHEN new.identity LIKE 'source:%' BEGIN
     ${retireTaskRecordsSql(`SELECT task_id FROM assistant_change_work WHERE root!=new.identity AND material_id IN
      (SELECT h.id FROM material_heads h JOIN source_archive_groups g ON g.source_id=h.source_id AND g.group_key=h.external_id
       WHERE g.source_id=new.source_id AND g.checkpoint=json_extract(substr(new.identity,8),'$[1]'))`)}
     ${retireTaskRecordsSql(`SELECT started_batch FROM assistant_change_work WHERE root!=new.identity AND material_id IN
      (SELECT h.id FROM material_heads h JOIN source_archive_groups g ON g.source_id=h.source_id AND g.group_key=h.external_id
       WHERE g.source_id=new.source_id AND g.checkpoint=json_extract(substr(new.identity,8),'$[1]')) AND started_batch IS NOT NULL`)}
     ${retireTaskRecordsSql(`SELECT json_extract(e.input,'$.itemId') FROM execution_steps e WHERE e.kind='batch.item' AND json_extract(e.input,'$.batchId') IN
      (SELECT started_batch FROM assistant_change_work WHERE root!=new.identity AND material_id IN
       (SELECT h.id FROM material_heads h JOIN source_archive_groups g ON g.source_id=h.source_id AND g.group_key=h.external_id
        WHERE g.source_id=new.source_id AND g.checkpoint=json_extract(substr(new.identity,8),'$[1]')) AND started_batch IS NOT NULL)`)}
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_change_material AFTER UPDATE OF revision,retired,min_visible_sequence ON material_heads
    WHEN new.sequence>0 AND (new.revision IS NOT old.revision OR new.retired IS NOT old.retired OR new.min_visible_sequence IS NOT old.min_visible_sequence) BEGIN
     INSERT INTO assistant_change_log(kind,identity,source_id,object_id,at)
      VALUES('material',new.id,new.source_id,NULL,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
     ${retireTaskRecordsSql("SELECT task_id FROM assistant_change_work WHERE material_id=new.id AND (new.retired=1 OR new.min_visible_sequence>new.sequence)")}
     DELETE FROM assistant_change_work WHERE material_id=new.id AND (new.retired=1 OR new.min_visible_sequence>new.sequence);
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_change_material_forget BEFORE DELETE ON material_heads BEGIN
    ${retireTaskRecordsSql('SELECT task_id FROM assistant_change_work WHERE material_id=old.id')}
    ${retireTaskRecordsSql('SELECT started_batch FROM assistant_change_work WHERE material_id=old.id AND started_batch IS NOT NULL')}
    ${retireTaskRecordsSql("SELECT json_extract(e.input,'$.itemId') FROM execution_steps e WHERE e.kind='batch.item' AND json_extract(e.input,'$.batchId') IN (SELECT started_batch FROM assistant_change_work WHERE material_id=old.id AND started_batch IS NOT NULL)")}
    DELETE FROM assistant_change_work WHERE material_id=old.id;
    DELETE FROM assistant_change_log WHERE kind='material' AND identity=old.id;
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_change_capture_forget BEFORE DELETE ON captures BEGIN
    DELETE FROM assistant_change_work WHERE capture_id=old.id;
    DELETE FROM assistant_change_log WHERE kind='original' AND identity='capture:'||old.id;
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_change_archive_forget BEFORE DELETE ON source_archive_groups BEGIN
    ${retireTaskRecordsSql("SELECT task_id FROM assistant_change_work WHERE root IN (SELECT identity FROM assistant_change_log WHERE kind='original' AND source_id=old.source_id AND object_id=old.group_hash)")}
    ${retireTaskRecordsSql("SELECT started_batch FROM assistant_change_work WHERE root IN (SELECT identity FROM assistant_change_log WHERE kind='original' AND source_id=old.source_id AND object_id=old.group_hash) AND started_batch IS NOT NULL")}
    ${retireTaskRecordsSql("SELECT json_extract(e.input,'$.itemId') FROM execution_steps e WHERE e.kind='batch.item' AND json_extract(e.input,'$.batchId') IN (SELECT started_batch FROM assistant_change_work WHERE root IN (SELECT identity FROM assistant_change_log WHERE kind='original' AND source_id=old.source_id AND object_id=old.group_hash) AND started_batch IS NOT NULL)")}
    DELETE FROM assistant_change_work WHERE root IN (SELECT identity FROM assistant_change_log WHERE kind='original' AND source_id=old.source_id AND object_id=old.group_hash);
    DELETE FROM assistant_change_log WHERE kind='original' AND source_id=old.source_id AND object_id=old.group_hash;
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_change_source_forget BEFORE DELETE ON source_connections BEGIN
    ${retireTaskRecordsSql('SELECT task_id FROM assistant_change_work WHERE source_id=old.id')}
    ${retireTaskRecordsSql('SELECT started_batch FROM assistant_change_work WHERE source_id=old.id AND started_batch IS NOT NULL')}
    ${retireTaskRecordsSql("SELECT json_extract(e.input,'$.itemId') FROM execution_steps e WHERE e.kind='batch.item' AND json_extract(e.input,'$.batchId') IN (SELECT started_batch FROM assistant_change_work WHERE source_id=old.id AND started_batch IS NOT NULL)")}
    DELETE FROM assistant_change_work WHERE source_id=old.id;
    DELETE FROM assistant_change_log WHERE source_id=old.id;
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_change_source_deleted AFTER UPDATE OF deleted ON source_heads WHEN new.deleted=1 BEGIN
    ${retireTaskRecordsSql('SELECT task_id FROM assistant_change_work WHERE capture_id=old.capture_id OR capture_id=new.capture_id')}
    DELETE FROM assistant_change_work WHERE capture_id=old.capture_id OR capture_id=new.capture_id;
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_change_feedback AFTER INSERT ON assistant_card_feedback BEGIN
    INSERT INTO assistant_change_log(kind,identity,source_id,object_id,at)
     VALUES('feedback',CAST(new.seq AS TEXT),NULL,new.card_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER));
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_change_feedback_forget BEFORE DELETE ON assistant_card_feedback BEGIN
    ${retireTaskRecordsSql('SELECT task_id FROM assistant_change_feedback_tasks WHERE feedback_seq=old.seq')}
    DELETE FROM assistant_change_log WHERE kind='feedback' AND identity=CAST(old.seq AS TEXT);
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_change_card_review AFTER UPDATE OF revision ON assistant_cards
    WHEN new.revision!=old.revision BEGIN
     UPDATE assistant_change_work SET needs_review=1 WHERE task_id IN
      (SELECT t.task_id FROM task_evidence t JOIN assistant_card_evidence c ON c.evidence_id=t.evidence_id WHERE c.card_id=new.id);
   END;
   CREATE TRIGGER IF NOT EXISTS assistant_change_memory_review AFTER UPDATE OF json ON memories
    WHEN new.json IS NOT old.json BEGIN
     UPDATE assistant_change_work SET needs_review=1 WHERE task_id IN (SELECT task_id FROM task_evidence WHERE evidence_id=new.id);
   END;`);
  // Existing data is coverage, not evidence of a newly arrived original.
  db.prepare(`INSERT OR IGNORE INTO assistant_change_state
   SELECT 1,0,(SELECT count(*) FROM captures),count(*),
    count(*) FILTER (WHERE json_extract(r.manifest,'$.coverage.state')='complete'),
    count(*) FILTER (WHERE json_extract(r.manifest,'$.coverage.state')='partial'),
    count(*) FILTER (WHERE json_extract(r.manifest,'$.coverage.state')='pending'),?
   FROM material_heads h JOIN material_revisions r ON r.material_id=h.id AND r.revision=h.revision WHERE h.retired=0`).run(new Date(now()).toISOString());
  store.registerStorage('assistant-change-feed',{
   assistant_change_log:'length(CAST(identity AS BLOB))+coalesce(length(CAST(source_id AS BLOB)),0)+coalesce(length(CAST(object_id AS BLOB)),0)+coalesce(length(CAST(previous_revision AS BLOB)),0)+96',
   assistant_change_state:'128',
   assistant_change_work:'length(CAST(key AS BLOB))+length(CAST(root AS BLOB))+length(CAST(source_id AS BLOB))+coalesce(length(CAST(capture_id AS BLOB)),0)+coalesce(length(CAST(material_id AS BLOB)),0)+coalesce(length(CAST(previous_revision AS BLOB)),0)+length(CAST(task_id AS BLOB))+coalesce(length(CAST(started_batch AS BLOB)),0)+192',
   assistant_change_feedback_tasks:'length(CAST(task_id AS BLOB))+64',
   assistant_change_deferred:'64',
  });
 }
 private transaction<T>(fn:()=>T):T{const db=this.store.db;db.exec('SAVEPOINT assistant_change_write');try{const result=fn();db.exec('RELEASE assistant_change_write');return result;}catch(error){db.exec('ROLLBACK TO assistant_change_write; RELEASE assistant_change_write');throw error;}}
 private snapshot(root:string,sourceId:string,captureId:string|null,materialIdValue:string|null,previousRevision:string|null):AssistantChangeInput|undefined{
  if(!captureId){const checkpoint=JSON.parse(root.slice('source:'.length)) as [string,string];
   if(!this.store.db.prepare('SELECT 1 FROM source_archive_groups WHERE source_id=? AND checkpoint=?').get(sourceId,checkpoint[1]))return;}
  const capture=captureId?this.store.evidence([captureId])[0]:undefined;
  if(captureId&&(!capture||!this.store.isCurrentEvidence(captureId)||capture.provenance?.deleted||capture.provenance?.layer==='derived'))return;
  let material=materialIdValue?this.materials.get(materialIdValue):undefined;
  if(material&&captureId&&!this.store.db.prepare("SELECT 1 FROM material_members WHERE material_id=? AND revision=? AND kind='capture' AND ref=?").get(material.id,material.revision,'capture:'+captureId))material=undefined;
  if(material&&!captureId){
   const checkpoint=JSON.parse(root.slice('source:'.length)) as [string,string];
   if(!this.store.db.prepare('SELECT 1 FROM source_pipeline_work WHERE source_id=? AND archive_checkpoint=? AND material_ref=?').get(sourceId,checkpoint[1],material.ref))material=undefined;
  }
  const artifacts=(material?.artifacts??[]).map(({key,state,reason})=>({key,state,...(reason?{reason}:{})}));
  const extracted=artifacts.find(item=>item.key==='extracted-text');
  const waiting=Boolean(capture?.source==='file'&&capture.provenance?.layer!=='reference'&&(!material||extracted?.state!=='ready'||material.coverage.state==='pending')||!capture&&(!material||material.coverage.state==='pending'||material.revision===previousRevision));
  const partial=Boolean(material&&(material.coverage.state==='partial'||extracted?.state==='failed'||extracted?.state==='unavailable'));
  const ids=captureId?[captureId]:material?this.materials.evidenceIds(material.ref):[];
  return {root,sourceId,...(captureId?{captureId}:{}),...(capture?{observedAt:capture.capturedAt}:{}),
   ...(capture?.provenance?.revision?{sourceRevision:capture.provenance.revision}:{}),...(capture?.provenance?.document?{document:capture.provenance.document}:{}),
   ...(material?{material:{ref:material.ref,coverage:material.coverage,artifacts}}:{}),readiness:waiting?'pending':partial?'partial':'ready',evidenceIds:ids};
 }
 private saveOriginal(row:ChangeRow){
  const root=row.identity,sourceId=row.source_id!;let captureId:string|null=null,materialIdValue:string|null=null,key:string;
  if(root.startsWith('capture:')){
   captureId=root.slice(8);const capture=this.store.evidence([captureId])[0];
   if(!capture||!this.store.isCurrentEvidence(captureId)||capture.provenance?.deleted||capture.provenance?.layer==='derived')return;
   if(capture.provenance&&!capture.provenance.document?.coding){
    key=sha256(JSON.stringify(['source',capture.provenance.sourceId,capture.provenance.externalId]));
    materialIdValue=materialId(capture.provenance.sourceId,capture.provenance.externalId);
   }else key=sha256(JSON.stringify(['capture',captureId]));
  }else{
   if(!row.object_id)return;
   const group=this.store.db.prepare('SELECT group_key,checkpoint FROM source_archive_groups WHERE source_id=? AND group_hash=?').get(sourceId,row.object_id);
   if(!group||sourceModelIdentity(sourceId,String(group.checkpoint))!==root)return;
   key=sha256(JSON.stringify(['archive',sourceId,row.object_id]));materialIdValue=materialId(sourceId,String(group.group_key));
  }
  const previous=this.store.db.prepare('SELECT * FROM assistant_change_work WHERE key=?').get(key) as WorkRow|undefined;
  if(previous?.root===root)return;
  const input=this.snapshot(root,sourceId,captureId,materialIdValue,row.previous_revision);if(!input)return;
  if(previous&&!previous.started_batch){const old=this.tasks.get(previous.task_id);if(!['stale','cancelled','succeeded','skipped'].includes(old.state))this.tasks.setState(old.id,old.revision,'stale');}
  const task=this.tasks.create({operationId:'assistant-change:'+key,kind:'assistant.change',requestId:'assistant-change:'+row.seq,input,
   evidenceDependencies:{version:1,complete:true,ids:input.evidenceIds}},this.assertCurrent);
  const at=this.now(),first=previous&&!previous.started_batch?previous.first_at:at;
  this.store.db.prepare(`INSERT INTO assistant_change_work VALUES(?,?,?,?,?,?,?,?,?,NULL,0)
   ON CONFLICT(key) DO UPDATE SET root=excluded.root,source_id=excluded.source_id,capture_id=excluded.capture_id,material_id=excluded.material_id,task_id=excluded.task_id,
    previous_revision=excluded.previous_revision,first_at=excluded.first_at,last_at=excluded.last_at,started_batch=NULL,needs_review=0`).run(key,root,sourceId,captureId,materialIdValue,row.previous_revision,task.id,first,at);
 }
 private refreshMaterial(row:ChangeRow){
  const material=this.materials.get(row.identity);if(!material)return;
  // Direct capture-derived materials are linked by their existing member, never
  // by text, hash similarity or the model's opinion.
  const captures=this.store.db.prepare("SELECT ref FROM material_members WHERE material_id=? AND revision=? AND kind='capture'").all(material.id,material.revision).map(value=>String(value.ref).replace(/^capture:/,''));
  const work=this.store.db.prepare(`SELECT * FROM assistant_change_work WHERE material_id=? OR (material_id IS NULL AND capture_id IN (SELECT value FROM json_each(?)))`).all(material.id,JSON.stringify(captures)) as WorkRow[];
  for(const item of work){
   if(item.started_batch){this.store.db.prepare('UPDATE assistant_change_work SET needs_review=1 WHERE key=?').run(item.key);continue;}
   const input=this.snapshot(item.root,item.source_id,item.capture_id,material.id,item.previous_revision);if(!input)continue;
   const old=this.tasks.get(item.task_id);let prior:AssistantChangeInput|undefined;
   try{prior=this.tasks.input<AssistantChangeInput>(old.id,old.revision,this.assertCurrent);}catch{}
   if(prior&&JSON.stringify(prior)===JSON.stringify(input))continue;
   if(old.state==='stale'){
    // The extractor can invalidate the previous projection while the same
    // original remains current. Keep its unclaimed root and replace only the
    // invalidated task input; no receipt or model authorization is minted.
    const task=this.tasks.create({operationId:'assistant-change:'+item.key,kind:'assistant.change',requestId:'assistant-change-refresh:'+row.seq+':'+item.key,input,
     evidenceDependencies:{version:1,complete:true,ids:input.evidenceIds}},this.assertCurrent);
    this.store.db.prepare('UPDATE assistant_change_work SET material_id=?,task_id=? WHERE key=?').run(material.id,task.id,item.key);
   }else if(old.state==='waiting'){
    this.tasks.replaceWaitingInput(old.id,old.revision,input,{version:1,complete:true,ids:input.evidenceIds},this.assertCurrent);
    this.store.db.prepare('UPDATE assistant_change_work SET material_id=? WHERE key=?').run(material.id,item.key);
   }
  }
 }
 private saveFeedback(row:ChangeRow){
  const saved=this.store.db.prepare(`SELECT f.card_id,f.stale,c.revision,s.private_json FROM assistant_card_feedback f
   JOIN assistant_cards c ON c.id=f.card_id JOIN assistant_card_feedback_scopes s ON s.feedback_seq=f.seq WHERE f.seq=?`).get(Number(row.identity));
  if(!saved)return;
  const {scope,cardRevision}=decodeMemoryPrivate<{scope:QueryScope;cardRevision:number}>(this.store,String(saved.private_json));
  // Historical card dependencies may already be stale. The feedback task
  // stores only a reference and its original scope; the card reader determines
  // which feedback is readable. Deletion of that reference retires it.
  const ids=saved.stale?[]:this.store.db.prepare('SELECT evidence_id FROM assistant_card_feedback_evidence WHERE feedback_seq=? ORDER BY evidence_id').all(Number(row.identity)).map(value=>String(value.evidence_id));
  const input:AssistantFeedbackInput={cardId:String(saved.card_id),feedbackSeq:Number(row.identity),cardRevision,scope};
  const task=this.tasks.create({operationId:'assistant-feedback:'+input.cardId,kind:'assistant.feedback',requestId:'assistant-feedback:'+input.feedbackSeq,input,
   evidenceDependencies:{version:1,complete:true,ids}},this.assertCurrent);
  this.store.db.prepare('INSERT OR IGNORE INTO assistant_change_feedback_tasks VALUES(?,?)').run(input.feedbackSeq,task.id);
  this.store.db.prepare(`UPDATE assistant_change_work SET needs_review=1 WHERE task_id IN
   (SELECT task_id FROM task_evidence WHERE evidence_id IN (SELECT evidence_id FROM assistant_card_feedback_evidence WHERE feedback_seq=?))`).run(input.feedbackSeq);
 }
 /** Process each event in its own transaction. Cursor and task input move
  * together, so a failed item cannot acknowledge a half-created task. Quota
  * exhaustion leaves the event pending for a later poll, including at startup. */
 tick(limit=100){
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error('Invalid assistant change page');
  const process=(row:ChangeRow)=>{
   if(row.kind==='original')this.saveOriginal(row);else if(row.kind==='material')this.refreshMaterial(row);else this.saveFeedback(row);
  };
  // An unavailable input is not allowed to stall unrelated sources. Its
  // original log row stays durable and is retried on later existing polls.
  const deferred=this.store.db.prepare('SELECT l.* FROM assistant_change_deferred d JOIN assistant_change_log l ON l.seq=d.seq ORDER BY d.attempts,d.seq LIMIT ?').all(limit) as ChangeRow[];
  for(const row of deferred)try{this.transaction(()=>{process(row);this.store.db.prepare('DELETE FROM assistant_change_deferred WHERE seq=?').run(row.seq);this.store.reserveMetadata(0);});}
   catch(error){if(error instanceof StoreError&&error.statusCode===507)return 0;if(!(error instanceof StoreError&&error.statusCode===409))throw error;this.store.db.prepare('UPDATE assistant_change_deferred SET attempts=attempts+1 WHERE seq=?').run(row.seq);}
  let count=0;
  for(;count<limit;count++){
   const row=this.store.db.prepare('SELECT * FROM assistant_change_log WHERE seq>(SELECT cursor FROM assistant_change_state WHERE id=1) ORDER BY seq LIMIT 1').get() as ChangeRow|undefined;
   if(!row)break;
   try{this.transaction(()=>{process(row);this.store.db.prepare('UPDATE assistant_change_state SET cursor=? WHERE id=1').run(row.seq);this.store.reserveMetadata(0);});}
   catch(error){
    if(error instanceof StoreError&&error.statusCode===507)return count;
    if(!(error instanceof StoreError&&error.statusCode===409))throw error;
    try{this.transaction(()=>{this.store.db.prepare('INSERT OR IGNORE INTO assistant_change_deferred(seq) VALUES(?)').run(row.seq);
     this.store.db.prepare('UPDATE assistant_change_state SET cursor=? WHERE id=1').run(row.seq);this.store.reserveMetadata(0);});}
    catch(error){if(error instanceof StoreError&&error.statusCode===507)return count;throw error;}
   }
  }
  return count;
 }
 coverage(){return this.store.db.prepare('SELECT cursor,initial_captures,initial_materials,initial_complete,initial_partial,initial_pending,initial_at FROM assistant_change_state WHERE id=1').get()!;}
 feedback(){return this.store.db.prepare('SELECT task_id FROM assistant_change_feedback_tasks ORDER BY feedback_seq').all().flatMap(row=>{
  try{const task=this.tasks.get(String(row.task_id));return [{task,input:this.tasks.input<AssistantFeedbackInput>(task.id,task.revision,this.assertCurrent)}];}catch{return [];}
 });}
 reviews(){return (this.store.db.prepare('SELECT * FROM assistant_change_work WHERE needs_review=1 ORDER BY first_at,key').all() as WorkRow[]).flatMap(row=>{
  try{const task=this.tasks.get(row.task_id),input=this.tasks.input<AssistantChangeInput>(task.id,task.revision,this.assertCurrent);
   return [{task,input,...(row.started_batch?{batchId:row.started_batch}:{})}];}catch{return [];}
 });}
 /** No handler means no model request. A later consumer can use this list after it has
  * built its actual scoped request; unready roots remain here across restart. */
 ready(){
  const at=this.now();return (this.store.db.prepare('SELECT * FROM assistant_change_work WHERE started_batch IS NULL AND needs_review=0 ORDER BY first_at,key').all() as WorkRow[]).flatMap(row=>{
   if(at<Math.min(row.last_at+this.settleMs,row.first_at+this.maximumWaitMs)||!this.control.freshTriggers([row.root],'assistant').length)return [];
   try{const task=this.tasks.get(row.task_id),input=this.tasks.input<AssistantChangeInput>(task.id,task.revision,this.assertCurrent),current=this.snapshot(row.root,row.source_id,row.capture_id,row.material_id,row.previous_revision);
    return input.readiness==='pending'||!input.evidenceIds.length||!current||JSON.stringify(current)!==JSON.stringify(input)?[]:[{task,input}];}catch{return [];}
  });
 }
 /** Submit the actual consumer's request through batch processing. Receipt claim, batch task,
  * execution steps and this work pointer commit or roll back together. */
 submit(taskId:string,request:BatchRequest,batch:BatchProcessing,context:{evidenceIds:readonly string[];taskIds:readonly string[]}={evidenceIds:[],taskIds:[]}){
  return this.transaction(()=>{
   const row=this.store.db.prepare('SELECT * FROM assistant_change_work WHERE task_id=?').get(taskId) as WorkRow|undefined;
   if(!row)throw new StoreError('Assistant change is not ready',409);
   if(row.started_batch){
    const roots=this.store.db.prepare('SELECT root FROM assistant_change_work WHERE started_batch=? ORDER BY root').all(row.started_batch).map(value=>String(value.root));
    const prior=batch.submit(request,{kind:'automatic',purpose:'assistant',roots});
    if(prior.id!==row.started_batch)throw new StoreError('Assistant change was already submitted',409);
    return prior;
   }
   const ready=this.ready(),selected=[...new Set([taskId,...context.taskIds])].map(id=>ready.find(candidate=>candidate.task.id===id));
   if(selected.some(candidate=>!candidate))throw new StoreError('Assistant change is not ready',409);
   this.assertCurrent(context.evidenceIds);
   const allowed=new Set([...selected.flatMap(candidate=>candidate!.input.evidenceIds),...context.evidenceIds]);
   if(request.items.some(item=>!item.evidenceIds.length||item.evidenceIds.some(id=>!allowed.has(id))))throw new StoreError('Assistant batch exceeds its frozen input',409);
   const result=batch.submit(request,{kind:'automatic',purpose:'assistant',roots:selected.map(candidate=>candidate!.input.root)});
   for(const candidate of selected){const {task}=candidate!;
    this.tasks.setState(task.id,task.revision,'running');
    this.store.db.prepare('UPDATE assistant_change_work SET started_batch=? WHERE task_id=?').run(result.id,task.id);
   }
   return result;
  });
 }
 complete(batchId:string,result:{cardIds:string[];commitmentIds:string[]}){
  this.transaction(()=>{
   for(const row of this.store.db.prepare('SELECT task_id FROM assistant_change_work WHERE started_batch=?').all(batchId)){
    const task=this.tasks.get(String(row.task_id));if(task.state!=='running')continue;
    const input=this.tasks.input<AssistantChangeInput>(task.id,task.revision,this.assertCurrent);
    this.tasks.saveResult(task.id,task.revision,result,{version:1,complete:true,ids:input.evidenceIds},this.assertCurrent);
    this.store.db.prepare('UPDATE assistant_change_work SET needs_review=0 WHERE task_id=?').run(task.id);
   }
  });
 }
 settle(batchId:string,state:'blocked'|'cancelled'|'stale'){
  this.transaction(()=>{
   for(const row of this.store.db.prepare('SELECT task_id FROM assistant_change_work WHERE started_batch=?').all(batchId)){
    const task=this.tasks.get(String(row.task_id));if(task.state==='running')this.tasks.setState(task.id,task.revision,state);
   }
  });
 }
}
