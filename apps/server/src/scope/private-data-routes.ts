import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {registerUserRoute} from './app.js';
import {PRIVATE_DATA_DOMAIN,PrivateData,privateListSchema} from './private-data.js';
import {installPrivateData} from './private-data-schema.js';
import {PrivateSql,PrivateCursor} from './private-data-sql.js';
import {privateDataLifecycle} from './private-data-lifecycle.js';
type ScopedRuntime=Parameters<typeof registerUserRoute>[0];

/** Registers only data-domain capabilities that have completed isolation.
 * Ingress, originals, workers, model tools and legacy catalogs stay closed. */
export function registerPrivateData(runtime:ScopedRuntime,db:DatabaseSync){
  const key=installPrivateData(db);
  runtime.services.registerUser(PRIVATE_DATA_DOMAIN,{scope:'user',
    create:context=>new PrivateData(new PrivateSql(db,context.userId,()=>runtime.authority.assert(context)),new PrivateCursor(key,context.deploymentId,context.userId)),
    lifecycle:privateDataLifecycle((subject,purpose)=>new PrivateSql(db,subject.userId,()=>runtime.services.assertSubject(subject,PRIVATE_DATA_DOMAIN,purpose))),
  });
  const service=(services:ReturnType<ScopedRuntime['services']['forUser']>)=>services.get<PrivateData>(PRIVATE_DATA_DOMAIN);
  // Each concrete URL is inventoried; no generic owner-selecting dispatcher.
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/sources',service:PRIVATE_DATA_DOMAIN,handle:({services})=>({items:service(services).sources()})});
  registerUserRoute(runtime,{scope:'user',method:'POST',url:'/api/sources',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).registerSource(request.body)});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/sources/:id',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).source((request.params as {id:string}).id)});
  registerUserRoute(runtime,{scope:'user',method:'PATCH',url:'/api/sources/:id',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).updateSource((request.params as {id:string}).id,request.body)});
  registerUserRoute(runtime,{scope:'user',method:'DELETE',url:'/api/sources/:id',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).deleteSource((request.params as {id:string}).id)});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/sources/:id/context',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).sourceContext((request.params as {id:string}).id,z.object({version:z.coerce.number().int().positive().optional()}).strict().parse(request.query).version)});
  registerUserRoute(runtime,{scope:'user',method:'PATCH',url:'/api/sources/:id/context',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).updateSourceContext((request.params as {id:string}).id,request.body)});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/source-items',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).captures(privateListSchema.parse(request.query),true)});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/sources/:id/items',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).captures({...privateListSchema.parse(request.query),sourceId:(request.params as {id:string}).id},true)});
  const itemQuery=z.object({externalId:z.string().min(1).max(1000)}).strict();
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/sources/:id/item',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>({item:service(services).sourceItem((request.params as {id:string}).id,itemQuery.parse(request.query).externalId)})});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/sources/:id/history',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>({items:service(services).sourceHistory((request.params as {id:string}).id,itemQuery.parse(request.query).externalId)})});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/captures',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).captures(privateListSchema.parse(request.query))});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/captures/:id',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).capture((request.params as {id:string}).id)});
  registerUserRoute(runtime,{scope:'user',method:'DELETE',url:'/api/captures/:id',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).deleteCapture((request.params as {id:string}).id)});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/materials',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).materials(privateListSchema.parse(request.query))});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/materials/:id',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).material((request.params as {id:string}).id)});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/materials/:id/revisions/:revision',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>{const {id,revision}=request.params as {id:string;revision:string};return service(services).material(id,revision);}});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/materials/:id/read',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).readMaterial((request.params as {id:string}).id,z.object({revision:z.string().regex(/^[a-f0-9]{64}$/).optional(),offset:z.coerce.number().int().nonnegative().optional(),length:z.coerce.number().int().min(1).max(12000).optional()}).strict().parse(request.query))});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/materials/:id/members',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).materialMembers((request.params as {id:string}).id,z.object({revision:z.string().regex(/^[a-f0-9]{64}$/).optional(),offset:z.coerce.number().int().nonnegative().optional(),limit:z.coerce.number().int().min(1).max(200).optional()}).strict().parse(request.query))});
  registerUserRoute(runtime,{scope:'user',method:'PATCH',url:'/api/materials/:id/context',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>{const body=z.object({expectedRevision:z.string().regex(/^[a-f0-9]{64}$/),ownerRelation:z.unknown()}).strict().parse(request.body);return service(services).correctMaterialContext((request.params as {id:string}).id,body.expectedRevision,body.ownerRelation);}});
  registerUserRoute(runtime,{scope:'user',method:'DELETE',url:'/api/materials/:id',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).deleteMaterial((request.params as {id:string}).id)});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/layers',service:PRIVATE_DATA_DOMAIN,handle:({services})=>service(services).statistics()});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/data/statistics',service:PRIVATE_DATA_DOMAIN,handle:({services})=>service(services).statistics()});
  registerUserRoute(runtime,{scope:'user',method:'GET',url:'/api/data/search',service:PRIVATE_DATA_DOMAIN,handle:({services,request})=>service(services).search(z.object({query:z.string().min(1).max(500),limit:z.coerce.number().int().min(1).max(200).optional()}).strict().parse(request.query))});
}
