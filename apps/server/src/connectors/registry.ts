import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {HostScope} from '@mote/plugin-host';
import type {StopReason} from '@mote/plugin-api/contracts';
import {sourceKindSchema,type SourceCapabilityDescriptor} from '@mote/shared';
import {z} from 'zod';
import {equalToken} from './mcp.js';
import {ConnectorError,type ConnectorContext} from './types.js';

type Method='GET'|'POST'|'PUT'|'DELETE';
export type OwnerRoute={
  method:Method;
  path:`/api/connectors/${string}`;
  handler:(request:FastifyRequest,reply:FastifyReply)=>unknown;
  bodyLimit?:number;
};
export type OAuthCallback={
  path:`/oauth/${string}/callback`;
  /** A specific prefix wins over the callback without a prefix at the same path. */
  statePrefix?:string;
  complete:(state:string,code:string)=>Promise<unknown>;
  successMessage:string;
  failureMessage:string;
};
export interface ConnectorHost {
  /** Owner authorization and operation error handling are applied by the host. */
  ownerRoute(route:OwnerRoute):void;
  /** The host validates callback inputs and sets restrictive response headers. */
  oauthCallback(callback:OAuthCallback):void;
}
export type ConnectorInstanceState='active'|'failed'|'blocked';
export interface ConnectorInventoryEntry {id:string;version:string;sourceKinds:string[];active:boolean;state:ConnectorInstanceState;error?:string}
export interface ConnectorRouteHandle {release(reason?:StopReason):Promise<void>}
/** Trusted H05/29 assembly seam. The dispatcher-backed adapter supplies it; ordinary
 * consumers never receive this registration object. */
export interface ConnectorHttpHost {
  ownerRoute(route:OwnerRoute,scope:HostScope):ConnectorRouteHandle;
  oauthCallback(callback:OAuthCallback,scope:HostScope):ConnectorRouteHandle;
}
export interface ConnectorRegistryOptions {
  readonly http?:ConnectorHttpHost;
  /** Fixed by H05 to the actual installed instance scope, never consumer-selectable. */
  readonly scopeFor?:(manifest:ConnectorManifest)=>HostScope;
  readonly statusScope?:HostScope;
  /** Trusted transport mount only (for example the existing MCP Fastify transport). */
  readonly transport?:(instance:ConnectorInstance)=>void|Promise<void>;
  /** The adapter installs per-instance capabilities itself. */
  readonly manageCapabilities?:boolean;
}
export interface ConnectorInstance {
  init?():Promise<void>;
  /** Replace future polling timers without cancelling an operation already in progress. */
  configureSyncInterval?(intervalMs:number):void;
  configure?(host:ConnectorHost):void;
  status?():unknown;
  /** Only trusted deployment modules should mount a custom transport with its own authorization. */
  mountTransport?(app:FastifyInstance):void|Promise<void>;
  close?():void|Promise<void>;
}
export interface ConnectorManifest {
  apiVersion:1;
  id:string;
  /** Existing built-in kinds can be named; new namespaced kinds require a capability descriptor. */
  sourceKinds:readonly (string|{kind:string;capabilities:SourceCapabilityDescriptor})[];
  /** Optional key in GET /api/connectors/status. */
  statusKey?:string;
  create(context:ConnectorContext):ConnectorInstance|Promise<ConnectorInstance>;
}

const descriptorSchema=z.object({
  lifecycle:z.enum(['continuous','one-shot','external-push']),
  discovery:z.enum(['local-selection','provider-list','explicit-selection']),
  listening:z.enum(['filesystem','polling','none']),
  readOriginal:z.enum(['collector-request','explicit-provider-read','none']),
  synchronization:z.enum(['revisions','import-only','push-only']),
  externalWrite:z.literal(false),
}).strict();
const connectorId=/^[a-z][a-z0-9-]{0,63}$/;
const failureCode=(error:unknown,fallback:string)=>{
  const code=(error as {code?:unknown})?.code;
  return typeof code==='string'&&/^[a-z][a-z0-9_.:-]{0,99}$/.test(code)?code:fallback;
};
const oauthPath=/^\/oauth\/[a-z][a-z0-9-]*\/callback$/;

/** A deployment scoped registry: plugins are explicit trusted code, archive contents are never loaded as code. */
export class ConnectorRegistry {
  private manifests:ConnectorManifest[]=[];
  private instances:{manifest:ConnectorManifest;instance:ConnectorInstance;scope?:HostScope;disposed?:boolean}[]=[];
  private failures=new Map<string,{manifest:ConnectorManifest;state:'failed'|'blocked';error:string}>();
  private routes:OwnerRoute[]=[];
  private callbacks:OAuthCallback[]=[];
  private addedKinds:string[]=[];
  private statusHandle?:ConnectorRouteHandle;
  private started=false;
  private closed=false;
  private closing?:Promise<void>;
  constructor(private app:FastifyInstance|undefined,private context:ConnectorContext,private options:ConnectorRegistryOptions={}){}

  register(value:unknown,hot=false){
    if(this.closed||(!hot&&this.started))throw Error('Connector registry is already started');
    if(!value||typeof value!=='object')throw Error('Invalid connector manifest');
    const manifest=value as ConnectorManifest;
    if(manifest.apiVersion!==1||typeof manifest.id!=='string'||!connectorId.test(manifest.id)||typeof manifest.create!=='function'||!Array.isArray(manifest.sourceKinds)||manifest.sourceKinds.length>20||manifest.statusKey!==undefined&&(typeof manifest.statusKey!=='string'||!connectorId.test(manifest.statusKey)))throw Error('Invalid connector manifest');
    if(this.manifests.some(other=>other.id===manifest.id))throw Error(`Connector ${manifest.id} is already registered`);
    if(manifest.statusKey&&this.manifests.some(other=>other.statusKey===manifest.statusKey))throw Error(`Connector status ${manifest.statusKey} is already registered`);
    for(const item of manifest.sourceKinds){
      const kind=typeof item==='string'?item:item?.kind;
      sourceKindSchema.parse(kind);
      if(typeof item!=='string')descriptorSchema.parse(item.capabilities);
    }
    this.manifests.push(manifest);
  }
  addManifest(value:unknown){this.register(value,true);}
  manifest(id:string){return this.manifests.find(manifest=>manifest.id===id);}

  async loadModules(specifiers:readonly string[]){
    for(const specifier of specifiers){
      if(typeof specifier!=='string'||!specifier||specifier.length>2000||/[\r\n\0]/.test(specifier)||/^[a-z][a-z0-9+.-]*:/i.test(specifier)&&!specifier.startsWith('file:'))throw Error('Invalid connector module specifier');
      const exports=await import(specifier) as {default?:unknown;connector?:unknown};
      this.register(exports.default??exports.connector);
    }
  }

  async start(){
    if(this.started||this.closed)throw Error('Connector registry is already started');
    this.started=true;
    try{
      if(this.options.manageCapabilities!==false)for(const manifest of this.manifests)for(const entry of manifest.sourceKinds){
        const kind=typeof entry==='string'?entry:entry.kind;
        if(typeof entry==='string'){
          if(!this.context.sources.capabilities.has(kind))throw Error(`Connector source kind ${kind} has no installed capability`);
        }else{
          this.context.sources.capabilities.register(kind,entry.capabilities);
          this.addedKinds.push(kind);
        }
      }
      for(const manifest of this.manifests){
        const scope=this.options.scopeFor?.(manifest);
        if(this.options.http&&!scope)throw Error('Connector scope is unavailable');
        const instance=await manifest.create(this.context);
        if(!instance||typeof instance!=='object')throw Error(`Connector ${manifest.id} did not create an instance`);
        const disposedLate=async()=>{
          try{await instance.close?.();}catch(cleanup){throw new AggregateError([Error('Connector registry is closed'),cleanup],'Connector late initialization and disposal failed');}
          throw Error('Connector registry is closed');
        };
        if(this.closed)await disposedLate();
        const entry={manifest,instance,...(scope?{scope}:{}),disposed:false};this.instances.push(entry);
        if(this.closed){this.instances.splice(this.instances.indexOf(entry),1);if(!entry.disposed){entry.disposed=true;await disposedLate();}throw Error('Connector registry is closed');}
        await instance.init?.();
        if(this.closed){
          // close() may already own this instance while init was pending; never
          // invoke a non-idempotent connector close a second time.
          if(!entry.disposed){entry.disposed=true;await disposedLate();}
          throw Error('Connector registry is closed');
        }
      }
      if(this.closed)throw Error('Connector registry is closed');
      if(this.options.http){
        if(!this.options.statusScope)throw Error('Connector status scope is unavailable');
        this.mountStatus(this.options.statusScope);
        for(const {instance,scope} of this.instances)instance.configure?.({
          ownerRoute:route=>{if(!scope)throw Error('Connector scope is unavailable');this.options.http!.ownerRoute(route,scope);},
          oauthCallback:callback=>{if(!scope)throw Error('Connector scope is unavailable');this.options.http!.oauthCallback(callback,scope);},
        });
        for(const {instance} of this.instances)if(instance.mountTransport){
          if(!this.options.transport)throw Error('Connector transport is unavailable');
          await this.options.transport(instance);
        }
      }else{
        const host:ConnectorHost={ownerRoute:route=>this.addOwnerRoute(route),oauthCallback:callback=>this.addOAuthCallback(callback)};
        for(const {instance} of this.instances)instance.configure?.(host);
        this.mount();
        for(const {instance} of this.instances)await instance.mountTransport?.(this.app!);
      }
      return this;
    }catch(error){try{await this.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Connector initialization and disposal failed',{cause:error});}throw error;}
  }

  private statusView(){return Object.fromEntries(this.instances.flatMap(({manifest,instance})=>manifest.statusKey&&instance.status?[[manifest.statusKey,instance.status()]]:[]));}
  mountStatus(scope:HostScope){
    if(!this.options.http)throw Error('Connector HTTP host is unavailable');
    if(this.statusHandle)throw Error('Connector status is already mounted');
    this.statusHandle=this.options.http.ownerRoute({method:'GET',path:'/api/connectors/status',handler:()=>this.statusView()},scope);
  }
  recordFailure(manifest:ConnectorManifest,error:unknown,state:'failed'|'blocked'='failed'){
    this.failures.set(manifest.id,{manifest,state,error:failureCode(error,state==='blocked'?'connector_blocked':'connector_failed')});
  }
  clearFailure(id:string){this.failures.delete(id);}
  /** Start one connector instance. Failure rolls back only this entry and its
   * instance; the caller owns the H04 scope and releases routes/capabilities. */
  async startInstance(manifest:ConnectorManifest,scope:HostScope){
    const http=this.options.http;if(!http)throw Error('Connector HTTP host is unavailable');
    if(this.closed)throw Error('Connector registry is closed');
    if(this.instances.some(entry=>entry.manifest.id===manifest.id))throw Error(`Connector ${manifest.id} is already started`);
    scope.assertCurrent();
    let instance:ConnectorInstance|undefined;
    try{instance=await manifest.create(this.context);}catch(error){this.recordFailure(manifest,error);throw error;}
    if(!instance||typeof instance!=='object'){this.recordFailure(manifest,Error('Invalid connector instance'),'failed');throw Error(`Connector ${manifest.id} did not create an instance`);}
    try{scope.assertCurrent();}catch(error){try{await instance.close?.();}catch(cleanup){throw new AggregateError([error,cleanup],'Connector late initialization and disposal failed',{cause:error});}throw error;}
    if(this.closed){
      try{await instance.close?.();}catch(cleanup){throw new AggregateError([Error('Connector registry is closed'),cleanup],'Connector late initialization and disposal failed');}
      throw Error('Connector registry is closed');
    }
    const entry={manifest,instance,scope,disposed:false};this.instances.push(entry);
    try{
      if(this.closed){const index=this.instances.indexOf(entry);if(index>=0)this.instances.splice(index,1);entry.disposed=true;await instance.close?.();throw Error('Connector registry is closed');}
      await instance.init?.();
      scope.assertCurrent();
      if(this.closed)throw Error('Connector registry is closed');
      instance.configure?.({
        ownerRoute:route=>http.ownerRoute(route,scope),
        oauthCallback:callback=>http.oauthCallback(callback,scope),
      });
      if(instance.mountTransport){
        if(!this.options.transport)throw Error('Connector transport is unavailable');
        await this.options.transport(instance);
      }
      this.clearFailure(manifest.id);
    }catch(error){
      const index=this.instances.indexOf(entry);if(index>=0)this.instances.splice(index,1);
      this.recordFailure(manifest,error);
      if(!entry.disposed){entry.disposed=true;try{await instance.close?.();}catch(cleanup){throw new AggregateError([error,cleanup],'Connector instance startup and disposal failed',{cause:error});}}
      throw error;
    }
  }
  async stop(id:string,beforeClose?:()=>void|Promise<void>){
    const index=this.instances.findIndex(item=>item.manifest.id===id);if(index<0){this.clearFailure(id);return;}
    const [entry]=this.instances.splice(index,1);
    entry.disposed=true;
    const errors:unknown[]=[];
    if(beforeClose)try{await beforeClose();}catch(error){errors.push(error);}
    try{await entry.instance.close?.();}catch(error){errors.push(error);}
    if(errors.length){this.recordFailure(entry.manifest,errors[0]);throw new AggregateError(errors,'Connector instance stop failed');}
    this.clearFailure(id);
  }

  private addOwnerRoute(route:OwnerRoute){
    if(!['GET','POST','PUT','DELETE'].includes(route.method)||!/^\/api\/connectors\/[a-z0-9][a-z0-9_/-]*$/.test(route.path)||route.path==='/api/connectors/status'||typeof route.handler!=='function')throw Error('Invalid connector owner route');
    if(this.routes.some(other=>other.method===route.method&&other.path===route.path))throw Error(`Connector route ${route.method} ${route.path} is already registered`);
    this.routes.push(route);
  }
  private addOAuthCallback(callback:OAuthCallback){
    if(!oauthPath.test(callback.path)||typeof callback.complete!=='function'||typeof callback.successMessage!=='string'||typeof callback.failureMessage!=='string'||callback.statePrefix!==undefined&&(typeof callback.statePrefix!=='string'||!callback.statePrefix||callback.statePrefix.length>80||/[\r\n\0]/.test(callback.statePrefix)))throw Error('Invalid connector OAuth callback');
    if(this.callbacks.some(other=>other.path===callback.path&&other.statePrefix===callback.statePrefix))throw Error(`Connector OAuth callback ${callback.path} is already registered`);
    this.callbacks.push(callback);
  }
  private mount(){
    const app=this.app;if(!app)throw Error('Connector Fastify host is unavailable');
    const owner=async(request:FastifyRequest,reply:FastifyReply)=>{
      if(!(this.context.ownerAuthorization?.(request.headers.authorization)??equalToken(request.headers.authorization,this.context.config.token)))return reply.code(401).send({error:'unauthorized'});
      reply.header('Cache-Control','no-store');
    };
    const action=(handler:OwnerRoute['handler'])=>async(request:FastifyRequest,reply:FastifyReply)=>{
      try{return await handler(request,reply);}catch(error){
        const known=error instanceof ConnectorError;
        return reply.code(known?error.statusCode:error instanceof z.ZodError?400:502).send({error:known?error.code:error instanceof z.ZodError?'connector_input_invalid':'connector_operation_failed',requestId:request.id});
      }
    };
    app.get('/api/connectors/status',{onRequest:owner},()=>Object.fromEntries(this.instances.flatMap(({manifest,instance})=>manifest.statusKey&&instance.status?[[manifest.statusKey,instance.status()]]:[])));
    for(const route of this.routes)app.route({method:route.method,url:route.path,onRequest:owner,...(route.bodyLimit?{bodyLimit:route.bodyLimit}:{}),handler:action(route.handler)});
    for(const path of new Set(this.callbacks.map(callback=>callback.path))){
      const candidates=this.callbacks.filter(callback=>callback.path===path);
      if(candidates.filter(callback=>!callback.statePrefix).length>1)throw Error(`Connector OAuth callback ${path} has multiple defaults`);
      app.get(path,async(request,reply)=>{
        reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',"default-src 'none'; style-src 'none'");
        const fallback=candidates.find(callback=>!callback.statePrefix);
        let selected=fallback??candidates[0]!;
        try{
          const input=z.object({state:z.string().min(20).max(200),code:z.string().min(1).max(4096)}).passthrough().parse(request.query);
          const matched=candidates.filter(callback=>callback.statePrefix&&input.state.startsWith(callback.statePrefix)).sort((a,b)=>b.statePrefix!.length-a.statePrefix!.length)[0];
          if(!matched&&!fallback)throw new ConnectorError('oauth_state_unrecognized',400);
          selected=matched??fallback!;
          await selected.complete(input.state,input.code);
          return reply.type('text/plain; charset=utf-8').send(selected.successMessage);
        }catch{return reply.code(400).type('text/plain; charset=utf-8').send(selected.failureMessage);}
      });
    }
  }
  inventory():ConnectorInventoryEntry[]{
    const active:ConnectorInventoryEntry[]=this.instances.map(({manifest})=>({id:manifest.id,version:String(manifest.apiVersion),sourceKinds:manifest.sourceKinds.map(k=>typeof k==='string'?k:k.kind),active:!this.closed,state:'active'}));
    const failed:ConnectorInventoryEntry[]=[...this.failures.values()].filter(value=>!this.instances.some(entry=>entry.manifest.id===value.manifest.id)).map(({manifest,state,error})=>({id:manifest.id,version:String(manifest.apiVersion),sourceKinds:manifest.sourceKinds.map(k=>typeof k==='string'?k:k.kind),active:false,state,error}));
    return [...active,...failed].sort((a,b)=>a.id.localeCompare(b.id));
  }
  configureSyncInterval(intervalMs:number){
    if(this.closed)return;
    z.number().int().positive().max(2_147_483_647).parse(intervalMs);
    const config=this.context.config.connectors??={directory:`${this.context.config.dataDir}/connectors`};
    config.syncIntervalMs=intervalMs;
    for(const {instance} of this.instances)instance.configureSyncInterval?.(intervalMs);
  }
  close(){return this.closing??=(async()=>{
    this.closed=true;
    const errors:unknown[]=[];
    // Fence status before disposing instances; the status scope itself may be
    // shared, so release only this registration instead of closing it.
    const status=this.statusHandle;this.statusHandle=undefined;
    if(status)try{await status.release('shutdown');}catch(error){errors.push(error);}
    for(const entry of [...this.instances].reverse()){entry.disposed=true;try{await entry.instance.close?.();}catch(error){errors.push(error);}}
    for(const kind of this.addedKinds)try{this.context.sources.capabilities.unregister(kind);}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Connector disposal failed');
  })();}
}
