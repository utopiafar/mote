import {randomUUID} from 'node:crypto';
import {PluginHost,PluginHostError,type HostPluginContext,type HostScope} from '@mote/plugin-host';
import {serviceContract,type ServiceBinding,type ServiceContract,type ServiceLease,type PluginLifecycle} from '@mote/plugin-api/contracts';
import type {ManifestContribution,StateStore} from '@mote/plugin-api';
import type {ConfigurationBootstrap} from './config.js';
import type {ConfigService} from './config-service.js';
import type {EvidenceStore as Store} from './evidence-store.js';
import type {createVaultPlatformAssembly} from './plugins/vault-platform.js';
import type {ConfigurationPlatform,ConfigurationPlatformOptions} from './plugins/configuration-platform.js';
import {c10IntegrationDeclaration} from './plugins/c10-integration.js';
import {createObservabilityPlatformFactory,observabilityPlatformDeclaration,type ObservabilityPlatform,type ObservabilityPlatformOptions} from './plugins/observability-platform.js';
import {defaultDistribution} from './distribution/default.js';
import {featureInventory,type HostContributionDescriptor} from './feature-inventory.js';
import {createDomainActivations,type CentralDomainPlugin} from './domain-activation.js';
export type {CentralDomainPlugin} from './domain-activation.js';

/** Assembly-private bridge for the existing product, not a plugin SDK service
 * bag. Storage and owner-authorization adapters stay raw foundation values; domain plugins acquire narrower services. */
export interface FoundationValues {
  configuration:{readonly bootstrap:ConfigurationBootstrap;readonly service:ConfigService;readonly platform:ConfigurationPlatform};
  storage:{readonly store:Store;readonly assembly:ReturnType<typeof createVaultPlatformAssembly>};
  authorization:{validOwnerBearer(authorization:string|undefined):boolean};
}
export interface FoundationInput {
  readonly configuration:ConfigurationPlatformOptions;
  readonly configService?:ConfigService;
  readonly store?:Store;
  readonly backgroundWorker?:boolean;
}
type ResolvedFoundationInput=FoundationInput & {readonly bootstrap:ConfigurationBootstrap;readonly configService:ConfigService};
export type FoundationKind=keyof FoundationValues;
export interface FoundationProvider<K extends FoundationKind=FoundationKind> {
  readonly kind:K;
  readonly id:string;
  readonly version:string;
  readonly contribution:ManifestContribution;
  /** Trusted build code owns acquired resources immediately through scope.defer.
   * Passing this registry is executable assembly authority, never user config. */
  readonly create:(context:HostPluginContext,input:K extends 'configuration'?FoundationInput:ResolvedFoundationInput)=>Promise<FoundationValues[K]>|FoundationValues[K];
}
export interface CentralDistribution {
  readonly foundations:readonly ({[K in FoundationKind]:FoundationProvider<K>}[FoundationKind])[];
  /** Selected HTTP feature ids. The implementation is build-owned; composition
   * selects which surfaces this host mounts. */
  readonly features:readonly string[];
  readonly plugins:readonly CentralDomainPlugin[];
}
export const foundationContracts=Object.freeze<{readonly [K in FoundationKind]:ServiceContract<FoundationValues[K]>}>({
  configuration:serviceContract<FoundationValues['configuration']>('mote.platform.configuration','1'),
  storage:serviceContract<FoundationValues['storage']>('mote.platform.storage','1'),
  authorization:serviceContract<FoundationValues['authorization']>('mote.platform.authorization','1'),
});
const kinds=['configuration','storage','authorization'] as const;
const lifecycle={prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
function invalid(message:string):never{throw Object.assign(new Error(message),{code:'MOTE_BOOTSTRAP_INVALID'});}

/** Trusted local build registry -> executable built-in registrations. It deliberately
 * does not manufacture a PackageManifest/archive/install row. Managed packages
 * are read later through PluginCenter's canonical release/integrity boundary. */
export async function bootstrapCentral(input:FoundationInput,distribution:CentralDistribution=defaultDistribution){
  // Pin and validate the complete selection before any factory acquires resources.
  const selected=distribution.foundations.map(provider=>({...provider,contribution:{...provider.contribution}}));
  if(new Set(selected.map(provider=>provider.id)).size!==selected.length)invalid('Duplicate foundation provider identity');
  for(const kind of kinds){
    const providers=selected.filter(provider=>provider.kind===kind);
    if(providers.length!==1)invalid(`Exactly one ${kind} provider is required`);
    const provider=providers[0]!,contract=foundationContracts[kind];
    const provides=provider.contribution.provides;
    if(!provider.id||!/^\d+\.\d+\.\d+$/.test(provider.version)||provider.contribution.id!==contract.id||provider.contribution.runtime!=='host'
      ||provides?.length!==1||provides[0]?.kind!=='service'||provides[0].id!==contract.id||provides[0].apiVersion!==contract.apiVersion||provides[0].cardinality!=='single')
      invalid('Invalid foundation provider descriptor');
  }
  if(selected.length!==kinds.length)invalid('Unknown foundation provider kind');
  const features=distribution.features.map(id=>{if(typeof id!=='string'||!id)invalid('Invalid feature contribution');return id;});
  if(new Set(features).size!==features.length)invalid('Duplicate feature contribution');
  const plugins=distribution.plugins.map(entry=>{
    const activation=entry.activation;
    return Object.freeze({...entry,contribution:Object.freeze({...entry.contribution}),declaration:Object.freeze({...entry.declaration}),
      ...(entry.components?{components:Object.freeze(entry.components.map(component=>Object.freeze({...component})))}:{}),
      ...(activation?{activation:Object.freeze({...activation,requires:Object.freeze(Object.fromEntries(Object.entries(activation.requires)
        .map(([name,requirement])=>[name,Object.freeze({...requirement,service:Object.freeze({...requirement.service})})])))})}:{}),
    });
  });
  if(new Set(plugins.map(entry=>entry.contribution.id)).size!==plugins.length)invalid('Duplicate domain plugin contribution');
  for(const plugin of plugins){
    if(plugin.contribution.id!==plugin.declaration.id||!plugin.replacement)invalid('Invalid domain plugin descriptor');
    if(plugin.activation&&(!plugin.activation.featureId||typeof plugin.activation.create!=='function'))invalid('Invalid domain activation');
  }
  const contributions=Object.freeze([
    ...selected.map(provider=>({...provider.contribution,featureVersion:provider.version})),
    ...plugins.map(plugin=>({...plugin.contribution,featureVersion:plugin.contribution.version,components:plugin.components})),
  ]);
  let stateFor:((scope:HostScope)=>StateStore)|undefined,storageOwner:HostScope|undefined;
  const host=new PluginHost({kind:'central',id:randomUUID()},undefined,undefined,{
    // The vault store is created by the storage foundation. State is bound
    // lazily on first plugin access, after that foundation has started.
    stateFor:scope=>{
      if(!stateFor)throw new PluginHostError('dependency_unavailable');
      return stateFor(scope);
    },
  });
  const leases:{release():Promise<void>}[]=[],bindings:ServiceBinding[]=[];
  const domainActivations=createDomainActivations(host,plugins,features);
  const facts:{id:string;version:string}[]=[];
  async function install<K extends FoundationKind>(kind:K,current:K extends 'configuration'?FoundationInput:ResolvedFoundationInput):Promise<ServiceLease<FoundationValues[K]>>{
    const provider=selected.find(provider=>provider.kind===kind)! as FoundationProvider<K>;
    const contract:ServiceContract<FoundationValues[K]>=foundationContracts[kind];
    let binding:ServiceBinding|undefined;
    await host.install({identity:{host:host.identity,packageId:provider.id,installationId:`build:${provider.id}@${provider.version}`,instanceId:kind,activationId:randomUUID()},
      contributions:[{id:provider.contribution.id,apiVersion:contract.apiVersion}],requires:kind==='configuration'?[]:[bindings[0]!],restartRequired:true,
      factory:async context=>{const value=await provider.create(context,current);if(kind==='storage')storageOwner=context.scope;binding=context.provide(provider.contribution.id,contract,value);return lifecycle;}});
    const lease=await host.acquire(contract,binding!);
    leases.push(lease);bindings.push(binding!);
    // Only installed, usable providers become host-dependency facts. Config and
    // pending/failed descriptors cannot satisfy composition requirements.
    lease.assertCurrent();facts.push(Object.freeze({id:provider.id,version:provider.version}));
    return lease;
  }
  try{
    const configuration=await install('configuration',input);
    const current={...input,bootstrap:configuration.value.bootstrap,configService:configuration.value.service};
    const storage=await install('storage',current);
    const stateOwner=()=>{if(!storageOwner)throw new PluginHostError('dependency_unavailable');return storageOwner;};
    const pluginStorage=Object.freeze({
      stateForScope:(scope:HostScope,sourceKinds:readonly string[]=[])=>storage.value.assembly.instanceStateForAssembly(stateOwner(),scope,undefined,sourceKinds),
      controlForScope:(scope:HostScope)=>storage.value.assembly.pluginControlForAssembly(stateOwner(),scope),
    });
    stateFor=scope=>pluginStorage.stateForScope(scope);
    const authorization=await install('authorization',current);
    let closing:Promise<void>|undefined,observability:{platform:ObservabilityPlatform;scope:HostScope}|undefined;
    return Object.freeze({configurationBootstrap:configuration.value.bootstrap,configService:configuration.value.service,configurationPlatform:configuration.value.platform,store:storage.value.store,vault:storage.value.assembly,pluginStorage,
      authorization:authorization.value,features:Object.freeze(features),plugins:Object.freeze(plugins),host,get hostDependencies(){return Object.freeze([...facts]);},snapshot:()=>host.snapshot(),
      selectsPlugin:(id:string)=>plugins.some(plugin=>plugin.contribution.id===id),
      selectsFeature:(id:string)=>features.includes(id),
      featureInventory:(extra:readonly HostContributionDescriptor[]=[])=>featureInventory(host.snapshot(),[...contributions,...extra]),
      /** Producers register the binding returned by provide(), not an object
       * lookup or a guessed activation/revision. Ordinary plugins still acquire
       * only the exact requirements enforced by PluginHost. */
      domainActivation:Object.freeze({selectedDomain:domainActivations.selectedDomain,installDomain:domainActivations.installDomain}),
      registerDomainService:domainActivations.register,
      acquireDomainService:domainActivations.acquire,
      activateDomains:domainActivations.activate,
      /** Trusted build-only installation in the same host; no public service or second host. */
      async installObservabilityPlatform(options:ObservabilityPlatformOptions){
        if(observability)return observability;
        let platform:ObservabilityPlatform|undefined,scope:HostScope|undefined;
        await host.install({identity:{host:host.identity,packageId:'mote.observability-platform',installationId:'build:observability-platform@1.0.0',instanceId:'observability',activationId:randomUUID()},
          contributions:[observabilityPlatformDeclaration],requires:[storage.binding],restartRequired:true,
          factory:createObservabilityPlatformFactory(options,{usageForScope:consumer=>{
            if(!storageOwner)throw Error('Vault usage owner is unavailable');
            return storage.value.assembly.usageForAssembly(storageOwner,consumer);
          }},(value,valueScope)=>{platform=value;scope=valueScope;})});
        if(!platform||!scope)throw Error('Observability platform did not hand off its trusted assembly');
        facts.push(Object.freeze({id:'observability-platform',version:'1.0.0'}));observability={platform,scope};return observability;
      },
      /** Trusted source-integration activation in the same host; callers retain the owner to stop or replace it. */
      async installSourceIntegration(factory:(context:HostPluginContext)=>PluginLifecycle|Promise<PluginLifecycle>){
        const owner=await host.install({identity:{host:host.identity,packageId:'mote.source-integration',installationId:'build:source-integration@1.0.0',instanceId:'source-integration',activationId:randomUUID()},
          contributions:[c10IntegrationDeclaration],restartRequired:true,factory});
        if(!facts.some(fact=>fact.id==='source-integration'))facts.push(Object.freeze({id:'source-integration',version:'1.0.0'}));return owner;
      },
      close:()=>closing??=(async()=>{try{await host.close();}finally{await Promise.all(leases.map(lease=>lease.release()));}})()});
  }catch(error){
    try{await host.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Foundation startup and cleanup failed',{cause:error});}
    throw error;
  }
}
