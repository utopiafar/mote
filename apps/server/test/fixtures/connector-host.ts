import type {FastifyInstance} from 'fastify';
import {PluginResourceScope,type HostScope} from '@mote/plugin-host';
import {ZodError} from 'zod';
import {ConnectorRegistry,type ConnectorManifest} from '../../src/connectors/registry.js';
import {equalToken} from '../../src/connectors/mcp.js';
import {ConnectorError,type ConnectorContext} from '../../src/connectors/types.js';
import {createDynamicHttpDispatcher,type DynamicHttpDispatcher} from '../../src/plugins/dynamic-http-dispatcher.js';

export type TestConnectorScope={resources:PluginResourceScope;scope:HostScope;fence:()=>void;close:()=>Promise<void>};

export function testConnectorScope(instanceId:string):TestConnectorScope{
  const resources=new PluginResourceScope(undefined,'Generated connector scope disposal failed');
  const scope:HostScope=Object.freeze({
    identity:{packageId:'generated.connector',installationId:'generated-install',instanceId,activationId:'generated-'+instanceId,host:{kind:'central' as const,id:'generated-host'}},
    signal:resources.signal,
    assertCurrent:()=>resources.assertCurrent(),
    defer:dispose=>resources.defer(dispose),
    run:work=>resources.run(work),
    every:(ms,work)=>resources.every(ms,work),
    retire:dispose=>resources.retire(dispose),
  });
  return {resources,scope,fence:()=>resources.stop(),close:()=>resources.close()};
}

/** Direct registry fixture for lower-level lifecycle cases. Production always
 * reaches the registry through the host adapter, which supplies the same
 * dispatcher-backed HTTP host and per-instance scopes. */
export function connectorRegistryHost(app:FastifyInstance,context:ConnectorContext,manifests:readonly ConnectorManifest[]=[]){
  const scopes:TestConnectorScope[]=[],status=testConnectorScope('status');
  const dispatcher: DynamicHttpDispatcher=createDynamicHttpDispatcher({
    authorize:request=>Boolean(context.ownerAuthorization?.(request.headers.authorization)??equalToken(request.headers.authorization,context.config.token)),
    mapError:error=>error instanceof ConnectorError?{status:error.statusCode,error:error.code}:error instanceof ZodError?{status:400,error:'connector_input_invalid'}:undefined,
  });
  dispatcher.attach(app);
  const registry=new ConnectorRegistry(context,{
    http:{ownerRoute:(route,scope)=>dispatcher.registerOwnerRoute(scope,route),oauthCallback:(callback,scope)=>dispatcher.registerOAuthCallback(scope,callback)},
    statusScope:status.scope,
    scopeFor:manifest=>{const value=testConnectorScope(manifest.id);scopes.push(value);return value.scope;},
    transport:instance=>instance.mountTransport?.(app),
  });
  for(const manifest of manifests)registry.register(manifest);
  return {
    registry,dispatcher,scopes,status,
    async close(){
      const errors:unknown[]=[];
      for(const task of [()=>registry.close(),...scopes.reverse().map(scope=>()=>scope.close()),()=>status.close(),()=>dispatcher.close()])try{await task();}catch(error){errors.push(error);}
      if(errors.length)throw new AggregateError(errors,'Generated connector host disposal failed');
    },
  };
}
