import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import {PluginResourceScope,type HostScope} from '@mote/plugin-host';
import type {StateStore} from '@mote/plugin-api';
import {installRecordingSources,recordingSourceManifests,type RecordingProvider} from '../plugins/recording-sources.js';
import {createInstanceState} from '../plugins/instance-state.js';
import {createConnectorHostAdapter,type ConnectorHostAdapter,type ConnectorInstanceScope} from '../plugins/connector-host-adapter.js';
import {createDynamicHttpDispatcher,type DynamicHttpDispatcher} from '../plugins/dynamic-http-dispatcher.js';
import type {ConnectorManifest} from './registry.js';
import {equalToken} from './mcp.js';
import {mcpManifest} from '../plugins/mcp-source-transport.js';
import {googleCalendarManifest,type GoogleDependencies} from '../plugins/google-calendar-source.js';
import {gmailManifest} from '../plugins/gmail-source.js';
import {larkManifest,type LarkRunner} from '../plugins/lark-source.js';
import {ConnectorError,type ConnectorContext} from './types.js';
import type {FastifyInstance} from 'fastify';
import {ZodError} from 'zod';

export type {ConnectorConfig,ConnectorContext} from './types.js';
export type {ConnectorManifest,ConnectorInstance,ConnectorHost,OwnerRoute,OAuthCallback,ConnectorHttpHost,ConnectorRegistryOptions,ConnectorRouteHandle} from './registry.js';
export {recordingManifest,RecordingConnector} from '../plugins/recording-sources.js';
export type {RecordingProvider,RecordingAccount,RecordingMetadata} from '../plugins/recording-sources.js';

export type ConnectorTestDependencies={recordings?:RecordingProvider[];google?:GoogleDependencies;gmail?:GoogleDependencies;lark?:LarkRunner;fetch?:typeof fetch};

function builtins(testing?:ConnectorTestDependencies):ConnectorManifest[]{return [
  ...recordingSourceManifests(testing?.recordings),
  mcpManifest(),
  googleCalendarManifest(testing?.google),
  gmailManifest(testing?.gmail),
  larkManifest(testing?.lark),
];}

/** One host-owned install scope per connector. The scope owns routes, OAuth
 * callbacks, timers and host-bound state; closing one never touches siblings. */
function connectorScope(packageId:string,instanceId:string,errorMessage:string):ConnectorInstanceScope&{resources:PluginResourceScope}{
  const resources=new PluginResourceScope(undefined,errorMessage);
  const cordis=new Context();
  resources.retire(()=>cordis.fiber.dispose());
  const identity={
    host:{kind:'central' as const,id:'central-connectors'},
    packageId,installationId:'central-connectors',instanceId,activationId:randomUUID(),
  };
  const scope:HostScope=Object.freeze({
    identity,signal:resources.signal,cordis,
    assertCurrent:()=>resources.assertCurrent(),defer:(dispose:()=>unknown|Promise<unknown>)=>resources.defer(dispose),
    run:<T>(work:(signal:AbortSignal)=>T|Promise<T>)=>resources.run(work),
    every:(ms:number,work:(signal:AbortSignal)=>unknown|Promise<unknown>)=>resources.every(ms,work),
    retire:(dispose:()=>unknown|Promise<unknown>)=>resources.retire(dispose),
  });
  return {resources,scope,fence:()=>resources.stop(),close:()=>resources.close()};
}

/** Register built-ins plus trusted assembly manifests before Fastify listens.
 * Owner routes and OAuth callbacks reach only the one dynamic dispatcher; each
 * installed connector gets its own host scope and failure rollback. */
export async function registerConnectors(app:FastifyInstance,context:ConnectorContext,testing?:ConnectorTestDependencies,additionalManifests:readonly ConnectorManifest[]=[],dispatcherInput?:DynamicHttpDispatcher):Promise<ConnectorHostAdapter>{
  const ctx={...context,...(testing?.fetch?{fetch:testing.fetch}:{}),config:{...context.config,connectors:{directory:join(context.config.dataDir,'connectors'),...context.config.connectors}}};
  const removeMemory=installRecordingSources(context.memoryStrategies);
  if(removeMemory)app.addHook('onClose',async()=>removeMemory());
  const manifests=[...builtins(testing),...additionalManifests];
  const status=connectorScope('mote.connectors','status','Connector status scope disposal failed');
  app.addHook('onClose',()=>status.close());
  const states=new WeakMap<HostScope,StateStore>();
  const dispatcher=dispatcherInput??createDynamicHttpDispatcher({
    authorize:request=>Boolean(ctx.ownerAuthorization?.(request.headers.authorization)??equalToken(request.headers.authorization,ctx.config.token)),
    mapError:connectorErrorResponse,
  });
  dispatcher.attach(app);
  const adapter=createConnectorHostAdapter({
    manifests,context:ctx,dispatcher,statusScope:status.scope,
    required:additionalManifests.map(manifest=>manifest.id),
    scopeFor:(manifest,instanceId)=>connectorScope(manifest.id,instanceId,`Connector ${instanceId} scope disposal failed`),
    stateFor:scope=>{
      let state=states.get(scope);
      if(!state){state=createInstanceState(ctx.store,scope);states.set(scope,state);}
      return state;
    },
    transport:instance=>instance.mountTransport?.(app),
  });
  const closeHost=async()=>{
    const errors:unknown[]=[];
    for(const dispose of [()=>adapter.close(),()=>status.close(),()=>dispatcher.close()])try{await dispose();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Connector host disposal failed');
  };
  try{await adapter.start();}
  catch(error){try{await closeHost();}catch(cleanup){throw new AggregateError([error,cleanup],'Connector host startup and disposal failed',{cause:error});}throw error;}
  return Object.freeze({
    start:adapter.start,inventory:adapter.inventory,contributions:adapter.contributions,configureSyncInterval:adapter.configureSyncInterval,
    install:adapter.install,known:adapter.known,restart:adapter.restart,stop:adapter.stop,executeAction:adapter.executeAction,close:closeHost,
  });
}

function connectorErrorResponse(error:unknown){
  if(error instanceof ConnectorError)return {status:error.statusCode,error:error.code};
  if(error instanceof ZodError)return {status:400,error:'connector_input_invalid'};
}
