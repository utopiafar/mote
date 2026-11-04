import {randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {storageStatistics} from '@mote/shared/storage-statistics';
import {z} from 'zod';
import {StoreError} from '../store.js';
import type {PluginResourceScope} from '@mote/plugin-host';
import type {ArchivedFileStore} from '../archived-files.js';
import type {Config} from '../config.js';
import type {ContentStorageService} from '../content-storage.js';
import type {ServerDiagnostics} from '../diagnostics.js';
import type {EvidenceReader} from '../evidence-reader.js';
import type {FileStore} from '../files.js';
import type {RetrievalIndex} from './central-contracts.js';
import type {MaterialStore} from '../materials.js';
import {registerArchiveExport} from './archive-export.js';
import {createMemoryBackup} from './memory-backup.js';
import type {DomainRouteContribution} from './domain-routes.js';

/** Vault-owned storage transport. Content storage is constructed by the vault
 * platform plugin; every handler resolves the current activation instead of
 * capturing a snapshot at mount time. */
export function registerContentStorage(app:FastifyInstance,service:ContentStorageService){
  app.get('/api/content-storage',async()=>service.snapshot());
  app.put('/api/content-storage',async req=>service.save(z.object({enabled:z.boolean(),revision:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict().parse(req.body)));
  app.post('/api/content-storage/decrypt',async(req,reply)=>{z.object({}).strict().parse(req.body??{});return reply.code(202).send(service.start());});
  app.post('/api/content-storage/decrypt/cancel',async()=>service.cancel());
}

export interface VaultStorageRouteDependencies {
  readonly archivedFiles:ArchivedFileStore;
  readonly config:Config;
  readonly diagnostics:ServerDiagnostics;
  readonly evidenceReader:EvidenceReader;
  readonly files:FileStore;
  readonly indexer:RetrievalIndex;
  readonly store:MaterialStore['store'];
}

export function vaultStorageRoutes(content:()=>ContentStorageService,dependencies:VaultStorageRouteDependencies):DomainRouteContribution{
  const {archivedFiles,config,diagnostics,evidenceReader,files,indexer,store}=dependencies;
  return Object.freeze({mount(app:FastifyInstance,scope?:PluginResourceScope){
    const maintain=()=>{files.sweep();if(config.retentionDays>0)return diagnostics.run(randomUUID(),()=>diagnostics.measure('maintenance','retention',()=>store.prune(new Date(Date.now()-config.retentionDays*86400000).toISOString()),deleted=>({deleted})));};
    if(scope)void scope.run(maintain);else void maintain();scope?.every(3600000,maintain);
    registerContentStorage(app,content());
    app.post('/api/index/retry',async()=>{if(!indexer.configured)throw new StoreError('Embedding model is not configured',409);const result=indexer.retry();diagnostics.record('queue.snapshot',{pending:result.queued});void indexer.tick();return result;});
    const memoryBackup=evidenceReader.memoryBindings?createMemoryBackup(evidenceReader.memoryBindings):undefined;
    registerArchiveExport(app,store,files,archivedFiles,config.maxExportBytes,memoryBackup);
    app.get('/api/export',async(_req,reply)=>{
      const memories=memoryBackup?await memoryBackup.export():undefined;
      const archive=store.exportArchive(config.maxExportBytes);if(memories)archive.memories=memories;
      if(Buffer.byteLength(JSON.stringify(archive))>config.maxExportBytes)throw new StoreError('Expanded archive exceeds the export limit; use npm run backup',413);
      return reply.header('Content-Disposition',`attachment; filename="mote-${new Date().toISOString().slice(0,10)}.json"`).send(archive);
    });
    app.post('/api/import',{bodyLimit:config.maxExportBytes},async req=>diagnostics.measure('ingest','import',()=>store.importArchive(req.body),r=>({count:r.imported})));
    app.get('/api/storage-statistics',async()=>{const types=new Map((store.db.prepare("SELECT object_hash,MIN(json_extract(manifest,'$.item.mimeType')) AS mime FROM file_versions WHERE object_hash IS NOT NULL GROUP BY object_hash").all() as {object_hash:string;mime:string}[]).map(r=>[r.object_hash,r.mime]));const report=await storageStatistics([config.dataDir],path=>path.startsWith(files.objects+'/')?types.get(path.slice(files.objects.length+1).split('/')[0])??'original':undefined);return {...report,logical:store.storageBreakdown()};});
  }});
}
