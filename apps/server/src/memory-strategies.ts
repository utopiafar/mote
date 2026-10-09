import {memoryExtractionStrategySchema,memoryReviewStrategySchema,memoryRecipeSchema,memoryStrategyPin,type MemoryExtractionStrategy,type MemoryReviewStrategy,type MemoryStrategyRef,type MemoryRecipeBinding} from './memory-strategy-contract.js';
import {freezeRecipe,recipeFingerprint} from './recipe-contract.js';
import {MEMORY_EXTRACTION_PROMPT,MEMORY_SKILL_VERSION} from './memory.js';
import {personalMemoryReviewStrategyV2} from './personal-memory-review-policy.js';
import {codingMemoryReviewStrategyV2} from './coding-memory-review-policy.js';
import {memoryIntegrationStrategySchema,memoryIntegrationRecipeSchema,type MemoryIntegrationStrategy,type MemoryIntegrationBinding} from './memory-strategy-contract.js';
import {defaultMemoryIntegrationStrategy,defaultMemoryIntegrationRecipe,defaultMemoryIntegrationReview} from './memory-integration-policy.js';

const key=(ref:MemoryStrategyRef)=>`${ref.id}@${ref.version}`;
export type ResolvedMemoryRecipe={binding:MemoryRecipeBinding;extract:MemoryExtractionStrategy;review:MemoryReviewStrategy};

/** Deployment-scoped trusted definitions. Installation never schedules work. */
export class MemoryStrategies {
  private extracts=new Map<string,MemoryExtractionStrategy>();
  private reviews=new Map<string,MemoryReviewStrategy>();
  private recipes=new Map<string,ReturnType<typeof memoryRecipeSchema.parse>>();
  private integrators=new Map<string,MemoryIntegrationStrategy>();
  private integrationRecipes=new Map<string,ReturnType<typeof memoryIntegrationRecipeSchema.parse>>();
  private identities=new Map<string,string>();
  constructor(){
    this.registerExtraction({id:'mote.context-extraction',version:MEMORY_SKILL_VERSION.split('@')[1],input:'memory-evidence@1',output:'memory-candidates@1',permissions:['evidence.read'],prompt:MEMORY_EXTRACTION_PROMPT});
    this.registerReview(personalMemoryReviewStrategyV2);
    this.registerRecipe({id:'mote.personal-memory',version:'2',extract:{id:'mote.context-extraction',version:MEMORY_SKILL_VERSION.split('@')[1]},review:{id:'mote.personal-review',version:'2'}});
    this.registerReview(codingMemoryReviewStrategyV2);
    this.registerRecipe({id:'mote.coding-memory',version:'2',extract:{id:'mote.context-extraction',version:MEMORY_SKILL_VERSION.split('@')[1]},review:{id:'mote.coding-review',version:'2'}});
    this.registerReview(defaultMemoryIntegrationReview);
    this.registerIntegration(defaultMemoryIntegrationStrategy);
    this.registerIntegrationRecipe({...defaultMemoryIntegrationRecipe,integrate:{id:defaultMemoryIntegrationStrategy.id,version:defaultMemoryIntegrationStrategy.version},review:{id:defaultMemoryIntegrationReview.id,version:defaultMemoryIntegrationReview.version}});
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
    return {binding:{recipe:memoryStrategyPin(recipe),extract:memoryStrategyPin(extract),review:memoryStrategyPin(review),...(recipe.requires?{requires:recipe.requires}:{})},extract,review};
  }
  resolvePinned(binding:MemoryRecipeBinding):ResolvedMemoryRecipe {
    const current=this.resolve(binding.recipe);
    if(recipeFingerprint(current.binding)!==recipeFingerprint(binding))throw Error('Memory recipe or component version changed');
    return current;
  }
  list(){return [...this.recipes.values()].map(recipe=>{try{return {...recipe,available:true,binding:this.resolve(recipe).binding};}catch{return {...recipe,available:false};}});}
}

declare module '@deepseek-ai/cordis' {interface Context {moteMemoryStrategies:MemoryStrategies;}}
