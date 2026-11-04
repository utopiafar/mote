import type {ConnectorManifest} from '../connectors/registry.js';
import {registerMcp,RemoteMcp,type McpTransportBinding} from '../connectors/mcp.js';
import {mcpContext,remoteMcpContext} from '../connectors/mcp-context.js';

/** C16's MCP transport and remote source. This module owns connectors/mcp.ts,
 * mcp-context.ts and mcp-import-state.ts: the inbound Fastify transport, its
 * read/write credential split, the remote discovery/import client and the
 * membership ledger live and die with the instance. The host keeps the
 * per-instance scope, owner routes and stop/restart; the /mcp route itself is
 * mounted once by the trusted assembly and dispatches to the current binding. */
export function mcpManifest():ConnectorManifest {
  return {apiVersion:1,id:'mcp',sourceKinds:['mcp'],statusKey:'mcp',create:ctx=>{
    const remote=new RemoteMcp(remoteMcpContext(ctx)),local=mcpContext(ctx);let inbound:McpTransportBinding|undefined;
    return {
      status:()=>({enabled:Boolean(local.configuration().mcpEnabled),readConfigured:Boolean(local.configuration().mcpReadToken),writeEnabled:Boolean(local.configuration().mcpWriteEnabled&&local.configuration().mcpWriteToken&&local.configuration().mcpWriteSourceIds?.length),writeSourceIds:local.configuration().mcpWriteSourceIds??[],endpoint:'/mcp'}),
      configure:host=>{
        host.ownerRoute({method:'POST',path:'/api/connectors/mcp/discover',handler:req=>remote.discover(req.body)});
        host.ownerRoute({method:'POST',path:'/api/connectors/mcp/import',handler:req=>remote.import(req.body)});
      },
      mountTransport:app=>{inbound=registerMcp(app,local);},
      close:async()=>{await Promise.all([remote.close(),inbound?.close()]);},
    };
  }};
}
