import type {FastifyInstance,FastifyRequest,FastifyReply} from 'fastify';
import {SCOPE_BASELINE,ScopeError} from './baseline.js';
import type {UserContext,UserContextAuthority} from './context.js';
import type {ScopedServices} from './services.js';
import {AuthError,type Accounts} from './accounts.js';
export type ScopedRuntime={app:FastifyInstance;authority:UserContextAuthority;services:ScopedServices;accounts?:Accounts};
export const SESSION_COOKIE='__Host-mote-session';
export function cookieCredential(request:FastifyRequest){
  const values=(request.headers.cookie??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(SESSION_COOKIE+'='));
  if(values.length>1)throw new ScopeError('invalid_identity',401);
  return values[0]?.slice(SESSION_COOKIE.length+1);
}
export function rejectIdentitySelectors(req:FastifyRequest){
  if(['x-user-id','x-owner-id','x-mote-user-id'].some(key=>req.headers[key]!==undefined))throw new ScopeError('invalid_identity',401);
  for(const value of [req.query,req.body])if(value&&typeof value==='object'&&['userId','ownerId','userContext','deploymentId'].some(key=>Object.hasOwn(value,key)))throw new ScopeError('invalid_identity',401);
}
/** Shared private HTTP resolver. M02 keeps registerUserRoute and the original
 * host context. Cookie requests additionally prove their originating session;
 * stale tabs cannot mutate B using A's CSRF token or session binding. */
export async function requestContext(req:FastifyRequest,authority:UserContextAuthority,accounts?:Accounts,options:{discoverSession?:boolean}={}){
  rejectIdentitySelectors(req);
  const cookie=cookieCredential(req),auth=req.headers.authorization;
  if(cookie&&auth)throw new ScopeError('invalid_identity',401);
  const context=await authority.authenticate(cookie??(typeof auth==='string'&&auth.startsWith('Bearer ')?auth.slice(7):undefined));
  // A device handoff is an ingestion capability, not a private archive session.
  // Check before every existing domain route, including credential minting.
  if(accounts?.credentialInfo(context,authority).deviceId&&!req.url.startsWith('/api/ingress/')&&!['/api/connections/self','/api/auth/logout'].includes(req.url.split('?')[0]))throw new ScopeError('invalid_identity',403);
  if(req.headers['x-mote-protocol-version']!==String(SCOPE_BASELINE.wireProtocol))throw new ScopeError('incompatible_protocol',426);
  if(cookie){
    if(!accounts||accounts.credentialInfo(context,authority).kind!=='web')throw new ScopeError('invalid_identity',401);
    if(!options.discoverSession&&req.headers['x-mote-session-id']!==context.credentialId)throw new AuthError('session_changed',409);
    if(!['GET','HEAD','OPTIONS'].includes(req.method))accounts.assertCsrf(context,authority,req.headers['x-mote-csrf']);
  }else if(accounts?.credentialInfo(context,authority).kind==='web')throw new ScopeError('invalid_identity',401);
  return context;
}
type Route={method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE';url:string;bodyLimit?:number;administrator?:boolean;revokesSelf?:boolean|((context:UserContext,request:FastifyRequest)=>boolean);discoverSession?:boolean;handle:(context:UserContext,req:FastifyRequest,reply:FastifyReply)=>unknown|Promise<unknown>};
export function registerAuthenticatedRoute(runtime:ScopedRuntime,route:Route){
  runtime.app.route({method:route.method,url:route.url,bodyLimit:route.bodyLimit,handler:async(req,reply)=>{
    const context=await requestContext(req,runtime.authority,runtime.accounts,{discoverSession:route.discoverSession});
    if(route.administrator)runtime.authority.assertAdministrator(context);
    const result=await route.handle(context,req,reply);
    const terminal=typeof route.revokesSelf==='function'?route.revokesSelf(context,req):route.revokesSelf;
    if(!terminal)runtime.authority.assert(context);
    return result;
  }});
}
export function registerUserRoute(runtime:ScopedRuntime,route:{scope:'user';method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE';url:string;bodyLimit?:number;service:string;handle:(input:{context:UserContext;services:ReturnType<ScopedServices['forUser']>;request:FastifyRequest})=>unknown|Promise<unknown>}){
  if(route.scope!=='user'||!route.url.startsWith('/api/')||route.url==='/api/health'||!route.service)throw new ScopeError('undeclared_scope',500);
  registerAuthenticatedRoute(runtime,{...route,handle:async(context,request)=>{const services=runtime.services.forUser(context);services.require(route.service);return route.handle({context,services,request});}});
}
