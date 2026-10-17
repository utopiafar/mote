import type {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID} from 'node:crypto';

/** M03 adapts the existing immutable chunk/receipt mechanism to the admitted
 * shared epoch-5 database. Every private key and relationship includes owner. */
export function installIngress(db:DatabaseSync){
 db.exec(`
 CREATE TABLE IF NOT EXISTS ig_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),ticket_key TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ig_file_forgets(user_id TEXT NOT NULL,source_id TEXT NOT NULL,external_id TEXT NOT NULL,capture_id TEXT NOT NULL,generation INTEGER NOT NULL,blocked INTEGER NOT NULL,decision_id TEXT NOT NULL,PRIMARY KEY(user_id,source_id,external_id),FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_file_forget_operations(user_id TEXT NOT NULL,operation_id TEXT NOT NULL,digest TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(user_id,operation_id));
 CREATE TABLE IF NOT EXISTS ig_file_generations(user_id TEXT NOT NULL,source_id TEXT NOT NULL,external_id TEXT NOT NULL,generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation>=0 AND generation<=9007199254740991),PRIMARY KEY(user_id,source_id,external_id));
 CREATE TABLE IF NOT EXISTS ig_state(user_id TEXT PRIMARY KEY,deleted INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS ig_capture_update_sequences(user_id TEXT NOT NULL,device_id TEXT NOT NULL,next INTEGER NOT NULL,PRIMARY KEY(user_id,device_id));
 CREATE TABLE IF NOT EXISTS ig_capture_updates(user_id TEXT NOT NULL,device_id TEXT NOT NULL,sequence INTEGER NOT NULL,capture_id TEXT NOT NULL,artifact_id TEXT NOT NULL,PRIMARY KEY(user_id,device_id,sequence),UNIQUE(user_id,device_id,capture_id,artifact_id),FOREIGN KEY(user_id,capture_id) REFERENCES pd_captures(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_objects(user_id TEXT NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,parts INTEGER NOT NULL,PRIMARY KEY(user_id,hash));
 CREATE TABLE IF NOT EXISTS ig_archive_files(user_id TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,hash) REFERENCES ig_objects(user_id,hash));
 CREATE TABLE IF NOT EXISTS ig_archive_links(user_id TEXT NOT NULL,capture_id TEXT NOT NULL,file_id TEXT NOT NULL,PRIMARY KEY(user_id,capture_id,file_id),FOREIGN KEY(user_id,capture_id) REFERENCES pd_captures(user_id,id) ON DELETE CASCADE,FOREIGN KEY(user_id,file_id) REFERENCES ig_archive_files(user_id,id));
 CREATE TABLE IF NOT EXISTS ig_attachment_links(user_id TEXT NOT NULL,capture_id TEXT NOT NULL,parent_capture_id TEXT NOT NULL,file_id TEXT NOT NULL,binding_id TEXT NOT NULL,PRIMARY KEY(user_id,capture_id),FOREIGN KEY(user_id,capture_id) REFERENCES pd_captures(user_id,id) ON DELETE CASCADE,FOREIGN KEY(user_id,parent_capture_id,file_id) REFERENCES ig_archive_links(user_id,capture_id,file_id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_import_uploads(user_id TEXT NOT NULL,id TEXT NOT NULL,stage_id TEXT NOT NULL,manifest TEXT NOT NULL,epoch INTEGER NOT NULL,expires INTEGER NOT NULL,file_id TEXT,PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,file_id) REFERENCES ig_archive_files(user_id,id));
 CREATE TABLE IF NOT EXISTS ig_import_parts(user_id TEXT NOT NULL,upload_id TEXT NOT NULL,part INTEGER NOT NULL,checksum TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(user_id,upload_id,part),FOREIGN KEY(user_id,upload_id) REFERENCES ig_import_uploads(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_parts(user_id TEXT NOT NULL,hash TEXT NOT NULL,part INTEGER NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(user_id,hash,part),FOREIGN KEY(user_id,hash) REFERENCES ig_objects(user_id,hash) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_originals(user_id TEXT NOT NULL,id TEXT NOT NULL,source_id TEXT NOT NULL,capture_id TEXT NOT NULL,hash TEXT NOT NULL,mime TEXT NOT NULL,retention TEXT NOT NULL,
 PRIMARY KEY(user_id,id),UNIQUE(user_id,source_id,capture_id),FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE,FOREIGN KEY(user_id,capture_id) REFERENCES pd_captures(user_id,id) ON DELETE CASCADE,FOREIGN KEY(user_id,hash) REFERENCES ig_objects(user_id,hash));
 CREATE TABLE IF NOT EXISTS ig_snapshot_inputs(user_id TEXT NOT NULL,original_id TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(user_id,original_id),FOREIGN KEY(user_id,original_id) REFERENCES ig_originals(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_capture_scopes(user_id TEXT NOT NULL,capture_id TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(user_id,capture_id),FOREIGN KEY(user_id,capture_id) REFERENCES pd_captures(user_id,id) ON DELETE CASCADE,FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE);
 CREATE TRIGGER IF NOT EXISTS ig_source_delete BEFORE DELETE ON pd_sources BEGIN DELETE FROM pd_captures WHERE user_id=old.user_id AND id IN(SELECT capture_id FROM ig_capture_scopes WHERE user_id=old.user_id AND source_id=old.id); END;
 CREATE TABLE IF NOT EXISTS ig_pins(user_id TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,hash) REFERENCES ig_objects(user_id,hash) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_uploads(user_id TEXT NOT NULL,id TEXT NOT NULL,source_id TEXT NOT NULL,request_key TEXT NOT NULL,manifest_hash TEXT NOT NULL,manifest TEXT NOT NULL,authorization_epoch INTEGER NOT NULL,expires INTEGER NOT NULL,receipt TEXT,PRIMARY KEY(user_id,id),UNIQUE(user_id,source_id,request_key),FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_upload_imports(user_id TEXT NOT NULL,upload_id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(user_id,upload_id),FOREIGN KEY(user_id,upload_id) REFERENCES ig_uploads(user_id,id) ON DELETE CASCADE);
   CREATE TABLE IF NOT EXISTS ig_upload_parts(user_id TEXT NOT NULL,upload_id TEXT NOT NULL,part INTEGER NOT NULL,checksum TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(user_id,upload_id,part),FOREIGN KEY(user_id,upload_id) REFERENCES ig_uploads(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_upload_recoveries(user_id TEXT NOT NULL,upload_id TEXT NOT NULL,original_id TEXT NOT NULL,recovery_id TEXT NOT NULL,PRIMARY KEY(user_id,upload_id),FOREIGN KEY(user_id,upload_id) REFERENCES ig_uploads(user_id,id) ON DELETE CASCADE,FOREIGN KEY(user_id,original_id) REFERENCES ig_originals(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_batches(user_id TEXT NOT NULL,source_id TEXT NOT NULL,batch_id TEXT NOT NULL,digest TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(user_id,source_id,batch_id),FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_devices(user_id TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(user_id,id));
 CREATE TABLE IF NOT EXISTS ig_work(user_id TEXT NOT NULL,id TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(user_id,id));
 CREATE TABLE IF NOT EXISTS ig_activity(user_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(user_id,id));
 CREATE TABLE IF NOT EXISTS ig_restore(user_id TEXT NOT NULL,operation_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(user_id,operation_id));
 `);
 if(!db.prepare('PRAGMA table_info(ig_file_forgets)').all().some(row=>row.name==='decision_id')){
  db.exec('ALTER TABLE ig_file_forgets ADD COLUMN decision_id TEXT');
 }
 // Resume an interrupted schema upgrade without rotating an existing decision.
 for(const row of db.prepare('SELECT user_id,source_id,external_id FROM ig_file_forgets WHERE decision_id IS NULL').all())db.prepare('UPDATE ig_file_forgets SET decision_id=? WHERE user_id=? AND source_id=? AND external_id=? AND decision_id IS NULL').run(randomUUID(),String(row.user_id),String(row.source_id),String(row.external_id));
 // A source's FK cascade must not reset an old page, ticket or task to zero.
 // This authorization counter survives source/capture removal, contains no
 // content or executable grant, and is erased by the account lifecycle.
 db.exec(`INSERT INTO ig_file_generations SELECT user_id,source_id,external_id,generation FROM ig_file_forgets WHERE true ON CONFLICT(user_id,source_id,external_id) DO UPDATE SET generation=MAX(ig_file_generations.generation,excluded.generation);
 CREATE TRIGGER IF NOT EXISTS ig_file_capture_retired BEFORE DELETE ON pd_captures
 WHEN old.source_id IS NOT NULL AND old.external_id IS NOT NULL AND json_extract(old.json,'$.source')='file'
 AND COALESCE((SELECT deleted FROM ig_state WHERE user_id=old.user_id),0)=0
 AND NOT EXISTS(SELECT 1 FROM ig_file_forgets f WHERE f.user_id=old.user_id AND f.source_id=old.source_id AND f.external_id=old.external_id AND f.blocked=1)
 BEGIN
 INSERT INTO ig_file_generations VALUES(old.user_id,old.source_id,old.external_id,COALESCE((SELECT generation FROM ig_file_forgets WHERE user_id=old.user_id AND source_id=old.source_id AND external_id=old.external_id),0)+1)
 ON CONFLICT(user_id,source_id,external_id) DO UPDATE SET generation=MAX(ig_file_generations.generation+1,excluded.generation);
 END;
 CREATE TRIGGER IF NOT EXISTS ig_raw_capture_retired BEFORE DELETE ON pd_captures
 WHEN json_extract(old.json,'$.source')!='file' AND COALESCE((SELECT deleted FROM ig_state WHERE user_id=old.user_id),0)=0
 BEGIN
 INSERT INTO ig_file_generations VALUES(old.user_id,'@capture',old.id,1)
 ON CONFLICT(user_id,source_id,external_id) DO UPDATE SET generation=ig_file_generations.generation+1;
 END;`);
 if(!db.prepare('PRAGMA table_info(ig_pins)').all().some(row=>row.name==='original_id'))db.exec('ALTER TABLE ig_pins ADD COLUMN original_id TEXT');
 // Existing admitted snapshot references receive their initial recovery window
 // once. Restart and receipt replay never extend an existing window.
 db.prepare("INSERT INTO ig_snapshot_inputs SELECT r.user_id,r.id,? FROM ig_originals r JOIN pd_captures c ON c.user_id=r.user_id AND c.id=r.capture_id WHERE r.retention='snapshot' AND json_extract(c.json,'$.source')='file' AND json_extract(c.json,'$.provenance.layer')='snapshot' AND json_type(c.json,'$.provenance.document.fileIndex')='object' ON CONFLICT(user_id,original_id) DO NOTHING").run(Date.now()+86400000);
 db.prepare('INSERT OR IGNORE INTO ig_meta VALUES(1,?)').run(randomBytes(32).toString('hex'));
 return String(db.prepare('SELECT ticket_key FROM ig_meta WHERE singleton=1').get()!.ticket_key);
}

/** Host-owned completion journal. Revocation must not prevent releasing a
 * specific already-issued local I/O lease. No caller-selected SQL escapes. */
export function ingressActivity(db:DatabaseSync,userId:string){
 const id=randomUUID();db.prepare('INSERT INTO ig_activity VALUES(?,?)').run(userId,id);
 return {id,finish:()=>{db.prepare('DELETE FROM ig_activity WHERE user_id=? AND id=?').run(userId,id);}};
}
