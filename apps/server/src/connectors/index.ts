import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {PluginResourceScope,type HostScope} from '@mote/plugin-host';
import type {StateStore} from '@mote/plugin-api';
import {mcpContext,remoteMcpContext} from './mcp-context.js';
import {larkContext} from './lark-context.js';
import {gmailContext} from './gmail-context.js';
import {installRecordingSources,recordingSourceManifests,type RecordingProvider} from '../plugins/recording-sources.js';
import {moteText} from '../i18n.js';
import {createInstanceState} from '../plugins/instance-state.js';
import {createConnectorHostAdapter,type ConnectorHostAdapter,type ConnectorInstanceScope} from '../plugins/connector-host-adapter.js';
import {createDynamicHttpDispatcher,type DynamicHttpDispatcher} from '../plugins/dynamic-http-dispatcher.js';
import {loadConnectorModules,type ConnectorManifest,type OwnerRoute} from './registry.js';
import {equalToken,registerMcp,RemoteMcp} from './mcp.js';
import {googleCalendarManifest,type GoogleDependencies} from '../plugins/google-calendar-source.js';
import {GmailConnector} from './gmail.js';
import {LarkConnector} from './lark.js';
import type {LarkRunner} from './lark-cli.js';
import {ConnectorError,type ConnectorContext} from './types.js';
import type {FastifyInstance} from 'fastify';
import {ZodError,z} from 'zod';

export type {ConnectorConfig,ConnectorContext} from './types.js';
export type {ConnectorManifest,ConnectorInstance,ConnectorHost,OwnerRoute,OAuthCallback,ConnectorHttpHost,ConnectorRegistryOptions,ConnectorRouteHandle} from './registry.js';
export {recordingManifest,RecordingConnector} from '../plugins/recording-sources.js';
export type {RecordingProvider,RecordingAccount,RecordingMetadata} from '../plugins/recording-sources.js';

export type ConnectorTestDependencies={recordings?:RecordingProvider[];google?:GoogleDependencies;gmail?:GoogleDependencies;lark?:LarkRunner};

function builtins(testing?:ConnectorTestDependencies):ConnectorManifest[]{return [
  ...recordingSourceManifests(testing?.recordings),
  {apiVersion:1,id:'mcp',sourceKinds:['mcp'],statusKey:'mcp',create:ctx=>{
    const remote=new RemoteMcp(remoteMcpContext(ctx)),local=mcpContext(ctx);let inbound:ReturnType<typeof registerMcp>|undefined;
    return {
      status:()=>({enabled:Boolean(local.configuration().mcpEnabled),readConfigured:Boolean(local.configuration().mcpReadToken),writeEnabled:Boolean(local.configuration().mcpWriteEnabled&&local.configuration().mcpWriteToken&&local.configuration().mcpWriteSourceIds?.length),writeSourceIds:local.configuration().mcpWriteSourceIds??[],endpoint:'/mcp'}),
      configure:host=>{
        host.ownerRoute({method:'POST',path:'/api/connectors/mcp/discover',handler:req=>remote.discover(req.body)});
        host.ownerRoute({method:'POST',path:'/api/connectors/mcp/import',handler:req=>remote.import(req.body)});
      },
      mountTransport:app=>{inbound=registerMcp(app,local);},
      close:async()=>{await Promise.all([remote.close(),inbound?.close()]);},
    };
  }},
  googleCalendarManifest(testing?.google),
  {apiVersion:1,id:'gmail',sourceKinds:['gmail'],statusKey:'gmail',create:ctx=>{
    const gmail=new GmailConnector(gmailContext(ctx),testing?.gmail);
    return {
      init:()=>gmail.init(),status:()=>gmail.status(),configureSyncInterval:interval=>gmail.configureSyncInterval(interval),
      configure:host=>{
        host.ownerRoute({method:'POST',path:'/api/connectors/gmail/start',bodyLimit:16384,handler:()=>gmail.start()});
        host.ownerRoute({method:'POST',path:'/api/connectors/gmail/sync',bodyLimit:16384,handler:()=>gmail.sync()});
        host.ownerRoute({method:'DELETE',path:'/api/connectors/gmail',bodyLimit:16384,handler:()=>gmail.disconnect()});
        host.oauthCallback({path:'/oauth/google/callback',statePrefix:'gmail.',complete:(state,code)=>gmail.callback(state,code),successMessage:moteText('Gmail 已连接。请返回 Mote 同步邮件。'),failureMessage:moteText('授权未完成或已过期。请返回 Mote 重新连接 Google 日历。')});
      },
      close:()=>gmail.close(),
    };
  }},
  {apiVersion:1,id:'lark',sourceKinds:['lark-docs','lark-calendar'],create:ctx=>{
    const lark=new LarkConnector(larkContext(ctx),testing?.lark);
    return {
      init:()=>lark.init(),configureSyncInterval:interval=>lark.configureSyncInterval(interval),
      configure:host=>{
        const route=(method:'GET'|'POST'|'PUT'|'DELETE',path:`/api/connectors/${string}`,handler:OwnerRoute['handler'])=>host.ownerRoute({method,path,bodyLimit:16384,handler});
        route('GET','/api/connectors/lark',()=>lark.status());
        route('POST','/api/connectors/lark/check',()=>lark.refresh());
        route('POST','/api/connectors/lark/install',()=>lark.startInstall());
        route('POST','/api/connectors/lark/setup',()=>lark.startSetup());
        route('POST','/api/connectors/lark/configure',req=>lark.configure(req.body));
        route('POST','/api/connectors/lark/login',req=>lark.login(z.object({calendar:z.boolean().optional()}).strict().parse(req.body??{}).calendar??false));
        route('POST','/api/connectors/lark/cancel',()=>lark.cancel());
        route('GET','/api/connectors/lark/calendars',()=>lark.calendars());
        route('PUT','/api/connectors/lark/selection',req=>lark.select(req.body));
        route('POST','/api/connectors/lark/preview',()=>lark.startPreview());
        route('POST','/api/connectors/lark/sync',req=>lark.startSync(z.object({document:z.string().trim().min(1).max(4000).optional()}).strict().parse(req.body??{}).document));
        route('DELETE','/api/connectors/lark',()=>lark.disconnect());
      },
      close:()=>lark.close(),
    };
  }},
];}

/** One host-owned install scope per connector. The scope owns routes, OAuth
 * callbacks, timers and host-bound state; closing one never touches siblings. */
function connectorScope(packageId:string,instanceId:string,errorMessage:string):ConnectorInstanceScope&{resources:PluginResourceScope}{
  const resources=new PluginResourceScope(undefined,errorMessage);
  const identity={
    host:{kind:'central' as const,id:'central-connectors'},
    packageId,installationId:'central-connectors',instanceId,activationId:randomUUID(),
  };
  const scope:HostScope=Object.freeze({
    identity,signal:resources.signal,
    assertCurrent:()=>resources.assertCurrent(),defer:(dispose:()=>unknown|Promise<unknown>)=>resources.defer(dispose),
    run:<T>(work:(signal:AbortSignal)=>T|Promise<T>)=>resources.run(work),
    every:(ms:number,work:(signal:AbortSignal)=>unknown|Promise<unknown>)=>resources.every(ms,work),
    retire:(dispose:()=>unknown|Promise<unknown>)=>resources.retire(dispose),
  });
  return {resources,scope,fence:()=>resources.stop(),close:()=>resources.close()};
}

/** Register built-ins plus trusted deployment modules before Fastify listens.
 * Owner routes and OAuth callbacks reach only the one dynamic dispatcher; each
 * installed connector gets its own host scope and failure rollback. */
export async function registerConnectors(app:FastifyInstance,context:ConnectorContext,testing?:ConnectorTestDependencies,additionalManifests:readonly ConnectorManifest[]=[],dispatcherInput?:DynamicHttpDispatcher):Promise<ConnectorHostAdapter>{
  const ctx={...context,config:{...context.config,connectors:{directory:join(context.config.dataDir,'connectors'),...context.config.connectors}}};
  const removeMemory=installRecordingSources(context.memoryStrategies);
  if(removeMemory)app.addHook('onClose',async()=>removeMemory());
  const manifests=[...builtins(testing),...await loadConnectorModules(ctx.config.connectors.modules??[]),...additionalManifests];
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
    start:adapter.start,inventory:adapter.inventory,configureSyncInterval:adapter.configureSyncInterval,
    install:adapter.install,restart:adapter.restart,stop:adapter.stop,close:closeHost,
  });
}

function connectorErrorResponse(error:unknown){
  if(error instanceof ConnectorError)return {status:error.statusCode,error:error.code};
  if(error instanceof ZodError)return {status:400,error:'connector_input_invalid'};
}
