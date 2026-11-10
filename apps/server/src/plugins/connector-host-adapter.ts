import type {HostScope} from '@mote/plugin-host';
import type {StateStore} from '@mote/plugin-api';
import type {ConnectorActionExecution,ConnectorActionReceipt,SourceCapabilityDescriptor} from '@mote/shared';
import type {ConnectorActivation,ConnectorContext} from '../connectors/types.js';
import {ConnectorRegistry,connectorCleanupFailure,isConnectorCleanupFailure,type ConnectorHttpHost,type ConnectorInstance,type ConnectorManifest} from '../connectors/registry.js';
import type {DynamicHttpDispatcher} from './dynamic-http-dispatcher.js';
import type {HostContributionDescriptor} from '../feature-inventory.js';

/** H05-owned per-install scope. The factory is trusted assembly input, never a
 * consumer-selectable registration API. */
export interface ConnectorInstanceScope {
  readonly scope:HostScope;
  /** Stop admission/cancel accepted work before connector shutdown; optional for
   * callers that only expose close(). */
  fence?():void|Promise<void>;
  close():Promise<void>;
}
export type ConnectorScopeFactory=(manifest:ConnectorManifest,instanceId:string)=>ConnectorInstanceScope;
export interface ConnectorHostAdapterOptions {
  readonly manifests:readonly ConnectorManifest[];
  /** Deployment modules whose initialization must fail the whole startup; an
   * ordinary built-in failure only marks that instance failed. */
  readonly required?:readonly string[];
  /** Private trusted assembly context for existing built-in connectors. */
  readonly context:ConnectorContext;
  readonly dispatcher:DynamicHttpDispatcher;
  /** H05 fixes this to the actual installed instance scope. */
  readonly scopeFor:ConnectorScopeFactory;
  /** Trusted persistent state binding for each installed instance scope. */
  readonly stateFor?:(scope:HostScope)=>StateStore;
  readonly statusScope:HostScope;
  /** Trusted transport slot only; ordinary plugins get no raw context here. */
  readonly transport?:(instance:ConnectorInstance)=>void|Promise<void>;
}
export interface ConnectorHostAdapter {
  start():Promise<void>;
  inventory():ReturnType<ConnectorRegistry['inventory']>;
  /** Live connector capabilities, attributed to their installed instance. */
  contributions():HostContributionDescriptor[];
  configureSyncInterval(intervalMs:number):void;
  /** Hot-install a new manifest after start; failure rolls back only it. */
  install(manifest:ConnectorManifest,activation?:ConnectorActivation):Promise<void>;
  /** True once a manifest has been installed, including while it is stopped. */
  known(id:string):boolean;
  /** Hot-restart a known stopped manifest with a fresh H04 scope. */
  restart(id:string,activation?:ConnectorActivation):Promise<void>;
  /** Hot-stop one installed instance; sibling instances keep running. */
  stop(id:string):Promise<void>;
  /** Dispatch one host-authorized action to an active connector instance. */
  executeAction(id:string,request:ConnectorActionExecution):Promise<ConnectorActionReceipt>;
  close():Promise<void>;
}

/** Adapts the existing deployment-scoped ConnectorRegistry to the shared H05
 * dispatcher and H04 scopes. It is a trusted assembly bridge: it creates no
 * second host/registry and publishes no raw SourceStore/engine/materials API. */
const descriptorKey=(descriptor:SourceCapabilityDescriptor)=>JSON.stringify([descriptor.lifecycle,descriptor.discovery,descriptor.listening,descriptor.readOriginal,descriptor.synchronization,descriptor.externalWrite]);
export function createConnectorHostAdapter(options:ConnectorHostAdapterOptions):ConnectorHostAdapter {
  const scopes=new Map<string,ConnectorInstanceScope>(),capabilityUsers=new Map<string,number>(),ownedKinds=new Set<string>(),ownedDescriptors=new Map<string,SourceCapabilityDescriptor>(),activations=new Map<string,ConnectorActivation>();
  const required=new Set(options.required??[]);
  const installedDescriptor=(kind:string):SourceCapabilityDescriptor=>{
    const value=options.context.sources.capabilities.describe({kind:kind as never,platform:'macos',retention:'snapshot'});
    return {lifecycle:value.lifecycle,discovery:value.discovery,listening:value.listening,readOriginal:value.readOriginal,synchronization:value.synchronization,externalWrite:value.externalWrite};
  };
  const scopeFor=(manifest:ConnectorManifest)=>{
    let value=scopes.get(manifest.id);
    if(!value){value=options.scopeFor(manifest,manifest.id);scopes.set(manifest.id,value);}
    value.scope.assertCurrent();return value.scope;
  };
  const releaseCapability=(kind:string)=>{
    const current=capabilityUsers.get(kind);if(current===undefined)return;
    if(current>1){capabilityUsers.set(kind,current-1);return;}
    capabilityUsers.delete(kind);
    if(ownedKinds.delete(kind)){ownedDescriptors.delete(kind);options.context.sources.capabilities.unregister(kind);}
  };
  const registerDescriptors=(manifest:ConnectorManifest)=>{
    const added:string[]=[];
    try{
      for(const entry of manifest.sourceKinds){
        if(typeof entry==='string')continue;
        const owned=ownedDescriptors.get(entry.kind);
        if(owned){
          if(descriptorKey(owned)!==descriptorKey(entry.capabilities))throw Error(`Connector source capability conflict: ${entry.kind}`);
          continue;
        }
        if(options.context.sources.capabilities.has(entry.kind)){
          if(descriptorKey(installedDescriptor(entry.kind))!==descriptorKey(entry.capabilities))throw Error(`Connector source capability conflict: ${entry.kind}`);
          continue;
        }
        options.context.sources.capabilities.register(entry.kind,entry.capabilities);
        ownedKinds.add(entry.kind);ownedDescriptors.set(entry.kind,entry.capabilities);added.push(entry.kind);
      }
    }catch(error){rollbackDescriptors(added);throw error;}
    return added;
  };
  const rollbackDescriptors=(added:readonly string[])=>{
    for(const kind of added)if(!capabilityUsers.get(kind)&&ownedKinds.delete(kind)){
      ownedDescriptors.delete(kind);try{options.context.sources.capabilities.unregister(kind);}catch{}
    }
  };
  const installRefs=(manifest:ConnectorManifest)=>{
    const scope=scopeFor(manifest);
    for(const entry of manifest.sourceKinds){
      const kind=typeof entry==='string'?entry:entry.kind;
      if(!options.context.sources.capabilities.has(kind))throw Error(`Connector source kind ${kind} has no installed capability`);
      capabilityUsers.set(kind,(capabilityUsers.get(kind)??0)+1);
      scope.defer(()=>releaseCapability(kind));
    }
  };
  const installCapabilities=()=>{
    try{
      // Descriptors install first, independent of manifest order. A descriptor
      // already present is either adapter-owned (must match) or preinstalled
      // (must match and stays externally owned).
      for(const manifest of options.manifests)registerDescriptors(manifest);
      // Every manifest use, including a string reference, keeps the kind alive.
      for(const manifest of options.manifests)installRefs(manifest);
    }catch(error){
      for(const kind of ownedKinds)try{options.context.sources.capabilities.unregister(kind);}catch{}
      ownedKinds.clear();ownedDescriptors.clear();capabilityUsers.clear();throw error;
    }
  };
  const installCapabilitiesFor=(manifest:ConnectorManifest)=>{
    const added=registerDescriptors(manifest);
    try{installRefs(manifest);}catch(error){rollbackDescriptors(added);throw error;}
  };
  const http:ConnectorHttpHost={
    ownerRoute:(route,scope)=>options.dispatcher.registerOwnerRoute(scope,route),
    oauthCallback:(callback,scope)=>options.dispatcher.registerOAuthCallback(scope,callback),
  };
  const registry=new ConnectorRegistry(options.context,{
    http,scopeFor,statusScope:options.statusScope,manageCapabilities:false,
    ...(options.transport?{transport:options.transport}:{}),
    activationFor:(manifest:ConnectorManifest)=>activations.get(manifest.id),
    ...(options.stateFor?{stateFor:(_manifest:ConnectorManifest,scope?:HostScope)=>{
      if(!scope)throw Error('Connector state scope is unavailable');
      return options.stateFor!(scope);
    }}:{}),
  });
  const manifests=new Map(options.manifests.map(manifest=>[manifest.id,manifest])),retiring=new Set<Promise<void>>(),pendingHot=new Set<Promise<void>>(),hotById=new Map<string,Promise<void>>(),lateCleanupFailures:unknown[]=[];
  const scopeClosures=new WeakMap<ConnectorInstanceScope,Promise<void>>();
  const closeScope=(value:ConnectorInstanceScope)=>{
    let task=scopeClosures.get(value);
    if(!task){try{task=Promise.resolve(value.close());}catch(error){task=Promise.reject(error);}scopeClosures.set(value,task);}
    return task;
  };
  for(const manifest of options.manifests)registry.register(manifest);
  let started=false,closed=false,startTask:Promise<void>|undefined,teardown:Promise<void>|undefined,closing:Promise<void>|undefined;
  const startHot=async(manifest:ConnectorManifest)=>{
    if(scopes.has(manifest.id))throw Error(`Connector ${manifest.id} is already started`);
    const scope=options.scopeFor(manifest,manifest.id);scopes.set(manifest.id,scope);
    let added:string[]=[];
    try{
      added=registerDescriptors(manifest);installRefs(manifest);
      await registry.startInstance(manifest,scope.scope);
    }catch(error){
      const current=scopes.get(manifest.id)===scope,cleanupErrors:unknown[]=[];
      if(current)scopes.delete(manifest.id);
      rollbackDescriptors(added);
      if(isConnectorCleanupFailure(error))cleanupErrors.push(error);
      try{await closeScope(scope);}catch(cleanup){cleanupErrors.push(cleanup);}
      if(current)registry.recordFailure(manifest,cleanupErrors[0]??error);else registry.clearFailure(manifest.id);
      if(cleanupErrors.length)throw connectorCleanupFailure([error,...cleanupErrors]);
      throw error;
    }
  };
  const runHot=(manifest:ConnectorManifest)=>{
    const task=startHot(manifest);pendingHot.add(task);hotById.set(manifest.id,task);
    // Retain shutdown-owned cleanup failures before the task disappears from
    // pendingHot, so close cannot miss a settled late-disposal error.
    void task.catch(error=>{if(isConnectorCleanupFailure(error))lateCleanupFailures.push(error);});
    void task.finally(()=>{pendingHot.delete(task);if(hotById.get(manifest.id)===task)hotById.delete(manifest.id);}).catch(()=>{});
    return task;
  };
  const teardownInternal=()=>{
    if(teardown)return teardown;
    closed=true;
    teardown=(async()=>{
      const errors:unknown[]=[],startedScopes=new Map<ConnectorInstanceScope,Promise<void>>();
      const clean=async(work:()=>unknown|Promise<unknown>)=>{try{await work();}catch(error){errors.push(error);}};
      // Fence every instance before connector shutdown; accepted work may drain,
      // but new route/OAuth admission is rejected while close is in progress.
      for(const value of scopes.values()){
        if(value.fence)await clean(()=>value.fence!());
        else {const task=closeScope(value);startedScopes.set(value,task);void task.catch(()=>{});}
      }
      await clean(()=>registry.close());
      for(const value of [...scopes.values()].reverse())await clean(()=>startedScopes.get(value)??closeScope(value));
      for(const task of [...retiring])await clean(()=>task);
      if(errors.length)throw new AggregateError(errors,'Connector host adapter disposal failed');
    })();
    return teardown;
  };
  const close=()=>{
    if(closing)return closing;
    // Observe teardown rejection immediately; it may settle while a pending
    // init still blocks startTask.
    const settledInternal=teardownInternal().then(()=>({error:undefined}),error=>({error}));
    closing=(async()=>{
      // Join late factory/init cleanup; start's own rejection is observed by
      // its caller, while teardown cleanup errors remain aggregated here.
      await (startTask?.catch(()=>{})??Promise.resolve());
      while(pendingHot.size)await Promise.allSettled([...pendingHot]);
      const cleanupErrors=lateCleanupFailures.splice(0);
      const {error}=await settledInternal;
      if(error!==undefined)cleanupErrors.push(error);
      if(cleanupErrors.length)throw new AggregateError(cleanupErrors,'Connector host adapter disposal failed');
    })();
    return closing;
  };
  return Object.freeze({
    async start(){
      if(startTask)throw Error('Connector host adapter is already started');
      if(started)throw Error('Connector host adapter is already started');
      if(closed)throw Error('Connector host adapter is closed');
      startTask=(async()=>{
        try{
          installCapabilities();
          for(const manifest of options.manifests){
            const scope=scopes.get(manifest.id);if(!scope)throw Error('Connector scope is unavailable');
            try{await registry.startInstance(manifest,scope.scope);}
            catch(error){
              scopes.delete(manifest.id);
              const cleanupErrors:unknown[]=[];
              try{await closeScope(scope);}catch(cleanup){cleanupErrors.push(cleanup);}
              // A deployment module is explicit trusted startup input: its
              // failure aborts startup instead of serving a partial node.
              if(required.has(manifest.id)){
                if(cleanupErrors.length)throw connectorCleanupFailure([error,...cleanupErrors]);
                throw error;
              }
              if(cleanupErrors.length)registry.recordFailure(manifest,cleanupErrors[0]);
            }
          }
          if(closed)throw Error('Connector host adapter is closed');
          registry.mountStatus(options.statusScope);
          started=true;
        }catch(error){
          if(!started){try{await teardownInternal();}catch(cleanup){throw new AggregateError([error,cleanup],'Connector host adapter startup and disposal failed',{cause:error});}}
          throw error;
        }
      })();
      return startTask;
    },
    inventory:()=>registry.inventory(),
    executeAction:(id:string,request:ConnectorActionExecution)=>registry.executeAction(id,request),
    contributions:():HostContributionDescriptor[]=>registry.inventory().map(connector=>({
      id:'connector-instance:'+connector.id,version:connector.version,surface:'ingress',runtime:'host',
      featureId:'mote.connector.'+connector.id,featureVersion:connector.version,self:false,
      state:connector.active?'active':'unavailable',...(connector.active?{}:{reason:connector.state}),
      components:[{id:'connector:'+connector.id,version:connector.version,surface:'ingress',state:connector.active?'active' as const:'unavailable' as const,...(connector.active?{}:{reason:connector.state})}],
    })),
    configureSyncInterval:(intervalMs:number)=>registry.configureSyncInterval(intervalMs),
    async install(manifest:ConnectorManifest,activation?:ConnectorActivation){
      if(!started||closed)throw Error('Connector host adapter is not active');
      if(manifests.has(manifest.id)||scopes.has(manifest.id)||hotById.has(manifest.id))throw Error(`Connector ${manifest.id} is already known`);
      if(activation)activations.set(manifest.id,activation);else activations.delete(manifest.id);
      registry.addManifest(manifest);manifests.set(manifest.id,manifest);
      try{return await runHot(manifest);}catch(error){activations.delete(manifest.id);throw error;}
    },
    known:(id:string)=>manifests.has(id),
    async restart(id:string,activation?:ConnectorActivation){
      if(!started||closed)throw Error('Connector host adapter is not active');
      const manifest=manifests.get(id);if(!manifest)throw Error(`Connector ${id} is not known`);
      if(scopes.has(id)||hotById.has(id)||registry.inventory().some(item=>item.id===id&&item.state==='active'))throw Error(`Connector ${id} is already started`);
      if(activation)activations.set(id,activation);else activations.delete(id);
      return runHot(manifest);
    },
    async stop(id:string){
      if(closed)throw Error('Connector host adapter is closed');
      const task=(async()=>{
        const errors:unknown[]=[],value=scopes.get(id),attempt=hotById.get(id);if(value)scopes.delete(id);
        let scopeClosing:Promise<void>|undefined;
        // A close-only scope must stop admission before connector shutdown; a
        // fence scope is invoked by registry.stop before it closes the instance.
        if(value&&!value.fence){scopeClosing=closeScope(value);void scopeClosing.catch(()=>{});}
        try{await registry.stop(id,value?.fence?()=>value.fence!():undefined);}catch(error){errors.push(error);}
        if(value&&!scopeClosing){scopeClosing=closeScope(value);void scopeClosing.catch(()=>{});}
        if(scopeClosing)try{await scopeClosing;}catch(error){errors.push(error);}
        if(attempt)try{await attempt;}catch(error){if(isConnectorCleanupFailure(error))errors.push(error);}
        activations.delete(id);
        if(errors.length)throw new AggregateError(errors,'Connector instance stop failed');
      })();
      retiring.add(task);void task.catch(()=>{});
      try{return await task;}finally{retiring.delete(task);}
    },
    close,
  });
}
