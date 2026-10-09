import {InstallationEpochs} from './installation-epochs.js';
import {z} from 'zod';
import {MaterialMemoryWork,type MaterialMemoryRunner,type MaterialMemoryPlanner,type MemoryWorkProposal,type MemoryWorkCandidate} from './material-memory-work.js';
import {Context,type Plugin} from '@deepseek-ai/cordis';
import type {SourceConnection,SourceItem} from '@mote/shared';
import {materialId,type CodingArchiveSnapshot,type MaterialAppendDraft,type MaterialDraft,type MaterialStore} from './materials.js';
import {SourceArchive,archiveHash} from './source-archive.js';
import {StoreError,type Store} from './store.js';
import {BackendPluginScope} from './backend-plugin-scope.js';
import {SourceRecipeExecutor,type RecipeSnapshot} from './source-recipe-executor.js';
import {recipeFingerprint} from './recipe-contract.js';
import type {InstalledRecipe} from './recipe-registry.js';
import {SourceArchiveRawReader} from './source-archive-reader.js';
import {ExecutionEngine,ExecutionFailure,type ExecutionStep} from './execution-engine.js';

type WorkRow={id:string;source_id:string;pipeline_id:string;version:string;group_key:string;state:string;generation:number;archive_checkpoint:string|null;memory_trigger:'source'|'rebuild';
  recipe_id:string|null;recipe_version:string|null;recipe_definition_fingerprint:string|null;recipe_config_fingerprint:string|null;recipe_component_pins:string|null};
type GroupInput={workId:string;sourceId:string;pipelineId:string;version:string;group:string;generation:number;checkpoint:string|null;memoryTrigger:'source'|'rebuild';
  recipeId:string|null;recipeVersion:string|null;recipeDefinitionFingerprint:string|null;recipeConfigFingerprint:string|null;recipeComponentPins:string|null;
  sourceFingerprint:string;configFingerprint:string;policyFingerprint:string;reprocess:'deterministic'|'manual'};
type PreparedGroup={installationEpoch:string|undefined;componentEpochs:string|undefined;draft:MaterialDraft|MaterialAppendDraft|undefined;pipeline:SourcePipeline;recipe:InstalledRecipe|undefined;sourceJson:string;configJson:string|null;checkpoint:string;policyFingerprint:string;
  priorRevision:string|null;codingSnapshot?:CodingArchiveSnapshot;
  options:z.infer<typeof configuration>};
const STEP_KIND='source.archive-group';
const stepId=(id:string,generation:number)=>`source.archive-group:${id}:${generation}`;

export interface SourcePipeline {
  id:string;version:string;priority?:number;featureId?:string;
  /** Explicit protocol/source kinds only, never semantic classification. */
  sourceKinds:string[];
  storage:'records'|'archive';
  index:'none'|'material';
  modelInput:'material';
  /** Default named outputs for Memory recipes without their own requirements. */
  memoryDependencies?:string[];
  /** A declarative recipe pins trusted implementations used by this pipeline. */
  recipe?:{id:string;version:string};
  /** Historical model work requires an explicit user request; only declared deterministic recipes replay automatically. */
  reprocess?:'deterministic'|'manual';
}
export class SourcePipelineRegistry {
  private entries=new Map<string,SourcePipeline>();
  readonly epochs=new InstallationEpochs();
  private declaredKinds=new Set<string>();
  register(pipeline:SourcePipeline){
    if(!/^[a-z0-9.-]+$/.test(pipeline.id)||!pipeline.version||this.entries.has(pipeline.id)||!pipeline.sourceKinds.length||pipeline.modelInput!=='material'||!['records','archive'].includes(pipeline.storage)||!['none','material'].includes(pipeline.index)||pipeline.storage==='archive'&&!pipeline.recipe)throw Error('Invalid source pipeline');
    if([...this.entries.values()].some(p=>(p.priority??0)===(pipeline.priority??0)&&p.sourceKinds.some(kind=>pipeline.sourceKinds.includes(kind))))throw Error('Ambiguous source pipeline');
    pipeline.sourceKinds.forEach(kind=>this.declaredKinds.add(kind));
    const revoke=this.epochs.install(pipeline.id);this.entries.set(pipeline.id,pipeline);return ()=>{revoke();if(this.entries.get(pipeline.id)===pipeline)this.entries.delete(pipeline.id);};
  }
  declared(kind:string){return this.declaredKinds.has(kind);}
  get(id:string){return this.entries.get(id);}
  forKind(kind:string){return [...this.entries.values()].filter(p=>p.sourceKinds.includes(kind)).sort((a,b)=>(b.priority??0)-(a.priority??0))[0];}
  list(){return [...this.entries.values()].map(policy=>({...policy}));}
}
declare module '@deepseek-ai/cordis' {interface Context {moteSourcePipelines:SourcePipelineRegistry;}}
/** Cordis owns installation; host owns receipts, durable work and atomic publication.
 * There is one work row per logical group, never one SQL row per raw event. */
export class SourcePipelineRuntime {
  readonly registry=new SourcePipelineRegistry();readonly recipes=new SourceRecipeExecutor();readonly context:Context;readonly archive:SourceArchive;private readonly pluginScope:BackendPluginScope;
  readonly engine:ExecutionEngine;private readonly ownsEngine:boolean;private readonly unregisterHandler:()=>void;
  readonly memoryWork:MaterialMemoryWork;
  readonly ready:Promise<void>;
  private productConsumer?:{observeProducts:(ref:string,bindingIds:readonly string[])=>void};
  setProductConsumer(consumer:{observeProducts:(ref:string,bindingIds:readonly string[])=>void}){this.productConsumer=consumer;}
  constructor(readonly store:Store,readonly materials:MaterialStore,plugins:Plugin[]=[],root?:Context,executor?:ExecutionEngine,memoryWork?:MaterialMemoryWork){
    this.pluginScope=new BackendPluginScope(root);this.context=this.pluginScope.context;
    this.engine=executor??new ExecutionEngine(store);this.ownsEngine=!executor;
    materials.bindIndexEngine(this.engine);
    this.archive=new SourceArchive(store);this.pluginScope.provide('moteSourcePipelines',this.registry);this.pluginScope.provide('moteSourceRecipes',this.recipes);this.pluginScope.provide('moteMaterialCatalog',materials.catalog.registry);
    store.db.exec(`CREATE TABLE IF NOT EXISTS source_pipeline_bindings(source_id TEXT PRIMARY KEY,pipeline_id TEXT NOT NULL,storage TEXT);
      CREATE TABLE IF NOT EXISTS source_pipeline_work(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,pipeline_id TEXT NOT NULL,version TEXT NOT NULL,group_key TEXT NOT NULL,state TEXT NOT NULL,error TEXT,updated_at INTEGER NOT NULL,material_ref TEXT,generation INTEGER NOT NULL DEFAULT 0,archive_checkpoint TEXT,memory_trigger TEXT NOT NULL,
        recipe_id TEXT,recipe_version TEXT,recipe_definition_fingerprint TEXT,recipe_config_fingerprint TEXT,recipe_component_pins TEXT);
      CREATE TABLE IF NOT EXISTS source_pipeline_config(source_id TEXT PRIMARY KEY,json TEXT NOT NULL);`);
    this.memoryWork=memoryWork??new MaterialMemoryWork(store,materials);
    this.unregisterHandler=this.engine.register({kind:STEP_KIND,pool:'source.archive',concurrency:()=>2,
      resourceKeys:step=>[`source.archive:${(step.input as unknown as GroupInput).workId}`],
      validate:step=>this.validWork(step),admit:step=>this.admitWork(step),
      execute:(step,signal)=>this.organizeGroup(step,signal),commit:(step,result)=>this.publishGroup(step,result as PreparedGroup),
      project:step=>this.projectWork(step),classify:()=>new ExecutionFailure('transient','organization_failed'),timeoutMs:300000});
    const pluginScope=this.pluginScope;
    this.ready=(async()=>{for(const plugin of plugins)await pluginScope.install(plugin);})();
  }
  private recipeFor(pipeline:SourcePipeline,source:SourceConnection):InstalledRecipe|undefined {
    if(!pipeline.recipe){if(pipeline.storage==='records')return undefined;throw new StoreError('Source archive pipelines require a recipe',409);}
    let recipe:InstalledRecipe;
    try{recipe=this.recipes.resolve(pipeline.recipe.id,pipeline.recipe.version);}catch{throw new StoreError('Source recipe or component unavailable',409);}
    if(recipe.definition.accepts.sourceKind!==source.kind)throw new StoreError('Source recipe kind mismatch',409);
    return recipe;
  }
  private recipeMetadata(recipe:InstalledRecipe,sourceId:string,options=this.storedOptions(sourceId)){
    return {
      id:recipe.definition.id,version:recipe.definition.version,
      definitionFingerprint:recipe.definitionFingerprint,
      configFingerprint:recipeFingerprint({recipe:recipe.configFingerprint,sourceConfig:organizationOptions(options)}),
      componentPins:JSON.stringify(recipe.componentPins),
    };
  }
  private policyFingerprint(pipeline:SourcePipeline){return archiveHash({id:pipeline.id,version:pipeline.version,storage:pipeline.storage,index:pipeline.index,
    memoryDependencies:pipeline.memoryDependencies??['material'],recipe:pipeline.recipe??null,reprocess:pipeline.reprocess??'manual'});}
  private sourceFingerprint(json:string){if(!json)return archiveHash('');const source=JSON.parse(json) as SourceConnection;
    // Availability and intake retention govern future receipts. Neither may
    // reinterpret raw input already accepted for this immutable source identity.
    return archiveHash({id:source.id,kind:source.kind,deviceId:source.deviceId,platform:source.platform});}
  private input(step:ExecutionStep){return step.input as unknown as GroupInput;}
  private row(id:string){return this.store.db.prepare('SELECT * FROM source_pipeline_work WHERE id=?').get(id) as WorkRow|undefined;}
  private enqueueWork(row:WorkRow){
    const db=this.store.db,sourceJson=String((db.prepare('SELECT json FROM source_connections WHERE id=?').get(row.source_id) as {json:string}|undefined)?.json??''),
      configJson=(db.prepare('SELECT json FROM source_pipeline_config WHERE source_id=?').get(row.source_id) as {json:string}|undefined)?.json??null;
    if(row.archive_checkpoint===null)throw new StoreError('Source work requires an immutable archive checkpoint',409);
    const pipeline=this.registry.get(row.pipeline_id);
    const input:GroupInput={workId:row.id,sourceId:row.source_id,pipelineId:row.pipeline_id,version:row.version,group:row.group_key,
      generation:row.generation,checkpoint:row.archive_checkpoint,memoryTrigger:row.memory_trigger,recipeId:row.recipe_id,recipeVersion:row.recipe_version,
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
      const input=this.input(step),row=this.row(input.workId);if(!row||row.generation!==input.generation||row.source_id!==input.sourceId||row.pipeline_id!==input.pipelineId||row.version!==input.version||row.group_key!==input.group||row.archive_checkpoint!==input.checkpoint||row.memory_trigger!==input.memoryTrigger)return false;
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
      const recipe=this.recipeFor(pipeline,source),options=this.storedOptions(input.sourceId);
      if(recipe){const metadata=this.recipeMetadata(recipe,input.sourceId,options);
        if(input.recipeId!==metadata.id||input.recipeVersion!==metadata.version||input.recipeDefinitionFingerprint!==metadata.definitionFingerprint||input.recipeConfigFingerprint!==metadata.configFingerprint||input.recipeComponentPins!==metadata.componentPins)throw Error('recipe_unavailable');
      }else throw Error('recipe_unavailable');
    }catch(error){return new ExecutionFailure('blocked',error instanceof Error&&error.message==='pipeline_unavailable'?'pipeline_unavailable':'recipe_unavailable');}
  }
  private async organizeGroup(step:ExecutionStep,signal:AbortSignal):Promise<PreparedGroup>{
    signal.throwIfAborted();if(!this.validWork(step))throw new ExecutionFailure('stale','input_changed');
    const input=this.input(step),db=this.store.db,pipeline=this.registry.get(input.pipelineId)!;
    const sourceJson=(db.prepare('SELECT json FROM source_connections WHERE id=?').get(input.sourceId) as {json:string}).json,
      configJson=(db.prepare('SELECT json FROM source_pipeline_config WHERE source_id=?').get(input.sourceId) as {json:string}|undefined)?.json??null,
      source=JSON.parse(sourceJson) as SourceConnection,options=configuration.parse(configJson?JSON.parse(configJson):{}),recipe=this.recipeFor(pipeline,source);
    const installationEpoch=this.registry.epochs.get(pipeline.id),componentEpochs=recipe?this.recipes.executionIdentity(recipe):undefined;
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
    const draft=this.recipes.organize(recipe!,source,input.group,snapshot);
    signal.throwIfAborted();
    const priorRevision=draft?this.materials.revisionForWrite(draft.id):null;
    if(draft&&'mode' in draft&&base?.record.revision!==priorRevision)throw new ExecutionFailure('stale','material_changed');
    const pinned=recipe?snapshot as RecipeSnapshot:undefined;
    const codingSnapshot=pinned&&typeof pinned.headCount==='number'&&typeof pinned.appendEpoch==='number'?
      {checkpoint:pinned.checkpoint,headCount:pinned.headCount,appendEpoch:pinned.appendEpoch}:undefined;
    return {installationEpoch,componentEpochs,draft,pipeline,recipe,sourceJson,configJson,checkpoint:snapshot.checkpoint,policyFingerprint:this.policyFingerprint(pipeline),options,
      priorRevision,codingSnapshot};
  }
  private publishGroup(step:ExecutionStep,result:PreparedGroup){
    const input=this.input(step),db=this.store.db;
    if(!this.validWork(step))throw new ExecutionFailure('stale','input_changed');
    const pipeline=this.registry.get(input.pipelineId);
    if(!this.registry.epochs.matches(input.pipelineId,result.installationEpoch)||result.recipe&&this.recipes.executionIdentity(result.recipe)!==result.componentEpochs)throw new ExecutionFailure('blocked','pipeline_instance_unavailable');
    if(pipeline!==result.pipeline||!pipeline||pipeline.version!==input.version||this.policyFingerprint(pipeline)!==result.policyFingerprint)throw new ExecutionFailure('blocked','pipeline_unavailable');
    const sourceJson=(db.prepare('SELECT json FROM source_connections WHERE id=?').get(input.sourceId) as {json:string}|undefined)?.json,
      configJson=(db.prepare('SELECT json FROM source_pipeline_config WHERE source_id=?').get(input.sourceId) as {json:string}|undefined)?.json??null;
    if(!sourceJson||this.sourceFingerprint(sourceJson)!==this.sourceFingerprint(result.sourceJson)||JSON.stringify(organizationOptions(configuration.parse(configJson?JSON.parse(configJson):{})))!==JSON.stringify(organizationOptions(configuration.parse(result.configJson?JSON.parse(result.configJson):{})))||this.archive.groupCheckpoint(input.sourceId,input.group)!==result.checkpoint)throw new ExecutionFailure('stale','input_changed');
    const source=JSON.parse(sourceJson!) as SourceConnection;
    try{if(this.select(source)!==pipeline||result.recipe&&this.recipeFor(pipeline,source)!==result.recipe)throw Error('Component changed');}
    catch{throw new ExecutionFailure('blocked','recipe_unavailable');}
    if(result.recipe){const metadata=this.recipeMetadata(result.recipe,input.sourceId,result.options);
      if(metadata.id!==input.recipeId||metadata.version!==input.recipeVersion||metadata.definitionFingerprint!==input.recipeDefinitionFingerprint||metadata.configFingerprint!==input.recipeConfigFingerprint||metadata.componentPins!==input.recipeComponentPins)throw new ExecutionFailure('blocked','recipe_unavailable');}
    let ref:string|null=null;
    if(result.draft){if(this.materials.revisionForWrite(result.draft.id)!==result.priorRevision)throw new ExecutionFailure('stale','material_changed');
      const published=this.materials.publish(result.draft,{expectedRevision:result.priorRevision,codingSnapshot:result.codingSnapshot});ref=published.ref;
      this.materials.setSearchable(published.id,result.options.index??pipeline.index==='material');
      const required=result.options.memoryDependencies??pipeline.memoryDependencies??['material'];
      const observe=published.changed?this.memoryWork.observe.bind(this.memoryWork):this.memoryWork.observeUnchanged.bind(this.memoryWork);
      observe(published.id,required,{inputKey:result.checkpoint,change:input.memoryTrigger,
        automatic:true},result.options.settleSeconds*1000);
      const consumers=this.options(input.sourceId).consumers;if(consumers.length)this.productConsumer?.observeProducts(published.ref,consumers);}
    const changed=db.prepare("UPDATE source_pipeline_work SET state='complete',error=NULL,material_ref=? WHERE id=? AND generation=?").run(ref,input.workId,input.generation).changes;
    if(changed!==1)throw new ExecutionFailure('stale','input_changed');
  }
  private projectWork(step:ExecutionStep){
    const input=this.input(step),state=step.state==='waiting'||step.state==='running'?'pending':step.state==='succeeded'?'complete':step.state==='stale'||step.state==='cancelled'?'blocked':step.state;
    this.store.db.prepare("UPDATE source_pipeline_work SET state=?,error=?,updated_at=? WHERE id=? AND generation=? AND state!='complete'").run(state,step.error??null,Date.now(),input.workId,input.generation);
  }
  select(source:SourceConnection){
    const binding=this.store.db.prepare('SELECT pipeline_id,storage FROM source_pipeline_bindings WHERE source_id=?').get(source.id);
    const pipeline=binding?this.registry.get(String(binding.pipeline_id)):this.registry.forKind(source.kind);
    if(binding&&!pipeline)throw new StoreError('Source pipeline unavailable',409);
    if(pipeline&&!pipeline.sourceKinds.includes(source.kind))throw new StoreError('Source pipeline kind mismatch',409);
    if(pipeline){this.recipeFor(pipeline,source);if(binding&&!binding.storage)throw new StoreError('Source binding requires storage semantics',409);}
    // Ordinary sources retain the record-store path. A declared plugin kind
    // may never silently fall through after uninstall.
    if(!pipeline&&this.registry.declared(source.kind))throw new StoreError('Source pipeline unavailable',409);
    return pipeline;
  }
  receive(source:SourceConnection,items:SourceItem[],validate:()=>void){
    const pipeline=this.select(source);if(!pipeline||pipeline.storage==='records')return undefined;
    const recipe=this.recipeFor(pipeline,source),metadata=recipe?this.recipeMetadata(recipe,source.id):undefined;
    const groups=items.map(item=>this.recipes.group(recipe!,item));
    const db=this.store.db;db.exec('BEGIN IMMEDIATE');
    try{
      validate();if(this.select(source)!==pipeline)throw new StoreError('Source pipeline changed',409);
      if(recipe&&(this.recipeFor(pipeline,source)!==recipe||this.recipeMetadata(recipe,source.id).configFingerprint!==metadata!.configFingerprint))throw new StoreError('Source recipe configuration changed',409);
      const archived=recipe?this.recipes.receive(recipe,this.archive,source,items,groups):this.archive.receive(source.id,items,groups);
      if(recipe&&(this.recipeFor(pipeline,source)!==recipe||this.recipeMetadata(recipe,source.id).configFingerprint!==metadata!.configFingerprint))throw new StoreError('Source recipe configuration changed',409);
      for(const group of archived.changedGroups)this.memoryWork.inputs.receive({sourceId:source.id,inputKey:archived.groupCheckpoints[group]});
      // A repeated tombstone has already revoked its old projection. Hiding
      // its unchanged current Material again would require a rebuild that an
      // immutable replay must not enqueue. New deletions still revoke every
      // changed group (including the previous group when an identity moves).
      if(items.some(item=>item.deleted))for(const group of archived.changedGroups)this.materials.redactUntilRebuilt(materialId(source.id,group));
      db.prepare('INSERT OR IGNORE INTO source_pipeline_bindings(source_id,pipeline_id,storage) VALUES(?,?,?)').run(source.id,pipeline.id,pipeline.storage);
      const superseded:string[]=[];
      for(const group of archived.groups){
        const id=archiveHash([source.id,group]);
        const prior=this.row(id),step=prior?this.engine.get(stepId(id,prior.generation)):undefined;
        // An immutable receipt replay does not replace a valid queued/running
        // worker, reset its failure, or rebuild an already published Material.
        // Missing work and changed source/recipe/config pins still use the
        // normal recovery/reprocessing path below.
        if(prior?.archive_checkpoint===archived.groupCheckpoints[group]&&step&&this.validWork(step)&&!this.admitWork(step))continue;
        db.prepare(`INSERT INTO source_pipeline_work(id,source_id,pipeline_id,version,group_key,state,error,updated_at,material_ref,generation,archive_checkpoint,recipe_id,recipe_version,recipe_definition_fingerprint,recipe_config_fingerprint,recipe_component_pins,memory_trigger)
        VALUES(?,?,?,?,?,'pending',NULL,?,NULL,0,?,?,?,?,?,?,'source')
        ON CONFLICT(id) DO UPDATE SET state='pending',error=NULL,updated_at=excluded.updated_at,pipeline_id=excluded.pipeline_id,version=excluded.version,memory_trigger='source',
          generation=source_pipeline_work.generation+1,archive_checkpoint=excluded.archive_checkpoint,recipe_id=excluded.recipe_id,recipe_version=excluded.recipe_version,
          recipe_definition_fingerprint=excluded.recipe_definition_fingerprint,recipe_config_fingerprint=excluded.recipe_config_fingerprint,recipe_component_pins=excluded.recipe_component_pins`).run(
            id,source.id,pipeline.id,pipeline.version,group,Date.now(),archived.groupCheckpoints[group],
            metadata?.id??null,metadata?.version??null,metadata?.definitionFingerprint??null,metadata?.configFingerprint??null,metadata?.componentPins??null);
        if(prior){const old=stepId(id,prior.generation);this.revoke(old);superseded.push(old);}
        this.enqueueWork(db.prepare('SELECT * FROM source_pipeline_work WHERE id=?').get(id) as WorkRow);
      }
      db.exec('COMMIT');for(const id of superseded)this.engine.abortLocal(id);
      return {receipts:archived.receipts};
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
          if(policy.recipe&&policy.reprocess==='deterministic'&&row.recipe_id===policy.recipe.id){
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
            db.prepare(`UPDATE source_pipeline_work SET memory_trigger=CASE WHEN state='complete' THEN 'rebuild' ELSE memory_trigger END,state='pending',error=NULL,version=?,generation=generation+1,updated_at=?,
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
    await this.materials.index?.tick();
    return rows.length;
  }
  // Preserve organization pins without letting Memory recipe selection
  // govern receipt authorization or current execution.
  private storedOptions(sourceId:string){const row=this.store.db.prepare('SELECT json FROM source_pipeline_config WHERE source_id=?').get(sourceId);return configuration.parse(row?JSON.parse(String(row.json)):{});}
  options(sourceId:string){return this.storedOptions(sourceId);}
  configure(sourceId:string,input:unknown){const value=configuration.parse(input),priorOptions=this.storedOptions(sourceId);const db=this.store.db,superseded:string[]=[];db.exec('BEGIN IMMEDIATE');try{
    const sourceRow=db.prepare('SELECT json FROM source_connections WHERE id=?').get(sourceId);
    const source=sourceRow?JSON.parse(String(sourceRow.json)) as SourceConnection:undefined;
    let selected:SourcePipeline|undefined;
    if(value.pipelineId){if(!source)throw new StoreError('Source not found',404);
      selected=this.registry.get(value.pipelineId);if(!selected||!selected.sourceKinds.includes(source.kind))throw new StoreError('Pipeline unavailable for source kind',409);
      const binding=db.prepare('SELECT pipeline_id,storage FROM source_pipeline_bindings WHERE source_id=?').get(sourceId);
      const storage=binding?.storage??(binding?this.registry.get(String(binding.pipeline_id))?.storage:this.registry.forKind(source.kind)?.storage);
      if(binding&&!storage)throw new StoreError('Previous storage contract is unavailable; reconnect this source',409);
      if(storage&&storage!==selected.storage)throw new StoreError('Changing physical storage requires a fresh source identity',409);
      this.recipeFor(selected,source);
      this.store.db.prepare('INSERT INTO source_pipeline_bindings(source_id,pipeline_id,storage) VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET pipeline_id=excluded.pipeline_id,storage=excluded.storage').run(sourceId,selected.id,selected.storage);
    }else if(source)selected=this.select(source);
    const recipe=selected&&source?this.recipeFor(selected,source):undefined;
    const metadata=recipe?this.recipeMetadata(recipe,sourceId,value):undefined;
    const previous=db.prepare('SELECT * FROM source_pipeline_work WHERE source_id=?').all(sourceId) as WorkRow[];
    db.prepare('INSERT INTO source_pipeline_config VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET json=excluded.json').run(sourceId,JSON.stringify(value));
    // Consumer authorization alone does not re-organize historical source groups.
    if(JSON.stringify(priorOptions.consumers)!==JSON.stringify(value.consumers)&&JSON.stringify(organizationOptions(priorOptions))===JSON.stringify(organizationOptions(value))){db.exec('COMMIT');return this.options(sourceId);}
    db.prepare(`UPDATE source_pipeline_work SET memory_trigger=CASE WHEN state='complete' THEN 'rebuild' ELSE memory_trigger END,state='pending',error=NULL,generation=generation+1,updated_at=?,pipeline_id=coalesce(?,pipeline_id),version=coalesce(?,version),
      recipe_id=?,recipe_version=?,recipe_definition_fingerprint=?,recipe_config_fingerprint=?,recipe_component_pins=? WHERE source_id=?`).run(
        Date.now(),selected?.id??null,selected?.version??null,metadata?.id??null,metadata?.version??null,metadata?.definitionFingerprint??null,metadata?.configFingerprint??null,metadata?.componentPins??null,sourceId);
    for(const prior of previous){const old=stepId(prior.id,prior.generation);this.revoke(old);superseded.push(old);this.enqueueWork(this.row(prior.id)!);}
    db.exec('COMMIT');for(const id of superseded)this.engine.abortLocal(id);return this.options(sourceId);}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}}
  memoryAllowed(sourceId:string):boolean {
    try{const binding=this.store.db.prepare('SELECT pipeline_id,storage FROM source_pipeline_bindings WHERE source_id=?').get(sourceId);
      if(!binding||binding.storage!=='archive')return true;
      return Boolean(this.registry.get(String(binding.pipeline_id)));
    }catch{return false;}
  }
  private memoryPlanner?:MaterialMemoryPlanner;
  private memoryPackageCreated?:((proposal:MemoryWorkProposal,job:{id:string})=>void);
  private memoryPlannerReconcile?:()=>void;
  private memoryPackageSkipped?:((proposal:MemoryWorkProposal)=>void);
  private memoryCandidateAllowed?:((candidate:MemoryWorkCandidate)=>boolean);
  setMemoryPlanner(planner:MaterialMemoryPlanner|undefined,onCreated?:(proposal:MemoryWorkProposal,job:{id:string})=>void,onSkipped?:(proposal:MemoryWorkProposal)=>void,onReconcile?:()=>void,allowCandidate?:(candidate:MemoryWorkCandidate)=>boolean){this.memoryPlanner=planner;this.memoryPackageCreated=onCreated;this.memoryPackageSkipped=onSkipped;this.memoryPlannerReconcile=onReconcile;this.memoryCandidateAllowed=allowCandidate;}
  drainMemory(pipeline:MaterialMemoryRunner,enabled:boolean,limit=1){
    this.memoryPlannerReconcile?.();
    if(this.memoryPlanner&&(!enabled||!this.store.db.prepare('SELECT 1 FROM material_memory_requests WHERE auto_authorized=1 AND ready_at<=? LIMIT 1').get(Date.now())))return this.memoryWork.drain(pipeline,false,limit);
    if(this.memoryPlanner)return this.memoryWork.drainPlanned(pipeline,enabled,this.memoryPlanner,64,materialId=>{const material=this.materials.get(materialId);return Boolean(material&&this.memoryAllowed(material.origin.sourceId));},this.memoryPackageCreated,this.memoryPackageSkipped,this.memoryCandidateAllowed);

    return this.memoryWork.drain(pipeline,enabled,limit,materialId=>{
      const material=this.materials.get(materialId);if(!material)return true;
      return this.memoryAllowed(material.origin.sourceId);
    });
  }
  forget(sourceId:string){
    if(!this.store.db.prepare('SELECT 1 FROM source_pipeline_bindings WHERE source_id=?').get(sourceId))throw new StoreError('Source has no archive pipeline',409);
    const db=this.store.db,superseded:string[]=[];db.exec('BEGIN IMMEDIATE');try{
      db.prepare("UPDATE source_connections SET json=json_set(json,'$.enabled',json('false')) WHERE id=?").run(sourceId);
      // Explicit source forgetting erases entire derived owner rules, including
      // mixed-source conclusions. Ordinary retention uses partial cleanup instead.
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_deletion_dependencies'").get())db.prepare(`DELETE FROM memory_deletions WHERE id IN (
        SELECT d.deletion_id FROM memory_deletion_dependencies d
        LEFT JOIN captures c ON c.id=d.evidence_id
        LEFT JOIN material_evidence e ON e.id=d.evidence_id
        LEFT JOIN material_heads m ON m.id=e.material_id
        WHERE json_extract(c.json,'$.provenance.sourceId')=? OR m.source_id=?)
        OR EXISTS (SELECT 1 FROM json_each(memory_deletions.json,'$.derivationSourceIds') s WHERE s.value=?)`).run(sourceId,sourceId,sourceId);
      for(const row of db.prepare('SELECT id FROM material_heads WHERE source_id=?').all(sourceId)){this.memoryWork.withdraw(String(row.id));this.materials.forget(String(row.id));}
      this.memoryWork.inputs.forgetSource(sourceId);
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

const configuration=z.object({pipelineId:z.string().regex(/^[a-z0-9.-]+$/).optional(),index:z.boolean().optional(),memoryDependencies:z.array(z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/).max(128)).min(1).max(16).optional(),consumers:z.array(z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/)).max(32).refine(values=>new Set(values).size===values.length).default([]),settleSeconds:z.number().int().min(0).max(86400).default(300)}).strict();

function organizationOptions(options:z.infer<typeof configuration>){const {consumers:_,...organization}=options;return organization;}
