import {sourceConnectionSchema,sourceIdSchema,sourceKindSchema,type SourceConnection} from '@mote/shared';
import type {Store} from './store.js';
import {CAPTURE_RAW_READER_VERSION} from './capture-raw-reader.js';
import {RecipeRegistry,type InstalledRecipe,type RecipeComponentKind,type RecipeComponentPin} from './recipe-registry.js';
import {recipeFingerprint,type RecipeDefinition} from './recipe-contract.js';
import type {RecipeExposureRoute} from './evidence-exposure.js';

export const SOURCE_ITEM_RECIPE_VERSION='1';
const components=[
  {id:'mote.record-ingest',version:'1',kind:'raw-writer'},
  {id:'mote.capture-raw-reader',version:CAPTURE_RAW_READER_VERSION,kind:'raw-reader'},
  {id:'mote.record-retention',version:'1',kind:'raw-retention'},
  {id:'mote.source-head-change',version:'1',kind:'trigger'},
  {id:'mote.source-external-group',version:'1',kind:'group'},
  {id:'mote.material-publisher',version:'1',kind:'publish'},
  {id:'mote.material-index',version:'1',kind:'index'},
  {id:'mote.source-item-exposure',version:'1',kind:'exposure'},
] as const satisfies readonly {id:string;version:string;kind:RecipeComponentKind}[];
export const SOURCE_ITEM_BUILD_COMPONENT='mote.source-item-build';

const ref=(id:string)=>({id});
function definition(sourceKind:SourceConnection['kind']):RecipeDefinition {
  return {
    schemaVersion:1,id:`mote.source-item.${sourceKind}`,version:SOURCE_ITEM_RECIPE_VERSION,accepts:{sourceKind},
    raw:{writer:ref('mote.record-ingest'),reader:ref('mote.capture-raw-reader'),retention:ref('mote.record-retention')},
    trigger:{policy:ref('mote.source-head-change')},group:{policy:ref('mote.source-external-group')},
    steps:[{id:'assemble',use:ref(SOURCE_ITEM_BUILD_COMPONENT),dependsOn:[]}],
    publish:{use:ref('mote.material-publisher')},index:{use:ref('mote.material-index')},
    exposure:{use:ref('mote.source-item-exposure'),routes:[
      ...(['pending','partial','ready'] as const).flatMap(phase=>
        (['capture','image','material','segment'] as const).map(readProjection=>({audience:'query',operation:'ask',phase,readProjection}))),
      {audience:'memory',operation:'derive',phase:'ready',readProjection:'material'},
      {audience:'memory',operation:'derive',phase:'partial',readProjection:'material'},
    ]},
  };
}

export type SourceItemRecipePin={
  recipeId:string;version:string;sourceKind:SourceConnection['kind'];
  definitionFingerprint:string;configFingerprint:string;componentPins:readonly Readonly<RecipeComponentPin>[];
};

/** Version gate for the existing SourceStore + MaterialOrganizerRuntime path.
 * Executable components remain trusted host code; this catalog records their
 * identities and makes missing/upgraded bindings fail closed at each job phase. */
export class SourceItemRecipeCatalog {
  readonly registry=new RecipeRegistry();
  private readonly installedKinds=new Set<SourceConnection['kind']>();
  constructor(private readonly store:Store,organizerVersion:string){
    for(const component of components)this.registry.installComponent(component);
    this.registry.installComponent({id:SOURCE_ITEM_BUILD_COMPONENT,version:organizerVersion,kind:'step'});
  }
  private resolveKind(sourceKind:SourceConnection['kind']):InstalledRecipe {
    if(!this.installedKinds.has(sourceKind)){
      this.registry.installRecipe(definition(sourceKind));
      this.installedKinds.add(sourceKind);
    }
    return this.registry.resolveRecipe(`mote.source-item.${sourceKind}`,SOURCE_ITEM_RECIPE_VERSION);
  }
  resolveForSourceId(sourceId:string):SourceItemRecipePin {
    sourceIdSchema.parse(sourceId);
    const row=this.store.db.prepare('SELECT json FROM source_connections WHERE id=?').get(sourceId) as {json:string}|undefined;
    if(!row)throw Error('Source item recipe source is unavailable');
    const value=JSON.parse(row.json) as Record<string,unknown>;
    if(value.id!==sourceId)throw Error('Source item recipe source identity changed');
    // Pause and retention changes govern future intake. Already received item
    // revisions keep the same interpretation, so they must not stale jobs.
    const source=sourceConnectionSchema.pick({id:true,kind:true}).parse({id:value.id,kind:value.kind});
    const sourceKind=sourceKindSchema.parse(source.kind),installed=this.resolveKind(sourceKind);
    const configFingerprint=recipeFingerprint({installed:installed.configFingerprint,sourceIdentity:source});
    return Object.freeze({recipeId:installed.definition.id,version:installed.definition.version,sourceKind,
      definitionFingerprint:installed.definitionFingerprint,configFingerprint,componentPins:installed.componentPins});
  }
  /** Exposure is an upper bound; partial Memory still requires a current named-artifact grant. */
  routesForSourceId(sourceId:string):readonly RecipeExposureRoute[] {
    const pin=this.resolveForSourceId(sourceId);
    return this.registry.resolveRecipe(pin.recipeId,pin.version).definition.exposure.routes;
  }
}
