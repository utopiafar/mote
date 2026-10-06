import type {DatabaseSync} from 'node:sqlite';

/** Keep reservations aligned with the dependency expression below. */
export const memoryDeletionDependencyBytes=(deletionId:string,evidenceId:string,originKeys:string,lineageKeys:string)=>Buffer.byteLength(deletionId)+Buffer.byteLength(evidenceId)+Buffer.byteLength(originKeys)+Buffer.byteLength(lineageKeys)+128;

/** Transactional logical payload accounting. SQLite indexes/WAL are physical overhead,
 * intentionally reported separately. Newly installed plugin tables join on next read. */
export class StorageLedger {
  private schemaVersion=-1;
  constructor(private db:DatabaseSync){db.exec('CREATE TABLE IF NOT EXISTS storage_ledger(name TEXT PRIMARY KEY,bytes INTEGER NOT NULL)');

  }
  bytes(){
    const version=Number(this.db.prepare('PRAGMA schema_version').get()!.schema_version);
    if(version!==this.schemaVersion)this.refresh();
    return Number(this.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM storage_ledger WHERE name NOT IN ('blobs','file_blobs','file_objects')").get()!.n);
  }
  private refresh(){
    const jsonTables=['import_uploads','todos','perception_results','captures','memories','memory_deletions','memory_input_plans','source_connections','conversations','conversation_turns','memory_jobs','memory_batches','memory_extraction_drafts','archived_files','import_jobs','file_artifacts','file_reviews','insight_runs','query_runs','model_usage','model_prices','memory_lifecycle_settings','memory_recipe_settings','memory_lifecycle_state','working_memories','action_meta','action_proposals','action_targets','context_contents','context_artifacts','processing_jobs','coding_conversation_contexts'];
    const expressions:Record<string,string>=Object.fromEntries(jsonTables.map(t=>[t,'length(CAST(json AS BLOB))']));
    expressions.image_products='length(CAST(json AS BLOB))+length(CAST(fingerprint AS BLOB))+256';
    expressions.image_inputs='coalesce(length(CAST(policy_json AS BLOB)),0)+512';
    expressions.image_attachment_intents='256';expressions.image_intake_overrides='192';expressions.image_backfills='length(CAST(query AS BLOB))+256';
    expressions.file_snapshot_inputs='256';expressions.file_snapshot_text='192';
    expressions.mcp_import_manifests='length(CAST(source_id AS BLOB))+length(CAST(identity AS BLOB))+length(CAST(members AS BLOB))+128';
    expressions.material_index_requests='length(CAST(material_id AS BLOB))+length(CAST(revision AS BLOB))+length(CAST(state AS BLOB))+coalesce(length(CAST(error AS BLOB)),0)+128';
    expressions.file_snapshot_index='length(CAST(json AS BLOB))+128';
    expressions.material_index_garbage='64';
    expressions.memory_deletion_dependencies='length(CAST(deletion_id AS BLOB))+length(CAST(evidence_id AS BLOB))+length(CAST(origin_keys AS BLOB))+length(CAST(lineage_keys AS BLOB))+128';
    Object.assign(expressions,{memory_input_authorizations:'length(CAST(source_id AS BLOB))+length(CAST(input_key AS BLOB))+length(CAST(scope AS BLOB))+COALESCE(length(CAST(binding_json AS BLOB)),0)+256',material_memory_requests:'length(CAST(required_json AS BLOB))+COALESCE(length(CAST(binding_json AS BLOB)),0)+512',material_block_payloads:'length(CAST(text AS BLOB))',material_revisions:'length(CAST(manifest AS BLOB))+256',material_blocks:'256',material_block_versions:'256',material_coding_snapshots:'256',material_members:'256',material_evidence:'128',material_evidence_context:'length(CAST(json AS BLOB))+128',material_evidence_dependencies:'128',source_archive_sizes:'bytes',source_archive_indexed_sources:'128',source_archive_groups:'length(CAST(group_key AS BLOB))+256',source_archive_versions:'512',source_archive_heads:'384',source_archive_batches:'128',source_archive_recovery_groups:'128',run_execution_owners:'128',operation_parents:'length(CAST(parent_id AS BLOB))+length(CAST(child_id AS BLOB))+256',file_configuration_snapshots:'length(CAST(receipt AS BLOB))+128',provider_cooldowns:'length(CAST(code AS BLOB))+128',operation_progress:'length(CAST(id AS BLOB))+256',operation_changes:'length(CAST(operation_id AS BLOB))+32',execution_steps:'length(CAST(input AS BLOB))+512',execution_resources:'length(CAST(resource_key AS BLOB))+64',import_upload_parts:'bytes',assets:'bytes',blobs:'bytes',file_blobs:'bytes',file_objects:'bytes',file_chunks:'length(CAST(text AS BLOB))+COALESCE(length(embedding),0)',file_versions:'length(CAST(manifest AS BLOB))',file_uploads:'length(CAST(manifest AS BLOB))',file_parts:'bytes'});
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
