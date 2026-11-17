import {installSchemaPlan} from './schema-installation.js';
import {evidenceDependenciesWithoutMaterialsInstallation,evidenceDependenciesWithMaterialsInstallation} from './asset-evidence-schema.js';
import type {EvidenceStore as Store} from './evidence-store.js';
export type EvidenceNode={kind:'capture'|'context_artifact'|'file_artifact'|'file_chunk'|'material_evidence'|'memory'|'memory_batch';id:string};
/** A projection over existing lineage, never another authoritative job or artifact store. */
export function installEvidenceDependencies(store:Store){
 const materials=Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_evidence_dependencies'").get());
 installSchemaPlan(store.db,[materials?evidenceDependenciesWithMaterialsInstallation:evidenceDependenciesWithoutMaterialsInstallation]);}
export function evidenceDependents(store:Store,node:EvidenceNode){return store.db.prepare(`WITH RECURSIVE descendants(kind,id) AS (
 SELECT ?,? UNION SELECT e.child_kind,e.child_id FROM evidence_dependency_edges e JOIN descendants d ON e.parent_kind=d.kind AND e.parent_id=d.id
 ) SELECT kind,id FROM descendants WHERE NOT(kind=? AND id=?) ORDER BY kind,id`).all(node.kind,node.id,node.kind,node.id) as EvidenceNode[];}

/** Retiring a derived container must only invalidate the evidence actually replaced. */
export function invalidateRetiredFileEvidence(store:Store,captureId:string){
 const retired=`WITH RECURSIVE descendants(kind,id) AS (
  SELECT 'file_chunk',c.id FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id WHERE c.capture_id=? AND (
   a.current=0 OR EXISTS(SELECT 1 FROM file_artifacts p WHERE p.capture_id=a.capture_id AND p.current=1 AND ((p.kind='corrected-dialogue' AND a.kind!='corrected-dialogue') OR (p.kind='dialogue' AND a.kind IN ('transcript','text','image-text'))))
  ) UNION SELECT e.child_kind,e.child_id FROM evidence_dependency_edges e JOIN descendants d ON e.parent_kind=d.kind AND e.parent_id=d.id
 ) `;
 const db=store.db;
 for(const anchor of db.prepare(retired+`SELECT id FROM descendants WHERE kind='material_evidence'`).all(captureId))
  store.invalidateMemoryEvidence(String(anchor.id));
 db.prepare(retired+`UPDATE memories SET json=json_set(json,'$.status','stale','$.staleReason','evidence_changed','$.updatedAt',?) WHERE id IN (SELECT id FROM descendants WHERE kind='memory') AND json_extract(json,'$.status')!='stale'`).run(captureId,new Date().toISOString());
 db.prepare(retired+`DELETE FROM memory_checkpoints WHERE evidence_id IN (SELECT id FROM descendants WHERE kind='file_chunk') OR evidence_id IN (SELECT evidence_id FROM memory_batch_dependencies WHERE batch_id IN (SELECT id FROM descendants WHERE kind='memory_batch'))`).run(captureId);
 db.prepare(retired+`UPDATE memory_batches SET json=json_set(json,'$.status','invalidated','$.errorCode','evidence_changed') WHERE id IN (SELECT id FROM descendants WHERE kind='memory_batch') AND json_extract(json,'$.status')!='invalidated'`).run(captureId);
}
