import {installSchemaPlan} from './schema-installation.js';
import {delegationJournalSchemaInstallation} from './delegation-schema.js';
import type {EvidenceStore as Store} from './evidence-store.js';
import {StoreError} from './evidence-store.js';

/** Private execution products: never indexed, exported as originals, or accepted
 * as citation authority. Vault encryption policy also applies to these payloads. */
export class DelegationStore {
  constructor(readonly store:Store){
    installSchemaPlan(store.db,[delegationJournalSchemaInstallation]);
    store.installContextHistoryInvalidation();
  }
  hasExternalUnits():boolean {
    return Boolean(this.store.db.prepare("SELECT 1 FROM delegation_units WHERE json_extract(json,'$.external')=1 LIMIT 1").get());
  }
  encodePrivate(value:unknown){const bytes=Buffer.from(JSON.stringify(value));return this.store.contentEncryption.enabled?'aes:'+this.store.contentEncryption.seal(bytes).toString('base64'):'json:'+bytes.toString('utf8');}
  decodePrivate<T>(value:string):T {return JSON.parse(value.startsWith('aes:')?this.store.contentEncryption.open(Buffer.from(value.slice(4),'base64')).toString('utf8'):value.slice(5)) as T;}
  payload<T>(id:string):T {const row=this.store.db.prepare('SELECT json FROM delegation_payloads WHERE work_id=?').get(id);if(!row)throw new StoreError('Delegation input is no longer available',409);return this.decodePrivate<T>(String(row.json));}
  savePayload(id:string,value:unknown){const json=this.encodePrivate(value);if(Buffer.byteLength(json)>2_000_000)throw new StoreError('Delegation input is too large',413);this.store.db.prepare('INSERT OR REPLACE INTO delegation_payloads VALUES(?,?)').run(id,json);}
  result<T>(id:string):T|undefined {const row=this.store.db.prepare('SELECT json FROM delegation_results WHERE work_id=?').get(id);return row?this.decodePrivate<T>(String(row.json)):undefined;}
  saveResult(id:string,value:unknown){const json=this.encodePrivate(value);if(Buffer.byteLength(json)>2_000_000)throw new StoreError('Delegation result is too large',413);this.store.db.prepare('INSERT OR REPLACE INTO delegation_results VALUES(?,?)').run(id,json);}
  artifact<T>(id:string):T {const row=this.store.db.prepare('SELECT json FROM delegation_artifacts WHERE id=?').get(id);if(!row)throw new StoreError('Delegation artifact is no longer available',409);return this.decodePrivate<T>(String(row.json));}
  saveArtifact(id:string,workId:string,unitId:string,value:unknown,metadata:unknown){const json=this.encodePrivate(value),encodedMetadata=this.encodePrivate(metadata);if(Buffer.byteLength(json)>2_000_000)throw new StoreError('Delegation artifact is too large',413);this.store.db.prepare('INSERT INTO delegation_artifacts VALUES(?,?,?,?,?)').run(id,workId,unitId,json,encodedMetadata);}
}
