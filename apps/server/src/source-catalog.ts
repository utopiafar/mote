import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {navigationScopeSchema} from './context-navigation.js';
import {availableFileAttachmentSql,readableFileSql} from './file-access.js';
import type {Range} from './store.js';
/** Literal URI structure only. Never opens a remote URI or interprets its contents. */
function parent(json:unknown){const record=JSON.parse(String(json)),uri=record.provenance?.uri;if(!uri)return '';try{const url=new URL(uri);url.search='';url.hash='';url.pathname=url.pathname.slice(0,url.pathname.lastIndexOf('/')+1);return url.href;}catch{return '';}}
export function initializeSourceCatalog(db:DatabaseSync){
 db.function('mote_catalog_parent',{deterministic:true},parent);
 db.exec(`CREATE TABLE IF NOT EXISTS source_catalog(source_id TEXT NOT NULL,external_id TEXT NOT NULL,capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE CASCADE,parent_uri TEXT NOT NULL,title TEXT NOT NULL,coverage TEXT NOT NULL,PRIMARY KEY(source_id,external_id));
 CREATE INDEX IF NOT EXISTS source_catalog_directory ON source_catalog(source_id,parent_uri,title,external_id);
 CREATE TRIGGER IF NOT EXISTS source_catalog_insert AFTER INSERT ON source_heads BEGIN
 INSERT OR REPLACE INTO source_catalog SELECT new.source_id,new.external_id,new.capture_id,mote_catalog_parent(json),COALESCE(json_extract(json,'$.windowTitle'),''),CASE WHEN json_extract(json,'$.ocrText')='' THEN 'catalog' ELSE COALESCE(json_extract(json,'$.provenance.document.fileIndex.coverage'),'full') END FROM captures WHERE id=new.capture_id AND new.deleted=0 AND json_extract(json,'$.source')='file'; END;
 CREATE TRIGGER IF NOT EXISTS source_catalog_update AFTER UPDATE ON source_heads BEGIN
 DELETE FROM source_catalog WHERE source_id=new.source_id AND external_id=new.external_id;
 INSERT INTO source_catalog SELECT new.source_id,new.external_id,new.capture_id,mote_catalog_parent(json),COALESCE(json_extract(json,'$.windowTitle'),''),CASE WHEN json_extract(json,'$.ocrText')='' THEN 'catalog' ELSE COALESCE(json_extract(json,'$.provenance.document.fileIndex.coverage'),'full') END FROM captures WHERE id=new.capture_id AND new.deleted=0 AND json_extract(json,'$.source')='file'; END;`);

}
export function browseSourceCatalog(db:DatabaseSync,sourceId:string,input:Range&{parent?:string;cursor?:string;limit?:number}={},visible:(captureId:string)=>boolean=()=>true){
 const args=z.object({...navigationScopeSchema.shape,parent:z.string().max(2048).optional(),cursor:z.string().max(8192).optional(),limit:z.number().int().min(1).max(100).default(30)}).strict().parse(input);
 const clauses=['sc.source_id=?',"json_extract(s.json,'$.enabled')=1",`(NOT EXISTS(SELECT 1 FROM file_versions v WHERE v.capture_id=sc.capture_id) OR ${readableFileSql('sc.capture_id')})`,availableFileAttachmentSql(db,'sc.capture_id'),'(EXISTS(SELECT 1 FROM file_versions own WHERE own.capture_id=sc.capture_id) OR NOT EXISTS(SELECT 1 FROM file_evidence_links l JOIN file_versions parent ON parent.capture_id=l.parent_id WHERE l.capture_id=sc.capture_id))'],values:(string|number)[]=[sourceId];
 for(const [key,column] of [['sourceId','sc.source_id'],['deviceId','c.device_id'],['after','c.context_at'],['before','c.context_at'],['appId',"json_extract(c.json,'$.appId')"],['source',"json_extract(c.json,'$.source')"],['projectKey',"json_extract(c.json,'$.provenance.document.coding.projectKey')"],['repositoryKey',"json_extract(c.json,'$.provenance.document.coding.repositoryKey')"],['provider',"json_extract(c.json,'$.provenance.document.coding.provider')"],['sessionId',"json_extract(c.json,'$.provenance.document.coding.sessionId')"]] as const)if(args[key]){clauses.push(`${column} ${key==='after'?'>=':key==='before'?'<':'='} ?`);values.push(key==='after'||key==='before'?new Date(args[key]!).toISOString():args[key]!);}
 if(args.collection==='activity')clauses.push("json_extract(c.json,'$.privacy.collection')='activity'");
 if(args.collection==='content')clauses.push("COALESCE(json_extract(c.json,'$.privacy.collection'),'content')='content'");
 // The source head becomes a tombstone when a device reports the original
 // missing. Its retained file head is still a distinct, readable location.
 const catalog=`(SELECT source_id,external_id,capture_id,parent_uri,title,coverage FROM source_catalog
   UNION ALL SELECT h.source_id,h.external_id,h.capture_id,mote_catalog_parent(original.json),
     COALESCE(json_extract(original.json,'$.windowTitle'),''),COALESCE(json_extract(si.json,'$.coverage'),'catalog')
   FROM file_heads h JOIN captures original ON original.id=h.capture_id LEFT JOIN file_snapshot_index si ON si.capture_id=h.capture_id
   WHERE h.origin_missing=1 AND NOT EXISTS(SELECT 1 FROM source_catalog existing WHERE existing.source_id=h.source_id AND existing.external_id=h.external_id))`;
 const from=`FROM ${catalog} sc JOIN captures c ON c.id=sc.capture_id JOIN source_connections s ON s.id=sc.source_id WHERE ${clauses.join(' AND ')}`;
 if(args.parent===undefined){
  const after=args.cursor?z.object({source:z.literal(sourceId),parent:z.string()}).parse(JSON.parse(Buffer.from(args.cursor,'base64url').toString())).parent:'';
  const directories:{parent:string;files:number;indexed:number}[]=[];
  for(const row of db.prepare(`SELECT sc.parent_uri,sc.coverage,sc.capture_id ${from} AND sc.parent_uri>=? ORDER BY sc.parent_uri,sc.title,sc.external_id`).iterate(...values,after)){
   if(!visible(String(row.capture_id)))continue;
   const parent=String(row.parent_uri);let directory=directories.at(-1);
   if(!directory||directory.parent!==parent){directory={parent,files:0,indexed:0};directories.push(directory);if(directories.length>args.limit)break;}
   directory.files++;if(row.coverage!=='catalog')directory.indexed++;
  }
  const items=directories.slice(0,args.limit),last=directories[args.limit];return {directories:items,items:[],nextCursor:last?Buffer.from(JSON.stringify({source:sourceId,parent:last.parent})).toString('base64url'):null,coverage:'Known directory catalog; indexed is not semantic completeness',modelCalls:0};
 }
 const position=args.cursor?z.object({source:z.literal(sourceId),parent:z.literal(args.parent),title:z.string(),id:z.string()}).parse(JSON.parse(Buffer.from(args.cursor,'base64url').toString())):undefined;
 const rows:{id:string;evidenceId:string;title:string;coverage:string}[]=[];
 for(const row of db.prepare(`SELECT sc.external_id AS id,sc.capture_id AS evidenceId,sc.title,sc.coverage ${from} AND sc.parent_uri=? ${position?'AND (sc.title>? OR (sc.title=? AND sc.external_id>?))':''} ORDER BY sc.title,sc.external_id`).iterate(...values,args.parent,...(position?[position.title,position.title,position.id]:[]))){
  if(!visible(String(row.evidenceId)))continue;rows.push({id:String(row.id),evidenceId:String(row.evidenceId),title:String(row.title),coverage:String(row.coverage)});if(rows.length>args.limit)break;
 }
 const items=rows.slice(0,args.limit),last=items.at(-1);return {directories:[],items,nextCursor:rows.length>args.limit&&last?Buffer.from(JSON.stringify({source:sourceId,parent:args.parent,title:last.title,id:last.id})).toString('base64url'):null,coverage:'Catalog / full or partial text index; originals may be offline',modelCalls:0};
}
