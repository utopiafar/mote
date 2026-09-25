import {StoreError} from '../store.js';
import { z } from 'zod';

import type { FastifyInstance } from 'fastify';
import type { FeatureServices } from '../feature-services.js';

/** coding: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{sourcePipelines,sources,store}:Pick<FeatureServices,"sourcePipelines"|"sources"|"store">){
app.get('/api/coding/uploads',async req=>{
  const {offset,limit}=z.object({offset:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict().parse(req.query);
  const all=sources.listSources().filter(source=>source.kind==='coding-agent');
  const items=all.slice(offset,offset+limit).map(source=>({
    source:{id:source.id,name:source.name,deviceId:source.deviceId,enabled:source.enabled,status:source.status},
    received:store.db.prepare('SELECT count(*) AS events,max(observed_at) AS lastObservedAt FROM source_archive_heads WHERE source_id=?').get(source.id),
    archiveBytes:Number(store.db.prepare('SELECT bytes FROM source_archive_sizes WHERE source_id=?').get(source.id)?.bytes??0),
    work:store.db.prepare('SELECT state,count(*) AS count FROM source_pipeline_work WHERE source_id=? GROUP BY state').all(source.id),
    materials:Number(store.db.prepare('SELECT count(*) AS n FROM material_heads WHERE source_id=? AND retired=0').get(source.id)?.n??0),
    indexedMaterials:Number(store.db.prepare('SELECT count(*) AS n FROM material_searchable s JOIN material_heads h ON h.id=s.material_id WHERE h.source_id=? AND h.retired=0').get(source.id)?.n??0),
    memory:store.db.prepare("SELECT coalesce(json_extract(j.json,'$.status'),CASE WHEN w.error IS NOT NULL THEN 'blocked' ELSE 'waiting' END) AS state,count(*) AS count FROM material_memory_work w JOIN material_heads h ON h.id=w.material_id LEFT JOIN memory_jobs j ON j.id=w.job_id WHERE h.source_id=? AND h.retired=0 GROUP BY state").all(source.id),
    pipeline:(()=>{try{return sourcePipelines.select(source)?.id??null;}catch(error){if(error instanceof StoreError&&error.statusCode===409)return null;throw error;}})(),
  }));
  return {items,nextOffset:offset+limit<all.length?offset+limit:null};
});
app.get('/api/source-pipelines',async()=>sourcePipelines.status());
app.get('/api/source-pipelines/:sourceId',async req=>{const {sourceId}=req.params as {sourceId:string};sources.getSource(sourceId);return sourcePipelines.options(sourceId);});
app.delete('/api/source-pipelines/:sourceId',async req=>{const {sourceId}=req.params as {sourceId:string};sources.getSource(sourceId);return sourcePipelines.forget(sourceId);});
app.put('/api/source-pipelines/:sourceId',async req=>{const {sourceId}=req.params as {sourceId:string};sources.getSource(sourceId);return sourcePipelines.configure(sourceId,req.body);});
}
