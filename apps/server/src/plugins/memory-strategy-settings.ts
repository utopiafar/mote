import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,ServiceBinding,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import {MemoryStrategies,defaultMemoryStrategyContribution,installMemoryStrategyContributions,type MemoryStrategiesPort,type MemoryStrategyContribution} from '../memory-strategies.js';
import {MemoryRecipeSettings,type MemoryRecipeSettingsPort} from '../memory-recipe-settings.js';
import {MemoryIntegrationSettings,type MemoryIntegrationSettingsPort} from '../memory-integration-settings.js';
import {StoreError} from '../store.js';
import {centralServices} from './central-contracts.js';

/** C21A owns the trusted strategy catalog and the two durable owner selections.
 * Recipes are data contributions installed by this activation; duplicate IDs
 * never overwrite an already installed definition. */
export const memoryStrategySettingsContribution={
  id:'memory-strategy-settings',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'}],
  provides:[
    {kind:'service' as const,id:centralServices.memoryStrategies.id,apiVersion:centralServices.memoryStrategies.apiVersion,cardinality:'single' as const},
    {kind:'service' as const,id:centralServices.memoryRecipeSettings.id,apiVersion:centralServices.memoryRecipeSettings.apiVersion,cardinality:'single' as const},
    {kind:'service' as const,id:centralServices.memoryIntegrationSettings.id,apiVersion:centralServices.memoryIntegrationSettings.apiVersion,cardinality:'single' as const},
  ],
} as const satisfies ManifestContribution;
export const memoryStrategySettingsDeclaration={id:memoryStrategySettingsContribution.id,apiVersion:'1'} as const;
/** The catalog is installed data and both selections are vault rows, so a new
 * activation reuses them without a process restart. */
export const memoryStrategySettingsReplacement='hot' as const;

type StrategySettingsStore=ConstructorParameters<typeof MemoryRecipeSettings>[0];

export interface MemoryStrategySettingsDependencies {
  readonly store:StrategySettingsStore;
  /** Additional data contributions installed by this activation. The built-in
   * product policies remain the default when omitted. */
  readonly contributions?:readonly MemoryStrategyContribution[];
}

export interface MemoryStrategySettingsBindings {
  readonly strategies:ServiceBinding;
  readonly recipes:ServiceBinding;
  readonly integration:ServiceBinding;
}

export interface MemoryStrategySettingsPorts {
  readonly strategies:MemoryStrategiesPort;
  readonly recipes:MemoryRecipeSettingsPort;
  readonly integration:MemoryIntegrationSettingsPort;
}

export interface MemoryStrategySettingsPlatform extends PluginLifecycle {
  readonly strategies:MemoryStrategies;
  readonly recipes:MemoryRecipeSettings;
  readonly integration:MemoryIntegrationSettings;
  readonly ports:MemoryStrategySettingsPorts;
  close():Promise<void>;
}

const unavailable=()=>new StoreError('Memory strategy settings are unavailable',503);

/** The only construction path for the catalog and both selection objects.
 * Prepare installs the contribution data; start admits registrations and owner
 * writes; quiesce keeps pinned reads while refusing new work; stop releases the
 * contribution registrations and makes the ports unavailable. */
export function createMemoryStrategySettings(dependencies:MemoryStrategySettingsDependencies):MemoryStrategySettingsPlatform {
  let phase:'created'|'preparing'|'prepared'|'active'|'quiescing'|'stopped'='created';
  let strategies:MemoryStrategies|undefined,recipes:MemoryRecipeSettings|undefined,integration:MemoryIntegrationSettings|undefined;
  let removeContributions:(()=>void)|undefined,closing:Promise<void>|undefined;
  const prepared=()=>{
    if(!strategies||!recipes||!integration||phase==='created'||phase==='stopped')throw unavailable();
    return {strategies,recipes,integration};
  };
  const active=()=>{
    if(phase!=='active')throw unavailable();
    return prepared();
  };
  const close=()=>closing??=(async()=>{
    const remove=removeContributions;removeContributions=undefined;
    phase='stopped';
    strategies=undefined;recipes=undefined;integration=undefined;
    if(remove)remove();
  })().finally(()=>{closing=undefined;});
  const strategiesPort:MemoryStrategiesPort=Object.freeze({
    registerExtraction:value=>active().strategies.registerExtraction(value),
    registerReview:value=>active().strategies.registerReview(value),
    registerRecipe:value=>active().strategies.registerRecipe(value),
    registerIntegration:value=>active().strategies.registerIntegration(value),
    registerIntegrationRecipe:value=>active().strategies.registerIntegrationRecipe(value),
    resolve:ref=>prepared().strategies.resolve(ref),
    resolvePinned:binding=>prepared().strategies.resolvePinned(binding),
    resolveIntegration:ref=>prepared().strategies.resolveIntegration(ref),
    resolvePinnedIntegration:binding=>prepared().strategies.resolvePinnedIntegration(binding),
    list:()=>prepared().strategies.list(),
    listIntegrations:()=>prepared().strategies.listIntegrations(),
  });
  const recipesPort:MemoryRecipeSettingsPort=Object.freeze({
    get onChange(){return prepared().recipes.onChange;},
    set onChange(value){prepared().recipes.onChange=value;},
    get onApplied(){return prepared().recipes.onApplied;},
    set onApplied(value){prepared().recipes.onApplied=value;},
    selection:(sourceId,scope)=>prepared().recipes.selection(sourceId,scope),
    enabled:(sourceId,binding)=>prepared().recipes.enabled(sourceId,binding),
    available:binding=>prepared().recipes.available(binding),
    view:(sourceId,scope)=>prepared().recipes.view(sourceId,scope),
    configure:raw=>active().recipes.configure(raw),
  });
  const integrationPort:MemoryIntegrationSettingsPort=Object.freeze({
    get onApplied(){return prepared().integration.onApplied;},
    set onApplied(value){prepared().integration.onApplied=value;},
    selection:()=>prepared().integration.selection(),
    view:()=>prepared().integration.view(),
    current:selection=>prepared().integration.current(selection),
    configure:raw=>active().integration.configure(raw),
    eligible:(ids,afterSequence,through)=>prepared().integration.eligible(ids,afterSequence,through),
  });
  const ports:MemoryStrategySettingsPorts=Object.freeze({strategies:strategiesPort,recipes:recipesPort,integration:integrationPort});
  const platform:MemoryStrategySettingsPlatform=Object.freeze({
    get strategies(){return prepared().strategies;},
    get recipes(){return prepared().recipes;},
    get integration(){return prepared().integration;},
    ports,
    async prepare(){
      if(phase!=='created')throw unavailable();
      phase='preparing';
      try{
        const catalog=new MemoryStrategies([]);
        removeContributions=installMemoryStrategyContributions(catalog,[defaultMemoryStrategyContribution,...(dependencies.contributions??[])]);
        const recipeSettings=new MemoryRecipeSettings(dependencies.store,catalog);
        const integrationSettings=new MemoryIntegrationSettings(dependencies.store,catalog);
        strategies=catalog;recipes=recipeSettings;integration=integrationSettings;
        phase='prepared';
      }catch(error){
        try{await close();}
        catch(cleanup){throw new AggregateError([error,cleanup],'Memory strategy settings preparation and disposal failed',{cause:error});}
        throw error;
      }
    },
    start(){if(phase!=='prepared')throw unavailable();phase='active';},
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},
    async stop(_reason?:StopReason){await close();},
    dispose:close,close,
  });
  return platform;
}
export type MemoryStrategySettings=ReturnType<typeof createMemoryStrategySettings>;

export function createMemoryStrategySettingsFactory(platform:MemoryStrategySettingsPlatform,onStarted?:(bindings:MemoryStrategySettingsBindings)=>void){
  return (context:HostPluginContext):PluginLifecycle=>{
    context.scope.defer(()=>platform.close());
    return {
      prepare:()=>platform.prepare(),
      start(){
        platform.start();
        const bindings={
          strategies:context.provide(memoryStrategySettingsContribution.id,centralServices.memoryStrategies,platform.ports.strategies),
          recipes:context.provide(memoryStrategySettingsContribution.id,centralServices.memoryRecipeSettings,platform.ports.recipes),
          integration:context.provide(memoryStrategySettingsContribution.id,centralServices.memoryIntegrationSettings,platform.ports.integration),
        };
        onStarted?.(bindings);
      },
      quiesce:(reason:StopReason)=>platform.quiesce(reason),stop:(reason:StopReason)=>platform.stop(reason),dispose:platform.dispose,
    };
  };
}
