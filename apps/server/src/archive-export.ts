import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {Store,StoreError} from './store.js';
import {ArchivedFileStore} from './archived-files.js';
import {FileStore} from './files.js';
import {exportTar} from './file-export.js';

/** Portable data export, deliberately excluding credentials, private settings and raw database pages. */
export function registerArchiveExport(app:FastifyInstance,store:Store,files:FileStore,archivedFiles:ArchivedFileStore,maxBytes:number){
  app.get('/api/export-bundle',async(req,reply)=>{
    const {mode}=z.object({mode:z.enum(['metadata','data']).default('metadata')}).strict().parse(req.query);
    const estimate=Number(store.db.prepare('SELECT COALESCE(SUM(length(CAST(json AS BLOB))),0) AS n FROM captures').get()!.n);
    if(estimate>maxBytes)throw new StoreError('Metadata exceeds HTTP export limit; use offline backup',413);
    const entries:{name:string;bytes:Buffer}[]=[];let total=0;
    function add(name:string,bytes:Buffer){total+=bytes.length;if(total>maxBytes)throw new StoreError('Export exceeds HTTP limit; use the offline backup command',413);entries.push({name,bytes});}
    const captures=(store.db.prepare('SELECT json,blob_hash FROM captures ORDER BY captured_at,id').all() as {json:string;blob_hash:string|null}[]).map(r=>({...JSON.parse(r.json),blobHash:r.blob_hash}));
    const versions=store.db.prepare('SELECT capture_id,manifest FROM file_versions ORDER BY capture_id').all() as {capture_id:string;manifest:string}[];
    const sources=(store.db.prepare('SELECT json FROM source_connections ORDER BY id').all() as {json:string}[]).map(r=>JSON.parse(r.json));
    const imported=(store.db.prepare('SELECT json FROM archived_files ORDER BY id').all() as {json:string}[]).map(r=>JSON.parse(r.json));
    const attachments=store.db.prepare('SELECT capture_id,file_id FROM capture_files ORDER BY capture_id,file_id').all();
    add('metadata.json',Buffer.from(JSON.stringify({format:'mote-data-export',version:1,mode,exportedAt:new Date().toISOString(),captures,sources,importedFiles:imported,attachments,files:versions.map(r=>({captureId:r.capture_id,...JSON.parse(r.manifest)}))})));
    if(mode==='data'){
      const seen=new Set<string>();
      for(const c of captures)if(c.blobHash&&!seen.has(c.blobHash)){seen.add(c.blobHash);add(`images/${c.blobHash}.blob`,store.image(c.id).bytes);}
      for(const v of versions){const detail=files.detail(v.capture_id);if(detail.hasOriginal){if(total+detail.sizeBytes>maxBytes)throw new StoreError('Export exceeds HTTP limit; use offline backup',413);add(`files/${v.capture_id}.blob`,Buffer.concat([...files.bytes(v.capture_id)]));}}
      for(const file of imported){if(total+file.sizeBytes>maxBytes)throw new StoreError('Export exceeds HTTP limit; use offline backup',413);add(`imported/${file.id}.blob`,archivedFiles.read(file.id));}
      const artifacts=store.db.prepare('SELECT id,capture_id,kind,json FROM file_artifacts ORDER BY id').all();
      add('processing.json',Buffer.from(JSON.stringify(artifacts)));
    }
    return reply.header('Content-Disposition',`attachment; filename="mote-${mode}.tar.gz"`).type('application/gzip').send(exportTar(entries));
  });
}
