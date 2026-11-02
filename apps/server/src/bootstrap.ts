import {randomUUID} from 'node:crypto';
import {PluginHost,type HostPluginContext} from '@mote/plugin-host';
import {serviceContract,type ServiceBinding,type ServiceContract,type ServiceLease} from '@mote/plugin-api/contracts';
import type {ManifestContribution} from '@mote/plugin-api';
import type {Config} from './config.js';
import type {ConfigService} from './config-service.js';
import type {Store} from './store.js';
import type {ServerFeatureAdapter} from './features/index.js';
import {defaultDistribution} from './distribution/default.js';

/** Assembly-private bridge for the existing product, not a plugin SDK service
 * bag. C02/C04 replace the storage/authorization adapters with domain ports. */
export interface FoundationValues {
  configuration:{readonly config:Config;readonly service:ConfigService};
  storage:{readonly store:Store};
  authorization:{validOwnerBearer(authorization:string|undefined):boolean};
}
export interface FoundationInput {
  readonly config:Config;
  readonly configService?:ConfigService;
  readonly store?:Store;
  readonly backgroundWorker?:boolean;
}
export type FoundationKind=keyof FoundationValues;
export interface FoundationProvider<K extends FoundationKind=FoundationKind> {
  readonly kind:K;
  readonly id:string;
  readonly version:string;
  readonly contribution:ManifestContribution;
  /** Trusted build code owns acquired resources immediately through scope.defer.
   * Passing this registry is executable assembly authority, never user config. */
  readonly create:(context:HostPluginContext,input:FoundationInput)=>Promise<FoundationValues[K]>|FoundationValues[K];
}
export interface CentralDistribution {
  readonly foundations:readonly ({[K in FoundationKind]:FoundationProvider<K>}[FoundationKind])[];
  readonly features:readonly ServerFeatureAdapter[];
}
export const foundationContracts=Object.freeze<{readonly [K in FoundationKind]:ServiceContract<FoundationValues[K]>}>({
  configuration:serviceContract<FoundationValues['configuration']>('mote.platform.configuration','1'),
  storage:serviceContract<FoundationValues['storage']>('mote.platform.storage','1'),
  authorization:serviceContract<FoundationValues['authorization']>('mote.platform.authorization','1'),
});
const kinds=['configuration','storage','authorization'] as const;
const lifecycle={prepare(){},start(){},quiesce(){},stop(){},dispose(){}};
function invalid(message:string):never{throw Object.assign(new Error(message),{code:'MOTE_BOOTSTRAP_INVALID'});}

/** Trusted local build registry -> H04 execution definitions. It deliberately
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
  const features=distribution.features.map(entry=>({descriptor:{...entry.descriptor},factory:entry.factory}));
  if(new Set(features.map(entry=>entry.descriptor.id)).size!==features.length)invalid('Duplicate feature contribution');
  const host=new PluginHost({kind:'central',id:randomUUID()});
  const leases:{release():Promise<void>}[]=[],bindings:ServiceBinding[]=[];
  const facts:{id:string;version:string}[]=[];
  async function install<K extends FoundationKind>(kind:K,current:FoundationInput):Promise<ServiceLease<FoundationValues[K]>>{
    const provider=selected.find(provider=>provider.kind===kind)! as FoundationProvider<K>;
    const contract:ServiceContract<FoundationValues[K]>=foundationContracts[kind];
    let binding:ServiceBinding|undefined;
    await host.install({identity:{host:host.identity,packageId:provider.id,installationId:`build:${provider.id}@${provider.version}`,instanceId:kind,activationId:randomUUID()},
      contributions:[{id:provider.contribution.id,apiVersion:contract.apiVersion}],requires:kind==='configuration'?[]:[bindings[0]!],restartRequired:true,
      factory:async context=>{const value=await provider.create(context,current);binding=context.provide(provider.contribution.id,contract,value);return lifecycle;}});
    const lease=await host.acquire(contract,binding!);
    leases.push(lease);bindings.push(binding!);
    // Only installed, usable providers become host-dependency facts. Config and
    // pending/failed descriptors cannot satisfy composition requirements.
    lease.assertCurrent();facts.push(Object.freeze({id:provider.id,version:provider.version}));
    return lease;
  }
  try{
    const configuration=await install('configuration',input);
    const current={...input,config:configuration.value.config};
    const storage=await install('storage',current),authorization=await install('authorization',current);
    let closing:Promise<void>|undefined;
    return Object.freeze({config:configuration.value.config,configService:configuration.value.service,store:storage.value.store,
      authorization:authorization.value,features:Object.freeze(features),hostDependencies:Object.freeze(facts),snapshot:()=>host.snapshot(),
      close:()=>closing??=(async()=>{try{await host.close();}finally{await Promise.all(leases.map(lease=>lease.release()));}})()});
  }catch(error){
    try{await host.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Foundation startup and cleanup failed',{cause:error});}
    throw error;
  }
}
