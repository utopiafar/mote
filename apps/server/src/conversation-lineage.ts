import type {EvidenceDependencies} from '@mote/shared';
import type {Store} from './store.js';

export function combineDependencies(values:(EvidenceDependencies|undefined)[]):EvidenceDependencies|undefined {
  if(values.some(value=>!value))return;
  return {version:1,complete:values.every(value=>value!.complete),ids:[...new Set(values.flatMap(value=>value!.ids))]};
}

/** Resolve derived disclosures while their lineage still exists, before deletion can cascade. */
export function resolveDependencies(store:Store,value:EvidenceDependencies|undefined):EvidenceDependencies|undefined {
  if(!value)return;
  const ids=new Set(value.ids);
  // The graph is installed by file processing in a full node. The fallback
  // covers lightweight Store/Conversations consumers without that service.
  const graph=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='evidence_dependency_edges'").get();
  const query=graph?store.db.prepare(`WITH RECURSIVE ancestors(id) AS (
    SELECT value FROM json_each(?) UNION SELECT e.parent_id FROM evidence_dependency_edges e JOIN ancestors a ON e.child_id=a.id
  ) SELECT id FROM ancestors`):undefined;
  const materialInputs=store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='artifact_material_inputs'").get();
  let previous=-1;
  while(previous!==ids.size){
    previous=ids.size;
    if(query)for(const row of query.all(JSON.stringify([...ids])))ids.add(String(row.id));
    for(const id of ids){
      for(const row of store.db.prepare('SELECT evidence_id FROM memory_dependencies WHERE memory_id=?').all(id))ids.add(String(row.evidence_id));
      for(const row of store.db.prepare('SELECT parent_id FROM file_evidence_links WHERE capture_id=?').all(id))ids.add(String(row.parent_id));
      for(const row of store.db.prepare('SELECT capture_id FROM file_chunks WHERE id=?').all(id))ids.add(String(row.capture_id));
      if(materialInputs)for(const row of store.db.prepare('SELECT e.id FROM artifact_material_inputs i JOIN material_evidence e ON e.material_id=i.material_id AND e.revision=i.revision WHERE i.artifact_id=?').all(id))ids.add(String(row.id));
    }
  }
  return {...value,ids:[...ids]};
}
