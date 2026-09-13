import {join} from 'node:path';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {ConnectorError,type ConnectorContext} from './types.js';
import {equalToken,registerMcp,RemoteMcp} from './mcp.js';
import {GoogleCalendarConnector,type GoogleDependencies} from './google.js';
export type {ConnectorConfig,ConnectorContext} from './types.js';

export async function registerConnectors(app:FastifyInstance,context:ConnectorContext,testing?:{google?:GoogleDependencies}) {
  const ctx={...context,config:{...context.config,connectors:{directory:join(context.config.dataDir,'connectors'),...context.config.connectors}}};
  const google=new GoogleCalendarConnector(ctx,testing?.google),remote=new RemoteMcp(ctx),mcp=registerMcp(app,ctx);
  await google.init();
  const owner=async(req:FastifyRequest,reply:FastifyReply)=>{if(!equalToken(req.headers.authorization,ctx.config.token))return reply.code(401).send({error:'unauthorized'});reply.header('Cache-Control','no-store');};
  const action=(fn:(req:FastifyRequest)=>unknown)=>async(req:FastifyRequest,reply:FastifyReply)=>{
    try{return await fn(req);}catch(error){const known=error instanceof ConnectorError;return reply.code(known?error.statusCode:error instanceof z.ZodError?400:502).send({error:known?error.code:error instanceof z.ZodError?'connector_input_invalid':'connector_operation_failed',requestId:req.id});}
  };
  app.get('/api/connectors/status',{preHandler:owner},()=>({mcp:{enabled:Boolean(ctx.config.connectors.mcpEnabled),readConfigured:Boolean(ctx.config.connectors.mcpReadToken),writeEnabled:Boolean(ctx.config.connectors.mcpWriteEnabled&&ctx.config.connectors.mcpWriteToken&&ctx.config.connectors.mcpWriteSourceIds?.length),writeSourceIds:ctx.config.connectors.mcpWriteSourceIds??[],endpoint:'/mcp'},google:google.status()}));
  app.post('/api/connectors/mcp/discover',{preHandler:owner},action(req=>remote.discover(req.body)));
  app.post('/api/connectors/mcp/import',{preHandler:owner},action(req=>remote.import(req.body)));
  app.post('/api/connectors/google/start',{preHandler:owner},action(()=>google.start()));
  app.get('/api/connectors/google/calendars',{preHandler:owner},action(()=>google.calendars()));
  app.put('/api/connectors/google/calendars',{preHandler:owner},action(req=>google.select(req.body)));
  app.post('/api/connectors/google/sync',{preHandler:owner},action(()=>google.sync()));
  app.delete('/api/connectors/google',{preHandler:owner},action(()=>google.disconnect()));
  app.get('/oauth/google/callback',async(req,reply)=>{
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',"default-src 'none'; style-src 'none'");
    try{const input=z.object({state:z.string().min(20).max(200),code:z.string().min(1).max(4096)}).passthrough().parse(req.query);await google.callback(input.state,input.code);return reply.type('text/plain; charset=utf-8').send('Google 日历已连接。请返回 Mote 选择需要同步的日历。');}
    catch{return reply.code(400).type('text/plain; charset=utf-8').send('授权未完成或已过期。请返回 Mote 重新连接 Google 日历。');}
  });
  let closed=false;
  return {close:async()=>{if(closed)return;closed=true;await Promise.all([google.close(),remote.close(),mcp.close()]);}};
}
