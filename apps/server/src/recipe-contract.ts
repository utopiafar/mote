import {createHash} from 'node:crypto';
import {sourceKindSchema} from '@mote/shared';
import {z} from 'zod';

/** Recipes are data. Only installed, trusted components can implement these IDs. */
export const recipeIdentifierSchema=z.string().min(3).max(128).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);
const localId=z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*$/);
const version=z.string().min(1).max(64).regex(/^[0-9A-Za-z][0-9A-Za-z._+-]*$/);
const routeId=z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/);

/** A component may additionally validate its own parameters at install time. */
export const recipeComponentRefSchema=z.object({
  id:recipeIdentifierSchema,
  config:z.record(z.unknown()).optional(),
}).strict();

const policy=z.object({policy:recipeComponentRefSchema}).strict();
const use=z.object({use:recipeComponentRefSchema}).strict();
export const recipeDefinitionSchema=z.object({
  schemaVersion:z.literal(1),
  id:recipeIdentifierSchema,
  version,
  accepts:z.object({sourceKind:sourceKindSchema}).strict(),
  raw:z.object({writer:recipeComponentRefSchema,reader:recipeComponentRefSchema,retention:recipeComponentRefSchema}).strict(),
  trigger:policy,
  group:policy,
  window:policy.optional(),
  join:policy.optional(),
  aggregation:policy.optional(),
  steps:z.array(z.object({id:localId,use:recipeComponentRefSchema,dependsOn:z.array(localId).max(64),}).strict()).min(1).max(64),
  publish:use,
  index:use,
  exposure:z.object({
    use:recipeComponentRefSchema,
    /** Declared upper bounds. The installed policy still decides per source and operation. */
    routes:z.array(z.object({audience:routeId,operation:routeId,phase:routeId,readProjection:routeId}).strict()).max(64),
  }).strict(),
}).strict();

export type RecipeDefinition=z.infer<typeof recipeDefinitionSchema>;
export type RecipeComponentRef=z.infer<typeof recipeComponentRefSchema>;

const safeToken=/^[A-Za-z0-9_.:/@+-]+$/;
const safeKey=/^[A-Za-z][A-Za-z0-9_-]*$/;

/** Reject executable values, script syntax, accessors and unbounded JSON before Zod reads it. */
function assertDeclarative(value:unknown){
  let nodes=0;
  const visit=(item:unknown,depth:number):void=>{
    if(++nodes>4096||depth>8)throw Error('Recipe data exceeds limits');
    if(item===null||typeof item==='boolean')return;
    if(typeof item==='number'){if(Number.isFinite(item))return;throw Error('Recipe numbers must be finite');}
    if(typeof item==='string'){
      if(item.length<=256&&safeToken.test(item))return;
      throw Error('Recipe strings must be bounded identifiers, not executable text');
    }
    if(typeof item!=='object')throw Error('Recipe must contain only declarative JSON');
    const prototype=Object.getPrototypeOf(item);
    if(!Array.isArray(item)&&prototype!==Object.prototype&&prototype!==null)throw Error('Recipe must contain only plain JSON objects');
    const properties=Object.getOwnPropertyDescriptors(item);
    if(Reflect.ownKeys(properties).length>256)throw Error('Recipe object exceeds limits');
    for(const key of Reflect.ownKeys(properties)){
      const validKey=typeof key==='string'&&(Array.isArray(item)?key==='length'||/^(0|[1-9][0-9]*)$/.test(key):safeKey.test(key));
      if(!validKey||key==='__proto__'||key==='constructor'||key==='prototype')throw Error('Recipe contains an invalid key');
      const descriptor=properties[key]!;
      if(!('value' in descriptor))throw Error('Recipe accessors are not allowed');
      visit(descriptor.value,depth+1);
    }
  };
  visit(value,0);
  if(JSON.stringify(value).length>65536)throw Error('Recipe data exceeds limits');
}

/** Keys are sorted so equivalent JSON yields the same identity across restarts. */
export function canonicalRecipeJson(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonicalRecipeJson).join(',')}]`;
  if(value!==null&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalRecipeJson((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function recipeFingerprint(value:unknown):string {
  return createHash('sha256').update(canonicalRecipeJson(value)).digest('hex');
}

export function recipeStepOrder(recipe:RecipeDefinition):readonly string[] {
  const steps=new Map<string,RecipeDefinition['steps'][number]>();
  for(const step of recipe.steps){
    if(steps.has(step.id))throw Error(`Duplicate recipe step: ${step.id}`);
    steps.set(step.id,step);
  }
  const visiting=new Set<string>(),visited=new Set<string>(),order:string[]=[];
  const visit=(id:string):void=>{
    if(visiting.has(id))throw Error(`Recipe step cycle at ${id}`);
    if(visited.has(id))return;
    const step=steps.get(id);
    if(!step)throw Error(`Unknown recipe step dependency: ${id}`);
    visiting.add(id);
    const dependencies=new Set<string>();
    for(const dependency of step.dependsOn){
      if(dependencies.has(dependency))throw Error(`Duplicate dependency ${dependency} in step ${id}`);
      dependencies.add(dependency);
      visit(dependency);
    }
    visiting.delete(id);visited.add(id);order.push(id);
  };
  for(const step of recipe.steps)visit(step.id);
  return order;
}

export function parseRecipeDefinition(input:unknown):{recipe:RecipeDefinition;stepOrder:readonly string[];definitionFingerprint:string}{
  assertDeclarative(input);
  const recipe=recipeDefinitionSchema.parse(input);
  const stepOrder=recipeStepOrder(recipe);
  const routes=new Set<string>();
  for(const route of recipe.exposure.routes){
    const key=canonicalRecipeJson(route);
    if(routes.has(key))throw Error('Duplicate recipe exposure route');
    routes.add(key);
  }
  return {recipe,stepOrder,definitionFingerprint:recipeFingerprint(recipe)};
}

export function freezeRecipe<T>(value:T):T {
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freezeRecipe(child);
    Object.freeze(value);
  }
  return value;
}
