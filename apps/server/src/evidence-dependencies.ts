import type {Store} from './store.js';
export type EvidenceNode={kind:'capture'|'context_artifact'|'file_artifact'|'file_chunk'|'memory'|'memory_batch';id:string};
/** A projection over existing lineage, never another authoritative job or artifact store. */
export function installEvidenceDependencies(store:Store){store.db.exec(`
 CREATE VIEW IF NOT EXISTS evidence_dependency_edges AS
 SELECT 'capture' parent_kind,observation_id parent_id,'context_artifact' child_kind,artifact_id child_id FROM artifact_inputs
 UNION ALL SELECT 'context_artifact',parent_id,'context_artifact',artifact_id FROM artifact_dependencies
 UNION ALL SELECT 'capture',capture_id,'file_artifact',id FROM file_artifacts
 UNION ALL SELECT 'file_artifact',p.value,'file_artifact',a.id FROM file_artifacts a,json_each(a.json,'$.inputArtifacts') p
 UNION ALL SELECT 'file_artifact',artifact_id,'file_chunk',id FROM file_chunks
 UNION ALL SELECT CASE WHEN c.id IS NULL THEN 'capture' ELSE 'file_chunk' END,d.evidence_id,'memory',d.memory_id FROM memory_dependencies d LEFT JOIN file_chunks c ON c.id=d.evidence_id
 UNION ALL SELECT 'context_artifact',artifact_id,'memory',memory_id FROM memory_artifact_dependencies
 UNION ALL SELECT 'memory',p.value,'memory',m.id FROM memories m,json_each(m.json,'$.relatedMemoryIds') p
 UNION ALL SELECT CASE WHEN c.id IS NULL THEN 'capture' ELSE 'file_chunk' END,d.evidence_id,'memory_batch',d.batch_id FROM memory_batch_dependencies d LEFT JOIN file_chunks c ON c.id=d.evidence_id;
 `);}
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
 db.prepare(retired+`UPDATE memories SET json=json_set(json,'$.status','stale','$.staleReason','evidence_changed','$.updatedAt',?) WHERE id IN (SELECT id FROM descendants WHERE kind='memory') AND json_extract(json,'$.status')!='stale'`).run(captureId,new Date().toISOString());
 db.prepare(retired+`DELETE FROM memory_checkpoints WHERE evidence_id IN (SELECT id FROM descendants WHERE kind='file_chunk') OR evidence_id IN (SELECT evidence_id FROM memory_batch_dependencies WHERE batch_id IN (SELECT id FROM descendants WHERE kind='memory_batch'))`).run(captureId);
 db.prepare(retired+`UPDATE memory_batches SET json=json_set(json,'$.status','invalidated','$.errorCode','evidence_changed') WHERE id IN (SELECT id FROM descendants WHERE kind='memory_batch') AND json_extract(json,'$.status')!='invalidated'`).run(captureId);
}
