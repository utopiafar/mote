import {z} from 'zod';
import {
  freezeRecipe,parseRecipeDefinition,recipeFingerprint,recipeIdentifierSchema,
  type RecipeComponentRef,type RecipeDefinition,
} from './recipe-contract.js';

export const recipeComponentKinds=[
  'raw-writer','raw-reader','raw-retention','trigger','group','window','join',
  'aggregation','step','publish','index','exposure',
] as const;
export type RecipeComponentKind=typeof recipeComponentKinds[number];

/** Installed by trusted server code. A recipe contains only references to these components. */
export interface RecipeComponentManifest {
  id:string;
  version:string;
  kind:RecipeComponentKind;
  configSchema?:z.ZodTypeAny;
}

export interface RecipeComponentPin {
  path:string;
  id:string;
  version:string;
  kind:RecipeComponentKind;
}

export interface InstalledRecipe {
  readonly definition:Readonly<RecipeDefinition>;
  readonly stepOrder:readonly string[];
  readonly definitionFingerprint:string;
  /** Hash of the exact recipe and installed component versions used for work receipts. */
  readonly configFingerprint:string;
  readonly componentPins:readonly Readonly<RecipeComponentPin>[];
}

const componentVersion=/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

function bindings(recipe:RecipeDefinition):{path:string;kind:RecipeComponentKind;ref:RecipeComponentRef}[]{
  const result:{path:string;kind:RecipeComponentKind;ref:RecipeComponentRef}[]=[
    {path:'raw.writer',kind:'raw-writer',ref:recipe.raw.writer},
    {path:'raw.reader',kind:'raw-reader',ref:recipe.raw.reader},
    {path:'raw.retention',kind:'raw-retention',ref:recipe.raw.retention},
    {path:'trigger.policy',kind:'trigger',ref:recipe.trigger.policy},
    {path:'group.policy',kind:'group',ref:recipe.group.policy},
  ];
  if(recipe.window)result.push({path:'window.policy',kind:'window',ref:recipe.window.policy});
  if(recipe.join)result.push({path:'join.policy',kind:'join',ref:recipe.join.policy});
  if(recipe.aggregation)result.push({path:'aggregation.policy',kind:'aggregation',ref:recipe.aggregation.policy});
  for(const step of recipe.steps)result.push({path:`steps.${step.id}`,kind:'step',ref:step.use});
  result.push(
    {path:'publish.use',kind:'publish',ref:recipe.publish.use},
    {path:'index.use',kind:'index',ref:recipe.index.use},
    {path:'exposure.use',kind:'exposure',ref:recipe.exposure.use},
  );
  return result;
}

/** Deployment scoped. Missing or upgraded components make existing recipes unavailable. */
export class RecipeRegistry {
  private readonly components=new Map<string,RecipeComponentManifest>();
  private readonly recipes=new Map<string,InstalledRecipe>();
  private readonly identities=new Map<string,{definitionFingerprint:string;configFingerprint:string}>();

  installComponent(component:RecipeComponentManifest):()=>void {
    recipeIdentifierSchema.parse(component.id);
    if(!componentVersion.test(component.version)||!recipeComponentKinds.includes(component.kind))throw Error('Invalid recipe component manifest');
    if(component.configSchema!==undefined&&typeof component.configSchema.safeParse!=='function')throw Error('Invalid recipe component config schema');
    if(this.components.has(component.id))throw Error(`Recipe component ${component.id} is already installed`);
    const installed={...component};
    this.components.set(component.id,installed);
    return ()=>{if(this.components.get(component.id)===installed)this.components.delete(component.id);};
  }

  uninstallComponent(id:string):void {
    if(!this.components.delete(id))throw Error(`Unknown recipe component: ${id}`);
  }

  installRecipe(input:unknown):InstalledRecipe {
    const parsed=parseRecipeDefinition(input);
    const pins=bindings(parsed.recipe).map(({path,kind,ref}):RecipeComponentPin=>{
      const component=this.components.get(ref.id);
      if(!component)throw Error(`Unknown recipe component ${ref.id} at ${path}`);
      if(component.kind!==kind)throw Error(`Recipe component ${ref.id} cannot serve ${path}`);
      if(component.configSchema){
        if(!component.configSchema.safeParse(ref.config??{}).success)throw Error(`Invalid recipe component config at ${path}`);
      }else if(ref.config&&Object.keys(ref.config).length)throw Error(`Recipe component ${ref.id} does not accept config`);
      return {path,id:component.id,version:component.version,kind};
    });
    const configFingerprint=recipeFingerprint({recipe:parsed.recipe,components:pins});
    const key=`${parsed.recipe.id}@${parsed.recipe.version}`;
    const identity=this.identities.get(key);
    if(identity&&(identity.definitionFingerprint!==parsed.definitionFingerprint||identity.configFingerprint!==configFingerprint))throw Error(`Recipe version ${key} has a different immutable definition or component version`);
    const existing=this.recipes.get(key);
    if(existing)return existing;
    const installed=freezeRecipe({
      definition:parsed.recipe,
      stepOrder:[...parsed.stepOrder],
      definitionFingerprint:parsed.definitionFingerprint,
      configFingerprint,
      componentPins:pins,
    }) as InstalledRecipe;
    this.identities.set(key,{definitionFingerprint:parsed.definitionFingerprint,configFingerprint});
    this.recipes.set(key,installed);
    return installed;
  }

  uninstallRecipe(id:string,version:string):void {
    const key=`${id}@${version}`;
    if(!this.recipes.delete(key))throw Error(`Recipe ${key} is not installed`);
  }

  /** Resolve immediately before work. A missing component must never fall through. */
  resolveRecipe(id:string,version:string):InstalledRecipe {
    const key=`${id}@${version}`,recipe=this.recipes.get(key);
    if(!recipe)throw Error(`Recipe ${key} is not installed`);
    for(const pin of recipe.componentPins){
      const component=this.components.get(pin.id);
      if(!component||component.version!==pin.version||component.kind!==pin.kind)throw Error(`Recipe ${key} requires unavailable component ${pin.id}@${pin.version}`);
    }
    return recipe;
  }

  listRecipes():readonly InstalledRecipe[]{return [...this.recipes.values()];}
}
