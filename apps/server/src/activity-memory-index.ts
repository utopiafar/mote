import type {Store} from './store.js';

const ranks:Record<string,number>={running:6,pausing:6,waiting_for_model:5,waiting_for_input:5,paused:5,stale:4,invalidated:4,failed:3,queued:2,pending:2,waiting:2,completed:0,cancelled:-1};
const rank=(value:string)=>`CASE ${value} ${Object.entries(ranks).map(([name,value])=>`WHEN '${name}' THEN ${value}`).join(' ')} ELSE 2 END`;
const jobValues=(ref:string)=>`${ref}.id,coalesce(json_extract(${ref}.json,'$.createdAt'),${ref}.created_at),coalesce(json_extract(${ref}.json,'$.updatedAt'),${ref}.created_at),coalesce(json_extract(${ref}.json,'$.status'),'queued'),json_extract(${ref}.json,'$.importJobId')`;
const grantArray=(ref:string)=>`CASE WHEN json_type(${ref}.json,'$.automaticGrants')='array' THEN json_extract(${ref}.json,'$.automaticGrants') WHEN json_type(${ref}.json,'$.automaticGrant')='object' THEN json_array(json_extract(${ref}.json,'$.automaticGrant')) ELSE json('[]') END`;
const batchValues=(ref:string)=>`${ref}.id,${ref}.job_id,CASE WHEN coalesce(json_array_length(${ref}.json,'$.supersededBy'),0)>0 THEN 0 ELSE 1 END,
 max(${rank(`json_extract(${ref}.json,'$.status')`)},CASE WHEN json_extract(${ref}.json,'$.status')='invalidated' THEN 4 WHEN EXISTS(SELECT 1 FROM json_each(${ref}.json,'$.coverage') c WHERE json_extract(c.value,'$.state') IN ('needs_context','needs_owner_input')) THEN 5 WHEN EXISTS(SELECT 1 FROM json_each(${ref}.json,'$.coverage') c WHERE json_extract(c.value,'$.state')='stale') THEN 4 WHEN EXISTS(SELECT 1 FROM json_each(${ref}.json,'$.coverage') c WHERE json_extract(c.value,'$.state')='failed') THEN 3 ELSE -1 END)`;
const itemsSql=(ref:string,from='')=>`SELECT ${ref}.id,CAST(e.value AS TEXT),coalesce(
 (SELECT json_array(json_extract(w.value,'$.sourceId'),json_extract(w.value,'$.inputKey')) FROM json_each(${ref}.json,'$.workPackage.inputs') w WHERE json_extract(w.value,'$.materialId') IN (SELECT json_extract(p.value,'$.materialId') FROM json_each(${ref}.json,'$.materialInputs') p WHERE e.value IN (SELECT value FROM json_each(p.value,'$.evidenceIds'))) OR json_extract(w.value,'$.ref')=json_extract(${ref}.json,'$.materialRefs."'||e.value||'"') LIMIT 1),
 CASE WHEN json_array_length(${grantArray(ref)})=1 THEN (SELECT json_array(json_extract(g.value,'$.sourceId'),json_extract(g.value,'$.inputKey')) FROM json_each(${grantArray(ref)}) g LIMIT 1) END,
 (SELECT json_extract(p.value,'$.materialId')||':'||json_extract(p.value,'$.fingerprint') FROM json_each(${ref}.json,'$.materialInputs') p WHERE e.value IN (SELECT value FROM json_each(p.value,'$.evidenceIds')) LIMIT 1),CAST(e.value AS TEXT)) FROM ${from}json_each(${ref}.json,'$.evidenceIds') e`;
const coverageSql=(ref:string,from='')=>`SELECT ${ref}.id,${ref}.job_id,CAST(c.key AS INTEGER),json_extract(c.value,'$.id'),CASE WHEN json_extract(${ref}.json,'$.status')='invalidated' THEN 'stale' WHEN coalesce(json_array_length(${ref}.json,'$.coverage'),0)>0 THEN CASE json_extract(c.value,'$.state') WHEN 'checked' THEN 'completed' WHEN 'no_candidates' THEN 'completed' WHEN 'needs_context' THEN 'needs_input' WHEN 'needs_owner_input' THEN 'needs_input' WHEN 'pending' THEN 'waiting' ELSE coalesce(json_extract(c.value,'$.state'),'waiting') END ELSE CASE json_extract(${ref}.json,'$.status') WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' WHEN 'running' THEN 'running' WHEN 'cancelled' THEN 'cancelled' ELSE 'waiting' END END
 FROM ${from}json_each(CASE WHEN coalesce(json_array_length(${ref}.json,'$.coverage'),0)>0 THEN json_extract(${ref}.json,'$.coverage') ELSE coalesce(json_extract(${ref}.json,'$.evidenceRanges'),json('[]')) END) c WHERE coalesce(json_array_length(${ref}.json,'$.supersededBy'),0)=0`;
const publicRank=(value:string)=>`CASE ${value} WHEN 'running' THEN 6 WHEN 'needs_input' THEN 5 WHEN 'stale' THEN 4 WHEN 'failed' THEN 3 WHEN 'waiting' THEN 2 WHEN 'completed' THEN 0 WHEN 'cancelled' THEN -1 WHEN 'excluded' THEN -2 ELSE CASE WHEN ${value} IS NULL THEN NULL ELSE 2 END END`;
const refreshOutputs=(jobId:string)=>`DELETE FROM activity_memory_outputs WHERE job_id=${jobId};
 INSERT OR IGNORE INTO activity_memory_outputs SELECT ${jobId},value FROM memory_jobs j,json_each(j.json,'$.memoryIds') WHERE j.id=${jobId};
 INSERT OR IGNORE INTO activity_memory_outputs SELECT b.job_id,value FROM memory_batches b,json_each(b.json,'$.memoryIds') WHERE b.job_id=${jobId} AND EXISTS(SELECT 1 FROM activity_memory_jobs current WHERE current.id=b.job_id);`;

/** Small relational metadata is maintained when products change. Activity pages
 * never parse complete historic job or batch payloads to find the newest goals. */
export class ActivityMemoryIndex {
 constructor(private store:Store){
  const db=store.db;
  // Refresh coverage triggers when the public state contract changes.
  db.exec('DROP TRIGGER IF EXISTS activity_memory_batch_insert; DROP TRIGGER IF EXISTS activity_memory_batch_update; DROP TRIGGER IF EXISTS activity_memory_batch_delete; DROP TRIGGER IF EXISTS activity_memory_outputs_update; DROP TRIGGER IF EXISTS activity_memory_job_update;');
  db.exec(`CREATE TABLE IF NOT EXISTS activity_memory_jobs(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,status TEXT NOT NULL,import_id TEXT);
   CREATE TABLE IF NOT EXISTS activity_memory_continuations(job_id TEXT PRIMARY KEY REFERENCES activity_memory_jobs(id) ON DELETE CASCADE,parent_id TEXT NOT NULL,root_id TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS activity_memory_continuation_roots ON activity_memory_continuations(root_id,job_id);
   CREATE INDEX IF NOT EXISTS activity_memory_jobs_recent ON activity_memory_jobs(updated_at DESC,id);
   CREATE INDEX IF NOT EXISTS activity_memory_jobs_import ON activity_memory_jobs(import_id,id);
   CREATE TABLE IF NOT EXISTS activity_memory_sources(job_id TEXT NOT NULL REFERENCES activity_memory_jobs(id) ON DELETE CASCADE,source_id TEXT NOT NULL,PRIMARY KEY(job_id,source_id));
   CREATE INDEX IF NOT EXISTS activity_memory_source_jobs ON activity_memory_sources(source_id,job_id);
   CREATE TABLE IF NOT EXISTS activity_memory_source_nodes(source_id TEXT PRIMARY KEY,refs INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS activity_memory_source_links(first_source TEXT NOT NULL,second_source TEXT NOT NULL,refs INTEGER NOT NULL,PRIMARY KEY(first_source,second_source));
   CREATE TABLE IF NOT EXISTS activity_memory_batches(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES activity_memory_jobs(id) ON DELETE CASCADE,leaf INTEGER NOT NULL,rank INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS activity_memory_batch_jobs ON activity_memory_batches(job_id,leaf,rank);
   CREATE TABLE IF NOT EXISTS activity_memory_items(job_id TEXT NOT NULL REFERENCES activity_memory_jobs(id) ON DELETE CASCADE,ref TEXT NOT NULL,item_key TEXT NOT NULL,PRIMARY KEY(job_id,ref));
   CREATE INDEX IF NOT EXISTS activity_memory_item_keys ON activity_memory_items(item_key,job_id);
   CREATE TABLE IF NOT EXISTS activity_memory_coverage(batch_id TEXT NOT NULL REFERENCES activity_memory_batches(id) ON DELETE CASCADE,job_id TEXT NOT NULL,idx INTEGER NOT NULL,ref TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(batch_id,idx));
   CREATE INDEX IF NOT EXISTS activity_memory_coverage_refs ON activity_memory_coverage(job_id,ref,state);
   CREATE TABLE IF NOT EXISTS activity_memory_outputs(job_id TEXT NOT NULL REFERENCES activity_memory_jobs(id) ON DELETE CASCADE,memory_id TEXT NOT NULL,PRIMARY KEY(job_id,memory_id));
   CREATE TRIGGER IF NOT EXISTS activity_memory_source_insert AFTER INSERT ON activity_memory_sources BEGIN
    INSERT INTO activity_memory_source_nodes VALUES(new.source_id,1) ON CONFLICT(source_id) DO UPDATE SET refs=refs+1;
    INSERT INTO activity_memory_source_links SELECT min(new.source_id,source_id),max(new.source_id,source_id),1 FROM activity_memory_sources WHERE job_id=new.job_id AND source_id!=new.source_id
      ON CONFLICT(first_source,second_source) DO UPDATE SET refs=refs+1;
   END;
   CREATE TRIGGER IF NOT EXISTS activity_memory_source_delete AFTER DELETE ON activity_memory_sources BEGIN
    UPDATE activity_memory_source_nodes SET refs=refs-1 WHERE source_id=old.source_id;
    DELETE FROM activity_memory_source_nodes WHERE refs<=0;
    UPDATE activity_memory_source_links SET refs=refs-1 WHERE (first_source=old.source_id AND second_source IN (SELECT source_id FROM activity_memory_sources WHERE job_id=old.job_id)) OR (second_source=old.source_id AND first_source IN (SELECT source_id FROM activity_memory_sources WHERE job_id=old.job_id));
    DELETE FROM activity_memory_source_links WHERE refs<=0;
   END;
   CREATE TRIGGER IF NOT EXISTS activity_memory_job_insert AFTER INSERT ON memory_jobs BEGIN
    INSERT INTO activity_memory_jobs VALUES(${jobValues('new')});
    INSERT OR IGNORE INTO activity_memory_sources SELECT new.id,json_extract(value,'$.sourceId') FROM json_each(${grantArray('new')}) WHERE json_extract(value,'$.sourceId') IS NOT NULL;
    INSERT OR IGNORE INTO activity_memory_items ${itemsSql('new')};
    INSERT OR IGNORE INTO activity_memory_outputs SELECT new.id,value FROM json_each(new.json,'$.memoryIds');
   END;
   CREATE TRIGGER IF NOT EXISTS activity_memory_job_update AFTER UPDATE OF json ON memory_jobs BEGIN
    UPDATE activity_memory_jobs SET updated_at=coalesce(json_extract(new.json,'$.updatedAt'),new.created_at),status=coalesce(json_extract(new.json,'$.status'),'queued'),import_id=coalesce(json_extract(new.json,'$.importJobId'),(SELECT import_id FROM activity_memory_jobs WHERE id=json_extract(new.json,'$.continuationOf'))) WHERE id=new.id;
   END;
   CREATE TRIGGER IF NOT EXISTS activity_memory_items_update AFTER UPDATE OF json ON memory_jobs WHEN coalesce(json_extract(new.json,'$.evidenceIds'),'')!=coalesce(json_extract(old.json,'$.evidenceIds'),'') OR coalesce(json_extract(new.json,'$.materialInputs'),'')!=coalesce(json_extract(old.json,'$.materialInputs'),'') OR coalesce(json_extract(new.json,'$.workPackage.inputs'),'')!=coalesce(json_extract(old.json,'$.workPackage.inputs'),'') OR coalesce(json_extract(new.json,'$.automaticGrants'),'')!=coalesce(json_extract(old.json,'$.automaticGrants'),'') OR coalesce(json_extract(new.json,'$.automaticGrant'),'')!=coalesce(json_extract(old.json,'$.automaticGrant'),'') BEGIN
    DELETE FROM activity_memory_items WHERE job_id=new.id;INSERT OR IGNORE INTO activity_memory_items ${itemsSql('new')};
   END;
   CREATE TRIGGER IF NOT EXISTS activity_memory_outputs_update AFTER UPDATE OF json ON memory_jobs WHEN coalesce(json_extract(new.json,'$.memoryIds'),'')!=coalesce(json_extract(old.json,'$.memoryIds'),'') BEGIN
    ${refreshOutputs('new.id')}
   END;
   CREATE TRIGGER IF NOT EXISTS activity_memory_job_sources_update AFTER UPDATE OF json ON memory_jobs WHEN coalesce(json_extract(new.json,'$.automaticGrants'),'')!=coalesce(json_extract(old.json,'$.automaticGrants'),'') OR coalesce(json_extract(new.json,'$.automaticGrant'),'')!=coalesce(json_extract(old.json,'$.automaticGrant'),'') BEGIN
    DELETE FROM activity_memory_sources WHERE job_id=new.id;
    INSERT OR IGNORE INTO activity_memory_sources SELECT new.id,json_extract(value,'$.sourceId') FROM json_each(${grantArray('new')}) WHERE json_extract(value,'$.sourceId') IS NOT NULL;
   END;
   CREATE TRIGGER IF NOT EXISTS activity_memory_job_delete AFTER DELETE ON memory_jobs BEGIN DELETE FROM activity_memory_jobs WHERE id=old.id; END;
   CREATE TRIGGER IF NOT EXISTS activity_memory_continuation_update AFTER UPDATE OF json ON memory_jobs WHEN json_extract(new.json,'$.continuationOf') IS NOT NULL BEGIN
    INSERT OR REPLACE INTO activity_memory_continuations SELECT new.id,json_extract(new.json,'$.continuationOf'),coalesce((SELECT root_id FROM activity_memory_continuations WHERE job_id=json_extract(new.json,'$.continuationOf')),json_extract(new.json,'$.continuationOf'));
    UPDATE activity_memory_jobs SET import_id=coalesce(import_id,(SELECT import_id FROM activity_memory_jobs WHERE id=json_extract(new.json,'$.continuationOf'))) WHERE id=new.id;
    INSERT OR IGNORE INTO activity_memory_sources SELECT new.id,source_id FROM activity_memory_sources WHERE job_id=json_extract(new.json,'$.continuationOf');
    UPDATE activity_memory_items AS i SET item_key=coalesce((SELECT prior.item_key FROM activity_memory_items prior JOIN memory_jobs p ON p.id=prior.job_id,json_each(p.json,'$.materialInputs') pin WHERE prior.job_id=json_extract(new.json,'$.continuationOf') AND prior.ref IN (SELECT value FROM json_each(pin.value,'$.evidenceIds')) AND json_extract(pin.value,'$.materialId') IN (SELECT json_extract(child.value,'$.materialId') FROM json_each(new.json,'$.materialInputs') child WHERE i.ref IN (SELECT value FROM json_each(child.value,'$.evidenceIds'))) LIMIT 1),item_key) WHERE job_id=new.id;
   END;
   CREATE TRIGGER IF NOT EXISTS activity_memory_batch_insert AFTER INSERT ON memory_batches BEGIN INSERT INTO activity_memory_batches VALUES(${batchValues('new')});INSERT INTO activity_memory_coverage ${coverageSql('new')};${refreshOutputs('new.job_id')} END;
   CREATE TRIGGER IF NOT EXISTS activity_memory_batch_update AFTER UPDATE OF json ON memory_batches BEGIN INSERT OR REPLACE INTO activity_memory_batches VALUES(${batchValues('new')});INSERT INTO activity_memory_coverage ${coverageSql('new')};${refreshOutputs('new.job_id')} END;
   CREATE TRIGGER IF NOT EXISTS activity_memory_batch_delete AFTER DELETE ON memory_batches BEGIN DELETE FROM activity_memory_batches WHERE id=old.id;${refreshOutputs('old.job_id')} END;`);
  // Repair persisted projections made by the previous coverage contract.
  db.exec(`UPDATE activity_memory_coverage SET state='needs_input' WHERE state='needs_owner_input';
   UPDATE activity_memory_batches SET rank=5 WHERE rank<5 AND leaf=1 AND id IN (SELECT batch_id FROM activity_memory_coverage WHERE state='needs_input') AND EXISTS(SELECT 1 FROM memory_batches b,json_each(b.json,'$.coverage') c WHERE b.id=activity_memory_batches.id AND json_extract(b.json,'$.status')!='invalidated' AND json_extract(c.value,'$.state')='needs_owner_input');`);
  for(const row of db.prepare("SELECT id,json FROM memory_jobs WHERE json_extract(json,'$.continuationOf') IS NOT NULL ORDER BY created_at,id").all())db.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(row.json,row.id);
  db.exec("INSERT OR IGNORE INTO activity_memory_outputs SELECT b.job_id,value FROM memory_batches b,json_each(b.json,'$.memoryIds') WHERE EXISTS(SELECT 1 FROM activity_memory_jobs j WHERE j.id=b.job_id)");
 }
 groups(){
  const parent=new Map<string,string>(),root=(source:string):string=>{const next=parent.get(source);if(!next){parent.set(source,source);return source;}return next===source?source:root(next);};
  for(const row of this.store.db.prepare('SELECT source_id FROM activity_memory_source_nodes').all())root(String(row.source_id));
  for(const row of this.store.db.prepare('SELECT first_source,second_source FROM activity_memory_source_links').all())parent.set(root(String(row.first_source)),root(String(row.second_source)));
  const sets=new Map<string,string[]>();for(const source of parent.keys()){const key=root(source),sources=sets.get(key)??[];sources.push(source);sets.set(key,sources);}
  const mapping:{sourceId:string;groupId:string}[]=[],sources=new Map<string,string[]>();
  for(const members of sets.values()){members.sort();const id=members.length===1?'memory-source:'+members[0]:'memory-sources:'+Buffer.from(JSON.stringify(members)).toString('base64url');sources.set(id,members);for(const sourceId of members)mapping.push({sourceId,groupId:id});}
  return {mapping,sources};
 }
 metadataSql(){
  const {mapping,sources}=this.groups(),mapped=JSON.stringify(mapping);
  const requests=Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='material_memory_requests'").get()),authorizations=Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_input_authorizations'").get());
  const pending=authorizations?`SELECT DISTINCT m.group_id FROM memory_input_authorizations a JOIN mapping m ON m.source_id=a.source_id WHERE a.authorized=1 AND a.revoked_at IS NULL AND a.job_id IS NULL ${requests?`AND NOT EXISTS(SELECT 1 FROM material_memory_requests r JOIN material_heads h ON h.id=r.material_id WHERE h.source_id=a.source_id AND r.input_key=a.input_key AND r.scope=a.scope AND r.job_id IS NOT NULL)`:''}`:"SELECT NULL group_id WHERE 0";
  const sql=`WITH mapping AS (SELECT json_extract(value,'$.sourceId') source_id,json_extract(value,'$.groupId') group_id FROM json_each(?)), job_groups AS (
    SELECT j.id,CASE WHEN j.import_id IS NOT NULL THEN 'memory-import:'||j.import_id WHEN min(m.group_id) IS NOT NULL THEN min(m.group_id) ELSE 'memory:'||coalesce((SELECT root_id FROM activity_memory_continuations WHERE job_id=j.id),j.id) END group_id,j.created_at,j.updated_at,${rank('j.status')} rank
    FROM activity_memory_jobs j LEFT JOIN activity_memory_sources s ON s.job_id=j.id LEFT JOIN mapping m ON m.source_id=s.source_id GROUP BY j.id), pending AS (${pending}), summaries AS (
   SELECT j.group_id id,min(j.created_at) created_at,max(j.updated_at) updated_at,max(max(j.rank,coalesce(b.rank,-2),CASE WHEN EXISTS(SELECT 1 FROM activity_memory_items i WHERE i.job_id=j.id AND NOT EXISTS(SELECT 1 FROM activity_memory_coverage c WHERE c.job_id=i.job_id AND c.ref=i.ref)) THEN 2 ELSE -2 END)) rank
   FROM job_groups j LEFT JOIN activity_memory_batches b ON b.job_id=j.id AND b.leaf=1 GROUP BY j.group_id)
   SELECT id,created_at,updated_at,max(rank,CASE WHEN id IN (SELECT group_id FROM pending) THEN 2 ELSE -2 END) rank FROM summaries`;
  return {sql,parameters:[mapped],sources};
 }
 summary(id:string){const query=this.metadataSql(),row=this.store.db.prepare(`SELECT * FROM (${query.sql}) WHERE id=?`).get(...query.parameters,id);return row?{id:String(row.id),sources:query.sources.get(String(row.id))??[],createdAt:String(row.created_at),updatedAt:String(row.updated_at),rank:Number(row.rank)}:undefined;
 }
 cardStats(id:string,sources:string[],captureIds:string[]=[]){
  const db=this.store.db,has=(table:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table));
  const predicate=id.startsWith('memory-import:')?'j.import_id=?':sources.length?'j.import_id IS NULL AND EXISTS(SELECT 1 FROM activity_memory_sources s WHERE s.job_id=j.id AND s.source_id IN (SELECT value FROM json_each(?)))':'coalesce((SELECT root_id FROM activity_memory_continuations WHERE job_id=j.id),j.id)=?';
  const parameter=id.startsWith('memory-import:')?id.slice('memory-import:'.length):sources.length?JSON.stringify(sources):id.slice('memory:'.length);
  const requests=has('material_memory_requests')&&has('material_heads'),authorizations=has('memory_input_authorizations');
  const assigned=requests?`OR EXISTS(SELECT 1 FROM material_memory_requests r JOIN material_heads h ON h.id=r.material_id WHERE h.source_id=a.source_id AND r.input_key=a.input_key AND r.scope=a.scope AND r.job_id IS NOT NULL)`:'';
  const sourceManifest=authorizations&&sources.length?`SELECT json_array(a.source_id,a.input_key) item_key,CASE WHEN a.job_id IS NULL AND NOT (0 ${assigned}) THEN 'waiting' ELSE NULL END state FROM memory_input_authorizations a WHERE a.source_id IN (SELECT value FROM json_each(?)) AND a.authorized=1 AND a.revoked_at IS NULL`:"SELECT NULL item_key,NULL state WHERE 0";
  const requestManifest=requests&&sources.length?`SELECT json_array(h.source_id,r.input_key) item_key,NULL state FROM material_memory_requests r JOIN material_heads h ON h.id=r.material_id WHERE h.source_id IN (SELECT value FROM json_each(?)) AND r.auto_authorized=1`:"SELECT NULL item_key,NULL state WHERE 0";
  const imported=authorizations&&captureIds.length?`SELECT json_array(a.source_id,a.input_key) item_key,'waiting' state FROM memory_input_authorizations a WHERE a.authorized=1 AND a.revoked_at IS NULL AND a.job_id IS NULL AND a.capture_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS(SELECT 1 FROM selected s JOIN activity_memory_items i ON i.job_id=s.id WHERE i.ref=a.capture_id ${has('material_evidence_dependencies')?"OR EXISTS(SELECT 1 FROM material_evidence_dependencies d WHERE d.anchor_id=i.ref AND d.evidence_id=a.capture_id)":''})`:"SELECT NULL item_key,NULL state WHERE 0";
  const plans=!sources.length&&has('memory_input_plans')?`SELECT p.material_id||':pending' item_key,'waiting' state FROM memory_input_plans p JOIN selected s ON s.id=p.job_id WHERE coalesce(json_array_length(p.json,'$.resolvedInput.evidenceIds'),0)=0`:"SELECT NULL item_key,NULL state WHERE 0";
  const sql=`WITH selected AS (SELECT j.* FROM activity_memory_jobs j WHERE ${predicate}), records AS (
   SELECT i.item_key,coalesce(c.state,CASE WHEN NOT EXISTS(SELECT 1 FROM activity_memory_batches b WHERE b.job_id=j.id AND b.leaf=1) AND j.status!='completed' THEN CASE j.status WHEN 'queued' THEN 'waiting' WHEN 'waiting_for_model' THEN 'needs_input' WHEN 'waiting_for_input' THEN 'needs_input' WHEN 'paused' THEN 'needs_input' WHEN 'pausing' THEN 'running' ELSE j.status END ELSE 'waiting' END) state FROM selected j JOIN activity_memory_items i ON i.job_id=j.id LEFT JOIN activity_memory_coverage c ON c.job_id=i.job_id AND c.ref=i.ref
   UNION ALL ${sourceManifest} UNION ALL ${requestManifest} UNION ALL ${imported} UNION ALL ${plans}), items AS (
    SELECT item_key,CASE WHEN max(${publicRank('state')})>0 THEN max(${publicRank('state')}) WHEN count(state)=0 THEN 2 WHEN min(${publicRank('state')})=-1 AND max(${publicRank('state')})=-1 THEN -1 WHEN min(${publicRank('state')})=-2 AND max(${publicRank('state')})=-2 THEN -2 ELSE 0 END rank FROM records GROUP BY item_key), states AS (
    SELECT rank FROM items UNION ALL SELECT ${rank('status')} FROM selected WHERE status!='completed')
   SELECT (SELECT min(created_at) FROM selected) created_at,(SELECT max(updated_at) FROM selected) updated_at,
    (SELECT count(*) FROM items) total,(SELECT count(*) FROM items WHERE rank=0) completed,(SELECT count(*) FROM items WHERE rank IN (3,4)) failed,(SELECT count(*) FROM items WHERE rank=5) needs_input,(SELECT count(*) FROM items WHERE rank=-2) excluded,
    (SELECT CASE WHEN max(rank)>0 THEN max(rank) WHEN min(rank)=-1 AND max(rank)=-1 THEN -1 WHEN min(rank)=-2 AND max(rank)=-2 THEN -2 ELSE 0 END FROM states) rank,
    (SELECT count(DISTINCT i.ref) FROM selected s JOIN activity_memory_items i ON i.job_id=s.id) evidence,
    (SELECT count(DISTINCT o.memory_id) FROM selected s JOIN activity_memory_outputs o ON o.job_id=s.id JOIN memories m ON m.id=o.memory_id) memories,
    (SELECT count(*) FROM selected s JOIN activity_memory_batches b ON b.job_id=s.id WHERE b.leaf=1) branches,
    (SELECT count(*) FROM selected s JOIN activity_memory_batches b ON b.job_id=s.id WHERE b.leaf=1 AND b.rank=6) running_branches,
    (SELECT count(*) FROM selected s JOIN activity_memory_batches b ON b.job_id=s.id WHERE b.leaf=1 AND b.rank=0) completed_branches,
    (SELECT json_group_array('memory:'||id) FROM (SELECT id FROM selected ORDER BY created_at,id LIMIT 100)) operations`;
  const row=db.prepare(sql).get(parameter,...(authorizations&&sources.length?[JSON.stringify(sources)]:[]),...(requests&&sources.length?[JSON.stringify(sources)]:[]),...(authorizations&&captureIds.length?[JSON.stringify(captureIds)]:[]))!;
  return {createdAt:String(row.created_at),updatedAt:String(row.updated_at),rank:Number(row.rank??2),total:Number(row.total),completed:Number(row.completed),failed:Number(row.failed),needsInput:Number(row.needs_input),excluded:Number(row.excluded),evidence:Number(row.evidence),memories:Number(row.memories),branches:Number(row.branches),runningBranches:Number(row.running_branches),completedBranches:Number(row.completed_branches),operations:JSON.parse(String(row.operations)) as string[]};
 }
 jobIds(id:string,sources:string[]):string[]{
  if(id.startsWith('memory-import:'))return this.store.db.prepare('SELECT id FROM activity_memory_jobs WHERE import_id=? ORDER BY created_at,id').all(id.slice('memory-import:'.length)).map(row=>String(row.id));
  if(sources.length)return this.store.db.prepare('SELECT DISTINCT j.id,j.created_at FROM activity_memory_jobs j JOIN activity_memory_sources s ON s.job_id=j.id WHERE j.import_id IS NULL AND s.source_id IN (SELECT value FROM json_each(?)) ORDER BY j.created_at,j.id').all(JSON.stringify(sources)).map(row=>String(row.id));
  return this.store.db.prepare('SELECT j.id FROM activity_memory_jobs j WHERE coalesce((SELECT root_id FROM activity_memory_continuations WHERE job_id=j.id),j.id)=? ORDER BY j.created_at,j.id').all(id.slice('memory:'.length)).map(row=>String(row.id));
 }
}
