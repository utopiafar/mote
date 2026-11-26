import type {ManifestContribution} from '@mote/plugin-api';
import type {Awaitable,PluginLifecycle,ReplacementPolicy,ServiceBinding,ServiceContract,ServiceRef} from '@mote/plugin-api/contracts';
import {PluginHostError,type PluginHost,type HostPluginContext,type PluginHandle} from '@mote/plugin-host';
import {randomUUID} from 'node:crypto';
import type {FeatureRoute} from './features/index.js';
import type {HostCapabilityDescriptor} from './feature-inventory.js';

/** Executable built-in registration. Dependencies name an exact contribution
 * and API; the loader passes only binding identities, never business values. */
export interface CentralDomainPlugin {
  readonly contribution:ManifestContribution;
  readonly declaration:{readonly id:string;readonly apiVersion:string};
  readonly replacement:ReplacementPolicy;
  readonly components?:readonly HostCapabilityDescriptor[];
  readonly activation?:{
    readonly featureId:string;
    readonly requires:Readonly<Record<string,{readonly provider:string;readonly service:ServiceRef}>>;
    readonly create:(context:HostPluginContext,bindings:Readonly<Record<string,ServiceBinding>>)=>Awaitable<DomainActivation>;
  };
}

export interface DomainActivation extends PluginLifecycle {
  readonly route:FeatureRoute;
}

/** Resolve executable selection from the pinned build declarations, never
 * from settings or a caller-supplied authorization flag. Private input
 * publishers use the same predicate as the activation loader. */
export function resolveSelectedDomain(selection:{readonly plugins:readonly CentralDomainPlugin[];readonly features:readonly string[]},id:string){
  const plugin=selection.plugins.find(plugin=>plugin.contribution.id===id);
  return plugin?.activation&&selection.features.includes(plugin.activation.featureId)?plugin:undefined;
}

/** One registry of concrete provider pins and one lifecycle for executable
 * build registrations. Values are acquired through PluginHost contracts; the
 * registry never inspects business objects or chooses providers by order. */
export function createDomainActivations(host:PluginHost,plugins:readonly CentralDomainPlugin[],features:readonly string[]){
  const selection=Object.freeze({plugins:Object.freeze([...plugins]),features:Object.freeze([...features])});
  const selectedDomain=(id:string)=>resolveSelectedDomain(selection,id);
  const domainBindings=new Map<string,ServiceBinding>();
  const bindingKey=(provider:string,service:{id:string;apiVersion:string})=>JSON.stringify([provider,service.id,service.apiVersion]);
  const registerDomainService=(binding:ServiceBinding)=>{
    const provider=binding.provider.contributionId,key=bindingKey(provider,binding.service);
    if(domainBindings.has(key))throw new PluginHostError('conflict');
    domainBindings.set(key,binding);
  };
  const domainBinding=(provider:string,service:{id:string;apiVersion:string})=>{
    const binding=domainBindings.get(bindingKey(provider,service));
    if(!binding)throw new PluginHostError('dependency_unavailable');
    return binding;
  };
  // Early owners and the final pass share the same pins, handles and cleanup.
  // Requests retain their explicit order; omitted dependencies are not installed
  // implicitly, and a failed request cannot start a later queued factory.
  const handles:PluginHandle[]=[],routes=new Map<string,FeatureRoute>(),installations=new Map<string,Promise<void>>();
  let installing=Promise.resolve(),failedInstallation:Promise<void>|undefined;
  const visitHandles=async(operation:(handle:PluginHandle)=>Promise<void>,message:string)=>{
    const errors:unknown[]=[];
    for(const handle of [...handles].reverse())try{await operation(handle);}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,message);
  };
  let quiescing:Promise<void>|undefined,closing:Promise<void>|undefined;
  const quiesce=()=>closing??(quiescing??=Promise.resolve().then(()=>visitHandles(handle=>handle.signal.aborted?Promise.resolve():handle.quiesce('shutdown'),'Domain quiescence failed')));
  const close=()=>closing??=Promise.resolve().then(async()=>{
    const errors:unknown[]=[];
    // Finish an accepted pass before disposal makes its remaining provider
    // handles stale. Later quiesce calls join this same closing result.
    if(quiescing)try{await quiescing;}catch(error){errors.push(error);}
    try{await visitHandles(handle=>handle.close('shutdown'),'Domain disposal failed');}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Domain disposal failed');
  });
  const installDomain=(id:string):Promise<void>=>{
    if(failedInstallation)return failedInstallation;
    if(closing||quiescing)return Promise.reject(new PluginHostError('stale_scope'));
    const existing=installations.get(id);if(existing)return existing;
    const plugin=selectedDomain(id);
    if(!plugin)return Promise.reject(new PluginHostError('dependency_unavailable'));
    const activation=plugin.activation!;
    const installation:Promise<void>=installing.then(async()=>{
      try{
        const required=Object.freeze(Object.fromEntries(Object.entries(activation.requires).map(([name,requirement])=>[name,domainBinding(requirement.provider,requirement.service)])));
        let instance:DomainActivation|undefined,active=false;
        const published:ServiceBinding[]=[];
        const handle=await host.install({
          identity:{host:host.identity,packageId:plugin.contribution.id,installationId:`build:${plugin.contribution.id}@${plugin.contribution.version}`,instanceId:plugin.contribution.id,activationId:randomUUID()},
          contributions:[plugin.declaration],requires:Object.values(required),restartRequired:plugin.replacement==='restart',
          factory:async context=>{
            instance=await activation.create({scope:context.scope,services:context.services,get state(){return context.state;},provide:(...args)=>{const binding=context.provide(...args);published.push(binding);return binding;}},required);
            if(instance.route.id!==activation.featureId){await instance.dispose();throw Object.assign(new Error('Domain route does not match its selected feature'),{code:'MOTE_BOOTSTRAP_INVALID'});}
            const service=instance;
            return {
              prepare:()=>service.prepare(),start:async()=>{await service.start();active=true;},
              quiesce:reason=>{active=false;return service.quiesce(reason);},
              stop:reason=>{active=false;return service.stop(reason);},dispose:()=>{active=false;return service.dispose();},
            };
          },
        });
        handles.push(handle);
        for(const binding of published)registerDomainService(binding);
        const route=instance!.route;
        const guarded:FeatureRoute={...route,mount(app,scope){app.register(async child=>{
          child.addHook('onRequest',async(_request,reply)=>{if(!active)return reply.code(503).send({error:'feature_unavailable'});});
          route.mount(child,scope);
        });}};
        const existing=routes.get(route.id);
        routes.set(route.id,existing?{...guarded,mount(app,scope){existing.mount(app,scope);guarded.mount(app,scope);}}:guarded);
      }catch(error){
        failedInstallation=installation;
        try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Domain startup and cleanup failed',{cause:error});}
        throw error;
      }
    });
    // Promise callbacks run only after both the cache and serial tail are set,
    // including when a factory synchronously re-enters installation.
    installations.set(id,installation);installing=installation;
    return installation;
  };
  let domains:Promise<{readonly routes:readonly FeatureRoute[];quiesce():Promise<void>;close():Promise<void>}>|undefined;
  return Object.freeze({
    selectedDomain,installDomain,register:registerDomainService,
    acquire:<T>(provider:string,contract:ServiceContract<T>)=>host.acquire(contract,domainBinding(provider,contract)),
    activate:()=>domains??=Promise.resolve().then(async()=>{
      if(failedInstallation)await failedInstallation;
      for(const plugin of selection.plugins)if(selectedDomain(plugin.contribution.id))await installDomain(plugin.contribution.id);
      return Object.freeze({routes:Object.freeze([...routes.values()]),quiesce,close});
    }),
  });
}
