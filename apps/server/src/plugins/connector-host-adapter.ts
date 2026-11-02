import type {HostScope} from '@mote/plugin-host';
import type {ConnectorContext} from '../connectors/types.js';
import {ConnectorRegistry,type ConnectorHttpHost,type ConnectorInstance,type ConnectorManifest} from '../connectors/registry.js';
import type {DynamicHttpDispatcher} from './dynamic-http-dispatcher.js';

/** H05-owned per-install scope. The factory is trusted assembly input, never a
 * consumer-selectable registration API. */
export interface ConnectorInstanceScope {
  readonly scope:HostScope;
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
export function createConnectorHostAdapter(options:ConnectorHostAdapterOptions):ConnectorHostAdapter {
  const scopes=new Map<string,ConnectorInstanceScope>(),capabilityRefs=new Map<string,number>();
  const scopeFor=(manifest:ConnectorManifest)=>{
    let value=scopes.get(manifest.id);
    if(!value){value=options.scopeFor(manifest,manifest.id);scopes.set(manifest.id,value);}
    value.scope.assertCurrent();return value.scope;
  };
  const installCapabilities=()=>{
    for(const manifest of options.manifests){
      const scope=scopeFor(manifest);
      for(const entry of manifest.sourceKinds){
        const kind=typeof entry==='string'?entry:entry.kind;
        if(typeof entry==='string'){
          if(!options.context.sources.capabilities.has(kind))throw Error(`Connector source kind ${kind} has no installed capability`);
          continue;
        }
        const count=capabilityRefs.get(kind)??0;
        if(count===0)options.context.sources.capabilities.register(kind,entry.capabilities);
        capabilityRefs.set(kind,count+1);
        scope.defer(()=>{
          const current=capabilityRefs.get(kind)??0;
          if(current<=1){try{options.context.sources.capabilities.unregister(kind);}finally{capabilityRefs.delete(kind);}}
          else capabilityRefs.set(kind,current-1);
        });
      }
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
      const errors:unknown[]=[];
      const clean=async(work:()=>unknown|Promise<unknown>)=>{try{await work();}catch(error){errors.push(error);}};
      await clean(()=>registry.close());
      for(const value of [...scopes.values()].reverse())await clean(()=>value.close());
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
      const errors:unknown[]=[];
      try{await registry.stop(id);}catch(error){errors.push(error);}
      const value=scopes.get(id);
      if(value)try{await value.close();scopes.delete(id);}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,'Connector instance stop failed');
    },
    close,
  });
}
