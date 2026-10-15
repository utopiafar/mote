import Fastify from 'fastify';
import {ZodError} from 'zod';
import {SCOPE_BASELINE,ScopeError} from './baseline.js';
import {UserContextAuthority,type IdentityVerifier} from './context.js';
import {ScopedServices} from './services.js';
import {openScopeStorage} from './storage.js';
import {Accounts,AuthError} from './accounts.js';
import {registerAuthentication} from './auth-routes.js';
import {requestContext} from './http.js';
import {ConnectionError} from '../connection-error.js';
import type {LifecycleAuthority} from './lifecycle.js';
import {Configurations} from './configuration.js';
import {registerConfigurationRoutes} from './configuration-routes.js';
import {ConfigServiceError,type ConfigDocument} from '../config-service.js';
export {registerUserRoute,requestContext} from './http.js';

/** Production composition. Domains register only after their isolation adapter
 * is complete. Account administration never mounts the retired owner services. */
export async function buildScopedApp(config:{dataDir:string;configuration?:{publicUrl?:string|null;configFile?:string|null;document?:ConfigDocument}},options:{verifier?:IdentityVerifier;lifecycleAuthority?:LifecycleAuthority}={}){
  const storage=openScopeStorage(config.dataDir);
  let configuration:Configurations|undefined;
  try{
    const app=Fastify({logger:false});
    const accounts=new Accounts(storage.db,storage.deploymentId);
    const authority=new UserContextAuthority(storage.deploymentId,options.verifier??accounts),services=new ScopedServices(authority,options.lifecycleAuthority);
    const runtime={app,authority,services,...(!options.verifier?{accounts}:{})};
    app.setErrorHandler((error,_request,reply)=>{
      const failure=error instanceof ScopeError||error instanceof AuthError||error instanceof ConnectionError||error instanceof ConfigServiceError?error:error instanceof ZodError?new AuthError('invalid_request',400):new ScopeError('scope_unavailable',503);
      return reply.code(failure.statusCode).send({error:failure.code});
    });
    if(!options.verifier)registerAuthentication({...runtime,accounts},config.configuration?.publicUrl);
    configuration=await Configurations.open({directory:config.dataDir,db:storage.db,authority,accounts:runtime.accounts,lifecycleAuthority:options.lifecycleAuthority,instancePath:config.configuration?.configFile??undefined,instanceDocument:config.configuration?.document});
    registerConfigurationRoutes(runtime,configuration);
    app.get('/api/health',async()=>({ok:true,mode:'multiuser-auth',protocol:{min:SCOPE_BASELINE.wireProtocol,max:SCOPE_BASELINE.wireProtocol},storageEpoch:SCOPE_BASELINE.storageEpoch,authentication:'username-password',privateCapabilities:'unavailable'}));
    app.setNotFoundHandler(async(req,reply)=>{if(req.url.startsWith('/api/'))await requestContext(req,authority,runtime.accounts);return reply.code(503).send({error:'scope_unavailable'});});
    app.addHook('onClose',async()=>{await configuration?.close();accounts.close();storage.close();});
    return {...runtime,configuration,deploymentId:storage.deploymentId};
  }catch(error){await configuration?.close();storage.close();throw error;}
}
