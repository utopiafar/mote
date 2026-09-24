import type {SourceConnection,SourceItem} from '@mote/shared';
import type {Context} from '@deepseek-ai/cordis';
import type {CodingAppendBase,MaterialAppendDraft,MaterialDraft} from './materials.js';
import type {SourceArchive} from './source-archive.js';
import type {RawReader} from './raw-reader.js';
import {RecipeRegistry,type InstalledRecipe,type RecipeComponentKind,type RecipeComponentManifest} from './recipe-registry.js';
import type {RecipeComponentRef} from './recipe-contract.js';

type RecipeConfig=RecipeComponentRef['config'];
export type RecipeSnapshot={items:SourceItem[];checkpoint:string;headCount?:number;appendEpoch?:number;
  mode?:'full'|'append';base?:CodingAppendBase};
type Handler=
  | {kind:'raw-writer';version:string;run:(archive:SourceArchive,source:SourceConnection,items:SourceItem[],groups:string[])=>ReturnType<SourceArchive['receive']>}
  | {kind:'raw-reader';version:string;run:(reader:RawReader,source:SourceConnection,group:string,signal:AbortSignal,base?:CodingAppendBase)=>Promise<RecipeSnapshot>}
  | {kind:'group';version:string;run:(item:SourceItem,config:RecipeConfig)=>string}
  | {kind:'step';version:string;run:(input:StepInput)=>unknown}
  | {kind:'publish';version:string;run:(input:PublishInput)=>MaterialDraft|MaterialAppendDraft|undefined};

export interface StepInput {
  source:SourceConnection;
  group:string;
  items:readonly SourceItem[];
  dependencies:Readonly<Record<string,unknown>>;
  config:RecipeConfig;
  snapshot:RecipeSnapshot;
}
export interface PublishInput {
  source:SourceConnection;
  group:string;
  items:readonly SourceItem[];
  outputs:Readonly<Record<string,unknown>>;
  config:RecipeConfig;
}

/** Trusted executable counterparts of declarative recipe IDs. */
export class SourceRecipeExecutor {
  readonly registry=new RecipeRegistry();
  private readonly handlers=new Map<string,Handler>();

  private register(component:RecipeComponentManifest,handler?:Handler):()=>void {
    if(handler&&handler.kind!==component.kind)throw Error(`Recipe handler kind mismatch: ${component.id}`);
    const uninstall=this.registry.installComponent(component);
    if(handler)this.handlers.set(component.id,handler);
    return ()=>{if(handler&&this.handlers.get(component.id)===handler)this.handlers.delete(component.id);uninstall();};
  }

  registerPolicy(component:RecipeComponentManifest):()=>void {
    if(['raw-writer','raw-reader','group','step','publish'].includes(component.kind))throw Error(`Recipe component ${component.id} requires an executable handler`);
    return this.register(component);
  }
  registerRawWriter(component:RecipeComponentManifest,run:Extract<Handler,{kind:'raw-writer'}>['run']):()=>void {
    return this.register(component,{kind:'raw-writer',version:component.version,run});
  }
  registerRawReader(component:RecipeComponentManifest,run:Extract<Handler,{kind:'raw-reader'}>['run']):()=>void {
    return this.register(component,{kind:'raw-reader',version:component.version,run});
  }
  registerGroup(component:RecipeComponentManifest,run:Extract<Handler,{kind:'group'}>['run']):()=>void {
    return this.register(component,{kind:'group',version:component.version,run});
  }
  registerStep(component:RecipeComponentManifest,run:Extract<Handler,{kind:'step'}>['run']):()=>void {
    return this.register(component,{kind:'step',version:component.version,run});
  }
  registerPublisher(component:RecipeComponentManifest,run:Extract<Handler,{kind:'publish'}>['run']):()=>void {
    return this.register(component,{kind:'publish',version:component.version,run});
  }
  installRecipe(input:unknown):()=>void {
    const installed=this.registry.installRecipe(input);
    return ()=>this.registry.uninstallRecipe(installed.definition.id,installed.definition.version);
  }

  resolve(id:string,version:string):InstalledRecipe {return this.registry.resolveRecipe(id,version);}
  private handler<T extends Handler['kind']>(recipe:InstalledRecipe,path:string,kind:T):Extract<Handler,{kind:T}> {
    const pin=recipe.componentPins.find(value=>value.path===path);
    if(!pin||pin.kind!==kind)throw Error(`Recipe has no ${kind} component at ${path}`);
    const handler=this.handlers.get(pin.id);
    if(!handler||handler.kind!==kind||handler.version!==pin.version)throw Error(`Recipe component ${pin.id}@${pin.version} is unavailable`);
    return handler as Extract<Handler,{kind:T}>;
  }
  group(recipe:InstalledRecipe,item:SourceItem):string {
    return this.handler(recipe,'group.policy','group').run(item,recipe.definition.group.policy.config);
  }
  receive(recipe:InstalledRecipe,archive:SourceArchive,source:SourceConnection,items:SourceItem[],groups:string[]){
    return this.handler(recipe,'raw.writer','raw-writer').run(archive,source,items,groups);
  }
  snapshot(recipe:InstalledRecipe,reader:RawReader,source:SourceConnection,group:string,signal:AbortSignal,base?:CodingAppendBase){
    return this.handler(recipe,'raw.reader','raw-reader').run(reader,source,group,signal,base);
  }
  organize(recipe:InstalledRecipe,source:SourceConnection,group:string,snapshot:RecipeSnapshot):MaterialDraft|MaterialAppendDraft|undefined {
    const outputs=Object.create(null) as Record<string,unknown>;
    const steps=new Map(recipe.definition.steps.map(step=>[step.id,step]));
    for(const stepId of recipe.stepOrder){
      const step=steps.get(stepId)!;
      const dependencies=Object.create(null) as Record<string,unknown>;
      for(const id of step.dependsOn)dependencies[id]=outputs[id];
      outputs[stepId]=this.handler(recipe,`steps.${stepId}`,'step').run({source,group,items:snapshot.items,dependencies,config:step.use.config,snapshot});
    }
    return this.handler(recipe,'publish.use','publish').run({source,group,items:snapshot.items,outputs,config:recipe.definition.publish.use.config});
  }
}

declare module '@deepseek-ai/cordis' {interface Context {moteSourceRecipes:SourceRecipeExecutor;}}
