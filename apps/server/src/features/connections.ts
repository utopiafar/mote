import { LoginHandoffs } from '../login-handoffs.js';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { type FastifyRequest } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { moteText } from '../i18n.js';
import { INGRESS_PROTOCOL_VERSION } from '../ingress.js';
import { MOTE_PROTOCOL_RANGE } from '@mote/shared';

/** connections: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{config,connectionRate,connections,connectionIdentity,serverVersion}:Pick<FeatureServices,"config"|"connectionRate"|"connections"|"connectionIdentity"|"serverVersion">){
const handoffs=new LoginHandoffs(connections);
const authorize=(req:FastifyRequest)=>()=>{const c=connectionIdentity(req);if(c)connections.assertActive(c);};
app.post('/api/login/ticket',{bodyLimit:8192,config:connectionRate},req=>{const {expiresAt}=z.object({expiresAt:z.number().int().positive().optional()}).strict().parse(req.body??{});const c=connectionIdentity(req);const deadline=c?.expiresAt?Date.parse(c.expiresAt):undefined;return handoffs.ticket(req.headers.authorization!.slice(7),authorize(req),deadline&&expiresAt?Math.min(deadline,expiresAt):deadline??expiresAt);});
app.post('/api/login/exchange',{bodyLimit:8192,config:connectionRate},req=>handoffs.exchange(req.body));
app.post('/api/login/requests',{bodyLimit:8192,config:connectionRate},req=>handoffs.create(req.body));
app.get('/api/login/requests/:id',{config:connectionRate},req=>handoffs.detail((req.params as {id:string}).id));
app.post('/api/login/requests/:id/approve',{bodyLimit:8192,config:connectionRate},req=>handoffs.approve((req.params as {id:string}).id,authorize(req)));
app.post('/api/login/poll',{bodyLimit:8192,config:{rateLimit:{max:120,timeWindow:'1 minute',keyGenerator:(req:FastifyRequest)=>`login-poll:${req.ip}`}}},req=>handoffs.poll(req.body));
app.post('/api/login/ack',{bodyLimit:8192,config:connectionRate},req=>handoffs.poll(req.body,true));
app.post('/api/login/session',{bodyLimit:8192,config:connectionRate},async req=>{const {serverUrl,deviceId,deviceName,platform,durationMs}=z.object({serverUrl:z.string(),deviceId:z.string(),deviceName:z.string(),platform:z.enum(['android','macos','windows','linux','other']),durationMs:z.number().optional()}).strict().parse(req.body);const grant=await connections.session(serverUrl,deviceName,{deviceId,deviceName,platform},durationMs);try{authorize(req)();}catch(e){await connections.revoke(grant.credentialId);throw e;}return grant;});
app.post('/api/login/logout',{config:connectionRate},req=>{const c=connectionIdentity(req);return c?connections.revoke(c.id):{revoked:false};});
app.post('/api/connections/invitations',{bodyLimit:8192,config:connectionRate},async req=>connections.invite(req.body));
app.post('/api/connections/invitations/revoke',{bodyLimit:8192,config:connectionRate},async req=>connections.cancelInvitation(req.body));
app.post('/api/connections/redeem',{bodyLimit:8192,config:{rateLimit:{max:12,timeWindow:'1 minute',keyGenerator:(req:FastifyRequest)=>`redeem:${req.ip}`}}},async req=>connections.redeem(req.body));
app.get('/api/connections',async()=>connections.inventory(config.connectors));
app.delete('/api/connections/:id',{config:connectionRate},async req=>connections.revoke((req.params as {id:string}).id));
app.post('/api/connections/mcp',{bodyLimit:8192,config:connectionRate},async req=>connections.mintMcp(req.body,config.connectors));
app.get('/api/connections/self',async req=>{
    const c=connectionIdentity(req);if(c)connections.assertActive(c);
    const owner=!c||connections.isOwner(c);
    // Current native clients require explicit protocol metadata.
    const protocol = {protocol:MOTE_PROTOCOL_RANGE};
    return {credential:c?{id:c.id,scope:owner?'owner':c.scope,label:c.label,serverUrl:c.serverUrl,...(c.deviceId?{deviceId:c.deviceId,deviceName:c.deviceName,platform:c.platform}:{})}:{id:'owner',scope:'owner',label:moteText("节点所有者")},node:{version:serverVersion,profile:config.profile??'default',...protocol},capabilities:{ingest:owner,ingressVersion:Number(INGRESS_PROTOCOL_VERSION),ownSources:owner,archiveRead:owner||c?.scope==='mcp-read'}};
  });
}
