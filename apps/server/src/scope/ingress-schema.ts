import type {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID} from 'node:crypto';

/** M03 adapts the existing immutable chunk/receipt mechanism to the admitted
 * shared epoch-5 database. Every private key and relationship includes owner. */
export function installIngress(db:DatabaseSync){
 db.exec(`
 CREATE TABLE IF NOT EXISTS ig_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),ticket_key TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS ig_state(user_id TEXT PRIMARY KEY,deleted INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS ig_objects(user_id TEXT NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,parts INTEGER NOT NULL,PRIMARY KEY(user_id,hash));
 CREATE TABLE IF NOT EXISTS ig_parts(user_id TEXT NOT NULL,hash TEXT NOT NULL,part INTEGER NOT NULL,checksum TEXT NOT NULL,PRIMARY KEY(user_id,hash,part),FOREIGN KEY(user_id,hash) REFERENCES ig_objects(user_id,hash) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_originals(user_id TEXT NOT NULL,id TEXT NOT NULL,source_id TEXT NOT NULL,capture_id TEXT NOT NULL,hash TEXT NOT NULL,mime TEXT NOT NULL,retention TEXT NOT NULL,
 PRIMARY KEY(user_id,id),UNIQUE(user_id,source_id,capture_id),FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE,FOREIGN KEY(user_id,capture_id) REFERENCES pd_captures(user_id,id) ON DELETE CASCADE,FOREIGN KEY(user_id,hash) REFERENCES ig_objects(user_id,hash));
 CREATE TABLE IF NOT EXISTS ig_capture_scopes(user_id TEXT NOT NULL,capture_id TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(user_id,capture_id),FOREIGN KEY(user_id,capture_id) REFERENCES pd_captures(user_id,id) ON DELETE CASCADE,FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE);
 CREATE TRIGGER IF NOT EXISTS ig_source_delete BEFORE DELETE ON pd_sources BEGIN DELETE FROM pd_captures WHERE user_id=old.user_id AND id IN(SELECT capture_id FROM ig_capture_scopes WHERE user_id=old.user_id AND source_id=old.id); END;
 CREATE TABLE IF NOT EXISTS ig_pins(user_id TEXT NOT NULL,id TEXT NOT NULL,hash TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(user_id,id),FOREIGN KEY(user_id,hash) REFERENCES ig_objects(user_id,hash) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_uploads(user_id TEXT NOT NULL,id TEXT NOT NULL,source_id TEXT NOT NULL,request_key TEXT NOT NULL,manifest_hash TEXT NOT NULL,manifest TEXT NOT NULL,authorization_epoch INTEGER NOT NULL,expires INTEGER NOT NULL,receipt TEXT,PRIMARY KEY(user_id,id),UNIQUE(user_id,source_id,request_key),FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_upload_parts(user_id TEXT NOT NULL,upload_id TEXT NOT NULL,part INTEGER NOT NULL,checksum TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(user_id,upload_id,part),FOREIGN KEY(user_id,upload_id) REFERENCES ig_uploads(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_batches(user_id TEXT NOT NULL,source_id TEXT NOT NULL,batch_id TEXT NOT NULL,digest TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(user_id,source_id,batch_id),FOREIGN KEY(user_id,source_id) REFERENCES pd_sources(user_id,id) ON DELETE CASCADE);
 CREATE TABLE IF NOT EXISTS ig_devices(user_id TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(user_id,id));
 CREATE TABLE IF NOT EXISTS ig_work(user_id TEXT NOT NULL,id TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(user_id,id));
 CREATE TABLE IF NOT EXISTS ig_activity(user_id TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(user_id,id));
 CREATE TABLE IF NOT EXISTS ig_restore(user_id TEXT NOT NULL,operation_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(user_id,operation_id));
 `);
 db.prepare('INSERT OR IGNORE INTO ig_meta VALUES(1,?)').run(randomBytes(32).toString('hex'));
 return String(db.prepare('SELECT ticket_key FROM ig_meta WHERE singleton=1').get()!.ticket_key);
}

/** Host-owned completion journal. Revocation must not prevent releasing a
 * specific already-issued local I/O lease. No caller-selected SQL escapes. */
export function ingressActivity(db:DatabaseSync,userId:string){
 const id=randomUUID();db.prepare('INSERT INTO ig_activity VALUES(?,?)').run(userId,id);
 return {id,finish:()=>{db.prepare('DELETE FROM ig_activity WHERE user_id=? AND id=?').run(userId,id);}};
}
