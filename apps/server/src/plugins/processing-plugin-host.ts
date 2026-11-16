import type {Context,Plugin} from '@deepseek-ai/cordis';
import type {HostPluginContext} from '@mote/plugin-host';
import type {PluginLifecycle} from '@mote/plugin-api/contracts';
import {ContextProcessorRegistry,type ProcessingRuntime} from '../processing-runtime.js';
import {ProcessorRegistry,type FileProcessorRuntime} from '../file-processors.js';
import {FileOutputRegistry,FileRecipeRegistry} from '../file-recipes.js';
import {MaterialConsumerRegistry} from '../material-consumers.js';
import {ImportIntakeRegistry} from '../import-intake.js';
import {ImageInputRegistry} from '../image-inputs.js';
import {ImageRecipeRegistry} from '../image-recipes.js';
import {StoreError} from '../store.js';

type Registry=Record<string,(value:any)=>()=>void>;
type Declaration={live?:()=>void;remove:()=>void;publish:()=>()=>void;active:boolean};
export type ProcessingPluginHost=ReturnType<typeof createProcessingPluginHost>;

/** Trusted assembly supplies registration ports only. The existing runtimes
 * retain job admission, originals, model authority, epochs and output commits. */
export function createProcessingPluginHost(workflows:Pick<ProcessingRuntime,'registry'|'consumers'>,files:FileProcessorRuntime,available:()=>boolean){
 return Object.freeze({create(context:HostPluginContext,plugin:Plugin,configuration:Record<string,unknown>,options:{publish:boolean;signal:AbortSignal;assertCurrent:()=>void}):PluginLifecycle{
  const scope=context.scope,declarations:Declaration[]=[];
  let sealed=false,fiber:ReturnType<Context['plugin']>|undefined,closing:Promise<void>|undefined;
  const current=()=>{scope.assertCurrent();options.signal.throwIfAborted();options.assertCurrent();if(!available())throw new StoreError('Processing host is unavailable',503);};
  const revoke=()=>{for(const declaration of [...declarations].reverse()){declaration.live?.();declaration.live=undefined;}};
  const guarded=(value:Record<string,unknown>,functions:readonly string[])=>{
   const callbacks=new Map<PropertyKey,{entry:Function;callback:Function}>();
   const read=(key:PropertyKey)=>{
    // Resolve inherited methods and accessors against the original instance,
    // including private fields. The facade is a separate target so frozen own
    // methods can also be wrapped without violating Proxy get invariants.
    if(typeof key==='string'&&functions.includes(key))current();
    const entry=Reflect.get(value,key,value);if(typeof entry!=='function')return entry;
    const previous=callbacks.get(key);if(previous&&previous.entry===entry)return previous.callback;
    const callback=function(this:unknown,...args:unknown[]){
     current();const first=args[0];
     if(first&&typeof first==='object'&&(first as {signal?:unknown}).signal instanceof AbortSignal)args[0]={...first,signal:AbortSignal.any([(first as {signal:AbortSignal}).signal,scope.signal,options.signal])};
     const result:unknown=Reflect.apply(entry,value,args);
     if(result&&typeof (result as {then?:unknown}).then==='function')return scope.run(()=>Promise.resolve(result)).then(output=>{current();return output;});
     current();return result;
    };
    callbacks.set(key,{entry,callback});return callback;
   };
   return new Proxy({}, {
    get:(_target,key)=>read(key),
    set:(_target,key,next)=>{current();return Reflect.set(value,key,next,value);},
    has:(_target,key)=>Reflect.has(value,key),ownKeys:()=>Reflect.ownKeys(value),
    getOwnPropertyDescriptor:(_target,key)=>{const descriptor=Reflect.getOwnPropertyDescriptor(value,key);return descriptor?{configurable:true,enumerable:descriptor.enumerable,get:()=>{current();return read(key);}}:undefined;},
   });
  };
  const ports:Record<string,unknown>={};
  const registry=(name:string,validation:object,live:object,methods:Record<string,readonly string[]>)=>{
   ports[name]=Object.freeze(Object.fromEntries(Object.entries(methods).map(([method,functions])=>[method,(value:Record<string,unknown>)=>{
    current();if(sealed)throw new StoreError('Processing declarations are sealed',409);
    if(!value||typeof value!=='object'&&typeof value!=='function'||functions.some(key=>typeof value[key]!=='function'))throw new StoreError('Invalid processing declaration',422);
    // Check and enable consume exactly the same real registry validators.
    // Callback-free recipe/configuration records keep their native clone
    // semantics; callback-bearing declarations retain their original receiver.
    const definition=functions.length?guarded(value,functions):value,remove=(validation as Registry)[method](definition);
    const declaration:Declaration={active:true,remove,publish:()=>{current();return (live as Registry)[method](definition);}};declarations.push(declaration);
    return ()=>{declaration.active=false;declaration.live?.();declaration.live=undefined;remove();};
   }])));
  };
  registry('moteContextProcessors',new ContextProcessorRegistry(),workflows.registry,{register:['process']});
  registry('moteMaterialConsumers',new MaterialConsumerRegistry(),workflows.consumers,{register:[]});
  registry('moteFileProcessors',new ProcessorRegistry(),files.registry,{register:['process']});
  registry('moteFileOutputs',new FileOutputRegistry(),files.outputs,{register:['parse','project']});
  registry('moteFileRecipes',new FileRecipeRegistry(),files.recipes,{registerStage:['run'],registerRecipe:[]});
  registry('moteImportIntake',new ImportIntakeRegistry(),files.intake,{registerFormat:['probe'],registerContainer:['probe','expand']});
  registry('moteImageInputs',new ImageInputRegistry(),files.imageInputs,{register:['resolve']});
  registry('moteImageRecipes',new ImageRecipeRegistry(),files.imageRecipes,{registerStage:['run'],registerRecipe:[]});
  const exported=plugin as unknown as {name?:string;inject?:unknown;apply?:Function};
  const inject=exported.inject??[];
  if(!Array.isArray(inject)||inject.some(name=>typeof name!=='string'||!Object.hasOwn(ports,name)))throw new StoreError('Processing package requires an unsupported registration port',422);
  const apply=typeof plugin==='function'?plugin:exported.apply!;
  // Unique apply identity prevents Cordis deduplication across installations.
  // These registration ports are already resolved by the host. Declaring them
  // as child service dependencies would wait for the preparing parent scope.
  const local=(ctx:Context)=>Object.create(ctx,{...Object.fromEntries(Object.entries(ports).map(([name,value])=>[name,{value,enumerable:true}])),get:{value:(name:string)=>{current();if(!Object.hasOwn(ports,name))throw new StoreError('Processing package requires an unsupported registration port',422);return ports[name];}}});
  const isolated={...exported,name:exported.name??'installed-processing',inject:[],apply:(ctx:Context,config:unknown)=>Reflect.apply(apply,plugin,[local(ctx),config])} as Plugin;
  const close=()=>closing??=(async()=>{revoke();await fiber?.dispose();for(const declaration of declarations.reverse())declaration.remove();})();
  scope.defer(close);
  for(const signal of [scope.signal,options.signal]){signal.addEventListener('abort',revoke,{once:true});scope.defer(()=>signal.removeEventListener('abort',revoke));}
  return {
   async prepare(){current();fiber=scope.cordis.plugin(isolated,configuration);await fiber;current();sealed=true;if(!declarations.some(value=>value.active))throw new StoreError('Processing package registered no capabilities',422);},
   start(){current();if(!options.publish)return;try{for(const declaration of declarations)if(declaration.active)declaration.live=declaration.publish();}catch(error){revoke();throw error;}},
   quiesce:revoke,stop:close,dispose:close,
  };
 }});
}
