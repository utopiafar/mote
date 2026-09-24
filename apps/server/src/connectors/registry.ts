import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
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
  rateLimit?:{max:number;timeWindow:string};
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
export interface ConnectorInstance {
  init?():Promise<void>;
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
const oauthPath=/^\/oauth\/[a-z][a-z0-9-]*\/callback$/;

/** A deployment scoped registry: plugins are explicit trusted code, archive contents are never loaded as code. */
export class ConnectorRegistry {
  private manifests:ConnectorManifest[]=[];
  private instances:{manifest:ConnectorManifest;instance:ConnectorInstance}[]=[];
  private routes:OwnerRoute[]=[];
  private callbacks:OAuthCallback[]=[];
  private addedKinds:string[]=[];
  private started=false;
  private closed=false;
  constructor(private app:FastifyInstance,private context:ConnectorContext){}

  register(value:unknown){
    if(this.started||this.closed)throw Error('Connector registry is already started');
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
      for(const manifest of this.manifests)for(const entry of manifest.sourceKinds){
        const kind=typeof entry==='string'?entry:entry.kind;
        if(typeof entry==='string'){
          if(!this.context.sources.capabilities.has(kind))throw Error(`Connector source kind ${kind} has no installed capability`);
        }else{
          this.context.sources.capabilities.register(kind,entry.capabilities);
          this.addedKinds.push(kind);
        }
      }
      for(const manifest of this.manifests){
        const instance=await manifest.create(this.context);
        if(!instance||typeof instance!=='object')throw Error(`Connector ${manifest.id} did not create an instance`);
        this.instances.push({manifest,instance});
        await instance.init?.();
      }
      const host:ConnectorHost={
        ownerRoute:route=>this.addOwnerRoute(route),
        oauthCallback:callback=>this.addOAuthCallback(callback),
      };
      for(const {instance} of this.instances)instance.configure?.(host);
      this.mount();
      for(const {instance} of this.instances)await instance.mountTransport?.(this.app);
      return this;
    }catch(error){await this.close().catch(()=>{});throw error;}
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
    const owner=async(request:FastifyRequest,reply:FastifyReply)=>{
      if(!equalToken(request.headers.authorization,this.context.config.token))return reply.code(401).send({error:'unauthorized'});
      reply.header('Cache-Control','no-store');
    };
    const action=(handler:OwnerRoute['handler'])=>async(request:FastifyRequest,reply:FastifyReply)=>{
      try{return await handler(request,reply);}catch(error){
        const known=error instanceof ConnectorError;
        return reply.code(known?error.statusCode:error instanceof z.ZodError?400:502).send({error:known?error.code:error instanceof z.ZodError?'connector_input_invalid':'connector_operation_failed',requestId:request.id});
      }
    };
    this.app.get('/api/connectors/status',{onRequest:owner},()=>Object.fromEntries(this.instances.flatMap(({manifest,instance})=>manifest.statusKey&&instance.status?[[manifest.statusKey,instance.status()]]:[])));
    for(const route of this.routes)this.app.route({method:route.method,url:route.path,onRequest:owner,...(route.bodyLimit?{bodyLimit:route.bodyLimit}:{}),...(route.rateLimit?{config:{rateLimit:route.rateLimit}}:{}),handler:action(route.handler)});
    for(const path of new Set(this.callbacks.map(callback=>callback.path))){
      const candidates=this.callbacks.filter(callback=>callback.path===path);
      if(candidates.filter(callback=>!callback.statePrefix).length>1)throw Error(`Connector OAuth callback ${path} has multiple defaults`);
      this.app.get(path,async(request,reply)=>{
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
  async close(){
    if(this.closed)return;
    this.closed=true;
    let failure:unknown,failed=false;
    for(const {instance} of [...this.instances].reverse())try{await instance.close?.();}catch(error){if(!failed){failure=error;failed=true;}}
    for(const kind of this.addedKinds)this.context.sources.capabilities.unregister(kind);
    if(failed)throw failure;
  }
}
