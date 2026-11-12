import type {EvidenceDependencies} from '@mote/shared';
import type {Store} from './store.js';
import {StoreError} from './store.js';
import {resolveDependencies} from './conversation-lineage.js';

/** SQL-only retirement, shared by evidence mutations and domain-owned triggers.
 * Keep the request receipt and dependency identities; erase both private bodies.
 * A stale task cannot be resumed by a late worker or an idempotent retry. */
export function retireTaskRecordsSql(selection:string){
  return `UPDATE task_records SET state='stale',revision=revision+1,input_json=NULL,result_json=NULL,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE state!='stale' AND id IN (${selection});`;
}

/** Domain owners may embed retireTaskRecordsSql in their own persisted triggers.
 * To erase their own prose/caches, install an AFTER UPDATE OF state trigger on
 * task_records WHEN new.state='stale' AND old.state!='stale', keyed by new.id.
 * Such cleanup runs in this same transaction, including in maintenance writers.
 * This entrypoint participates in the caller's evidence/forget transaction and
 * also covers private inputs of tasks which have not produced any result yet. */
export function invalidateTaskEvidence(store:Store,ids?:readonly string[]){
  const selection=ids===undefined?'SELECT id FROM task_records':
    'SELECT task_id FROM task_evidence WHERE evidence_id IN (SELECT value FROM json_each(?))';
  store.db.prepare(retireTaskRecordsSql(selection)).run(...(ids===undefined?[]:[JSON.stringify(ids)]));
}

export function installTaskEvidence(store:Store){
  const db=store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS task_evidence(
    task_id TEXT NOT NULL REFERENCES task_records(id) ON DELETE CASCADE,
    evidence_id TEXT NOT NULL,PRIMARY KEY(task_id,evidence_id));
    CREATE INDEX IF NOT EXISTS task_evidence_original ON task_evidence(evidence_id,task_id);`);
  // Persisted triggers also protect maintenance/backup writers without a live
  // TaskRecords instance. Material retirement calls EvidenceStore's invalidation
  // entrypoint; its optional tables need not exist during vault installation.
  for(const table of ['captures','file_chunks','context_artifacts','memories']){
    db.exec(`CREATE TRIGGER IF NOT EXISTS task_${table}_deleted BEFORE DELETE ON ${table} BEGIN
      ${retireTaskRecordsSql('SELECT task_id FROM task_evidence WHERE evidence_id=old.id')}
    END;`);
  }
}

/** These are host disclosure receipts, never citations or processing grants.
 * Resolve ancestors now, before a disposable derived representation disappears. */
export function validateTaskDependencies(dependencies:EvidenceDependencies):EvidenceDependencies{
  if(dependencies?.version!==1||dependencies.complete!==true||!Array.isArray(dependencies.ids)||
    dependencies.ids.some(id=>typeof id!=='string'||!id||id.length>512))
    throw new StoreError('Task requires complete evidence dependencies',409);
  return {version:1,complete:true,ids:[...new Set(dependencies.ids)].sort()};
}
export function taskEvidenceIds(store:Store,dependencies:EvidenceDependencies):string[]{
  return [...new Set(resolveDependencies(store,validateTaskDependencies(dependencies))!.ids)].sort();
}

export function addTaskEvidence(store:Store,id:string,ids:readonly string[]){
  const insert=store.db.prepare('INSERT OR IGNORE INTO task_evidence(task_id,evidence_id) VALUES(?,?)');
  for(const evidenceId of ids)insert.run(id,evidenceId);
}
