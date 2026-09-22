import type {DatabaseSync} from 'node:sqlite';

/** Transactional logical payload accounting. SQLite indexes/WAL are physical overhead,
 * intentionally reported separately. Newly installed plugin tables join on next read. */
export class StorageLedger {
  private schemaVersion=-1;
  constructor(private db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS storage_ledger(name TEXT PRIMARY KEY,bytes INTEGER NOT NULL)');
    if(!db.prepare("SELECT 1 FROM settings WHERE key='asset-storage-ledger-v2'").get()){
      for(const table of ['blobs','file_blobs','file_objects'])db.exec(`DROP TRIGGER IF EXISTS ledger_${table}_insert; DROP TRIGGER IF EXISTS ledger_${table}_update; DROP TRIGGER IF EXISTS ledger_${table}_delete; DELETE FROM storage_ledger WHERE name='${table}'`);
      db.prepare('INSERT INTO settings VALUES(?,?)').run('asset-storage-ledger-v2','1');
    }
  }
  bytes(){
    const version=Number(this.db.prepare('PRAGMA schema_version').get()!.schema_version);
    if(version!==this.schemaVersion)this.refresh();
    return Number(this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM storage_ledger WHERE name NOT IN ('blobs','file_blobs','file_objects')").get()!.n);
  }
  private refresh(){
    const jsonTables=['import_uploads','todos','perception_results','captures','memories','source_connections','conversations','conversation_turns','memory_jobs','memory_batches','archived_files','import_jobs','file_artifacts','file_reviews','insight_runs','query_runs','model_usage','model_prices','memory_lifecycle_settings','memory_lifecycle_state','working_memories','action_meta','action_proposals','action_targets','context_contents','context_artifacts','processing_jobs'];
    const expressions:Record<string,string>=Object.fromEntries(jsonTables.map(t=>[t,'length(CAST(json AS BLOB))']));
    Object.assign(expressions,{operation_progress:'length(CAST(id AS BLOB))+256',operation_changes:'length(CAST(operation_id AS BLOB))+32',execution_steps:'length(CAST(input AS BLOB))+512',execution_resources:'length(CAST(resource_key AS BLOB))+64',import_upload_parts:'bytes',assets:'bytes',blobs:'bytes',file_blobs:'bytes',file_objects:'bytes',file_chunks:'length(CAST(text AS BLOB))+COALESCE(length(embedding),0)',file_versions:'length(CAST(manifest AS BLOB))',file_uploads:'length(CAST(manifest AS BLOB))',file_parts:'bytes'});
    const tables=new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>String(r.name)));
    const ownTransaction=!this.db.isTransaction;if(ownTransaction)this.db.exec('BEGIN IMMEDIATE');
    try{for(const [name,expression] of Object.entries(expressions)){
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
    this.schemaVersion=Number(this.db.prepare('PRAGMA schema_version').get()!.schema_version);
  }
}
