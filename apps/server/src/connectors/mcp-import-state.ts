import type {Store} from '../store.js';

/** Membership snapshots share SourceStore's transaction for nonempty batches;
 * an empty result still publishes its snapshot in the same SQLite connection. */
export function mcpImportState(store:Pick<Store,'db'>){
 const {db}=store;
 db.exec('CREATE TABLE IF NOT EXISTS mcp_import_manifests(source_id TEXT NOT NULL REFERENCES source_connections(id) ON DELETE CASCADE,identity TEXT NOT NULL,members TEXT NOT NULL,PRIMARY KEY(source_id,identity))');
 return {
  members:(sourceId:string,identity:string)=>{const row=db.prepare('SELECT members FROM mcp_import_manifests WHERE source_id=? AND identity=?').get(sourceId,identity);return row?String(row.members):undefined;},
  save:(sourceId:string,identity:string,members:string)=>{
   db.prepare('INSERT INTO mcp_import_manifests VALUES(?,?,?) ON CONFLICT(source_id,identity) DO UPDATE SET members=excluded.members').run(sourceId,identity,members);
  },
  transaction:(publish:()=>void)=>{db.exec('BEGIN IMMEDIATE');try{publish();db.exec('COMMIT');}catch(error){if(db.isTransaction){db.exec('ROLLBACK');}throw error;}},
 };
}
export type McpImportState=ReturnType<typeof mcpImportState>;
