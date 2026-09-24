import {z} from 'zod';
import type {MemoryPipeline} from './memory-pipeline.js';
import {Context,type Plugin} from '@deepseek-ai/cordis';
import type {SourceConnection,SourceItem} from '@mote/shared';
import type {MaterialDraft,MaterialStore} from './materials.js';
import {SourceArchive,archiveHash} from './source-archive.js';
import {StoreError,type Store} from './store.js';

export interface SourcePipeline {
  id:string;version:string;priority?:number;
  /** Explicit protocol/source kinds only, never semantic classification. */
  sourceKinds:string[];
  storage:'records'|'archive';
  index:'none'|'material';
  modelInput:'material';
  memory?:boolean;
  group?(item:SourceItem):string;
  organize?(input:{source:SourceConnection;items:SourceItem[];group:string}):MaterialDraft|undefined;
}
export class SourcePipelineRegistry {
  private entries=new Map<string,SourcePipeline>();
  private declaredKinds=new Set<string>();
  register(pipeline:SourcePipeline){
    if(!/^[a-z0-9.-]+$/.test(pipeline.id)||!pipeline.version||this.entries.has(pipeline.id)||!pipeline.sourceKinds.length||pipeline.modelInput!=='material'||!['records','archive'].includes(pipeline.storage)||!['none','material'].includes(pipeline.index)||pipeline.storage==='archive'&&(!pipeline.group||!pipeline.organize))throw Error('Invalid source pipeline');
    if([...this.entries.values()].some(p=>(p.priority??0)===(pipeline.priority??0)&&p.sourceKinds.some(kind=>pipeline.sourceKinds.includes(kind))))throw Error('Ambiguous source pipeline');
    pipeline.sourceKinds.forEach(kind=>this.declaredKinds.add(kind));
    this.entries.set(pipeline.id,pipeline);return ()=>{if(this.entries.get(pipeline.id)===pipeline)this.entries.delete(pipeline.id);};
  }
  declared(kind:string){return this.declaredKinds.has(kind);}
  get(id:string){return this.entries.get(id);}
  forKind(kind:string){return [...this.entries.values()].filter(p=>p.sourceKinds.includes(kind)).sort((a,b)=>(b.priority??0)-(a.priority??0))[0];}
  list(){return [...this.entries.values()].map(({group,organize,...policy})=>policy);}
}
declare module '@deepseek-ai/cordis' {interface Context {moteSourcePipelines:SourcePipelineRegistry;}}
/** Cordis owns installation; host owns receipts, durable work and atomic publication.
 * There is one work row per logical group, never one SQL row per raw event. */
export class SourcePipelineRuntime {
  readonly registry=new SourcePipelineRegistry();readonly context=new Context();readonly archive:SourceArchive;
  readonly ready:Promise<void>;
  constructor(readonly store:Store,readonly materials:MaterialStore,plugins:Plugin[]=[]){
    this.archive=new SourceArchive(store);this.context.provide('moteSourcePipelines',this.registry);
    store.db.exec(`CREATE TABLE IF NOT EXISTS source_pipeline_bindings(source_id TEXT PRIMARY KEY,pipeline_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_pipeline_work(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,pipeline_id TEXT NOT NULL,version TEXT NOT NULL,group_key TEXT NOT NULL,state TEXT NOT NULL,error TEXT,updated_at INTEGER NOT NULL,material_ref TEXT);
      CREATE TABLE IF NOT EXISTS source_pipeline_config(source_id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material_memory_work(material_id TEXT PRIMARY KEY REFERENCES material_heads(id) ON DELETE CASCADE,revision TEXT NOT NULL,ready_at INTEGER NOT NULL,job_id TEXT,error TEXT);`);
    this.ready=(async()=>{for(const plugin of plugins)await this.context.plugin(plugin);})();
  }
  select(source:SourceConnection){
    const binding=this.store.db.prepare('SELECT pipeline_id FROM source_pipeline_bindings WHERE source_id=?').get(source.id);
    const pipeline=binding?this.registry.get(String(binding.pipeline_id)):this.registry.forKind(source.kind);
    if(binding&&!pipeline)throw new StoreError('Source pipeline unavailable',409);
    if(pipeline&&!pipeline.sourceKinds.includes(source.kind))throw new StoreError('Source pipeline kind mismatch',409);
    // Ordinary sources retain the record-store path. A declared plugin kind
    // may never silently fall through after uninstall.
    if(!pipeline&&this.registry.declared(source.kind))throw new StoreError('Source pipeline unavailable',409);
    return pipeline;
  }
  receive(source:SourceConnection,items:SourceItem[],validate:()=>void){
    const pipeline=this.select(source);if(!pipeline||pipeline.storage==='records')return undefined;
    const groups=items.map(item=>pipeline.group!(item));
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try{
      validate();if(this.select(source)!==pipeline)throw new StoreError('Source pipeline changed',409);
      const archived=this.archive.receive(source.id,items,groups);
      db.prepare('INSERT OR IGNORE INTO source_pipeline_bindings VALUES(?,?)').run(source.id,pipeline.id);
      for(const group of archived.groups)db.prepare(`INSERT INTO source_pipeline_work VALUES(?,?,?,?,?,'pending',NULL,?,NULL)
        ON CONFLICT(id) DO UPDATE SET state='pending',error=NULL,updated_at=excluded.updated_at,version=excluded.version`).run(archiveHash([source.id,group]),source.id,pipeline.id,pipeline.version,group,Date.now());
      db.exec('COMMIT');this.archive.acknowledge(source.id,archived.checkpoint);return {receipts:archived.receipts};
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  tick(limit=10){
    for(const policy of this.registry.list())this.store.db.prepare("UPDATE source_pipeline_work SET state='pending',version=? WHERE pipeline_id=? AND version!=?").run(policy.version,policy.id,policy.version);
    const rows=this.store.db.prepare("SELECT * FROM source_pipeline_work WHERE state IN ('pending','blocked','failed') ORDER BY updated_at LIMIT ?").all(limit);
    for(const row of rows){
      const pipeline=this.registry.get(String(row.pipeline_id));
      if(!pipeline||pipeline.version!==row.version){this.store.db.prepare("UPDATE source_pipeline_work SET state='blocked',error='pipeline_unavailable',updated_at=? WHERE id=?").run(Date.now(),row.id);continue;}
      const db=this.store.db;db.exec('BEGIN IMMEDIATE');
      try{
        const sourceRow=db.prepare('SELECT json FROM source_connections WHERE id=?').get(row.source_id);if(!sourceRow)throw Error('Source missing');
        const source=JSON.parse(String(sourceRow.json)) as SourceConnection;
        const draft=pipeline.organize!({source,group:String(row.group_key),items:this.archive.current(source.id,String(row.group_key))});
        let ref:string|null=null;
        if(draft){const prior=this.materials.get(draft.id);const published=this.materials.publish(draft,{expectedRevision:prior?.revision??null});ref=published.ref;this.materials.setSearchable(published.id,this.options(source.id).index??pipeline.index==='material');
          if(published.coverage.state==='complete'&&(published.changed||!db.prepare('SELECT 1 FROM material_memory_work WHERE material_id=?').get(published.id))&&(this.options(source.id).memory??pipeline.memory??false))db.prepare(`INSERT INTO material_memory_work VALUES(?,?,?,NULL,NULL) ON CONFLICT(material_id) DO UPDATE SET revision=excluded.revision,ready_at=excluded.ready_at,job_id=NULL,error=NULL`).run(published.id,published.revision,Date.now()+this.options(source.id).settleSeconds*1000);}
        db.prepare("UPDATE source_pipeline_work SET state='complete',error=NULL,material_ref=? WHERE id=?").run(ref,row.id);db.exec('COMMIT');
      }catch(error){db.exec('ROLLBACK');db.prepare("UPDATE source_pipeline_work SET state='failed',error='organization_failed',updated_at=? WHERE id=?").run(Date.now(),row.id);}
    }
    return rows.length;
  }
  options(sourceId:string){const row=this.store.db.prepare('SELECT json FROM source_pipeline_config WHERE source_id=?').get(sourceId);return configuration.parse(row?JSON.parse(String(row.json)):{});}
  configure(sourceId:string,input:unknown){const value=configuration.parse(input);const db=this.store.db;db.exec('BEGIN IMMEDIATE');try{
    if(value.pipelineId){const sourceRow=this.store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(sourceId);if(!sourceRow)throw new StoreError('Source not found',404);const source=JSON.parse(String(sourceRow.json)) as SourceConnection;
      const selected=this.registry.get(value.pipelineId);if(!selected||!selected.sourceKinds.includes(source.kind))throw new StoreError('Pipeline unavailable for source kind',409);
      const prior=this.select(source);if(prior&&prior.storage!==selected.storage)throw new StoreError('Changing physical storage requires a fresh source identity',409);
      this.store.db.prepare('INSERT INTO source_pipeline_bindings VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET pipeline_id=excluded.pipeline_id').run(sourceId,selected.id);
      this.store.db.prepare("UPDATE source_pipeline_work SET pipeline_id=?,version=?,state='pending' WHERE source_id=?").run(selected.id,selected.version,sourceId);
    }
    this.store.db.prepare('INSERT INTO source_pipeline_config VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET json=excluded.json').run(sourceId,JSON.stringify(value));this.store.db.prepare("UPDATE source_pipeline_work SET state='pending' WHERE source_id=?").run(sourceId);db.exec('COMMIT');return value;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
  drainMemory(pipeline:MemoryPipeline,enabled:boolean,limit=1){
    if(!enabled)return;
    for(const row of this.store.db.prepare('SELECT * FROM material_memory_work WHERE job_id IS NULL AND ready_at<=? ORDER BY ready_at LIMIT ?').all(Date.now(),limit)){
      const material=this.materials.get(String(row.material_id));if(!material||material.revision!==row.revision)continue;
      if(this.options(material.origin.sourceId).memory===false){this.store.db.prepare('UPDATE material_memory_work SET ready_at=? WHERE material_id=?').run(Date.now()+60000,row.material_id);continue;}
      const binding=this.store.db.prepare('SELECT pipeline_id FROM source_pipeline_bindings WHERE source_id=?').get(material.origin.sourceId);if(!binding||!this.registry.get(String(binding.pipeline_id)))continue;
      try{const job=pipeline.create({evidenceIds:this.materials.evidenceIds(material.ref),originKey:material.ref});this.store.db.prepare('UPDATE material_memory_work SET job_id=?,error=NULL WHERE material_id=? AND revision=?').run(job.id,row.material_id,row.revision);void pipeline.run(job.id).catch(()=>{});}
      catch{this.store.db.prepare("UPDATE material_memory_work SET error='memory_enqueue_failed',ready_at=? WHERE material_id=?").run(Date.now()+60000,row.material_id);}
    }
  }
  forget(sourceId:string){
    if(!this.store.db.prepare('SELECT 1 FROM source_pipeline_bindings WHERE source_id=?').get(sourceId))throw new StoreError('Source has no archive pipeline',409);
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');try{
      db.prepare("UPDATE source_connections SET json=json_set(json,'$.enabled',json('false')) WHERE id=?").run(sourceId);
      for(const row of db.prepare('SELECT id FROM material_heads WHERE source_id=?').all(sourceId))this.materials.forget(String(row.id));
      db.prepare('DELETE FROM source_pipeline_work WHERE source_id=?').run(sourceId);
      db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    this.archive.forget(sourceId);return {erased:true,sourcePaused:true};
  }
  status(){return {pipelines:this.registry.list(),work:this.store.db.prepare('SELECT state,count(*) count FROM source_pipeline_work GROUP BY state').all()};}
  async close(){await this.context.fiber.dispose();}
}

const configuration=z.object({pipelineId:z.string().regex(/^[a-z0-9.-]+$/).optional(),index:z.boolean().optional(),memory:z.boolean().optional(),settleSeconds:z.number().int().min(0).max(86400).default(300)}).strict();
