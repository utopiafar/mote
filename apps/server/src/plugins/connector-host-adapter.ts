import type {HostScope} from '@mote/plugin-host';
import type {SourceCapabilityDescriptor} from '@mote/shared';
import type {ConnectorContext} from '../connectors/types.js';
import {ConnectorRegistry,type ConnectorHttpHost,type ConnectorInstance,type ConnectorManifest} from '../connectors/registry.js';
import type {DynamicHttpDispatcher} from './dynamic-http-dispatcher.js';

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
  /** Private trusted assembly context for existing built-in connectors. */
  readonly context:ConnectorContext;
  readonly dispatcher:DynamicHttpDispatcher;
  /** H05 fixes this to the actual installed instance scope. */
  readonly scopeFor:ConnectorScopeFactory;
  readonly statusScope:HostScope;
  /** Trusted transport slot only; ordinary plugins get no raw context here. */
  readonly transport?:(instance:ConnectorInstance)=>void|Promise<void>;
}
export interface ConnectorHostAdapter {
  start():Promise<void>;
  inventory():ReturnType<ConnectorRegistry['inventory']>;
  configureSyncInterval(intervalMs:number):void;
  /** Hot-stop one installed instance; sibling instances keep running. */
  stop(id:string):Promise<void>;
  close():Promise<void>;
}

/** Adapts the existing deployment-scoped ConnectorRegistry to the shared H05
 * dispatcher and H04 scopes. It is a trusted assembly bridge: it creates no
 * second host/registry and publishes no raw SourceStore/engine/materials API. */
const descriptorKey=(descriptor:SourceCapabilityDescriptor)=>JSON.stringify([descriptor.lifecycle,descriptor.discovery,descriptor.listening,descriptor.readOriginal,descriptor.synchronization,descriptor.externalWrite]);
export function createConnectorHostAdapter(options:ConnectorHostAdapterOptions):ConnectorHostAdapter {
  const scopes=new Map<string,ConnectorInstanceScope>(),capabilityUsers=new Map<string,number>(),ownedKinds=new Set<string>(),ownedDescriptors=new Map<string,SourceCapabilityDescriptor>();
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
  const installCapabilities=()=>{
    try{
      // Descriptors install first, independent of manifest order. A descriptor
      // already present is either adapter-owned (must match) or preinstalled
      // (must match and stays externally owned).
      for(const manifest of options.manifests)for(const entry of manifest.sourceKinds){
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
        ownedKinds.add(entry.kind);ownedDescriptors.set(entry.kind,entry.capabilities);
      }
      // Every manifest use, including a string reference, keeps the kind alive.
      for(const manifest of options.manifests){
        const scope=scopeFor(manifest);
        for(const entry of manifest.sourceKinds){
          const kind=typeof entry==='string'?entry:entry.kind;
          if(!options.context.sources.capabilities.has(kind))throw Error(`Connector source kind ${kind} has no installed capability`);
          capabilityUsers.set(kind,(capabilityUsers.get(kind)??0)+1);
          scope.defer(()=>releaseCapability(kind));
        }
      }
    }catch(error){
      for(const kind of ownedKinds)try{options.context.sources.capabilities.unregister(kind);}catch{}
      ownedKinds.clear();ownedDescriptors.clear();capabilityUsers.clear();throw error;
    }
  };
  const http:ConnectorHttpHost={
    ownerRoute:(route,scope)=>options.dispatcher.registerOwnerRoute(scope,route),
    oauthCallback:(callback,scope)=>options.dispatcher.registerOAuthCallback(scope,callback),
  };
  const registry=new ConnectorRegistry(undefined,options.context,{
    http,scopeFor,statusScope:options.statusScope,manageCapabilities:false,
    ...(options.transport?{transport:options.transport}:{}),
  });
  for(const manifest of options.manifests)registry.register(manifest);
  let started=false,closed=false,closing:Promise<void>|undefined;
  const close=()=>{
    if(closing)return closing;
    closed=true;
    closing=(async()=>{
      const errors:unknown[]=[],started=new Map<ConnectorInstanceScope,Promise<void>>();
      const clean=async(work:()=>unknown|Promise<unknown>)=>{try{await work();}catch(error){errors.push(error);}};
      // Fence every instance before connector shutdown; accepted work may drain,
      // but new route/OAuth admission is rejected while close is in progress.
      for(const value of scopes.values()){
        if(value.fence)await clean(()=>value.fence!());
        else started.set(value,value.close());
      }
      await clean(()=>registry.close());
      for(const value of [...scopes.values()].reverse())await clean(()=>started.get(value)??value.close());
      if(errors.length)throw new AggregateError(errors,'Connector host adapter disposal failed');
    })();
    return closing;
  };
  return Object.freeze({
    async start(){
      if(started)throw Error('Connector host adapter is already started');
      if(closed)throw Error('Connector host adapter is closed');
      try{installCapabilities();await registry.start();started=true;}
      catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Connector host adapter startup and disposal failed',{cause:error});}throw error;}
    },
    inventory:()=>registry.inventory(),
    configureSyncInterval:(intervalMs:number)=>registry.configureSyncInterval(intervalMs),
    async stop(id:string){
      if(closed)throw Error('Connector host adapter is closed');
      const errors:unknown[]=[],value=scopes.get(id);let started:Promise<void>|undefined;
      if(value?.fence)try{await value.fence();}catch(error){errors.push(error);}
      else if(value)started=value.close();
      try{await registry.stop(id);}catch(error){errors.push(error);}
      if(value)try{await (started??value.close());scopes.delete(id);}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,'Connector instance stop failed');
    },
    close,
  });
}
