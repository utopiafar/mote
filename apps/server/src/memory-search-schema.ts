import type {DatabaseSync} from 'node:sqlite';
import type {SchemaInstallation} from './schema-installation.js';

/** Search projections of canonical Memory records. Original evidence, Memory
 * records/dependencies and provider revocations keep their existing owners. */
export const memorySearchSchemaInstallation={
 owner:'memory-search',requires:[],
 prerequisites:[
  {owner:'capture',objects:[{type:'table',name:'captures'}]},
  {owner:'memory',objects:[{type:'table',name:'memories'},{type:'table',name:'memory_dependencies'},{type:'table',name:'memory_provider_evidence_revocations'}]},
 ],
 install(db:DatabaseSync){memoryIndex(db);memoryCatalog(db);},
} as const satisfies SchemaInstallation;

function memoryIndex(db:DatabaseSync){
    db.exec(`CREATE INDEX IF NOT EXISTS memories_context_priority ON memories(json_extract(json,'$.contextPriority')) WHERE json_extract(json,'$.contextPriority') IS NOT NULL;
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED,text,tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(id,text) VALUES(new.id,json_extract(new.json,'$.title')||' '||json_extract(new.json,'$.statement')||' '||json_extract(new.json,'$.uncertainty')); END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN DELETE FROM memories_fts WHERE id=old.id; END;
      CREATE TRIGGER IF NOT EXISTS memory_original_release_card_removed AFTER DELETE ON memories BEGIN
        UPDATE memory_provider_evidence_revocations SET json=json_remove(json,'$.releasedOriginal.memoryFingerprints.'||old.id)
        WHERE json_extract(json,'$.releasedOriginal.memoryFingerprints.'||old.id) IS NOT NULL;
      END;
      CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN DELETE FROM memories_fts WHERE id=old.id; INSERT INTO memories_fts(id,text) VALUES(new.id,json_extract(new.json,'$.title')||' '||json_extract(new.json,'$.statement')||' '||json_extract(new.json,'$.uncertainty')); END;
`);
}

function memoryCatalog(db:DatabaseSync){
    const projection=(v:string)=>`json_object('id',${v}.id,'title',json_extract(${v}.json,'$.title'),'admission',json_extract(${v}.json,'$.admission'),'reviewRunId',json_extract(${v}.json,'$.reviewRunId'),'domain',json_extract(${v}.json,'$.domain'),'coding',json_extract(${v}.json,'$.coding'),'scopeRefs',json_extract(${v}.json,'$.scopeRefs'),'tier',json_extract(${v}.json,'$.tier'),'kind',json_extract(${v}.json,'$.kind'),'status',json_extract(${v}.json,'$.status'),'createdAt',${v}.created_at,'revision',json_extract(${v}.json,'$.fingerprint'),'version',json_extract(${v}.json,'$.version'),'relations',json_extract(${v}.json,'$.relations'),'supersededBy',json_extract(${v}.json,'$.supersededBy'),'supersededAt',json_extract(${v}.json,'$.supersededAt'),'validFrom',json_extract(${v}.json,'$.validFrom'),'validUntil',json_extract(${v}.json,'$.validUntil'),'correction',json_extract(${v}.json,'$.correction'),'evidenceCount',json_array_length(${v}.json,'$.evidenceIds'))`;
    const insert=(v:string)=>`INSERT OR REPLACE INTO memory_catalog SELECT ${v}.id,${v}.created_at,json_extract(${v}.json,'$.status'),json_extract(${v}.json,'$.tier'),json_extract(${v}.json,'$.kind'),json_extract(${v}.json,'$.admission.layer'),${projection(v)};`;
    const scope=(v:string)=>`INSERT INTO memory_scopes SELECT ${v}.id,json_extract(e.value,'$.id'),coalesce(json_extract(e.value,'$.deviceId'),''),CASE json_extract(e.value,'$.timeBasis') WHEN 'occurred' THEN coalesce(json_extract(e.value,'$.occurredAt'),json_extract(e.value,'$.recordedAt'),json_extract(e.value,'$.capturedAt')) ELSE coalesce(json_extract(e.value,'$.recordedAt'),json_extract(e.value,'$.capturedAt')) END FROM json_each(${v}.json,'$.evidence') e;`;
    db.exec(`CREATE TABLE IF NOT EXISTS memory_catalog(id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,created_at TEXT NOT NULL,status TEXT NOT NULL,tier TEXT NOT NULL,kind TEXT NOT NULL,layer TEXT NOT NULL,json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_catalog_page ON memory_catalog(status,created_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS memory_scopes(memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,evidence_id TEXT NOT NULL,device_id TEXT NOT NULL,at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_scope_parent ON memory_scopes(memory_id,device_id,at);
      CREATE TRIGGER IF NOT EXISTS memory_catalog_insert AFTER INSERT ON memories BEGIN ${insert('new')} ${scope('new')} END;
      CREATE TRIGGER IF NOT EXISTS memory_catalog_update AFTER UPDATE OF json ON memories BEGIN ${insert('new')} DELETE FROM memory_scopes WHERE memory_id=new.id; ${scope('new')} END;
      CREATE TRIGGER IF NOT EXISTS memory_evidence_edited AFTER UPDATE OF json ON captures WHEN new.json!=old.json BEGIN
        UPDATE memories SET json=json_set(json,'$.status','stale','$.staleReason','evidence_changed') WHERE id IN (SELECT memory_id FROM memory_dependencies WHERE evidence_id=new.id);
      END;
      DROP TRIGGER IF EXISTS memory_evidence_removed;
      CREATE TRIGGER memory_evidence_removed BEFORE DELETE ON captures BEGIN DELETE FROM memories WHERE id IN (SELECT memory_id FROM memory_dependencies WHERE evidence_id=old.id)
        AND NOT EXISTS(SELECT 1 FROM memory_provider_evidence_revocations r,json_each(r.json,'$.releasedOriginal.memoryFingerprints') kept WHERE r.id=old.id AND kept.key=memories.id AND kept.value=json_extract(memories.json,'$.fingerprint')); END;`);

}
