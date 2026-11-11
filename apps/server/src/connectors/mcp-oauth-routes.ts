import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {moteText} from '../i18n.js';
import {McpOAuthError,type McpOAuthServer} from './mcp-oauth.js';

const authorizeQuery=z.object({
  response_type:z.string().max(40).optional(),
  client_id:z.string().min(1).max(200),
  redirect_uri:z.string().min(1).max(2048),
  state:z.string().max(512).optional(),
  code_challenge:z.string().max(128).optional(),
  code_challenge_method:z.string().max(16).optional(),
  scope:z.string().max(200).optional(),
  resource:z.string().max(2048).optional(),
}).passthrough();
const pendingId=z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const escapeHtml=(value:string)=>value.replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!));
type McpOAuthConfiguration=Pick<import('./types.js').ConnectorConfig,'mcpEnabled'|'mcpWriteEnabled'|'mcpWriteSourceIds'>;
export interface McpOAuthRouteOptions {
  readonly oauth:McpOAuthServer;
  readonly configuration:()=>McpOAuthConfiguration|undefined;
  readonly publicUrl?:string;
  readonly allowedOrigins:readonly string[];
  readonly ownerAuthorization:(header:string|undefined)=>boolean;
}

export function mcpBaseUrl(publicUrl:string|undefined,request:FastifyRequest){
  if(publicUrl){try{return new URL(publicUrl).origin;}catch{/* fall through to the request host */}}
  const forwardedProto=String(request.headers['x-forwarded-proto']??'').split(',')[0]?.trim();
  const protocol=forwardedProto==='https'?'https':forwardedProto==='http'?'http':request.protocol==='https'?'https':'http';
  const forwardedHost=String(request.headers['x-forwarded-host']??'').split(',')[0]?.trim();
  const host=forwardedHost||request.headers.host;
  if(!host||host.length>255||!/^[A-Za-z0-9.\-:\[\]]+$/.test(host))return;
  try{return new URL(`${protocol}://${host}`).origin;}catch{return;}
}
export function mcpResourceUrl(publicUrl:string|undefined,request:FastifyRequest){
  const base=mcpBaseUrl(publicUrl,request);
  return base?`${base}/mcp`:undefined;
}
export function mcpChallenge(publicUrl:string|undefined,request:FastifyRequest,invalid:boolean){
  const base=mcpBaseUrl(publicUrl,request);
  return base?`Bearer realm="mote", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"${invalid?', error="invalid_token"':''}`:'Bearer realm="mote"';
}
export function mcpUnauthorized(publicUrl:string|undefined,allowedOrigins:readonly string[],request:FastifyRequest,reply:FastifyReply){
  if(request.headers.origin&&allowedOrigins.includes(request.headers.origin))reply.header('Access-Control-Expose-Headers','WWW-Authenticate');
  return reply.header('WWW-Authenticate',mcpChallenge(publicUrl,request,Boolean(request.headers.authorization))).header('Cache-Control','no-store').code(401).send({error:'mcp_unauthorized'});
}

/** MCP authorization discovery plus the OAuth endpoints it advertises. This is
 * mounted by trusted host assembly with the existing Connections lifecycle, not
 * by an installable connector package. Static Bearer credentials and the existing
 * /mcp tool surface are untouched. */
export function registerMcpOAuthRoutes(app:FastifyInstance,options:McpOAuthRouteOptions){
  const scopes=()=>{
    const config=options.configuration();
    return ['mote.read',...(config?.mcpEnabled&&config.mcpWriteEnabled&&config.mcpWriteSourceIds?.length?['mote.write']:[])];
  };
  const allowedOrigin=(request:FastifyRequest)=>!request.headers.origin||options.allowedOrigins.includes(request.headers.origin);
  const errorResponse=(reply:FastifyReply,error:unknown)=>{
    if(error instanceof McpOAuthError)return reply.code(error.statusCode).header('Cache-Control','no-store').header('Pragma','no-cache').send({error:error.code,error_description:error.description});
    return reply.code(503).header('Cache-Control','no-store').header('Pragma','no-cache').send({error:'temporarily_unavailable',error_description:'OAuth is unavailable'});
  };
  const metadata=(request:FastifyRequest,reply:FastifyReply)=>{
    if(!allowedOrigin(request))return reply.code(403).header('Cache-Control','no-store').send({error:'origin_denied'});
    const base=mcpBaseUrl(options.publicUrl,request);
    if(!base)return reply.code(400).header('Cache-Control','no-store').send({error:'invalid_host'});
    return reply.type('application/json; charset=utf-8').header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').send({
      resource:`${base}/mcp`,
      authorization_servers:[base],
      bearer_methods_supported:['header'],
      scopes_supported:scopes(),
      resource_name:'Mote',
    });
  };
  app.get('/.well-known/oauth-protected-resource',metadata);
  app.get('/.well-known/oauth-protected-resource/mcp',metadata);
  app.get('/.well-known/oauth-authorization-server',(request,reply)=>{
    if(!allowedOrigin(request))return reply.code(403).header('Cache-Control','no-store').send({error:'origin_denied'});
    const base=mcpBaseUrl(options.publicUrl,request);
    if(!base)return reply.code(400).header('Cache-Control','no-store').send({error:'invalid_host'});
    return reply.type('application/json; charset=utf-8').header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').send({
      issuer:base,
      authorization_endpoint:`${base}/oauth/authorize`,
      token_endpoint:`${base}/oauth/token`,
      registration_endpoint:`${base}/oauth/register`,
      response_types_supported:['code'],
      response_modes_supported:['query'],
      grant_types_supported:['authorization_code','refresh_token'],
      token_endpoint_auth_methods_supported:['none'],
      code_challenge_methods_supported:['S256'],
      scopes_supported:scopes(),
      resource_indicators_supported:true,
    });
  });

  const redirectError=(reply:FastifyReply,redirectUri:string,state:string|undefined,error:string,description:string)=>{
    const url=new URL(redirectUri);
    url.searchParams.set('error',error);url.searchParams.set('error_description',description);
    if(state!==undefined)url.searchParams.set('state',state);
    return reply.code(303).header('Location',url.toString()).header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff').send();
  };
  const page=(reply:FastifyReply,status:number,title:string,body:string,refresh=false)=>reply.code(status).type('text/html; charset=utf-8')
    .header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('X-Frame-Options','DENY').header('X-Content-Type-Options','nosniff')
    .header('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'")
    .send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh?'<meta http-equiv="refresh" content="2">':''}<title>${escapeHtml(title)}</title><style>body{font-family:system-ui,-apple-system,sans-serif;line-height:1.6;margin:0;padding:2rem;background:#f6f4ef;color:#25231f}main{max-width:34rem;margin:4rem auto;background:#fff;border:1px solid #ded8cc;border-radius:14px;padding:2rem}h1{font-size:1.35rem;margin:0 0 1rem}p{margin:.75rem 0}code{overflow-wrap:anywhere;background:#f2efe8;padding:.15rem .35rem;border-radius:4px}a{color:#175c4c}</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`);
  const pendingPage=(reply:FastifyReply,pending:{clientName:string;write:boolean})=>page(reply,200,moteText('Mote MCP 授权'),
    `<p>${moteText('客户端 {0} 请求访问 Mote。',escapeHtml(pending.clientName))}</p><p>${moteText('访问权限')}: <strong>${escapeHtml(pending.write?moteText('仅写入指定来源'):moteText('只读归档资料'))}</strong></p><p>${moteText('请在已登录的 Mote「AI 接入」中批准此连接；批准后此页面会自动继续。')}</p><p><a href="/#/connections/access" target="_blank" rel="noreferrer">${moteText('打开 Mote「AI 接入」')}</a></p>`,true);

  app.register(async routes=>{
    routes.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'string',bodyLimit:16*1024},(_request,body,done)=>done(null,body));
    routes.post('/oauth/register',{bodyLimit:8192},async(request,reply)=>{
      if(!allowedOrigin(request))return reply.code(403).header('Cache-Control','no-store').send({error:'origin_denied'});
      if(!request.body||typeof request.body!=='object')return reply.code(400).header('Cache-Control','no-store').send({error:'invalid_client_metadata',error_description:'Client metadata is invalid'});
      try{return reply.code(201).header('Cache-Control','no-store').send(await options.oauth.register(request.body));}
      catch(error){return errorResponse(reply,error);}
    });
    routes.get('/oauth/authorize',async(request,reply)=>{
      if(!allowedOrigin(request))return reply.code(403).type('text/plain; charset=utf-8').send(moteText('授权请求无效。'));
      const parsed=authorizeQuery.safeParse(request.query);
      if(!parsed.success)return page(reply,400,moteText('Mote MCP 授权'),`<p>${moteText('授权请求无效。')}</p>`);
      const query=parsed.data;
      try{
        const client=await options.oauth.client(query.client_id);
        if(!client||!client.redirectUris.includes(query.redirect_uri))return page(reply,400,moteText('Mote MCP 授权'),`<p>${moteText('授权请求无效。')}</p>`);
        if(query.response_type!=='code')return redirectError(reply,query.redirect_uri,query.state,'unsupported_response_type','Only the authorization code response is supported');
        const expected=mcpResourceUrl(options.publicUrl,request);
        if(!expected)return page(reply,400,moteText('Mote MCP 授权'),`<p>${moteText('授权请求无效。')}</p>`);
        if(query.resource!==undefined&&query.resource!==expected)return redirectError(reply,query.redirect_uri,query.state,'invalid_target','The resource does not match this MCP service');
        const outcome=await options.oauth.authorize({clientId:client.clientId,clientName:client.clientName,redirectUri:query.redirect_uri,...(query.state!==undefined?{state:query.state}:{}),codeChallenge:query.code_challenge??'',codeChallengeMethod:query.code_challenge_method??'',...(query.scope!==undefined?{scope:query.scope}:{}),resource:query.resource??expected});
        if(outcome.kind==='pending')return pendingPage(reply,outcome);
        if(outcome.kind==='approved'){
          const url=new URL(outcome.redirectUri);url.searchParams.set('code',outcome.code);if(outcome.state!==undefined)url.searchParams.set('state',outcome.state);
          return reply.code(303).header('Location',url.toString()).header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').send();
        }
        if(outcome.kind==='rejected')return redirectError(reply,query.redirect_uri,query.state,'access_denied','The owner rejected this connection');
        return redirectError(reply,query.redirect_uri,query.state,'invalid_request','The authorization request expired');
      }catch(error){
        if(error instanceof McpOAuthError){
          if(error.code==='mcp_disabled'||error.code==='temporarily_unavailable'&&error.statusCode===503)return page(reply,error.statusCode,moteText('Mote MCP 授权'),`<p>${escapeHtml(error.code==='mcp_disabled'?moteText('MCP 服务当前未启用。'):error.description)}</p>`);
          return redirectError(reply,query.redirect_uri,query.state,error.code,error.description);
        }
        return page(reply,503,moteText('Mote MCP 授权'),`<p>${moteText('MCP 服务当前未启用。')}</p>`);
      }
    });
    routes.post('/oauth/token',{bodyLimit:16*1024},async(request,reply)=>{
      if(!allowedOrigin(request))return reply.code(403).header('Cache-Control','no-store').send({error:'invalid_request',error_description:'The request origin is not allowed'});
      if(typeof request.body!=='string')return reply.code(400).header('Cache-Control','no-store').send({error:'invalid_request',error_description:'A form body is required'});
      const params=new URLSearchParams(request.body),grant=params.get('grant_type'),expected=mcpResourceUrl(options.publicUrl,request),resource=params.get('resource')??expected;
      try{
        let result;
        if(grant==='authorization_code'){
          const code=params.get('code')??'',clientId=params.get('client_id')??'',redirectUri=params.get('redirect_uri')??'',verifier=params.get('code_verifier')??'';
          if(!code||!clientId||!redirectUri||!verifier)throw new McpOAuthError('invalid_request',400,'code, client_id, redirect_uri and code_verifier are required');
          result=await options.oauth.exchange({clientId,code,redirectUri,...(resource!==undefined?{resource}:{}),verifier});
        }else if(grant==='refresh_token'){
          const refreshToken=params.get('refresh_token')??'',clientId=params.get('client_id')??'';
          if(!refreshToken||!clientId)throw new McpOAuthError('invalid_request',400,'refresh_token and client_id are required');
          result=await options.oauth.refresh({clientId,refreshToken,...(resource!==undefined?{resource}:{})});
        }else throw new McpOAuthError('unsupported_grant_type',400,'Only authorization_code and refresh_token are supported');
        return reply.header('Cache-Control','no-store').header('Pragma','no-cache').send(result);
      }catch(error){return errorResponse(reply,error);}
    });
  });

  const owner=(request:FastifyRequest,reply:FastifyReply)=>{
    if(!options.ownerAuthorization(request.headers.authorization))return {error:reply.code(403).header('Cache-Control','no-store').send({error:'owner_authorization_required'})};
    return {ok:true as const};
  };
  app.get('/api/connections/mcp/oauth/requests',async(request,reply)=>{
    const admitted=owner(request,reply);if(admitted.error)return admitted.error;
    try{return reply.header('Cache-Control','no-store').send({items:await options.oauth.list()});}
    catch(error){return errorResponse(reply,error);}
  });
  app.post('/api/connections/mcp/oauth/requests/:id/approve',{bodyLimit:8192},async(request,reply)=>{
    const admitted=owner(request,reply);if(admitted.error)return admitted.error;
    const parsed=pendingId.safeParse((request.params as {id?:unknown}).id);
    if(!parsed.success)return reply.code(404).header('Cache-Control','no-store').send({error:'oauth_request_not_found'});
    try{return reply.header('Cache-Control','no-store').send(await options.oauth.approve(parsed.data));}
    catch(error){return errorResponse(reply,error);}
  });
  app.post('/api/connections/mcp/oauth/requests/:id/reject',{bodyLimit:8192},async(request,reply)=>{
    const admitted=owner(request,reply);if(admitted.error)return admitted.error;
    const parsed=pendingId.safeParse((request.params as {id?:unknown}).id);
    if(!parsed.success)return reply.code(404).header('Cache-Control','no-store').send({error:'oauth_request_not_found'});
    try{return reply.header('Cache-Control','no-store').send(await options.oauth.reject(parsed.data));}
    catch(error){return errorResponse(reply,error);}
  });
}
