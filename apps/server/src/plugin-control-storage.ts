import type {DatabaseSync} from 'node:sqlite';
import {installSchemaPlan,type SchemaInstallation} from './schema-installation.js';
import {sha256,StoreError,type Store} from './store.js';
import type {PluginControlStore as PluginControlAccess,PluginCommand,PluginCommandReceipt,BuildInstance} from './plugins/plugin-control-store.js';

export const pluginControlSchemaInstallation={owner:'plugin-control',requires:[],install:pluginControlSchema} as const satisfies SchemaInstallation;

/** The control constructor retains its original four-table and seed closure. */
function pluginControlSchema(db:DatabaseSync){db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_center(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO plugin_center VALUES(1,1);
    CREATE TABLE IF NOT EXISTS plugin_commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plugin_control_receipts(id TEXT PRIMARY KEY,json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plugin_build_instances(id TEXT PRIMARY KEY,json TEXT NOT NULL);
  `);}

/** One vault transaction owns CAS, intent identity and its acknowledgement.
 * Runtime effects occur only after COMMIT; receipts never assert their completion.
 * These feature-owned tables install before app.ready(). */
class PluginControlStore {
  constructor(private readonly store:Store){installSchemaPlan(store.db,[pluginControlSchemaInstallation]);
  store.registerStorage('plugin-control',{
    plugin_center:'144',
    plugin_commands:'length(CAST(id AS BLOB))+length(CAST(fingerprint AS BLOB))+128',
    plugin_control_receipts:'length(CAST(json AS BLOB))+length(CAST(id AS BLOB))+128',
    plugin_build_instances:'length(CAST(json AS BLOB))+length(CAST(id AS BLOB))+128',
  });}
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
    const json=JSON.stringify(value),prior=this.store.db.prepare('SELECT json FROM plugin_build_instances WHERE id=?').get(value.id);
    if(prior?.json===json)return;

    this.store.db.prepare('INSERT INTO plugin_build_instances VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(value.id,json);
  }
}

/** The Vault retains the real repository. Control consumers receive frozen
 * operations and cannot recover its Store through a public field or prototype. */
export function createVaultPluginControlStore(store:Store,current:()=>void):PluginControlAccess {
  current();const control=new PluginControlStore(store);
  return Object.freeze({
    revision(){current();return control.revision();},
    bump(){current();control.bump();},
    command(kind: string,input:PluginCommand,revision:()=>number,apply:()=>void){current();return control.command(kind,input,()=>{current();return revision();},()=>{current();apply();current();});},
    receipt(operationId:string){current();return control.receipt(operationId);},
    build(id:string){current();return control.build(id);},
    builds(){current();return control.builds();},
    saveBuild(value:BuildInstance){current();control.saveBuild(value);},
  });
}
