import type { FastifyInstance } from 'fastify';
import { type FastifyRequest } from 'fastify';
import type { FeatureServices } from '../feature-services.js';
import { moteText } from '../i18n.js';
import { INGRESS_PROTOCOL_VERSION } from '../ingress.js';

/** connections: owns its transport, data and command contributions. */
export function register(app:FastifyInstance,{config,connectionRate,connections,credential,serverVersion}:Pick<FeatureServices,"config"|"connectionRate"|"connections"|"credential"|"serverVersion">){
app.post('/api/connections/invitations',{bodyLimit:8192,config:connectionRate},async req=>connections.invite(req.body));
app.post('/api/connections/invitations/revoke',{bodyLimit:8192,config:connectionRate},async req=>connections.cancelInvitation(req.body));
app.post('/api/connections/redeem',{bodyLimit:8192,config:{rateLimit:{max:12,timeWindow:'1 minute',keyGenerator:(req:FastifyRequest)=>`redeem:${req.ip}`}}},async req=>connections.redeem(req.body));
app.get('/api/connections',async()=>connections.inventory(config.connectors));
app.delete('/api/connections/:id',{config:connectionRate},async req=>connections.revoke((req.params as {id:string}).id));
app.post('/api/connections/mcp',{bodyLimit:8192,config:connectionRate},async req=>connections.mintMcp(req.body,config.connectors));
app.get('/api/connections/self',async req=>{
    const c=credential(req);if(c)connections.assertActive(c);
    const owner=!c,collector=c?.scope==='collector';
    return {credential:c?{id:c.id,scope:c.scope,label:c.label,serverUrl:c.serverUrl,...(c.deviceId?{deviceId:c.deviceId,deviceName:c.deviceName,platform:c.platform}:{})}:{id:'owner',scope:'owner',label:moteText("节点所有者")},node:{version:serverVersion,profile:config.profile??'legacy'},capabilities:{ingest:owner||collector,ingressVersion:Number(INGRESS_PROTOCOL_VERSION),ownSources:owner||collector,archiveRead:owner||c?.scope==='mcp-read'}};
  });
}
