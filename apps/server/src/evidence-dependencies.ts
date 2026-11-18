import {installSchemaPlan} from './schema-installation.js';
import {evidenceDependenciesWithoutMaterialsInstallation,evidenceDependenciesWithMaterialsInstallation} from './asset-evidence-schema.js';
import type {EvidenceStore as Store} from './evidence-store.js';
export type EvidenceNode={kind:'capture'|'context_artifact'|'file_artifact'|'file_chunk'|'material_evidence'|'memory'|'memory_batch';id:string};
function materialEvidenceInstalled(store:Store){
 return Boolean(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_evidence_dependencies'").get());
}
/** A projection over existing lineage, never another authoritative job or artifact store. */
export function installEvidenceDependencies(store:Store){
 installSchemaPlan(store.db,[materialEvidenceInstalled(store)?evidenceDependenciesWithMaterialsInstallation:evidenceDependenciesWithoutMaterialsInstallation]);}
export function evidenceDependents(store:Store,node:EvidenceNode){return store.db.prepare(`WITH RECURSIVE descendants(kind,id) AS (
 SELECT ?,? UNION SELECT e.child_kind,e.child_id FROM evidence_dependency_edges e JOIN descendants d ON e.parent_kind=d.kind AND e.parent_id=d.id
 ) SELECT kind,id FROM descendants WHERE NOT(kind=? AND id=?) ORDER BY kind,id`).all(node.kind,node.id,node.kind,node.id) as EvidenceNode[];}

/** Retiring a derived container must only invalidate the evidence actually replaced. */
export function invalidateRetiredFileEvidence(store:Store,captureId:string){
 const db=store.db,materials=materialEvidenceInstalled(store);
 // File chunks can only lead to Material anchors, Memory, or batch dependencies.
 // SQLite builds an index over the entire union view when it is used in this
 // recursive join. Seek the existing parent indexes from the affected frontier.
 const evidenceParent=materials
  ? "(d.kind='material_evidence' OR (d.kind='file_chunk' AND NOT EXISTS(SELECT 1 FROM material_evidence WHERE id=d.id)))"
  : "d.kind='file_chunk'";
 const ids:Record<'file_chunk'|'material_evidence'|'memory'|'memory_batch',string[]>={file_chunk:[],material_evidence:[],memory:[],memory_batch:[]};
 const retired=db.prepare(`WITH RECURSIVE related_memory(parent_id,id) AS MATERIALIZED (
  SELECT p.value,m.id FROM memories m,json_each(m.json,'$.relatedMemoryIds') p
 ), descendants(kind,id) AS (
  SELECT 'file_chunk',c.id FROM file_chunks c JOIN file_artifacts a ON a.id=c.artifact_id WHERE c.capture_id=? AND (
   a.current=0 OR EXISTS(SELECT 1 FROM file_artifacts p WHERE p.capture_id=a.capture_id AND p.current=1 AND ((p.kind='corrected-dialogue' AND a.kind!='corrected-dialogue') OR (p.kind='dialogue' AND a.kind IN ('transcript','text','image-text'))))
  )
  ${materials?`UNION SELECT 'material_evidence',e.anchor_id FROM descendants d JOIN material_evidence_dependencies e ON e.evidence_id=d.id WHERE ${evidenceParent}`:''}
  UNION SELECT 'memory',e.memory_id FROM descendants d JOIN memory_dependencies e ON e.evidence_id=d.id WHERE ${evidenceParent}
  UNION SELECT 'memory_batch',e.batch_id FROM descendants d JOIN memory_batch_dependencies e ON e.evidence_id=d.id WHERE ${evidenceParent}
  UNION SELECT 'memory',r.id FROM descendants d CROSS JOIN related_memory r ON r.parent_id=d.id WHERE d.kind='memory'
 ) SELECT kind,id FROM descendants`).all(captureId) as {kind:keyof typeof ids;id:string}[];
 if(!retired.length)return;
 for(const {kind,id} of retired)ids[kind].push(id);
 for(const anchor of ids.material_evidence)store.invalidateMemoryEvidence(anchor);
 const batches=JSON.stringify(ids.memory_batch);
 db.prepare(`UPDATE memories SET json=json_set(json,'$.status','stale','$.staleReason','evidence_changed','$.updatedAt',?)
  WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(json,'$.status')!='stale'`).run(new Date().toISOString(),JSON.stringify(ids.memory));
 db.prepare(`DELETE FROM memory_checkpoints WHERE evidence_id IN (SELECT value FROM json_each(?))
  OR evidence_id IN (SELECT evidence_id FROM memory_batch_dependencies WHERE batch_id IN (SELECT value FROM json_each(?)))`).run(JSON.stringify(ids.file_chunk),batches);
 db.prepare(`UPDATE memory_batches SET json=json_set(json,'$.status','invalidated','$.errorCode','evidence_changed')
  WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(json,'$.status')!='invalidated'`).run(batches);
}
