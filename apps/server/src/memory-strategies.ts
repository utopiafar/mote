import {memoryExtractionStrategySchema,memoryReviewStrategySchema,memoryRecipeSchema,memoryStrategyPin,type MemoryExtractionStrategy,type MemoryReviewStrategy,type MemoryStrategyRef,type MemoryRecipeBinding} from './memory-strategy-contract.js';
import {freezeRecipe,recipeFingerprint} from './recipe-contract.js';
import {memoryIntegrationStrategySchema,memoryIntegrationRecipeSchema,type MemoryIntegrationStrategy,type MemoryIntegrationBinding} from './memory-strategy-contract.js';
import {defaultMemoryIntegrationStrategy,defaultMemoryIntegrationRecipe,defaultMemoryIntegrationReview} from './memory-integration-policy.js';
import {RANGE_SELECTION_PERSONAL_RECIPE,RANGE_SELECTION_CODING_RECIPE,RANGE_SELECTION_DAILY_RECIPE,rangeSelectionPersonalExtractionStrategy,rangeSelectionPersonalReviewStrategy,rangeSelectionContextExtractionStrategy,rangeSelectionCodingReviewStrategy,rangeSelectionDailyExtractionStrategy,rangeSelectionDailyReviewStrategy} from './memory-range-selection-policy.js';

const key=(ref:MemoryStrategyRef)=>`${ref.id}@${ref.version}`;
export type ResolvedMemoryRecipe={binding:MemoryRecipeBinding;extract:MemoryExtractionStrategy;review:MemoryReviewStrategy};

/** One plugin's immutable strategy data. The plugin activation registers it and
 * removes exactly these definitions when the contribution is withdrawn. */
export interface MemoryStrategyContribution {
  readonly id:string;
  readonly extractions?:readonly unknown[];
  readonly reviews?:readonly unknown[];
  readonly recipes?:readonly unknown[];
  readonly integrations?:readonly unknown[];
  readonly integrationRecipes?:readonly unknown[];
}

/** The built-in product policies are one contribution, not a registry side
 * effect. An activation may install additional contributions before use. */
export const defaultMemoryStrategyContribution:MemoryStrategyContribution=Object.freeze({
  id:'mote.builtin-memory-strategies',
  extractions:Object.freeze([rangeSelectionPersonalExtractionStrategy,rangeSelectionContextExtractionStrategy,rangeSelectionDailyExtractionStrategy]),
  reviews:Object.freeze([rangeSelectionPersonalReviewStrategy,rangeSelectionCodingReviewStrategy,rangeSelectionDailyReviewStrategy,defaultMemoryIntegrationReview]),
  recipes:Object.freeze([
    {...RANGE_SELECTION_PERSONAL_RECIPE,workContract:'range-evaluation@1',extract:{id:rangeSelectionPersonalExtractionStrategy.id,version:rangeSelectionPersonalExtractionStrategy.version},review:{id:rangeSelectionPersonalReviewStrategy.id,version:rangeSelectionPersonalReviewStrategy.version}},
    {...RANGE_SELECTION_CODING_RECIPE,workContract:'range-evaluation@1',extract:{id:rangeSelectionContextExtractionStrategy.id,version:rangeSelectionContextExtractionStrategy.version},review:{id:rangeSelectionCodingReviewStrategy.id,version:rangeSelectionCodingReviewStrategy.version}},
    {...RANGE_SELECTION_DAILY_RECIPE,workContract:'range-evaluation@1',requires:['daily-events'],extract:{id:rangeSelectionDailyExtractionStrategy.id,version:rangeSelectionDailyExtractionStrategy.version},review:{id:rangeSelectionDailyReviewStrategy.id,version:rangeSelectionDailyReviewStrategy.version}},
  ]),
  integrations:Object.freeze([defaultMemoryIntegrationStrategy]),
  integrationRecipes:Object.freeze([{...defaultMemoryIntegrationRecipe,integrate:{id:defaultMemoryIntegrationStrategy.id,version:defaultMemoryIntegrationStrategy.version},review:{id:defaultMemoryIntegrationReview.id,version:defaultMemoryIntegrationReview.version}}]),
});

/** Install one contribution atomically: a rejected definition leaves none of
 * that contribution's components installed. Duplicate IDs never overwrite the
 * already installed definition. */
export function installMemoryStrategyContribution(strategies:MemoryStrategies,contribution:MemoryStrategyContribution):()=>void {
  const disposers:(()=>void)[]=[];
  try{
    for(const value of contribution.extractions??[])disposers.push(strategies.registerExtraction(value));
    for(const value of contribution.reviews??[])disposers.push(strategies.registerReview(value));
    for(const value of contribution.recipes??[])disposers.push(strategies.registerRecipe(value));
    for(const value of contribution.integrations??[])disposers.push(strategies.registerIntegration(value));
    for(const value of contribution.integrationRecipes??[])disposers.push(strategies.registerIntegrationRecipe(value));
  }catch(error){
    for(const dispose of disposers.reverse()){try{dispose();}catch{}}
    throw error;
  }
  return ()=>{for(const dispose of disposers.reverse())dispose();};
}

export function installMemoryStrategyContributions(strategies:MemoryStrategies,contributions:readonly MemoryStrategyContribution[]):()=>void {
  const disposers:(()=>void)[]=[];
  try{
    for(const contribution of contributions)disposers.push(installMemoryStrategyContribution(strategies,contribution));
  }catch(error){
    for(const dispose of disposers.reverse()){try{dispose();}catch{}}
    throw error;
  }
  return ()=>{for(const dispose of disposers.reverse())dispose();};
}

/** Deployment-scoped trusted definitions. Installation never schedules work. */
export class MemoryStrategies {
  private extracts=new Map<string,MemoryExtractionStrategy>();
  private reviews=new Map<string,MemoryReviewStrategy>();
  private recipes=new Map<string,ReturnType<typeof memoryRecipeSchema.parse>>();
  private integrators=new Map<string,MemoryIntegrationStrategy>();
  private integrationRecipes=new Map<string,ReturnType<typeof memoryIntegrationRecipeSchema.parse>>();
  private identities=new Map<string,string>();
  constructor(contributions:readonly MemoryStrategyContribution[]=[defaultMemoryStrategyContribution]){
    for(const contribution of contributions)installMemoryStrategyContribution(this,contribution);
  }
  private install<T extends MemoryStrategyRef>(kind:string,map:Map<string,T>,value:T):()=>void {
    const id=key(value),identity=kind+':'+id,fingerprint=recipeFingerprint(value);
    if(map.has(id))throw Error(`Memory ${kind} ${id} is already installed`);
    if(this.identities.has(identity)&&this.identities.get(identity)!==fingerprint)throw Error(`Memory ${kind} ${id} changed without a new version`);
    const frozen=freezeRecipe(value) as T;this.identities.set(identity,fingerprint);map.set(id,frozen);
    return ()=>{if(map.get(id)===frozen)map.delete(id);};
  }
  registerExtraction(value:unknown){return this.install('extraction',this.extracts,memoryExtractionStrategySchema.parse(value));}
  registerReview(value:unknown){return this.install('review',this.reviews,memoryReviewStrategySchema.parse(value));}
  registerIntegration(value:unknown){return this.install('integration',this.integrators,memoryIntegrationStrategySchema.parse(value));}
  registerIntegrationRecipe(value:unknown){const parsed=memoryIntegrationRecipeSchema.parse(value);this.integrationComponents(parsed);return this.install('integration-recipe',this.integrationRecipes,parsed);}
  private integrationComponents(recipe:ReturnType<typeof memoryIntegrationRecipeSchema.parse>){
    const integrate=this.integrators.get(key(recipe.integrate)),review=this.reviews.get(key(recipe.review));
    if(!integrate||!review)throw Error('Memory integration recipe has unavailable components');
    if(review.permissions[0]!=='memory.read')throw Error('Memory integration review requires memory.read');return {integrate,review};
  }
  resolveIntegration(ref:MemoryStrategyRef){
    const recipe=this.integrationRecipes.get(key(ref));if(!recipe)throw Error('Memory integration recipe is not installed');
    const {integrate,review}=this.integrationComponents(recipe);
    return {binding:{recipe:memoryStrategyPin(recipe),integrate:memoryStrategyPin(integrate),review:memoryStrategyPin(review)},integrate,review};
  }
  resolvePinnedIntegration(binding:MemoryIntegrationBinding){const current=this.resolveIntegration(binding.recipe);if(recipeFingerprint(current.binding)!==recipeFingerprint(binding))throw Error('Memory integration definition changed');return current;}
  listIntegrations(){return [...this.integrationRecipes.values()].map(recipe=>{try{return {...recipe,available:true,binding:this.resolveIntegration(recipe).binding};}catch{return {...recipe,available:false};}});}
  registerRecipe(value:unknown){
    const parsed=memoryRecipeSchema.parse(value);this.components(parsed);
    return this.install('recipe',this.recipes,parsed);
  }
  private components(recipe:ReturnType<typeof memoryRecipeSchema.parse>){
    const extract=this.extracts.get(key(recipe.extract)),review=this.reviews.get(key(recipe.review));
    if(!extract||!review)throw Error('Memory recipe has unavailable components');
    return {extract,review};
  }
  resolve(ref:MemoryStrategyRef):ResolvedMemoryRecipe {
    const recipe=this.recipes.get(key(ref));if(!recipe)throw Error('Memory recipe is not installed');
    const {extract,review}=this.components(recipe);
    return {binding:{recipe:memoryStrategyPin(recipe),extract:memoryStrategyPin(extract),review:memoryStrategyPin(review),...(recipe.requires?{requires:recipe.requires}:{}),workContract:recipe.workContract},extract,review};
  }
  resolvePinned(binding:MemoryRecipeBinding):ResolvedMemoryRecipe {
    const current=this.resolve(binding.recipe);
    if(recipeFingerprint(current.binding)!==recipeFingerprint(binding))throw Error('Memory recipe or component version changed');
    return current;
  }
  list(){return [...this.recipes.values()].map(recipe=>{try{return {...recipe,available:true,binding:this.resolve(recipe).binding};}catch{return {...recipe,available:false};}});}
}

/** Consumer-facing registry surface. A plugin activation fences registration
 * after quiesce; reads keep serving already pinned work. */
export type MemoryStrategiesPort=Pick<MemoryStrategies,'registerExtraction'|'registerReview'|'registerRecipe'|'registerIntegration'|'registerIntegrationRecipe'|'resolve'|'resolvePinned'|'resolveIntegration'|'resolvePinnedIntegration'|'list'|'listIntegrations'>;

declare module '@deepseek-ai/cordis' {interface Context {moteMemoryStrategies:MemoryStrategies;}}
