import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Context} from '@deepseek-ai/cordis';
import {moteText} from '../i18n.js';
import type {ConnectionCredential} from '../connections.js';
import {DeveloperAccessError,type DeveloperAccessHost} from '../developer-access.js';
import type {bootstrapCentral} from '../bootstrap.js';
import {contributeDomainRoutes} from '../plugins/domain-routes.js';
import type {FeatureRoute} from './index.js';

export interface DeveloperAccessFeatureDependencies {
  readonly host:DeveloperAccessHost;
  readonly credential:(request:FastifyRequest)=>ConnectionCredential|undefined;
  readonly connectionIdentity:(request:FastifyRequest)=>ConnectionCredential|undefined;
}

/** Developer access is a companion surface of the selected Connections feature.
 * It joins the same route table and is mounted by the common selected collector,
 * never by an independent Host push or a second Connections owner. */
export function prepareDeveloperAccessRoute(bootstrap:Pick<Awaited<ReturnType<typeof bootstrapCentral>>,'selectsFeature'>,context:Context,dependencies:DeveloperAccessFeatureDependencies){
  if(!bootstrap.selectsFeature('mote.connections'))return;
  contributeDomainRoutes(context,{'mote.developer-access':{mount:developerAccessFeature(dependencies).mount}});
}

/** Owner management is separate from the read-only Developer API. The global
 * credential gate only admits developer credentials to `GET /api/developer/v1/events`;
 * owner control never routes through a developer token. */
export function developerAccessFeature(dependencies:DeveloperAccessFeatureDependencies):FeatureRoute {
  return Object.freeze({id:'mote.developer-access',mount(app:FastifyInstance){
    const owner=(request:FastifyRequest)=>{
      if(dependencies.credential(request))throw new DeveloperAccessError('owner_required',403,moteText("仅节点所有者可以管理 Webhook 与开发者凭据。"));
    };
    app.get('/api/developer',request=>{owner(request);return dependencies.host.inventory();});
    app.post('/api/developer/credentials',{bodyLimit:8192},request=>{owner(request);return dependencies.host.mintCredential(request.body);});
    app.delete('/api/developer/credentials/:id',request=>{owner(request);return dependencies.host.revokeCredential((request.params as {id:string}).id);});
    app.get('/api/developer/webhooks',request=>{owner(request);return {items:dependencies.host.inventory().endpoints};});
    app.post('/api/developer/webhooks',{bodyLimit:8192},request=>{owner(request);return dependencies.host.createWebhook(request.body);});
    app.patch('/api/developer/webhooks/:id',{bodyLimit:8192},request=>{owner(request);return dependencies.host.updateWebhook((request.params as {id:string}).id,request.body);});
    app.delete('/api/developer/webhooks/:id',request=>{owner(request);return dependencies.host.disableWebhook((request.params as {id:string}).id);});
    app.get('/api/developer/deliveries',request=>{
      owner(request);
      const raw=(request.query as {limit?:string}).limit,limit=Math.min(100,Math.max(1,Number.parseInt(raw??'50',10)||50));
      return {items:dependencies.host.deliveries(limit)};
    });
    app.get('/api/developer/v1/events',request=>{
      const credential=dependencies.connectionIdentity(request);
      if(!credential||credential.scope!=='developer')
        throw new DeveloperAccessError('developer_credential_required',403,moteText("此读取需要独立的开发者凭据。"));
      const query=request.query as {after?:string;limit?:string};
      return dependencies.host.events(credential,{after:query.after,limit:query.limit});
    });
  }});
}
