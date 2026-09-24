import {join} from 'node:path';
import {moteText} from '../i18n.js';
import {ConnectorRegistry,type ConnectorManifest,type OwnerRoute} from './registry.js';
import {registerMcp,RemoteMcp} from './mcp.js';
import {GoogleCalendarConnector,type GoogleDependencies} from './google.js';
import {GmailConnector} from './gmail.js';
import {LarkConnector} from './lark.js';
import type {LarkRunner} from './lark-cli.js';
import type {ConnectorContext} from './types.js';
import type {FastifyInstance} from 'fastify';

export type {ConnectorConfig,ConnectorContext} from './types.js';
export type {ConnectorManifest,ConnectorInstance,ConnectorHost,OwnerRoute,OAuthCallback} from './registry.js';

type TestDependencies={google?:GoogleDependencies;gmail?:GoogleDependencies;lark?:LarkRunner};
const larkRate={max:60,timeWindow:'1 minute'};

function builtins(testing?:TestDependencies):ConnectorManifest[]{return [
  {apiVersion:1,id:'mcp',sourceKinds:['mcp'],statusKey:'mcp',create:ctx=>{
    const remote=new RemoteMcp(ctx);let inbound:ReturnType<typeof registerMcp>|undefined;
    return {
      status:()=>({enabled:Boolean(ctx.config.connectors?.mcpEnabled),readConfigured:Boolean(ctx.config.connectors?.mcpReadToken),writeEnabled:Boolean(ctx.config.connectors?.mcpWriteEnabled&&ctx.config.connectors?.mcpWriteToken&&ctx.config.connectors?.mcpWriteSourceIds?.length),writeSourceIds:ctx.config.connectors?.mcpWriteSourceIds??[],endpoint:'/mcp'}),
      configure:host=>{
        host.ownerRoute({method:'POST',path:'/api/connectors/mcp/discover',handler:req=>remote.discover(req.body)});
        host.ownerRoute({method:'POST',path:'/api/connectors/mcp/import',handler:req=>remote.import(req.body)});
      },
      mountTransport:app=>{inbound=registerMcp(app,ctx);},
      close:async()=>{await Promise.all([remote.close(),inbound?.close()]);},
    };
  }},
  {apiVersion:1,id:'google-calendar',sourceKinds:['google-calendar'],statusKey:'google',create:ctx=>{
    const google=new GoogleCalendarConnector(ctx,testing?.google);
    return {
      init:()=>google.init(),status:()=>google.status(),
      configure:host=>{
        host.ownerRoute({method:'POST',path:'/api/connectors/google/start',handler:()=>google.start()});
        host.ownerRoute({method:'GET',path:'/api/connectors/google/calendars',handler:()=>google.calendars()});
        host.ownerRoute({method:'PUT',path:'/api/connectors/google/calendars',handler:req=>google.select(req.body)});
        host.ownerRoute({method:'POST',path:'/api/connectors/google/sync',handler:()=>google.sync()});
        host.ownerRoute({method:'DELETE',path:'/api/connectors/google',handler:()=>google.disconnect()});
        host.oauthCallback({path:'/oauth/google/callback',complete:(state,code)=>google.callback(state,code),successMessage:moteText('Google 日历已连接。请返回 Mote 选择需要同步的日历。'),failureMessage:moteText('授权未完成或已过期。请返回 Mote 重新连接 Google 日历。')});
      },
      close:()=>google.close(),
    };
  }},
  {apiVersion:1,id:'gmail',sourceKinds:['gmail'],statusKey:'gmail',create:ctx=>{
    const gmail=new GmailConnector(ctx,testing?.gmail);
    return {
      init:()=>gmail.init(),status:()=>gmail.status(),
      configure:host=>{
        host.ownerRoute({method:'POST',path:'/api/connectors/gmail/start',rateLimit:larkRate,bodyLimit:16384,handler:()=>gmail.start()});
        host.ownerRoute({method:'POST',path:'/api/connectors/gmail/sync',rateLimit:larkRate,bodyLimit:16384,handler:()=>gmail.sync()});
        host.ownerRoute({method:'DELETE',path:'/api/connectors/gmail',rateLimit:larkRate,bodyLimit:16384,handler:()=>gmail.disconnect()});
        host.oauthCallback({path:'/oauth/google/callback',statePrefix:'gmail.',complete:(state,code)=>gmail.callback(state,code),successMessage:moteText('Gmail 已连接。请返回 Mote 同步邮件。'),failureMessage:moteText('授权未完成或已过期。请返回 Mote 重新连接 Google 日历。')});
      },
      close:()=>gmail.close(),
    };
  }},
  {apiVersion:1,id:'lark',sourceKinds:['lark-docs','lark-calendar'],create:ctx=>{
    const lark=new LarkConnector(ctx,testing?.lark);
    return {
      init:()=>lark.init(),
      configure:host=>{
        const route=(method:'GET'|'POST'|'PUT'|'DELETE',path:`/api/connectors/${string}`,handler:OwnerRoute['handler'])=>host.ownerRoute({method,path,rateLimit:larkRate,bodyLimit:16384,handler});
        route('GET','/api/connectors/lark',()=>lark.status());
        route('POST','/api/connectors/lark/check',()=>lark.refresh());
        route('POST','/api/connectors/lark/install',()=>lark.startInstall());
        route('POST','/api/connectors/lark/setup',()=>lark.startSetup());
        route('POST','/api/connectors/lark/configure',req=>lark.configure(req.body));
        route('POST','/api/connectors/lark/login',()=>lark.login());
        route('POST','/api/connectors/lark/cancel',()=>lark.cancel());
        route('GET','/api/connectors/lark/calendars',()=>lark.calendars());
        route('PUT','/api/connectors/lark/selection',req=>lark.select(req.body));
        route('POST','/api/connectors/lark/sync',()=>lark.startSync());
        route('DELETE','/api/connectors/lark',()=>lark.disconnect());
      },
      close:()=>lark.close(),
    };
  }},
];}

/** Register built-ins plus trusted deployment modules before any route is mounted. */
export async function registerConnectors(app:FastifyInstance,context:ConnectorContext,testing?:TestDependencies,additionalManifests:readonly ConnectorManifest[]=[]){
  const ctx={...context,config:{...context.config,connectors:{directory:join(context.config.dataDir,'connectors'),...context.config.connectors}}};
  const registry=new ConnectorRegistry(app,ctx);
  for(const manifest of builtins(testing))registry.register(manifest);
  await registry.loadModules(ctx.config.connectors.modules??[]);
  for(const manifest of additionalManifests)registry.register(manifest);
  return registry.start();
}
