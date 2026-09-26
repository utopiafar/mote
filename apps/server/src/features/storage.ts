import {randomUUID} from 'node:crypto';
import type {ServerFeatureScope} from '../feature-host.js';
import { storageStatistics } from '@mote/shared/storage-statistics';
import type { FastifyInstance } from 'fastify';
import { registerArchiveExport } from '../archive-export.js';
import { registerContentStorage } from '../content-storage.js';
import type { FeatureServices } from '../feature-services.js';
import { StoreError } from '../store.js';

/** storage: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{archivedFiles,config,contentStorage,diagnostics,files,indexer,store}:Pick<FeatureServices,"archivedFiles"|"config"|"contentStorage"|"diagnostics"|"files"|"indexer"|"store">,scope?:ServerFeatureScope){
 scope?.every(5000,()=>indexer.tick());scope?.defer(()=>indexer.close());
 const maintain=()=>{files.sweep();if(config.retentionDays>0)return diagnostics.run(randomUUID(),()=>diagnostics.measure('maintenance','retention',()=>store.prune(new Date(Date.now()-config.retentionDays*86400000).toISOString()),deleted=>({deleted})));};
 if(scope)void scope.run(maintain);else void maintain();scope?.every(3600000,maintain);
registerContentStorage(app,contentStorage);
app.post('/api/index/retry',async()=>{if(!indexer.configured)throw new StoreError('Embedding model is not configured',409);const result=indexer.retry();diagnostics.record('queue.snapshot',{pending:result.queued});void indexer.tick();return result;});
registerArchiveExport(app,store,files,archivedFiles,config.maxExportBytes);
app.get('/api/export',async(_req,reply)=>reply.header('Content-Disposition',`attachment; filename="mote-${new Date().toISOString().slice(0,10)}.json"`).send(store.exportArchive(config.maxExportBytes)));
app.post('/api/import',{bodyLimit:config.maxExportBytes},async req=>diagnostics.measure('ingest','import',()=>store.importArchive(req.body),r=>({count:r.imported})));
app.get('/api/storage-statistics',async()=>{const types=new Map((store.db.prepare("SELECT object_hash,MIN(json_extract(manifest,'$.item.mimeType')) AS mime FROM file_versions WHERE object_hash IS NOT NULL GROUP BY object_hash").all() as {object_hash:string;mime:string}[]).map(r=>[r.object_hash,r.mime]));return storageStatistics([config.dataDir],path=>path.startsWith(store.blobsDir+'/')?'image':path.startsWith(files.objects+'/')?types.get(path.slice(files.objects.length+1).split('/')[0])??'original':undefined);});
}
