import {InstallationEpochs} from './installation-epochs.js';
import {transcriptSchema,type Transcript} from '@mote/shared';
import type {ProcessorInput} from './file-processors.js';
import {StoreError} from './store.js';
import {recipeFingerprint,freezeRecipe} from './recipe-contract.js';

export type ComponentRef={id:string;version:string};
export interface FileOutputType extends ComponentRef {
  /** Native payload is retained; projection supplies validated, located evidence. */
  parse(value:unknown):unknown;
  project(value:unknown):Transcript;
  kind:'text'|'image-text'|'transcript'|'dialogue';
}
export class FileOutputRegistry {
  private entries=new Map<string,FileOutputType>();
  register(type:FileOutputType){const key=componentKey(type);if(this.entries.has(key))throw Error('Duplicate file output type');this.entries.set(key,type);return ()=>{if(this.entries.get(key)===type)this.entries.delete(key);};}
  get(ref:ComponentRef){const type=this.entries.get(componentKey(ref));if(!type)throw new StoreError('File output type is unavailable',409);return type;}
  decode(ref:ComponentRef,value:unknown){const type=this.get(ref),payload=type.parse(value);return {payload,transcript:transcriptSchema.parse(type.project(payload)),kind:type.kind,type:ref};}
  list(){return [...this.entries.values()].map(({id,version,kind})=>({id,version,kind}));}
}
export const TRANSCRIPT_OUTPUT:ComponentRef={id:'mote.transcript',version:'2'};
export function defaultFileOutput(processor:{output?:ComponentRef;mediaTypes:string[]}):ComponentRef {
  return processor.output??TRANSCRIPT_OUTPUT;
}
const componentKey=(ref:ComponentRef)=>{if(!/^[a-z][a-z0-9.-]{2,127}$/.test(ref.id)||!ref.version)throw Error('Invalid file component');return `${ref.id}@${ref.version}`;};
export type FileRecipeStep={name:string;stage:ComponentRef;dependsOn:string[];enabled?:'semanticTurns'};
export type FileRecipe=ComponentRef&{steps:FileRecipeStep[];output:string};
export type FileRecipeContext={
  input:ProcessorInput;dependencies:Readonly<Record<string,string>>;
  readArtifact(id:string):unknown;
  /** Host validates, caches, fences and publishes every custom stage output. */
  transform(type:ComponentRef,execute:(signal:AbortSignal)=>Promise<unknown>):Promise<string>;
  builtin(operation:'extract'|'diarize'|'align'|'turns'):Promise<string>;
};
export interface FileRecipeStage extends ComponentRef {run(context:FileRecipeContext):Promise<string>;}
export class FileRecipeRegistry {
  readonly epochs=new InstallationEpochs();
  private stages=new Map<string,FileRecipeStage>();
  private recipes=new Map<string,Readonly<FileRecipe>>();
  registerStage(stage:FileRecipeStage){const key=componentKey(stage);if(this.stages.has(key))throw Error('Duplicate file stage');const revoke=this.epochs.install(key);this.stages.set(key,stage);return ()=>{revoke();if(this.stages.get(key)===stage)this.stages.delete(key);};}
  registerRecipe(recipe:FileRecipe){const key=componentKey(recipe);if(this.recipes.has(key))throw Error('Duplicate file recipe');this.order(recipe);const value=freezeRecipe(structuredClone(recipe));this.recipes.set(key,value);return ()=>{if(this.recipes.get(key)===value)this.recipes.delete(key);};}
  private order(recipe:FileRecipe){
    const names=new Map(recipe.steps.map(step=>[step.name,step]));
    if(!recipe.steps.length||recipe.steps.length>64||names.size!==recipe.steps.length||!names.has(recipe.output))throw Error('Invalid file recipe steps');
    const visited=new Set<string>(),active=new Set<string>(),ordered:FileRecipeStep[]=[];
    const visit=(name:string)=>{if(visited.has(name))return;const step=names.get(name);if(!step||active.has(name))throw Error('Missing dependency or cyclic file recipe');if(!/^[a-z][a-z0-9.-]{0,63}$/.test(name))throw Error('Invalid file step name');componentKey(step.stage);active.add(name);step.dependsOn.forEach(visit);active.delete(name);visited.add(name);ordered.push(step);};
    recipe.steps.forEach(step=>visit(step.name));return ordered;
  }
  resolve(ref:ComponentRef,flags:{semanticTurns:boolean}){
    const recipe=this.recipes.get(componentKey(ref));if(!recipe)throw new StoreError('File recipe is unavailable',409);
    const steps=this.order(recipe).map(step=>({...step,active:!step.enabled||flags[step.enabled]}));
    const pins=steps.filter(step=>step.active).map(step=>{const stage=this.stages.get(componentKey(step.stage));if(!stage)throw new StoreError('File recipe stage is unavailable',409);return {name:step.name,...step.stage};});
    return {recipe,steps,pins,fingerprint:recipeFingerprint({recipe,pins,flags})};
  }
  async run(ref:ComponentRef,flags:{semanticTurns:boolean},context:(step:FileRecipeStep,dependencies:Record<string,string>)=>FileRecipeContext,verify:(artifactId:string)=>void){
    const plan=this.resolve(ref,flags),outputs:Record<string,string>={};
    for(const step of plan.steps){
      const dependencies=Object.fromEntries(step.dependsOn.map(name=>[name,outputs[name]]));
      if(!step.active){if(step.dependsOn.length!==1)throw new StoreError('Disabled file step requires one passthrough dependency',422);outputs[step.name]=outputs[step.dependsOn[0]];continue;}
      const stage=this.stages.get(componentKey(step.stage));if(!stage)throw new StoreError('File stage was uninstalled',409);
      outputs[step.name]=await stage.run(context(step,dependencies));
      verify(outputs[step.name]);
    }
    return outputs[plan.recipe.output];
  }
  list(){return {recipes:[...this.recipes.values()],stages:[...this.stages.values()].map(({id,version})=>({id,version}))};}
}
export function defaultFileRecipe(processor:{dialogue?:boolean;recipe?:ComponentRef}):ComponentRef{return processor.recipe??{id:processor.dialogue?'mote.audio-dialogue':'mote.file-extraction',version:processor.dialogue?'2':'1'};}
export function installFileRecipes(recipes:FileRecipeRegistry,outputs:FileOutputRegistry){
  const dispose=[outputs.register({...TRANSCRIPT_OUTPUT,kind:'text',parse:value=>transcriptSchema.parse(value),project:value=>value as Transcript})];
  for(const name of ['extract','diarize','align','turns'] as const)dispose.push(recipes.registerStage({id:'mote.'+name,version:name==='align'?'2':'1',run:context=>context.builtin(name)}));
  const stage=(name:string,dependsOn:string[]=[],enabled?:'semanticTurns'):FileRecipeStep=>({name,stage:{id:'mote.'+name,version:'1'},dependsOn,...(enabled?{enabled}:{})});
  dispose.push(recipes.registerRecipe({id:'mote.file-extraction',version:'1',steps:[stage('extract')],output:'extract'}));
  dispose.push(recipes.registerRecipe({id:'mote.audio-dialogue',version:'2',steps:[stage('extract'),stage('diarize',['extract']),{...stage('align',['extract','diarize']),stage:{id:'mote.align',version:'2'}},stage('turns',['align'],'semanticTurns')],output:'turns'}));
  return ()=>dispose.reverse().forEach(stop=>stop());
}
declare module '@deepseek-ai/cordis' {interface Context {moteFileRecipes:FileRecipeRegistry;moteFileOutputs:FileOutputRegistry;}}
