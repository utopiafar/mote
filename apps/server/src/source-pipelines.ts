import {z} from 'zod';
import type {MemoryPipeline} from './memory-pipeline.js';
import {Context,type Plugin} from '@deepseek-ai/cordis';
import type {SourceConnection,SourceItem} from '@mote/shared';
import {materialId,type CodingArchiveSnapshot,type MaterialAppendDraft,type MaterialDraft,type MaterialStore} from './materials.js';
import {SourceArchive,archiveHash} from './source-archive.js';
import {StoreError,type Store} from './store.js';
import {BackendPluginScope} from './backend-plugin-scope.js';
import {SourceRecipeExecutor,type RecipeSnapshot} from './source-recipe-executor.js';
import {recipeFingerprint} from './recipe-contract.js';
import type {InstalledRecipe} from './recipe-registry.js';
import {materialDependencyStatus} from './material-readiness.js';
import {SourceArchiveRawReader} from './source-archive-reader.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';

type WorkRow={id:string;source_id:string;pipeline_id:string;version:string;group_key:string;state:string;generation:number;archive_checkpoint:string|null;
  recipe_id:string|null;recipe_version:string|null;recipe_definition_fingerprint:string|null;recipe_config_fingerprint:string|null;recipe_component_pins:string|null};
type GroupInput={workId:string;sourceId:string;pipelineId:string;version:string;group:string;generation:number;checkpoint:string|null;
  recipeId:string|null;recipeVersion:string|null;recipeDefinitionFingerprint:string|null;recipeConfigFingerprint:string|null;recipeComponentPins:string|null;
  sourceFingerprint:string;configFingerprint:string;policyFingerprint:string;reprocess:'deterministic'|'manual'};
type PreparedGroup={draft:MaterialDraft|MaterialAppendDraft|undefined;pipeline:SourcePipeline;recipe:InstalledRecipe|undefined;sourceJson:string;configJson:string|null;checkpoint:string;policyFingerprint:string;
  priorRevision:string|null;codingSnapshot?:CodingArchiveSnapshot;
  organizer:SourcePipeline['organize'];options:z.infer<typeof configuration>};
const STEP_KIND='source.archive-group';
const stepId=(id:string,generation:number)=>`source.archive-group:${id}:${generation}`;

export interface SourcePipeline {
  id:string;version:string;priority?:number;
  /** Explicit protocol/source kinds only, never semantic classification. */
  sourceKinds:string[];
  storage:'records'|'archive';
  index:'none'|'material';
  modelInput:'material';
  memory?:boolean;
  /** Named material outputs required before this source may derive Memory. */
  memoryDependencies?:string[];
  /** A declarative recipe pins trusted implementations used by this pipeline. */
  recipe?:{id:string;version:string};
  /** Historical model work requires an explicit user request; only declared deterministic recipes replay automatically. */
  reprocess?:'deterministic'|'manual';
  group?(item:SourceItem):string;
  organize?(input:{source:SourceConnection;items:SourceItem[];group:string}):MaterialDraft|undefined;
}
export class SourcePipelineRegistry {
  private entries=new Map<string,SourcePipeline>();
  private declaredKinds=new Set<string>();
  register(pipeline:SourcePipeline){
    if(!/^[a-z0-9.-]+$/.test(pipeline.id)||!pipeline.version||this.entries.has(pipeline.id)||!pipeline.sourceKinds.length||pipeline.modelInput!=='material'||!['records','archive'].includes(pipeline.storage)||!['none','material'].includes(pipeline.index)||pipeline.storage==='archive'&&!pipeline.recipe&&(!pipeline.group||!pipeline.organize))throw Error('Invalid source pipeline');
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
  readonly registry=new SourcePipelineRegistry();readonly recipes=new SourceRecipeExecutor();readonly context:Context;readonly archive:SourceArchive;private readonly pluginScope:BackendPluginScope;
  readonly engine:ExecutionEngine;private readonly ownsEngine:boolean;private readonly unregisterHandler:()=>void;
  readonly ready:Promise<void>;
  constructor(readonly store:Store,readonly materials:MaterialStore,plugins:Plugin[]=[],root?:Context,executor?:ExecutionEngine){
    this.pluginScope=new BackendPluginScope(root);this.context=this.pluginScope.context;
    this.engine=executor??new ExecutionEngine(store);this.ownsEngine=!executor;
    this.archive=new SourceArchive(store);this.pluginScope.provide('moteSourcePipelines',this.registry);this.pluginScope.provide('moteSourceRecipes',this.recipes);
    store.db.exec(`CREATE TABLE IF NOT EXISTS source_pipeline_bindings(source_id TEXT PRIMARY KEY,pipeline_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_pipeline_work(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,pipeline_id TEXT NOT NULL,version TEXT NOT NULL,group_key TEXT NOT NULL,state TEXT NOT NULL,error TEXT,updated_at INTEGER NOT NULL,material_ref TEXT,generation INTEGER NOT NULL DEFAULT 0,archive_checkpoint TEXT,
        recipe_id TEXT,recipe_version TEXT,recipe_definition_fingerprint TEXT,recipe_config_fingerprint TEXT,recipe_component_pins TEXT);
      CREATE TABLE IF NOT EXISTS source_pipeline_config(source_id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS material_memory_work(material_id TEXT PRIMARY KEY REFERENCES material_heads(id) ON DELETE CASCADE,revision TEXT NOT NULL,ready_at INTEGER NOT NULL,job_id TEXT,error TEXT);`);
    const workColumns=new Set((store.db.prepare('PRAGMA table_info(source_pipeline_work)').all() as {name:string}[]).map(column=>column.name));
    if(!workColumns.has('generation'))store.db.exec('ALTER TABLE source_pipeline_work ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    if(!workColumns.has('archive_checkpoint'))store.db.exec('ALTER TABLE source_pipeline_work ADD COLUMN archive_checkpoint TEXT');
    for(const name of ['recipe_id','recipe_version','recipe_definition_fingerprint','recipe_config_fingerprint','recipe_component_pins'])if(!workColumns.has(name))store.db.exec(`ALTER TABLE source_pipeline_work ADD COLUMN ${name} TEXT`);
    this.unregisterHandler=this.engine.register({kind:STEP_KIND,pool:'source.archive',concurrency:()=>2,
      resourceKeys:step=>[`source.archive:${(step.input as unknown as GroupInput).workId}`],
      validate:step=>this.validWork(step),admit:step=>this.admitWork(step),
      execute:(step,signal)=>this.organizeGroup(step,signal),commit:(step,result)=>this.publishGroup(step,result as PreparedGroup),
      project:step=>this.projectWork(step),classify:()=>new ExecutionFailure('transient','organization_failed'),timeoutMs:300000});
    const pluginScope=this.pluginScope;
    this.ready=(async()=>{for(const plugin of plugins)await pluginScope.install(plugin);})();
  }
  private recipeFor(pipeline:SourcePipeline,source:SourceConnection):InstalledRecipe|undefined {
    if(!pipeline.recipe)return undefined;
    let recipe:InstalledRecipe;
    try{recipe=this.recipes.resolve(pipeline.recipe.id,pipeline.recipe.version);}catch{throw new StoreError('Source recipe or component unavailable',409);}
    if(recipe.definition.accepts.sourceKind!==source.kind)throw new StoreError('Source recipe kind mismatch',409);
    return recipe;
  }
  private recipeMetadata(recipe:InstalledRecipe,sourceId:string,options=this.options(sourceId)){
    return {
      id:recipe.definition.id,version:recipe.definition.version,
      definitionFingerprint:recipe.definitionFingerprint,
      configFingerprint:recipeFingerprint({recipe:recipe.configFingerprint,sourceConfig:options}),
      componentPins:JSON.stringify(recipe.componentPins),
    };
  }
  private policyFingerprint(pipeline:SourcePipeline){return archiveHash({id:pipeline.id,version:pipeline.version,storage:pipeline.storage,index:pipeline.index,
    memory:pipeline.memory??false,memoryDependencies:pipeline.memoryDependencies??['material'],recipe:pipeline.recipe??null,reprocess:pipeline.reprocess??'manual'});}
  private sourceFingerprint(json:string){if(!json)return archiveHash('');const source=JSON.parse(json) as SourceConnection;
    // Availability and intake retention govern future receipts. Neither may
    // reinterpret raw input already accepted for this immutable source identity.
    return archiveHash({id:source.id,kind:source.kind,deviceId:source.deviceId,platform:source.platform});}
  private input(step:ExecutionStep){return step.input as unknown as GroupInput;}
  private row(id:string){return this.store.db.prepare('SELECT * FROM source_pipeline_work WHERE id=?').get(id) as WorkRow|undefined;}
  private enqueueWork(row:WorkRow){
    const db=this.store.db,sourceJson=String((db.prepare('SELECT json FROM source_connections WHERE id=?').get(row.source_id) as {json:string}|undefined)?.json??''),
      configJson=(db.prepare('SELECT json FROM source_pipeline_config WHERE source_id=?').get(row.source_id) as {json:string}|undefined)?.json??null;
    if(row.archive_checkpoint===null){row.archive_checkpoint=this.archive.groupCheckpoint(row.source_id,row.group_key);
      db.prepare('UPDATE source_pipeline_work SET archive_checkpoint=? WHERE id=? AND generation=?').run(row.archive_checkpoint,row.id,row.generation);}
    const pipeline=this.registry.get(row.pipeline_id);
    const input:GroupInput={workId:row.id,sourceId:row.source_id,pipelineId:row.pipeline_id,version:row.version,group:row.group_key,
      generation:row.generation,checkpoint:row.archive_checkpoint,recipeId:row.recipe_id,recipeVersion:row.recipe_version,
      recipeDefinitionFingerprint:row.recipe_definition_fingerprint,recipeConfigFingerprint:row.recipe_config_fingerprint,
      recipeComponentPins:row.recipe_component_pins,sourceFingerprint:this.sourceFingerprint(sourceJson),configFingerprint:archiveHash(configJson),
      policyFingerprint:pipeline?this.policyFingerprint(pipeline):'',reprocess:pipeline?.reprocess??'manual'};
    return this.engine.enqueue(`source:${row.source_id}:${row.id}`,STEP_KIND,input as unknown as Record<string,unknown>,
      {id:stepId(row.id,row.generation),generation:{slot:'archive-group',version:String(row.generation)}});
  }
  private revoke(id:string){
    this.store.db.prepare("UPDATE execution_steps SET state='stale',fence=NULL,error='superseded',updated_at=? WHERE id=? AND state IN ('waiting','running')").run(Date.now(),id);
  }
  private validWork(step:ExecutionStep){
    try{
      const input=this.input(step),row=this.row(input.workId);if(!row||row.generation!==input.generation||row.source_id!==input.sourceId||row.pipeline_id!==input.pipelineId||row.version!==input.version||row.group_key!==input.group||row.archive_checkpoint!==input.checkpoint)return false;
      if(row.recipe_id!==input.recipeId||row.recipe_version!==input.recipeVersion||row.recipe_definition_fingerprint!==input.recipeDefinitionFingerprint||row.recipe_config_fingerprint!==input.recipeConfigFingerprint||row.recipe_component_pins!==input.recipeComponentPins)return false;
      const db=this.store.db,sourceJson=(db.prepare('SELECT json FROM source_connections WHERE id=?').get(row.source_id) as {json:string}|undefined)?.json??'',
        configJson=(db.prepare('SELECT json FROM source_pipeline_config WHERE source_id=?').get(row.source_id) as {json:string}|undefined)?.json??null;
      if(this.sourceFingerprint(sourceJson)!==input.sourceFingerprint||archiveHash(configJson)!==input.configFingerprint)return false;
      // Pausing a source stops new receipts at SourceStore. A receipt already
      // accepted into the archive still owns its pinned organization work.
      if(!sourceJson||!input.checkpoint)return false;
      return this.archive.groupCheckpoint(input.sourceId,input.group)===input.checkpoint;
    }catch{return false;}
  }
  private admitWork(step:ExecutionStep){
    try{
      const input=this.input(step),pipeline=this.registry.get(input.pipelineId);
      if(!pipeline||pipeline.version!==input.version||pipeline.storage!=='archive'||this.policyFingerprint(pipeline)!==input.policyFingerprint)throw Error('pipeline_unavailable');
      const source=JSON.parse(String((this.store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(input.sourceId) as {json:string}).json)) as SourceConnection;
      if(this.select(source)!==pipeline)throw Error('pipeline_unavailable');
      const recipe=this.recipeFor(pipeline,source),options=this.options(input.sourceId);
      if(recipe){const metadata=this.recipeMetadata(recipe,input.sourceId,options);
        if(input.recipeId!==metadata.id||input.recipeVersion!==metadata.version||input.recipeDefinitionFingerprint!==metadata.definitionFingerprint||input.recipeConfigFingerprint!==metadata.configFingerprint||input.recipeComponentPins!==metadata.componentPins)throw Error('recipe_unavailable');
      }else if(input.recipeId!==null||!pipeline.organize)throw Error('pipeline_unavailable');
    }catch(error){return new ExecutionFailure('blocked',error instanceof Error&&error.message==='pipeline_unavailable'?'pipeline_unavailable':'recipe_unavailable');}
  }
  private async organizeGroup(step:ExecutionStep,signal:AbortSignal):Promise<PreparedGroup>{
    signal.throwIfAborted();if(!this.validWork(step))throw new ExecutionFailure('stale','input_changed');
    const input=this.input(step),db=this.store.db,pipeline=this.registry.get(input.pipelineId)!;
    const sourceJson=(db.prepare('SELECT json FROM source_connections WHERE id=?').get(input.sourceId) as {json:string}).json,
      configJson=(db.prepare('SELECT json FROM source_pipeline_config WHERE source_id=?').get(input.sourceId) as {json:string}|undefined)?.json??null,
      source=JSON.parse(sourceJson) as SourceConnection,options=configuration.parse(configJson?JSON.parse(configJson):{}),recipe=this.recipeFor(pipeline,source);
    // The reader and organizer run outside the engine transaction. This stage
    // may become asynchronous without changing its fenced host commit.
    const base=recipe?this.materials.codingBase(materialId(input.sourceId,input.group)):undefined;
    const scopedReader=recipe?new SourceArchiveRawReader(this.store,this.archive,{
      mayReadSource:id=>id===input.sourceId&&!signal.aborted&&this.validWork(step),
      mayReadGroup:(id,group)=>id===input.sourceId&&group===input.group&&!signal.aborted&&this.validWork(step),
    }):undefined;
    const snapshot=recipe?await this.recipes.snapshot(recipe,scopedReader!,source,input.group,signal,base):this.archive.currentSnapshot(input.sourceId,input.group);
    if(snapshot.checkpoint!==input.checkpoint)throw new ExecutionFailure('stale','archive_changed');
    signal.throwIfAborted();
    const organizer=pipeline.organize,draft=recipe?this.recipes.organize(recipe,source,input.group,snapshot):organizer!({source,group:input.group,items:snapshot.items});
    signal.throwIfAborted();
    const priorRevision=draft?this.materials.revisionForWrite(draft.id):null;
    if(draft&&'mode' in draft&&base?.record.revision!==priorRevision)throw new ExecutionFailure('stale','material_changed');
    const pinned=recipe?snapshot as RecipeSnapshot:undefined;
    const codingSnapshot=pinned&&typeof pinned.headCount==='number'&&typeof pinned.appendEpoch==='number'?
      {checkpoint:pinned.checkpoint,headCount:pinned.headCount,appendEpoch:pinned.appendEpoch}:undefined;
    return {draft,pipeline,recipe,sourceJson,configJson,checkpoint:snapshot.checkpoint,policyFingerprint:this.policyFingerprint(pipeline),organizer,options,
      priorRevision,codingSnapshot};
  }
  private publishGroup(step:ExecutionStep,result:PreparedGroup){
    const input=this.input(step),db=this.store.db;
    if(!this.validWork(step))throw new ExecutionFailure('stale','input_changed');
    const pipeline=this.registry.get(input.pipelineId);
    if(pipeline!==result.pipeline||!pipeline||pipeline.version!==input.version||pipeline.organize!==result.organizer||this.policyFingerprint(pipeline)!==result.policyFingerprint)throw new ExecutionFailure('blocked','pipeline_unavailable');
    const sourceJson=(db.prepare('SELECT json FROM source_connections WHERE id=?').get(input.sourceId) as {json:string}|undefined)?.json,
      configJson=(db.prepare('SELECT json FROM source_pipeline_config WHERE source_id=?').get(input.sourceId) as {json:string}|undefined)?.json??null;
    if(!sourceJson||this.sourceFingerprint(sourceJson)!==this.sourceFingerprint(result.sourceJson)||configJson!==result.configJson||this.archive.groupCheckpoint(input.sourceId,input.group)!==result.checkpoint)throw new ExecutionFailure('stale','input_changed');
    const source=JSON.parse(sourceJson!) as SourceConnection;
    try{if(this.select(source)!==pipeline||result.recipe&&this.recipeFor(pipeline,source)!==result.recipe)throw Error('Component changed');}
    catch{throw new ExecutionFailure('blocked','recipe_unavailable');}
    if(result.recipe){const metadata=this.recipeMetadata(result.recipe,input.sourceId,result.options);
      if(metadata.id!==input.recipeId||metadata.version!==input.recipeVersion||metadata.definitionFingerprint!==input.recipeDefinitionFingerprint||metadata.configFingerprint!==input.recipeConfigFingerprint||metadata.componentPins!==input.recipeComponentPins)throw new ExecutionFailure('blocked','recipe_unavailable');}
    let ref:string|null=null;
    if(result.draft){if(this.materials.revisionForWrite(result.draft.id)!==result.priorRevision)throw new ExecutionFailure('stale','material_changed');
      const published=this.materials.publish(result.draft,{expectedRevision:result.priorRevision,codingSnapshot:result.codingSnapshot});ref=published.ref;
      const shouldIndex=result.options.index??pipeline.index==='material',isIndexed=Boolean(db.prepare('SELECT 1 FROM material_searchable WHERE material_id=?').get(published.id));
      if(shouldIndex!==isIndexed)this.materials.setSearchable(published.id,shouldIndex);
      const required=result.options.memoryDependencies??pipeline.memoryDependencies??['material'],readiness=materialDependencyStatus(published,required);
      if(!readiness.ready)db.prepare('DELETE FROM material_memory_work WHERE material_id=?').run(published.id);
      else if((published.changed||!db.prepare('SELECT 1 FROM material_memory_work WHERE material_id=?').get(published.id))&&(result.options.memory??pipeline.memory??false))db.prepare(`INSERT INTO material_memory_work VALUES(?,?,?,NULL,NULL) ON CONFLICT(material_id) DO UPDATE SET revision=excluded.revision,ready_at=excluded.ready_at,job_id=NULL,error=NULL`).run(published.id,published.revision,Date.now()+result.options.settleSeconds*1000);}
    const changed=db.prepare("UPDATE source_pipeline_work SET state='complete',error=NULL,material_ref=? WHERE id=? AND generation=?").run(ref,input.workId,input.generation).changes;
    if(changed!==1)throw new ExecutionFailure('stale','input_changed');
  }
  private projectWork(step:ExecutionStep){
    const input=this.input(step),state=step.state==='waiting'||step.state==='running'?'pending':step.state==='succeeded'?'complete':step.state==='stale'||step.state==='cancelled'?'blocked':step.state;
    this.store.db.prepare("UPDATE source_pipeline_work SET state=?,error=?,updated_at=? WHERE id=? AND generation=? AND state!='complete'").run(state,step.error??null,Date.now(),input.workId,input.generation);
  }
  select(source:SourceConnection){
    const binding=this.store.db.prepare('SELECT pipeline_id FROM source_pipeline_bindings WHERE source_id=?').get(source.id);
    const pipeline=binding?this.registry.get(String(binding.pipeline_id)):this.registry.forKind(source.kind);
    if(binding&&!pipeline)throw new StoreError('Source pipeline unavailable',409);
    if(pipeline&&!pipeline.sourceKinds.includes(source.kind))throw new StoreError('Source pipeline kind mismatch',409);
    if(pipeline)this.recipeFor(pipeline,source);
    // Ordinary sources retain the record-store path. A declared plugin kind
    // may never silently fall through after uninstall.
    if(!pipeline&&this.registry.declared(source.kind))throw new StoreError('Source pipeline unavailable',409);
    return pipeline;
  }
  receive(source:SourceConnection,items:SourceItem[],validate:()=>void){
    const pipeline=this.select(source);if(!pipeline||pipeline.storage==='records')return undefined;
    const recipe=this.recipeFor(pipeline,source),metadata=recipe?this.recipeMetadata(recipe,source.id):undefined;
    const groups=items.map(item=>recipe?this.recipes.group(recipe,item):pipeline.group!(item));
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try{
      validate();if(this.select(source)!==pipeline)throw new StoreError('Source pipeline changed',409);
      if(recipe&&(this.recipeFor(pipeline,source)!==recipe||this.recipeMetadata(recipe,source.id).configFingerprint!==metadata!.configFingerprint))throw new StoreError('Source recipe configuration changed',409);
      const archived=recipe?this.recipes.receive(recipe,this.archive,source,items,groups):this.archive.receive(source.id,items,groups);
      if(recipe&&(this.recipeFor(pipeline,source)!==recipe||this.recipeMetadata(recipe,source.id).configFingerprint!==metadata!.configFingerprint))throw new StoreError('Source recipe configuration changed',409);
      if(items.some(item=>item.deleted))for(const group of archived.groups)this.materials.redactUntilRebuilt(materialId(source.id,group));
      db.prepare('INSERT OR IGNORE INTO source_pipeline_bindings VALUES(?,?)').run(source.id,pipeline.id);
      const superseded:string[]=[];
      for(const group of archived.groups){
        const id=archiveHash([source.id,group]);
        const prior=db.prepare('SELECT generation FROM source_pipeline_work WHERE id=?').get(id) as {generation:number}|undefined;
        db.prepare(`INSERT INTO source_pipeline_work(id,source_id,pipeline_id,version,group_key,state,error,updated_at,material_ref,generation,archive_checkpoint,recipe_id,recipe_version,recipe_definition_fingerprint,recipe_config_fingerprint,recipe_component_pins)
        VALUES(?,?,?,?,?,'pending',NULL,?,NULL,0,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET state='pending',error=NULL,updated_at=excluded.updated_at,pipeline_id=excluded.pipeline_id,version=excluded.version,
          generation=source_pipeline_work.generation+1,archive_checkpoint=excluded.archive_checkpoint,recipe_id=excluded.recipe_id,recipe_version=excluded.recipe_version,
          recipe_definition_fingerprint=excluded.recipe_definition_fingerprint,recipe_config_fingerprint=excluded.recipe_config_fingerprint,recipe_component_pins=excluded.recipe_component_pins`).run(
            id,source.id,pipeline.id,pipeline.version,group,Date.now(),archived.groupCheckpoints[group],
            metadata?.id??null,metadata?.version??null,metadata?.definitionFingerprint??null,metadata?.configFingerprint??null,metadata?.componentPins??null);
        if(prior){const old=stepId(id,prior.generation);this.revoke(old);superseded.push(old);}
        this.enqueueWork(db.prepare('SELECT * FROM source_pipeline_work WHERE id=?').get(id) as WorkRow);
      }
      db.exec('COMMIT');for(const id of superseded)this.engine.abortLocal(id);
      this.archive.acknowledge(source.id,archived.checkpoint);return {receipts:archived.receipts};
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  }
  async tick(limit=10){
    const db=this.store.db,superseded:string[]=[];
    db.exec('BEGIN IMMEDIATE');
    let rows:WorkRow[]=[];
    try{
      for(const policy of this.registry.list()){
        const changed=db.prepare("SELECT * FROM source_pipeline_work WHERE pipeline_id=? AND (version!=? OR (recipe_id IS NOT NULL AND recipe_version!=?))").all(policy.id,policy.version,policy.recipe?.version??'') as WorkRow[];
        for(const row of changed){
          const old=stepId(row.id,row.generation),block=(reason:string)=>{
            db.prepare("UPDATE source_pipeline_work SET state='blocked',error=?,updated_at=? WHERE id=? AND generation=?").run(reason,Date.now(),row.id,row.generation);
            this.revoke(old);superseded.push(old);
          };
          if(row.recipe_id===null&&!policy.recipe){
            db.prepare("UPDATE source_pipeline_work SET state='pending',error=NULL,version=?,generation=generation+1,updated_at=? WHERE id=? AND generation=?").run(policy.version,Date.now(),row.id,row.generation);
          }else if(policy.recipe&&policy.reprocess==='deterministic'&&row.recipe_id===policy.recipe.id){
            const prior=this.engine.get(old),input=prior?.input as unknown as GroupInput|undefined;
            const sourceJson=(db.prepare('SELECT json FROM source_connections WHERE id=?').get(row.source_id) as {json:string}|undefined)?.json??'',
              configJson=(db.prepare('SELECT json FROM source_pipeline_config WHERE source_id=?').get(row.source_id) as {json:string}|undefined)?.json??null;
            if(!input||input.generation!==row.generation||input.checkpoint!==row.archive_checkpoint||input.reprocess!=='deterministic'){block('recipe_upgrade_unpinned');continue;}
            if(archiveHash(configJson)!==input.configFingerprint){block('recipe_config_changed');continue;}
            if(this.sourceFingerprint(sourceJson)!==input.sourceFingerprint||!sourceJson){block('source_unavailable');continue;}
            if(this.archive.groupCheckpoint(row.source_id,row.group_key)!==row.archive_checkpoint){block('archive_changed');continue;}
            let metadata:ReturnType<typeof this.recipeMetadata>;
            try{const source=JSON.parse(sourceJson) as SourceConnection;
              if(this.select(source)!==this.registry.get(policy.id))throw Error('Source binding changed');
              metadata=this.recipeMetadata(this.recipeFor(this.registry.get(policy.id)!,source)!,row.source_id,configuration.parse(configJson?JSON.parse(configJson):{}));
            }catch{block('recipe_unavailable');continue;}
            db.prepare(`UPDATE source_pipeline_work SET state='pending',error=NULL,version=?,generation=generation+1,updated_at=?,
              recipe_id=?,recipe_version=?,recipe_definition_fingerprint=?,recipe_config_fingerprint=?,recipe_component_pins=? WHERE id=? AND generation=?`).run(
                policy.version,Date.now(),metadata.id,metadata.version,metadata.definitionFingerprint,metadata.configFingerprint,metadata.componentPins,row.id,row.generation);
          }else{block('recipe_unavailable');continue;}
          this.revoke(old);superseded.push(old);
          this.enqueueWork(this.row(row.id)!);
        }
      }
      rows=db.prepare("SELECT * FROM source_pipeline_work WHERE state IN ('pending','blocked','failed') ORDER BY updated_at LIMIT ?").all(limit) as WorkRow[];
      for(const row of rows){
        const id=stepId(row.id,row.generation),step=this.engine.get(id);
        if(!step)this.enqueueWork(row);
        else if(step.state==='stale'&&this.validWork(step)&&!this.admitWork(step))this.engine.retry(id);
      }
      db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    for(const id of superseded)this.engine.abortLocal(id);
    // Drain only the selected source groups. A shared engine may also have a
    // long model request in another pool; it must not hold this tick open.
    const ids=rows.map(row=>stepId(row.id,row.generation));
    for(let pass=0;pass<ids.length+1;pass++){
      const actionable=ids.map(id=>this.engine.get(id)).filter(step=>step&&(step.state==='running'||step.state==='waiting'&&step.availableAt<=Date.now()));
      if(!actionable.length)break;
      const before=actionable.map(step=>[step!.id,step!.state,step!.attempts,step!.availableAt].join(':')).join('|');
      await this.engine.drain(ids);
      const after=ids.map(id=>this.engine.get(id)).filter(step=>step&&(step.state==='running'||step.state==='waiting'&&step.availableAt<=Date.now()))
        .map(step=>[step!.id,step!.state,step!.attempts,step!.availableAt].join(':')).join('|');
      if(before===after)break;
    }
    return rows.length;
  }
  options(sourceId:string){const row=this.store.db.prepare('SELECT json FROM source_pipeline_config WHERE source_id=?').get(sourceId);return configuration.parse(row?JSON.parse(String(row.json)):{});}
  configure(sourceId:string,input:unknown){const value=configuration.parse(input);const db=this.store.db,superseded:string[]=[];db.exec('BEGIN IMMEDIATE');try{
    const sourceRow=db.prepare('SELECT json FROM source_connections WHERE id=?').get(sourceId);
    const source=sourceRow?JSON.parse(String(sourceRow.json)) as SourceConnection:undefined;
    let selected:SourcePipeline|undefined;
    if(value.pipelineId){if(!source)throw new StoreError('Source not found',404);
      selected=this.registry.get(value.pipelineId);if(!selected||!selected.sourceKinds.includes(source.kind))throw new StoreError('Pipeline unavailable for source kind',409);
      const prior=this.select(source);if(prior&&prior.storage!==selected.storage)throw new StoreError('Changing physical storage requires a fresh source identity',409);
      this.recipeFor(selected,source);
      this.store.db.prepare('INSERT INTO source_pipeline_bindings VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET pipeline_id=excluded.pipeline_id').run(sourceId,selected.id);
    }else if(source)selected=this.select(source);
    const recipe=selected&&source?this.recipeFor(selected,source):undefined;
    const metadata=recipe?this.recipeMetadata(recipe,sourceId,value):undefined;
    const previous=db.prepare('SELECT * FROM source_pipeline_work WHERE source_id=?').all(sourceId) as WorkRow[];
    db.prepare('INSERT INTO source_pipeline_config VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET json=excluded.json').run(sourceId,JSON.stringify(value));
    db.prepare(`UPDATE source_pipeline_work SET state='pending',error=NULL,generation=generation+1,updated_at=?,pipeline_id=coalesce(?,pipeline_id),version=coalesce(?,version),
      recipe_id=?,recipe_version=?,recipe_definition_fingerprint=?,recipe_config_fingerprint=?,recipe_component_pins=? WHERE source_id=?`).run(
        Date.now(),selected?.id??null,selected?.version??null,metadata?.id??null,metadata?.version??null,metadata?.definitionFingerprint??null,metadata?.configFingerprint??null,metadata?.componentPins??null,sourceId);
    for(const prior of previous){const old=stepId(prior.id,prior.generation);this.revoke(old);superseded.push(old);this.enqueueWork(this.row(prior.id)!);}
    db.exec('COMMIT');for(const id of superseded)this.engine.abortLocal(id);return value;}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
  drainMemory(pipeline:MemoryPipeline,enabled:boolean,limit=1){
    if(!enabled)return;
    for(const row of this.store.db.prepare('SELECT * FROM material_memory_work WHERE job_id IS NULL AND ready_at<=? ORDER BY ready_at LIMIT ?').all(Date.now(),limit)){
      const material=this.materials.get(String(row.material_id));if(!material||material.revision!==row.revision)continue;
      if(this.options(material.origin.sourceId).memory===false){this.store.db.prepare('UPDATE material_memory_work SET ready_at=? WHERE material_id=?').run(Date.now()+60000,row.material_id);continue;}
      const binding=this.store.db.prepare('SELECT pipeline_id FROM source_pipeline_bindings WHERE source_id=?').get(material.origin.sourceId);if(!binding||!this.registry.get(String(binding.pipeline_id)))continue;
      const sourcePipeline=this.registry.get(String(binding.pipeline_id))!,required=this.options(material.origin.sourceId).memoryDependencies??sourcePipeline.memoryDependencies??['material'];
      if(!materialDependencyStatus(material,required).ready){this.store.db.prepare('DELETE FROM material_memory_work WHERE material_id=?').run(row.material_id);continue;}
      try{const job=pipeline.create({evidenceIds:this.materials.evidenceIds(material.ref),originKey:material.ref});this.store.db.prepare('UPDATE material_memory_work SET job_id=?,error=NULL WHERE material_id=? AND revision=?').run(job.id,row.material_id,row.revision);void pipeline.run(job.id).catch(()=>{});}
      catch{this.store.db.prepare("UPDATE material_memory_work SET error='memory_enqueue_failed',ready_at=? WHERE material_id=?").run(Date.now()+60000,row.material_id);}
    }
  }
  forget(sourceId:string){
    if(!this.store.db.prepare('SELECT 1 FROM source_pipeline_bindings WHERE source_id=?').get(sourceId))throw new StoreError('Source has no archive pipeline',409);
    const db=this.store.db,superseded:string[]=[];db.exec('BEGIN IMMEDIATE');try{
      db.prepare("UPDATE source_connections SET json=json_set(json,'$.enabled',json('false')) WHERE id=?").run(sourceId);
      for(const row of db.prepare('SELECT id FROM material_heads WHERE source_id=?').all(sourceId))this.materials.forget(String(row.id));
      for(const row of db.prepare('SELECT id,generation FROM source_pipeline_work WHERE source_id=?').all(sourceId) as {id:string;generation:number}[]){const id=stepId(row.id,row.generation);this.revoke(id);superseded.push(id);}
      db.prepare('DELETE FROM source_pipeline_work WHERE source_id=?').run(sourceId);
      db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
    for(const id of superseded)this.engine.abortLocal(id);
    this.archive.forget(sourceId);return {erased:true,sourcePaused:true};
  }
  status(){return {pipelines:this.registry.list(),work:this.store.db.prepare('SELECT state,count(*) count FROM source_pipeline_work GROUP BY state').all()};}
  async close(){await this.ready.catch(()=>{});if(this.ownsEngine)await this.engine.close();this.unregisterHandler();await this.pluginScope.close();}
}

const configuration=z.object({pipelineId:z.string().regex(/^[a-z0-9.-]+$/).optional(),index:z.boolean().optional(),memory:z.boolean().optional(),memoryDependencies:z.array(z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/).max(128)).min(1).max(16).optional(),settleSeconds:z.number().int().min(0).max(86400).default(300)}).strict();
