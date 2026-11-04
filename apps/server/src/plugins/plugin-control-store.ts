import type {PluginPackageView,PluginInstanceView} from '@mote/shared';
import type {PluginManifest} from '../plugin-release.js';
import {sha256,StoreError,type Store} from '../store.js';

export interface PluginCommand {readonly operationId:string;readonly expectedRevision:number}
/** An acknowledgement of a committed control intent, not proof of a remote effect. */
export interface PluginCommandReceipt {readonly operationId:string;readonly kind:string;readonly revision:number}
export interface BuildSelection {readonly packageId:string;readonly version:string;readonly configurationRevision:number}
export type BuildObserved='queued'|'starting'|'active'|'stopped'|'blocked'|'restart_required'|'draining';
/** One durable build/instance record. Native builds select a trusted host
 * contribution; worker packages retain their release artifact and configured
 * instance in the same record instead of separate package/instance tables. */
export interface BuildInstance {
  readonly id:string;readonly packageId:string;readonly installationId:string;
  revision:number;desired:BuildSelection|null;retired:boolean;
  observed:BuildObserved;
  blockers:string[];operationId:string;
  /** Worker activation retained for draining despite desired becoming null. */
  activeSelection?:BuildSelection|null;
  readonly kind?:'native'|'package'|'instance';
  readonly version?:string;
  readonly package?:BuildPackageRecord;
  readonly instance?:BuildInstanceRecord;
}
export interface BuildPackageRecord {
  installationId:string;view:PluginPackageView;manifest:PluginManifest;directory?:string;previewId:string;
  hostAdapter?:'mote.mem0@1'|'mote.hindsight@1';
}
export interface BuildInstanceRecord {view:PluginInstanceView;configurationId?:string;stepId?:string}

/** One vault transaction owns CAS, intent identity and its acknowledgement.
 * Runtime effects occur only after COMMIT; receipts never assert their completion.
 * These feature-owned tables install before app.ready(). */
export class PluginControlStore {
  constructor(readonly store:Store){store.db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_center(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO plugin_center VALUES(1,1);
    CREATE TABLE IF NOT EXISTS plugin_commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plugin_control_receipts(id TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plugin_build_instances(id TEXT PRIMARY KEY,json TEXT NOT NULL);
  `);}
  revision(){return Number(this.store.db.prepare('SELECT revision FROM plugin_center WHERE id=1').get()!.revision);}
  bump(){this.store.db.prepare('UPDATE plugin_center SET revision=revision+1 WHERE id=1').run();}
  command(kind:string,input:PluginCommand,revision:()=>number,apply:()=>void){
    const fingerprint=sha256(JSON.stringify({kind,...input})),db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try{
      const prior=db.prepare('SELECT fingerprint FROM plugin_commands WHERE id=?').get(input.operationId);
      if(prior){if(prior.fingerprint!==fingerprint)throw new StoreError('Plugin command identity conflict',409);db.exec('COMMIT');return false;}
      if(input.expectedRevision!==revision())throw new StoreError('Plugin settings changed; refresh before applying',409);
      apply();this.bump();
      const receipt:PluginCommandReceipt={operationId:input.operationId,kind,revision:this.revision()},json=JSON.stringify(receipt);
      this.store.reserveMetadata(Buffer.byteLength(json)+Buffer.byteLength(input.operationId)*2+512);
      db.prepare('INSERT INTO plugin_commands VALUES(?,?)').run(input.operationId,fingerprint);
      db.prepare('INSERT INTO plugin_control_receipts VALUES(?,?)').run(input.operationId,json);
      db.exec('COMMIT');return true;
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  receipt(operationId:string):PluginCommandReceipt|undefined{
    const row=this.store.db.prepare('SELECT json FROM plugin_control_receipts WHERE id=?').get(operationId);return row?JSON.parse(String(row.json)):undefined;
  }
  build(id:string):BuildInstance|undefined{
    const row=this.store.db.prepare('SELECT json FROM plugin_build_instances WHERE id=?').get(id);return row?JSON.parse(String(row.json)):undefined;
  }
  builds():BuildInstance[]{return this.store.db.prepare('SELECT json FROM plugin_build_instances ORDER BY rowid').all().map(row=>JSON.parse(String(row.json)));}
  saveBuild(value:BuildInstance){
    const json=JSON.stringify(value);this.store.reserveMetadata(Buffer.byteLength(json)+Buffer.byteLength(value.id)+128);
    this.store.db.prepare('INSERT INTO plugin_build_instances VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id,json);
  }
}
