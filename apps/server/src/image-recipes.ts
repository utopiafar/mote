import {z} from 'zod';
import type {CaptureRecord,ImageReadInput,ImageReadResult,Transcript} from '@mote/shared';
import {recipeFingerprint,freezeRecipe} from './recipe-contract.js';
import {StoreError} from './store.js';
import type {ComponentRef} from './file-recipes.js';

/** These are interpretations, never OCR or verbatim original evidence. Regions
 * use original encoded pixels and are checked by the host before publication. */
export const imageInterpretationSchema=z.object({
 text:z.string().trim().min(1).max(24000),
 regions:z.array(z.object({x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),width:z.number().int().positive(),height:z.number().int().positive(),description:z.string().max(4000)}).strict()).max(32).default([]),
}).strict();
export type ImageInterpretation=z.infer<typeof imageInterpretationSchema>;
export type ImageStageContext={
 record:CaptureRecord;hash:string;mimeType:string;dependencies:Readonly<Record<string,unknown>>;signal:AbortSignal;
 readImage(input:Omit<ImageReadInput,'id'>):Promise<ImageReadResult>;
 ocr():Promise<Transcript>;
 understand():Promise<ImageInterpretation>;
};
export type ImageStage=ComponentRef&{kind:'ocr'|'understanding'|'derived';reuseByContent?:boolean;run(input:ImageStageContext):Promise<unknown>};
export type ImageRecipe=ComponentRef&{steps:{name:string;stage:ComponentRef;dependsOn:string[];optionalDependencies?:string[];when?:'understanding'}[]};
const key=(ref:ComponentRef)=>`${ref.id}@${ref.version}`;
/** Installed capability is separate from the owner's selected, versioned recipe. */
export class ImageRecipeRegistry {
 private stages=new Map<string,ImageStage>();private recipes=new Map<string,Readonly<ImageRecipe>>();
 registerStage(stage:ImageStage){if(!/^[a-z][a-z0-9.-]{2,127}$/.test(stage.id)||!stage.version||this.stages.has(key(stage)))throw Error('Invalid image stage');this.stages.set(key(stage),stage);return ()=>{if(this.stages.get(key(stage))===stage)this.stages.delete(key(stage));};}
 registerRecipe(recipe:ImageRecipe){
  if(!/^[a-z][a-z0-9.-]{2,127}$/.test(recipe.id)||!recipe.version||this.recipes.has(key(recipe)))throw Error('Invalid image recipe');
  this.order(recipe);const saved=freezeRecipe(structuredClone(recipe));this.recipes.set(key(recipe),saved);return ()=>{if(this.recipes.get(key(recipe))===saved)this.recipes.delete(key(recipe));};
 }
 private order(recipe:ImageRecipe){
  const names=new Map(recipe.steps.map(step=>[step.name,step])),done=new Set<string>(),active=new Set<string>(),ordered:ImageRecipe['steps']=[];
  if(!names.size||names.size!==recipe.steps.length||names.size>32)throw Error('Invalid image recipe steps');
  const visit=(name:string)=>{if(done.has(name))return;const step=names.get(name);if(!step||active.has(name)||!/^[a-z][a-z0-9.-]{0,63}$/.test(name))throw Error('Invalid image recipe dependency');if(step.optionalDependencies?.some(d=>!step.dependsOn.includes(d)))throw Error('Invalid optional image dependency');active.add(name);step.dependsOn.forEach(visit);active.delete(name);done.add(name);ordered.push(step);};recipe.steps.forEach(step=>visit(step.name));return ordered;
 }
 resolve(ref:ComponentRef,understanding:boolean){
  const recipe=this.recipes.get(key(ref));if(!recipe)throw new StoreError('Image recipe is unavailable',409);
  const steps=this.order(recipe).filter(step=>!step.when||understanding),pins=steps.map(step=>{const stage=this.stages.get(key(step.stage));if(!stage)throw new StoreError('Image stage is unavailable',409);return {...step,kind:stage.kind};});
  if(pins.some(step=>step.dependsOn.some(name=>!pins.some(candidate=>candidate.name===name))))throw new StoreError('Image recipe dependency is disabled',409);
  return {recipe,steps:pins,fingerprint:recipeFingerprint({recipe,pins})};
 }
 get(ref:ComponentRef){const stage=this.stages.get(key(ref));if(!stage)throw new StoreError('Image stage is unavailable',409);return stage;}
 list(){return {recipes:[...this.recipes.values()],stages:[...this.stages.values()].map(({run,...metadata})=>metadata)};}
}
export const DEFAULT_IMAGE_RECIPE={id:'mote.image',version:'1'};
export function installImageRecipes(registry:ImageRecipeRegistry){
 const stop=[registry.registerStage({id:'mote.image-ocr',version:'1',kind:'ocr',reuseByContent:true,run:input=>input.ocr()}),registry.registerStage({id:'mote.image-understanding',version:'1',kind:'understanding',run:input=>input.understand()}),
 registry.registerRecipe({...DEFAULT_IMAGE_RECIPE,steps:[{name:'ocr',stage:{id:'mote.image-ocr',version:'1'},dependsOn:[]},{name:'understanding',stage:{id:'mote.image-understanding',version:'1'},dependsOn:['ocr'],optionalDependencies:['ocr'],when:'understanding'}]})];
 return ()=>stop.reverse().forEach(dispose=>dispose());
}
declare module '@deepseek-ai/cordis' {interface Context {moteImageRecipes:ImageRecipeRegistry;}}
