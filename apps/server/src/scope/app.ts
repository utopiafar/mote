import Fastify,{type FastifyInstance,type FastifyRequest} from 'fastify';
import {SCOPE_BASELINE,ScopeError} from './baseline.js';
import {UserContextAuthority,type IdentityVerifier,type UserContext} from './context.js';
import {ScopedServices} from './services.js';
import {openScopeStorage} from './storage.js';
import type {LifecycleAuthority} from './lifecycle.js';
import {registerPrivateData} from './private-data-routes.js';
import {PrivateDataError} from './private-data-sql.js';
import {ZodError} from 'zod';

export type ScopedRuntime={app:FastifyInstance;authority:UserContextAuthority;services:ScopedServices};
const denyVerifier:IdentityVerifier={verify:async()=>undefined,isCurrent:()=>false};
async function requestContext(req:FastifyRequest,authority:UserContextAuthority){
  // Identity selectors in headers cannot impersonate an account, even alongside
  // a valid credential. Query/body identities are never consulted by the host.
  if(['x-user-id','x-owner-id','x-mote-user-id'].some(key=>req.headers[key]!==undefined))throw new ScopeError('invalid_identity',401);
  for(const value of [req.query,req.body])if(value&&typeof value==='object'&&['userId','ownerId','userContext','deploymentId'].some(key=>Object.hasOwn(value,key)))throw new ScopeError('invalid_identity',401);
  const auth=req.headers.authorization;
  const context=await authority.authenticate(typeof auth==='string'&&auth.startsWith('Bearer ')?auth.slice(7):undefined);
  if(req.headers['x-mote-protocol-version']!==String(SCOPE_BASELINE.wireProtocol))throw new ScopeError('incompatible_protocol',426);
  return context;
}
/** The only private HTTP registration entry point. M01 supplies the verifier;
 * each domain registers its already scoped services before making routes live. */
export function registerUserRoute(runtime:ScopedRuntime,route:{scope:'user';method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE';url:string;service:string;handle:(input:{context:UserContext;services:ReturnType<ScopedServices['forUser']>;request:FastifyRequest})=>unknown|Promise<unknown>}){
  if(route.scope!=='user'||!route.url.startsWith('/api/')||route.url==='/api/health'||!route.service)throw new ScopeError('undeclared_scope',500);
  runtime.app.route({method:route.method,url:route.url,handler:async request=>{
    const context=await requestContext(request,runtime.authority),services=runtime.services.forUser(context);
    services.require(route.service); // Fail before the handler when a domain is absent.
    const result=await route.handle({context,services,request});runtime.authority.assert(context);return result;
  }});
}

/** Production composition. No single-owner data tree, worker, token fallback or
 * plugin is started while its multi-user adapter is still unimplemented. */
export async function buildScopedApp(config:{dataDir:string},options:{verifier?:IdentityVerifier;lifecycleAuthority?:LifecycleAuthority}={}){
  const storage=openScopeStorage(config.dataDir);
  try{
  const app=Fastify({logger:false});
  const authority=new UserContextAuthority(storage.deploymentId,options.verifier??denyVerifier),services=new ScopedServices(authority,options.lifecycleAuthority);
  const runtime={app,authority,services};
  app.setErrorHandler((error,_request,reply)=>{const failure=error instanceof ScopeError||error instanceof PrivateDataError?error:error instanceof ZodError?new PrivateDataError('invalid_data'):new ScopeError('scope_unavailable',503);return reply.code(failure.statusCode).send({error:failure.code});});
  app.get('/api/health',async()=>({ok:true,mode:'multiuser-foundation',protocol:{min:SCOPE_BASELINE.wireProtocol,max:SCOPE_BASELINE.wireProtocol},storageEpoch:SCOPE_BASELINE.storageEpoch,privateCapabilities:['private-data']}));
  registerPrivateData(runtime,storage.db);
  app.setNotFoundHandler(async(req,reply)=>{
    if(req.url.startsWith('/api/'))await requestContext(req,authority);
    return reply.code(503).send({error:'scope_unavailable'});
  });
  app.addHook('onClose',async()=>storage.close());
  return {...runtime,deploymentId:storage.deploymentId};
  }catch(error){storage.close();throw error;}
}
