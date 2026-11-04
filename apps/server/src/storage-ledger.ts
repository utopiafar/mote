import type {DatabaseSync} from 'node:sqlite';

/** Keep reservations aligned with the dependency expression below. */
export const memoryDeletionDependencyBytes=(deletionId:string,evidenceId:string,originKeys:string,lineageKeys:string)=>Buffer.byteLength(deletionId)+Buffer.byteLength(evidenceId)+Buffer.byteLength(originKeys)+Buffer.byteLength(lineageKeys)+128;

/** One registered table and the logical-byte expression its plugin declared. */
export interface StorageMeterEntry {readonly name:string;readonly bytes:number}
export interface StorageMeterGroup {readonly plugin:string;readonly bytes:number;readonly tables:readonly StorageMeterEntry[]}
export interface StorageMeterBreakdown {readonly bytes:number;readonly plugins:readonly StorageMeterGroup[]}
export type StorageMeters=Readonly<Record<string,string>>;

const identifier=/^[a-z_][a-z0-9_]*$/;

/** Transactional logical payload accounting. SQLite indexes/WAL are physical
 * overhead, intentionally reported separately. The ledger owns no domain table
 * names: the vault and each domain plugin register the durable tables they
 * create. Registrations are persisted so a stopped/absent plugin still has its
 * retained rows counted and attributed on later reads and restarts. */
export class StorageLedger {
  private schemaVersion=-1;
  /** `excluded` names remain metered rows (and stay visible in `stats()`), but
   * the vault decides which physical object stores are not logical payload. */
  constructor(private db:DatabaseSync,private excluded:readonly string[]=[]) {
    db.exec(`CREATE TABLE IF NOT EXISTS storage_ledger(name TEXT PRIMARY KEY,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS storage_ledger_meters(name TEXT PRIMARY KEY,plugin TEXT NOT NULL,expression TEXT NOT NULL);`);
  }
  /** Register or re-declare the tables one plugin owns. A changed expression
   * rebuilds that table's row/triggers on the next read. */
  register(plugin:string,meters:StorageMeters){this.registerAll({[plugin]:meters});}
  /** Install several plugin declarations in one boundary (fixed startup inventory). */
  registerAll(groups:Readonly<Record<string,StorageMeters>>){
    const db=this.db,ownTransaction=!db.isTransaction;if(ownTransaction)db.exec('BEGIN IMMEDIATE');
    try{
      for(const [plugin,meters] of Object.entries(groups)){
        if(typeof plugin!=='string'||!plugin.trim())throw Error('Storage meter plugin is required');
        for(const [name,expression] of Object.entries(meters)){
          if(!identifier.test(name)||typeof expression!=='string'||!expression.trim())throw Error('Invalid storage meter');
          const prior=db.prepare('SELECT expression FROM storage_ledger_meters WHERE name=?').get(name) as {expression:string}|undefined;
          if(prior&&String(prior.expression)!==expression){
            db.exec(`DROP TRIGGER IF EXISTS ledger_${name}_insert;DROP TRIGGER IF EXISTS ledger_${name}_delete;DROP TRIGGER IF EXISTS ledger_${name}_update;`);
            db.prepare('DELETE FROM storage_ledger WHERE name=?').run(name);
          }
          db.prepare('INSERT INTO storage_ledger_meters(name,plugin,expression) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET plugin=excluded.plugin,expression=excluded.expression').run(name,plugin,expression);
        }
      }
      if(ownTransaction)db.exec('COMMIT');
    }catch(error){if(ownTransaction&&db.isTransaction)db.exec('ROLLBACK');throw error;}
    this.schemaVersion=-1;
  }
  bytes(){
    this.refresh();
    const filter=this.excluded.length?`name NOT IN (${this.excluded.map(()=>'?').join(',')})`:'1=1';
    return Number(this.db.prepare(`SELECT COALESCE(SUM(bytes),0) AS n FROM storage_ledger WHERE ${filter}`).get(...this.excluded)!.n);
  }
  /** Durable per-table accounting with its owning plugin, including plugins that
   * are not active in this process. Physical blob/object rows stay in `stats()`. */
  breakdown():StorageMeterBreakdown{
    this.refresh();
    const filter=this.excluded.length?`AND m.name NOT IN (${this.excluded.map(()=>'?').join(',')})`:'';
    const rows=this.db.prepare(`SELECT m.plugin AS plugin,m.name AS name,COALESCE(l.bytes,0) AS bytes FROM storage_ledger_meters m
      LEFT JOIN storage_ledger l ON l.name=m.name WHERE 1=1 ${filter} ORDER BY m.plugin,m.name`).all(...this.excluded) as {plugin:string;name:string;bytes:number}[];
    const groups=new Map<string,{plugin:string;bytes:number;tables:{name:string;bytes:number}[]}>();
    for(const row of rows){
      const plugin=String(row.plugin),group=groups.get(plugin)??{plugin,bytes:0,tables:[]};
      const bytes=Number(row.bytes);group.bytes+=bytes;group.tables.push({name:String(row.name),bytes});groups.set(plugin,group);
    }
    return {bytes:[...groups.values()].reduce((sum,group)=>sum+group.bytes,0),plugins:[...groups.values()].sort((a,b)=>b.bytes-a.bytes||a.plugin.localeCompare(b.plugin))};
  }
  private refresh(){
    const version=Number(this.db.prepare('PRAGMA schema_version').get()!.schema_version);
    if(version!==this.schemaVersion)this.install();
    this.schemaVersion=Number(this.db.prepare('PRAGMA schema_version').get()!.schema_version);
  }
  private install(){
    const meters=this.db.prepare('SELECT name,expression FROM storage_ledger_meters ORDER BY name').all() as {name:string;expression:string}[];
    if(!meters.length)return;
    const tables=new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>String(r.name)));
    const ownTransaction=!this.db.isTransaction;if(ownTransaction)this.db.exec('BEGIN IMMEDIATE');
    try{for(const {name,expression} of meters){
      if(!tables.has(name)||this.db.prepare('SELECT 1 FROM storage_ledger WHERE name=?').get(name))continue;
      const columns=this.db.prepare(`PRAGMA table_info(${name})`).all().map(r=>String(r.name));
      const qualify=(prefix:string)=>expression.replace(/\b[a-z_]+\b/g,word=>columns.includes(word)?`${prefix}.${word}`:word);
      this.db.exec(`INSERT INTO storage_ledger SELECT '${name}',COALESCE(SUM(${expression}),0) FROM ${name};
        CREATE TRIGGER ledger_${name}_insert AFTER INSERT ON ${name} BEGIN UPDATE storage_ledger SET bytes=bytes+(${qualify('new')}) WHERE name='${name}'; END;
        CREATE TRIGGER ledger_${name}_delete AFTER DELETE ON ${name} BEGIN UPDATE storage_ledger SET bytes=bytes-(${qualify('old')}) WHERE name='${name}'; END;
        CREATE TRIGGER ledger_${name}_update AFTER UPDATE ON ${name} BEGIN UPDATE storage_ledger SET bytes=bytes+(${qualify('new')})-(${qualify('old')}) WHERE name='${name}'; END;`);
    }
    if(ownTransaction)this.db.exec('COMMIT');
    }catch(error){if(ownTransaction)this.db.exec('ROLLBACK');throw error;}
  }
}
