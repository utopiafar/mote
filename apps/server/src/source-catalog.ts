import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
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
 if(!db.prepare("SELECT 1 FROM settings WHERE key='source-catalog-v1'").get())db.exec(`BEGIN IMMEDIATE;
 INSERT OR REPLACE INTO source_catalog SELECT h.source_id,h.external_id,c.id,mote_catalog_parent(c.json),COALESCE(json_extract(c.json,'$.windowTitle'),''),CASE WHEN json_extract(c.json,'$.ocrText')='' THEN 'catalog' ELSE COALESCE(json_extract(c.json,'$.provenance.document.fileIndex.coverage'),'full') END FROM source_heads h JOIN captures c ON c.id=h.capture_id WHERE h.deleted=0 AND json_extract(c.json,'$.source')='file';
 INSERT INTO settings VALUES('source-catalog-v1','1'); COMMIT;`);
}
export function browseSourceCatalog(db:DatabaseSync,sourceId:string,input:{parent?:string;cursor?:string;limit?:number}={}){
 const args=z.object({parent:z.string().max(2048).optional(),cursor:z.string().max(8192).optional(),limit:z.number().int().min(1).max(100).default(30)}).parse(input);
 if(args.parent===undefined){
  const after=args.cursor?z.object({source:z.literal(sourceId),parent:z.string()}).parse(JSON.parse(Buffer.from(args.cursor,'base64url').toString())).parent:'';
  const directories=db.prepare('SELECT parent_uri AS parent,COUNT(*) AS files,SUM(coverage!=\'catalog\') AS indexed FROM source_catalog WHERE source_id=? AND parent_uri>=? GROUP BY parent_uri ORDER BY parent_uri LIMIT ?').all(sourceId,after,args.limit+1);
  const items=directories.slice(0,args.limit),last=directories[args.limit];return {directories:items,items:[],nextCursor:last?Buffer.from(JSON.stringify({source:sourceId,parent:last.parent})).toString('base64url'):null,coverage:'Known directory catalog; indexed is not semantic completeness',modelCalls:0};
 }
 const position=args.cursor?z.object({source:z.literal(sourceId),parent:z.literal(args.parent),title:z.string(),id:z.string()}).parse(JSON.parse(Buffer.from(args.cursor,'base64url').toString())):undefined;
 const rows=db.prepare(`SELECT external_id AS id,capture_id AS evidenceId,title,coverage FROM source_catalog WHERE source_id=? AND parent_uri=? ${position?'AND (title>? OR (title=? AND external_id>?))':''} ORDER BY title,external_id LIMIT ?`).all(sourceId,args.parent,...(position?[position.title,position.title,position.id]:[]),args.limit+1);
 const items=rows.slice(0,args.limit),last=items.at(-1);return {directories:[],items,nextCursor:rows.length>args.limit&&last?Buffer.from(JSON.stringify({source:sourceId,parent:args.parent,title:last.title,id:last.id})).toString('base64url'):null,coverage:'Catalog / full or partial text index; originals may be offline',modelCalls:0};
}
