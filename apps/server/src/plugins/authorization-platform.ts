import {AsyncLocalStorage} from 'node:async_hooks';
import {timingSafeEqual,createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {captureSchema,sourceItemSchema,type CaptureInput} from '@mote/shared';
import type {ManifestContribution} from '@mote/plugin-api';
import type {PluginLifecycle,StopReason} from '@mote/plugin-api/contracts';
import type {HostPluginContext} from '@mote/plugin-host';
import type {Store} from '../store.js';
import type {SourceStore} from '../sources.js';
import type {FileStore} from '../files.js';
import type {MaterialStore} from '../materials.js';
import type {MaterialMemoryWork} from '../material-memory-work.js';
import type {ConnectorConfig} from '../connectors/types.js';
import {Connections,ConnectionError,type ConnectionCredential} from '../connections.js';
import {LoginHandoffs} from '../login-handoffs.js';
import {IngressService} from '../ingress.js';
import {assertExternalCaptures,assertCaptureAttachments} from '../capture-admission.js';
import {BackgroundModelAuthorization,type ModelConnection} from '../background-model-authorization.js';
import {ModelAuthorizationHost,sourceModelIdentity} from '../model-authorization-host.js';
import {automaticMemoryGrantSchema,type AutomaticMemoryGrant,type MemoryInputAuthorization} from '../memory-input-authorization.js';
import type {RequestAuthority,RequestAuthorization,CommitAuthority,CommitAuthorization,CaptureIntake,SourceIntake} from './central-contracts.js';

export interface AuthorizationPlatformOptions {
  readonly ownerToken:string;
  readonly connectorConfiguration?:()=>ConnectorConfig|undefined;
  readonly allowedOrigins?:readonly string[];
  readonly clock?:()=>number;
}
export interface AuthorizationPlatformDependencies {
  readonly store:Store;
  readonly availableModelConnections:()=>ModelConnection[];
  /** Matches existing buildApp ownership: supplied Connections is owned and closed. */
  readonly connections?:Connections;
}
export interface AuthorizationRepositories {
  readonly sources:SourceStore;readonly files:FileStore;readonly materials:MaterialStore;
  readonly ingress?:IngressService;readonly memoryInputs?:MemoryInputAuthorization;readonly memoryWork?:MaterialMemoryWork;
}
export interface BoundAuthorizationRequest {
  readonly authorization?:string;readonly method:string;readonly route:string;
  readonly params?:Readonly<{id?:string}>;readonly origin?:string;readonly signal?:AbortSignal;
}
/** Executable local owner only; it advertises no ordinary issuer/control/write service.
 * H05's trusted registry supplies real storage. This is not a release/package Manifest. */
export const authorizationPlatformContribution={id:'authorization-platform',version:'1.0.0',surface:'data',runtime:'host',
  requires:[{kind:'host',id:'mote.vault-platform',version:'1.0.0'}],provides:[],
} as const satisfies ManifestContribution;
export const authorizationPlatformDeclaration={id:authorizationPlatformContribution.id,apiVersion:'1'} as const;
export const authorizationPlatformReplacement='restart' as const;

type RequestState={credential?:Readonly<ConnectionCredential>;mcp?:{write:boolean;sourceIds:readonly string[];staticTokenHash?:string};
  controller:AbortController;signal:AbortSignal;active:boolean;bound?:Readonly<Omit<BoundAuthorizationRequest,'authorization'|'signal'>>;timer?:ReturnType<typeof setTimeout>};
type Target={kind:'capture';input:CaptureInput}|{kind:'captures';input:CaptureInput[]}|{kind:'source'|'sources';sourceId:string;input:unknown};
type Admission={request:RequestAuthority;target:Target;active:boolean};
const denied=(code='connection_scope_denied',status=403)=>new ConnectionError(code,status,'Authorization is unavailable');
const equalBearer=(header:string|undefined,token:string|undefined)=>{
  if(typeof header!=='string'||!token)return false;const supplied=Buffer.from(header),expected=Buffer.from('Bearer '+token);
  return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
};
function immutable<T>(value:T):T {
  const clone=structuredClone(value);
  const seen=new WeakSet<object>(),pending:unknown[]=[clone];
  while(pending.length){const object=pending.pop();if(!object||typeof object!=='object'||seen.has(object))continue;seen.add(object);pending.push(...Object.values(object));Object.freeze(object);}
  return clone;
}

/** All admission/issuer/control members are trusted server assembly only, never ordinary
 * plugin ports. ALS carries an already-issued admission; provenance, request, target,
 * existing policy and current domain fences are independently checked at actual writes. */
export function createAuthorizationPlatform(options:AuthorizationPlatformOptions,dependencies:AuthorizationPlatformDependencies){
  if(!options.ownerToken)throw denied('authorization_unavailable',503);
  const ownerToken=options.ownerToken,now=options.clock??Date.now,origins=[...(options.allowedOrigins??[])];
  const configuration=options.connectorConfiguration??(()=>undefined);
  const {store}=dependencies;
  let phase:'created'|'prepared'|'bound'|'active'|'quiescing'|'stopped'|'disposed'='created';
  let control:BackgroundModelAuthorization|undefined,host:ModelAuthorizationHost|undefined,connections:Connections|undefined,handoffs:LoginHandoffs|undefined;
  let repositories:AuthorizationRepositories|undefined,ingress:IngressService|undefined,closing:Promise<void>|undefined;
  const disposers:(()=>void)[]=[],pending=new Set<Promise<unknown>>();
  const requestRegistry=new WeakMap<object,RequestState>(),commitRegistry=new WeakMap<object,Admission>();
  const liveAdmissions=new Set<Admission>();
  const liveRequests=new Map<RequestAuthority,RequestState>(),memoryRuns=new Set<{controller:AbortController;assert:()=>void}>();
  const context=new AsyncLocalStorage<Admission>();
  const running=()=>{if(phase!=='active'&&phase!=='quiescing')throw denied('authorization_unavailable',503);};
  const ready=()=>{if(!control||phase==='stopped'||phase==='disposed')throw denied('authorization_unavailable',503);};
  const track=<T>(work:Promise<T>):Promise<T>=>{pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;};
  const state=(request:RequestAuthority)=>{
    running();const found=request&&typeof request==='object'?requestRegistry.get(request):undefined;
    if(!found||!found.active)throw denied('connection_revoked',401);return found;
  };
  function assertRequest(request:RequestAuthority){
    const value=state(request);value.signal.throwIfAborted();
    if(value.credential)connections!.assertActive(value.credential);
    if(value.mcp){
      const config=configuration();if(!config?.mcpEnabled||value.mcp.write&&!config.mcpWriteEnabled)throw denied('mcp_disabled',503);
      if(value.mcp.staticTokenHash!==undefined&&value.mcp.staticTokenHash!==createHash('sha256').update('Bearer '+(value.mcp.write?config.mcpWriteToken:config.mcpReadToken)).digest('hex'))throw denied('connection_revoked',401);
    }
    return value;
  }
  function releaseRequest(request:RequestAuthority){
    const value=requestRegistry.get(request);if(!value)return;value.active=false;liveRequests.delete(request);if(value.timer)clearTimeout(value.timer);
    if(!value.controller.signal.aborted)value.controller.abort(denied('connection_revoked',401));
  }
  const owner=(value:RequestState)=>!value.mcp&&(!value.credential||value.credential.scope==='owner');
  const requestChecks={
    authenticate(header:string|undefined):RequestAuthority|undefined {
      if(phase!=='active')return;
      const credential=connections!.authenticate(header);
      if(!equalBearer(header,ownerToken)&&!credential)return;
      const controller=new AbortController(),reference:object=Object.freeze({});
      requestRegistry.set(reference,{credential:credential?immutable(credential):undefined,controller,signal:controller.signal,active:true});
      return reference as RequestAuthority;
    },
    assertCurrent(request:RequestAuthority){assertRequest(request);},
    assertOwnDevice(request:RequestAuthority,input:{deviceId:string}){const value=assertRequest(request);if(!owner(value)){if(value.mcp)throw denied();connections!.assertOwnDevice(value.credential!,input);}},
    assertOwnSource(request:RequestAuthority,sourceId:string){
      const value=assertRequest(request);
      if(value.mcp){if(!value.mcp.write||!value.mcp.sourceIds.includes(sourceId)||!configuration()?.mcpWriteSourceIds?.includes(sourceId))throw denied('mcp_write_scope_denied');}
      else if(!owner(value))connections!.assertOwnSource(value.credential!,sourceId);
    },
    assertCapture(request:RequestAuthority,input:CaptureInput){
      const value=assertRequest(request);if(value.mcp)throw denied();
      if(!owner(value))connections!.assertCapture(value.credential!,input);
      assertExternalCaptures([input],owner(value));assertCaptureAttachments([input],repositories!.files,owner(value)?undefined:value.credential);
    },
  } satisfies RequestAuthorization;
  function policy(request:RequestAuthority,target:Target){
    const value=assertRequest(request),bound=value.bound;if(!bound)throw denied();
    if(target.kind==='capture'||target.kind==='captures'){
      const routes=target.kind==='capture'?['/api/captures','/api/notes']:['/api/captures/batch','/api/captures/bundle'];
      if(bound.method!=='POST'||!routes.includes(bound.route))throw denied();
      for(const input of target.kind==='capture'?[target.input]:target.input)requestChecks.assertCapture(request,input);
    }else{
      const mcp=bound.route==='/mcp'&&target.kind==='source';
      if(!mcp&&(bound.method!==(target.kind==='source'?'PUT':'POST')||bound.route!==(target.kind==='source'?'/api/sources/:id/items':'/api/sources/:id/items/batch')||bound.params?.id!==target.sourceId))throw denied();
      requestChecks.assertOwnSource(request,target.sourceId);
      if(!repositories!.sources.getSource(target.sourceId).enabled)throw denied();
    }
  }
  function admission(authority:CommitAuthority,actual?:Target){
    running();const value=authority&&typeof authority==='object'?commitRegistry.get(authority):undefined;
    if(!value||!value.active||context.getStore()!==value)throw denied('commit_authority_invalid');
    if(actual&&!isDeepStrictEqual(value.target,actual))throw denied('commit_target_mismatch');
    policy(value.request,actual??value.target);return value;
  }
  const commits={
    capture():CommitAuthority{
      const value=context.getStore();if(!value?.active)throw denied('commit_authority_invalid');policy(value.request,value.target);
      const reference:object=Object.freeze({});commitRegistry.set(reference,value);return reference as CommitAuthority;
    },
    assertCurrent(authority:CommitAuthority){admission(authority);},
  } satisfies CommitAuthorization;
  function withTarget<T>(request:RequestAuthority,target:Target,work:()=>Promise<T>):Promise<T>{
    policy(request,target);const accepted:Admission={request,target:immutable(target),active:true};liveAdmissions.add(accepted);
    return context.run(accepted,()=>{
      try{return track(Promise.resolve(work()).then(value=>{policy(request,accepted.target);return value;}).finally(()=>{accepted.active=false;liveAdmissions.delete(accepted);}));}
      catch(error){accepted.active=false;liveAdmissions.delete(accepted);throw error;}
    });
  }
  const captures={
    async capture(input:CaptureInput,authority:CommitAuthority){
      const actual=immutable(captureSchema.parse(input));admission(authority,{kind:'capture',input:actual});
      return track(ingress!.capture(actual,()=>{admission(authority,{kind:'capture',input:actual});}));
    },
    async captureSettled(inputs:CaptureInput[],authority:CommitAuthority){
      const actual=immutable(inputs.map(input=>captureSchema.parse(input)));admission(authority,{kind:'captures',input:actual});
      return track(ingress!.captureSettled(actual,()=>{admission(authority,{kind:'captures',input:actual});}));
    },
  } satisfies CaptureIntake;
  const sources={
    async sourceItem(sourceId:string,input:unknown,authority:CommitAuthority){
      const actual=immutable(sourceItemSchema.parse(input));admission(authority,{kind:'source',sourceId,input:actual});
      return track(ingress!.sourceItem(sourceId,actual,()=>{admission(authority,{kind:'source',sourceId,input:actual});}));
    },
    async sourceBatch(sourceId:string,inputs:unknown,authority:CommitAuthority){
      if(!Array.isArray(inputs))throw denied('invalid_source_batch',400);
      const actual=immutable(inputs.map(input=>sourceItemSchema.parse(input)));admission(authority,{kind:'sources',sourceId,input:actual});
      return track(ingress!.sourceBatch(sourceId,actual,()=>{admission(authority,{kind:'sources',sourceId,input:actual});}));
    },
  } satisfies SourceIntake;
  function bindRequest(input:BoundAuthorizationRequest):RequestAuthority{
    if(phase!=='active')throw denied('authorization_unavailable',503);
    let reference:RequestAuthority|undefined,mcp:RequestState['mcp'];
    if(input.route==='/mcp'){
      const config=configuration();if(!config?.mcpEnabled)throw denied('mcp_disabled',503);
      if(input.origin&&!origins.includes(input.origin))throw denied('mcp_origin_denied');
      if(input.method!=='POST')throw denied('method_not_allowed',405);
      const issued=connections!.mcpAuthorization(input.authorization,config);
      const staticWrite=Boolean(config.mcpWriteEnabled&&config.mcpWriteSourceIds?.length&&equalBearer(input.authorization,config.mcpWriteToken));
      if(!issued&&!staticWrite&&!equalBearer(input.authorization,config.mcpReadToken))throw denied('mcp_unauthorized',401);
      // Credential MCP grants retain their own frozen source scope; static grants keep only private token identity.
      mcp={write:Boolean(issued?.write||staticWrite),sourceIds:[...(issued?.write?issued.sourceIds??[]:staticWrite?config.mcpWriteSourceIds??[]:[])],...(!issued||!issued.write&&staticWrite?{staticTokenHash:createHash('sha256').update(input.authorization!).digest('hex')}:{})};
      const raw:object=Object.freeze({}),controller=new AbortController(),credential=issued?connections!.authenticate(input.authorization):undefined;
      requestRegistry.set(raw,{credential:credential?immutable(credential):undefined,mcp,controller,signal:controller.signal,active:true});reference=raw as RequestAuthority;
    }else{
      reference=requestChecks.authenticate(input.authorization);if(!reference)throw denied('unauthorized',401);
      const entry=requestRegistry.get(reference)!;if(entry.credential)connections!.assertCollectorRoute(entry.credential,input.method,input.route);
    }
    const entry=requestRegistry.get(reference)!;
    entry.bound=immutable({method:input.method,route:input.route,params:input.params,origin:input.origin});
    entry.signal=AbortSignal.any([entry.controller.signal,...(input.signal?[input.signal]:[])]);
    if(entry.credential?.expiresAt){const expiresAt=Date.parse(entry.credential.expiresAt);const expire=()=>{const remaining=expiresAt-now();if(remaining<=0){releaseRequest(reference!);return;}entry.timer=setTimeout(expire,Math.min(remaining,2147483647));entry.timer.unref();};expire();}
    liveRequests.set(reference,entry);
    if(input.signal){const revoke=()=>releaseRequest(reference!);input.signal.addEventListener('abort',revoke,{once:true});entry.controller.signal.addEventListener('abort',()=>input.signal!.removeEventListener('abort',revoke),{once:true});}
    try{assertRequest(reference);return reference;}catch(error){releaseRequest(reference);throw error;}
  }
  function refreshFences(){
    for(const [request,value] of liveRequests)try{
      assertRequest(request);
    }catch(error){value.controller.abort(error);}
    for(const accepted of liveAdmissions)try{policy(accepted.request,accepted.target);}catch(error){requestRegistry.get(accepted.request)?.controller.abort(error);}
    for(const run of memoryRuns)try{run.assert();}catch(error){run.controller.abort(error);}
    control?.revalidateActive();
  }
  function withMemoryGrant<T>(raw:unknown,jobId:string,work:(signal:AbortSignal,assertCurrent:()=>void)=>Promise<T>):Promise<T>{
    if(phase!=='active')throw denied('authorization_unavailable',503);
    const pin=immutable(automaticMemoryGrantSchema.parse(raw)),inputs=repositories?.memoryInputs,memoryWork=repositories?.memoryWork;
    if(!inputs||!memoryWork||memoryWork.inputs!==inputs||!host||!control)throw denied('authorization_unavailable',503);
    const controller=new AbortController();
    const assert=()=>{running();controller.signal.throwIfAborted();inputs.assertClaimed(pin,jobId);if(!memoryWork.authorized({id:jobId,automaticGrant:pin}))throw denied('memory_authorization_revoked',409);};assert();
    const run={controller,assert};memoryRuns.add(run);
    return track(host.automatic(jobId,'memory',[sourceModelIdentity(pin.sourceId,pin.inputKey)],async modelSignal=>{
      const signal=AbortSignal.any([controller.signal,modelSignal]);assert();control!.assertDisclosure([{sourceId:pin.sourceId,dataKind:'text'}]);
      const result=await work(signal,assert);signal.throwIfAborted();assert();return result;
    },controller.signal).finally(()=>{memoryRuns.delete(run);}));
  }
  function stopNow(){
    if(phase==='disposed')return;phase='stopped';
    for(const value of liveRequests.values()){value.active=false;if(value.timer)clearTimeout(value.timer);value.controller.abort(denied('authorization_unavailable',503));}
    liveRequests.clear();for(const run of memoryRuns)run.controller.abort(denied('authorization_unavailable',503));control?.close();
  }
  function close(){
    if(closing)return closing;stopNow();
    closing=(async()=>{
      const errors:unknown[]=[];for(const dispose of disposers.splice(0).reverse())try{dispose();}catch(error){errors.push(error);}
      try{await handoffs?.close();}catch(error){errors.push(error);}
      await Promise.allSettled([...pending]);
      try{await connections?.close();}catch(error){errors.push(error);}
      context.disable();phase='disposed';if(errors.length)throw new AggregateError(errors,'Authorization platform disposal failed');
    })();return closing;
  }
  return Object.freeze({
    async prepare(){if(phase!=='created')throw denied('authorization_unavailable',503);try{control=new BackgroundModelAuthorization(store,dependencies.availableModelConnections);phase='prepared';}catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Authorization preparation and cleanup failed',{cause:error});}throw error;}},
    bindRepositories(value:AuthorizationRepositories){
      if(phase!=='prepared')throw denied('authorization_unavailable',503);
      if(value.sources.store!==store||value.files.store!==store||value.materials.store!==store)throw denied('authorization_repository_mismatch',503);
      if(dependencies.connections&&!dependencies.connections.usesStore(store))throw denied('authorization_repository_mismatch',503);
      repositories=value;ingress=value.ingress??new IngressService(store,value.sources,value.files);
      host=new ModelAuthorizationHost(control!,store,value.materials,value.files);
      connections=dependencies.connections??new Connections(store,value.sources,{clock:now});handoffs=new LoginHandoffs(connections,now);
      disposers.push(connections.onChange(refreshFences));
      if(value.memoryInputs){
        const inputs=value.memoryInputs,previous=inputs.onOriginalInput,observer:NonNullable<MemoryInputAuthorization['onOriginalInput']>=(input,automatic)=>{previous?.(input,automatic);host!.source(input,automatic);};
        inputs.onOriginalInput=observer;disposers.push(()=>{if(inputs.onOriginalInput===observer)inputs.onOriginalInput=previous;});disposers.push(inputs.onInvalidated(refreshFences));
      }
      phase='bound';
    },
    async start(){if(phase!=='bound')throw denied('authorization_unavailable',503);try{await connections!.init();if(phase!=='bound')throw denied('authorization_unavailable',503);phase='active';}catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Authorization start and cleanup failed',{cause:error});}throw error;}},
    quiesce(_reason?:StopReason){if(phase==='active')phase='quiescing';},stop:async(_reason?:StopReason)=>{await close();},dispose:close,close,
    /** These assembly members must never be published as ordinary plugin services. */
    get assembly(){ready();return Object.freeze({get connections(){return connections;},get handoffs(){return handoffs;},modelAuthorization:control!,get modelAuthorizationHost(){return host;}});},
    validOwnerBearer(header:string|undefined){return phase!=='stopped'&&phase!=='disposed'&&equalBearer(header,ownerToken);},
    requests:Object.freeze(requestChecks),commits:Object.freeze(commits),captureIntake:Object.freeze(captures),sourceIntake:Object.freeze(sources),
    bindRequest,releaseRequest,requestSignal:(request:RequestAuthority)=>assertRequest(request).signal,
    withCapture:<T>(request:RequestAuthority,input:CaptureInput|CaptureInput[],work:()=>Promise<T>)=>withTarget(request,Array.isArray(input)?{kind:'captures',input:input.map(value=>captureSchema.parse(value))}:{kind:'capture',input:captureSchema.parse(input)},work),
    withSource:<T>(request:RequestAuthority,sourceId:string,input:unknown,work:()=>Promise<T>)=>withTarget(request,Array.isArray(input)?{kind:'sources',sourceId,input:input.map(value=>sourceItemSchema.parse(value))}:{kind:'source',sourceId,input:sourceItemSchema.parse(input)},work),
    withMemoryGrant,refreshFences,
  });
}
export type AuthorizationPlatform=ReturnType<typeof createAuthorizationPlatform>;

/** Compiled trusted H04 owner. No normal plugin receives admission, issuer or controls. */
export function createAuthorizationPlatformFactory(options:AuthorizationPlatformOptions,dependencies:AuthorizationPlatformDependencies,repositories:AuthorizationRepositories){
  return (context:HostPluginContext):PluginLifecycle=>{
    const platform=createAuthorizationPlatform(options,dependencies);context.scope.defer(platform.close);
    return {prepare:async()=>{await platform.prepare();platform.bindRepositories(repositories);},start:platform.start,quiesce:platform.quiesce,stop:platform.stop,dispose:platform.close};
  };
}
