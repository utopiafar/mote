import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {StopReason} from '@mote/plugin-api/contracts';
import type {HostScope} from '@mote/plugin-host';
import {Readable} from 'node:stream';
import {z,ZodError} from 'zod';

type OwnerMethod='GET'|'POST'|'PUT'|'DELETE';
export interface DynamicOwnerRoute {
  readonly method:OwnerMethod;
  readonly path:`/api/connectors/${string}`;
  readonly handler:(request:FastifyRequest,reply:FastifyReply)=>unknown;
  /** Preserved current per-route body limit. The static route keeps Fastify's outer bound. */
  readonly bodyLimit?:number;
}
export interface DynamicOAuthCallback {
  readonly path:`/oauth/${string}/callback`;
  /** A specific prefix wins over the callback without a prefix at the same path. */
  readonly statePrefix?:string;
  readonly complete:(state:string,code:string)=>Promise<unknown>;
  readonly successMessage:string;
  readonly failureMessage:string;
}
export interface DynamicHttpRouteHandle {release(reason?:StopReason):Promise<void>}
export interface DynamicHttpErrorResponse {readonly status:number;readonly error:string}
export interface DynamicHttpDispatcherOptions {
  /** Existing owner authorization (C04/H assembly). Return false or throw to reject. */
  readonly authorize:(request:FastifyRequest)=>boolean;
  /** C12 adapter keeps its existing ConnectorError/Zod response mapping. */
  readonly mapError?:(error:unknown,request:FastifyRequest)=>DynamicHttpErrorResponse|undefined;
  /** Observation only; route removal and drain still complete after an error. */
  readonly onError?:(error:unknown)=>void;
}

export type DynamicHttpErrorCode='invalid_route'|'route_conflict'|'oauth_default_conflict'|'dispatcher_closed'|'dispatcher_attached';
export class DynamicHttpError extends Error {
  constructor(readonly code:DynamicHttpErrorCode,readonly statusCode=409){super(code);this.name='DynamicHttpError';}
}

interface EntryBase {
  active:boolean;
  readonly scope:HostScope;
  readonly inflight:Set<Promise<unknown>>;
  abort?:()=>void;
  released?:Promise<void>;
  remove():void;
}
interface OwnerEntry extends EntryBase {readonly kind:'owner';readonly route:DynamicOwnerRoute}
interface OAuthEntry extends EntryBase {readonly kind:'oauth';readonly callback:DynamicOAuthCallback}
type Entry=OwnerEntry|OAuthEntry;
interface OAuthGroup {readonly callbacks:Map<string,OAuthEntry>;first?:OAuthEntry;default?:OAuthEntry}

const ownerMethods:ReadonlySet<string>=new Set(['GET','POST','PUT','DELETE']);
const ownerPath=/^\/api\/connectors\/[a-z0-9][a-z0-9_/-]*$/;
const oauthPath=/^\/oauth\/[a-z][a-z0-9-]*\/callback$/;
const oauthQuery=z.object({state:z.string().min(20).max(200),code:z.string().min(1).max(4096)}).passthrough();
const RELEASED=Symbol('dynamic-http-released');
type Admission=typeof RELEASED|{value:unknown}|{error:unknown};

const requestPath=(request:FastifyRequest)=>{
  const url=request.raw.url??request.url,index=url.indexOf('?');
  return index<0?url:url.slice(0,index);
};
const defaultError=(error:unknown):DynamicHttpErrorResponse=>{
  if(error instanceof ZodError)return {status:400,error:'connector_input_invalid'};
  const value=error as {name?:unknown;code?:unknown;statusCode?:unknown};
  if(value?.name==='ConnectorError'&&typeof value.code==='string'&&Number.isInteger(value.statusCode)&&(value.statusCode as number)>=400&&(value.statusCode as number)<=599)return {status:value.statusCode as number,error:value.code};
  return {status:502,error:'connector_operation_failed'};
};
const bodyTooLarge=()=>Object.assign(new Error('Connector request body is too large'),{statusCode:413,code:'FST_ERR_CTP_BODY_TOO_LARGE'});

/** One host-owned dispatch table behind two routes registered before Fastify listen.
 * It is not another PluginHost: H04's HostScope owns admission, drain and scope cleanup. */
class DynamicHttpDispatcherImpl {
  private attached?:FastifyInstance;
  private closed=false;
  private closing?:Promise<void>;
  private readonly owner=new Map<string,OwnerEntry>();
  private readonly oauth=new Map<string,OAuthGroup>();
  private readonly registered=new Set<Entry>();
  private readonly admitted=new WeakMap<FastifyRequest,OwnerEntry>();
  constructor(private readonly options:DynamicHttpDispatcherOptions){}
  attach(app:FastifyInstance){
    if(this.closed)throw new DynamicHttpError('dispatcher_closed');
    if(this.attached)throw new DynamicHttpError('dispatcher_attached');
    if(app.server.listening)throw new DynamicHttpError('dispatcher_attached');
    app.route({method:['GET','POST','PUT','DELETE'],url:'/api/connectors/*',
      onRequest:async(request,reply)=>{
        const entry=this.owner.get(`${request.method} ${requestPath(request)}`);
        if(!entry||!entry.active)return reply.code(404).send({error:'connector_route_unavailable',requestId:request.id});
        let allowed=false;try{allowed=this.options.authorize(request);}catch{allowed=false;}
        if(!allowed)return reply.code(401).send({error:'unauthorized'});
        reply.header('Cache-Control','no-store');this.admitted.set(request,entry);
      },
      preParsing:(request,_reply,payload,done)=>{
        const limit=this.admitted.get(request)?.route.bodyLimit;
        if(limit===undefined){done(null,payload);return;}
        // Count raw wire bytes before parsing; reserializing parsed JSON would let
        // whitespace hide an oversized chunked request. Buffering is bounded by
        // the registered limit and replay preserves the original bytes.
        const chunks:Buffer[]=[];let bytes=0,settled=false;
        const finish=(error?:Error)=>{
          if(settled)return;settled=true;
          if(error){payload.pause();done(error);return;}
          done(null,Readable.from(chunks));
        };
        payload.on('data',(chunk:Buffer)=>{if(settled)return;bytes+=chunk.length;if(bytes>limit){finish(bodyTooLarge());return;}chunks.push(chunk);});
        payload.on('end',()=>finish());
        payload.on('error',error=>finish(error));
      },
      handler:(request,reply)=>this.dispatchOwner(request,reply)});
    app.get('/oauth/:provider/callback',(request,reply)=>this.dispatchOAuth(request,reply));
    app.addHook('onClose',async()=>{await this.close();});
    this.attached=app;
  }
  registerOwnerRoute(scope:HostScope,route:DynamicOwnerRoute):DynamicHttpRouteHandle {
    if(this.closed)throw new DynamicHttpError('dispatcher_closed');
    scope.assertCurrent();
    if(!ownerMethods.has(route.method)||!ownerPath.test(route.path)||typeof route.handler!=='function'||route.bodyLimit!==undefined&&(!Number.isSafeInteger(route.bodyLimit)||route.bodyLimit<1))throw new DynamicHttpError('invalid_route',400);
    const key=`${route.method} ${route.path}`;
    if(this.owner.has(key))throw new DynamicHttpError('route_conflict');
    const entry:OwnerEntry={kind:'owner',route,scope,active:true,inflight:new Set(),remove:()=>{}};
    entry.remove=()=>{if(this.owner.get(key)===entry)this.owner.delete(key);};
    this.owner.set(key,entry);this.registered.add(entry);this.bind(entry);
    return Object.freeze({release:()=>this.release(entry)});
  }
  registerOAuthCallback(scope:HostScope,callback:DynamicOAuthCallback):DynamicHttpRouteHandle {
    if(this.closed)throw new DynamicHttpError('dispatcher_closed');
    scope.assertCurrent();
    if(!oauthPath.test(callback.path)||typeof callback.complete!=='function'||typeof callback.successMessage!=='string'||typeof callback.failureMessage!=='string'||callback.statePrefix!==undefined&&(typeof callback.statePrefix!=='string'||!callback.statePrefix||callback.statePrefix.length>80||/[\r\n\0]/.test(callback.statePrefix)))throw new DynamicHttpError('invalid_route',400);
    const prefix=callback.statePrefix??'',group=this.oauth.get(callback.path)??{callbacks:new Map<string,OAuthEntry>()};
    if(prefix===''&&group.default)throw new DynamicHttpError('oauth_default_conflict');
    if(group.callbacks.has(prefix))throw new DynamicHttpError('route_conflict');
    const entry:OAuthEntry={kind:'oauth',callback,scope,active:true,inflight:new Set(),remove:()=>{}};
    entry.remove=()=>{
      const current=this.oauth.get(callback.path);if(!current)return;
      // A stopped scope may be replaced before its deferred release runs; only
      // remove this exact registration, never the replacement at the same prefix.
      if(current.callbacks.get(prefix)===entry)current.callbacks.delete(prefix);
      if(current.default===entry)delete current.default;
      if(current.first===entry)current.first=current.callbacks.values().next().value;
      if(!current.callbacks.size)this.oauth.delete(callback.path);
    };
    group.callbacks.set(prefix,entry);group.first??=entry;if(prefix==='')group.default=entry;this.oauth.set(callback.path,group);
    this.registered.add(entry);this.bind(entry);
    return Object.freeze({release:()=>this.release(entry)});
  }
  private bind(entry:Entry){
    const scope=entry.scope,invalidate=()=>{entry.active=false;entry.remove();};
    entry.abort=invalidate;scope.signal.addEventListener('abort',invalidate,{once:true});
    try{scope.defer(()=>this.release(entry));}
    catch(error){scope.signal.removeEventListener('abort',invalidate);entry.remove();throw error;}
  }
  private release(entry:Entry):Promise<void> {
    if(entry.released)return entry.released;
    entry.active=false;entry.remove();
    if(entry.abort){entry.scope.signal.removeEventListener('abort',entry.abort);entry.abort=undefined;}
    const settling=(async()=>{
      const results=await Promise.allSettled([...entry.inflight]);
      const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
      for(const error of errors)try{this.options.onError?.(error);}catch{}
      if(errors.length)throw new AggregateError(errors,'Dynamic HTTP route release failed');
    })();
    entry.released=settling.finally(()=>{this.registered.delete(entry);});
    return entry.released;
  }
  private admit(entry:Entry,work:()=>unknown|Promise<unknown>):Promise<Admission|undefined> {
    return entry.scope.run(async()=>{
      if(!entry.active)return RELEASED;
      try{entry.scope.assertCurrent();return {value:await work()};}
      catch(error){return {error};}
    });
  }
  private async dispatchOwner(request:FastifyRequest,reply:FastifyReply){
    const entry=this.admitted.get(request);
    if(!entry||!entry.active)return reply.code(404).send({error:'connector_route_unavailable',requestId:request.id});
    const task=this.admit(entry,()=>entry.route.handler(request,reply));
    entry.inflight.add(task);void task.then(()=>entry.inflight.delete(task),()=>entry.inflight.delete(task));
    let result:Admission|undefined;try{result=await task;}catch(error){return this.sendError(error,request,reply);}
    if(result===undefined)return reply.code(503).send({error:'feature_unavailable',requestId:request.id});
    if(result===RELEASED)return reply.code(404).send({error:'connector_route_unavailable',requestId:request.id});
    if('error' in result)return this.sendError(result.error,request,reply);
    return result.value;
  }
  private async dispatchOAuth(request:FastifyRequest,reply:FastifyReply){
    const group=this.oauth.get(requestPath(request));
    if(!group)return reply.code(404).send({error:'not_found'});
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',"default-src 'none'; style-src 'none'");
    const fallback=group.default??group.first;
    if(!fallback)return reply.code(404).send({error:'not_found'});
    let selected=fallback;
    try{
      const input=oauthQuery.parse(request.query);
      const matched=[...group.callbacks.values()].filter(entry=>entry.active&&entry.callback.statePrefix&&input.state.startsWith(entry.callback.statePrefix)).sort((a,b)=>b.callback.statePrefix!.length-a.callback.statePrefix!.length)[0];
      if(matched)selected=matched;
      else if(!group.default)return reply.code(400).type('text/plain; charset=utf-8').send(selected.callback.failureMessage);
      const task=this.admit(selected,()=>selected.callback.complete(input.state,input.code));
      selected.inflight.add(task);void task.then(()=>selected.inflight.delete(task),()=>selected.inflight.delete(task));
      const result=await task;
      if(result===undefined||result===RELEASED||'error' in result)return reply.code(400).type('text/plain; charset=utf-8').send(selected.callback.failureMessage);
      return reply.type('text/plain; charset=utf-8').send(selected.callback.successMessage);
    }catch{return reply.code(400).type('text/plain; charset=utf-8').send(selected.callback.failureMessage);}
  }
  private sendError(error:unknown,request:FastifyRequest,reply:FastifyReply){
    const mapped=this.options.mapError?.(error,request)??defaultError(error);
    if(reply.sent)return reply;
    return reply.code(mapped.status).send({error:mapped.error,requestId:request.id});
  }
  close():Promise<void> {
    if(this.closing)return this.closing;
    this.closed=true;
    // Includes entries already removed from the lookup tables by release/abort;
    // their accepted inflight work must still settle before close resolves.
    const entries:Entry[]=[...this.registered];
    this.closing=(async()=>{
      const results=await Promise.allSettled(entries.map(entry=>this.release(entry)));
      const errors=results.flatMap(result=>result.status==='rejected'?[result.reason]:[]);
      if(errors.length)throw new AggregateError(errors,'Dynamic HTTP dispatcher disposal failed');
    })();
    return this.closing;
  }
}
export interface DynamicHttpDispatcher {
  /** Register the two static routes once, before Fastify listen/ready. */
  attach(app:FastifyInstance):void;
  registerOwnerRoute(scope:HostScope,route:DynamicOwnerRoute):DynamicHttpRouteHandle;
  registerOAuthCallback(scope:HostScope,callback:DynamicOAuthCallback):DynamicHttpRouteHandle;
  close():Promise<void>;
}
export function createDynamicHttpDispatcher(options:DynamicHttpDispatcherOptions):DynamicHttpDispatcher {
  return new DynamicHttpDispatcherImpl(options);
}
