import {isDeepStrictEqual} from 'node:util';
import type {ManifestContribution} from '@mote/plugin-api';
import {serviceContract,type PluginLifecycle,type StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {ModelFeature} from '@mote/shared/models';
import {ConfigService,ConfigServiceError,type ConfigDomainRegistration,type ConfigServiceOptions} from '../config-service.js';
import {registerBuiltinDomains,type Config} from '../config.js';
import {ExecutionSettings,executionSettingsSchema,diagnosticsSettingsSchema,type ExecutionSettingsValue,type DiagnosticsSettingsValue} from '../execution-settings.js';
import {ModelSettingsStore,ModelSettingsError,type ModelSettingsStoreOptions} from '../model-settings.js';
import type {ConfigurationDomain} from './central-contracts.js';

export interface ModelProfileSelection {
  select(feature:ModelFeature,override?:string):ReturnType<ModelSettingsStore['selectPublic']>;
}
export const configurationServices=Object.freeze({
  execution:serviceContract<ConfigurationDomain<ExecutionSettingsValue>>('mote.central.configuration.execution','1'),
  diagnostics:serviceContract<ConfigurationDomain<DiagnosticsSettingsValue>>('mote.central.configuration.diagnostics','1'),
  modelSelection:serviceContract<ModelProfileSelection>('mote.central.configuration.model-selection','1'),
});
export const configurationPlatformContribution={id:'configuration-platform',version:'1.0.0',surface:'data',runtime:'host',
  provides:Object.values(configurationServices).map(({id,apiVersion})=>({id,apiVersion,kind:'service',cardinality:'single'})),
} as const satisfies ManifestContribution;
export const configurationPlatformDeclaration={id:configurationPlatformContribution.id,apiVersion:'1'} as const;
export const configurationPlatformReplacement='restart' as const;
export interface ConfigurationPlatformOptions extends ConfigServiceOptions {
  /** Trusted bootstrap seed only. Owner-token checks and secret resolution remain in the existing registry. */
  readonly config?:Config;
}
type ModelDependencies=Omit<ModelSettingsStoreOptions,'configService'>;

/** Owns the file/transaction queue, watcher, domain subscriptions, settings stores and their shutdown.
 * The raw assembly getters are trusted roots-only; none is published through ordinary services. */
export function createConfigurationPlatform(options:ConfigurationPlatformOptions) {
  const service=new ConfigService(options);
  registerBuiltinDomains(service,options.config);
  let ready=false,closing=false,preparing:Promise<void>|undefined,starting:Promise<void>|undefined,closingTask:Promise<void>|undefined;
  let models:ModelSettingsStore|undefined,modelBinding:Promise<void>|undefined,modelsReady=false,quiescing=false;
  const subscriptions=new Set<()=>void>(),registrations=new Map<string,()=>Promise<void>>();
  const assertReady=()=>{if(!ready||closing)throw new ConfigServiceError('config_unavailable');};
  const assertAdmission=()=>{assertReady();if(quiescing)throw new ConfigServiceError('config_unavailable');};
  const domain=<T>(id:string,parse:(input:unknown)=>T,parsePatch:(input:unknown)=>unknown=(input)=>input):ConfigurationDomain<T>=>{
    const snapshot=()=>{assertReady();return {revision:service.revision,value:parse(service.current(id))};};
    return Object.freeze({snapshot,
      async update(value:Partial<T>,expectedRevision:number){
        assertAdmission();let patch:unknown;try{patch=parsePatch(value);}catch{throw new ConfigServiceError('config_invalid',id);}
        await service.update(id,patch,expectedRevision);assertReady();return snapshot();
      },
      subscribe(listener:(value:{revision:number;value:T})=>void){
        assertAdmission();let previous=snapshot().value,active=true;
        const unsubscribe=service.onChange(()=>{
          if(!active||closing)return;
          let next:ReturnType<typeof snapshot>;
          try{next=snapshot();}catch{return;}
          if(isDeepStrictEqual(previous,next.value))return;
          previous=structuredClone(next.value);
          listener(next);
        });
        const release=()=>{active=false;unsubscribe();subscriptions.delete(release);};
        subscriptions.add(release);return release;
      },
    });
  };
  const execution=domain('execution',value=>executionSettingsSchema.strip().parse(value),value=>executionSettingsSchema.partial().parse(value));
  const diagnostics=domain('diagnostics',value=>diagnosticsSettingsSchema.strip().parse(value),value=>diagnosticsSettingsSchema.partial().parse(value));
  // Builtin domains contain a few additional deployment fields. These public ports deliberately project only their schema.
  const runtimeSettings=new ExecutionSettings({execution,diagnostics});
  const selection:ModelProfileSelection=Object.freeze({select(feature:ModelFeature,override?:string){assertReady();if(!modelsReady||!models)throw new ModelSettingsError('model_settings_unavailable');return models.selectPublic(feature,override);}});
  const prepare=()=>preparing??=(async()=>{await service.initialize();if(closing)throw new ConfigServiceError('config_unavailable');ready=true;})();
  const bindModels=(dependencies:ModelDependencies)=>{
    assertAdmission();if(modelBinding)throw new ConfigServiceError('config_conflict');
    models=new ModelSettingsStore({...dependencies,configService:service});
    return modelBinding=models.initialize().then(()=>{assertReady();modelsReady=true;});
  };
  const close=()=>closingTask??=(async()=>{
    closing=true;
    for(const unsubscribe of [...subscriptions])unsubscribe();
    // ConfigService rejects new file work synchronously and drains accepted transactions before stores retire.
    const [serviceOutcome]=await Promise.allSettled([service.close(),preparing,starting,modelBinding]);
    // Initialization failures remain observable to their original callers; they are not cleanup errors.
    const failures:unknown[]=serviceOutcome.status==='rejected'?[serviceOutcome.reason]:[];
    try{await models?.close();}catch(error){failures.push(error);}
    for(const unregister of [...registrations.values()].reverse())try{await unregister();}catch(error){failures.push(error);}
    registrations.clear();ready=false;
    if(failures.length)throw new AggregateError(failures,'Configuration shutdown failed');
  })();
  return {
    prepare,
    start(){assertAdmission();return starting??=service.startWatching();},
    quiesce(_reason:StopReason){quiescing=true;for(const unsubscribe of [...subscriptions])unsubscribe();return service.stopWatching();},
    stop(_reason:StopReason){return close();},dispose:close,close,
    execution,diagnostics,selection,
    /** Trusted phased assembly: wire real AGENT prepare/probe before publishing model selection. */
    bindModels,
    get configService(){assertReady();return service;},
    get runtimeSettings(){assertReady();return runtimeSettings;},
    get modelSettings(){assertReady();if(!models||!modelsReady)throw new ModelSettingsError('model_settings_unavailable');return models;},
    /** Plugins declare schemas in their existing private namespace; unknown schemas have no handle.
     * Sensitive domains remain private. This public-domain helper cannot export their raw values. */
    async registerDomain<T>(registration:ConfigDomainRegistration<T>):Promise<ConfigurationDomain<T>>{
      assertAdmission();if(registration.fields?.some(field=>field.sensitive))throw new ConfigServiceError('config_invalid');
      const unregister=await service.registerPlugin(registration),id=`plugin.${registration.id}`;
      if(closing){await unregister();throw new ConfigServiceError('config_unavailable');}
      registrations.set(id,unregister);
      // ConfigService merges partial patches into the saved document and validates the full candidate.
      // Filling omitted keys from effective state here would overwrite pending restart-only values.
      return domain(id,input=>registration.schema.parse(input));
    },
  };
}
export type ConfigurationPlatform=ReturnType<typeof createConfigurationPlatform>;

/** Build-registered factory; requires real AGENT callbacks, not a pretend ready model provider.
 * H05 roots supply this exact executable and the canonical contribution fragment, not a fabricated release. */
export function createConfigurationPlatformFactory(options:ConfigurationPlatformOptions,models:ModelDependencies) {
  return (context:HostPluginContext):PluginLifecycle=>{
    const platform=createConfigurationPlatform(options);
    context.scope.defer(()=>platform.close());
    return {
      async prepare(){await platform.prepare();context.scope.assertCurrent();await platform.bindModels(models);context.scope.assertCurrent();
        context.provide(configurationPlatformDeclaration.id,configurationServices.execution,platform.execution);
        context.provide(configurationPlatformDeclaration.id,configurationServices.diagnostics,platform.diagnostics);
        context.provide(configurationPlatformDeclaration.id,configurationServices.modelSelection,platform.selection);
      },
      start:()=>platform.start(),quiesce:reason=>platform.quiesce(reason),stop:reason=>platform.stop(reason),dispose:()=>platform.close(),
    };
  };
}
