import type {Store} from './store.js';
import {StoreError} from './store.js';

/** Private execution products: never indexed, exported as originals, or accepted
 * as citation authority. Vault encryption policy also applies to these payloads. */
export class DelegationStore {
  constructor(readonly store:Store){
    store.db.exec(`CREATE TABLE IF NOT EXISTS delegation_works(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_payloads(work_id TEXT PRIMARY KEY REFERENCES delegation_works(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_results(work_id TEXT PRIMARY KEY REFERENCES delegation_works(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_units(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES delegation_works(id) ON DELETE CASCADE,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS delegation_units_work ON delegation_units(work_id);
      CREATE TABLE IF NOT EXISTS delegation_artifacts(id TEXT PRIMARY KEY,work_id TEXT NOT NULL REFERENCES delegation_works(id) ON DELETE CASCADE,unit_id TEXT NOT NULL REFERENCES delegation_units(id) ON DELETE CASCADE,json TEXT NOT NULL,metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS delegation_events(id INTEGER PRIMARY KEY AUTOINCREMENT,work_id TEXT NOT NULL REFERENCES delegation_works(id) ON DELETE CASCADE,type TEXT NOT NULL,message TEXT,unit_id TEXT,at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS delegation_events_work ON delegation_events(work_id,id);
      CREATE TABLE IF NOT EXISTS delegation_dependencies(work_id TEXT NOT NULL REFERENCES delegation_works(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,PRIMARY KEY(work_id,evidence_id));
      CREATE INDEX IF NOT EXISTS delegation_dependency_evidence ON delegation_dependencies(evidence_id,work_id);
      DROP TRIGGER IF EXISTS delegation_original_deleted;
      CREATE TRIGGER IF NOT EXISTS delegation_original_deleted AFTER INSERT ON changes WHEN new.operation='delete' BEGIN
        DELETE FROM delegation_artifacts WHERE work_id IN (SELECT work_id FROM delegation_dependencies WHERE evidence_id=new.id);
        DELETE FROM delegation_payloads WHERE work_id IN (SELECT work_id FROM delegation_dependencies WHERE evidence_id=new.id);
        DELETE FROM delegation_results WHERE work_id IN (SELECT work_id FROM delegation_dependencies WHERE evidence_id=new.id);
        DELETE FROM delegation_events WHERE work_id IN (SELECT work_id FROM delegation_dependencies WHERE evidence_id=new.id);
        UPDATE delegation_works SET json=json_set(json_remove(json,'$.private'),'$.status','stale','$.goal','','$.error','evidence_deleted') WHERE id IN (SELECT work_id FROM delegation_dependencies WHERE evidence_id=new.id);
        UPDATE delegation_units SET json=json_set(json_remove(json,'$.private'),'$.status','stale','$.title','','$.goal','','$.input',json('{}'),'$.error','evidence_deleted') WHERE work_id IN (SELECT work_id FROM delegation_dependencies WHERE evidence_id=new.id);
      END;`);
  }
  encodePrivate(value:unknown){const bytes=Buffer.from(JSON.stringify(value));return this.store.contentEncryption.enabled?'aes:'+this.store.contentEncryption.seal(bytes).toString('base64'):'json:'+bytes.toString('utf8');}
  decodePrivate<T>(value:string):T {return JSON.parse(value.startsWith('aes:')?this.store.contentEncryption.open(Buffer.from(value.slice(4),'base64')).toString('utf8'):value.slice(5)) as T;}
  payload<T>(id:string):T {const row=this.store.db.prepare('SELECT json FROM delegation_payloads WHERE work_id=?').get(id);if(!row)throw new StoreError('Delegation input is no longer available',409);return this.decodePrivate<T>(String(row.json));}
  savePayload(id:string,value:unknown){const json=this.encodePrivate(value);if(Buffer.byteLength(json)>2_000_000)throw new StoreError('Delegation input is too large',413);this.store.reserveMetadata(Buffer.byteLength(json)+256);this.store.db.prepare('INSERT OR REPLACE INTO delegation_payloads VALUES(?,?)').run(id,json);}
  result<T>(id:string):T|undefined {const row=this.store.db.prepare('SELECT json FROM delegation_results WHERE work_id=?').get(id);return row?this.decodePrivate<T>(String(row.json)):undefined;}
  saveResult(id:string,value:unknown){const json=this.encodePrivate(value);if(Buffer.byteLength(json)>2_000_000)throw new StoreError('Delegation result is too large',413);this.store.reserveMetadata(Buffer.byteLength(json)+256);this.store.db.prepare('INSERT OR REPLACE INTO delegation_results VALUES(?,?)').run(id,json);}
  artifact<T>(id:string):T {const row=this.store.db.prepare('SELECT json FROM delegation_artifacts WHERE id=?').get(id);if(!row)throw new StoreError('Delegation artifact is no longer available',409);return this.decodePrivate<T>(String(row.json));}
  saveArtifact(id:string,workId:string,unitId:string,value:unknown,metadata:unknown){const json=this.encodePrivate(value),encodedMetadata=this.encodePrivate(metadata);if(Buffer.byteLength(json)>2_000_000)throw new StoreError('Delegation artifact is too large',413);this.store.reserveMetadata(Buffer.byteLength(json)+Buffer.byteLength(encodedMetadata)+1024);this.store.db.prepare('INSERT INTO delegation_artifacts VALUES(?,?,?,?,?)').run(id,workId,unitId,json,encodedMetadata);}
}
