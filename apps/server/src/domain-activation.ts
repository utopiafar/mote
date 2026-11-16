import type {ManifestContribution} from '@mote/plugin-api';
import type {Awaitable,PluginLifecycle,ReplacementPolicy,ServiceBinding,ServiceContract,ServiceRef} from '@mote/plugin-api/contracts';
import {PluginHostError,type PluginHost,type HostPluginContext,type PluginHandle} from '@mote/plugin-host';
import {randomUUID} from 'node:crypto';
import type {FeatureRoute} from './features/index.js';

/** Executable built-in registration. Dependencies name an exact contribution
 * and API; the loader passes only binding identities, never business values. */
export interface CentralDomainPlugin {
  readonly contribution:ManifestContribution;
  readonly declaration:{readonly id:string;readonly apiVersion:string};
  readonly replacement:ReplacementPolicy;
  readonly activation?:{
    readonly featureId:string;
    readonly requires:Readonly<Record<string,{readonly provider:string;readonly service:ServiceRef}>>;
    readonly create:(context:HostPluginContext,bindings:Readonly<Record<string,ServiceBinding>>)=>Awaitable<DomainActivation>;
  };
}

export interface DomainActivation extends PluginLifecycle {
  readonly route:FeatureRoute;
}

/** One registry of concrete provider pins and one lifecycle for executable
 * build registrations. Values are acquired through PluginHost contracts; the
 * registry never inspects business objects or chooses providers by order. */
export function createDomainActivations(host:PluginHost,plugins:readonly CentralDomainPlugin[],features:readonly string[]){
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
  let domains:Promise<{readonly routes:readonly FeatureRoute[];quiesce():Promise<void>;close():Promise<void>}>|undefined;
  return Object.freeze({
    register:registerDomainService,
    acquire:<T>(provider:string,contract:ServiceContract<T>)=>host.acquire(contract,domainBinding(provider,contract)),
    activate:()=>domains??=(async()=>{
      const handles:PluginHandle[]=[],routes=new Map<string,FeatureRoute>();
      const visitHandles=async(operation:(handle:PluginHandle)=>Promise<void>,message:string)=>{
        const errors:unknown[]=[];
        for(const handle of [...handles].reverse())try{await operation(handle);}catch(error){errors.push(error);}
        if(errors.length)throw new AggregateError(errors,message);
      };
      let quiescing:Promise<void>|undefined,closing:Promise<void>|undefined;
      const quiesce=()=>closing??(quiescing??=visitHandles(handle=>handle.quiesce('shutdown'),'Domain quiescence failed'));
      const close=()=>closing??=(async()=>{
        const errors:unknown[]=[];
        // Finish an accepted pass before disposal makes its remaining provider
        // handles stale. Later quiesce calls join this same closing result.
        if(quiescing)try{await quiescing;}catch(error){errors.push(error);}
        try{await visitHandles(handle=>handle.close('shutdown'),'Domain disposal failed');}catch(error){errors.push(error);}
        if(errors.length)throw new AggregateError(errors,'Domain disposal failed');
      })();
      try{
        for(const plugin of plugins){
          const activation=plugin.activation;
          if(!activation||!features.includes(activation.featureId))continue;
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
        }
        return Object.freeze({routes:Object.freeze([...routes.values()]),quiesce,close});
      }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Domain startup and cleanup failed',{cause:error});}throw error;}
    })(),
  });
}
